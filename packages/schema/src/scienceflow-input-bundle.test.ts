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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonicalScienceFlowInputBundleManifest,
  isScienceFlowInputBundlePath,
  parseScienceFlowInputBundleManifest,
  parseScienceFlowInputBundleRequest,
  SCIENCE_FLOW_INPUT_BUNDLE_LIMITS,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  scienceFlowInputBundleTotalBytes,
  type ScienceFlowInputBundleEntry,
  type ScienceFlowInputBundleRequest,
  type ScienceFlowInputFileRole,
} from "./scienceflow-input-bundle.js";

const CONTRACT_DIGEST = "a".repeat(64);

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function entry(
  path: string,
  roles: readonly ScienceFlowInputFileRole[],
  content: string,
  overrides: Partial<ScienceFlowInputBundleEntry> = {},
): ScienceFlowInputBundleEntry {
  return {
    path,
    roles,
    size: Buffer.byteLength(content),
    sha256: sha256(content),
    content: Buffer.from(content, "utf8").toString("base64"),
    ...overrides,
  };
}

function bundle(
  entries: readonly ScienceFlowInputBundleEntry[] = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
  ],
): ScienceFlowInputBundleRequest {
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    files: entries.map(({ content: _content, ...file }) => file),
  };
  const digest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    bundleDigest: digest,
    entries,
  };
}

test("BUNDLE-S01 a canonical bundle parses and its digest input is stable", () => {
  const parsed = parseScienceFlowInputBundleRequest(bundle());
  if (parsed.status !== "ok") assert.fail("expected a valid bundle");
  assert.equal(parsed.manifest.files.length, 4);
  assert.deepEqual(
    parsed.manifest.files.map((file) => file.path),
    [
      "manifest.yaml",
      "package/description.md",
      "package/evaluate.py",
      "package/task.yaml",
    ],
  );
  assert.equal(
    scienceFlowInputBundleTotalBytes(parsed.manifest),
    parsed.manifest.files.reduce((total, file) => total + file.size, 0),
  );
  // The canonical string depends only on the manifest, never on key insertion
  // order or on the content bytes.
  const reordered = canonicalScienceFlowInputBundleManifest({
    files: parsed.manifest.files,
    contractDigest: CONTRACT_DIGEST,
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  });
  assert.equal(reordered, canonicalScienceFlowInputBundleManifest(parsed.manifest));
  assert.equal(reordered.includes("manifest\n"), false);
});

test("BUNDLE-S02 entries must be sorted by path with one role each", () => {
  const reversed = [
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
  ];
  assert.equal(parseScienceFlowInputBundleRequest(bundle(reversed)).status, "invalid");

  const duplicateRole = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/other.py", ["evaluator"], "other\n"),
  ];
  assert.equal(parseScienceFlowInputBundleRequest(bundle(duplicateRole)).status, "invalid");

  const merged = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/task.yaml", ["task_yaml", "description"], "id: t\n"),
  ];
  const parsed = parseScienceFlowInputBundleRequest(bundle(merged));
  if (parsed.status !== "ok") assert.fail("expected a merged role entry to parse");
  assert.deepEqual(parsed.manifest.files[2]?.roles, ["task_yaml", "description"]);
});

test("BUNDLE-S03 a bundle must carry every required role", () => {
  const missingEvaluator = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
  ];
  assert.equal(parseScienceFlowInputBundleRequest(bundle(missingEvaluator)).status, "invalid");
});

test("BUNDLE-S04 content must be canonical base64 of the declared size", () => {
  const base = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
  ];
  const cases: ScienceFlowInputBundleEntry[][] = [
    // A non-canonical trailing bit set is a second spelling Buffer.from would
    // accept; the protocol refuses it.
    [{ ...base[0]!, content: "bWFuaWZlc3QK\r" }, ...base.slice(1)],
    [{ ...base[0]!, content: "bWFuaWZlc3QK=" }, ...base.slice(1)],
    [{ ...base[0]!, content: "bWFuaWZlc3QK!!" }, ...base.slice(1)],
    [{ ...base[0]!, content: "bWFuaWZlc3QK", size: 10 }, ...base.slice(1)],
    [{ ...base[0]!, size: 1 }, ...base.slice(1)],
  ];
  for (const entries of cases) {
    assert.equal(parseScienceFlowInputBundleRequest(bundle(entries)).status, "invalid");
  }
  // The plus/slash alphabet at the canonical form is accepted.
  const binary = Buffer.from([0xfb, 0xff, 0xbf]).toString("base64");
  const parsed = parseScienceFlowInputBundleRequest(
    bundle([
      { ...base[0]!, content: binary, size: 3, sha256: createHash("sha256").update(Buffer.from([0xfb, 0xff, 0xbf])).digest("hex") },
      ...base.slice(1),
    ]),
  );
  assert.equal(parsed.status, "ok");
});

test("BUNDLE-S05 paths are logical labels, never host paths", () => {
  for (const path of ["/abs/file", "C:/file", "..", "a/../b", "a\\b", "a//b", "./a", ""]) {
    assert.equal(isScienceFlowInputBundlePath(path), false, path);
  }
  for (const path of ["manifest.yaml", "package/_shared/task_defaults.yaml", "a.b/c-d_e"]) {
    assert.equal(isScienceFlowInputBundlePath(path), true, path);
  }
});

test("BUNDLE-S06 the wire shape is exact and bounded", () => {
  const valid = bundle();
  assert.equal(
    parseScienceFlowInputBundleRequest({ ...valid, command: "run" }).status,
    "invalid",
  );
  assert.equal(
    parseScienceFlowInputBundleRequest({ ...valid, schemaVersion: 2 }).status,
    "invalid",
  );
  assert.equal(
    parseScienceFlowInputBundleRequest({ ...valid, bundleDigest: "b".repeat(64) }).status,
    "ok",
    "the digest is the sender's claim; verification belongs to the receiver",
  );
  assert.equal(
    parseScienceFlowInputBundleRequest({
      ...valid,
      entries: valid.entries.map((file) => ({ ...file, extra: 1 })),
    }).status,
    "invalid",
  );

  const many = [
    ...valid.entries,
    entry("package/extra-1", ["shared_task_defaults"], "x\n"),
    entry("package/extra-2", ["manifest"], "y\n"),
  ];
  assert.equal(parseScienceFlowInputBundleRequest(bundle(many)).status, "invalid");

  const oversize = valid.entries.map((file) =>
    file.path === "package/evaluate.py"
      ? {
          ...file,
          size: SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxEntryBytes + 1,
          content: "AAAA",
        }
      : file,
  );
  assert.equal(parseScienceFlowInputBundleRequest(bundle(oversize)).status, "invalid");
});

test("BUNDLE-S07 the stored manifest validates without content", () => {
  const parsed = parseScienceFlowInputBundleRequest(bundle());
  if (parsed.status !== "ok") assert.fail("expected a valid bundle");
  const stored = parseScienceFlowInputBundleManifest({
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    files: parsed.manifest.files,
  });
  assert.equal(stored.status, "ok");
  assert.equal(
    parseScienceFlowInputBundleManifest({ ...parsed.manifest, content: "x" }).status,
    "invalid",
  );
});
