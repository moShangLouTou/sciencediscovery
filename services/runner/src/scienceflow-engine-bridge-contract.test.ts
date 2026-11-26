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
 * The bridge's derivation and callbacks, run against the real engine code.
 *
 * These cases execute the exact program text the sandbox runs. They import it
 * as a module (its trailing `__main__` guard keeps execution out of import),
 * drive `build_launch_manifest()` over a frozen input tree, and hand the result
 * to the engine's own `report_budget`, `load_task_package` and
 * `find_task_package`. One case also runs the engine's real `worker.supervise`
 * with the bridge's own `ready` callback.
 *
 * `SCIENCEFLOW_ENGINE_CHECKOUT` names a checkout of the patched engine and
 * `SCIENCEFLOW_TEST_PYTHON` the compliant interpreter that can import it
 * (>= 3.11 and < 3.14, with `psutil` and `PyYAML`). Without the checkout the
 * engine-backed cases are skipped: a synthetic substitute would prove nothing
 * about the real contract.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  SCIENCEFLOW_ENGINE_BRIDGE_SOURCE,
  SCIENCEFLOW_LAUNCH_MAPPING_VERSION,
} from "./scienceflow-engine-bridge.js";

const ENGINE = process.env.SCIENCEFLOW_ENGINE_CHECKOUT;
const PYTHON = process.env.SCIENCEFLOW_TEST_PYTHON ?? "python3";
const REVISION = "e".repeat(40);
const VERSION = "0.2.0";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface Entry {
  readonly path: string;
  readonly roles: readonly string[];
  readonly content: string;
}

/** A frozen contract in the shape the API's execution-contract builder emits. */
function frozenContract(overrides: {
  readonly manifest?: string;
  readonly taskYaml?: string;
} = {}): Entry[] {
  const manifest = overrides.manifest ?? [
    "max_concurrent: 1",
    "time_limit: 9000",
    "tasks:",
    "  - exp_id: alpha",
    "    time_limit: 7200",
    "    lnr:",
    "      wall_clock_budget_sec: 6000",
    "defaults:",
    "  phase: run",
    "  type: lnr",
    "  workspace_base: /srv/workspaces",
    "",
  ].join("\n");
  const taskYaml = overrides.taskYaml ?? [
    "id: alpha",
    "category: benchmarks",
    "profile: artifact_solver",
    "description: description.md",
    "artifact:",
    "  path: submission.csv",
    "  kind: table",
    "metric:",
    "  name: frozen_score",
    "  lower_is_better: false",
    "  type: benchmark",
    "evaluator:",
    "  entrypoint: evaluate.py:main",
    "  timeout_sec: 120",
    "",
  ].join("\n");
  return [
    { content: manifest, path: "manifest.yaml", roles: ["manifest"] },
    { content: taskYaml, path: "package/task.yaml", roles: ["task_yaml"] },
    { content: "Solve the frozen task and submit the table.\n", path: "package/description.md", roles: ["description"] },
    { content: "def main():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] },
    { content: "inputs:\n  required: false\n", path: "package/_shared/task_defaults.yaml", roles: ["shared_task_defaults"] },
  ];
}

function indexOf(entries: readonly Entry[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    contractDigest: "a".repeat(64),
    bundleDigest: "b".repeat(64),
    files: entries.map((entry) => ({
      path: entry.path,
      roles: [...entry.roles],
      size: Buffer.byteLength(entry.content),
      sha256: sha256(entry.content),
    })),
  });
}

interface Scratch {
  readonly root: string;
  readonly inputs: string;
  readonly control: string;
  readonly engineState: string;
  readonly engine: string;
  readonly bridge: string;
  readonly index: string;
  readonly workspace: string;
}

async function scratch(label: string, entries: readonly Entry[], options: {
  readonly sameNamedEngineTask?: boolean;
} = {}): Promise<Scratch> {
  const root = await mkdtemp(resolve(tmpdir(), `bridge-contract-${label}-`));
  const inputs = resolve(root, "inputs");
  const control = resolve(root, "control");
  const engineState = resolve(root, "engine-state");
  const engine = resolve(root, "engine");
  const workspace = resolve(root, "workspace");
  for (const directory of [control, engineState, engine, workspace]) {
    await mkdir(directory, { recursive: true });
  }
  for (const entry of entries) {
    const target = resolve(inputs, entry.path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, entry.content);
  }
  // A minimal engine package: enough for `engine_version()` and to host a
  // poisoned same-named task; the bridge never imports it in the derivation.
  await writeFile(resolve(engine, "pyproject.toml"), '[project]\nname = "scienceflow"\nversion = "0.2.0"\n');
  if (options.sameNamedEngineTask) {
    const task = resolve(engine, "tasks", "benchmarks", "alpha");
    await mkdir(task, { recursive: true });
    await writeFile(resolve(task, "task.yaml"), [
      "id: alpha",
      "metric:",
      "  name: engine_poisoned_score",
      "  lower_is_better: true",
      "artifact:",
      "  path: engine_poisoned.csv",
      "evaluator:",
      "  entrypoint: poisoned.py:main",
      "description: poisoned.md",
      "",
    ].join("\n"));
    await writeFile(resolve(task, "description.md"), "engine description\n");
    await writeFile(resolve(task, "poisoned.py"), "def main():\n    return 0\n");
  }
  const bridge = resolve(root, "bridge.py");
  await writeFile(bridge, SCIENCEFLOW_ENGINE_BRIDGE_SOURCE);
  return { bridge, control, engine, engineState, index: indexOf(entries), inputs, root, workspace };
}

/** The bridge's own argv layout, preceded by nothing: argv[0] is the program. */
function bridgeArgs(scenario: Scratch, extra: readonly string[] = []): string[] {
  return [
    scenario.bridge, scenario.control, "run-contract",
    scenario.inputs, scenario.index, scenario.engine, scenario.engineState,
    REVISION, VERSION, JSON.stringify({ reportBudgetMs: 2_000, researchBudgetMs: 30_000 }),
    ...extra,
  ];
}

function runPython(script: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(PYTHON, ["-I", "-B", "-c", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: ENGINE ?? "", PYTHONNOUSERSITE: "1", ...env },
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function requiresEngine(context: { skip?: (message?: string) => void }): boolean {
  if (ENGINE !== undefined) return false;
  context.skip?.("SCIENCEFLOW_ENGINE_CHECKOUT does not name the patched engine checkout");
  return true;
}

const DERIVE = String.raw`
import json, os, sys
argv = sys.argv[1:]
sys.argv = argv
# The interpreter runs isolated, like the sandbox: the engine is reached
# through the pinned checkout path, never through PYTHONPATH.
sys.path.insert(0, os.environ["SCIENCEFLOW_ENGINE_CHECKOUT"])
import importlib.util
spec = importlib.util.spec_from_file_location("bridge", argv[0])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target, run_id, digest = module.build_launch_manifest()
from pathlib import Path
from scienceflow.runtime.parallel.control.reporting import report_budget
from scienceflow.runtime.task_package import find_task_package, load_task_package
import yaml
payload = yaml.safe_load(target.read_text(encoding="utf-8"))
task = payload["tasks"][0]
spec = load_task_package(Path(task["evaluator"]["package_source"]))
fixture_tasks = Path(argv[5]) / "tasks"
print(json.dumps({
    "budget": report_budget(payload),
    "budget_nested": "report_budget_sec" in (payload.get("defaults") or {}),
    "digest": digest,
    "launch_exp_id": task["exp_id"],
    "package_source_inside_state": task["evaluator"]["package_source"].startswith(argv[6]),
    "package": {
        "id": spec.task_id,
        "metric": spec.metric_name,
        "entrypoint": spec.evaluator_entrypoint,
    },
    "same_named_task": find_task_package(task["exp_id"], tasks_root=fixture_tasks) is not None,
    "frozen_task_present": find_task_package("alpha", tasks_root=fixture_tasks) is not None,
    "payload": payload,
}))
`;

test("the derived manifest carries the frozen contract and a top-level report budget", async (context) => {
  if (requiresEngine(context)) return;
  const scenario = await scratch("derive", frozenContract(), { sameNamedEngineTask: true });
  context.after(() => rm(scenario.root, { force: true, recursive: true }));
  const result = runPython(DERIVE, bridgeArgs(scenario));
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout) as {
    budget: number;
    budget_nested: boolean;
    digest: string;
    launch_exp_id: string;
    package_source_inside_state: boolean;
    package: { id: string; metric: string; entrypoint: string };
    same_named_task: boolean;
    frozen_task_present: boolean;
    payload: Record<string, any>;
  };
  // The engine reads `report_budget_sec` from the manifest top level only; a
  // nested value would silently become the 300 s default.
  assert.equal(answer.budget, 2);
  assert.equal(answer.budget_nested, false);
  assert.equal(answer.digest.length, 64);
  // The engine resolves the relocated frozen package, not its own same-named
  // task: the package id, metric and entrypoint are the frozen ones.
  assert.deepEqual(answer.package, { entrypoint: "evaluate.py:main", id: "alpha", metric: "frozen_score" });
  assert.equal(answer.package_source_inside_state, true);
  assert.equal(answer.same_named_task, false, "the launch identity must not resolve an engine task by name");
  assert.equal(answer.frozen_task_present, true, "the fixture's same-named task must be discoverable, or the check proves nothing");
  assert.notEqual(answer.launch_exp_id, "alpha");
  const task = (answer.payload.tasks as Record<string, any>[])[0]!;
  assert.equal(task.task, "Solve the frozen task and submit the table.\n");
  assert.equal(task.workspace, "/workspace");
  assert.equal(task.type, "lnr");
  assert.equal(task.time_limit, 7200);
  assert.equal(task.lnr.wall_clock_budget_sec, 6000);
  assert.deepEqual(task.evaluator.metric, { lower_is_better: false, name: "frozen_score", type: "benchmark" });
  assert.deepEqual(task.evaluator.candidate, { artifact: "submission.csv", artifact_kind: "table" });
  assert.equal(task.evaluator.backend, "task_package");
  assert.equal(answer.payload.max_concurrent, 1);
  // The frozen bytes are relocated verbatim; nothing is re-encoded.
  const relocated = resolve(task.evaluator.package_source as string);
  const frozen = frozenContract();
  const content = (path: string) => frozen.find((entry) => entry.path === path)!.content;
  assert.equal(await readFile(resolve(relocated, "evaluate.py"), "utf8"), content("package/evaluate.py"));
  assert.equal(await readFile(resolve(relocated, "task.yaml"), "utf8"), content("package/task.yaml"));
  assert.equal(await readFile(resolve(relocated, "description.md"), "utf8"), content("package/description.md"));
  assert.equal(
    await readFile(resolve(relocated, "..", "_shared", "task_defaults.yaml"), "utf8"),
    content("package/_shared/task_defaults.yaml"),
  );
});

test("the report budget keeps a sub-second value instead of falling back", async (context) => {
  if (requiresEngine(context)) return;
  const scenario = await scratch("budget", frozenContract());
  context.after(() => rm(scenario.root, { force: true, recursive: true }));
  const args = bridgeArgs(scenario);
  args[9] = JSON.stringify({ reportBudgetMs: 500, researchBudgetMs: 30_000 });
  const result = runPython(DERIVE, args);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout) as { budget: number };
  assert.equal(answer.budget, 0.5, "a sub-second budget is passed through, not clamped or ignored");
});

const REFUSE = String.raw`
import importlib.util, json, sys
argv = sys.argv[1:]
sys.argv = argv
spec = importlib.util.spec_from_file_location("bridge", argv[0])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    module.build_launch_manifest()
except SystemExit:
    pass
print(json.dumps({
    "refusal": json.loads(module.REFUSED.read_text(encoding="utf-8")),
    "status": json.loads((module.CONTROL / "status").read_text(encoding="utf-8")),
}))
`;

test("a frozen contract outside the single-task subset is refused, never reduced", async (context) => {
  if (requiresEngine(context)) return;
  const cases: { label: string; entries: readonly Entry[]; reason: string }[] = [
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n  - exp_id: beta\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "two-tasks",
      reason: "manifest-task-count",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    input_data_dir: /srv/data\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "task-dataset",
      reason: "manifest-dataset",
    },
    {
      // The same binding under its legacy alias, at the task level.
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    data_dir: /srv/data\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "task-dataset-alias",
      reason: "manifest-dataset",
    },
    {
      // And at the defaults level, under both names: the engine reads all four
      // positions, so a bridge that only checked the task key would silently
      // run without the data the contract named.
      entries: frozenContract({
        manifest: "defaults:\n  input_data_dir: /srv/data\n  workspace_base: /srv\ntasks:\n  - exp_id: alpha\n",
      }),
      label: "defaults-dataset",
      reason: "manifest-dataset",
    },
    {
      entries: frozenContract({
        manifest: "defaults:\n  data_dir: /srv/data\n  workspace_base: /srv\ntasks:\n  - exp_id: alpha\n",
      }),
      label: "defaults-dataset-alias",
      reason: "manifest-dataset",
    },
    {
      entries: frozenContract({
        manifest: "config: shared.yaml\ntasks:\n  - exp_id: alpha\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "include",
      reason: "manifest-include",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    config: other.yaml\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "task-include",
      reason: "manifest-include",
    },
    {
      entries: frozenContract({
        manifest:
          "tasks:\n  - exp_id: alpha\n    lnr:\n      num_workers: 4\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "workers",
      reason: "manifest-workers",
    },
    {
      entries: frozenContract({
        manifest:
          "tasks:\n  - exp_id: alpha\n    lnr:\n      max_steps: 10\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "lnr-unsupported",
      reason: "manifest-lnr",
    },
    {
      entries: frozenContract({
        manifest: "model: unsupported\ntasks:\n  - exp_id: alpha\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "unknown-root-key",
      reason: "manifest-key",
    },
    {
      entries: frozenContract({
        manifest: "defaults:\n  models: [a]\n  workspace_base: /srv\ntasks:\n  - exp_id: alpha\n",
      }),
      label: "model-gateway",
      reason: "manifest-key",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    task: inline text\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "inline-text",
      reason: "manifest-task-text",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    run_id: other\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "run-id",
      reason: "manifest-run-id",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    gpu_list: '0'\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "devices",
      reason: "manifest-devices",
    },
    {
      entries: frozenContract({
        manifest: "tasks:\n  - exp_id: alpha\n    num_drafts: 2\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "drafts",
      reason: "manifest-drafts",
    },
    {
      entries: frozenContract({
        manifest: "resume: true\ntasks:\n  - exp_id: alpha\ndefaults:\n  workspace_base: /srv\n",
      }),
      label: "resume",
      reason: "manifest-resume",
    },
    {
      // The engine never reads defaults.time_limit, and the frozen subset does
      // not carry it either; accepting it would imply a budget it does not set.
      entries: frozenContract({
        manifest: "defaults:\n  time_limit: 4000\n  workspace_base: /srv\ntasks:\n  - exp_id: alpha\n",
      }),
      label: "defaults-time-limit",
      reason: "manifest-key",
    },
    {
      entries: frozenContract({ manifest: "tasks:\n  - exp_id: alpha\n" }),
      label: "workspace-missing",
      reason: "manifest-workspace",
    },
    {
      entries: frozenContract({ taskYaml: "id: alpha\ndataset: kaggle\n" }),
      label: "task-package-dataset",
      reason: "task-key",
    },
    {
      entries: frozenContract({
        taskYaml:
          "id: alpha\ndescription: description.md\nartifact:\n  path: submission.csv\nmetric:\n  name: m\n  lower_is_better: false\nevaluator:\n  entrypoint: evaluate.py:main\ninputs:\n  required: false\n  path: /srv/data\n",
      }),
      label: "task-inputs-path",
      reason: "task-dataset",
    },
    {
      entries: frozenContract({
        taskYaml:
          "id: alpha\ndescription: description.md\nartifact:\n  path: submission.csv\nmetric:\n  name: m\n  lower_is_better: false\nevaluator:\n  entrypoint: evaluate.py:main\n  command: run.sh\n",
      }),
      label: "task-evaluator-command",
      reason: "task-evaluator",
    },
    {
      entries: frozenContract({
        taskYaml:
          "id: alpha\ndescription: description.md\nartifact:\n  path: submission.csv\nmetric:\n  name: m\n  lower_is_better: false\nevaluator:\n  entrypoint: evaluate.py:main\ngate:\n  policy: strict\n",
      }),
      label: "task-gate",
      reason: "task-evaluator",
    },
  ];
  for (const item of cases) {
    const scenario = await scratch(item.label, item.entries);
    context.after(() => rm(scenario.root, { force: true, recursive: true }));
    const result = runPython(REFUSE, bridgeArgs(scenario));
    assert.equal(result.status, 0, result.stderr);
    const answer = JSON.parse(result.stdout) as {
      refusal: { code: string; execution: string; reason: string; version: number };
      status: { outcome: string; phase: string; report: string };
    };
    assert.equal(answer.refusal.code, "unsupported", item.label);
    assert.equal(answer.refusal.execution, "run-contract", item.label);
    assert.equal(answer.refusal.version, 1);
    assert.equal(answer.refusal.reason, item.reason, item.label);
    // The run is terminated positively: a refused contract is a definite
    // failure, never a missing record the Runner would have to guess about.
    assert.equal(answer.status.outcome, "failed", item.label);
    assert.equal(answer.status.phase, "finished", item.label);
    assert.equal(answer.status.report, "failed", item.label);
  }
});

test("supported manifest fields keep the engine's own precedence", async (context) => {
  if (requiresEngine(context)) return;
  // lnr merges root < defaults < task, time_limit is task then root (the engine
  // never reads defaults.time_limit), and one worker stays one worker.
  const layered = await scratch("priority-layered", frozenContract({
    manifest: [
      "max_concurrent: 1",
      "time_limit: 9000",
      "lnr:",
      "  wall_clock_budget_sec: 100",
      "  num_workers: 1",
      "tasks:",
      "  - exp_id: alpha",
      "    time_limit: 7200",
      "    lnr:",
      "      wall_clock_budget_sec: 300",
      "defaults:",
      "  phase: run",
      "  type: lnr",
      "  workspace_base: /srv/workspaces",
      "  lnr:",
      "    wall_clock_budget_sec: 200",
      "",
    ].join("\n"),
  }));
  context.after(() => rm(layered.root, { force: true, recursive: true }));
  const layeredResult = runPython(DERIVE, bridgeArgs(layered));
  assert.equal(layeredResult.status, 0, layeredResult.stderr);
  const layeredAnswer = JSON.parse(layeredResult.stdout) as { payload: Record<string, any> };
  const layeredTask = (layeredAnswer.payload.tasks as Record<string, any>[])[0]!;
  assert.equal(layeredTask.time_limit, 7200, "the task time_limit wins over the root and defaults");
  assert.equal(layeredTask.lnr.wall_clock_budget_sec, 300, "task lnr wins over defaults and root");
  assert.equal(layeredTask.lnr.num_workers, 1);

  // Without a task value the root's budget applies, and a defaults lnr value
  // fills in exactly as the engine's own merge does.
  const rootOnly = await scratch("priority-root", frozenContract({
    manifest: [
      "time_limit: 9000",
      "tasks:",
      "  - exp_id: alpha",
      "defaults:",
      "  phase: run",
      "  type: lnr",
      "  workspace_base: /srv/workspaces",
      "  lnr:",
      "    wall_clock_budget_sec: 200",
      "",
    ].join("\n"),
  }));
  context.after(() => rm(rootOnly.root, { force: true, recursive: true }));
  const rootResult = runPython(DERIVE, bridgeArgs(rootOnly));
  assert.equal(rootResult.status, 0, rootResult.stderr);
  const rootAnswer = JSON.parse(rootResult.stdout) as { payload: Record<string, any> };
  const rootTask = (rootAnswer.payload.tasks as Record<string, any>[])[0]!;
  assert.equal(rootTask.time_limit, 9000);
  assert.equal(rootTask.lnr.wall_clock_budget_sec, 200, "defaults lnr applies when the task declares none");
});

const READY = String.raw`
import asyncio, json, os, sys, time
argv = sys.argv[1:]
sys.argv = argv
sys.path.insert(0, os.environ["SCIENCEFLOW_ENGINE_CHECKOUT"])
import importlib.util
spec = importlib.util.spec_from_file_location("bridge", argv[0])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from scienceflow.runtime.parallel.control import service, worker
from scienceflow.runtime.parallel.control import reporting
from scienceflow.runtime.parallel.control.registry import read_record, run_dir

async def finalize(record):
    return [{"status": "generation_failed"}], False
reporting.finalize_reports = finalize

workspace = argv[10]
writes = []
original_write = module.write
def recording_write(name, payload):
    writes.append(name)
    original_write(name, payload)
module.write = recording_write

called = []
async def research(manifest):
    called.append(manifest)
    class Summary:
        results = [type("R", (), {"status": "success"})()]
        text = "summary"
    return Summary()

async def supervise(run_id, stop):
    directory = run_dir(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    record = {
        "attempt": 0, "created_at": time.time(), "cwd": workspace, "draft": None,
        "manifest_payload": {"report_budget_sec": 5}, "run_id": run_id,
        "started_at": time.time(), "status": "starting", "task_roots": [workspace],
    }
    prepared = service._prepare_launch(directory, record, resume=False)
    await worker.supervise(run_id, prepared.launch_token, stop_event=stop,
                           on_ready=module.ready, research=research)
    return read_record(directory)

async def main():
    ready_stop = asyncio.Event()
    first = await supervise("bridge-ready", ready_stop)
    ready_writes = writes.count("ready")
    ready_file = (module.CONTROL / "ready").exists()
    writes.clear()
    pending_stop = asyncio.Event()
    pending_stop.set()
    second = await supervise("bridge-pending", pending_stop)
    print(json.dumps({
        "coroutine": asyncio.iscoroutinefunction(module.ready),
        "ready_writes": ready_writes,
        "ready_file": ready_file,
        "first": first,
        "pending": second,
        "pending_ready_writes": writes.count("ready"),
        "research_calls": len(called),
    }))

asyncio.run(main())
`;

test("the bridge's ready callback is synchronous and runs once under the real supervisor", async (context) => {
  if (requiresEngine(context)) return;
  const scenario = await scratch("ready", frozenContract());
  context.after(() => rm(scenario.root, { force: true, recursive: true }));
  const state = resolve(scenario.root, "state-home");
  await mkdir(state, { recursive: true });
  const result = runPython(
    READY,
    bridgeArgs(scenario, [scenario.workspace]),
    { XDG_STATE_HOME: state },
  );
  assert.equal(result.status, 0, result.stderr);
  // The supervisor's own progress lines share stdout; the answer is last.
  const answer = JSON.parse(result.stdout.trim().split("\n").pop()!) as {
    coroutine: boolean;
    ready_writes: number;
    ready_file: boolean;
    first: { research_status: string };
    pending: { research_status: string; status: string };
    pending_ready_writes: number;
    research_calls: number;
  };
  assert.equal(answer.coroutine, false, "the supervisor calls on_ready synchronously; the bridge must not hand it a coroutine");
  assert.equal(answer.ready_writes, 1, "readiness is stated exactly once");
  assert.equal(answer.ready_file, true);
  assert.equal(answer.first.research_status, "completed");
  // A stop that predates the supervisor is a correlated short-circuit: the
  // record says so positively and readiness is never announced.
  assert.equal(answer.pending.status, "stopped");
  assert.equal(answer.pending.research_status, "not-started");
  assert.equal(answer.pending_ready_writes, 0);
  assert.equal(answer.research_calls, 1, "the pending stop never reaches the research step");
});

test("the bridge mapping version is a Runner constant the link must repeat", () => {
  assert.equal(SCIENCEFLOW_LAUNCH_MAPPING_VERSION, 3);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /MAPPING_VERSION = 3/);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /"report_budget_sec": report_seconds/);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /if __name__ == "__main__":/);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /def ready\(\):/);
});
