// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isValidExecutionBoundaryHandle,
  type ExecutionBoundaryHandle,
} from "./execution-boundary.js";

/**
 * The table that keeps an environment fenced while a runtime probe
 * could not be proven to have stopped. It lives in the same ledger as
 * `execution_resources` so a Runner restart cannot forget it; the row is only
 * removed with the round-10 proof that the process boundary is empty.
 */
export const RUNTIME_CHECK_RESERVATIONS_TABLE = "runtime_check_reservations";
export const RUNTIME_CHECK_RESERVATION_SCHEMA_VERSION = 1;

/** An unproven boundary identified only by the fact that it was not captured. */
export type RuntimeCheckBoundary = ExecutionBoundaryHandle | "unproven";

export interface RuntimeCheckReservation {
  /** Identifies one check's reservation, so release only deletes its own row. */
  readonly id: string;
  readonly boundary: RuntimeCheckBoundary;
}

export interface StoredRuntimeCheckReservation {
  readonly reservation: RuntimeCheckReservation;
  /** The exact stored JSON, used as the compare-and-delete token. */
  readonly record: string;
}

/**
 * Refuse an environment change. One error for both the ledger's execution
 * resources and a runtime-check reservation: to the caller they are the same
 * "this prefix may still have a process" condition, and the same operator
 * action clears them.
 */
export function environmentExecutionUnverifiedError(): Error {
  return Object.assign(new Error(
    "An execution still owns this environment; verify its process and recover its resources before changing packages or deleting it"),
  { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
}

/** The execution ledger, rather than the lifetime of an HTTP operation, owns
 * access to an environment while process termination remains unverified. */
export function assertEnvironmentMutationAllowed(ledgerPath: string, environmentId: string): void {
  const unavailable = environmentExecutionUnverifiedError;
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
    if (tables.has(RUNTIME_CHECK_RESERVATIONS_TABLE)) {
      for (const row of db.prepare(`SELECT environment FROM ${RUNTIME_CHECK_RESERVATIONS_TABLE}`).all()) {
        // Any row blocks its environment. A malformed row cannot name a safe
        // environment either, so it blocks every change (fail closed).
        if (typeof row.environment !== "string" || row.environment.length === 0
          || row.environment.trim() !== row.environment) throw unavailable();
        if (row.environment === environmentId) throw unavailable();
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

/**
 * Persist one runtime-check reservation.
 *
 * `INSERT ... DO NOTHING` keeps another check's evidence: if two checks over the
 * same environment both lose their boundary, whichever row landed first remains,
 * and neither may overwrite it with a weaker record. Returns the stored JSON
 * when this call created the row, or null when another row already owns the
 * environment. An unreadable or unwritable ledger throws; the caller must then
 * keep its in-process fence and report the persistence failure.
 */
export function writeRuntimeCheckReservation(
  ledgerPath: string,
  environmentId: string,
  reservation: RuntimeCheckReservation,
): { readonly stored: boolean; readonly record: string | null } {
  const record = JSON.stringify({
    boundary: reservation.boundary,
    id: reservation.id,
    schemaVersion: RUNTIME_CHECK_RESERVATION_SCHEMA_VERSION,
  });
  const db = new DatabaseSync(ledgerPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`CREATE TABLE IF NOT EXISTS ${RUNTIME_CHECK_RESERVATIONS_TABLE} (environment TEXT PRIMARY KEY, record TEXT NOT NULL)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db.prepare(
        `INSERT INTO ${RUNTIME_CHECK_RESERVATIONS_TABLE} (environment, record) VALUES (?, ?) ON CONFLICT(environment) DO NOTHING`,
      ).run(environmentId, record);
      db.exec("COMMIT");
      return { record: Number(inserted.changes) > 0 ? record : null, stored: Number(inserted.changes) > 0 };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Read the durable reservation for one environment.
 *
 * A corrupt row is `"corrupt"` rather than absent: it still means "some process
 * may own this environment", so callers must refuse. A missing ledger or table
 * means no reservation was ever recorded.
 */
export function readRuntimeCheckReservation(
  ledgerPath: string,
  environmentId: string,
): StoredRuntimeCheckReservation | "corrupt" | undefined {
  if (!existsSync(ledgerPath)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(ledgerPath, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has(RUNTIME_CHECK_RESERVATIONS_TABLE)) return undefined;
    const row = db.prepare(
      `SELECT record FROM ${RUNTIME_CHECK_RESERVATIONS_TABLE} WHERE environment = ?`,
    ).get(environmentId);
    if (row === undefined) return undefined;
    if (typeof row.record !== "string") return "corrupt";
    let parsed: unknown;
    try { parsed = JSON.parse(row.record); } catch { return "corrupt"; }
    if (!parsed || typeof parsed !== "object") return "corrupt";
    const value = parsed as Record<string, unknown>;
    if (value.schemaVersion !== RUNTIME_CHECK_RESERVATION_SCHEMA_VERSION) return "corrupt";
    if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 160) return "corrupt";
    const boundary = value.boundary;
    if (boundary !== "unproven" && !isValidExecutionBoundaryHandle(boundary)) return "corrupt";
    return {
      record: row.record,
      reservation: { boundary, id: value.id },
    };
  } catch {
    return "corrupt";
  } finally {
    db?.close();
  }
}

/** Delete only the exact row a check wrote; another check's evidence stays. */
export function deleteRuntimeCheckReservation(
  ledgerPath: string,
  environmentId: string,
  record: string,
): void {
  if (!existsSync(ledgerPath)) return;
  const db = new DatabaseSync(ledgerPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has(RUNTIME_CHECK_RESERVATIONS_TABLE)) return;
    db.prepare(
      `DELETE FROM ${RUNTIME_CHECK_RESERVATIONS_TABLE} WHERE environment = ? AND record = ?`,
    ).run(environmentId, record);
  } finally {
    db.close();
  }
}
