// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { EnvironmentRuntime } from "./environment-store.js";
import { loadRunnerConfig } from "./server.js";
import { createRuntimeProbeService } from "./runtime-probe.js";

async function fixture(context: { after: (fn: () => Promise<void>) => void }) {
  const base = resolve(".tmp/r"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, "probe-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prefix = resolve(root, "prefix");
  const config = loadRunnerConfig({ SCIENCE_AGENT_DATA_DIR: resolve(root, "data"),
    SCIENCE_AGENT_SANDBOX_PROVIDER: "bubblewrap", SCIENCE_AGENT_BWRAP_PATH: process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap",
    SCIENCE_AGENT_RUNNER_TOKEN: randomBytes(24).toString("hex") }, root);
  const environment: EnvironmentRuntime = {
    interpreterPath: resolve(prefix, "bin/python"), prefixPath: prefix,
    environment: { id: "env", currentRevisionId: "revision", createdAt: "now", updatedAt: "now", name: "fixture", kind: "task", language: "python" },
    revision: { id: "revision", environmentId: "env", language: "python", languageVersion: "3.10", channels: [], createdAt: "now", packages: [], packageSpecHash: "fixture", platform: "linux", provisioner: "fixture", runnerVersion: "fixture", snapshot: { hash: "fixture", size: 0 } },
  };
  return { root, prefix, config, environment };
}
const identity = { scopeKey: "product-binding", environmentId: "env" };

test("probe leases exclude aliases of the same environment and release after failures", async context => {
  const f = await fixture(context), hold = Promise.withResolvers<void>();
  let leases = 0;
  const service = createRuntimeProbeService({ config: f.config, environmentStore: {
    withRuntime: async () => { leases++; await hold.promise; throw new Error("lease failed"); },
  } });
  const first = service.withEnvironment(identity, async () => "unused");
  assert.equal((await service.withEnvironment({ ...identity, scopeKey: "alias" }, async () => "unused")).status, "unavailable");
  assert.equal((await service.withEnvironment({ ...identity, environmentId: "other" }, async () => "unused")).status, "unavailable", "the same binding remains exclusive too");
  const independent = service.withEnvironment({ scopeKey: "other", environmentId: "other" }, async () => "unused");
  assert.equal(leases, 2);
  hold.resolve();
  await Promise.all([first, independent]);
  await service.withEnvironment(identity, async () => "unused");
  assert.equal(leases, 3);
});

test("an unproven reservation inherited during a lease wait refuses the operation", async context => {
  const f = await fixture(context);
  let fenced = false, entered = false;
  const diagnostics: string[] = [];
  const service = createRuntimeProbeService({ config: f.config, onDiagnostic: reason => diagnostics.push(reason), environmentStore: {
    runtimeCheckBoundary: () => fenced ? "unproven" : undefined,
    withRuntime: async (_id, operation) => { fenced = true; return operation(f.environment); },
  } });
  assert.equal((await service.withEnvironment(identity, async () => { entered = true; })).status, "unavailable");
  assert.equal(entered, false);
  assert.deepEqual(diagnostics, ["termination-unverified"]);
  assert.equal(existsSync(resolve(f.config.dataDir, "runtime-checks")), false);
});

test("corrupt and unproven durable reservations survive service reconstruction", async context => {
  const f = await fixture(context);
  let leases = 0, releases = 0;
  for (const boundary of ["unproven", "corrupt"] as const) {
    const service = createRuntimeProbeService({ config: f.config, environmentStore: {
      runtimeCheckBoundary: () => boundary,
      releaseRuntimeCheckReservation: () => { releases++; },
      withRuntime: async (_id, operation) => { leases++; return operation(f.environment); },
    } });
    assert.equal((await service.withEnvironment(identity, async () => "unused")).status, "unavailable");
  }
  assert.equal(leases, 0); assert.equal(releases, 0);
});

test("a failing product classifier releases its lease without inventing evidence", async context => {
  const f = await fixture(context);
  const service = createRuntimeProbeService({ config: f.config, environmentStore: {
    withRuntime: async (_id, operation) => operation(f.environment),
  } });
  assert.equal((await service.withEnvironment(identity, async () => { throw new Error("bad facts"); })).status, "unavailable");
  assert.deepEqual(await service.withEnvironment(identity, async probe => probe.environment.revision.id), { status: "result", value: "revision" });
});

test("a product-neutral program runs in the selected sandbox and its joined workspace is removed", async context => {
  const f = await fixture(context);
  // Synthetic prefix: copy only the host interpreter and link its standard
  // library. No managed environments, installation or daily state is used.
  const child = spawnSync("/usr/bin/python3.10", ["-I", "-S", "-B", "-"], { encoding: "utf8", input: `
import os, shutil, sys, sysconfig
prefix = ${JSON.stringify(f.prefix)}
lib = os.path.join(prefix, "lib", "python3.10")
os.makedirs(os.path.join(prefix, "bin"))
os.makedirs(lib)
shutil.copyfile(sys.executable, os.path.join(prefix, "bin", "python"))
os.chmod(os.path.join(prefix, "bin", "python"), 0o755)
for entry in os.listdir(sysconfig.get_path("stdlib")):
    if entry not in ("dist-packages", "site-packages", "sitecustomize.py", "usercustomize.py"):
        os.symlink(os.path.join(sysconfig.get_path("stdlib"), entry), os.path.join(lib, entry))
` });
  assert.equal(child.status, 0, child.stderr);
  const service = createRuntimeProbeService({ config: f.config, environmentStore: {
    withRuntime: async (_id, operation) => operation(f.environment),
  } });
  const result = await service.withEnvironment(identity, async probe => {
    const spec = { interpreterFlags: ["-I", "-S", "-B"], readOnlyHostBinds: [], timeoutMs: 5000, maxOutputBytes: 1024 };
    const answer = await probe.run({ ...spec, program: 'import sys; print("evidence", sys.flags.no_site, sys.dont_write_bytecode)' });
    assert.deepEqual(answer, { status: "output", stdout: "evidence 1 True\n" });
    const failed = await probe.run({ ...spec, program: 'raise RuntimeError("invalid evidence")' });
    assert.deepEqual(failed, { status: "unavailable", reason: "probe-failed" });
    return "classified";
  });
  assert.deepEqual(result, { status: "result", value: "classified" });
  assert.deepEqual(await readdir(resolve(f.config.dataDir, "runtime-checks")), []);
  let detached: Promise<unknown> | undefined;
  await service.withEnvironment(identity, async probe => {
    detached = probe.run({ program: 'import time; time.sleep(0.05); print("joined")',
      interpreterFlags: ["-I", "-S", "-B"], readOnlyHostBinds: [], timeoutMs: 5000, maxOutputBytes: 1024 });
    assert.deepEqual(await probe.run({ program: "pass", interpreterFlags: [], readOnlyHostBinds: [], timeoutMs: 5000, maxOutputBytes: 1024 }),
      { status: "unavailable", reason: "launch-failed" }, "one lease cannot run overlapping phases");
  });
  assert.deepEqual(await detached, { status: "output", stdout: "joined\n" });
  assert.deepEqual(await readdir(resolve(f.config.dataDir, "runtime-checks")), [], "the lease waits for a phase even if its caller does not");

  const unreadableProc = resolve(f.root, "unreadable-proc");
  await symlink(unreadableProc, unreadableProc); // ELOOP is unobservable, never evidence that a process is gone.
  let reservation: "unproven" | undefined;
  const fencedService = createRuntimeProbeService({ config: f.config, procRoot: unreadableProc, environmentStore: {
    withRuntime: async (_id, operation) => operation(f.environment),
    runtimeCheckBoundary: () => reservation,
    reserveRuntimeCheck: (_id, boundary) => { assert.equal(boundary, "unproven"); reservation = "unproven"; },
  } });
  const fenced = await fencedService.withEnvironment(identity, async probe => {
    const spec = { program: 'print("untrusted evidence")', interpreterFlags: ["-I", "-S", "-B"], readOnlyHostBinds: [], timeoutMs: 5000, maxOutputBytes: 1024 };
    const answer = await probe.run(spec);
    assert.deepEqual(answer, { status: "termination-unverified", handle: "unproven" });
    assert.deepEqual(await probe.run(spec), { status: "unavailable", reason: "launch-failed" });
    return "fenced";
  });
  assert.equal(fenced.status, "result");
  assert.equal(reservation, "unproven");
  assert.equal((await readdir(resolve(f.config.dataDir, "runtime-checks"))).length, 1, "unproven termination retains its workspace");
  assert.equal((await fencedService.withEnvironment(identity, async () => assert.fail("must not acquire a fenced lease"))).status, "unavailable");
});
