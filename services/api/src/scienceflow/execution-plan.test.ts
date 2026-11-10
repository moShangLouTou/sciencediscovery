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

import {
  SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
  SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
  type ScienceFlowExecutionPlanContractDto,
  type ScienceFlowExecutionPlanDto,
  type ScienceFlowPlanCheckDto,
  type ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_EXECUTION_BLOCKERS,
  digestScienceFlowContract,
} from "./execution-contract.js";
import type { ScienceFlowExecutionSettings } from "./execution-config.js";
import { createScienceFlowExecutionPlanService } from "./execution-plan.js";
import {
  ScienceFlowExecutionPlanCorruptError,
  type ScienceFlowExecutionPlanDraft,
  type ScienceFlowExecutionPlanStore,
  type ScienceFlowStoredExecutionPlan,
} from "./execution-plan-repository.js";

const IDENTITY = { projectId: "project-1", sessionId: "session-1" };
const INPUT = { profileId: "profile-1", requestId: "request-1" };
const PROFILE = {
  profileId: "profile-1",
  scienceFlowRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
  manifestPath: "/srv/task/manifest.yaml",
  taskPackageRoot: "/srv/task/opt_solver/circle-packing",
  allowedReadRoots: ["/srv/task"],
} as const;

function contract(
  overrides: Partial<ScienceFlowExecutionPlanContractDto> = {},
): ScienceFlowExecutionPlanContractDto {
  return Object.freeze<ScienceFlowExecutionPlanContractDto>({
    scienceflow: {
      declaredRevision: PROFILE.scienceFlowRevision,
      verification: "unverified" as const,
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
    workspace: { source: "defaults_workspace_base" },
    taskYamlSha256: "c".repeat(64),
    manifestSha256: "d".repeat(64),
    sharedDefaultsSha256: null,
    budgets: [
      { name: "wall_clock_budget_sec", value: 120, unit: "seconds", nature: "requested" },
    ],
    unknowns: {
      dataset: "not-applicable",
      environment: "unknown",
      pricing: "unknown",
      modelGateway: "unknown",
      revision: "unverified",
      dependencyClosure: "incomplete",
    },
    ...overrides,
  });
}

function check(
  code: ScienceFlowPlanCheckDto["code"],
  status: ScienceFlowPlanCheckDto["status"] = "passed",
): ScienceFlowPlanCheckDto {
  return { code, status, description: `${code} ${status}` };
}

interface StoredRow {
  plan: ScienceFlowExecutionPlanDto;
  revision: number;
}

interface StoreOptions {
  readonly createError?: unknown;
  readonly getError?: unknown;
  readonly saveError?: unknown;
}

interface HarnessOptions extends StoreOptions {
  readonly profiles?: ScienceFlowExecutionSettings | undefined;
  readonly projectMissing?: boolean;
  readonly sessionProject?: string;
  readonly writableError?: unknown;
  readonly build?: () => ReturnType<
    Parameters<typeof createScienceFlowExecutionPlanService>[0]["buildContract"]
  >;
  /** Lets a test pause the builder and change state while it waits. */
  readonly awaitBuild?: Promise<void>;
}

interface Harness {
  readonly service: ReturnType<typeof createScienceFlowExecutionPlanService>;
  readonly drafts: ScienceFlowExecutionPlanDraft[];
  readonly preflightSaves: ScienceFlowPreflightDto[];
  readonly rows: Map<string, StoredRow>;
  buildCalls(): number;
  writableCalls(): number;
  setWritableError(error: unknown): void;
  setSessionMissing(missing: boolean): void;
  bumpRevision(planId: string): void;
}

function harness(options: HarnessOptions = {}): Harness {
  const rows = new Map<string, StoredRow>();
  const byRequest = new Map<string, string>();
  const drafts: ScienceFlowExecutionPlanDraft[] = [];
  const preflightSaves: ScienceFlowPreflightDto[] = [];
  let buildCalls = 0;
  let writableCalls = 0;
  let generated = 0;
  let writableError = options.writableError;
  let sessionMissing = false;

  const makePlan = (draft: ScienceFlowExecutionPlanDraft): ScienceFlowExecutionPlanDto =>
    Object.freeze({
      schemaVersion: SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
      planId: draft.planId,
      projectId: draft.projectId,
      sessionId: draft.sessionId,
      profileId: draft.profileId,
      requestId: draft.requestId,
      createdAt: draft.createdAt,
      contractDigest: draft.contractDigest,
      contract: draft.contract,
      execution: { canStart: false as const, blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS },
      latestPreflight: null,
    });

  const store: ScienceFlowExecutionPlanStore = {
    create(draft) {
      drafts.push(draft);
      if (options.createError !== undefined) throw options.createError;
      const key = `${draft.projectId}\u0000${draft.sessionId}\u0000${draft.requestId}`;
      const existingId = byRequest.get(key);
      if (existingId !== undefined) {
        const existing = rows.get(existingId);
        if (!existing) throw new ScienceFlowExecutionPlanCorruptError();
        return { created: false, stored: clone(existing) };
      }
      const plan = makePlan(draft);
      rows.set(draft.planId, { plan, revision: 0 });
      byRequest.set(key, draft.planId);
      return { created: true, stored: clone({ plan, revision: 0 }) };
    },
    list(projectId, sessionId, limit, offset) {
      if (options.getError !== undefined) throw options.getError;
      return [...rows.values()]
        .filter(
          (row) =>
            row.plan.projectId === projectId && row.plan.sessionId === sessionId,
        )
        .slice(offset, offset + limit)
        .map(clone);
    },
    get(projectId, sessionId, planId) {
      if (options.getError !== undefined) throw options.getError;
      const row = rows.get(planId);
      return row && row.plan.projectId === projectId && row.plan.sessionId === sessionId
        ? clone(row)
        : undefined;
    },
    findByRequest(projectId, sessionId, requestId) {
      if (options.getError !== undefined) throw options.getError;
      const id = byRequest.get(`${projectId}\u0000${sessionId}\u0000${requestId}`);
      const row = id === undefined ? undefined : rows.get(id);
      return row ? clone(row) : undefined;
    },
    savePreflight(projectId, sessionId, planId, expectedRevision, preflight) {
      preflightSaves.push(preflight);
      if (options.saveError !== undefined) throw options.saveError;
      const row = rows.get(planId);
      if (!row || row.plan.projectId !== projectId || row.plan.sessionId !== sessionId) {
        throw new ScienceFlowExecutionPlanCorruptError();
      }
      if (row.revision !== expectedRevision) {
        return { saved: false, stored: clone(row) };
      }
      const updated: StoredRow = {
        plan: Object.freeze({ ...row.plan, latestPreflight: preflight }),
        revision: row.revision + 1,
      };
      rows.set(planId, updated);
      return { saved: true, stored: clone(updated) };
    },
  };

  const defaultProfiles: ScienceFlowExecutionSettings = {
    profileFor: (profileId: string) =>
      profileId === PROFILE.profileId ? PROFILE : undefined,
  };
  const profiles =
    "profiles" in options ? options.profiles : defaultProfiles;

  const buildContract = options.build ?? (async () => {
    buildCalls += 1;
    if (options.awaitBuild) await options.awaitBuild;
    return {
      status: "ok" as const,
      contract: contract(),
      checks: [check("manifest_readable")],
    };
  });

  const service = createScienceFlowExecutionPlanService({
    identities: {
      getProject: (projectId) =>
        options.projectMissing || projectId !== IDENTITY.projectId
          ? undefined
          : { id: projectId },
      getSession: (sessionId) =>
        sessionMissing || sessionId !== IDENTITY.sessionId
          ? undefined
          : { projectId: options.sessionProject ?? IDENTITY.projectId },
    },
    requireWritable() {
      writableCalls += 1;
      if (writableError !== undefined) throw writableError;
    },
    ...(profiles === undefined ? {} : { profiles }),
    store: () => store,
    buildContract,
    generatePlanId: () => `plan-${++generated}`,
    now: () => "2026-11-10T00:00:00.000Z",
  });

  return {
    service,
    drafts,
    preflightSaves,
    rows,
    buildCalls: () => buildCalls,
    writableCalls: () => writableCalls,
    setWritableError: (error) => {
      writableError = error;
    },
    setSessionMissing: (missing) => {
      sessionMissing = missing;
    },
    bumpRevision: (planId) => {
      const row = rows.get(planId);
      if (row) rows.set(planId, { ...row, revision: row.revision + 1 });
    },
  };
}

function clone(row: StoredRow): ScienceFlowStoredExecutionPlan {
  return { plan: row.plan, preflightRevision: row.revision };
}

test("PLAN-C01 a first create freezes the contract and returns 201 semantics", async () => {
  const test = harness();
  const result = await test.service.create(IDENTITY, INPUT);
  if (result.status !== "created") assert.fail(`expected created, got ${result.status}`);
  assert.equal(test.drafts.length, 1);
  assert.equal(result.plan.planId, "plan-1");
  assert.equal(result.plan.contractDigest, digestScienceFlowContract(contract()));
  assert.equal(result.plan.execution.canStart, false);
  assert.equal(result.plan.execution.blockers.length, SCIENCE_FLOW_EXECUTION_BLOCKERS.length);
  assert.deepEqual(result.plan.contract.budgets[0], {
    name: "wall_clock_budget_sec",
    value: 120,
    unit: "seconds",
    nature: "requested",
  });
  assert.equal(result.plan.latestPreflight, null);
});

test("PLAN-C02 a retry returns the stored plan without re-reading files", async () => {
  const test = harness();
  await test.service.create(IDENTITY, INPUT);
  const retry = await test.service.create(IDENTITY, INPUT);
  if (retry.status !== "existing") assert.fail(`expected existing, got ${retry.status}`);
  assert.equal(test.buildCalls(), 1);
  assert.equal(test.drafts.length, 1);
});

test("PLAN-C03 reusing a request id with another profile conflicts", async () => {
  const test = harness({
    profiles: {
      profileFor: (profileId) =>
        profileId === "profile-1" || profileId === "profile-2"
          ? { ...PROFILE, profileId }
          : undefined,
    },
  });
  await test.service.create(IDENTITY, INPUT);
  const conflict = await test.service.create(IDENTITY, {
    profileId: "profile-2",
    requestId: INPUT.requestId,
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(test.drafts.length, 1);
});

test("PLAN-C04 a disabled feature, an unknown profile, and a missing Session are distinct", async () => {
  const disabled = await harness({ profiles: undefined }).service.create(IDENTITY, INPUT);
  assert.equal(disabled.status, "disabled");

  const unknownProfile = await harness().service.create(IDENTITY, {
    profileId: "profile-9",
    requestId: "request-9",
  });
  assert.deepEqual(unknownProfile, { status: "not-found", resource: "profile" });

  const missing = await harness({ projectMissing: true }).service.create(IDENTITY, INPUT);
  assert.deepEqual(missing, { status: "not-found", resource: "project" });

  const other = await harness({ sessionProject: "project-2" }).service.create(IDENTITY, INPUT);
  assert.deepEqual(other, { status: "not-found", resource: "session" });
});

test("PLAN-C05 an invalid body is refused before any file is read", async () => {
  const test = harness();
  assert.deepEqual(
    await test.service.create(IDENTITY, { profileId: "profile-1", requestId: "" }),
    { status: "invalid", reason: "body" },
  );
  assert.deepEqual(
    await test.service.create(IDENTITY, {
      profileId: "profile-1",
      requestId: "a/b",
    }),
    { status: "invalid", reason: "body" },
  );
  assert.equal(test.buildCalls(), 0);
});

test("PLAN-C06 a rejected contract persists nothing and reports its checks", async () => {
  const test = harness({
    build: async () => ({
      status: "rejected" as const,
      checks: [check("manifest_readable", "failed"), check("contract_changed")],
    }),
  });
  const result = await test.service.create(IDENTITY, INPUT);
  if (result.status !== "contract-invalid") assert.fail(`unexpected ${result.status}`);
  assert.equal(result.checks[0]?.code, "manifest_readable");
  assert.equal(result.checks[0]?.status, "failed");
  assert.equal(test.drafts.length, 0);
});

test("PLAN-C07 an internal read failure never becomes a blocked contract", async () => {
  const test = harness({ build: async () => ({ status: "internal" as const }) });
  assert.deepEqual(await test.service.create(IDENTITY, INPUT), {
    status: "internal-error",
  });
  assert.equal(test.drafts.length, 0);
});

test("PLAN-C08 a Session deleted while the builder awaits is not written", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = harness({ awaitBuild: gate });
  const pending = test.service.create(IDENTITY, INPUT);
  test.setSessionMissing(true);
  release();
  const result = await pending;
  assert.deepEqual(result, { status: "not-found", resource: "session" });
  assert.equal(test.drafts.length, 0);
});

test("PLAN-C09 write permission withdrawn while the builder awaits is not bypassed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const error = Object.assign(new Error("read only"), { status: 409 });
  const test = harness({ awaitBuild: gate });
  const pending = test.service.create(IDENTITY, INPUT);
  test.setWritableError(error);
  release();
  await assert.rejects(pending, (thrown) => thrown === error);
  assert.equal(test.drafts.length, 0);
  assert.equal(test.writableCalls(), 2);
});

test("PLAN-C10 a storage failure is reported, never a success", async () => {
  const internal = harness({ createError: new Error("disk") });
  assert.deepEqual(await internal.service.create(IDENTITY, INPUT), {
    status: "internal-error",
  });

  const corrupt = harness({ createError: new ScienceFlowExecutionPlanCorruptError() });
  assert.deepEqual(await corrupt.service.create(IDENTITY, INPUT), {
    status: "corrupt",
  });
});

test("PLAN-C11 list and get stay readable and clamp pagination", async () => {
  const test = harness();
  await test.service.create(IDENTITY, INPUT);
  const list = await test.service.list(IDENTITY, { limit: 10_000, offset: -5 });
  if (list.status !== "ok") assert.fail(`unexpected ${list.status}`);
  assert.equal(list.plans.length, 1);

  const found = await test.service.get(IDENTITY, "plan-1");
  assert.equal(found.status, "ok");
  assert.deepEqual(await test.service.get(IDENTITY, "plan-9"), {
    status: "not-found",
    resource: "plan",
  });
});

test("PLAN-P01 a preflight of unchanged files passes but keeps canStart false", async () => {
  const test = harness();
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  const result = await test.service.preflight(IDENTITY, created.plan.planId);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.equal(result.preflight.outcome, "passed");
  assert.equal(result.preflight.canStart, false);
  assert.equal(result.preflight.contractDigest, created.plan.contractDigest);
  assert.equal(result.preflight.observedContractDigest, created.plan.contractDigest);
  assert.equal(result.preflight.checks.length, 2);
  assert.equal(result.preflight.checks.some((entry) => entry.code === "contract_changed"), true);
  assert.equal(result.plan.latestPreflight?.checkedAt, "2026-11-10T00:00:00.000Z");
});

test("PLAN-P02 changed source files report contract_changed without rewriting the plan", async () => {
  let current = contract();
  const test = harness({
    build: async () => ({
      status: "ok" as const,
      contract: current,
      checks: [check("manifest_readable")],
    }),
  });
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  const before = created.plan.contractDigest;

  current = contract({
    metric: { name: "different", lowerIsBetter: true, type: null, authoritative: null },
  });
  const result = await test.service.preflight(IDENTITY, created.plan.planId);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.equal(result.preflight.outcome, "blocked");
  const changed = result.preflight.checks.find(
    (entry) => entry.code === "contract_changed",
  );
  assert.equal(changed?.status, "failed");
  assert.equal(result.preflight.observedContractDigest, digestScienceFlowContract(current));
  // The frozen contract is untouched.
  assert.equal(result.plan.contractDigest, before);
  assert.equal(result.plan.contract.metric.name, "min_distance");
});

test("PLAN-P03 unreadable files produce a blocked preflight, not a 500", async () => {
  const calls: number[] = [];
  const test = harness({
    build: async () => {
      calls.push(1);
      return calls.length === 1
        ? {
            status: "ok" as const,
            contract: contract(),
            checks: [check("manifest_readable")],
          }
        : {
            status: "rejected" as const,
            checks: [check("manifest_readable", "failed")],
          };
    },
  });
  const stored = await test.service.create(IDENTITY, INPUT);
  if (stored.status !== "created") assert.fail("expected created");
  const result = await test.service.preflight(IDENTITY, stored.plan.planId);
  if (result.status !== "ok") assert.fail(`unexpected ${result.status}`);
  assert.equal(result.preflight.outcome, "blocked");
  assert.equal(result.preflight.observedContractDigest, null);
  assert.equal(
    result.preflight.checks.find((entry) => entry.code === "contract_changed")?.status,
    "failed",
  );
});

test("PLAN-P04 an internal preflight failure persists nothing", async () => {
  let calls = 0;
  const test = harness({
    build: async () => {
      calls += 1;
      return calls === 1
        ? { status: "ok" as const, contract: contract(), checks: [check("manifest_readable")] }
        : { status: "internal" as const };
    },
  });
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  const result = await test.service.preflight(IDENTITY, created.plan.planId);
  assert.deepEqual(result, { status: "internal-error" });
  assert.equal(test.preflightSaves.length, 0);
  assert.equal(test.rows.get(created.plan.planId)?.revision, 0);
});

test("PLAN-P05 a storage failure on save leaves the contract readable", async () => {
  const failing = harness({ saveError: new Error("disk") });
  const created = await failing.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  assert.deepEqual(await failing.service.preflight(IDENTITY, created.plan.planId), {
    status: "internal-error",
  });
  const found = await failing.service.get(IDENTITY, created.plan.planId);
  assert.equal(found.status, "ok");
});

test("PLAN-P06 a concurrent preflight that loses the revision race keeps the winner", async () => {
  // The second build pauses, so another writer can land between this check's
  // read and its conditional write.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let builds = 0;
  const test = harness({
    build: async () => {
      builds += 1;
      if (builds > 1) await gate;
      return {
        status: "ok" as const,
        contract: contract(),
        checks: [check("manifest_readable")],
      };
    },
  });
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  const planId = created.plan.planId;
  const winner: ScienceFlowPreflightDto = {
    schemaVersion: SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
    planId,
    contractDigest: created.plan.contractDigest,
    observedContractDigest: created.plan.contractDigest,
    checkedAt: "2026-11-10T00:00:01.000Z",
    outcome: "passed",
    canStart: false,
    checks: [check("contract_changed")],
    blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
  };

  const pending = test.service.preflight(IDENTITY, planId);
  // Another check commits its result while ours is still reading the files.
  const row = test.rows.get(planId);
  if (!row) assert.fail("missing row");
  test.rows.set(planId, {
    plan: Object.freeze({ ...row.plan, latestPreflight: winner }),
    revision: row.revision + 1,
  });
  release();

  const result = await pending;
  if (result.status !== "ok") assert.fail(`unexpected ${result.status}`);
  // The stored winner is reported; our discarded result is not presented as persisted.
  assert.equal(result.preflight, winner);
  assert.equal(result.plan.latestPreflight, winner);
});

test("PLAN-P07 preflight is disabled when the feature is off or the profile withdrawn", async () => {
  const off = harness({ profiles: undefined });
  // A disabled feature answers before it looks at any stored plan.
  assert.equal((await off.service.preflight(IDENTITY, "plan-1")).status, "disabled");

  let available = true;
  const test = harness({
    profiles: {
      profileFor: (profileId: string) =>
        available && profileId === PROFILE.profileId ? PROFILE : undefined,
    },
  });
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  available = false;
  // The metadata stays readable, but no check may run against a withdrawn profile.
  assert.deepEqual(await test.service.preflight(IDENTITY, created.plan.planId), {
    status: "disabled",
  });
  const found = await test.service.get(IDENTITY, created.plan.planId);
  assert.equal(found.status, "ok");
});

test("PLAN-P08 preflight requires the write gate and re-checks it after the await", async () => {
  // Only the second build (the preflight's) pauses, so create stays immediate.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let builds = 0;
  const test = harness({
    build: async () => {
      builds += 1;
      if (builds > 1) await gate;
      return {
        status: "ok" as const,
        contract: contract(),
        checks: [check("manifest_readable")],
      };
    },
  });
  const created = await test.service.create(IDENTITY, INPUT);
  if (created.status !== "created") assert.fail("expected created");
  const pending = test.service.preflight(IDENTITY, created.plan.planId);
  const error = Object.assign(new Error("read only"), { status: 409 });
  test.setWritableError(error);
  release();
  await assert.rejects(pending, (thrown) => thrown === error);
  assert.equal(test.preflightSaves.length, 0);
});
