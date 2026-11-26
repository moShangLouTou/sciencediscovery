// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { parseResearchInputBundleManifest, parseResearchInputBundleRequest } from "./research-input-bundle.js";
const file = { path: "facts.txt", roles: ["facts"], size: 1, sha256: "a".repeat(64) };
const manifest = { schemaVersion: 1, contractDigest: "b".repeat(64), files: [file] };
test("a neutral bundle carries ordinary files with product role labels", () => {
  assert.equal(parseResearchInputBundleManifest(manifest).status, "ok");
  assert.equal(parseResearchInputBundleManifest({ ...manifest, files: [file, { ...file, path: "second.txt" }] }).status, "ok");
  assert.equal(parseResearchInputBundleRequest({ schemaVersion: 1, contractDigest: manifest.contractDigest,
    bundleDigest: "c".repeat(64), entries: [{ ...file, content: "YQ==" }] }).status, "ok");
});
test("neutral bundles reject path escapes, duplicate paths, roles and malformed byte identities", () => {
  for (const changed of [
    { ...file, path: "../facts.txt" }, { ...file, path: "/facts.txt" },
    { ...file, roles: ["facts", "facts"] }, { ...file, roles: ["bad\nrole"] },
    { ...file, size: -1 }, { ...file, size: 2 ** 53 }, { ...file, sha256: "not-a-digest" },
  ]) assert.equal(parseResearchInputBundleManifest({ ...manifest, files: [changed] }).status, "invalid");
  assert.equal(parseResearchInputBundleManifest({ ...manifest, files: [file, file] }).status, "invalid");
  for (const content of ["YQ", "YR==", "YQ==ignored", "YWI="]) {
    assert.equal(parseResearchInputBundleRequest({ schemaVersion: 1, contractDigest: manifest.contractDigest,
      bundleDigest: "c".repeat(64), entries: [{ ...file, content }] }).status, "invalid");
  }
});
