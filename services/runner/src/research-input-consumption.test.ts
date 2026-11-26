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
 * A research execution consuming a real prepared bundle.
 *
 * These cases join the round-14 content store to the round-13 execution
 * manager: the bundle is published through the real store, the manager admits
 * the run into its real SQLite ledger, and a real bubblewrap sandbox runs a
 * fixed program that reads the mounted copy by role and writes the digests it
 * actually saw. A mocked bundle source is used only where the subject is the
 * refusal path, never to claim consumption.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalResearchInputBundleManifest,
  RESEARCH_INPUT_BUNDLE_VERSION,
  type ExecutionOwner,
  type ResearchInputFileEvidence,
  type ResearchRunRequest,
  type ResearchTimeSchedule,
  type ResearchInputBundleManifest,
  type ResearchInputBundleRequest,
} from "@sciencediscovery/schema";
import { VersionStore } from "@sciencediscovery/cas";

import {
  RunnerResearchInputBundles,
  ResearchInputBundleError,
  researchInputBundleDigest,
} from "./research-input-bundles.js";
import {
  RESEARCH_INPUTS_MOUNT,
  createResearchRunExecutor,
  createResearchWorkloadRegistry,
  researchInputRoot,
  type ResearchRunWiring,
} from "./research-run.js";
import { ExecutionManager } from "./execution-manager.js";
import { retainedTerminationResources } from "./termination-resources.js";

const owner: ExecutionOwner = { agentId: "agent", sessionId: "session" };
const CONTRACT = "f".repeat(64);
const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 200,
  reportBudgetMs: 2_000,
  researchBudgetMs: 8_000,
  stopGraceMs: 600,
  verificationWindowMs: 2_000,
};

interface Scenario {
  /** Stay alive this long after reading the inputs, still honouring a stop. */
  readonly lingerSeconds?: number;
  /** Per-execution overrides, so two runs overlap deterministically. */
  readonly lingerByExecution?: Readonly<Record<string, number>>;
  /** Read the inputs only after this long, so the source can be mutated first. */
  readonly readDelaySeconds?: number;
  /** Spawn a descendant that leaves the process group and ignores SIGTERM. */
  readonly escapedDescendant?: boolean;
  /** Read the inputs, then stay alive without ever writing a terminal record. */
  readonly hang?: boolean;
  /** Leave the control directory without consuming a stop. */
  readonly honourStop?: boolean;
}

/**
 * The fixed program. It knows only the fixed mount point and the Runner's own
 * index; it never imports the evaluator, runs a command named by the bundle, or
 * treats a manifest string as a host path.
 */
function consumingProgram(scenario: Scenario): string {
  return `import hashlib, json, os, subprocess, sys, time

SCENARIO = json.loads(${JSON.stringify(JSON.stringify(scenario))})
CONTROL = sys.argv[1]
EXECUTION = sys.argv[2]
INPUTS = sys.argv[3]
INDEX = json.loads(sys.argv[4])
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

def take_stop():
    if not SCENARIO.get("honourStop", True):
        return None
    try:
        with open(STOP) as handle:
            request = json.load(handle)
    except (FileNotFoundError, ValueError, OSError):
        return None
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

def read_inputs():
    seen = []
    for item in INDEX["files"]:
        path = os.path.join(INPUTS, item["path"])
        with open(path, "rb") as handle:
            data = handle.read()
        seen.append({"path": item["path"], "roles": item["roles"],
                     "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    probe = os.path.join(INPUTS, ".write-probe-" + str(os.getpid()))
    writable = False
    try:
        with open(probe, "w") as handle:
            handle.write("x")
        writable = True
        os.unlink(probe)
    except OSError:
        writable = False
    with open("consumed.json", "w") as handle:
        json.dump({"execution": EXECUTION, "files": seen, "mount": INPUTS, "writable": writable}, handle)

def body():
    stop_id = take_stop()
    if stop_id is not None:
        record("finished", "not-started", "none", stop_id)
        return 0
    if SCENARIO.get("escapedDescendant"):
        child = subprocess.Popen([sys.executable, "-c",
            "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"])
        with open("descendant.json", "w") as handle:
            json.dump({"pid": child.pid,
                       "start": open("/proc/%d/stat" % child.pid).read().split(") ")[1].split()[19]}, handle)
    record("research")
    end = time.monotonic() + SCENARIO.get("readDelaySeconds", 0)
    while time.monotonic() < end:
        stop_id = take_stop()
        if stop_id is not None:
            record("finished", "stopped", "incomplete", stop_id)
            return 0
        time.sleep(0.02)
    read_inputs()
    if SCENARIO.get("hang"):
        time.sleep(60)
        return 1
    record("reporting", "completed", "generating")
    linger = SCENARIO.get("lingerByExecution", {}).get(EXECUTION, SCENARIO.get("lingerSeconds", 0))
    stop_id = poll(linger)
    if stop_id is not None:
        record("finished", "completed", "incomplete", stop_id)
        return 0
    record("finished", "completed", "ready")
    return 0

sys.exit(body())
`;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface BundleFixture {
  readonly contractDigest: string;
  readonly bundleDigest: string;
  readonly files: readonly ResearchInputFileEvidence[];
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly request: ResearchInputBundleRequest;
}

function bundleFixture(options: {
  readonly proofOnly?: boolean;
  readonly sharedDefaults?: boolean;
  readonly dualRole?: boolean;
  readonly contractDigest?: string;
} = {}): BundleFixture {
  const contractDigest = options.contractDigest ?? CONTRACT;
  const raw: Array<{ path: string; roles: ResearchInputFileEvidence["roles"]; content: string }> = [
    { content: "contract: 1\n", path: "manifest.yaml", roles: ["manifest"] },
    { content: "task: 1\n", path: "package/task.yaml", roles: ["task_yaml"] },
  ];
  if (options.proofOnly) {
    raw.splice(0, raw.length, { content: "checked fact: 2 + 2 = 4\n", path: "facts.txt", roles: ["facts"] });
  } else if (options.dualRole) {
    raw.push({ content: "shared description and evaluator\n", path: "package/description.md",
      roles: ["description", "evaluator"] });
  } else {
    raw.push({ content: "description\n", path: "package/description.md", roles: ["description"] });
    raw.push({ content: "def evaluate():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] });
  }
  if (options.sharedDefaults) {
    raw.push({ content: "defaults: 1\n", path: "shared/defaults.yaml", roles: ["shared_task_defaults"] });
  }
  raw.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = raw.map((entry) => Object.freeze({
    path: entry.path,
    roles: entry.roles,
    size: Buffer.byteLength(entry.content),
    sha256: sha256(entry.content),
  }));
  const manifest: ResearchInputBundleManifest = {
    schemaVersion: RESEARCH_INPUT_BUNDLE_VERSION,
    contractDigest,
    files,
  };
  const bundleDigest = researchInputBundleDigest(manifest);
  const entries = raw.map((entry) => Object.freeze({
    path: entry.path,
    roles: entry.roles,
    size: Buffer.byteLength(entry.content),
    sha256: sha256(entry.content),
    content: Buffer.from(entry.content).toString("base64"),
  }));
  return {
    contractDigest,
    bundleDigest,
    files,
    contents: new Map(raw.map((entry) => [entry.path, Buffer.from(entry.content)])),
    request: {
      schemaVersion: RESEARCH_INPUT_BUNDLE_VERSION,
      contractDigest,
      bundleDigest,
      entries,
    },
  };
}

async function scratch(context: { after: (fn: () => Promise<void>) => void }, label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `research-input-${label}-`));
  const dataDir = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const closers: Array<() => Promise<void> | void> = [];
  context.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    workspace,
    close: (closer: () => Promise<void> | void) => { closers.push(closer); },
  };
}

function request(
  id: string,
  workspaceRoot: string,
  bundle: BundleFixture,
  overrides: Partial<ResearchRunRequest> = {},
): ResearchRunRequest {
  return {
    agentId: owner.agentId,
    executionId: id,
    inputs: { contractDigest: bundle.contractDigest, bundleDigest: bundle.bundleDigest },
    kind: "research",
    permissionEpoch: { sessionId: owner.sessionId } as ResearchRunRequest["permissionEpoch"],
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    workload: "fixed-program",
    workspaceRoot,
    ...overrides,
  };
}

function wiring(
  dataDir: string,
  store: RunnerResearchInputBundles | undefined,
  scenario: Scenario,
): ResearchRunWiring {
  return {
    config: { bwrapPath: "bwrap", dataDir, execTimeoutMs: 30_000, maxOutputBytes: 4_096,
      maxWorkspaceBytes: 0, terminationGraceMs: 400 },
    ...(store ? { inputBundles: store } : {}),
    fixtureRuntime: { identity: "fixture-runtime", interpreterPath: "/usr/bin/python3" },
    program: consumingProgram(scenario),
  };
}

async function managerFixture(
  context: { after: (fn: () => Promise<void>) => void },
  label: string,
  scenario: Scenario,
): Promise<{
  readonly dataDir: string;
  readonly manager: ExecutionManager;
  readonly store: RunnerResearchInputBundles;
  readonly workspace: string;
  readonly root: string;
}> {
  const { close, dataDir, root, workspace } = await scratch(context, label);
  const store = new RunnerResearchInputBundles(dataDir);
  const manager = new ExecutionManager(dataDir, undefined, {
    research: createResearchRunExecutor(wiring(dataDir, store, scenario)),
  });
  // A case that closes the manager itself to rebuild it must not fail its own
  // cleanup hook on the second close.
  close(async () => { await manager.close().catch(() => undefined); });
  return { dataDir, manager, root, store, workspace };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await delay(10);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface Consumed {
  readonly execution: string;
  readonly files: readonly ResearchInputFileEvidence[];
  readonly mount: string;
  readonly writable: boolean;
}

async function consumed(workspace: string): Promise<Consumed> {
  return JSON.parse(await readFile(resolve(workspace, "consumed.json"), "utf8")) as Consumed;
}

function readOnlyLedger(dataDir: string): DatabaseSync {
  return new DatabaseSync(resolve(dataDir, "runner-executions", "executions.sqlite"), { readOnly: true });
}

test("INPUT-RUN-01 a real bundle is verified, mounted read-only and consumed by role", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "normal", {});
  const bundle = bundleFixture();
  await store.put(bundle.request);
  manager.submitResearch(request("run-normal", workspace, bundle));
  await until(() => manager.get("run-normal", owner).state === "completed");

  const record = manager.get("run-normal", owner);
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.deepEqual(record.research?.inputs?.files, bundle.files);
  assert.equal(record.research?.inputs?.state, "verified");
  assert.ok(record.version);

  // The workload really read the mounted copy: every role's digest is the
  // bundle's. This proves the fixture read these bytes, not that any arbitrary
  // workload is trustworthy.
  const seen = await consumed(workspace);
  assert.equal(seen.execution, "run-normal");
  assert.equal(seen.mount, RESEARCH_INPUTS_MOUNT);
  assert.equal(seen.writable, false, "the copy is mounted read-only");
  assert.deepEqual(
    [...seen.files].sort((left, right) => (left.path < right.path ? -1 : 1)),
    [...bundle.files].map(({ path, roles, size, sha256 }) => ({ path, roles: [...roles], size, sha256 })),
  );

  // The published record carries the same identity, and the shared cache was
  // neither consumed nor altered by the run.
  const published = await new VersionStore(dataDir)
    .readRecord<{ researchInputs?: unknown }>(record.version!, "WorkspaceExecution");
  assert.deepEqual(published.value.researchInputs, record.research?.inputs);
  assert.equal((await store.status(bundle.bundleDigest)).status, "ready");

  // The per-execution copy is removed only after the run's termination was
  // proven and its evidence was recorded.
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-normal")), false);

  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  const row = JSON.parse(String(db.prepare("SELECT record FROM executions WHERE id = ?")
    .get("run-normal")!.record)) as { research?: { inputs?: unknown } };
  assert.deepEqual(row.research?.inputs, record.research?.inputs);
});

test("INPUT-RUN-02 shared defaults and a multi-role file are copied without miscounting", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "roles", {});
  const bundle = bundleFixture({ sharedDefaults: true, dualRole: true });
  await store.put(bundle.request);
  manager.submitResearch(request("run-roles", workspace, bundle));
  await until(() => manager.get("run-roles", owner).state === "completed");
  const record = manager.get("run-roles", owner);
  assert.equal(record.research?.inputs?.files?.length, bundle.files.length);
  const seen = await consumed(workspace);
  const dual = seen.files.find((file) => file.path === "package/description.md");
  assert.deepEqual(dual?.roles, ["description", "evaluator"]);
  const shared = seen.files.find((file) => file.path === "shared/defaults.yaml");
  assert.deepEqual(shared?.roles, ["shared_task_defaults"]);
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-roles")), false);
});

test("INPUT-RUN-03 a workspace file with the same name cannot substitute for the input", async (context) => {
  const { manager, store, workspace } = await managerFixture(context, "decoy", {});
  const bundle = bundleFixture();
  await store.put(bundle.request);
  // The workload's own writable workspace holds a decoy at the same logical
  // path. A run that fell back to workspace files would report this digest.
  await mkdir(resolve(workspace, "package"), { recursive: true });
  await writeFile(resolve(workspace, "manifest.yaml"), "decoy\n");
  await writeFile(resolve(workspace, "package", "task.yaml"), "decoy\n");
  manager.submitResearch(request("run-decoy", workspace, bundle));
  await until(() => manager.get("run-decoy", owner).state === "completed");
  const seen = await consumed(workspace);
  for (const file of seen.files) {
    const expected = bundle.files.find((candidate) => candidate.path === file.path);
    assert.equal(file.sha256, expected?.sha256, file.path);
  }
  // The workload's write probe into the mount failed; the decoy in the
  // workspace is still there untouched by the Runner.
  assert.equal(seen.writable, false);
  assert.equal(await readFile(resolve(workspace, "manifest.yaml"), "utf8"), "decoy\n");
});

test("INPUT-RUN-04 mutating the shared source after verification does not change the copy", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "frozen", {
    readDelaySeconds: 1.2,
  });
  const bundle = bundleFixture();
  await store.put(bundle.request);
  manager.submitResearch(request("run-frozen", workspace, bundle));
  // The verified record is durable before the process exists; only then is the
  // shared source removed, while the workload has not read the mount yet.
  await until(() => manager.get("run-frozen", owner).research?.inputs?.state === "verified");
  await rm(resolve(dataDir, ".research-input-bundles", bundle.bundleDigest),
    { recursive: true, force: true });
  await until(() => manager.get("run-frozen", owner).state === "completed", 30_000);
  const seen = await consumed(workspace);
  for (const file of seen.files) {
    const expected = bundle.files.find((candidate) => candidate.path === file.path);
    assert.equal(file.sha256, expected?.sha256, file.path);
  }
  assert.equal((await store.status(bundle.bundleDigest)).status, "missing");
});

test("INPUT-RUN-05 two executions of one bundle keep independent copies", async (context) => {
  const { dataDir, manager, store, root, workspace } = await managerFixture(context, "independent", {
    lingerByExecution: { "run-a": 1.5, "run-b": 4 },
  });
  const second = resolve(root, "workspace-two");
  await mkdir(second, { recursive: true });
  const bundle = bundleFixture();
  await store.put(bundle.request);
  manager.submitResearch(request("run-a", workspace, bundle));
  manager.submitResearch(request("run-b", second, bundle));
  await until(() => manager.get("run-a", owner).state === "running"
    && manager.get("run-b", owner).state === "running", 30_000);
  // `running` is recorded before the operation prepares the copy, so wait for
  // both private trees to exist instead of assuming the instant they appear.
  await until(() => pathExists(researchInputRoot(dataDir, "run-a"))
    .then(async (first) => first && await pathExists(researchInputRoot(dataDir, "run-b"))), 30_000);
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-a")), true);
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-b")), true);
  await until(() => manager.get("run-a", owner).state === "completed", 30_000);
  // The first copy's cleanup must not touch the second execution's input.
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-a")), false);
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-b")), true);
  await until(() => manager.get("run-b", owner).state === "completed", 30_000);
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-b")), false);
  assert.deepEqual((await consumed(workspace)).files.map((file) => file.sha256),
    (await consumed(second)).files.map((file) => file.sha256));
});

test("INPUT-RUN-06 an unverified termination retains the copy, and a rebuild neither deletes nor replays it", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "retained", {
    escapedDescendant: true, hang: true, honourStop: false,
  });
  const bundle = bundleFixture();
  await store.put(bundle.request);
  manager.submitResearch(request("run-retained", workspace, bundle));
  await until(() => manager.get("run-retained", owner).state === "running", 30_000);
  await until(() => manager.get("run-retained", owner).research?.inputs?.state === "verified", 30_000);
  const retainedBefore = retainedTerminationResources()
    .filter((entry) => entry.resources.includes("research-input-copy")).length;
  await manager.cancel("run-retained", owner);
  await until(() => manager.get("run-retained", owner).state === "unknown", 30_000);
  // The namespace was proven empty, but the run has no terminal business
  // record: its evidence is unknown, so its input copy is retained rather than
  // deleted, and the fence stays.
  const copy = researchInputRoot(dataDir, "run-retained");
  assert.equal(await pathExists(copy), true);
  assert.equal(retainedTerminationResources()
    .filter((entry) => entry.resources.includes("research-input-copy")).length, retainedBefore + 1);
  await manager.close();

  const rebuilt = new ExecutionManager(dataDir, undefined, {});
  context.after(async () => { await rebuilt.close(); });
  await rebuilt.ready();
  const record = rebuilt.get("run-retained", owner);
  assert.equal(record.state, "unknown");
  assert.equal(record.version, undefined);
  assert.equal(await pathExists(copy), true, "a rebuild does not delete an unknown execution's inputs");
  const db = readOnlyLedger(dataDir);
  context.after(async () => { db.close(); });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count, 1);
});

test("INPUT-RUN-07 a missing or corrupt bundle refuses before spawn and stays usable", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "refuse", {});
  manager.submitResearch(request("run-missing", workspace, bundleFixture()));
  await until(() => manager.get("run-missing", owner).state === "failed");
  const missing = manager.get("run-missing", owner);
  assert.equal(missing.research?.process, "not_started");
  assert.equal(missing.research?.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-missing")), false);

  // A published then tampered bundle is refused, not repaired.
  const bundle = bundleFixture();
  await store.put(bundle.request);
  const stored = resolve(dataDir, ".research-input-bundles", bundle.bundleDigest, "manifest.yaml");
  // Stored entries are immutable (mode 0444); replacing the file is how an
  // out-of-band edit presents itself, and the store must report it.
  await rm(stored);
  await writeFile(stored, "tampered\n");
  await manager.submitResearch(request("run-corrupt", workspace, bundle));
  await until(() => ["failed", "unknown"].includes(manager.get("run-corrupt", owner).state));
  const corrupt = manager.get("run-corrupt", owner);
  assert.equal(corrupt.research?.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  assert.equal(corrupt.research?.process, "not_started");
  assert.equal((await store.status(bundle.bundleDigest)).status, "corrupt");
});

test("INPUT-SNAP-01 the snapshot door refuses aliases, non-files and missing trees", async (context) => {
  const { dataDir, root } = await scratch(context, "snapshot");
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture();
  await store.put(bundle.request);
  const snapshot = await store.snapshot(bundle.bundleDigest);
  assert.deepEqual([...snapshot.contents.keys()].sort(), bundle.files.map((file) => file.path).sort());
  for (const file of bundle.files) {
    assert.equal(sha256(snapshot.contents.get(file.path)!), file.sha256);
  }
  const missing = bundleFixture({ contractDigest: "e".repeat(64) });
  await assert.rejects(store.snapshot(missing.bundleDigest),
    (error: unknown) => error instanceof ResearchInputBundleError);

  // A hardlink alias outside the tree is not a controlled snapshot.
  const aliasBundle = bundleFixture({ contractDigest: "d".repeat(64) });
  await store.put(aliasBundle.request);
  const aliasRoot = resolve(dataDir, ".research-input-bundles", aliasBundle.bundleDigest);
  const outside = resolve(root, "outside-manifest");
  await link(resolve(aliasRoot, "manifest.yaml"), outside);
  await assert.rejects(store.snapshot(aliasBundle.bundleDigest),
    (error: unknown) => error instanceof ResearchInputBundleError && error.kind === "corrupt");

  // A parent component replaced by a symlink is refused, never followed.
  const linkedBundle = bundleFixture({ contractDigest: "c".repeat(64) });
  await store.put(linkedBundle.request);
  const linkedRoot = resolve(dataDir, ".research-input-bundles", linkedBundle.bundleDigest);
  const realPackage = resolve(root, "real-package");
  await mkdir(realPackage);
  await writeFile(resolve(realPackage, "task.yaml"), bundle.contents.get("package/task.yaml")!);
  await rm(resolve(linkedRoot, "package"), { recursive: true, force: true });
  await symlink(realPackage, resolve(linkedRoot, "package"));
  await assert.rejects(store.snapshot(linkedBundle.bundleDigest),
    (error: unknown) => error instanceof ResearchInputBundleError && error.kind === "corrupt");

  // A FIFO at a file name is refused without waiting for a writer.
  const fifoBundle = bundleFixture({ contractDigest: "b".repeat(64) });
  await store.put(fifoBundle.request);
  const fifoRoot = resolve(dataDir, ".research-input-bundles", fifoBundle.bundleDigest);
  await rm(resolve(fifoRoot, "package", "evaluate.py"));
  execFileSync("mkfifo", [resolve(fifoRoot, "package", "evaluate.py")]);
  const refused = await Promise.race([
    store.snapshot(fifoBundle.bundleDigest).then(() => "ready" as const,
      (error: unknown) => error instanceof ResearchInputBundleError ? error.kind : "other"),
    delay(2_000).then(() => "timeout" as const),
  ]);
  assert.equal(refused, "corrupt");
});

test("INPUT-RUN-08 a bundle with an extra entry refuses before spawn, like status already says", async (context) => {
  const { dataDir, manager, store, workspace } = await managerFixture(context, "extra-entry", {});
  const bundle = bundleFixture();
  await store.put(bundle.request);
  // The published tree gains an entry the manifest does not name. `status`
  // already answers corrupt; a consuming run must not accept what the public
  // query rejects.
  await writeFile(resolve(dataDir, ".research-input-bundles", bundle.bundleDigest, "unexpected.txt"), "extra\n");
  assert.equal((await store.status(bundle.bundleDigest)).status, "corrupt");
  manager.submitResearch(request("run-extra", workspace, bundle));
  await until(() => ["failed", "unknown"].includes(manager.get("run-extra", owner).state));
  const record = manager.get("run-extra", owner);
  assert.equal(record.research?.process, "not_started");
  assert.equal(record.research?.refusal, "RESEARCH_INPUT_UNAVAILABLE");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-extra")), false);
  assert.equal(await pathExists(resolve(workspace, "consumed.json")), false,
    "no sandbox may have consumed a bundle the store calls corrupt");
});

test("INPUT-ALIAS-01 a workspace at the input parent exposes no writable alias and is refused", async (context) => {
  const { close, dataDir } = await scratch(context, "alias-parent");
  // The reviewer's alias: the execution's own writable workspace is the
  // directory that holds private input copies, so the copy root would be
  // reachable through `/workspace/<digest>` as well as `/research-inputs`.
  const workspace = resolve(dataDir, "runner-research-inputs");
  await mkdir(workspace, { recursive: true });
  const store = new RunnerResearchInputBundles(dataDir);
  const manager = new ExecutionManager(dataDir, undefined, {
    research: createResearchRunExecutor(wiring(dataDir, store, {})),
  });
  close(async () => { await manager.close().catch(() => undefined); });
  const bundle = bundleFixture();
  await store.put(bundle.request);
  manager.submitResearch(request("run-alias-parent", workspace, bundle));
  await until(() => ["failed", "unknown"].includes(manager.get("run-alias-parent", owner).state));
  const record = manager.get("run-alias-parent", owner);
  assert.equal(record.research?.process, "not_started");
  assert.equal(record.research?.refusal, "RESEARCH_INPUT_COPY_FAILED");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-alias-parent")), false);
  assert.equal(await pathExists(resolve(workspace, "consumed.json")), false);
  assert.equal((await store.status(bundle.bundleDigest)).status, "ready");
});

test("INPUT-ALIAS-02 a workspace at an ancestor of the data directory is refused", async (context) => {
  const { dataDir, root } = await scratch(context, "alias-ancestor");
  // Binding an ancestor of the data directory exposes the copy just as
  // directly: `/workspace/data/runner-research-inputs/<digest>`. The executor
  // is exercised directly here: with a workspace that contains the data
  // directory, the manager's own workspace snapshot races the state root it
  // creates, which would mask this refusal with an unrelated failure.
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture();
  await store.put(bundle.request);
  const executor = createResearchRunExecutor(wiring(dataDir, store, {}));
  const outcome = await executor.run(request("run-alias-ancestor", root, bundle), {
    signal: new AbortController().signal,
  });
  assert.equal(outcome.research.process, "not_started");
  assert.equal(outcome.research.refusal, "RESEARCH_INPUT_COPY_FAILED");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-alias-ancestor")), false);
  assert.equal(await pathExists(resolve(root, "consumed.json")), false);
});

test("INPUT-ALIAS-03 a workspace that is a host symlink to the data directory is refused", async (context) => {
  const { dataDir, root } = await scratch(context, "alias-link");
  const workspace = resolve(root, "linked-workspace");
  await symlink(dataDir, workspace);
  // The link is resolved before comparison, so the writable bind's real target
  // is what is checked, not the spelling the request used.
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture();
  await store.put(bundle.request);
  const executor = createResearchRunExecutor(wiring(dataDir, store, {}));
  const outcome = await executor.run(request("run-alias-link", workspace, bundle), {
    signal: new AbortController().signal,
  });
  assert.equal(outcome.research.process, "not_started");
  assert.equal(outcome.research.refusal, "RESEARCH_INPUT_COPY_FAILED");
  assert.equal(await pathExists(researchInputRoot(dataDir, "run-alias-link")), false);
  assert.equal(await pathExists(resolve(dataDir, "consumed.json")), false);
});

test("INPUT-ALIAS-04 a workspace naming the not-yet-created copy root is refused", async (context) => {
  const { dataDir } = await scratch(context, "alias-future-root");
  // The caller can derive this path before the Runner creates it. Comparing
  // only existing directories would see two missing paths and allow the run;
  // the canonical future spelling must still be recognised as the same place.
  const workspace = researchInputRoot(dataDir, "run-future-root");
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture();
  await store.put(bundle.request);
  const executor = createResearchRunExecutor(wiring(dataDir, store, {}));
  const outcome = await executor.run(request("run-future-root", workspace, bundle), {
    signal: new AbortController().signal,
  });
  assert.equal(outcome.research.process, "not_started");
  assert.equal(outcome.research.refusal, "RESEARCH_INPUT_COPY_FAILED");
  assert.equal(await pathExists(workspace), false, "the refusal leaves no copy at the named workspace");
});

test("INPUT-SNAP-03 status and snapshot refuse the same extra entries", async (context) => {
  const { dataDir, root } = await scratch(context, "extra-snapshot");
  const store = new RunnerResearchInputBundles(dataDir);
  const corrupt = (error: unknown): boolean =>
    error instanceof ResearchInputBundleError && error.kind === "corrupt";

  const extraFile = bundleFixture({ contractDigest: "a".repeat(64) });
  await store.put(extraFile.request);
  const extraFileRoot = resolve(dataDir, ".research-input-bundles", extraFile.bundleDigest);
  await writeFile(resolve(extraFileRoot, "unexpected.txt"), "extra\n");
  assert.equal((await store.status(extraFile.bundleDigest)).status, "corrupt");
  await assert.rejects(store.snapshot(extraFile.bundleDigest), corrupt);

  const extraDirectory = bundleFixture({ contractDigest: "b".repeat(64) });
  await store.put(extraDirectory.request);
  await mkdir(resolve(dataDir, ".research-input-bundles", extraDirectory.bundleDigest, "extra"));
  assert.equal((await store.status(extraDirectory.bundleDigest)).status, "corrupt");
  await assert.rejects(store.snapshot(extraDirectory.bundleDigest), corrupt);

  const extraLink = bundleFixture({ contractDigest: "c".repeat(64) });
  await store.put(extraLink.request);
  await symlink(resolve(root, "elsewhere"),
    resolve(dataDir, ".research-input-bundles", extraLink.bundleDigest, "link"));
  assert.equal((await store.status(extraLink.bundleDigest)).status, "corrupt");
  await assert.rejects(store.snapshot(extraLink.bundleDigest), corrupt);

  const extraFifo = bundleFixture({ contractDigest: "d".repeat(64) });
  await store.put(extraFifo.request);
  execFileSync("mkfifo", [resolve(dataDir, ".research-input-bundles", extraFifo.bundleDigest, "pipe")]);
  assert.equal((await store.status(extraFifo.bundleDigest)).status, "corrupt");
  const refused = await Promise.race([
    store.snapshot(extraFifo.bundleDigest).then(() => "ready" as const, corrupt),
    delay(2_000).then(() => "timeout" as const),
  ]);
  assert.equal(refused, true);
});

test("INPUT-SNAP-02 a re-verified copy is byte-identical to the snapshot", async (context) => {
  const { dataDir } = await scratch(context, "copy");
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture({ sharedDefaults: true });
  await store.put(bundle.request);
  const snapshot = await store.snapshot(bundle.bundleDigest);
  // The canonical manifest is a function of the same fields; two reads agree.
  const again = await store.snapshot(bundle.bundleDigest);
  assert.equal(canonicalResearchInputBundleManifest(again.manifest),
    canonicalResearchInputBundleManifest(snapshot.manifest));
  for (const [path, bytes] of snapshot.contents) {
    assert.deepEqual(again.contents.get(path), bytes, path);
  }
});


test("a proof-only workload uses the shared registry, durable ledger and immutable inputs", async (context) => {
  const { close, dataDir, workspace } = await scratch(context, "proof-product");
  const store = new RunnerResearchInputBundles(dataDir);
  const bundle = bundleFixture({ proofOnly: true });
  await store.put(bundle.request);
  const definitions = ["proof-checker", "another-product"].map((workloadId) => ({ ...wiring(dataDir, store, {}), workloadId }));
  const registry = createResearchWorkloadRegistry(definitions);
  let manager = new ExecutionManager(dataDir, undefined, { research: registry });
  close(async () => manager.close());
  assert.throws(() => manager.submitResearch(request("unknown", workspace, bundle, { workload: "unregistered" })),
    { code: "RESEARCH_WORKLOAD_UNKNOWN" });
  const input = request("proof", workspace, bundle, { workload: "proof-checker" });
  assert.equal(manager.submitResearch(input).accepted, true);
  assert.equal(manager.submitResearch(input).accepted, false);
  await until(() => manager.get("proof", owner).state === "completed");
  const completed = manager.get("proof", owner);
  assert.ok(completed.version);
  assert.deepEqual(completed.research?.inputs?.files?.map((file) => file.roles), [["facts"]]);
  assert.equal((await consumed(workspace)).files[0]?.sha256, bundle.files[0]?.sha256);
  await manager.close();
  manager = new ExecutionManager(dataDir, undefined, { research: createResearchWorkloadRegistry(definitions) });
  assert.deepEqual(manager.get("proof", owner).version, completed.version);
  assert.equal(manager.submitResearch(input).accepted, false);
  manager.submitResearch(request("another", workspace, bundle, { workload: "another-product" }));
  await until(() => manager.get("another", owner).state === "completed");
});
