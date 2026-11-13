// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The Runner-owned fixed research workload.
 *
 * The tests are split by what each one can honestly prove:
 *
 * - the contract, the record parser, the deadlines and the policy functions are
 *   pure, so they are exercised directly;
 * - the control channel runs on a real filesystem, including the cases where a
 *   workload replaces an entry with a link or a device node;
 * - the manager runs against its real SQLite ledger, workspace lease and
 *   resource rows, with a synthetic executor where the subject is admission,
 *   idempotency, publication or fencing rather than the sandbox;
 * - a few cases run a real bubblewrap with the fixed program, because only the
 *   kernel can answer whether the workload really is an ordinary supervised
 *   process and whether the namespace is really empty afterwards.
 *
 * Nothing here starts the Runner's HTTP server, and no case answers PID 1 with
 * a mock.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RESEARCH_RECORD_MAX_BYTES,
  ResearchControlChannel,
  ResearchRunError,
  createResearchRunExecutor,
  parseResearchRunRequest,
  parseResearchTimeSchedule,
  parseResearchWorkloadRecord,
  researchExecutionState,
  researchPublishable,
  researchRefusalMessage,
  researchRunDeadlines,
  researchStateRoot,
  type ResearchRunExecutor,
  type ResearchRunLaunch,
  type ResearchRunWiring,
} from "./research-run.js";
import { ExecutionManager, type ExecutionManagerOptions } from "./execution-manager.js";
import { assertEnvironmentMutationAllowed } from "./execution-resource-fences.js";
import {
  EnvironmentStore,
  type ProvisionerExecutor,
} from "./environment-store.js";
import type {
  ExecutionOwner,
  ResearchRunRequest,
  ResearchRunStatus,
  ResearchTimeSchedule,
  ShellExecutionRequest,
} from "@sciencediscovery/schema";

const owner: ExecutionOwner = { agentId: "agent", sessionId: "session" };

/** Large enough for a sandbox start, short enough that a stuck case fails fast. */
const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 200,
  reportBudgetMs: 2_000,
  researchBudgetMs: 8_000,
  stopGraceMs: 600,
  verificationWindowMs: 2_000,
};

function researchRequest(
  id: string,
  workspaceRoot: string,
  overrides: Partial<ResearchRunRequest> = {},
): ResearchRunRequest {
  return {
    agentId: owner.agentId,
    executionId: id,
    kind: "research",
    permissionEpoch: { sessionId: owner.sessionId } as ResearchRunRequest["permissionEpoch"],
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    workload: "scienceflow-fixed",
    workspaceRoot,
    ...overrides,
  };
}

function shellRequest(root: string, id: string): ShellExecutionRequest {
  return { agentId: owner.agentId, code: "echo shell", executionId: id, workspaceRoot: root,
    permissionEpoch: { sessionId: owner.sessionId } as ShellExecutionRequest["permissionEpoch"] };
}

function status(overrides: Partial<ResearchRunStatus> = {}): ResearchRunStatus {
  return {
    deadlineViolated: false,
    observedAt: new Date().toISOString(),
    outcome: null,
    phase: "unknown",
    process: "not_started",
    schemaVersion: 1,
    stop: "none",
    verificationWindowMs: 1_000,
    workload: "scienceflow-fixed",
    ...overrides,
  };
}

async function scratch(context: { after: (fn: () => Promise<void>) => void }, label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `research-${label}-`));
  const dataDir = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // Node runs `after` hooks in registration order, so removing the tree from
  // this first hook would race a manager that is still writing into it. One
  // hook closes whatever the test opened (last registered first) and only then
  // deletes the directory.
  const closers: Array<() => Promise<void> | void> = [];
  context.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  const close = (closer: () => Promise<void> | void) => { closers.push(closer); };
  return { close, dataDir, root, workspace };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function readOnlyLedger(dataDir: string): DatabaseSync {
  return new DatabaseSync(resolve(dataDir, "runner-executions", "executions.sqlite"), { readOnly: true });
}

// ---------------------------------------------------------------------------
// The fixed program
//
// The workload is test code injected through the executor's constructor seam:
// it is never reachable from a request. Every scenario below is a property of
// that fixed program, not something a request can choose.
// ---------------------------------------------------------------------------

interface Scenario {
  /** `complete`: research then finished; `forge`: reporting phase; `hang`: never reports. */
  readonly behaviour: "complete" | "reporting" | "hang" | "failed";
  /** Whether the workload reads the stop channel at all. */
  readonly honourStop: boolean;
  /** Spawn a descendant that leaves the process group and ignores SIGTERM. */
  readonly escapedDescendant?: boolean;
  /** Write the namespace shape into the workspace before reporting. */
  readonly reportShape?: boolean;
  /** Seconds before it finishes on its own. */
  readonly lifetimeSeconds?: number;
}

function fixedProgram(scenario: Scenario): string {
  return `import json, os, signal, subprocess, sys, time
SCENARIO = json.loads(${JSON.stringify(JSON.stringify(scenario))})
control = sys.argv[1]

def write(name, payload):
    tmp = os.path.join(control, "." + name + "." + str(os.getpid()))
    with open(tmp, "w") as handle:
        handle.write(json.dumps(payload) + "\\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.rename(tmp, os.path.join(control, name))

def read(name):
    try:
        with open(os.path.join(control, name)) as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError):
        return None

if SCENARIO.get("reportShape"):
    try:
        pid1 = open("/proc/1/cmdline", "rb").read().decode("utf-8", "replace").split("\\0")[0]
    except OSError:
        pid1 = ""
    with open("shape.json", "w") as handle:
        json.dump({"self": os.getpid(), "ppid": os.getppid(), "pid1": pid1}, handle)

# A stop that predates the research phase is a short-circuit, and it is reported
# with the sender's own id so the Runner can correlate it to its intent.
pending = read("stop")
if pending is not None:
    os.rename(os.path.join(control, "stop"), os.path.join(control, "stop.consumed"))
    write("status", {"version": 1, "phase": "finished", "outcome": "not-started", "stopId": pending.get("stopId")})
    sys.exit(0)

if SCENARIO.get("escapedDescendant"):
    child = subprocess.Popen([sys.executable, "-c",
        "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"])
    with open("descendant.json", "w") as handle:
        json.dump({"pid": child.pid, "start": open("/proc/%d/stat" % child.pid).read().split(") ")[1].split()[19]}, handle)

if SCENARIO["behaviour"] == "failed":
    write("status", {"version": 1, "phase": "finished", "outcome": "failed"})
    sys.exit(3)

write("status", {"version": 1, "phase": "research"})
if SCENARIO["behaviour"] == "reporting":
    write("status", {"version": 1, "phase": "reporting"})

# Without an explicit lifetime a scenario finishes as soon as it has reported;
# a long lifetime is how the stop scenarios keep the workload alive.
deadline = time.time() + SCENARIO.get("lifetimeSeconds", 0)
consumed = None
while time.time() < deadline:
    if SCENARIO["honourStop"] and consumed is None:
        request = read("stop")
        if request is not None:
            # Only the first request is consumed, and it is acknowledged with
            # the same id, which is the only thing the Runner trusts.
            try:
                os.rename(os.path.join(control, "stop"), os.path.join(control, "stop.consumed"))
            except OSError:
                pass
            consumed = request.get("stopId")
            write("status", {"version": 1, "phase": "finished", "outcome": "stopped", "stopId": consumed})
            sys.exit(0)
    time.sleep(0.02)

write("status", {"version": 1, "phase": "finished", "outcome": "completed"})
`;
}

function wiring(dataDir: string, scenario: Scenario, extra: Partial<ResearchRunWiring> = {}): ResearchRunWiring {
  return {
    config: { bwrapPath: "bwrap", dataDir, execTimeoutMs: 30_000, maxOutputBytes: 4_096, maxWorkspaceBytes: 0, terminationGraceMs: 400 },
    program: fixedProgram(scenario),
    ...extra,
  };
}

/** True when that exact process (pid plus start time) is gone, not reused. */
async function processGone(pid: number, startTime: string): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] !== startTime;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The internal contract
// ---------------------------------------------------------------------------

test("a research request cannot name a program, a path, a state root or a control file", () => {
  for (const extra of [
    { program: "print(1)" },
    { code: "print(1)" },
    { interpreter: "/usr/bin/python3" },
    { stateRoot: "/tmp/elsewhere" },
    { controlPath: "/tmp/elsewhere" },
    { environment: { PATH: "/host" } },
    { module: "scienceflow" },
  ]) {
    assert.throws(() => parseResearchRunRequest({ ...researchRequest("id", "/workspace"), ...extra }),
      (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID",
      `accepted an override: ${Object.keys(extra)[0]}`);
  }
  assert.throws(() => parseResearchRunRequest(researchRequest("id", "relative/workspace")),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID");
  assert.throws(() => parseResearchRunRequest(researchRequest("id", "/workspace/../etc")),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID");
  assert.throws(() => parseResearchRunRequest(researchRequest("../escape", "/workspace")),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID");
  assert.throws(() => parseResearchRunRequest(researchRequest("id", "/workspace", { workload: "scienceflow" as never })),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_WORKLOAD_UNKNOWN");
  // The accepted shape carries exactly the identity and the schedule.
  const parsed = parseResearchRunRequest(researchRequest("run-1", "/workspace"));
  assert.deepEqual(Object.keys(parsed).sort(),
    ["agentId", "executionId", "kind", "permissionEpoch", "schedule", "schemaVersion", "workload", "workspaceRoot"]);
});

test("an out-of-range schedule refuses the submission instead of being clamped", () => {
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, researchBudgetMs: 0 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, verificationWindowMs: 0 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, stopGraceMs: 0 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, researchBudgetMs: 1.5 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, extraMs: 1 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.throws(() => parseResearchTimeSchedule({ ...SCHEDULE, researchBudgetMs: 8 * 24 * 60 * 60 * 1000 }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_SCHEDULE_INVALID");
  assert.deepEqual(parseResearchTimeSchedule({ ...SCHEDULE }), SCHEDULE);
});

test("the state root is derived from the execution id, so no id text becomes a path", () => {
  const root = researchStateRoot("/data", "run-1");
  assert.equal(researchStateRoot("/data", "run-1"), root, "derivation is deterministic");
  assert.notEqual(researchStateRoot("/data", "run-2"), root);
  // `.` and `..` cannot escape: they are digested, not appended.
  for (const id of [".", "..", "../../etc", "a/b", "..\\..\\windows"]) {
    const derived = researchStateRoot("/data", id);
    assert.equal(derived.startsWith("/data/runner-research/"), true, id);
    assert.equal(derived.split("/").slice(3).join("/").includes(".."), false, id);
    assert.equal(derived.split("/").slice(3).join("/").includes("\\"), false, id);
  }
  assert.match(root, /^\/data\/runner-research\/[0-9a-f]{32}$/);
});

test("the workload record is read against a fixed whitelist and never filtered", () => {
  assert.deepEqual(parseResearchWorkloadRecord('{"version":1,"phase":"research"}'),
    { outcome: null, phase: "research", stopId: null });
  assert.deepEqual(parseResearchWorkloadRecord('{"version":1,"phase":"finished","outcome":"completed","stopId":"s-1"}'),
    { outcome: "completed", phase: "finished", stopId: "s-1" });
  const refused = (text: string, code: string) => assert.throws(() => parseResearchWorkloadRecord(text),
    (error: unknown) => error instanceof ResearchRunError && error.code === code, text);
  refused("", "RESEARCH_RECORD_MALFORMED");
  refused("{}", "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"unknown"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"research","outcome":"completed"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"finished"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"finished","outcome":"unknown"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"finished","outcome":"completed","stopId":"a b"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"research","extra":1}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":2,"phase":"research"}', "RESEARCH_RECORD_VERSION_UNKNOWN");
  refused('{"phase":"research"}', "RESEARCH_RECORD_MALFORMED");
});

test("a process fact never becomes a research result by itself", () => {
  // Nothing ran: a typed refusal is a failure and may publish; a bare
  // `not_started` (a record that never ran) may not.
  assert.equal(researchExecutionState(status({ refusal: "RESEARCH_LAUNCH_FAILED" }), false), "failed");
  assert.equal(researchPublishable(status({ refusal: "RESEARCH_LAUNCH_FAILED" })), true);
  assert.equal(researchPublishable(status()), false);
  // Exit code is not business state: an unproven namespace is unknown and keeps fences.
  assert.equal(researchExecutionState(status({ process: "unverified", outcome: "completed" }), false), "unknown");
  assert.equal(researchPublishable(status({ process: "unverified", outcome: "completed" })), false);
  // A joined process without a terminal record is unknown, not completed.
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "unknown" }), false), "unknown");
  assert.equal(researchPublishable(status({ process: "spawned-then-terminated", outcome: "unknown" })), false);
  // The workload's own terminal record decides the business outcome.
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "completed" }), false), "completed");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "stopped" }), true), "cancelled");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "not-started" }), true), "cancelled");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "failed" }), false), "failed");
});

test("the deadlines reserve the verification window before the hard deadline", () => {
  const deadlines = researchRunDeadlines(SCHEDULE);
  assert.equal(deadlines.stopAtMs, SCHEDULE.researchBudgetMs);
  assert.equal(deadlines.hardDeadlineMs,
    SCHEDULE.researchBudgetMs + SCHEDULE.reportBudgetMs + SCHEDULE.drainGraceMs + SCHEDULE.verificationWindowMs);
  assert.equal(deadlines.forceKillAtMs, deadlines.hardDeadlineMs - SCHEDULE.verificationWindowMs);
  assert.ok(deadlines.forceKillAtMs > deadlines.stopAtMs);
});

// ---------------------------------------------------------------------------
// The control channel (real filesystem, no sandbox)
// ---------------------------------------------------------------------------

test("a replaced control entry is refused rather than followed to another host path", async (context) => {
  const { root } = await scratch(context, "control");
  const stateRoot = resolve(root, "state");
  // The state root itself is created by the runner before the channel opens.
  await mkdir(stateRoot, { mode: 0o700 });
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });

  const outside = resolve(root, "outside.json");
  await writeFile(outside, '{"version":1,"phase":"finished","outcome":"completed"}');
  await symlink(outside, resolve(stateRoot, "control", "status"));
  // A link at the record name is a replacement: its target is never read.
  assert.deepEqual(await channel.read("status"), { status: "refused", code: "RESEARCH_CONTROL_REPLACED" });

  // A link at the stop name cannot redirect the Runner's write either.
  const victim = resolve(root, "victim");
  await writeFile(victim, "untouched");
  await symlink(victim, resolve(stateRoot, "control", "stop"));
  await channel.writeStop("stop-1");
  assert.equal(await readFile(victim, "utf8"), "untouched");
  const written = await channel.read("stop");
  assert.equal(written.status, "text");
  assert.deepEqual(JSON.parse((written as { text: string }).text), { stopId: "stop-1", version: 1 });
});

test("an oversized, malformed or non-file record is refused with its own code", async (context) => {
  const { root } = await scratch(context, "records");
  const stateRoot = resolve(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });
  const control = resolve(stateRoot, "control");

  await writeFile(resolve(control, "status"), "x".repeat(RESEARCH_RECORD_MAX_BYTES + 1));
  assert.deepEqual(await channel.read("status"), { status: "refused", code: "RESEARCH_RECORD_OVERSIZE" });
  await rm(resolve(control, "status"));
  await mkdir(resolve(control, "status"));
  assert.deepEqual(await channel.read("status"), { status: "refused", code: "RESEARCH_CONTROL_REPLACED" });
  await rm(resolve(control, "status"), { recursive: true });
  assert.deepEqual(await channel.read("status"), { status: "missing" });
});

test("the control directory itself must not be a link or a writable directory", async (context) => {
  const { root } = await scratch(context, "control-open");
  const elsewhere = resolve(root, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(resolve(root, "state"));
  await symlink(elsewhere, resolve(root, "state", "control"));
  await assert.rejects(ResearchControlChannel.open(resolve(root, "state")),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_STATE_ROOT_UNSAFE");

  const open2 = resolve(root, "state2");
  await mkdir(open2);
  await mkdir(resolve(open2, "control"));
  await chmod(resolve(open2, "control"), 0o777);
  await assert.rejects(ResearchControlChannel.open(open2),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_STATE_ROOT_UNSAFE");
});

test("the stop request is written once per intent and survives a replaced destination", async (context) => {
  const { root } = await scratch(context, "stop-write");
  const stateRoot = resolve(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });
  await channel.writeStop("first");
  const readBack = await channel.read("stop");
  assert.deepEqual(JSON.parse((readBack as { text: string }).text).stopId, "first");
  // A directory at the destination makes the rename fail closed; it must never
  // be replaced by an ordinary write somewhere else.
  await rm(resolve(stateRoot, "control", "stop"));
  await mkdir(resolve(stateRoot, "control", "stop"));
  await assert.rejects(channel.writeStop("second"),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_CONTROL_WRITE_FAILED");
});

// ---------------------------------------------------------------------------
// Admission, idempotency and publication through the real ledger
// ---------------------------------------------------------------------------

interface ManagerFixture {
  readonly dataDir: string;
  readonly manager: ExecutionManager;
  readonly workspace: string;
}

async function managerFixture(
  context: { after: (fn: () => Promise<void>) => void },
  label: string,
  options: ExecutionManagerOptions = {},
): Promise<ManagerFixture> {
  const { close, dataDir, workspace } = await scratch(context, label);
  const manager = new ExecutionManager(dataDir, undefined, options);
  close(async () => { await manager.close(); });
  return { dataDir, manager, workspace };
}

function syntheticExecutor(
  calls: string[],
  answer: (request: ResearchRunRequest, launch: ResearchRunLaunch) => Promise<ResearchRunStatus>,
): ResearchRunExecutor {
  return {
    run: async (request, launch) => {
      calls.push(request.executionId);
      return { research: await answer(request, launch), result: shellResult(request) };
    },
  };
}

function shellResult(request: { executionId: string; workspaceRoot: string }) {
  return { cgroupMode: "none" as const, createdFiles: [], environmentRevisionId: "system", environmentVariables: {},
    executionId: request.executionId, exitCode: 0, finishedAt: new Date().toISOString(),
    kernelId: `ephemeral:${request.executionId}`, kernelMode: "ephemeral" as const, language: "shell" as const,
    modifiedFiles: [], networkPolicy: "none" as const, runnerVersion: "test", sandbox: "bubblewrap" as const,
    startedAt: new Date().toISOString(), stderr: "", stdout: "", workingDirectory: request.workspaceRoot };
}

test("a Runner without the research dependency refuses before anything reaches the ledger", async (context) => {
  const { dataDir, manager, workspace } = await managerFixture(context, "unconfigured");
  assert.throws(() => manager.submitResearch(researchRequest("run-1", workspace)),
    (error: unknown) => (error as { code?: string }).code === "RESEARCH_RUN_NOT_CONFIGURED");
  const db = readOnlyLedger(dataDir);
  context.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count, 0);
  // The refusal is the fixed message, not an inner exception rendered to text.
  assert.equal((() => { try { manager.submitResearch(researchRequest("run-1", workspace)); } catch (error) { return (error as Error).message; } })(),
    researchRefusalMessage("RESEARCH_RUN_NOT_CONFIGURED"));
  // A shell submission is unaffected: the module is additive, not a new mode.
  const started = manager.start(shellRequest(workspace, "shell-1"), async () => shellResult(shellRequest(workspace, "shell-1")) as never);
  assert.equal(started.state, "queued");
  await until(() => manager.get("shell-1", owner).state === "completed");
  const record = manager.get("shell-1", owner);
  assert.equal(record.workload, undefined);
  assert.equal(record.research, undefined);
});

test("a duplicate submission returns the accepted record and a different digest conflicts without launching", async (context) => {
  const calls: string[] = [];
  const { manager, workspace } = await managerFixture(context, "duplicate",
    { research: syntheticExecutor(calls, async () => status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated" })) });
  const request = researchRequest("run-dup", workspace);
  const first = manager.submitResearch(request);
  assert.equal(first.accepted, true);
  assert.equal(first.execution.workload, "research");
  assert.equal(first.execution.research?.process, "not_started", "acceptance is a positive record");
  const duplicate = manager.submitResearch({ ...request });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.execution.receipt?.requestDigest, first.execution.receipt?.requestDigest);
  await until(() => manager.get("run-dup", owner).state === "completed");
  assert.deepEqual(calls, ["run-dup"], "the operation ran exactly once");

  // A different digest under the same identity is a conflict, and the running
  // operation is not called again.
  assert.throws(() => manager.submitResearch({ ...request, schedule: { ...SCHEDULE, reportBudgetMs: 1_500 } }),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_ID_CONFLICT");
  // A different owner conflicts on the identity, not on the digest.
  assert.throws(() => manager.submitResearch({ ...request, permissionEpoch: { sessionId: "other" } as never }),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_ID_CONFLICT");
  assert.deepEqual(calls, ["run-dup"]);
});

test("same-workspace research submissions stay serialized by the execution queue", async (context) => {
  const timeline: Array<[string, string]> = [];
  const { manager, workspace } = await managerFixture(context, "queue", {
    research: syntheticExecutor([], async (request) => {
      timeline.push([request.executionId, "start"]);
      await new Promise((done) => setTimeout(done, 40));
      timeline.push([request.executionId, "end"]);
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated" });
    }),
  });
  const first = manager.submitResearch(researchRequest("run-a", workspace));
  const second = manager.submitResearch(researchRequest("run-b", workspace));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  // The submission of the second does not start it: the workspace queue owns
  // admission, exactly as it does for shell executions.
  assert.equal(manager.get("run-b", owner).state, "queued");
  await until(() => manager.get("run-a", owner).state === "completed"
    && manager.get("run-b", owner).state === "completed");
  assert.deepEqual(timeline, [["run-a", "start"], ["run-a", "end"], ["run-b", "start"], ["run-b", "end"]]);
  assert.ok(manager.get("run-b", owner).startedAt! >= manager.get("run-a", owner).finishedAt!);
});

test("a pre-spawn refusal is a failed run with not_started evidence that still publishes", async (context) => {
  const { manager, workspace } = await managerFixture(context, "refusal", {
    research: syntheticExecutor([], async () => status({ refusal: "RESEARCH_SANDBOX_UNSUPPORTED" })),
  });
  manager.submitResearch(researchRequest("run-refused", workspace));
  await until(() => manager.get("run-refused", owner).state === "failed");
  const record = manager.get("run-refused", owner);
  assert.equal(record.evidence?.terminationReason, "not_started");
  assert.equal(record.research?.process, "not_started");
  assert.equal(record.research?.refusal, "RESEARCH_SANDBOX_UNSUPPORTED");
  assert.equal(record.error, researchRefusalMessage("RESEARCH_SANDBOX_UNSUPPORTED"));
  assert.ok(record.version, "a typed pre-spawn refusal is publishable");
  assert.equal(record.boundary?.terminationConfirmed ?? false, false);
});

test("a spawned run without a proven boundary or terminal record stays unknown and fenced", async (context) => {
  const calls: string[] = [];
  // The manager's capture refuses the identity, so `lifecycle.spawned` throws
  // after the process exists — the shape a real unavailable /proc read has.
  const { dataDir, manager, workspace } = await managerFixture(context, "unproven", {
    captureBoundary: () => ({ status: "unavailable", reason: "identity-unreadable" }),
    research: syntheticExecutor(calls, async (_request, launch) => {
      try {
        launch.lifecycle?.spawned({ kind: "pid-namespace", pid: process.pid, sandbox: "bubblewrap" });
      } catch {
        // The launcher stopped the child it could not supervise; nothing may be
        // claimed about the process, so the record is `unverified`.
      }
      return status({ outcome: "completed", phase: "finished", process: "unverified" });
    }),
  });
  manager.submitResearch(researchRequest("run-unproven", workspace, { environmentId: "task-1" }));
  await until(() => ["unknown", "failed", "completed"].includes(manager.get("run-unproven", owner).state));
  const record = manager.get("run-unproven", owner);
  assert.equal(record.state, "unknown");
  assert.equal(record.version, undefined, "nothing is published from an unverified process");
  assert.equal(record.result, undefined);
  assert.equal(record.finishedAt, undefined);
  assert.ok(record.error);
  // The environment row survives, so the store refuses any mutation.
  assert.throws(() => assertEnvironmentMutationAllowed(
    resolve(dataDir, "runner-executions", "executions.sqlite"), "task-1"), /still owns this environment/);
});

test("a research run with a proven process but no terminal business fact is quarantined", async (context) => {
  const { dataDir, manager, workspace } = await managerFixture(context, "no-record", {
    research: syntheticExecutor([], async () => status({ outcome: "unknown", phase: "research", process: "spawned-then-terminated" })),
  });
  manager.submitResearch(researchRequest("run-no-record", workspace));
  await until(() => manager.get("run-no-record", owner).state === "unknown");
  const record = manager.get("run-no-record", owner);
  assert.equal(record.version, undefined);
  assert.match(record.error!, /terminal research record/);
  // A later execution into the same workspace is refused at admission: the
  // workspace and device fences stay exactly as an unverified process would.
  // Admission owns this refusal, so it is a synchronous rejection of the
  // submission rather than a queued execution that fails later.
  assert.throws(() => manager.submitResearch(researchRequest("run-later", workspace)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED"
      && /unverified process state/.test((error as Error).message));
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_resources WHERE execution = ?")
    .get("run-no-record")!.count, 1, "the resource row is retained");
});

test("a research execution cancelled while queued records not-started without launching", async (context) => {
  const calls: string[] = [];
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const { manager, workspace } = await managerFixture(context, "queued-cancel", {
    research: syntheticExecutor(calls, async (request) => {
      if (request.executionId === "run-blocking") { started.resolve(); await finish.promise; }
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated" });
    }),
  });
  manager.submitResearch(researchRequest("run-blocking", workspace));
  manager.submitResearch(researchRequest("run-queued", workspace));
  await started.promise;
  const cancelled = await manager.cancel("run-queued", owner);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.evidence?.terminationReason, "not_started");
  assert.deepEqual(cancelled.research, {
    ...cancelled.research, outcome: "not-started", phase: "finished", stop: "requested",
  });
  finish.resolve();
  await until(() => manager.get("run-blocking", owner).state === "completed");
  assert.deepEqual(calls, ["run-blocking"], "the cancelled operation was never invoked");
});

// ---------------------------------------------------------------------------
// The real sandbox
// ---------------------------------------------------------------------------

test("the fixed workload is an ordinary supervised process and publishes only after the namespace is empty", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "sandbox");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true, reportShape: true,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-sandbox", workspace));
  await until(() => manager.get("run-sandbox", owner).state === "completed", 20_000);
  const record = manager.get("run-sandbox", owner);
  assert.equal(record.workload, "research");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.boundary?.terminationConfirmed, true, "publication follows the namespace proof");
  assert.ok(record.version);

  // The kernel's answer about the shape: bubblewrap is PID 1 and the workload
  // is its ordinary child, so the design's "bootstrap must be PID 1" premise
  // does not hold and no argument was bent to force it.
  const shape = JSON.parse(await readFile(resolve(workspace, "shape.json"), "utf8")) as
    { self: number; ppid: number; pid1: string };
  assert.equal(shape.ppid, 1);
  assert.ok(shape.self > 1);
  assert.match(shape.pid1, /bwrap/);

  // One ledger-held execution, with its identity row and released resources.
  // The release follows the publish in the same operation turn, so it is
  // observed rather than assumed to have happened before `completed` was read.
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  const resourceRows = () => Number(db.prepare("SELECT COUNT(*) AS count FROM execution_resources WHERE execution = ?")
    .get("run-sandbox")!.count);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_boundaries WHERE execution = ?")
    .get("run-sandbox")!.count, 1);
  await until(() => resourceRows() === 0, 10_000);
});

test("a graceful stop after ready is consumed once and does not wait for the run budget", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "graceful");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true, lifetimeSeconds: 30,
  })) });
  close(async () => { await manager.close(); });
  const requestedAt = Date.now();
  manager.submitResearch(researchRequest("run-graceful", workspace));
  await until(() => manager.get("run-graceful", owner).state === "running", 20_000);
  const stateRoot = researchStateRoot(dataDir, "run-graceful");
  await waitFor(async () => fileExists(resolve(stateRoot, "control", "status")), 20_000);
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });
  await waitFor(async () => {
    const record = await channel.read("status");
    return record.status === "text" && JSON.parse(record.text).phase === "research";
  }, 20_000);
  const first = await manager.cancel("run-graceful", owner);
  assert.equal(first.boundary?.stopRequestedAt !== undefined, true, "the intent is durable before the workload sees it");
  assert.equal(first.research?.stop, "requested");
  // A repeated stop is the same intent, not a second control task.
  const second = await manager.cancel("run-graceful", owner);
  assert.equal(second.boundary?.stopRequestedAt, first.boundary?.stopRequestedAt);
  await until(() => manager.get("run-graceful", owner).state === "cancelled", 10_000);
  const record = manager.get("run-graceful", owner);
  assert.equal(record.research?.outcome, "stopped");
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.boundary?.terminationConfirmed, true);
  assert.ok(Date.now() - requestedAt < SCHEDULE.researchBudgetMs,
    "a user stop is bounded by its own grace, not by the whole run budget");
  const stop = await channel.read("stop");
  const consumed = await channel.read("stop.consumed");
  // Consuming the request renames it away, so the stop name is gone and the
  // acknowledgement carries the sender's id exactly once.
  assert.equal(stop.status, "missing");
  assert.equal(consumed.status, "text");
  const stopId = JSON.parse((consumed as { text: string }).text).stopId;
  assert.match(stopId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse((consumed as { text: string }).text), { stopId, version: 1 });
});

test("a stop that predates the research phase is a correlated not-started record", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "pending");
  // The fixture plants the stop intent before the run, the way a restart after
  // a durable intent would. The workload must short-circuit and say so.
  const stateRoot = researchStateRoot(dataDir, "run-pending");
  await mkdir(resolve(stateRoot, "control"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(stateRoot, "control", "stop"), JSON.stringify({ stopId: "planted", version: 1 }) + "\n");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-pending", workspace));
  await until(() => manager.get("run-pending", owner).state === "cancelled", 20_000);
  const record = manager.get("run-pending", owner);
  assert.equal(record.research?.outcome, "not-started");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.boundary?.terminationConfirmed, true);
});

test("an unresponsive workload is reclaimed by its stop grace and nothing escapes the namespace", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "unresponsive");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", escapedDescendant: true, honourStop: false, lifetimeSeconds: 60,
  })) });
  close(async () => { await manager.close(); });
  const requestedAt = Date.now();
  manager.submitResearch(researchRequest("run-unresponsive", workspace));
  await until(() => manager.get("run-unresponsive", owner).state === "running", 20_000);
  await waitFor(async () => fileExists(resolve(workspace, "descendant.json")), 20_000);
  await manager.cancel("run-unresponsive", owner);
  await until(() => manager.get("run-unresponsive", owner).state === "unknown", 15_000);
  const record = manager.get("run-unresponsive", owner);
  // A joined monitor is not proof; the namespace kill is, and it covers the
  // descendant that left the process group.
  assert.equal(record.boundary?.terminationConfirmed, true);
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.outcome, "unknown", "no terminal record is unknown, never completed");
  assert.equal(record.research?.deadlineViolated, false, "a user stop is not a deadline violation");
  assert.equal(record.version, undefined);
  assert.ok(Date.now() - requestedAt < SCHEDULE.researchBudgetMs);
  const descendant = JSON.parse(await readFile(resolve(workspace, "descendant.json"), "utf8")) as
    { pid: number; start: string };
  assert.equal(await processGone(descendant.pid, descendant.start), true,
    "the escaped descendant is gone, not merely out of its process group");
});

test("the whole-run deadline reclaims the namespace and marks the deadline violated", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "deadline");
  const short: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 100, researchBudgetMs: 500, stopGraceMs: 200, verificationWindowMs: 800,
  };
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: false, lifetimeSeconds: 60,
  })) });
  close(async () => { await manager.close(); });
  const requestedAt = Date.now();
  manager.submitResearch(researchRequest("run-deadline", workspace, { schedule: short }));
  await until(() => ["unknown", "failed", "completed", "cancelled"].includes(manager.get("run-deadline", owner).state), 20_000);
  const elapsed = Date.now() - requestedAt;
  const record = manager.get("run-deadline", owner);
  assert.equal(record.state, "unknown");
  assert.equal(record.research?.deadlineViolated, true);
  assert.equal(record.boundary?.terminationConfirmed, true, "the reclaim still emptied the namespace");
  assert.equal(record.finishedAt, undefined);
  assert.ok(elapsed < 15_000, `the run did not outlive its budget (${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// Restart and the existing shell contract
// ---------------------------------------------------------------------------

test("a rebuilt manager neither replays nor publishes an unknown research record, and the shell ledger keeps its meaning", async (context) => {
  const { close, dataDir, root, workspace } = await scratch(context, "rebuild");
  // The unknown research run fences its own workspace, so the compatibility
  // check uses a second one; the fence itself is asserted below.
  const shellWorkspace = resolve(root, "workspace-shell");
  await mkdir(shellWorkspace, { recursive: true });
  const calls: string[] = [];
  const options: ExecutionManagerOptions = {
    research: syntheticExecutor(calls, async (request) => {
      if (request.executionId === "run-unknown") return status({ outcome: "unknown", phase: "research", process: "unverified" });
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated" });
    }),
  };
  const first = new ExecutionManager(dataDir, undefined, options);
  first.submitResearch(researchRequest("run-unknown", workspace));
  await until(() => first.get("run-unknown", owner).state === "unknown");
  first.start(shellRequest(shellWorkspace, "shell-ok"), async () => shellResult(shellRequest(shellWorkspace, "shell-ok")) as never);
  await until(() => first.get("shell-ok", owner).state === "completed");
  const shellReceipt = first.get("shell-ok", owner).receipt!;
  await first.close();

  const rebuilt = new ExecutionManager(dataDir, undefined, {});
  close(async () => { await rebuilt.close(); });
  // Startup settles publications the previous process could not clear; only
  // then do the fences it restored become the answer to a new submission.
  await rebuilt.ready();
  // A restarted Runner reads the same rows and changes nothing about them.
  const research = rebuilt.get("run-unknown", owner);
  assert.equal(research.state, "unknown");
  assert.equal(research.version, undefined);
  assert.equal(calls.length, 1, "the operation is not replayed");
  // The old shell record keeps its identity: same digest, idempotent resubmit,
  // and its published result is still readable.
  const shell = rebuilt.get("shell-ok", owner);
  assert.equal(shell.state, "completed");
  assert.equal(shell.workload, undefined);
  assert.equal(shell.receipt?.requestDigest, shellReceipt.requestDigest);
  assert.ok(shell.version);
  const repeated = rebuilt.submit(shellRequest(shellWorkspace, "shell-ok"), async () => shellResult(shellRequest(shellWorkspace, "shell-ok")) as never);
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.execution.receipt?.requestDigest, shellReceipt.requestDigest);
  // The unknown record keeps its fence across the restart: the fenced workspace
  // still refuses new work, and the refusal is admission's, not a queued job.
  assert.throws(() => rebuilt.start(shellRequest(workspace, "shell-later"), async () => shellResult(shellRequest(workspace, "shell-later")) as never),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED");
});

// ---------------------------------------------------------------------------
// The environment gate
// ---------------------------------------------------------------------------

/** A provisioner that only creates prefixes and lists them; no real package. */
async function environmentFixture(context: { after: (fn: () => Promise<void>) => void }, dataDir: string) {
  const root = await mkdtemp(resolve(tmpdir(), "research-env-"));
  const provisionerPath = resolve(root, "provisioner");
  await writeFile(provisionerPath, "#!/bin/sh\nexit 0\n");
  await chmod(provisionerPath, 0o755);
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const commands: string[][] = [];
  const executor: ProvisionerExecutor = async (path, arguments_) => {
    commands.push(arguments_);
    // The interpreter inventory is parsed as JSON, so that call answers with an
    // empty package list instead of a provisioner reply.
    if (path.endsWith("/python")) return "[]";
    const command = arguments_[1];
    const prefixIndex = arguments_.indexOf("--prefix");
    const prefix = prefixIndex >= 0 ? arguments_[prefixIndex + 1]! : "";
    if (command === "create") {
      await mkdir(resolve(prefix, "bin"), { recursive: true });
      // The R inventory is line-based and may legitimately be empty.
      await writeFile(resolve(prefix, "bin", "python"), "#!/bin/sh\necho '[]'\n");
      await chmod(resolve(prefix, "bin", "python"), 0o755);
      await writeFile(resolve(prefix, "bin", "R"), "#!/bin/sh\nexit 0\n");
      await chmod(resolve(prefix, "bin", "R"), 0o755);
      return "";
    }
    if (command === "list") return JSON.stringify([]);
    return "";
  };
  const store = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    executionLedgerPath: resolve(dataDir, "runner-executions", "executions.sqlite"),
    provisionerPath,
    root: resolve(root, "envs"),
    runnerVersion: "test-runner",
  }, executor);
  return { commands, store };
}

test("an environment writer waits for the run's reader and proceeds after a normal end", async (context) => {
  const { dataDir } = await scratch(context, "env-waits");
  const { store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("leased", "python");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  // The run holds the reader for its whole lifetime, exactly as withRuntime does.
  const reading = store.withRuntime(task.id, async () => { started.resolve(); await finish.promise; });
  await started.promise;
  const install = store.install(task.id, ["added=1"]);
  let settled = false;
  void install.finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(settled, false, "no mutation may run while the run reads the prefix");
  finish.resolve();
  await reading;
  const revision = await install;
  assert.ok(revision.packages.length >= 0);
});

test("an environment change is refused while an unknown research run still owns it", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "env-fenced");
  const { commands, store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("fenced", "python");
  const manager = new ExecutionManager(dataDir, undefined, {
    research: syntheticExecutor([], async () => status({ outcome: "unknown", phase: "research", process: "unverified" })),
  });
  close(async () => { await manager.close(); });
  const before = commands.length;
  manager.submitResearch(researchRequest("run-fenced", workspace, { environmentId: task.id }));
  await until(() => manager.get("run-fenced", owner).state === "unknown");
  await assert.rejects(store.install(task.id, ["added=1"]), /still owns this environment/);
  assert.equal(commands.length, before, "no provisioner command runs behind the fence");
});
