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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64"],
});
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  checkEngineRevision,
  parsePorcelain,
} from "./engine-revision.js";

const run = promisify(execFile);
const TMP_PARENT =
  process.env.SCIENCE_FLOW_ROUND9_TMP ?? resolve(process.cwd(), ".tmp");
/**
 * A marker that must never appear in a result, a thrown error, or a log: the
 * fixtures put it in repository content and in a hostile Git stand-in.
 */
const MARKER = "round9-marker-do-not-log";
/** A synthetic Git identity: no real author is implied by these fixtures. */
const IDENTITY = ["-c", "user.name=Round 9 Fixture", "-c", "user.email=fixture@example.invalid"];

interface Repository {
  readonly root: string;
  readonly commit: string;
  git(...args: string[]): Promise<string>;
}

async function repository(prefix: string, files: Record<string, string>): Promise<Repository> {
  await mkdir(TMP_PARENT, { recursive: true });
  const root = await mkdtemp(join(TMP_PARENT, `${prefix}-`));
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", root, ...IDENTITY, ...args]);
    return stdout.trim();
  };
  await git("init", "--quiet", "--initial-branch=main");
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  await git("add", "--all");
  await git("commit", "--quiet", "--message", `fixture ${MARKER}`);
  return { root, commit: await git("rev-parse", "HEAD"), git };
}

async function scratchDir(prefix: string): Promise<string> {
  await mkdir(TMP_PARENT, { recursive: true });
  return mkdtemp(join(TMP_PARENT, `${prefix}-`));
}

test("a matching clean checkout is verified", async (t) => {
  const repo = await repository("round9-rev-clean", {
    "scienceflow/__init__.py": "VERSION = 1\n",
    "pyproject.toml": "[project]\nname = 'fixture'\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: repo.commit,
  });
  assert.equal(result.status, "verified-clean");
  assert.equal(result.revision, repo.commit);
  assert.equal(result.dirty, false);
  assert.equal(result.trackedModified, false);
  assert.equal(result.untrackedRunnable, false);
  assert.equal(result.reason, null);
});

test("a different commit is a revision mismatch", async (t) => {
  const repo = await repository("round9-rev-mismatch", {
    "scienceflow/__init__.py": "VERSION = 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: "0".repeat(40),
  });
  assert.equal(result.status, "revision-mismatch");
  assert.equal(result.revision, repo.commit);
});

test("a modified tracked file makes the checkout dirty", async (t) => {
  const repo = await repository("round9-rev-dirty", {
    "scienceflow/runner.py": "def run():\n    return 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await writeFile(
    join(repo.root, "scienceflow/runner.py"),
    "def run():\n    return 2\n",
    "utf8",
  );
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: repo.commit,
  });
  assert.equal(result.status, "dirty");
  assert.equal(result.dirty, true);
  assert.equal(result.trackedModified, true);
});

test("an untracked runnable source file makes the checkout dirty", async (t) => {
  const repo = await repository("round9-rev-untracked", {
    "scienceflow/runner.py": "def run():\n    return 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await writeFile(
    join(repo.root, "scienceflow/overlay.py"),
    "def override():\n    return 'planted'\n",
    "utf8",
  );
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: repo.commit,
  });
  assert.equal(result.status, "dirty");
  assert.equal(result.untrackedRunnable, true);
  assert.equal(result.trackedModified, false);
});

test("an untracked non-runnable file does not make the checkout dirty", async (t) => {
  const repo = await repository("round9-rev-doc", {
    "scienceflow/runner.py": "def run():\n    return 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await writeFile(join(repo.root, "NOTES.md"), `note ${MARKER}\n`, "utf8");
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: repo.commit,
  });
  assert.equal(result.status, "verified-clean");
  assert.equal(result.dirty, false);
});

test("a plain directory is reported as unsupported rather than guessed", async (t) => {
  // Outside any working tree on purpose: a directory nested in a repository is
  // covered by the checkout-root test instead.
  const root = await mkdtemp(join(tmpdir(), "round9-rev-plain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "setup.py"), "print('not a checkout')\n", "utf8");
  const result = await checkEngineRevision({
    path: root,
    expectedRevision: "0".repeat(40),
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "not-a-git-checkout");
  assert.equal(result.revision, null);
});

test("a subdirectory of a checkout is not accepted as the checkout root", async (t) => {
  const repo = await repository("round9-rev-subdir", {
    "scienceflow/runner.py": "def run():\n    return 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const result = await checkEngineRevision({
    path: join(repo.root, "scienceflow"),
    expectedRevision: repo.commit,
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "path-not-checkout-root");
});

test("a bounded output limit stops an oversized Git answer", async (t) => {
  const repo = await repository("round9-rev-limit", {
    "scienceflow/__init__.py": "VERSION = 1\n",
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const result = await checkEngineRevision({
    path: repo.root,
    expectedRevision: repo.commit,
    maxOutputBytes: 4,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "output-limit");
});

test("a slow Git stand-in is stopped at the timeout", async (t) => {
  const root = await scratchDir("round9-rev-timeout");
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeGit = join(root, "fake-git.sh");
  await writeFile(
    fakeGit,
    `#!/bin/sh\necho "${MARKER}"\nsleep 30\n`,
    "utf8",
  );
  await chmod(fakeGit, 0o755);
  const started = Date.now();
  const result = await checkEngineRevision({
    path: root,
    expectedRevision: "0".repeat(40),
    gitExecutable: fakeGit,
    timeoutMs: 300,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "timeout");
  assert.ok(Date.now() - started < 10_000, "the check must return promptly");
});

test("a failing Git stand-in leaks neither stdout, stderr, nor paths", async (t) => {
  const root = await scratchDir("round9-rev-leak");
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeGit = join(root, "fake-git.sh");
  await writeFile(
    fakeGit,
    `#!/bin/sh\necho "${MARKER} stdout"\necho "${MARKER} stderr" >&2\nexit 1\n`,
    "utf8",
  );
  await chmod(fakeGit, 0o755);
  const result = await checkEngineRevision({
    path: root,
    expectedRevision: "0".repeat(40),
    gitExecutable: fakeGit,
  });
  assert.notEqual(result.status, "verified-clean");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(MARKER), false);
  assert.equal(serialized.includes(root), false);
});

test("a missing Git binary is reported as unavailable", async (t) => {
  const root = await scratchDir("round9-rev-nogit");
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkEngineRevision({
    path: root,
    expectedRevision: "0".repeat(40),
    gitExecutable: join(root, "no-such-git"),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "git-unavailable");
});

test("malformed options are rejected before any Git call", async () => {
  await assert.rejects(
    async () =>
      checkEngineRevision({ path: "relative/checkout", expectedRevision: "0".repeat(40) }),
    TypeError,
  );
  await assert.rejects(
    async () => checkEngineRevision({ path: "/tmp", expectedRevision: "abc" }),
    TypeError,
  );
  await assert.rejects(
    async () =>
      checkEngineRevision({
        path: "/tmp",
        expectedRevision: "0".repeat(40),
        timeoutMs: 0,
      }),
    TypeError,
  );
});

test("porcelain parsing separates tracked changes from runnable additions", () => {
  const parsed = parsePorcelain(
    [
      " M scienceflow/runner.py",
      "?? scienceflow/overlay.py",
      "?? NOTES.md",
      "R  old.py -> scienceflow/renamed.py",
      "",
    ].join("\n"),
  );
  assert.equal(parsed.trackedModified, true);
  assert.equal(parsed.untrackedRunnable, true);
  assert.equal(parsePorcelain("?? NOTES.md\n").trackedModified, false);
  assert.equal(parsePorcelain("?? NOTES.md\n").untrackedRunnable, false);
});
