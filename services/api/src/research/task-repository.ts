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
 * Durable, engine-neutral persistence for accepted research operations.
 *
 * The repository owns the SQLite table, the identity columns, insert-if-absent
 * deduplication and corruption checks. A product supplies a `codec` that
 * validates its own record fields; the shared modules never inspect them. The
 * table name is a composition parameter so an existing product table can be
 * reused in place instead of creating a second ledger that could disagree with
 * the first.
 *
 * A service rebuild reads the same rows, so observation, cancellation and
 * delivery retry do not depend on an in-memory task object.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  ResearchOperationCorruptError,
  type ResearchOperationCodec,
  type ResearchOperationRowIdentity,
  type ResearchTaskRecord,
} from "./task-record.js";

interface StoredRow {
  id: string;
  project_id: string;
  session_id: string;
  owner_run_id: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  record_json: string;
}

/** The persistence surface the shared task service needs. */
export interface ResearchTaskStore<Record extends ResearchTaskRecord> {
  createIfAbsent(record: Record): { readonly created: boolean; readonly record: Record };
  get(operationId: string): Record | undefined;
  findByIdempotency(projectId: string, sessionId: string, idempotencyKey: string): Record | undefined;
  listForSession(projectId: string, sessionId: string): Record[];
  update(record: Record): void;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

export interface ResearchTaskRepositoryOptions<Record extends ResearchTaskRecord> {
  /** A validated SQL identifier; the default is the shared table. */
  readonly table?: string;
  readonly codec: ResearchOperationCodec<Record>;
}

const DEFAULT_TABLE = "research_task_operations";

/**
 * Persistence for one product's operation records over an existing SQLite
 * database. Creating the table is additive: an older data directory upgrades in
 * place, and an existing table with the same columns is reused as-is.
 */
export class ResearchTaskRepository<Record extends ResearchTaskRecord> implements ResearchTaskStore<Record> {
  private readonly table: string;
  private readonly codec: ResearchOperationCodec<Record>;

  constructor(
    readonly database: DatabaseSync,
    options: ResearchTaskRepositoryOptions<Record>,
  ) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(table)) {
      throw new TypeError("The research task table name is not a safe SQL identifier");
    }
    this.table = table;
    this.codec = options.codec;
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
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
      CREATE INDEX IF NOT EXISTS ${table}_session ON ${table}(session_id);
      CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(project_id);
    `);
  }

  /**
   * Insert-or-return-existing keyed by the business idempotency key. The insert
   * and the read-back run synchronously on one connection, so concurrent starts
   * of the same accepted request cannot split them.
   */
  createIfAbsent(record: Record): { readonly created: boolean; readonly record: Record } {
    const result = this.database
      .prepare(
        `INSERT INTO ${this.table}
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
        JSON.stringify(this.codec.encode(record)),
      );
    if (result.changes === 1) return { created: true, record: structuredClone(record) };
    const existing = this.findByIdempotency(
      record.identity.projectId,
      record.identity.sessionId,
      record.idempotencyKey,
    );
    if (!existing) throw new ResearchOperationCorruptError();
    return { created: false, record: existing };
  }

  get(operationId: string): Record | undefined {
    const row = this.database
      .prepare(`SELECT * FROM ${this.table} WHERE id = ?`)
      .get(operationId) as StoredRow | undefined;
    return row ? this.parseRow(row) : undefined;
  }

  findByIdempotency(
    projectId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Record | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM ${this.table}
          WHERE project_id = ? AND session_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, sessionId, idempotencyKey) as StoredRow | undefined;
    return row ? this.parseRow(row) : undefined;
  }

  listForSession(projectId: string, sessionId: string): Record[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM ${this.table}
          WHERE project_id = ? AND session_id = ?
          ORDER BY created_at, id`,
      )
      .all(projectId, sessionId) as unknown as StoredRow[];
    return rows.map((row) => this.parseRow(row));
  }

  /** Replace a record's observed state. The identity columns never change. */
  update(record: Record): void {
    const result = this.database
      .prepare(
        `UPDATE ${this.table}
            SET updated_at = ?, record_json = ?
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .run(
        record.updatedAt,
        JSON.stringify(this.codec.encode(record)),
        record.operationId,
        record.identity.projectId,
        record.identity.sessionId,
      );
    if (result.changes !== 1) throw new ResearchOperationCorruptError();
  }

  deleteSession(sessionId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE session_id = ?`).run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE project_id = ?`).run(projectId);
  }

  private parseRow(row: StoredRow): Record {
    let value: unknown;
    try {
      value = JSON.parse(row.record_json);
    } catch {
      throw new ResearchOperationCorruptError();
    }
    const identity: ResearchOperationRowIdentity = {
      createdAt: row.created_at,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      ownerRunId: row.owner_run_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      updatedAt: row.updated_at,
    };
    return this.codec.decode(value, identity);
  }
}
