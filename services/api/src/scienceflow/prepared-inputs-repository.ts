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
 * Control-plane persistence for ScienceFlow prepared-input receipts.
 *
 * The table joins `catalog.sqlite` additively and keeps one latest receipt per
 * plan. Only the whitelisted result is stored: digests, the Runner's id, the
 * preparation time, and one role summary per enumerated file. Source bytes,
 * host paths, the Runner's storage layout, and raw manifest text never reach
 * this module.
 *
 * A row carries a monotonic generation. Every preparation reserves its
 * generation atomically before it contacts a Runner, then writes conditionally:
 * a row is only replaced by a strictly newer generation. A slower concurrent
 * request therefore cannot overwrite a newer fact, and its own result is
 * reported as superseded rather than saved. Both the reservation and the write
 * share one database lock with deletion, so a Session or Project removed while
 * a Runner call was in flight cannot be resurrected by the late receipt.
 * Every read re-validates the row: a corrupt or unknown-version record throws
 * instead of being skipped, repaired, or erased.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_INPUT_FILE_ROLES,
  SCIENCE_FLOW_INPUT_BUNDLE_LIMITS,
  SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
  isScienceFlowInputBundlePath,
  type ScienceFlowPreparedInputFileDto,
  type ScienceFlowPreparedInputsDto,
  type ScienceFlowPreparedInputsStateDto,
} from "@sciencediscovery/schema";

interface PreparedInputRow {
  plan_id: string;
  project_id: string;
  session_id: string;
  generation: number;
  prepared_at: string;
  record_json: string;
}

interface GenerationRow {
  plan_id: string;
  project_id: string;
  session_id: string;
  allocated: number;
}

/** A new receipt taken at `generation`, already reduced to public evidence. */
export interface ScienceFlowPreparedInputsDraft {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly prepared: ScienceFlowPreparedInputsDto;
}

/** One stored receipt and the generation it was written at. */
export interface ScienceFlowStoredPreparedInputs {
  readonly prepared: ScienceFlowPreparedInputsDto;
  readonly generation: number;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowPreparedInputsCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow prepared inputs are unreadable");
    this.name = "ScienceFlowPreparedInputsCorruptError";
  }
}

/** The subset of the repository the service and its tests use. */
export interface ScienceFlowPreparedInputsStore {
  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredPreparedInputs | undefined;
  /**
   * Reserve the next generation for one preparation, before any Runner call.
   * The reservation is durable, so a restart cannot hand out a generation that
   * is already in flight.
   */
  allocate(projectId: string, sessionId: string, planId: string): number;
  /**
   * Conditional write: the row is replaced only by a strictly newer
   * generation. Returns the row as it stands now, so a losing writer sees the
   * persisted winner instead of its own discarded result.
   */
  save(draft: ScienceFlowPreparedInputsDraft): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredPreparedInputs;
  };
  /** Removes every receipt owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void;
  /** Removes every receipt owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void;
}

export class ScienceFlowPreparedInputsRepository
  implements ScienceFlowPreparedInputsStore
{
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_prepared_inputs (
        plan_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        prepared_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS science_flow_prepared_inputs_session
        ON science_flow_prepared_inputs(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_prepared_inputs_project
        ON science_flow_prepared_inputs(project_id);
      CREATE TABLE IF NOT EXISTS science_flow_prepared_input_generations (
        plan_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        allocated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS science_flow_prepared_input_generations_session
        ON science_flow_prepared_input_generations(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_prepared_input_generations_project
        ON science_flow_prepared_input_generations(project_id);
    `);
  }

  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredPreparedInputs | undefined {
    const row = this.select(projectId, sessionId, planId);
    return row ? parseRow(row) : undefined;
  }

  /**
   * Reserve a generation inside one write transaction. The counter is seeded
   * by both the last allocation and the last stored row, so a backed-up table
   * cannot hand out a generation that is not strictly newer.
   */
  allocate(projectId: string, sessionId: string, planId: string): number {
    if (
      !isIdentityText(projectId) ||
      !isIdentityText(sessionId) ||
      !isIdentityText(planId)
    ) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const allocation = this.database
        .prepare(
          `SELECT plan_id, project_id, session_id, allocated
             FROM science_flow_prepared_input_generations
            WHERE plan_id = ?`,
        )
        .get(planId) as GenerationRow | undefined;
      let allocated = 0;
      if (allocation !== undefined) {
        if (
          allocation.plan_id !== planId ||
          allocation.project_id !== projectId ||
          allocation.session_id !== sessionId ||
          typeof allocation.allocated !== "number" ||
          !Number.isSafeInteger(allocation.allocated) ||
          allocation.allocated < 0
        ) {
          throw new ScienceFlowPreparedInputsCorruptError();
        }
        allocated = allocation.allocated;
      }
      const storedRow = this.select(projectId, sessionId, planId);
      const storedGeneration = storedRow ? parseRow(storedRow).generation : 0;
      const generation = Math.max(allocated, storedGeneration) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new ScienceFlowPreparedInputsCorruptError();
      }
      this.database
        .prepare(
          `INSERT INTO science_flow_prepared_input_generations
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

  save(draft: ScienceFlowPreparedInputsDraft): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredPreparedInputs;
  } {
    if (
      draft.prepared.planId.trim().length === 0 ||
      draft.prepared.schemaVersion !== SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION ||
      draft.generation !== draft.prepared.generation ||
      !Number.isSafeInteger(draft.generation) ||
      draft.generation < 1
    ) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    // Share a write lock with deletion from validation through the returned
    // snapshot, so a late receipt cannot insert after a delete commits.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const allocation = this.database
        .prepare(
          `SELECT plan_id, project_id, session_id, allocated
             FROM science_flow_prepared_input_generations
            WHERE plan_id = ?`,
        )
        .get(draft.prepared.planId) as GenerationRow | undefined;
      // Only a generation this plan actually issued may be written. After a
      // Session/Project delete removed the allocations, a preparation still in
      // flight cannot insert a row back into an empty table.
      if (
        allocation === undefined ||
        allocation.plan_id !== draft.prepared.planId ||
        allocation.project_id !== draft.projectId ||
        allocation.session_id !== draft.sessionId ||
        typeof allocation.allocated !== "number" ||
        !Number.isSafeInteger(allocation.allocated) ||
        draft.generation > allocation.allocated
      ) {
        this.database.exec("COMMIT");
        return { saved: false };
      }
      const record = JSON.stringify(reducePrepared(draft.prepared));
      const result = this.database
        .prepare(
          `INSERT INTO science_flow_prepared_inputs
             (plan_id, project_id, session_id, generation, prepared_at, record_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(plan_id) DO UPDATE SET
             generation = excluded.generation,
             prepared_at = excluded.prepared_at,
             record_json = excluded.record_json
           WHERE excluded.generation > science_flow_prepared_inputs.generation
             AND science_flow_prepared_inputs.project_id = excluded.project_id
             AND science_flow_prepared_inputs.session_id = excluded.session_id`,
        )
        .run(
          draft.prepared.planId,
          draft.projectId,
          draft.sessionId,
          draft.generation,
          draft.prepared.preparedAt,
          record,
        );
      const saved = Number(result.changes) === 1;
      const row = this.select(
        draft.projectId,
        draft.sessionId,
        draft.prepared.planId,
      );
      const outcome = row ? { saved, stored: parseRow(row) } : { saved };
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM science_flow_prepared_inputs WHERE session_id = ?")
        .run(sessionId);
      this.database
        .prepare(
          "DELETE FROM science_flow_prepared_input_generations WHERE session_id = ?",
        )
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
        .prepare("DELETE FROM science_flow_prepared_inputs WHERE project_id = ?")
        .run(projectId);
      this.database
        .prepare(
          "DELETE FROM science_flow_prepared_input_generations WHERE project_id = ?",
        )
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
  ): PreparedInputRow | undefined {
    return this.database
      .prepare(
        `SELECT plan_id, project_id, session_id, generation, prepared_at, record_json
           FROM science_flow_prepared_inputs
          WHERE plan_id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(planId, projectId, sessionId) as PreparedInputRow | undefined;
  }
}

/** The read answer: the latest stored receipt, or none performed yet. */
export function preparedInputsState(
  planId: string,
  stored: ScienceFlowStoredPreparedInputs | undefined,
): ScienceFlowPreparedInputsStateDto {
  return Object.freeze({ planId, prepared: stored?.prepared ?? null });
}

/** The reduced record actually stored. */
type StoredPreparedInputs = {
  readonly contractDigest: string;
  readonly bundleDigest: string;
  readonly runnerId: string;
  readonly preparedAt: string;
  readonly outcome: "prepared";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly ScienceFlowPreparedInputFileDto[];
};

function reducePrepared(
  prepared: ScienceFlowPreparedInputsDto,
): StoredPreparedInputs {
  return {
    contractDigest: prepared.contractDigest,
    bundleDigest: prepared.bundleDigest,
    runnerId: prepared.runnerId,
    preparedAt: prepared.preparedAt,
    outcome: "prepared",
    fileCount: prepared.fileCount,
    totalBytes: prepared.totalBytes,
    files: prepared.files.map(({ role, path, size, sha256 }) => ({
      role,
      path,
      size,
      sha256,
    })),
  };
}

function parseRow(row: PreparedInputRow): ScienceFlowStoredPreparedInputs {
  if (
    typeof row.plan_id !== "string" ||
    row.plan_id.trim().length === 0 ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const value = parseJson(row.record_json);
  if (!isRecord(value)) throw new ScienceFlowPreparedInputsCorruptError();
  const preparedAt = value.preparedAt;
  if (
    typeof preparedAt !== "string" ||
    preparedAt.trim().length === 0 ||
    preparedAt !== row.prepared_at
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const contractDigest = value.contractDigest;
  const bundleDigest = value.bundleDigest;
  if (!isDigest(contractDigest) || !isDigest(bundleDigest)) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const runnerId = value.runnerId;
  if (!isIdentityText(runnerId)) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  if (value.outcome !== "prepared") {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const files = parseFiles(value.files);
  const fileCount = value.fileCount;
  const totalBytes = value.totalBytes;
  if (
    typeof fileCount !== "number" ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 1 ||
    fileCount > SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxFiles ||
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  // The summary must still describe the role list it was stored with: distinct
  // byte sets and their total, not a second opinion.
  const sizes = new Map<string, number>();
  for (const file of files) {
    const existing = sizes.get(file.path);
    if (existing !== undefined && existing !== file.size) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    sizes.set(file.path, file.size);
  }
  if (
    sizes.size !== fileCount ||
    [...sizes.values()].reduce((total, size) => total + size, 0) !== totalBytes
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }

  const prepared: ScienceFlowPreparedInputsDto = Object.freeze({
    schemaVersion: SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
    planId: row.plan_id,
    contractDigest,
    bundleDigest,
    runnerId,
    preparedAt,
    outcome: "prepared" as const,
    canStart: false as const,
    fileCount,
    totalBytes,
    files,
    generation: row.generation,
  });
  return Object.freeze({ prepared, generation: row.generation });
}

function parseFiles(
  value: unknown,
): readonly ScienceFlowPreparedInputFileDto[] {
  if (!Array.isArray(value)) throw new ScienceFlowPreparedInputsCorruptError();
  const roles = new Set<string>();
  const files = value.map((entry: unknown): ScienceFlowPreparedInputFileDto => {
    if (!isRecord(entry)) throw new ScienceFlowPreparedInputsCorruptError();
    const role = entry.role;
    const path = entry.path;
    const size = entry.size;
    const sha256 = entry.sha256;
    if (
      typeof role !== "string" ||
      !(SCIENCE_FLOW_INPUT_FILE_ROLES as readonly string[]).includes(role) ||
      roles.has(role) ||
      !isScienceFlowInputBundlePath(path) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxEntryBytes ||
      !isDigest(sha256)
    ) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    roles.add(role);
    return Object.freeze({
      role: role as ScienceFlowPreparedInputFileDto["role"],
      path,
      size,
      sha256,
    });
  });
  return Object.freeze(files);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
