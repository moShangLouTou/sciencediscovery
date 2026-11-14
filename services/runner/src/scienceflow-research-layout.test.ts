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
 * Stage C of the round-18 feasibility harness: proof S and proof R in one
 * lease, against the same pinned source.
 *
 * These cases are gated on `SCIENCEFLOW_TEST_ENGINE_PYTHON`, an interpreter that
 * satisfies the engine's `requires-python` and can import its runtime package
 * set. When it is absent the cases skip with that reason rather than pretending
 * a substitute environment is the engine.
 *
 * What they establish: S still passes on a correctly provisioned prefix whose
 * only binding is a path-only `.pth`, R then reaches that same checkout through
 * the fixed `/scienceflow-engine` mount with the run's own `-P -B` flags, a
 * decoy package in the writable workspace cannot replace the engine entry, and
 * the `.venv` mask decides which interpreter `resolve_project_python()` returns.
 * What they do not establish: a real managed start, a budget, or a gateway.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { after, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutorConfig } from "./executor.js";
import {
  prepareSandboxLaunch,
  RESEARCH_ENGINE_MOUNT,
  runSandboxed,
  workspaceBindArguments,
} from "./executor.js";
import { environmentPrefixBindArguments } from "./executor.js";
import type { EnvironmentRuntime } from "./environment-store.js";
import {
  runResearchLayoutProbe,
  type ResearchLayoutFacts,
} from "./scienceflow-research-layout.js";
import { verifyScienceFlowSourceBinding } from "./scienceflow-runtime-check.js";

const execFileAsync = promisify(execFile);

const ENGINE_CHECKOUT = process.env.SCIENCEFLOW_ENGINE_CHECKOUT
  ?? "/home/liyuan/sd-fork/sf-engine-r16";
const ENGINE_PYTHON = process.env.SCIENCEFLOW_TEST_ENGINE_PYTHON;
const BWRAP = process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap";

const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

async function scratchDirectory(prefix = "sciencediscovery-research-layout-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const IMPORT_PROBE = "import scienceflow.runtime.parallel.control, scienceflow.runtime.environment";

interface Prerequisite {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * One interpreter that can actually back the lease: the declared version range
 * and the engine's runtime import graph. Nothing is installed here.
 */
const prerequisite = (async (): Promise<Prerequisite> => {
  if (!ENGINE_PYTHON) {
    return { detail: "SCIENCEFLOW_TEST_ENGINE_PYTHON is not set", ok: false };
  }
  const version = spawnSync(ENGINE_PYTHON, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {
    encoding: "utf8",
  });
  if (version.status !== 0) return { detail: "the interpreter did not answer", ok: false };
  const [major, minor] = version.stdout.trim().split(".").map(Number);
  if (major !== 3 || (minor ?? 0) < 11) {
    return { detail: `the interpreter is ${version.stdout.trim()}, the engine needs >=3.11`, ok: false };
  }
  const probe = spawnSync(ENGINE_PYTHON, ["-P", "-B", "-c", IMPORT_PROBE], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: ENGINE_CHECKOUT, PYTHONNOUSERSITE: "1" },
    timeout: 120_000,
  });
  if (probe.status !== 0) {
    const last = (probe.stderr ?? "").trim().split("\n").at(-1) ?? "the engine import failed";
    return { detail: `the engine cannot be imported by that interpreter: ${last}`, ok: false };
  }
  return { detail: "ready", ok: true };
})();

async function requiresEngine(context: { skip?: (message?: string) => void }): Promise<boolean> {
  const result = await prerequisite;
  if (result.ok) return false;
  context.skip?.(result.detail);
  return true;
}

const PREFIX_BUILD = String.raw`
import json, os, shutil, site, sys, sysconfig
prefix = sys.argv[1]
source = sys.argv[2]
version = "%d.%d" % sys.version_info[:2]
lib = os.path.join(prefix, "lib", "python" + version)
os.makedirs(os.path.join(prefix, "bin"))
os.makedirs(lib)
# A copy, never a link: the interpreter derives its own prefix from this path.
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
site_dir = os.path.join(lib, os.path.basename(site.getsitepackages()[0]))
os.makedirs(site_dir)
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
# The only source binding S accepts: one path-only line naming the checkout.
with open(os.path.join(site_dir, "scienceflow.pth"), "w") as handle:
    handle.write(source + "\n")
print(json.dumps({"site": site_dir, "version": version}))
`;

interface Lease {
  readonly prefixPath: string;
  readonly interpreterPath: string;
  /** The checkout revision S is asked to verify. */
  readonly sourceRevision: string;
  readonly environment: EnvironmentRuntime;
}

const lease = (async (): Promise<Lease | null> => {
  if (!(await prerequisite).ok) return null;
  const root = await scratchDirectory();
  const prefix = join(root, "prefix");
  await execFileAsync(ENGINE_PYTHON!, ["-c", PREFIX_BUILD, prefix, ENGINE_CHECKOUT], { timeout: 600_000 });
  const revision = spawnSync("git", ["-C", ENGINE_CHECKOUT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const languageVersion = spawnSync(ENGINE_PYTHON!, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {
    encoding: "utf8",
  }).stdout.trim();
  const environment = {
    environment: { id: "layout-test", name: "layout-test" },
    interpreterPath: join(prefix, "bin", "python"),
    prefixPath: prefix,
    revision: {
      id: "layout-test-revision",
      language: "python",
      languageVersion,
      revision: (revision.stdout ?? "").trim(),
    },
  } as unknown as EnvironmentRuntime;
  return {
    environment,
    interpreterPath: environment.interpreterPath,
    prefixPath: prefix,
    sourceRevision: (revision.stdout ?? "").trim(),
  };
})();

function executorConfig(dataDir: string): ExecutorConfig {
  return {
    bwrapPath: BWRAP,
    dataDir,
    execTimeoutMs: 0,
    maxOutputBytes: 0,
    maxWorkspaceBytes: 0,
  };
}

/** A workspace with a decoy `scienceflow` package that would win on `cwd`. */
async function decoyWorkspace(root: string): Promise<string> {
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "scienceflow"), { recursive: true });
  await writeFile(join(workspace, "scienceflow", "__init__.py"), "DECOY = 'workspace'\n");
  return workspace;
}

/** Same layout as the probe, for a free-form command in it. */
async function runInLayout(options: {
  dataDir: string;
  lease: Lease;
  sourceRoot: string;
  workspace: string;
  argv: string[];
  stdin: string;
  maskVirtualEnv: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const config = executorConfig(options.dataDir);
  const binds = workspaceBindArguments(options.workspace, undefined);
  const launch = await prepareSandboxLaunch(config, {
    chdir: binds.chdir,
    environmentBinds: environmentPrefixBindArguments(options.lease.prefixPath),
    environmentPaths: [options.lease.prefixPath],
    hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} },
    language: "python",
    pathEnv: "/opt/science-env/bin:/usr/bin",
    pythonPathEnv: RESEARCH_ENGINE_MOUNT,
    researchEngine: { maskVirtualEnv: options.maskVirtualEnv, sourceRoot: options.sourceRoot },
    workspaceBindArgs: binds.args,
    workspaceRoot: options.workspace,
  });
  return await runSandboxed(
    config,
    launch,
    options.argv,
    options.stdin,
    120_000,
    options.workspace,
    undefined,
    "Research layout harness",
    0,
    256 * 1024,
    "baseline",
  );
}

test("S verifies the lease and R reaches the same pinned source through the research mount", async (context) => {
  if (await requiresEngine(context)) return;
  const built = await lease;
  assert.ok(built);
  const dataDir = await scratchDirectory();
  const config = executorConfig(dataDir);
  const binding = {
    bindingId: "scienceflow-test",
    expectedRevision: built.sourceRevision,
    sourceRoot: ENGINE_CHECKOUT,
  };

  // S: the static gate on the provisioned prefix. It runs before any research
  // mount exists, so it says nothing about `/scienceflow-engine`.
  const s = await verifyScienceFlowSourceBinding({ binding, config, environment: built.environment });
  assert.equal(s.status, "verified", JSON.stringify(s));

  const workspace = await decoyWorkspace(dataDir);
  const r = await runResearchLayoutProbe({
    config,
    environment: built.environment,
    maskVirtualEnv: true,
    sourceRoot: ENGINE_CHECKOUT,
    workspaceRoot: workspace,
  });
  assert.equal(r.status, "facts", JSON.stringify(r));
  const facts = (r as { facts: ResearchLayoutFacts }).facts;

  // R: the child assembly reaches the mount, with the run's own flags.
  assert.equal(facts.safePath, true, "-P must be in effect for the engine child");
  assert.equal(facts.cwd, "/workspace");
  assert.equal(facts.pathHead[0], RESEARCH_ENGINE_MOUNT, "the mount must be the first search entry");
  assert.equal(facts.scienceflow.origin, `${RESEARCH_ENGINE_MOUNT}/scienceflow/__init__.py`);
  for (const key of ["prep", "task", "report"] as const) {
    assert.equal(facts[key].state, "found", `${key} must be importable through the mount`);
    assert.ok(String(facts[key].origin).startsWith(`${RESEARCH_ENGINE_MOUNT}/`), `${key} resolved outside the mount`);
  }
  // The leased interpreter, not the host path and not a source-side one.
  assert.equal(facts.executable, "/opt/science-env/bin/python");
  assert.equal(facts.projectPython, "/opt/science-env/bin/python",
    "with the .venv masked, resolve_project_python must fall back to sys.executable");
});

test("a package planted in the workspace replaces the engine entry only without -P", async (context) => {
  if (await requiresEngine(context)) return;
  const built = await lease;
  assert.ok(built);
  const dataDir = await scratchDirectory();
  const workspace = await decoyWorkspace(dataDir);
  const probe = async (interpreterFlags: string[]) => {
    const result = await runResearchLayoutProbe({
      config: executorConfig(dataDir),
      environment: built.environment,
      interpreterFlags,
      maskVirtualEnv: true,
      sourceRoot: ENGINE_CHECKOUT,
      workspaceRoot: workspace,
    });
    assert.equal(result.status, "facts", JSON.stringify(result));
    return (result as { facts: ResearchLayoutFacts }).facts;
  };

  // The production flags: the decoy cannot become the engine entry.
  const safe = await probe(["-P", "-B"]);
  assert.equal(safe.scienceflow.origin, `${RESEARCH_ENGINE_MOUNT}/scienceflow/__init__.py`);
  // The negative control, recorded on purpose: without -P, `cwd` is sys.path[0]
  // and the writable workspace wins. That is exactly what EC6 prevents.
  const unsafe = await probe(["-B"]);
  assert.equal(unsafe.safePath, false);
  assert.equal(unsafe.scienceflow.origin, "/workspace/scienceflow/__init__.py");
});

test("the .venv mask decides which interpreter resolve_project_python returns", async (context) => {
  if (await requiresEngine(context)) return;
  const built = await lease;
  assert.ok(built);
  const dataDir = await scratchDirectory();
  const workspace = await decoyWorkspace(dataDir);

  // The pinned checkout itself carries no `.venv`.
  const absent = await runResearchLayoutProbe({
    config: executorConfig(dataDir),
    environment: built.environment,
    maskVirtualEnv: true,
    sourceRoot: ENGINE_CHECKOUT,
    workspaceRoot: workspace,
  });
  assert.equal(absent.status, "facts", JSON.stringify(absent));
  assert.equal((absent as { facts: ResearchLayoutFacts }).facts.projectPython, "/opt/science-env/bin/python");

  // A checkout that does carry one: the mask must hide it, or the run would use
  // an interpreter the lease never vetted.
  const withVenv = join(dataDir, "checkout-with-venv");
  await cp(ENGINE_CHECKOUT, withVenv, {
    filter: (source) => !source.includes("/.git/") && !source.endsWith("/.git"),
    recursive: true,
  });
  await mkdir(join(withVenv, ".venv", "bin"), { recursive: true });
  await writeFile(join(withVenv, ".venv", "bin", "python"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const masked = await runResearchLayoutProbe({
    config: executorConfig(dataDir),
    environment: built.environment,
    maskVirtualEnv: true,
    sourceRoot: withVenv,
    workspaceRoot: workspace,
  });
  assert.equal(masked.status, "facts", JSON.stringify(masked));
  const maskedFacts = (masked as { facts: ResearchLayoutFacts }).facts;
  assert.equal(maskedFacts.projectPython, "/opt/science-env/bin/python",
    "the empty tmpfs must hide the checkout's own interpreter");

  const unmasked = await runResearchLayoutProbe({
    config: executorConfig(dataDir),
    environment: built.environment,
    maskVirtualEnv: false,
    sourceRoot: withVenv,
    workspaceRoot: workspace,
  });
  assert.equal(unmasked.status, "facts", JSON.stringify(unmasked));
  assert.equal((unmasked as { facts: ResearchLayoutFacts }).facts.projectPython,
    `${RESEARCH_ENGINE_MOUNT}/.venv/bin/python`,
    "without the mask the walk finds the source-side interpreter: that is the hazard");
});

test("an arbitrary research script keeps its sibling imports", async (context) => {
  if (await requiresEngine(context)) return;
  const built = await lease;
  assert.ok(built);
  const dataDir = await scratchDirectory();
  const workspace = join(dataDir, "workspace");
  await mkdir(join(workspace, "program"), { recursive: true });
  await writeFile(join(workspace, "program", "helper.py"), "VALUE = 'sibling'\n");
  await writeFile(join(workspace, "program", "main.py"), String.raw`
import json, os, sys
import helper
print(json.dumps({"first_path": sys.path[0], "helper": helper.VALUE, "cwd": os.getcwd()}))
`);

  // Research code is not an engine entry point: it runs as a literal script, so
  // its own directory stays first on the path and its siblings import as today.
  const result = await runInLayout({
    argv: ["/opt/science-env/bin/python", "/workspace/program/main.py"],
    dataDir,
    lease: built,
    maskVirtualEnv: true,
    sourceRoot: ENGINE_CHECKOUT,
    stdin: "",
    workspace,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const facts = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.equal(facts.first_path, "/workspace/program");
  assert.equal(facts.helper, "sibling");
  assert.equal(facts.cwd, "/workspace");
});
