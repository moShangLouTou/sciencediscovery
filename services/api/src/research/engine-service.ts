// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  isTerminalResearchLifecycleState,
  type ResearchDeliveryProgress,
  type ResearchEngineAdapter,
  type ResearchOperationRecord,
  type ResearchOperationWriter,
} from "./engine-adapter.js";

/** Engine communication only; preparation, policy and publication are composed by the platform. */
export type ResearchExecutionTransport<R extends ResearchOperationRecord<D>, D extends ResearchDeliveryProgress> =
  Pick<ResearchEngineAdapter<R, D>, "engine" | "launch" | "inspect" | "observe" | "requestStop" | "confirmStop">;

export interface ResearchPreparationStep<R extends ResearchOperationRecord> {
  readonly name: string;
  run(record: R, signal: AbortSignal, writer: ResearchOperationWriter<R>): Promise<R>;
  message?(error: unknown): string;
}

/** The platform owns ordering, cancellation and failure persistence between asynchronous steps. */
export function createResearchEngineService<R extends ResearchOperationRecord<D>, D extends ResearchDeliveryProgress>(options: {
  readonly transport: ResearchExecutionTransport<R, D>;
  readonly transitions: ResearchEngineAdapter<R, D>["transitions"];
  readonly preparation: readonly ResearchPreparationStep<R>[];
  readonly beforeLaunch: ResearchEngineAdapter<R, D>["beforeLaunch"];
  readonly deliver: ResearchEngineAdapter<R, D>["deliver"];
  now(): string;
  ownerStopped(sessionId: string, ownerRunId: string): Promise<boolean>;
}): ResearchEngineAdapter<R, D> {
  const { transitions } = options;
  return {
    ...options.transport,
    transitions,
    beforeLaunch: options.beforeLaunch,
    deliver: options.deliver,
    async prepare(record, signal, writer) {
      let current = writer.get(record.operationId) ?? record;
      const mayContinue = async () => {
        current = writer.get(record.operationId) ?? current;
        if (isTerminalResearchLifecycleState(current.state)) return false;
        if (current.stop.requestedAt) {
          current = writer.mutate(current.operationId, transitions.stopped);
          return false;
        }
        const ownerStopped = signal.aborted || await options.ownerStopped(current.identity.sessionId, current.ownerRunId);
        // The owner lookup is asynchronous; re-read both stop intent and terminal state.
        current = writer.get(current.operationId) ?? current;
        if (isTerminalResearchLifecycleState(current.state)) return false;
        if (current.stop.requestedAt) {
          current = writer.mutate(current.operationId, transitions.stopped);
          return false;
        }
        if (signal.aborted || ownerStopped) {
          current = writer.mutate(current.operationId, (item) => transitions.stoppedByConversation(item, options.now()));
          return false;
        }
        return !isTerminalResearchLifecycleState(current.state);
      };
      for (const step of options.preparation) {
        if (!await mayContinue()) return { proceed: false, record: current };
        try { current = await step.run(current, signal, writer); }
        catch (error) {
          if (await mayContinue()) {
            const message = step.message?.(error) ?? (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
            current = writer.mutate(current.operationId, (item) => transitions.failed(item, step.name, message));
          }
          return { proceed: false, record: current };
        }
      }
      return { proceed: await mayContinue(), record: current };
    },
  };
}
