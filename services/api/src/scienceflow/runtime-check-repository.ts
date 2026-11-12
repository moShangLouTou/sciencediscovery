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
 * A row carries a monotonic generation. Every check reserves its generation
 * atomically before it contacts a Runner, then writes conditionally: a row is
 * only replaced by a strictly newer generation. A slower concurrent check
 * therefore cannot overwrite a newer fact, and its own result is reported as
 * superseded rather than saved. A check that fails after reserving leaves the
 * prior row untouched as history.
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

interface GenerationRow {
  plan_id: string;
  project_id: string;
  session_id: string;
  allocated: number;
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
   * Reserve the next generation for one check, before any Runner call. Two
   * overlapping requests get distinct integers; the reservation is durable, so
   * a restart cannot hand out a generation that is already in flight.
   */
  allocate(projectId: string, sessionId: string, planId: string): number;
  /**
   * Conditional write: the row is replaced only by a strictly newer
   * generation. Returns the row as it stands now, so a losing writer sees the
   * persisted winner instead of its own discarded result.
   */
  save(draft: ScienceFlowRuntimeCheckDraft): {
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
      CREATE TABLE IF NOT EXISTS science_flow_runtime_check_generations (
        plan_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        allocated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS science_flow_runtime_check_generations_session
        ON science_flow_runtime_check_generations(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_runtime_check_generations_project
        ON science_flow_runtime_check_generations(project_id);
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

  /**
   * Reserve a generation inside one write transaction.
   *
   * The counter is seeded by both the last allocation and the last stored row,
   * so a row written before this table existed (or a table restored from a
   * backup) cannot hand out a generation that is not strictly newer. Allocation
   * happens before the await, so overlapping requests cannot read the same
   * "latest" and both claim the next integer.
   */
  allocate(projectId: string, sessionId: string, planId: string): number {
    if (
      !isIdentityText(projectId) ||
      !isIdentityText(sessionId) ||
      !isIdentityText(planId)
    ) {
      throw new ScienceFlowRuntimeCheckCorruptError();
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const allocation = this.database
        .prepare(
          `SELECT plan_id, project_id, session_id, allocated
             FROM science_flow_runtime_check_generations
            WHERE plan_id = ?`,
        )
        .get(planId) as GenerationRow | undefined;
      let allocated = 0;
      if (allocation !== undefined) {
        // A generation row that names a different owner is corruption, not a
        // counter to trust.
        if (
          allocation.plan_id !== planId ||
          allocation.project_id !== projectId ||
          allocation.session_id !== sessionId ||
          typeof allocation.allocated !== "number" ||
          !Number.isSafeInteger(allocation.allocated) ||
          allocation.allocated < 0
        ) {
          throw new ScienceFlowRuntimeCheckCorruptError();
        }
        allocated = allocation.allocated;
      }
      const storedRow = this.select(projectId, sessionId, planId);
      const storedGeneration = storedRow ? parseRow(storedRow).generation : 0;
      const generation = Math.max(allocated, storedGeneration) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new ScienceFlowRuntimeCheckCorruptError();
      }
      this.database
        .prepare(
          `INSERT INTO science_flow_runtime_check_generations
             (plan_id, project_id, session_id, allocated)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(plan_id) DO UPDATE SET
             project_id = excluded.project_id,
             session_id = excluded.session_id,
             allocated = excluded.allocated`,
        )
        .run(planId, projectId, sessionId, generation);
      this.database.exec("COMMIT");
      return generation;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve the original error */
      }
      throw error;
    }
  }

  save(draft: ScienceFlowRuntimeCheckDraft): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredRuntimeCheck;
  } {
    if (
      draft.check.planId.trim().length === 0 ||
      draft.check.schemaVersion !== SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION ||
      draft.generation !== draft.check.generation ||
      !Number.isSafeInteger(draft.generation) ||
      draft.generation < 1
    ) {
      throw new ScienceFlowRuntimeCheckCorruptError();
    }
    // Only a generation this plan actually issued may be written. Once the
    // Session/Project delete removed the allocations, a check that was still in
    // flight cannot insert a row back into an empty table.
    const allocation = this.database
      .prepare(
        `SELECT plan_id, project_id, session_id, allocated
           FROM science_flow_runtime_check_generations
          WHERE plan_id = ?`,
      )
      .get(draft.check.planId) as GenerationRow | undefined;
    if (
      allocation === undefined ||
      allocation.plan_id !== draft.check.planId ||
      allocation.project_id !== draft.projectId ||
      allocation.session_id !== draft.sessionId ||
      typeof allocation.allocated !== "number" ||
      !Number.isSafeInteger(allocation.allocated) ||
      draft.generation > allocation.allocated
    ) {
      return { saved: false };
    }
    const record = JSON.stringify(reduceCheck(draft.check));
    const result = this.database
      .prepare(
        `INSERT INTO science_flow_runtime_checks
           (plan_id, project_id, session_id, generation, checked_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET
           generation = excluded.generation,
           checked_at = excluded.checked_at,
           record_json = excluded.record_json
         WHERE excluded.generation > science_flow_runtime_checks.generation
           AND science_flow_runtime_checks.project_id = excluded.project_id
           AND science_flow_runtime_checks.session_id = excluded.session_id`,
      )
      .run(
        draft.check.planId,
        draft.projectId,
        draft.sessionId,
        draft.generation,
        draft.check.checkedAt,
        record,
      );
    const saved = Number(result.changes) === 1;
    const row = this.select(draft.projectId, draft.sessionId, draft.check.planId);
    // A missed write can mean a newer check already won, or that the owning
    // Session was deleted while the check ran. The caller distinguishes them
    // by whether a row is still there.
    return row ? { saved, stored: parseRow(row) } : { saved };
  }

  deleteSession(sessionId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM science_flow_runtime_checks WHERE session_id = ?")
        .run(sessionId);
      this.database
        .prepare("DELETE FROM science_flow_runtime_check_generations WHERE session_id = ?")
        .run(sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve the original error */
      }
      throw error;
    }
  }

  deleteProject(projectId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM science_flow_runtime_checks WHERE project_id = ?")
        .run(projectId);
      this.database
        .prepare("DELETE FROM science_flow_runtime_check_generations WHERE project_id = ?")
        .run(projectId);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve the original error */
      }
      throw error;
    }
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
