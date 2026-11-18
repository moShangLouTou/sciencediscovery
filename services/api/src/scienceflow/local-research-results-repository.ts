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
 * Control-plane persistence for two research-line facts:
 *
 * - `science_flow_research_result_selections` holds the explicit
 *   `selected_for_next` choice for one scientific contract group. It is a
 *   durable business decision, not a cached projection: the comparison service
 *   can always recompute `best_valid`, but only this row remembers that a
 *   researcher deliberately chose a different starting point.
 * - `science_flow_research_parents` holds the research line's total budget,
 *   reservations/settlements and decision history. One row per contract group
 *   and Session; it never starts or relaunches a run on its own.
 *
 * Both tables join the existing `catalog.sqlite` additively. Reads re-validate
 * a row and throw instead of repairing it.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  RESEARCH_PARENT_VERSION,
  RESEARCH_RESULT_SELECTION_VERSION,
  type ScienceFlowResearchParent,
  type ScienceFlowResearchResultSelection,
} from "./local-research-results.js";

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ResearchResultStoreCorruptError extends Error {
  constructor(what: "selection" | "parent") {
    super(`Stored research ${what} record is unreadable`);
    this.name = "ResearchResultStoreCorruptError";
  }
}

export interface ResearchResultSelectionStore {
  get(projectId: string, sessionId: string, groupId: string): ScienceFlowResearchResultSelection | undefined;
  listForSession(projectId: string, sessionId: string): ScienceFlowResearchResultSelection[];
  /** Replace the explicit choice for one group. The latest decision wins. */
  put(selection: ScienceFlowResearchResultSelection): void;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

interface SelectionRow {
  project_id: string;
  session_id: string;
  group_id: string;
  selected_at: string;
  record_json: string;
}

export class ResearchResultSelectionRepository implements ResearchResultSelectionStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_research_result_selections (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS science_flow_research_result_selections_session
        ON science_flow_research_result_selections(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_research_result_selections_project
        ON science_flow_research_result_selections(project_id);
    `);
  }

  get(projectId: string, sessionId: string, groupId: string): ScienceFlowResearchResultSelection | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM science_flow_research_result_selections
          WHERE project_id = ? AND session_id = ? AND group_id = ?`,
      )
      .get(projectId, sessionId, groupId) as SelectionRow | undefined;
    return row ? parseSelectionRow(row) : undefined;
  }

  listForSession(projectId: string, sessionId: string): ScienceFlowResearchResultSelection[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM science_flow_research_result_selections
          WHERE project_id = ? AND session_id = ?
          ORDER BY selected_at, group_id`,
      )
      .all(projectId, sessionId) as unknown as SelectionRow[];
    return rows.map(parseSelectionRow);
  }

  put(selection: ScienceFlowResearchResultSelection): void {
    this.database
      .prepare(
        `INSERT INTO science_flow_research_result_selections
           (project_id, session_id, group_id, selected_at, record_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, group_id) DO UPDATE SET
           selected_at = excluded.selected_at,
           record_json = excluded.record_json`,
      )
      .run(
        selection.projectId,
        selection.sessionId,
        selection.groupId,
        selection.selectedAt,
        JSON.stringify(selection),
      );
  }

  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_result_selections WHERE session_id = ?")
      .run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_result_selections WHERE project_id = ?")
      .run(projectId);
  }
}

export interface ResearchParentStore {
  get(projectId: string, sessionId: string, groupId: string): ScienceFlowResearchParent | undefined;
  listForSession(projectId: string, sessionId: string): ScienceFlowResearchParent[];
  put(parent: ScienceFlowResearchParent): void;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

interface ParentRow {
  project_id: string;
  session_id: string;
  group_id: string;
  updated_at: string;
  record_json: string;
}

export class ResearchParentRepository implements ResearchParentStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_research_parents (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS science_flow_research_parents_session
        ON science_flow_research_parents(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_research_parents_project
        ON science_flow_research_parents(project_id);
    `);
  }

  get(projectId: string, sessionId: string, groupId: string): ScienceFlowResearchParent | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM science_flow_research_parents
          WHERE project_id = ? AND session_id = ? AND group_id = ?`,
      )
      .get(projectId, sessionId, groupId) as ParentRow | undefined;
    return row ? parseParentRow(row) : undefined;
  }

  listForSession(projectId: string, sessionId: string): ScienceFlowResearchParent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM science_flow_research_parents
          WHERE project_id = ? AND session_id = ?
          ORDER BY updated_at, group_id`,
      )
      .all(projectId, sessionId) as unknown as ParentRow[];
    return rows.map(parseParentRow);
  }

  put(parent: ScienceFlowResearchParent): void {
    this.database
      .prepare(
        `INSERT INTO science_flow_research_parents
           (project_id, session_id, group_id, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, group_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           record_json = excluded.record_json`,
      )
      .run(
        parent.identity.projectId,
        parent.identity.sessionId,
        parent.groupId,
        parent.updatedAt,
        JSON.stringify(parent),
      );
  }

  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_parents WHERE session_id = ?")
      .run(sessionId);
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_research_parents WHERE project_id = ?")
      .run(projectId);
  }
}

function parseSelectionRow(row: SelectionRow): ScienceFlowResearchResultSelection {
  const value = parseJson(row.record_json, "selection");
  if (
    value.schemaVersion !== RESEARCH_RESULT_SELECTION_VERSION
    || value.projectId !== row.project_id
    || value.sessionId !== row.session_id
    || value.groupId !== row.group_id
    || value.selectedAt !== row.selected_at
    || typeof value.operationId !== "string"
    || typeof value.artifactId !== "string"
    || typeof value.versionId !== "string"
    || typeof value.logicalName !== "string"
    || !Number.isSafeInteger(value.version)
    || typeof value.metricName !== "string"
    || typeof value.metricValue !== "number"
    || !Number.isFinite(value.metricValue)
    || typeof value.lowerIsBetter !== "boolean"
    || (value.selectedBy !== "tool" && value.selectedBy !== "web")
    || typeof value.reason !== "string"
    || typeof value.wasBestValid !== "boolean"
    || (value.bestValidOperationId !== null && typeof value.bestValidOperationId !== "string")
  ) {
    throw new ResearchResultStoreCorruptError("selection");
  }
  return value as unknown as ScienceFlowResearchResultSelection;
}

function parseParentRow(row: ParentRow): ScienceFlowResearchParent {
  const value = parseJson(row.record_json, "parent");
  if (
    value.schemaVersion !== RESEARCH_PARENT_VERSION
    || !isRecord(value.identity)
    || value.identity.projectId !== row.project_id
    || value.identity.sessionId !== row.session_id
    || value.groupId !== row.group_id
    || value.updatedAt !== row.updated_at
    || typeof value.parentId !== "string"
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.reservations)
    || !Array.isArray(value.settlements)
    || !Array.isArray(value.decisions)
    || !isRecord(value.stop)
    || (value.limits !== null && !isRecord(value.limits))
  ) {
    throw new ResearchResultStoreCorruptError("parent");
  }
  return value as unknown as ScienceFlowResearchParent;
}

function parseJson(text: string, what: "selection" | "parent"): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResearchResultStoreCorruptError(what);
  }
  if (!isRecord(value)) throw new ResearchResultStoreCorruptError(what);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
