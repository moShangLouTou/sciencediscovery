// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { DatabaseSync } from "node:sqlite";
import type { ResearchBudgetLine } from "./budget.js";
import { isPlainRecord } from "./task-record.js";
import { ResearchScopeRepository, ResearchScopeCorruptError } from "./scope-repository.js";
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown) => typeof value === "string" && value.length > 0;
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
function tokens(value: unknown): boolean {
  return isPlainRecord(value) && oneOf(value.status, ["known", "partially-known", "unknown", "not-launched"])
    && ["calls", "completedCalls", "failedCalls", "unknownUsageCalls", "inputTokens", "outputTokens"]
      .every((key) => amount(value[key]) && Number.isSafeInteger(value[key]));
}
function line(value: unknown): value is ResearchBudgetLine {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !text(value.lineId) || !text(value.lineKey)
    || !date(value.createdAt) || !date(value.updatedAt) || !isPlainRecord(value.identity)
    || !text(value.identity.projectId) || !text(value.identity.sessionId)) return false;
  const limits = value.limits;
  if (limits !== null && (!isPlainRecord(limits) || !amount(limits.totalAllowanceSec)
    || !Number.isSafeInteger(limits.maxChildRuns) || typeof limits.maxChildRuns !== "number"
    || limits.maxChildRuns < 1 || !date(limits.deadlineAt))) return false;
  if (!Array.isArray(value.reservations) || !value.reservations.every((entry: unknown) => isPlainRecord(entry)
    && text(entry.operationId) && date(entry.reservedAt) && amount(entry.reservedSec))) return false;
  if (!Array.isArray(value.settlements) || !value.settlements.every((entry: unknown) => isPlainRecord(entry)
    && text(entry.operationId) && date(entry.settledAt) && tokens(entry.tokens) && isPlainRecord(entry.wallClock)
    && oneOf(entry.wallClock.status, ["known", "unknown", "not-launched"])
    && oneOf(entry.wallClock.source, ["launch-receipt", "reserved-allowance", "operation-record"])
    && amount(entry.wallClock.chargedSeconds) && (entry.wallClock.seconds === null || amount(entry.wallClock.seconds)))) return false;
  if (!Array.isArray(value.decisions) || !value.decisions.every((entry: unknown) => isPlainRecord(entry)
    && date(entry.at) && typeof entry.summary === "string" && (entry.operationId === undefined || text(entry.operationId))
    && oneOf(entry.kind, ["start", "settle", "stop-requested", "stop-confirmed", "select"]))) return false;
  if (!isPlainRecord(value.stop)) return false;
  const stop = value.stop;
  return ["requestedAt", "confirmedAt"].every((key) => stop[key] === undefined || date(stop[key]))
    && ["ownerRunId", "operationId"].every((key) => stop[key] === undefined || text(stop[key]))
    && (stop.requestedBy === undefined || oneOf(stop.requestedBy, ["tool", "conversation-cancel"]));
}
/** Ready-to-use neutral budget persistence; SF binds its existing extended rows to the same scope repository. */
export class ResearchBudgetRepository extends ResearchScopeRepository<ResearchBudgetLine> {
  constructor(database: DatabaseSync, table = "research_budget_lines") {
    super(database, { table, codec: {
      identity: (value) => ({ ...value.identity, scopeKey: value.lineKey, changedAt: value.updatedAt }),
      decode(value, identity) {
        if (!line(value) || value.identity.projectId !== identity.projectId || value.identity.sessionId !== identity.sessionId
          || value.lineKey !== identity.scopeKey || value.updatedAt !== identity.changedAt) throw new ResearchScopeCorruptError();
        return value;
      },
    } });
  }
}
