// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withResearchPreparationWorkspace, observeResearchPreparation } from "./preparation.js";
test("preparation records actual time and result before returning", async () => {
  let clock = 0;
  const result = await observeResearchPreparation({ now: () => new Date(clock).toISOString(),
    work: async () => { clock += 3500; return "prepared-input-version"; }, record: (event) => {
      assert.equal(event.outcome, "succeeded"); assert.equal(event.elapsedSeconds, 3.5);
    } });
  assert.equal(result, "prepared-input-version");
});
test("failed preparation records unknown cost without swallowing the original failure", async () => {
  const failure = new Error("preparation failed");
  let recorded = false;
  await assert.rejects(observeResearchPreparation({ now: () => "invalid-clock",
    work: async () => { throw failure; }, record: (event) => {
      assert.equal(event.outcome, "failed"); assert.equal(event.elapsedSeconds, null); recorded = true;
    } }), (error) => error === failure);
  assert.equal(recorded, true);
});

test("a failed probe cleans its private preparation workspace and preserves the error", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sd-preparation-"));
  let workspace = "";
  const failure = new Error("probe refused");
  try {
    await assert.rejects(withResearchPreparationWorkspace(parent, async (root) => {
      workspace = root;
      await writeFile(join(root, "input.txt"), "frozen");
      assert.equal(await readFile(join(root, "input.txt"), "utf8"), "frozen");
      throw failure;
    }), (error) => error === failure);
    assert.notEqual(workspace, "");
    await assert.rejects(stat(workspace), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
