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
 * Round 16 acceptance: the real patched engine under the real Runner.
 *
 * Every case here drives one production path end to end: the real
 * `ExecutionManager`, the real research executor, the verified private input
 * copy, the real bubblewrap sandbox with the research seccomp profile, the
 * fixed bridge, the patched `prepare_run()`, the patched `worker.supervise()`
 * and the engine's own durable registry. The one workload identity is a
 * dataset-free frozen task package; the task package the engine reads is the
 * frozen one, relocated by the bridge.
 *
 * PREREQUISITE, AND WHY THESE CASES ARE PENDING. `prepare_run()` parses the
 * launch manifest through `ParallelRunner`, whose import graph needs the
 * engine's third-party dependencies (`omegaconf` and the rest of
 * `foundation/config`). No interpreter on this machine has them today, and
 * this round may not install packages, copy a daily environment or substitute
 * the parser. `SCIENCEFLOW_TEST_ENGINE_PYTHON` must therefore name a
 * user-supplied interpreter inside the engine's declared range (`>=3.11,<3.14`)
 * that can import the engine normally. Without it every case below skips with
 * the exact reason; the first case is the concrete probe the task asks for
 * (normal `prepare_run` import), and it fails rather than skips when both
 * variables are set.
 *
 * Substitutions are confined to the expensive boundaries the task allows: the
 * model research step, the report generator child process, the report content
 * read and the library export payload. The adapter that makes those
 * substitutions is written by this test into the controlled sandbox prefix; it
 * is never reachable from a request, a route or a configuration file.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test, before, after } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ManagedExecution,
  type ResearchEngineEvidence,
  type ResearchRunRequest,
  type ResearchTimeSchedule,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowInputFileRole,
} from "@sciencediscovery/schema";

import {
  createResearchRunExecutor,
  researchInputRoot,
  researchStateRoot,
  type ResearchEngineBinding,
  type ResearchRunWiring,
} from "./research-run.js";
import { researchEngineStateRoot } from "./scienceflow-engine-bridge.js";
import { ExecutionManager } from "./execution-manager.js";
import type { EnvironmentRuntime } from "./environment-store.js";

const ENGINE = process.env.SCIENCEFLOW_ENGINE_CHECKOUT;
const ENGINE_PYTHON = process.env.SCIENCEFLOW_TEST_ENGINE_PYTHON;
/** The pinned checkout's declared package version; the bridge must report it. */
const VERSION = "0.2.0";
/** The frozen task id collides with a real task of the pinned checkout. */
const FROZEN_ID = "circle-packing";
const FROZEN_METRIC = "frozen_score";
const OWNER = { agentId: "agent", sessionId: "session" } as const;
const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 200, reportBudgetMs: 10_000, researchBudgetMs: 60_000,
  stopGraceMs: 1_000, verificationWindowMs: 10_000,
};

// ---------------------------------------------------------------------------
// Prerequisite: the pinned engine's normal prepare_run import
// ---------------------------------------------------------------------------

const IMPORT_PROBE = `
import os, sys
sys.path.insert(0, os.environ["SF_ENGINE"])
from scienceflow.runtime.parallel.execution.runner import ParallelRunner
from scienceflow.runtime.parallel.control.service import prepare_run
if not callable(prepare_run):
    raise SystemExit("prepare_run is not callable")
print("ok")
`;

interface Prerequisite {
  readonly ok: boolean;
  readonly detail: string;
}

let prerequisiteOnce: Promise<Prerequisite> | undefined;

/** The one concrete prerequisite check; never a machine-wide audit. */
function prerequisite(): Promise<Prerequisite> {
  prerequisiteOnce ??= (async (): Promise<Prerequisite> => {
    if (ENGINE === undefined) {
      return { detail: "SCIENCEFLOW_ENGINE_CHECKOUT does not name the patched engine checkout", ok: false };
    }
    if (ENGINE_PYTHON === undefined) {
      return {
        detail: "SCIENCEFLOW_TEST_ENGINE_PYTHON does not name a compliant interpreter with the engine's dependencies",
        ok: false,
      };
    }
    const probe = spawnSync(ENGINE_PYTHON, ["-I", "-B", "-c", IMPORT_PROBE], {
      encoding: "utf8",
      env: { ...process.env, PYTHONNOUSERSITE: "1", SF_ENGINE: ENGINE },
      timeout: 120_000,
    });
    if (probe.error !== undefined) return { detail: probe.error.message, ok: false };
    if (probe.status !== 0) {
      const lines = (probe.stderr ?? "").trim().split("\n").filter((line) => line.trim().length > 0);
      return { detail: lines.at(-1) ?? "the engine import failed", ok: false };
    }
    return { detail: "imported", ok: true };
  })();
  return prerequisiteOnce;
}

async function requiresEngine(context: { skip?: (message?: string) => void }): Promise<boolean> {
  const result = await prerequisite();
  if (result.ok) return false;
  context.skip?.(result.detail);
  return true;
}

// ---------------------------------------------------------------------------
// Controlled sandbox prefix, assembled once from the accepted interpreter
// ---------------------------------------------------------------------------

const PREFIX_BUILD = String.raw`
import json, os, shutil, site, sys, sysconfig
prefix = sys.argv[1]
source = sys.argv[2]
version = "%d.%d" % sys.version_info[:2]
lib = os.path.join(prefix, "lib", "python" + version)
os.makedirs(os.path.join(prefix, "bin"))
os.makedirs(lib)
shutil.copyfile(sys.executable, os.path.join(prefix, "bin", "python"))
os.chmod(os.path.join(prefix, "bin", "python"), 0o755)
stdlib = sysconfig.get_path("stdlib")
for entry in os.listdir(stdlib):
    if entry in ("site-packages", "dist-packages", "sitecustomize.py", "usercustomize.py"):
        continue
    source_entry = os.path.join(stdlib, entry)
    target_entry = os.path.join(lib, entry)
    if stdlib.startswith("/usr/"):
        # The sandbox already mounts /usr read-only; a link stays valid there.
        os.symlink(source_entry, target_entry)
    elif os.path.isdir(source_entry) and not os.path.islink(source_entry):
        # Outside the host mounts the sandbox provides, the fixture carries the
        # stdlib itself; a link would dangle inside the sandbox.
        shutil.copytree(source_entry, target_entry, symlinks=True)
    else:
        shutil.copy2(source_entry, target_entry, follow_symlinks=False)
site_dir = os.path.join(lib, os.path.basename(site.getsitepackages()[0]))
os.makedirs(site_dir)
# The engine's own dependencies come from the interpreter that was accepted for
# this run. Only packages are carried: a copied .pth file (whose import lines
# the source-binding probe refuses), a startup hook or a second scienceflow
# package would change how the checkout resolves, so none of them is copied.
copied = set()
for packages_root in site.getsitepackages():
    if not os.path.isdir(packages_root):
        continue
    for entry in sorted(os.listdir(packages_root)):
        if entry in copied or entry in ("__pycache__", "sitecustomize.py", "usercustomize.py"):
            continue
        if entry.endswith(".pth") or entry.startswith("scienceflow"):
            continue
        source_entry = os.path.join(packages_root, entry)
        target_entry = os.path.join(site_dir, entry)
        if os.path.lexists(target_entry):
            continue
        copied.add(entry)
        if os.path.isdir(source_entry) and not os.path.islink(source_entry):
            shutil.copytree(source_entry, target_entry, symlinks=True)
        elif os.path.isfile(source_entry) and not os.path.islink(source_entry):
            shutil.copy2(source_entry, target_entry)
with open(os.path.join(site_dir, "scienceflow.pth"), "w") as handle:
    handle.write(source + "\n")
print(json.dumps({"site": site_dir, "version": version}))
`;

/**
 * The test-only adapter the bridge imports as its research step.
 *
 * `worker.run_manifest` is the engine's own seam, and the three module
 * attributes are the engine's own substitution points for its expensive
 * boundaries. The import-time gate is what makes "a stop arrived before
 * research" a fact instead of a race: the bridge imports this module after its
 * stop watcher is running and before `prepare_run()`.
 */
const ADAPTER = String.raw`
"""Test-only expensive boundaries for the Runner's engine integration run."""

import asyncio
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

WORKSPACE = Path("/workspace")
GATE = WORKSPACE / "adapter"


def marker(name, text=""):
    GATE.mkdir(parents=True, exist_ok=True)
    temporary = GATE / ("." + name)
    temporary.write_text(text)
    os.replace(temporary, GATE / name)


def append_marker(name, line):
    GATE.mkdir(parents=True, exist_ok=True)
    with open(GATE / name, "a") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def wait(name, timeout=180.0):
    deadline = time.monotonic() + timeout
    while not (GATE / name).exists():
        if time.monotonic() > deadline:
            raise RuntimeError("adapter timed out waiting for " + name)
        time.sleep(0.02)


def engine_record():
    root = Path(os.environ["XDG_STATE_HOME"]) / "scienceflow" / "managed_runs"
    entries = sorted(root.glob("*/control.json"))
    if len(entries) != 1:
        raise RuntimeError("expected exactly one engine record, found %d" % len(entries))
    return json.loads(entries[0].read_text())


class Summary:
    def __init__(self):
        self.text = "adapter research"
        self.results = [SimpleNamespace(status="success")]


async def report_process(*argv, **kwargs):
    """The report generator: a real child in its own session, holdable."""
    seconds = "30" if (GATE / "report.hold").exists() else "0"
    process = await asyncio.create_subprocess_exec("/bin/sleep", seconds, **kwargs)
    marker("report.child", str(process.pid))
    marker("report.entered")
    return process


def read_report_manifest(root):
    """The committed report content; the child process is what was substituted."""
    current = engine_record()
    return {"attempt": current["attempt"], "run_id": current["run_id"], "status": "ready"}


def export_success(current):
    """The library export payload; holding here proves the post-terminal window."""
    marker("export.entered")
    if (GATE / "export.hold").exists():
        wait("export.release")
    return {"status": "registered"}


async def run(manifest):
    from scienceflow.runtime.parallel.control import reporting
    import scienceflow.research.reporting as research_reporting
    import scienceflow.research.onboarding.library.export as export_module
    reporting.spawn_report_process = report_process
    research_reporting.read_report_manifest = read_report_manifest
    export_module.export_success = export_success
    marker("research.entered")
    if (GATE / "research.stop").exists():
        try:
            await asyncio.sleep(600)
        except asyncio.CancelledError:
            append_marker("research.cancelled", "1")
            raise
    marker("research.completed")
    return Summary()


# The bridge imports this module before prepare_run(); holding here turns a
# stop that must precede research into an ordering, not a timing guess.
marker("imported")
wait("import-release")
`;

interface Prefix {
  readonly languageVersion: string;
  readonly root: string;
}

let prefixOnce: Promise<Prefix | null> | undefined;

function prefix(): Promise<Prefix | null> {
  prefixOnce ??= (async (): Promise<Prefix | null> => {
    const result = await prerequisite();
    if (!result.ok) return null;
    const root = await mkdtemp(resolve(tmpdir(), "engine-integration-prefix-"));
    const build = spawnSync(ENGINE_PYTHON!, ["-I", "-B", "-c", PREFIX_BUILD, root, ENGINE!], {
      encoding: "utf8", timeout: 300_000,
    });
    if (build.error !== undefined) throw build.error;
    assert.equal(build.status, 0, build.stderr);
    const answer = JSON.parse(build.stdout.trim().split("\n").at(-1)!) as {
      site: string; version: string;
    };
    await writeFile(resolve(answer.site, "sf_test_adapter.py"), ADAPTER);
    return { languageVersion: answer.version, root };
  })();
  return prefixOnce;
}

after(async () => {
  if (prefixOnce === undefined) return;
  const built = await prefixOnce.catch(() => null);
  if (built !== null) await rm(built.root, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Frozen input package and the per-case sandbox fixture
// ---------------------------------------------------------------------------

interface Entry {
  readonly content: string;
  readonly path: string;
  readonly roles: readonly ScienceFlowInputFileRole[];
}

const DESCRIPTION = "Solve the frozen task and submit the table.\n";
const TASK_YAML = [
  `id: ${FROZEN_ID}`,
  "category: benchmarks",
  "profile: artifact_solver",
  "description: description.md",
  "artifact:",
  "  path: submission.csv",
  "  kind: table",
  "metric:",
  `  name: ${FROZEN_METRIC}`,
  "  lower_is_better: false",
  "evaluator:",
  "  entrypoint: evaluate.py:main",
  "  timeout_sec: 30",
  "",
].join("\n");

/** One single-task, dataset-free frozen contract the bridge supports. */
function frozenContract(): Entry[] {
  const manifest = [
    "max_concurrent: 1",
    "time_limit: 900",
    "tasks:",
    `  - exp_id: ${FROZEN_ID}`,
    "    lnr:",
    "      wall_clock_budget_sec: 600",
    "defaults:",
    "  phase: run",
    "  type: lnr",
    "  workspace_base: /srv/workspaces",
    "",
  ].join("\n");
  return [
    { content: manifest, path: "manifest.yaml", roles: ["manifest"] },
    { content: TASK_YAML, path: "package/task.yaml", roles: ["task_yaml"] },
    { content: DESCRIPTION, path: "package/description.md", roles: ["description"] },
    { content: "def main():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] },
    { content: "inputs:\n  required: false\n", path: "package/_shared/task_defaults.yaml", roles: ["shared_task_defaults"] },
  ];
}

interface InputBundle {
  readonly contents: Map<string, Buffer>;
  readonly identity: { readonly bundleDigest: string; readonly contractDigest: string };
  readonly manifest: ScienceFlowInputBundleManifest;
}

function bundle(entries: readonly Entry[]): InputBundle {
  const contractDigest = "a".repeat(64);
  const files = entries
    .map((entry) => ({
      path: entry.path,
      roles: entry.roles,
      size: Buffer.byteLength(entry.content),
      sha256: createHash("sha256").update(entry.content).digest("hex"),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION as typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files,
  };
  const bundleDigest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
  return {
    contents: new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content)])),
    identity: { bundleDigest, contractDigest },
    manifest,
  };
}

interface Fixture {
  readonly dataDir: string;
  readonly root: string;
  readonly runtime: EnvironmentRuntime;
  readonly revision: string;
  readonly workspace: string;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(
  context: { after: (fn: () => Promise<void>) => void },
  built: Prefix,
): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "engine-integration-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const dataDir = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const runtime: EnvironmentRuntime = {
    environment: {
      createdAt: "now", currentRevisionId: "revision", id: "environment",
      kind: "task", language: "python", name: "fixture", updatedAt: "now",
    },
    interpreterPath: resolve(built.root, "bin/python"),
    prefixPath: built.root,
    revision: {
      channels: [], createdAt: "now", environmentId: "environment", id: "revision",
      language: "python", languageVersion: built.languageVersion, packageSpecHash: "fixture", packages: [],
      platform: "linux", provisioner: "fixture", runnerVersion: "fixture",
      snapshot: { hash: "fixture", size: 0 },
    },
  };
  return { dataDir, revision: git(ENGINE!, ["rev-parse", "HEAD"]), root, runtime, workspace };
}

function request(id: string, workspace: string, identity: InputBundle["identity"]): ResearchRunRequest {
  return {
    agentId: OWNER.agentId,
    environmentId: "environment",
    executionId: id,
    expectedEnvironmentRevisionId: "revision",
    inputs: { ...identity },
    kind: "research",
    permissionEpoch: { sessionId: OWNER.sessionId } as ResearchRunRequest["permissionEpoch"],
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    workload: "scienceflow-fixed",
    workspaceRoot: workspace,
  };
}

function wiring(f: Fixture, inputs: InputBundle): ResearchRunWiring {
  const engine: ResearchEngineBinding = {
    researchStepModule: "sf_test_adapter",
    revision: f.revision,
    runtimeBindingId: "binding",
    sourceRoot: ENGINE!,
    version: VERSION,
  };
  return {
    config: {
      bwrapPath: "bwrap", dataDir: f.dataDir, execTimeoutMs: 30_000, maxOutputBytes: 65_536,
      maxWorkspaceBytes: 0, terminationGraceMs: 2_000,
    },
    engine,
    environmentStore: { withRuntime: async (_id, operation) => operation(f.runtime) },
    inputBundles: {
      hostRoots: () => [],
      snapshot: async () => ({ contents: inputs.contents, manifest: inputs.manifest }),
    },
    runtimeBindings: {
      bindingFor: (id) => id === "binding"
        ? { bindingId: id, expectedRevision: f.revision, sourceRoot: ENGINE! }
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("the expected observation did not happen");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function settled(record: ManagedExecution): boolean {
  return record.state !== "queued" && record.state !== "running";
}

function gatePath(workspace: string, name: string): string {
  return resolve(workspace, "adapter", name);
}

async function mark(workspace: string, name: string, text = ""): Promise<void> {
  await mkdir(resolve(workspace, "adapter"), { recursive: true });
  await writeFile(gatePath(workspace, name), text);
}

function marked(workspace: string, name: string): boolean {
  return existsSync(gatePath(workspace, name));
}

/** The engine record prepared for this execution, read from Runner-owned state. */
async function engineRecord(dataDir: string, id: string): Promise<Record<string, unknown>> {
  const registry = resolve(researchEngineStateRoot(dataDir, id), "state/scienceflow/managed_runs");
  const runs = (await readdir(registry)).filter((name) => !name.startsWith("."));
  assert.equal(runs.length, 1, `expected one engine run, saw ${runs.join(", ")}`);
  return JSON.parse(await readFile(resolve(registry, runs[0]!, "control.json"), "utf8")) as Record<string, unknown>;
}

function started(manager: ExecutionManager, id: string): ManagedExecution {
  return manager.get(id, OWNER);
}

/** Start one execution and return its record once the manager is running it. */
async function launch(manager: ExecutionManager, f: Fixture, inputs: InputBundle, id: string): Promise<void> {
  manager.submitResearch(request(id, f.workspace, inputs.identity));
  await until(() => started(manager, id).state === "running");
}

// ---------------------------------------------------------------------------
// The prerequisite itself: the pinned engine's normal prepare_run import
// ---------------------------------------------------------------------------

test("the pinned engine's prepare_run imports under the acceptance interpreter", async (context) => {
  if (ENGINE === undefined) {
    context.skip?.("SCIENCEFLOW_ENGINE_CHECKOUT does not name the patched engine checkout");
    return;
  }
  if (ENGINE_PYTHON === undefined) {
    context.skip?.("SCIENCEFLOW_TEST_ENGINE_PYTHON does not name a compliant interpreter with the engine's dependencies");
    return;
  }
  // Both variables are set, so this is no longer a missing fixture: a pinned
  // engine that cannot be imported normally is a real failure of the run.
  const result = await prerequisite();
  assert.equal(result.ok, true, `the engine did not import: ${result.detail}`);
});

// ---------------------------------------------------------------------------
// Scenario 1: prepare and normal completion, consuming the frozen package
// ---------------------------------------------------------------------------

test("prepare, supervision and completion drive the real engine lifecycle", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const built = await prefix();
  if (built === null) {
    context.skip?.("the controlled engine prefix could not be assembled");
    return;
  }
  const f = await fixture(context, built);
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  await mark(f.workspace, "import-release");
  await launch(manager, f, inputs, "engine-completed");
  await until(() => settled(manager.get("engine-completed", OWNER)), 120_000);
  const record = manager.get("engine-completed", OWNER);
  assert.equal(record.state, "completed", JSON.stringify(record.research));
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "ready");
  assert.equal(record.evidence?.processTerminated, true);
  // Publication needs a workspace version: completion came from the terminal
  // record plus the proven boundary, not from an exit code.
  assert.notEqual(record.version, undefined);
  // The execution-to-engine association the bridge reported is durable.
  const engine = record.research?.engine as ResearchEngineEvidence | undefined;
  assert.notEqual(engine, undefined);
  assert.equal(engine?.attempt, 1);
  assert.equal(engine?.revision, f.revision);
  assert.equal(engine?.version, VERSION);
  assert.match(engine!.engineRunId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u);
  // The engine's own record is the producer of those facts: the real
  // `prepare_run()` created run/attempt/token and the real supervisor claimed
  // the identity, so the record carries both without spawning a detached worker.
  const engineRun = await engineRecord(f.dataDir, "engine-completed");
  assert.equal(engineRun.run_id, engine!.engineRunId);
  assert.equal(engineRun.attempt, 1);
  assert.equal(typeof engineRun.launch_token, "string");
  assert.equal(typeof engineRun.pid, "number");
  assert.equal(engineRun.status, "completed");
  assert.equal(engineRun.phase, "finished");
  assert.equal(engineRun.research_status, "completed");
  assert.equal(engineRun.report_status, "ready");
  assert.deepEqual(engineRun.task_registration, { status: "registered" });
  // The prepared task configuration reads the frozen package, not the pinned
  // checkout's own task with the same name (`circle-packing` exists there).
  const payload = engineRun.manifest_payload as {
    tasks: Array<{
      exp_id: string;
      task: string;
      evaluator: {
        package_source: string;
        metric: { name: string };
        candidate: { artifact: string };
      };
    }>;
  };
  const task = payload.tasks[0]!;
  assert.notEqual(task.exp_id, FROZEN_ID);
  assert.match(task.exp_id, /^sf-[0-9a-f]{16}$/u);
  assert.equal(task.task, DESCRIPTION);
  assert.equal(task.evaluator.metric.name, FROZEN_METRIC);
  assert.equal(task.evaluator.candidate.artifact, "submission.csv");
  const packageSource = resolve(task.evaluator.package_source);
  assert.ok(
    packageSource.startsWith(resolve(researchEngineStateRoot(f.dataDir, "engine-completed"), "task-package")),
    packageSource,
  );
  // Relocation is byte-for-byte: the engine read exactly the frozen bytes.
  assert.equal(await readFile(resolve(packageSource, "task.yaml"), "utf8"), TASK_YAML);
  assert.equal(await readFile(resolve(packageSource, "description.md"), "utf8"), DESCRIPTION);
  // The manager released the private copy only after the boundary was proven.
  await assert.rejects(stat(researchInputRoot(f.dataDir, "engine-completed")));
});

// ---------------------------------------------------------------------------
// Scenario 2: a durable stop that arrives before research starts
// ---------------------------------------------------------------------------

test("a pending durable stop is stated by the real supervisor as not-started", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const built = await prefix();
  if (built === null) {
    context.skip?.("the controlled engine prefix could not be assembled");
    return;
  }
  const f = await fixture(context, built);
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  await launch(manager, f, inputs, "engine-pending-stop");
  // The adapter holds the bridge after the stop watcher is armed and before
  // `prepare_run()`, so the intent demonstrably precedes research.
  await until(() => marked(f.workspace, "imported"), 120_000);
  await manager.cancel("engine-pending-stop", OWNER);
  await mark(f.workspace, "import-release");
  await until(() => settled(manager.get("engine-pending-stop", OWNER)), 120_000);
  const record = manager.get("engine-pending-stop", OWNER);
  assert.equal(record.state, "cancelled", JSON.stringify(record.research));
  assert.equal(record.research?.outcome, "not-started");
  assert.equal(record.research?.phase, "finished");
  assert.equal(record.research?.report, "none");
  assert.notEqual(record.research?.stop, "none");
  assert.equal(record.research?.process, "spawned-then-terminated");
  // The supervisor wrote the positive fact; nothing ran and nothing reported.
  const engineRun = await engineRecord(f.dataDir, "engine-pending-stop");
  assert.equal(engineRun.status, "stopped");
  assert.equal(engineRun.phase, "finished");
  assert.equal(engineRun.research_status, "not-started");
  assert.equal(engineRun.report_status, "none");
  // One intent, consumed exactly once: the stop file was renamed away.
  assert.equal(marked(f.workspace, "research.entered"), false);
  assert.equal(marked(f.workspace, "report.entered"), false);
  const control = resolve(researchStateRoot(f.dataDir, "engine-pending-stop"), "control");
  assert.equal(existsSync(resolve(control, "stop")), false);
  assert.equal(existsSync(resolve(control, "stop.consumed")), true);
});

// ---------------------------------------------------------------------------
// Scenario 3: a stop during research
// ---------------------------------------------------------------------------

test("a durable stop during research cancels once and reporting follows", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const built = await prefix();
  if (built === null) {
    context.skip?.("the controlled engine prefix could not be assembled");
    return;
  }
  const f = await fixture(context, built);
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  await mark(f.workspace, "research.stop");
  await mark(f.workspace, "import-release");
  await launch(manager, f, inputs, "engine-research-stop");
  await until(() => marked(f.workspace, "research.entered"), 120_000);
  await manager.cancel("engine-research-stop", OWNER);
  await until(() => settled(manager.get("engine-research-stop", OWNER)), 120_000);
  const record = manager.get("engine-research-stop", OWNER);
  assert.equal(record.state, "cancelled", JSON.stringify(record.research));
  assert.equal(record.research?.outcome, "stopped");
  assert.equal(record.research?.report, "ready");
  assert.notEqual(record.research?.stop, "none");
  // The intent cancelled research exactly once; the adapter records each one.
  const cancellations = (await readFile(gatePath(f.workspace, "research.cancelled"), "utf8")).trim().split("\n");
  assert.equal(cancellations.length, 1);
  const engineRun = await engineRecord(f.dataDir, "engine-research-stop");
  assert.equal(engineRun.research_status, "stopped");
  assert.equal(engineRun.phase, "finished");
  assert.equal(engineRun.status, "stopped");
  // The one intent was consumed once and the process boundary is proven. The
  // supervisor's own "no control waiter survives" guarantee is engine-side
  // (`finally` in `supervise`), covered by the engine's lifecycle suite; the
  // Runner never sees the bridge's stderr because research output is not
  // projected into the log table, so this case does not pretend to observe it.
  assert.equal(record.research?.stop, "consumed");
  assert.equal(record.research?.process, "spawned-then-terminated");
  const control = resolve(researchStateRoot(f.dataDir, "engine-research-stop"), "control");
  assert.equal(existsSync(resolve(control, "stop")), false);
  assert.equal(existsSync(resolve(control, "stop.consumed")), true);
});

// ---------------------------------------------------------------------------
// Scenario 4: a stop during reporting
// ---------------------------------------------------------------------------

test("a durable stop during reporting keeps research and marks the report incomplete", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const built = await prefix();
  if (built === null) {
    context.skip?.("the controlled engine prefix could not be assembled");
    return;
  }
  const f = await fixture(context, built);
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  // The report child is a real process that stays alive until it is reaped.
  await mark(f.workspace, "report.hold");
  await mark(f.workspace, "import-release");
  await launch(manager, f, inputs, "engine-report-stop");
  await until(() => marked(f.workspace, "report.entered"), 120_000);
  await manager.cancel("engine-report-stop", OWNER);
  await until(() => settled(manager.get("engine-report-stop", OWNER)), 120_000);
  const record = manager.get("engine-report-stop", OWNER);
  assert.equal(record.state, "cancelled", JSON.stringify(record.research));
  assert.equal(record.research?.outcome, "completed");
  assert.equal(record.research?.report, "incomplete");
  const engineRun = await engineRecord(f.dataDir, "engine-report-stop");
  assert.equal(engineRun.research_status, "completed");
  assert.equal(engineRun.report_status, "incomplete");
  assert.equal(engineRun.status, "completed");
  assert.equal(engineRun.report_timed_out, false);
  // The report child was reaped before the manager released the resources.
  const child = Number((await readFile(gatePath(f.workspace, "report.child"), "utf8")).trim());
  assert.ok(Number.isInteger(child) && child > 1, String(child));
  assert.equal(existsSync(`/proc/${child}`), false);
});

// ---------------------------------------------------------------------------
// Scenario 5: the window after the engine record became terminal
// ---------------------------------------------------------------------------

test("a held export boundary keeps the manager from publishing or releasing", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const built = await prefix();
  if (built === null) {
    context.skip?.("the controlled engine prefix could not be assembled");
    return;
  }
  const f = await fixture(context, built);
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  await mark(f.workspace, "export.hold");
  await mark(f.workspace, "import-release");
  await launch(manager, f, inputs, "engine-window");
  await until(() => marked(f.workspace, "export.entered"), 120_000);
  // The engine's record is terminal while its workload is still alive.
  const terminal = await engineRecord(f.dataDir, "engine-window");
  assert.equal(terminal.phase, "finished");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.report_status, "ready");
  // The manager has not published the completion, has not released the private
  // inputs, and does not run a second execution on the same workspace.
  assert.equal(started(manager, "engine-window").state, "running");
  await stat(researchInputRoot(f.dataDir, "engine-window"));
  manager.submitResearch(request("engine-window-conflict", f.workspace, inputs.identity));
  await until(() => started(manager, "engine-window-conflict").state === "queued");
  assert.equal(started(manager, "engine-window-conflict").state, "queued");
  await manager.cancel("engine-window-conflict", OWNER);
  await mark(f.workspace, "export.release");
  await until(() => settled(manager.get("engine-window", OWNER)), 120_000);
  const record = manager.get("engine-window", OWNER);
  assert.equal(record.state, "completed", JSON.stringify(record.research));
  assert.notEqual(record.version, undefined);
  await assert.rejects(stat(researchInputRoot(f.dataDir, "engine-window")));
  // The cancelled conflict never launched.
  const conflict = manager.get("engine-window-conflict", OWNER);
  assert.equal(conflict.state, "cancelled");
  assert.equal(conflict.research?.outcome, "not-started");
});

// ---------------------------------------------------------------------------
// Scenario 6: prepare without spawn, and the old detached launch
// ---------------------------------------------------------------------------

const COMPATIBILITY = String.raw`
import json, os, subprocess, sys, types
from pathlib import Path

engine = sys.argv[1]
root = Path(sys.argv[2])
sys.path.insert(0, engine)

from scienceflow.runtime.parallel.control import service
from scienceflow.runtime.parallel.control.registry import read_record, run_dir

first_manifest = root / "manifest-first.yaml"
second_manifest = root / "manifest-second.yaml"
third_manifest = root / "manifest-third.yaml"

prepared = service.prepare_run(first_manifest)
first = read_record(prepared.directory)
spawned = []
duplicate = None
try:
    service.prepare_run(first_manifest)
except ValueError as error:
    duplicate = str(error)
# The refusal released registry and run-directory locks: a second run prepares.
reopened = service.prepare_run(second_manifest)

class FakeProcess:
    def __init__(self, argv, **kwargs):
        self.pid = os.getpid()
        self.argv = [str(item) for item in argv]
        self.kwargs = dict(kwargs)

def fake_popen(argv, **kwargs):
    process = FakeProcess(argv, **kwargs)
    spawned.append({"argv": process.argv, "cwd": str(kwargs.get("cwd")),
                    "close_fds": kwargs.get("close_fds"),
                    "start_new_session": kwargs.get("start_new_session")})
    return process

class FakeSubprocess:
    Popen = staticmethod(fake_popen)
    DEVNULL = subprocess.DEVNULL
    STDOUT = subprocess.STDOUT

# The only intercepted boundary is the detached spawn: the record-arming half,
# the busy check, the reservation and the manifest write stay production code.
service.subprocess = FakeSubprocess
public = service.start_run(third_manifest)
started = read_record(run_dir(public["run_id"]))

print(json.dumps({
    "duplicate": duplicate,
    "first": {
        "attempt": first["attempt"],
        "has_pid": "pid" in first,
        "manifest_exists": Path(first["manifest"]).is_file(),
        "status": first["status"],
        "token_length": len(first["launch_token"]),
    },
    "reopened_attempt": reopened.attempt,
    "reopened_has_pid": "pid" in read_record(reopened.directory),
    "spawned": spawned,
    "started": {
        "attempt": started["attempt"],
        "has_pid": "pid" in started and "process_created" in started,
        "status": started["status"],
        "token": started["launch_token"],
        "log": started["log"],
    },
    "run_id": started["run_id"],
}))
`;

/** A minimal legacy manifest and the relocated task package it names. */
async function compatibilityFixture(root: string): Promise<void> {
  const packageDir = resolve(root, "task-package", FROZEN_ID);
  await mkdir(resolve(root, "task-package", "_shared"), { recursive: true });
  await mkdir(packageDir, { recursive: true });
  await mkdir(resolve(root, "workspace"), { recursive: true });
  await writeFile(resolve(packageDir, "task.yaml"), TASK_YAML);
  await writeFile(resolve(packageDir, "description.md"), DESCRIPTION);
  await writeFile(resolve(packageDir, "evaluate.py"), "def main():\n    return 1\n");
  await writeFile(resolve(root, "task-package", "_shared", "task_defaults.yaml"), "inputs:\n  required: false\n");
  const manifest = (runId: string): string => [
    "report_budget_sec: 2",
    "max_concurrent: 1",
    "time_limit: 600",
    "resume: false",
    "defaults:",
    "  phase: run",
    "  type: lnr",
    "tasks:",
    `  - exp_id: ${runId}`,
    `    run_id: ${runId}`,
    `    task: "Solve the frozen task and submit the table."`,
    `    workspace: ${resolve(root, "workspace", runId)}`,
    "    type: lnr",
    "    time_limit: 600",
    "    evaluator:",
    "      enabled: true",
    "      backend: task_package",
    "      task_profile: benchmarks",
    `      package_source: ${packageDir}`,
    "      candidate:",
    "        artifact: submission.csv",
    "        artifact_kind: table",
    "      metric:",
    `        name: ${FROZEN_METRIC}`,
    "        type: benchmark",
    "        lower_is_better: false",
    "    lnr:",
    "      num_workers: 1",
    "      wall_clock_budget_sec: 600",
    "",
  ].join("\n");
  await writeFile(resolve(root, "manifest-first.yaml"), manifest("sf-compat-first"));
  await writeFile(resolve(root, "manifest-second.yaml"), manifest("sf-compat-second"));
  await writeFile(resolve(root, "manifest-third.yaml"), manifest("sf-compat-third"));
}

test("prepare_run parses without spawning and start_run keeps its detached launch", { timeout: 240_000 }, async (context) => {
  if (await requiresEngine(context)) return;
  const root = await mkdtemp(resolve(tmpdir(), "engine-compatibility-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await compatibilityFixture(root);
  const result = spawnSync(ENGINE_PYTHON!, ["-I", "-B", "-c", COMPATIBILITY, ENGINE!, root], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONNOUSERSITE: "1", XDG_STATE_HOME: resolve(root, "state") },
    timeout: 120_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    duplicate: string | null;
    first: { attempt: number; has_pid: boolean; manifest_exists: boolean; status: string; token_length: number };
    reopened_attempt: number;
    reopened_has_pid: boolean;
    spawned: Array<{ argv: string[]; close_fds: boolean; cwd: string; start_new_session: boolean }>;
    started: { attempt: number; has_pid: boolean; log: string; status: string; token: string };
    run_id: string;
  };
  // Normal parsing and arming, with no process: the record and its per-attempt
  // manifest are the whole result of prepare_run().
  assert.equal(answer.first.attempt, 1);
  assert.equal(answer.first.has_pid, false);
  assert.equal(answer.first.manifest_exists, true);
  assert.equal(answer.first.status, "starting");
  assert.equal(answer.first.token_length, 32);
  // A duplicate run identity is refused, and the refusal released its locks.
  assert.match(answer.duplicate ?? "", /Run ID already exists/u);
  assert.equal(answer.reopened_attempt, 1);
  assert.equal(answer.reopened_has_pid, false);
  // The old start path still launches the detached supervisor, unchanged.
  assert.equal(answer.spawned.length, 1);
  const spawned = answer.spawned[0]!;
  assert.equal(spawned.start_new_session, true);
  assert.equal(spawned.close_fds, true);
  assert.equal(spawned.cwd, root);
  assert.deepEqual(spawned.argv.slice(1), ["-m", "scienceflow.runtime.parallel.control.worker",
    answer.run_id, answer.started.token]);
  assert.equal(answer.started.attempt, 1);
  assert.equal(answer.started.has_pid, true);
  assert.equal(answer.started.status, "starting");
  assert.equal(answer.started.log, resolve(root, "state/scienceflow/managed_runs", answer.run_id, "supervisor-1.log"));
  // Nothing was executed: the intercepted spawn is the only process fact.
  assert.equal(answer.spawned.length, 1);
});

before(async () => {
  // Building the prefix is expensive and shared; do it once, and let a missing
  // prerequisite stay a skip instead of a failure.
  await prerequisite();
});
