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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  resolveDeliveryTarget,
  type ScienceFlowResultDeliveryRequest,
} from "./result-delivery.js";

const RUN_ID = "round-test-circle-packing-c";
const TASK = "circle-packing";
const SOLUTION_TEXT = JSON.stringify({
  circles: [
    [0.5, 0.5, 0.2],
    [0.1, 0.1, 0.01],
  ],
});

const STAGES = [
  {
    artifactSha: sha256("seed-and-s01"),
    createdAtUtc: "2026-11-15T05:18:21Z",
    metric: 2.61661905326,
    parent: "",
    stageId: "S01",
  },
  {
    artifactSha: null as string | null,
    createdAtUtc: "2026-11-15T05:28:24Z",
    metric: 2.623651703004654,
    parent: "S01",
    stageId: "S02",
  },
] as const;

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

interface Fixture {
  readonly root: string;
  readonly store: SessionStore;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly taskRoot: string;
  readonly candidatePath: string;
  readonly candidateSha: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-sf-delivery-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Delivery");
  // A Session needs an installed model; this fixture never calls it.
  await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Delivered result");
  const workDir = join(root, "pilot");
  const taskRoot = join(workDir, "runs", RUN_ID, TASK);
  const candidatePath = join(taskRoot, "workers", "w00", "snapshots", "W00-L01-S02", "artifacts", "best_solution.json");
  await mkdir(dirname(candidatePath), { recursive: true });
  await writeFile(candidatePath, SOLUTION_TEXT, "utf8");
  await writeJson(join(workDir, "state", "scienceflow", "managed_runs", RUN_ID, "control.json"), {
    run_id: RUN_ID,
    status: "stopped",
  });
  await mkdir(join(taskRoot, "task_logs"), { recursive: true });
  await writeFile(join(taskRoot, "task_logs", "lhr_stage_performance.csv"), stageCsv(STAGES), "utf8");
  return {
    candidatePath,
    candidateSha: sha256(SOLUTION_TEXT),
    projectId: project.id,
    root,
    sessionId: session.id,
    store,
    taskRoot,
    workDir,
  };
}

function stageCsv(rows: readonly {
  stageId: string;
  parent: string;
  metric: number;
  artifactSha: string | null;
  snapshotPath?: string;
}[]): string {
  const header = [
    "stage_id", "parent_stage_id", "candidate_id", "metric_name", "metric_value", "lower_is_better",
    "validation_ok", "selection_eligible", "gate_accepted", "evaluator_status", "artifact_sha", "artifact_path",
    "snapshot_path", "created_at_utc",
  ].join(",");
  const lines = rows.map((row) => [
    row.stageId,
    row.parent,
    `W00:L01:${row.stageId}`,
    "radii_sum",
    String(row.metric),
    "0",
    "1",
    "1",
    "1",
    "ok",
    row.artifactSha ?? "",
    "artifacts/best_solution.json",
    row.snapshotPath ?? "",
    "2026-11-15T05:00:00Z",
  ].join(","));
  return [header, ...lines, ""].join("\n");
}

function snapshotFor(input: {
  readonly path?: string | null;
  readonly sha256?: string | null;
  readonly metricValue?: number;
  readonly stageId?: string;
  readonly digestVerified?: boolean;
  readonly metricName?: string;
}): ScienceFlowRunSnapshot {
  const hasCandidate = input.path !== null;
  return {
    diagnostics: [],
    phase: "finished",
    rawStatus: "stopped",
    runId: RUN_ID,
    schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    tasks: [{
      candidateArtifact: hasCandidate
        ? {
            digestVerified: input.digestVerified ?? true,
            lowerIsBetter: false,
            metricName: input.metricName ?? "radii_sum",
            metricValue: input.metricValue ?? 2.6239750175348147,
            path: input.path,
            recordedSha256: input.sha256,
            sha256: input.sha256,
            stageId: input.stageId ?? "S02",
          }
        : null,
      evidenceReferences: ["task_logs/lhr_stage_performance.csv"],
      reportedBestMetric: {
        lowerIsBetter: false,
        metricName: "radii_sum",
        metricValue: input.metricValue ?? 2.6239750175348147,
        source: "lhr_stage_performance",
      },
      taskRoot: null,
    }],
  };
}

function reader(snapshot: ScienceFlowRunSnapshot) {
  return async (_options: ReadScienceFlowRunSnapshotOptions): Promise<ScienceFlowSnapshotReadResult> => ({
    snapshot,
    status: "ok",
  });
}

function requestFor(target: Fixture, overrides: Partial<ScienceFlowResultDeliveryRequest> = {}): ScienceFlowResultDeliveryRequest {
  return {
    projectId: target.projectId,
    pythonExecutable: "/usr/bin/python3",
    readerScriptPath: "/repo/services/scienceflow-reader/snapshot.py",
    runId: RUN_ID,
    sessionId: target.sessionId,
    task: TASK,
    workDir: target.workDir,
    ...overrides,
  };
}

async function deliver(
  target: Fixture,
  snapshot: ScienceFlowRunSnapshot,
  overrides: Partial<ScienceFlowResultDeliveryRequest> = {},
) {
  return await deliverScienceFlowResult(target.store, requestFor(target, overrides), {
    readSnapshot: reader(snapshot),
  });
}

function artifactsNamed(store: SessionStore, projectId: string, name: string) {
  return store.listProjectArtifacts(projectId).filter((artifact) => artifact.name === name);
}

test("delivers the selected stage as unchanged Session artifacts", async (context) => {
  const target = await fixture(context);
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));

  assert.equal(record.outcome.status, "delivered");
  assert.equal(record.registration?.status, "created");
  assert.equal(record.runState?.status, "stopped");
  assert.equal(record.runState?.phase, "finished");
  assert.equal(record.selected?.stageId, "S02");
  assert.equal(record.selected?.artifactSha256, target.candidateSha);
  assert.equal(record.selected?.bytes, Buffer.byteLength(SOLUTION_TEXT));
  assert.equal(record.selected?.sourcePath, "workers/w00/snapshots/W00-L01-S02/artifacts/best_solution.json");

  const solution = record.artifacts.solution;
  const note = record.artifacts.note;
  assert.ok(solution, "the solution artifact must be published");
  assert.ok(note, "the result note must be published");
  assert.equal(solution.content.hash, target.candidateSha);
  assert.equal(solution.status, "created");

  // The normal content surface returns exactly the delivered bytes.
  const stored = await new CasStore(target.store.dataDir).read(solution.content.hash);
  assert.equal(stored.toString("utf8"), SOLUTION_TEXT);
  const version = target.store.listProjectArtifactVersions(target.projectId, solution.artifactId)
    .find((candidate) => candidate.id === solution.versionId);
  assert.equal(version?.content.hash, target.candidateSha);
  const artifact = target.store.getProjectArtifact(target.projectId, solution.artifactId);
  assert.equal(artifact?.origin, "server_generated");
  assert.equal(artifact?.kind, "json");
  assert.deepEqual(artifact?.originMeta?.sourceRunId, RUN_ID);
  assert.equal(note.kind, "markdown");

  // The note depends on the solution version, not on a fabricated execution.
  const noteVersion = target.store.listProjectArtifactVersions(target.projectId, note.artifactId)
    .find((candidate) => candidate.id === note.versionId);
  assert.deepEqual(noteVersion?.inputArtifactVersionIds, [solution.versionId]);

  const noteText = (await new CasStore(target.store.dataDir).read(note.content.hash)).toString("utf8");
  assert.match(noteText, /radii_sum/);
  assert.match(noteText, /higher is better/);
  assert.match(noteText, /2\.6239750175348147/);
  assert.match(noteText, /S01/);
  assert.match(noteText, /first captured stage/);
  assert.match(noteText, /stopped/);
  assert.match(noteText, /has not been run/);
  // No host paths, endpoints, credentials or reader prose in published text.
  assert.ok(!noteText.includes(target.root) && !noteText.includes(target.workDir), "note must not carry host paths");
  assert.ok(!noteText.includes("://") && !/sk-[A-Za-z0-9]{10,}/u.test(noteText), "note must not carry endpoints or credentials");
});

test("repeated delivery reuses the same versions instead of duplicating", async (context) => {
  const target = await fixture(context);
  const snapshot = snapshotFor({ path: target.candidatePath, sha256: target.candidateSha });
  const first = await deliver(target, snapshot);
  const second = await deliver(target, snapshot);

  assert.equal(second.outcome.status, "delivered");
  assert.equal(second.registration?.status, "existing");
  assert.equal(second.artifacts.solution?.status, "reused");
  assert.equal(second.artifacts.note?.status, "reused");
  assert.equal(second.artifacts.solution?.versionId, first.artifacts.solution?.versionId);
  assert.equal(second.artifacts.note?.versionId, first.artifacts.note?.versionId);
  assert.equal(second.artifacts.solution?.version, 1);
  for (const name of ["scienceflow/" + RUN_ID + "/best-solution.json", "scienceflow/" + RUN_ID + "/result-note.md"]) {
    const artifacts = artifactsNamed(target.store, target.projectId, name);
    assert.equal(artifacts.length, 1, `${name} must stay a single artifact`);
    assert.equal(target.store.listProjectArtifactVersions(target.projectId, artifacts[0]!.id).length, 1);
  }
});

test("a retry finishes a partially published delivery without duplicating it", async (context) => {
  const target = await fixture(context);
  // A conflicting artifact with the note's name makes only the note publication fail.
  const noteName = `scienceflow/${RUN_ID}/result-note.md`;
  const cas = new CasStore(target.store.dataDir);
  const content = await cas.put(Buffer.from("conflicting content"));
  const conflicting = await target.store.createArtifactVersion({
    content,
    kind: "latex",
    logicalName: noteName,
    mediaType: "text/plain",
    origin: "server_generated",
    sessionId: target.sessionId,
  });

  const snapshot = snapshotFor({ path: target.candidatePath, sha256: target.candidateSha });
  const partial = await deliver(target, snapshot);
  assert.equal(partial.outcome.status, "failed");
  assert.equal(partial.outcome.status === "failed" ? partial.outcome.failedStep : null, "publish-note");
  assert.equal(partial.artifacts.solution?.status, "created");
  assert.equal(partial.artifacts.note, undefined);

  await target.store.deleteArtifact(target.projectId, conflicting.artifact.id);
  const retry = await deliver(target, snapshot);
  assert.equal(retry.outcome.status, "delivered");
  assert.equal(retry.artifacts.solution?.status, "reused");
  assert.equal(retry.artifacts.solution?.versionId, partial.artifacts.solution?.versionId);
  assert.equal(retry.artifacts.note?.status, "created");
  const solutionVersions = target.store.listProjectArtifactVersions(target.projectId, partial.artifacts.solution!.artifactId);
  assert.equal(solutionVersions.length, 1, "the completed half must not be republished");
});

test("a candidate whose bytes do not match the recorded digest is refused", async (context) => {
  const target = await fixture(context);
  const record = await deliver(target, snapshotFor({
    path: target.candidatePath,
    sha256: sha256("some other bytes"),
  }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "candidate-sha-mismatch");
  assert.deepEqual(record.artifacts, {});
  assert.deepEqual(artifactsNamed(target.store, target.projectId, `scienceflow/${RUN_ID}/best-solution.json`), []);
});

test("a missing candidate file is an actionable failure, not an empty artifact", async (context) => {
  const target = await fixture(context);
  const missing = join(target.taskRoot, "workers", "w00", "snapshots", "gone", "artifacts", "best_solution.json");
  const record = await deliver(target, snapshotFor({ path: missing, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "candidate-file-missing");
  assert.deepEqual(record.artifacts, {});
});

test("a candidate outside the run's task root is refused", async (context) => {
  const target = await fixture(context);
  const outside = join(target.root, "elsewhere", "best_solution.json");
  await mkdir(dirname(outside), { recursive: true });
  await writeFile(outside, SOLUTION_TEXT, "utf8");
  const record = await deliver(target, snapshotFor({ path: outside, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "candidate-path-out-of-bounds");
  assert.deepEqual(record.artifacts, {});
});

test("a Session in another Project is refused by identity", async (context) => {
  const target = await fixture(context);
  const otherProject = await target.store.createProject("Other");
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { projectId: otherProject.id },
  );
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "session-not-found");
  assert.deepEqual(record.artifacts, {});
});

test("a read-only Session is refused before publication", async (context) => {
  const target = await fixture(context);
  await target.store.archiveSession(target.sessionId);
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "session-not-writable");
  assert.deepEqual(record.artifacts, {});
  assert.deepEqual(artifactsNamed(target.store, target.projectId, `scienceflow/${RUN_ID}/best-solution.json`), []);
});

test("a run without a captured candidate delivers nothing", async (context) => {
  const target = await fixture(context);
  const record = await deliver(target, snapshotFor({ path: null }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "no-candidate");
  assert.deepEqual(record.artifacts, {});
});

test("a stage ledger that contradicts the selected digest is refused", async (context) => {
  const target = await fixture(context);
  await writeFile(
    join(target.taskRoot, "task_logs", "lhr_stage_performance.csv"),
    stageCsv([
      { artifactSha: "0".repeat(64), metric: 2.6239750175348147, parent: "", stageId: "S02" },
    ]),
    "utf8",
  );
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "stage-ledger-conflict");
  assert.deepEqual(record.artifacts, {});
});

test("an unreadable stage ledger still delivers the selected solution", async (context) => {
  const target = await fixture(context);
  await rm(join(target.taskRoot, "task_logs", "lhr_stage_performance.csv"));
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "delivered");
  assert.deepEqual(record.stages, []);
  const noteText = (await new CasStore(target.store.dataDir).read(record.artifacts.note!.content.hash)).toString("utf8");
  assert.match(noteText, /stage ledger was not readable/);
});

test("the note uses the launch receipt only for model identity and lifecycle", async (context) => {
  const target = await fixture(context);
  await writeJson(join(target.workDir, "receipt.json"), {
    engine: { runId: RUN_ID },
    identity: { projectId: target.projectId, sessionId: target.sessionId },
    launch: { elapsedSec: 910.2, stoppedByAllowance: true },
    model: {
      // A credential-shaped field must never reach published text.
      apiToken: `sk-${"a".repeat(32)}`,
      profileName: "Authorized gateway",
      providerHost: "gateway.internal.example",
      providerModel: "Qwen3.8-Flash",
      selectionSource: "session",
    },
  });
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "delivered");
  const noteText = (await new CasStore(target.store.dataDir).read(record.artifacts.note!.content.hash)).toString("utf8");
  assert.match(noteText, /`Qwen3\.8-Flash`/);
  assert.match(noteText, /source layer `session`/);
  assert.match(noteText, /wall-clock allowance stopped it after 910\.2 s/);
  assert.ok(!noteText.includes("gateway.internal.example"), "the provider host must not be published");
  assert.ok(!/sk-[A-Za-z0-9]{10,}/u.test(noteText), "credentials must not be published");
});

test("a launch receipt for another run is not used to label the result", async (context) => {
  const target = await fixture(context);
  await writeJson(join(target.workDir, "receipt.json"), {
    engine: { runId: "some-other-run" },
    identity: { projectId: target.projectId, sessionId: target.sessionId },
    launch: { stoppedByAllowance: true },
    model: { profileName: "Other profile", providerModel: "Other model", selectionSource: "global" },
  });
  const record = await deliver(target, snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }));
  assert.equal(record.outcome.status, "delivered");
  const noteText = (await new CasStore(target.store.dataDir).read(record.artifacts.note!.content.hash)).toString("utf8");
  assert.ok(!noteText.includes("Other model"));
  assert.match(noteText, /not recorded in an operator receipt/);
});

test("operator options cannot smuggle a host path as a run id", () => {
  assert.throws(
    () => resolveDeliveryTarget({
      projectId: "p",
      pythonExecutable: "/usr/bin/python3",
      readerScriptPath: "/repo/snapshot.py",
      runId: "../../etc",
      sessionId: "s",
      workDir: "/tmp/pilot",
    }),
    /run id/,
  );
});

const PLAN_TEXT = [
  "# Experiment plan (fixture)",
  "",
  "Test one deterministic restart from the incumbent packing state.",
  "Accept only a valid candidate that improves radii_sum.",
].join("\n");

async function publishPlan(
  target: Fixture,
  sessionId: string = target.sessionId,
): Promise<{ artifactId: string; versionId: string }> {
  const cas = new CasStore(target.store.dataDir);
  const content = await cas.put(Buffer.from(PLAN_TEXT));
  const { artifact, version } = await target.store.createArtifactVersion({
    content,
    kind: "markdown",
    logicalName: "scienceflow/round22/experiment-plan.md",
    mediaType: "text/markdown",
    origin: "server_generated",
    originMeta: { assistantAuthored: "true", purpose: "experiment-plan" },
    sessionId,
    title: "Agent-authored experiment plan",
  });
  return { artifactId: artifact.id, versionId: version.id };
}

async function publishIncumbent(
  target: Fixture,
  text: string,
): Promise<{ artifactId: string; versionId: string }> {
  const cas = new CasStore(target.store.dataDir);
  const content = await cas.put(Buffer.from(text));
  const { artifact, version } = await target.store.createArtifactVersion({
    content,
    kind: "json",
    logicalName: "scienceflow/round21/best-solution.json",
    mediaType: "application/json",
    origin: "server_generated",
    sessionId: target.sessionId,
    title: "Delivered incumbent",
  });
  return { artifactId: artifact.id, versionId: version.id };
}

test("links the plan version and drops the templated next-experiment suggestion", async (context) => {
  const target = await fixture(context);
  const plan = await publishPlan(target);
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { planVersionId: plan.versionId },
  );

  assert.equal(record.outcome.status, "delivered");
  assert.equal(record.plan?.versionId, plan.versionId);
  assert.equal(record.plan?.artifactId, plan.artifactId);
  assert.equal(record.plan?.logicalName, "scienceflow/round22/experiment-plan.md");
  assert.equal(record.plan?.title, "Agent-authored experiment plan");

  const note = record.artifacts.note!;
  const noteVersion = target.store.listProjectArtifactVersions(target.projectId, note.artifactId)
    .find((candidate) => candidate.id === note.versionId);
  assert.deepEqual(noteVersion?.inputArtifactVersionIds, [record.artifacts.solution!.versionId, plan.versionId]);

  const noteText = (await new CasStore(target.store.dataDir).read(note.content.hash)).toString("utf8");
  assert.match(noteText, /## Experiment plan tested/);
  assert.ok(noteText.includes(plan.versionId), "the note must cite the plan version id");
  assert.ok(noteText.includes(plan.artifactId), "the note must cite the plan artifact id");
  assert.match(noteText, /## Interpreting this run/);
  assert.ok(!noteText.includes("Proposed next experiment (not run)"), "the template suggestion must not stand in for the plan");
  assert.ok(!noteText.includes("twice the largest stage-to-stage step"), "the template margin is not a plan requirement");
});

test("a plan version from another Session is refused before publication", async (context) => {
  const target = await fixture(context);
  const other = await target.store.createSession(target.projectId, "Other session");
  const plan = await publishPlan(target, other.id);
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { planVersionId: plan.versionId },
  );
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.failedStep : null, "plan");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "plan-version-not-found");
  assert.deepEqual(record.artifacts, {});
});

test("a missing plan version is refused and nothing is published", async (context) => {
  const target = await fixture(context);
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { planVersionId: randomUUID() },
  );
  assert.equal(record.outcome.status, "failed");
  assert.equal(record.outcome.status === "failed" ? record.outcome.reason : null, "plan-version-not-found");
  assert.deepEqual(record.artifacts, {});
  assert.deepEqual(artifactsNamed(target.store, target.projectId, `scienceflow/${RUN_ID}/best-solution.json`), []);
});

test("every captured stage is published as its own attempt, beside the selected best", async (context) => {
  const target = await fixture(context);
  const seedText = JSON.stringify({ circles: [[0.5, 0.5, 0.1]] });
  const seedDir = join(target.taskRoot, "workers", "w00", "snapshots", "W00-L01-S01");
  await mkdir(join(seedDir, "artifacts"), { recursive: true });
  await writeFile(join(seedDir, "artifacts", "best_solution.json"), seedText, "utf8");
  await writeFile(
    join(target.taskRoot, "task_logs", "lhr_stage_performance.csv"),
    stageCsv([
      { artifactSha: sha256(seedText), metric: 2.61661905326, parent: "", snapshotPath: seedDir, stageId: "S01" },
      { artifactSha: target.candidateSha, metric: 2.6239750175348147, parent: "S01", snapshotPath: dirname(dirname(target.candidatePath)), stageId: "S02" },
    ]),
    "utf8",
  );
  const plan = await publishPlan(target);
  const incumbent = await publishIncumbent(target, seedText);
  const snapshot = snapshotFor({ path: target.candidatePath, sha256: target.candidateSha });

  const record = await deliver(target, snapshot, {
    includeAttempts: true,
    incumbentVersionId: incumbent.versionId,
    planVersionId: plan.versionId,
  });
  assert.equal(record.outcome.status, "delivered");
  assert.equal(record.incumbent?.versionId, incumbent.versionId);
  const seed = record.attempts.find((attempt) => attempt.stageId === "S01");
  const selected = record.attempts.find((attempt) => attempt.stageId === "S02");
  assert.equal(seed?.role, "carried_seed");
  assert.equal(seed?.status, "published");
  assert.equal(seed?.artifact?.content.hash, sha256(seedText));
  assert.equal(selected?.role, "evaluated_attempt");
  assert.equal(selected?.status, "selected");

  const seedArtifact = target.store.getProjectArtifact(target.projectId, seed!.artifact!.artifactId);
  assert.equal(seedArtifact?.originMeta?.attemptRole, "carried_seed");
  assert.equal(seedArtifact?.originMeta?.incumbentVersionId, incumbent.versionId);
  assert.equal(seedArtifact?.originMeta?.planVersionId, plan.versionId);
  const storedSeed = await new CasStore(target.store.dataDir).read(seed!.artifact!.content.hash);
  assert.equal(storedSeed.toString("utf8"), seedText, "the seed bytes must be published unchanged");

  const note = record.artifacts.note!;
  const noteText = (await new CasStore(target.store.dataDir).read(note.content.hash)).toString("utf8");
  assert.match(noteText, /## Evaluated attempts/);
  assert.ok(noteText.includes(seed!.artifact!.versionId), "the note must cite the attempt version");
  const noteVersion = target.store.listProjectArtifactVersions(target.projectId, note.artifactId)
    .find((candidate) => candidate.id === note.versionId);
  assert.deepEqual(noteVersion?.inputArtifactVersionIds, [
    record.artifacts.solution!.versionId,
    seed!.artifact!.versionId,
    plan.versionId,
    incumbent.versionId,
  ]);

  const repeated = await deliver(target, snapshot, {
    includeAttempts: true,
    incumbentVersionId: incumbent.versionId,
    planVersionId: plan.versionId,
  });
  assert.equal(repeated.outcome.status, "delivered");
  assert.equal(repeated.attempts.find((attempt) => attempt.stageId === "S01")?.artifact?.status, "reused");
  assert.equal(
    target.store.listProjectArtifactVersions(repeated.identity.projectId, seed!.artifact!.artifactId).length,
    1,
    "a repeated delivery must not duplicate an attempt version",
  );
});

test("an unreadable attempt is recorded as unresolved without hiding the selected result", async (context) => {
  const target = await fixture(context);
  const missingDir = join(target.taskRoot, "workers", "w00", "snapshots", "W00-L01-S01");
  await writeFile(
    join(target.taskRoot, "task_logs", "lhr_stage_performance.csv"),
    stageCsv([
      { artifactSha: sha256("never written"), metric: 2.61661905326, parent: "", snapshotPath: missingDir, stageId: "S01" },
      { artifactSha: target.candidateSha, metric: 2.6239750175348147, parent: "S01", snapshotPath: dirname(dirname(target.candidatePath)), stageId: "S02" },
    ]),
    "utf8",
  );
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { includeAttempts: true },
  );
  assert.equal(record.outcome.status, "delivered");
  const seed = record.attempts.find((attempt) => attempt.stageId === "S01");
  assert.equal(seed?.status, "unresolved");
  assert.equal(seed?.reason, "artifact-file-missing");
  const noteText = (await new CasStore(target.store.dataDir).read(record.artifacts.note!.content.hash)).toString("utf8");
  assert.match(noteText, /artifact not published/);
  assert.match(noteText, /artifact-file-missing/);
});

test("a first stage whose digest is not the incumbent is a new candidate, not the seed", async (context) => {
  const target = await fixture(context);
  const firstText = JSON.stringify({ circles: [[0.4, 0.4, 0.3]] });
  const firstDir = join(target.taskRoot, "workers", "w00", "snapshots", "W00-L01-S01");
  await mkdir(join(firstDir, "artifacts"), { recursive: true });
  await writeFile(join(firstDir, "artifacts", "best_solution.json"), firstText, "utf8");
  await writeFile(
    join(target.taskRoot, "task_logs", "lhr_stage_performance.csv"),
    stageCsv([
      { artifactSha: sha256(firstText), metric: 2.631640653898, parent: "", snapshotPath: firstDir, stageId: "S01" },
      { artifactSha: target.candidateSha, metric: 2.633134264465223, parent: "S01", snapshotPath: dirname(dirname(target.candidatePath)), stageId: "S02" },
    ]),
    "utf8",
  );
  const incumbent = await publishIncumbent(target, JSON.stringify({ circles: [[0.5, 0.5, 0.1]] }));
  const record = await deliver(
    target,
    snapshotFor({ path: target.candidatePath, sha256: target.candidateSha }),
    { includeAttempts: true, incumbentVersionId: incumbent.versionId },
  );
  assert.equal(record.outcome.status, "delivered");
  const first = record.attempts.find((attempt) => attempt.stageId === "S01");
  assert.equal(first?.role, "first_captured");
  assert.equal(first?.status, "published");
  const firstArtifact = target.store.getProjectArtifact(target.projectId, first!.artifact!.artifactId);
  assert.equal(firstArtifact?.originMeta?.attemptRole, "first_captured");
  const noteText = (await new CasStore(target.store.dataDir).read(record.artifacts.note!.content.hash)).toString("utf8");
  assert.match(noteText, /\| S01 \| — \| first captured stage \|/);
  assert.ok(!noteText.includes("| carried-in seed |"), "no stage matches the incumbent, so none is labelled the seed");
});
