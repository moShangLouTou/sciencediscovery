// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export interface ResearchGenerationIdentity {
  readonly key: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly recordedAt: string;
}
export interface ResearchGenerationDraft<T> extends ResearchGenerationIdentity {
  readonly record: T;
}
export interface ResearchGenerationSnapshot<T> {
  readonly record: T;
  readonly generation: number;
}
export class ResearchGenerationCorruptError extends Error {
  constructor() {
    super("Stored research observation or generation is unreadable");
    this.name = "ResearchGenerationCorruptError";
  }
}

/** Latest observations with durable generations and deletion-safe conditional writes.
 * Products own the payload codec; legacy table and column names remain intact.
 * Allocate before awaiting external work, then save with that generation.
 */
export class ResearchGenerationRepository<T> {
  private readonly keyColumn: string;
  private readonly timeColumn: string;
  constructor(readonly database: DatabaseSync, private readonly options: {
    readonly table: string;
    readonly generationsTable: string;
    readonly keyColumn?: string;
    readonly timeColumn?: string;
    encode(record: T): unknown;
    decode(value: unknown, identity: ResearchGenerationIdentity): T;
    corrupt?(): Error;
  }) {
    this.keyColumn = options.keyColumn ?? "observation_id";
    this.timeColumn = options.timeColumn ?? "recorded_at";
    for (const name of [options.table, options.generationsTable, this.keyColumn, this.timeColumn]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new TypeError("Unsafe research generation SQL identifier");
    }
    const { table, generationsTable } = options;
    database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      ${this.keyColumn} TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      generation INTEGER NOT NULL, ${this.timeColumn} TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${table}_session ON ${table}(session_id);
      CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(project_id);
      CREATE TABLE IF NOT EXISTS ${generationsTable} (
        ${this.keyColumn} TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        allocated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ${generationsTable}_session ON ${generationsTable}(session_id);
      CREATE INDEX IF NOT EXISTS ${generationsTable}_project ON ${generationsTable}(project_id);`);
  }

  latest(projectId: string, sessionId: string, key: string): ResearchGenerationSnapshot<T> | undefined {
    const row = this.select(projectId, sessionId, key);
    return row ? this.parse(row) : undefined;
  }

  allocate(projectId: string, sessionId: string, key: string): number {
    if (![projectId, sessionId, key].every(isIdentity)) throw this.corrupt();
    return this.transaction(() => {
      const allocation = this.allocation(key);
      let allocated = 0;
      if (allocation !== undefined) {
        if (allocation[this.keyColumn] !== key || allocation.project_id !== projectId
          || allocation.session_id !== sessionId || typeof allocation.allocated !== "number"
          || !Number.isSafeInteger(allocation.allocated) || allocation.allocated < 0) throw this.corrupt();
        allocated = allocation.allocated;
      }
      const stored = this.latest(projectId, sessionId, key);
      const generation = Math.max(allocated, stored?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw this.corrupt();
      this.database.prepare(`INSERT INTO ${this.options.generationsTable}
        (${this.keyColumn}, project_id, session_id, allocated) VALUES (?, ?, ?, ?)
        ON CONFLICT(${this.keyColumn}) DO UPDATE SET project_id = excluded.project_id,
          session_id = excluded.session_id, allocated = excluded.allocated`)
        .run(key, projectId, sessionId, generation);
      return generation;
    });
  }

  save(draft: ResearchGenerationDraft<T>): { readonly saved: boolean; readonly stored?: ResearchGenerationSnapshot<T> } {
    if (![draft.key, draft.projectId, draft.sessionId].every(isIdentity)
      || !Number.isSafeInteger(draft.generation) || draft.generation < 1
      || typeof draft.recordedAt !== "string" || !draft.recordedAt.trim()) throw this.corrupt();
    const encoded = this.options.encode(draft.record);
    // Validate the reduced payload too: redaction must not produce invalid evidence.
    this.options.decode(encoded, draft);
    const json = JSON.stringify(encoded);
    return this.transaction(() => {
      const allocation = this.allocation(draft.key);
      // Delete removes allocations under the same lock. A late receipt cannot
      // recreate a deleted owner's row, even from another SQLite connection.
      if (!allocation || allocation[this.keyColumn] !== draft.key
        || allocation.project_id !== draft.projectId || allocation.session_id !== draft.sessionId
        || typeof allocation.allocated !== "number" || !Number.isSafeInteger(allocation.allocated)
        || draft.generation > allocation.allocated) return { saved: false };
      const { table } = this.options;
      const result = this.database.prepare(`INSERT INTO ${table}
        (${this.keyColumn}, project_id, session_id, generation, ${this.timeColumn}, record_json)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${this.keyColumn}) DO UPDATE SET
          generation = excluded.generation, ${this.timeColumn} = excluded.${this.timeColumn}, record_json = excluded.record_json
        WHERE excluded.generation > ${table}.generation
          AND ${table}.project_id = excluded.project_id AND ${table}.session_id = excluded.session_id`)
        .run(draft.key, draft.projectId, draft.sessionId, draft.generation, draft.recordedAt, json);
      const stored = this.latest(draft.projectId, draft.sessionId, draft.key);
      return { saved: Number(result.changes) === 1, ...(stored ? { stored } : {}) };
    });
  }

  deleteSession(sessionId: string): void { this.deleteOwner("session_id", sessionId); }
  deleteProject(projectId: string): void { this.deleteOwner("project_id", projectId); }

  private deleteOwner(column: "session_id" | "project_id", id: string): void {
    this.transaction(() => {
      for (const table of [this.options.table, this.options.generationsTable]) {
        this.database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
      }
    });
  }
  private allocation(key: string) {
    return this.database.prepare(`SELECT * FROM ${this.options.generationsTable} WHERE ${this.keyColumn} = ?`).get(key);
  }
  private select(projectId: string, sessionId: string, key: string) {
    return this.database.prepare(`SELECT * FROM ${this.options.table}
      WHERE ${this.keyColumn} = ? AND project_id = ? AND session_id = ?`).get(key, projectId, sessionId);
  }
  private parse(row: Record<string, SQLOutputValue>): ResearchGenerationSnapshot<T> {
    const key = row[this.keyColumn], recordedAt = row[this.timeColumn];
    if (!isIdentity(key) || !isIdentity(row.project_id) || !isIdentity(row.session_id)
      || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 1
      || typeof recordedAt !== "string" || !recordedAt.trim() || typeof row.record_json !== "string") throw this.corrupt();
    let value: unknown;
    try { value = JSON.parse(row.record_json); } catch { throw this.corrupt(); }
    return Object.freeze({ generation: row.generation, record: this.options.decode(value, {
      key, recordedAt, generation: row.generation, projectId: row.project_id, sessionId: row.session_id,
    }) });
  }
  private corrupt(): Error { return this.options.corrupt?.() ?? new ResearchGenerationCorruptError(); }
  private transaction<R>(operation: () => R): R {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}
function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !value.includes("\0");
}
