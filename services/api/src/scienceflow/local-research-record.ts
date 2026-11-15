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
 * The durable shape of one experimental local research operation.
 *
 * The record is control-plane state, not public output: it holds the host paths
 * and engine identity a rebuilt service needs to observe the same run. Every
 * Agent-visible view and every published artifact is derived from it with those
 * fields removed. It is not a job platform: one owned experiment, one engine
 * run, one automatic delivery.
 */

/** The only record version this module writes and reads. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION = 1;

/**
 * Research state, derived from the engine's own lifecycle (plus the launch and
 * readback steps around it). Delivery state is tracked separately so a failed
 * publication stays retryable without touching the experiment.
 */
export type ScienceFlowLocalResearchState =
  | "accepted"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

/** A terminal research state; a terminal operation is never relaunched. */
export function isTerminalResearchState(state: ScienceFlowLocalResearchState): boolean {
  return state === "completed" || state === "failed" || state === "stopped" || state === "unknown";
}

export interface ScienceFlowLocalResearchStage {
  readonly stageId: string;
  readonly parentStageId: string | null;
  readonly metricName: string;
  readonly metricValue: number;
  readonly artifactSha256: string | null;
  readonly validationOk: boolean;
  readonly gateAccepted: boolean;
  readonly evaluatorStatus: string;
  readonly createdAtUtc: string;
}

export interface ScienceFlowLocalResearchUsage {
  readonly calls: number;
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly unknownUsageCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly models: readonly string[];
}

/** A fixed grant: the scheduling bounds the run was started with. */
export interface ScienceFlowLocalResearchGrant {
  readonly task: string;
  readonly researchBudgetSec: number;
  readonly reportBudgetSec: number;
  readonly totalAllowanceSec: number;
  readonly maxSteps: number;
  readonly stageCaptureMax: number;
  readonly bashTimeoutSec: number;
  readonly codeMaxTokens: number;
  readonly feedbackMaxTokens: number;
  readonly httpTimeoutSec: number;
  readonly refusePackageInstall: boolean;
  /** Whether the configured fixed task text was pinned into the launch input. */
  readonly taskDescriptionPinned: boolean;
}

/** The credential-free model facts the engine actually ran with. */
export interface ScienceFlowLocalResearchModel {
  readonly profileName: string;
  readonly providerModel: string;
  readonly selectionSource: string;
}

/** An ordinary Session artifact version produced by delivery. */
export interface ScienceFlowLocalResearchArtifactRef {
  readonly artifactId: string;
  readonly versionId: string;
  readonly version: number;
  readonly logicalName: string;
  readonly role: "solution" | "note" | "carried_seed" | "first_captured" | "evaluated_attempt" | "researcher_record";
  readonly metricName?: string;
  readonly metricValue?: number;
}

export interface ScienceFlowLocalResearchDelivery {
  readonly state: "pending" | "delivered" | "failed" | "no-candidate";
  readonly attempts: number;
  readonly updatedAt: string;
  /** A stable reason when publication failed. */
  readonly reason?: string;
  readonly failedStep?: string;
  readonly message?: string;
  /** Set when a later retry failed after an earlier delivery succeeded. */
  readonly lastError?: string;
  readonly selectedStageId?: string;
  readonly metricName?: string;
  readonly metricValue?: number;
  readonly lowerIsBetter?: boolean | null;
  readonly solution?: ScienceFlowLocalResearchArtifactRef;
  readonly note?: ScienceFlowLocalResearchArtifactRef;
  readonly staged?: readonly ScienceFlowLocalResearchArtifactRef[];
  /** The researcher's own trial/submit logs, copied unchanged. */
  readonly researcher?: readonly ScienceFlowLocalResearchArtifactRef[];
}

export interface ScienceFlowLocalResearchStop {
  readonly requestedAt?: string;
  readonly requestedBy?: "tool" | "conversation-cancel";
  readonly confirmedAt?: string;
  readonly engineStatus?: string;
  readonly lastError?: string;
}

/** The two fixed input roles this experimental profile can bind. */
export type ScienceFlowLocalResearchInputRole = "plan" | "incumbent";

/**
 * The bytes this operation's launch actually used for one fixed input role.
 * `versionId` is the Session version the start named after its content was
 * proven equal to the profile's configured input file; `null` means the start
 * ran the configured input without a linked version.
 */
export interface ScienceFlowLocalResearchInput {
  readonly role: ScienceFlowLocalResearchInputRole;
  readonly sha256: string;
  readonly size: number;
  readonly versionId: string | null;
  /** Where the bytes were staged inside the operation's input directory. */
  readonly stagedName?: string;
}

/**
 * The operation-owned input directory the engine's manifest pointed at. Recorded
 * so a rebuilt service (and an auditor) can tell which directory this run read,
 * and so nothing can silently re-point it at the administrator's seed later.
 */
export interface ScienceFlowLocalResearchStagedInputs {
  readonly dataDir: string;
  readonly entries: number;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly stagedAt: string;
  readonly totalBytes: number;
}

/** What the engine's own record last said about this run. */
export interface ScienceFlowLocalResearchEngineFacts {
  readonly status?: string;
  readonly phase?: string;
  readonly researchStatus?: string;
  readonly reportStatus?: string;
  readonly alive?: boolean;
  readonly supervisorPid?: number;
  readonly observedAt?: string;
}

export interface ScienceFlowLocalResearchOperation {
  readonly schemaVersion: typeof SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION;
  readonly operationId: string;
  /** Stable hash of the accepted start request; a replay finds this row. */
  readonly idempotencyKey: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  /** The conversation run that started it; the Session's cancel path uses it. */
  readonly ownerRunId: string;
  readonly intent: string;
  readonly planVersionId?: string;
  readonly incumbentVersionId?: string;
  /**
   * The fixed input bytes this launch used, with the verified version identity
   * when the start named one. Absent on records written before the binding was
   * introduced; observation still reads them unchanged.
   */
  readonly inputs?: readonly ScienceFlowLocalResearchInput[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ScienceFlowLocalResearchState;
  readonly engineRunId: string;
  readonly task: string;
  /** Control-plane paths, needed to observe this run again after a rebuild. */
  readonly workDir: string;
  readonly receiptPath: string;
  readonly deliveryRecordPath: string;
  readonly launch: {
    readonly profileId: string;
    readonly engineCheckout: string;
    readonly pythonExecutable: string;
    readonly readerScriptPath: string;
    readonly seedDir: string;
    readonly privateRoot: string;
    readonly model: ScienceFlowLocalResearchModel | null;
    readonly grant: ScienceFlowLocalResearchGrant;
    /** `fixed` for records written before dynamic input existed. */
    readonly inputMode?: "fixed" | "dynamic";
    /** The exact instruction pinned for this run, when one was composed. */
    readonly taskDescription?: string;
  };
  readonly engine: ScienceFlowLocalResearchEngineFacts;
  /** Present once the operation's own input directory has been staged. */
  readonly stagedInputs?: ScienceFlowLocalResearchStagedInputs;
  readonly progress: {
    readonly stages: readonly ScienceFlowLocalResearchStage[];
    readonly usage: ScienceFlowLocalResearchUsage | null;
    readonly observedAt?: string;
  };
  readonly delivery: ScienceFlowLocalResearchDelivery;
  readonly stop: ScienceFlowLocalResearchStop;
  readonly error?: { readonly step: string; readonly message: string };
}
