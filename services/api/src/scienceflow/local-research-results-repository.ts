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
import { ResearchScopeRepository } from "../research/scope-repository.js";
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

export class ResearchResultSelectionRepository extends ResearchScopeRepository<ScienceFlowResearchResultSelection> implements ResearchResultSelectionStore {
  constructor(database: DatabaseSync) {
    super(database, { table: "science_flow_research_result_selections", corrupt: () => new ResearchResultStoreCorruptError("selection"), keyColumn: "group_id", timeColumn: "selected_at", codec: {
      identity: (record) => ({ projectId: record.projectId, sessionId: record.sessionId, scopeKey: record.groupId, changedAt: record.selectedAt }),
      decode: (value, row) => parseSelectionRow({ project_id: row.projectId, session_id: row.sessionId,
        group_id: row.scopeKey, selected_at: row.changedAt, record_json: JSON.stringify(value) }),
    } });
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

export class ResearchParentRepository extends ResearchScopeRepository<ScienceFlowResearchParent> implements ResearchParentStore {
  constructor(database: DatabaseSync) {
    super(database, { table: "science_flow_research_parents", corrupt: () => new ResearchResultStoreCorruptError("parent"), keyColumn: "group_id", codec: {
      identity: (record) => ({ projectId: record.identity.projectId, sessionId: record.identity.sessionId,
        scopeKey: record.groupId, changedAt: record.updatedAt }),
      decode: (value, row) => parseParentRow({ project_id: row.projectId, session_id: row.sessionId,
        group_id: row.scopeKey, updated_at: row.changedAt, record_json: JSON.stringify(value) }),
    } });
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
