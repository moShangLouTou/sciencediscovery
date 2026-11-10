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
 * Public, versioned contract for one ScienceFlow managed-run snapshot.
 *
 * The reader's snapshot is an internal record: it carries absolute paths,
 * open metadata objects, and diagnostic prose. These types are the allow-listed
 * projection a future HTTP response may return. Enum values are closed on
 * purpose; unknown engine states are reported as `unknown`, never as an
 * inferred research outcome.
 */

/** Version of this response contract, not of the Python reader snapshot. */
export const SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION = 1;

/** Engine status values this contract is willing to show. */
export const SCIENCE_FLOW_PUBLIC_RUN_STATUSES = [
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "unknown",
] as const;
export type ScienceFlowPublicRunStatus =
  (typeof SCIENCE_FLOW_PUBLIC_RUN_STATUSES)[number];

/** Engine phases this contract is willing to show. */
export const SCIENCE_FLOW_PUBLIC_RUN_PHASES = [
  "research",
  "reporting",
  "finished",
  "unknown",
] as const;
export type ScienceFlowPublicRunPhase =
  (typeof SCIENCE_FLOW_PUBLIC_RUN_PHASES)[number];

/** Where an engine-reported metric came from. */
export const SCIENCE_FLOW_PUBLIC_METRIC_SOURCES = [
  "best_stage_manifest",
  "lhr_stage_performance",
  "lhr_state.global_best",
  "task_registration",
  "unknown",
] as const;
export type ScienceFlowPublicMetricSource =
  (typeof SCIENCE_FLOW_PUBLIC_METRIC_SOURCES)[number];

/** Diagnostic codes the server is willing to translate into a fixed note. */
export const SCIENCE_FLOW_PUBLIC_DIAGNOSTIC_CODES = [
  "run_record_missing",
  "run_record_invalid_json",
  "run_record_too_large",
  "run_record_missing_run_id",
  "task_root_missing",
  "task_root_out_of_bounds",
  "metadata_too_large",
  "metadata_invalid_json",
  "metadata_invalid_csv",
  "no_candidate_binding",
  "no_valid_candidate",
  "no_eligible_candidate",
  "candidate_file_missing",
  "candidate_sha_mismatch",
  "candidate_path_out_of_bounds",
  "unsupported_schema_version",
  "invalid_arguments",
  "internal_error",
  "other",
] as const;
export type ScienceFlowPublicDiagnosticCode =
  (typeof SCIENCE_FLOW_PUBLIC_DIAGNOSTIC_CODES)[number];

export interface ScienceFlowPublicMetric {
  readonly metricName: string;
  readonly metricValue: number;
  /** Null when the record did not say which direction is better. */
  readonly lowerIsBetter: boolean | null;
}

export interface ScienceFlowReportedMetric extends ScienceFlowPublicMetric {
  readonly source: ScienceFlowPublicMetricSource;
}

export interface ScienceFlowCandidateSummary {
  /** Lowercase hex digest the reader computed during this read. */
  readonly sha256: string;
  /** True only when the recorded digest matched; null when none was recorded. */
  readonly digestVerified: boolean | null;
  /** Candidate metric binding; null when the record did not carry a valid one. */
  readonly metric: ScienceFlowPublicMetric | null;
  readonly stageId: string | null;
}

/** One task, related across the response by `taskIndex`. */
export interface ScienceFlowTaskSnapshotDto {
  /** Response-local position; not a stable task id across requests. */
  readonly taskIndex: number;
  /** Engine-recorded metric, not a finally valid result. */
  readonly reportedMetric: ScienceFlowReportedMetric | null;
  /** Present only when the reader could verify a candidate file and binding. */
  readonly candidate: ScienceFlowCandidateSummary | null;
}

export interface ScienceFlowSnapshotDiagnosticDto {
  readonly code: ScienceFlowPublicDiagnosticCode;
  /** Fixed server-side description; the reader's message is never forwarded. */
  readonly description: string;
}

export interface ScienceFlowRunSnapshotDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION;
  readonly run: {
    readonly runId: string;
    readonly status: ScienceFlowPublicRunStatus;
    readonly phase: ScienceFlowPublicRunPhase;
  };
  readonly tasks: readonly ScienceFlowTaskSnapshotDto[];
  readonly diagnostics: readonly ScienceFlowSnapshotDiagnosticDto[];
}

/**
 * Version of the persisted, control-plane registration record.
 *
 * A registration says only that an existing, admin-bound run was attached to a
 * Session. It carries no host path, no interpreter, no research outcome and no
 * snapshot, and it is never used as engine lifecycle state.
 */
export const SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION = 1;

/**
 * One existing ScienceFlow run registered against a Project/Session.
 *
 * `registrationId` is server-generated and immutable. `runId` is still the
 * ScienceFlow managed-run id; the triple `(projectId, sessionId, runId)` is the
 * unique identity a retry resolves to. `createdAt` is server-generated.
 */
export interface ScienceFlowRunRegistrationDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION;
  readonly registrationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  /** ISO-8601 creation time, written once and never updated. */
  readonly createdAt: string;
}

/**
 * The only body a registration create accepts. Everything else — paths,
 * interpreter, roots, ids, timestamps, state — is rejected, never overridden.
 */
export interface ScienceFlowRunRegistrationInput {
  readonly runId: string;
}
