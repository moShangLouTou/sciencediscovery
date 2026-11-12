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
  const result = store.save(draft(1), 0);
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
  store.save(draft(1), 0);
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
  assert.equal(store.save(draft(1), 0).saved, true);
  const next = store.save(draft(2, check({ generation: 2, checkedAt: "2026-11-12T00:01:00.000Z" })), 1);
  assert.equal(next.saved, true);
  const stored = store.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(stored?.generation, 2);
  assert.equal(stored?.check.checkedAt, "2026-11-12T00:01:00.000Z");
});

test("RT-REPO-04 a writer that observed a stale generation loses and sees the winner", () => {
  const store = repository();
  store.save(draft(1), 0);
  // The second writer observed generation 0 before the first one inserted, so
  // its insert hits the existing row and must not replace it.
  const late = store.save(draft(1, check({ environmentId: "environment-2" })), 0);
  assert.equal(late.saved, false);
  assert.equal(late.stored?.check.environmentId, "environment-1");
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.generation, 1);
});

test("RT-REPO-05 delete removes only the owning Session or Project", () => {
  const store = repository();
  store.save(draft(1), 0);
  const other = {
    ...draft(1),
    projectId: "project-2",
    sessionId: "session-2",
    check: check({ planId: "plan-2" }),
  };
  assert.equal(store.save(other, 0).saved, true);

  store.deleteSession(SESSION_ID);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.notEqual(store.latest("project-2", "session-2", "plan-2"), undefined);

  store.deleteProject("project-2");
  assert.equal(store.latest("project-2", "session-2", "plan-2"), undefined);
});

test("RT-REPO-06 a check relies on the generation it was given", () => {
  const store = repository();
  assert.throws(
    () => store.save(draft(2), 0),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );
  assert.throws(
    () => store.save(draft(1, check({ planId: "" })), 0),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );
});

test("RT-REPO-07 a corrupt row is refused, never repaired or skipped", () => {
  const store = repository();
  store.save(draft(1), 0);
  const target = (record: Record<string, unknown>) => {
    store.database
      .prepare("UPDATE science_flow_runtime_checks SET record_json = ?")
      .run(JSON.stringify(record));
  };
  const valid = () =>
    JSON.parse(
      (
        store.database
          .prepare("SELECT record_json FROM science_flow_runtime_checks")
          .get() as { record_json: string }
      ).record_json,
    ) as Record<string, unknown>;

  target({ ...valid(), sourceKind: "checkout" });
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );

  target({ ...valid(), outcome: "verified", checks: passing().map((entry) => (entry.code === "source_revision" ? { ...entry, status: "failed" } : entry)) });
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    (error: unknown) => error instanceof ScienceFlowRuntimeCheckCorruptError,
  );

  // The plan-level read answer stays available; only the corrupt check refuses.
  const state = runtimeCheckState(PLAN_ID, undefined);
  assert.deepEqual(state, { planId: PLAN_ID, check: null });
});
