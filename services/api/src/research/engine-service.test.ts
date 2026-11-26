// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ResearchEngineAdapter, ResearchOperationRecord, ResearchOperationWriter } from "./engine-adapter.js";
import { createResearchEngineService, type ResearchPreparationStep } from "./engine-service.js";

type Record = ResearchOperationRecord & { error?: { step: string; message: string } };
function fixture(steps: readonly ResearchPreparationStep<Record>[], ownerStopped = async () => false) {
  let record: Record = { operationId: "operation", ownerRunId: "conversation", identity: { projectId: "project", sessionId: "session" },
    state: "accepted", engine: {}, stop: {}, delivery: { state: "pending", attempts: 0, updatedAt: "now" } };
  const writer: ResearchOperationWriter<Record> = { get: () => record, mutate(_id, change) { record = change(record); return record; } };
  const transitions: ResearchEngineAdapter<Record, Record["delivery"]>["transitions"] = {
    stopped: (record) => ({ ...record, state: "stopped" }),
    stoppedByConversation: (record, at) => ({ ...record, state: "stopped", stop: { requestedAt: at, requestedBy: "conversation-cancel" } }),
    stopping: (record) => ({ ...record, state: "stopping" }), stopRequestedByConversation: (record) => record,
    stopResult: (record) => record, failed: (record, step, message) => ({ ...record, state: "failed", error: { step, message } }),
    unknown: (record) => ({ ...record, state: "unknown" }), deliveryFailed: (record) => record,
  };
  const service = createResearchEngineService({ preparation: steps, transitions, ownerStopped, now: () => "cancel-time",
    transport: { engine: "plain", async launch() { assert.fail("preparation must never launch"); },
      async inspect(record: Record) { return { record, engineRecordObserved: false, engineTerminal: false }; },
      async observe(record: Record) { return { record, stateAfterObservation: record.state, engineRecordObserved: false, engineTerminal: false }; },
      async requestStop() { return {}; }, async confirmStop() { return false; } },
    beforeLaunch: (record) => ({ record }), deliver: async (record) => record.delivery });
  return { service, writer, get record() { return record; } };
}

test("platform sequences steps and persists actionable failure, including thrown undefined", async () => {
  const seen: string[] = [];
  const f = fixture([{ name: "first", async run(record) { seen.push("first"); return record; } },
    { name: "probe", async run() { throw undefined; } }, { name: "publish", async run(record) { seen.push("publish"); return record; } }]);
  const result = await f.service.prepare(f.record, new AbortController().signal, f.writer);
  assert.equal(result.proceed, false); assert.deepEqual(seen, ["first"]);
  assert.deepEqual(result.record.error, { step: "probe", message: "undefined" });
});

test("stop during a failed asynchronous step wins and prevents later publication", async () => {
  let later = false;
  const f = fixture([{ name: "probe", async run(record, _signal, writer) {
    writer.mutate(record.operationId, (item) => ({ ...item, stop: { requestedAt: "tool-time", requestedBy: "tool" } }));
    throw new Error("probe failed after stop");
  } }, { name: "publish", async run(record) { later = true; return record; } }]);
  const result = await f.service.prepare(f.record, new AbortController().signal, f.writer);
  assert.equal(result.proceed, false); assert.equal(result.record.state, "stopped");
  assert.equal(result.record.stop.requestedBy, "tool"); assert.equal(result.record.error, undefined); assert.equal(later, false);
});

test("abort arriving during owner lookup prevents the first step", async () => {
  const controller = new AbortController(); let prepared = false;
  const f = fixture([{ name: "prepare", async run(record) { prepared = true; return record; } }], async () => { controller.abort(); return false; });
  const result = await f.service.prepare(f.record, controller.signal, f.writer);
  assert.equal(result.proceed, false); assert.equal(prepared, false);
  assert.equal(result.record.stop.requestedBy, "conversation-cancel");
});
