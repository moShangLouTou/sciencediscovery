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
 * Control-plane persistence for a prepared task's preflight result.
 *
 * A contract artifact is ordinary Session data, and the Agent can append a new
 * version of it through the normal artifact tools. Its `probes` array is
 * therefore evidence a caller can copy into an edited contract, not proof that
 * those exact evaluator bytes were ever probed. This table is the trusted
 * side: preparation records the validation keyed by the *contract version id*
 * the store assigned, together with every identity the probe covered. A start
 * re-reads that row and requires it to agree with the contract it is about to
 * run, so a normally edited contract version cannot inherit an older probe.
 *
 * The table joins `catalog.sqlite` additively; a record is immutable once
 * written. Reads re-validate the row and throw instead of repairing it.
 */
import type { DatabaseSync } from "node:sqlite";
import { ResearchVersionRepository } from "../research/version-repository.js";

import type {
  PreparedTaskInputBinding,
  PreparedTaskProbe,
} from "./local-research-task.js";

/** The only validation record version this module writes and reads. */
export const PREPARED_TASK_VALIDATION_VERSION = 1;

/**
 * What one accepted probe proved, bound to the exact version identities it
 * ran against. Paths and evaluator bytes stay out; digests are enough.
 */
export interface PreparedTaskValidation {
  readonly schemaVersion: typeof PREPARED_TASK_VALIDATION_VERSION;
  readonly contractVersionId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly contractHash: string;
  readonly taskId: string;
  readonly evaluator: {
    readonly sha256: string;
    readonly size: number;
    readonly versionId: string;
  };
  readonly metric: {
    readonly name: string;
    readonly lowerIsBetter: boolean;
    readonly jsonPath: string;
  };
  readonly artifact: {
    readonly path: string;
    readonly kind: string;
  };
  readonly inputs: readonly PreparedTaskInputBinding[];
  readonly probes: readonly PreparedTaskProbe[];
  readonly recordedAt: string;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class PreparedTaskValidationCorruptError extends Error {
  constructor() {
    super("Stored prepared task validation is unreadable");
    this.name = "PreparedTaskValidationCorruptError";
  }
}

/** The subset the task service and its tests use. */
export interface PreparedTaskValidationStore {
  /** Record one accepted validation. The same id and body is a no-op. */
  record(validation: PreparedTaskValidation): void;
  get(projectId: string, contractVersionId: string): PreparedTaskValidation | undefined;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

interface ValidationRow {
  contract_version_id: string;
  project_id: string;
  session_id: string;
  recorded_at: string;
  record_json: string;
}

export class PreparedTaskValidationRepository extends ResearchVersionRepository<PreparedTaskValidation> implements PreparedTaskValidationStore {
  constructor(database: DatabaseSync) {
    super(database, { table: "science_flow_prepared_task_validations", keyColumn: "contract_version_id",
      identity: (record) => ({ versionId: record.contractVersionId, projectId: record.projectId,
        sessionId: record.sessionId, recordedAt: record.recordedAt }),
      decode: (value, identity) => parseRow({ contract_version_id: identity.versionId,
        project_id: identity.projectId, session_id: identity.sessionId, recorded_at: identity.recordedAt,
        record_json: JSON.stringify(value) }),
      corrupt: () => new PreparedTaskValidationCorruptError(),
    });
  }
}

function parseRow(row: ValidationRow): PreparedTaskValidation {
  let value: unknown;
  try {
    value = JSON.parse(row.record_json);
  } catch {
    throw new PreparedTaskValidationCorruptError();
  }
  if (!isRecord(value) || value.schemaVersion !== PREPARED_TASK_VALIDATION_VERSION) {
    throw new PreparedTaskValidationCorruptError();
  }
  if (
    value.contractVersionId !== row.contract_version_id
    || value.projectId !== row.project_id
    || value.sessionId !== row.session_id
    || value.recordedAt !== row.recorded_at
    || typeof value.contractHash !== "string"
    || typeof value.taskId !== "string"
    || !isRecord(value.evaluator)
    || typeof value.evaluator.sha256 !== "string"
    || typeof value.evaluator.versionId !== "string"
    || typeof value.evaluator.size !== "number"
    || !isRecord(value.metric)
    || typeof value.metric.name !== "string"
    || typeof value.metric.lowerIsBetter !== "boolean"
    || typeof value.metric.jsonPath !== "string"
    || !isRecord(value.artifact)
    || typeof value.artifact.path !== "string"
    || typeof value.artifact.kind !== "string"
    || !Array.isArray(value.inputs)
    || !Array.isArray(value.probes)
  ) {
    throw new PreparedTaskValidationCorruptError();
  }
  return value as unknown as PreparedTaskValidation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
