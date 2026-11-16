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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TestContext } from "node:test";

import { CasStore } from "@sciencediscovery/cas";
import {
  SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
  type ReadScienceFlowRunSnapshotOptions,
  type ScienceFlowRunSnapshot,
  type ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";

import { SessionStore } from "../store.js";
import {
  deliverScienceFlowResult,
  type ScienceFlowResultDeliveryRecord,
} from "./result-delivery.js";
import {
  createLocalResearchService,
  LocalResearchRefusal,
  type LocalResearchServiceStore,
} from "./local-research.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import type { ResearchPilotLauncher, ResearchPilotLaunchOutcome } from "./research-pilot.js";

const TASK = "circle-packing";
const PLAN_TEXT = "# plan\n";
const SEED_TEXT = JSON.stringify({ circles: [[0.5, 0.5, 0.1]] });
const NEW_TEXT = JSON.stringify({ circles: [[0.5, 0.5, 0.11], [0.1, 0.1, 0.01]] });
const STAGE_METRICS = [2.61661905326, 2.6239750175348147];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Fixture {
  readonly root: string;
  readonly store: SessionStore;
  readonly projectId: string;
  readonly sessionId: string;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly planVersionId: string;
  readonly incumbentVersionId: string;
  readonly workRoot: string;
}

async function fixture(context: TestContext, options: { readonly model?: "openai" | "anthropic" } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Local research");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
    ...(options.model === "anthropic" ? { apiProtocol: "anthropic-messages" } : {}),
  });
  const session = await store.createSession(project.id, "Research session", { modelId: model.id });
  const seedDir = join(root, "seed");
  const workRoot = join(root, "work");
  const privateRoot = join(root, "private");
  await mkdir(seedDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  // The profile's fixed experiment: these are the exact bytes the engine will
  // receive, and the versions published below are their Session identity.
  await writeFile(join(seedDir, "experiment_plan.md"), PLAN_TEXT, "utf8");
  await writeFile(join(seedDir, "incumbent.json"), SEED_TEXT, "utf8");
  const plan = await publishVersion(store, project.id, session.id, "scienceflow/round23/experiment-plan.md", PLAN_TEXT);
  const incumbent = await publishVersion(store, project.id, session.id, "scienceflow/round23/incumbent.json", SEED_TEXT);
  return {
    incumbentVersionId: incumbent.versionId,
    planVersionId: plan.versionId,
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
      engineCheckout: join(root, "engine"),
      privateRoot,
      profileId: "round23-local",
      pythonExecutable: join(root, "python-not-used"),
      readerScriptPath: join(root, "snapshot.py"),
      refusePackageInstall: true,
      seedDir,
      inputs: {
        incumbent: join(seedDir, "incumbent.json"),
        plan: join(seedDir, "experiment_plan.md"),
      },
      task: TASK,
      taskDescription: "Run the two bounded commands and report the trial log.",
      workRoot,
    },
    store,
    workRoot,
  };
}

async function publishVersion(
  store: SessionStore,
  projectId: string,
  sessionId: string,
  logicalName: string,
  text: string,
): Promise<{ artifactId: string; versionId: string }> {
  const content = await new CasStore(store.dataDir).put(Buffer.from(text));
  const { artifact, version } = await store.createArtifactVersion({
    content,
    kind: "markdown",
    logicalName,
    mediaType: "text/markdown",
    origin: "server_generated",
    originMeta: { purpose: "local-research-fixture" },
    sessionId,
    title: "Fixture artifact",
  });
  assert.equal(artifact.createdInSessionId, sessionId);
  assert.ok(projectId);
  return { artifactId: artifact.id, versionId: version.id };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A launch that writes what a completed engine run leaves behind. */
function completedLaunch(context: TestContext, calls: { count: number }): ResearchPilotLauncher {
  return async (input): Promise<ResearchPilotLaunchOutcome> => {
    calls.count += 1;
    const taskRoot = join(input.workDir, "runs", input.runId, TASK);
    const snapshots: Array<[string, string, number, string]> = [
      ["S01", SEED_TEXT, STAGE_METRICS[0]!, ""],
      ["S02", NEW_TEXT, STAGE_METRICS[1]!, "S01"],
    ];
    const rows: string[] = [];
    for (const [stageId, text, metric, parent] of snapshots) {
      const snapshot = join(taskRoot, "workers", "w00", "snapshots", stageId);
      await mkdir(join(snapshot, "artifacts"), { recursive: true });
      await writeFile(join(snapshot, "artifacts", "best_solution.json"), text, "utf8");
      rows.push([
        stageId, parent, `W00:L01:${stageId}`, "radii_sum", String(metric), "0",
        "1", "1", "1", "ok", sha256(text), "artifacts/best_solution.json",
        snapshot, "2026-11-15T05:00:00Z",
      ].join(","));
    }
    await mkdir(join(taskRoot, "task_logs"), { recursive: true });
    await writeFile(
      join(taskRoot, "task_logs", "lhr_stage_performance.csv"),
      [
        "stage_id,parent_stage_id,candidate_id,metric_name,metric_value,lower_is_better,validation_ok,"
          + "selection_eligible,gate_accepted,evaluator_status,artifact_sha,artifact_path,snapshot_path,created_at_utc",
        ...rows,
        "",
      ].join("\n"),
      "utf8",
    );
    // The researcher's own run records, as the runner leaves them.
    const workspaceArtifacts = join(taskRoot, "workers", "w00", "workspace", "artifacts");
    await mkdir(workspaceArtifacts, { recursive: true });
    await writeFile(
      join(workspaceArtifacts, "trial_log.tsv"),
      "arm\tindex\tseed\telapsed_s\tradii_sum\tstatus\texit_code\nA\t1\t101\t7.2\t2.62\tvalid\t0\n",
      "utf8",
    );
    await writeFile(
      join(workspaceArtifacts, "submit_log.tsv"),
      "arm\tcandidate\tradii_sum\nA\tA_1.json\t2.62\n",
      "utf8",
    );
    await mkdir(input.stateHome, { recursive: true });
    await mkdir(join(input.stateHome, "scienceflow", "managed_runs", input.runId), { recursive: true });
    await writeFile(
      join(input.stateHome, "scienceflow", "managed_runs", input.runId, "control.json"),
      JSON.stringify({ alive: false, phase: "finished", pid: 4242, report_status: "completed",
        research_status: "completed", run_id: input.runId, status: "completed" }),
      "utf8",
    );
    context.after(() => undefined);
    return {      elapsedSec: 1,
      outcome: "finished",
      phase: "finished",
      reportStatus: "completed",
      researchStatus: "completed",
      status: "completed",
      supervisorAliveAfterFinish: false,
      supervisorPid: 4242,
    };
  };
}

function reader(): (options: ReadScienceFlowRunSnapshotOptions) => Promise<ScienceFlowSnapshotReadResult> {
  return async (options) => {
    const taskRoot = options.allowedTaskRoots[0]!;
    const runId = basename(dirname(options.runRecordPath));
    const path = join(taskRoot, "workers", "w00", "snapshots", "S02", "artifacts", "best_solution.json");
    const snapshot: ScienceFlowRunSnapshot = {
      diagnostics: [],
      phase: "finished",
      rawStatus: "completed",
      runId,
      schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
      tasks: [{
        candidateArtifact: {
          digestVerified: true,
          lowerIsBetter: false,
          metricName: "radii_sum",
          metricValue: STAGE_METRICS[1]!,
          path,
          recordedSha256: sha256(NEW_TEXT),
          sha256: sha256(NEW_TEXT),
          stageId: "S02",
        },
        evidenceReferences: ["task_logs/lhr_stage_performance.csv"],
        reportedBestMetric: {
          lowerIsBetter: false,
          metricName: "radii_sum",
          metricValue: STAGE_METRICS[1]!,
          source: "lhr_stage_performance",
        },
        taskRoot: null,
      }],
    };
    return { snapshot, status: "ok" };
  };
}

function serviceFor(
  target: Fixture,
  dependencies: Parameters<typeof createLocalResearchService>[1] = {},
) {
  return createLocalResearchService({ settings: target.settings, store: target.store }, dependencies);
}

async function waitTerminal(
  service: ReturnType<typeof createLocalResearchService>,
  identity: { readonly projectId: string; readonly sessionId: string; readonly operationId: string },
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let view = await service.get(identity, { waitMs: 200 });
  while (Date.now() < deadline) {
    view = await service.get(identity, { waitMs: 200 });
    if (view.state !== "accepted" && view.state !== "running" && view.state !== "stopping"
      && view.delivery.state !== "pending") return view;
    await sleep(100);
  }
  return view;
}

test("one accepted start becomes one run, an evaluated stage and delivered artifacts", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, {
    deliver: (store, request) => deliverScienceFlowResult(store as unknown as SessionStore, request, {
      readSnapshot: reader(),
    }),
    launch: completedLaunch(context, calls),
  });
  const outcome = await service.start({
    incumbentVersionId: target.incumbentVersionId,
    intent: "Run the bounded routing ablation and report the trial log.",
    ownerRunId: "conversation-run-1",
    planVersionId: target.planVersionId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(outcome.attached, false);
  assert.match(outcome.operation.engineRunId, /^sd-research-/);
  assert.equal(outcome.operation.state, "accepted");
  // The start freezes the credential-free model selection it resolved.
  assert.equal(outcome.operation.model?.providerModel, "fixture-model");
  // The named versions were accepted because their bytes are exactly the
  // profile's configured inputs; the record keeps both digests and identities.
  assert.deepEqual(outcome.operation.inputs, [
    {
      role: "plan",
      sha256: sha256(PLAN_TEXT),
      size: Buffer.byteLength(PLAN_TEXT),
      versionId: target.planVersionId,
    },
    {
      role: "incumbent",
      sha256: sha256(SEED_TEXT),
      size: Buffer.byteLength(SEED_TEXT),
      versionId: target.incumbentVersionId,
    },
  ]);

  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(calls.count, 1);
  assert.equal(view.state, "completed");
  assert.equal(view.stages.length, 2);
  assert.equal(view.stages[1]!.stageId, "S02");
  assert.equal(view.delivery.state, "delivered");
  assert.equal(view.delivery.selectedStageId, "S02");
  assert.equal(view.delivery.metricValue, STAGE_METRICS[1]);
  assert.ok(view.delivery.solution, "the selected solution must be delivered");
  assert.ok(view.delivery.note, "the result note must be delivered");
  // The selected stage is represented by the solution artifact; every other
  // captured stage is published beside it.
  assert.deepEqual(view.delivery.staged?.map((attempt) => attempt.role), ["carried_seed"]);
  assert.equal(view.planVersionId, target.planVersionId);
  assert.equal(view.incumbentVersionId, target.incumbentVersionId);
  // The launch manifest points the engine at the very seed directory whose
  // files were proven equal to the named versions above.
  const manifest = await readFile(
    join(target.workRoot, "operations", outcome.operation.operationId, "pilot-manifest.yaml"),
    "utf8",
  );
  assert.ok(
    manifest.split("\n").some((line) => line.trim() === `input_data_dir: ${JSON.stringify(target.settings.seedDir)}`),
    "the manifest must hand the engine the configured fixed input directory",
  );
  assert.equal(view.experimentalLocalExecution, true);
  assert.equal(view.formalRunnerSandbox, false);

  // The Agent-visible view carries no host path or credential-shaped field.
  const serialized = JSON.stringify(view);
  for (const forbidden of [target.root, "python-not-used", "engineCheckout", "privateRoot", "workDir"]) {
    assert.ok(!serialized.includes(forbidden), `the view must not expose ${forbidden}`);
  }

  // The Session's list projection is the same path-free view the card reads.
  const listed = service.list(target.projectId, target.sessionId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.operationId, view.operationId);
  assert.ok(!JSON.stringify(listed).includes(target.root));
  assert.throws(
    () => service.list("not-a-project", target.sessionId),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "project-not-found",
  );

  // The delivered solution really is the evaluated candidate's bytes.
  const solution = target.store.listProjectArtifactVersions(target.projectId, view.delivery.solution!.artifactId)
    .find((version) => version.id === view.delivery.solution!.versionId);
  assert.ok(solution);
  const bytes = await new CasStore(target.store.dataDir).read(solution.content.hash);
  assert.equal(bytes.toString("utf8"), NEW_TEXT);

  // The note must state that this deployment started the run, not that it was
  // an external run SD only observed.
  const note = target.store.listProjectArtifactVersions(target.projectId, view.delivery.note!.artifactId)
    .find((version) => version.id === view.delivery.note!.versionId);
  assert.ok(note);
  const noteText = (await new CasStore(target.store.dataDir).read(note.content.hash)).toString("utf8");
  assert.match(noteText, /experimental local research mode/);
  assert.ok(!noteText.includes("did not start or evaluate"), "the note must not deny starting the run");
  // The researcher's own records are delivered unchanged, so the Session can
  // see which commands ran instead of inferring from the stage chain.
  assert.match(noteText, /## Researcher run records/);
  assert.equal(view.delivery.researcher?.length, 2);
  assert.ok(view.delivery.researcher!.every((entry) =>
    entry.logicalName.includes("/researcher/") && entry.role === "researcher_record"));
  const trialLog = target.store.listProjectArtifactVersions(target.projectId, view.delivery.researcher![0]!.artifactId)
    .find((version) => version.id === view.delivery.researcher![0]!.versionId);
  assert.ok(trialLog);
  const trialText = (await new CasStore(target.store.dataDir).read(trialLog.content.hash)).toString("utf8");
  assert.match(trialText, /^arm\tindex\tseed/);
  assert.match(trialText, /A\t1\t101/);
});

test("a replayed accepted start attaches instead of launching a second run", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, {
    deliver: (store, request) => deliverScienceFlowResult(store as unknown as SessionStore, request, {
      readSnapshot: reader(),
    }),
    launch: completedLaunch(context, calls),
  });
  const request = {
    intent: "Run the bounded experiment and report the result.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  };
  const first = await service.start(request);
  const second = await service.start(request);
  assert.equal(second.attached, true);
  assert.equal(second.attachedReason, "same-request");
  assert.equal(second.operation.operationId, first.operation.operationId);
  // A different label in the still-live conversation run also attaches.
  const third = await service.start({ ...request, intent: "Run it again please." });
  assert.equal(third.attached, true);
  assert.equal(third.attachedReason, "active-operation");
  await waitTerminal(service, { operationId: first.operation.operationId, ...request });
  assert.equal(calls.count, 1);
});

test("refuses an unsupported model and an unknown Session before anything runs", async (context) => {
  const target = await fixture(context, { model: "anthropic" });
  const calls = { count: 0 };
  const service = serviceFor(target, { launch: completedLaunch(context, calls) });
  await assert.rejects(
    service.start({
      intent: "Run the experiment.",
      ownerRunId: "run",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "unsupported-model",
  );
  await assert.rejects(
    service.start({
      intent: "Run the experiment.",
      ownerRunId: "run",
      projectId: target.projectId,
      sessionId: randomUUID(),
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "session-not-found",
  );
  assert.equal(calls.count, 0);
});

test("a linked version that is not the configured input is refused before launch", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, { launch: completedLaunch(context, calls) });
  // Both are live versions of this same Session; only their bytes differ from
  // the profile's fixed experiment, so neither may be linked to a run.
  const otherPlan = await publishVersion(
    target.store,
    target.projectId,
    target.sessionId,
    "scienceflow/round23/experiment-plan-2.md",
    "# a different plan\n",
  );
  const otherIncumbent = await publishVersion(
    target.store,
    target.projectId,
    target.sessionId,
    "scienceflow/round23/incumbent-2.json",
    JSON.stringify({ circles: [[0.2, 0.2, 0.2]] }),
  );
  const request = {
    intent: "Run the configured experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  };
  await assert.rejects(
    service.start({ ...request, planVersionId: otherPlan.versionId, incumbentVersionId: target.incumbentVersionId }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-mismatch",
  );
  await assert.rejects(
    service.start({ ...request, planVersionId: target.planVersionId, incumbentVersionId: otherIncumbent.versionId }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-mismatch",
  );
  assert.equal(calls.count, 0, "a mismatched input must never reach the engine");
  assert.equal(service.latest(target.projectId, target.sessionId), undefined);
});

test("a version for a role the profile does not bind is refused instead of linked", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const { inputs: ignored, ...unbound } = target.settings;
  void ignored;
  const service = createLocalResearchService(
    { settings: unbound, store: target.store },
    { launch: completedLaunch(context, calls) },
  );
  await assert.rejects(
    service.start({
      incumbentVersionId: target.incumbentVersionId,
      intent: "Run the configured experiment.",
      ownerRunId: "conversation-run-1",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-not-supported",
  );
  assert.equal(calls.count, 0);
  assert.equal(service.latest(target.projectId, target.sessionId), undefined);
});

test("a start under an already cancelled conversation creates nothing", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, {
    launch: completedLaunch(context, calls),
    ownerRunStatus: async () => "cancelled",
  });
  await assert.rejects(
    service.start({
      intent: "Run the configured experiment.",
      ownerRunId: "conversation-run-1",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "conversation-cancelled",
  );
  assert.equal(calls.count, 0);
  assert.equal(service.latest(target.projectId, target.sessionId), undefined);
});

test("cancellation between acceptance and the worker records a stop instead of launching", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  let statusChecks = 0;
  const service = serviceFor(target, {
    launch: completedLaunch(context, calls),
    // The start sees a live conversation; by the time the background worker
    // re-checks, the user has cancelled it.
    ownerRunStatus: async () => {
      statusChecks += 1;
      return statusChecks === 1 ? "running" : "cancelled";
    },
  });
  await service.start({
    intent: "Run the configured experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const deadline = Date.now() + 5_000;
  let record = service.latest(target.projectId, target.sessionId);
  while (record?.state !== "stopped" && Date.now() < deadline) {
    await sleep(20);
    record = service.latest(target.projectId, target.sessionId);
  }
  assert.equal(record?.state, "stopped");
  assert.equal(record?.stop.requestedBy, "conversation-cancel");
  assert.equal(calls.count, 0, "a cancelled conversation must not launch a late run");
});

test("a genuinely new user experiment receives a new operation identity", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, { launch: completedLaunch(context, calls) });
  const request = {
    intent: "Run the bounded experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  };
  const first = await service.start(request);
  // A later user message is a different conversation run; the same intent is a
  // new experiment, not a replay of the first one.
  const second = await service.start({ ...request, ownerRunId: "conversation-run-2" });
  assert.equal(first.attached, false);
  assert.equal(second.attached, false);
  assert.notEqual(second.operation.operationId, first.operation.operationId);
  await waitTerminal(service, {
    operationId: first.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  await waitTerminal(service, {
    operationId: second.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(calls.count, 2);
});

test("a rebuilt service observes and delivers the existing run without relaunching", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, {
    deliver: (store, request) => deliverScienceFlowResult(store as unknown as SessionStore, request, {
      readSnapshot: reader(),
    }),
    launch: completedLaunch(context, calls),
  });
  const started = await service.start({
    intent: "Run the bounded experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const finished = await waitTerminal(service, {
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });

  // A second composition over the same data directory: no worker exists, and a
  // launch would be a duplicate run, so it must never be called.
  const rebuilt = serviceFor(target, {
    launch: async () => {
      throw new Error("a rebuilt service must not launch again");
    },
  });
  const observed = await rebuilt.get({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  }, { waitMs: 0 });
  assert.equal(observed.operationId, finished.operationId);
  assert.equal(observed.engineRunId, finished.engineRunId);
  assert.equal(observed.state, "completed");
  assert.equal(observed.delivery.state, "delivered");
  assert.equal(calls.count, 1);
});

test("stop on an already terminal run requests nothing and reports the engine state", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  const service = serviceFor(target, {
    deliver: (store, request) => deliverScienceFlowResult(store as unknown as SessionStore, request, {
      readSnapshot: reader(),
    }),
    launch: completedLaunch(context, calls),
  });
  const started = await service.start({
    intent: "Run the bounded experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  await waitTerminal(service, {
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const stopped = await service.stop({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(stopped.requested, false);
  assert.equal(stopped.reason, "already-terminal");
  assert.equal(stopped.operation.state, "completed");
});

test("a failed delivery is visible and retry republishes without rerunning research", async (context) => {
  const target = await fixture(context);
  const calls = { count: 0 };
  let deliveries = 0;
  const failure = {
    artifacts: {},
    attempts: [],
    finishedAt: "2026-11-15T00:00:00Z",
    identity: { projectId: target.projectId, sessionId: target.sessionId },
    invocation: "scienceflow-result-delivery",
    outcome: { failedStep: "readback", message: "fixture readback failure", reason: "readback-failed", status: "failed" },
    incumbent: null,
    plan: null,
    registration: null,
    run: { runId: "fixture", task: TASK },
    runState: null,
    schemaVersion: 1,
    selected: null,
    snapshot: null,
    stages: null,
    startedAt: "2026-11-15T00:00:00Z",
  } as unknown as ScienceFlowResultDeliveryRecord;
  const service = serviceFor(target, {
    deliver: (store, request) => {
      deliveries += 1;
      return deliveries === 1
        ? Promise.resolve(failure)
        : deliverScienceFlowResult(store as unknown as SessionStore, request, { readSnapshot: reader() });
    },
    launch: completedLaunch(context, calls),
  });
  const started = await service.start({
    intent: "Run the bounded experiment.",
    ownerRunId: "conversation-run-1",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const failed = await waitTerminal(service, {
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(failed.state, "completed");
  assert.equal(failed.delivery.state, "failed");
  assert.equal(failed.delivery.reason, "readback-failed");
  assert.match(failed.instruction, /retry_delivery/);

  const retried = await service.retryDelivery({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(deliveries, 2);
  assert.equal(calls.count, 1, "retrying publication must not rerun the experiment");
});

test("a non-object store view is refused rather than guessed", async (context) => {
  const target = await fixture(context);
  const service = serviceFor(target);
  await assert.rejects(
    service.get({ operationId: "missing", projectId: target.projectId, sessionId: target.sessionId }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "operation-not-found",
  );
  assert.equal(service.latest(target.projectId, target.sessionId), undefined);
});

void ({} as LocalResearchServiceStore);
