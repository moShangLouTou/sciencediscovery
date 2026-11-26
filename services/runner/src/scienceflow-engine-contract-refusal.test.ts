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
 * What the Runner does with the bridge's two pre-run protocol records.
 *
 * The bridge judges the frozen contract before it imports the engine, so the
 * refusal path can be proven through the real research executor, the real
 * sandbox and the real manager on a checkout without the engine's third-party
 * dependencies. A validated, execution-bound refusal is a definite `failed`
 * result with its fixed code; a run that started but never named the engine run
 * it created is `unknown` with every fence kept. The two states are mutually
 * exclusive, and this file checks both ends of that exclusivity.
 *
 * The assembly is test-only by construction: `SCIENCEFLOW_ENGINE_CHECKOUT`
 * names the pinned checkout and `SCIENCEFLOW_TEST_PYTHON` an interpreter inside
 * the engine's own `requires-python` range with PyYAML. The fixture copies that
 * interpreter into a prefix and links the checkout through one `.pth`, which is
 * the same shape the source-binding check reconstructs. Production leases such
 * an environment and never copies one.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ManagedExecution,
  type ResearchRunRequest,
  type ResearchTimeSchedule,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowInputFileRole,
} from "@sciencediscovery/schema";

import { ExecutionManager } from "./execution-manager.js";
import { researchEngineStateRoot } from "./scienceflow-engine-bridge.js";
import { createScienceFlowResearchRunExecutor as createResearchRunExecutor, type ScienceFlowResearchRunWiring as ResearchRunWiring } from "./scienceflow-workload.js";
import { researchInputRoot } from "./research-run.js";
import type { EnvironmentRuntime } from "./environment-store.js";

const ENGINE = process.env.SCIENCEFLOW_ENGINE_CHECKOUT;
const PYTHON = process.env.SCIENCEFLOW_TEST_PYTHON;
const VERSION = "0.2.0";
const OWNER = { agentId: "agent", sessionId: "session" } as const;
const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 100, reportBudgetMs: 500, researchBudgetMs: 5_000,
  stopGraceMs: 100, verificationWindowMs: 1_000,
};

function requiresFixture(context: { skip?: (message?: string) => void }): boolean {
  if (ENGINE !== undefined && PYTHON !== undefined) return false;
  context.skip?.("SCIENCEFLOW_ENGINE_CHECKOUT and SCIENCEFLOW_TEST_PYTHON must name the patched checkout and a compliant interpreter");
  return true;
}

interface Entry {
  readonly path: string;
  readonly roles: readonly ScienceFlowInputFileRole[];
  readonly content: string;
}

/** A frozen contract the bridge supports; `dataset` adds the refused binding. */
function frozenContract(options: { readonly dataset?: boolean } = {}): Entry[] {
  const manifest = [
    "max_concurrent: 1",
    "time_limit: 9000",
    "tasks:",
    "  - exp_id: alpha",
    ...(options.dataset ? ["    data_dir: /srv/data"] : []),
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
    {
      content: [
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
        "evaluator:",
        "  entrypoint: evaluate.py:main",
        "  timeout_sec: 30",
        "",
      ].join("\n"),
      path: "package/task.yaml",
      roles: ["task_yaml"],
    },
    { content: "Solve the frozen task and submit the table.\n", path: "package/description.md", roles: ["description"] },
    { content: "def main():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] },
    { content: "inputs:\n  required: false\n", path: "package/_shared/task_defaults.yaml", roles: ["shared_task_defaults"] },
  ];
}

function bundle(entries: readonly Entry[]): {
  readonly identity: { contractDigest: string; bundleDigest: string };
  readonly manifest: ScienceFlowInputBundleManifest;
  readonly contents: Map<string, Buffer>;
} {
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
    identity: { bundleDigest, contractDigest },
    manifest,
    contents: new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content)])),
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * Build the controlled environment prefix and the engine checkout the spawn
 * proves. Without `stubEngine` the checkout is the pinned one, referenced in
 * place (never copied or written); with it, a minimal Git checkout provides
 * exactly the two control modules the bridge imports, so `prepare_run` can
 * fail after the derivation and leave a terminal record without an engine link.
 */
async function fixture(
  context: { after: (fn: () => Promise<void>) => void },
  options: { readonly stubEngine?: boolean } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "engine-contract-refusal-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  let source = ENGINE!;
  if (options.stubEngine === true) {
    source = resolve(root, "stub-checkout");
    await mkdir(resolve(source, "scienceflow/runtime/parallel/control"), { recursive: true });
    for (const init of [
      "scienceflow/__init__.py",
      "scienceflow/runtime/__init__.py",
      "scienceflow/runtime/parallel/__init__.py",
      "scienceflow/runtime/parallel/control/__init__.py",
    ]) {
      await writeFile(resolve(source, init), "");
    }
    await writeFile(
      resolve(source, "scienceflow/runtime/parallel/control/worker.py"),
      "run_manifest = None\n"
        + "async def supervise(run_id, token, **options):\n"
        + "    raise AssertionError('the stub supervisor must never run')\n",
    );
    await writeFile(
      resolve(source, "scienceflow/runtime/parallel/control/service.py"),
      "def prepare_run(manifest):\n"
        + "    raise RuntimeError('stub prepare_run')\n",
    );
    await writeFile(
      resolve(source, "pyproject.toml"),
      '[project]\nname = "scienceflow"\nversion = "0.2.0"\nrequires-python = ">=3.11,<3.14"\n',
    );
    git(source, ["init", "--quiet"]);
    git(source, ["add", "-A"]);
    git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "stub"]);
  }
  const revision = git(source, ["rev-parse", "HEAD"]);
  const prefix = resolve(root, "prefix");
  const build = spawnSync(PYTHON!, ["-I", "-B", "-c", `
import os, shutil, sys, sysconfig
prefix = ${JSON.stringify(prefix)}
source = ${JSON.stringify(source)}
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
        os.symlink(source_entry, target_entry)
    elif os.path.isdir(source_entry) and not os.path.islink(source_entry):
        shutil.copytree(source_entry, target_entry, symlinks=True)
    else:
        shutil.copy2(source_entry, target_entry, follow_symlinks=False)
# The bridge derives the launch manifest with PyYAML before it imports the
# engine; the fixture prefix needs that one package for the derivation itself.
import site
site_dir = os.path.join(lib, os.path.basename(site.getsitepackages()[0]))
os.makedirs(site_dir)
try:
    import yaml
    yaml_dir = os.path.dirname(yaml.__file__)
except ImportError:
    yaml_dir = os.path.join(sysconfig.get_path("purelib"), "yaml")
if not os.path.isdir(yaml_dir):
    raise SystemExit("PyYAML is required for the contract-refusal fixture")
shutil.copytree(yaml_dir, os.path.join(site_dir, "yaml"))
with open(os.path.join(site_dir, "scienceflow.pth"), "w") as handle:
    handle.write(source + "\\n")
print(version)
`], { encoding: "utf8" });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
  const languageVersion = build.stdout.trim();
  const dataDir = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const runtime: EnvironmentRuntime = {
    environment: {
      createdAt: "now", currentRevisionId: "revision", id: "environment",
      kind: "task", language: "python", name: "fixture", updatedAt: "now",
    },
    interpreterPath: resolve(prefix, "bin/python"),
    prefixPath: prefix,
    revision: {
      channels: [], createdAt: "now", environmentId: "environment", id: "revision",
      language: "python", languageVersion, packageSpecHash: "fixture", packages: [],
      platform: "linux", provisioner: "fixture", runnerVersion: "fixture",
      snapshot: { hash: "fixture", size: 0 },
    },
  };
  return { dataDir, revision, root, runtime, source, workspace };
}

function request(id: string, workspace: string, identity: { contractDigest: string; bundleDigest: string }): ResearchRunRequest {
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

function wiring(
  f: Awaited<ReturnType<typeof fixture>>,
  contents: ReturnType<typeof bundle>,
): ResearchRunWiring {
  return {
    config: {
      bwrapPath: "bwrap", dataDir: f.dataDir, execTimeoutMs: 30_000, maxOutputBytes: 65_536,
      maxWorkspaceBytes: 0, terminationGraceMs: 2_000,
    },
    engine: { revision: f.revision, runtimeBindingId: "binding", sourceRoot: f.source, version: VERSION },
    environmentStore: { withRuntime: async (_id, operation) => operation(f.runtime) },
    inputBundles: {
      hostRoots: () => [],
      snapshot: async () => ({ contents: contents.contents, manifest: contents.manifest }),
    },
    runtimeBindings: {
      bindingFor: (id) => id === "binding"
        ? { bindingId: id, expectedRevision: f.revision, sourceRoot: f.source }
        : undefined,
    },
  };
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("execution did not reach the expected state");
    await new Promise((done) => setTimeout(done, 10));
  }
}

function settled(record: ManagedExecution): boolean {
  return record.state !== "queued" && record.state !== "running";
}

test("a validated contract refusal is a definite failed result and releases its resources", async (context) => {
  if (requiresFixture(context)) return;
  const f = await fixture(context);
  const inputs = bundle(frozenContract({ dataset: true }));
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  manager.submitResearch(request("contract-refused", f.workspace, inputs.identity));
  await until(() => settled(manager.get("contract-refused", OWNER)));
  const record = manager.get("contract-refused", OWNER);
  // The bridge refused before prepare_run, so there is no engine run at all.
  // The refusal is still a positive, bound answer about this execution.
  assert.equal(record.state, "failed", JSON.stringify(record.research));
  assert.equal(record.research?.process, "spawned-then-terminated");
  assert.equal(record.research?.refusal, "RESEARCH_ENGINE_CONTRACT_UNSUPPORTED");
  assert.equal(record.research?.outcome, "failed");
  assert.equal(record.research?.report, "failed");
  assert.match(record.error ?? "", /outside the single-task, dataset-free subset/u);
  assert.equal(record.evidence?.processTerminated, true);
  // The refusal record itself names this execution and the fixed reason; the
  // Runner read the same file it reports.
  const engineRoot = researchEngineStateRoot(f.dataDir, "contract-refused");
  const refusal = JSON.parse(await readFile(resolve(engineRoot, "contract.refused"), "utf8")) as {
    code: string; execution: string; reason: string; version: number;
  };
  assert.deepEqual(refusal, {
    code: "unsupported", execution: "contract-refused", reason: "manifest-dataset", version: 1,
  });
  // Resources: the private input copy is released once termination is proven,
  // and the workspace fence is gone, so the same workspace accepts the next
  // execution instead of staying quarantined.
  await assert.rejects(stat(researchInputRoot(f.dataDir, "contract-refused")));
  manager.submitResearch(request("after-refusal", f.workspace, inputs.identity));
  await until(() => settled(manager.get("after-refusal", OWNER)));
  assert.equal(manager.get("after-refusal", OWNER).research?.refusal, "RESEARCH_ENGINE_CONTRACT_UNSUPPORTED");
});

test("a run that starts without naming its engine run stays unknown with its fences", async (context) => {
  if (PYTHON === undefined) {
    context.skip?.("SCIENCEFLOW_TEST_PYTHON must name a compliant interpreter");
    return;
  }
  // The stub checkout provides exactly the two control modules the bridge
  // imports, so the derivation succeeds and `prepare_run` fails after it. That
  // is the protocol shape under test: a process that started, wrote a terminal
  // record and never named an engine run. The engine's own dependency graph is
  // not involved, and this assembly exists only in this test.
  const f = await fixture(context, { stubEngine: true });
  const inputs = bundle(frozenContract());
  const manager = new ExecutionManager(f.dataDir, undefined, {
    research: createResearchRunExecutor(wiring(f, inputs)),
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
  });
  manager.submitResearch(request("missing-link", f.workspace, inputs.identity));
  await until(() => settled(manager.get("missing-link", OWNER)));
  const record = manager.get("missing-link", OWNER);
  assert.equal(record.state, "unknown", JSON.stringify(record.research));
  assert.equal(record.research?.refusal, "RESEARCH_ENGINE_IDENTITY_MISMATCH");
  assert.equal(record.research?.outcome, "unknown");
  assert.equal(record.research?.phase, "unknown");
  assert.equal(record.result, undefined);
  // The unproven association keeps the workspace fence: a new execution on the
  // same workspace is refused instead of running beside an unvouched process.
  assert.throws(
    () => manager.submitResearch(request("after-missing", f.workspace, inputs.identity)),
    (error: unknown) => (error as { code?: string }).code === "EXECUTION_RESOURCE_QUARANTINED",
  );
});
