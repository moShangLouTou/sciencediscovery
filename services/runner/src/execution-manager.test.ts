// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RefStore, VersionStore, withWorkspaceMutation, withWorkspaceRetirement, workspaceHeadName } from "@sciencediscovery/cas";
import type { ExecutionOwner, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { executionDigestVectors } from "../../../test/support/execution-digest-vectors.js";
import { ExecutionManager, ExecutionManagerError, type ExecutionManagerOptions, type ExecutionQuarantineDiagnostic } from "./execution-manager.js";
import { EXECUTION_BOUNDARY_SCHEMA_VERSION, type ExecutionBoundaryHandle } from "./execution-boundary.js";
import { sendSignal } from "@sciencediscovery/sandbox-capability";
import { ProcessTerminationUnverifiedError } from "./executor.js";
import { assertEnvironmentMutationAllowed } from "./execution-resource-fences.js";

const owner: ExecutionOwner = { agentId: "main", sessionId: "session" };
function request(root: string, id: string): ShellExecutionRequest {
  return { agentId: owner.agentId, executionId: id, code: "echo result", workspaceRoot: root,
    permissionEpoch: { sessionId: owner.sessionId } as ShellExecutionRequest["permissionEpoch"] };
}
function result(id: string): ShellExecutionResult {
  return { executionId: id, environmentRevisionId: "latest", exitCode: 0, stdout: "done", stderr: "",
    createdFiles: [], modifiedFiles: [], language: "shell", kernelMode: "ephemeral", kernelId: `ephemeral:${id}`,
    cgroupMode: "none", sandbox: "bubblewrap", environmentVariables: {}, networkPolicy: "none", runnerVersion: "test",
    workingDirectory: "/workspace", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
}
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Execution did not reach expected state within ${timeoutMs}ms`);
    await new Promise((done) => setTimeout(done, 5));
  }
}
async function fixture(context: { after: (fn: () => Promise<void>) => void }, options?: ExecutionManagerOptions) {
  const root = await mkdtemp(resolve(tmpdir(), "execution-manager-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const manager = new ExecutionManager(root, undefined, options);
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, manager };
}

test("deletion admission failure is not a poisoned version store after a successful rollback", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  await withWorkspaceRetirement(new VersionStore(root), [workspace], "rollback", async (_roots, reopen) => {
    manager.start(request(workspace, "blocked-delete"), async () => { assert.fail("closed Workspace executed"); });
    await until(() => manager.get("blocked-delete", owner).state === "failed");
    assert.match(manager.get("blocked-delete", owner).error!, /deleted/);
    reopen();
  });
  manager.start(request(workspace, "after-rollback"), async () => result("after-rollback"));
  await until(() => manager.get("after-rollback", owner).state === "completed");
});

test("a preflight rejection records a deterministic pre-admission failure without poisoning the workspace", async (context) => {
  const { manager, workspace } = await fixture(context);
  let launched = false;
  const submitted = manager.submit(request(workspace, "blocked-shell"),
    async () => { launched = true; return result("blocked-shell"); },
    async () => { throw new Error("Managed Bash is unavailable: ENOENT"); });
  assert.equal(submitted.accepted, true);
  await until(() => manager.get("blocked-shell", owner).state === "failed");
  const record = manager.get("blocked-shell", owner);
  assert.equal(launched, false, "a rejected preflight must not launch the operation");
  assert.equal(record.error, "Managed Bash is unavailable: ENOENT");
  assert.equal(record.startedAt, undefined, "no process joined, so no start time is invented");
  assert.equal(record.result, undefined);
  assert.equal(record.version, undefined, "a pre-admission failure publishes no workspace version");
  assert.equal(record.evidence?.terminationReason, "not_started");
  assert.equal(record.evidence?.processTerminated, true);
  assert.equal(record.evidence?.runnerInstanceId, record.receipt?.runnerInstanceId);
  assert.equal(record.evidence?.revision, record.receipt?.revision);
  // The rejected admission never reaches the workspace catch, which would
  // mark the workspace as failed for every later execution.
  manager.start(request(workspace, "after-preflight"), async () => result("after-preflight"));
  await until(() => manager.get("after-preflight", owner).state === "completed");
});

test("a preflight recheck at admission catches a Shell that became unavailable while queued", async (context) => {
  const { manager, workspace } = await fixture(context);
  let release!: () => void;
  const latch = new Promise<void>((done) => { release = done; });
  manager.start(request(workspace, "holds-queue"), async () => { await latch; return result("holds-queue"); });
  await until(() => manager.get("holds-queue", owner).state === "running");
  // The API precheck passed before this request waited behind earlier work in
  // the same Workspace queue.
  let available = true;
  const queued = manager.submit(request(workspace, "rechecked-shell"),
    async () => { assert.fail("an unavailable Shell must never launch"); },
    async () => { if (!available) throw new Error("Managed Bash became unavailable"); });
  assert.equal(queued.execution.state, "queued");
  available = false;
  release();
  await until(() => manager.get("rechecked-shell", owner).state === "failed");
  assert.equal(manager.get("holds-queue", owner).state, "completed");
  const record = manager.get("rechecked-shell", owner);
  assert.equal(record.error, "Managed Bash became unavailable");
  assert.equal(record.startedAt, undefined);
  assert.equal(record.evidence?.terminationReason, "not_started");
});

test("background admission does not block observers; one workspace queues, another runs, CAS commits before release", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  let release!: () => void;
  const latch = new Promise<void>((done) => { release = done; });
  assert.equal(manager.start(request(workspace, "one"), async (_signal, log) => {
    const bytes = Buffer.from("训练中\n");
    log("stdout", bytes.subarray(0, 2));
    log("stdout", bytes.subarray(2));
    await latch;
    await writeFile(resolve(workspace, "result.txt"), "first");
    return result("one");
  }).state, "queued");
  await until(() => manager.get("one", owner).state === "running");
  manager.start(request(workspace, "two"), async () => {
    assert.ok(manager.get("one", owner).version, "the preceding writer committed its version before release");
    return result("two");
  });
  assert.equal(manager.get("two", owner).state, "queued");
  assert.equal(manager.logs("one", owner).chunks.map((chunk) => chunk.text).join(""), "训练中\n");
  assert.throws(() => manager.get("one", { ...owner, agentId: "other" }), /not found/);
  assert.equal(manager.start(request(workspace, "one"), async () => assert.fail("duplicate command launched")).state, "running");
  const second = resolve(root, "second-workspace");
  await mkdir(second);
  manager.start(request(second, "parallel"), async () => result("parallel"));
  await until(() => manager.get("parallel", owner).state === "completed");
  assert.equal(manager.get("one", owner).state, "running");
  release();
  await until(() => manager.get("two", owner).state === "completed");
  const versions = new VersionStore(root);
  const ref = manager.get("one", owner).version!;
  await versions.validateClosure(ref);
  const record = await versions.readRecord<{ workspace: typeof ref; stdout: typeof ref }>(ref, "WorkspaceExecution");
  assert.equal((await versions.readState(record.value.stdout)).toString(), "训练中\n");
  const refs = await RefStore.open(versions);
  try { assert.ok(refs.roots().some((entry) => entry.digest === ref.digest)); } finally { refs.close(); }
});

test("cancel waits for process join; queued cancellation never starts or replays a command", async (context) => {
  const { manager, workspace } = await fixture(context);
  let joined = false;
  manager.start(request(workspace, "running"), async (signal, log) => {
    log("stderr", Buffer.from("progress"));
    await new Promise<void>((done) => signal.addEventListener("abort", () => setTimeout(done, 20), { once: true }));
    joined = true;
    throw new Error("aborted");
  });
  await until(() => manager.get("running", owner).state === "running");
  let queuedRan = false;
  manager.start(request(workspace, "queued"), async () => { queuedRan = true; return result("queued"); });
  manager.cancel("queued", owner);
  assert.equal((await manager.cancel("running", owner)).state, "running");
  assert.equal(joined, false);
  await until(() => manager.get("running", owner).state === "cancelled" && manager.get("queued", owner).state === "cancelled");
  assert.equal(joined, true);
  assert.equal(queuedRan, false);
  assert.ok(manager.get("running", owner).version);
  assert.equal(manager.logs("running", owner).chunks[0]?.text, "progress");
});

test("cancelling a queued execution is terminal before its turn without starting the next one", async (context) => {
  const { manager, workspace } = await fixture(context);
  let release!: () => void;
  const latch = new Promise<void>((done) => { release = done; });
  manager.start(request(workspace, "head"), async () => { await latch; return result("head"); });
  await until(() => manager.get("head", owner).state === "running");
  manager.start(request(workspace, "waiting"), async () => assert.fail("a cancelled queued command launched"));
  manager.start(request(workspace, "after-cancel"), async () => result("after-cancel"));
  const cancelled = await manager.cancel("waiting", owner);
  assert.equal(cancelled.state, "cancelled", "no process was launched, so cancellation needs no join");
  assert.ok(cancelled.finishedAt);
  assert.equal(cancelled.evidence?.terminationReason, "not_started");
  assert.equal(manager.get("after-cancel", owner).state, "queued",
    "cancelling one queued command must not let the next one overtake the running head");
  release();
  await until(() => manager.get("after-cancel", owner).state === "completed");
  assert.equal(manager.get("waiting", owner).state, "cancelled");
});

test("an execution whose process cannot be verified as terminated quarantines the workspace and advances the queue", async (context) => {
  const { manager, workspace } = await fixture(context);
  // The operation rejects only after the Runner gave up on observing the kill;
  // the workspace may still have a writer, so the outcome is unknown, not a
  // cancelled exit, and later queued work must be rejected rather than wedged.
  manager.start(request(workspace, "unverified"), async (signal) => {
    await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
    throw new ProcessTerminationUnverifiedError("Shell execution could not be verified as terminated after cancellation");
  });
  await until(() => manager.get("unverified", owner).state === "running");
  manager.start(request(workspace, "behind"), async () => assert.fail("queued work launched into a quarantined workspace"));
  manager.cancel("unverified", owner);
  await until(() => manager.get("unverified", owner).state === "unknown");
  await until(() => manager.get("behind", owner).state === "failed");
  assert.match(manager.get("behind", owner).error!, /unverified process state/u);
  assert.throws(() => manager.start(request(workspace, "blocked"), async () => assert.fail("admitted after quarantine")),
    { code: "EXECUTION_RESOURCE_QUARANTINED" });
  assert.equal(manager.get("unverified", owner).evidence?.processTerminated, undefined,
    "an unverified kill must not claim the process terminated");
});

test("unknown execution fences CAS mutation and retirement after Runner lease release and restart", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "manager-shared-fence-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  let manager = new ExecutionManager(root);
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  manager.start(request(workspace, "shared-fence"), async () => {
    throw new ProcessTerminationUnverifiedError("synthetic unverified child");
  });
  await until(() => manager.get("shared-fence", owner).state === "unknown", 30_000);
  const mutation = () => withWorkspaceMutation(new VersionStore(root), workspace,
    async () => assert.fail("API mutation bypassed Runner quarantine"), { kind: "upload" });
  await assert.rejects(mutation(), { code: "WORKSPACE_EXECUTION_UNVERIFIED" });
  await manager.close();
  const restarted = new ExecutionManager(root);
  manager = restarted;
  await restarted.ready();
  await assert.rejects(mutation(), { code: "WORKSPACE_EXECUTION_UNVERIFIED" });
  await assert.rejects(withWorkspaceRetirement(new VersionStore(root), [workspace], "delete", async () => {
    assert.fail("API deletion bypassed Runner quarantine");
  }), { code: "WORKSPACE_EXECUTION_UNVERIFIED" });
  assert.equal(restarted.get("shared-fence", owner).state, "unknown");
});

test("missing-handle cancellation keeps its stop intent across restart and repeated cancellation", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "manager-missing-stop-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  let manager = new ExecutionManager(root);
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  manager.start(request(workspace, "missing-stop"), async () => {
    throw new ProcessTerminationUnverifiedError("no handle captured");
  });
  await until(() => manager.get("missing-stop", owner).state === "unknown", 30_000);
  await assert.rejects(manager.cancel("missing-stop", owner), { code: "EXECUTION_BOUNDARY_UNAVAILABLE" });
  const first = manager.get("missing-stop", owner).boundary?.stopRequestedAt;
  assert.ok(first);
  await manager.close();
  const restarted = new ExecutionManager(root);
  manager = restarted;
  await restarted.ready();
  assert.equal(restarted.get("missing-stop", owner).boundary?.stopRequestedAt, first);
  await assert.rejects(restarted.cancel("missing-stop", owner), { code: "EXECUTION_BOUNDARY_UNAVAILABLE" });
  assert.equal(restarted.get("missing-stop", owner).boundary?.stopRequestedAt, first);
});

test("running cancellation persists its stop intent before abort and later operation saves retain it", async context => {
  const { manager, workspace } = await fixture(context);
  let intentAtAbort: string | undefined;
  manager.start(request(workspace, "running-stop"), async signal => {
    await new Promise<void>(done => signal.addEventListener("abort", () => {
      intentAtAbort = manager.get("running-stop", owner).boundary?.stopRequestedAt;
      done();
    }, { once: true }));
    return result("running-stop");
  });
  await until(() => manager.get("running-stop", owner).state === "running", 30_000);
  const cancelled = await manager.cancel("running-stop", owner);
  const cancellationRevision = cancelled.receipt!.revision;
  assert.ok(intentAtAbort);
  assert.equal(cancelled.boundary?.stopRequestedAt, intentAtAbort);
  await until(() => manager.get("running-stop", owner).state === "cancelled", 30_000);
  assert.equal(manager.get("running-stop", owner).boundary?.stopRequestedAt, intentAtAbort);
  assert.ok(manager.get("running-stop", owner).receipt!.revision > cancellationRevision);
});

test("running cancellation never aborts when its durable stop-intent write fails", async context => {
  const { manager, workspace, root } = await fixture(context);
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  manager.start(request(workspace, "stop-storage-failure"), async current => {
    signal = current;
    current.addEventListener("abort", () => finish.resolve(), { once: true });
    await finish.promise;
    return result("stop-storage-failure");
  });
  await until(() => signal !== undefined, 30_000);
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_stop BEFORE UPDATE ON executions
      WHEN NEW.id = 'stop-storage-failure'
      BEGIN SELECT RAISE(ABORT, 'injected stop-intent failure'); END;`);
    await assert.rejects(manager.cancel("stop-storage-failure", owner), /injected stop-intent failure/);
    assert.equal(signal?.aborted, false);
    assert.equal(manager.get("stop-storage-failure", owner).boundary?.stopRequestedAt, undefined);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_stop");
    db.close();
    finish.resolve();
  }
  await until(() => manager.get("stop-storage-failure", owner).state === "completed", 30_000);
});

test("managed resources wait for the boundary check and unknown executions retain their environment fence", async context => {
  const { manager, workspace, root } = await fixture(context, {
    captureBoundary: executionId => ({ status: "captured",
      handle: JSON.parse(boundaryRow(executionId, { namespaces: [] })) as ExecutionBoundaryHandle }),
  });
  let cleaned = false;
  manager.start({ ...request(workspace, "retain-resources"), environmentId: "selected" }, async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle?.retainResource);
    lifecycle.retainResource(async () => { cleaned = true; }, "synthetic-managed-launch");
    lifecycle.spawned({ pid: ABSENT_PID, kind: "pid-namespace", sandbox: "bubblewrap" });
    assert.equal(cleaned, false);
    return result("retain-resources");
  });
  await until(() => manager.get("retain-resources", owner).state === "unknown", 30_000);
  assert.equal(cleaned, false);
  assert.throws(() => assertEnvironmentMutationAllowed(resolve(root, "runner-executions/executions.sqlite"), "selected"),
    { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
});

test("verified managed completion cleans once and releases external CAS and environment mutations", async context => {
  const { manager, workspace, root } = await fixture(context);
  let cleanups = 0;
  const cleanup = async () => { cleanups++; };
  manager.start({ ...request(workspace, "release-resources"), environmentId: "selected" }, async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle?.retainResource);
    lifecycle.retainResource(cleanup, "synthetic-managed-launch");
    lifecycle.retainResource(cleanup, "synthetic-managed-launch");
    assert.equal(cleanups, 0);
    assert.throws(() => assertEnvironmentMutationAllowed(resolve(root, "runner-executions/executions.sqlite"), "selected"),
      { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
    return result("release-resources");
  });
  await until(() => manager.get("release-resources", owner).state === "completed", 30_000);
  await withWorkspaceMutation(new VersionStore(root), workspace, async () => {}, { kind: "external-after-completion" });
  assert.equal(cleanups, 1);
  assert.doesNotThrow(() => assertEnvironmentMutationAllowed(resolve(root, "runner-executions/executions.sqlite"), "selected"));
});

test("cancellation after durable fencing but before spawn removes only the unstarted execution fences", async context => {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  // Resolve the pause even when an assertion fails before cancellation.
  context.after(() => proceed.resolve());
  const { manager, workspace, root } = await fixture(context, {
    afterFence: async () => { entered.resolve(); await proceed.promise; },
  });
  let launched = false;
  manager.start({ ...request(workspace, "fenced-not-started"), environmentId: "selected" }, async () => {
    launched = true; return result("fenced-not-started");
  });
  await entered.promise;
  await manager.cancel("fenced-not-started", owner);
  proceed.resolve();
  await withWorkspaceMutation(new VersionStore(root), workspace, async () => {}, { kind: "after-not-started" });
  assert.equal(launched, false);
  assert.equal(manager.get("fenced-not-started", owner).evidence?.terminationReason, "not_started");
  assert.equal(manager.get("fenced-not-started", owner).version, undefined);
  assert.doesNotThrow(() => assertEnvironmentMutationAllowed(resolve(root, "runner-executions/executions.sqlite"), "selected"));
});

test("empty or malformed environment IDs cannot bypass default-runtime resource fencing", async context => {
  const { manager, workspace } = await fixture(context);
  for (const environmentId of ["", " ", " selected"]) {
    assert.throws(() => manager.start({ ...request(workspace, "bad-env"), environmentId }, async () => {
      assert.fail("invalid environment selection launched");
    }), /Invalid environment ID/);
  }
});

test("validated publication recovery releases only evidence-backed workspace and environment fences", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "manager-resource-publication-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  let manager = new ExecutionManager(root);
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const commit = RefStore.prototype.commit;
  context.mock.method(RefStore.prototype, "commit", async function(this: RefStore, ...args: Parameters<RefStore["commit"]>) {
    const result = await commit.apply(this, args);
    if ((await args[0].readRecord(args[3])).kind === "WorkspaceExecution") throw new Error("synthetic response loss after publication");
    return result;
  });
  let launches = 0;
  manager.start({ ...request(workspace, "publication-resources"), environmentId: "selected" }, async () => {
    launches++; return result("publication-resources");
  });
  await until(() => manager.get("publication-resources", owner).state === "unknown", 30_000);
  await manager.close();
  manager = new ExecutionManager(root);
  await manager.ready();
  assert.equal(manager.get("publication-resources", owner).state, "completed");
  assert.equal(manager.get("publication-resources", owner).evidence?.processTerminated, true);
  assert.equal(launches, 1);
  await withWorkspaceMutation(new VersionStore(root), workspace, async () => {}, { kind: "after-proven-publication-recovery" });
  assert.doesNotThrow(() => assertEnvironmentMutationAllowed(resolve(root, "runner-executions/executions.sqlite"), "selected"));
});

test("external file publication waits for cancelled process join and the execution ref commit", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  let joined = false;
  manager.start(request(workspace, "writer"), async (signal) => {
    await new Promise<void>((done) => signal.addEventListener("abort", () => setTimeout(done, 40), { once: true }));
    joined = true;
    await writeFile(resolve(workspace, "partial"), "cancelled output");
    throw new Error("cancelled");
  });
  await until(() => manager.get("writer", owner).state === "running");
  let published = false;
  const versions = new VersionStore(root);
  const upload = withWorkspaceMutation(versions, workspace, async () => {
    assert.equal(joined, true);
    assert.ok(manager.get("writer", owner).version);
    const refs = await RefStore.open(versions);
    try { assert.deepEqual(refs.head(workspaceHeadName(workspace)), manager.get("writer", owner).version); }
    finally { refs.close(); }
    await writeFile(resolve(workspace, "upload"), "new output"); published = true;
  }, { kind: "external-upload" });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(published, false);
  assert.equal(manager.get("writer", owner).state, "running");
  manager.cancel("writer", owner);
  assert.equal(published, false);
  await upload;
  assert.equal(published, true);
});

test("restart retains completed results and marks unfinished records unknown without replay", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const first = new ExecutionManager(root);
  first.start(request(workspace, "finished"), async () => result("finished"));
  await until(() => first.get("finished", owner).state === "completed");
  await first.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run("lost", owner.sessionId, owner.agentId,
    JSON.stringify({ ...owner, id: "lost", state: "running", queuedAt: new Date().toISOString() }));
  db.close();
  const restarted = new ExecutionManager(root);
  await restarted.ready();
  try {
    assert.equal(restarted.get("finished", owner).result?.stdout, "done");
    assert.equal(restarted.get("lost", owner).state, "unknown");
    assert.match(restarted.get("lost", owner).error!, /not replayed/);
    assert.throws(() => restarted.start(request(workspace, "lost"), async () => result("lost")), { code: "EXECUTION_ID_CONFLICT", statusCode: 409 });
    assert.equal(restarted.get("lost", owner).finishedAt, undefined);
    assert.equal(restarted.get("lost", owner).evidence, undefined);
    assert.throws(() => restarted.start(request(workspace, "new"), async () => result("new")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await restarted.close(); }
});

test("log retention is explicit, paginated and does not stop execution", async (context) => {
  const { manager, workspace } = await fixture(context);
  manager.start({ ...request(workspace, "verbose"), maxOutputBytes: 25_000 }, async (_signal, log) => {
    log("stdout", Buffer.from("x".repeat(30_000)));
    return result("verbose");
  });
  await until(() => manager.get("verbose", owner).state === "completed");
  const first = manager.logs("verbose", owner);
  assert.equal(first.retentionTruncated, true);
  assert.equal(first.truncated, true);
  const second = manager.logs("verbose", owner, first.nextCursor);
  assert.ok(second.nextCursor > first.nextCursor);
  assert.equal(second.truncated, false);
  assert.equal([...first.chunks, ...second.chunks].reduce((sum, chunk) => sum + chunk.text.length, 0), 25_000);
});

test("workspace snapshot failure closes writer admission instead of claiming a committed version", async (context) => {
  const { manager, workspace } = await fixture(context);
  manager.start(request(workspace, "broken"), async () => {
    await rm(workspace, { recursive: true });
    return result("broken");
  });
  await until(() => manager.get("broken", owner).state === "failed");
  assert.equal(manager.get("broken", owner).version, undefined);
  assert.match(manager.get("broken", owner).error!, /version commit failed/);
  assert.throws(() => manager.start(request(workspace, "next"), async () => result("next")), /repair storage/);
});

test("failed atomic ref publication never reports an unrooted Execution version", async (context) => {
  const { manager, workspace } = await fixture(context);
  context.mock.method(RefStore.prototype, "commit", async () => { throw new Error("injected ref publication failure"); });
  manager.start(request(workspace, "unrooted"), async () => result("unrooted"));
  await until(() => manager.get("unrooted", owner).state === "failed");
  const execution = manager.get("unrooted", owner);
  assert.equal(execution.version, undefined, "CAS bytes alone are not a committed Workspace version");
  assert.match(execution.error!, /ref publication failure/);
  assert.throws(() => manager.start(request(workspace, "later"), async () => result("later")), /repair storage/);
});

test("a caught HTTP denial still fails the managed execution and commits its partial workspace", async context => {
  const { manager, workspace, root } = await fixture(context);
  manager.start(request(workspace, "caught-denial"), async () => {
    await writeFile(resolve(workspace, "partial.txt"), "already wrote");
    return { ...result("caught-denial"), networkDeniedHosts: ["pypi.org:443"] };
  });
  await until(() => manager.get("caught-denial", owner).state === "failed");
  const record = manager.get("caught-denial", owner);
  assert.equal(record.result!.exitCode, 0, "retain actual process exit status rather than falsifying it");
  assert.deepEqual(record.result!.networkDeniedHosts, ["pypi.org:443"]);
  assert.ok(record.version);
  await new VersionStore(root).validateClosure(record.version!);
});

test("cancellation wins over a successful late process result without losing its audit", async context => {
  const { manager, workspace } = await fixture(context);
  manager.start(request(workspace, "late-success"), async signal => {
    await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
    return result("late-success");
  });
  await until(() => manager.get("late-success", owner).state === "running");
  manager.cancel("late-success", owner);
  await until(() => manager.get("late-success", owner).state === "cancelled");
  assert.equal(manager.get("late-success", owner).result!.exitCode, 0);
  assert.ok(manager.get("late-success", owner).version);
});

test("explicit Specialist handoff records execution receipts without snapshotting undeclared files", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  manager.start({ ...request(workspace, "explicit"), explicitHandoff: true }, async () => {
    await writeFile(resolve(workspace, "private.txt"), "must-not-be-versioned");
    return result("explicit");
  });
  await until(() => !["queued", "running"].includes(manager.get("explicit", owner).state));
  const execution = manager.get("explicit", owner);
  assert.equal(execution.state, "completed", execution.error ?? "");
  assert.ok(execution.version, "execution receipt remains durable");
  assert.equal(execution.result?.workspaceSnapshot, undefined);
  const record = await new VersionStore(root).readRecord<{ workspace?: unknown }>(execution.version!, "WorkspaceExecution");
  assert.equal(record.value.workspace, undefined, "no file tree or undeclared bytes in the execution version");
});

test("identical concurrent submissions return one durable receipt and launch only once", async (context) => {
  const { manager, workspace } = await fixture(context);
  let launches = 0;
  const input = request(workspace, "same");
  const submissions = await Promise.all(Array.from({ length: 25 }, () => Promise.resolve().then(() => manager.submit(input, async () => {
    launches += 1;
    return result("same");
  }))));
  assert.equal(submissions.filter(submission => submission.accepted).length, 1);
  const receipt = submissions[0]!.execution.receipt!;
  assert.equal(receipt.revision, 1);
  assert.match(receipt.requestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.runnerInstanceId, manager.identity.runnerInstanceId);
  assert.equal(receipt.runnerBootId, manager.identity.runnerBootId);
  assert.ok(submissions.every(submission => submission.execution.receipt?.requestDigest === receipt.requestDigest));
  await until(() => manager.get("same", owner).state === "completed");
  assert.equal(launches, 1);
  const completed = manager.get("same", owner);
  assert.ok(completed.receipt!.revision > receipt.revision);
  assert.equal(completed.evidence?.processTerminated, true);
  assert.equal(completed.evidence?.revision, completed.receipt?.revision);
  assert.equal(completed.evidence?.workspaceVersionDigest, completed.version?.digest);
  assert.match(completed.evidence!.resultDigest!, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manager.submit(input, async () => assert.fail("terminal replay launched")), { execution: completed, accepted: false });
});

test("canonical request digest ignores object key ordering but binds all execution inputs and ownership", async (context) => {
  const { manager, workspace } = await fixture(context);
  const input = { ...request(workspace, "canonical"), npuDevices: [0, 1], cwd: "subdir", maxOutputBytes: 300 };
  const accepted = manager.start(input, async () => result("canonical"));
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as ShellExecutionRequest;
  assert.equal(manager.submit(reordered, async () => assert.fail("reordered payload launched")).accepted, false);
  const variants: ShellExecutionRequest[] = [
    { ...input, code: "different command" }, { ...input, workspaceRoot: `${workspace}-other` },
    { ...input, npuDevices: [1, 0] }, { ...input, environmentId: "other" },
    { ...input, maxOutputBytes: 301 }, { ...input, permissionEpoch: { ...input.permissionEpoch, sessionId: "other-session" } },
    { ...input, agentId: "other-agent" },
  ];
  for (const variant of variants) {
    assert.throws(() => manager.submit(variant, async () => assert.fail("conflict launched")), error => {
      assert.ok(error instanceof ExecutionManagerError);
      assert.equal(error.code, "EXECUTION_ID_CONFLICT");
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "Execution ID conflicts with an existing submission");
      return true;
    });
  }
  await until(() => manager.get("canonical", owner).state === "completed");
  assert.equal(manager.get("canonical", owner).receipt?.requestDigest, accepted.receipt?.requestDigest);
});

test("restart preserves identity and quarantines original workspace and selected devices without replay", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-quarantine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  const other = resolve(root, "other");
  await mkdir(workspace); await mkdir(other);
  const first = new ExecutionManager(root);
  const identity = first.identity;
  const input = { ...request(workspace, "orphan"), npuDevices: [0] };
  first.start(input, async () => result("orphan"));
  await until(() => first.get("orphan", owner).state === "completed");
  const original = first.get("orphan", owner);
  await first.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  const interrupted = { ...original, state: "running", result: undefined, version: undefined, evidence: undefined, finishedAt: undefined };
  db.prepare("UPDATE executions SET record = ? WHERE id = ?").run(JSON.stringify(interrupted), "orphan");
  db.close();
  const restarted = new ExecutionManager(root);
  await restarted.ready();
  try {
    assert.equal(restarted.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.notEqual(restarted.identity.runnerBootId, identity.runnerBootId);
    const recovered = restarted.get("orphan", owner);
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.finishedAt, undefined);
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.workspaceKey, workspace);
    assert.deepEqual(recovered.npuDevices, [0]);
    assert.ok(recovered.receipt!.revision > original.receipt!.revision);
    assert.equal(recovered.receipt?.runnerBootId, identity.runnerBootId);
    assert.deepEqual(restarted.submit(input, async () => assert.fail("orphan replay launched")), { execution: recovered, accepted: false });
    // No durable boundary was ever recorded, so the restart cannot prove which
    // process (if any) belongs to this execution. Cancellation fails closed:
    // nothing is signaled and the workspace/device quarantine stays in force.
    await assert.rejects(restarted.cancel("orphan", owner), { code: "EXECUTION_BOUNDARY_UNAVAILABLE" });
    assert.throws(() => restarted.start(request(workspace, "same-workspace"), async () => assert.fail("workspace isolation lost")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    assert.throws(() => restarted.start({ ...request(other, "same-device"), npuDevices: [0] }, async () => assert.fail("device isolation lost")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    restarted.start({ ...request(other, "unrelated"), npuDevices: [1] }, async () => result("unrelated"));
    await until(() => restarted.get("unrelated", owner).state === "completed");
  } finally { await restarted.close(); }
  const again = new ExecutionManager(root);
  await again.ready();
  try {
    assert.equal(again.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.throws(() => again.start(request(workspace, "still-blocked"), async () => assert.fail("quarantine expired")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    assert.equal(again.get("unrelated", owner).state, "completed");
  } finally { await again.close(); }
});

test("a legacy unknown record without resource scope blocks unrelated new submissions too", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-legacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExecutionManager(root);
  await manager.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run("legacy", owner.sessionId, owner.agentId,
    JSON.stringify({ ...owner, id: "legacy", state: "unknown", queuedAt: new Date().toISOString() }));
  db.close();
  const restarted = new ExecutionManager(root);
  await restarted.ready();
  try {
    assert.throws(() => restarted.start({ ...request("/unrelated-workspace", "new-id"), npuDevices: [7] }, async () => assert.fail("legacy unknown admitted work")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await restarted.close(); }
});

test("process exit is journaled before result publication and terminal state follows its commit", async context => {
  const { manager, workspace } = await fixture(context);
  let finish!: () => void;
  const operationLatch = new Promise<void>(done => { finish = done; });
  manager.start(request(workspace, "journal"), async () => { await operationLatch; return result("journal"); });
  await until(() => manager.get("journal", owner).state === "running");
  let publish!: () => void;
  const publicationLatch = new Promise<void>(done => { publish = done; });
  let publishing = false;
  const commit = RefStore.prototype.commit;
  context.mock.method(RefStore.prototype, "commit", async function(this: RefStore, ...args: Parameters<RefStore["commit"]>) {
    publishing = true;
    await publicationLatch;
    return commit.apply(this, args);
  });
  finish();
  await until(() => publishing);
  const pending = manager.get("journal", owner);
  assert.equal(pending.state, "running");
  assert.equal(pending.finishedAt, undefined);
  assert.equal(pending.evidence?.processTerminated, true);
  assert.equal(pending.evidence?.resultDigest, undefined);
  assert.equal(pending.evidence?.workspaceVersionDigest, undefined);
  assert.equal(pending.version, undefined);
  publish();
  await until(() => manager.get("journal", owner).state === "completed");
  assert.ok(manager.get("journal", owner).receipt!.revision > pending.receipt!.revision);
});

test("Unicode log cursors remain stable across pagination, duplicate submission and restart", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-unicode-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const manager = new ExecutionManager(root);
  const text = "训练🧬\n".repeat(5000);
  manager.start(request(workspace, "unicode"), async (_signal, log) => {
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length; offset += 11) log("stdout", bytes.subarray(offset, offset + 11));
    return result("unicode");
  });
  // The 55 KB log is written in 11-byte chunks and committed through CAS plus a
  // workspace snapshot. It can exceed 30 s while the full UT layer is sharing
  // a slow disk, so the completion wait needs a bound sized for that load; every
  // content/cursor/dedup/restart assertion below still checks exact bytes.
  await until(() => manager.get("unicode", owner).state === "completed", 60_000);
  const first = manager.logs("unicode", owner);
  const terminal = manager.get("unicode", owner);
  await manager.close();
  const restarted = new ExecutionManager(root);
  await restarted.ready();
  try {
    assert.deepEqual(restarted.get("unicode", owner), terminal);
    assert.deepEqual(restarted.logs("unicode", owner), first);
    assert.equal(restarted.submit(request(workspace, "unicode"), async () => assert.fail("logs replay started process")).accepted, false);
    let reconstructed = first.chunks.map(chunk => chunk.text).join("");
    let cursor = first.nextCursor;
    while (true) {
      const page = restarted.logs("unicode", owner, cursor);
      if (!page.chunks.length) break;
      assert.ok(page.chunks.every(chunk => chunk.cursor > cursor));
      reconstructed += page.chunks.map(chunk => chunk.text).join("");
      cursor = page.nextCursor;
    }
    assert.equal(reconstructed, text);
    assert.equal(reconstructed.includes("�"), false);
  } finally { await restarted.close(); }
});

test("corrupt SQLite, corrupt records and lost receipt identity fail closed rather than replacing the ledger", async context => {
  for (const corruption of ["sqlite", "empty", "missing", "record", "identity", "future-schema", "missing-table"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "execution-corrupt-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const manager = new ExecutionManager(root);
    manager.start(request(workspace, "saved"), async () => result("saved"));
    await until(() => manager.get("saved", owner).state === "completed");
    await manager.close();
    const path = resolve(root, "runner-executions", "executions.sqlite");
    if (corruption === "sqlite") await writeFile(path, "not a sqlite ledger");
    else if (corruption === "empty") await writeFile(path, "");
    else if (corruption === "missing") await rm(path);
    else {
      const db = new DatabaseSync(path);
      if (corruption === "missing-table") db.exec("DROP TABLE executions");
      else if (corruption === "future-schema") db.exec("PRAGMA user_version=99");
      else if (corruption === "record") db.prepare("UPDATE executions SET record = ?").run("{invalid JSON");
      else db.exec("DELETE FROM execution_metadata WHERE key = 'runnerInstanceId'");
      db.close();
    }
    assert.throws(() => new ExecutionManager(root), { code: "EXECUTION_LEDGER_UNAVAILABLE", statusCode: 503 });
  }
});

test("a second manager cannot relabel or launch work while the ledger has a live owner", async context => {
  const { manager, workspace, root } = await fixture(context);
  let finish!: () => void;
  const latch = new Promise<void>(done => { finish = done; });
  manager.start(request(workspace, "live"), async () => { await latch; return result("live"); });
  await until(() => manager.get("live", owner).state === "running");
  try {
    assert.throws(() => new ExecutionManager(root), { code: "RUNNER_ALREADY_ACTIVE", statusCode: 503 });
    assert.equal(manager.get("live", owner).state, "running");
  } finally { finish(); }
  await until(() => manager.get("live", owner).state === "completed");
});

test("a crashed Runner releases the OS-owned ledger lock and restart quarantines its original execution", { timeout: 10_000 }, async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-process-crash-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = request(workspace, "crashed");
  const script = `
    import { ExecutionManager } from ${JSON.stringify(new URL("./execution-manager.ts", import.meta.url).href)};
    const manager = new ExecutionManager(${JSON.stringify(root)});
    manager.start(${JSON.stringify(input)}, async () => new Promise(() => {}));
    const timer = setInterval(() => {
      if (manager.get("crashed", ${JSON.stringify(owner)}).state === "running") {
        process.send(manager.identity);
        clearInterval(timer);
        setInterval(() => {}, 1000);
      }
    }, 5);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  context.after(() => { child.kill("SIGKILL"); });
  let childErrors = "";
  assert.ok(child.stderr);
  child.stderr.on("data", chunk => { childErrors += String(chunk); });
  const [identity] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error(`Runner child exited before acceptance: ${childErrors}`); }),
  ]) as [{ runnerInstanceId: string; runnerBootId: string }];
  assert.throws(() => new ExecutionManager(root), { code: "RUNNER_ALREADY_ACTIVE" });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const restarted = new ExecutionManager(root);
  await restarted.ready();
  try {
    assert.equal(restarted.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.notEqual(restarted.identity.runnerBootId, identity.runnerBootId);
    const recovered = restarted.get("crashed", owner);
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.finishedAt, undefined);
    assert.equal(restarted.submit(input, async () => assert.fail("crashed command replayed")).accepted, false);
    assert.throws(() => restarted.start(request(workspace, "next"), async () => assert.fail("orphan workspace reused")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await restarted.close(); }
});

for (const point of ["before-publication", "after-publication", "conflicting-head", "invalid-target", "missing-cas"] as const) {
  test(`restart recovers durable publication without compute replay: ${point}`, { timeout: 10_000 }, async context => {
    const root = await mkdtemp(resolve(tmpdir(), "execution-publication-crash-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    context.after(() => rm(root, { recursive: true, force: true }));
    const input = request(workspace, "publication-crash");
    const script = `
      import { ExecutionManager } from ${JSON.stringify(new URL("./execution-manager.ts", import.meta.url).href)};
      import { RefStore } from "@sciencediscovery/cas";
      const manager = new ExecutionManager(${JSON.stringify(root)});
      const commit = RefStore.prototype.commit;
      RefStore.prototype.commit = async function(store, name, expected, target) {
        const record = await store.readRecord(target);
        if (record.kind !== "WorkspaceExecution") return commit.call(this, store, name, expected, target);
        if (${JSON.stringify(point)} === "after-publication") await commit.call(this, store, name, expected, target);
        process.send({ target, name });
        await new Promise(() => {});
      };
      manager.start(${JSON.stringify(input)}, async (_signal, log) => {
        log("stdout", Buffer.from("original-result"));
        return ${JSON.stringify(result("publication-crash"))};
      });
      setInterval(() => {}, 1000);
    `;
    // Resolve CAS in the child's normal Runner package workspace.
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    context.after(() => { child.kill("SIGKILL"); });
    let errors = "";
    assert.ok(child.stderr);
    child.stderr.on("data", chunk => { errors += String(chunk); });
    const [publication] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error(`Crash fixture exited before journal: ${errors}`); }),
    ]) as [{ target: NonNullable<import("@sciencediscovery/schema").ManagedExecution["version"]>; name: string }];
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const versions = new VersionStore(root);
    const refsBefore = await RefStore.open(versions);
    let sequenceBefore: number | undefined;
    try {
      sequenceBefore = refsBefore.publicationSequence(publication.name, publication.target);
      if (point === "conflicting-head") {
        const other = await versions.putRecord("WorkspaceMutation", { kind: "conflicting-test-publication" });
        await refsBefore.commit(versions, publication.name, refsBefore.head(publication.name), other);
      }
    } finally { refsBefore.close(); }
    if (point === "missing-cas") await rm(versions.objectPath(publication.target));
    if (point === "invalid-target") {
      const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
      const row = db.prepare("SELECT record FROM execution_publications WHERE id = ?").get(input.executionId)!;
      const journal = JSON.parse(String(row.record));
      journal.execution.evidence.resultDigest = `sha256:${"0".repeat(64)}`;
      db.prepare("UPDATE execution_publications SET record = ? WHERE id = ?").run(JSON.stringify(journal), input.executionId);
      db.close();
    }
    let releaseValidation!: () => void;
    let validating = false;
    if (point === "before-publication") {
      const latch = new Promise<void>(done => { releaseValidation = done; });
      const validate = VersionStore.prototype.validateClosure;
      context.mock.method(VersionStore.prototype, "validateClosure", async function(this: VersionStore, ref: Parameters<VersionStore["validateClosure"]>[0]) {
        validating = true;
        await latch;
        return validate.call(this, ref);
      });
    }
    const diagnostics: ExecutionQuarantineDiagnostic[] = [];
    const restarted = new ExecutionManager(root, detail => { diagnostics.push(detail); throw new Error("sink unavailable"); });
    let recoveredRevision: number | undefined;
    try {
      assert.throws(() => restarted.get(input.executionId, owner), { code: "EXECUTION_RECOVERY_PENDING", statusCode: 503 });
      if (point === "before-publication") {
        await until(() => validating);
        assert.throws(() => restarted.get(input.executionId, { ...owner, agentId: "other" }), { code: "EXECUTION_NOT_FOUND", statusCode: 404 });
        assert.throws(() => restarted.submit(input, async () => assert.fail("recovering POST replayed")), { code: "EXECUTION_RECOVERY_PENDING", statusCode: 503 });
        assert.equal(restarted.logs(input.executionId, owner).chunks.map(chunk => chunk.text).join(""), "original-result");
      }
      assert.throws(() => restarted.start(request(workspace, "premature"), async () => assert.fail("recovery admitted work")), { code: "EXECUTION_RECOVERY_PENDING" });
      releaseValidation?.();
      await restarted.ready();
      const recovered = restarted.get(input.executionId, owner);
      assert.equal(restarted.submit(input, async () => assert.fail("publication recovery replayed compute")).accepted, false);
      if (point === "conflicting-head" || point === "invalid-target" || point === "missing-cas") {
        assert.equal(recovered.state, "unknown");
        assert.equal(recovered.version, undefined);
        assert.match(recovered.error!, /recovery is blocked/);
        assert.equal(diagnostics.filter(detail => detail.phase === "publication-recovery").length, 1,
          "catch and rebuild of the same unresolved fence emit once despite a throwing sink");
        assert.equal(diagnostics.find(detail => detail.phase === "publication-recovery")?.executionId, input.executionId);
      } else {
        assert.equal(recovered.state, "completed");
        assert.equal(recovered.result?.stdout, "done");
        assert.deepEqual(recovered.version, publication.target);
        assert.equal(recovered.evidence?.processTerminated, true);
        assert.equal(recovered.evidence?.revision, recovered.receipt?.revision);
        assert.equal(restarted.logs(input.executionId, owner).chunks.map(chunk => chunk.text).join(""), "original-result");
        recoveredRevision = recovered.receipt?.revision;
        const refs = await RefStore.open(versions);
        try {
          assert.deepEqual(refs.head(publication.name), publication.target);
          if (point === "after-publication") assert.equal(refs.publicationSequence(publication.name, publication.target), sequenceBefore, "already rooted result is never republished");
        } finally { refs.close(); }
      }
      // The generic CAS active marker intentionally needs explicit fence repair.
      assert.throws(() => restarted.start(request(workspace, "after-recovery"), async () => assert.fail("ambiguous active marker cleared")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    } finally { releaseValidation?.(); await restarted.close(); }
    if (recoveredRevision !== undefined) {
      const again = new ExecutionManager(root);
      try {
        await again.ready();
        assert.equal(again.get(input.executionId, owner).state, "completed");
        assert.equal(again.get(input.executionId, owner).receipt?.revision, recoveredRevision, "repeated publication recovery is idempotent");
      } finally { await again.close(); }
    }
  });
}


test("startup quarantine diagnostics expose only scope and IDs and cannot release admission", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "quarantine-diagnostic-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const initial = new ExecutionManager(root); await initial.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  for (const [id, extra] of [["scoped", { workspaceKey: "/workspace/example", npuDevices: [2] }], ["legacy", {}]] as const) {
    db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(id, owner.sessionId, owner.agentId,
      JSON.stringify({ ...owner, id, state: "unknown", queuedAt: "now", error: "SECRET_SENTINEL", result: { stdout: "SECRET_SENTINEL" }, ...extra }));
  }
  db.close();
  const messages: ExecutionQuarantineDiagnostic[] = [];
  const restarted = new ExecutionManager(root, detail => { messages.push(detail); throw new Error("diagnostic sink unavailable"); });
  await restarted.ready();
  try {
    assert.deepEqual(messages, ["startup", "publication-recovery"].flatMap((phase) => [
      { phase, executionId: "scoped", scope: "workspace-and-devices", workspaceKeyHash: createHash("sha256").update("/workspace/example").digest("hex"), npuDevices: [2] },
      { phase, executionId: "legacy", scope: "runner" },
    ]));
    assert.ok(!JSON.stringify(messages).includes("SECRET_SENTINEL"));
    assert.ok(!JSON.stringify(messages).includes("/workspace/example"), "absolute workspace paths stay out of diagnostics");
    assert.throws(() => restarted.start(request("/unrelated", "blocked"), async () => assert.fail("diagnostic released quarantine")),
      { code: "EXECUTION_RESOURCE_QUARANTINED" });
    assert.equal(restarted.get("scoped", owner).state, "unknown");
  } finally { await restarted.close(); }
});

test("Runner request receipts match shared canonical JSON golden digests", async context => {
  for (const vector of executionDigestVectors) {
    const root = await mkdtemp(resolve(tmpdir(), "execution-digest-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const manager = new ExecutionManager(root);
    let operations = 0;
    try {
      await assert.rejects(lstat(String(vector.value.workspaceRoot)), { code: "ENOENT" });
      assert.equal(`sha256:${createHash("sha256").update(vector.canonical).digest("hex")}`, vector.digest, "golden bytes and digest agree");
      const submitted = manager.submit(vector.value as unknown as ShellExecutionRequest, async () => {
        operations++;
        return result(String(vector.value.executionId));
      });
      assert.equal(submitted.execution.receipt!.requestDigest, vector.digest, vector.name);
      // Admission is intentionally impossible for the fixture's nonexistent path.
    } finally { await manager.close(); }
    assert.equal(operations, 0, "golden vectors never invoke computation");
    await assert.rejects(lstat(String(vector.value.workspaceRoot)), { code: "ENOENT" });
  }
});


test("runtime publication failure emits a fence diagnostic despite a throwing sink", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "quarantine-runtime-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const messages: ExecutionQuarantineDiagnostic[] = [];
  const manager = new ExecutionManager(root, detail => { messages.push(detail); throw new Error("sink failure"); });
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const commit = RefStore.prototype.commit;
  context.mock.method(RefStore.prototype, "commit", async function(this: RefStore, ...args: Parameters<RefStore["commit"]>) {
    const record = await args[0].readRecord(args[3]);
    if (record.kind === "WorkspaceExecution") throw new Error("injected publication failure");
    return commit.apply(this, args);
  });
  manager.submit(request(workspace, "runtime-fence"), async () => result("runtime-fence"));
  await until(() => manager.get("runtime-fence", owner).state === "unknown");
  assert.deepEqual(messages.map(detail => detail.phase), ["runtime"]);
  assert.equal(messages[0]?.executionId, "runtime-fence");
  assert.throws(() => manager.submit(request(workspace, "blocked"), async () => assert.fail("must not replay")),
    { code: "EXECUTION_RESOURCE_QUARANTINED" });
});

// --- Round 10: durable process boundary across a Runner restart ---------------

function realBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** A pid above the kernel's pid_max: no signal can ever reach a real process. */
const ABSENT_PID = 2_147_483_646;

function boundaryRow(executionId: string, overrides: Partial<ExecutionBoundaryHandle> = {}): string {
  return JSON.stringify({
    schemaVersion: EXECUTION_BOUNDARY_SCHEMA_VERSION,
    kind: "pid-namespace",
    executionId,
    sandbox: "bubblewrap",
    bootId: realBootId(),
    pid: ABSENT_PID,
    startTimeTicks: "1",
    processGroupId: ABSENT_PID,
    sessionId: ABSENT_PID,
    uid: process.getuid?.() ?? 1000,
    namespaces: ["pid:[424242]"],
    capturedAt: new Date().toISOString(),
    ...overrides,
  });
}

/**
 * Create the ledger first, then seed one interrupted execution exactly as a
 * previous Runner process would have left it: state unknown, started, no
 * receipt (that is what an older ledger looks like), and optionally a handle.
 */
async function seedInterruptedExecution(root: string, executionId: string,
  options: { workspaceKey: string; handle?: string | null }): Promise<void> {
  const created = new ExecutionManager(root);
  await created.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  const now = new Date().toISOString();
  const record = { id: executionId, sessionId: owner.sessionId, agentId: owner.agentId, state: "unknown",
    queuedAt: now, startedAt: now, workspaceKey: options.workspaceKey, npuDevices: [] };
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(executionId, owner.sessionId, owner.agentId, JSON.stringify(record));
  if (options.handle !== undefined && options.handle !== null) {
    db.prepare("INSERT INTO execution_boundaries VALUES (?, ?)").run(executionId, options.handle);
  }
  db.close();
}

test("a restart without a recorded handle observes not-recorded and refuses to cancel", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-boundary-legacy-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  await seedInterruptedExecution(root, "legacy", { workspaceKey: workspace });
  const manager = new ExecutionManager(root);
  try {
    await manager.ready();
    const recovered = manager.get("legacy", owner);
    assert.equal(recovered.state, "unknown");
    assert.deepEqual({ ...recovered.boundary, observedAt: undefined },
      { observedAt: undefined, state: "not-recorded", terminationConfirmed: false, reason: "no-handle" });
    await assert.rejects(manager.cancel("legacy", owner), { code: "EXECUTION_BOUNDARY_UNAVAILABLE" });
    const after = manager.get("legacy", owner);
    assert.equal(after.state, "unknown", "a refused cancel never settles the execution");
    assert.ok(after.boundary?.stopRequestedAt, "the stop intent is durable even when nothing was signaled");
    assert.equal(after.boundary?.terminationConfirmed, false);
    assert.throws(() => manager.start(request(workspace, "blocked"), async () => assert.fail("quarantine released")),
      { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await manager.close(); }
});

test("a restart proves an empty recorded boundary gone and cancels idempotently without settling the state", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-boundary-gone-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  await seedInterruptedExecution(root, "gone", { workspaceKey: workspace, handle: boundaryRow("gone") });
  const manager = new ExecutionManager(root);
  try {
    await manager.ready();
    const recovered = manager.get("gone", owner);
    assert.equal(recovered.boundary?.state, "gone");
    assert.equal(recovered.boundary?.terminationConfirmed, true);
    const cancelled = await manager.cancel("gone", owner);
    assert.equal(cancelled.state, "unknown", "no exit status was ever observed");
    assert.equal(cancelled.boundary?.terminationConfirmed, true);
    assert.ok(cancelled.boundary?.stopRequestedAt);
    assert.equal(cancelled.result, undefined, "no result is fabricated");
    // Repeating the request must report the same proof, not signal anything new.
    const again = await manager.cancel("gone", owner);
    assert.equal(again.state, "unknown");
    assert.equal(again.boundary?.terminationConfirmed, true);
    // Confirming termination does not release the fence; only existing recovery does.
    assert.throws(() => manager.start(request(workspace, "still-fenced"), async () => assert.fail("fence released")),
      { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await manager.close(); }
});

test("a handle from another boot is never signaled and never settles the record", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-boundary-boot-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const bystander = spawn(process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" });
  context.after(async () => {
    if (bystander.exitCode === null && bystander.signalCode === null) {
      try { bystander.kill("SIGKILL"); } catch { /* gone */ }
      await once(bystander, "exit").catch(() => undefined);
    }
  });
  const pid = bystander.pid!;
  await seedInterruptedExecution(root, "other-boot", { workspaceKey: workspace,
    handle: boundaryRow("other-boot", { bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", pid,
      processGroupId: pid, sessionId: pid }) });
  const manager = new ExecutionManager(root);
  await manager.ready();
  try {
    const recovered = manager.get("other-boot", owner);
    assert.equal(recovered.boundary?.state, "boot-changed");
    assert.equal(recovered.boundary?.terminationConfirmed, false);
    await assert.rejects(manager.cancel("other-boot", owner), error => {
      assert.ok(error instanceof ExecutionManagerError);
      assert.equal(error.code, "EXECUTION_TERMINATION_UNVERIFIED");
      assert.equal(error.statusCode, 409);
      return true;
    });
    // The pid now names an unrelated process; refusing must have left it running.
    assert.equal(sendSignal(pid, "SIGKILL"), "sent", "the bystander was alive after the refusal");
    await once(bystander, "exit");
    const after = manager.get("other-boot", owner);
    assert.equal(after.state, "unknown");
    assert.equal(after.boundary?.terminationConfirmed, false);
    assert.throws(() => manager.start(request(workspace, "blocked"), async () => assert.fail("fence released")),
      { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await manager.close(); }
});

test("a corrupt or foreign boundary row fails closed instead of being repaired", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-boundary-corrupt-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const other = resolve(root, "other"); await mkdir(other);
  context.after(() => rm(root, { recursive: true, force: true }));
  await seedInterruptedExecution(root, "corrupt", { workspaceKey: workspace, handle: "{not-json" });
  await seedInterruptedExecution(root, "foreign", { workspaceKey: other,
    handle: boundaryRow("someone-else") });
  const manager = new ExecutionManager(root);
  await manager.ready();
  try {
    for (const [id, key] of [["corrupt", workspace], ["foreign", other]] as const) {
      const recovered = manager.get(id, owner);
      assert.equal(recovered.boundary?.state, "unverifiable", id);
      assert.equal(recovered.boundary?.reason, "handle-invalid", id);
      assert.equal(recovered.boundary?.terminationConfirmed, false, id);
      await assert.rejects(manager.cancel(id, owner), { code: "EXECUTION_BOUNDARY_UNAVAILABLE" });
      assert.equal(manager.get(id, owner).state, "unknown");
      assert.throws(() => manager.start(request(key, `blocked-${id}`), async () => assert.fail("fence released")),
        { code: "EXECUTION_RESOURCE_QUARANTINED" });
    }
  } finally { await manager.close(); }
});

test("a sandbox that promised a boundary but never yielded one stays unknown and fenced", async context => {
  const { manager, workspace } = await fixture(context);
  // A live host process that is not a PID namespace init: its identity may be
  // readable, but no sandbox namespace exists to bound. That is exactly the
  // shape a capture can fail in, and it must not degrade into the legacy
  // "nothing was recorded, so nothing can be wrong" pass.
  const bare = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  context.after(async () => {
    if (bare.exitCode === null && bare.signalCode === null) {
      try { bare.kill("SIGKILL"); } catch { /* already gone */ }
      await once(bare, "exit").catch(() => undefined);
    }
  });
  manager.start(request(workspace, "uncaptured"), async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle, "a managed execution always receives a lifecycle");
    assert.ok(bare.pid);
    lifecycle.spawned({ pid: bare.pid, kind: "pid-namespace", sandbox: "bubblewrap" });
    return result("uncaptured");
  });
  await until(() => manager.get("uncaptured", owner).state === "unknown");
  const record = manager.get("uncaptured", owner);
  assert.match(record.error!, /process identity was never recorded/);
  assert.deepEqual({ ...record.boundary, observedAt: undefined },
    { observedAt: undefined, state: "not-recorded", terminationConfirmed: false, reason: "no-handle" });
  assert.equal(record.evidence, undefined, "no exit evidence is invented for an unverified sandbox");
  assert.equal(record.result, undefined, "no result is published over a possibly live writer");
  assert.equal(record.version, undefined);
  assert.throws(() => manager.start(request(workspace, "behind"), async () => assert.fail("queued work launched into a fenced workspace")),
    { code: "EXECUTION_RESOURCE_QUARANTINED" });
});

test("a recorded handle with an empty namespace list is never accepted as termination", async context => {
  const { manager, workspace } = await fixture(context, {
    captureBoundary: (executionId) => ({ status: "captured",
      handle: JSON.parse(boundaryRow(executionId, { namespaces: [] })) as ExecutionBoundaryHandle }),
  });
  manager.start(request(workspace, "empty-namespace"), async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle, "a managed execution always receives a lifecycle");
    lifecycle.spawned({ pid: ABSENT_PID, kind: "pid-namespace", sandbox: "bubblewrap" });
    return result("empty-namespace");
  });
  await until(() => manager.get("empty-namespace", owner).state === "unknown");
  const record = manager.get("empty-namespace", owner);
  // Persisted as-is by the spawn turn; only the after-run check may refuse it,
  // and it must refuse rather than let the observation path pass.
  assert.equal(record.boundary?.state, "unverifiable");
  assert.equal(record.boundary?.reason, "namespace-unverified");
  assert.equal(record.boundary?.terminationConfirmed, false);
  assert.match(record.error!, /namespace is empty and cannot be verified/);
  assert.equal(record.result, undefined);
  assert.equal(record.evidence, undefined);
  assert.throws(() => manager.start(request(workspace, "behind"), async () => assert.fail("fence released")),
    { code: "EXECUTION_RESOURCE_QUARANTINED" });
});

test("a corrupt boundary row written after capture fails the after-run check", async context => {
  const { manager, workspace, root } = await fixture(context, {
    captureBoundary: (executionId) => ({ status: "captured",
      handle: JSON.parse(boundaryRow(executionId)) as ExecutionBoundaryHandle }),
  });
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  try {
    // Simulate an edit or partial write after the Runner recorded a good row:
    // the row now exists but cannot be trusted, which is not the same thing as
    // a platform that never had one.
    db.exec(`CREATE TRIGGER corrupt_boundary AFTER INSERT ON execution_boundaries
      BEGIN UPDATE execution_boundaries SET record = '{not-json' WHERE execution = NEW.execution; END;`);
  } finally { db.close(); }
  manager.start(request(workspace, "corrupt-after-run"), async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle, "a managed execution always receives a lifecycle");
    lifecycle.spawned({ pid: ABSENT_PID, kind: "pid-namespace", sandbox: "bubblewrap" });
    return result("corrupt-after-run");
  });
  await until(() => manager.get("corrupt-after-run", owner).state === "unknown");
  const record = manager.get("corrupt-after-run", owner);
  assert.equal(record.boundary?.reason, "handle-invalid");
  assert.equal(record.boundary?.terminationConfirmed, false);
  assert.match(record.error!, /process identity is corrupt/);
  assert.equal(record.result, undefined);
  assert.throws(() => manager.start(request(workspace, "behind"), async () => assert.fail("fence released")),
    { code: "EXECUTION_RESOURCE_QUARANTINED" });
});

test("a boundary row the ledger refuses to persist stops admission instead of running unsupervised", async context => {
  const { manager, workspace, root } = await fixture(context, {
    captureBoundary: (executionId) => ({ status: "captured",
      handle: JSON.parse(boundaryRow(executionId)) as ExecutionBoundaryHandle }),
  });
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_boundary BEFORE INSERT ON execution_boundaries
      BEGIN SELECT RAISE(ABORT, 'injected boundary write failure'); END;`);
  } finally { db.close(); }
  manager.start(request(workspace, "unpersisted"), async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle, "a managed execution always receives a lifecycle");
    lifecycle.spawned({ pid: ABSENT_PID, kind: "pid-namespace", sandbox: "bubblewrap" });
    return result("unpersisted");
  });
  await until(() => manager.get("unpersisted", owner).state === "unknown");
  const record = manager.get("unpersisted", owner);
  assert.equal(record.boundary?.reason, "no-handle", "the identity that could not be stored is not claimed as recorded");
  assert.equal(record.evidence, undefined);
  assert.equal(record.result, undefined);
  // The row that could not be written also means nothing later can be fenced
  // by identity, so the ledger stops taking work instead of guessing.
  assert.throws(() => manager.start(request(workspace, "after-storage-failure"), async () => result("after")),
    { code: "EXECUTION_LEDGER_UNAVAILABLE" });
});

test("a sandbox that ended in its spawn turn is not quarantined for a boundary it cannot have", async context => {
  const { manager, workspace, root } = await fixture(context, {
    captureBoundary: () => ({ status: "ended" }),
  });
  manager.start(request(workspace, "ended-at-spawn"), async (_signal, _log, _revision, lifecycle) => {
    assert.ok(lifecycle, "a managed execution always receives a lifecycle");
    lifecycle.spawned({ pid: ABSENT_PID, kind: "pid-namespace", sandbox: "bubblewrap" });
    return result("ended-at-spawn");
  });
  await until(() => manager.get("ended-at-spawn", owner).state === "completed");
  const record = manager.get("ended-at-spawn", owner);
  assert.equal(record.result?.stdout, "done");
  assert.equal(record.evidence?.processTerminated, true);
  assert.equal(record.boundary, undefined, "nothing remained to observe");
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_boundaries").get()!.n, 0);
  } finally { db.close(); }
  manager.start(request(workspace, "after-ended"), async () => result("after-ended"));
  await until(() => manager.get("after-ended", owner).state === "completed");
});
