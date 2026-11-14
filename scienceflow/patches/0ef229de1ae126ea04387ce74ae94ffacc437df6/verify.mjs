#!/usr/bin/env node
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
 * Rebuild the pinned engine from a clean checkout and prove the result.
 *
 * The check is deliberately offline and non-destructive: it reads a ScienceFlow
 * checkout, refuses anything that is not the declared base commit or that has
 * local changes, clones that commit into a disposable directory, applies the
 * patches in order and compares the resulting tree with the pinned tree. It
 * never fetches, never installs and never writes to the source checkout.
 *
 *   node verify.mjs /path/to/scienceflow
 *
 * Exit 0 means the patches rebuild exactly the pinned tree; any other outcome
 * prints one fixed reason and exits non-zero.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function fail(reason, detail) {
  process.stderr.write(`${reason}${detail === undefined ? "" : `: ${detail}`}\n`);
  process.exit(1);
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 });
  if (result.error) fail("git-unavailable", result.error.code ?? result.error.message);
  return result;
}

function mustGit(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) fail("git-failed", `${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const source = process.argv[2];
if (typeof source !== "string" || !source.startsWith("/")) {
  fail("usage", "node verify.mjs <absolute scienceflow checkout>");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
} catch (error) {
  fail("manifest-unreadable", error.message);
}
if (manifest.schemaVersion !== 1 || manifest.engine !== "scienceflow"
  || ![manifest.baseRevision, manifest.patchedRevision, manifest.patchedTree]
    .every((value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value))
  || !Array.isArray(manifest.patches) || manifest.patches.length === 0) {
  fail("manifest-invalid");
}

// Every patch must be the byte string the manifest pins.
for (const patch of manifest.patches) {
  let text;
  try {
    text = readFileSync(join(here, patch.path), "utf8");
  } catch (error) {
    fail("patch-missing", `${patch.path}: ${error.message}`);
  }
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (digest !== patch.sha256) fail("patch-digest-mismatch", patch.path);
}

const root = resolve(source);
if (mustGit(root, ["rev-parse", "--show-toplevel"]) !== root) fail("not-checkout-root");
const head = mustGit(root, ["rev-parse", "HEAD"]);
if (head !== manifest.baseRevision) fail("wrong-base", `${head} is not ${manifest.baseRevision}`);
const dirty = mustGit(root, ["status", "--porcelain"]);
if (dirty !== "") fail("dirty-source");

// A disposable clone of exactly that commit: the source checkout is only read.
const scratch = mkdtempSync(join(tmpdir(), "scienceflow-patch-check-"));
try {
  const clone = join(scratch, "engine");
  const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, clone], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (cloned.status !== 0) fail("clone-failed", cloned.stderr.trim());
  mustGit(clone, ["checkout", "--quiet", "--detach", manifest.baseRevision]);
  for (const patch of manifest.patches) {
    const applied = git(clone, ["apply", "--whitespace=nowarn", join(here, patch.path)]);
    if (applied.status !== 0) fail("patch-apply-failed", `${patch.path}: ${applied.stderr.trim()}`);
  }
  mustGit(clone, ["add", "-A"]);
  const tree = mustGit(clone, ["write-tree"]);
  if (tree !== manifest.patchedTree) fail("tree-mismatch", `${tree} is not ${manifest.patchedTree}`);
  process.stdout.write(`${JSON.stringify({
    base: manifest.baseRevision,
    patched: manifest.patchedRevision,
    tree,
    patches: manifest.patches.length,
    status: "rebuilt",
  })}\n`);
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
