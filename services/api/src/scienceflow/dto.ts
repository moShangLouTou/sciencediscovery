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
 * Project the reader's internal snapshot onto the public response contract.
 *
 * The reader returns open metadata records plus absolute paths and diagnostic
 * prose. This module walks those values field by field: nothing is spread,
 * cast through, or copied wholesale. Every exposed value is a whitelisted
 * enum, a validated number or digest, or `null`. A field that does not meet
 * its known contract becomes `null` (or `unknown` for enums); it is never
 * replaced by a guess.
 *
 * Two limits remain visible in the response shape: a readable candidate with
 * a matching digest was not re-evaluated, and `reportedMetric` is what the
 * engine recorded, not a final valid score.
 */
import type {
  ScienceFlowRunSnapshot,
  ScienceFlowSnapshotDiagnostic,
} from "@sciencediscovery/scienceflow-reader";

import {
  SCIENCE_FLOW_PUBLIC_DIAGNOSTIC_CODES,
  SCIENCE_FLOW_PUBLIC_METRIC_SOURCES,
  SCIENCE_FLOW_PUBLIC_RUN_PHASES,
  SCIENCE_FLOW_PUBLIC_RUN_STATUSES,
  SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION,
  type ScienceFlowCandidateSummary,
  type ScienceFlowPublicDiagnosticCode,
  type ScienceFlowPublicMetric,
  type ScienceFlowPublicMetricSource,
  type ScienceFlowPublicRunPhase,
  type ScienceFlowPublicRunStatus,
  type ScienceFlowReportedMetric,
  type ScienceFlowRunSnapshotDto,
  type ScienceFlowSnapshotDiagnosticDto,
  type ScienceFlowTaskSnapshotDto,
} from "@sciencediscovery/schema";

/** Fixed server-side notes. The reader's own message text is never forwarded. */
const DIAGNOSTIC_DESCRIPTIONS: Readonly<
  Record<ScienceFlowPublicDiagnosticCode, string>
> = {
  run_record_missing: "The run record was not found.",
  run_record_invalid_json: "The run record is not valid JSON.",
  run_record_too_large: "The run record exceeds the reader's size limit.",
  run_record_missing_run_id: "The run record does not name a run.",
  task_root_missing: "A task root is not a usable path.",
  task_root_out_of_bounds: "A task root is outside the allowed roots.",
  metadata_too_large: "A metadata file exceeds the reader's size limit.",
  metadata_invalid_json: "A metadata file is not valid JSON.",
  metadata_invalid_csv: "A metadata file is not a valid CSV.",
  no_candidate_binding: "The run records no candidate for this task.",
  no_valid_candidate: "The run records no valid candidate.",
  no_eligible_candidate: "The run records no eligible candidate.",
  candidate_file_missing: "The recorded candidate file is missing.",
  candidate_sha_mismatch: "The candidate file does not match its recorded digest.",
  candidate_path_out_of_bounds: "The recorded candidate path is outside the allowed roots.",
  unsupported_schema_version: "The reader reported an unsupported schema version.",
  invalid_arguments: "The reader received unusable arguments.",
  internal_error: "The reader failed unexpectedly.",
  other: "The reader reported a condition this API does not classify.",
};

/**
 * Build the public snapshot. `runId` must be the already-validated business
 * identity the binding names; it is not taken from the reader payload.
 */
export function projectScienceFlowRunSnapshot(
  runId: string,
  snapshot: ScienceFlowRunSnapshot,
): ScienceFlowRunSnapshotDto {
  return {
    schemaVersion: SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION,
    run: {
      runId,
      status: publicStatus(snapshot.rawStatus),
      phase: publicPhase(snapshot.phase),
    },
    tasks: snapshot.tasks.map((task, index) => projectTask(task, index)),
    diagnostics: projectScienceFlowDiagnostics(snapshot.diagnostics),
  };
}

/** Project diagnostics for either a success or a failure response. */
export function projectScienceFlowDiagnostics(
  diagnostics: readonly ScienceFlowSnapshotDiagnostic[],
): readonly ScienceFlowSnapshotDiagnosticDto[] {
  return diagnostics.map((diagnostic) => {
    const rawCode: unknown = isRecord(diagnostic) ? diagnostic.code : undefined;
    const code: ScienceFlowPublicDiagnosticCode = isPublicDiagnosticCode(rawCode)
      ? rawCode
      : "other";
    return { code, description: DIAGNOSTIC_DESCRIPTIONS[code] };
  });
}

function projectTask(value: unknown, taskIndex: number): ScienceFlowTaskSnapshotDto {
  const task = isRecord(value) ? value : {};
  return {
    taskIndex,
    reportedMetric: projectReportedMetric(task.reportedBestMetric),
    candidate: projectCandidate(task.candidateArtifact),
  };
}

function projectReportedMetric(value: unknown): ScienceFlowReportedMetric | null {
  const metric = projectMetric(value);
  if (metric === null) return null;
  const source = isRecord(value) ? value.source : undefined;
  return {
    ...metric,
    source: isPublicMetricSource(source) ? source : "unknown",
  };
}

function projectCandidate(value: unknown): ScienceFlowCandidateSummary | null {
  if (!isRecord(value)) return null;
  const sha256 = value.sha256;
  // A candidate is only published when the reader hashed a real file; an
  // unparsable digest means there is no candidate summary to show.
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const digestVerified = value.digestVerified;
  const stageId = value.stageId;
  return {
    sha256,
    // Only an explicit boolean means the recorded digest was compared.
    digestVerified:
      typeof digestVerified === "boolean" ? digestVerified : null,
    metric: projectMetric(value),
    stageId:
      typeof stageId === "string" && stageId.trim().length > 0 ? stageId : null,
  };
}

/** Shared narrowing for the reported metric and the candidate's metric. */
function projectMetric(value: unknown): ScienceFlowPublicMetric | null {
  if (!isRecord(value)) return null;
  const metricName = value.metricName;
  const metricValue = value.metricValue;
  if (typeof metricName !== "string" || metricName.trim().length === 0) {
    return null;
  }
  if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
    return null;
  }
  const lowerIsBetter = value.lowerIsBetter;
  return {
    metricName,
    metricValue,
    // An absent or malformed direction stays "unknown", not "maximize".
    lowerIsBetter: typeof lowerIsBetter === "boolean" ? lowerIsBetter : null,
  };
}

function publicStatus(value: string | null): ScienceFlowPublicRunStatus {
  return isPublicRunStatus(value) ? value : "unknown";
}

function publicPhase(value: string | null): ScienceFlowPublicRunPhase {
  return isPublicRunPhase(value) ? value : "unknown";
}

function isPublicRunStatus(value: unknown): value is ScienceFlowPublicRunStatus {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_PUBLIC_RUN_STATUSES as readonly string[]).includes(value)
  );
}

function isPublicRunPhase(value: unknown): value is ScienceFlowPublicRunPhase {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_PUBLIC_RUN_PHASES as readonly string[]).includes(value)
  );
}

function isPublicMetricSource(
  value: unknown,
): value is ScienceFlowPublicMetricSource {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_PUBLIC_METRIC_SOURCES as readonly string[]).includes(value)
  );
}

function isPublicDiagnosticCode(
  value: unknown,
): value is ScienceFlowPublicDiagnosticCode {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_PUBLIC_DIAGNOSTIC_CODES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
