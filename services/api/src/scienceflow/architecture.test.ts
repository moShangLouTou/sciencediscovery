// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
test("SF execution transport has no preparation, budget policy or publication responsibilities", async () => {
  const source = await readFile(new URL("./engine-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /stageResearchOperationInputs|materializePreparedTaskAssets|writeDeliveryRecord|publishArtifactVersion|applyScienceFlowLaunchGrant|beforeLaunch\s*\(|async prepare\s*\(|async deliver\s*\(/);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:result-delivery|operation-policy|operation-preparation|operation-delivery|execution-service|local-research\.js)["']/);
  assert.match(source, /runResearchPilotEngine/);
});
test("SF experiment domain modules have no process, persistence or engine-transport imports", async () => {
  const directory = new URL("./domain/", import.meta.url);
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = await readFile(new URL(file, directory), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:(?:fs|child_process|sqlite)|[^"']*(?:research-pilot|result-delivery|engine-adapter|local-research\.js|store\.js))["']/u, file);
  }
});
