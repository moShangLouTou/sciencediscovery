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
 * ScienceFlow's durable operation rows over the shared task repository.
 *
 * The SQLite table, insert-if-absent deduplication, identity columns and
 * session/project deletion are the shared mechanism in
 * `research/task-repository.ts`. This module supplies only what is specific to
 * ScienceFlow: its record schema version and the validation of its stored JSON.
 * The table keeps its original name and column set, so a data directory written
 * before the shared repository existed is read in place and no second ledger
 * is created.
 */
import type { DatabaseSync } from "node:sqlite";

import { ResearchOperationCorruptError, isPlainRecord, type ResearchOperationCodec, type ResearchOperationRowIdentity } from "../research/task-record.js";
import { ResearchTaskRepository } from "../research/task-repository.js";
import {
  SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION,
  type ScienceFlowLocalResearchOperation,
} from "./local-research-record.js";

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowLocalResearchCorruptError extends ResearchOperationCorruptError {
  constructor() {
    super("Stored local research operation is unreadable");
    this.name = "ScienceFlowLocalResearchCorruptError";
  }
}

/** The subset the service needs (and tests stub). */
export interface ScienceFlowLocalResearchStore {
  createIfAbsent(record: ScienceFlowLocalResearchOperation): {
    readonly created: boolean;
    readonly record: ScienceFlowLocalResearchOperation;
  };
  get(operationId: string): ScienceFlowLocalResearchOperation | undefined;
  findByIdempotency(
    projectId: string,
    sessionId: string,
    idempotencyKey: string,
  ): ScienceFlowLocalResearchOperation | undefined;
  listForSession(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation[];
  update(record: ScienceFlowLocalResearchOperation): void;
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

/**
 * Validate the ScienceFlow fields a stored row is allowed to omit and the ones
 * every reader depends on. This is the product's validation boundary; the
 * shared repository has already checked the identity columns and schema version.
 */
const scienceFlowCodec: ResearchOperationCodec<ScienceFlowLocalResearchOperation> = {
  schemaVersion: SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION,
  encode: (record) => record,
  decode(value, row: ResearchOperationRowIdentity): ScienceFlowLocalResearchOperation {
    if (!isPlainRecord(value) || value.schemaVersion !== SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION) {
      throw new ScienceFlowLocalResearchCorruptError();
    }
    if (
      value.operationId !== row.id
      || !isPlainRecord(value.identity)
      || value.identity.projectId !== row.projectId
      || value.identity.sessionId !== row.sessionId
      || value.ownerRunId !== row.ownerRunId
      || value.idempotencyKey !== row.idempotencyKey
      || value.createdAt !== row.createdAt
      || value.updatedAt !== row.updatedAt
    ) {
      throw new ScienceFlowLocalResearchCorruptError();
    }
    return value as unknown as ScienceFlowLocalResearchOperation;
  },
};

export class ScienceFlowLocalResearchRepository implements ScienceFlowLocalResearchStore {
  private readonly repository: ResearchTaskRepository<ScienceFlowLocalResearchOperation>;

  constructor(database: DatabaseSync) {
    // The original table name is kept deliberately: existing rows stay the one
    // source of truth and two ledgers cannot decide differently for one task.
    this.repository = new ResearchTaskRepository<ScienceFlowLocalResearchOperation>(database, {
      codec: scienceFlowCodec,
      table: "science_flow_local_research_operations",
    });
  }

  createIfAbsent(record: ScienceFlowLocalResearchOperation): {
    readonly created: boolean;
    readonly record: ScienceFlowLocalResearchOperation;
  } {
    return this.repository.createIfAbsent(record);
  }

  get(operationId: string): ScienceFlowLocalResearchOperation | undefined {
    return this.repository.get(operationId);
  }

  findByIdempotency(
    projectId: string,
    sessionId: string,
    idempotencyKey: string,
  ): ScienceFlowLocalResearchOperation | undefined {
    return this.repository.findByIdempotency(projectId, sessionId, idempotencyKey);
  }

  listForSession(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation[] {
    return this.repository.listForSession(projectId, sessionId);
  }

  update(record: ScienceFlowLocalResearchOperation): void {
    this.repository.update(record);
  }

  deleteSession(sessionId: string): void {
    this.repository.deleteSession(sessionId);
  }

  deleteProject(projectId: string): void {
    this.repository.deleteProject(projectId);
  }
}
