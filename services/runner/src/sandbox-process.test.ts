// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { killSandboxProcess, spawnSandboxProcess } from "./executor.js";
import { captureExecutionBoundaryOutcome } from "./execution-boundary.js";

test("sandbox cancellation kills monitor and descendants before parent-death binding", {
  tags: ["os:linux"],
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-group-"));
  // Model bwrap's startup window: its descendant exists but has not yet bound
  // its lifetime to the monitor. Both keep stdout open. Killing only the
  // monitor must fail this regression, regardless of scheduler timing.
  const descendant = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
  const monitor = `require("node:child_process").spawn(process.execPath,
    ["-e", ${JSON.stringify(descendant)}], {stdio: ["ignore", 1, 2]});
    setInterval(() => {}, 1000);`;
  const child = await spawnSandboxProcess({ dataDir: root, bwrapPath: process.execPath }, {
    args: ["--new-session"], commandPrefix: [], chdir: root, env: {}, sandbox: "bubblewrap",
  }, ["-e", monitor], "baseline");
  const closed = once(child, "close");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((done) => {
        let output = "";
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("ready\n")) {
            child.stdout.removeListener("data", read);
            done();
          }
        };
        child.stdout.on("data", read);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("descendant did not start")), 5000); }),
    ]);
    clearTimeout(timer);
    assert.equal(killSandboxProcess(child), true);
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("descendant kept sandbox pipes open after cancellation")), 1500); }),
    ]);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    clearTimeout(timer);
    // Independent cleanup also works when testing the broken single-PID kill.
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

function assertGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} survived a failed spawn record`);
}

test("a sandbox whose spawn record fails is terminated before the error surfaces", {
  tags: ["os:linux"],
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-record-failure-"));
  let started: ChildProcessWithoutNullStreams | undefined;
  try {
    // The record callback is the ledger write. When it throws, the Runner still
    // holds the child and nothing else can see it, so the spawn call must not
    // return an unsupervised process — nor claim a termination it cannot prove.
    await assert.rejects(spawnSandboxProcess(
      { dataDir: root, bwrapPath: process.execPath, terminationGraceMs: 2_000 },
      { args: ["--new-session"], commandPrefix: [], chdir: root, env: {}, sandbox: "bubblewrap" },
      ["-e", "setInterval(() => {}, 1000)"], "baseline", undefined,
      (child) => { started = child; throw new Error("boundary identity unavailable"); },
    ), (error: Error & { code?: string; cause?: unknown }) => {
      assert.equal(error.code, "PROCESS_TERMINATION_UNVERIFIED");
      assert.match(error.message, /could not be verified/);
      assert.equal((error.cause as Error).message, "boundary identity unavailable");
      return true;
    });
    assert.ok(started?.pid);
    assert.notEqual(started.exitCode ?? started.signalCode, null,
      "the spawn call only rejects after the monitor's terminal event was observed");
    assertGone(started.pid);
  } finally {
    if (started?.pid) {
      try { process.kill(-started.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a direct sandbox whose spawn record fails stops its child and rethrows the cause", {
  tags: ["os:linux"],
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-direct-record-failure-"));
  let started: ChildProcessWithoutNullStreams | undefined;
  try {
    // No namespace bounds a "none" process, so its own exit is the proof. Here
    // that proof exists, and the storage error itself is the outcome.
    await assert.rejects(spawnSandboxProcess(
      { dataDir: root, bwrapPath: process.execPath, terminationGraceMs: 2_000 },
      { args: [], commandPrefix: [], executable: process.execPath, chdir: root, env: {}, sandbox: "none" },
      ["-e", "setInterval(() => {}, 1000)"], "baseline", undefined,
      (child) => { started = child; throw new Error("ledger refused the boundary row"); },
    ), { message: "ledger refused the boundary row" });
    assert.ok(started?.pid);
    assert.notEqual(started.exitCode ?? started.signalCode, null);
    assertGone(started.pid);
  } finally {
    if (started?.pid) {
      try { process.kill(started.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a captured real bubblewrap boundary joins its monitor before callback failure surfaces", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-captured-record-"));
  let started: ChildProcessWithoutNullStreams | undefined;
  let cleanups = 0;
  const failure = new Error("synthetic ledger callback failure");
  try {
    await assert.rejects(spawnSandboxProcess(
      { dataDir: root, bwrapPath: process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap", terminationGraceMs: 2_000 },
      { args: ["--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"],
        commandPrefix: [], chdir: root, env: {}, sandbox: "bubblewrap", cleanup: async () => { cleanups++; } },
      ["/bin/sh", "-c", "while :; do sleep 1; done"], "baseline", undefined,
      child => {
        started = child;
        assert.ok(child.pid);
        assert.equal(captureExecutionBoundaryOutcome("captured-record", { pid: child.pid, kind: "pid-namespace", sandbox: "bubblewrap" }).status,
          "captured", "this test must exercise a real captured namespace");
        throw failure;
      },
    ), error => error === failure);
    assert.ok(started?.pid);
    assert.notEqual(started.exitCode ?? started.signalCode, null);
    assertGone(started.pid);
    assert.equal(cleanups, 1);
  } finally {
    if (started?.pid && started.exitCode === null && started.signalCode === null) killSandboxProcess(started);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed spawn and throwing callback own the child error event instead of crashing the Runner", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-missing-executable-"));
  let cleanups = 0;
  const failure = new Error("synthetic callback failure after ENOENT");
  try {
    await assert.rejects(spawnSandboxProcess(
      { dataDir: root, bwrapPath: "unused", terminationGraceMs: 2_000 },
      { args: [], commandPrefix: [], chdir: root, env: {}, sandbox: "none", executable: resolve(root, "missing-executable"),
        cleanup: async () => { cleanups++; } },
      [], "baseline", undefined, () => { throw failure; },
    ), error => error === failure);
    assert.equal(cleanups, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
