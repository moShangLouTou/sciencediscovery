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
 * The engine-neutral research-line budget ledger.
 *
 * A research line groups child runs under one frozen product identity key (for
 * example one scientific contract). This module owns the reusable mechanism:
 * the line deadline, the child-run limit, per-line wall-clock reservations and
 * settlements, the single active child, the stop recorded for one conversation
 * run, and the durable decision history. It does not understand what a metric,
 * evaluator, score direction or comparison group means; the product supplies
 * the frozen line key and the per-child usage facts.
 *
 * The ledger is a durable projection, not an in-memory counter: a rebuilt
 * service reconstructs the same answer from stored children and stored
 * settlements. A child that was launched but whose elapsed time is unknown is
 * charged its reservation, never zero.
 */
import { isTerminalTaskState } from "./task-record.js";
import type { ResearchEngineLaunchBudget, ResearchLifecycleState } from "./engine-adapter.js";

export const RESEARCH_BUDGET_LINE_VERSION = 1;
export const RESEARCH_BUDGET_DECISION_LIMIT = 200;

export interface ResearchBudgetLimits {
  readonly maxChildRuns: number;
  readonly totalAllowanceSec: number;
  /** `createdAt + totalAllowanceSec`; enforced before a new child is reserved. */
  readonly deadlineAt: string;
}

export interface ResearchBudgetReservation {
  readonly operationId: string;
  readonly reservedSec: number;
  readonly reservedAt: string;
}

export interface ResearchBudgetWallClock {
  readonly status: "known" | "unknown" | "not-launched";
  readonly seconds: number | null;
  /** What the line is charged: known seconds, the reservation, or observed time. */
  readonly chargedSeconds: number;
  readonly source: "launch-receipt" | "reserved-allowance" | "operation-record";
}

export interface ResearchBudgetTokenUsage {
  readonly status: "known" | "partially-known" | "unknown" | "not-launched";
  readonly calls: number;
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly unknownUsageCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ResearchBudgetSettlement {
  readonly operationId: string;
  readonly settledAt: string;
  readonly wallClock: ResearchBudgetWallClock;
  readonly tokens: ResearchBudgetTokenUsage;
}

export type ResearchBudgetDecisionKind =
  | "start"
  | "settle"
  | "stop-requested"
  | "stop-confirmed"
  | "select";

export interface ResearchBudgetDecision {
  readonly at: string;
  readonly kind: ResearchBudgetDecisionKind;
  readonly operationId?: string;
  readonly summary: string;
}

export interface ResearchBudgetStop {
  readonly requestedAt?: string;
  readonly requestedBy?: "tool" | "conversation-cancel";
  readonly ownerRunId?: string;
  readonly operationId?: string;
  readonly confirmedAt?: string;
}

/** The durable state of one research line. */
export interface ResearchBudgetLine {
  readonly schemaVersion: typeof RESEARCH_BUDGET_LINE_VERSION;
  readonly lineId: string;
  readonly lineKey: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: ResearchBudgetLimits | null;
  readonly reservations: readonly ResearchBudgetReservation[];
  readonly settlements: readonly ResearchBudgetSettlement[];
  readonly decisions: readonly ResearchBudgetDecision[];
  readonly stop: ResearchBudgetStop;
}

export interface ResearchBudgetTokenFacts {
  readonly calls: number;
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly unknownUsageCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The neutral facts one child contributes to its line. */
export interface ResearchBudgetChild {
  readonly operationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ResearchLifecycleState;
  /** The wall clock this line reserved when the child was accepted. */
  readonly reservedSec: number;
  /** True once the engine was actually launched (or reported a status). */
  readonly launched: boolean;
  /** The engine's reported elapsed wall clock, when it is known. */
  readonly elapsedSec?: number;
  /** The engine's recorded token usage, when it reported one. */
  readonly usage?: ResearchBudgetTokenFacts | null;
}

export interface ResearchBudgetViewCore {
  readonly lineId: string;
  readonly lineKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: ResearchBudgetLimits | null;
  readonly enforcement: {
    readonly runCount: boolean;
    readonly wallClock: boolean;
    /** This path cannot observe a total token cap; it is recorded, never promised. */
    readonly tokenCap: false;
  };
  readonly runs: { readonly started: number; readonly settled: number; readonly active: number };
  readonly usage: {
    readonly wallClock: {
      readonly knownSeconds: number;
      readonly chargedSeconds: number;
      readonly reservedSeconds: number;
      readonly unknownSettlements: number;
      readonly notLaunched: number;
      readonly remainingSeconds: number | null;
    };
    readonly tokens: ResearchBudgetTokenUsage;
  };
  readonly activeChild: {
    readonly operationId: string;
    readonly state: ResearchLifecycleState;
    readonly reservedSec: number;
  } | null;
  readonly deadlinePassed: boolean;
  readonly stop: ResearchBudgetStop;
  readonly decisions: readonly ResearchBudgetDecision[];
}

export type ResearchBudgetRefusalReason =
  | "research-line-busy"
  | "research-line-stopped"
  | "parent-budget-exhausted"
  | "parent-deadline-exceeded";

export interface ResearchBudgetRefusal {
  readonly reason: ResearchBudgetRefusalReason;
  readonly message: string;
}

export interface ResearchBudgetViewOptions {
  /**
   * Product-owned wall clock already attributable to this line (for example a
   * preparation or evaluator probe). It is charged like a settlement.
   */
  readonly extraChargedSeconds?: number;
}

/**
 * Project the line from its stored children. Terminal children are settled once
 * and kept; active children keep their reservation. A changed projection is
 * returned; an unchanged one keeps the existing timestamps and history.
 */
export function projectResearchBudgetLine(input: {
  readonly existing: ResearchBudgetLine | undefined;
  readonly children: readonly ResearchBudgetChild[];
  readonly lineId: string;
  readonly lineKey: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly limits: { readonly maxChildRuns: number; readonly totalAllowanceSec: number } | undefined;
  readonly now: string;
}): ResearchBudgetLine {
  const ordered = [...input.children].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId),
  );
  const existing = input.existing;
  const createdAt = existing?.createdAt ?? ordered[0]?.createdAt ?? input.now;
  const limits = existing?.limits ?? (input.limits
    ? {
        deadlineAt: new Date(Date.parse(createdAt) + input.limits.totalAllowanceSec * 1_000).toISOString(),
        maxChildRuns: input.limits.maxChildRuns,
        totalAllowanceSec: input.limits.totalAllowanceSec,
      }
    : null);
  const previousReservations = new Map((existing?.reservations ?? []).map((row) => [row.operationId, row]));
  const reservations: ResearchBudgetReservation[] = [];
  const settlements = [...(existing?.settlements ?? [])];
  const settled = new Set(settlements.map((row) => row.operationId));
  const decisions = [...(existing?.decisions ?? [])];
  let changed = existing === undefined;
  for (const child of ordered) {
    if (isTerminalTaskState(child.state)) {
      if (!settled.has(child.operationId)) {
        const reservation = previousReservations.get(child.operationId);
        const settlement = settleResearchBudgetChild(child, reservation, input.now);
        settlements.push(settlement);
        settled.add(child.operationId);
        decisions.push({
          at: settlement.settledAt,
          kind: "settle",
          operationId: child.operationId,
          summary: settlementSummary(settlement),
        });
        changed = true;
      }
      continue;
    }
    const reservation = previousReservations.get(child.operationId) ?? {
      operationId: child.operationId,
      reservedAt: child.createdAt,
      reservedSec: child.reservedSec,
    };
    reservations.push(reservation);
    if (!previousReservations.has(child.operationId)) changed = true;
  }
  if (reservations.length !== (existing?.reservations.length ?? 0)) changed = true;
  if (settlements.length !== (existing?.settlements.length ?? 0)) changed = true;
  const stop = existing?.stop ?? {};
  const next: ResearchBudgetLine = {
    createdAt,
    decisions: decisions.slice(-RESEARCH_BUDGET_DECISION_LIMIT),
    identity: input.identity,
    limits,
    lineId: existing?.lineId ?? input.lineId,
    lineKey: input.lineKey,
    reservations,
    schemaVersion: RESEARCH_BUDGET_LINE_VERSION,
    settlements,
    stop,
    updatedAt: input.now,
  };
  return changed ? next : { ...next, decisions: existing!.decisions, updatedAt: existing!.updatedAt };
}

/** The settlement charged to one terminal child. */
export function settleResearchBudgetChild(
  child: ResearchBudgetChild,
  reservation: ResearchBudgetReservation | undefined,
  now: string,
): ResearchBudgetSettlement {
  const reservedSec = reservation?.reservedSec ?? child.reservedSec;
  const elapsed = child.elapsedSec;
  const wallClock: ResearchBudgetWallClock = typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0
    ? { chargedSeconds: elapsed, seconds: elapsed, source: "launch-receipt", status: "known" }
    : child.launched
      ? { chargedSeconds: reservedSec, seconds: null, source: "reserved-allowance", status: "unknown" }
      : (() => {
          // A preparation that never reached a launch still spent the accepted
          // operation's own wall clock. Charge what the record shows instead of
          // silently releasing it as zero.
          const created = Date.parse(child.createdAt);
          const updated = Date.parse(child.updatedAt);
          const observed = Number.isFinite(created) && Number.isFinite(updated) && updated >= created
            ? (updated - created) / 1_000
            : 0;
          return {
            chargedSeconds: observed,
            seconds: observed,
            source: "operation-record" as const,
            status: "not-launched" as const,
          };
        })();
  return {
    operationId: child.operationId,
    settledAt: child.updatedAt || now,
    tokens: tokenUsage(child, child.launched),
    wallClock,
  };
}

function tokenUsage(child: ResearchBudgetChild, launched: boolean): ResearchBudgetTokenUsage {
  const usage = child.usage;
  if (usage) {
    return {
      calls: usage.calls,
      completedCalls: usage.completedCalls,
      failedCalls: usage.failedCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      status: usage.unknownUsageCalls > 0 ? "partially-known" : "known",
      unknownUsageCalls: usage.unknownUsageCalls,
    };
  }
  return {
    calls: 0,
    completedCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    status: launched ? "unknown" : "not-launched",
    unknownUsageCalls: 0,
  };
}

function settlementSummary(settlement: ResearchBudgetSettlement): string {
  const wall = settlement.wallClock.status === "known"
    ? `${settlement.wallClock.seconds}s recorded`
    : settlement.wallClock.status === "unknown"
      ? "wall clock unknown; charged at the reserved allowance"
      : "no engine launch";
  const tokens = settlement.tokens.status === "unknown"
    ? "token usage unknown"
    : `${settlement.tokens.inputTokens + settlement.tokens.outputTokens} tokens recorded`;
  return `settled ${settlement.operationId}: ${wall}; ${tokens}`;
}

/** The neutral budget/usage view of one line. */
export function researchBudgetLineView(
  line: ResearchBudgetLine,
  children: readonly ResearchBudgetChild[],
  now: string,
  options: ResearchBudgetViewOptions = {},
): ResearchBudgetViewCore {
  const extraChargedSeconds = Math.max(0, options.extraChargedSeconds ?? 0);
  const reservations = line.reservations;
  const reservedSeconds = reservations.reduce((total, row) => total + row.reservedSec, 0);
  const knownSeconds = line.settlements.reduce(
    (total, row) => total + (row.wallClock.status === "known" ? row.wallClock.seconds ?? 0 : 0),
    0,
  );
  const runChargedSeconds = line.settlements.reduce((total, row) => total + row.wallClock.chargedSeconds, 0);
  const unknownSettlements = line.settlements.filter((row) => row.wallClock.status === "unknown").length;
  const notLaunched = line.settlements.filter((row) => row.wallClock.status === "not-launched").length;
  const active = children.filter((child) => !isTerminalTaskState(child.state));
  const tokenRows = line.settlements.map((row) => row.tokens);
  const tokensStatus = tokenRows.some((row) => row.status === "unknown")
    ? "unknown"
    : tokenRows.some((row) => row.status === "partially-known")
      ? "partially-known"
      : tokenRows.some((row) => row.status === "known")
        ? "known"
        : "not-launched";
  const chargedSeconds = runChargedSeconds + extraChargedSeconds;
  const remainingSeconds = line.limits === null
    ? null
    : Math.max(0, line.limits.totalAllowanceSec - chargedSeconds - reservedSeconds);
  return {
    activeChild: active.length === 0
      ? null
      : {
          operationId: active[0]!.operationId,
          reservedSec: reservations.find((row) => row.operationId === active[0]!.operationId)?.reservedSec
            ?? active[0]!.reservedSec,
          state: active[0]!.state,
        },
    createdAt: line.createdAt,
    deadlinePassed: line.limits !== null && Date.parse(now) > Date.parse(line.limits.deadlineAt),
    decisions: line.decisions,
    enforcement: {
      runCount: line.limits !== null,
      tokenCap: false,
      wallClock: line.limits !== null,
    },
    limits: line.limits,
    lineId: line.lineId,
    lineKey: line.lineKey,
    runs: {
      active: active.length,
      settled: line.settlements.length,
      started: children.length,
    },
    stop: line.stop,
    updatedAt: line.updatedAt,
    usage: {
      tokens: {
        calls: tokenRows.reduce((total, row) => total + row.calls, 0),
        completedCalls: tokenRows.reduce((total, row) => total + row.completedCalls, 0),
        failedCalls: tokenRows.reduce((total, row) => total + row.failedCalls, 0),
        inputTokens: tokenRows.reduce((total, row) => total + row.inputTokens, 0),
        outputTokens: tokenRows.reduce((total, row) => total + row.outputTokens, 0),
        status: tokensStatus,
        unknownUsageCalls: tokenRows.reduce((total, row) => total + row.unknownUsageCalls, 0),
      },
      wallClock: {
        chargedSeconds,
        knownSeconds,
        notLaunched,
        remainingSeconds,
        reservedSeconds,
        unknownSettlements,
      },
    },
  };
}

/**
 * Whether this line may accept one more child. Checked before a record is
 * created, so a refused start spends nothing.
 */
export function researchBudgetLineRefusal(input: {
  readonly line: ResearchBudgetLine;
  readonly children: readonly ResearchBudgetChild[];
  readonly allowanceSec: number;
  readonly ownerRunId: string;
  readonly now: string;
  readonly excludeOperationId?: string;
  readonly viewOptions?: ResearchBudgetViewOptions;
}): ResearchBudgetRefusal | undefined {
  const active = input.children.filter((child) =>
    !isTerminalTaskState(child.state) && child.operationId !== input.excludeOperationId);
  if (active.length > 0) {
    return {
      message: `This research line already has an active experiment (${active[0]!.operationId}); it runs one child at a time`,
      reason: "research-line-busy",
    };
  }
  if (input.line.stop.requestedAt && input.line.stop.ownerRunId === input.ownerRunId) {
    return {
      message: "This research line was stopped in this conversation; a later conversation run must request a new start explicitly",
      reason: "research-line-stopped",
    };
  }
  if (input.line.limits === null) return undefined;
  const deadlineMs = Date.parse(input.line.limits.deadlineAt);
  const nowMs = Date.parse(input.now);
  const remainingSec = Number.isFinite(deadlineMs) && Number.isFinite(nowMs)
    ? (deadlineMs - nowMs) / 1_000
    : 0;
  if (remainingSec <= 0) {
    return {
      message: `The research line reached its deadline (${input.line.limits.deadlineAt}); no further child may be reserved`,
      reason: "parent-deadline-exceeded",
    };
  }
  // A child is granted a fixed wall-clock allowance. Checking only "is it past
  // the deadline now" would admit a 320s grant one second before the deadline;
  // the whole grant has to fit before it is reserved.
  if (input.allowanceSec > remainingSec) {
    return {
      message: `The research line has ${Math.floor(remainingSec)}s before its deadline (${input.line.limits.deadlineAt}); this child needs ${input.allowanceSec}s`,
      reason: "parent-deadline-exceeded",
    };
  }
  const started = input.children.filter((child) => child.operationId !== input.excludeOperationId).length;
  if (started >= input.line.limits.maxChildRuns) {
    return {
      message: `The research line reached its configured limit of ${input.line.limits.maxChildRuns} child runs`,
      reason: "parent-budget-exhausted",
    };
  }
  const view = researchBudgetLineView(
    input.line,
    input.children,
    input.now,
    input.viewOptions ?? {},
  );
  const remaining = view.usage.wallClock.remainingSeconds ?? 0;
  if (input.allowanceSec > remaining) {
    return {
      message: `The research line has ${remaining}s unreserved allowance left; this child needs ${input.allowanceSec}s`,
      reason: "parent-budget-exhausted",
    };
  }
  return undefined;
}

/** Append one decision immutably, keeping the newest bounded history. */
export function withResearchBudgetDecision<
  Line extends { readonly decisions: readonly ResearchBudgetDecision[]; readonly updatedAt: string },
>(line: Line, decision: ResearchBudgetDecision): Line {
  return {
    ...line,
    decisions: [...line.decisions, decision].slice(-RESEARCH_BUDGET_DECISION_LIMIT),
    updatedAt: decision.at,
  };
}

/** Recheck a durable reservation after preparation, excluding only its own hold. */
export function researchBudgetLaunchAllowance(
  line: ResearchBudgetLine,
  children: readonly ResearchBudgetChild[],
  operationId: string,
  ownerRunId: string,
  now: string,
  options: ResearchBudgetViewOptions = {},
): ResearchEngineLaunchBudget | ResearchBudgetRefusal {
  const reservation = line.reservations.find((row) => row.operationId === operationId);
  if (!reservation || !Number.isFinite(reservation.reservedSec) || reservation.reservedSec <= 0) {
    return { reason: "parent-budget-exhausted", message: "The task has no valid durable reservation" };
  }
  const availableLine = { ...line, reservations: line.reservations.filter((row) => row.operationId !== operationId) };
  const view = researchBudgetLineView(availableLine, children, now, options);
  const deadlineSeconds = line.limits === null ? Infinity
    : (Date.parse(line.limits.deadlineAt) - Date.parse(now)) / 1_000;
  const allowanceSec = Math.floor(Math.min(reservation.reservedSec, deadlineSeconds,
    view.usage.wallClock.remainingSeconds ?? Infinity));
  if (!Number.isFinite(allowanceSec) || allowanceSec <= 0) return {
    reason: deadlineSeconds <= 0 ? "parent-deadline-exceeded" : "parent-budget-exhausted",
    message: "The research line's allowance or deadline was exhausted during preparation",
  };
  const refusal = researchBudgetLineRefusal({ line: availableLine, children, allowanceSec, ownerRunId,
    now, excludeOperationId: operationId, viewOptions: options });
  return refusal ?? { allowanceSec, ...(line.limits === null ? {} : { deadlineAt: line.limits.deadlineAt }) };
}
