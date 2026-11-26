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
 * The engine-neutral research-line budget ledger, exercised without a product.
 *
 * These cases pin the reusable mechanism: one settlement per terminal child,
 * a launched child with unknown elapsed time charged its reservation, a
 * preparation that never launched charged its observed wall clock, and a
 * rebuilt projection reading the same reservations and settlements.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import {
  projectResearchBudgetLine,
  researchBudgetLineRefusal,
  researchBudgetLaunchAllowance,
  researchBudgetLineView,
  withResearchBudgetDecision,
  type ResearchBudgetChild,
} from "./budget.js";

const IDENTITY = { projectId: "project-1", sessionId: "session-1" };
const NOW = "2026-11-26T10:05:00.000Z";

function child(overrides: Partial<ResearchBudgetChild> = {}): ResearchBudgetChild {
  return {
    createdAt: "2026-11-26T10:00:00.000Z",
    elapsedSec: 10,
    launched: true,
    operationId: "operation-1",
    reservedSec: 60,
    state: "completed",
    updatedAt: "2026-11-26T10:00:10.000Z",
    ...overrides,
  };
}

function project(
  children: readonly ResearchBudgetChild[],
  existing?: ReturnType<typeof projectResearchBudgetLine>,
) {
  return projectResearchBudgetLine({
    children,
    existing,
    identity: IDENTITY,
    limits: { maxChildRuns: 5, totalAllowanceSec: 600 },
    lineId: "line-1",
    lineKey: "line-key",
    now: NOW,
  });
}

test("a terminal child settles once and a repeated projection does not duplicate it", () => {
  const first = project([child()]);
  assert.equal(first.settlements.length, 1);
  assert.equal(first.settlements[0]!.wallClock.status, "known");
  const second = project([child()], first);
  assert.equal(second.settlements.length, 1);
  assert.equal(second.settlements[0]!.operationId, "operation-1");
  assert.deepEqual(second.decisions, first.decisions);
});

test("a launched child with unknown elapsed time is charged its reservation, not zero", () => {
  const line = project([child({ elapsedSec: undefined, launched: true, state: "failed" })]);
  const view = researchBudgetLineView(line, [child({ elapsedSec: undefined, launched: true, state: "failed" })], NOW);
  assert.equal(line.settlements[0]!.wallClock.status, "unknown");
  assert.equal(line.settlements[0]!.wallClock.chargedSeconds, 60);
  assert.equal(view.usage.wallClock.unknownSettlements, 1);
  assert.equal(view.usage.wallClock.chargedSeconds, 60);
  assert.equal(view.usage.wallClock.remainingSeconds, 540);
  assert.equal(view.usage.tokens.status, "unknown");
});

test("a preparation that never launched is charged its observed operation wall clock", () => {
  const notLaunched = child({
    createdAt: "2026-11-26T10:00:00.000Z",
    elapsedSec: undefined,
    launched: false,
    state: "failed",
    updatedAt: "2026-11-26T10:00:07.000Z",
  });
  const line = project([notLaunched]);
  assert.equal(line.settlements[0]!.wallClock.status, "not-launched");
  assert.equal(line.settlements[0]!.wallClock.chargedSeconds, 7);
  const view = researchBudgetLineView(line, [notLaunched], NOW);
  assert.equal(view.usage.wallClock.notLaunched, 1);
  assert.equal(view.usage.wallClock.remainingSeconds, 593);
  assert.equal(view.usage.tokens.status, "not-launched");
});

test("an active child reserves its allowance and only one child may run", () => {
  const active = child({ state: "running" });
  const line = project([active]);
  const view = researchBudgetLineView(line, [active], NOW);
  assert.equal(line.reservations.length, 1);
  assert.equal(line.reservations[0]!.reservedSec, 60);
  assert.equal(view.usage.wallClock.reservedSeconds, 60);
  assert.equal(view.usage.wallClock.remainingSeconds, 540);
  assert.deepEqual(view.activeChild, {
    operationId: "operation-1",
    reservedSec: 60,
    state: "running",
  });

  const busy = researchBudgetLineRefusal({
    allowanceSec: 30,
    children: [active],
    line,
    now: NOW,
    ownerRunId: "conversation-run-2",
  });
  assert.equal(busy?.reason, "research-line-busy");
});

test("a stop recorded in one conversation refuses that conversation and not another", () => {
  const active = child({ state: "running" });
  let line = project([active]);
  line = {
    ...line,
    stop: { operationId: "operation-1", ownerRunId: "conversation-run-1", requestedAt: NOW, requestedBy: "tool" },
    updatedAt: NOW,
  };
  const same = researchBudgetLineRefusal({
    allowanceSec: 10,
    children: [],
    line,
    now: NOW,
    ownerRunId: "conversation-run-1",
  });
  assert.equal(same?.reason, "research-line-stopped");
  const other = researchBudgetLineRefusal({
    allowanceSec: 10,
    children: [],
    line,
    now: NOW,
    ownerRunId: "conversation-run-2",
  });
  assert.equal(other, undefined);
});

test("the run limit and the whole-child allowance are enforced before reservation", () => {
  const settled = child({ elapsedSec: 60, state: "completed" });
  const line = project([settled]);
  const limit = researchBudgetLineRefusal({
    allowanceSec: 60,
    children: [settled, settled, settled, settled, settled],
    line: { ...line, limits: { ...line.limits!, maxChildRuns: 5 } },
    now: NOW,
    ownerRunId: "conversation-run-2",
  });
  assert.equal(limit?.reason, "parent-budget-exhausted");

  // A grant that only fits one second past the deadline is refused before it
  // is reserved.
  const deadline = researchBudgetLineRefusal({
    allowanceSec: 60,
    children: [],
    line,
    now: "2026-11-26T10:09:30.000Z",
    ownerRunId: "conversation-run-2",
  });
  assert.equal(deadline?.reason, "parent-deadline-exceeded");
});

test("a rebuilt projection preserves reservations, settlements and decisions", () => {
  let line = project([child({ state: "running" })]);
  line = withResearchBudgetDecision(line, {
    at: NOW,
    kind: "start",
    operationId: "operation-1",
    summary: "started operation-1",
  });
  const reopened = JSON.parse(JSON.stringify(line)) as typeof line;
  const completed = child({ elapsedSec: 30, state: "completed" });
  const projected = project([completed], reopened);
  assert.equal(projected.reservations.length, 0);
  assert.equal(projected.settlements.length, 1);
  assert.equal(projected.settlements[0]!.wallClock.chargedSeconds, 30);
  assert.ok(projected.decisions.some((decision) => decision.kind === "start"));
  assert.ok(projected.decisions.some((decision) => decision.kind === "settle"));
  const view = researchBudgetLineView(projected, [completed], NOW);
  assert.equal(view.usage.wallClock.remainingSeconds, 570);
});


test("pre-launch allowance includes preparation charges without double-counting its own hold", () => {
  const active = child({ state: "accepted", launched: false, reservedSec: 400 });
  const line = project([active]);
  const result = researchBudgetLaunchAllowance(line, [active], active.operationId, "owner", NOW,
    { extraChargedSeconds: 350 });
  assert.deepEqual(result, { allowanceSec: 250, deadlineAt: line.limits!.deadlineAt });
});

test("pre-launch refusal preserves other active reservations and the owner's stop", () => {
  const active = child({ state: "accepted", launched: false });
  const other = { ...active, operationId: "operation-2" };
  const line = project([active, other]);
  const busy = researchBudgetLaunchAllowance(line, [active, other], active.operationId, "owner", NOW);
  assert.ok("reason" in busy);
  assert.equal(busy.reason, "research-line-busy");
  const stopped = researchBudgetLaunchAllowance({ ...project([active]),
    stop: { ownerRunId: "owner", requestedAt: NOW } }, [active], active.operationId, "owner", NOW);
  assert.ok("reason" in stopped);
  assert.equal(stopped.reason, "research-line-stopped");
});
