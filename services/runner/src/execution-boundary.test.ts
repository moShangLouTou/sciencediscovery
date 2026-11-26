// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readProcessStat, sendSignal } from "@sciencediscovery/sandbox-capability";
import {
  EXECUTION_BOUNDARY_SCHEMA_VERSION,
  boundaryTerminationVerified,
  captureExecutionBoundary,
  captureExecutionBoundaryOutcome,
  isValidExecutionBoundaryHandle,
  observeExecutionBoundary,
  terminateExecutionBoundary,
  type ExecutionBoundaryHandle,
  type SpawnedExecution,
} from "./execution-boundary.js";

const BOOT = "0b8f4a52-6f4c-4a0e-9d1c-2e3f40516273";

interface ProcFixture {
  state?: string;
  parentPid?: number;
  sessionId?: number;
  processGroupId?: number;
  startTimeTicks?: string;
  namespace?: number;
  uid?: number;
}

async function writeProcess(root: string, pid: number, fixture: ProcFixture = {}): Promise<void> {
  const directory = join(root, String(pid));
  await mkdir(join(directory, "ns"), { recursive: true });
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = fixture.state ?? "S";
  fields[1] = String(fixture.parentPid ?? 1);
  fields[2] = String(fixture.processGroupId ?? pid);
  fields[3] = String(fixture.sessionId ?? pid);
  fields[19] = fixture.startTimeTicks ?? "1000";
  await writeFile(join(directory, "stat"), `${pid} (proc) ${fields.join(" ")}\n`);
  await writeFile(join(directory, "status"),
    `Name:\tproc\nUid:\t${fixture.uid ?? 1000}\t${fixture.uid ?? 1000}\t${fixture.uid ?? 1000}\t${fixture.uid ?? 1000}\n`);
  await symlink(`pid:[${fixture.namespace ?? 100}]`, join(directory, "ns", "pid"));
}

async function procFixture(context: { after(fn: () => unknown): void }, bootId = BOOT): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "execution-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sys", "kernel", "random"), { recursive: true });
  await writeFile(join(root, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  return root;
}

function realBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function handle(overrides: Partial<ExecutionBoundaryHandle> = {}): ExecutionBoundaryHandle {
  return {
    schemaVersion: EXECUTION_BOUNDARY_SCHEMA_VERSION,
    kind: "pid-namespace",
    executionId: "execution",
    sandbox: "bubblewrap",
    bootId: BOOT,
    pid: 500,
    startTimeTicks: "1000",
    processGroupId: 500,
    sessionId: 500,
    uid: 1000,
    namespaces: ["pid:[2]"],
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A pid that provably does not exist, so no signal can reach a real process. */
async function missingPid(): Promise<number> {
  const last = Number(readFileSync("/proc/sys/kernel/ns_last_pid", "utf8").trim());
  for (let pid = last + 10_000; pid < last + 20_000; pid += 1) {
    if ((await readProcessStat("/proc", pid)).status === "gone") return pid;
  }
  throw new Error("no absent pid found");
}

function spawnTermIgnoring(): ChildProcess {
  return spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" });
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await once(child, "exit").catch(() => undefined);
  }
}

test("a boundary handle is trusted only when every identity field is present and shaped", () => {
  assert.equal(isValidExecutionBoundaryHandle(handle()), true);
  for (const broken of [
    null, {}, { ...handle(), schemaVersion: 2 }, { ...handle(), kind: "process-group" },
    { ...handle(), sandbox: "none" }, { ...handle(), executionId: "" },
    { ...handle(), bootId: "not-a-boot" }, { ...handle(), pid: 0 }, { ...handle(), pid: 1.5 },
    { ...handle(), startTimeTicks: "12a" }, { ...handle(), processGroupId: 0 },
    { ...handle(), sessionId: -1 }, { ...handle(), uid: -1 },
    { ...handle(), namespaces: ["pid:2"] }, { ...handle(), namespaces: ["pid:[2]", 7] },
  ]) {
    assert.equal(isValidExecutionBoundaryHandle(broken), false, JSON.stringify(broken));
  }
  assert.equal(isValidExecutionBoundaryHandle(handle({ namespaces: [] })), true,
    "an empty namespace list is recorded as-is; refusal happens on use");
});

test("capture records the monitor identity and only bubblewrap namespaces", async context => {
  assert.equal(captureExecutionBoundary("execution", { pid: 500, kind: "process", sandbox: "none" }), null);
  assert.equal(captureExecutionBoundary("execution", { pid: 500, kind: "pid-namespace", sandbox: "seatbelt" }), null);

  const root = await procFixture(context);
  const ownPid = process.pid;
  await writeProcess(root, ownPid, { namespace: 1, startTimeTicks: "1" });
  await writeProcess(root, 500, { parentPid: ownPid, namespace: 1, startTimeTicks: "1000", uid: 1001 });
  await writeProcess(root, 501, { parentPid: 500, namespace: 2, startTimeTicks: "1001" });

  const spawned: SpawnedExecution = { pid: 500, kind: "pid-namespace", sandbox: "bubblewrap" };
  const captured = captureExecutionBoundary("execution", spawned, root);
  assert.ok(captured);
  const { capturedAt, ...identity } = captured;
  assert.deepEqual(identity, {
    schemaVersion: EXECUTION_BOUNDARY_SCHEMA_VERSION, kind: "pid-namespace", executionId: "execution",
    sandbox: "bubblewrap", bootId: BOOT, pid: 500, startTimeTicks: "1000",
    processGroupId: 500, sessionId: 500, uid: 1001, namespaces: ["pid:[2]"],
  });
  assert.match(capturedAt, /^\d{4}-\d{2}-\d{2}T/);

  // A monitor whose session is not its own is never recorded: signalling its
  // group would signal the parent that created it.
  await writeProcess(root, 502, { parentPid: ownPid, namespace: 1, sessionId: ownPid, processGroupId: ownPid });
  assert.equal(captureExecutionBoundary("execution", { pid: 502, kind: "pid-namespace", sandbox: "bubblewrap" }, root), null);
});

test("capture distinguishes a platform without a boundary from a sandbox that lost it", async context => {
  const bubblewrap: SpawnedExecution = { pid: 500, kind: "pid-namespace", sandbox: "bubblewrap" };
  // No durable boundary was ever promised on these paths; they keep their
  // existing semantics.
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { pid: 500, kind: "process", sandbox: "none" }), { status: "not-applicable" });
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { pid: 500, kind: "pid-namespace", sandbox: "seatbelt" }), { status: "not-applicable" });

  const root = await procFixture(context);
  await writeProcess(root, process.pid, { namespace: 1, startTimeTicks: "1" });
  // Gone before the identity read: nothing it started outlives it.
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { ...bubblewrap, pid: 600 }, root), { status: "ended" });
  await writeProcess(root, 601, { state: "Z" });
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { ...bubblewrap, pid: 601 }, root), { status: "ended" },
    "a reaped monitor whose pid already names a zombie is ended, not captured");
  // Alive, but its session/group prove it is not the init the Runner spawned.
  await writeProcess(root, 602, { sessionId: 1, processGroupId: 1 });
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { ...bubblewrap, pid: 602 }, root),
    { status: "unavailable", reason: "identity-unreadable" });
  // Identity read, but the sandbox namespace was never observed. This is the
  // case that must not be mistaken for "this platform has no boundary".
  const unreadableSelf = await procFixture(context);
  await writeProcess(unreadableSelf, 700);
  assert.deepEqual(captureExecutionBoundaryOutcome("execution", { ...bubblewrap, pid: 700 }, unreadableSelf),
    { status: "unavailable", reason: "namespace-unobserved" });
  // The ordinary case: identity plus a namespace other than the Runner's own.
  await writeProcess(root, 500, { parentPid: process.pid, namespace: 2 });
  const captured = captureExecutionBoundaryOutcome("execution", bubblewrap, root);
  assert.equal(captured.status, "captured");
  assert.equal(captured.status === "captured" && captured.handle.namespaces[0], "pid:[2]");
});

test("observation never turns an unreadable or absent handle into absence", async context => {
  const root = await procFixture(context);
  await writeProcess(root, process.pid, { namespace: 1 });

  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(undefined, { procRoot: root })),
    { state: "not-recorded", terminationConfirmed: false, reason: "no-handle" });

  const noKernel = await procFixture(context);
  await rm(join(noKernel, "sys", "kernel", "random", "boot_id"));
  assert.equal(observeExecutionBoundary(handle(), { procRoot: noKernel }).reason, "kernel-unreadable");
  assert.equal(observeExecutionBoundary(handle(), { procRoot: noKernel }).terminationConfirmed, false);

  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ bootId: realBootId() }), { procRoot: root })),
    { state: "boot-changed", terminationConfirmed: false, reason: "boot-mismatch" },
    "another boot never confirms a cancellation in this boot");

  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ namespaces: [] }), { procRoot: root })),
    { state: "unverifiable", terminationConfirmed: false, reason: "namespace-unverified" });

  // A handle naming the Runner's own namespace can only be corrupt.
  await writeProcess(root, 500, { parentPid: process.pid, namespace: 1 });
  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ namespaces: ["pid:[1]"] }), { procRoot: root })),
    { state: "unverifiable", terminationConfirmed: false, reason: "namespace-own" });

  // Namespace known, no member: this is a proven absence.
  // (Namespace 33 names no process in the fixture.)
  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ namespaces: ["pid:[33]"] }), { procRoot: root })),
    { state: "gone", terminationConfirmed: true });

  // A live member keeps it alive, including one that left the session.
  await writeProcess(root, 504, { parentPid: process.pid, namespace: 4 });
  await writeProcess(root, 505, { parentPid: 1, namespace: 4, sessionId: 505, processGroupId: 505 });
  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ namespaces: ["pid:[4]"] }), { procRoot: root })),
    { state: "alive", terminationConfirmed: false });

  // A member whose namespace cannot be read makes an empty result unproven.
  await writeProcess(root, 506, { parentPid: process.pid });
  await rm(join(root, "506", "ns", "pid"));
  await mkdir(join(root, "506", "ns", "pid"), { recursive: true });
  assert.deepEqual(
    (({ observedAt, ...rest }) => rest)(observeExecutionBoundary(handle({ namespaces: ["pid:[5]"] }), { procRoot: root })),
    { state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" });

  // The stop intent is carried through every observation without changing it.
  const stopping = observeExecutionBoundary(undefined, { procRoot: root, stopRequestedAt: "then" });
  assert.equal(stopping.stopRequestedAt, "then");
});

test("termination refuses before any signal when identity or boundary cannot be trusted", async context => {
  const root = await procFixture(context);
  await writeProcess(root, process.pid, { namespace: 1 });
  const bystander = spawnTermIgnoring();
  context.after(async () => reap(bystander));
  assert.ok(bystander.pid);

  const refusals: Array<[ExecutionBoundaryHandle | undefined, string]> = [
    [undefined, "no-handle"],
    [handle({ bootId: realBootId(), pid: bystander.pid }), "boot-mismatch"],
    [handle({ namespaces: [] }), "namespace-unverified"],
    [handle({ namespaces: ["pid:[1]"] }), "namespace-own"],
  ];
  for (const [candidate, reason] of refusals) {
    const result = await terminateExecutionBoundary(candidate, { procRoot: root, termGraceMs: 20, killGraceMs: 20, pollMs: 5 });
    assert.equal(result.signaled, false, reason);
    assert.equal(result.confirmed, false, reason);
    assert.equal(result.status.reason, reason);
    assert.equal(result.status.terminationConfirmed, false);
  }
  // The bystander is a real session leader named by one of the refused handles;
  // refusing must have left it untouched. SIGKILL proves it was still alive.
  assert.equal(sendSignal(bystander.pid!, "SIGKILL"), "sent");
  await once(bystander, "exit");
});

test("termination confirms only a namespace the kernel proves empty", async () => {
  const pid = await missingPid();
  const gone = await terminateExecutionBoundary(
    handle({ bootId: realBootId(), pid, namespaces: ["pid:[424242]"] }),
    { termGraceMs: 20, killGraceMs: 20, pollMs: 5 });
  assert.equal(gone.signaled, false, "there was nothing to signal");
  assert.equal(gone.confirmed, true);
  assert.equal(gone.status.state, "gone");

  assert.equal(boundaryTerminationVerified(undefined), false);
  assert.equal(boundaryTerminationVerified(handle({ bootId: realBootId(), pid, namespaces: ["pid:[424242]"] })), true,
    "post-run verification accepts a proven-empty namespace");
  assert.equal(boundaryTerminationVerified(handle({ bootId: realBootId(), pid, namespaces: [] })), false,
    "an unrecorded boundary is not proof");
});

test("a TERM-ignoring member is escalated to KILL and only then confirmed", async context => {
  const root = await procFixture(context);
  await writeProcess(root, process.pid, { namespace: 1 });
  const member = spawnTermIgnoring();
  context.after(async () => reap(member));
  const pid = member.pid!;
  await writeProcess(root, pid, { parentPid: process.pid, namespace: 7, startTimeTicks: "9001" });
  // The kernel deletes the process; mirror that in the fixture so the next scan
  // observes what a real /proc would.
  member.once("exit", () => { try { rmSync(join(root, String(pid)), { recursive: true, force: true }); } catch { /* gone */ } });

  const result = await terminateExecutionBoundary(
    handle({ bootId: BOOT, pid, startTimeTicks: "9001", namespaces: ["pid:[7]"] }),
    { procRoot: root, termGraceMs: 100, killGraceMs: 2_000, pollMs: 5 });
  assert.equal(result.signaled, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.status.state, "gone");
  assert.ok(member.exitCode !== null || member.signalCode !== null, "the escalated member really ended");
  assert.equal(sendSignal(pid, "SIGTERM"), "gone");
});
