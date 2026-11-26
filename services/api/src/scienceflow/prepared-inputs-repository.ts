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
 * Control-plane persistence for ScienceFlow prepared-input receipts.
 *
 * The table joins `catalog.sqlite` additively and keeps one latest receipt per
 * plan. Only the whitelisted result is stored: digests, the Runner's id, the
 * preparation time, and one role summary per enumerated file. Source bytes,
 * host paths, the Runner's storage layout, and raw manifest text never reach
 * this module.
 *
 * A row carries a monotonic generation. Every preparation reserves its
 * generation atomically before it contacts a Runner, then writes conditionally:
 * a row is only replaced by a strictly newer generation. A slower concurrent
 * request therefore cannot overwrite a newer fact, and its own result is
 * reported as superseded rather than saved. Both the reservation and the write
 * share one database lock with deletion, so a Session or Project removed while
 * a Runner call was in flight cannot be resurrected by the late receipt.
 * Every read re-validates the row: a corrupt or unknown-version record throws
 * instead of being skipped, repaired, or erased. A record must also still be a
 * bundle — the four required roles, one byte set per path, counts that follow
 * from the files, and a `bundleDigest` recomputed from the canonical manifest —
 * and the same check runs before a write.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ResearchGenerationRepository, type ResearchGenerationIdentity } from "../research/generation-repository.js";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_LIMITS,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  SCIENCE_FLOW_INPUT_FILE_ROLES,
  SCIENCE_FLOW_INPUT_REQUIRED_ROLES,
  SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
  isScienceFlowInputBundlePath,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowPreparedInputFileDto,
  type ScienceFlowPreparedInputsDto,
  type ScienceFlowPreparedInputsStateDto,
} from "@sciencediscovery/schema";

const ROLE_INDEX = new Map(
  SCIENCE_FLOW_INPUT_FILE_ROLES.map((role, index) => [role, index] as const),
);

/** A new receipt taken at `generation`, already reduced to public evidence. */
export interface ScienceFlowPreparedInputsDraft {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly prepared: ScienceFlowPreparedInputsDto;
}

/** One stored receipt and the generation it was written at. */
export interface ScienceFlowStoredPreparedInputs {
  readonly prepared: ScienceFlowPreparedInputsDto;
  readonly generation: number;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowPreparedInputsCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow prepared inputs are unreadable");
    this.name = "ScienceFlowPreparedInputsCorruptError";
  }
}

/** The subset of the repository the service and its tests use. */
export interface ScienceFlowPreparedInputsStore {
  latest(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredPreparedInputs | undefined;
  /**
   * Reserve the next generation for one preparation, before any Runner call.
   * The reservation is durable, so a restart cannot hand out a generation that
   * is already in flight.
   */
  allocate(projectId: string, sessionId: string, planId: string): number;
  /**
   * Conditional write: the row is replaced only by a strictly newer
   * generation. Returns the row as it stands now, so a losing writer sees the
   * persisted winner instead of its own discarded result.
   */
  save(draft: ScienceFlowPreparedInputsDraft): {
    readonly saved: boolean;
    readonly stored?: ScienceFlowStoredPreparedInputs;
  };
  /** Removes every receipt owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void;
  /** Removes every receipt owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void;
}

export class ScienceFlowPreparedInputsRepository implements ScienceFlowPreparedInputsStore {
  private readonly observations: ResearchGenerationRepository<ScienceFlowPreparedInputsDto>;
  constructor(readonly database: DatabaseSync) {
    this.observations = new ResearchGenerationRepository(database, {
      table: "science_flow_prepared_inputs", generationsTable: "science_flow_prepared_input_generations",
      keyColumn: "plan_id", timeColumn: "prepared_at",
      encode: reducePrepared, decode: decodePrepared, corrupt: () => new ScienceFlowPreparedInputsCorruptError(),
    });
  }
  latest(projectId: string, sessionId: string, planId: string): ScienceFlowStoredPreparedInputs | undefined {
    const snapshot = this.observations.latest(projectId, sessionId, planId);
    return snapshot ? Object.freeze({ prepared: snapshot.record, generation: snapshot.generation }) : undefined;
  }
  allocate(projectId: string, sessionId: string, planId: string): number {
    return this.observations.allocate(projectId, sessionId, planId);
  }
  save(draft: ScienceFlowPreparedInputsDraft): { readonly saved: boolean; readonly stored?: ScienceFlowStoredPreparedInputs } {
    if (draft.prepared.schemaVersion !== SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION || draft.generation !== draft.prepared.generation) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    const result = this.observations.save({
      key: draft.prepared.planId, projectId: draft.projectId, sessionId: draft.sessionId,
      generation: draft.generation, recordedAt: draft.prepared.preparedAt, record: draft.prepared,
    });
    return { saved: result.saved, ...(result.stored ? { stored: Object.freeze({
      prepared: result.stored.record, generation: result.stored.generation,
    }) } : {}) };
  }
  deleteSession(sessionId: string): void { this.observations.deleteSession(sessionId); }
  deleteProject(projectId: string): void { this.observations.deleteProject(projectId); }
}

/** The read answer: the latest stored receipt, or none performed yet. */
export function preparedInputsState(
  planId: string,
  stored: ScienceFlowStoredPreparedInputs | undefined,
): ScienceFlowPreparedInputsStateDto {
  return Object.freeze({ planId, prepared: stored?.prepared ?? null });
}

/** The reduced record actually stored. */
type StoredPreparedInputs = {
  readonly contractDigest: string;
  readonly bundleDigest: string;
  readonly runnerId: string;
  readonly preparedAt: string;
  readonly outcome: "prepared";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly ScienceFlowPreparedInputFileDto[];
};

function reducePrepared(
  prepared: ScienceFlowPreparedInputsDto,
): StoredPreparedInputs {
  return {
    contractDigest: prepared.contractDigest,
    bundleDigest: prepared.bundleDigest,
    runnerId: prepared.runnerId,
    preparedAt: prepared.preparedAt,
    outcome: "prepared",
    fileCount: prepared.fileCount,
    totalBytes: prepared.totalBytes,
    files: prepared.files.map(({ role, path, size, sha256 }) => ({
      role,
      path,
      size,
      sha256,
    })),
  };
}

function decodePrepared(value: unknown, identity: ResearchGenerationIdentity): ScienceFlowPreparedInputsDto {
  const record = parseRecord(value, identity.recordedAt);
  const prepared: ScienceFlowPreparedInputsDto = Object.freeze({
    schemaVersion: SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
    planId: identity.key,
    ...record,
    canStart: false as const,
    generation: identity.generation,
  });
  return prepared;
}

/**
 * Validate one stored record against the bundle rules it claims to satisfy.
 * The row's own `prepared_at` is authoritative for the timestamp, so a record
 * whose time disagrees with the row is corrupt rather than a second opinion.
 */
function parseRecord(
  value: unknown,
  preparedAt: string,
): StoredPreparedInputs {
  if (!isRecord(value)) throw new ScienceFlowPreparedInputsCorruptError();
  if (
    typeof preparedAt !== "string" ||
    preparedAt.trim().length === 0 ||
    value.preparedAt !== preparedAt
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const contractDigest = value.contractDigest;
  const bundleDigest = value.bundleDigest;
  if (!isDigest(contractDigest) || !isDigest(bundleDigest)) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const runnerId = value.runnerId;
  if (!isIdentityText(runnerId)) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  if (value.outcome !== "prepared") {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  const files = parseFiles(value.files);
  // The record must still describe one bundle: the distinct byte sets its
  // roles name, their total, and the digest the Runner computed for exactly
  // that canonical manifest. Nothing is repaired to make a row readable.
  const manifest = receiptManifest(contractDigest, files);
  const fileCount = manifest.files.length;
  const totalBytes = manifest.files.reduce((total, file) => total + file.size, 0);
  if (
    value.fileCount !== fileCount ||
    value.totalBytes !== totalBytes ||
    totalBytes > SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxTotalBytes ||
    receiptDigest(manifest) !== bundleDigest
  ) {
    throw new ScienceFlowPreparedInputsCorruptError();
  }
  return Object.freeze({
    contractDigest,
    bundleDigest,
    runnerId,
    preparedAt,
    outcome: "prepared" as const,
    fileCount,
    totalBytes,
    files,
  });
}

function parseFiles(
  value: unknown,
): readonly ScienceFlowPreparedInputFileDto[] {
  if (!Array.isArray(value)) throw new ScienceFlowPreparedInputsCorruptError();
  const roles = new Set<string>();
  const files = value.map((entry: unknown): ScienceFlowPreparedInputFileDto => {
    if (!isRecord(entry)) throw new ScienceFlowPreparedInputsCorruptError();
    const role = entry.role;
    const path = entry.path;
    const size = entry.size;
    const sha256 = entry.sha256;
    if (
      typeof role !== "string" ||
      !(SCIENCE_FLOW_INPUT_FILE_ROLES as readonly string[]).includes(role) ||
      roles.has(role) ||
      !isScienceFlowInputBundlePath(path) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxEntryBytes ||
      !isDigest(sha256)
    ) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    roles.add(role);
    return Object.freeze({
      role: role as ScienceFlowPreparedInputFileDto["role"],
      path,
      size,
      sha256,
    });
  });
  // Every receipt predates any optional shared defaults: the four required
  // roles are always present, so a partial row is never a preparation.
  for (const role of SCIENCE_FLOW_INPUT_REQUIRED_ROLES) {
    if (!roles.has(role)) throw new ScienceFlowPreparedInputsCorruptError();
  }
  return Object.freeze(files);
}

/** The canonical file set the stored roles describe, in protocol order. */
function receiptManifest(
  contractDigest: string,
  files: readonly ScienceFlowPreparedInputFileDto[],
): ScienceFlowInputBundleManifest {
  const merged = new Map<
    string,
    {
      readonly roles: ScienceFlowPreparedInputFileDto["role"][];
      readonly size: number;
      readonly sha256: string;
    }
  >();
  for (const file of files) {
    const existing = merged.get(file.path);
    if (existing === undefined) {
      merged.set(file.path, {
        roles: [file.role],
        size: file.size,
        sha256: file.sha256,
      });
      continue;
    }
    // Two roles may share one byte set; they may never name two different ones.
    if (existing.size !== file.size || existing.sha256 !== file.sha256) {
      throw new ScienceFlowPreparedInputsCorruptError();
    }
    existing.roles.push(file.role);
  }
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files: Object.freeze(
      [...merged.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, file]) =>
          Object.freeze({
            path,
            roles: Object.freeze(
              [...file.roles].sort(
                (left, right) => roleOrder(left) - roleOrder(right),
              ),
            ),
            size: file.size,
            sha256: file.sha256,
          }),
        ),
    ),
  };
}

function roleOrder(role: ScienceFlowPreparedInputFileDto["role"]): number {
  const index = ROLE_INDEX.get(role);
  if (index === undefined) throw new ScienceFlowPreparedInputsCorruptError();
  return index;
}

/** SHA-256 over the canonical manifest; the bundle's content identity. */
function receiptDigest(manifest: ScienceFlowInputBundleManifest): string {
  return createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
