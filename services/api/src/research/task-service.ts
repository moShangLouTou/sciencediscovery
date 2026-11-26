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
 * The shared research task service.
 *
 * It owns the engine-neutral control plane one accepted research task needs:
 * request admission (Project/Session ownership and write access), request
 * deduplication, the one-live-operation-per-conversation-run rule, the check
 * that a cancelled conversation does not create an unowned task, research-line
 * budget reservation and refusal, durable persistence, background execution,
 * bounded observation, stop request versus confirmed termination, conversation
 * cancellation, delivery retry and the latest/list reads.
 *
 * A product supplies only its extensions through `ResearchTaskProduct`: the
 * engine adapter, its own permission/configuration gate, request validation and
 * record construction (model resolution, task selection, domain inputs), its
 * frozen budget-line identity, its public view and its post-accept bookkeeping.
 * Scientific decisions — what a score means, which candidate is best, whether a
 * proof is accepted — stay in the product.
 */
import type {
  ResearchDeliveryProgress,
  ResearchEngineAdapter,
  ResearchOperationWriter,
  ResearchStopRequester,
} from "./engine-adapter.js";
import {
  createResearchOperationLifecycle,
  type ResearchOperationLifecycle,
} from "./operation-lifecycle.js";
import {
  projectResearchBudgetLine,
  researchBudgetLineRefusal,
  withResearchBudgetDecision,
  type ResearchBudgetChild,
  type ResearchBudgetDecision,
  type ResearchBudgetLine,
  type ResearchBudgetRefusal,
} from "./budget.js";
import { randomUUID } from "node:crypto";

import { isTerminalTaskState, type ResearchTaskRecord, type ResearchTaskRequestIdentity } from "./task-record.js";
import type { ResearchTaskStore } from "./task-repository.js";

/** The product-neutral store surface admission and observation need. */
export interface ResearchTaskServiceStore {
  getProject(projectId: string): unknown;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
  assertSessionWritable(sessionId: string): unknown;
  /** The owning conversation run's status, used to refuse a late launch. */
  getSessionRun?(
    sessionId: string,
    runId: string,
  ): Promise<{ readonly status: string } | undefined> | { readonly status: string } | undefined;
}

/** Durable research-line storage, supplied by the product's store. */
export interface ResearchTaskLineStore<Record> {
  get(projectId: string, sessionId: string, lineKey: string): ResearchBudgetLine | undefined;
  /** Persist a projected line; the product may add its own domain fields. */
  put(line: ResearchBudgetLine, record: Record): void;
}

/** A product's frozen budget-line facts for one stored record. */
export interface ResearchLineFacts {
  readonly lineKey: string;
  readonly lineId: string;
  readonly limits?: { readonly maxChildRuns: number; readonly totalAllowanceSec: number };
  readonly children: readonly ResearchBudgetChild[];
  readonly extraChargedSeconds?: number;
}

export type ResearchStartPlan<Record> =
  /** Product resolution found the request was already accepted; attach to it. */
  | { readonly attachTo: Record }
  | {
    /** The fully built accepted record; its identity columns are re-validated. */
    readonly record: Record;
    /** The key recomputed after product resolution (selection, inputs, ...). */
    readonly dedupeKey: string;
    readonly line: ResearchLineFacts & {
      readonly allowanceSec: number;
      /** The durable start-decision summary; a neutral default is used when absent. */
      readonly startSummary?: string;
    };
    /** Product bookkeeping after the record and its reservation are durable. */
    readonly onAccepted?: (record: Record) => void;
  };

export interface ResearchStartContext<Record extends ResearchTaskRecord> {
  readonly operations: ResearchTaskStore<Record>;
  readonly lifecycle: ResearchOperationLifecycle<Record>;
  readonly writer: ResearchOperationWriter<Record>;
  readonly now: () => string;
  readonly newOperationId: () => string;
  /** The stored line, when one exists, before this request is reserved. */
  readonly lineFor: (facts: { readonly lineKey: string; readonly sessionId: string; readonly projectId: string })
    => ResearchBudgetLine | undefined;
}

/**
 * What the registered engine itself can do. These are declarations used to
 * read results honestly; they never promise a capability the adapter does not
 * implement.
 */
export interface ResearchEngineCapabilities {
  /** `launch` may return while the engine is still running. */
  readonly asynchronousLaunch: boolean;
  /** The engine has an authoritative termination record `confirmStop` reads. */
  readonly confirmsStop: boolean;
  /** Observed records may carry a real elapsed wall clock. */
  readonly reportsElapsedSec: boolean;
  /** Observed records may carry real token usage. */
  readonly reportsTokenUsage: boolean;
  /** What `deliver` publishes; a product-specific description. */
  readonly delivers: string;
}

/**
 * The product extension points. None of them may be skipped by a product to
 * re-implement persistence, deduplication, cancellation or budget admission:
 * the shared service always runs those steps around the hooks.
 */
export interface ResearchTaskProduct<
  Request,
  Delivery extends ResearchDeliveryProgress,
  Record extends ResearchTaskRecord<Delivery>,
  View,
> {
  /** Stable engine/product identity written beside the operation. */
  readonly engineId: string;
  readonly capabilities: ResearchEngineCapabilities;
  readonly engine: ResearchEngineAdapter<Record, Delivery>;
  /** Identify the request before any lookup or write. */
  requestIdentity(request: Request): ResearchTaskRequestIdentity;
  /** Product permission/configuration gate; runs before admission writes. */
  authorize(request: Request): Promise<void> | void;
  /** Cheap idempotency identity of the accepted request. */
  idempotencyKey(request: Request): string;
  /** Validate and freeze the product's request, then build the record. */
  planStart(request: Request, context: ResearchStartContext<Record>): Promise<ResearchStartPlan<Record>>;
  /** The product's refusal error, so callers keep their stable reason codes. */
  refuse(reason: string, message: string): Error;
  /** Project one stored record to the product's public view. */
  present(record: Record): Promise<View> | View;
  /** Project many records with their product relations. */
  list?(projectId: string, sessionId: string, records: readonly Record[]): Promise<readonly View[]> | readonly View[];
  /** The frozen line facts for one stored record, for settlement and stops. */
  lineFactsFor(record: Record): ResearchLineFacts | undefined;
  afterObserve?(record: Record): Promise<void> | void;
  afterStop?(record: Record): Promise<void> | void;
  /** Product audit after the shared service recorded a terminal outcome. */
  onTerminal?(record: Record): void;
}

export interface ResearchTaskServiceOptions<
  Request,
  Delivery extends ResearchDeliveryProgress,
  Record extends ResearchTaskRecord<Delivery>,
  View,
> {
  readonly store: ResearchTaskServiceStore;
  readonly operations: ResearchTaskStore<Record>;
  readonly lines: ResearchTaskLineStore<Record>;
  readonly product: ResearchTaskProduct<Request, Delivery, Record, View>;
  readonly observeMaxWaitMs: number;
  /** True when the owning conversation run was cancelled or interrupted. */
  readonly ownerStopped?: (sessionId: string, runId: string) => Promise<boolean>;
  readonly now?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newOperationId?: () => string;
  readonly errorMessage?: (error: unknown) => string;
}

export interface ResearchTaskStartOutcome<Record, View> {
  readonly record: Record;
  readonly view: View;
  readonly attached: boolean;
  readonly attachedReason?: "same-request" | "active-operation";
}

export interface ResearchTaskStopOutcome<Record, View> {
  readonly record: Record;
  readonly view: View;
  readonly requested: boolean;
  readonly confirmed: boolean;
  readonly reason?: "already-terminal";
}

export interface ResearchTaskOperationInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly operationId?: string;
}

export interface ResearchTaskService<Request, Record extends ResearchTaskRecord, View> {
  start(request: Request): Promise<ResearchTaskStartOutcome<Record, View>>;
  get(
    input: ResearchTaskOperationInput,
    options?: { readonly waitMs?: number; readonly signal?: AbortSignal },
  ): Promise<{ readonly record: Record; readonly view: View }>;
  stop(input: ResearchTaskOperationInput): Promise<ResearchTaskStopOutcome<Record, View>>;
  retryDelivery(input: ResearchTaskOperationInput): Promise<{ readonly record: Record; readonly view: View }>;
  cancelOwnerRun(sessionId: string, runId: string): Promise<void>;
  list(projectId: string, sessionId: string): Promise<readonly View[]>;
  latest(projectId: string, sessionId: string): Record | undefined;
  /** The shared lifecycle, for product steps that reconcile before reserving. */
  readonly lifecycle: ResearchOperationLifecycle<Record>;
  /** Project and persist the line's settlement for one terminal record. */
  settleLine(record: Record): void;
}

const DEFAULT_REFUSAL_MESSAGE = "The research request was refused";

export function createResearchTaskService<
  Request,
  Delivery extends ResearchDeliveryProgress,
  Record extends ResearchTaskRecord<Delivery>,
  View,
>(options: ResearchTaskServiceOptions<Request, Delivery, Record, View>): ResearchTaskService<Request, Record, View> {
  const { store, operations, lines, product } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const newOperationId = options.newOperationId ?? (() => randomUUID());
  const errorMessage = options.errorMessage ?? defaultErrorMessage;

  const ownerStopped = options.ownerStopped ?? (async (sessionId: string, runId: string): Promise<boolean> => {
    if (!store.getSessionRun) return false;
    const run = await store.getSessionRun(sessionId, runId);
    return run?.status === "cancelled" || run?.status === "interrupted";
  });

  const writer: ResearchOperationWriter<Record> = {
    get: (operationId) => operations.get(operationId),
    mutate: (operationId, change) => {
      const current = operations.get(operationId);
      if (!current) throw product.refuse("operation-not-found", "The research operation does not exist");
      const next: Record = { ...change(current), updatedAt: now() };
      operations.update(next);
      return next;
    },
  };

  const persistLine = (record: Record): void => {
    const facts = product.lineFactsFor(record);
    if (!facts) return;
    const existing = lines.get(record.identity.projectId, record.identity.sessionId, facts.lineKey);
    const projected = projectResearchBudgetLine({
      children: facts.children,
      existing,
      identity: record.identity,
      limits: facts.limits,
      lineId: facts.lineId,
      lineKey: facts.lineKey,
      now: now(),
    });
    lines.put(projected, record);
  };

  const settleLine = (record: Record): void => {
    if (!isTerminalTaskState(record.state)) return;
    persistLine(record);
  };

  const markLineStop = (
    record: Record,
    requestedBy: ResearchStopRequester,
    at: string,
    confirmed: boolean,
  ): void => {
    const facts = product.lineFactsFor(record);
    if (!facts) return;
    const existing = lines.get(record.identity.projectId, record.identity.sessionId, facts.lineKey);
    let line = projectResearchBudgetLine({
      children: facts.children,
      existing,
      identity: record.identity,
      limits: facts.limits,
      lineId: facts.lineId,
      lineKey: facts.lineKey,
      now: at,
    });
    const previousStop = line.stop;
    const alreadyRequested = previousStop.requestedAt !== undefined
      && previousStop.operationId === record.operationId;
    line = {
      ...line,
      stop: {
        ...line.stop,
        operationId: record.operationId,
        ownerRunId: record.ownerRunId,
        requestedAt: at,
        requestedBy,
        ...(confirmed ? { confirmedAt: at } : {}),
      },
      updatedAt: at,
    };
    if (!alreadyRequested) {
      line = withResearchBudgetDecision(line, {
        at,
        kind: "stop-requested",
        operationId: record.operationId,
        summary: `stop requested by ${requestedBy} for ${record.operationId}`,
      });
    }
    if (confirmed && previousStop.confirmedAt === undefined) {
      line = withResearchBudgetDecision(line, {
        at,
        kind: "stop-confirmed",
        operationId: record.operationId,
        summary: `engine confirmed termination of ${record.operationId}`,
      });
    }
    lines.put(line, record);
  };

  const lifecycle = createResearchOperationLifecycle<Record, Delivery>({
    engine: product.engine,
    errorMessage,
    now,
    observeMaxWaitMs: options.observeMaxWaitMs,
    onStopConfirmed: (record, at, requestedBy) => {
      markLineStop(record, requestedBy, at, true);
      product.onTerminal?.(record);
    },
    onStopRequested: (record, at, requestedBy) => markLineStop(record, requestedBy, at, false),
    onTerminal: (record) => {
      settleLine(record);
      product.onTerminal?.(record);
    },
    operations: writer,
    ownerStopped,
    sleep,
  });

  const context: ResearchStartContext<Record> = {
    lineFor: (facts) => lines.get(facts.projectId, facts.sessionId, facts.lineKey),
    lifecycle,
    newOperationId,
    now,
    operations,
    writer,
  };

  const assertUsableIdentity = (identity: ResearchTaskRequestIdentity): void => {
    for (const value of [identity.projectId, identity.sessionId, identity.ownerRunId]) {
      if (typeof value !== "string" || !value.trim()) {
        throw product.refuse("invalid-option", "The Project, Session and run ids must be non-blank business ids");
      }
    }
  };

  const requireProjectSession = (projectId: string, sessionId: string): void => {
    if (!store.getProject(projectId)) {
      throw product.refuse("project-not-found", "The Project does not exist");
    }
    const session = store.getSession(sessionId);
    if (!session || session.projectId !== projectId) {
      throw product.refuse("session-not-found", "The Session does not exist in this Project");
    }
  };

  const resolveRecord = (input: ResearchTaskOperationInput): Record => {
    requireProjectSession(input.projectId, input.sessionId);
    const rows = operations.listForSession(input.projectId, input.sessionId);
    const record = input.operationId
      ? rows.find((candidate) => candidate.operationId === input.operationId)
      : [...rows].reverse().find((candidate) => !isTerminalTaskState(candidate.state)) ?? rows.at(-1);
    if (!record) {
      throw product.refuse("operation-not-found", "This Session has no research operation to observe");
    }
    if (record.identity.projectId !== input.projectId || record.identity.sessionId !== input.sessionId) {
      // The lookup is already Session-scoped; keep the guard explicit so a
      // future lookup change cannot retarget another Session.
      throw product.refuse("operation-identity-mismatch", "The research operation belongs to another Session");
    }
    return record;
  };

  const present = async (record: Record): Promise<View> => product.present(record);

  const start = async (request: Request): Promise<ResearchTaskStartOutcome<Record, View>> => {
    const identity = product.requestIdentity(request);
    assertUsableIdentity(identity);
    requireProjectSession(identity.projectId, identity.sessionId);
    store.assertSessionWritable(identity.sessionId);
    await product.authorize(request);

    const key = product.idempotencyKey(request);
    const existing = operations.findByIdempotency(identity.projectId, identity.sessionId, key);
    if (existing) {
      return {
        attached: true,
        attachedReason: "same-request",
        record: existing,
        view: await present(existing),
      };
    }
    // One conversation run owns at most one live experiment; a second start
    // attaches instead of launching a second paid run.
    const active = operations
      .listForSession(identity.projectId, identity.sessionId)
      .find((candidate) => candidate.ownerRunId === identity.ownerRunId && !isTerminalTaskState(candidate.state));
    if (active) {
      return {
        attached: true,
        attachedReason: "active-operation",
        record: active,
        view: await present(active),
      };
    }
    // A start that arrives after its conversation run was cancelled must not
    // create an operation no cancel path owns any more.
    if (await ownerStopped(identity.sessionId, identity.ownerRunId)) {
      throw product.refuse(
        "conversation-cancelled",
        "The conversation run that would own this experiment was cancelled",
      );
    }

    const plan = await product.planStart(request, context);
    if ("attachTo" in plan) {
      return {
        attached: true,
        attachedReason: "same-request",
        record: plan.attachTo,
        view: await present(plan.attachTo),
      };
    }
    assertPlanIdentity(plan, identity, product);
    // The early key was computed before product resolution (for example an
    // automatic selection). Re-check so a replay attaches to its operation.
    if (plan.dedupeKey !== key) {
      const resolvedExisting = operations.findByIdempotency(
        identity.projectId,
        identity.sessionId,
        plan.dedupeKey,
      );
      if (resolvedExisting) {
        return {
          attached: true,
          attachedReason: "same-request",
          record: resolvedExisting,
          view: await present(resolvedExisting),
        };
      }
    }

    const storedLine = lines.get(identity.projectId, identity.sessionId, plan.line.lineKey);
    const refusal = budgetRefusal(storedLine, plan, identity, now());
    if (refusal) throw product.refuse(refusal.reason, refusal.message);

    const accepted: Record = plan.record.engineId === undefined
      ? { ...plan.record, engineId: product.engineId }
      : plan.record;
    const stored = operations.createIfAbsent(accepted);
    if (!stored.created) {
      return {
        attached: true,
        attachedReason: "same-request",
        record: stored.record,
        view: await present(stored.record),
      };
    }

    // The accepted child is the line's one reservation until it is terminal.
    const acceptedChild: ResearchBudgetChild = {
      createdAt: stored.record.createdAt,
      operationId: stored.record.operationId,
      reservedSec: plan.line.allowanceSec,
      state: stored.record.state,
      updatedAt: stored.record.updatedAt,
      launched: false,
    };
    let line = projectResearchBudgetLine({
      children: [...plan.line.children, acceptedChild],
      existing: storedLine,
      identity: stored.record.identity,
      limits: plan.line.limits,
      lineId: plan.line.lineId,
      lineKey: plan.line.lineKey,
      now: now(),
    });
    // A start from a later conversation run supersedes an earlier stop; the
    // stop event itself stays in the decision history.
    if (line.stop.requestedAt !== undefined
      && line.stop.ownerRunId !== undefined && line.stop.ownerRunId !== identity.ownerRunId) {
      line = { ...line, stop: {} };
    }
    const decision: ResearchBudgetDecision = {
      at: now(),
      kind: "start",
      operationId: stored.record.operationId,
      summary: plan.line.startSummary
        ?? `started ${stored.record.operationId} with a ${plan.line.allowanceSec}s reservation`,
    };
    lines.put(withResearchBudgetDecision(line, decision), stored.record);

    plan.onAccepted?.(stored.record);
    // Return the operation identity now; the engine run continues in the
    // background so one HTTP request or tool call is not held open for it.
    void lifecycle.execute(stored.record.operationId).catch(() => undefined);
    return {
      attached: false,
      record: stored.record,
      view: await present(stored.record),
    };
  };

  return {
    cancelOwnerRun: async (sessionId, runId) => {
      const session = store.getSession(sessionId);
      if (!session) return;
      const owned = operations
        .listForSession(session.projectId, sessionId)
        .filter((candidate) => candidate.ownerRunId === runId && !isTerminalTaskState(candidate.state));
      await lifecycle.stopConversationRun(owned);
    },
    async get(input, getOptions = {}) {
      const record = resolveRecord(input);
      const observed = await lifecycle.observe(record, getOptions);
      await product.afterObserve?.(observed);
      const latest = operations.get(observed.operationId) ?? observed;
      return { record: latest, view: await present(latest) };
    },
    latest(projectId, sessionId) {
      const rows = operations.listForSession(projectId, sessionId);
      return [...rows].reverse().find((candidate) => !isTerminalTaskState(candidate.state)) ?? rows.at(-1);
    },
    lifecycle,
    async list(projectId, sessionId) {
      requireProjectSession(projectId, sessionId);
      const records = operations.listForSession(projectId, sessionId);
      if (product.list) return await product.list(projectId, sessionId, records);
      return await Promise.all(records.map((record) => present(record)));
    },
    async retryDelivery(input) {
      const record = resolveRecord(input);
      const updated = await lifecycle.retryDelivery(record);
      await product.afterObserve?.(updated);
      const latest = operations.get(record.operationId) ?? updated;
      return { record: latest, view: await present(latest) };
    },
    settleLine,
    async stop(input) {
      const record = resolveRecord(input);
      const outcome = await lifecycle.stop(record);
      await product.afterStop?.(outcome.record);
      const latest = operations.get(outcome.record.operationId) ?? outcome.record;
      return {
        confirmed: outcome.confirmed,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        record: latest,
        requested: outcome.requested,
        view: await present(latest),
      };
    },
    start,
  };
}

function budgetRefusal<Record>(
  storedLine: ResearchBudgetLine | undefined,
  plan: Extract<ResearchStartPlan<Record>, { readonly record: Record }>,
  identity: ResearchTaskRequestIdentity,
  now: string,
): ResearchBudgetRefusal | undefined {
  const projected = projectResearchBudgetLine({
    children: plan.line.children,
    existing: storedLine,
    identity: { projectId: identity.projectId, sessionId: identity.sessionId },
    limits: plan.line.limits,
    lineId: plan.line.lineId,
    lineKey: plan.line.lineKey,
    now,
  });
  return researchBudgetLineRefusal({
    allowanceSec: plan.line.allowanceSec,
    children: plan.line.children,
    line: projected,
    now,
    ownerRunId: identity.ownerRunId,
    viewOptions: {
      ...(plan.line.extraChargedSeconds === undefined
        ? {}
        : { extraChargedSeconds: plan.line.extraChargedSeconds }),
    },
  });
}

function assertPlanIdentity<Request, Delivery extends ResearchDeliveryProgress, Record extends ResearchTaskRecord<Delivery>, View>(
  plan: Extract<ResearchStartPlan<Record>, { readonly record: Record }>,
  identity: ResearchTaskRequestIdentity,
  product: ResearchTaskProduct<Request, Delivery, Record, View>,
): void {
  const record = plan.record;
  if (
    record.identity.projectId !== identity.projectId
    || record.identity.sessionId !== identity.sessionId
    || record.ownerRunId !== identity.ownerRunId
    || record.idempotencyKey !== plan.dedupeKey
    || (record.engineId !== undefined && record.engineId !== product.engineId)
    || record.state !== "accepted"
    || typeof record.operationId !== "string"
    || !record.operationId
  ) {
    throw product.refuse(
      "invalid-option",
      "The product prepared an operation that does not match the admitted request",
    );
  }
}

function defaultErrorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500) || DEFAULT_REFUSAL_MESSAGE;
}
