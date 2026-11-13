// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ScienceFlowInputBundleEntry,
  type ScienceFlowInputBundleRequest,
  type ScienceFlowInputFileRole,
} from "@sciencediscovery/schema";

import {
  RunnerScienceFlowInputBundles,
  ScienceFlowInputBundleError,
} from "./scienceflow-input-bundles.js";

const CONTRACT_DIGEST = "a".repeat(64);

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function dataDir(): Promise<string> {
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  return mkdtemp(resolve(process.cwd(), ".tmp", "scienceflow-input-bundles-"));
}

function entry(
  path: string,
  roles: readonly ScienceFlowInputFileRole[],
  content: string,
): ScienceFlowInputBundleEntry {
  return {
    path,
    roles,
    size: Buffer.byteLength(content),
    sha256: digest(Buffer.from(content, "utf8")),
    content: Buffer.from(content, "utf8").toString("base64"),
  };
}

function bundle(
  entries: readonly ScienceFlowInputBundleEntry[] = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
  ],
): ScienceFlowInputBundleRequest {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const files = sorted.map(({ content: _content, ...file }) => file);
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    files,
  };
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    bundleDigest: digest(Buffer.from(canonicalScienceFlowInputBundleManifest(manifest), "utf8")),
    entries: sorted,
  };
}

test("BUNDLE-R01 a verified bundle is materialized only after publication", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);
  const request = bundle();

  assert.equal((await store.status(request.bundleDigest)).status, "missing");
  const publication = await store.put(request);
  assert.equal(publication.bundleDigest, request.bundleDigest);
  assert.equal(publication.contractDigest, CONTRACT_DIGEST);
  assert.equal(publication.fileCount, 4);
  assert.equal(
    publication.totalBytes,
    request.entries.reduce((total, file) => total + file.size, 0),
  );

  const status = await store.status(request.bundleDigest);
  assert.equal(status.status, "ready");
  assert.equal(status.bundleDigest, request.bundleDigest);
  assert.equal(status.contractDigest, CONTRACT_DIGEST);
  assert.equal(status.fileCount, 4);

  // The bytes are exactly what was sent, and the tree is complete.
  assert.equal(
    await readFile(
      resolve(root, ".scienceflow-input-bundles", request.bundleDigest, "package/evaluate.py"),
      "utf8",
    ),
    "def score():\n  return 0\n",
  );
  // Staging is private and empty after a successful publication.
  assert.deepEqual(await readdir(resolve(root, ".scienceflow-input-bundle-staging")), []);
  // Nothing was written into a Session-style workspace namespace.
  await assert.rejects(lstat(resolve(root, "projects")), /ENOENT/);
});

test("BUNDLE-R02 a corrupt snapshot is reported and never overwritten", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);
  const request = bundle();
  await store.put(request);

  const file = resolve(
    root,
    ".scienceflow-input-bundles",
    request.bundleDigest,
    "package/task.yaml",
  );
  await chmod(file, 0o644);
  await writeFile(file, "tampered\n");

  assert.equal((await store.status(request.bundleDigest)).status, "corrupt");
  await assert.rejects(
    store.put(request),
    (error: unknown) =>
      error instanceof ScienceFlowInputBundleError && error.kind === "corrupt",
  );
  // The damaged content is preserved for inspection, not silently resigned.
  assert.equal(await readFile(file, "utf8"), "tampered\n");
});

test("BUNDLE-R03 an extra file, symlink, or replaced manifest is corrupt", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);

  const extra = bundle();
  await store.put(extra);
  const extraRoot = resolve(root, ".scienceflow-input-bundles", extra.bundleDigest);
  await writeFile(resolve(extraRoot, "package/extra.py"), "x\n");
  assert.equal((await store.status(extra.bundleDigest)).status, "corrupt");

  const linked = bundle([
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/shared.yaml", ["shared_task_defaults"], "shared\n"),
  ]);
  await store.put(linked);
  const linkedRoot = resolve(root, ".scienceflow-input-bundles", linked.bundleDigest);
  const target = resolve(root, "outside.yaml");
  await writeFile(target, "shared\n");
  await rm(resolve(linkedRoot, "package/shared.yaml"));
  await symlink(target, resolve(linkedRoot, "package/shared.yaml"));
  assert.equal((await store.status(linked.bundleDigest)).status, "corrupt");

  const manifest = bundle([
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/other.py", ["evaluator"], "other\n"),
  ]);
  await store.put(manifest);
  const manifestRoot = resolve(
    root,
    ".scienceflow-input-bundles",
    manifest.bundleDigest,
  );
  const stored = JSON.parse(
    await readFile(resolve(manifestRoot, ".input-bundle.json"), "utf8"),
  ) as { files: Array<{ path: string }> };
  stored.files[0]!.path = "manifest-renamed.yaml";
  const storedManifest = resolve(manifestRoot, ".input-bundle.json");
  await chmod(storedManifest, 0o644);
  await writeFile(storedManifest, JSON.stringify(stored));
  assert.equal((await store.status(manifest.bundleDigest)).status, "corrupt");
});

test("BUNDLE-R04 the sender's digest is re-derived, not trusted", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);

  const forged = { ...bundle(), bundleDigest: "b".repeat(64) };
  await assert.rejects(
    store.put(forged),
    (error: unknown) =>
      error instanceof ScienceFlowInputBundleError && error.kind === "invalid",
  );
  await assert.rejects(
    lstat(resolve(root, ".scienceflow-input-bundles", bundle().bundleDigest)),
    /ENOENT/,
  );

  const valid = bundle();
  const wrongBytes = {
    ...valid,
    entries: valid.entries.map((file) =>
      file.path === "package/evaluate.py"
        ? { ...file, content: Buffer.from("other\n").toString("base64") }
        : file,
    ),
  };
  // The manifest digest changes with the content only through the entry's own
  // digest: here the claim is stale, so the digest no longer matches.
  await assert.rejects(
    store.put(wrongBytes),
    (error: unknown) =>
      error instanceof ScienceFlowInputBundleError && error.kind === "invalid",
  );

  const sizeLie = {
    ...valid,
    entries: valid.entries.map((file) =>
      file.path === "package/evaluate.py" ? { ...file, size: file.size + 1 } : file,
    ),
  };
  await assert.rejects(
    store.put(sizeLie),
    (error: unknown) =>
      error instanceof ScienceFlowInputBundleError && error.kind === "invalid",
  );
  await assert.rejects(
    lstat(resolve(root, ".scienceflow-input-bundles", valid.bundleDigest)),
    /ENOENT/,
  );
  // Staging is either absent or empty: a rejected bundle leaves nothing behind.
  const staging = await readdir(
    resolve(root, ".scienceflow-input-bundle-staging"),
  ).catch(() => [] as string[]);
  assert.deepEqual(staging, []);
});

test("BUNDLE-R05 a repeated or concurrent transfer reuses one complete tree", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);
  const request = bundle();

  const [first, second, third] = await Promise.all([
    store.put(request),
    store.put(request),
    store.put(request),
  ]);
  assert.equal(first.bundleDigest, request.bundleDigest);
  assert.equal(second.bundleDigest, request.bundleDigest);
  assert.equal(third.bundleDigest, request.bundleDigest);

  const roots = await readdir(resolve(root, ".scienceflow-input-bundles"));
  assert.deepEqual(roots, [request.bundleDigest]);
  assert.deepEqual(await readdir(resolve(root, ".scienceflow-input-bundle-staging")), []);
  assert.equal((await store.status(request.bundleDigest)).status, "ready");
});

test("BUNDLE-R06 a traversal-shaped path never reaches the filesystem", async (context) => {
  const root = await dataDir();
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunnerScienceFlowInputBundles(root);

  const escaping = {
    ...bundle(),
    entries: [
      entry("manifest.yaml", ["manifest"], "manifest\n"),
      entry("../escape.yaml", ["task_yaml"], "id: t\n"),
      entry("package/description.md", ["description"], "description\n"),
      entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    ],
  };
  await assert.rejects(
    store.put(escaping),
    (error: unknown) =>
      error instanceof ScienceFlowInputBundleError && error.kind === "invalid",
  );
  await assert.rejects(lstat(resolve(root, "escape.yaml")), /ENOENT/);
});
