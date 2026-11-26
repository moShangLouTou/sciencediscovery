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
 * The engine-neutral boundary of one research operation.
 *
 * The product entry point owns the durable operation, its Project/Session
 * association, and permission and version-binding checks at acceptance. The
 * shared lifecycle coordinates cancellation and publication/retry policy.
 * Engine-specific operations — preparing inputs, starting the engine, reading
 * its record, asking it to stop and reading its result — are behind this
 * interface. The lifecycle module (`operation-lifecycle.ts`) is written against
 * exactly these types, independently of any engine's transport, disk layout or
 * model configuration.
 *
 * Engine result payloads stay engine-specific: the record carries a `Delivery`
 * value that the adapter produces and the lifecycle only persists.
 */

/** The engine-independent lifecycle of one accepted operation. */
export type ResearchLifecycleState =
  | "accepted"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

/** A terminal lifecycle state is never relaunched and never revived. */
export function isTerminalResearchLifecycleState(state: ResearchLifecycleState): boolean {
  return state === "completed" || state === "failed" || state === "stopped" || state === "unknown";
}

/** Who asked to stop: the Agent's tool call or the conversation's cancellation. */
export type ResearchStopRequester = "tool" | "conversation-cancel";

export interface ResearchStopState {
  readonly requestedAt?: string;
  readonly requestedBy?: ResearchStopRequester;
  readonly confirmedAt?: string;
  readonly engineStatus?: string;
  readonly lastError?: string;
}

/**
 * Engine-neutral publication state. An adapter may carry more fields (score,
 * selected stage, artifact references); the lifecycle only reads these.
 */
export interface ResearchDeliveryProgress {
  readonly state: string;
  readonly attempts: number;
  readonly updatedAt: string;
  readonly reason?: string;
  readonly failedStep?: string;
  readonly message?: string;
  readonly lastError?: string;
}

/**
 * The durable facts the shared lifecycle needs. An engine's own record type
 * extends this structurally; nothing here is a host path or a credential.
 */
export interface ResearchOperationRecord<Delivery extends ResearchDeliveryProgress = ResearchDeliveryProgress> {
  readonly operationId: string;
  readonly ownerRunId: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly state: ResearchLifecycleState;
  readonly stop: ResearchStopState;
  readonly delivery: Delivery;
  /** The engine's last observed facts; `status` is its own opaque lifecycle name. */
  readonly engine: { readonly status?: string };
}

/** The only persistence the lifecycle and an adapter share. */
export interface ResearchOperationWriter<Record extends ResearchOperationRecord> {
  get(operationId: string): Record | undefined;
  /** Apply a change and persist it; the implementation owns `updatedAt`. */
  mutate(operationId: string, change: (current: Record) => Record): Record;
}

/** One engine observation, in engine-neutral terms. */
export interface ResearchEngineObservation<Record> {
  /** The record with the engine's facts and progress already persisted. */
  readonly record: Record;
  /** True when the engine has its own record for this run. */
  readonly engineRecordObserved: boolean;
  /** True when the observed engine status never continues on its own. */
  readonly engineTerminal: boolean;
  /** The lifecycle state derived from this observation. */
  readonly stateAfterObservation: ResearchLifecycleState;
}

/** A read-only look at the engine's own record, without persisting anything. */
export interface ResearchEngineInspection<Record> {
  /** True when the engine has its own record for this run. */
  readonly engineRecordObserved: boolean;
  /** True when the observed engine status never continues on its own. */
  readonly engineTerminal: boolean;
  /** The record with the observed engine state applied in memory, not persisted. */
  readonly record: Record;
}

export interface ResearchEnginePreparation<Record> {
  readonly record: Record;
  /** False when preparation recorded a terminal outcome; the run must not launch. */
  readonly proceed: boolean;
}

export interface ResearchEngineRefusal {
  /** A stable step name recorded on the operation, never a credential or path. */
  readonly step: string;
  readonly message: string;
}

/** A service-computed cap; adapters only apply engine-specific minimums and configuration. */
export interface ResearchEngineLaunchBudget {
  readonly allowanceSec: number;
  readonly deadlineAt?: string;
}

export interface ResearchEngineBeforeLaunch<Record> {
  /** Required when the service tightens a reservation; confirms the applied engine limit. */
  readonly appliedAllowanceSec?: number;
  readonly record: Record;
  readonly refusal?: ResearchEngineRefusal;
}

export interface ResearchEngineLaunch<Record> {
  readonly record: Record;
  /**
   * The engine run this launch produced, or null for a confirmed non-start.
   *
   * A launch may return before an asynchronous engine reaches a terminal state
   * (the record then stays `accepted`/`running`). Delivery starts only from the
   * latest persisted record being terminal, so an early return keeps the result
   * pending until a later observation reports completion.
   */
  readonly engineRunId: string | null;
}

/**
 * The neutral record transitions the lifecycle needs. The adapter supplies them
 * so an engine's own record type never has to be constructed generically here.
 */
export interface ResearchLifecycleTransitions<Record> {
  /** The run never launched because a stop was already recorded. */
  stopped(record: Record): Record;
  /** A stop recorded during asynchronous preparation; no run exists. */
  stoppedByConversation(record: Record, at: string): Record;
  /** A stop request on a run that may exist. */
  stopping(record: Record, at: string, requestedBy: ResearchStopRequester): Record;
  /** Conversation cancellation records the request without changing the state. */
  stopRequestedByConversation(record: Record, at: string): Record;
  /** The engine's own termination record, or the absence of one after the wait. */
  stopResult(
    record: Record,
    at: string,
    result: { readonly confirmed: boolean; readonly error?: string },
  ): Record;
  failed(record: Record, step: string, message: string): Record;
  unknown(record: Record): Record;
  deliveryFailed(record: Record, message: string): Record;
}

/**
 * One engine, seen through the operation lifecycle. Every method receives the
 * SD-owned record and, where it must persist engine facts, the operation writer;
 * the adapter owns the engine-specific I/O and state mapping, while the
 * lifecycle owns when each step may run. Passing the writer per call is what
 * lets an adapter be substituted at composition without service internals.
 */
export interface ResearchEngineAdapter<
  Record extends ResearchOperationRecord<Delivery>,
  Delivery extends ResearchDeliveryProgress,
> {
  /** Stable engine name for diagnostics; never a credential or host path. */
  readonly engine: string;
  readonly transitions: ResearchLifecycleTransitions<Record>;
  /** Engine-specific preparation before launch (staging, task assets, ...). */
  prepare(
    record: Record,
    signal: AbortSignal,
    writer: ResearchOperationWriter<Record>,
  ): Promise<ResearchEnginePreparation<Record>>;
  /** The final pre-launch check; a refusal is recorded as a failed operation. */
  beforeLaunch(
    record: Record,
    writer: ResearchOperationWriter<Record>,
    budget?: ResearchEngineLaunchBudget,
  ): ResearchEngineBeforeLaunch<Record>;
  /** Start the engine run and observe it to its own terminal or allowance boundary. */
  launch(record: Record, writer: ResearchOperationWriter<Record>): Promise<ResearchEngineLaunch<Record>>;
  /** Read the engine's own record without persisting; used to decide whether a
   *  stop or a reconciliation is needed. */
  inspect(record: Record): Promise<ResearchEngineInspection<Record>>;
  /** Read and persist the engine's current facts and progress. */
  observe(record: Record, writer: ResearchOperationWriter<Record>): Promise<ResearchEngineObservation<Record>>;
  /** Ask the engine to stop this run. It never starts anything. */
  requestStop(record: Record): Promise<{ readonly error?: string }>;
  /** Bounded wait for the engine's own termination record. */
  confirmStop(record: Record): Promise<boolean>;
  /** Publish the run's result into the Session. Never restarts research. */
  deliver(record: Record, options: { readonly force: boolean }): Promise<Delivery>;
}
