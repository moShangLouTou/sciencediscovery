// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { DatabaseSync } from "node:sqlite";

export interface ResearchVersionIdentity {
  readonly versionId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly recordedAt: string;
}
export class ResearchVersionCorruptError extends Error {
  constructor() { super("Stored research version is unreadable or conflicts with its identity"); this.name = "ResearchVersionCorruptError"; }
}
/** Immutable version-bound evidence; existing product tables keep their names and JSON. */
export class ResearchVersionRepository<T> {
  private readonly key: string;
  private readonly time: string;
  constructor(readonly database: DatabaseSync, private readonly options: {
    readonly table: string;
    readonly keyColumn?: string;
    readonly timeColumn?: string;
    identity(value: T): ResearchVersionIdentity;
    decode(value: unknown, identity: ResearchVersionIdentity): T;
    corrupt?(): Error;
  }) {
    this.key = options.keyColumn ?? "version_id";
    this.time = options.timeColumn ?? "recorded_at";
    for (const name of [options.table, this.key, this.time]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new TypeError("Unsafe research version SQL identifier");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS ${options.table} (
      ${this.key} TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      ${this.time} TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${options.table}_session ON ${options.table}(session_id);
      CREATE INDEX IF NOT EXISTS ${options.table}_project ON ${options.table}(project_id);`);
  }
  record(value: T): void {
    const id = this.options.identity(value);
    this.options.decode(value, id);
    const json = JSON.stringify(value);
    this.database.prepare(`INSERT INTO ${this.options.table}
      (${this.key}, project_id, session_id, ${this.time}, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(${this.key}) DO NOTHING`).run(id.versionId, id.projectId, id.sessionId, id.recordedAt, json);
    const row = this.database.prepare(`SELECT * FROM ${this.options.table} WHERE ${this.key} = ?`).get(id.versionId);
    if (!row || row.record_json !== json) throw this.corrupt();
    this.parse(row);
  }
  get(projectId: string, versionId: string): T | undefined {
    const row = this.database.prepare(`SELECT * FROM ${this.options.table} WHERE project_id = ? AND ${this.key} = ?`).get(projectId, versionId);
    return row ? this.parse(row) : undefined;
  }
  deleteSession(sessionId: string): void { this.database.prepare(`DELETE FROM ${this.options.table} WHERE session_id = ?`).run(sessionId); }
  deleteProject(projectId: string): void { this.database.prepare(`DELETE FROM ${this.options.table} WHERE project_id = ?`).run(projectId); }
  private corrupt(): Error { return this.options.corrupt?.() ?? new ResearchVersionCorruptError(); }
  private parse(row: { [key: string]: unknown }): T {
    const versionId = row[this.key], recordedAt = row[this.time];
    if (typeof versionId !== "string" || typeof recordedAt !== "string" || typeof row.project_id !== "string"
      || typeof row.session_id !== "string" || typeof row.record_json !== "string") throw this.corrupt();
    let body: unknown;
    try { body = JSON.parse(row.record_json); } catch { throw this.corrupt(); }
    const expected = { versionId, recordedAt, projectId: row.project_id, sessionId: row.session_id };
    const decoded = this.options.decode(body, expected);
    const actual = this.options.identity(decoded);
    if (actual.versionId !== versionId || actual.projectId !== expected.projectId
      || actual.sessionId !== expected.sessionId || actual.recordedAt !== recordedAt) throw this.corrupt();
    return decoded;
  }
}
