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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EnvironmentRuntime } from "./environment-store.js";
import { loadRunnerConfig } from "./server.js";
import { createScienceFlowRuntimeCheckService } from "./scienceflow-runtime-check.js";
import { parseScienceFlowRuntimeProbeAnswer, SCIENCE_FLOW_RUNTIME_PROBE_SOURCE } from "./scienceflow-runtime-probe.js";

function python(executable: string, flags: string[], input: string) {
  const child = spawnSync(executable, [...flags, "-"], { input, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

async function fixture(context: { after: (fn: () => Promise<void>) => void }) {
  const base = resolve(process.cwd(), ".tmp/r");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, "runtime-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prefix = resolve(root, "prefix");
  const source = resolve(root, "source");
  await mkdir(resolve(source, "scienceflow"), { recursive: true });
  await writeFile(resolve(source, "scienceflow/__init__.py"), 'raise RuntimeError("the identity check must not import this fixture")\n');
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", "scienceflow/__init__.py");
  git("-c", "user.name=Runtime Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  // A copy of the existing interpreter and links to its stdlib are synthetic
  // test files, not an installed/managed ScienceFlow environment.
  python("/usr/bin/python3.10", ["-I", "-S", "-B"], `
import os, shutil, sys, sysconfig
prefix = ${JSON.stringify(prefix)}
source = ${JSON.stringify(source)}
version = "%d.%d" % sys.version_info[:2]
lib = os.path.join(prefix, "lib", "python" + version)
os.makedirs(os.path.join(prefix, "bin"))
os.makedirs(os.path.join(lib, "dist-packages"))
shutil.copyfile(sys.executable, os.path.join(prefix, "bin", "python"))
os.chmod(os.path.join(prefix, "bin", "python"), 0o755)
stdlib = sysconfig.get_path("stdlib")
for entry in os.listdir(stdlib):
    if entry not in ("dist-packages", "site-packages", "sitecustomize.py", "usercustomize.py"):
        os.symlink(os.path.join(stdlib, entry), os.path.join(lib, entry))
with open(os.path.join(lib, "dist-packages", "scienceflow.pth"), "w") as handle:
    handle.write(source + "\\n")
`);
  const executable = resolve(prefix, "bin/python");
  const site = resolve(prefix, "lib/python3.10/dist-packages");
  const config = loadRunnerConfig({
    SCIENCE_AGENT_DATA_DIR: resolve(root, "data"),
    SCIENCE_AGENT_SANDBOX_PROVIDER: "bubblewrap",
    SCIENCE_AGENT_BWRAP_PATH: process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap",
    SCIENCE_AGENT_RUNNER_TOKEN: randomBytes(24).toString("hex"),
  }, root);
  const runtime: EnvironmentRuntime = {
    interpreterPath: executable, prefixPath: prefix,
    environment: { id: "environment", currentRevisionId: "revision", createdAt: "now", updatedAt: "now", name: "fixture", kind: "task", language: "python" },
    revision: { id: "revision", environmentId: "environment", language: "python", languageVersion: "3.10", channels: [], createdAt: "now", packages: [], packageSpecHash: "fixture", platform: "linux", provisioner: "fixture", runnerVersion: "fixture", snapshot: { hash: "fixture", size: 0 } },
  };
  const service = createScienceFlowRuntimeCheckService({
    config,
    environmentStore: { withRuntime: async (_id, operation) => operation(runtime) },
    bindings: { bindingFor: bindingId => ({ bindingId, sourceRoot: source, expectedRevision: revision }) },
  });
  const request = (bindingId = "binding") => ({ schemaVersion: 1 as const, requestId: "check", bindingId, environmentId: "environment", expectedEnvironmentRevisionId: "revision", expectedRevision: revision });
  return { root, prefix, site, executable, config, service, request, runtime };
}

test("RT-SAFETY clean copied interpreter and plain path binding remain verified in bubblewrap", async context => {
  const f = await fixture(context);
  const result = await f.service.check(f.request());
  assert.equal(result.outcome, "verified");
});

test("RT-SAFETY sourceless startup hook is refused before normal startup, with an executable positive control", async context => {
  const f = await fixture(context);
  const marker = resolve(f.root, "hook-marker");
  const hook = resolve(f.site, "sitecustomize.py");
  await writeFile(hook, `import sys\nsys.stdout.write("HOOK_EXECUTED\\n")\nopen(${JSON.stringify(marker)}, "w").write("executed")\n`);
  python("/usr/bin/python3.10", ["-I", "-S", "-B"], `import py_compile\npy_compile.compile(${JSON.stringify(hook)}, cfile=${JSON.stringify(hook + "c")}, doraise=True)\n`);
  await rm(hook);
  const result = await f.service.check(f.request());
  assert.equal(result.outcome, "blocked", "a missed hook executes in the normal phase and corrupts its protocol instead");
  assert.equal(result.checks.find(check => check.code === "startup_hooks")?.status, "failed");
  assert.equal(existsSync(marker), false);
  // This control runs on the host after the check. Its stdout marker makes
  // execution observable even when a sandbox would refuse the marker file.
  const normal = python(f.executable, ["-I", "-B"], "pass\n");
  assert.match(normal, /HOOK_EXECUTED/);
  assert.equal(await readFile(marker, "utf8"), "executed");
});

test("RT-SAFETY native and bytecode hook candidates are inventoried without importing them", async context => {
  const f = await fixture(context);
  const suffix = python("/usr/bin/python3.10", ["-I", "-S", "-B"], "import importlib.machinery; print(importlib.machinery.EXTENSION_SUFFIXES[0])\n").trim();
  await writeFile(resolve(f.site, `sitecustomize${suffix}`), "not a loadable extension; existence must refuse startup");
  await writeFile(resolve(f.site, "usercustomize.pyc"), "not bytecode; existence must refuse startup");
  const parsed = parseScienceFlowRuntimeProbeAnswer(python(f.executable, ["-I", "-S", "-B"], SCIENCE_FLOW_RUNTIME_PROBE_SOURCE), "static");
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") assert.fail("static probe failed");
  const hooks = parsed.facts.hooks.find(hook => hook.entry === f.site);
  assert.ok(hooks);
  assert.equal(hooks.sitecustomize, true);
  assert.equal(hooks.usercustomize, true);
});

test("RT-SAFETY different bindings cannot acquire concurrent probes on one environment", async context => {
  const f = await fixture(context);
  const hold = Promise.withResolvers<void>();
  let leases = 0;
  const service = createScienceFlowRuntimeCheckService({
    config: f.config,
    environmentStore: { withRuntime: async () => { leases++; await hold.promise; throw new Error("synthetic lease refusal"); } },
    bindings: { bindingFor: bindingId => ({ bindingId, sourceRoot: f.root, expectedRevision: f.request().expectedRevision }) },
  });
  const pending = [service.check(f.request("a")), service.check(f.request("b")), service.check(f.request("c"))];
  try {
    assert.equal(leases, 1, "the same environment must have at most one outstanding probe owner");
    pending.push(service.check({ ...f.request("independent"), environmentId: "another-environment" }));
    assert.equal(leases, 2, "a different environment remains independent");
  } finally {
    hold.resolve();
    const results = await Promise.all(pending);
    assert.ok(results.every(result => result.outcome === "unavailable"));
  }
});

test("RT-SAFETY a reservation appearing during the lease wait refuses both probe phases", async context => {
  const f = await fixture(context);
  let fenced = false;
  const diagnostics: string[] = [];
  const service = createScienceFlowRuntimeCheckService({
    config: f.config,
    environmentStore: {
      runtimeCheckBoundary: () => fenced ? "unproven" : undefined,
      withRuntime: async (_id, operation) => { fenced = true; return operation(f.runtime); },
    },
    bindings: { bindingFor: bindingId => ({ bindingId, sourceRoot: f.root, expectedRevision: f.request().expectedRevision }) },
    onDiagnostic: (_event, detail) => { if (typeof detail?.reason === "string") diagnostics.push(detail.reason); },
  });
  const result = await service.check(f.request());
  assert.equal(result.outcome, "unavailable");
  assert.deepEqual(diagnostics, ["termination-unverified"]);
  assert.equal(existsSync(resolve(f.config.dataDir, "runtime-checks")), false, "no probe may start after a queued reader inherits a fence");
});
