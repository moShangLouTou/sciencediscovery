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
 * Engine substitution through the production research service.
 *
 * A fake adapter is injected where ScienceFlow normally sits. It runs no Python,
 * reads no ScienceFlow paths and generates no model configuration. The service's
 * own acceptance, operation identity, cancellation ownership and delivery
 * retry still apply, which is exactly what a second engine (for example an HTTP
 * MCP adapter) would rely on.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { SessionStore } from "../store.js";
import { createLocalResearchService, type LocalResearchServiceDependencies } from "./local-research.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import {
  isTerminalResearchState,
  type ScienceFlowLocalResearchDelivery,
  type ScienceFlowLocalResearchOperation,
} from "./local-research-record.js";
import type {
  ResearchEngineAdapter,
  ResearchLifecycleTransitions,
  ResearchOperationWriter,
} from "../research/engine-adapter.js";

const NOW = "2026-11-20T10:00:00.000Z";
const TASK = "fake-task";

interface Fixture {
  readonly projectId: string;
  readonly root: string;
  readonly sessionId: string;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly store: SessionStore;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-engine-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Engine substitution");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Fake engine session", { modelId: model.id });
  const seedDir = join(root, "seed");
  const workRoot = join(root, "work");
  const privateRoot = join(root, "private");
  await Promise.all([
    mkdir(seedDir, { recursive: true }),
    mkdir(workRoot, { recursive: true }),
    mkdir(privateRoot, { recursive: true }),
  ]);
  return {
    projectId: project.id,
    root,
    sessionId: session.id,
    settings: {
      defaults: {
        bashTimeoutSec: 60,
        codeMaxTokens: 1_024,
        feedbackMaxTokens: 1_024,
        httpTimeoutSec: 60,
        maxSteps: 8,
        observeMaxWaitMs: 500,
        reportBudgetSec: 60,
        researchBudgetSec: 240,
        stageCaptureMax: 3,
        totalAllowanceSec: 320,
      },
      engineCheckout: join(root, "engine"),
      privateRoot,
      profileId: "fake-engine",
      pythonExecutable: join(root, "python-not-used"),
      readerScriptPath: join(root, "snapshot.py"),
      refusePackageInstall: true,
      seedDir,
      task: TASK,
      taskDescription: "Run the fake engine.",
      workRoot,
    },
    store,
  };
}

const transitions: ResearchLifecycleTransitions<ScienceFlowLocalResearchOperation> = {
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

function fakeDelivery(record: ScienceFlowLocalResearchOperation): ScienceFlowLocalResearchDelivery {
  return {
    attempts: record.delivery.attempts + 1,
    lowerIsBetter: false,
    metricName: "fake_metric",
    metricValue: 1,
    selectedStageId: "fake-stage",
    state: "delivered",
    updatedAt: NOW,
  };
}

interface FakeEngineHooks {
  /** Keep the run live after launch instead of finishing it. */
  readonly stayRunning?: boolean;
  /** Throw on the first N deliveries, then succeed. */
  readonly deliveryFailures?: number;
}

function fakeEngine(hooks: FakeEngineHooks = {}) {
  const calls = {
    confirmStop: 0,
    deliver: 0,
    launch: 0,
    observe: 0,
    prepare: 0,
    requestStop: 0,
  };
  let remainingFailures = hooks.deliveryFailures ?? 0;
  const adapter: ResearchEngineAdapter<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery> = {
    engine: "fake-engine",
    transitions,
    async prepare(record) {
      calls.prepare += 1;
      return { proceed: true, record };
    },
    beforeLaunch(record) {
      return { record };
    },
    async launch(record, writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>) {
      calls.launch += 1;
      const running = writer.mutate(record.operationId, (current) => ({
        ...current,
        engine: { status: "running" },
        state: "running",
      }));
      if (hooks.stayRunning) return { engineRunId: record.engineRunId, record: running };
      const completed = writer.mutate(record.operationId, (current) => ({
        ...current,
        engine: { status: "completed" },
        progress: { ...current.progress, observedAt: NOW },
        state: "completed",
      }));
      return { engineRunId: record.engineRunId, record: completed };
    },
    async inspect(record) {
      return {
        engineRecordObserved: true,
        engineTerminal: isTerminalResearchState(record.state),
        record,
      };
    },
    async observe(record) {
      calls.observe += 1;
      return {
        engineRecordObserved: true,
        engineTerminal: isTerminalResearchState(record.state),
        record,
        stateAfterObservation: record.state,
      };
    },
    async requestStop() {
      calls.requestStop += 1;
      return {};
    },
    async confirmStop() {
      calls.confirmStop += 1;
      return true;
    },
    async deliver(record) {
      calls.deliver += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("fake engine publication broke");
      }
      return fakeDelivery(record);
    },
  };
  return { adapter, calls };
}

function serviceFor(
  target: Fixture,
  adapter: ResearchEngineAdapter<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery>,
  dependencies: LocalResearchServiceDependencies = {},
) {
  return createLocalResearchService(
    { settings: target.settings, store: target.store },
    { adapter, ...dependencies },
  );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.ok(predicate(), message);
}

function latestRecord(target: Fixture, service: ReturnType<typeof createLocalResearchService>) {
  const record = service.latest(target.projectId, target.sessionId);
  assert.ok(record, "the fixture operation must exist");
  return record;
}

function startInput(target: Fixture) {
  return {
    intent: "Run the fake engine end to end.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  };
}

test("a fake non-ScienceFlow adapter runs the shared lifecycle", async (context) => {
  const target = await fixture(context);
  const { adapter, calls } = fakeEngine();
  const service = serviceFor(target, adapter);
  const started = await service.start(startInput(target));
  assert.equal(started.attached, false);
  assert.match(started.operation.engineRunId, /^sd-research-/);

  await waitFor(
    () => service.latest(target.projectId, target.sessionId)?.delivery.state === "delivered",
    "the fake engine result must be delivered",
  );
  const record = latestRecord(target, service);
  assert.equal(record.state, "completed");
  assert.equal(record.engine.status, "completed");
  assert.equal(record.delivery.state, "delivered");
  assert.equal(record.delivery.metricName, "fake_metric");
  assert.equal(calls.launch, 1);
  assert.equal(calls.deliver, 1);
});

test("a cancelled conversation stops before the fake engine launches", async (context) => {
  const target = await fixture(context);
  const { adapter, calls } = fakeEngine();
  let checks = 0;
  const service = serviceFor(target, adapter, {
    // The start sees a live conversation; the background worker sees a cancel.
    ownerRunStatus: async () => {
      checks += 1;
      return checks === 1 ? "running" : "cancelled";
    },
  });
  await service.start(startInput(target));
  await waitFor(
    () => service.latest(target.projectId, target.sessionId)?.state === "stopped",
    "the cancelled conversation must leave the operation stopped",
  );
  const record = latestRecord(target, service);
  assert.equal(record.stop.requestedBy, "conversation-cancel");
  assert.equal(calls.prepare, 0);
  assert.equal(calls.launch, 0, "a cancelled conversation must not reach the engine");
});

test("stop goes through the adapter and records the confirmed termination", async (context) => {
  const target = await fixture(context);
  const { adapter, calls } = fakeEngine({ stayRunning: true });
  const service = serviceFor(target, adapter);
  const started = await service.start(startInput(target));
  await waitFor(
    () => service.latest(target.projectId, target.sessionId)?.state === "running",
    "the fake engine must report the run running",
  );
  const stopped = await service.stop({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(stopped.requested, true);
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.operation.state, "stopped");
  assert.ok(stopped.operation.stop.confirmedAt);
  assert.equal(calls.requestStop, 1);
  assert.equal(calls.confirmStop, 1);
  assert.equal(calls.launch, 1, "stopping must not start a second run");
});

test("delivery retry republishes through the adapter without relaunching the engine", async (context) => {
  const target = await fixture(context);
  const { adapter, calls } = fakeEngine({ deliveryFailures: 1 });
  const service = serviceFor(target, adapter);
  const started = await service.start(startInput(target));
  await waitFor(
    () => service.latest(target.projectId, target.sessionId)?.delivery.state === "failed",
    "the first delivery failure must be visible",
  );
  const failed = latestRecord(target, service);
  assert.equal(failed.state, "completed");
  assert.equal(failed.delivery.reason, "publication-failed");
  assert.match(failed.delivery.message ?? "", /fake engine publication broke/);

  const retried = await service.retryDelivery({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(calls.launch, 1, "retrying publication must not rerun the experiment");
  assert.equal(calls.deliver, 2);
});

test("an asynchronous engine keeps delivery pending until a terminal observation", async (context) => {
  const target = await fixture(context);
  const { adapter, calls } = fakeEngine({ stayRunning: true });
  const service = serviceFor(target, adapter);
  const started = await service.start(startInput(target));
  const identity = {
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  };
  await waitFor(
    () => service.latest(target.projectId, target.sessionId)?.state === "running",
    "the asynchronous fake engine must report the run running",
  );
  // Let the worker leave its post-launch step before inspecting the record.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  const running = latestRecord(target, service);
  assert.equal(running.delivery.state, "pending");
  assert.equal(calls.deliver, 0, "a launch that returns while running must not publish a result");

  // The engine finishes outside this process; the next observation sees the
  // terminal record and publishes exactly once.
  target.store.scienceFlowResearchOperations.update({
    ...running,
    engine: { status: "completed" },
    progress: { ...running.progress, observedAt: NOW },
    state: "completed",
    updatedAt: NOW,
  });
  const observed = await service.get(identity, { waitMs: 0 });
  assert.equal(observed.state, "completed");
  assert.equal(observed.delivery.state, "delivered");
  assert.equal(calls.deliver, 1);

  // Another observation neither republishes nor relaunches.
  await service.get(identity, { waitMs: 0 });
  assert.equal(calls.deliver, 1);
  assert.equal(calls.launch, 1);

  // An explicit retry republishes only.
  const retried = await service.retryDelivery(identity);
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(calls.deliver, 2);
  assert.equal(calls.launch, 1);
});
