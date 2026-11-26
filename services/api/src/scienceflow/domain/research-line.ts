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

import { projectResearchBudgetLine, RESEARCH_BUDGET_LINE_VERSION, researchBudgetLineView,
  researchBudgetLineRefusal, withResearchBudgetDecision, type ResearchBudgetLine, type ResearchBudgetChild } from "../../research/budget.js";
import { summarizeResearchOverhead, summarizeResearchUsage } from "../../research/overhead-ledger.js";
import type { ScienceFlowLocalResearchOperation } from "../local-research-record.js";
import type { ScienceFlowResearchPreparation } from "../local-research-overhead-repository.js";
import { RESEARCH_PARENT_VERSION, contractFingerprint, type ResearchContractIdentity, type ScienceFlowResearchParent,
  type ResearchParentView, type ResearchParentDecision, type ResearchLineRefusal, type ResearchParentLimits } from "./experiment-comparison.js";
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
export function attributableResearchPreparations(
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
  const attributable = attributableResearchPreparations(parent.contract, preparations);
  const overhead = summarizeResearchOverhead(attributable);
  const preparationSeconds = overhead.knownSeconds;
  const unknownPreparations = overhead.unknown;
  const core = researchBudgetLineView(
    researchParentBudgetLine(parent),
    operations.map(researchBudgetChild),
    now,
    { extraChargedSeconds: preparationSeconds },
  );
  const agentDecision = summarizeResearchUsage(agentUsage);
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
      preparations: { ...overhead, tokens: "not-applicable" },
    },
    parentId: core.lineId,
    runs: core.runs,
    stop: core.stop,
    taskId: parent.contract.taskId,
    title: parent.contract.title,
    updatedAt: core.updatedAt,
    usage: {
      tokens: {
        agentDecision,
        calls: core.usage.tokens.calls,
        coverage: "sf-worker-and-recorded-agent-runs",
        hardCap: null,
        inputTokens: core.usage.tokens.inputTokens,
        note: "Known values cover SF worker calls, attributable preparation wall clock, and model usage recorded for this line's conversation runs. A conversation run shared by several lines is counted on each line, and this path cannot enforce a total token hard cap; these are not a global provider-total claim.",
        outputTokens: core.usage.tokens.outputTokens,
        status: core.usage.tokens.status,
        unknownUsageCalls: core.usage.tokens.unknownUsageCalls + agentDecision.unknownUsageCalls,
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
  const attributable = attributableResearchPreparations(input.parent.contract, input.preparations ?? []);
  const preparationSeconds = summarizeResearchOverhead(attributable).knownSeconds;
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

