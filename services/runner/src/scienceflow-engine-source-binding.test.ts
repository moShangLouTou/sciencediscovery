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
 * The engine's source binding, proven in the lease that runs it.
 *
 * A production engine wiring names an administrator source binding, and the
 * spawn proves that this environment's interpreter resolves `scienceflow` from
 * that checkout at that revision. These cases build a controlled source mount
 * explicitly (a real Git checkout plus a copied interpreter prefix) and then
 * check both answers: a matching binding lets the engine start, and a missing,
 * unknown or non-resolving binding is a fixed refusal before any process.
 *
 * The assembly here is test-only by construction: production never copies an
 * interpreter, and its binding comes from the Runner's own configuration file.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ResearchRunRequest,
  type ResearchTimeSchedule,
} from "@sciencediscovery/schema";

import { createScienceFlowResearchRunExecutor as createResearchRunExecutor, type ScienceFlowEngineBinding as ResearchEngineBinding } from "./scienceflow-workload.js";
import { type ResearchRunWiring } from "./research-run.js";
import { pythonRequirementAllows, readRequiresPython } from "./scienceflow-runtime-check.js";
import type { EnvironmentRuntime } from "./environment-store.js";

// The fixture prefix copies a host interpreter the way the runtime-identity
// check's own fixtures do. It proves the binding path, not engine
// compatibility: the engine itself is not imported in these cases. The
// compliant interpreter is the one the engine's own `requires-python` allows;
// without it only the refusal paths can run here.
const PYTHON = process.env.SCIENCEFLOW_FIXTURE_PYTHON ?? "/usr/bin/python3";
const COMPLIANT_PYTHON = process.env.SCIENCEFLOW_TEST_PYTHON;
const REQUIRES_PYTHON = ">=3.11,<3.14";
const VERSION = "0.2.0";
const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 100, reportBudgetMs: 500, researchBudgetMs: 5_000,
  stopGraceMs: 100, verificationWindowMs: 1_000,
};

const INPUTS = (() => {
  const contractDigest = "a".repeat(64);
  const entries = [
    {
      content: [
        "max_concurrent: 1",
        "time_limit: 9000",
        "tasks:",
        "  - exp_id: probe",
        "defaults:",
        "  phase: run",
        "  type: lnr",
        "  workspace_base: /srv/workspaces",
        "",
      ].join("\n"),
      path: "manifest.yaml",
      roles: ["manifest"] as const,
    },
    {
      content: [
        "id: probe",
        "description: description.md",
        "artifact:",
        "  path: submission.csv",
        "metric:",
        "  name: probe_score",
        "  lower_is_better: false",
        "evaluator:",
        "  entrypoint: evaluate.py:main",
        "",
      ].join("\n"),
      path: "package/task.yaml",
      roles: ["task_yaml"] as const,
    },
    { content: "description\n", path: "package/description.md", roles: ["description"] as const },
    { content: "def main():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] as const },
    { content: "inputs:\n  required: false\n", path: "package/_shared/task_defaults.yaml", roles: ["shared_task_defaults"] as const },
  ];
  const files = entries.map((entry) => ({
    path: entry.path,
    roles: entry.roles,
    size: Buffer.byteLength(entry.content),
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  }));
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
})();

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(
  context: { after: (fn: () => Promise<void>) => void },
  python = PYTHON,
) {
  const root = await mkdtemp(resolve(tmpdir(), "engine-source-binding-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const checkout = resolve(root, "checkout");
  await mkdir(resolve(checkout, "scienceflow"), { recursive: true });
  await writeFile(resolve(checkout, "scienceflow/__init__.py"), 'raise RuntimeError("not a runnable engine")\n');
  await writeFile(
    resolve(checkout, "pyproject.toml"),
    `[project]\nname = "scienceflow"\nversion = "${VERSION}"\nrequires-python = "${REQUIRES_PYTHON}"\n`,
  );
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["add", "-A"]);
  git(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const revision = git(checkout, ["rev-parse", "HEAD"]);

  // A controlled environment prefix: a copied interpreter, its stdlib, one
  // `.pth` path line and the PyYAML package the bridge's derivation needs
  // before it imports the engine. This is the "controlled source mount"
  // assembly a test may build itself; production leases such an environment and
  // never copies one.
  const prefix = resolve(root, "prefix");
  const build = spawnSync(python, ["-I", "-B", "-c", `
import os, shutil, site, sys, sysconfig
prefix = ${JSON.stringify(prefix)}
source = ${JSON.stringify(checkout)}
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
try:
    import yaml
    yaml_dir = os.path.dirname(yaml.__file__)
except ImportError:
    yaml_dir = os.path.join(sysconfig.get_path("purelib"), "yaml")
if not os.path.isdir(yaml_dir):
    raise SystemExit("PyYAML is required for the engine bridge fixture")
shutil.copytree(yaml_dir, os.path.join(site_dir, "yaml"))
with open(os.path.join(site_dir, "scienceflow.pth"), "w") as handle:
    handle.write(source + "\\n")
print(".".join(version.split(".")) + " " + site_dir)
`], { encoding: "utf8" });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
  const [languageVersion, sitePackages] = build.stdout.trim().split(" ") as [string, string];
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
  return { checkout, dataDir, languageVersion, prefix, revision, root, runtime, sitePackages, workspace };
}

function request(id: string, workspace: string): ResearchRunRequest {
  return {
    agentId: "agent",
    environmentId: "environment",
    executionId: id,
    expectedEnvironmentRevisionId: "revision",
    inputs: { ...INPUTS.identity },
    kind: "research",
    permissionEpoch: { sessionId: "session" } as ResearchRunRequest["permissionEpoch"],
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    workload: "scienceflow-fixed",
    workspaceRoot: workspace,
  };
}

function wiring(
  f: Awaited<ReturnType<typeof fixture>>,
  engine: ResearchEngineBinding,
  bindings?: ResearchRunWiring["runtimeBindings"],
): ResearchRunWiring {
  return {
    config: {
      bwrapPath: "bwrap", dataDir: f.dataDir, execTimeoutMs: 30_000, maxOutputBytes: 65_536,
      maxWorkspaceBytes: 0, terminationGraceMs: 2_000,
    },
    engine,
    environmentStore: { withRuntime: async (_id, operation) => operation(f.runtime) },
    inputBundles: {
      hostRoots: () => [],
      snapshot: async () => ({ contents: INPUTS.contents, manifest: INPUTS.manifest }),
    },
    ...(bindings !== undefined ? { runtimeBindings: bindings } : {}),
  };
}

test("the engine's requires-python range is decided before the spawn", () => {
  const requirement = readRequiresPython('[project]\nname = "scienceflow"\nrequires-python = ">=3.11,<3.14"\n');
  assert.equal(requirement, REQUIRES_PYTHON);
  for (const version of ["3.11.0", "3.12.12", "3.13.9"]) {
    assert.equal(pythonRequirementAllows(requirement!, version), true, version);
  }
  for (const version of ["3.10.12", "3.14.0", "4.0.0"]) {
    assert.equal(pythonRequirementAllows(requirement!, version), false, version);
  }
  // A specifier this Runner does not evaluate is never treated as satisfied.
  assert.equal(pythonRequirementAllows("!=3.13", "3.12.0"), null);
  assert.equal(pythonRequirementAllows(">=3.11", "3.14.0"), true);
  for (const [range, version] of [
    ["~=3.11", "3.12.1"],
    ["~=3.11.5", "3.11.0"],
    ["~=3.11.5", "3.12.0"],
    ["==3.11", "3.11.9"],
    ["==3.12.1", "3.12.1"],
    [">=3.11,~=3.11.5", "3.12.0"],
  ] as const) {
    assert.equal(pythonRequirementAllows(range, version), null, `${range}: ${version}`);
  }
  // Only one plain declaration in `[project]` is a contract.
  assert.equal(readRequiresPython('[project]\nrequires-python = ">=3.11"\nrequires-python = ">=3.12"\n'), null);
  assert.equal(readRequiresPython('[tool.other]\nrequires-python = ">=3.11,<3.14"\n'), null);
});

test("a matching source binding is proven in the lease and the engine starts", async (context) => {
  if (COMPLIANT_PYTHON === undefined) {
    context.skip?.("SCIENCEFLOW_TEST_PYTHON does not name an interpreter inside the engine's range");
    return;
  }
  const f = await fixture(context, COMPLIANT_PYTHON);
  const engine = { revision: f.revision, runtimeBindingId: "binding", sourceRoot: f.checkout, version: VERSION };
  const executor = createResearchRunExecutor(wiring(
    f,
    engine,
    { bindingFor: (id) => id === "binding" ? { bindingId: id, expectedRevision: f.revision, sourceRoot: f.checkout } : undefined },
  ));
  const outcome = await executor.run(request("bound", f.workspace), { signal: new AbortController().signal });
  // The proof passed, so the bridge really was launched: the fixture engine
  // raises on import and leaves no record, which is `unknown`, never a refusal.
  assert.equal(typeof outcome.research.spawnedAt, "string", JSON.stringify(outcome.research));
  assert.notEqual(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
  assert.notEqual(outcome.research.refusal, "RESEARCH_ENGINE_NOT_CONFIGURED");
  assert.equal(outcome.research.process, "unverified");
  assert.equal(outcome.research.outcome, "unknown");
});

test("an interpreter outside the engine's declared range is refused before spawn", async (context) => {
  const f = await fixture(context);
  const [major, minor] = f.languageVersion.split(".").map(Number) as [number, number];
  if (major === 3 && minor >= 11 && minor < 14) {
    context.skip?.(`the fixture interpreter ${f.languageVersion} is inside the engine's declared range`);
    return;
  }
  const engine = { revision: f.revision, runtimeBindingId: "binding", sourceRoot: f.checkout, version: VERSION };
  const executor = createResearchRunExecutor(wiring(
    f,
    engine,
    { bindingFor: (id) => ({ bindingId: id, expectedRevision: f.revision, sourceRoot: f.checkout }) },
  ));
  const outcome = await executor.run(request("python-range", f.workspace), { signal: new AbortController().signal });
  // The source binding and revision are fine; the interpreter is not in the
  // contract the checkout declares, so no research process may exist.
  assert.equal(outcome.research.process, "not_started", JSON.stringify(outcome.research));
  assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
  assert.equal(outcome.research.spawnedAt, undefined);
  await assert.rejects(stat(resolve(f.dataDir, "runner-research-engine")));
});

test("a production engine without a source binding is refused before spawn", async (context) => {
  const f = await fixture(context);
  const engine = { revision: f.revision, sourceRoot: f.checkout, version: VERSION };
  const executor = createResearchRunExecutor(wiring(f, engine));
  const outcome = await executor.run(request("unbound", f.workspace), { signal: new AbortController().signal });
  assert.equal(outcome.research.process, "not_started");
  assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_NOT_CONFIGURED");
  assert.equal(outcome.research.spawnedAt, undefined);
  await assert.rejects(stat(resolve(f.dataDir, "runner-research-engine")));
});

test("a binding that names another checkout or revision is refused before spawn", async (context) => {
  const f = await fixture(context);
  const engine = { revision: f.revision, runtimeBindingId: "binding", sourceRoot: f.checkout, version: VERSION };
  const cases: ResearchRunWiring["runtimeBindings"][] = [
    undefined,
    { bindingFor: () => undefined },
    { bindingFor: (id) => ({ bindingId: id, expectedRevision: "f".repeat(40), sourceRoot: f.checkout }) },
    { bindingFor: (id) => ({ bindingId: id, expectedRevision: f.revision, sourceRoot: resolve(f.root, "elsewhere") }) },
  ];
  for (const bindings of cases) {
    const executor = createResearchRunExecutor(wiring(f, engine, bindings));
    const outcome = await executor.run(request("mismatch", f.workspace), { signal: new AbortController().signal });
    assert.equal(outcome.research.process, "not_started", JSON.stringify(bindings));
    assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
    assert.equal(outcome.research.spawnedAt, undefined);
  }
});

test("an interpreter that resolves another copy of the package is refused", async (context) => {
  if (COMPLIANT_PYTHON === undefined) {
    context.skip?.("SCIENCEFLOW_TEST_PYTHON does not name an interpreter inside the engine's range");
    return;
  }
  const f = await fixture(context, COMPLIANT_PYTHON);
  // The binding is well formed, but the environment's `.pth` points somewhere
  // that is not the trusted checkout: the static proof must see that and
  // refuse instead of accepting the configured path on faith.
  const elsewhere = resolve(f.root, "shadow");
  await mkdir(resolve(elsewhere, "scienceflow"), { recursive: true });
  await writeFile(resolve(elsewhere, "scienceflow/__init__.py"), "SHADOW = 1\n");
  const pth = resolve(f.sitePackages, "scienceflow.pth");
  await writeFile(pth, `${elsewhere}\n`);
  const engine = { revision: f.revision, runtimeBindingId: "binding", sourceRoot: f.checkout, version: VERSION };
  const executor = createResearchRunExecutor(wiring(
    f,
    engine,
    { bindingFor: (id) => ({ bindingId: id, expectedRevision: f.revision, sourceRoot: f.checkout }) },
  ));
  const outcome = await executor.run(request("shadow", f.workspace), { signal: new AbortController().signal });
  assert.equal(outcome.research.process, "not_started");
  assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
  assert.equal(outcome.research.spawnedAt, undefined);
});
