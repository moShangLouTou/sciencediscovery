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
 * The engine-neutral lifecycle of one accepted research operation.
 *
 * SD owns everything here: when preparation may still be overtaken by a stop or
 * a cancelled conversation, when a launch is permitted, how a rebuilt process
 * observes an existing run without relaunching it, how a stop request becomes a
 * confirmed stop, and how publication is retried without touching the
 * experiment. The engine adapter (`engine-adapter.ts`) supplies only the
 * engine-specific steps.
 *
 * Three process-local sets keep concurrent paths coordinated: an operation's
 * worker, an in-flight delivery, and the abort controller for the preparation
 * window before any engine run exists. They are deliberately process-local: a
 * rebuilt service has no worker and therefore observes rather than relaunches.
 */
import {
  isTerminalResearchLifecycleState,
  type ResearchDeliveryProgress,
  type ResearchEngineAdapter,
  type ResearchEngineBeforeLaunch,
  type ResearchOperationRecord,
  type ResearchOperationWriter,
  type ResearchStopRequester,
} from "./engine-adapter.js";

/** A bounded wait polls the engine record at this interval. */
const DEFAULT_OBSERVE_POLL_MS = 2_000;

export interface ResearchOperationLifecycleOptions<
  Record extends ResearchOperationRecord<Delivery>,
  Delivery extends ResearchDeliveryProgress,
> {
  readonly operations: ResearchOperationWriter<Record>;
  readonly engine: ResearchEngineAdapter<Record, Delivery>;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** True when the owning conversation run was cancelled or interrupted. */
  readonly ownerStopped: (sessionId: string, runId: string) => Promise<boolean>;
  /** Upper bound for one bounded observation wait a tool may request. */
  readonly observeMaxWaitMs: number;
  /** Service-owned budget gate, followed by engine-specific launch checks. */
  readonly beforeLaunch?: (record: Record) => ResearchEngineBeforeLaunch<Record>;
  /** Called when execution or observation leaves the operation terminal. */
  readonly onTerminal?: (record: Record) => void;
  /** Called when a stop request is recorded on the owning research line. */
  readonly onStopRequested?: (record: Record, at: string, requestedBy: ResearchStopRequester) => void;
  /** Called when the engine's termination (or an already-terminal state) is recorded. */
  readonly onStopConfirmed?: (record: Record, at: string, requestedBy: ResearchStopRequester) => void;
  readonly errorMessage: (error: unknown) => string;
  readonly observePollMs?: number;
}

export interface ResearchEngineStopOutcome<Record> {
  readonly record: Record;
  readonly requested: boolean;
  readonly confirmed: boolean;
  /** Present when stop was not requested because the run already ended. */
  readonly reason?: "already-terminal";
}

export interface ResearchOperationLifecycle<Record> {
  /** The background worker: prepare, check, launch, then one automatic delivery. */
  execute(operationId: string): Promise<void>;
  /** Bounded observation; the returned record is the latest persisted one. */
  observe(record: Record, options?: { readonly waitMs?: number; readonly signal?: AbortSignal }): Promise<Record>;
  /** Reconcile stored children with the engine before a new reservation. */
  reconcile(records: readonly Record[]): Promise<Record[]>;
  /** The tool's stop: request, bounded confirmation, recorded outcome. */
  stop(record: Record): Promise<ResearchEngineStopOutcome<Record>>;
  /** Conversation cancellation: best-effort stop for the owned operations. */
  stopConversationRun(records: readonly Record[]): Promise<void>;
  /** Publication only; the experiment identity and state are untouched. */
  retryDelivery(record: Record): Promise<Record>;
  /** One delivery pass; `force` republishes an already delivered result. */
  deliver(operationId: string, force?: boolean): Promise<void>;
  isWorkerActive(operationId: string): boolean;
}

export function createResearchOperationLifecycle<
  Record extends ResearchOperationRecord<Delivery>,
  Delivery extends ResearchDeliveryProgress,
>(options: ResearchOperationLifecycleOptions<Record, Delivery>): ResearchOperationLifecycle<Record> {
  const { operations, engine, now, sleep, ownerStopped, errorMessage } = options;
  const observePollMs = options.observePollMs ?? DEFAULT_OBSERVE_POLL_MS;
  const transitions = engine.transitions;
  /** Operations whose launch/observe/deliver worker is alive in this process. */
  const activeWorkers = new Set<string>();
  /** Operations with a delivery attempt in flight in this process. */
  const deliveryInFlight = new Set<string>();
  /** Per-operation abort for the preparation window before a launch exists. */
  const operationAborts = new Map<string, AbortController>();

  /**
   * A delivery attempt never restarts research: it only republishes the result
   * the engine already produced. Automatic passes skip an already delivered
   * result; an explicit retry may republish it (delivery itself is idempotent
   * by content). A failure is recorded beside an earlier success, not on top.
   */
  const deliverOperation = async (operationId: string, force = false): Promise<void> => {
    if (deliveryInFlight.has(operationId)) return;
    deliveryInFlight.add(operationId);
    try {
      const record = operations.get(operationId);
      if (!record || !isTerminalResearchLifecycleState(record.state)) return;
      if (!force && record.delivery.state === "delivered") return;
      try {
        const delivery = await engine.deliver(record, { force });
        operations.mutate(operationId, (current) => ({ ...current, delivery }));
      } catch (error) {
        operations.mutate(operationId, (current) => transitions.deliveryFailed(current, errorMessage(error)));
      }
    } finally {
      deliveryInFlight.delete(operationId);
    }
  };

  const execute = async (operationId: string): Promise<void> => {
    activeWorkers.add(operationId);
    const controller = new AbortController();
    operationAborts.set(operationId, controller);
    try {
      let current = operations.get(operationId);
      if (!current) return;
      // A stop requested before the launch began must not be overtaken by one.
      if (current.stop.requestedAt) {
        operations.mutate(operationId, (record) => transitions.stopped(record));
        return;
      }
      // Cancellation can land between the tool's post-permission check and this
      // worker: when the owning run already ended by cancellation there is no
      // one left to read a result, so record the stop instead of launching.
      if (await ownerStopped(current.identity.sessionId, current.ownerRunId)) {
        operations.mutate(operationId, (record) => transitions.stoppedByConversation(record, now()));
        return;
      }
      const prepared = await engine.prepare(current, controller.signal, operations);
      current = prepared.record;
      if (!prepared.proceed) return;
      // Preparation is asynchronous: the session may have been cancelled or the
      // run stopped while it ran, with no worker left to read a result.
      current = operations.get(operationId) ?? current;
      if (current.stop.requestedAt) {
        operations.mutate(operationId, (record) => transitions.stopped(record));
        return;
      }
      if (await ownerStopped(current.identity.sessionId, current.ownerRunId)) {
        operations.mutate(operationId, (record) => transitions.stoppedByConversation(record, now()));
        return;
      }
      // The last check before the launch: an asynchronous preparation may have
      // outlived the line's deadline even though the reservation fitted at start.
      const verdict = options.beforeLaunch?.(current) ?? engine.beforeLaunch(current, operations);
      current = verdict.record;
      const refusal = verdict.refusal;
      if (refusal) {
        const refused = operations.mutate(operationId, (record) => (
          transitions.failed(record, refusal.step, refusal.message)
        ));
        options.onTerminal?.(refused);
        return;
      }
      const launched = await engine.launch(current, operations);
      // A launch may return while an asynchronous engine is still running.
      // Delivery is only meaningful from a terminal record; an early return
      // leaves delivery pending so the later terminal observation publishes the
      // result exactly once. A terminal launch with an engine run is delivered
      // here, including a failed/unknown outcome whose publication the engine
      // adapter still records (for example a no-candidate failure).
      const latest = operations.get(operationId) ?? launched.record;
      if (launched.engineRunId !== null && isTerminalResearchLifecycleState(latest.state)) {
        await deliverOperation(operationId);
      }
    } catch (error) {
      operations.mutate(operationId, (record) => transitions.failed(record, "launch", errorMessage(error)));
    } finally {
      operationAborts.delete(operationId);
      activeWorkers.delete(operationId);
      const latest = operations.get(operationId);
      if (latest && isTerminalResearchLifecycleState(latest.state)) options.onTerminal?.(latest);
    }
  };

  const observe = async (
    record: Record,
    observeOptions: { readonly waitMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<Record> => {
    let current = record;
    const waitMs = Math.max(0, Math.min(options.observeMaxWaitMs, Math.trunc(observeOptions.waitMs ?? 0)));
    const deadline = Date.now() + waitMs;
    while (true) {
      observeOptions.signal?.throwIfAborted();
      // Re-read before observing: the launch worker may have advanced this
      // operation since the previous poll, and its state is authoritative.
      current = operations.get(current.operationId) ?? current;
      const seen = await engine.observe(current, operations);
      current = seen.record;
      if (!seen.engineRecordObserved
        && !activeWorkers.has(current.operationId)
        && (seen.stateAfterObservation === "accepted" || seen.stateAfterObservation === "running")) {
        // The process that was launching this experiment is gone and the engine
        // left no record: the outcome is unknown, not a silent relaunch.
        current = operations.mutate(current.operationId, (stored) => (
          stored.state === seen.stateAfterObservation && stored.engine.status === undefined
            ? transitions.unknown(stored)
            : stored
        ));
      }
      if (isTerminalResearchLifecycleState(current.state)) {
        // An existing terminal run is read back, never relaunched. Delivery is
        // the only step this observation may reconcile, and only when the engine
        // left a record whose stages can actually be read.
        if (seen.engineRecordObserved && !activeWorkers.has(current.operationId)
          && current.delivery.state === "pending") {
          await deliverOperation(current.operationId);
          current = operations.get(current.operationId) ?? current;
        }
        options.onTerminal?.(current);
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(observePollMs, Math.max(0, deadline - Date.now())));
    }
    return current;
  };

  /**
   * Reconcile the line's stored children with the engine before a new child is
   * reserved. This is not a relaunch: it reads the same engine record `observe`
   * reads and may publish an already-ended run's artifacts (delivery is a
   * publication, not a rerun), so a service restart cannot make a finished run
   * look active forever or lose its result before the next comparison.
   */
  const reconcile = async (records: readonly Record[]): Promise<Record[]> => {
    for (const record of records) {
      if (isTerminalResearchLifecycleState(record.state)) continue;
      const seen = await engine.inspect(record);
      if (!seen.engineRecordObserved || !seen.engineTerminal) continue;
      const observed = await engine.observe(record, operations);
      const settled = observed.record;
      if (settled.delivery.state === "pending") await deliverOperation(settled.operationId);
      options.onTerminal?.(operations.get(settled.operationId) ?? settled);
    }
    return records.map((record) => operations.get(record.operationId) ?? record);
  };

  const stop = async (record: Record): Promise<ResearchEngineStopOutcome<Record>> => {
    const seen = await engine.inspect(record);
    if (seen.engineRecordObserved && seen.engineTerminal) {
      const observed = await engine.observe(record, operations);
      const current = observed.record;
      // Even an already-terminal run records the user's intent to end this line,
      // so a later same-conversation start cannot reserve another child.
      options.onStopConfirmed?.(current, now(), "tool");
      options.onTerminal?.(current);
      return { confirmed: true, reason: "already-terminal", record: current, requested: false };
    }
    const requestedAt = now();
    let current = operations.mutate(record.operationId, (item) => transitions.stopping(item, requestedAt, "tool"));
    // A stop during the preparation window must abort the staging copy rather
    // than let a launch follow it.
    operationAborts.get(current.operationId)?.abort();
    options.onStopRequested?.(current, requestedAt, "tool");
    const outcome = await engine.requestStop(current);
    const confirmed = await engine.confirmStop(current);
    current = operations.mutate(current.operationId, (item) => (
      transitions.stopResult(item, now(), { confirmed, ...(outcome.error ? { error: outcome.error } : {}) })
    ));
    if (confirmed) options.onStopConfirmed?.(current, now(), "tool");
    options.onTerminal?.(current);
    return { confirmed, record: current, requested: true };
  };

  const stopConversationRun = async (records: readonly Record[]): Promise<void> => {
    for (const record of records) {
      try {
        // Trip the preparation abort even when no engine record exists yet: a
        // cancel that lands while the operation is staging must not launch.
        operationAborts.get(record.operationId)?.abort();
        const seen = await engine.inspect(record);
        if (seen.engineRecordObserved && seen.engineTerminal) {
          const observed = await engine.observe(record, operations);
          const current = observed.record;
          options.onStopConfirmed?.(current, now(), "conversation-cancel");
          options.onTerminal?.(current);
          continue;
        }
        options.onStopRequested?.(record, now(), "conversation-cancel");
        let current = operations.mutate(record.operationId, (item) => (
          transitions.stopRequestedByConversation(item, now())
        ));
        await engine.requestStop(current);
        // Cancellation waits for the engine's own termination record instead of
        // declaring success when the stop request returned.
        const confirmed = await engine.confirmStop(current);
        current = operations.mutate(current.operationId, (item) => (
          transitions.stopResult(item, now(), { confirmed })
        ));
        if (confirmed) options.onStopConfirmed?.(current, now(), "conversation-cancel");
        options.onTerminal?.(current);
      } catch {
        // Cancellation is best effort: a failed stop leaves the recorded request
        // visible instead of failing the conversation cancellation.
      }
    }
  };

  return {
    deliver: deliverOperation,
    execute,
    isWorkerActive: (operationId: string): boolean => activeWorkers.has(operationId),
    observe,
    reconcile,
    retryDelivery: async (record: Record): Promise<Record> => {
      await deliverOperation(record.operationId, true);
      return operations.get(record.operationId) ?? record;
    },
    stop,
    stopConversationRun,
  };
}
