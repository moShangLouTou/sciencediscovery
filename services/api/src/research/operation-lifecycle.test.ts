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
 * The shared research-operation lifecycle, exercised with a fake engine.
 *
 * These cases do not touch ScienceFlow: they pin the engine-neutral rules a
 * second adapter relies on — a preparation-window stop or a cancelled owning
 * conversation never reaches launch, a launch error is recorded once, a
 * terminal observation publishes at most what it should, and a delivery retry
 * never starts the engine again.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import type {
  ResearchDeliveryProgress,
  ResearchEngineAdapter,
  ResearchEngineInspection,
  ResearchEngineObservation,
  ResearchLifecycleTransitions,
  ResearchOperationRecord,
  ResearchOperationWriter,
} from "./engine-adapter.js";
import {
  createResearchOperationLifecycle,
  type ResearchOperationLifecycleOptions,
} from "./operation-lifecycle.js";

const NOW = "2026-11-20T10:00:00.000Z";

interface FakeDelivery extends ResearchDeliveryProgress {
  readonly detail?: string;
}

interface FakeRecord extends ResearchOperationRecord<FakeDelivery> {
  readonly error?: { readonly step: string; readonly message: string };
  readonly updatedAt: string;
}

const transitions: ResearchLifecycleTransitions<FakeRecord> = {
  deliveryFailed(record, message) {
    return {
      ...record,
      delivery: {
        attempts: record.delivery.attempts + 1,
        message,
        reason: "publication-failed",
        state: "failed",
        updatedAt: NOW,
      },
    };
  },
  failed(record, step, message) {
    return { ...record, state: "failed", error: { message, step } };
  },
  stopped(record) {
    return { ...record, state: "stopped" };
  },
  stoppedByConversation(record, at) {
    return {
      ...record,
      state: "stopped",
      stop: record.stop.requestedAt
        ? record.stop
        : { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" },
    };
  },
  stopping(record, at, requestedBy) {
    return {
      ...record,
      state: record.state === "completed" || record.state === "failed" ? record.state : "stopping",
      stop: { ...record.stop, requestedAt: at, requestedBy },
    };
  },
  stopRequestedByConversation(record, at) {
    return { ...record, stop: { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" } };
  },
  stopResult(record, at, result) {
    return {
      ...record,
      state: result.confirmed ? "stopped" : record.state,
      engine: { ...record.engine, ...(result.confirmed ? { status: "stopped" } : {}) },
      stop: {
        ...record.stop,
        ...(result.confirmed ? { confirmedAt: at, engineStatus: "stopped" } : {}),
        ...(result.error ? { lastError: result.error } : {}),
      },
    };
  },
  unknown(record) {
    return { ...record, state: "unknown" };
  },
};

function fakeRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    delivery: { attempts: 0, state: "pending", updatedAt: NOW },
    engine: {},
    identity: { projectId: "project-1", sessionId: "session-1" },
    operationId: "operation-1",
    ownerRunId: "conversation-run-1",
    state: "accepted",
    stop: {},
    updatedAt: NOW,
    ...overrides,
  };
}

class MemoryOperations implements ResearchOperationWriter<FakeRecord> {
  readonly rows = new Map<string, FakeRecord>();

  put(record: FakeRecord): FakeRecord {
    this.rows.set(record.operationId, record);
    return record;
  }

  get(operationId: string): FakeRecord | undefined {
    return this.rows.get(operationId);
  }

  mutate(operationId: string, change: (current: FakeRecord) => FakeRecord): FakeRecord {
    const current = this.rows.get(operationId);
    assert.ok(current, `operation ${operationId} must exist`);
    const next = { ...change(current), updatedAt: NOW };
    this.rows.set(operationId, next);
    return next;
  }
}

/** The fixture operation, asserted present so callers narrow without `!`. */
function stored(operations: MemoryOperations): FakeRecord {
  const record = operations.get("operation-1");
  assert.ok(record, "the fixture operation must exist");
  return record;
}

interface FakeHooks {
  readonly prepare?: (
    record: FakeRecord,
    writer: ResearchOperationWriter<FakeRecord>,
  ) => Promise<{ readonly record: FakeRecord; readonly proceed: boolean }>;
  readonly launch?: (
    record: FakeRecord,
    writer: ResearchOperationWriter<FakeRecord>,
  ) => Promise<{ readonly record: FakeRecord; readonly engineRunId: string | null }>;
  readonly observe?: (
    record: FakeRecord,
    writer: ResearchOperationWriter<FakeRecord>,
  ) => Promise<ResearchEngineObservation<FakeRecord>>;
  readonly inspect?: (record: FakeRecord) => Promise<ResearchEngineInspection<FakeRecord>>;
  readonly requestStop?: () => Promise<{ readonly error?: string }>;
  readonly confirmStop?: () => Promise<boolean>;
  readonly deliver?: (record: FakeRecord) => Promise<FakeDelivery>;
}

function fakeAdapter(hooks: FakeHooks = {}) {
  const calls = { confirmStop: 0, deliver: 0, launch: 0, observe: 0, prepare: 0, requestStop: 0 };
  const adapter: ResearchEngineAdapter<FakeRecord, FakeDelivery> = {
    engine: "fake",
    transitions,
    async prepare(record, _signal, writer) {
      calls.prepare += 1;
      return hooks.prepare ? await hooks.prepare(record, writer) : { proceed: true, record };
    },
    beforeLaunch(record) {
      return { record };
    },
    async launch(record, writer) {
      calls.launch += 1;
      return hooks.launch
        ? await hooks.launch(record, writer)
        : { engineRunId: record.operationId, record };
    },
    async inspect(record) {
      return hooks.inspect
        ? await hooks.inspect(record)
        : { engineRecordObserved: false, engineTerminal: false, record };
    },
    async observe(record, writer) {
      calls.observe += 1;
      return hooks.observe
        ? await hooks.observe(record, writer)
        : {
            engineRecordObserved: false,
            engineTerminal: false,
            record,
            stateAfterObservation: record.state,
          };
    },
    async requestStop() {
      calls.requestStop += 1;
      return hooks.requestStop ? await hooks.requestStop() : {};
    },
    async confirmStop() {
      calls.confirmStop += 1;
      return hooks.confirmStop ? await hooks.confirmStop() : true;
    },
    async deliver(record) {
      calls.deliver += 1;
      if (hooks.deliver) return await hooks.deliver(record);
      return {
        attempts: record.delivery.attempts + 1,
        state: "delivered",
        updatedAt: NOW,
      };
    },
  };
  return { adapter, calls };
}

function lifecycleFor(
  operations: MemoryOperations,
  adapter: ResearchEngineAdapter<FakeRecord, FakeDelivery>,
  overrides: Partial<ResearchOperationLifecycleOptions<FakeRecord, FakeDelivery>> = {},
) {
  const events: string[] = [];
  const lifecycle = createResearchOperationLifecycle<FakeRecord, FakeDelivery>({
    engine: adapter,
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    now: () => NOW,
    observeMaxWaitMs: 0,
    onStopConfirmed: (_record, _at, requestedBy) => events.push(`confirmed:${requestedBy}`),
    onStopRequested: (_record, _at, requestedBy) => events.push(`requested:${requestedBy}`),
    onTerminal: () => events.push("terminal"),
    operations,
    ownerStopped: async () => false,
    sleep: async () => undefined,
    ...overrides,
  });
  return { events, lifecycle };
}

/** An observation of a record the fake engine reports as finished. */
function terminalObservation(record: FakeRecord, state: FakeRecord["state"]): ResearchEngineObservation<FakeRecord> {
  return { engineRecordObserved: true, engineTerminal: true, record, stateAfterObservation: state };
}

test("a stop recorded during preparation prevents the launch", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord());
  const { adapter, calls } = fakeAdapter({
    prepare: async (record, writer) => ({
      proceed: true,
      record: writer.mutate(record.operationId, (current) => ({
        ...current,
        stop: { requestedAt: NOW, requestedBy: "conversation-cancel" },
      })),
    }),
  });
  const { lifecycle } = lifecycleFor(operations, adapter);
  await lifecycle.execute("operation-1");
  assert.equal(calls.launch, 0, "a stopped preparation must not reach the engine");
  assert.equal(operations.get("operation-1")?.state, "stopped");
});

test("a cancelled owning conversation after preparation prevents the launch", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord());
  const { adapter, calls } = fakeAdapter();
  let checks = 0;
  const { lifecycle } = lifecycleFor(operations, adapter, {
    ownerStopped: async () => {
      checks += 1;
      return checks > 1;
    },
  });
  await lifecycle.execute("operation-1");
  assert.equal(calls.launch, 0);
  const record = operations.get("operation-1");
  assert.equal(record?.state, "stopped");
  assert.equal(record?.stop.requestedBy, "conversation-cancel");
});

test("a launch error is recorded once and the run is never relaunched by observation", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord());
  const { adapter, calls } = fakeAdapter({
    launch: async () => {
      throw new Error("engine unreachable");
    },
  });
  const { lifecycle } = lifecycleFor(operations, adapter);
  await lifecycle.execute("operation-1");
  const record = stored(operations);
  assert.equal(record.state, "failed");
  assert.deepEqual(record.error, { message: "engine unreachable", step: "launch" });
  assert.equal(calls.launch, 1);

  // Observing the failed operation does not call the engine again.
  const observed = await lifecycle.observe(record, { waitMs: 0 });
  assert.equal(observed.state, "failed");
  assert.equal(calls.launch, 1);
});

test("an unreadable launch with no worker becomes unknown and is never launched again", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord({ state: "running" }));
  const { adapter, calls } = fakeAdapter();
  const { lifecycle } = lifecycleFor(operations, adapter);
  const observed = await lifecycle.observe(stored(operations), { waitMs: 0 });
  assert.equal(observed.state, "unknown");
  assert.equal(calls.launch, 0);
});

test("a terminal observation delivers once; a failed retry is visible and republished", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord({ engine: { status: "completed" }, state: "completed" }));
  let failures = 1;
  const { adapter, calls } = fakeAdapter({
    deliver: async (record) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("publication broke");
      }
      return { attempts: record.delivery.attempts + 1, state: "delivered", updatedAt: NOW };
    },
    observe: async (record) => terminalObservation(record, "completed"),
  });
  const { events, lifecycle } = lifecycleFor(operations, adapter);

  const first = await lifecycle.observe(stored(operations), { waitMs: 0 });
  assert.equal(first.delivery.state, "failed");
  assert.equal(first.delivery.reason, "publication-failed");
  assert.equal(first.delivery.attempts, 1);
  assert.equal(events.filter((event) => event === "terminal").length, 1);

  const retried = await lifecycle.retryDelivery(first);
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(retried.delivery.attempts, 2);
  assert.equal(calls.launch, 0, "retrying publication must not start the engine");

  // An already delivered result is not republished by ordinary observation.
  await lifecycle.observe(retried, { waitMs: 0 });
  assert.equal(calls.deliver, 2);
});

test("stop requests the engine and records an unconfirmed stop without changing the experiment", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord({
    engine: { status: "running" },
    state: "running",
  }));
  const { adapter, calls } = fakeAdapter({
    confirmStop: async () => false,
    requestStop: async () => ({ error: "engine stop failed" }),
  });
  const { events, lifecycle } = lifecycleFor(operations, adapter);
  const outcome = await lifecycle.stop(stored(operations));
  assert.equal(outcome.requested, true);
  assert.equal(outcome.confirmed, false);
  assert.equal(calls.requestStop, 1);
  assert.equal(calls.confirmStop, 1);
  assert.equal(outcome.record.state, "stopping");
  assert.equal(outcome.record.stop.lastError, "engine stop failed");
  assert.deepEqual(events, ["requested:tool", "terminal"]);
});

test("stop on an already terminal engine run requests nothing and confirms the line stop", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord({ engine: { status: "stopped" }, state: "stopped" }));
  const { adapter, calls } = fakeAdapter({
    inspect: async (record) => ({
      engineRecordObserved: true,
      engineTerminal: true,
      record,
    }),
  });
  const { events, lifecycle } = lifecycleFor(operations, adapter);
  const outcome = await lifecycle.stop(stored(operations));
  assert.equal(outcome.requested, false);
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.reason, "already-terminal");
  assert.equal(calls.requestStop, 0);
  assert.deepEqual(events, ["confirmed:tool", "terminal"]);
});

test("reconciling a finished stored child publishes it without launching", async () => {
  const operations = new MemoryOperations();
  operations.put(fakeRecord({ engine: { status: "completed" }, state: "running" }));
  const { adapter, calls } = fakeAdapter({
    inspect: async (record) => ({
      engineRecordObserved: true,
      engineTerminal: true,
      record,
    }),
    observe: async (record, writer) => {
      const completed = writer.mutate(record.operationId, (current) => ({
        ...current,
        engine: { status: "completed" },
        state: "completed",
      }));
      return terminalObservation(completed, "completed");
    },
  });
  const { lifecycle } = lifecycleFor(operations, adapter);
  const reconciled = await lifecycle.reconcile([stored(operations)]);
  const [first] = reconciled;
  assert.ok(first, "the reconciled record must be returned");
  assert.equal(first.state, "completed");
  assert.equal(calls.deliver, 1);
  assert.equal(calls.launch, 0, "reconciliation must never start a run");
});
