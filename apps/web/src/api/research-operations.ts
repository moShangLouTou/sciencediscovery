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
