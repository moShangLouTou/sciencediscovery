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
 * Cross-run comparison and research-line budget behavior.
 *
 * The pure cases establish the scientific-contract boundary, the three result
 * relations, invalid-result exclusion and the parent settlement arithmetic. The
 * service cases use the real SessionStore so a rebuilt service and the durable
 * explicit selection are exercised, not a mirror of the implementation.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { CasStore } from "@sciencediscovery/cas";

import type { ModelInvocationUsage } from "@sciencediscovery/schema";

import { SessionStore } from "../store.js";
import {
  createLocalResearchService,
  LocalResearchRefusal,
  type LocalResearchServiceDependencies,
  type LocalResearchStartInput,
} from "./local-research.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import {
  isTerminalResearchState,
  type ScienceFlowLocalResearchOperation,
  type ScienceFlowLocalResearchStage,
} from "./local-research-record.js";
import {
  contractFingerprint,
  createResearchSelection,
  deriveResearchResultGroups,
  projectResearchParent,
  ResearchResultRefusal,
  researchContractIdentityFrom,
  researchGroupId,
  researchLineRefusal,
  researchParentView,
  readExecutionEnvironment,
  type ScienceFlowResearchResultSelection,
} from "./local-research-results.js";
import type { ScienceFlowTaskBinding } from "./local-research-task.js";
import type { ScienceFlowResearchPreparation } from "./local-research-overhead-repository.js";
import type { ResearchPilotLaunchOutcome } from "./research-pilot.js";
import type { ScienceFlowResultDeliveryRecord } from "./result-delivery.js";

const ENGINE_REVISION = "a".repeat(40);
const EVALUATOR_SHA = "e".repeat(64);
const CONTRACT_HASH = "c".repeat(64);
const INPUT_SHA = "d".repeat(64);
const ARTIFACT_SHA = "f".repeat(64);

function preparedBinding(overrides: Partial<ScienceFlowTaskBinding> = {}): ScienceFlowTaskBinding {
  return {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    authoritative: false,
    contractHash: CONTRACT_HASH,
    evaluator: { kind: "generated-command", sha256: EVALUATOR_SHA, versionId: "evaluator-version-1" },
    inputs: [{ logicalName: "fit.csv", sha256: INPUT_SHA, size: 10, versionId: "input-version-1" }],
    lowerIsBetter: true,
    metricJsonPath: "metric",
    metricName: "rmse",
    metricType: "exploratory",
    source: "prepared",
    summary: "Fit — metric `rmse` (lower is better); evaluator prepared in this Session (exploratory)",
    taskId: "sd-fit-12345678",
    taskVersionId: "task-version-1",
    title: "Fit",
    ...overrides,
  };
}

let sequence = 0;
function operation(overrides: {
  readonly metricValue?: number;
  readonly metricName?: string;
  readonly lowerIsBetter?: boolean | null;
  readonly state?: ScienceFlowLocalResearchOperation["state"];
  readonly deliveryState?: ScienceFlowLocalResearchOperation["delivery"]["state"];
  readonly binding?: ScienceFlowTaskBinding | null;
  readonly stage?: Partial<ScienceFlowLocalResearchStage>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly elapsedSec?: number;
  readonly launchedAt?: string;
  readonly usage?: ScienceFlowLocalResearchOperation["progress"]["usage"] | null;
  readonly engineRevision?: string | null;
  readonly engineWorktreeDirty?: boolean | null;
  readonly engineStatusDigest?: string | null;
  readonly executionEnvironment?: import("./local-research-results.js").ExecutionEnvironmentIdentity | null;
  readonly operationId?: string;
  readonly ownerRunId?: string;
} = {}): ScienceFlowLocalResearchOperation {
  sequence += 1;
  const id = overrides.operationId ?? `operation-${String(sequence).padStart(2, "0")}`;
  const createdAt = overrides.createdAt
    ?? new Date(Date.parse("2026-11-16T10:00:00.000Z") + sequence * 1_000).toISOString();
  const updatedAt = overrides.updatedAt ?? createdAt;
  const binding = overrides.binding === null ? undefined : overrides.binding ?? preparedBinding();
  const metricName = overrides.metricName ?? binding?.metricName ?? "metric";
  const metricValue = overrides.metricValue ?? 0.1;
  const lowerIsBetter = overrides.lowerIsBetter === null
    ? null
    : overrides.lowerIsBetter ?? binding?.lowerIsBetter ?? true;
  const state = overrides.state ?? "completed";
  const deliveryState = overrides.deliveryState ?? "delivered";
  const stage: ScienceFlowLocalResearchStage = {
    stageId: `S0${sequence}`,
    parentStageId: null,
    metricName,
    metricValue,
    artifactSha256: ARTIFACT_SHA,
    validationOk: true,
    gateAccepted: true,
    evaluatorStatus: "ok",
    createdAtUtc: createdAt,
    ...overrides.stage,
  };
  return {
    createdAt,
    delivery: {
      ...(deliveryState === "delivered"
        ? {
            lowerIsBetter,
            metricName,
            metricValue,
            selectedStageId: stage.stageId,
            solution: {
              artifactId: "solution-artifact",
              logicalName: "best-solution.json",
              role: "solution",
              version: 1,
              versionId: "solution-version",
            },
          }
        : {}),
      attempts: deliveryState === "pending" ? 0 : 1,
      state: deliveryState,
      updatedAt,
    },
    deliveryRecordPath: "/control/delivery.json",
    engine: {
      ...(state === "completed" || state === "failed" || state === "stopped" ? { status: state } : {}),
      ...(overrides.elapsedSec === undefined ? {} : { elapsedSec: overrides.elapsedSec }),
    },
    engineRunId: `sd-research-${id}`,
    idempotencyKey: `key-${id}`,
    identity: { projectId: "project-1", sessionId: "session-1" },
    intent: `Intent ${id}`,
    launch: {
      engineCheckout: "/engine",
      engineRevision: overrides.engineRevision === null ? undefined : overrides.engineRevision ?? ENGINE_REVISION,
      engineWorktreeDirty: overrides.engineWorktreeDirty === null ? undefined : overrides.engineWorktreeDirty ?? false,
      engineStatusDigest: overrides.engineStatusDigest === null ? undefined : overrides.engineStatusDigest ?? "s".repeat(64),
      executionEnvironment: overrides.executionEnvironment === null ? undefined : overrides.executionEnvironment ?? {
        arch: "x86_64",
        fingerprint: "e".repeat(64),
        platform: "linux",
        python: "3.12.12",
      },
      grant: {
        bashTimeoutSec: 60,
        codeMaxTokens: 1_024,
        feedbackMaxTokens: 1_024,
        httpTimeoutSec: 60,
        maxSteps: 8,
        refusePackageInstall: true,
        reportBudgetSec: 60,
        researchBudgetSec: 240,
        stageCaptureMax: 3,
        task: binding?.taskId ?? "circle-packing",
        taskDescriptionPinned: true,
        totalAllowanceSec: 320,
      },
      model: null,
      privateRoot: "/private",
      profileId: "fixture",
      pythonExecutable: "/python",
      readerScriptPath: "/reader",
      seedDir: "/seed",
      ...(overrides.launchedAt === undefined ? { launchedAt: createdAt } : { launchedAt: overrides.launchedAt }),
    },
    operationId: id,
    ownerRunId: overrides.ownerRunId ?? "conversation-run-1",
    progress: {
      stages: [stage],
      usage: overrides.usage === null ? null : overrides.usage ?? {
        calls: 2,
        completedCalls: 2,
        failedCalls: 0,
        inputTokens: 100,
        models: ["fixture"],
        outputTokens: 50,
        unknownUsageCalls: 0,
      },
    },
    receiptPath: "/control/receipt.json",
    schemaVersion: 1,
    state,
    stop: {},
    task: binding?.taskId ?? "circle-packing",
    ...(binding === undefined ? {} : { taskBinding: binding }),
    updatedAt,
    workDir: "/work",
  };
}

function groupFor(operations: readonly ScienceFlowLocalResearchOperation[], selections: readonly ScienceFlowResearchResultSelection[] = []) {
  const groups = deriveResearchResultGroups(operations, selections);
  assert.equal(groups.length, 1);
  return groups[0]!;
}

test("minimizing metric keeps the lowest valid run as best even when the latest is worse", () => {
  const best = operation({ metricValue: 0.03, createdAt: "2026-11-16T10:00:01.000Z" });
  const middle = operation({ metricValue: 0.05, createdAt: "2026-11-16T10:00:02.000Z" });
  const latest = operation({ metricValue: 0.04, createdAt: "2026-11-16T10:00:03.000Z" });
  const group = groupFor([best, middle, latest]);
  assert.equal(group.rankable, true);
  assert.equal(group.bestValidOperationId, best.operationId);
  assert.equal(group.latestOperationId, latest.operationId);
  assert.equal(group.comparison.latestVsBest?.direction, "latest-worse");
  assert.ok((group.comparison.latestVsBest?.improvement ?? 0) < 0);
  assert.equal(group.comparison.latestVsBest?.significance, "not-evaluated");
  assert.equal(group.independentFinalEvaluation, null);
});

test("a delivered metric name that differs from the frozen contract is invalid, even when better", () => {
  const best = operation({ metricValue: 0.03 });
  const relabelled = operation({
    metricName: "accuracy",
    metricValue: 0.001,
    stage: { metricName: "accuracy" },
  });
  const group = groupFor([best, relabelled]);
  const entry = group.results.find((result) => result.operationId === relabelled.operationId)!;
  assert.equal(entry.validity, "invalid");
  assert.ok(entry.validityReasons.includes("metric-name-mismatch"));
  assert.equal(group.bestValidOperationId, best.operationId);
});

test("stopped, failed and unknown runs may hold valid evidence but never replace best_valid", () => {
  const best = operation({ metricValue: 0.05 });
  const stopped = operation({ metricValue: 0.0001, state: "stopped" });
  const failed = operation({ metricValue: 0.0002, state: "failed" });
  const unknown = operation({ metricValue: 0.0003, state: "unknown" });
  const stoppedRequested: ScienceFlowLocalResearchOperation = {
    ...operation({ metricValue: 0.0004, state: "completed" }),
    stop: { requestedAt: "2026-11-16T10:00:30.000Z", requestedBy: "tool" },
  };
  const group = groupFor([best, stopped, failed, unknown, stoppedRequested]);
  const byId = new Map(group.results.map((result) => [result.operationId, result]));
  for (const result of [stopped, failed, unknown]) {
    assert.equal(byId.get(result.operationId)?.validity, "valid", "captured evidence remains viewable");
    assert.equal(byId.get(result.operationId)?.promotable, false);
  }
  assert.equal(byId.get(stoppedRequested.operationId)?.validity, "valid");
  assert.equal(byId.get(stoppedRequested.operationId)?.promotable, false);
  assert.equal(group.bestValidOperationId, best.operationId);
  assert.equal(group.comparison.latestVsBest, null);
});

test("maximizing metric keeps the highest valid run as best", () => {
  const binding = preparedBinding({ lowerIsBetter: false, metricName: "accuracy" });
  const low = operation({ binding, metricValue: 0.71 });
  const high = operation({ binding, metricValue: 0.83 });
  const group = groupFor([low, high], []);
  assert.equal(group.bestValidOperationId, high.operationId);
});

test("no-candidate, failed evaluator, missing metric and unknown direction are invalid, never zero", () => {
  const good = operation({ metricValue: 0.2 });
  const failedStage = operation({
    metricValue: 0.01,
    stage: { evaluatorStatus: "error", validationOk: false },
  });
  const ineligible = operation({
    metricValue: 0.01,
    stage: { selectionEligible: false },
  });
  const noCandidate = operation({
    deliveryState: "no-candidate",
    metricValue: 0.0001,
  });
  const missingMetric = operation({
    metricValue: Number.NaN,
  });
  const unknownDirection = operation({
    binding: preparedBinding({ lowerIsBetter: null }),
    lowerIsBetter: null,
  });
  const group = groupFor([good, failedStage, ineligible, noCandidate, missingMetric]);
  const byId = new Map(group.results.map((result) => [result.operationId, result]));
  assert.equal(byId.get(failedStage.operationId)?.validity, "invalid");
  assert.ok(byId.get(failedStage.operationId)?.validityReasons.includes("stage-validation-failed"));
  assert.ok(byId.get(ineligible.operationId)?.validityReasons.includes("stage-not-selection-eligible"));
  assert.equal(byId.get(noCandidate.operationId)?.validity, "invalid");
  assert.ok(byId.get(noCandidate.operationId)?.validityReasons.includes("no-candidate"));
  assert.equal(byId.get(missingMetric.operationId)?.validity, "invalid");
  assert.ok(byId.get(missingMetric.operationId)?.validityReasons.includes("metric-missing"));
  assert.equal(group.bestValidOperationId, good.operationId);
  // A different metric direction is a different scientific contract, so the
  // unknown-direction run is invalid in its own group rather than mixed in.
  const unknownGroup = groupFor([unknownDirection]);
  assert.equal(unknownGroup.results[0]?.validity, "invalid");
  assert.ok(unknownGroup.results[0]?.validityReasons.includes("direction-unknown"));
  assert.equal(unknownGroup.bestValidOperationId, null);
});

test("different task, evaluator, data or engine revision never share a comparison group", () => {
  const base = operation({ metricValue: 0.2 });
  const otherContract = operation({
    metricValue: 0.1,
    binding: preparedBinding({ contractHash: "1".repeat(64) }),
  });
  const otherEvaluator = operation({
    metricValue: 0.1,
    binding: preparedBinding({ evaluator: { kind: "generated-command", sha256: "2".repeat(64), versionId: "ev2" } }),
  });
  const otherData = operation({
    metricValue: 0.1,
    binding: preparedBinding({ inputs: [{ logicalName: "fit.csv", sha256: "3".repeat(64), size: 10, versionId: "v2" }] }),
  });
  const catalog = operation({
    binding: {
      artifactKind: "json_solution",
      artifactPath: "artifacts/solution.json",
      authoritative: true,
      evaluator: {
        entrypoint: "evaluator.py:evaluate",
        entrypointSha256: "1".repeat(64),
        kind: "task-package",
        packageSha256: "2".repeat(64),
      },
      inputs: [],
      lowerIsBetter: false,
      metricName: "inv_ratio_squared",
      metricType: "benchmark",
      source: "catalog",
      summary: "ratio",
      taskId: "ratio-minimization",
      title: "ratio",
    },
  });
  const otherRevision = operation({
    binding: catalog.taskBinding,
    engineRevision: "b".repeat(40),
  });
  const groups = deriveResearchResultGroups(
    [base, otherContract, otherEvaluator, otherData, catalog, otherRevision],
    [],
  );
  assert.equal(groups.length, 6);
  assert.equal(new Set(groups.map((group) => group.groupId)).size, 6);
  // Each group can only pick a best from its own rows.
  for (const group of groups) {
    assert.ok(group.bestValidOperationId === null || group.results
      .filter((result) => result.validity === "valid")
      .some((result) => result.operationId === group.bestValidOperationId));
  }
  const catalogGroup = groups.find((group) => group.contract.source === "catalog"
    && group.results.some((result) => result.operationId === catalog.operationId));
  assert.equal(catalogGroup?.comparable, true);
});

test("a catalog result is valid only when the executed evaluator package matches the frozen description", () => {
  const entrypointSha256 = "1".repeat(64);
  const packageSha256 = "2".repeat(64);
  const binding: ScienceFlowTaskBinding = {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    authoritative: true,
    evaluator: { entrypoint: "evaluator.py:evaluate", entrypointSha256, kind: "task-package", packageSha256 },
    inputs: [],
    lowerIsBetter: false,
    metricName: "inv_ratio_squared",
    metricType: "benchmark",
    source: "catalog",
    summary: "ratio",
    taskId: "ratio-minimization",
    title: "ratio",
  };
  const base = operation({ binding });
  const valid: ScienceFlowLocalResearchOperation = {
    ...base,
    engine: { ...base.engine, evaluator: { entrypointSha256, packageSha256, taskId: "ratio-minimization" } },
  };
  const mismatch: ScienceFlowLocalResearchOperation = {
    ...operation({ binding }),
    engine: { ...base.engine, evaluator: { entrypointSha256, packageSha256: "9".repeat(64) } },
  };
  const missing = operation({ binding });
  const group = groupFor([valid, mismatch, missing]);
  const byId = new Map(group.results.map((result) => [result.operationId, result]));
  assert.equal(byId.get(valid.operationId)?.validity, "valid");
  assert.equal(byId.get(valid.operationId)?.promotable, true);
  assert.ok(byId.get(mismatch.operationId)?.validityReasons.includes("executed-evaluator-mismatch"));
  assert.ok(byId.get(missing.operationId)?.validityReasons.includes("executed-evaluator-identity-missing"));
  assert.equal(group.bestValidOperationId, valid.operationId);

  const otherPackage = operation({
    binding: {
      ...binding,
      evaluator: { entrypoint: "evaluator.py:evaluate", entrypointSha256, kind: "task-package", packageSha256: "3".repeat(64) },
    },
  });
  const otherGroup = deriveResearchResultGroups([valid, otherPackage], []);
  assert.equal(otherGroup.length, 2, "different executed package bytes are a different scientific identity");
});

test("a catalog run without an observable engine revision is shown but not ranked", () => {
  const binding: ScienceFlowTaskBinding = {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    authoritative: true,
    evaluator: { kind: "task-package", entrypoint: "evaluator.py:evaluate" },
    inputs: [],
    lowerIsBetter: false,
    metricName: "inv_ratio_squared",
    metricType: "benchmark",
    source: "catalog",
    summary: "ratio",
    taskId: "ratio-minimization",
    title: "ratio",
  };
  const first = operation({ binding, engineRevision: null });
  const second = operation({ binding, engineRevision: null });
  const group = groupFor([first, second]);
  assert.equal(group.comparable, false);
  assert.equal(group.rankable, false);
  assert.equal(group.incomparableReason, "engine-revision-unknown");
  assert.equal(group.bestValidOperationId, null);
});

test("an explicitly selected non-optimal result stays selected while best_valid remains the best", () => {
  const best = operation({ metricValue: 0.02 });
  const worse = operation({ metricValue: 0.08 });
  const group = groupFor([best, worse]);
  const selected = createResearchSelection([group], {
    now: "2026-11-16T11:00:00.000Z",
    operationId: worse.operationId,
    projectId: "project-1",
    reason: "The worse run explored a different basin that the next plan needs.",
    selectedBy: "tool",
    sessionId: "session-1",
  });
  assert.equal(selected.selection.wasBestValid, false);
  assert.equal(selected.selection.bestValidOperationId, best.operationId);
  const view = groupFor([best, worse], [selected.selection]);
  assert.equal(view.bestValidOperationId, best.operationId);
  assert.equal(view.selectionState, "non-optimal");
  assert.equal(view.selection?.operationId, worse.operationId);
  assert.equal(view.selection?.isBestValid, false);
});

test("a selection becomes stale when its result stops being valid", () => {
  const chosen = operation({ metricValue: 0.02 });
  const first = groupFor([chosen]);
  const selected = createResearchSelection([first], {
    now: "2026-11-16T11:00:00.000Z",
    operationId: chosen.operationId,
    projectId: "project-1",
    reason: "Starting here.",
    selectedBy: "tool",
    sessionId: "session-1",
  });
  const later = { ...chosen, delivery: { ...chosen.delivery, state: "failed" as const } };
  const view = groupFor([later], [selected.selection]);
  assert.equal(view.selectionState, "stale");
  assert.equal(view.selection?.valid, false);
});

test("an invalid or cross-contract result cannot be selected for the next run", () => {
  const good = operation({ metricValue: 0.02 });
  const invalid = operation({ deliveryState: "no-candidate" });
  const group = groupFor([good, invalid]);
  assert.throws(
    () => createResearchSelection([group], {
      now: "2026-11-16T11:00:00.000Z",
      operationId: invalid.operationId,
      projectId: "project-1",
      reason: "Try this.",
      selectedBy: "tool",
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof ResearchResultRefusal && error.reason === "result-invalid",
  );
});

test("an unknown metric direction blocks ranking and selection", () => {
  const binding = preparedBinding({ lowerIsBetter: null });
  const first = operation({ binding, lowerIsBetter: undefined });
  const group = groupFor([first]);
  assert.equal(group.rankable, false);
  assert.equal(group.rankingBlockedReason, "metric-direction-unknown");
  assert.equal(group.bestValidOperationId, null);
  assert.throws(
    () => createResearchSelection([group], {
      now: "2026-11-16T11:00:00.000Z",
      operationId: first.operationId,
      projectId: "project-1",
      reason: "Try this.",
      selectedBy: "tool",
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof ResearchResultRefusal && error.reason === "metric-direction-unknown",
  );
});

test("equal scores keep one deterministic best across repeated derivations", () => {
  const first = operation({ metricValue: 0.05, createdAt: "2026-11-16T10:00:01.000Z" });
  const second = operation({ metricValue: 0.05, createdAt: "2026-11-16T10:00:02.000Z" });
  const one = groupFor([first, second]);
  const two = groupFor([second, first]);
  assert.equal(one.bestValidOperationId, first.operationId);
  assert.equal(two.bestValidOperationId, first.operationId);
});

test("a legacy fixed-profile run is visible but not comparable", () => {
  const legacy = operation({ binding: null });
  const group = groupFor([legacy]);
  assert.equal(group.contract.source, "fixed");
  assert.equal(group.comparable, false);
  assert.equal(group.incomparableReason, "legacy-fixed-profile");
  assert.equal(group.bestValidOperationId, null);
});

test("the parent charges a launched run with no elapsed time at its reservation and keeps tokens unknown", () => {
  const unknown = operation({
    elapsedSec: undefined,
    launchedAt: "2026-11-16T10:00:00.000Z",
    usage: null,
  });
  const contract = researchContractIdentityFrom(unknown.taskBinding, unknown.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const groupId = researchGroupId(unknown);
  const parent = projectResearchParent({
    contract,
    existing: undefined,
    groupId,
    identity: unknown.identity,
    limits: { maxChildRuns: 3, totalAllowanceSec: 1_000 },
    now: "2026-11-16T12:00:00.000Z",
    operations: [unknown],
  });
  const view = researchParentView(parent, [unknown], "2026-11-16T12:00:00.000Z");
  assert.equal(view.usage.wallClock.unknownSettlements, 1);
  assert.equal(view.usage.wallClock.chargedSeconds, 320);
  assert.equal(view.usage.wallClock.knownSeconds, 0);
  assert.equal(view.usage.tokens.status, "unknown");
  assert.equal(view.usage.tokens.hardCap, null);
  assert.equal(view.usage.wallClock.remainingSeconds, 680);
});

test("the research line refuses a reservation after its deadline", () => {
  const first = operation({ createdAt: "2026-11-16T10:00:00.000Z" });
  const contract = researchContractIdentityFrom(first.taskBinding, first.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const parent = projectResearchParent({
    contract,
    existing: undefined,
    groupId: researchGroupId(first),
    identity: first.identity,
    limits: { maxChildRuns: 5, totalAllowanceSec: 100 },
    now: "2026-11-16T10:00:00.000Z",
    operations: [first],
  });
  const refusal = researchLineRefusal({
    allowanceSec: 60,
    now: "2026-11-16T11:00:00.000Z",
    operations: [first],
    ownerRunId: "conversation-run-2",
    parent,
  });
  assert.deepEqual(refusal, {
    message: "The research line reached its deadline (2026-11-16T10:01:40.000Z); no further child may be reserved",
    reason: "parent-deadline-exceeded",
  });
});

test("a child whose full allowance crosses the line deadline is refused even if some budget remains", () => {
  const first = operation({ createdAt: "2026-11-17T01:00:00.000Z" });
  const contract = researchContractIdentityFrom(first.taskBinding, first.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const parent = projectResearchParent({
    contract,
    existing: undefined,
    groupId: researchGroupId(first),
    identity: first.identity,
    limits: { maxChildRuns: 5, totalAllowanceSec: 1_800 },
    now: "2026-11-17T01:00:00.000Z",
    operations: [first],
  });
  const refusal = researchLineRefusal({
    allowanceSec: 320,
    now: "2026-11-17T01:29:59.000Z",
    operations: [first],
    ownerRunId: "conversation-run-2",
    parent,
  });
  assert.equal(refusal?.reason, "parent-deadline-exceeded");
  assert.match(refusal?.message ?? "", /1s before its deadline/);
});

test("the parent records a not-launched failure as zero wall clock and no reservation", () => {
  const failed = operation({ state: "failed", deliveryState: "failed", elapsedSec: undefined });
  const notLaunched: ScienceFlowLocalResearchOperation = {
    ...failed,
    engine: {},
    launch: { ...failed.launch, launchedAt: undefined },
    progress: { ...failed.progress, usage: null },
  };
  const contract = researchContractIdentityFrom(notLaunched.taskBinding, notLaunched.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const parent = projectResearchParent({
    contract,
    existing: undefined,
    groupId: researchGroupId(notLaunched),
    identity: notLaunched.identity,
    limits: { maxChildRuns: 2, totalAllowanceSec: 1_000 },
    now: "2026-11-16T12:00:00.000Z",
    operations: [notLaunched],
  });
  const view = researchParentView(parent, [notLaunched], "2026-11-16T12:00:00.000Z");
  assert.equal(view.usage.wallClock.notLaunched, 1);
  assert.equal(view.usage.wallClock.chargedSeconds, 0);
  assert.equal(view.usage.tokens.status, "not-launched");
});

test("a preparation failure that never launched is charged its observed operation wall clock", () => {
  const failed = operation({
    createdAt: "2026-11-16T10:00:00.000Z",
    deliveryState: "failed",
    state: "failed",
    updatedAt: "2026-11-16T10:00:07.000Z",
  });
  const notLaunched: ScienceFlowLocalResearchOperation = {
    ...failed,
    engine: {},
    launch: { ...failed.launch, launchedAt: undefined },
    progress: { ...failed.progress, usage: null },
  };
  const contract = researchContractIdentityFrom(notLaunched.taskBinding, notLaunched.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const parent = projectResearchParent({
    contract,
    existing: undefined,
    groupId: researchGroupId(notLaunched),
    identity: notLaunched.identity,
    limits: { maxChildRuns: 2, totalAllowanceSec: 1_000 },
    now: "2026-11-16T12:00:00.000Z",
    operations: [notLaunched],
  });
  const view = researchParentView(parent, [notLaunched], "2026-11-16T12:00:00.000Z");
  assert.equal(view.usage.wallClock.notLaunched, 1);
  assert.equal(view.usage.wallClock.chargedSeconds, 7);
  assert.equal(view.usage.wallClock.knownSeconds, 0);
  assert.equal(view.usage.wallClock.remainingSeconds, 993);
});

// ---------------------------------------------------------------------------
// Service-level persistence, rebuild and budget enforcement.

interface Fixture {
  readonly root: string;
  readonly store: SessionStore;
  readonly projectId: string;
  readonly sessionId: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-research-results-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Results");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Results session", { modelId: model.id });
  return { projectId: project.id, root, sessionId: session.id, store };
}

function settingsFor(fixture: Fixture, parentBudget?: { maxChildRuns: number; totalAllowanceSec: number }): ScienceFlowLocalResearchSettings {
  return {
    defaults: {
      bashTimeoutSec: 60,
      codeMaxTokens: 1_024,
      feedbackMaxTokens: 1_024,
      httpTimeoutSec: 60,
      maxSteps: 8,
      observeMaxWaitMs: 0,
      reportBudgetSec: 60,
      researchBudgetSec: 240,
      stageCaptureMax: 3,
      totalAllowanceSec: 320,
    },
    engineCheckout: join(fixture.root, "engine"),
    inputMode: "fixed",
    privateRoot: join(fixture.root, "private"),
    profileId: "results-fixture",
    pythonExecutable: join(fixture.root, "python"),
    readerScriptPath: join(fixture.root, "reader.py"),
    refusePackageInstall: true,
    seedDir: join(fixture.root, "seed"),
    taskMode: "fixed",
    task: "circle-packing",
    workRoot: join(fixture.root, "work"),
    ...(parentBudget === undefined ? {} : { parentBudget }),
  };
}

function tenantOperation(
  fixture: Fixture,
  overrides: Parameters<typeof operation>[0] = {},
): ScienceFlowLocalResearchOperation {
  const base = operation(overrides);
  return {
    ...base,
    identity: { projectId: fixture.projectId, sessionId: fixture.sessionId },
    workDir: join(fixture.root, "work", base.operationId),
  };
}

function insert(fixture: Fixture, record: ScienceFlowLocalResearchOperation): ScienceFlowLocalResearchOperation {
  return fixture.store.scienceFlowResearchOperations.createIfAbsent(record).record;
}

test("the service persists an explicit non-optimal selection and a rebuilt service reads it back", async (context) => {
  const target = await fixture(context);
  const best = insert(target, tenantOperation(target, {
    createdAt: "2026-11-16T10:00:01.000Z",
    metricValue: 0.02,
  }));
  const worse = insert(target, tenantOperation(target, {
    createdAt: "2026-11-16T10:00:02.000Z",
    metricValue: 0.09,
  }));
  const first = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const group = first.selectForNext({
    operationId: worse.operationId,
    projectId: target.projectId,
    reason: "A deliberately different basin",
    sessionId: target.sessionId,
  });
  assert.equal(group.bestValidOperationId, best.operationId);
  assert.equal(group.selection?.operationId, worse.operationId);
  assert.equal(group.selectionState, "non-optimal");
  assert.equal(group.parent?.decisions.some((decision) => decision.kind === "select"), true);
  target.store.close();

  const reopened = new SessionStore(target.root);
  await reopened.load();
  try {
    const second = createLocalResearchService({ settings: settingsFor(target), store: reopened }, {
      now: () => "2026-11-16T10:05:00.000Z",
      readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
      readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
    });
    const groups = second.results({ projectId: target.projectId, sessionId: target.sessionId });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.bestValidOperationId, best.operationId);
    assert.equal(groups[0]!.selection?.operationId, worse.operationId);
    assert.equal(groups[0]!.selectionState, "non-optimal");
    // The relation attached to each operation view is derived, not cached.
    const views = second.list(target.projectId, target.sessionId);
    const worseView = views.find((view) => view.operationId === worse.operationId)!;
    assert.equal(worseView.resultRelation?.isSelectedForNext, true);
    assert.equal(worseView.resultRelation?.isBestValid, false);
    assert.equal(worseView.resultRelation?.bestValid?.operationId, best.operationId);
  } finally {
    reopened.close();
  }
});

test("the service refuses a selection from another Session's group", async (context) => {
  const target = await fixture(context);
  insert(target, tenantOperation(target));
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  assert.throws(
    () => service.selectForNext({
      operationId: "missing-operation",
      projectId: target.projectId,
      reason: "not here",
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "operation-not-found",
  );
});

function completedLaunch(calls: { count: number }) {
  return async (input: { readonly workDir: string; readonly runId: string }): Promise<ResearchPilotLaunchOutcome> => {
    calls.count += 1;
    await mkdir(join(input.workDir, "state", "scienceflow", "managed_runs", input.runId), { recursive: true });
    await writeFile(
      join(input.workDir, "state", "scienceflow", "managed_runs", input.runId, "control.json"),
      JSON.stringify({ alive: false, phase: "finished", status: "completed" }),
      "utf8",
    );
    return {
      elapsedSec: 11,
      outcome: "finished",
      phase: "finished",
      status: "completed",
      supervisorAliveAfterFinish: false,
    };
  };
}

test("a full line refuses another child at its configured run-count limit before launching", async (context) => {
  const target = await fixture(context);
  insert(target, tenantOperation(target, {
    binding: null,
    state: "completed",
  }));
  insert(target, tenantOperation(target, {
    binding: null,
    state: "completed",
  }));
  const calls = { count: 0 };
  const service = createLocalResearchService({
    settings: settingsFor(target, { maxChildRuns: 2, totalAllowanceSec: 1_000 }),
    store: target.store,
  }, {
    launch: completedLaunch(calls),
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  await assert.rejects(
    () => service.start({
      intent: "A third bounded run.",
      ownerRunId: "conversation-run-2",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "parent-budget-exhausted",
  );
  assert.equal(calls.count, 0);
  assert.equal(target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId).length, 2);
});

test("a second child is refused while the first is active, and a stopped line blocks a same-conversation start", async (context) => {
  const target = await fixture(context);
  const active = insert(target, tenantOperation(target, {
    binding: null,
    state: "running",
    deliveryState: "pending",
  }));
  const calls = { count: 0 };
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    launch: completedLaunch(calls),
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  await assert.rejects(
    () => service.start({
      intent: "A concurrent run.",
      ownerRunId: "conversation-run-2",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "research-line-busy",
  );
  // An already-terminal engine stop records the line's stop intent.
  await mkdir(join(active.workDir, "state", "scienceflow", "managed_runs", active.engineRunId), { recursive: true });
  await writeFile(
    join(active.workDir, "state", "scienceflow", "managed_runs", active.engineRunId, "control.json"),
    JSON.stringify({ alive: false, phase: "finished", status: "stopped" }),
    "utf8",
  );
  const stopped = await service.stop({
    operationId: active.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(stopped.requested, false);
  await assert.rejects(
    () => service.start({
      intent: "A start after the stop.",
      ownerRunId: "conversation-run-1",
      projectId: target.projectId,
      sessionId: target.sessionId,
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "research-line-stopped",
  );
  // A later conversation run is a new explicit request: it may resume the line,
  // and that start supersedes the earlier conversation's stop intent.
  const resumed = await service.start({
    intent: "A new conversation explicitly resumes the line.",
    ownerRunId: "conversation-run-2",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(resumed.attached, false);
  const parent = service.results({ projectId: target.projectId, sessionId: target.sessionId })[0]!.parent;
  assert.equal(parent?.stop.requestedAt, undefined);
});

test("a rebuilt service never relaunches a terminal operation while recomputing the comparison", async (context) => {
  const target = await fixture(context);
  insert(target, tenantOperation(target, {
    binding: null,
    state: "completed",
    elapsedSec: 12,
  }));
  const calls = { count: 0 };
  const first = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    launch: completedLaunch(calls),
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const before = first.results({ projectId: target.projectId, sessionId: target.sessionId });
  target.store.close();
  const reopened = new SessionStore(target.root);
  await reopened.load();
  try {
    const second = createLocalResearchService({ settings: settingsFor(target), store: reopened }, {
      launch: completedLaunch(calls),
      now: () => "2026-11-16T10:05:00.000Z",
      readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
      readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
    });
    const after = second.results({ projectId: target.projectId, sessionId: target.sessionId });
    assert.deepEqual(after.map((group) => group.groupId), before.map((group) => group.groupId));
    assert.equal(after[0]!.parent?.usage.wallClock.knownSeconds, 12);
    assert.equal(calls.count, 0, "reading a rebuilt comparison must never start a run");
  } finally {
    reopened.close();
  }
});

test("the contract identity is stable across equivalent operations and differs on data", () => {
  const first = operation();
  const same = operation();
  const otherData = operation({
    binding: preparedBinding({ inputs: [{ logicalName: "fit.csv", sha256: "9".repeat(64), size: 10, versionId: "v9" }] }),
  });
  const identityOne = researchContractIdentityFrom(first.taskBinding, first.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const identityTwo = researchContractIdentityFrom(same.taskBinding, same.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  const identityThree = researchContractIdentityFrom(otherData.taskBinding, otherData.task, { executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }, revision: ENGINE_REVISION, statusDigest: "s".repeat(64), worktreeDirty: false });
  assert.equal(contractFingerprint(identityOne), contractFingerprint(identityTwo));
  assert.notEqual(contractFingerprint(identityOne), contractFingerprint(identityThree));
  assert.notEqual(researchGroupId(first), researchGroupId(otherData));
});


test("observation records the evaluator package the engine actually registered", async (context) => {
  const target = await fixture(context);
  const record = insert(target, tenantOperation(target, { binding: null, state: "running", deliveryState: "pending" }));
  const runRoot = join(record.workDir, "runs", record.engineRunId, record.task);
  await mkdir(join(runRoot, "task_runtime"), { recursive: true });
  await writeFile(
    join(runRoot, "task_runtime", "registry.json"),
    JSON.stringify({
      entrypoint_sha256: "1".repeat(64),
      package_sha256: "2".repeat(64),
      task_id: record.task,
    }),
    "utf8",
  );
  await mkdir(join(record.workDir, "state", "scienceflow", "managed_runs", record.engineRunId), { recursive: true });
  await writeFile(
    join(record.workDir, "state", "scienceflow", "managed_runs", record.engineRunId, "control.json"),
    JSON.stringify({ alive: false, phase: "finished", status: "completed" }),
    "utf8",
  );
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const view = await service.get({
    operationId: record.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.deepEqual(view.engine.evaluator, {
    entrypointSha256: "1".repeat(64),
    packageSha256: "2".repeat(64),
    taskId: record.task,
  });
});

for (const delaySec of [150, 950, 1001]) {
  test(`preparation taking ${delaySec}s respects shared allowance and SF minimums`, async (context) => {
    const target = await fixture(context);
    const plan = await publishArtifact(target, "experiment_plan.md", Buffer.from("# plan\n", "utf8"), "other", "text/markdown");
    await mkdir(join(target.root, "seed"), { recursive: true });
    let clock = Date.parse("2026-11-16T10:00:00.000Z");
    let reads = 0;
    const launches: Array<{ totalAllowanceSec: number }> = [];
    const settings = {
      ...settingsFor(target, { maxChildRuns: 5, totalAllowanceSec: 1_000 }),
      defaults: { ...settingsFor(target).defaults, reportBudgetSec: 60, researchBudgetSec: 240, totalAllowanceSec: 900 },
      dynamicInputs: { incumbent: "start_solution.json", incumbentOptional: true, plan: "experiment_plan.md" },
      inputMode: "dynamic" as const,
      taskTemplate: "Read {{plan_file}} ({{plan_version_id}}). Intent: {{research_intent}}",
    };
    const service = createLocalResearchService({ settings, store: target.store }, {
      deliver: async () => ({ outcome: { failedStep: "readback", message: "stub", status: "failed" } } as unknown as ScienceFlowResultDeliveryRecord),
      launch: async (input) => {
        launches.push({ totalAllowanceSec: input.totalAllowanceSec });
        return completedLaunch({ count: 0 })(input);
      },
      now: () => new Date(clock).toISOString(),
      readArtifactBytes: async (hash) => {
        const bytes = await new CasStore(target.store.dataDir).read(hash);
        reads += 1;
        // The first read verifies the named plan at start; the second is the
        // asynchronous staging copy, where a real preparation delay occurs.
        if (reads === 2) clock += delaySec * 1_000;
        return bytes;
      },
      readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
      readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
    });
    const started = await service.start({
      intent: "A bounded run whose preparation is slow.",
      ownerRunId: "conversation-run-1",
      planVersionId: plan.versionId,
      projectId: target.projectId,
      sessionId: target.sessionId,
    });
    const deadline = Date.now() + 3_000;
    while (launches.length === 0
      && target.store.scienceFlowResearchOperations.get(started.operation.operationId)?.state !== "failed"
      && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const record = target.store.scienceFlowResearchOperations.get(started.operation.operationId)!;
    if (delaySec === 150) {
      assert.equal(launches.length, 1, JSON.stringify({ error: record.error, state: record.state }));
      assert.equal(launches[0]!.totalAllowanceSec, 850);
      assert.equal(record.launch.grant.totalAllowanceSec, 850);
    } else {
      assert.equal(launches.length, 0);
      assert.equal(record.state, "failed");
      assert.equal(record.error?.step, "budget");
      assert.match(record.error?.message ?? "", delaySec === 950 ? /at least 60s/ : /exhausted during preparation/);
    }
  });
}

test("a stop recorded during preparation prevents the launch and leaves the run stopped", async (context) => {
  const target = await fixture(context);
  const plan = await publishArtifact(target, "experiment_plan.md", Buffer.from("# plan\n", "utf8"), "other", "text/markdown");
  await mkdir(join(target.root, "seed"), { recursive: true });
  let reads = 0;
  const launches: string[] = [];
  const settings = {
    ...settingsFor(target),
    dynamicInputs: { incumbent: "start_solution.json", incumbentOptional: true, plan: "experiment_plan.md" },
    inputMode: "dynamic" as const,
    taskTemplate: "Read {{plan_file}} ({{plan_version_id}}). Intent: {{research_intent}}",
  };
  const service = createLocalResearchService({ settings, store: target.store }, {
    launch: async (input) => {
      launches.push(input.runId);
      return completedLaunch({ count: 0 })(input);
    },
    now: () => "2026-11-16T10:05:00.000Z",
    readArtifactBytes: async (hash) => {
      const bytes = await new CasStore(target.store.dataDir).read(hash);
      reads += 1;
      if (reads === 2) {
        const current = target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId)
          .find((operation) => !isTerminalResearchState(operation.state));
        if (current) {
          target.store.scienceFlowResearchOperations.update({
            ...current,
            stop: { requestedAt: "2026-11-16T10:05:30.000Z", requestedBy: "conversation-cancel" },
            updatedAt: "2026-11-16T10:05:30.000Z",
          });
        }
      }
      return bytes;
    },
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const started = await service.start({
    intent: "A run cancelled while its inputs are staging.",
    ownerRunId: "conversation-run-1",
    planVersionId: plan.versionId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  let view = await service.get({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const deadline = Date.now() + 3_000;
  while (view.state !== "stopped" && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    view = await service.get({
      operationId: started.operation.operationId,
      projectId: target.projectId,
      sessionId: target.sessionId,
    });
  }
  assert.equal(view.state, "stopped");
  assert.equal(launches.length, 0);
});

test("a rebuilt service reconciles a finished stored child instead of relaunching it or blocking the line", async (context) => {
  const target = await fixture(context);
  const stale = insert(target, tenantOperation(target, {
    binding: null,
    state: "running",
    deliveryState: "pending",
  }));
  await mkdir(join(stale.workDir, "state", "scienceflow", "managed_runs", stale.engineRunId), { recursive: true });
  await writeFile(
    join(stale.workDir, "state", "scienceflow", "managed_runs", stale.engineRunId, "control.json"),
    JSON.stringify({ alive: false, phase: "finished", status: "completed" }),
    "utf8",
  );
  const launches = { count: 0 };
  const deliveries: string[] = [];
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    deliver: async (_store, request) => {
      deliveries.push(request.runId);
      return {
        outcome: {
          failedStep: "readback",
          message: "stub delivery",
          reason: "readback-failed",
          status: "failed",
        },
      } as unknown as ScienceFlowResultDeliveryRecord;
    },
    launch: completedLaunch(launches),
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const started = await service.start({
    intent: "The next explicit experiment.",
    ownerRunId: "conversation-run-2",
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(started.attached, false);
  const deadline = Date.now() + 3_000;
  while (launches.count === 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(launches.count, 1, "only the new child is launched");
  assert.equal(deliveries[0], stale.engineRunId, "the finished stored child is published before the next child");
  assert.ok(deliveries.includes(stale.engineRunId), "the finished stored child is published, not rerun");
  const reconciled = target.store.scienceFlowResearchOperations.get(stale.operationId)!;
  assert.notEqual(reconciled.state, "running");
});


async function publishArtifact(
  fixture: Fixture,
  logicalName: string,
  bytes: Buffer,
  kind: "json" | "other",
  mediaType: string,
): Promise<{ artifactId: string; versionId: string; sha256: string; size: number }> {
  const content = await new CasStore(fixture.store.dataDir).put(bytes);
  const { artifact, version } = await fixture.store.createArtifactVersion({
    content,
    kind,
    logicalName,
    mediaType,
    origin: "server_generated",
    sessionId: fixture.sessionId,
  });
  return { artifactId: artifact.id, sha256: content.hash, size: content.size, versionId: version.id };
}

test("check_evolve_pilot freezes the adapter from the real evaluator, CSV and delivered solution", async (context) => {
  const target = await fixture(context);
  const evaluatorSource = Buffer.from([
    "import json, sys",
    "from pathlib import Path",
    "rows = Path(\"dataset/fit.csv\").read_text().splitlines()[1:]",
    "artifact = json.loads(Path(sys.argv[1]).read_text())",
    "print(json.dumps({\"metric\": abs(float(artifact[\"a\"]) - 2.0) + len(rows) * 0}))",
    "",
  ].join("\n"), "utf8");
  const csv = Buffer.from(`x,y\n${Array.from({ length: 20 }, (_, index) => `${index + 1},${2 * (index + 1) + 1}`).join("\n")}\n`, "utf8");
  const solution = Buffer.from(JSON.stringify({ a: 2, b: 1 }), "utf8");
  const evaluator = await publishArtifact(target, "research-tasks/sd-fit/evaluator.py", evaluatorSource, "other", "text/x-python");
  const dataset = await publishArtifact(target, "fit.csv", csv, "other", "text/csv");
  const delivered = await publishArtifact(target, "best-solution.json", solution, "json", "application/json");
  const binding = preparedBinding({
    evaluator: { kind: "generated-command", sha256: evaluator.sha256, versionId: evaluator.versionId },
    inputs: [{ logicalName: "fit.csv", sha256: dataset.sha256, size: dataset.size, versionId: dataset.versionId }],
    taskId: "sd-fit",
  });
  const record = tenantOperation(target, { binding });
  const operationRecord: ScienceFlowLocalResearchOperation = {
    ...record,
    delivery: {
      ...record.delivery,
      solution: {
        artifactId: delivered.artifactId,
        logicalName: "best-solution.json",
        role: "solution",
        version: 1,
        versionId: delivered.versionId,
      },
    },
  };
  insert(target, operationRecord);
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const check = await service.checkEvolvePilot({
    expansions: 12,
    operationId: operationRecord.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
    statement: "Improve the fit from the delivered candidate.",
    workers: 1,
  });
  assert.equal(check.adapterShapeSupported, true, check.gaps.join("; "));
  assert.equal(check.executionSupported, false);
  assert.equal(check.adapter?.candidateFormat, "json-artifact-function");
  assert.equal(check.adapter?.dataset.name, "fit.csv");
  assert.equal(check.adapter?.dataset.rows, 20);
  assert.equal(check.adapter?.shardCount, 16);
  assert.equal(check.adapter?.dataset.sha256, dataset.sha256);
  assert.equal(check.adapter?.evaluatorSourceSha256, (await import("./evolve-pilot-adapter.js")).buildEvolvePilotArtifacts({
    artifactKind: binding.artifactKind,
    artifactPath: binding.artifactPath,
    dataset: { bytes: csv, name: "fit.csv" },
    evaluatorBytes: evaluatorSource,
    lowerIsBetter: true,
    metricJsonPath: binding.metricJsonPath!,
    metricName: binding.metricName,
    timeoutSeconds: 120,
  }, solution).evaluatorSourceSha256);
  assert.ok(check.executionUnsupportedReasons.some((reason) => /held-out/.test(reason)));
  assert.ok(check.executionUnsupportedReasons.some((reason) => /parent budget/.test(reason)));
  assert.equal(check.gaps.length, 0);
});

test("check_evolve_pilot states the shape gaps instead of adapting an unsupported task", async (context) => {
  const target = await fixture(context);
  insert(target, tenantOperation(target, { binding: null }));
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const check = await service.checkEvolvePilot({
    operationId: target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId)[0]!.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  assert.equal(check.adapterShapeSupported, false);
  assert.equal(check.executionSupported, false);
  assert.ok(check.gaps.some((gap) => /fixed administrator task/.test(gap)));
});


test("a start without an incumbent follows the explicit selected_for_next result", async (context) => {
  const target = await fixture(context);
  const entrypointSha256 = "1".repeat(64);
  const packageSha256 = "2".repeat(64);
  const binding: ScienceFlowTaskBinding = {
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    authoritative: true,
    evaluator: { entrypoint: "evaluator.py:evaluate", entrypointSha256, kind: "task-package", packageSha256 },
    inputs: [],
    lowerIsBetter: false,
    metricName: "inv_ratio_squared",
    metricType: "benchmark",
    source: "catalog",
    summary: "ratio",
    taskId: "ratio-minimization",
    title: "Ratio minimization",
  };
  const solution = await publishArtifact(target, "best-solution.json", Buffer.from(JSON.stringify({ a: 2, b: 1 }), "utf8"), "json", "application/json");
  const otherSolution = await publishArtifact(target, "other-solution.json", Buffer.from(JSON.stringify({ a: 3, b: 2 }), "utf8"), "json", "application/json");
  const priorBase = tenantOperation(target, { binding });
  const prior = insert(target, {
    ...priorBase,
    delivery: {
      ...priorBase.delivery,
      solution: {
        artifactId: solution.artifactId,
        logicalName: "best-solution.json",
        role: "solution",
        version: 1,
        versionId: solution.versionId,
      },
    },
    engine: {
      ...priorBase.engine,
      evaluator: { entrypointSha256, packageSha256, taskId: "ratio-minimization" },
    },
  });
  const selectedAt = "2026-11-16T10:04:00.000Z";
  target.store.scienceFlowResearchResultSelections.put({
    artifactId: solution.artifactId,
    bestValidOperationId: prior.operationId,
    groupId: researchGroupId(prior),
    logicalName: "best-solution.json",
    lowerIsBetter: false,
    metricName: "inv_ratio_squared",
    metricValue: prior.delivery.metricValue!,
    operationId: prior.operationId,
    projectId: target.projectId,
    reason: "The prior geometry is a better starting basin.",
    schemaVersion: 1,
    selectedAt,
    selectedBy: "tool",
    sessionId: target.sessionId,
    version: 1,
    versionId: solution.versionId,
    wasBestValid: true,
  });
  const plan = await publishArtifact(target, "experiment_plan.md", Buffer.from("# plan\n", "utf8"), "other", "text/markdown");
  await mkdir(join(target.root, "seed"), { recursive: true });
  const launches: number[] = [];
  const settings = {
    ...settingsFor(target),
    dynamicInputs: { incumbent: "start_solution.json", incumbentOptional: true, plan: "experiment_plan.md" },
    evaluatorProbeTimeoutSec: 30,
    inputMode: "dynamic" as const,
    preparationScriptPath: join(target.root, "preparation.py"),
    taskMode: "task-dynamic" as const,
    taskTemplate: "Read {{plan_file}} ({{plan_version_id}}). Intent: {{research_intent}}. Incumbent: {{incumbent_file}} ({{incumbent_version_id}}).",
  };
  const dependencies: LocalResearchServiceDependencies = {
    deliver: async () => ({ outcome: { failedStep: "readback", message: "stub", status: "failed" } } as unknown as ScienceFlowResultDeliveryRecord),
    describeTask: async () => ({
      artifactKind: binding.artifactKind,
      artifactPath: binding.artifactPath,
      authoritative: true,
      category: "opt_solver",
      description: "# Ratio minimization",
      descriptionAvailable: true,
      entrypointSha256,
      evaluatorEntrypoint: "evaluator.py:evaluate",
      id: "ratio-minimization",
      inputsRequired: null,
      lowerIsBetter: false,
      metricName: "inv_ratio_squared",
      metricType: "benchmark",
      missingModules: [],
      packageSha256,
      profile: "opt_solver",
      provider: "",
    }),
    launch: async (input) => {
      launches.push(input.totalAllowanceSec);
      await mkdir(join(input.workDir, "state", "scienceflow", "managed_runs", input.runId), { recursive: true });
      await writeFile(
        join(input.workDir, "state", "scienceflow", "managed_runs", input.runId, "control.json"),
        JSON.stringify({ alive: false, phase: "finished", status: "completed" }),
        "utf8",
      );
      return { elapsedSec: 10, outcome: "finished", phase: "finished", status: "completed", supervisorAliveAfterFinish: false };
    },
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  };
  const service = createLocalResearchService({ settings, store: target.store }, dependencies);
  const beforeGroups = service.results({ projectId: target.projectId, sessionId: target.sessionId });
  const beforeGroup = beforeGroups.find((group) => group.groupId === researchGroupId(prior));
  assert.equal(beforeGroup?.selectionState, "best", JSON.stringify(beforeGroup?.selection));
  assert.equal(beforeGroup?.selection?.valid, true);
  const roundRequest: LocalResearchStartInput = {
    intent: "A new round that follows the selected starting point.",
    ownerRunId: "conversation-run-2",
    planVersionId: plan.versionId,
    projectId: target.projectId,
    proposal: {
      evaluationMethod: "Same frozen ratio task and evaluator.",
      evidence: [{ fact: "The prior run delivered a valid candidate.", kind: "operation-result", operationId: prior.operationId }],
      expectedObservation: "A higher inverse ratio squared.",
      methodChange: "Perturb the selected geometry by moving the smallest circle.",
      researchQuestion: "Can the selected geometry be improved?",
      stopCondition: "Stop after the first captured candidate better than the selected one.",
      subBudgetSeconds: 320,
    },
    sessionId: target.sessionId,
    taskPackageId: "ratio-minimization",
  };
  const started = await service.start(roundRequest);
  const record = target.store.scienceFlowResearchOperations.get(started.operation.operationId)!;
  const debugIdentity = {
    next: researchGroupId(record),
    previous: researchGroupId(prior),
    nextBinding: record.taskBinding,
    previousBinding: prior.taskBinding,
    nextLaunch: { dirty: record.launch.engineWorktreeDirty, revision: record.launch.engineRevision },
    previousLaunch: { dirty: prior.launch.engineWorktreeDirty, revision: prior.launch.engineRevision },
  };
  assert.equal(record.incumbentVersionId, solution.versionId, JSON.stringify(debugIdentity));
  assert.equal(record.followedSelection?.operationId, prior.operationId);
  assert.equal(record.followedSelection?.versionId, solution.versionId);
  assert.equal(record.followedSelection?.reason, "The prior geometry is a better starting basin.");
  assert.equal(record.proposal?.fingerprint.length, 64);
  assert.equal(record.proposal?.subBudgetSeconds, 320);
  assert.equal(record.launch.grant.totalAllowanceSec, 320);
  assert.ok(record.proposal?.evidence[0]?.operationId === prior.operationId);

  // A different explicit incumbent conflicts with the recorded selection.
  await assert.rejects(
    () => service.start({
      incumbentVersionId: otherSolution.versionId,
      intent: "A conflicting round.",
      ownerRunId: "conversation-run-3",
      planVersionId: plan.versionId,
      projectId: target.projectId,
      proposal: {
        evaluationMethod: "Same frozen ratio task and evaluator.",
        evidence: [{ fact: "The prior run delivered a valid candidate.", kind: "operation-result", operationId: prior.operationId }],
        expectedObservation: "A higher score.",
        methodChange: "A different method change.",
        researchQuestion: "A different question.",
        stopCondition: "Stop at the first capture.",
      },
      sessionId: target.sessionId,
      taskPackageId: "ratio-minimization",
    }),
    (error: unknown) => error instanceof LocalResearchRefusal && error.reason === "selection-conflict",
  );

  // Replaying the exact request after the operation completes must attach to
  // it, not be refused as a repeated experiment. Wait for the background
  // worker to settle first.
  let settled = await service.get({
    operationId: started.operation.operationId,
    projectId: target.projectId,
    sessionId: target.sessionId,
  });
  const settleDeadline = Date.now() + 5_000;
  while ((settled.state === "accepted" || settled.state === "running") && Date.now() < settleDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    settled = await service.get({
      operationId: started.operation.operationId,
      projectId: target.projectId,
      sessionId: target.sessionId,
    });
  }
  const rowsBeforeReplay = target.store.scienceFlowResearchOperations
    .listForSession(target.projectId, target.sessionId).length;
  const launchesBeforeReplay = launches.length;
  const replay = await service.start(roundRequest);
  assert.equal(replay.attached, true);
  assert.equal(replay.attachedReason, "same-request");
  assert.equal(replay.operation.operationId, started.operation.operationId);
  assert.equal(target.store.scienceFlowResearchOperations.listForSession(target.projectId, target.sessionId).length, rowsBeforeReplay);
  assert.equal(launches.length, launchesBeforeReplay);

  // A rebuilt service over the same store must attach the same replay too.
  const reopened = new SessionStore(target.root);
  await reopened.load();
  context.after(() => reopened.close());
  const rebuilt = createLocalResearchService({ settings, store: reopened }, dependencies);
  const rebuiltReplay = await rebuilt.start(roundRequest);
  assert.equal(rebuiltReplay.attached, true);
  assert.equal(rebuiltReplay.attachedReason, "same-request");
  assert.equal(rebuiltReplay.operation.operationId, started.operation.operationId);
  assert.equal(launches.length, launchesBeforeReplay);
});


test("attributable preparation and probe wall clock is charged to the research line", async (context) => {
  const target = await fixture(context);
  const binding = preparedBinding();
  const operation = insert(target, tenantOperation(target, { binding, elapsedSec: 30 }));
  const preparation: ScienceFlowResearchPreparation = {
    finishedAt: "2026-11-16T10:00:12.000Z",
    identity: { projectId: target.projectId, sessionId: target.sessionId },
    outcome: "succeeded",
    preparationId: "preparation-1",
    probe: { evaluations: 2, evaluatorSha256: binding.evaluator.kind === "generated-command" ? binding.evaluator.sha256 : null, status: "known" },
    runId: "run-1",
    schemaVersion: 1,
    startedAt: "2026-11-16T10:00:00.000Z",
    taskId: binding.taskId,
    taskVersionId: binding.taskVersionId ?? null,
    tokens: { note: "probe runs code", status: "not-applicable" },
    wallClock: { seconds: 12, status: "known" },
  };
  target.store.scienceFlowResearchPreparations.record(preparation);
  const service = createLocalResearchService({
    settings: settingsFor(target, { maxChildRuns: 5, totalAllowanceSec: 1_000 }),
    store: target.store,
  }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  const group = service.results({ projectId: target.projectId, sessionId: target.sessionId })
    .find((candidate) => candidate.groupId === researchGroupId(operation))!;
  assert.equal(group.parent?.usage.wallClock.preparationSeconds, 12);
  assert.equal(group.parent?.usage.wallClock.chargedSeconds, 42);
  assert.equal(group.parent?.overhead.preparations.attempts, 1);
  assert.equal(group.parent?.overhead.preparations.probeEvaluations, 2);
  assert.equal(group.parent?.overhead.ideaTree.executed, false);
  assert.equal(group.parent?.overhead.evolve.executed, false);
  assert.equal(group.parent?.overhead.preparations.tokens, "not-applicable");
  const overhead = service.overhead({ projectId: target.projectId, sessionId: target.sessionId });
  assert.equal(overhead.preparations.attempts, 1);
  assert.equal(overhead.preparations.succeeded, 1);
  assert.equal(overhead.preparations.probeEvaluations, 2);
  assert.equal(overhead.preparations.knownSeconds, 12);
  assert.equal(overhead.preparations.unattributedAttempts, 0);
  assert.equal(overhead.ideaTree.executed, false);
  assert.equal(overhead.evolve.executed, false);
  assert.equal(overhead.tokens.hardCap, null);
});

test("Agent decision usage is captured per operation and unknown provider usage stays unknown", async (context) => {
  const target = await fixture(context);
  const operation = insert(target, tenantOperation(target, { binding: null }));
  const usage = (overrides: Partial<ModelInvocationUsage>): ModelInvocationUsage => ({
    attemptIndex: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    finishedAt: "2026-11-16T10:00:05.000Z",
    id: randomUUID(),
    inputTokens: 100,
    invocationId: randomUUID(),
    invocationKind: "delegation-track",
    model: "fixture-model",
    modelProfileId: "fixture-profile",
    modelProfileName: "Fixture",
    outputTokens: 50,
    runId: operation.ownerRunId,
    sessionId: target.sessionId,
    startedAt: "2026-11-16T10:00:00.000Z",
    totalTokens: 150,
    usageStatus: "reported",
    ...overrides,
  });
  await target.store.appendModelInvocationUsage(usage({}));
  const service = createLocalResearchService({ settings: settingsFor(target), store: target.store }, {
    now: () => "2026-11-16T10:05:00.000Z",
    readEngineIdentity: async () => ({ dirty: false, revision: ENGINE_REVISION, statusDigest: "s".repeat(64) }),
    readExecutionEnvironment: async () => ({ arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" }),
  });
  await service.get({ operationId: operation.operationId, projectId: target.projectId, sessionId: target.sessionId });
  let group = service.results({ projectId: target.projectId, sessionId: target.sessionId })
    .find((candidate) => candidate.groupId === researchGroupId(operation))!;
  assert.deepEqual(group.parent?.usage.tokens.agentDecision, {
    calls: 1,
    inputTokens: 100,
    outputTokens: 50,
    status: "known",
    unknownUsageCalls: 0,
  });
  await target.store.appendModelInvocationUsage(usage({
    id: randomUUID(),
    inputTokens: null,
    invocationId: randomUUID(),
    outputTokens: null,
    totalTokens: null,
    usageStatus: "provider-not-reported",
  }));
  await service.get({ operationId: operation.operationId, projectId: target.projectId, sessionId: target.sessionId });
  group = service.results({ projectId: target.projectId, sessionId: target.sessionId })
    .find((candidate) => candidate.groupId === researchGroupId(operation))!;
  assert.equal(group.parent?.usage.tokens.agentDecision.status, "partially-known");
  assert.equal(group.parent?.usage.tokens.agentDecision.calls, 2);
  assert.equal(group.parent?.usage.tokens.agentDecision.unknownUsageCalls, 1);
  assert.equal(group.parent?.usage.tokens.agentDecision.inputTokens, 100);
  assert.equal(group.parent?.usage.tokens.agentDecision.outputTokens, 50);
});


test("a missing execution environment is display-only and different environments are separate groups", () => {
  const missing = operation({ executionEnvironment: null });
  const missingGroup = groupFor([missing]);
  assert.equal(missingGroup.comparable, false);
  assert.equal(missingGroup.incomparableReason, "execution-environment-unknown");
  assert.equal(missingGroup.bestValidOperationId, null);

  const first = operation({
    executionEnvironment: { arch: "x86_64", fingerprint: "e".repeat(64), platform: "linux", python: "3.12.12" },
  });
  const second = operation({
    executionEnvironment: { arch: "aarch64", fingerprint: "f".repeat(64), platform: "linux", python: "3.12.12" },
  });
  const groups = deriveResearchResultGroups([first, second], []);
  assert.equal(groups.length, 2, "speed-like metrics must not be ranked across execution environments");
});

test("the real interpreter yields a stable execution environment fingerprint without exposing paths", async () => {
  const first = await readExecutionEnvironment("python3");
  const second = await readExecutionEnvironment("python3");
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint.length, 64);
  assert.ok(first.platform.length > 0);
  assert.ok(first.arch.length > 0);
  assert.match(first.python, /^\d+\.\d+\.\d+$/u);
  assert.ok(!JSON.stringify(first).includes("/"), "no host path is exposed");
});

test("continuation domain distinguishes a new seed, missing provenance and a changed task contract", async () => {
  const { assertScienceFlowContinuation } = await import("./domain/continuation.js");
  const source = operation();
  const versionId = source.delivery.solution?.versionId;
  assert.ok(versionId);
  const input = { binding: preparedBinding(), versionId, operations: [source], hasDeliveryProvenance: true };
  assert.equal(assertScienceFlowContinuation(input), undefined);
  assert.equal(assertScienceFlowContinuation({ ...input, binding: preparedBinding({ contractHash: "b".repeat(64) }) }), "continuation-task-mismatch");
  assert.equal(assertScienceFlowContinuation({ ...input, operations: [], sourceRunId: source.engineRunId }), "continuation-provenance-unknown");
  assert.equal(assertScienceFlowContinuation({ ...input, operations: [], hasDeliveryProvenance: false }), undefined);
});
