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
 * The Web projection of one experimental local research operation.
 *
 * These fields mirror the server's public view; paths, interpreter, endpoint and
 * credentials are not part of it. The panel treats a missing field as "not
 * observed yet" rather than inventing progress.
 */

export type ResearchOperationState =
  | "accepted"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

export interface ResearchArtifactRef {
  artifactId: string;
  logicalName: string;
  role: "solution" | "note" | "carried_seed" | "first_captured" | "evaluated_attempt" | "researcher_record";
  version: number;
  versionId: string;
}

export interface ResearchStage {
  artifactSha256: string | null;
  createdAtUtc: string;
  evaluatorStatus: string;
  gateAccepted: boolean;
  metricName: string;
  metricValue: number;
  parentStageId: string | null;
  stageId: string;
  validationOk: boolean;
}

export interface ResearchDelivery {
  attempts: number;
  failedStep?: string;
  lastError?: string;
  lowerIsBetter?: boolean | null;
  message?: string;
  metricName?: string;
  metricValue?: number;
  note?: ResearchArtifactRef;
  reason?: string;
  researcher?: ResearchArtifactRef[];
  selectedStageId?: string;
  solution?: ResearchArtifactRef;
  staged?: ResearchArtifactRef[];
  state: "pending" | "delivered" | "failed" | "no-candidate";
  updatedAt: string;
}

export interface ResearchOperation {
  createdAt: string;
  delivery: ResearchDelivery;
  engine: {
    alive?: boolean;
    phase?: string;
    reportStatus?: string;
    researchStatus?: string;
    status?: string;
    supervisorPid?: number;
  };
  engineRunId: string;
  error: { message: string; step: string } | null;
  experimentalLocalExecution: true;
  formalRunnerSandbox: false;
  incumbentVersionId: string | null;
  inputMode: "fixed" | "dynamic";
  instruction: string;
  intent: string;
  model: { profileName: string; providerModel: string; selectionSource: string } | null;
  operationId: string;
  planVersionId: string | null;
  /** This run's relation to its contract's latest/best/explicitly selected result. */
  resultRelation?: ResearchResultRelation;
  /** The research line's total-budget projection for this contract. */
  parent?: ResearchParentSummary;
  stages: ResearchStage[];
  state: ResearchOperationState;
  stop: {
    confirmedAt?: string;
    engineStatus?: string;
    lastError?: string;
    requestedAt?: string;
    requestedBy?: "tool" | "conversation-cancel";
  };
  task: string;
  updatedAt: string;
  usage: {
    calls: number;
    completedCalls: number;
    failedCalls: number;
    inputTokens: number;
    models: string[];
    outputTokens: number;
    unknownUsageCalls: number;
  } | null;
}

export interface ResearchResultSolutionRef {
  artifactId: string;
  logicalName: string;
  version: number;
  versionId: string;
}

export interface ResearchResultSelection {
  isBestValid: boolean;
  metric: { lowerIsBetter: boolean; name: string; value: number };
  operationId: string;
  reason: string;
  selectedAt: string;
  selectedBy: "tool" | "web";
  solution: ResearchResultSolutionRef;
  /** False when the chosen result is no longer a valid comparable result. */
  valid: boolean;
  wasBestValid: boolean;
}

export interface ResearchResultRelation {
  bestValid: {
    metric: { lowerIsBetter: boolean; name: string; value: number };
    operationId: string;
    solution: ResearchResultSolutionRef | null;
  } | null;
  comparable: boolean;
  comparisonNote: string;
  contractTaskId: string;
  contractTitle: string;
  groupId: string;
  isBestValid: boolean;
  isLatest: boolean;
  isSelectedForNext: boolean;
  rankable: boolean;
  selectedForNext: ResearchResultSelection | null;
  validity: "valid" | "invalid";
  validityReasons: string[];
}

export interface ResearchParentSummary {
  activeChild: { operationId: string; reservedSec: number; state: ResearchOperationState } | null;
  createdAt: string;
  deadlinePassed: boolean;
  enforcement: { runCount: boolean; tokenCap: false; wallClock: boolean };
  groupId: string;
  limits: { deadlineAt: string; maxChildRuns: number; totalAllowanceSec: number } | null;
  lowerIsBetter: boolean | null;
  metricName: string | null;
  parentId: string;
  runs: { active: number; settled: number; started: number };
  stop: {
    confirmedAt?: string;
    operationId?: string;
    ownerRunId?: string;
    requestedAt?: string;
    requestedBy?: "tool" | "conversation-cancel";
  };
  taskId: string;
  title: string;
  updatedAt: string;
  usage: {
    wallClock: {
      chargedSeconds: number;
      knownSeconds: number;
      notLaunched: number;
      preparationSeconds?: number;
      remainingSeconds: number | null;
      reservedSeconds: number;
      unknownPreparations?: number;
      unknownSettlements: number;
    };
    tokens: {
      agentDecision?: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        status: "known" | "partially-known" | "unknown" | "not-recorded";
        unknownUsageCalls: number;
      };
      calls: number;
      coverage?: string;
      hardCap: null;
      inputTokens: number;
      note: string;
      outputTokens: number;
      status: "known" | "partially-known" | "unknown" | "not-launched";
      unknownUsageCalls: number;
    };
  };
  overhead?: {
    preparations: {
      attempts: number;
      failed: number;
      knownSeconds: number;
      probeEvaluations: number;
      succeeded: number;
      tokens: "not-applicable";
      unknown: number;
      unknownProbes: number;
    };
    ideaTree: { executed: false; reason: string };
    evolve: { executed: false; reason: string };
  };
}

export interface ResearchOperationsResponse {
  enabled: boolean;
  inputMode?: "fixed" | "dynamic";
  operations: ResearchOperation[];
  profileId?: string;
}

export interface ResearchStopResponse {
  confirmed: boolean;
  operation: ResearchOperation;
  reason?: "already-terminal";
  requested: boolean;
}
