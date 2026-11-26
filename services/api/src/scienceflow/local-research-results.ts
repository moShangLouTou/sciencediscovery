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
 * Cross-run results for one scientific contract, and the budget of the research
 * line that produced them.
 *
 * The comparison is deliberately narrow. It never compares two operations whose
 * frozen scientific contract is not identical: a different task version, task
 * package, evaluator identity, engine revision, metric direction or bound input
 * bytes starts a separate group. Within a group it keeps three distinct
 * relations:
 *
 * - `latest` is the most recent run, valid or not;
 * - `best_valid` is the best engine-validated captured result under the frozen
 *   metric direction, with a deterministic tie rule;
 * - `selected_for_next` is an explicit, durable research decision that may
 *   deliberately point at a non-optimal result.
 *
 * A run is valid only when its result was delivered, its captured stage passed
 * validation and the gate, its evaluator reported `ok`, the selected metric is
 * finite and its direction is known. A missing score is never treated as zero,
 * and a worse or invalid run never replaces the best evidence.
 *
 * Metrics here are engine-recorded selection/validation metrics, not independent
 * final evaluations. A difference is descriptive: no repeat count, seed policy
 * or significance test is claimed.
 *
 * Nothing in this module starts an engine run, reads an engine file or copies an
 * artifact. A rebuilt service recomputes the same view from the durable operation
 * rows and the explicit selection row.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { parsePorcelain } from "@sciencediscovery/scienceflow-reader";

import type {
  ScienceFlowLocalResearchOperation,
  ScienceFlowLocalResearchStage,
  ScienceFlowLocalResearchUsage,
} from "./local-research-record.js";
import type { ScienceFlowResearchPreparation } from "./local-research-overhead-repository.js";
import type { ScienceFlowTaskBinding } from "./local-research-task.js";
import {
  projectResearchBudgetLine,
  RESEARCH_BUDGET_LINE_VERSION,
  researchBudgetLineView,
  researchBudgetLineRefusal,
  withResearchBudgetDecision,
  type ResearchBudgetChild,
  type ResearchBudgetDecision,
  type ResearchBudgetDecisionKind,
  type ResearchBudgetLimits,
  type ResearchBudgetLine,
  type ResearchBudgetReservation,
  type ResearchBudgetSettlement,
  type ResearchBudgetStop,
  type ResearchBudgetTokenUsage,
  type ResearchBudgetWallClock,
} from "../research/budget.js";

/** The only selection record version this module writes and reads. */
export const RESEARCH_RESULT_SELECTION_VERSION = 1;
/** The only parent research-line record version. */
export const RESEARCH_PARENT_VERSION = 1;
/** How many decisions a parent record keeps; the newest are retained. */
export const RESEARCH_PARENT_DECISION_LIMIT = 200;

/** One captured result's validity reason; never a numeric penalty. */
export type ResearchResultValidityReason =
  | "contract-incomparable"
  | "delivery-pending"
  | "delivery-failed"
  | "no-candidate"
  | "solution-missing"
  | "metric-missing"
  | "metric-name-mismatch"
  | "direction-unknown"
  | "direction-mismatch"
  | "stage-evidence-missing"
  | "stage-validation-failed"
  | "stage-not-selection-eligible"
  | "stage-gate-rejected"
  | "evaluator-failed"
  | "stage-metric-name-mismatch"
  | "stage-metric-value-mismatch"
  | "stage-digest-missing"
  | "executed-evaluator-identity-missing"
  | "executed-evaluator-mismatch";

export interface ResearchResultSolutionRef {
  readonly artifactId: string;
  readonly versionId: string;
  readonly version: number;
  readonly logicalName: string;
}

/** The frozen identity of one scientific contract. */
export interface ResearchContractIdentity {
  readonly source: "catalog" | "prepared" | "fixed";
  readonly taskId: string;
  readonly taskVersionId: string | null;
  readonly title: string;
  readonly artifactPath: string | null;
  readonly artifactKind: string | null;
  readonly metricName: string | null;
  readonly metricType: string | null;
  readonly lowerIsBetter: boolean | null;
  readonly metricJsonPath: string | null;
  readonly contractHash: string | null;
  /** The execution environment that would actually import the evaluator. */
  readonly environment: {
    readonly engineRevision: string | null;
    /** Tracked or runnable-untracked changes in the checkout. */
    readonly worktreeDirty: boolean | null;
    /** Digest of the exact checkout status, so different dirty states differ. */
    readonly statusDigest: string | null;
    /** Stable host/interpreter/dependency-environment fingerprint. */
    readonly executionFingerprint: string | null;
    readonly executionPlatform: string | null;
    readonly executionArch: string | null;
    readonly executionPython: string | null;
  };
  readonly evaluator:
    | {
        readonly kind: "task-package";
        readonly entrypoint: string;
        readonly entrypointSha256: string | null;
        readonly packageSha256: string | null;
      }
    | { readonly kind: "generated-command"; readonly sha256: string; readonly versionId: string }
    | { readonly kind: "unknown" };
  readonly inputs: readonly { readonly logicalName: string; readonly sha256: string }[];
}

export interface ResearchResultEntry {
  readonly operationId: string;
  readonly engineRunId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly intent: string;
  readonly state: ScienceFlowLocalResearchOperation["state"];
  readonly validity: "valid" | "invalid";
  readonly validityReasons: readonly ResearchResultValidityReason[];
  /**
   * Whether this result may replace `best_valid`. A stopped, failed or
   * unknown run may still hold a valid captured candidate for viewing and an
   * explicit selection, but it is not promotion-eligible evidence.
   */
  readonly promotable: boolean;
  readonly promotionBlockedReason?: "result-invalid" | "run-not-completed" | "run-stopped" | "run-failed" | "run-unknown";
  readonly metric: {
    readonly name: string;
    readonly value: number;
    readonly lowerIsBetter: boolean;
  } | null;
  readonly solution: ResearchResultSolutionRef | null;
  readonly stage: {
    readonly stageId: string;
    readonly artifactSha256: string;
    readonly validationOk: boolean;
    readonly gateAccepted: boolean;
    readonly evaluatorStatus: string;
  } | null;
  readonly resources: {
    readonly elapsedSec: number | null;
    readonly launchRecorded: boolean;
    readonly usage: ScienceFlowLocalResearchUsage | null;
  };
  /** The structured proposal this round was accepted on, when one exists. */
  readonly experiment?: {
    readonly fingerprint: string;
    readonly researchQuestion: string;
    readonly methodChange: string;
    readonly expectedObservation: string;
    readonly evaluationMethod: string;
    readonly stopCondition: string;
    readonly subBudgetSeconds: number | null;
    readonly evidence: readonly {
      readonly kind: "artifact-version" | "operation-result";
      readonly versionId?: string;
      readonly operationId?: string;
      readonly fact: string;
    }[];
    readonly repeat: { readonly repetitions: number; readonly purpose: string; readonly randomness: string } | null;
  };
}

export interface ResearchSelectionView {
  readonly operationId: string;
  readonly solution: ResearchResultSolutionRef;
  readonly metric: { readonly name: string; readonly value: number; readonly lowerIsBetter: boolean };
  readonly selectedAt: string;
  readonly selectedBy: "tool" | "web";
  readonly reason: string;
  readonly wasBestValid: boolean;
  /** Recomputed now: the selected operation may have become invalid or displaced. */
  readonly isBestValid: boolean;
  /** The selected result is still a valid delivered candidate in this group. */
  readonly valid: boolean;
}

export interface ResearchResultDelta {
  readonly bestOperationId: string;
  readonly latestOperationId: string;
  readonly metricName: string;
  readonly lowerIsBetter: boolean;
  readonly bestValue: number;
  readonly latestValue: number;
  /** Positive means the latest run is better than the best run. */
  readonly improvement: number;
  readonly relativeImprovement: number | null;
  readonly direction: "latest-better" | "latest-worse" | "equal";
  /** Descriptive only; no repeat count or significance claim is recorded. */
  readonly significance: "not-evaluated";
}

export interface ScienceFlowResearchResultGroupView {
  readonly groupId: string;
  readonly contract: ResearchContractIdentity;
  readonly contractFingerprint: string;
  readonly comparable: boolean;
  readonly incomparableReason?: string;
  readonly rankable: boolean;
  readonly rankingBlockedReason?: string;
  readonly results: readonly ResearchResultEntry[];
  readonly latestOperationId: string | null;
  readonly bestValidOperationId: string | null;
  readonly selection: ResearchSelectionView | null;
  readonly selectionState: "none" | "best" | "non-optimal" | "stale";
  readonly comparison: {
    readonly selectionRule: string;
    readonly note: string;
    readonly latestVsBest: ResearchResultDelta | null;
  };
  readonly evaluationBasis: "engine-recorded-captured-stage";
  /** Always null for this delivery: no independent final evaluation is recorded. */
  readonly independentFinalEvaluation: null;
  readonly replicatePolicy: {
    readonly declared: false;
    readonly note: string;
  };
  /** The research line's budget projection, when the caller attached one. */
  readonly parent?: ResearchParentView;
}

/** A relation attached to one operation's public view. */
export interface ResearchResultRelation {
  readonly groupId: string;
  readonly contractTaskId: string;
  readonly contractTitle: string;
  readonly comparable: boolean;
  readonly rankable: boolean;
  readonly validity: "valid" | "invalid";
  readonly validityReasons: readonly ResearchResultValidityReason[];
  readonly promotable: boolean;
  readonly isLatest: boolean;
  readonly isBestValid: boolean;
  readonly isSelectedForNext: boolean;
  readonly bestValid: {
    readonly operationId: string;
    readonly metric: { readonly name: string; readonly value: number; readonly lowerIsBetter: boolean };
    readonly solution: ResearchResultSolutionRef | null;
  } | null;
  readonly selectedForNext: ResearchSelectionView | null;
  readonly comparisonNote: string;
}

/** The explicit `selected_for_next` decision for one group. */
export interface ScienceFlowResearchResultSelection {
  readonly schemaVersion: typeof RESEARCH_RESULT_SELECTION_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly groupId: string;
  readonly operationId: string;
  readonly artifactId: string;
  readonly versionId: string;
  readonly version: number;
  readonly logicalName: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly lowerIsBetter: boolean;
  readonly selectedAt: string;
  readonly selectedBy: "tool" | "web";
  readonly reason: string;
  readonly bestValidOperationId: string | null;
  readonly wasBestValid: boolean;
}

/** The frozen total budget of one research line. */
export type ResearchParentLimits = ResearchBudgetLimits;

export type ResearchParentReservation = ResearchBudgetReservation;

export type ResearchParentWallClock = ResearchBudgetWallClock;

export type ResearchParentTokenUsage = ResearchBudgetTokenUsage;

export type ResearchParentSettlement = ResearchBudgetSettlement;

export type ResearchParentDecisionKind = ResearchBudgetDecisionKind;

export type ResearchParentDecision = ResearchBudgetDecision;

/**
 * The ScienceFlow research line: the shared budget ledger plus the frozen
 * scientific contract that gives this line its product identity. The ledger
 * mechanism itself lives in `research/budget.ts`.
 */
export interface ScienceFlowResearchParent
  extends Omit<ResearchBudgetLine, "lineId" | "lineKey" | "schemaVersion"> {
  readonly schemaVersion: typeof RESEARCH_PARENT_VERSION;
  /** The stable product parent id, derived from the comparison group. */
  readonly parentId: string;
  readonly groupId: string;
  readonly contract: ResearchContractIdentity;
  readonly stop: ResearchBudgetStop;
}

/** The budget view an Agent or the Web panel reads. */
export interface ResearchParentView {
  readonly parentId: string;
  readonly groupId: string;
  readonly taskId: string;
  readonly title: string;
  readonly metricName: string | null;
  readonly lowerIsBetter: boolean | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: ResearchParentLimits | null;
  readonly enforcement: {
    readonly runCount: boolean;
    readonly wallClock: boolean;
    /** This path cannot observe a total token cap; it is recorded, never promised. */
    readonly tokenCap: false;
  };
  readonly runs: {
    readonly started: number;
    readonly settled: number;
    readonly active: number;
  };
  readonly usage: {
    readonly wallClock: {
      readonly knownSeconds: number;
      readonly preparationSeconds: number;
      readonly chargedSeconds: number;
      readonly reservedSeconds: number;
      readonly unknownSettlements: number;
      readonly unknownPreparations: number;
      readonly notLaunched: number;
      readonly remainingSeconds: number | null;
    };
    readonly tokens: {
      readonly status: "known" | "partially-known" | "unknown" | "not-launched";
      readonly calls: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly unknownUsageCalls: number;
      readonly hardCap: null;
      readonly note: string;
      /** The Agent's own conversation-run usage linked to this line. */
      readonly agentDecision: {
        readonly status: "known" | "partially-known" | "unknown" | "not-recorded";
        readonly calls: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly unknownUsageCalls: number;
      };
      readonly coverage: "sf-worker-and-recorded-agent-runs";
    };
  };
  readonly overhead: {
    readonly preparations: {
      readonly attempts: number;
      readonly succeeded: number;
      readonly failed: number;
      readonly knownSeconds: number;
      readonly unknown: number;
      readonly probeEvaluations: number;
      readonly unknownProbes: number;
      readonly tokens: "not-applicable";
    };
    readonly ideaTree: { readonly executed: false; readonly reason: string };
    readonly evolve: { readonly executed: false; readonly reason: string };
  };
  readonly activeChild: {
    readonly operationId: string;
    readonly state: ScienceFlowLocalResearchOperation["state"];
    readonly reservedSec: number;
  } | null;
  readonly deadlinePassed: boolean;
  readonly stop: ScienceFlowResearchParent["stop"];
  readonly decisions: readonly ResearchParentDecision[];
}

/** A selection refusal with a stable reason and a path-free message. */
export class ResearchResultRefusal extends Error {
  readonly reason:
    | "group-not-found"
    | "operation-not-found"
    | "contract-not-comparable"
    | "metric-direction-unknown"
    | "result-invalid";
  constructor(reason: ResearchResultRefusal["reason"], message: string) {
    super(message);
    this.name = "ResearchResultRefusal";
    this.reason = reason;
  }
}

export type ResearchLineRefusalReason =
  | "research-line-busy"
  | "research-line-stopped"
  | "parent-budget-exhausted"
  | "parent-deadline-exceeded";

export interface ResearchLineRefusal {
  readonly reason: ResearchLineRefusalReason;
  readonly message: string;
}

const FINITE_DIRECTION = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * The frozen identity a comparison group is keyed by. A catalog task uses its
 * package/evaluator entrypoint and the engine checkout revision the run recorded;
 * a prepared task uses its contract digest and the actual evaluator bytes. A
 * legacy fixed-profile run has no task binding and is therefore never ranked.
 */
export interface EngineSourceIdentity {
  readonly revision: string;
  readonly dirty: boolean;
  /** Digest of the exact `git status --porcelain` bytes. */
  readonly statusDigest: string;
}

/** The actual host/interpreter environment a run executes in; no host paths. */
export interface ExecutionEnvironmentIdentity {
  readonly fingerprint: string;
  readonly platform: string;
  readonly arch: string;
  readonly python: string;
}

export function researchContractIdentity(operation: ScienceFlowLocalResearchOperation): ResearchContractIdentity {
  return researchContractIdentityFrom(operation.taskBinding, operation.task, {
    executionEnvironment: operation.launch.executionEnvironment,
    revision: operation.launch.engineRevision,
    statusDigest: operation.launch.engineStatusDigest,
    worktreeDirty: operation.launch.engineWorktreeDirty,
  });
}

/** The same identity for a contract the caller is about to freeze. */
export function researchContractIdentityFrom(
  binding: ScienceFlowTaskBinding | undefined,
  task: string,
  environment?: {
    readonly revision?: string;
    readonly worktreeDirty?: boolean;
    readonly statusDigest?: string;
    readonly executionEnvironment?: ExecutionEnvironmentIdentity;
  },
): ResearchContractIdentity {
  const environmentIdentity = {
    engineRevision: environment?.revision ?? null,
    executionArch: environment?.executionEnvironment?.arch ?? null,
    executionFingerprint: environment?.executionEnvironment?.fingerprint ?? null,
    executionPlatform: environment?.executionEnvironment?.platform ?? null,
    executionPython: environment?.executionEnvironment?.python ?? null,
    statusDigest: environment?.statusDigest ?? null,
    worktreeDirty: environment?.worktreeDirty ?? null,
  };
  if (!binding) {
    return {
      artifactKind: null,
      artifactPath: null,
      contractHash: null,
      environment: environmentIdentity,
      evaluator: { kind: "unknown" },
      inputs: [],
      lowerIsBetter: null,
      metricJsonPath: null,
      metricName: null,
      metricType: null,
      source: "fixed",
      taskId: task,
      taskVersionId: null,
      title: task,
    };
  }
  return {
    artifactKind: binding.artifactKind,
    artifactPath: binding.artifactPath,
    contractHash: binding.contractHash ?? null,
    environment: environmentIdentity,
    evaluator: identityEvaluator(binding),
    inputs: binding.inputs.map((input) => ({ logicalName: input.logicalName, sha256: input.sha256 })),
    lowerIsBetter: binding.lowerIsBetter,
    metricJsonPath: binding.metricJsonPath ?? null,
    metricName: binding.metricName,
    metricType: binding.metricType,
    source: binding.source,
    taskId: binding.taskId,
    taskVersionId: binding.taskVersionId ?? null,
    title: binding.title,
  };
}

function identityEvaluator(binding: ScienceFlowTaskBinding): ResearchContractIdentity["evaluator"] {
  if (binding.evaluator.kind === "generated-command") {
    return { kind: "generated-command", sha256: binding.evaluator.sha256, versionId: binding.evaluator.versionId };
  }
  return {
    entrypoint: binding.evaluator.entrypoint,
    entrypointSha256: binding.evaluator.entrypointSha256 ?? null,
    kind: "task-package",
    packageSha256: binding.evaluator.packageSha256 ?? null,
  };
}

/** A stable digest of the frozen contract; two different contracts never mix. */
export function contractFingerprint(contract: ResearchContractIdentity): string {
  return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

export function researchGroupId(operation: ScienceFlowLocalResearchOperation): string {
  return contractGroupId(researchContractIdentity(operation));
}

export function contractGroupId(contract: ResearchContractIdentity): string {
  return `sfc-${contractFingerprint(contract).slice(0, 24)}`;
}

/** Why a group may be shown but not ranked. `undefined` means fully comparable. */
export function contractComparisonBlocker(contract: ResearchContractIdentity): string | undefined {
  if (contract.source === "fixed") return "legacy-fixed-profile";
  if (contract.environment.engineRevision === null) return "engine-revision-unknown";
  if (contract.environment.worktreeDirty === null) return "engine-worktree-state-unknown";
  if (contract.environment.statusDigest === null) return "engine-status-identity-missing";
  if (contract.environment.executionFingerprint === null) return "execution-environment-unknown";
  if (contract.source === "catalog") {
    if (!contract.taskId || contract.evaluator.kind !== "task-package" || !contract.evaluator.entrypoint) {
      return "evaluator-identity-incomplete";
    }
    if (contract.evaluator.entrypointSha256 === null || contract.evaluator.packageSha256 === null) {
      return "evaluator-source-identity-missing";
    }
    return undefined;
  }
  if (contract.source === "prepared") {
    if (!contract.contractHash || contract.evaluator.kind !== "generated-command") {
      return "evaluator-identity-incomplete";
    }
    return undefined;
  }
  return "contract-identity-incomplete";
}

/** Build every comparison group of one Session, in first-run order. */
export function deriveResearchResultGroups(
  operations: readonly ScienceFlowLocalResearchOperation[],
  selections: readonly ScienceFlowResearchResultSelection[],
): readonly ScienceFlowResearchResultGroupView[] {
  const groups = new Map<string, ScienceFlowLocalResearchOperation[]>();
  for (const operation of operations) {
    const groupId = researchGroupId(operation);
    const list = groups.get(groupId);
    if (list) list.push(operation);
    else groups.set(groupId, [operation]);
  }
  return [...groups.entries()]
    .map(([groupId, rows]) => buildGroup(groupId, rows, selections.find((row) => row.groupId === groupId)))
    .sort((left, right) => {
      const leftFirst = left.results[0]?.createdAt ?? "";
      const rightFirst = right.results[0]?.createdAt ?? "";
      return leftFirst.localeCompare(rightFirst) || left.groupId.localeCompare(right.groupId);
    });
}

function buildGroup(
  groupId: string,
  rows: readonly ScienceFlowLocalResearchOperation[],
  selection: ScienceFlowResearchResultSelection | undefined,
): ScienceFlowResearchResultGroupView {
  const ordered = [...rows].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId),
  );
  const contract = researchContractIdentity(ordered[0]!);
  const fingerprint = contractFingerprint(contract);
  const blocker = contractComparisonBlocker(contract);
  const entries = ordered.map((operation) => resultEntry(operation));
  const latestOperationId = ordered.at(-1)?.operationId ?? null;
  const direction = contract.lowerIsBetter;
  const rankable = blocker === undefined && FINITE_DIRECTION(direction);
  const best = rankable
    ? entries.filter((entry) => entry.promotable).reduce<ResearchResultEntry | undefined>(
        (winner, entry) => (winner === undefined || betterResult(entry, winner, direction as boolean) ? entry : winner),
        undefined,
      )
    : undefined;
  const bestValidOperationId = best?.operationId ?? null;
  const selectedEntry = selection ? entries.find((entry) => entry.operationId === selection.operationId) : undefined;
  const selectionView = selection && selectedEntry
    ? {
        isBestValid: bestValidOperationId === selection.operationId,
        metric: selectedEntry.metric ?? {
          lowerIsBetter: selection.lowerIsBetter,
          name: selection.metricName,
          value: selection.metricValue,
        },
        operationId: selection.operationId,
        reason: selection.reason,
        selectedAt: selection.selectedAt,
        selectedBy: selection.selectedBy,
        solution: selectedEntry.solution ?? {
          artifactId: selection.artifactId,
          logicalName: selection.logicalName,
          version: selection.version,
          versionId: selection.versionId,
        },
        valid: selectedEntry.validity === "valid",
        wasBestValid: selection.wasBestValid,
      }
    : null;
  const selectionState: ScienceFlowResearchResultGroupView["selectionState"] = selection === undefined
    ? "none"
    : selectionView === null || !selectionView.valid
      ? "stale"
      : bestValidOperationId === selection.operationId
        ? "best"
        : "non-optimal";
  return {
    bestValidOperationId,
    comparable: blocker === undefined,
    comparison: {
      latestVsBest: latestDelta(entries, latestOperationId, best),
      note: "Descriptive only: the recorded value is the engine's captured-stage validation metric, not an independent final evaluation. No repeat count, seed policy or significance test is recorded.",
      selectionRule: "best metric under the frozen direction; equal values keep the earliest run",
    },
    contract,
    contractFingerprint: fingerprint,
    evaluationBasis: "engine-recorded-captured-stage",
    groupId,
    independentFinalEvaluation: null,
    incomparableReason: blocker,
    latestOperationId,
    rankable,
    rankingBlockedReason: blocker ?? (rankable ? undefined : "metric-direction-unknown"),
    replicatePolicy: {
      declared: false,
      note: "This record does not declare repeated measurements or a pre-registered selection rule beyond the frozen metric direction.",
    },
    results: entries,
    selection: selectionView,
    selectionState,
  };
}

function resultEntry(operation: ScienceFlowLocalResearchOperation): ResearchResultEntry {
  const binding = operation.taskBinding;
  const delivery = operation.delivery;
  const metricName = delivery.metricName ?? binding?.metricName;
  const metricValue = delivery.metricValue;
  const lowerIsBetter = delivery.lowerIsBetter ?? binding?.lowerIsBetter ?? null;
  const solution = delivery.state === "delivered" && delivery.solution
    ? {
        artifactId: delivery.solution.artifactId,
        logicalName: delivery.solution.logicalName,
        version: delivery.solution.version,
        versionId: delivery.solution.versionId,
      }
    : null;
  const stage = delivery.selectedStageId
    ? operation.progress.stages.find((row) => row.stageId === delivery.selectedStageId)
    : undefined;
  const reasons: ResearchResultValidityReason[] = [];
  if (contractComparisonBlocker(researchContractIdentity(operation)) !== undefined) {
    reasons.push("contract-incomparable");
  }
  if (delivery.state === "pending") reasons.push("delivery-pending");
  else if (delivery.state === "failed") reasons.push("delivery-failed");
  else if (delivery.state === "no-candidate") reasons.push("no-candidate");
  if (!solution) reasons.push("solution-missing");
  if (metricName === undefined || metricValue === undefined || !Number.isFinite(metricValue)) {
    reasons.push("metric-missing");
  }
  // The delivered metric must be the one the frozen contract declared, not
  // merely agree with the stage row. A re-labelled metric is a different
  // scientific claim even when its number looks better.
  if (binding !== undefined && metricName !== undefined && metricName !== binding.metricName) {
    reasons.push("metric-name-mismatch");
  }
  if (typeof lowerIsBetter !== "boolean") reasons.push("direction-unknown");
  else if (binding?.lowerIsBetter !== null && binding?.lowerIsBetter !== undefined
    && binding.lowerIsBetter !== lowerIsBetter) {
    reasons.push("direction-mismatch");
  }
  if (binding?.evaluator.kind === "task-package") {
    const declared = binding.evaluator;
    const executed = operation.engine.evaluator;
    if (declared.entrypointSha256 === undefined || declared.packageSha256 === undefined
      || executed?.entrypointSha256 === undefined || executed?.packageSha256 === undefined) {
      reasons.push("executed-evaluator-identity-missing");
    } else if (executed.entrypointSha256 !== declared.entrypointSha256
      || executed.packageSha256 !== declared.packageSha256) {
      reasons.push("executed-evaluator-mismatch");
    }
  }
  if (!stage) reasons.push("stage-evidence-missing");
  else {
    if (!stage.validationOk) reasons.push("stage-validation-failed");
    if (stage.selectionEligible === false) reasons.push("stage-not-selection-eligible");
    if (!stage.gateAccepted) reasons.push("stage-gate-rejected");
    if (stage.evaluatorStatus !== "ok") reasons.push("evaluator-failed");
    if (binding?.metricName !== undefined && stage.metricName !== binding.metricName) reasons.push("stage-metric-name-mismatch");
    else if (metricName !== undefined && stage.metricName !== metricName) reasons.push("stage-metric-name-mismatch");
    if (metricValue !== undefined && !sameMetricValue(stage.metricValue, metricValue)) reasons.push("stage-metric-value-mismatch");
    if (stage.artifactSha256 === null) reasons.push("stage-digest-missing");
  }
  const metric = metricName !== undefined && metricValue !== undefined && Number.isFinite(metricValue)
    && typeof lowerIsBetter === "boolean"
    ? { lowerIsBetter, name: metricName, value: metricValue }
    : null;
  const promotionBlockedReason: ResearchResultEntry["promotionBlockedReason"] =
    reasons.length > 0
      ? "result-invalid"
      : operation.stop.requestedAt !== undefined
        ? "run-stopped"
        : operation.state === "stopped"
          ? "run-stopped"
          : operation.state === "failed"
            ? "run-failed"
            : operation.state === "unknown"
              ? "run-unknown"
              : operation.state !== "completed"
                ? "run-not-completed"
                : undefined;
  const experiment = operation.proposal
    ? {
        evaluationMethod: operation.proposal.evaluationMethod,
        evidence: operation.proposal.evidence.map((entry) => ({
          fact: entry.fact,
          ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
          kind: entry.kind,
          ...(entry.versionId === undefined ? {} : { versionId: entry.versionId }),
        })),
        expectedObservation: operation.proposal.expectedObservation,
        fingerprint: operation.proposal.fingerprint,
        methodChange: operation.proposal.methodChange,
        repeat: operation.proposal.repeat === null
          ? null
          : {
              purpose: operation.proposal.repeat.purpose,
              randomness: operation.proposal.repeat.randomness,
              repetitions: operation.proposal.repeat.repetitions,
            },
        researchQuestion: operation.proposal.researchQuestion,
        stopCondition: operation.proposal.stopCondition,
        subBudgetSeconds: operation.proposal.subBudgetSeconds,
      }
    : undefined;
  return {
    createdAt: operation.createdAt,
    engineRunId: operation.engineRunId,
    intent: operation.intent,
    metric,
    operationId: operation.operationId,
    resources: {
      elapsedSec: typeof operation.engine.elapsedSec === "number" && Number.isFinite(operation.engine.elapsedSec)
        ? operation.engine.elapsedSec
        : null,
      launchRecorded: operation.launch.launchedAt !== undefined || operation.engine.status !== undefined,
      usage: operation.progress.usage,
    },
    solution,
    stage: stage
      ? {
          artifactSha256: stage.artifactSha256 ?? "",
          evaluatorStatus: stage.evaluatorStatus,
          gateAccepted: stage.gateAccepted,
          stageId: stage.stageId,
          validationOk: stage.validationOk,
        }
      : null,
    state: operation.state,
    updatedAt: operation.updatedAt,
    promotable: promotionBlockedReason === undefined,
    ...(promotionBlockedReason === undefined ? {} : { promotionBlockedReason }),
    validity: reasons.length === 0 ? "valid" : "invalid",
    validityReasons: reasons,
  };
}

/** A serialization round trip must not make a consistent result invalid. */
function sameMetricValue(left: number, right: number): boolean {
  if (left === right) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= 1e-12 * scale;
}

function betterResult(candidate: ResearchResultEntry, current: ResearchResultEntry, lowerIsBetter: boolean): boolean {
  const left = candidate.metric?.value;
  const right = current.metric?.value;
  if (left === undefined || right === undefined) return false;
  if (left !== right) return lowerIsBetter ? left < right : left > right;
  // Equal scores keep the earlier run, so a duplicate delivery cannot rename
  // which evidence is "best".
  return candidate.createdAt < current.createdAt
    || (candidate.createdAt === current.createdAt && candidate.operationId < current.operationId);
}

function latestDelta(
  entries: readonly ResearchResultEntry[],
  latestOperationId: string | null,
  best: ResearchResultEntry | undefined,
): ResearchResultDelta | null {
  if (!latestOperationId || !best || !best.metric) return null;
  const latest = entries.find((entry) => entry.operationId === latestOperationId);
  if (!latest || !latest.promotable || !latest.metric) return null;
  const lowerIsBetter = best.metric.lowerIsBetter;
  // Positive improvement means "the latest run is better than the best run".
  const improvement = lowerIsBetter
    ? best.metric.value - latest.metric.value
    : latest.metric.value - best.metric.value;
  return {
    bestOperationId: best.operationId,
    bestValue: best.metric.value,
    direction: improvement > 0 ? "latest-better" : improvement < 0 ? "latest-worse" : "equal",
    improvement,
    latestOperationId,
    latestValue: latest.metric.value,
    lowerIsBetter,
    metricName: best.metric.name,
    relativeImprovement: best.metric.value === 0 ? null : Math.abs(improvement / best.metric.value),
    significance: "not-evaluated",
  };
}

/** Attach the group relations to every operation view. */
export function researchResultRelations(
  groups: readonly ScienceFlowResearchResultGroupView[],
  operations: readonly ScienceFlowLocalResearchOperation[],
): ReadonlyMap<string, ResearchResultRelation> {
  const operationGroup = new Map<string, ScienceFlowResearchResultGroupView>();
  for (const group of groups) {
    for (const result of group.results) operationGroup.set(result.operationId, group);
  }
  const relations = new Map<string, ResearchResultRelation>();
  for (const operation of operations) {
    const group = operationGroup.get(operation.operationId);
    const entry = group?.results.find((result) => result.operationId === operation.operationId);
    if (!group || !entry) continue;
    const best = group.bestValidOperationId === null
      ? null
      : group.results.find((result) => result.operationId === group.bestValidOperationId) ?? null;
    relations.set(operation.operationId, {
      bestValid: best && best.metric
        ? { metric: best.metric, operationId: best.operationId, solution: best.solution }
        : null,
      comparable: group.comparable,
      comparisonNote: comparisonNote(group, entry),
      contractTaskId: group.contract.taskId,
      contractTitle: group.contract.title,
      groupId: group.groupId,
      isBestValid: group.bestValidOperationId === operation.operationId,
      isLatest: group.latestOperationId === operation.operationId,
      isSelectedForNext: group.selection?.operationId === operation.operationId,
      promotable: entry.promotable,
      rankable: group.rankable,
      selectedForNext: group.selection,
      validity: entry.validity,
      validityReasons: entry.validityReasons,
    });
  }
  return relations;
}

function comparisonNote(group: ScienceFlowResearchResultGroupView, entry: ResearchResultEntry): string {
  if (!group.rankable) {
    return `These runs are not ranked: ${group.rankingBlockedReason ?? "the metric direction is unknown"}.`;
  }
  if (entry.validity !== "valid") {
    return `This run is not a valid comparable result (${entry.validityReasons.join(", ")}); it cannot replace the best valid evidence.`;
  }
  if (!entry.promotable) {
    return `This run holds valid captured evidence but is not eligible to replace best_valid (${entry.promotionBlockedReason ?? "run not completed"}). It remains viewable and may be selected explicitly.`;
  }
  if (group.bestValidOperationId === entry.operationId) {
    return "This is the best valid result under the frozen metric direction. Any later worse result does not replace it.";
  }
  const best = group.results.find((result) => result.operationId === group.bestValidOperationId);
  if (!best?.metric || !entry.metric) return "The best valid result is kept separately from this run.";
  const lower = entry.metric.lowerIsBetter;
  const improvement = lower
    ? best.metric.value - entry.metric.value
    : entry.metric.value - best.metric.value;
  return improvement < 0
    ? `This run is worse than the best valid result by ${formatNumber(Math.abs(improvement))} (descriptive, not a significance claim).`
    : `This run matches or exceeds the best valid result; the comparison rule keeps one deterministic best.`;
}

/** Record an explicit `selected_for_next`; a non-optimal choice is allowed. */
export function createResearchSelection(
  groups: readonly ScienceFlowResearchResultGroupView[],
  input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly reason: string;
    readonly selectedBy: "tool" | "web";
    readonly now: string;
  },
): { readonly selection: ScienceFlowResearchResultSelection; readonly group: ScienceFlowResearchResultGroupView } {
  const group = groups.find((candidate) =>
    candidate.results.some((result) => result.operationId === input.operationId));
  if (!group) {
    throw new ResearchResultRefusal("operation-not-found", "This Session has no result with that operation id");
  }
  if (!group.comparable) {
    throw new ResearchResultRefusal(
      "contract-not-comparable",
      `This result belongs to a contract that cannot be compared: ${group.incomparableReason ?? "unknown"}`,
    );
  }
  if (!group.rankable) {
    throw new ResearchResultRefusal(
      "metric-direction-unknown",
      "This contract has no recorded metric direction, so a starting point cannot be selected",
    );
  }
  const entry = group.results.find((result) => result.operationId === input.operationId)!;
  if (entry.validity !== "valid" || !entry.metric || !entry.solution) {
    throw new ResearchResultRefusal(
      "result-invalid",
      `Only a valid delivered result can be selected for the next run (${entry.validityReasons.join(", ")})`,
    );
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 1_000 || reason.includes("\u0000")) {
    throw new ResearchResultRefusal("result-invalid", "The selection reason must be 1-1000 characters without NUL bytes");
  }
  return {
    group,
    selection: {
      artifactId: entry.solution.artifactId,
      bestValidOperationId: group.bestValidOperationId,
      groupId: group.groupId,
      logicalName: entry.solution.logicalName,
      lowerIsBetter: entry.metric.lowerIsBetter,
      metricName: entry.metric.name,
      metricValue: entry.metric.value,
      operationId: entry.operationId,
      projectId: input.projectId,
      reason,
      schemaVersion: RESEARCH_RESULT_SELECTION_VERSION,
      selectedAt: input.now,
      selectedBy: input.selectedBy,
      sessionId: input.sessionId,
      version: entry.solution.version,
      versionId: entry.solution.versionId,
      wasBestValid: group.bestValidOperationId === entry.operationId,
    },
  };
}

/**
 * Project the research line's budget from its durable operations. This is a pure
 * function: the caller decides whether to persist the result. Settlements are
 * derived from the operation records, so a rebuilt service sees the same charge.
 *
 * A launched run with no observable elapsed time is charged the reservation, not
 * zero; a launched run with no usage record keeps its token use `unknown`.
 */
/** The neutral budget facts one stored operation contributes to its line. */
export function researchBudgetChild(operation: ScienceFlowLocalResearchOperation): ResearchBudgetChild {
  return {
    createdAt: operation.createdAt,
    ...(operation.engine.elapsedSec === undefined ? {} : { elapsedSec: operation.engine.elapsedSec }),
    launched: operation.launch.launchedAt !== undefined || operation.engine.status !== undefined,
    operationId: operation.operationId,
    reservedSec: operation.launch.grant.totalAllowanceSec,
    state: operation.state,
    updatedAt: operation.updatedAt,
    usage: operation.progress.usage ?? null,
  };
}

/** The shared ledger projection of a stored ScienceFlow parent. */
export function researchParentBudgetLine(parent: ScienceFlowResearchParent): ResearchBudgetLine {
  return {
    createdAt: parent.createdAt,
    decisions: parent.decisions,
    identity: parent.identity,
    limits: parent.limits,
    lineId: parent.parentId,
    lineKey: parent.groupId,
    reservations: parent.reservations,
    schemaVersion: RESEARCH_BUDGET_LINE_VERSION,
    settlements: parent.settlements,
    stop: parent.stop,
    updatedAt: parent.updatedAt,
  };
}

/** Attach the scientific contract to one shared ledger projection. */
export function researchParentFromBudgetLine(
  line: ResearchBudgetLine,
  contract: ResearchContractIdentity,
  groupId: string,
): ScienceFlowResearchParent {
  return {
    contract,
    createdAt: line.createdAt,
    decisions: line.decisions,
    groupId,
    identity: line.identity,
    limits: line.limits,
    parentId: line.lineId,
    reservations: line.reservations,
    schemaVersion: RESEARCH_PARENT_VERSION,
    settlements: line.settlements,
    stop: line.stop,
    updatedAt: line.updatedAt,
  };
}

/**
 * Project the line from its stored children. The deadline, run limit,
 * reservations and terminal settlements are the shared budget mechanism; this
 * function only maps ScienceFlow operations to neutral child facts and keeps
 * the frozen contract that keys the line.
 */
export function projectResearchParent(input: {
  readonly existing: ScienceFlowResearchParent | undefined;
  readonly operations: readonly ScienceFlowLocalResearchOperation[];
  readonly groupId: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly contract: ResearchContractIdentity;
  readonly limits: { readonly maxChildRuns: number; readonly totalAllowanceSec: number } | undefined;
  readonly now: string;
}): ScienceFlowResearchParent {
  const parentId = input.existing?.parentId ?? `sf-parent-${input.groupId.replace(/^sfc-/u, "")}`;
  const line = projectResearchBudgetLine({
    children: input.operations.map(researchBudgetChild),
    existing: input.existing === undefined ? undefined : researchParentBudgetLine(input.existing),
    identity: input.identity,
    limits: input.limits,
    lineId: parentId,
    lineKey: input.groupId,
    now: input.now,
  });
  return researchParentFromBudgetLine(
    line,
    input.existing?.contract ?? input.contract,
    input.groupId,
  );
}

/** Preparation records attributable to one frozen scientific contract. */
function attributablePreparations(
  contract: ResearchContractIdentity,
  preparations: readonly ScienceFlowResearchPreparation[],
): readonly ScienceFlowResearchPreparation[] {
  // Preparation/probe cost belongs to the contract whose task version it
  // published. A failed attempt with no version stays in the Session overhead
  // view instead of being silently dropped.
  if (contract.source !== "prepared") return [];
  return preparations.filter((preparation) => preparation.taskVersionId !== null
    ? preparation.taskVersionId === contract.taskVersionId
    : preparation.taskId !== null && preparation.taskId === contract.taskId);
}

/** The budget/usage view for one research line. */
export function researchParentView(
  parent: ScienceFlowResearchParent,
  operations: readonly ScienceFlowLocalResearchOperation[],
  now: string,
  preparations: readonly ScienceFlowResearchPreparation[] = [],
  agentUsage: readonly NonNullable<ScienceFlowLocalResearchOperation["agentUsage"]>[] = [],
): ResearchParentView {
  const attributable = attributablePreparations(parent.contract, preparations);
  const preparationSeconds = attributable.reduce(
    (total, preparation) => total + (preparation.wallClock.status === "known" ? preparation.wallClock.seconds : 0),
    0,
  );
  const unknownPreparations = attributable.filter(
    (preparation) => preparation.wallClock.status === "unknown",
  ).length;
  const probeEvaluations = attributable.reduce(
    (total, preparation) => total + (preparation.probe.status === "known" ? preparation.probe.evaluations : 0),
    0,
  );
  const unknownProbes = attributable.filter(
    (preparation) => preparation.probe.status === "unknown",
  ).length;
  const core = researchBudgetLineView(
    researchParentBudgetLine(parent),
    operations.map(researchBudgetChild),
    now,
    { extraChargedSeconds: preparationSeconds },
  );
  const agentRows = agentUsage.filter((usage) => usage.status !== "not-recorded");
  const agentCalls = agentRows.reduce((total, usage) => total + usage.calls, 0);
  const agentUnknownCalls = agentRows.reduce((total, usage) => total + usage.unknownUsageCalls, 0);
  const agentStatus: ResearchParentView["usage"]["tokens"]["agentDecision"]["status"] =
    agentRows.length === 0
      ? "not-recorded"
      : agentUnknownCalls >= agentCalls
        ? "unknown"
        : agentUnknownCalls > 0
          ? "partially-known"
          : "known";
  return {
    activeChild: core.activeChild,
    createdAt: core.createdAt,
    deadlinePassed: core.deadlinePassed,
    decisions: core.decisions,
    enforcement: core.enforcement,
    groupId: parent.groupId,
    limits: core.limits,
    lowerIsBetter: parent.contract.lowerIsBetter,
    metricName: parent.contract.metricName,
    overhead: {
      evolve: { executed: false, reason: "No Evolve search is executed by this local research line." },
      ideaTree: { executed: false, reason: "No Idea Tree execution is linked to this local research line." },
      preparations: {
        attempts: attributable.length,
        failed: attributable.filter((preparation) => preparation.outcome === "failed").length,
        knownSeconds: preparationSeconds,
        probeEvaluations,
        succeeded: attributable.filter((preparation) => preparation.outcome === "succeeded").length,
        tokens: "not-applicable",
        unknown: unknownPreparations,
        unknownProbes,
      },
    },
    parentId: core.lineId,
    runs: core.runs,
    stop: core.stop,
    taskId: parent.contract.taskId,
    title: parent.contract.title,
    updatedAt: core.updatedAt,
    usage: {
      tokens: {
        agentDecision: {
          calls: agentCalls,
          inputTokens: agentRows.reduce((total, usage) => total + usage.inputTokens, 0),
          outputTokens: agentRows.reduce((total, usage) => total + usage.outputTokens, 0),
          status: agentStatus,
          unknownUsageCalls: agentUnknownCalls,
        },
        calls: core.usage.tokens.calls,
        coverage: "sf-worker-and-recorded-agent-runs",
        hardCap: null,
        inputTokens: core.usage.tokens.inputTokens,
        note: "Known values cover SF worker calls, attributable preparation wall clock, and model usage recorded for this line's conversation runs. A conversation run shared by several lines is counted on each line, and this path cannot enforce a total token hard cap; these are not a global provider-total claim.",
        outputTokens: core.usage.tokens.outputTokens,
        status: core.usage.tokens.status,
        unknownUsageCalls: core.usage.tokens.unknownUsageCalls + agentUnknownCalls,
      },
      wallClock: {
        chargedSeconds: core.usage.wallClock.chargedSeconds,
        knownSeconds: core.usage.wallClock.knownSeconds,
        notLaunched: core.usage.wallClock.notLaunched,
        preparationSeconds,
        remainingSeconds: core.usage.wallClock.remainingSeconds,
        reservedSeconds: core.usage.wallClock.reservedSeconds,
        unknownPreparations,
        unknownSettlements: core.usage.wallClock.unknownSettlements,
      },
    },
  };
}

/**
 * Whether this line may accept one more child. The reservation is checked before
 * the operation record is created, so a refused start spends nothing. The
 * serial-run, stop, deadline and allowance rules are the shared budget
 * mechanism; this function only supplies the product facts.
 */
export function researchLineRefusal(input: {
  readonly parent: ScienceFlowResearchParent;
  readonly operations: readonly ScienceFlowLocalResearchOperation[];
  readonly allowanceSec: number;
  readonly ownerRunId: string;
  readonly now: string;
  readonly excludeOperationId?: string;
  readonly preparations?: readonly ScienceFlowResearchPreparation[];
  readonly agentUsage?: readonly NonNullable<ScienceFlowLocalResearchOperation["agentUsage"]>[];
}): ResearchLineRefusal | undefined {
  const attributable = attributablePreparations(input.parent.contract, input.preparations ?? []);
  const preparationSeconds = attributable.reduce(
    (total, preparation) => total + (preparation.wallClock.status === "known" ? preparation.wallClock.seconds : 0),
    0,
  );
  const refusal = researchBudgetLineRefusal({
    allowanceSec: input.allowanceSec,
    children: input.operations.map(researchBudgetChild),
    ...(input.excludeOperationId === undefined ? {} : { excludeOperationId: input.excludeOperationId }),
    line: researchParentBudgetLine(input.parent),
    now: input.now,
    ownerRunId: input.ownerRunId,
    viewOptions: { extraChargedSeconds: preparationSeconds },
  });
  return refusal === undefined ? undefined : { message: refusal.message, reason: refusal.reason };
}

export function isTerminal(state: ScienceFlowLocalResearchOperation["state"]): boolean {
  return state === "completed" || state === "failed" || state === "stopped" || state === "unknown";
}

/** Append one decision immutably, keeping the newest bounded history. */
export function withParentDecision(
  parent: ScienceFlowResearchParent,
  decision: ResearchParentDecision,
): ScienceFlowResearchParent {
  return withResearchBudgetDecision(parent, decision);
}

function formatNumber(value: number): string {
  return String(value);
}

/** Recursively key-sorted JSON: two equal contracts always hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

/** Exposed for tests and for the view builder that explains an invalid stage. */
export type { ScienceFlowLocalResearchStage };

/**
 * The engine checkout's own git identity, read without modifying it.
 *
 * `HEAD` alone is not enough: the reference deployment applies a patch series
 * or may carry local changes, and two runs that report the same `HEAD` can
 * import different evaluator bytes. The identity therefore also carries a
 * dirty flag, and the catalog binding separately carries the actual evaluator
 * and package digests. A failure is reported as unknown, never guessed.
 */
export async function readEngineSourceIdentity(
  engineCheckout: string,
  timeoutMs = 3_000,
): Promise<EngineSourceIdentity | undefined> {
  const root = await runGitBounded(engineCheckout, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (root === undefined || root.trim() !== engineCheckout) return undefined;
  const revision = await runGitBounded(engineCheckout, ["rev-parse", "--verify", "HEAD"], timeoutMs);
  if (revision === undefined || !/^[a-f0-9]{40}$/u.test(revision.trim())) return undefined;
  const status = await runGitBounded(
    engineCheckout,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    timeoutMs,
  );
  if (status === undefined) return undefined;
  const summary = parsePorcelain(status);
  return {
    dirty: summary.trackedModified || summary.untrackedRunnable,
    revision: revision.trim(),
    statusDigest: createHash("sha256").update(status).digest("hex"),
  };
}

/**
 * The actual execution environment of the engine's interpreter: host platform,
 * architecture, CPU class, Python version and interpreter/prefix identity.
 * The fingerprint hashes paths and the hostname rather than exposing them; the
 * public fields are only platform/arch/python. Two source-identical checkouts
 * on different machines, CPUs or interpreters therefore never share a group,
 * so speed-like metrics cannot be ranked across them.
 */
export async function readExecutionEnvironment(
  pythonExecutable: string,
  timeoutMs = 3_000,
): Promise<ExecutionEnvironmentIdentity | undefined> {
  const raw = await runProcessBounded(pythonExecutable, ["-I", "-c", EXECUTION_ENVIRONMENT_PROGRAM], timeoutMs);
  if (raw === undefined) return undefined;
  let payload: unknown;
  for (const line of raw.split("\n").map((value) => value.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      payload = JSON.parse(line);
      break;
    } catch {
      continue;
    }
  }
  if (!isRecord(payload)) return undefined;
  const platform = typeof payload.platform === "string" ? payload.platform : "";
  const arch = typeof payload.arch === "string" ? payload.arch : "";
  const python = typeof payload.python === "string" ? payload.python : "";
  if (!platform || !arch || !python) return undefined;
  const fingerprint = createHash("sha256").update(canonicalJson({
    arch,
    cpu: typeof payload.cpu === "string" ? payload.cpu : "",
    cpuCount: typeof payload.cpuCount === "number" ? payload.cpuCount : 0,
    executableHash: sha256Text(typeof payload.executable === "string" ? payload.executable : ""),
    nodeHash: sha256Text(typeof payload.node === "string" ? payload.node : ""),
    platform,
    prefixHash: sha256Text(typeof payload.prefix === "string" ? payload.prefix : ""),
    python,
  })).digest("hex");
  return { arch, fingerprint, platform, python };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EXECUTION_ENVIRONMENT_PROGRAM = String.raw`import json, os, platform, sys
def cpu_model():
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as handle:
            for line in handle:
                if line.strip().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor()
print(json.dumps({
    "arch": platform.machine(),
    "cpu": cpu_model(),
    "cpuCount": os.cpu_count(),
    "executable": sys.executable,
    "node": platform.node(),
    "platform": sys.platform,
    "prefix": sys.prefix,
    "python": "%d.%d.%d" % sys.version_info[:3],
}))
`;

/** One bounded Git invocation; stdout only, never a shell. */
function runProcessBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolvePromise) => {
    let settled = false;
    let output = "";
    let child: ChildProcess | undefined;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(value);
    };
    const timer: NodeJS.Timeout | undefined = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
      finish(undefined);
    }, timeoutMs);
    timer.unref();
    try {
      child = spawn(command, [...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(undefined);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < 262_144) output += chunk;
    });
    child.once("error", () => finish(undefined));
    // `close` fires after stdout is drained; `exit` can fire before the last
    // chunk arrives, which would parse an empty environment report.
    child.once("close", (code) => finish(code === 0 ? output : undefined));
  });
}

function runGitBounded(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return runProcessBounded("git", ["-C", cwd, ...args], timeoutMs);
}
