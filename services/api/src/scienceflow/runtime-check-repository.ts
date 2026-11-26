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
 * Control-plane persistence for ScienceFlow runtime identity checks.
 *
 * The table joins `catalog.sqlite` additively and keeps one latest row per plan.
 * Only the whitelisted result is stored: fixed codes and statuses, identities,
 * digests, and the observation time. Host paths, `sys.path` entries, Git output,
 * stderr, and interpreter details never reach this module.
 *
 * A row carries a monotonic generation. Every check reserves its generation
 * atomically before it contacts a Runner, then writes conditionally: a row is
 * only replaced by a strictly newer generation. A slower concurrent check
 * therefore cannot overwrite a newer fact, and its own result is reported as
 * superseded rather than saved. A check that fails after reserving leaves the
 * prior row untouched as history.
 * Every read re-validates the row and rebuilds its descriptions; a corrupt row
 * throws rather than being skipped, repaired, or erased.
 */
import type { DatabaseSync } from "node:sqlite";
import { ResearchGenerationRepository, type ResearchGenerationIdentity } from "../research/generation-repository.js";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
  type ScienceFlowRuntimeCheckDto,
  type ScienceFlowRuntimeCheckStateDto,
  type ScienceFlowRuntimeSourceKind,
} from "@sciencediscovery/schema";

import {
  canonicalRuntimeChecks,
  isScienceFlowRuntimeSourceKind,
  isVerifiedRuntimeCheck,
  runtimeCheckChecksDto,
  SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
} from "./runtime-check-dto.js";

/** A new check taken at `generation`, already reduced to public evidence. */
export interface ScienceFlowRuntimeCheckDraft {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly check: ScienceFlowRuntimeCheckDto;
}

/** One stored check and the generation it was written at. */
export interface ScienceFlowStoredRuntimeCheck {
  readonly check: ScienceFlowRuntimeCheckDto;
  readonly generation: number;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowRuntimeCheckCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow runtime check is unreadable");
    this.name = "ScienceFlowRuntimeCheckCorruptError";
  }
}

/** The subset of the repository the service and its tests use. */
export interface ScienceFlowRuntimeCheckStore {
  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredRuntimeCheck | undefined;
  /**
   * Reserve the next generation for one check, before any Runner call. Two
   * overlapping requests get distinct integers; the reservation is durable, so
   * a restart cannot hand out a generation that is already in flight.
   */
  allocate(projectId: string, sessionId: string, planId: string): number;
  /**
   * Conditional write: the row is replaced only by a strictly newer
   * generation. Returns the row as it stands now, so a losing writer sees the
   * persisted winner instead of its own discarded result.
   */
  save(draft: ScienceFlowRuntimeCheckDraft): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredRuntimeCheck;
  };
  /** Removes every check owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void;
  /** Removes every check owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void;
}

export class ScienceFlowRuntimeCheckRepository implements ScienceFlowRuntimeCheckStore {
  private readonly observations: ResearchGenerationRepository<ScienceFlowRuntimeCheckDto>;
  constructor(readonly database: DatabaseSync) {
    this.observations = new ResearchGenerationRepository(database, {
      table: "science_flow_runtime_checks", generationsTable: "science_flow_runtime_check_generations",
      keyColumn: "plan_id", timeColumn: "checked_at",
      encode: reduceCheck, decode: decodeCheck, corrupt: () => new ScienceFlowRuntimeCheckCorruptError(),
    });
  }
  latest(projectId: string, sessionId: string, planId: string): ScienceFlowStoredRuntimeCheck | undefined {
    const snapshot = this.observations.latest(projectId, sessionId, planId);
    return snapshot ? Object.freeze({ check: snapshot.record, generation: snapshot.generation }) : undefined;
  }
  allocate(projectId: string, sessionId: string, planId: string): number {
    return this.observations.allocate(projectId, sessionId, planId);
  }
  save(draft: ScienceFlowRuntimeCheckDraft): { readonly saved: boolean; readonly stored?: ScienceFlowStoredRuntimeCheck } {
    if (draft.check.schemaVersion !== SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION || draft.generation !== draft.check.generation) {
      throw new ScienceFlowRuntimeCheckCorruptError();
    }
    const result = this.observations.save({
      key: draft.check.planId, projectId: draft.projectId, sessionId: draft.sessionId,
      generation: draft.generation, recordedAt: draft.check.checkedAt, record: draft.check,
    });
    return { saved: result.saved, ...(result.stored ? { stored: Object.freeze({
      check: result.stored.record, generation: result.stored.generation,
    }) } : {}) };
  }
  deleteSession(sessionId: string): void { this.observations.deleteSession(sessionId); }
  deleteProject(projectId: string): void { this.observations.deleteProject(projectId); }
}

/** The read answer: the latest stored check, or none performed yet. */
export function runtimeCheckState(
  planId: string,
  stored: ScienceFlowStoredRuntimeCheck | undefined,
): ScienceFlowRuntimeCheckStateDto {
  return Object.freeze({ planId, check: stored?.check ?? null });
}

/** The reduced record actually stored: descriptions are rebuilt on read. */
type StoredRuntimeCheck = {
  readonly contractDigest: string;
  readonly bindingDigest: string;
  readonly runnerId: string;
  readonly environmentId: string;
  readonly environmentRevisionId: string | null;
  readonly checkedAt: string;
  readonly outcome: "verified" | "blocked";
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  readonly sourceRevision: string | null;
  readonly checks: readonly {
    readonly code: ScienceFlowRuntimeCheckDto["checks"][number]["code"];
    readonly status: ScienceFlowRuntimeCheckDto["checks"][number]["status"];
  }[];
};

function reduceCheck(check: ScienceFlowRuntimeCheckDto): StoredRuntimeCheck {
  return {
    contractDigest: check.contractDigest,
    bindingDigest: check.bindingDigest,
    runnerId: check.runnerId,
    environmentId: check.environmentId,
    environmentRevisionId: check.environmentRevisionId,
    checkedAt: check.checkedAt,
    outcome: check.outcome,
    sourceKind: check.sourceKind,
    sourceRevision: check.sourceRevision,
    checks: check.checks.map(({ code, status }) => ({ code, status })),
  };
}

function decodeCheck(value: unknown, identity: ResearchGenerationIdentity): ScienceFlowRuntimeCheckDto {
  if (!isRecord(value)) throw new ScienceFlowRuntimeCheckCorruptError();
  const checkedAt = value.checkedAt;
  if (
    typeof checkedAt !== "string" ||
    checkedAt.trim().length === 0 ||
    checkedAt !== identity.recordedAt
  ) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const contractDigest = value.contractDigest;
  const bindingDigest = value.bindingDigest;
  if (!isDigest(contractDigest) || !isDigest(bindingDigest)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const runnerId = value.runnerId;
  const environmentId = value.environmentId;
  if (!isIdentityText(runnerId) || !isIdentityText(environmentId)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const environmentRevisionId = value.environmentRevisionId;
  if (
    environmentRevisionId !== null &&
    !isIdentityText(environmentRevisionId)
  ) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const sourceRevision = value.sourceRevision;
  if (sourceRevision !== null && !isRevision(sourceRevision)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const outcome = value.outcome;
  if (outcome !== "verified" && outcome !== "blocked") {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const sourceKind = value.sourceKind;
  if (!isScienceFlowRuntimeSourceKind(sourceKind)) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const checks = canonicalRuntimeChecks(value.checks);
  if (checks === null) throw new ScienceFlowRuntimeCheckCorruptError();
  // The stored outcome must still follow from the stored checks; a row that
  // says `verified` while carrying a non-passing check is corrupt.
  if (isVerifiedRuntimeCheck(checks) !== (outcome === "verified")) {
    throw new ScienceFlowRuntimeCheckCorruptError();
  }
  const check: ScienceFlowRuntimeCheckDto = Object.freeze({
    schemaVersion: SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
    planId: identity.key,
    contractDigest,
    bindingDigest,
    runnerId,
    environmentId,
    environmentRevisionId,
    checkedAt,
    outcome,
    canStart: false as const,
    sourceKind,
    sourceRevision,
    checks: runtimeCheckChecksDto(checks),
    unknowns: SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
    generation: identity.generation,
  });
  return check;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
