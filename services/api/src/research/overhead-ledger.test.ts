// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { captureResearchUsage, summarizeResearchUsage, summarizeResearchOverhead } from "./overhead-ledger.js";
test("preparation overhead retains failures and unknown probe/time coverage", () => {
  assert.deepEqual(summarizeResearchOverhead([
    { outcome: "succeeded", wallClock: { status: "known", seconds: 0 }, probe: { status: "known", evaluations: 2 } },
    { outcome: "failed", wallClock: { status: "unknown", seconds: 0 }, probe: { status: "unknown", evaluations: 0 } },
  ]), { attempts: 2, succeeded: 1, failed: 1, knownSeconds: 0, unknown: 1, probeEvaluations: 2, unknownProbes: 1 });
});
test("provider missing usage and absent records remain distinguishable from zero-token calls", () => {
  const usage = captureResearchUsage([{ usageStatus: "reported", inputTokens: 0, outputTokens: 0 },
    { usageStatus: "reported", inputTokens: 5, outputTokens: null }]);
  assert.equal(usage.status, "partially-known"); assert.equal(usage.unknownUsageCalls, 1); assert.equal(usage.inputTokens, 0);
  assert.equal(summarizeResearchUsage([captureResearchUsage([])]).status, "not-recorded");
  assert.equal(captureResearchUsage([{ usageStatus: "reported", inputTokens: 0, outputTokens: 0 }]).status, "known");
});
