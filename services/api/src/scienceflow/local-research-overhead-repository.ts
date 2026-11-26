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

export { ResearchEventCorruptError as ResearchPreparationCorruptError } from "../research/event-repository.js";
import { ResearchEventCorruptError as ResearchPreparationCorruptError, ResearchEventRepository } from "../research/event-repository.js";

export interface ResearchPreparationStore {
  record(preparation: ScienceFlowResearchPreparation): void;
  listForSession(projectId: string, sessionId: string): ScienceFlowResearchPreparation[];
  deleteSession(sessionId: string): void;
  deleteProject(projectId: string): void;
}

/** SF retains its event schema and validation; storage/integrity are shared. */
export class ResearchPreparationRepository extends ResearchEventRepository<ScienceFlowResearchPreparation> implements ResearchPreparationStore {
  constructor(database: DatabaseSync) {
    super(database, { table: "science_flow_research_preparations", versionColumn: "task_version_id", codec: {
      decode: parsePreparation,
      identity: (record) => ({ eventId: record.preparationId, projectId: record.identity.projectId,
        sessionId: record.identity.sessionId, ownerRunId: record.runId, inputVersionId: record.taskVersionId,
        finishedAt: record.finishedAt }),
    } });
  }
}

function parsePreparation(value: unknown): ScienceFlowResearchPreparation {
  if (!isRecord(value) || value.schemaVersion !== RESEARCH_PREPARATION_VERSION) {
    throw new ResearchPreparationCorruptError();
  }
  if (
    typeof value.preparationId !== "string" || !isRecord(value.identity)
    || typeof value.identity.projectId !== "string" || typeof value.identity.sessionId !== "string"
    || typeof value.runId !== "string" || typeof value.finishedAt !== "string"
    || (value.taskVersionId !== null && typeof value.taskVersionId !== "string")
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
