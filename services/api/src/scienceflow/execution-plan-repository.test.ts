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

import type {
  ScienceFlowExecutionPlanContractDto,
  ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";
import { SCIENCE_FLOW_PREFLIGHT_DTO_VERSION } from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_EXECUTION_BLOCKERS,
  digestScienceFlowContract,
} from "./execution-contract.js";
import {
  ScienceFlowExecutionPlanCorruptError,
  ScienceFlowExecutionPlanRepository,
} from "./execution-plan-repository.js";

const CONTRACT: ScienceFlowExecutionPlanContractDto = {
  scienceflow: {
    declaredRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
    verification: "unverified",
  },
  task: { taskId: "circle-packing", category: "opt_solver", profile: "default" },
  metric: {
    name: "min_distance",
    lowerIsBetter: false,
    type: "continuous",
    authoritative: false,
  },
  artifact: { path: "artifacts/best.json", kind: "json" },
  evaluator: {
    entrypoint: "evaluate.py:score",
    path: "evaluate.py",
    function: "score",
    sha256: "a".repeat(64),
    timeoutSec: 300,
  },
  description: { path: "description.md", sha256: "b".repeat(64) },
  taskYamlSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  sharedDefaultsSha256: null,
  budgets: [
    { name: "time_limit", value: 600, unit: "seconds", nature: "requested" },
  ],
  unknowns: {
    dataset: "not-applicable",
    environment: "unknown",
    pricing: "unknown",
    modelGateway: "unknown",
    revision: "unverified",
    dependencyClosure: "incomplete",
  },
};

function draft(overrides: Partial<Parameters<ScienceFlowExecutionPlanRepository["create"]>[0]> = {}) {
  return {
    planId: "plan-1",
    projectId: "project-1",
    sessionId: "session-1",
    profileId: "profile-1",
    requestId: "request-1",
    createdAt: "2026-11-10T00:00:00.000Z",
    contractDigest: digestScienceFlowContract(CONTRACT),
    contract: CONTRACT,
    ...overrides,
  };
}

function preflight(overrides: Record<string, unknown> = {}): ScienceFlowPreflightDto {
  return {
    schemaVersion: SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
    planId: "plan-1",
    contractDigest: digestScienceFlowContract(CONTRACT),
    observedContractDigest: digestScienceFlowContract(CONTRACT),
    checkedAt: "2026-11-10T00:00:01.000Z",
    outcome: "passed" as const,
    canStart: false as const,
    checks: [{ code: "contract_changed" as const, status: "passed" as const, description: "x" }],
    blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
    ...overrides,
  };
}

function repository(context: { after(callback: () => void): void }) {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  return { database, repository: new ScienceFlowExecutionPlanRepository(database) };
}

test("PLAN-R01 a stored plan round-trips with its digest and fixed blockers", (context) => {
  const { repository: store } = repository(context);
  const { created, stored } = store.create(draft());
  assert.equal(created, true);
  assert.equal(stored.plan.contractDigest, digestScienceFlowContract(CONTRACT));
  assert.equal(stored.plan.latestPreflight, null);
  assert.equal(stored.plan.execution.canStart, false);
  assert.deepEqual(stored.plan.execution.blockers, SCIENCE_FLOW_EXECUTION_BLOCKERS);
  assert.deepEqual(store.get("project-1", "session-1", "plan-1"), stored);
  assert.equal(store.get("project-2", "session-1", "plan-1"), undefined);
  assert.equal(store.get("project-1", "session-2", "plan-1"), undefined);
});

test("PLAN-R02 the request identity is idempotent and unique", (context) => {
  const { repository: store } = repository(context);
  const first = store.create(draft());
  const retry = store.create(draft({ planId: "plan-2", profileId: "profile-2" }));
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  // The stored plan keeps the original profile: the repository never rewrites it.
  assert.equal(retry.stored.plan.profileId, "profile-1");
  assert.equal(store.findByRequest("project-1", "session-1", "request-1")?.plan.planId, "plan-1");
  assert.equal(store.findByRequest("project-1", "session-1", "request-9"), undefined);
});

test("PLAN-R03 listing is bounded and ordered, scoped to one Session", (context) => {
  const { repository: store } = repository(context);
  store.create(draft({ planId: "plan-2", requestId: "request-2", createdAt: "2026-11-10T00:00:02.000Z" }));
  store.create(draft({ planId: "plan-1", requestId: "request-1", createdAt: "2026-11-10T00:00:01.000Z" }));
  store.create(draft({ planId: "plan-3", requestId: "request-3", sessionId: "session-2" }));
  assert.deepEqual(
    store.list("project-1", "session-1", 10, 0).map((entry) => entry.plan.planId),
    ["plan-1", "plan-2"],
  );
  assert.deepEqual(
    store.list("project-1", "session-1", 1, 1).map((entry) => entry.plan.planId),
    ["plan-2"],
  );
});

test("PLAN-R04 only the writer that observed the revision may replace it", (context) => {
  const { repository: store } = repository(context);
  store.create(draft());
  const first = store.savePreflight("project-1", "session-1", "plan-1", 0, preflight());
  assert.equal(first.saved, true);
  assert.equal(first.stored.preflightRevision, 1);
  assert.equal(first.stored.plan.latestPreflight?.outcome, "passed");
  // A writer holding the stale revision is refused and sees the winner.
  const stale = store.savePreflight(
    "project-1",
    "session-1",
    "plan-1",
    0,
    preflight({ checkedAt: "2026-11-10T00:00:02.000Z", outcome: "blocked" }),
  );
  assert.equal(stale.saved, false);
  assert.equal(stale.stored.preflightRevision, 1);
  assert.equal(stale.stored.plan.latestPreflight?.checkedAt, "2026-11-10T00:00:01.000Z");
  // The current revision still writes.
  const second = store.savePreflight("project-1", "session-1", "plan-1", 1, preflight());
  assert.equal(second.saved, true);
  assert.equal(second.stored.preflightRevision, 2);
});

test("PLAN-R05 a corrupt contract payload is refused, never repaired", (context) => {
  const { database, repository: store } = repository(context);
  store.create(draft());
  database
    .prepare("UPDATE science_flow_execution_plans SET contract_json = ? WHERE id = ?")
    .run("{not json", "plan-1");
  assert.throws(
    () => store.get("project-1", "session-1", "plan-1"),
    ScienceFlowExecutionPlanCorruptError,
  );
});

test("PLAN-R06 a contract that no longer matches its digest is refused", (context) => {
  const { database, repository: store } = repository(context);
  store.create(draft());
  const altered = JSON.stringify({
    ...CONTRACT,
    metric: { ...CONTRACT.metric, name: "altered" },
  });
  database
    .prepare("UPDATE science_flow_execution_plans SET contract_json = ? WHERE id = ?")
    .run(altered, "plan-1");
  assert.throws(
    () => store.get("project-1", "session-1", "plan-1"),
    ScienceFlowExecutionPlanCorruptError,
  );
});

test("PLAN-R07 a stored preflight is re-validated and its prose rebuilt", (context) => {
  const { database, repository: store } = repository(context);
  store.create(draft());
  store.savePreflight("project-1", "session-1", "plan-1", 0, preflight());
  // Descriptions are not stored; the read rebuilds the fixed text.
  const row = database
    .prepare("SELECT preflight_json FROM science_flow_execution_plans WHERE id = ?")
    .get("plan-1") as { preflight_json: string };
  assert.equal(row.preflight_json.includes("description"), false);
  const stored = store.get("project-1", "session-1", "plan-1");
  assert.equal(
    stored?.plan.latestPreflight?.checks[0]?.description,
    "The current profile or source files match the frozen contract.",
  );

  // An outcome that contradicts its checks is corrupt, not a blocked preflight.
  database
    .prepare("UPDATE science_flow_execution_plans SET preflight_json = ? WHERE id = ?")
    .run(
      JSON.stringify({
        observedContractDigest: null,
        checkedAt: "2026-11-10T00:00:01.000Z",
        outcome: "passed",
        checks: [{ code: "manifest_readable", status: "failed" }],
      }),
      "plan-1",
    );
  assert.throws(
    () => store.get("project-1", "session-1", "plan-1"),
    ScienceFlowExecutionPlanCorruptError,
  );
});

test("PLAN-R08 a preflight for another plan is refused, a stale digest writes nothing", (context) => {
  const { repository: store } = repository(context);
  store.create(draft());
  // A result for a different plan is a caller bug, not a race.
  assert.throws(
    () => store.savePreflight("project-1", "session-1", "plan-1", 0, preflight({ planId: "plan-2" })),
    ScienceFlowExecutionPlanCorruptError,
  );
  // A result bound to another contract is a stale writer: the condition refuses
  // the write and the row is returned unchanged.
  const stale = store.savePreflight(
    "project-1",
    "session-1",
    "plan-1",
    0,
    preflight({ contractDigest: "e".repeat(64) }),
  );
  assert.equal(stale.saved, false);
  assert.equal(stale.stored.plan.latestPreflight, null);
  assert.equal(store.get("project-1", "session-1", "plan-1")?.preflightRevision, 0);
});

test("PLAN-R09 Session and Project deletion clear exactly their own rows", (context) => {
  const { repository: store } = repository(context);
  store.create(draft({ planId: "plan-1", requestId: "request-1" }));
  store.create(draft({ planId: "plan-2", requestId: "request-2", sessionId: "session-2" }));
  store.create(
    draft({
      planId: "plan-3",
      requestId: "request-3",
      projectId: "project-2",
      sessionId: "session-3",
    }),
  );
  store.deleteSession("session-1");
  assert.equal(store.get("project-1", "session-1", "plan-1"), undefined);
  assert.notEqual(store.get("project-1", "session-2", "plan-2"), undefined);
  store.deleteProject("project-1");
  assert.equal(store.get("project-1", "session-2", "plan-2"), undefined);
  assert.notEqual(store.get("project-2", "session-3", "plan-3"), undefined);
});
