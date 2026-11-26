// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { DatabaseSync } from "node:sqlite";

/** One durable record per frozen product identity, including budgets and decisions. */
export interface ResearchScopeIdentity {
  readonly projectId: string;
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly changedAt: string;
}
export interface ResearchScopeCodec<Record> {
  identity(record: Record): ResearchScopeIdentity;
  decode(value: unknown, identity: ResearchScopeIdentity): Record;
}
export class ResearchScopeCorruptError extends Error {
  constructor() { super("Stored research scope record is unreadable"); this.name = "ResearchScopeCorruptError"; }
}
export class ResearchScopeRepository<Record> {
  private readonly table: string;
  private readonly keyColumn: string;
  private readonly timeColumn: string;
  constructor(readonly database: DatabaseSync, private readonly options: {
    readonly table: string;
    readonly keyColumn?: string;
    readonly timeColumn?: string;
    readonly codec: ResearchScopeCodec<Record>;
    readonly corrupt?: () => Error;
  }) {
    this.table = options.table; this.keyColumn = options.keyColumn ?? "scope_key"; this.timeColumn = options.timeColumn ?? "updated_at";
    for (const name of [this.table, this.keyColumn, this.timeColumn]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new TypeError("Unsafe research scope SQL identifier");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, ${this.keyColumn} TEXT NOT NULL,
      ${this.timeColumn} TEXT NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id, ${this.keyColumn}));
      CREATE INDEX IF NOT EXISTS ${this.table}_session ON ${this.table}(session_id);
      CREATE INDEX IF NOT EXISTS ${this.table}_project ON ${this.table}(project_id);`);
  }
  get(projectId: string, sessionId: string, scopeKey: string): Record | undefined {
    const row = this.database.prepare(`SELECT * FROM ${this.table}
      WHERE project_id = ? AND session_id = ? AND ${this.keyColumn} = ?`).get(projectId, sessionId, scopeKey);
    return row ? this.parse(row) : undefined;
  }
  listForSession(projectId: string, sessionId: string): Record[] {
    return this.database.prepare(`SELECT * FROM ${this.table} WHERE project_id = ? AND session_id = ?
      ORDER BY ${this.timeColumn}, ${this.keyColumn}`).all(projectId, sessionId).map((row) => this.parse(row));
  }
  put(record: Record): void {
    const identity = this.options.codec.identity(record);
    this.options.codec.decode(record, identity);
    this.database.prepare(`INSERT INTO ${this.table} (project_id, session_id, ${this.keyColumn}, ${this.timeColumn}, record_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, session_id, ${this.keyColumn}) DO UPDATE SET
      ${this.timeColumn} = excluded.${this.timeColumn}, record_json = excluded.record_json`)
      .run(identity.projectId, identity.sessionId, identity.scopeKey, identity.changedAt, JSON.stringify(record));
  }
  deleteSession(sessionId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE session_id = ?`).run(sessionId);
  }
  deleteProject(projectId: string): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE project_id = ?`).run(projectId);
  }
  private parse(row: { [key: string]: unknown }): Record {
    const scopeKey = row[this.keyColumn], changedAt = row[this.timeColumn];
    if (typeof row.project_id !== "string" || typeof row.session_id !== "string" || typeof scopeKey !== "string"
      || typeof changedAt !== "string" || typeof row.record_json !== "string") throw (this.options.corrupt?.() ?? new ResearchScopeCorruptError());
    let value: unknown;
    try { value = JSON.parse(row.record_json); } catch { throw (this.options.corrupt?.() ?? new ResearchScopeCorruptError()); }
    const expected = { projectId: row.project_id, sessionId: row.session_id, scopeKey, changedAt };
    const record = this.options.codec.decode(value, expected);
    const actual = this.options.codec.identity(record);
    if (actual.projectId !== expected.projectId || actual.sessionId !== expected.sessionId
      || actual.scopeKey !== scopeKey || actual.changedAt !== changedAt) throw (this.options.corrupt?.() ?? new ResearchScopeCorruptError());
    return record;
  }
}
