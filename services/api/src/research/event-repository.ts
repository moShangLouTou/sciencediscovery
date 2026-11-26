// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { DatabaseSync } from "node:sqlite";

/** Durable append-only preparation/usage observations, including unassigned overhead. */
export interface ResearchEventIdentity {
  readonly eventId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
  readonly inputVersionId: string | null;
  readonly finishedAt: string;
}
export class ResearchEventCorruptError extends Error {
  constructor() { super("Stored research event is unreadable or conflicts with its identity"); this.name = "ResearchEventCorruptError"; }
}
export interface ResearchEventCodec<Record> {
  decode(value: unknown): Record;
  identity(record: Record): ResearchEventIdentity;
}
export class ResearchEventRepository<Record> {
  private readonly table: string;
  private readonly versionColumn: string;
  constructor(readonly database: DatabaseSync, private readonly options: {
    readonly table: string;
    /** Supports legacy tables without rewriting their records or columns. */
    readonly versionColumn?: string;
    readonly codec: ResearchEventCodec<Record>;
  }) {
    this.table = options.table;
    this.versionColumn = options.versionColumn ?? "input_version_id";
    for (const name of [this.table, this.versionColumn]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new TypeError("Unsafe research event SQL identifier");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, ${this.versionColumn} TEXT, finished_at TEXT NOT NULL, record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${this.table}_session ON ${this.table}(session_id);
    CREATE INDEX IF NOT EXISTS ${this.table}_project ON ${this.table}(project_id);
    CREATE INDEX IF NOT EXISTS ${this.table}_version ON ${this.table}(${this.versionColumn});`);
  }
  record(record: Record): void {
    this.options.codec.decode(record);
    const id = this.options.codec.identity(record);
    const encoded = JSON.stringify(record);
    this.database.prepare(`INSERT INTO ${this.table}
      (id, project_id, session_id, run_id, ${this.versionColumn}, finished_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id.eventId, id.projectId, id.sessionId, id.ownerRunId, id.inputVersionId, id.finishedAt, encoded);
    const stored = this.database.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id.eventId);
    if (!stored || stored.record_json !== encoded) throw new ResearchEventCorruptError();
    this.parse(stored);
  }
  listForSession(projectId: string, sessionId: string): Record[] {
    return this.database.prepare(`SELECT * FROM ${this.table}
      WHERE project_id = ? AND session_id = ? ORDER BY finished_at, id`).all(projectId, sessionId)
      .map((row) => this.parse(row));
  }
  deleteSession(sessionId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE session_id = ?`).run(sessionId);
  }
  deleteProject(projectId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE project_id = ?`).run(projectId);
  }
  private parse(row: { [key: string]: unknown }): Record {
    let value: unknown;
    try { value = JSON.parse(String(row.record_json)); } catch { throw new ResearchEventCorruptError(); }
    const record = this.options.codec.decode(value);
    const id = this.options.codec.identity(record);
    if (id.eventId !== row.id || id.projectId !== row.project_id || id.sessionId !== row.session_id
      || id.ownerRunId !== row.run_id || id.inputVersionId !== row[this.versionColumn] || id.finishedAt !== row.finished_at) {
      throw new ResearchEventCorruptError();
    }
    return record;
  }
}
