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
 * Control-plane persistence for experimental local research operations.
 *
 * A conversation tool starts a real engine run that outlives the tool call, so
 * the operation's identity, frozen launch facts and latest observed state have
 * to survive a service rebuild. The table lives in the API's existing
 * `catalog.sqlite`; creating it is additive, so an older data directory upgrades
 * in place. Reads re-validate the stored record: a corrupt or unknown-version
 * row throws instead of being skipped or erased.
 *
 * This is not a general job platform: one row per owned experiment, keyed by an
 * idempotency key derived from the accepted start request.
 */
import type { DatabaseSync } from "node:sqlite";

import { SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION, type ScienceFlowLocalResearchOperation } from "./local-research-record.js";

interface OperationRow {
  id: string;
  project_id: string;
  session_id: string;
  owner_run_id: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  record_json: string;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowLocalResearchCorruptError extends Error {
  constructor() {
    super("Stored local research operation is unreadable");
    this.name = "ScienceFlowLocalResearchCorruptError";
  }
}

/** The subset the service needs (and tests stub). */
export interface ScienceFlowLocalResearchStore {
  createIfAbsent(record: ScienceFlowLocalResearchOperation): {
    readonly created: boolean;
    readonly record: ScienceFlowLocalResearchOperation;
  };
  get(operationId: string): ScienceFlowLocalResearchOperation | undefined;
  findByIdempotency(
    projectId: string,
    sessionId: string,
    idempotencyKey: string,
  ): ScienceFlowLocalResearchOperation | undefined;
  listForSession(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation[];
  update(record: ScienceFlowLocalResearchOperation): void;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

export class ScienceFlowLocalResearchRepository implements ScienceFlowLocalResearchStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_local_research_operations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        owner_run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(project_id, session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS science_flow_local_research_operations_session
        ON science_flow_local_research_operations(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_local_research_operations_project
        ON science_flow_local_research_operations(project_id);
    `);
  }

  /**
   * Insert-or-return-existing, keyed by the business idempotency key. The insert
   * and the read-back happen synchronously on one connection, so two concurrent
   * starts of the same accepted request cannot split them.
   */
  createIfAbsent(record: ScienceFlowLocalResearchOperation): {
    readonly created: boolean;
    readonly record: ScienceFlowLocalResearchOperation;
  } {
    const result = this.database
      .prepare(
        `INSERT INTO science_flow_local_research_operations
           (id, project_id, session_id, owner_run_id, idempotency_key, created_at, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, idempotency_key) DO NOTHING`,
      )
      .run(
        record.operationId,
        record.identity.projectId,
        record.identity.sessionId,
        record.ownerRunId,
        record.idempotencyKey,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      );
    if (result.changes === 1) return { created: true, record: structuredClone(record) };
    const existing = this.findByIdempotency(
      record.identity.projectId,
      record.identity.sessionId,
      record.idempotencyKey,
    );
    if (!existing) throw new ScienceFlowLocalResearchCorruptError();
    return { created: false, record: existing };
  }

  get(operationId: string): ScienceFlowLocalResearchOperation | undefined {
    const row = this.database
      .prepare("SELECT * FROM science_flow_local_research_operations WHERE id = ?")
      .get(operationId) as OperationRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  findByIdempotency(
    projectId: string,
    sessionId: string,
    idempotencyKey: string,
  ): ScienceFlowLocalResearchOperation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM science_flow_local_research_operations
          WHERE project_id = ? AND session_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, sessionId, idempotencyKey) as OperationRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  listForSession(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM science_flow_local_research_operations
          WHERE project_id = ? AND session_id = ?
          ORDER BY created_at, id`,
      )
      .all(projectId, sessionId) as unknown as OperationRow[];
    return rows.map(parseRow);
  }

  /** Replace a record's observed state. The identity columns never change. */
  update(record: ScienceFlowLocalResearchOperation): void {
    const result = this.database
      .prepare(
        `UPDATE science_flow_local_research_operations
            SET updated_at = ?, record_json = ?
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .run(record.updatedAt, JSON.stringify(record), record.operationId,
        record.identity.projectId, record.identity.sessionId);
    if (result.changes !== 1) throw new ScienceFlowLocalResearchCorruptError();
  }

  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_local_research_operations WHERE session_id = ?")
      .run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_local_research_operations WHERE project_id = ?")
      .run(projectId);
  }
}

function parseRow(row: OperationRow): ScienceFlowLocalResearchOperation {
  let value: unknown;
  try {
    value = JSON.parse(row.record_json);
  } catch {
    throw new ScienceFlowLocalResearchCorruptError();
  }
  if (!isRecord(value) || value.schemaVersion !== SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION) {
    throw new ScienceFlowLocalResearchCorruptError();
  }
  if (
    value.operationId !== row.id
    || !isRecord(value.identity)
    || value.identity.projectId !== row.project_id
    || value.identity.sessionId !== row.session_id
    || value.ownerRunId !== row.owner_run_id
    || value.idempotencyKey !== row.idempotency_key
    || value.createdAt !== row.created_at
    || value.updatedAt !== row.updated_at
  ) {
    throw new ScienceFlowLocalResearchCorruptError();
  }
  return value as unknown as ScienceFlowLocalResearchOperation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
