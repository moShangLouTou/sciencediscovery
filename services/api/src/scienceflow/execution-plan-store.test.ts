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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { SCIENCE_FLOW_PREFLIGHT_DTO_VERSION } from "@sciencediscovery/schema";
import type {
  ScienceFlowExecutionPlanContractDto,
  ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";

import { SessionStore } from "../store.js";
import {
  SCIENCE_FLOW_EXECUTION_BLOCKERS,
  digestScienceFlowContract,
} from "./execution-contract.js";

const CONTRACT: ScienceFlowExecutionPlanContractDto = {
  scienceflow: {
    declaredRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
    verification: "unverified",
  },
  task: { taskId: "circle-packing", category: null, profile: null },
  metric: { name: "min_distance", lowerIsBetter: false, type: null, authoritative: null },
  artifact: { path: "artifacts/best.json", kind: null },
  evaluator: {
    entrypoint: "evaluate.py:score",
    path: "evaluate.py",
    function: "score",
    sha256: "a".repeat(64),
    timeoutSec: null,
  },
  description: { path: "description.md", sha256: "b".repeat(64) },
  taskYamlSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  sharedDefaultsSha256: null,
  budgets: [],
  unknowns: {
    dataset: "not-applicable",
    environment: "unknown",
    pricing: "unknown",
    modelGateway: "unknown",
    revision: "unverified",
    dependencyClosure: "incomplete",
  },
};

/**
 * These tests use the real `SessionStore`: the point is that a catalog rebuild
 * keeps the frozen contract and its latest preflight, and that the real delete
 * entry points remove exactly the plans below the target.
 */
async function temporaryRoot(): Promise<string> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(resolve(parent, "execution-plans-store-"));
}

function draft(
  planId: string,
  projectId: string,
  sessionId: string,
  requestId: string,
) {
  return {
    planId,
    projectId,
    sessionId,
    profileId: "profile-1",
    requestId,
    createdAt: "2026-11-10T00:00:00.000Z",
    contractDigest: digestScienceFlowContract(CONTRACT),
    contract: CONTRACT,
  };
}

test("PLAN-T01 plans and their latest preflight survive a real store reload", async (context) => {
  const root = await temporaryRoot();
  const open = new Set<SessionStore>();
  const openStore = async (): Promise<SessionStore> => {
    const store = new SessionStore(root);
    open.add(store);
    await store.load();
    return store;
  };
  const closeStore = async (store: SessionStore): Promise<void> => {
    if (!open.delete(store)) return;
    await store.whenDeletionsSettle().catch(() => undefined);
    store.close();
  };
  context.after(async () => {
    for (const store of [...open]) await closeStore(store);
    await rm(root, { recursive: true, force: true });
  });

  const first = await openStore();
  const project = await first.createProject("Plan persistence");
  const session = await first.createSession(project.id, "Planned", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const created = first.scienceFlowExecutionPlans.create(
    draft("plan-1", project.id, session.id, "request-1"),
  );
  assert.equal(created.created, true);
  const preflight: ScienceFlowPreflightDto = {
    schemaVersion: SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
    planId: "plan-1",
    contractDigest: created.stored.plan.contractDigest,
    observedContractDigest: created.stored.plan.contractDigest,
    checkedAt: "2026-11-10T00:00:01.000Z",
    outcome: "passed",
    canStart: false as const,
    checks: [
      { code: "contract_changed" as const, status: "passed" as const, description: "x" },
    ],
    blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
  };
  first.scienceFlowExecutionPlans.savePreflight(
    project.id,
    session.id,
    "plan-1",
    0,
    preflight,
  );
  await closeStore(first);

  const reopened = await openStore();
  const stored = reopened.scienceFlowExecutionPlans.get(project.id, session.id, "plan-1");
  assert.ok(stored);
  assert.equal(stored.plan.contractDigest, digestScienceFlowContract(CONTRACT));
  assert.equal(stored.plan.contract.task.taskId, "circle-packing");
  assert.equal(stored.plan.latestPreflight?.outcome, "passed");
  assert.equal(stored.plan.latestPreflight?.checkedAt, "2026-11-10T00:00:01.000Z");
  assert.equal(stored.preflightRevision, 1);
  assert.equal(reopened.getSession(session.id)?.title, "Planned");
});

test("PLAN-T02 the real delete entry points clear only the rows below the target", async (context) => {
  const root = await temporaryRoot();
  const store = new SessionStore(root);
  context.after(async () => {
    await store.whenDeletionsSettle().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.load();

  const first = await store.createProject("Plans A");
  const second = await store.createProject("Plans B");
  const doomed = await store.createSession(first.id, "Doomed", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const kept = await store.createSession(first.id, "Kept", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const other = await store.createSession(second.id, "Other", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const rows: Array<readonly [string, string, string, string]> = [
    ["plan-1", first.id, doomed.id, "request-1"],
    ["plan-2", first.id, kept.id, "request-2"],
    ["plan-3", second.id, other.id, "request-3"],
  ];
  for (const [planId, projectId, sessionId, requestId] of rows) {
    store.scienceFlowExecutionPlans.create(draft(planId, projectId, sessionId, requestId));
  }

  await store.deleteSession(doomed.id, doomed.id);
  await store.whenDeletionsSettle();
  assert.equal(store.scienceFlowExecutionPlans.get(first.id, doomed.id, "plan-1"), undefined);
  assert.notEqual(
    store.scienceFlowExecutionPlans.get(first.id, kept.id, "plan-2"),
    undefined,
  );

  await store.deleteProject(first.id, first.id);
  await store.whenDeletionsSettle();
  assert.equal(store.scienceFlowExecutionPlans.get(first.id, kept.id, "plan-2"), undefined);
  assert.notEqual(
    store.scienceFlowExecutionPlans.get(second.id, other.id, "plan-3"),
    undefined,
  );
});
