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
 * Durable accounting for task preparation and its evaluator probe.
 *
 * `prepareResearchTask` runs real evaluator code and can take seconds before any
 * research operation exists. A parent research line that only counted launched
 * SF children would therefore under-report its real resource use. This table
 * records each attempt, its observed wall clock, the two probe evaluations and
 * whether it published a task version. Successful attempts are attributed to the
 * matching prepared contract; failed attempts stay visible as unattributed
 * Session overhead instead of disappearing.
 *
 * The probe runs evaluator code, not a model, so its token use is explicitly
 * `not-applicable`; it is never recorded as a zero-token model call.
 */
import type { DatabaseSync } from "node:sqlite";

export const RESEARCH_PREPARATION_VERSION = 1;

export interface ScienceFlowResearchPreparation {
  readonly schemaVersion: typeof RESEARCH_PREPARATION_VERSION;
  readonly preparationId: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly runId: string;
  readonly taskId: string | null;
  readonly taskVersionId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallClock: {
    readonly status: "known" | "unknown";
    readonly seconds: number;
  };
  readonly probe: {
    readonly status: "known" | "unknown";
    readonly evaluations: number;
    readonly evaluatorSha256: string | null;
  };
  readonly tokens: {
    readonly status: "not-applicable";
    readonly note: string;
  };
  readonly outcome: "succeeded" | "failed";
  readonly error?: string;
}

export class ResearchPreparationCorruptError extends Error {
  constructor() {
    super("Stored research preparation is unreadable");
    this.name = "ResearchPreparationCorruptError";
  }
}

export interface ResearchPreparationStore {
  record(preparation: ScienceFlowResearchPreparation): void;
  listForSession(projectId: string, sessionId: string): ScienceFlowResearchPreparation[];
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

interface PreparationRow {
  id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  task_version_id: string | null;
  finished_at: string;
  record_json: string;
}

export class ResearchPreparationRepository implements ResearchPreparationStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_research_preparations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_version_id TEXT,
        finished_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS science_flow_research_preparations_session
        ON science_flow_research_preparations(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_research_preparations_project
        ON science_flow_research_preparations(project_id);
      CREATE INDEX IF NOT EXISTS science_flow_research_preparations_version
        ON science_flow_research_preparations(task_version_id);
    `);
  }

  record(preparation: ScienceFlowResearchPreparation): void {
    this.database
      .prepare(
        `INSERT INTO science_flow_research_preparations
           (id, project_id, session_id, run_id, task_version_id, finished_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        preparation.preparationId,
        preparation.identity.projectId,
        preparation.identity.sessionId,
        preparation.runId,
        preparation.taskVersionId,
        preparation.finishedAt,
        JSON.stringify(preparation),
      );
    const stored = this.listForSession(preparation.identity.projectId, preparation.identity.sessionId)
      .find((row) => row.preparationId === preparation.preparationId);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(preparation)) {
      throw new ResearchPreparationCorruptError();
    }
  }

  listForSession(projectId: string, sessionId: string): ScienceFlowResearchPreparation[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM science_flow_research_preparations
          WHERE project_id = ? AND session_id = ?
          ORDER BY finished_at, id`,
      )
      .all(projectId, sessionId) as unknown as PreparationRow[];
    return rows.map(parseRow);
  }

  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_preparations WHERE session_id = ?")
      .run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_preparations WHERE project_id = ?")
      .run(projectId);
  }
}

function parseRow(row: PreparationRow): ScienceFlowResearchPreparation {
  let value: unknown;
  try {
    value = JSON.parse(row.record_json);
  } catch {
    throw new ResearchPreparationCorruptError();
  }
  if (!isRecord(value) || value.schemaVersion !== RESEARCH_PREPARATION_VERSION) {
    throw new ResearchPreparationCorruptError();
  }
  if (
    value.preparationId !== row.id
    || !isRecord(value.identity)
    || value.identity.projectId !== row.project_id
    || value.identity.sessionId !== row.session_id
    || value.runId !== row.run_id
    || value.taskVersionId !== row.task_version_id
    || value.finishedAt !== row.finished_at
    || !isRecord(value.wallClock)
    || (value.wallClock.status !== "known" && value.wallClock.status !== "unknown")
    || typeof value.wallClock.seconds !== "number"
    || !isRecord(value.probe)
    || (value.probe.status !== "known" && value.probe.status !== "unknown")
    || typeof value.probe.evaluations !== "number"
    || !isRecord(value.tokens)
    || value.tokens.status !== "not-applicable"
    || (value.outcome !== "succeeded" && value.outcome !== "failed")
  ) {
    throw new ResearchPreparationCorruptError();
  }
  return value as unknown as ScienceFlowResearchPreparation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
