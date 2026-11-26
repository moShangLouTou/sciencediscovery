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
 * Dynamic input mode: the Session supplies the plan and the incumbent for one
 * task package, and each accepted operation stages exactly those bytes into its
 * own directory before the engine starts.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { deliverScienceFlowResult } from "./result-delivery.js";
import {
  createLocalResearchService,
  LocalResearchRefusal,
} from "./local-research.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import type { ResearchPilotLauncher, ResearchPilotLaunchOutcome } from "./research-pilot.js";

const TASK = "circle-packing";
const PLAN_TEXT = "# plan v1\nSearch from the fixed start and submit one candidate.\n";
const PLAN_TEXT_V2 = "# plan v2\nSearch with a different operator order and submit one candidate.\n";
const INCUMBENT_TEXT = JSON.stringify({ circles: [[0.5, 0.5, 0.1]] });
const NEW_TEXT = JSON.stringify({ circles: [[0.5, 0.5, 0.11], [0.1, 0.1, 0.01]] });
const STAGE_METRICS = [2.61661905326, 2.6239750175348147];
const TEMPLATE = [
  "# Bounded circle-packing run",
  "",
  "Read the plan at {{plan_file}} (version {{plan_version_id}}) and carry it out.",
  "The fixed start is {{incumbent_file}} (version {{incumbent_version_id}}).",
  "Research intent for this operation: {{research_intent}}",
  "Operation {{operation_id}}.",
  "",
].join("\n");

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Fixture {
  readonly assetsDir: string;
  readonly incumbents: { readonly artifactId: string; readonly versionId: string };
  readonly plan: { readonly artifactId: string; readonly v1: string; readonly v2: string };
  readonly projectId: string;
  readonly root: string;
  readonly sessionId: string;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly store: SessionStore;
  readonly workRoot: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-dynamic-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Dynamic research");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Dynamic session", { modelId: model.id });
  const assetsDir = join(root, "assets");
  const workRoot = join(root, "work");
  const privateRoot = join(root, "private");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(join(assetsDir, "kernel"), { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  // Supporting assets the administrator owns: copied into every operation but
  // never confused with the plan or the incumbent the Session selects.
  await writeFile(join(assetsDir, "kernel", "packing_core.py"), "KERNEL = 1\n", "utf8");
  await writeFile(join(assetsDir, "submit.py"), "print('submit')\n", "utf8");

  const planV1 = await publish(store, project.id, session.id, "research-plan.md", PLAN_TEXT, "Plan");
  const planV2 = await publishVersion(store, project.id, session.id, planV1.artifactId, planV1.versionId, PLAN_TEXT_V2);
  const incumbent = await publish(
    store, project.id, session.id, "scienceflow/round23/solution.json", INCUMBENT_TEXT, "Incumbent",
  );
  return {
    assetsDir,
    incumbents: { artifactId: incumbent.artifactId, versionId: incumbent.versionId },
    plan: { artifactId: planV1.artifactId, v1: planV1.versionId, v2: planV2.versionId },
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
      dynamicInputs: { incumbent: "start_solution.json", plan: "experiment_plan.md" },
      engineCheckout: join(root, "engine"),
      inputMode: "dynamic",
      privateRoot,
      profileId: "round24-local",
      pythonExecutable: join(root, "python-not-used"),
      readerScriptPath: join(root, "snapshot.py"),
      refusePackageInstall: true,
      seedDir: assetsDir,
      task: TASK,
      taskTemplate: TEMPLATE,
      workRoot,
    },
    store,
    workRoot,
  };
}

async function publish(
  store: SessionStore,
  projectId: string,
  sessionId: string,
  logicalName: string,
  text: string,
  title: string,
): Promise<{ artifactId: string; versionId: string }> {
  const content = await new CasStore(store.dataDir).put(Buffer.from(text));
  const { artifact, version } = await store.createArtifactVersion({
    content,
    kind: "markdown",
    logicalName,
    mediaType: "text/markdown",
    origin: "server_generated",
    originMeta: { purpose: "dynamic-fixture" },
    sessionId,
    title,
  });
  assert.equal(artifact.createdInSessionId, sessionId);
  assert.ok(projectId);
  return { artifactId: artifact.id, versionId: version.id };
}

async function publishVersion(
  store: SessionStore,
  projectId: string,
  sessionId: string,
  artifactId: string,
  baseVersionId: string,
  text: string,
): Promise<{ artifactId: string; versionId: string }> {
  const content = await new CasStore(store.dataDir).put(Buffer.from(text));
  const { artifact, version } = await store.createArtifactVersion({
    artifactId,
    baseVersionId,
    content,
    kind: "markdown",
    logicalName: "research-plan.md",
    mediaType: "text/markdown",
    origin: "server_generated",
    sessionId,
  });
  assert.ok(projectId);
  return { artifactId: artifact.id, versionId: version.id };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What a launch observes about the staged input, and what it leaves behind. */
interface LaunchRecord {
  assets: readonly string[];
  count: number;
  inputDataDir?: string;
  manifest?: string;
  stagedIncumbent?: string;
  stagedPlan?: string;
  taskText?: string;
}

function recordingLaunch(record: LaunchRecord, incumbentExpected = true): ResearchPilotLauncher {
  return async (input): Promise<ResearchPilotLaunchOutcome> => {
    record.count += 1;
    const manifest = await readFile(input.manifestPath, "utf8");
    record.manifest = manifest;
    const line = manifest.split("\n").find((candidate) => candidate.trim().startsWith("input_data_dir:"))!;
    const dir = JSON.parse(line.split("input_data_dir:")[1]!.trim()) as string;
    record.inputDataDir = dir;
    record.stagedPlan = await readFile(join(dir, "experiment_plan.md"), "utf8");
    if (incumbentExpected) {
      record.stagedIncumbent = await readFile(join(dir, "start_solution.json"), "utf8");
    } else {
      await assert.rejects(readFile(join(dir, "start_solution.json")), { code: "ENOENT" });
    }
    record.assets = await readdir(join(dir, "kernel"));
    record.taskText = manifest
      .split("\n")
      .slice(manifest.split("\n").findIndex((candidate) => candidate.trim() === "task: |") + 1)
      .filter((candidate) => candidate.startsWith("      "))
      .map((candidate) => candidate.slice(6))
      .join("\n");

    const taskRoot = join(input.workDir, "runs", input.runId, TASK);
    const snapshots: Array<[string, string, number, string]> = [
      ["S01", INCUMBENT_TEXT, STAGE_METRICS[0]!, ""],
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
        snapshot, "2026-11-16T05:00:00Z",
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
    await mkdir(join(input.stateHome, "scienceflow", "managed_runs", input.runId), { recursive: true });
    await writeFile(
      join(input.stateHome, "scienceflow", "managed_runs", input.runId, "control.json"),
      JSON.stringify({ alive: false, phase: "finished", pid: 4242, report_status: "completed",
        research_status: "completed", run_id: input.runId, status: "completed" }),
      "utf8",
    );
    return {
      elapsedSec: 1,
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

function ready(target: Fixture, dependencies: Parameters<typeof createLocalResearchService>[1] = {}) {
  return serviceFor(target, {
    deliver: (store, request) => deliverScienceFlowResult(store as unknown as SessionStore, request, {
      readSnapshot: reader(),
    }),
    ...dependencies,
  });
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

function startInput(target: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    incumbentVersionId: target.incumbents.versionId,
    intent: "Run the revised plan from the current candidate and report what the run actually did.",
    ownerRunId: "conversation-run-1",
    planVersionId: target.plan.v1,
    projectId: target.projectId,
    sessionId: target.sessionId,
    ...overrides,
  } as Parameters<ReturnType<typeof createLocalResearchService>["start"]>[0];
}

test("a fresh Session starts without a candidate, then continues from its delivered candidate", async (context) => {
  const base = await fixture(context);
  const session = await base.store.createSession(base.projectId, "From scratch");
  const target = { ...base, sessionId: session.id, settings: {
    ...base.settings,
    dynamicInputs: { plan: "experiment_plan.md", incumbent: "start_solution.json", incumbentOptional: true },
  } };
  const plan = await publish(target.store, target.projectId, session.id, "scratch-plan.md", PLAN_TEXT, "Scratch plan");
  const record: LaunchRecord = { assets: [], count: 0 };
  let first = true;
  const service = ready(target, { launch: async (request) => {
    const expectIncumbent = !first;
    first = false;
    return recordingLaunch(record, expectIncumbent)(request);
  } });
  assert.equal(service.incumbentMode, "optional");
  const request = startInput(target, { planVersionId: plan.versionId, incumbentVersionId: undefined });
  await assert.rejects(service.start({ ...request, planVersionId: undefined }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-missing");
  await assert.rejects(service.start({ ...request, incumbentVersionId: base.incumbents.versionId }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-not-found");
  assert.equal(record.count, 0);
  const outcome = await service.start(request);
  const identity = { projectId: target.projectId, sessionId: session.id, operationId: outcome.operation.operationId };
  const view = await waitTerminal(service, identity);
  assert.equal(view.state, "completed");
  assert.equal(view.incumbentVersionId, null);
  assert.deepEqual(view.inputs.map(input => input.role), ["plan"]);
  assert.equal(record.stagedIncumbent, undefined);
  assert.equal(view.delivery.state, "delivered");
  const solution = view.delivery.solution;
  assert.ok(solution);
  const revised = await publish(target.store, target.projectId, session.id, "revised-plan.md", PLAN_TEXT_V2, "Revised plan");
  const second = await service.start({ ...request, ownerRunId: "conversation-run-2",
    planVersionId: revised.versionId, incumbentVersionId: solution.versionId });
  const continued = await waitTerminal(service, { ...identity, operationId: second.operation.operationId });
  assert.equal(continued.state, "completed");
  assert.equal(continued.incumbentVersionId, solution.versionId);
  assert.equal(record.stagedIncumbent, NEW_TEXT);
  assert.equal(record.count, 2);
});

test("a dynamic start stages exactly the selected plan and incumbent", async (context) => {
  const target = await fixture(context);
  const record: LaunchRecord = { assets: [], count: 0 };
  const service = ready(target, { launch: recordingLaunch(record) });
  const outcome = await service.start(startInput(target));
  assert.equal(outcome.attached, false);
  assert.equal(outcome.operation.inputMode, "dynamic");
  assert.deepEqual(outcome.operation.inputs, [
    {
      role: "plan",
      sha256: sha256(PLAN_TEXT),
      size: Buffer.byteLength(PLAN_TEXT),
      stagedName: "experiment_plan.md",
      versionId: target.plan.v1,
    },
    {
      role: "incumbent",
      sha256: sha256(INCUMBENT_TEXT),
      size: Buffer.byteLength(INCUMBENT_TEXT),
      stagedName: "start_solution.json",
      versionId: target.incumbents.versionId,
    },
  ]);

  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 1);
  assert.equal(view.state, "completed");
  assert.equal(view.delivery.state, "delivered");

  // The engine's manifest points at this operation's own directory, and the
  // files the researcher reads there are the selected bytes plus the assets.
  const operationDir = join(target.workRoot, "operations", outcome.operation.operationId);
  assert.equal(record.inputDataDir, join(operationDir, "input"));
  assert.equal(record.stagedPlan, PLAN_TEXT);
  assert.equal(record.stagedIncumbent, INCUMBENT_TEXT);
  assert.deepEqual(record.assets, ["packing_core.py"]);
  // The composed instruction carries the real intent, the staged paths and the
  // version identities this run was accepted with.
  assert.match(record.taskText!, /Run the revised plan from the current candidate/);
  assert.match(record.taskText!, /dataset\/experiment_plan\.md/);
  assert.match(record.taskText!, /dataset\/start_solution\.json/);
  assert.ok(record.taskText!.includes(target.plan.v1));
  assert.ok(record.taskText!.includes(outcome.operation.operationId));

  // The durable record froze the directory, the manifest digest and the task
  // text this launch used.
  const stored = target.store.scienceFlowResearchOperations.get(outcome.operation.operationId);
  assert.ok(stored?.stagedInputs);
  assert.equal(stored.stagedInputs.dataDir, join(operationDir, "input"));
  assert.match(stored.stagedInputs.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(stored.launch.taskDescription, record.taskText);

  // The Agent-visible view carries no host path.
  const serialized = JSON.stringify(view);
  for (const forbidden of [target.root, "python-not-used", "engineCheckout", "privateRoot", "workDir"]) {
    assert.ok(!serialized.includes(forbidden), `the view must not expose ${forbidden}`);
  }
});

test("a newer plan version after acceptance cannot change the staged plan", async (context) => {
  const target = await fixture(context);
  const record: LaunchRecord = { assets: [], count: 0 };
  let switched = false;
  const service = ready(target, {
    launch: recordingLaunch(record),
    readArtifactBytes: async (hash) => {
      // Publish a newer version of the same plan before the staged bytes are
      // read: the operation must still stage the version it accepted.
      if (!switched) {
        switched = true;
        await publishVersion(
          target.store, target.projectId, target.sessionId,
          target.plan.artifactId, target.plan.v2, "# plan v3\nA different plan again.\n",
        );
      }
      return await new CasStore(target.store.dataDir).read(hash);
    },
  });
  const outcome = await service.start(startInput(target));
  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 1);
  assert.equal(record.stagedPlan, PLAN_TEXT, "the accepted plan bytes must be what the researcher reads");
  assert.equal(view.planVersionId, target.plan.v1);
  assert.equal(view.inputs[0]!.sha256, sha256(PLAN_TEXT));
  const staged = await readFile(
    join(target.workRoot, "operations", outcome.operation.operationId, "input", "experiment_plan.md"),
    "utf8",
  );
  assert.equal(staged, PLAN_TEXT);
});

test("two operations never share a staged input directory", async (context) => {
  const target = await fixture(context);
  const first: LaunchRecord = { assets: [], count: 0 };
  const second: LaunchRecord = { assets: [], count: 0 };
  let launch = recordingLaunch(first);
  const service = ready(target, { launch: (input) => launch(input) });
  const one = await service.start(startInput(target));
  await waitTerminal(service, {
    operationId: one.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  // The second experiment uses a different plan version and a new user request.
  launch = recordingLaunch(second);
  const two = await service.start(startInput(target, {
    intent: "Run the revised plan and report the new evidence honestly.",
    ownerRunId: "conversation-run-2",
    planVersionId: target.plan.v2,
  }));
  await waitTerminal(service, {
    operationId: two.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.notEqual(one.operation.operationId, two.operation.operationId);
  assert.notEqual(first.inputDataDir, second.inputDataDir);
  assert.equal(first.stagedPlan, PLAN_TEXT);
  assert.equal(second.stagedPlan, PLAN_TEXT_V2);
});

test("a dynamic start refuses missing, cross-Session and unreadable versions before any operation", async (context) => {
  const target = await fixture(context);
  const record: LaunchRecord = { assets: [], count: 0 };
  const service = ready(target, { launch: recordingLaunch(record) });

  await assert.rejects(
    service.start(startInput(target, { planVersionId: undefined })),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-missing",
  );
  await assert.rejects(
    service.start(startInput(target, { incumbentVersionId: undefined })),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-missing",
  );

  // A version created in another Session of the same Project is not this
  // Session's input.
  const other = await target.store.createSession(target.projectId, "Other session");
  const foreign = await publish(
    target.store, target.projectId, other.id, "other-session/research-plan.md", PLAN_TEXT, "Foreign plan",
  );
  await assert.rejects(
    service.start(startInput(target, { planVersionId: foreign.versionId })),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-not-found",
  );

  const unreadable = ready(target, {
    launch: recordingLaunch(record),
    readArtifactBytes: async () => {
      throw new Error("content store unavailable");
    },
  });
  await assert.rejects(
    unreadable.start(startInput(target)),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-version-unreadable",
  );

  assert.equal(target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId).length, 0);
  assert.equal(record.count, 0);
});

test("a version for a role the dynamic profile does not stage is refused", async (context) => {
  const target = await fixture(context);
  // The profile stages only the plan; a named incumbent would otherwise be
  // ignored while the run silently used the plan alone.
  const planOnly = createLocalResearchService({
    settings: { ...target.settings, dynamicInputs: { plan: "experiment_plan.md" } },
    store: target.store,
  }, { launch: recordingLaunch({ assets: [], count: 0 }) });
  await assert.rejects(
    planOnly.start(startInput(target)),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "link-not-supported",
  );
  assert.equal(target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId).length, 0);
});

test("a staging failure leaves an actionable failed record and never launches", async (context) => {
  const target = await fixture(context);
  // A symlinked supporting asset could point the engine outside the asset root.
  await symlink(join(target.root, "outside.py"), join(target.assetsDir, "linked.py"));
  const record: LaunchRecord = { assets: [], count: 0 };
  const service = ready(target, { launch: recordingLaunch(record) });
  const outcome = await service.start(startInput(target));
  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 0, "a staging failure must not reach the engine");
  assert.equal(view.state, "failed");
  assert.equal(view.error?.step, "staging");
  assert.match(view.error?.message ?? "", /staging-unsafe/);
  assert.equal(view.delivery.state, "pending");
});

test("a staged role that collides with a supporting asset is refused, not overwritten", async (context) => {
  const target = await fixture(context);
  // The administrator's assets happen to contain a file with the plan's staged
  // name; the two origins would be indistinguishable in the engine's dataset.
  await writeFile(join(target.assetsDir, "experiment_plan.md"), "# an administrator note\n", "utf8");
  const record: LaunchRecord = { assets: [], count: 0 };
  const service = ready(target, { launch: recordingLaunch(record) });
  const outcome = await service.start(startInput(target));
  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 0);
  assert.equal(view.state, "failed");
  assert.match(view.error?.message ?? "", /staging-conflict/);
  // The administrator's file is untouched.
  assert.equal(
    await readFile(join(target.workRoot, "operations", outcome.operation.operationId, "input", "experiment_plan.md"), "utf8")
      .catch(() => null),
    null,
  );
});

test("a stop during staging records the stop instead of launching", async (context) => {
  const target = await fixture(context);
  const record: LaunchRecord = { assets: [], count: 0 };
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const service = ready(target, {
    launch: recordingLaunch(record),
    readArtifactBytes: async (hash) => {
      reads += 1;
      // The two reads of the accepted start complete; the staging read waits for
      // the user's Stop to land.
      if (reads > 2) await stalled;
      return await new CasStore(target.store.dataDir).read(hash);
    },
  });
  const outcome = await service.start(startInput(target));
  assert.equal(outcome.attached, false);
  const cancelling = service.requestStopForConversationRun(target.sessionId, "conversation-run-1");
  release?.();
  await cancelling;
  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 0, "a cancelled preparation must not launch");
  assert.equal(view.state, "stopped");
  assert.equal(view.stop.requestedBy, "conversation-cancel");
});

test("a model change after acceptance refuses the launch instead of running with another model", async (context) => {
  const target = await fixture(context);
  const record: LaunchRecord = { assets: [], count: 0 };
  let reads = 0;
  let switched = false;
  const service = ready(target, {
    launch: recordingLaunch(record),
    readArtifactBytes: async (hash) => {
      reads += 1;
      // Switch the Session's model after the start froze its selection.
      if (reads > 2 && !switched) {
        switched = true;
        const replacement = await target.store.createModel({
          apiToken: randomUUID(),
          baseUrl: "https://other.example.test/v1",
          model: "other-model",
          name: "Other model",
        });
        await target.store.updateSession(target.sessionId, { modelId: replacement.id });
      }
      return await new CasStore(target.store.dataDir).read(hash);
    },
  });
  const outcome = await service.start(startInput(target));
  const view = await waitTerminal(service, {
    operationId: outcome.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(record.count, 0);
  assert.equal(view.state, "failed");
  assert.equal(view.error?.step, "model-selection");
});
