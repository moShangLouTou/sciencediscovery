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
 * The shared research task service, exercised end to end by a fake engine.
 *
 * This suite imports only the shared research modules and the platform's public
 * store. The fake engine has no ScienceFlow configuration, model profile,
 * Python checkout, seed or evaluator, and its result is an ordinary file with a
 * verified digest. The cases run through the real task entry, a real SQLite
 * operation repository and the real CAS/Artifact publication path: submit,
 * deduplicate, launch, observe, reopen the service, cancel, reserve budget and
 * deliver.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

import { SessionStore } from "../store.js";
import { publishArtifactVersion } from "./artifact-publisher.js";
import {
  RESEARCH_BUDGET_LINE_VERSION,
  type ResearchBudgetLine,
} from "./budget.js";
import type {
  ResearchDeliveryProgress,
  ResearchEngineAdapter,
  ResearchEngineInspection,
  ResearchEngineObservation,
  ResearchLifecycleTransitions,
  ResearchOperationWriter,
  ResearchStopRequester,
} from "./engine-adapter.js";
import {
  ResearchOperationCorruptError,
  assertResearchTaskRecordEnvelope,
  isPlainRecord,
  type ResearchOperationCodec,
  type ResearchTaskRecord,
} from "./task-record.js";
import { ResearchTaskRepository } from "./task-repository.js";
import {
  createResearchTaskService,
  type ResearchLineFacts,
  type ResearchTaskLineStore,
  type ResearchStartPlan,
  type ResearchTaskProduct,
  type ResearchTaskService,
} from "./task-service.js";

const FAKE_VERSION = 7;
const ENGINE_ID = "fake-engine";
const LINE_ID = "fake-line";
const LINE_KEY = "fake-line";

interface FakeDelivery extends ResearchDeliveryProgress {
  readonly artifactVersionId?: string;
}

interface FakeRecord extends ResearchTaskRecord<FakeDelivery> {
  readonly intent: string;
  readonly launchAllowanceSec?: number;
  readonly engineId?: string;
  readonly engine: { readonly status?: string; readonly elapsedSec?: number };
}

interface FakeView {
  readonly operationId: string;
  readonly state: string;
  readonly engineStatus: string | null;
  readonly delivery: string;
  readonly artifactVersionId: string | null;
}

class FakeRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "FakeRefusal";
    this.reason = reason;
  }
}

interface EngineRun {
  status: "running" | "completed" | "failed" | "stopped";
  elapsedSec?: number;
}

interface ServiceTestOptions {
  readonly ownerStopped?: () => Promise<boolean>;
  readonly hideEngineRecords?: boolean;
  readonly now?: () => string;
  readonly planBarrier?: () => Promise<void>;
  readonly prepare?: ResearchEngineAdapter<FakeRecord, FakeDelivery>["prepare"];
  readonly ignoreBudget?: boolean;
}

interface Fixture {
  readonly root: string;
  readonly store: SessionStore;
  readonly projectId: string;
  readonly sessionId: string;
  readonly repository: ResearchTaskRepository<FakeRecord>;
  readonly lines: ResearchTaskLineStore<FakeRecord>;
  readonly engineRuns: Map<string, EngineRun>;
  readonly counters: { launches: number; deliverCalls: number; failDelivery: boolean; engineRecordsVisible: boolean };
  readonly service: ResearchTaskService<FakeRequest, FakeRecord, FakeView>;
  readonly budget: { maxChildRuns: number; totalAllowanceSec: number } | undefined;
  readonly newService: (options?: ServiceTestOptions) => ResearchTaskService<FakeRequest, FakeRecord, FakeView>;
}

interface FakeRequest {
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
  readonly intent: string;
  readonly allowanceSec?: number;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the fake engine");
    await sleep(5);
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(
  context: TestContext,
  budget?: { maxChildRuns: number; totalAllowanceSec: number },
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-research-task-service-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Fake engine project");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Fake engine session", { modelId: model.id });

  const database = new DatabaseSync(join(root, "research.sqlite"));
  context.after(() => database.close());
  const repository = new ResearchTaskRepository<FakeRecord>(database, {
    codec: fakeCodec,
    table: "fake_research_operations",
  });
  const lines = new SqliteLineStore(database);
  const engineRuns = new Map<string, EngineRun>();
  const counters = { deliverCalls: 0, engineRecordsVisible: true, failDelivery: false, launches: 0 };

  const createService = (options: ServiceTestOptions = {}): ResearchTaskService<FakeRequest, FakeRecord, FakeView> => {
    const baseEngine = fakeEngine(store, engineRuns, counters, () => options.hideEngineRecords ?? false);
    const engine = { ...baseEngine,
      ...(options.prepare ? { prepare: options.prepare } : {}),
      ...(options.ignoreBudget ? { beforeLaunch: (record: FakeRecord) => ({ record }) } : {}),
    };
    const product: ResearchTaskProduct<FakeRequest, FakeDelivery, FakeRecord, FakeView> = {
      authorize: () => undefined,
      afterObserve: () => undefined,
      capabilities: {
        asynchronousLaunch: true,
        confirmsStop: true,
        delivers: "one plain text result file",
        reportsElapsedSec: true,
        reportsTokenUsage: false,
      },
      engine,
      engineId: ENGINE_ID,
      idempotencyKey: (request) => dedupeKey(request),
      lineFactsFor: (record) => lineFacts(repository, lines, record, budget),
      list: (_projectId, _sessionId, records) => records.map((record) => present(record)),
      planStart: async (
        request,
        contextValue,
      ): Promise<ResearchStartPlan<FakeRecord>> => {
        const operationId = contextValue.newOperationId();
        const createdAt = contextValue.now();
        const key = dedupeKey(request);
        const existing = contextValue.operations.findByIdempotency(
          request.projectId,
          request.sessionId,
          key,
        );
        if (existing) return { attachTo: existing };
        const children = contextValue.operations
          .listForSession(request.projectId, request.sessionId)
          .map((row) => childFacts(row));
        await options.planBarrier?.();
        const record: FakeRecord = {
          createdAt,
          delivery: { attempts: 0, state: "pending", updatedAt: createdAt },
          engine: {},
          engineId: ENGINE_ID,
          engineRunId: null,
          idempotencyKey: key,
          identity: { projectId: request.projectId, sessionId: request.sessionId },
          intent: request.intent,
          operationId,
          ownerRunId: request.ownerRunId,
          schemaVersion: FAKE_VERSION,
          state: "accepted",
          stop: {},
          updatedAt: createdAt,
        };
        return {
          dedupeKey: key,
          line: {
            allowanceSec: request.allowanceSec ?? 60,
            children,
            ...(budget === undefined ? {} : { limits: budget }),
            lineId: LINE_ID,
            lineKey: LINE_KEY,
          },
          record,
        };
      },
      present: (record) => present(record),
      refuse: (reason, message) => new FakeRefusal(reason, message),
      requestIdentity: (request) => ({
        ownerRunId: request.ownerRunId,
        projectId: request.projectId,
        sessionId: request.sessionId,
      }),
    };
    return createResearchTaskService<FakeRequest, FakeDelivery, FakeRecord, FakeView>({
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)).slice(0, 200),
      lines,
      observeMaxWaitMs: 100,
      ...(options.now ? { now: options.now } : {}),
      ...(options.ownerStopped ? { ownerStopped: options.ownerStopped } : {}),
      operations: repository,
      product,
      store,
    });
  };

  return {
    budget,
    counters,
    engineRuns,
    lines,
    newService: createService,
    projectId: project.id,
    repository,
    root,
    service: createService(),
    sessionId: session.id,
    store,
  };
}

const fakeCodec: ResearchOperationCodec<FakeRecord> = {
  decode(value, row): FakeRecord {
    assertResearchTaskRecordEnvelope(value, row, FAKE_VERSION);
    if (!isPlainRecord(value) || typeof value.intent !== "string") {
      throw new ResearchOperationCorruptError();
    }
    return value as unknown as FakeRecord;
  },
  encode: (record) => record,
  schemaVersion: FAKE_VERSION,
};

class SqliteLineStore implements ResearchTaskLineStore<FakeRecord> {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS fake_research_lines (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        line_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id, line_key)
      )
    `);
  }

  get(projectId: string, sessionId: string, lineKey: string): ResearchBudgetLine | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM fake_research_lines WHERE project_id = ? AND session_id = ? AND line_key = ?")
      .get(projectId, sessionId, lineKey) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ResearchBudgetLine : undefined;
  }

  put(line: ResearchBudgetLine, _record: FakeRecord): void {
    this.database
      .prepare(
        `INSERT INTO fake_research_lines (project_id, session_id, line_key, record_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, line_key) DO UPDATE SET record_json = excluded.record_json`,
      )
      .run(line.identity.projectId, line.identity.sessionId, line.lineKey, JSON.stringify(line));
  }
}

function dedupeKey(request: FakeRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      intent: request.intent,
      ownerRunId: request.ownerRunId,
      projectId: request.projectId,
      sessionId: request.sessionId,
    }))
    .digest("hex");
}

function childFacts(record: FakeRecord) {
  return {
    createdAt: record.createdAt,
    ...(record.engine.elapsedSec === undefined ? {} : { elapsedSec: record.engine.elapsedSec }),
    launched: record.engineRunId !== null,
    operationId: record.operationId,
    reservedSec: 60,
    state: record.state,
    updatedAt: record.updatedAt,
  };
}

function lineFacts(
  repository: ResearchTaskRepository<FakeRecord>,
  lines: ResearchTaskLineStore<FakeRecord>,
  record: FakeRecord,
  budget: { maxChildRuns: number; totalAllowanceSec: number } | undefined,
): ResearchLineFacts {
  const rows = repository.listForSession(record.identity.projectId, record.identity.sessionId);
  const reservation = lines.get(record.identity.projectId, record.identity.sessionId, LINE_KEY)
    ?.reservations.find((row) => row.operationId === record.operationId);
  return {
    children: rows.map((row) => ({
      ...childFacts(row),
      reservedSec: reservation?.reservedSec ?? 60,
    })),
    ...(budget === undefined ? {} : { limits: budget }),
    lineId: LINE_ID,
    lineKey: LINE_KEY,
  };
}

function present(record: FakeRecord): FakeView {
  return {
    artifactVersionId: record.delivery.artifactVersionId ?? null,
    delivery: record.delivery.state,
    engineStatus: record.engine.status ?? null,
    operationId: record.operationId,
    state: record.state,
  };
}

function transitions(now: () => string): ResearchLifecycleTransitions<FakeRecord> {
  const at = () => now();
  return {
    deliveryFailed: (record, message) => ({
      ...record,
      delivery: { ...record.delivery, lastError: message, state: "failed", updatedAt: at() },
    }),
    failed: (record, step, message) => ({ ...record, error: { message, step }, state: "failed" }),
    stopRequestedByConversation: (record, requestedAt) => ({
      ...record,
      stop: { ...record.stop, requestedAt, requestedBy: "conversation-cancel" },
    }),
    stopResult: (record, confirmedAt, result) => ({
      ...record,
      state: result.confirmed ? "stopped" : record.state,
      stop: {
        ...record.stop,
        ...(result.confirmed ? { confirmedAt } : {}),
        ...(result.error === undefined ? {} : { lastError: result.error }),
      },
    }),
    stopped: (record) => ({
      ...record,
      state: "stopped",
      stop: {
        ...record.stop,
        confirmedAt: record.stop.confirmedAt ?? at(),
        requestedAt: record.stop.requestedAt ?? at(),
        requestedBy: record.stop.requestedBy ?? "tool",
      },
    }),
    stoppedByConversation: (record, requestedAt) => ({
      ...record,
      state: "stopped",
      stop: { ...record.stop, requestedAt, requestedBy: "conversation-cancel" },
    }),
    stopping: (record, requestedAt, requestedBy: ResearchStopRequester) => ({
      ...record,
      state: "stopping",
      stop: { ...record.stop, requestedAt, requestedBy },
    }),
    unknown: (record) => ({ ...record, state: "unknown" }),
  };
}

function fakeEngine(
  store: SessionStore,
  runs: Map<string, EngineRun>,
  counters: { launches: number; deliverCalls: number; failDelivery: boolean },
  hideRecords: () => boolean,
): ResearchEngineAdapter<FakeRecord, FakeDelivery> {
  const now = () => new Date().toISOString();
  const observe = async (
    record: FakeRecord,
    writer: ResearchOperationWriter<FakeRecord> | undefined,
  ): Promise<ResearchEngineObservation<FakeRecord> | ResearchEngineInspection<FakeRecord>> => {
    const run = hideRecords() ? undefined : (record.engineRunId === null ? undefined : runs.get(record.engineRunId));
    if (!run) {
      return { engineRecordObserved: false, engineTerminal: false, record, stateAfterObservation: record.state };
    }
    const state = run.status;
    const engine = {
      ...record.engine,
      status: run.status,
      ...(run.elapsedSec === undefined ? {} : { elapsedSec: run.elapsedSec }),
    };
    const next = writer
      ? writer.mutate(record.operationId, (current) => ({ ...current, engine, state }))
      : { ...record, engine, state };
    return {
      engineRecordObserved: true,
      engineTerminal: run.status !== "running",
      record: next,
      stateAfterObservation: state,
    };
  };
  return {
    async confirmStop(record) {
      return record.engineRunId !== null && runs.get(record.engineRunId)?.status === "stopped";
    },
    async deliver(record) {
      counters.deliverCalls += 1;
      if (counters.failDelivery) throw new Error("the fake content store refused the write");
      const bytes = Buffer.from(`verified result for ${record.operationId}\n`, "utf8");
      const published = await publishArtifactVersion(store, {
        bytes,
        description: "A plain verified result file from the fake engine",
        digest: sha256(bytes),
        kind: "other",
        logicalName: `fake-engine/${record.operationId}/result.txt`,
        mediaType: "text/plain",
        originMeta: { engine: ENGINE_ID, operationId: record.operationId },
        sessionId: record.identity.sessionId,
        title: `Fake result ${record.operationId}`,
      });
      return {
        ...record.delivery,
        artifactVersionId: published.versionId,
        attempts: record.delivery.attempts + 1,
        state: "delivered",
        updatedAt: now(),
      };
    },
    engine: ENGINE_ID,
    async inspect(record): Promise<ResearchEngineInspection<FakeRecord>> {
      return await observe(record, undefined) as ResearchEngineInspection<FakeRecord>;
    },
    async launch(record, writer) {
      counters.launches += 1;
      const engineRunId = `fake-run-${record.operationId}`;
      runs.set(engineRunId, { status: "running" });
      // Engine facts are observed, not assumed: the launch records its handle
      // and running state but not an engine status it has not read.
      const next = writer.mutate(record.operationId, (current) => ({
        ...current,
        engineRunId,
        state: "running",
      }));
      // Persist the handle before returning; the engine is asynchronous.
      return { engineRunId, record: next };
    },
    async observe(record, writer): Promise<ResearchEngineObservation<FakeRecord>> {
      return await observe(record, writer) as ResearchEngineObservation<FakeRecord>;
    },
    async prepare(record) {
      return { proceed: true, record };
    },
    async requestStop(record) {
      const run = record.engineRunId === null ? undefined : runs.get(record.engineRunId);
      if (run) run.status = "stopped";
      return {};
    },
    transitions: transitions(now),
    beforeLaunch(record, writer, budget) {
      if (!budget) return { record };
      return { appliedAllowanceSec: budget.allowanceSec,
        record: writer.mutate(record.operationId, (current) => ({ ...current, launchAllowanceSec: budget.allowanceSec })) };
    },
  };
}

function request(fixtureValue: Fixture, ownerRunId: string, intent: string, allowanceSec?: number): FakeRequest {
  return {
    ...(allowanceSec === undefined ? {} : { allowanceSec }),
    intent,
    ownerRunId,
    projectId: fixtureValue.projectId,
    sessionId: fixtureValue.sessionId,
  };
}

async function settle(
  fixtureValue: Fixture,
  service: ResearchTaskService<FakeRequest, FakeRecord, FakeView>,
  operationId: string,
): Promise<FakeView> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const result = await service.get(
      { operationId, projectId: fixtureValue.projectId, sessionId: fixtureValue.sessionId },
      { waitMs: 20 },
    );
    const view = result.view;
    const terminal = view.state === "completed" || view.state === "failed"
      || view.state === "stopped" || view.state === "unknown";
    if (terminal && (view.delivery !== "pending" || view.state === "unknown")) return view;
    if (Date.now() >= deadline) return view;
    await sleep(5);
  }
}

test("a fake engine submits through the real repository and publishes a plain verified file", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "Produce one verified file"));
  assert.equal(started.attached, false);
  assert.equal(started.view.state, "accepted");

  // The background worker launches an asynchronous engine; nothing is
  // delivered while it runs.
  await waitFor(() => fx.engineRuns.has(`fake-run-${started.record.operationId}`));
  assert.equal(fx.counters.launches, 1);
  const running = (await fx.service.get(
    { operationId: started.record.operationId, projectId: fx.projectId, sessionId: fx.sessionId },
    { waitMs: 20 },
  )).view;
  assert.equal(running.state, "running");
  assert.equal(running.delivery, "pending");

  // The engine reaches a terminal state; the observation publishes once.
  const run = fx.engineRuns.get(`fake-run-${started.record.operationId}`)!;
  run.status = "completed";
  run.elapsedSec = 12;
  const completed = await settle(fx, fx.service, started.record.operationId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.delivery, "delivered");
  assert.ok(completed.artifactVersionId);

  // A later observation and a delivery retry do not create a second version.
  const again = await settle(fx, fx.service, started.record.operationId);
  assert.equal(again.artifactVersionId, completed.artifactVersionId);
  const retried = await fx.service.retryDelivery({
    operationId: started.record.operationId,
    projectId: fx.projectId,
    sessionId: fx.sessionId,
  });
  assert.equal(retried.view.artifactVersionId, completed.artifactVersionId);
  assert.equal(fx.counters.deliverCalls, 2);
  // The line settled the terminal child once.
  const line = fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY)!;
  assert.equal(line.schemaVersion, RESEARCH_BUDGET_LINE_VERSION);
  assert.equal(line.settlements.length, 1);
  assert.equal(line.settlements[0]!.wallClock.chargedSeconds, 12);
  assert.equal(line.reservations.length, 0);
});

test("a repeated request attaches and a second start in one conversation never launches", async (context) => {
  const fx = await fixture(context);
  const first = await fx.service.start(request(fx, "run-1", "The one experiment"));
  await waitFor(() => fx.counters.launches === 1);

  const replay = await fx.service.start(request(fx, "run-1", "The one experiment"));
  assert.equal(replay.attached, true);
  assert.equal(replay.attachedReason, "same-request");
  assert.equal(replay.record.operationId, first.record.operationId);

  const second = await fx.service.start(request(fx, "run-1", "A different intent"));
  assert.equal(second.attached, true);
  assert.equal(second.attachedReason, "active-operation");
  assert.equal(second.record.operationId, first.record.operationId);
  assert.equal(fx.counters.launches, 1);
});

test("a rebuilt service observes an existing engine run without relaunching it", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "Survive a rebuild"));
  await waitFor(() => fx.engineRuns.has(`fake-run-${started.record.operationId}`));
  fx.engineRuns.get(`fake-run-${started.record.operationId}`)!.status = "completed";

  const rebuilt = fx.newService();
  const observed = await rebuilt.get({
    operationId: started.record.operationId,
    projectId: fx.projectId,
    sessionId: fx.sessionId,
  });
  assert.equal(observed.view.state, "completed");
  assert.equal(observed.view.delivery, "delivered");
  assert.equal(fx.counters.launches, 1);

  const replay = await rebuilt.start(request(fx, "run-1", "Survive a rebuild"));
  assert.equal(replay.attached, true);
  assert.equal(fx.counters.launches, 1);
});

test("a restart with no engine record marks the operation unknown and never re-executes it", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "Lose the engine record"));
  await waitFor(() => fx.engineRuns.has(`fake-run-${started.record.operationId}`));

  const rebuilt = fx.newService({ hideEngineRecords: true });
  const observed = await rebuilt.get({
    operationId: started.record.operationId,
    projectId: fx.projectId,
    sessionId: fx.sessionId,
  });
  assert.equal(observed.view.state, "unknown");
  assert.equal(observed.view.delivery, "pending");
  assert.equal(fx.counters.launches, 1);
});

test("conversation cancellation records a stop and no launch is retried", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "Cancel me"));
  await waitFor(() => fx.engineRuns.has(`fake-run-${started.record.operationId}`));

  await fx.service.cancelOwnerRun(fx.sessionId, "run-1");
  const stopped = await settle(fx, fx.service, started.record.operationId);
  assert.equal(stopped.state, "stopped");
  assert.equal(fx.counters.launches, 1);
  assert.equal(fx.engineRuns.get(`fake-run-${started.record.operationId}`)!.status, "stopped");

  // The conversation that was stopped cannot quietly start another child.
  const reopened = fx.newService();
  await assert.rejects(
    () => reopened.start(request(fx, "run-1", "Start after stop")),
    (error: unknown) => error instanceof FakeRefusal && error.reason === "research-line-stopped",
  );
});

test("an active child reserves its allowance and keeps the line serial", async (context) => {
  const fx = await fixture(context, { maxChildRuns: 5, totalAllowanceSec: 100 });
  const first = await fx.service.start(request(fx, "run-1", "First child", 60));
  await waitFor(() => fx.counters.launches === 1);
  const line = fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY)!;
  assert.equal(line.reservations.length, 1);
  assert.equal(line.reservations[0]!.reservedSec, 60);

  // Another conversation cannot run a second child while this one is active.
  await assert.rejects(
    () => fx.service.start(request(fx, "run-2", "Second child", 20)),
    (error: unknown) => error instanceof FakeRefusal && error.reason === "research-line-busy",
  );
  assert.equal(fx.counters.launches, 1);
  assert.equal(fx.repository.listForSession(fx.projectId, fx.sessionId).length, 1);

  // Once it settles, the remaining unreserved allowance still bounds the next.
  const run = fx.engineRuns.get(`fake-run-${first.record.operationId}`)!;
  run.status = "completed";
  run.elapsedSec = 60;
  await settle(fx, fx.service, first.record.operationId);
  await assert.rejects(
    () => fx.service.start(request(fx, "run-2", "Second child", 60)),
    (error: unknown) => error instanceof FakeRefusal
      && error.reason === "parent-budget-exhausted"
      && /40s unreserved allowance/.test(error.message),
  );
  assert.equal(fx.counters.launches, 1);
});

test("the shared budget refuses a child beyond the line's run limit after settlement", async (context) => {
  const fx = await fixture(context, { maxChildRuns: 1, totalAllowanceSec: 600 });
  const first = await fx.service.start(request(fx, "run-1", "Only child", 60));
  await waitFor(() => fx.engineRuns.has(`fake-run-${first.record.operationId}`));
  fx.engineRuns.get(`fake-run-${first.record.operationId}`)!.status = "completed";
  await settle(fx, fx.service, first.record.operationId);

  await assert.rejects(
    () => fx.service.start(request(fx, "run-2", "One child too many", 60)),
    (error: unknown) => error instanceof FakeRefusal
      && error.reason === "parent-budget-exhausted"
      && /limit of 1 child runs/.test(error.message),
  );
  assert.equal(fx.repository.listForSession(fx.projectId, fx.sessionId).length, 1);
});

test("a failed publication is retried without relaunching and reuses the same version", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "Publish after a failure"));
  await waitFor(() => fx.engineRuns.has(`fake-run-${started.record.operationId}`));
  fx.counters.failDelivery = true;
  fx.engineRuns.get(`fake-run-${started.record.operationId}`)!.status = "completed";

  const failed = await settle(fx, fx.service, started.record.operationId);
  assert.equal(failed.state, "completed");
  assert.equal(failed.delivery, "failed");

  fx.counters.failDelivery = false;
  const retried = await fx.service.retryDelivery({
    operationId: started.record.operationId,
    projectId: fx.projectId,
    sessionId: fx.sessionId,
  });
  assert.equal(retried.view.delivery, "delivered");
  assert.equal(fx.counters.launches, 1);

  const retriedAgain = await fx.service.retryDelivery({
    operationId: started.record.operationId,
    projectId: fx.projectId,
    sessionId: fx.sessionId,
  });
  assert.equal(retriedAgain.view.artifactVersionId, retried.view.artifactVersionId);
  assert.equal(fx.counters.launches, 1);
});

test("durable records reject a corrupted row instead of skipping or repairing it", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "run-1", "A row that will be corrupt"));
  await waitFor(() => fx.counters.launches === 1);
  // Corrupt the stored JSON behind the repository.
  const database = new DatabaseSync(join(fx.root, "research.sqlite"));
  context.after(() => database.close());
  database.prepare("UPDATE fake_research_operations SET record_json = ? WHERE id = ?")
    .run("{not-json", started.record.operationId);
  assert.throws(
    () => fx.repository.get(started.record.operationId),
    (error: unknown) => error instanceof ResearchOperationCorruptError,
  );
});


function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function twoPlans() {
  const gate = deferred();
  let count = 0;
  return async () => { if (++count === 2) gate.resolve(); await gate.promise; };
}

test("concurrent different requests from one owner attach after asynchronous planning", async (context) => {
  const fx = await fixture(context, { maxChildRuns: 1, totalAllowanceSec: 300 });
  const service = fx.newService({ planBarrier: twoPlans() });
  const results = await Promise.all([
    service.start(request(fx, "owner", "first")), service.start(request(fx, "owner", "second")),
  ]);
  await waitFor(() => fx.counters.launches === 1);
  assert.equal(results[0]!.record.operationId, results[1]!.record.operationId);
  assert.equal(results.filter((result) => result.attached).length, 1);
  assert.equal(fx.repository.listForSession(fx.projectId, fx.sessionId).length, 1);
  assert.equal(fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY)!.reservations.length, 1);
});

test("concurrent owners reserve one child across service instances", async (context) => {
  const fx = await fixture(context, { maxChildRuns: 1, totalAllowanceSec: 300 });
  const options = { planBarrier: twoPlans() };
  const results = await Promise.allSettled([
    fx.newService(options).start(request(fx, "owner-1", "first")),
    fx.newService(options).start(request(fx, "owner-2", "second")),
  ]);
  await waitFor(() => fx.counters.launches === 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof FakeRefusal);
  assert.equal(rejected.reason.reason, "research-line-busy");
  assert.equal(fx.repository.listForSession(fx.projectId, fx.sessionId).length, 1);
  assert.equal(fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY)!.reservations.length, 1);
});

test("concurrent identical requests attach to the same durable operation", async (context) => {
  const fx = await fixture(context);
  const service = fx.newService({ planBarrier: twoPlans() });
  const input = request(fx, "owner", "same request");
  const results = await Promise.all([service.start(input), service.start(input)]);
  assert.equal(results[0]!.record.operationId, results[1]!.record.operationId);
  assert.equal(results.find((result) => result.attached)!.attachedReason, "same-request");
  await waitFor(() => fx.counters.launches === 1);
});

test("delivery retry while running stays pending until terminal observation", async (context) => {
  const fx = await fixture(context);
  const started = await fx.service.start(request(fx, "owner", "still running"));
  await waitFor(() => fx.counters.launches === 1);
  const input = { projectId: fx.projectId, sessionId: fx.sessionId, operationId: started.record.operationId };
  const retry = await fx.service.retryDelivery(input);
  assert.equal(retry.record.state, "running");
  assert.equal(retry.record.delivery.state, "pending");
  assert.equal(fx.counters.deliverCalls, 0);
  fx.engineRuns.get(`fake-run-${started.record.operationId}`)!.status = "completed";
  await settle(fx, fx.service, started.record.operationId);
  assert.equal(fx.counters.deliverCalls, 1);
});

for (const mode of ["expired", "tightened", "unsupported"] as const) {
  test(`preparation budget is ${mode} by the shared service`, async (context) => {
    const fx = await fixture(context, { maxChildRuns: 2, totalAllowanceSec: 120 });
    let now = "2026-01-01T00:00:00.000Z";
    const entered = deferred();
    const release = deferred();
    const service = fx.newService({ now: () => now, ignoreBudget: mode === "unsupported",
      prepare: async (record) => { entered.resolve(); await release.promise; return { record, proceed: true }; },
    });
    const started = await service.start(request(fx, "owner", mode, 90));
    await entered.promise;
    now = mode === "expired" ? "2026-01-01T00:02:01.000Z" : "2026-01-01T00:01:00.000Z";
    release.resolve();
    await waitFor(() => fx.counters.launches > 0 || fx.repository.get(started.record.operationId)!.state === "failed");
    const record = fx.repository.get(started.record.operationId)!;
    const line = fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY)!;
    if (mode === "tightened") {
      assert.equal(fx.counters.launches, 1);
      assert.equal(record.launchAllowanceSec, 60);
      assert.equal(line.reservations[0]!.reservedSec, 60);
    } else {
      assert.equal(fx.counters.launches, 0);
      assert.equal(record.error?.step, "budget");
      assert.equal(line.reservations.length, 0);
      assert.equal(line.settlements.length, 1);
    }
  });
}

test("parallel publishers reuse one version and a failed write releases the queue", async (context) => {
  const fx = await fixture(context);
  const input = { bytes: Buffer.from("verified fact"), description: "result", kind: "other" as const,
    logicalName: "parallel.txt", mediaType: "text/plain", sessionId: fx.sessionId, title: "result" };
  const failed = publishArtifactVersion(fx.store, { ...input, digest: "wrong" });
  const results = await Promise.all([failed.catch(() => undefined),
    ...Array.from({ length: 8 }, () => publishArtifactVersion(fx.store, input))]);
  const published = results.slice(1).filter((result) => result !== undefined);
  assert.equal(published.length, 8);
  assert.equal(new Set(published.map((result) => result.versionId)).size, 1);
  assert.deepEqual(published.map((result) => result.version), Array(8).fill(1));
  const artifact = fx.store.getArtifactByName(fx.sessionId, input.logicalName)!;
  assert.equal(fx.store.listProjectArtifactVersions(fx.projectId, artifact.id).length, 1);
});


test("cancellation during planning refuses admission without a record or reservation", async (context) => {
  const fx = await fixture(context);
  const entered = deferred();
  const release = deferred();
  let cancelled = false;
  const service = fx.newService({ ownerStopped: async () => cancelled,
    planBarrier: async () => { entered.resolve(); await release.promise; },
  });
  const start = service.start(request(fx, "owner", "cancel during planning"));
  const rejected = assert.rejects(start,
    (error: unknown) => error instanceof FakeRefusal && error.reason === "conversation-cancelled");
  await entered.promise;
  cancelled = true;
  release.resolve();
  await rejected;
  assert.equal(fx.counters.launches, 0);
  assert.equal(fx.repository.listForSession(fx.projectId, fx.sessionId).length, 0);
  assert.equal(fx.lines.get(fx.projectId, fx.sessionId, LINE_KEY), undefined);
});
