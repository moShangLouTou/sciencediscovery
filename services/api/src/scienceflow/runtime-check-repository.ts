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
 * Control-plane persistence for ScienceFlow runtime identity checks.
 *
 * The table joins `catalog.sqlite` additively and keeps one latest row per plan.
 * Only the whitelisted result is stored: fixed codes and statuses, identities,
 * digests, and the observation time. Host paths, `sys.path` entries, Git output,
 * stderr, and interpreter details never reach this module.
 *
 * A row carries a monotonic generation. A check takes the next generation when
 * it starts and writes conditionally on the generation it observed, so a slower
 * concurrent check can never replace a newer one; the loser reads the winner.
 * Every read re-validates the row and rebuilds its descriptions; a corrupt row
 * throws rather than being skipped, repaired, or erased.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
  type ScienceFlowRuntimeCheckDto,
  type ScienceFlowRuntimeCheckStateDto,
  type ScienceFlowRuntimeSourceKind,
} from "@sciencediscovery/schema";

import {
  canonicalRuntimeChecks,
  isScienceFlowRuntimeSourceKind,
  isVerifiedRuntimeCheck,
  runtimeCheckChecksDto,
  SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
} from "./runtime-check-dto.js";

interface RuntimeCheckRow {
  plan_id: string;
  project_id: string;
  session_id: string;
  generation: number;
  checked_at: string;
  record_json: string;
}

/** A new check taken at `generation`, already reduced to public evidence. */
export interface ScienceFlowRuntimeCheckDraft {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly check: ScienceFlowRuntimeCheckDto;
}

/** One stored check and the generation it was written at. */
export interface ScienceFlowStoredRuntimeCheck {
  readonly check: ScienceFlowRuntimeCheckDto;
  readonly generation: number;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowRuntimeCheckCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow runtime check is unreadable");
    this.name = "ScienceFlowRuntimeCheckCorruptError";
  }
}

/** The subset of the repository the service and its tests use. */
export interface ScienceFlowRuntimeCheckStore {
  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredRuntimeCheck | undefined;
  /**
   * Conditional write: only the caller that observed `expectedGeneration` may
   * replace it. Returns the row as it stands now, so a losing writer sees the
   * persisted winner instead of its discarded result.
   */
  save(
    draft: ScienceFlowRuntimeCheckDraft,
    expectedGeneration: number,
  ): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredRuntimeCheck;
  };
  /** Removes every check owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void;
  /** Removes every check owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void;
}

export class ScienceFlowRuntimeCheckRepository
  implements ScienceFlowRuntimeCheckStore
{
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_runtime_checks (
        plan_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS science_flow_runtime_checks_session
        ON science_flow_runtime_checks(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_runtime_checks_project
        ON science_flow_runtime_checks(project_id);
    `);
  }

  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredRuntimeCheck | undefined {
    const row = this.select(projectId, sessionId, planId);
    return row ? parseRow(row) : undefined;
  }

  save(
    draft: ScienceFlowRuntimeCheckDraft,
    expectedGeneration: number,
  ): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredRuntimeCheck;
  } {
    if (
      draft.check.planId.trim().length === 0 ||
      draft.check.schemaVersion !== SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION ||
      draft.generation !== draft.check.generation ||
      draft.generation !== expectedGeneration + 1
    ) {
      throw new ScienceFlowRuntimeCheckCorruptError();
    }
    const record = JSON.stringify(reduceCheck(draft.check));
    const result =
      expectedGeneration === 0
        ? this.database
            .prepare(
              `INSERT INTO science_flow_runtime_checks
                 (plan_id, project_id, session_id, generation, checked_at, record_json)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(plan_id) DO NOTHING`,
            )
            .run(
              draft.check.planId,
              draft.projectId,
              draft.sessionId,
              draft.generation,
              draft.check.checkedAt,
              record,
            )
        : this.database
            .prepare(
              `UPDATE science_flow_runtime_checks
                  SET generation = ?, checked_at = ?, record_json = ?
                WHERE plan_id = ? AND project_id = ? AND session_id = ?
                  AND generation = ?`,
            )
            .run(
              draft.generation,
              draft.check.checkedAt,
              record,
              draft.check.planId,
              draft.projectId,
              draft.sessionId,
              expectedGeneration,
            );
    const saved = Number(result.changes) === 1;
    if (expectedGeneration === 0 && !saved) {
      // A concurrent insert won. The row must be there; a missing one means the
      // table is unreadable, not that this check failed.
      const row = this.select(draft.projectId, draft.sessionId, draft.check.planId);
      if (!row) throw new ScienceFlowRuntimeCheckCorruptError();
      return { saved: false, stored: parseRow(row) };
    }
    const row = this.select(draft.projectId, draft.sessionId, draft.check.planId);
    // A missed update can mean the owning Session was deleted while the check
    // ran. That is a discarded result, not a stored one.
    return row ? { saved, stored: parseRow(row) } : { saved };
  }

  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_runtime_checks WHERE session_id = ?")
      .run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_runtime_checks WHERE project_id = ?")
      .run(projectId);
  }

  private select(
    projectId: string,
    sessionId: string,
    planId: string,
  ): RuntimeCheckRow | undefined {
    return this.database
      .prepare(
        `SELECT plan_id, project_id, session_id, generation, checked_at, record_json
           FROM science_flow_runtime_checks
          WHERE plan_id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(planId, projectId, sessionId) as RuntimeCheckRow | undefined;
  }
}

/** The read answer: the latest stored check, or none performed yet. */
export function runtimeCheckState(
  planId: string,
  stored: ScienceFlowStoredRuntimeCheck | undefined,
): ScienceFlowRuntimeCheckStateDto {
  return Object.freeze({ planId, check: stored?.check ?? null });
}

/** The reduced record actually stored: descriptions are rebuilt on read. */
type StoredRuntimeCheck = {
  readonly contractDigest: string;
  readonly bindingDigest: string;
  readonly runnerId: string;
  readonly environmentId: string;
  readonly environmentRevisionId: string | null;
  readonly checkedAt: string;
  readonly outcome: "verified" | "blocked";
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  readonly sourceRevision: string | null;
  readonly checks: readonly {
    readonly code: ScienceFlowRuntimeCheckDto["checks"][number]["code"];
    readonly status: ScienceFlowRuntimeCheckDto["checks"][number]["status"];
  }[];
};

function reduceCheck(check: ScienceFlowRuntimeCheckDto): StoredRuntimeCheck {
  return {
    contractDigest: check.contractDigest,
    bindingDigest: check.bindingDigest,
    runnerId: check.runnerId,
    environmentId: check.environmentId,
    environmentRevisionId: check.environmentRevisionId,
    checkedAt: check.checkedAt,
    outcome: check.outcome,
    sourceKind: check.sourceKind,
    sourceRevision: check.sourceRevision,
    checks: check.checks.map(({ code, status }) => ({ code, status })),
  };
}

function parseRow(row: RuntimeCheckRow): ScienceFlowStoredRuntimeCheck {
  if (
    typeof row.plan_id !== "string" ||
    row.plan_id.trim().length === 0 ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const value = parseJson(row.record_json);
  if (!isRecord(value)) throw new ScienceFlowRuntimeCheckCorruptError();
  const checkedAt = value.checkedAt;
  if (
    typeof checkedAt !== "string" ||
    checkedAt.trim().length === 0 ||
    checkedAt !== row.checked_at
  ) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const contractDigest = value.contractDigest;
  const bindingDigest = value.bindingDigest;
  if (!isDigest(contractDigest) || !isDigest(bindingDigest)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const runnerId = value.runnerId;
  const environmentId = value.environmentId;
  if (!isIdentityText(runnerId) || !isIdentityText(environmentId)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const environmentRevisionId = value.environmentRevisionId;
  if (
    environmentRevisionId !== null &&
    !isIdentityText(environmentRevisionId)
  ) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const sourceRevision = value.sourceRevision;
  if (sourceRevision !== null && !isRevision(sourceRevision)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const outcome = value.outcome;
  if (outcome !== "verified" && outcome !== "blocked") {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const sourceKind = value.sourceKind;
  if (!isScienceFlowRuntimeSourceKind(sourceKind)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const checks = canonicalRuntimeChecks(value.checks);
  if (checks === null) throw new ScienceFlowRuntimeCheckCorruptError();
  // The stored outcome must still follow from the stored checks; a row that
  // says `verified` while carrying a non-passing check is corrupt.
  if (isVerifiedRuntimeCheck(checks) !== (outcome === "verified")) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const check: ScienceFlowRuntimeCheckDto = Object.freeze({
    schemaVersion: SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
    planId: row.plan_id,
    contractDigest,
    bindingDigest,
    runnerId,
    environmentId,
    environmentRevisionId,
    checkedAt,
    outcome,
    canStart: false as const,
    sourceKind,
    sourceRevision,
    checks: runtimeCheckChecksDto(checks),
    unknowns: SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
    generation: row.generation,
  });
  return Object.freeze({ check, generation: row.generation });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
