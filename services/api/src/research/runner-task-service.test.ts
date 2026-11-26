// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CasStore } from "@sciencediscovery/cas";
import { RunnerClient } from "@sciencediscovery/executor";
import { createRunnerServer, loadRunnerConfig } from "../../../runner/src/server.js";
import { researchInputBundleDigest } from "../../../runner/src/research-input-bundles.js";
import { PROOF_PROGRAM } from "../../../../test/support/research/proof-program.mjs";
import { SessionStore } from "../store.js";
import { publishArtifactVersion } from "./artifact-publisher.js";
import { ResearchBudgetRepository } from "./budget-repository.js";
import { createRunnerTaskEngine, type RunnerTaskRecord } from "./runner-engine-adapter.js";
import { ResearchTaskRepository } from "./task-repository.js";
import { assertResearchTaskRecordEnvelope, isPlainRecord, type ResearchOperationCodec } from "./task-record.js";
import { createResearchTaskService, type ResearchTaskProduct } from "./task-service.js";

/** Fully validate this fixture's frozen product extension and mutable envelope. */
function assertRecord(value: unknown, runner: RunnerTaskRecord["runner"]): asserts value is RunnerTaskRecord {
  assert.ok(isPlainRecord(value));
  assert.deepEqual(value.runner, runner);
  for (const key of ["operationId", "ownerRunId", "idempotencyKey", "createdAt", "updatedAt"]) assert.ok(typeof value[key] === "string");
  assert.equal(value.schemaVersion, 1);
  assert.ok(isPlainRecord(value.identity) && typeof value.identity.projectId === "string" && typeof value.identity.sessionId === "string");
  assert.ok(typeof value.state === "string" && ["accepted", "running", "stopping", "completed", "failed", "stopped", "unknown"].includes(value.state));
  assert.ok(value.engineRunId === null || typeof value.engineRunId === "string");
  assert.ok(value.engineId === undefined || typeof value.engineId === "string");
  assert.ok(isPlainRecord(value.engine) && (value.engine.status === undefined || typeof value.engine.status === "string")
    && (value.engine.elapsedSec === undefined || typeof value.engine.elapsedSec === "number"));
  assert.ok(isPlainRecord(value.stop));
  for (const key of ["requestedAt", "confirmedAt", "engineStatus", "lastError"]) assert.ok(value.stop[key] === undefined || typeof value.stop[key] === "string");
  assert.ok(value.stop.requestedBy === undefined || value.stop.requestedBy === "tool" || value.stop.requestedBy === "conversation-cancel");
  assert.ok(value.error === undefined || (isPlainRecord(value.error) && typeof value.error.step === "string" && typeof value.error.message === "string"));
  assert.ok(isPlainRecord(value.delivery));
  assert.ok(typeof value.delivery.state === "string" && ["pending", "delivered", "failed"].includes(value.delivery.state));
  assert.ok(typeof value.delivery.attempts === "number" && typeof value.delivery.updatedAt === "string");
  assert.ok(value.delivery.lastError === undefined || typeof value.delivery.lastError === "string");
  assert.ok(Array.isArray(value.delivery.outputs));
  for (const output of value.delivery.outputs) {
    assert.ok(isPlainRecord(output));
    for (const key of ["artifactId", "logicalName", "mediaType", "versionId"]) assert.ok(typeof output[key] === "string");
    assert.equal(output.kind, "other"); assert.ok(output.status === "created" || output.status === "reused");
    assert.ok(typeof output.version === "number" && isPlainRecord(output.content)
      && typeof output.content.hash === "string" && typeof output.content.size === "number");
  }
}

for (const loseLaunchResponse of [false, true]) test(`plain-file task uses the shared Runner and recovers without relaunch (lost response: ${loseLaunchResponse})`, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sd-task-runner-"));
  const runnerData = join(root, "runner"), workspace = join(runnerData, "projects", "proof");
  await mkdir(workspace, { recursive: true });
  const api = new SessionStore(join(root, "api")); await api.load();
  const db = new DatabaseSync(join(root, "tasks.sqlite"));
  const token = randomUUID();
  const config = { ...loadRunnerConfig({ SCIENCE_AGENT_AUTH_TOKEN: token }), dataDir: runnerData, authToken: token, port: 0,
    npuBrokerEnabled: false, researchWorkloads: [{ workloadId: "proof-checker", program: PROOF_PROGRAM,
      fixtureRuntime: { identity: "fixture", interpreterPath: "/usr/bin/python3" } }] };
  const runner = createRunnerServer(config);
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => runner.close(() => resolve())); api.close(); db.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = runner.address(); assert.ok(address && typeof address !== "string");
  const client = new RunnerClient(`http://127.0.0.1:${address.port}`, token);
  const project = await api.createProject("Proof product");
  const model = await api.createModel({ name: "Default", model: "fixture", apiToken: randomUUID(), baseUrl: "https://models.example.test/v1" });
  const session = await api.createSession(project.id, "Plain-file task", { modelId: model.id });
  const source = await publishArtifactVersion(api, { sessionId: session.id, bytes: Buffer.from("2 + 2 = 4\n"),
    logicalName: "fact.txt", title: "Fact", description: "Input", kind: "other", mediaType: "text/plain" });
  const file = { path: "fact.txt", roles: ["facts"], size: source.content.size, sha256: source.content.hash };
  const contractDigest = createHash("sha256").update("plain-proof-contract").digest("hex");
  const bundleDigest = researchInputBundleDigest({ schemaVersion: 1, contractDigest, files: [file] });
  let frozenRunner: RunnerTaskRecord["runner"];
  const codec: ResearchOperationCodec<RunnerTaskRecord> = { schemaVersion: 1, encode: (value) => value,
    decode(value, row) { assertResearchTaskRecordEnvelope(value, row, 1); assertRecord(value, frozenRunner); return value; } };
  const operations = new ResearchTaskRepository(db, { codec });
  const lines = new ResearchBudgetRepository(db);
  const engine = createRunnerTaskEngine({ client: {
    prepareResearchInputBundle: (...args) => client.prepareResearchInputBundle(...args),
    async submitResearchExecution(...args) {
      const result = await client.submitResearchExecution(...args);
      if (loseLaunchResponse) throw new Error("Simulated lost response after Runner accepted the execution");
      return result;
    },
    getShellExecution: (...args) => client.getShellExecution(...args),
    cancelShellExecution: (...args) => client.cancelShellExecution(...args),
    readResearchExecutionFile: (...args) => client.readResearchExecutionFile(...args),
  }, store: api });
  const facts = () => ({ lineKey: "proof-line", lineId: "proof-line", limits: { maxChildRuns: 1, totalAllowanceSec: 120 },
    children: operations.listForSession(project.id, session.id).map((record) => ({
      operationId: record.operationId, createdAt: record.createdAt, updatedAt: record.updatedAt,
      state: record.state, reservedSec: 60, launched: record.engineRunId !== null,
      ...(record.engine.elapsedSec === undefined ? {} : { elapsedSec: record.engine.elapsedSec }),
    })) });
  const product: ResearchTaskProduct<{ ownerRunId: string }, RunnerTaskRecord["delivery"], RunnerTaskRecord, RunnerTaskRecord> = {
    engineId: "proof-product", engine, capabilities: { asynchronousLaunch: true, confirmsStop: true,
      reportsElapsedSec: true, reportsTokenUsage: false, delivers: "ordinary proof file" },
    authorize: () => undefined, requestIdentity: (request) => ({ ...request, projectId: project.id, sessionId: session.id }),
    idempotencyKey: () => "proof-request", refuse: (reason, message) => new Error(`${reason}: ${message}`),
    present: (record) => record, lineFactsFor: facts,
    async planStart(request, contextValue) {
      const operationId = contextValue.newOperationId(), at = contextValue.now();
      frozenRunner = { request: { kind: "research", schemaVersion: 1, workload: "proof-checker", executionId: operationId,
        agentId: "proof-agent", workspaceRoot: workspace, inputs: { contractDigest, bundleDigest },
        permissionEpoch: { sessionId: session.id, createdAt: at, id: "epoch", environmentRevisionId: "fixture",
          mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", reason: "test", secretRefs: [] },
        schedule: { researchBudgetMs: 4000, reportBudgetMs: 2000, drainGraceMs: 200, verificationWindowMs: 1000, stopGraceMs: 200 } },
        inputs: [{ ...file, versionId: source.versionId }], outputs: [{ path: "proof.txt", logicalName: "proof.txt",
          title: "Checked facts", kind: "other", mediaType: "text/plain" }] };
      const record: RunnerTaskRecord = { schemaVersion: 1, operationId, idempotencyKey: "proof-request",
        identity: { projectId: project.id, sessionId: session.id }, ownerRunId: request.ownerRunId, state: "accepted",
        engineRunId: null, engine: {}, stop: {}, createdAt: at, updatedAt: at, runner: frozenRunner,
        delivery: { state: "pending", attempts: 0, updatedAt: at, outputs: [] } };
      return { record, dedupeKey: "proof-request", line: { ...facts(), allowanceSec: 60 } };
    },
  };
  const newService = () => createResearchTaskService({ product, store: api, operations, lines, observeMaxWaitMs: 100 });
  const service = newService(), input = { ownerRunId: "conversation" };
  const start = await service.start(input);
  assert.equal((await service.start(input)).record.operationId, start.record.operationId);
  const identity = { projectId: project.id, sessionId: session.id, operationId: start.record.operationId };
  assert.equal((await service.retryDelivery(identity)).record.delivery.state, "pending");
  let result = start.record;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && result.delivery.state !== "delivered" && result.state !== "failed") {
    result = (await service.get(identity)).record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.state, "completed", JSON.stringify(result)); assert.equal(result.delivery.state, "delivered");
  const output = result.delivery.outputs[0]; assert.ok(output);
  assert.equal((await new CasStore(api.dataDir).read(output.content.hash)).toString(), "checked: 2 + 2 = 4\n");
  const rebuilt = newService();
  assert.equal((await rebuilt.retryDelivery(identity)).record.delivery.outputs[0]?.versionId, output.versionId);
  assert.equal((await rebuilt.get(identity)).record.engineRunId, result.engineRunId);
  assert.equal(lines.get(project.id, session.id, "proof-line")?.settlements.length, 1);
  assert.equal(api.listProjectArtifactVersions(project.id, output.artifactId).length, 1);
  const ledger = new DatabaseSync(join(runnerData, "runner-executions", "executions.sqlite"));
  try { assert.equal(ledger.prepare("SELECT COUNT(*) AS count FROM executions").get()?.count, 1); } finally { ledger.close(); }
});
