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
 * Task-dynamic mode: the conversation selects a registered package or prepares
 * its own task contract, and start binds exactly that task into the manifest.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { CasStore } from "@sciencediscovery/cas";

import { SessionStore } from "../store.js";
import type { ScienceFlowResultDeliveryRecord } from "./result-delivery.js";
import {
  createLocalResearchService,
  LocalResearchRefusal,
} from "./local-research.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import { TaskPreparationRefusal, parsePreparedTaskContract, requireInputName } from "./local-research-task.js";
import type { ResearchPilotLaunchOutcome } from "./research-pilot.js";

const PLAN_TEXT = "# plan\nFit the model parameters and submit the solution artifact.\n";
const TEMPLATE = [
  "Read the plan at {{plan_file}} (version {{plan_version_id}}).",
  "Intent: {{research_intent}}",
].join("\n");

interface Fixture {
  readonly projectId: string;
  readonly root: string;
  readonly sessionId: string;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly store: SessionStore;
  readonly workRoot: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-task-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Task dynamic research");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Task dynamic session", { modelId: model.id });
  const assetsDir = join(root, "assets");
  const workRoot = join(root, "work");
  const privateRoot = join(root, "private");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
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
        observeMaxWaitMs: 3_000,
        reportBudgetSec: 60,
        researchBudgetSec: 240,
        stageCaptureMax: 3,
        totalAllowanceSec: 320,
      },
      dynamicInputs: { incumbent: "start_solution.json", incumbentOptional: true, plan: "experiment_plan.md" },
      engineCheckout: join(root, "engine"),
      evaluatorProbeTimeoutSec: 30,
      inputMode: "dynamic",
      preparationScriptPath: join(root, "preparation.py"),
      privateRoot,
      profileId: "round26-task-dynamic",
      pythonExecutable: join(root, "python-not-used"),
      readerScriptPath: join(root, "snapshot.py"),
      refusePackageInstall: true,
      seedDir: assetsDir,
      taskMode: "task-dynamic",
      taskTemplate: TEMPLATE,
      workRoot,
    },
    store,
    workRoot,
  };
}

async function publish(
  store: SessionStore,
  sessionId: string,
  logicalName: string,
  text: string,
  kind: "json" | "markdown" = "markdown",
): Promise<{ artifactId: string; versionId: string }> {
  const content = await new CasStore(store.dataDir).put(Buffer.from(text));
  const { artifact, version } = await store.createArtifactVersion({
    content,
    kind,
    logicalName,
    mediaType: kind === "json" ? "application/json" : "text/markdown",
    origin: "server_generated",
    sessionId,
  });
  return { artifactId: artifact.id, versionId: version.id };
}

const finishedLaunch = async (input: { readonly workDir: string; readonly runId: string }): Promise<ResearchPilotLaunchOutcome> => {
  await mkdir(join(input.workDir, "state", "scienceflow", "managed_runs", input.runId), { recursive: true });
  await writeFile(
    join(input.workDir, "state", "scienceflow", "managed_runs", input.runId, "control.json"),
    JSON.stringify({ alive: false, phase: "finished", status: "completed" }),
    "utf8",
  );
  return {
    elapsedSec: 1,
    outcome: "finished",
    phase: "finished",
    status: "completed",
    supervisorAliveAfterFinish: false,
  };
};

const stubDelivery = async (): Promise<ScienceFlowResultDeliveryRecord> => ({
  outcome: { failedStep: "readback", message: "stub delivery", status: "failed" },
} as unknown as ScienceFlowResultDeliveryRecord);

function serviceFor(
  target: Fixture,
  overrides: Parameters<typeof createLocalResearchService>[1] = {},
) {
  const launches: string[] = [];
  const service = createLocalResearchService({ settings: target.settings, store: target.store }, {
    deliver: stubDelivery,
    launch: (input) => {
      launches.push(input.manifestPath);
      return finishedLaunch(input);
    },
    now: () => "2026-11-16T10:00:00.000Z",
    ...overrides,
  });
  return { launches, service };
}

async function startAccepted(
  service: ReturnType<typeof serviceFor>["service"],
  target: Fixture,
  planVersionId: string,
  extra: {
    readonly incumbentVersionId?: string;
    readonly inputVersionIds?: readonly string[];
    readonly taskPackageId?: string;
    readonly taskVersionId?: string;
  },
) {
  const started = await service.start({
    intent: "Fit the requested numerical model and report the evaluated metric.",
    ownerRunId: "conversation-run-1",
    planVersionId,
    projectId: target.projectId,
    sessionId: target.sessionId,
    ...extra,
  });
  const deadline = Date.now() + 15_000;
  let view = started.operation;
  while ((view.state === "accepted" || view.state === "running") && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
    view = await service.get({ operationId: started.operation.operationId, projectId: target.projectId, sessionId: target.sessionId });
  }
  return view;
}

function operationFor(target: Fixture, operationId: string) {
  const row = target.store.scienceFlowResearchOperations
    .listForSession(target.projectId, target.sessionId)
    .find((operation) => operation.operationId === operationId);
  assert.ok(row);
  return row;
}

const acceptedProbe = async () => [
  { artifactSha256: "a".repeat(64), expect: "accepted" as const, label: "valid", lowerIsBetter: true, metricName: "rmse", metricValue: 0.5, ok: true, status: "ok" },
  { artifactSha256: "b".repeat(64), expect: "rejected" as const, label: "invalid", lowerIsBetter: true, metricName: "rmse", metricValue: null, ok: false, status: "evaluator_error" },
];

test("a catalog task is bound by id and the manifest keeps the package evaluator", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const upload = await publish(target.store, target.sessionId, "problem.json", JSON.stringify({ num_points: 16 }), "json");
  const described: string[] = [];
  const { launches, service } = serviceFor(target, {
    describeTask: async (_settings, taskId) => {
      described.push(taskId);
      return {
        artifactKind: "json_solution",
        artifactPath: "artifacts/best_solution.json",
        authoritative: false,
        category: "opt_solver",
        description: "# Ratio minimization\n\nPlace 16 points.",
        descriptionAvailable: true,
        evaluatorEntrypoint: "evaluator.py:evaluate",
        id: "ratio-minimization",
        inputsRequired: null,
        lowerIsBetter: false,
        metricName: "inv_ratio_squared",
        metricType: "benchmark",
        missingModules: [],
        profile: "opt_solver",
        provider: "",
      };
    },
  });
  const view = await startAccepted(service, target, plan.versionId, {
    inputVersionIds: [upload.versionId],
    taskPackageId: "ratio-minimization",
  });
  assert.equal(view.state, "completed");
  assert.deepEqual(described, ["ratio-minimization"]);
  assert.equal(view.task, "ratio-minimization");
  assert.equal(view.taskIdentity?.source, "catalog");
  assert.equal(view.taskIdentity?.metricName, "inv_ratio_squared");
  assert.equal(view.taskIdentity?.taskVersionId, null);
  assert.equal(launches.length, 1);
  const manifest = await readFile(launches[0]!, "utf8");
  assert.match(manifest, /exp_id: ratio-minimization/);
  assert.doesNotMatch(manifest, /backend: artifact_command/);
  assert.match(manifest, /Ratio minimization/);
  assert.match(manifest, /inv_ratio_squared/);
  // The bound data version is staged into the operation's own dataset.
  const dataLine = manifest.split("\n").find((line) => line.trim().startsWith("input_data_dir:"))!;
  const dataDir = JSON.parse(dataLine.split("input_data_dir:")[1]!.trim()) as string;
  assert.match(await readFile(join(dataDir, "problem.json"), "utf8"), /num_points/);
});

test("a prepared task publishes a contract only after a passing probe and binds a minimizing evaluator", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const probeCalls: Array<Record<string, unknown>> = [];
  const { launches, service } = serviceFor(target, {
    probeTask: async (_settings, input) => {
      probeCalls.push(input as unknown as Record<string, unknown>);
      return acceptedProbe();
    },
  });
  const published = await service.prepareTask({
    artifactPath: "artifacts/solution.json",
    evaluatorSource: [
      "import json, math, sys",
      "value = json.loads(open(sys.argv[1], encoding='utf-8').read())",
      "x = value['x']",
      "if not isinstance(x, (int, float)) or not math.isfinite(x):",
      "    raise SystemExit(2)",
      "print(json.dumps({'metric': abs(x - 3.0)}))",
    ].join("\n"),
    invalidSample: { content: JSON.stringify({ x: "nope" }), name: "invalid.json" },
    metricDirection: "minimize",
    metricJsonPath: "metric",
    metricName: "rmse",
    objective: "Fit x to 3.0 from the bound observations and write artifacts/solution.json as {\"x\": <number>}.",
    projectId: target.projectId,
    runId: "conversation-run-1",
    sessionId: target.sessionId,
    slug: "numerical-model-fit",
    title: "Numerical model fit",
    validSample: { content: JSON.stringify({ x: 2.5 }), name: "valid.json" },
  });
  assert.equal(published.authority, "exploratory-generated");
  assert.equal(published.metric.lowerIsBetter, true);
  assert.equal(published.probes.length, 2);
  assert.equal(probeCalls.length, 1);
  const metrics = published.metric;
  assert.deepEqual(metrics, { jsonPath: "metric", lowerIsBetter: true, name: "rmse" });

  const contract = await target.store.getArtifactByName(target.sessionId, `research-tasks/${published.taskId}/contract.json`);
  assert.ok(contract);
  const version = target.store.listProjectArtifactVersions(target.projectId, contract.id).at(-1)!;
  const contractBytes = await new CasStore(target.store.dataDir).read(version.content.hash);
  assert.match(contractBytes.toString("utf8"), /exploratory-generated/);

  const view = await startAccepted(service, target, plan.versionId, { taskVersionId: published.taskVersionId });
  assert.equal(view.state, "completed");
  assert.equal(view.taskIdentity?.source, "prepared");
  assert.equal(view.taskIdentity?.evaluatorKind, "generated-command");
  assert.equal(view.taskIdentity?.lowerIsBetter, true);
  assert.equal(launches.length, 1);
  const manifest = await readFile(launches[0]!, "utf8");
  assert.match(manifest, /exp_id: sd-numerical-model-fit-[a-f0-9]{8}/);
  assert.match(manifest, /backend: artifact_command/);
  assert.match(manifest, /lower_is_better: true/);
  assert.match(manifest, /artifacts\/solution\.json/);
  assert.match(manifest, /task-manifest\.json|evaluator\.py/);
  // The operation runs its own frozen copy of the evaluator.
  const operation = service.latest(target.projectId, target.sessionId)!;
  assert.ok(operation.taskBinding?.assetDir);
  assert.match(await readFile(join(operation.taskBinding.assetDir, "evaluator.py"), "utf8"), /abs\(x - 3\.0\)/);
  assert.match(await readFile(join(operation.taskBinding.assetDir, "task-manifest.json"), "utf8"), /rmse/);
});

test("a failed probe publishes nothing", async (context) => {
  const target = await fixture(context);
  const { service } = serviceFor(target, {
    probeTask: async () => [
      { artifactSha256: "a".repeat(64), expect: "accepted" as const, label: "valid", lowerIsBetter: false, metricName: "score", metricValue: 0.5, ok: true, status: "ok" },
      { artifactSha256: "b".repeat(64), expect: "rejected" as const, label: "invalid", lowerIsBetter: false, metricName: "score", metricValue: 0.5, ok: true, status: "ok" },
    ],
  });
  await assert.rejects(
    service.prepareTask({
      artifactPath: "artifacts/solution.json",
      evaluatorSource: "print('{}')",
      invalidSample: { content: "{}", name: "invalid.json" },
      metricDirection: "maximize",
      metricName: "score",
      objective: "Maximize the reported score.",
      projectId: target.projectId,
      runId: "conversation-run-1",
      sessionId: target.sessionId,
      title: "Broken evaluator",
      validSample: { content: "{}", name: "valid.json" },
    }),
    (error: unknown) => error instanceof TaskPreparationRefusal && error.reason === "probe-failed",
  );
  assert.equal(target.store.getArtifactByName(target.sessionId, "research-tasks"),
    undefined);
});

test("a task version from another Session is refused before launch", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const other = await target.store.createSession(target.projectId, "Other session",
    { modelId: target.store.getSession(target.sessionId)!.modelId });
  const foreign = await publish(target.store, other.id, "research-tasks/foreign/contract.json", "{}", "json");
  const { launches, service } = serviceFor(target);
  await assert.rejects(
    service.start({
      intent: "Use a foreign task",
      ownerRunId: "conversation-run-1",
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskVersionId: foreign.versionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-not-found",
  );
  assert.equal(launches.length, 0);
});

test("fixed-task mode refuses task selection instead of silently ignoring it", async (context) => {
  const target = await fixture(context);
  const fixed = { ...target.settings, task: "circle-packing", taskMode: "fixed" as const };
  const service = createLocalResearchService({ settings: fixed, store: target.store }, {
    deliver: stubDelivery,
    launch: finishedLaunch,
  });
  await assert.rejects(
    service.start({
      intent: "Name a task this profile does not allow",
      ownerRunId: "conversation-run-1",
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskPackageId: "ratio-minimization",
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "invalid-option",
  );
});

test("a bound input name may carry the dataset/ prefix the evaluator sees", () => {
  assert.equal(requireInputName("fit.csv"), "fit.csv");
  assert.equal(requireInputName("dataset/fit.csv"), "fit.csv");
  assert.throws(() => requireInputName("dataset/nested/fit.csv"), /one plain file name/);
  assert.throws(() => requireInputName("../fit.csv"), /one plain file name/);
});

test("two prepared tasks in one Session keep separate contracts and operation-owned assets", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { service } = serviceFor(target, { probeTask: async () => acceptedProbe() });
  const prepare = (slug: string, title: string, artifactPath: string) => service.prepareTask({
    artifactPath,
    evaluatorSource: "print('{\"metric\": 1.0}')",
    invalidSample: { content: "{}", name: "invalid.json" },
    metricDirection: "minimize",
    metricName: "rmse",
    objective: `Objective for ${title}.`,
    projectId: target.projectId,
    runId: "conversation-run-1",
    sessionId: target.sessionId,
    slug,
    title,
    validSample: { content: "{}", name: "valid.json" },
  });
  const first = await prepare("task-a", "Task A", "artifacts/a.json");
  const second = await prepare("task-b", "Task B", "artifacts/b.json");
  assert.notEqual(first.taskId, second.taskId);
  assert.notEqual(first.taskVersionId, second.taskVersionId);
  const firstView = await startAccepted(service, target, plan.versionId, { taskVersionId: first.taskVersionId });
  const secondView = await startAccepted(service, target, plan.versionId, { taskVersionId: second.taskVersionId });
  assert.equal(firstView.state, "completed");
  assert.equal(secondView.state, "completed");
  assert.equal(firstView.task, first.taskId);
  assert.equal(secondView.task, second.taskId);
  const operations = service.list(target.projectId, target.sessionId);
  assert.equal(operations.length, 2);
  const firstOperation = operationFor(target, firstView.operationId);
  const secondOperation = operationFor(target, secondView.operationId);
  assert.notEqual(firstOperation.taskBinding?.assetDir, secondOperation.taskBinding?.assetDir);
  assert.match(await readFile(join(firstOperation.taskBinding!.assetDir!, "evaluator.py"), "utf8"), /metric/);
  assert.match(await readFile(join(secondOperation.taskBinding!.assetDir!, "task-manifest.json"), "utf8"), new RegExp(second.taskId));
  // Each start keeps its own artifact path contract.
  assert.equal(firstView.taskIdentity?.artifactPath, "artifacts/a.json");
  assert.equal(secondView.taskIdentity?.artifactPath, "artifacts/b.json");
});

function preparation(
  target: Fixture,
  slug: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    evaluatorSource: [
      "import json, math, sys",
      "value = json.loads(open(sys.argv[1], encoding='utf-8').read())",
      "x = value.get('x')",
      "if not isinstance(x, (int, float)) or not math.isfinite(x):",
      "    raise SystemExit(2)",
      "print(json.dumps({'metric': abs(x - 3.0)}))",
    ].join("\n"),
    invalidSample: { content: JSON.stringify({ x: "nope" }), name: "invalid.json" },
    metricDirection: "minimize" as const,
    metricName: "rmse",
    objective: `Fit the requested parameter for ${slug} and report the evaluated metric.`,
    projectId: target.projectId,
    runId: "conversation-run-1",
    sessionId: target.sessionId,
    slug,
    title: slug,
    validSample: { content: JSON.stringify({ x: 2.5 }), name: "valid.json" },
    ...overrides,
  };
}

/** A candidate artifact shaped like this deployment's own delivery. */
async function publishDelivered(
  target: Fixture,
  engineRunId: string,
  text: string,
): Promise<{ artifactId: string; versionId: string }> {
  const content = await new CasStore(target.store.dataDir).put(Buffer.from(text));
  const { artifact, version } = await target.store.createArtifactVersion({
    content,
    kind: "json",
    logicalName: `scienceflow/${engineRunId}/best-solution.json`,
    mediaType: "application/json",
    origin: "server_generated",
    originMeta: {
      deliveredBy: "scienceflow-result-delivery",
      externalEngine: "scienceflow",
      sourceRunId: engineRunId,
      sourceStageId: "S01",
    },
    sessionId: target.sessionId,
  });
  return { artifactId: artifact.id, versionId: version.id };
}

test("a non-default metric JSON path is carried from preparation into the run manifest", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { launches, service } = serviceFor(target, { probeTask: async () => acceptedProbe() });
  const prepared = await service.prepareTask(preparation(target, "nested-metric", {
    evaluatorSource: [
      "import json, math, sys",
      "value = json.loads(open(sys.argv[1], encoding='utf-8').read())",
      "x = value.get('x')",
      "if not isinstance(x, (int, float)) or not math.isfinite(x):",
      "    raise SystemExit(2)",
      "print(json.dumps({'result': {'loss': abs(x - 3.0)}}))",
    ].join("\n"),
    metricJsonPath: "result.loss",
  }));
  assert.deepEqual(prepared.metric, { jsonPath: "result.loss", lowerIsBetter: true, name: "rmse" });
  // The probe receives the same path the contract carries.
  const view = await startAccepted(service, target, plan.versionId, { taskVersionId: prepared.taskVersionId });
  assert.equal(view.state, "completed");
  assert.equal(view.taskIdentity?.metricJsonPath, "result.loss");
  const manifest = await readFile(launches[0]!, "utf8");
  assert.match(manifest, /json_path: "result\.loss"/);
  assert.doesNotMatch(manifest, /json_path: "metric"/);
});

test("an unusable metric JSON path is refused before any probe runs", async (context) => {
  const target = await fixture(context);
  let probes = 0;
  const { service } = serviceFor(target, {
    probeTask: async () => {
      probes += 1;
      return acceptedProbe();
    },
  });
  await assert.rejects(
    service.prepareTask(preparation(target, "bad-path", { metricJsonPath: "../metric" })),
    (error: unknown) => error instanceof TaskPreparationRefusal && error.reason === "invalid-option",
  );
  assert.equal(probes, 0);
});

const CONTRACT_SHA = "a".repeat(64);

function contractBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    authority: "exploratory-generated",
    evaluator: {
      language: "python",
      scriptName: "evaluator.py",
      sha256: CONTRACT_SHA,
      size: 32,
      versionId: "evaluator-version",
    },
    inputs: [],
    metric: { jsonPath: "metric", lowerIsBetter: true, name: "rmse" },
    objective: "Fit the parameter.",
    probes: [
      {
        artifactSha256: "b".repeat(64),
        expect: "accepted",
        label: "valid",
        lowerIsBetter: true,
        metricName: "rmse",
        metricValue: 0.5,
        ok: true,
        status: "ok",
      },
      {
        artifactSha256: "c".repeat(64),
        expect: "rejected",
        label: "invalid",
        lowerIsBetter: null,
        metricName: "",
        metricValue: null,
        ok: false,
        status: "evaluator_error",
      },
    ],
    provenance: {
      agentRunId: "run",
      preparedAt: "2026-11-16T00:00:00.000Z",
      publishedBy: "research-task-tool",
      sessionId: "session",
    },
    schemaVersion: 1,
    taskId: "sd-parser-check",
    title: "Parser check",
    ...overrides,
  };
}

function parseContract(body: Record<string, unknown>) {
  return parsePreparedTaskContract(Buffer.from(JSON.stringify(body), "utf8"));
}

test("a malformed contract probe or input is refused instead of silently dropped", () => {
  assert.equal(parseContract(contractBody()).probes.length, 2);
  const contractInvalid = (error: unknown) =>
    error instanceof TaskPreparationRefusal && error.reason === "contract-invalid";

  assert.throws(() => parseContract(contractBody({ probes: [] })), contractInvalid);
  assert.throws(
    () => parseContract(contractBody({ probes: [{ junk: true }] })),
    contractInvalid,
  );
  const accepted = contractBody().probes as Array<Record<string, unknown>>;
  const forged = structuredClone(accepted);
  forged[0]!.ok = "yes";
  assert.throws(() => parseContract(contractBody({ probes: forged })), contractInvalid);
  const doubled = structuredClone(accepted);
  doubled[1]!.expect = "accepted";
  assert.throws(() => parseContract(contractBody({ probes: doubled })), contractInvalid);
  assert.throws(
    () => parseContract(contractBody({ probes: [...accepted, { junk: true }] })),
    contractInvalid,
  );
  assert.throws(
    () => parseContract(contractBody({
      inputs: [{ logicalName: "nested/fit.csv", sha256: CONTRACT_SHA, size: 10, versionId: "v" }],
    })),
    contractInvalid,
  );
  assert.throws(
    () => parseContract(contractBody({
      inputs: [{ logicalName: "fit.csv", sha256: "not-a-digest", size: 10, versionId: "v" }],
    })),
    contractInvalid,
  );
  assert.throws(
    () => parseContract(contractBody({
      inputs: [
        { logicalName: "fit.csv", sha256: CONTRACT_SHA, size: 10, versionId: "v1" },
        { logicalName: "fit.csv", sha256: CONTRACT_SHA, size: 10, versionId: "v2" },
      ],
    })),
    contractInvalid,
  );
});

test("a normally edited contract version cannot inherit an older accepted probe", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { service } = serviceFor(target, { probeTask: async () => acceptedProbe() });
  const prepared = await service.prepareTask(preparation(target, "stale-probe"));
  const original = target.store.getProjectArtifactVersion(target.projectId, prepared.taskVersionId)!;
  const cas = new CasStore(target.store.dataDir);
  const contract = JSON.parse((await cas.read(original.content.hash)).toString("utf8")) as Record<string, unknown>;
  // A normal artifact edit: new evaluator bytes, old probe array copied through.
  const changedBytes = Buffer.from("raise SystemExit(2)\n");
  const changedContent = await cas.put(changedBytes);
  const evaluator = await target.store.createArtifactVersion({
    content: changedContent,
    kind: "other",
    logicalName: "changed-evaluator.py",
    mediaType: "text/x-python",
    origin: "llm_declared",
    sessionId: target.sessionId,
  });
  contract.evaluator = {
    ...(contract.evaluator as Record<string, unknown>),
    sha256: changedContent.hash,
    size: changedBytes.length,
    versionId: evaluator.version.id,
  };
  const changedContract = await target.store.createArtifactVersion({
    artifactId: prepared.contractArtifactId,
    baseVersionId: prepared.taskVersionId,
    content: await cas.put(Buffer.from(JSON.stringify(contract), "utf8")),
    kind: "json",
    logicalName: `research-tasks/${prepared.taskId}/contract.json`,
    mediaType: "application/json",
    origin: "llm_declared",
    sessionId: target.sessionId,
  });
  await assert.rejects(
    service.start({
      intent: "Run the edited task",
      ownerRunId: "edited-run",
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskVersionId: changedContract.version.id,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "invalid-option",
  );
});

test("a legitimate re-preparation is validated anew and starts", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  let probes = 0;
  const { service } = serviceFor(target, {
    probeTask: async () => {
      probes += 1;
      return acceptedProbe();
    },
  });
  const first = await service.prepareTask(preparation(target, "reprepared"));
  const second = await service.prepareTask(preparation(target, "reprepared", {
    evaluatorSource: "print('{\"metric\": 2.0}')\n",
  }));
  assert.equal(probes, 2);
  assert.equal(first.taskId, second.taskId);
  assert.notEqual(first.taskVersionId, second.taskVersionId);
  // Both probed versions remain runnable; neither borrowed the other's record.
  const firstView = await startAccepted(service, target, plan.versionId, { taskVersionId: first.taskVersionId });
  const secondView = await startAccepted(service, target, plan.versionId, { taskVersionId: second.taskVersionId });
  assert.equal(firstView.state, "completed");
  assert.equal(secondView.state, "completed");
});

test("continuation rejects a candidate delivered under another task contract", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { service } = serviceFor(target, { probeTask: async () => acceptedProbe() });
  const taskA = await service.prepareTask(preparation(target, "task-a"));
  const taskB = await service.prepareTask(preparation(target, "task-b", {
    artifactPath: "artifacts/weights.json",
    objective: "Task B requires a weights vector, not task A's single parameter.",
    evaluatorSource: [
      "import json, sys",
      "weights = json.loads(open(sys.argv[1], encoding='utf-8').read()).get('weights')",
      "if not isinstance(weights, list) or len(weights) != 2:",
      "    raise SystemExit(2)",
      "print(json.dumps({'metric': sum(v * v for v in weights)}))",
    ].join("\n"),
    invalidSample: { content: JSON.stringify({ x: 2.5 }), name: "invalid.json" },
    validSample: { content: JSON.stringify({ weights: [1, 2] }), name: "valid.json" },
  }));
  const firstA = await startAccepted(service, target, plan.versionId, { taskVersionId: taskA.taskVersionId });
  const operationA = operationFor(target, firstA.operationId);
  const candidate = await publishDelivered(target, operationA.engineRunId, JSON.stringify({ x: 2.5 }));

  // The task that produced the candidate may continue from it.
  const continued = await startAccepted(service, target, plan.versionId, {
    incumbentVersionId: candidate.versionId,
    taskVersionId: taskA.taskVersionId,
  });
  assert.equal(continued.state, "completed");
  assert.equal(continued.incumbentVersionId, candidate.versionId);

  // A different frozen contract may not.
  await assert.rejects(
    service.start({
      intent: "Continue a different task from task A's candidate",
      ownerRunId: "cross-task-run",
      incumbentVersionId: candidate.versionId,
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskVersionId: taskB.taskVersionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "continuation-task-mismatch",
  );
  // An explicitly uploaded candidate is a new baseline, not a delivered continuation.
  const seed = await publish(target.store, target.sessionId, "weights-seed.json", JSON.stringify({ weights: [1, 2] }), "json");
  const explicit = await startAccepted(service, target, plan.versionId, {
    incumbentVersionId: seed.versionId,
    taskVersionId: taskB.taskVersionId,
  });
  assert.equal(explicit.state, "completed");
});

test("a re-prepared task contract is a new experiment, not a continuation", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { service } = serviceFor(target, { probeTask: async () => acceptedProbe() });
  const original = await service.prepareTask(preparation(target, "evolving"));
  const first = await startAccepted(service, target, plan.versionId, { taskVersionId: original.taskVersionId });
  const operation = operationFor(target, first.operationId);
  const candidate = await publishDelivered(target, operation.engineRunId, JSON.stringify({ x: 2.5 }));
  const reworked = await service.prepareTask(preparation(target, "evolving", {
    evaluatorSource: "print('{\"metric\": 1.0}')\n",
  }));
  await assert.rejects(
    service.start({
      intent: "Continue the changed task contract",
      ownerRunId: "changed-contract-run",
      incumbentVersionId: candidate.versionId,
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskVersionId: reworked.taskVersionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "continuation-task-mismatch",
  );
});

test("a catalog task with an unresolved evaluator dependency is refused before launch", async (context) => {
  const target = await fixture(context);
  const plan = await publish(target.store, target.sessionId, "research-plan.md", PLAN_TEXT);
  const { launches, service } = serviceFor(target, {
    describeTask: async () => ({
      artifactKind: "json_solution",
      artifactPath: "artifacts/best_solution.json",
      authoritative: true,
      category: "opt_solver",
      description: "# Ratio minimization\n\nPlace 16 points.",
      descriptionAvailable: true,
      evaluatorEntrypoint: "evaluator.py:evaluate",
      id: "ratio-minimization",
      inputsRequired: null,
      lowerIsBetter: false,
      metricName: "inv_ratio_squared",
      metricType: "benchmark",
      missingModules: ["numpy", "scipy"],
      profile: "opt_solver",
      provider: "",
    }),
  });
  await assert.rejects(
    service.start({
      intent: "Run a package whose evaluator cannot import its dependencies",
      ownerRunId: "dependency-gap-run",
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      taskPackageId: "ratio-minimization",
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "invalid-option"
      && /numpy, scipy/u.test(error.message),
  );
  assert.equal(launches.length, 0);
});
