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
 * The engine-neutral shape every durable research task record exposes.
 *
 * A product stores its domain facts beside these fields. The shared task
 * service, repository and budget ledger read only this contract, so an engine
 * is never required to provide another product's configuration, model
 * resolution, scoring rules or file layout. The product-specific fields are
 * validated by the product's own codec (see `task-repository.ts`); the shared
 * modules never read them through `any` or a cast.
 */
import type {
  ResearchDeliveryProgress,
  ResearchLifecycleState,
  ResearchStopState,
} from "./engine-adapter.js";

export interface ResearchTaskIdentity {
  readonly projectId: string;
  readonly sessionId: string;
}

/**
 * The facts the shared task service persists for every accepted operation.
 * An engine record extends this with its own fields (task contract, launch
 * configuration, engine paths, ...).
 */
export interface ResearchTaskRecord<Delivery extends ResearchDeliveryProgress = ResearchDeliveryProgress> {
  /** The record schema version written and accepted by the product codec. */
  readonly schemaVersion: number;
  /** SD's identity for this accepted operation. */
  readonly operationId: string;
  /** Stable hash of the accepted start request; a replay finds this row. */
  readonly idempotencyKey: string;
  readonly identity: ResearchTaskIdentity;
  /** The conversation run that owns this operation. */
  readonly ownerRunId: string;
  /** Stable engine/product identity for diagnostics. Never a credential. */
  readonly engineId?: string;
  /** The engine's durable task handle; a rebuilt service observes this task. */
  readonly engineRunId: string | null;
  readonly state: ResearchLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly delivery: Delivery;
  readonly stop: ResearchStopState;
  /** The engine's own opaque status, when it has one. */
  readonly engine: { readonly status?: string };
  /** A stable refusal/failure step and a safe message. */
  readonly error?: { readonly step: string; readonly message: string };
}

/** A terminal lifecycle state is never relaunched or revived. */
export function isTerminalTaskState(state: ResearchLifecycleState): boolean {
  return state === "completed" || state === "failed" || state === "stopped" || state === "unknown";
}

/** The identity a start request is admitted under. */
export interface ResearchTaskRequestIdentity {
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
}

/** The columns that mirror the record envelope in the SQLite row. */
export interface ResearchOperationRowIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A product's durable codec: it validates a stored row and produces the typed
 * record. A corrupt or unknown-version row must throw
 * `ResearchOperationCorruptError`, never be skipped or repaired silently.
 */
export interface ResearchOperationCodec<Record extends ResearchTaskRecord> {
  /** The record schema version this codec writes and accepts. */
  readonly schemaVersion: number;
  /** Encode the record exactly as it must be persisted. */
  encode(record: Record): unknown;
  /** Validate and decode one persisted value; throws on any mismatch. */
  decode(value: unknown, row: ResearchOperationRowIdentity): Record;
}

export class ResearchOperationCorruptError extends Error {
  constructor(message = "Stored research operation is unreadable") {
    super(message);
    this.name = "ResearchOperationCorruptError";
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the envelope columns every product record must satisfy. */
export function assertResearchTaskRecordEnvelope(
  value: unknown,
  row: ResearchOperationRowIdentity,
  schemaVersion: number,
): void {
  if (!isPlainRecord(value) || value.schemaVersion !== schemaVersion) {
    throw new ResearchOperationCorruptError();
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
    throw new ResearchOperationCorruptError();
  }
  if (typeof value.state !== "string" || !isPlainRecord(value.delivery) || !isPlainRecord(value.stop)) {
    throw new ResearchOperationCorruptError();
  }
}
