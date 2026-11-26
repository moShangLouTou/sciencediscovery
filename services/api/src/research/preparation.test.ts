// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { observeResearchPreparation } from "./preparation.js";
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
