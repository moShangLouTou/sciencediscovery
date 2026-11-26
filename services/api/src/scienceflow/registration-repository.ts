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
 * Control-plane persistence for ScienceFlow run registrations.
 *
 * The table lives in the API's existing `catalog.sqlite`; creating it is
 * additive (`CREATE TABLE IF NOT EXISTS`), so an older data directory upgrades
 * in place without a migration step. Reads re-validate every stored record:
 * a corrupt or unknown-version row throws instead of being skipped or erased.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION,
  type ScienceFlowRunRegistrationDto,
} from "@sciencediscovery/schema";

interface RegistrationRow {
  id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  created_at: string;
  record_json: string;
}

/** Server-generated fields of a new registration; the service supplies them. */
export interface ScienceFlowRunRegistrationDraft {
  readonly registrationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly createdAt: string;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowRegistrationCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow run registration is unreadable");
    this.name = "ScienceFlowRegistrationCorruptError";
  }
}

/** The subset of the repository the composition layer needs (and tests stub). */
export interface ScienceFlowRegistrationStore {
  create(draft: ScienceFlowRunRegistrationDraft): {
    readonly created: boolean;
    readonly record: ScienceFlowRunRegistrationDto;
  };
  list(
    projectId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): ScienceFlowRunRegistrationDto[];
  get(
    projectId: string,
    sessionId: string,
    registrationId: string,
  ): ScienceFlowRunRegistrationDto | undefined;
}

export class ScienceFlowRegistrationRepository
  implements ScienceFlowRegistrationStore
{
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_run_registrations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(project_id, session_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS science_flow_run_registrations_session
        ON science_flow_run_registrations(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_run_registrations_project
        ON science_flow_run_registrations(project_id);
    `);
  }

  /**
   * Insert-or-return-existing, keyed by the business triple. The insert and the
   * read-back happen synchronously on one connection, so a concurrent retry can
   * never split them. A storage failure throws; it is never reported as success.
   */
  create(draft: ScienceFlowRunRegistrationDraft): {
    readonly created: boolean;
    readonly record: ScienceFlowRunRegistrationDto;
  } {
    const record = freezeRecord({
      schemaVersion: SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION,
      registrationId: draft.registrationId,
      projectId: draft.projectId,
      sessionId: draft.sessionId,
      runId: draft.runId,
      createdAt: draft.createdAt,
    });
    const result = this.database
      .prepare(
        `INSERT INTO science_flow_run_registrations
           (id, project_id, session_id, run_id, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, run_id) DO NOTHING`,
      )
      .run(
        record.registrationId,
        record.projectId,
        record.sessionId,
        record.runId,
        record.createdAt,
        JSON.stringify(record),
      );
    const row = this.database
      .prepare(
        `SELECT id, project_id, session_id, run_id, created_at, record_json
           FROM science_flow_run_registrations
          WHERE project_id = ? AND session_id = ? AND run_id = ?`,
      )
      .get(record.projectId, record.sessionId, record.runId) as
      | RegistrationRow
      | undefined;
    // The row must exist after the statement above: either it was just inserted
    // or the conflict target already held it. Anything else is corruption.
    if (!row) throw new ScienceFlowRegistrationCorruptError();
    return { created: Number(result.changes) === 1, record: parseRecord(row) };
  }

  list(
    projectId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): ScienceFlowRunRegistrationDto[] {
    const rows = this.database
      .prepare(
        `SELECT id, project_id, session_id, run_id, created_at, record_json
           FROM science_flow_run_registrations
          WHERE project_id = ? AND session_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(projectId, sessionId, limit, offset) as unknown as RegistrationRow[];
    return rows.map(parseRecord);
  }

  get(
    projectId: string,
    sessionId: string,
    registrationId: string,
  ): ScienceFlowRunRegistrationDto | undefined {
    const row = this.database
      .prepare(
        `SELECT id, project_id, session_id, run_id, created_at, record_json
           FROM science_flow_run_registrations
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(registrationId, projectId, sessionId) as RegistrationRow | undefined;
    return row ? parseRecord(row) : undefined;
  }

  /** Removes every registration owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_run_registrations WHERE session_id = ?")
      .run(sessionId);
  }

  /** Removes every registration owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_run_registrations WHERE project_id = ?")
      .run(projectId);
  }
}

function parseRecord(row: RegistrationRow): ScienceFlowRunRegistrationDto {
  let value: unknown;
  try {
    value = JSON.parse(row.record_json);
  } catch {
    throw new ScienceFlowRegistrationCorruptError();
  }
  if (!isRecord(value)) throw new ScienceFlowRegistrationCorruptError();
  const registrationId = value.registrationId;
  const projectId = value.projectId;
  const sessionId = value.sessionId;
  const runId = value.runId;
  const createdAt = value.createdAt;
  if (
    value.schemaVersion !== SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION ||
    typeof registrationId !== "string" ||
    typeof projectId !== "string" ||
    typeof sessionId !== "string" ||
    typeof runId !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new ScienceFlowRegistrationCorruptError();
  }
  // The record must describe exactly the row it was read from. A mismatch means
  // the row and its payload disagree; refuse rather than trust either.
  if (
    registrationId !== row.id ||
    projectId !== row.project_id ||
    sessionId !== row.session_id ||
    runId !== row.run_id ||
    createdAt !== row.created_at ||
    createdAt.trim().length === 0
  ) {
    throw new ScienceFlowRegistrationCorruptError();
  }
  return freezeRecord({
    schemaVersion: SCIENCE_FLOW_RUN_REGISTRATION_DTO_VERSION,
    registrationId,
    projectId,
    sessionId,
    runId,
    createdAt,
  });
}

function freezeRecord(
  record: ScienceFlowRunRegistrationDto,
): ScienceFlowRunRegistrationDto {
  return Object.freeze(record);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
