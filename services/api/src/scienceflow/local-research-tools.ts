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
 * The lead Agent's surface for the experimental local research mode.
 *
 * These are ordinary tools in the production assembly: they appear when an
 * administrator enabled the mode, and they call the same service the rest of the
 * server uses. They carry business identities only — a research intent and the
 * fixed Artifact version ids this experiment tests. Paths, interpreter, model,
 * endpoint, credential and the pinned task text never come from the model.
 *
 * `get_research` may wait for a bounded time; the wait is announced as an
 * external wait so a long experiment does not trip the Agent's idle handling.
 * The start call returns an operation identity at once and never holds a request
 * open for the whole run.
 */
import { Type } from "typebox";
import type { AgentTool } from "@sciencediscovery/tools";

import {
  LocalResearchRefusal,
  type LocalResearchService,
  type ScienceFlowLocalResearchView,
} from "./local-research.js";

export const START_RESEARCH_TOOL = "start_research";
export const GET_RESEARCH_TOOL = "get_research";
export const STOP_RESEARCH_TOOL = "stop_research";

export const LOCAL_RESEARCH_TOOL_NAMES = [START_RESEARCH_TOOL, GET_RESEARCH_TOOL, STOP_RESEARCH_TOOL] as const;

/** A short intent label; the text is recorded, never executed. */
const INTENT_MAX_CHARACTERS = 2_000;
/** One bounded observation wait; the service caps it again. */
const WAIT_SECONDS_MAX = 300;

const startParameters = Type.Object({
  intent: Type.String({
    description: "One or two sentences naming the bounded experiment to run and what its result should answer.",
    maxLength: INTENT_MAX_CHARACTERS,
    minLength: 1,
  }),
  plan_version_id: Type.Optional(Type.String({
    description: "The Session's Agent-authored plan artifact version this run tests. Business id only.",
    maxLength: 200,
    minLength: 1,
  })),
  incumbent_version_id: Type.Optional(Type.String({
    description: "The fixed incumbent artifact version the run is seeded with. Business id only.",
    maxLength: 200,
    minLength: 1,
  })),
}, { additionalProperties: false });

const getParameters = Type.Object({
  operation_id: Type.Optional(Type.String({
    description: "The operation id start_research returned. Omitted means the latest operation of this Session.",
    maxLength: 200,
    minLength: 1,
  })),
  wait_seconds: Type.Optional(Type.Integer({
    description: "Wait this many seconds for the run to end before returning its current state. 0 returns at once.",
    maximum: WAIT_SECONDS_MAX,
    minimum: 0,
  })),
  action: Type.Optional(Type.Union([
    Type.Literal("status"),
    Type.Literal("retry_delivery"),
  ], { description: "status observes the run; retry_delivery republishes an ended run's artifacts without rerunning research." })),
}, { additionalProperties: false });

const stopParameters = Type.Object({
  operation_id: Type.Optional(Type.String({
    description: "The operation id to stop. Omitted means the latest operation of this Session.",
    maxLength: 200,
    minLength: 1,
  })),
}, { additionalProperties: false });

export interface LocalResearchToolInput {
  readonly service: LocalResearchService;
  readonly projectId: string;
  readonly sessionId: string;
  /** The conversation run that owns any experiment started here. */
  readonly runId: string;
  /** The governed permission check used before a start. */
  readonly requirePrivilege: (request: {
    readonly resource: string;
    readonly summary: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
  /** Pauses the Agent's idle clock while a bounded wait is in progress. */
  readonly beginExternalWait?: () => () => void;
}

/**
 * Prompt text for a Session whose deployment enabled the mode. It states the
 * experimental boundary and the start→observe→read-artifacts workflow in the
 * same voice as the other governance instructions.
 */
export function localResearchInstructions(service: LocalResearchService): string {
  return [
    `<local_research_mode>`,
    `Experimental local research is enabled for this Session (profile ${service.profileId}). It runs one bounded ScienceFlow experiment on this host with the Session's own model and the administrator's fixed engine/task inputs. This is experimental local execution, not the formal Runner sandbox: formal execution-plan readiness and its blockers are unchanged and this mode makes no sandbox claim.`,
    `When the user asks to run or execute a bounded experiment, call start_research with a short intent and, when the experiment tests a fixed plan or incumbent, this Session's plan_version_id / incumbent_version_id. Never supply host paths, an interpreter, a model, an endpoint, a credential, commands or a task description: those are administrator and Session configuration.`,
    `start_research returns an operation id immediately. Call get_research with wait_seconds (at most ${Math.floor(service.observeMaxWaitMs / 1_000)}) to observe the real engine lifecycle and the evaluated stages. Do not call start_research again for the same experiment; a replayed start attaches to the same operation.`,
    `When the run ends, its result artifacts are delivered to this Session automatically. Read them with list_artifacts and read_artifact and answer from what was actually evaluated. If delivery failed, call get_research action retry_delivery; that republishes without rerunning research. Use stop_research for an explicit user stop and distinguish a requested stop from confirmed engine termination.`,
    `Do not claim success, a score or a scientific conclusion that the delivered evidence does not support.`,
    `</local_research_mode>`,
  ].join(" ");
}

/** The three tools, assembled once per conversation run. */
export function createLocalResearchTools(input: LocalResearchToolInput): AgentTool[] {
  const { service, projectId, sessionId, runId, requirePrivilege, beginExternalWait } = input;

  const result = (value: Record<string, unknown>) => {
    const view = publicView(value);
    return { content: [{ type: "text" as const, text: JSON.stringify(view) }], details: view };
  };

  const refused = (error: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => {
    if (error instanceof LocalResearchRefusal) {
      return result({ error: error.reason, message: error.message });
    }
    throw error;
  };

  const start: AgentTool<typeof startParameters> = {
    name: START_RESEARCH_TOOL,
    label: "Start local research",
    description: [
      "Start one bounded experimental ScienceFlow research run for this Session from a short research intent.",
      "Supply business identities only: intent and, when the experiment tests fixed versions, this Session's plan_version_id and incumbent_version_id.",
      "This is experimental local execution on this host, not the formal Runner sandbox. It returns an operation id at once; observe it with get_research. Do not start the same experiment twice.",
    ].join(" "),
    parameters: startParameters,
    async execute(toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        // The mode's enablement is deployment configuration; the Session's own
        // governed permission still has to allow starting the execution.
        await requirePrivilege({
          resource: service.permissionResource,
          summary: `Start an experimental local research run (${service.profileId})`,
          toolCallId,
          ...(signal ? { signal } : {}),
        });
        const outcome = await service.start({
          projectId,
          sessionId,
          ownerRunId: runId,
          intent: parameters.intent,
          ...(parameters.plan_version_id ? { planVersionId: parameters.plan_version_id } : {}),
          ...(parameters.incumbent_version_id ? { incumbentVersionId: parameters.incumbent_version_id } : {}),
        });
        return result({
          operation: outcome.operation,
          attached: outcome.attached,
          ...(outcome.attachedReason ? { attachedReason: outcome.attachedReason } : {}),
          instruction: outcome.attached
            ? "This start request matches an existing research operation; no second run was launched. Observe it with get_research."
            : "The research run was accepted and is starting in the background. Observe it with get_research; do not call start_research again for this experiment.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const get: AgentTool<typeof getParameters> = {
    name: GET_RESEARCH_TOOL,
    label: "Observe local research",
    description: [
      "Observe an experimental local research operation: real engine lifecycle, evaluated stages, delivery state and artifact version references.",
      "wait_seconds bounds how long this call waits; the Engine idle clock is paused for that wait. action retry_delivery republishes an ended run's artifacts without rerunning research.",
      "When the run has ended, read the delivered artifacts with read_artifact and answer from them.",
    ].join(" "),
    parameters: getParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      const operation = {
        projectId,
        sessionId,
        ...(parameters.operation_id ? { operationId: parameters.operation_id } : {}),
      };
      try {
        if (parameters.action === "retry_delivery") {
          return result(serviceView(await service.retryDelivery(operation)));
        }
        const waitMs = Math.min(
          service.observeMaxWaitMs,
          Math.max(0, (parameters.wait_seconds ?? 0) * 1_000),
        );
        const release = waitMs > 0 ? beginExternalWait?.() : undefined;
        try {
          return result(serviceView(await service.get(operation, {
            waitMs,
            ...(signal ? { signal } : {}),
          })));
        } finally {
          release?.();
        }
      } catch (error) {
        return refused(error);
      }
    },
  };

  const stop: AgentTool<typeof stopParameters> = {
    name: STOP_RESEARCH_TOOL,
    label: "Stop local research",
    description: [
      "Request this Session's experimental research run to stop through the engine's own stop path.",
      "It reports whether termination was requested and whether the engine confirmed it; repeating it is safe. It never stops another run.",
    ].join(" "),
    parameters: stopParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        const outcome = await service.stop({
          projectId,
          sessionId,
          ...(parameters.operation_id ? { operationId: parameters.operation_id } : {}),
        });
        return result({
          operation: outcome.operation,
          requested: outcome.requested,
          confirmed: outcome.confirmed,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          instruction: !outcome.requested
            ? "The run already reached a terminal state, so no stop was sent. Report its actual outcome."
            : outcome.confirmed
              ? "The engine confirmed termination. Report what ran and that the run was stopped by this request."
              : "The stop was requested but termination is not confirmed yet. Call get_research to observe the final state before reporting.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  return [start, get, stop];
}

/** The service view is already public; keep one explicit mapping point. */
function serviceView(view: ScienceFlowLocalResearchView): Record<string, unknown> {
  return { ...view };
}

/**
 * Drop any accidental host-path-shaped field from a tool result. The service
 * view carries none by construction; this is the last guard before the model
 * and the event stream see a value.
 */
function publicView(value: Record<string, unknown>): Record<string, unknown> {
  const forbidden = new Set([
    "workDir",
    "receiptPath",
    "deliveryRecordPath",
    "seedDir",
    "privateRoot",
    "engineCheckout",
    "pythonExecutable",
    "readerScriptPath",
    "endpointUrl",
    "apiToken",
  ]);
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([key]) => !forbidden.has(key))
          .map(([key, item]) => [key, clean(item)]),
      );
    }
    return input;
  };
  return clean(value) as Record<string, unknown>;
}
