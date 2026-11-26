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

import type { ScienceFlowInputFileRole } from "./scienceflow-input-bundle.js";

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

/**
 * Version of the immutable execution-plan contract.
 *
 * A plan freezes what an administrator's profile and the checked source files
 * said at one moment. It is not a ResearchTaskSpec, not a registration, and not
 * a ScienceFlow run: `planId`, `registrationId`, and `runId` are three different
 * identities and are never interchangeable.
 */
export const SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION = 1;
/** Version of one static preflight result, bound to a plan contract digest. */
export const SCIENCE_FLOW_PREFLIGHT_DTO_VERSION = 1;
/** Default and maximum page sizes for listing plans. */
export const SCIENCE_FLOW_EXECUTION_PLAN_LIST_DEFAULT_LIMIT = 100;
export const SCIENCE_FLOW_EXECUTION_PLAN_LIST_MAX_LIMIT = 250;

/** How one static check ended. Only `passed` and `unknown` keep a contract valid. */
export const SCIENCE_FLOW_PLAN_CHECK_STATUSES = [
  "passed",
  "failed",
  "unknown",
  "unsupported",
] as const;
export type ScienceFlowPlanCheckStatus =
  (typeof SCIENCE_FLOW_PLAN_CHECK_STATUSES)[number];

/**
 * Fixed diagnostic codes a plan check may carry.
 *
 * Codes describe a condition, not a sentence: the server supplies the fixed
 * description. No code, description, or error ever carries a host path, raw
 * YAML, an exception message, or a free-form engine diagnostic.
 */
export const SCIENCE_FLOW_PLAN_CHECK_CODES = [
  "manifest_readable",
  "manifest_encoding",
  "manifest_size",
  "manifest_yaml",
  "manifest_duplicate_key",
  "manifest_alias_limit",
  "manifest_shape",
  "manifest_key",
  "manifest_multiple_tasks",
  "manifest_max_concurrent",
  "manifest_phase",
  "manifest_type",
  "manifest_resume",
  "manifest_config_include",
  "manifest_task_text",
  "manifest_model_gateway",
  "manifest_evaluator",
  "manifest_budget",
  "manifest_workspace",
  "task_yaml_readable",
  "task_yaml_encoding",
  "task_yaml_size",
  "task_yaml_yaml",
  "task_yaml_duplicate_key",
  "task_yaml_alias_limit",
  "task_yaml_shape",
  "task_yaml_key",
  "shared_defaults",
  "task_identity",
  "task_metric",
  "task_artifact",
  "evaluator_entrypoint",
  "evaluator_file",
  "description_reference",
  "description_file",
  "path_allowed_roots",
  "path_traversal",
  "dataset_identity",
  "execution_environment",
  "pricing",
  "model_gateway",
  "scienceflow_revision",
  "dependency_closure",
  "contract_changed",
] as const;
export type ScienceFlowPlanCheckCode =
  (typeof SCIENCE_FLOW_PLAN_CHECK_CODES)[number];

/**
 * Reasons execution cannot start. `canStart` is always false this round: a
 * static contract being valid says nothing about a connected backend, a model
 * gateway, enforced budgets, descendant-process cancellation, or a verified
 * engine revision.
 */
export const SCIENCE_FLOW_EXECUTION_BLOCKER_CODES = [
  "execution_backend_not_connected",
  "model_gateway_not_configured",
  "budget_enforcement_not_implemented",
  "process_cancellation_not_implemented",
  "scienceflow_revision_unverified",
] as const;
export type ScienceFlowExecutionBlockerCode =
  (typeof SCIENCE_FLOW_EXECUTION_BLOCKER_CODES)[number];

export interface ScienceFlowPlanCheckDto {
  readonly code: ScienceFlowPlanCheckCode;
  readonly status: ScienceFlowPlanCheckStatus;
  /** Fixed server-side description; never source text or an exception. */
  readonly description: string;
}

export interface ScienceFlowPlanBlockerDto {
  readonly code: ScienceFlowExecutionBlockerCode;
  readonly description: string;
}

/** The declared engine revision, kept apart from what was actually checked. */
export interface ScienceFlowDeclaredRevisionDto {
  readonly declaredRevision: string;
  /** This round never inspects an installation, so it is always `unverified`. */
  readonly verification: "unverified";
}

export interface ScienceFlowExecutionTaskDto {
  readonly taskId: string;
  readonly category: string | null;
  readonly profile: string | null;
}

export interface ScienceFlowExecutionMetricDto {
  readonly name: string;
  readonly lowerIsBetter: boolean;
  readonly type: string | null;
  /** Null when the package did not state it; never inferred. */
  readonly authoritative: boolean | null;
}

export interface ScienceFlowExecutionArtifactDto {
  /** Package-relative; never an absolute host path. */
  readonly path: string;
  readonly kind: string | null;
}

export interface ScienceFlowExecutionEvaluatorDto {
  /** The package-relative `path:function` reference, not imported or executed. */
  readonly entrypoint: string;
  readonly path: string;
  readonly function: string;
  readonly sha256: string;
  readonly timeoutSec: number | null;
}

export interface ScienceFlowExecutionDescriptionDto {
  readonly path: string;
  readonly sha256: string;
}

/**
 * Which manifest key supplies the task workspace.
 *
 * The engine resolves a workspace from the first non-blank of the task's
 * `workspace`, the task's `workspace_base`, then `defaults.workspace_base`, and
 * refuses a manifest that supplies none. This contract records only which one
 * supplied it: the path is never read, expanded, created, stored, or returned.
 */
export const SCIENCE_FLOW_WORKSPACE_SOURCES = [
  "task_workspace",
  "task_workspace_base",
  "defaults_workspace_base",
] as const;
export type ScienceFlowWorkspaceSource =
  (typeof SCIENCE_FLOW_WORKSPACE_SOURCES)[number];

export interface ScienceFlowExecutionWorkspaceDto {
  readonly source: ScienceFlowWorkspaceSource;
}

export interface ScienceFlowExecutionBudgetDto {
  /** Manifest-declared, never enforced by this round. */
  readonly name: "wall_clock_budget_sec" | "time_limit";
  readonly value: number;
  readonly unit: "seconds";
  readonly nature: "requested";
}

/** Capabilities this round cannot verify. Each stays explicit, never assumed. */
export interface ScienceFlowExecutionUnknownsDto {
  readonly dataset: "not-applicable" | "unknown";
  readonly environment: "unknown";
  readonly pricing: "unknown";
  readonly modelGateway: "unknown";
  readonly revision: "unverified";
  readonly dependencyClosure: "incomplete";
}

/** The whitelisted, immutable content of one execution plan. */
export interface ScienceFlowExecutionPlanContractDto {
  readonly scienceflow: ScienceFlowDeclaredRevisionDto;
  readonly task: ScienceFlowExecutionTaskDto;
  readonly metric: ScienceFlowExecutionMetricDto;
  readonly artifact: ScienceFlowExecutionArtifactDto;
  readonly evaluator: ScienceFlowExecutionEvaluatorDto;
  readonly description: ScienceFlowExecutionDescriptionDto;
  /** Which key supplied the workspace; never the path. */
  readonly workspace: ScienceFlowExecutionWorkspaceDto;
  readonly taskYamlSha256: string;
  readonly manifestSha256: string;
  /** Digest of the applied `_shared/task_defaults.yaml`; null when none applied. */
  readonly sharedDefaultsSha256: string | null;
  readonly budgets: readonly ScienceFlowExecutionBudgetDto[];
  readonly unknowns: ScienceFlowExecutionUnknownsDto;
}

/**
 * Version of the Runner-side runtime identity probe.
 *
 * The probe answers one question: which ScienceFlow package source would the
 * selected environment's interpreter resolve, and is that source the trusted
 * checkout at the declared revision? It never imports ScienceFlow and never
 * starts it.
 */
export const SCIENCE_FLOW_RUNTIME_PROBE_VERSION = 1;
/** Version of one persisted runtime check, bound to a plan and its binding. */
export const SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION = 1;

/**
 * Fixed diagnostic codes a runtime identity check may carry.
 *
 * Each code names a fact the Runner either established or could not. Codes are
 * the only detail that leaves the Runner: no host path, interpreter path,
 * `sys.path` entry, Git output, or package metadata is ever attached to one.
 */
export const SCIENCE_FLOW_RUNTIME_CHECK_CODES = [
  "binding_identity",
  "environment_revision",
  "interpreter_identity",
  "package_resolution",
  "source_root",
  "source_revision",
  "source_cleanliness",
  "startup_hooks",
  "duplicate_distribution",
] as const;
export type ScienceFlowRuntimeCheckCode =
  (typeof SCIENCE_FLOW_RUNTIME_CHECK_CODES)[number];

/** What the resolved package source is; only `git-checkout` can be verified. */
export const SCIENCE_FLOW_RUNTIME_SOURCE_KINDS = [
  "git-checkout",
  "installed-distribution",
  "unsupported",
] as const;
export type ScienceFlowRuntimeSourceKind =
  (typeof SCIENCE_FLOW_RUNTIME_SOURCE_KINDS)[number];

export interface ScienceFlowRuntimeCheckDtoCheck {
  readonly code: ScienceFlowRuntimeCheckCode;
  readonly status: ScienceFlowPlanCheckStatus;
  /** Fixed server-side description; never probe output. */
  readonly description: string;
}

/**
 * What the Runner accepted. Every field is an identity the API already knows or
 * an administrator configured; there is no command, path, environment variable,
 * or interpreter field a caller could supply.
 */
export interface ScienceFlowRuntimeProbeRequest {
  readonly schemaVersion: typeof SCIENCE_FLOW_RUNTIME_PROBE_VERSION;
  /** Server-generated; echoed back so a mismatched answer is detectable. */
  readonly requestId: string;
  /** The Runner-side trusted binding id from the Runner's own configuration. */
  readonly bindingId: string;
  readonly environmentId: string;
  readonly expectedEnvironmentRevisionId: string;
  /** The frozen plan's declared revision; must equal the Runner binding's. */
  readonly expectedRevision: string;
}

/**
 * What the Runner observed. The Runner's own classification, carrying only
 * facts it stands behind; `checks` explains every non-passing one.
 */
export interface ScienceFlowRuntimeProbeResult {
  readonly schemaVersion: typeof SCIENCE_FLOW_RUNTIME_PROBE_VERSION;
  readonly requestId: string;
  readonly bindingId: string;
  readonly environmentId: string;
  readonly environmentRevisionId: string | null;
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  /** The checkout's actual HEAD, only when the Git check could read it. */
  readonly revision: string | null;
  readonly checkedAt: string;
  /** `blocked` means the check ran and did not establish a source binding. */
  readonly outcome: "verified" | "blocked" | "unavailable";
  readonly checks: readonly {
    readonly code: ScienceFlowRuntimeCheckCode;
    readonly status: ScienceFlowPlanCheckStatus;
  }[];
}

/** Capabilities a source binding does not establish. */
export interface ScienceFlowRuntimeUnknownsDto {
  readonly dependencyClosure: "incomplete";
  readonly executionStart: "not-checked";
  readonly modelGateway: "unknown";
  readonly evaluator: "not-checked";
  readonly gpu: "not-checked";
}

/**
 * One persisted runtime identity check. It is evidence from `checkedAt`, bound
 * to the plan, its contract digest, and the exact binding that was checked; it
 * is never an execution authorization, and a later `POST` replaces it.
 */
export interface ScienceFlowRuntimeCheckDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION;
  readonly planId: string;
  readonly contractDigest: string;
  /** Digest over plan, profile, runner, environment, and expected revisions. */
  readonly bindingDigest: string;
  readonly runnerId: string;
  readonly environmentId: string;
  readonly environmentRevisionId: string | null;
  readonly checkedAt: string;
  readonly outcome: "verified" | "blocked";
  readonly canStart: false;
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  readonly sourceRevision: string | null;
  readonly checks: readonly ScienceFlowRuntimeCheckDtoCheck[];
  readonly unknowns: ScienceFlowRuntimeUnknownsDto;
  /** Monotonic per plan; a larger generation supersedes an older result. */
  readonly generation: number;
}

/** The read answer: the latest stored check, or none performed yet. */
export interface ScienceFlowRuntimeCheckStateDto {
  readonly planId: string;
  readonly check: ScienceFlowRuntimeCheckDto | null;
}

/**
 * Version of one persisted "input evidence prepared" receipt.
 *
 * A receipt records one successful preparation at one moment: that the
 * selected Runner held a bundle whose bytes matched the frozen plan's contract.
 * It is not a continuous health fact, not a runtime identity verification, not
 * a start authorization, and not a formal Artifact.
 */
export const SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION = 1;

/** One contract role and the verified byte set that serves it. */
export interface ScienceFlowPreparedInputFileDto {
  readonly role: ScienceFlowInputFileRole;
  /** Logical bundle-relative label, never a Runner host path. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * The whitelisted preparation receipt. It carries digests and role summaries
 * only: no raw manifest, evaluator source, internal layout, or storage address.
 */
export interface ScienceFlowPreparedInputsDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION;
  readonly planId: string;
  /** The frozen plan digest the preparation was matched against. */
  readonly contractDigest: string;
  /** Content identity of the exact file set the Runner materialized. */
  readonly bundleDigest: string;
  readonly runnerId: string;
  /** ISO-8601 time the API recorded the preparation. */
  readonly preparedAt: string;
  readonly outcome: "prepared";
  readonly canStart: false;
  /** Distinct byte sets materialized; `files` lists every role. */
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly ScienceFlowPreparedInputFileDto[];
  /** Monotonic per plan; a larger generation supersedes an older receipt. */
  readonly generation: number;
}

/** The read answer: the latest stored receipt, or none performed yet. */
export interface ScienceFlowPreparedInputsStateDto {
  readonly planId: string;
  readonly prepared: ScienceFlowPreparedInputsDto | null;
}

/** One immutable plan plus the most recent stored preflight result. */
export interface ScienceFlowExecutionPlanDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION;
  readonly planId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly profileId: string;
  /** The client's idempotency identity, echoed back so retries are explicit. */
  readonly requestId: string;
  /** ISO-8601 creation time, written once and never updated. */
  readonly createdAt: string;
  /** SHA-256 over the canonical contract below. */
  readonly contractDigest: string;
  readonly contract: ScienceFlowExecutionPlanContractDto;
  /** Static contract validity only; execution availability is reported apart. */
  readonly execution: {
    readonly canStart: false;
    readonly blockers: readonly ScienceFlowPlanBlockerDto[];
  };
  readonly latestPreflight: ScienceFlowPreflightDto | null;
}

/**
 * One completed static preflight. `outcome` reports contract validity only;
 * `canStart` is always false and the blockers are fixed.
 */
export interface ScienceFlowPreflightDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_PREFLIGHT_DTO_VERSION;
  readonly planId: string;
  /** The frozen plan digest the check is bound to. */
  readonly contractDigest: string;
  /** Digest recomputed from the current profile and files; null if unreadable. */
  readonly observedContractDigest: string | null;
  readonly checkedAt: string;
  readonly outcome: "passed" | "blocked";
  readonly canStart: false;
  readonly checks: readonly ScienceFlowPlanCheckDto[];
  readonly blockers: readonly ScienceFlowPlanBlockerDto[];
}

/**
 * The only body a plan create accepts. Paths, manifest text, scripts, model
 * credentials, and budget overrides are not accepted fields.
 */
export interface ScienceFlowExecutionPlanInput {
  readonly profileId: string;
  readonly requestId: string;
}
