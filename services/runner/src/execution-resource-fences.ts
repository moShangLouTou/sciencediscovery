// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The execution ledger, rather than the lifetime of an HTTP operation, owns
 * access to an environment while process termination remains unverified. */
export function assertEnvironmentMutationAllowed(ledgerPath: string, environmentId: string): void {
  const unavailable = () => Object.assign(new Error(
    "An execution still owns this environment; verify its process and recover its resources before changing packages or deleting it"),
  { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  if (!existsSync(ledgerPath)) {
    if (existsSync(dirname(ledgerPath))) throw unavailable();
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(ledgerPath, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has("executions")) throw unavailable();
    const resources = new Map<string, string | null>();
    if (tables.has("execution_resources")) {
      for (const row of db.prepare("SELECT execution, environment FROM execution_resources").all()) {
        if (typeof row.execution !== "string" || (row.environment !== null && (typeof row.environment !== "string"
          || row.environment.length === 0 || row.environment.trim() !== row.environment))) throw unavailable();
        resources.set(row.execution, row.environment);
        // A default runtime (notably provider=none) may select an environment
        // inside the operation. Null means its exact environment is unknown.
        if (row.environment === null || row.environment === environmentId) throw unavailable();
      }
    }
    for (const row of db.prepare("SELECT id, record FROM executions").all()) {
      const record: unknown = JSON.parse(String(row.record));
      if (!record || typeof record !== "object" || !("state" in record) || typeof record.state !== "string"
        || !["queued", "running", "unknown", "completed", "cancelled", "failed"].includes(record.state)) throw unavailable();
      // Older records did not bind an environment. Do not guess that their
      // unknown process cannot still be using the environment being changed.
      if ((record.state === "unknown" || record.state === "running"
        || (record.state === "failed" && "startedAt" in record && record.startedAt
          && (!("version" in record) || !record.version))) && !resources.has(String(row.id))) throw unavailable();
    }
  } catch {
    throw unavailable();
  } finally { db?.close(); }
}
