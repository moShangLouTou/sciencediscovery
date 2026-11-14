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
 * - the contract, the record parser, the fold, the deadlines and the policy
 *   functions are pure, so they are exercised directly;
 * - the control channel runs on a real filesystem, including the cases where a
 *   workload replaces an entry with a link, a FIFO, a socket or a directory;
 * - the manager runs against its real SQLite ledger, workspace lease and
 *   resource rows, with a synthetic executor where the subject is admission,
 *   idempotency, publication or fencing rather than the sandbox, and with real
 *   SQLite write faults where the subject is a stop that must be durable before
 *   anything is asked of the workload;
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RESEARCH_RECORD_MAX_BYTES,
  ResearchControlChannel,
  ResearchRunError,
  createResearchRunExecutor,
  nextResearchRecordState,
  parseResearchInputIdentity,
  parseResearchRunRequest,
  parseResearchTimeSchedule,
  parseResearchWorkloadRecord,
  parseStopMarker,
  researchExecutionState,
  researchInputRoot,
  researchPublishable,
  researchRecordUnusable,
  researchRefusalMessage,
  researchRunDeadlines,
  researchStateRoot,
  researchStopId,
  verifiedResearchInputs,
  type ResearchRunExecutor,
  type ResearchRunLaunch,
  type ResearchRunWiring,
  type ResearchWorkloadRecord,
} from "./research-run.js";
import { ExecutionManager, type ExecutionManagerOptions } from "./execution-manager.js";
import { assertEnvironmentMutationAllowed } from "./execution-resource-fences.js";
import { VersionStore } from "@sciencediscovery/cas";
import {
  EnvironmentStore,
  type EnvironmentRuntime,
  type ProvisionerExecutor,
} from "./environment-store.js";
import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ExecutionOwner,
  type ResearchInputEvidence,
  type ResearchInputIdentity,
  type ResearchRunRequest,
  type ResearchRunStatus,
  type ResearchTimeSchedule,
  type ScienceFlowInputBundleManifest,
  type ShellExecutionRequest,
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

/**
 * A synthetic input bundle whose manifest digest is computed the same way the
 * real store computes it. Tests that are not about the bundle store consume
 * this snapshot through the executor's constructor seam; the store's own
 * verification has separate, real-filesystem coverage.
 */
interface InputFixture {
  readonly identity: ResearchInputIdentity;
  readonly manifest: ScienceFlowInputBundleManifest;
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly evidence: ResearchInputEvidence;
}

function inputFixture(): InputFixture {
  const contractDigest = "a".repeat(64);
  const entries = [
    { content: "contract\n", path: "manifest.yaml", roles: ["manifest"] as const },
    { content: "task: 1\n", path: "package/task.yaml", roles: ["task_yaml"] as const },
    { content: "description\n", path: "package/description.md", roles: ["description"] as const },
    { content: "def evaluate():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] as const },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = entries.map((entry) => ({
    path: entry.path,
    roles: [...entry.roles],
    size: Buffer.byteLength(entry.content),
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  }));
  const manifest: ScienceFlowInputBundleManifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files,
  };
  const bundleDigest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
  return {
    identity: { contractDigest, bundleDigest },
    manifest,
    contents: new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content)])),
    evidence: {
      contractDigest,
      bundleDigest,
      state: "verified",
      files: files.map((file) => ({ ...file, roles: [...file.roles] })),
    },
  };
}

const INPUT = inputFixture();

function stubInputSource(): { snapshot(bundleDigest: string): Promise<{
  manifest: InputFixture["manifest"];
  contents: ReadonlyMap<string, Buffer>;
}> } {
  return {
    snapshot: async (bundleDigest: string) => {
      if (bundleDigest !== INPUT.identity.bundleDigest) throw new Error("bundle is not materialized");
      return { manifest: INPUT.manifest, contents: INPUT.contents };
    },
  };
}

function researchRequest(
  id: string,
  workspaceRoot: string,
  overrides: Partial<ResearchRunRequest> = {},
): ResearchRunRequest {
  return {
    agentId: owner.agentId,
    executionId: id,
    inputs: { ...INPUT.identity },
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
  const base: ResearchRunStatus = {
    deadlineViolated: false,
    forceReclaimRequested: false,
    observedAt: new Date().toISOString(),
    outcome: null,
    phase: "unknown",
    process: "not_started",
    report: "none",
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    stop: "none",
    verificationWindowMs: SCHEDULE.verificationWindowMs,
    workload: "scienceflow-fixed",
    ...overrides,
  };
  // A run that was accepted but never spawned still carries only the caller's
  // declaration; one that reports a process fact has the verified set. The
  // manager and the publication policy distinguish exactly those two.
  if (base.inputs === undefined) {
    return { ...base, inputs: base.process === "not_started"
      ? { ...INPUT.identity, state: "declared" }
      : INPUT.evidence };
  }
  return base;
}

function record(
  overrides: Partial<ResearchWorkloadRecord> & Pick<ResearchWorkloadRecord, "phase">,
): ResearchWorkloadRecord {
  return { execution: "run-1", outcome: null, report: "none", stopId: null, ...overrides };
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

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await delay(5);
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await delay(10);
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

/** Existence of any entry, including a directory (the wrapper's marker). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readOnlyLedger(dataDir: string): DatabaseSync {
  return new DatabaseSync(resolve(dataDir, "runner-executions", "executions.sqlite"), { readOnly: true });
}

/** The manager's own write connection, used to inject a real storage failure. */
function managerDb(manager: ExecutionManager): DatabaseSync {
  return (manager as unknown as { db: DatabaseSync }).db;
}

// ---------------------------------------------------------------------------
// The fixed program
//
// The workload is test code injected through the executor's constructor seam:
// it is never reachable from a request. Every scenario below is a property of
// that fixed program, not something a request can choose. It speaks the whole
// protocol: a pending stop is consumed before research, the stop channel is
// read and acknowledged exactly once, reporting is a phase of its own, and the
// natural-exit path runs its own cleanup before the process ends.
// ---------------------------------------------------------------------------

interface Scenario {
  /** `complete`: research then finished; `reporting`: a long report phase;
   *  `hang`: never reports again; `failed`: a terminal failure; `silent`: no
   *  records; `conflict`: a finished record that rewrites the research outcome. */
  readonly behaviour?: "complete" | "reporting" | "hang" | "failed" | "silent" | "conflict";
  /** Whether the workload reads the stop channel at all. */
  readonly honourStop?: boolean;
  /** Spawn a descendant that leaves the process group and ignores SIGTERM. */
  readonly escapedDescendant?: boolean;
  /** Write the namespace shape into the workspace before reporting. */
  readonly reportShape?: boolean;
  /** How long the research phase stays running before it reports. */
  readonly researchSeconds?: number;
  /** How long the reporting phase stays running before it reports ready. */
  readonly reportingSeconds?: number;
  /** How long a silent or unresponsive workload stays alive. */
  readonly lifetimeSeconds?: number;
  /** Await this much cleanup in the natural-exit path. */
  readonly cleanupSeconds?: number;
  /** Leave a marker in the control directory after the awaited cleanup. */
  readonly cleanupMarker?: boolean;
  /** Replace or remove the terminal record after it was written once (valid → unusable). */
  readonly corruptAfter?: "malformed" | "oversize" | "foreign" | "missing";
  /** Stay alive this much longer after the terminal record. */
  readonly lingerSeconds?: number;
}

function fixedProgram(scenario: Scenario): string {
  return `import json, os, signal, subprocess, sys, time

SCENARIO = json.loads(${JSON.stringify(JSON.stringify(scenario))})
CONTROL = sys.argv[1]
EXECUTION = sys.argv[2]
STOP = os.path.join(CONTROL, "stop")
CONSUMED = os.path.join(CONTROL, "stop.consumed")

def write(name, text):
    tmp = os.path.join(CONTROL, "." + name + "." + str(os.getpid()))
    with open(tmp, "w") as handle:
        handle.write(text + "\\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, os.path.join(CONTROL, name))

def record(phase, outcome=None, report=None, stop_id=None):
    payload = {"version": 1, "execution": EXECUTION, "phase": phase}
    if outcome is not None:
        payload["outcome"] = outcome
    if report is not None:
        payload["report"] = report
    if stop_id is not None:
        payload["stopId"] = stop_id
    write("status", json.dumps(payload))

def read_json(name):
    try:
        with open(os.path.join(CONTROL, name)) as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError, OSError):
        return None

def take_stop():
    # Only the first request is consumed, and the rename is the acknowledgement:
    # after it there is no stop file left for a second read to find.
    if not SCENARIO.get("honourStop", True):
        return None
    request = read_json("stop")
    if not isinstance(request, dict) or not isinstance(request.get("stopId"), str):
        return None
    try:
        os.replace(STOP, CONSUMED)
    except OSError:
        return None
    return request["stopId"]

def poll(seconds):
    end = time.monotonic() + seconds
    while True:
        stop_id = take_stop()
        if stop_id is not None:
            return stop_id
        if time.monotonic() >= end:
            return None
        time.sleep(0.02)

def body():
    # A stop that predates the research phase is a correlated short-circuit.
    stop_id = take_stop()
    if stop_id is not None:
        record("finished", "not-started", "none", stop_id)
        return 0

    if SCENARIO.get("reportShape"):
        try:
            pid1 = open("/proc/1/cmdline", "rb").read().decode("utf-8", "replace").split("\\0")[0]
        except OSError:
            pid1 = ""
        with open("shape.json", "w") as handle:
            json.dump({"self": os.getpid(), "ppid": os.getppid(), "pid1": pid1}, handle)

    if SCENARIO.get("escapedDescendant"):
        child = subprocess.Popen([sys.executable, "-c",
            "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"])
        with open("descendant.json", "w") as handle:
            json.dump({"pid": child.pid,
                       "start": open("/proc/%d/stat" % child.pid).read().split(") ")[1].split()[19]}, handle)

    behaviour = SCENARIO.get("behaviour", "complete")
    if behaviour == "failed":
        record("finished", "failed", "failed")
        return 3
    if behaviour == "silent":
        time.sleep(SCENARIO.get("lifetimeSeconds", 60))
        return 1

    record("research")
    stop_id = poll(SCENARIO.get("researchSeconds", 0))
    if stop_id is not None:
        record("finished", "stopped", "incomplete", stop_id)
        return 0
    if behaviour == "hang":
        # It ignores the stop channel by configuration and keeps running.
        time.sleep(SCENARIO.get("lifetimeSeconds", 60))
        return 1
    if behaviour == "reporting":
        record("reporting", "completed", "generating")
        stop_id = poll(SCENARIO.get("reportingSeconds", 60))
        if stop_id is not None:
            # Research is complete; only the report was stopped.
            record("finished", "completed", "incomplete", stop_id)
            return 0
        record("finished", "completed", "ready")
        return 0
    if behaviour == "conflict":
        # The reporting record states the research fact; the finished record
        # then tries to rewrite it. The reporting record is left in place long
        # enough for the poll turn to read it before the conflict arrives.
        record("reporting", "completed", "generating")
        time.sleep(0.4)
        record("finished", "failed", "failed")
        time.sleep(0.6)
        return 3

    # Without a requested lifetime a scenario reports as soon as it is done; a
    # longer one keeps it alive and still honours a stop arriving meanwhile.
    wait = SCENARIO.get("lifetimeSeconds", 0) + SCENARIO.get("lingerSeconds", 0)
    if wait > 0:
        stop_id = poll(wait)
        if stop_id is not None:
            record("finished", "stopped", "incomplete", stop_id)
            return 0

    record("finished", "completed", "ready")
    corruption = SCENARIO.get("corruptAfter")
    if corruption is not None:
        time.sleep(0.4)
        if corruption == "missing":
            os.unlink(os.path.join(CONTROL, "status"))
        elif corruption == "malformed":
            write("status", "{not json")
        elif corruption == "oversize":
            write("status", "x" * (${RESEARCH_RECORD_MAX_BYTES} + 16))
        else:
            write("status", json.dumps({"version": 1, "execution": EXECUTION + "-other",
                "phase": "finished", "outcome": "completed", "report": "ready"}))
        time.sleep(0.6)
    if SCENARIO.get("lingerSeconds"):
        time.sleep(SCENARIO["lingerSeconds"])
    return 0

def main():
    try:
        return body()
    finally:
        # Natural-exit cleanup: it is part of the process's own lifetime and
        # completes before the workload exits.
        time.sleep(SCENARIO.get("cleanupSeconds", 0))
        if SCENARIO.get("cleanupMarker"):
            with open(os.path.join(CONTROL, "cleanup"), "w") as handle:
                handle.write("done\\n")

sys.exit(main())
`;
}

/** Runtime used by fixtures that do not lease a managed environment. */
const FIXTURE_RUNTIME = { identity: "fixture-runtime", interpreterPath: "/usr/bin/python3" };

function executorConfig(dataDir: string): ResearchRunWiring["config"] {
  return { bwrapPath: "bwrap", dataDir, execTimeoutMs: 30_000, maxOutputBytes: 4_096,
    maxWorkspaceBytes: 0, terminationGraceMs: 400 };
}

/** No fixture runtime: the shape a production wiring has. */
function bareWiring(
  dataDir: string,
  scenario: Scenario,
  extra: Partial<ResearchRunWiring> = {},
): ResearchRunWiring {
  return {
    config: executorConfig(dataDir),
    inputBundles: stubInputSource(),
    program: fixedProgram(scenario),
    ...extra,
  };
}

function wiring(
  dataDir: string,
  scenario: Scenario,
  extra: Partial<ResearchRunWiring> = {},
): ResearchRunWiring {
  return bareWiring(dataDir, scenario, { fixtureRuntime: FIXTURE_RUNTIME, ...extra });
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
  // The accepted shape carries exactly the identity, the input reference and
  // the schedule.
  const parsed = parseResearchRunRequest(researchRequest("run-1", "/workspace"));
  assert.deepEqual(Object.keys(parsed).sort(),
    ["agentId", "executionId", "inputs", "kind", "permissionEpoch", "schedule", "schemaVersion", "workload", "workspaceRoot"]);
});

test("the input reference is exactly two digests and never a locator", () => {
  const request = researchRequest("run-inputs", "/workspace");
  assert.deepEqual(parseResearchInputIdentity(request.inputs),
    { contractDigest: INPUT.identity.contractDigest, bundleDigest: INPUT.identity.bundleDigest });
  for (const bad of [
    { contractDigest: "A".repeat(64), bundleDigest: "b".repeat(64) },
    { contractDigest: "a".repeat(63), bundleDigest: "b".repeat(64) },
    { contractDigest: "a".repeat(64) },
    { bundleDigest: "b".repeat(64) },
    { contractDigest: "a".repeat(64), bundleDigest: "b".repeat(64), root: "/shared" },
    { contractDigest: "a".repeat(64), bundleDigest: "b".repeat(64), files: [] },
    "a".repeat(64),
  ]) {
    assert.throws(() => parseResearchInputIdentity(bad),
      (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID",
      JSON.stringify(bad));
  }
  // A request without the optional reference still parses: historical records
  // and pre-consumption callers keep their meaning. Only a new execution is
  // refused, and that refusal happens in the launcher and the manager.
  const { inputs: _omitted, ...legacy } = request;
  assert.equal(parseResearchRunRequest(legacy).inputs, undefined);
  assert.throws(() => parseResearchRunRequest({ ...request, inputs: { contractDigest: "a".repeat(64) } }),
    (error: unknown) => error instanceof ResearchRunError && error.code === "RESEARCH_REQUEST_INVALID");
});

test("a verified input record must rebuild to its own bundle digest", () => {
  assert.deepEqual(verifiedResearchInputs(INPUT.evidence), INPUT.evidence);
  // A declared record is not verified evidence.
  assert.equal(verifiedResearchInputs({ ...INPUT.identity, state: "declared" }), null);
  // The files and the digest must describe the same canonical manifest.
  assert.equal(verifiedResearchInputs({ ...INPUT.evidence, bundleDigest: "b".repeat(64) }), null);
  assert.equal(verifiedResearchInputs({ ...INPUT.evidence, files: [] }), null);
  assert.equal(verifiedResearchInputs({
    ...INPUT.evidence,
    files: INPUT.evidence.files!.map((file) => file.path === "manifest.yaml"
      ? { ...file, sha256: "c".repeat(64) } : file),
  }), null);
  // There is no host path in evidence: a path that could escape is not one.
  assert.equal(verifiedResearchInputs({
    ...INPUT.evidence,
    files: INPUT.evidence.files!.map((file) => file.path === "manifest.yaml"
      ? { ...file, path: "../outside" } : file),
  }), null);
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
  assert.deepEqual(parseResearchWorkloadRecord('{"version":1,"execution":"run-1","phase":"research"}', "run-1"),
    { execution: "run-1", outcome: null, phase: "research", report: "none", stopId: null });
  assert.deepEqual(parseResearchWorkloadRecord(
    '{"version":1,"execution":"run-1","phase":"finished","outcome":"completed","report":"ready","stopId":"s-1"}', "run-1"),
  { execution: "run-1", outcome: "completed", phase: "finished", report: "ready", stopId: "s-1" });
  // The research and report facts are separate: a finished stopped run says so.
  assert.deepEqual(parseResearchWorkloadRecord(
    '{"version":1,"execution":"run-1","phase":"finished","outcome":"stopped","report":"incomplete"}', "run-1"),
  { execution: "run-1", outcome: "stopped", phase: "finished", report: "incomplete", stopId: null });
  // Entering reporting states what research did; it is never inferred.
  assert.deepEqual(parseResearchWorkloadRecord(
    '{"version":1,"execution":"run-1","phase":"reporting","outcome":"completed"}', "run-1"),
  { execution: "run-1", outcome: "completed", phase: "reporting", report: "generating", stopId: null });
  const refused = (text: string, code: string) => assert.throws(
    () => parseResearchWorkloadRecord(text, "run-1"),
    (error: unknown) => error instanceof ResearchRunError && error.code === code, text);
  refused("", "RESEARCH_RECORD_MALFORMED");
  refused("{}", "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"phase":"research"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"unknown"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"research","outcome":"completed"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"finished"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"finished","outcome":"unknown"}', "RESEARCH_RECORD_MALFORMED");
  // A completed research phase without a report fact is not a terminal record.
  refused('{"version":1,"execution":"run-1","phase":"finished","outcome":"completed"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"finished","outcome":"completed","report":"ready","stopId":"a b"}',
    "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"execution":"run-1","phase":"research","extra":1}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":2,"execution":"run-1","phase":"research"}', "RESEARCH_RECORD_VERSION_UNKNOWN");
  // A record left by another execution is never this run's result.
  refused('{"version":1,"execution":"run-2","phase":"finished","outcome":"completed","report":"ready"}',
    "RESEARCH_RECORD_IDENTITY_MISMATCH");
});

test("the stop marker is smaller than a record and never a business fact", () => {
  assert.equal(parseStopMarker('{"version":1,"stopId":"s-1"}'), "s-1");
  const refused = (text: string, code: string) => assert.throws(() => parseStopMarker(text),
    (error: unknown) => error instanceof ResearchRunError && error.code === code, text);
  refused("not json", "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":1,"stopId":"s-1","phase":"finished"}', "RESEARCH_RECORD_MALFORMED");
  refused('{"version":2,"stopId":"s-1"}', "RESEARCH_RECORD_VERSION_UNKNOWN");
});

test("the record fold refuses a terminal rewrite, a regression and a foreign stop", () => {
  const applied = (current: Parameters<typeof nextResearchRecordState>[0], next: ResearchWorkloadRecord,
    context: { stopId: string | null; stopRequested: boolean } = { stopId: null, stopRequested: false }) =>
    nextResearchRecordState(current, next, context);
  // A forward walk applies, and the report only moves forward.
  const research = applied(null, record({ phase: "research" }));
  assert.equal(research.status, "applied");
  const reporting = applied(research.status === "applied" ? research.facts : null,
    record({ outcome: "completed", phase: "reporting", report: "generating" }));
  assert.equal(reporting.status, "applied");
  const finished = applied(reporting.status === "applied" ? reporting.facts : null,
    record({ outcome: "completed", phase: "finished", report: "ready" }));
  assert.deepEqual(finished, { status: "applied", facts: { outcome: "completed", phase: "finished", report: "ready", stopId: null } });
  // Re-reading the same terminal record is not a second transition.
  assert.deepEqual(applied(finished.status === "applied" ? finished.facts : null,
    record({ outcome: "completed", phase: "finished", report: "ready" })), finished);
  // terminal → non-terminal and terminal → a different terminal are refused.
  for (const next of [
    record({ phase: "research" }),
    record({ phase: "reporting", outcome: "completed", report: "generating" }),
    record({ outcome: "failed", phase: "finished", report: "failed" }),
    record({ outcome: "completed", phase: "finished", report: "incomplete" }),
  ]) {
    assert.equal(applied(finished.status === "applied" ? finished.facts : null, next).status, "refused", JSON.stringify(next));
  }
  // A phase may not move backwards while it is not terminal either.
  const back = applied(reporting.status === "applied" ? reporting.facts : null, record({ phase: "research" }));
  assert.deepEqual(back, { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" });
  // A stop this run did not persist is another attempt's stop, not evidence.
  assert.deepEqual(applied(null, record({ outcome: "stopped", phase: "finished", report: "incomplete", stopId: "foreign" })),
    { status: "refused", code: "RESEARCH_RECORD_IDENTITY_MISMATCH" });
  assert.deepEqual(applied(null, record({ outcome: "stopped", phase: "finished", report: "incomplete" })),
    { status: "refused", code: "RESEARCH_RECORD_IDENTITY_MISMATCH" });
  assert.deepEqual(applied(null, record({ outcome: "not-started", phase: "finished", report: "none" })),
    { status: "refused", code: "RESEARCH_RECORD_IDENTITY_MISMATCH" });
  // With the durable intent behind it, the same record applies.
  const stopped = applied(null, record({ outcome: "stopped", phase: "finished", report: "incomplete", stopId: "s-1" }),
    { stopId: "s-1", stopRequested: true });
  assert.equal(stopped.status, "applied");
  // The stable stop identity is derived from the durable intent, not a UUID.
  assert.equal(researchStopId("run-1", "2026-11-13T00:00:00.000Z"),
    researchStopId("run-1", "2026-11-13T00:00:00.000Z"));
  assert.notEqual(researchStopId("run-1", "2026-11-13T00:00:00.000Z"),
    researchStopId("run-2", "2026-11-13T00:00:00.000Z"));
});

test("a research outcome a reporting record stated is never rewritten by a later phase", () => {
  const reporting = { outcome: "completed", phase: "reporting", report: "generating", stopId: null } as const;
  const finish = (next: ResearchWorkloadRecord, current: Parameters<typeof nextResearchRecordState>[0],
    stopContext: { stopId: string | null; stopRequested: boolean } = { stopId: null, stopRequested: false }) =>
    nextResearchRecordState(current, next, stopContext);
  // The phase may advance while the research fact stays exactly as stated; a
  // failed report is a failed report, not a failed research phase.
  const failedReport = finish(record({ outcome: "completed", phase: "finished", report: "failed" }), reporting);
  assert.deepEqual(failedReport, {
    status: "applied", facts: { outcome: "completed", phase: "finished", report: "failed", stopId: null },
  });
  // The policy keeps the two facts apart on the publication path too.
  const stored = status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "failed" });
  assert.equal(researchExecutionState(stored, false), "failed");
  assert.equal(stored.outcome, "completed");
  // A finished record may not turn a completed research phase into a failure.
  assert.deepEqual(finish(record({ outcome: "failed", phase: "finished", report: "failed" }), reporting),
    { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" });
  assert.deepEqual(finish(record({ outcome: "stopped", phase: "finished", report: "incomplete" }), reporting,
    { stopId: null, stopRequested: true }),
    { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" });
  // Nor may a stopped or failed research phase be upgraded to a completion.
  const stopped = { outcome: "stopped", phase: "reporting", report: "generating", stopId: null } as const;
  assert.deepEqual(finish(record({ outcome: "completed", phase: "finished", report: "ready" }), stopped),
    { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" });
  const failed = { outcome: "failed", phase: "reporting", report: "generating", stopId: null } as const;
  assert.deepEqual(finish(record({ outcome: "completed", phase: "finished", report: "ready" }), failed),
    { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" });
  // A research phase still running has stated no outcome yet, so its reporting
  // record may determine the terminal one normally.
  const running = { outcome: "unknown", phase: "research", report: "none", stopId: null } as const;
  assert.equal(finish(record({ outcome: "completed", phase: "reporting", report: "generating" }), running).status,
    "applied");
  // Re-reading an identical finished record is still not a conflict.
  const terminal = { outcome: "completed", phase: "finished", report: "ready", stopId: null } as const;
  assert.deepEqual(finish(record({ outcome: "completed", phase: "finished", report: "ready" }), terminal),
    { status: "applied", facts: terminal });
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
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "completed", report: "ready" }), false), "completed");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "stopped", report: "incomplete" }), true), "cancelled");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "not-started" }), true), "cancelled");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "failed", report: "failed" }), false), "failed");
  // Research completed while the report did not: the two facts are kept apart.
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "completed", report: "incomplete", stop: "consumed" }), false), "cancelled");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "completed", report: "failed" }), false), "failed");
  assert.equal(researchExecutionState(status({ process: "spawned-then-terminated", outcome: "completed", report: "incomplete" }), true), "cancelled");
  // A stop outcome without the durable intent behind it is never published.
  assert.equal(researchPublishable(status({ process: "spawned-then-terminated", outcome: "stopped", report: "incomplete" })), false);
  assert.equal(researchPublishable(status({ process: "spawned-then-terminated", outcome: "completed", report: "ready", stop: "consumed" })), true);
});

test("an unusable record and a late proof can never be published from an earlier completion", () => {
  // The exact shape a valid completion followed by an unreadable record leaves:
  // the business facts were dropped, the refusal is named, nothing publishes.
  for (const refusal of [
    "RESEARCH_RECORD_MISSING",
    "RESEARCH_RECORD_MALFORMED",
    "RESEARCH_RECORD_OVERSIZE",
    "RESEARCH_RECORD_IDENTITY_MISMATCH",
    "RESEARCH_RECORD_TRANSITION_INVALID",
    "RESEARCH_RECORD_VERSION_UNKNOWN",
    "RESEARCH_STATE_SAVE_FAILED",
  ] as const) {
    const unusable = status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated",
      refusal, report: "ready" });
    assert.equal(researchRecordUnusable(unusable), true, refusal);
    assert.equal(researchExecutionState(unusable, false), "unknown", refusal);
    assert.equal(researchPublishable(unusable), false, refusal);
  }
  // Proof that completed after the hard deadline is unknown whatever it says.
  const late = status({ deadlineViolated: true, outcome: "completed",
    process: "spawned-then-terminated", report: "ready" });
  assert.equal(researchExecutionState(late, false), "unknown");
  assert.equal(researchPublishable(late), false);
  // A reclaim request is not a violation by itself.
  const reclaimed = status({ forceReclaimRequested: true, outcome: "stopped",
    process: "spawned-then-terminated", report: "incomplete", stop: "consumed" });
  assert.equal(reclaimed.deadlineViolated, false);
  assert.equal(researchExecutionState(reclaimed, false), "cancelled");
  assert.equal(researchPublishable(reclaimed), true);
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

test("a FIFO at a control name is refused without waiting for a writer", async (context) => {
  const { root } = await scratch(context, "fifo");
  const stateRoot = resolve(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });
  const control = resolve(stateRoot, "control");

  // A FIFO is the case a blocking open never settles: the supervision turn
  // would stop checking deadlines and the reader/manager queue would wedge.
  execFileSync("mkfifo", [resolve(control, "status")]);
  let settled = false;
  const read = channel.read("status").then((value) => { settled = true; return value; });
  const outcome = await Promise.race([
    read,
    delay(1_000).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    // Release a blocking open from a regression so the failure leaves no
    // thread parked on the FIFO, then let the read settle before failing.
    await writeFile(resolve(control, "status"), "").catch(() => undefined);
    await read.catch(() => undefined);
  }
  assert.equal(settled, true, "the read must not wait for a writer");
  assert.deepEqual(outcome, { status: "refused", code: "RESEARCH_CONTROL_REPLACED" });
});

test("a socket at a control name is refused as a non-regular entry", async (context) => {
  const { root } = await scratch(context, "socket");
  const stateRoot = resolve(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const channel = await ResearchControlChannel.open(stateRoot);
  context.after(async () => { await channel.close(); });
  const path = resolve(stateRoot, "control", "status");
  const server = createServer();
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(path, () => done());
  });
  context.after(async () => { await new Promise<void>((done) => server.close(() => done())); });
  assert.deepEqual(await channel.read("status"), { status: "refused", code: "RESEARCH_CONTROL_REPLACED" });
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
    { research: syntheticExecutor(calls, async () => status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready" })) });
  const request = researchRequest("run-dup", workspace);
  const first = manager.submitResearch(request);
  assert.equal(first.accepted, true);
  assert.equal(first.execution.workload, "research");
  assert.equal(first.execution.research?.process, "not_started", "acceptance is a positive record");
  assert.deepEqual(first.execution.research?.schedule, SCHEDULE, "the governing schedule is persisted");
  assert.equal(first.execution.research?.forceReclaimRequested, false);
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
      await delay(40);
      timeline.push([request.executionId, "end"]);
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready" });
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

test("an unbound input, a missing bundle or another contract refuses before spawn", async (context) => {
  const { dataDir, root, workspace } = await scratch(context, "input-refusals");
  const run = (
    extra: Partial<ResearchRunWiring>,
    request = researchRequest("run-input", workspace),
  ) => createResearchRunExecutor(wiring(dataDir, { behaviour: "complete" }, extra))
    .run(request, { signal: new AbortController().signal });

  const { inputs: _omitted, ...legacy } = researchRequest("run-unbound", workspace);
  const unbound = await run({}, legacy);
  assert.equal(unbound.research.process, "not_started");
  assert.equal(unbound.research.refusal, "RESEARCH_INPUT_REQUIRED");
  assert.equal(await pathExists(resolve(root, "data", "runner-research")), false,
    "nothing was created for a run that names no inputs");

  // A wiring without the store, a store that does not hold the digest, and a
  // manifest whose contract is not the requested one are all one fixed refusal.
  assert.equal((await run({ inputBundles: undefined })).research.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  assert.equal((await run({ inputBundles: { snapshot: async () => { throw new Error("not materialized"); } } }))
    .research.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  const otherContract = await run({}, researchRequest("run-input", workspace, {
    inputs: { contractDigest: "c".repeat(64), bundleDigest: INPUT.identity.bundleDigest },
  }));
  assert.equal(otherContract.research.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-input")), false,
    "a refused run leaves no copy behind");

  // The manager refuses an unbound new execution before writing the ledger.
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(
    wiring(dataDir, { behaviour: "complete" })) });
  context.after(async () => { await manager.close(); });
  assert.throws(() => manager.submitResearch(legacy),
    (error: unknown) => (error as { code?: string }).code === "RESEARCH_INPUT_REQUIRED");
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count, 0);
});

test("a completed run publishes the input identity it verified", async (context) => {
  const { dataDir, manager, workspace } = await managerFixture(context, "input-publish", {
    research: syntheticExecutor([], async () => status({
      outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready",
    })),
  });
  manager.submitResearch(researchRequest("run-input-publish", workspace));
  await until(() => manager.get("run-input-publish", owner).state === "completed");
  const record = manager.get("run-input-publish", owner);
  assert.deepEqual(record.research?.inputs, INPUT.evidence);
  assert.ok(record.version);
  // The published WorkspaceExecution carries the same identity, so a reader
  // that never saw the operation can still name the frozen input version.
  const published = await new VersionStore(dataDir)
    .readRecord<{ researchInputs?: ResearchInputEvidence }>(record.version!, "WorkspaceExecution");
  assert.deepEqual(published.value.researchInputs, INPUT.evidence);
});

test("verified inputs never upgrade a failed research result, and foreign evidence is not published", async (context) => {
  const failed = await managerFixture(context, "input-failed", {
    research: syntheticExecutor([], async () => status({
      outcome: "failed", phase: "finished", process: "spawned-then-terminated", report: "failed",
    })),
  });
  failed.manager.submitResearch(researchRequest("run-input-failed", failed.workspace));
  await until(() => failed.manager.get("run-input-failed", owner).state === "failed");
  const failedRecord = failed.manager.get("run-input-failed", owner);
  assert.equal(failedRecord.research?.outcome, "failed");
  assert.equal(failedRecord.research?.inputs?.state, "verified");

  // Evidence that names another bundle is not this execution's input. The
  // record keeps only the declaration, so nothing is published as consumed.
  const foreign = await managerFixture(context, "input-foreign", {
    research: syntheticExecutor([], async () => status({
      outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready",
      inputs: { ...INPUT.evidence, bundleDigest: "e".repeat(64) },
    })),
  });
  foreign.manager.submitResearch(researchRequest("run-input-foreign", foreign.workspace));
  await until(() => foreign.manager.get("run-input-foreign", owner).state === "unknown");
  const foreignRecord = foreign.manager.get("run-input-foreign", owner);
  assert.equal(foreignRecord.research?.inputs?.state, "declared");
  assert.equal(foreignRecord.version, undefined);
  assert.match(foreignRecord.error ?? "", /verified input set/);
});

test("changing the input identity under one execution id is a conflict, not a second run", async (context) => {
  const calls: string[] = [];
  const { manager, workspace } = await managerFixture(context, "input-conflict", {
    research: syntheticExecutor(calls, async () => status({
      outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready",
    })),
  });
  const request = researchRequest("run-input-conflict", workspace);
  manager.submitResearch(request);
  manager.submitResearch({ ...request });
  await until(() => manager.get("run-input-conflict", owner).state === "completed");
  assert.deepEqual(calls, ["run-input-conflict"]);
  // The two digests are part of the request digest: another bundle is another
  // request under the same id, so the existing execution is never reused.
  assert.throws(() => manager.submitResearch({ ...request,
    inputs: { ...request.inputs!, bundleDigest: "b".repeat(64) } }),
  (error: unknown) => (error as { code?: string }).code === "EXECUTION_ID_CONFLICT");
  assert.deepEqual(calls, ["run-input-conflict"]);
  // A record written before input consumption existed still publishes on the
  // same terms as before; the new rule only constrains records that name inputs.
  const legacy = { ...status({ outcome: "completed", phase: "finished",
    process: "spawned-then-terminated", report: "ready" }) };
  delete (legacy as { inputs?: unknown }).inputs;
  assert.equal(researchPublishable(legacy), true);
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
      return status({ outcome: "completed", phase: "finished", process: "unverified", report: "ready" });
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
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready" });
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
    behaviour: "complete", cleanupMarker: true, cleanupSeconds: 0.1, honourStop: true, reportShape: true,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-sandbox", workspace));
  await until(() => manager.get("run-sandbox", owner).state === "completed", 20_000);
  const record = manager.get("run-sandbox", owner);
  assert.equal(record.workload, "research");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.deadlineViolated, false);
  assert.equal(record.research?.forceReclaimRequested, false);
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
  // The natural-exit path really awaited its cleanup before the process ended.
  assert.equal(await readFile(resolve(researchStateRoot(dataDir, "run-sandbox"), "control", "cleanup"), "utf8"), "done\n");

  // One ledger-held execution, with its identity row and released resources.
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  const resourceRows = () => Number(db.prepare("SELECT COUNT(*) AS count FROM execution_resources WHERE execution = ?")
    .get("run-sandbox")!.count);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_boundaries WHERE execution = ?")
    .get("run-sandbox")!.count, 1);
  await until(() => resourceRows() === 0, 10_000);
});

test("a running execution reports its process and business facts to the ledger, not to memory only", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "observed");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true, researchSeconds: 2,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-observed", workspace));
  await until(() => manager.get("run-observed", owner).state === "running", 20_000);
  // The process fact and the business phase must be readable while it runs;
  // a ledger that still says `not_started` describes a different run.
  await waitFor(() => {
    const record = manager.get("run-observed", owner);
    return record.state === "running" && record.research?.process === "spawned"
      && record.research?.phase === "research";
  }, 20_000);
  const live = manager.get("run-observed", owner);
  assert.equal(live.research?.process, "spawned");
  assert.equal(live.research?.phase, "research");
  assert.equal(live.research?.outcome, null);
  assert.equal(live.research?.report, "none");
  assert.equal(live.research?.stop, "none");
  assert.equal(live.research?.stopCause, undefined);
  assert.ok(live.research?.spawnedAt, "the spawn instant is durable, not inferred later");
  // The remembered process identity is durable while the run is live.
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_boundaries WHERE execution = ?")
    .get("run-observed")!.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_resources WHERE execution = ?")
    .get("run-observed")!.count, 1);

  await until(() => manager.get("run-observed", owner).state === "completed", 20_000);
  const record = manager.get("run-observed", owner);
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.spawnedAt, live.research?.spawnedAt);
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
  assert.equal(first.research?.stopCause, "user");
  // A repeated stop is the same intent, not a second control task.
  const second = await manager.cancel("run-graceful", owner);
  assert.equal(second.boundary?.stopRequestedAt, first.boundary?.stopRequestedAt);
  await until(() => manager.get("run-graceful", owner).state === "cancelled", 10_000);
  const record = manager.get("run-graceful", owner);
  assert.equal(record.research?.outcome, "stopped");
  assert.equal(record.research?.report, "incomplete");
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.research?.stopCause, "user");
  assert.equal(record.boundary?.terminationConfirmed, true);
  assert.ok(record.version, "a stopped run with durable evidence is still publishable");
  assert.ok(Date.now() - requestedAt < SCHEDULE.researchBudgetMs,
    "a user stop is bounded by its own grace, not by the whole run budget");
  const stop = await channel.read("stop");
  const consumed = await channel.read("stop.consumed");
  // Consuming the request renames it away, so the stop name is gone and the
  // acknowledgement carries the sender's id exactly once.
  assert.equal(stop.status, "missing");
  assert.equal(consumed.status, "text");
  const stopId = JSON.parse((consumed as { text: string }).text).stopId;
  assert.match(stopId, /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse((consumed as { text: string }).text), { stopId, version: 1 });
});

test("a stop during reporting keeps research completed and publishes the incomplete report", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "reporting");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "reporting", honourStop: true, reportingSeconds: 60, researchSeconds: 0,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-reporting", workspace));
  await until(() => manager.get("run-reporting", owner).state === "running", 20_000);
  await waitFor(() => manager.get("run-reporting", owner).research?.phase === "reporting", 20_000);
  await manager.cancel("run-reporting", owner);
  await until(() => manager.get("run-reporting", owner).state === "cancelled", 15_000);
  const record = manager.get("run-reporting", owner);
  // The two business facts are independent: research finished, the report was
  // stopped. Neither is collapsed into the other or into the process state.
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "incomplete");
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.research?.stopCause, "user");
  assert.ok(record.version);
});

test("a planted stop and a stale acknowledgement are refused, not published", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "stale-stop");
  // A stop file nobody in this Runner persisted, plus an acknowledgement left
  // by another attempt. Neither is evidence: the workload may consume the first
  // and report `not-started` with an id this run never issued.
  const stateRoot = researchStateRoot(dataDir, "run-stale");
  await mkdir(resolve(stateRoot, "control"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(stateRoot, "control", "stop"), JSON.stringify({ stopId: "planted", version: 1 }) + "\n");
  await writeFile(resolve(stateRoot, "control", "stop.consumed"), JSON.stringify({ stopId: "old", version: 1 }) + "\n");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-stale", workspace));
  await until(() => ["unknown", "failed", "cancelled", "completed"].includes(manager.get("run-stale", owner).state), 20_000);
  const record = manager.get("run-stale", owner);
  assert.equal(record.state, "unknown", "a stop without a durable intent is not a stop");
  assert.equal(record.research?.refusal, "RESEARCH_RECORD_IDENTITY_MISMATCH");
  assert.equal(record.research?.outcome, "unknown");
  assert.equal(record.research?.phase, "unknown");
  assert.equal(record.research?.stop, "none", "the stale acknowledgement never flips the channel state");
  assert.equal(record.version, undefined);
  assert.equal(record.research?.process, "spawned-then-terminated");
  // The fence is retained, so the workspace cannot accept new work.
  assert.throws(() => manager.submitResearch(researchRequest("run-after-stale", workspace)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED");
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
  assert.equal(record.research?.deadlineViolated, false, "a user stop proven on time is not a deadline violation");
  assert.equal(record.research?.stopCause, "user");
  assert.equal(record.version, undefined);
  assert.ok(Date.now() - requestedAt < SCHEDULE.researchBudgetMs);
  const descendant = JSON.parse(await readFile(resolve(workspace, "descendant.json"), "utf8")) as
    { pid: number; start: string };
  assert.equal(await processGone(descendant.pid, descendant.start), true,
    "the escaped descendant is gone, not merely out of its process group");
});

test("a valid completion followed by an unusable record is never published", async (context) => {
  for (const corruption of ["malformed", "oversize", "foreign"] as const) {
    const { close, dataDir, workspace } = await scratch(context, `corrupt-${corruption}`);
    const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
      behaviour: "complete", corruptAfter: corruption, honourStop: true,
    })) });
    close(async () => { await manager.close(); });
    const id = `run-corrupt-${corruption}`;
    manager.submitResearch(researchRequest(id, workspace));
    await until(() => ["unknown", "failed", "completed"].includes(manager.get(id, owner).state), 20_000);
    const stored = manager.get(id, owner);
    // The first read was a valid `completed`/`ready`; the later record is not
    // evidence, and the earlier value is not a cache to fall back on.
    assert.equal(stored.state, "unknown", corruption);
    assert.equal(stored.research?.phase, "unknown", corruption);
    assert.equal(stored.research?.outcome, "unknown", corruption);
    assert.equal(stored.research?.report, "none", corruption);
    assert.equal(stored.research?.refusal, corruption === "malformed" ? "RESEARCH_RECORD_MALFORMED"
      : corruption === "oversize" ? "RESEARCH_RECORD_OVERSIZE"
        : "RESEARCH_RECORD_IDENTITY_MISMATCH", corruption);
    assert.equal(stored.version, undefined, corruption);
    assert.equal(stored.research?.process, "spawned-then-terminated", corruption);
    // Fences are retained exactly as for an unproven process.
    assert.throws(() => manager.submitResearch(researchRequest(`${id}-later`, workspace)),
      (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED", corruption);
  }
});

test("a terminal record that is gone when the workload exits is not resurrected from an earlier read", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "record-missing");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", corruptAfter: "missing", honourStop: true,
  })) });
  close(async () => { await manager.close(); });
  const id = "run-record-missing";
  manager.submitResearch(researchRequest(id, workspace));
  // The ledger really did hold a valid `completed`/`ready` before the workload
  // withdrew the record; this is not a run that never reported.
  await waitFor(() => manager.get(id, owner).research?.outcome === "completed", 20_000);
  await until(() => ["unknown", "failed", "completed"].includes(manager.get(id, owner).state), 20_000);
  const stored = manager.get(id, owner);
  // The final record, not the earlier read, is the evidence the run is judged
  // by: a record that is not at its name when the process is gone is no record.
  assert.equal(stored.state, "unknown");
  assert.equal(stored.research?.phase, "unknown");
  assert.equal(stored.research?.outcome, "unknown");
  assert.equal(stored.research?.report, "none");
  assert.equal(stored.research?.refusal, "RESEARCH_RECORD_MISSING");
  assert.equal(stored.version, undefined, "nothing is published from a withdrawn record");
  assert.equal(stored.research?.process, "spawned-then-terminated");
  assert.equal(stored.boundary?.terminationConfirmed, true);
  // The fence is retained, so the workspace cannot accept new work.
  assert.throws(() => manager.submitResearch(researchRequest(`${id}-later`, workspace)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED");
});

test("a workload that never writes a record is unknown, never a completion by default", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "record-never");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "silent", honourStop: false, lifetimeSeconds: 0,
  })) });
  close(async () => { await manager.close(); });
  const id = "run-record-never";
  manager.submitResearch(researchRequest(id, workspace));
  await until(() => ["unknown", "failed", "completed"].includes(manager.get(id, owner).state), 20_000);
  const stored = manager.get(id, owner);
  assert.equal(stored.state, "unknown");
  assert.equal(stored.research?.refusal, "RESEARCH_RECORD_MISSING");
  assert.equal(stored.research?.outcome, "unknown");
  assert.equal(stored.research?.phase, "unknown");
  assert.equal(stored.version, undefined);
  assert.throws(() => manager.submitResearch(researchRequest(`${id}-later`, workspace)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED");
});

test("a finished record that rewrites the research outcome invalidates the run", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "record-conflict");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "conflict", honourStop: false,
  })) });
  close(async () => { await manager.close(); });
  const id = "run-record-conflict";
  manager.submitResearch(researchRequest(id, workspace));
  // The reporting record (research completed) really was read before the
  // conflicting finished record arrived.
  await waitFor(() => manager.get(id, owner).research?.outcome === "completed", 20_000);
  await until(() => ["unknown", "failed", "completed"].includes(manager.get(id, owner).state), 20_000);
  const stored = manager.get(id, owner);
  // A later phase may add the report fact; it may not turn `completed` into
  // `failed`. The conflict is not resolved by keeping either value.
  assert.equal(stored.state, "unknown");
  assert.equal(stored.research?.refusal, "RESEARCH_RECORD_TRANSITION_INVALID");
  assert.equal(stored.research?.outcome, "unknown");
  assert.equal(stored.research?.phase, "unknown");
  assert.equal(stored.version, undefined);
  assert.equal(stored.research?.process, "spawned-then-terminated");
  assert.throws(() => manager.submitResearch(researchRequest(`${id}-later`, workspace)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED");
});

test("a FIFO placed on the live record stops the operation instead of parking it", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "fifo-run");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "hang", honourStop: true, lifetimeSeconds: 60,
  })) });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-fifo", workspace));
  const statusPath = resolve(researchStateRoot(dataDir, "run-fifo"), "control", "status");
  // Wait for the workload's own first record, so the process is definitely
  // spawned before the channel is replaced.
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(statusPath, "utf8")).phase === "research";
    } catch { return false; }
  }, 20_000);
  const requestedAt = Date.now();
  await rm(statusPath);
  execFileSync("mkfifo", [statusPath]);
  await until(() => ["unknown", "failed"].includes(manager.get("run-fifo", owner).state), 10_000);
  const record = manager.get("run-fifo", owner);
  assert.ok(Date.now() - requestedAt < 10_000, "a replaced channel does not wait for the deadline");
  assert.equal(record.state, "unknown");
  assert.equal(record.research?.refusal, "RESEARCH_CONTROL_REPLACED");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.version, undefined);
});

// ---------------------------------------------------------------------------
// The durable stop intent under a real storage fault
// ---------------------------------------------------------------------------

const BUDGET_SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 0, reportBudgetMs: 2_000, researchBudgetMs: 500, stopGraceMs: 500, verificationWindowMs: 1_000,
};

test("a budget stop is durable before any control write, and a failed save writes nothing", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "budget-fault");
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true, lifetimeSeconds: 30,
  })) });
  close(async () => { await manager.close(); });
  const control = resolve(researchStateRoot(dataDir, "run-budget"), "control");
  manager.submitResearch(researchRequest("run-budget", workspace, { schedule: BUDGET_SCHEDULE }));
  await until(() => manager.get("run-budget", owner).state === "running", 20_000);
  await waitFor(() => manager.get("run-budget", owner).research?.phase === "research", 20_000);

  const db = managerDb(manager);
  db.exec("PRAGMA query_only = ON");
  try {
    // Past the research budget with the retry throttle active: the persist
    // fails, so there must be no control file, no abort and no stop in memory.
    await delay(900);
    assert.equal(await fileExists(resolve(control, "stop")), false, "no control write without a durable intent");
    const stuck = manager.get("run-budget", owner);
    assert.equal(stuck.state, "running");
    assert.equal(stuck.research?.stop, "none");
    assert.equal(stuck.research?.stopCause, undefined);
    assert.equal(stuck.boundary?.stopRequestedAt, undefined);
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
  // Once storage works again the next tick persists the same intent and the
  // workload is asked to stop. It is recorded as a budget stop, not a user one.
  await until(() => manager.get("run-budget", owner).state === "cancelled", 15_000);
  const record = manager.get("run-budget", owner);
  assert.equal(record.research?.stopCause, "budget");
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.research?.outcome, "stopped");
  assert.equal(record.research?.report, "incomplete");
  assert.equal(record.boundary?.terminationConfirmed, true);
});

test("a user stop that cannot be persisted sends nothing and says so", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "user-fault");
  const long: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 2_000, researchBudgetMs: 5_000, stopGraceMs: 500, verificationWindowMs: 1_000,
  };
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "complete", honourStop: true, lifetimeSeconds: 30,
  })) });
  close(async () => { await manager.close(); });
  const control = resolve(researchStateRoot(dataDir, "run-user-fault"), "control");
  manager.submitResearch(researchRequest("run-user-fault", workspace, { schedule: long }));
  await until(() => manager.get("run-user-fault", owner).state === "running", 20_000);
  await waitFor(() => manager.get("run-user-fault", owner).research?.phase === "research", 20_000);

  const db = managerDb(manager);
  db.exec("PRAGMA query_only = ON");
  try {
    await assert.rejects(manager.cancel("run-user-fault", owner),
      (error: unknown) => (error as { code?: string }).code === "RESEARCH_STOP_NOT_DURABLE");
    assert.equal(await fileExists(resolve(control, "stop")), false);
    const stuck = manager.get("run-user-fault", owner);
    assert.equal(stuck.state, "running");
    assert.equal(stuck.research?.stop, "none");
    assert.equal(stuck.boundary?.stopRequestedAt, undefined);
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
  // The caller can retry once the ledger accepts writes; the same durable
  // identity then reaches the workload and the run stops as a user stop.
  await manager.cancel("run-user-fault", owner);
  await until(() => manager.get("run-user-fault", owner).state === "cancelled", 15_000);
  const record = manager.get("run-user-fault", owner);
  assert.equal(record.research?.stopCause, "user");
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.research?.outcome, "stopped");
});

// ---------------------------------------------------------------------------
// The schedule starts at the spawn instant
// ---------------------------------------------------------------------------

test("waiting for the environment lease does not consume the run budget", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "lease-wait");
  const { store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("lease", "python");
  await store.withRuntime(task.id, async (runtime) => {
    await copyFile("/usr/bin/python3", runtime.interpreterPath);
    await chmod(runtime.interpreterPath, 0o755);
  });
  // The queue/lease wait is deliberately longer than the whole run budget; it
  // happens strictly before the spawn the schedule is counted from.
  const delayed: Pick<EnvironmentStore, "withRuntime"> = {
    withRuntime: async <T>(environmentId: string, operation: (runtime: EnvironmentRuntime) => Promise<T>): Promise<T> => {
      await delay(600);
      return await store.withRuntime(environmentId, operation);
    },
  };
  const short: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 100, researchBudgetMs: 400, stopGraceMs: 300, verificationWindowMs: 400,
  };
  const manager = new ExecutionManager(dataDir, undefined, {
    research: createResearchRunExecutor(bareWiring(dataDir, { behaviour: "complete", honourStop: true },
      { environmentStore: delayed })),
  });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-lease", workspace, { environmentId: task.id, schedule: short }));
  await until(() => !["running", "queued"].includes(manager.get("run-lease", owner).state), 20_000);
  const record = manager.get("run-lease", owner);
  assert.equal(record.state, "completed");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.research?.forceReclaimRequested, false);
  assert.equal(record.research?.deadlineViolated, false, "a pre-spawn lease wait is outside the schedule");
});

test("a pre-spawn preparation delay does not shorten the run budget", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "prep-wait");
  // The wrapper sleeps only on its first invocation, which is the capability
  // probe during sandbox preparation — strictly before any process is spawned.
  const wrapper = resolve(dataDir, "slow-bwrap");
  await writeFile(wrapper, `#!/bin/sh
if mkdir "${dataDir}/prepared" 2>/dev/null; then
  sleep 0.6
fi
exec bwrap "$@"
`);
  await chmod(wrapper, 0o755);
  const short: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 100, researchBudgetMs: 400, stopGraceMs: 300, verificationWindowMs: 400,
  };
  const manager = new ExecutionManager(dataDir, undefined, {
    research: createResearchRunExecutor(wiring(dataDir, { behaviour: "complete", honourStop: true },
      { config: { ...executorConfig(dataDir), bwrapPath: wrapper } })),
  });
  close(async () => { await manager.close(); });
  const startedAt = Date.now();
  manager.submitResearch(researchRequest("run-prep", workspace, { schedule: short }));
  await until(() => !["running", "queued"].includes(manager.get("run-prep", owner).state), 20_000);
  const record = manager.get("run-prep", owner);
  assert.ok(await pathExists(resolve(dataDir, "prepared")), "the wrapper's slow path really ran");
  assert.equal(record.state, "completed");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.research?.deadlineViolated, false,
    "preparation happens before the spawn instant the schedule is counted from");
  assert.ok(Date.now() - startedAt > 600, "the delayed preparation was not skipped");
});

test("a force reclaim proven inside the deadline is not a deadline violation", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "force-on-time");
  const short: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 500, researchBudgetMs: 500, stopGraceMs: 300, verificationWindowMs: 1_000,
  };
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "hang", honourStop: false, lifetimeSeconds: 60,
  })) });
  close(async () => { await manager.close(); });
  const startedAt = Date.now();
  manager.submitResearch(researchRequest("run-force", workspace, { schedule: short }));
  await until(() => manager.get("run-force", owner).state !== "running"
    && manager.get("run-force", owner).state !== "queued", 20_000);
  const record = manager.get("run-force", owner);
  assert.equal(record.research?.forceReclaimRequested, true, "the namespace was reclaimed uninvited");
  assert.equal(record.research?.deadlineViolated, false, "termination was proven before the hard deadline");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.boundary?.terminationConfirmed, true);
  assert.equal(record.research?.outcome, "unknown");
  // The reclaim is bounded by the schedule, not by the case's own patience.
  assert.ok(Date.now() - startedAt < 10_000);
});

test("a proof that only lands after the hard deadline is recorded as a violation", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "late-proof");
  // The stop grace is longer than the whole schedule, so the budget stop cannot
  // pre-empt the reclaim; only the force-kill instant does, and it sits one
  // millisecond before the hard deadline. The workload ignores the stop and the
  // namespace is still populated, so the reclaim itself, not an idle run, is
  // what lands after the deadline. Evidence strength: this is the real kernel
  // path with a real boundary; the outcome is decided by the measured proof
  // instant, and the on-time case is covered by the previous test.
  const short: ResearchTimeSchedule = {
    drainGraceMs: 0, reportBudgetMs: 300, researchBudgetMs: 300, stopGraceMs: 5_000, verificationWindowMs: 1,
  };
  const manager = new ExecutionManager(dataDir, undefined, { research: createResearchRunExecutor(wiring(dataDir, {
    behaviour: "hang", honourStop: false, lifetimeSeconds: 60,
  })) });
  close(async () => { await manager.close(); });
  const startedAt = Date.now();
  manager.submitResearch(researchRequest("run-late", workspace, { schedule: short }));
  await until(() => !["running", "queued"].includes(manager.get("run-late", owner).state), 20_000);
  const record = manager.get("run-late", owner);
  assert.equal(record.research?.forceReclaimRequested, true, "the reclaim was requested, not an idle exit");
  assert.equal(record.research?.deadlineViolated, true);
  // The kernel did prove the namespace empty — after the hard deadline. The
  // proof instant, not the outcome of the proof, is what marks the violation.
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.state, "unknown");
  assert.equal(record.version, undefined, "a late proof never publishes");
  assert.equal(record.finishedAt, undefined);
  assert.ok(Date.now() - startedAt >= 600, "the proof really happened at or after the force-kill instant");
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
      return status({ outcome: "completed", phase: "finished", process: "spawned-then-terminated", report: "ready" });
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
  await delay(100);
  assert.equal(settled, false, "no mutation may run while the run reads the prefix");
  finish.resolve();
  await reading;
  const revision = await install;
  assert.ok(revision.packages.length >= 0);
});

test("a managed environment without an environment binding is refused before launch", async (context) => {
  const { dataDir, workspace } = await scratch(context, "env-required");
  const { store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("required", "python");
  // A production wiring has no fixture runtime: omitting the environment is
  // refused instead of falling back to the host interpreter, and a revision
  // without an environment has nothing to compare against.
  const executor = createResearchRunExecutor(bareWiring(dataDir, { behaviour: "complete", honourStop: true }));
  for (const overrides of [
    {},
    { expectedEnvironmentRevisionId: task.currentRevisionId },
  ]) {
    const outcome = await executor.run(researchRequest("run-required", workspace, overrides),
      { signal: new AbortController().signal });
    assert.equal(outcome.research.refusal, "RESEARCH_ENVIRONMENT_REQUIRED", JSON.stringify(overrides));
    assert.equal(outcome.research.process, "not_started");
    assert.equal(outcome.result.exitCode, 1);
  }
  // An environment id with no store cannot be leased either.
  const noStore = await createResearchRunExecutor(bareWiring(dataDir, { behaviour: "complete", honourStop: true }))
    .run(researchRequest("run-no-store", workspace, { environmentId: task.id }),
      { signal: new AbortController().signal });
  assert.equal(noStore.research.refusal, "RESEARCH_ENVIRONMENT_UNAVAILABLE");
  assert.equal(noStore.research.process, "not_started");
});

test("a revision that does not match the leased environment is refused, never re-pointed", async (context) => {
  const { dataDir, workspace } = await scratch(context, "env-revision");
  const { store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("revision", "python");
  const executor = createResearchRunExecutor(bareWiring(dataDir, { behaviour: "complete", honourStop: true },
    { environmentStore: store }));
  const outcome = await executor.run(researchRequest("run-revision", workspace, {
    environmentId: task.id, expectedEnvironmentRevisionId: "revision-that-is-not-current",
  }), { signal: new AbortController().signal });
  assert.equal(outcome.research.refusal, "RESEARCH_ENVIRONMENT_REVISION_MISMATCH");
  assert.equal(outcome.research.process, "not_started");
});

test("a real managed environment is leased through the executor and recorded on the result", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "env-real");
  const { store } = await environmentFixture(context, dataDir);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("real", "python");
  // A real interpreter staged in the fixture prefix: the run must reach it
  // through the environment lease, not through a fixture or the host default.
  await store.withRuntime(task.id, async (runtime) => {
    await copyFile("/usr/bin/python3", runtime.interpreterPath);
    await chmod(runtime.interpreterPath, 0o755);
  });
  // Production-shaped wiring: no fixture runtime at all.
  const manager = new ExecutionManager(dataDir, undefined, {
    research: createResearchRunExecutor(bareWiring(dataDir, { behaviour: "complete", honourStop: true },
      { environmentStore: store })),
  });
  close(async () => { await manager.close(); });
  manager.submitResearch(researchRequest("run-env", workspace, {
    environmentId: task.id, expectedEnvironmentRevisionId: task.currentRevisionId,
  }));
  await until(() => ["completed", "failed", "unknown"].includes(manager.get("run-env", owner).state), 20_000);
  const record = manager.get("run-env", owner);
  assert.equal(record.state, "completed");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.result?.environmentRevisionId, task.currentRevisionId,
    "the leased revision is the one the result names");
  assert.ok(record.version);
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
