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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_CODES,
  SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowRuntimeCheckCode,
  type ScienceFlowRuntimeCheckDto,
} from "@sciencediscovery/schema";

import {
  ScienceFlowRuntimeCheckCorruptError,
  ScienceFlowRuntimeCheckRepository,
  runtimeCheckState,
} from "./runtime-check-repository.js";

const PLAN_ID = "plan-1";
const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";
const DIGEST = "a".repeat(64);
const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";

function passing(): readonly {
  code: ScienceFlowRuntimeCheckCode;
  status: ScienceFlowPlanCheckStatus;
}[] {
  return SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({ code, status: "passed" }));
}

function check(
  overrides: Partial<ScienceFlowRuntimeCheckDto> = {},
): ScienceFlowRuntimeCheckDto {
  return Object.freeze({
    schemaVersion: SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
    planId: PLAN_ID,
    contractDigest: DIGEST,
    bindingDigest: DIGEST,
    runnerId: "runner-1",
    environmentId: "environment-1",
    environmentRevisionId: "revision-1",
    checkedAt: "2026-11-12T00:00:00.000Z",
    outcome: "verified",
    canStart: false as const,
    sourceKind: "git-checkout",
    sourceRevision: REVISION,
    checks: passing().map((entry) => ({ ...entry, description: `${entry.code} passed` })),
    unknowns: {
      dependencyClosure: "incomplete" as const,
      executionStart: "not-checked" as const,
      modelGateway: "unknown" as const,
      evaluator: "not-checked" as const,
      gpu: "not-checked" as const,
    },
    generation: 1,
    ...overrides,
  });
}

function draft(generation: number, value = check({ generation })) {
  return {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    check: value,
  };
}

function repository(): ScienceFlowRuntimeCheckRepository {
  return new ScienceFlowRuntimeCheckRepository(new DatabaseSync(":memory:"));
}

test("RT-REPO-01 a stored check reads back with rebuilt descriptions", () => {
  const store = repository();
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  const result = store.save(draft(1));
  assert.equal(result.saved, true);
  const stored = store.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  if (!stored) assert.fail("expected a stored check");
  assert.equal(stored.generation, 1);
  assert.equal(stored.check.outcome, "verified");
  assert.equal(stored.check.canStart, false);
  assert.equal(stored.check.sourceRevision, REVISION);
  assert.deepEqual(
    stored.check.checks.map((entry) => entry.code),
    [...SCIENCE_FLOW_RUNTIME_CHECK_CODES],
  );
  // Prose is never stored, so a read must rebuild it.
  for (const entry of stored.check.checks) {
    assert.equal(entry.description.length > 0, true);
    assert.notEqual(entry.description, `${entry.code} passed`);
  }
});

test("RT-REPO-02 the stored record carries no prose or host detail", () => {
  const store = repository();
  store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  store.save(draft(1));
  const row = store.database
    .prepare("SELECT record_json FROM science_flow_runtime_checks")
    .get() as { record_json: string };
  const record = JSON.parse(row.record_json) as Record<string, unknown>;
  assert.equal("description" in record, false);
  assert.equal("unknowns" in record, false);
  assert.equal("canStart" in record, false);
  assert.equal("schemaVersion" in record, false);
  assert.equal("planId" in record, false);
  assert.equal(row.record_json.includes("/srv"), false);
  assert.equal(row.record_json.includes("sys.path"), false);
});

test("RT-REPO-03 a newer generation replaces an older one", () => {
  const store = repository();
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  assert.equal(store.save(draft(1)).saved, true);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 2);
  const next = store.save(draft(2, check({ generation: 2, checkedAt: "2026-11-12T00:01:00.000Z" })));
  assert.equal(next.saved, true);
  const stored = store.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(stored?.generation, 2);
  assert.equal(stored?.check.checkedAt, "2026-11-12T00:01:00.000Z");
});

test("RT-REPO-04 an older check that finishes late never replaces a newer blocked fact", () => {
  const store = repository();
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 2);
  // The newer request completes first with a real blocked observation.
  const newer = store.save(draft(2, check({
    generation: 2,
    outcome: "blocked",
    sourceKind: "installed-distribution",
    checks: SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({
      code,
      status: code === "source_root" ? ("failed" as const) : ("passed" as const),
    })),
  })));
  assert.equal(newer.saved, true);
  // The older request finishes later with a verified observation. It must not
  // win, and the persisted newer fact is what it sees.
  const older = store.save(draft(1, check({ environmentId: "environment-2" })));
  assert.equal(older.saved, false);
  assert.equal(older.stored?.generation, 2);
  assert.equal(older.stored?.check.outcome, "blocked");
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.generation, 2);
});

test("RT-REPO-05 delete removes only the owning Session or Project, and its allocations", () => {
  const store = repository();
  store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  store.save(draft(1));
  const other = {
    ...draft(1),
    projectId: "project-2",
    sessionId: "session-2",
    check: check({ planId: "plan-2" }),
  };
  store.allocate("project-2", "session-2", "plan-2");
  assert.equal(store.save(other).saved, true);

  store.deleteSession(SESSION_ID);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.notEqual(store.latest("project-2", "session-2", "plan-2"), undefined);
  // A check still in flight after the delete cannot insert its row back.
  assert.equal(store.save(draft(1, check({ environmentId: "environment-2" }))).saved, false);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);

  store.deleteProject("project-2");
  assert.equal(store.latest("project-2", "session-2", "plan-2"), undefined);
});

test("RT-REPO-06 a check relies on an allocated generation", () => {
  const store = repository();
  assert.throws(
    () => store.save(draft(0, check({ generation: 0 }))),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );
  assert.throws(
    () => store.save(draft(1, check({ generation: 2 }))),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );
  assert.throws(
    () => store.save(draft(1, check({ planId: "" }))),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );
  // No allocation, no write: a generation is issued before the Runner is asked.
  assert.equal(store.save(draft(1)).saved, false);
  store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(store.save(draft(2)).saved, false, "a generation that was never issued is refused");
});

test("RT-REPO-07 a corrupt row is refused, never repaired or skipped", () => {
  const store = repository();
  store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  store.save(draft(1));
  const target = (record: Record<string, unknown>) => {
    store.database
      .prepare("UPDATE science_flow_runtime_checks SET record_json = ?")
      .run(JSON.stringify(record));
  };
  const original = JSON.parse(
    (
      store.database
        .prepare("SELECT record_json FROM science_flow_runtime_checks")
        .get() as { record_json: string }
    ).record_json,
  ) as Record<string, unknown>;

  target({ ...original, sourceKind: "checkout" });
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );

  target({
    ...original,
    outcome: "verified",
    checks: passing().map((entry) =>
      entry.code === "source_revision" ? { ...entry, status: "failed" } : entry,
    ),
  });
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );

  // The plan-level read answer stays available; only the corrupt check refuses.
  const state = runtimeCheckState(PLAN_ID, undefined);
  assert.deepEqual(state, { planId: PLAN_ID, check: null });
});

test("RT-REPO-08 generations are allocated atomically and survive a restart", () => {
  const store = repository();
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 2);
  // A second repository over the same database is the restart case; it must
  // keep counting rather than reissuing a generation that is still in flight.
  const restarted = new ScienceFlowRuntimeCheckRepository(store.database);
  assert.equal(restarted.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 3);
  assert.equal(restarted.save(draft(3, check({ generation: 3 }))).saved, true);
  assert.equal(restarted.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.generation, 3);
});

test("RT-REPO-09 an allocation table that predates the stored row still counts past it", () => {
  const store = repository();
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  assert.equal(store.save(draft(1)).saved, true);
  // Simulate an upgrade from the first storage layout: a stored row but no
  // allocation counter. The next generation is seeded from the stored row.
  store.database.prepare("DELETE FROM science_flow_runtime_check_generations").run();
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 2);
  assert.equal(store.save(draft(2, check({ generation: 2 }))).saved, true);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.generation, 2);
});
