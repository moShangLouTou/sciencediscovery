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
  SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
  SCIENCE_FLOW_RUNTIME_CHECK_CODES,
  SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
  SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowRuntimeCheckCode,
  type ScienceFlowRuntimeProbeRequest,
  type ScienceFlowRuntimeProbeResult,
} from "@sciencediscovery/schema";

import { SCIENCE_FLOW_EXECUTION_BLOCKERS } from "./execution-contract.js";

import {
  createScienceFlowRuntimeCheckService,
  type ScienceFlowRuntimeCheckRunner,
} from "./runtime-check.js";
import { ScienceFlowRuntimeCheckRepository } from "./runtime-check-repository.js";
import type { ScienceFlowExecutionPlanStore } from "./execution-plan-repository.js";
import type {
  ScienceFlowExecutionProfile,
  ScienceFlowExecutionSettings,
} from "./execution-config.js";
import type {
  ScienceFlowRuntimeBinding,
  ScienceFlowRuntimeSettings,
} from "./runtime-config.js";

const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";
const OTHER_REVISION = "1111111111111111111111111111111111111111";
const IDENTITY = { projectId: "project-1", sessionId: "session-1" };
const PLAN_ID = "plan-1";

const PROFILE: ScienceFlowExecutionProfile = Object.freeze({
  profileId: "profile-1",
  scienceFlowRevision: REVISION,
  manifestPath: "/srv/task/manifest.yaml",
  taskPackageRoot: "/srv/task/opt_solver/circle-packing",
  allowedReadRoots: Object.freeze(["/srv/task"]),
  runtimeBindingId: "binding-1",
});

const BINDING: ScienceFlowRuntimeBinding = Object.freeze({
  bindingId: "binding-1",
  runnerId: "runner-1",
  runnerBindingId: "runner-binding-1",
  environmentId: "environment-1",
  expectedEnvironmentRevisionId: "revision-1",
  timeoutMs: 60_000,
});

function profiles(): ScienceFlowExecutionSettings {
  return {
    profileFor: (profileId) => (profileId === PROFILE.profileId ? PROFILE : undefined),
    profiles: [PROFILE],
  };
}

function runtime(bindings: readonly ScienceFlowRuntimeBinding[] = [BINDING]): ScienceFlowRuntimeSettings {
  return {
    bindingFor: (bindingId) => bindings.find((binding) => binding.bindingId === bindingId),
    has: (bindingId) => bindings.some((binding) => binding.bindingId === bindingId),
  };
}

function checks(status: ScienceFlowPlanCheckStatus = "passed"): readonly {
  code: ScienceFlowRuntimeCheckCode;
  status: ScienceFlowPlanCheckStatus;
}[] {
  return SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({ code, status }));
}

function plan(
  overrides: { readonly declaredRevision?: string; readonly profileId?: string } = {},
) {
  return {
    plan: {
      schemaVersion: SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
      planId: PLAN_ID,
      projectId: IDENTITY.projectId,
      sessionId: IDENTITY.sessionId,
      profileId: overrides.profileId ?? PROFILE.profileId,
      requestId: "request-1",
      createdAt: "2026-11-12T00:00:00.000Z",
      contractDigest: "d".repeat(64),
      contract: {
        scienceflow: {
          declaredRevision: overrides.declaredRevision ?? REVISION,
          verification: "unverified" as const,
        },
        task: { taskId: "circle-packing", category: "opt_solver", profile: "default" },
        metric: {
          name: "min_distance",
          lowerIsBetter: false,
          type: "continuous" as const,
          authoritative: false,
        },
        artifact: { path: "artifacts/best.json", kind: "json" as const },
        evaluator: {
          entrypoint: "evaluate.py:score",
          path: "evaluate.py",
          function: "score",
          sha256: "a".repeat(64),
          timeoutSec: 300,
        },
        description: { path: "description.md", sha256: "b".repeat(64) },
        workspace: { source: "defaults_workspace_base" as const },
        taskYamlSha256: "c".repeat(64),
        manifestSha256: "d".repeat(64),
        sharedDefaultsSha256: null,
        budgets: [
          {
            name: "wall_clock_budget_sec",
            value: 120,
            unit: "seconds" as const,
            nature: "requested" as const,
          },
        ],
        unknowns: {
          dataset: "not-applicable" as const,
          environment: "unknown" as const,
          pricing: "unknown" as const,
          modelGateway: "unknown" as const,
          revision: "unverified" as const,
          dependencyClosure: "incomplete" as const,
        },
      },
      execution: {
        canStart: false as const,
        blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
      },
      latestPreflight: null,
    },
    preflightRevision: 0,
  };
}

/** A store that serves one frozen plan; every write path is unused here. */
function planStore(stored: ReturnType<typeof plan> | undefined): ScienceFlowExecutionPlanStore {
  const unused = (): never => {
    throw new Error("unexpected plan write");
  };
  return {
    create: unused,
    list: () => [],
    get: (projectId, sessionId, planId) =>
      stored &&
      stored.plan.projectId === projectId &&
      stored.plan.sessionId === sessionId &&
      stored.plan.planId === planId
        ? stored
        : undefined,
    findByRequest: () => undefined,
    savePreflight: unused,
  };
}

function answer(
  request: ScienceFlowRuntimeProbeRequest,
  overrides: Partial<ScienceFlowRuntimeProbeResult> = {},
): ScienceFlowRuntimeProbeResult {
  return {
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
    requestId: request.requestId,
    bindingId: request.bindingId,
    environmentId: request.environmentId,
    environmentRevisionId: request.expectedEnvironmentRevisionId,
    sourceKind: "git-checkout",
    revision: request.expectedRevision,
    checkedAt: "2026-11-12T00:00:01.000Z",
    outcome: "verified",
    checks: checks(),
    ...overrides,
  };
}

interface HarnessOptions {
  readonly profiles?: ScienceFlowExecutionSettings | undefined;
  readonly runtime?: ScienceFlowRuntimeSettings | undefined;
  readonly stored?: ReturnType<typeof plan> | undefined;
  readonly runnerAllowed?: (sessionId: string, runnerId: string) => boolean;
  readonly respond?: (
    request: ScienceFlowRuntimeProbeRequest,
    signal?: AbortSignal,
  ) => Promise<ScienceFlowRuntimeProbeResult>;
}

function harness(options: HarnessOptions = {}) {
  const store = new ScienceFlowRuntimeCheckRepository(new DatabaseSync(":memory:"));
  const runnerCalls: ScienceFlowRuntimeProbeRequest[] = [];
  const writable: string[] = [];
  const state = { writableError: undefined as unknown, sessionMissing: false };
  const runner: ScienceFlowRuntimeCheckRunner = {
    async scienceFlowRuntimeCheck(request, signal) {
      runnerCalls.push(request);
      return options.respond ? await options.respond(request, signal) : answer(request);
    },
  };
  const service = createScienceFlowRuntimeCheckService({
    identities: {
      getProject: (projectId) =>
        projectId === IDENTITY.projectId ? { id: projectId } : undefined,
      getSession: (sessionId) =>
        state.sessionMissing || sessionId !== IDENTITY.sessionId
          ? undefined
          : { projectId: IDENTITY.projectId },
    },
    requireWritable(sessionId) {
      writable.push(sessionId);
      if (state.writableError !== undefined) throw state.writableError;
    },
    runnerAllowed: options.runnerAllowed ?? (() => true),
    ...("profiles" in options
      ? { profiles: options.profiles }
      : { profiles: profiles() }),
    ...("runtime" in options ? { runtime: options.runtime } : { runtime: runtime() }),
    plans: () => planStore("stored" in options ? options.stored : plan()),
    store: () => store,
    runnerFor: () => runner,
    generateRequestId: () => "request-1",
  });
  return { service, store, runnerCalls, writable, state };
}

test("RT-SVC-01 a verified probe is stored as fixed evidence and never a start gate", async () => {
  const test = harness();
  const result = await test.service.check(IDENTITY, PLAN_ID);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  const check = result.check;
  assert.equal(check.schemaVersion, SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION);
  assert.equal(check.planId, PLAN_ID);
  assert.equal(check.contractDigest, "d".repeat(64));
  assert.equal(check.bindingDigest.length, 64);
  assert.equal(check.runnerId, "runner-1");
  assert.equal(check.environmentId, "environment-1");
  assert.equal(check.environmentRevisionId, "revision-1");
  assert.equal(check.outcome, "verified");
  assert.equal(check.canStart, false);
  assert.equal(check.sourceKind, "git-checkout");
  assert.equal(check.sourceRevision, REVISION);
  assert.equal(check.generation, 1);
  assert.deepEqual(check.unknowns, {
    dependencyClosure: "incomplete",
    executionStart: "not-checked",
    modelGateway: "unknown",
    evaluator: "not-checked",
    gpu: "not-checked",
  });
  assert.deepEqual(
    check.checks.map((entry) => entry.code),
    [...SCIENCE_FLOW_RUNTIME_CHECK_CODES],
  );
  // The Runner request carries identities only, and the frozen revision.
  assert.deepEqual(test.runnerCalls[0], {
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
    requestId: "request-1",
    bindingId: "runner-binding-1",
    environmentId: "environment-1",
    expectedEnvironmentRevisionId: "revision-1",
    expectedRevision: REVISION,
  });
  // The write gate is taken before the read and again after the await.
  assert.deepEqual(test.writable, [IDENTITY.sessionId, IDENTITY.sessionId]);
  // A read is served from storage without contacting a Runner.
  const latest = await test.service.latest(IDENTITY, PLAN_ID);
  if (latest.status !== "ok") assert.fail(`expected ok, got ${latest.status}`);
  assert.equal(latest.state.planId, PLAN_ID);
  assert.deepEqual(latest.state.check, check);
  assert.equal(test.runnerCalls.length, 1);
});

test("RT-SVC-02 a blocked probe is stored as blocked, never as verified", async () => {
  const test = harness({
    respond: async (request) =>
      answer(request, {
        outcome: "blocked",
        sourceKind: "installed-distribution",
        revision: OTHER_REVISION,
        checks: SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({
          code,
          status: code === "source_root" ? ("failed" as const) : ("passed" as const),
        })),
      }),
  });
  const result = await test.service.check(IDENTITY, PLAN_ID);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.equal(result.check.outcome, "blocked");
  assert.equal(result.check.canStart, false);
  assert.equal(result.check.sourceKind, "installed-distribution");
  assert.equal(result.check.sourceRevision, OTHER_REVISION);
  const latest = await test.service.latest(IDENTITY, PLAN_ID);
  if (latest.status !== "ok") assert.fail("expected a stored result");
  assert.equal(latest.state.check?.outcome, "blocked");
});

/** An untrusted answer: the Runner protocol is deliberately not trusted here. */
function malformed(
  request: ScienceFlowRuntimeProbeRequest,
  overrides: Record<string, unknown>,
): ScienceFlowRuntimeProbeResult {
  return { ...answer(request), ...overrides } as ScienceFlowRuntimeProbeResult;
}

test("RT-SVC-03 an unavailable or mismatched answer stores nothing", async () => {
  const cases: Array<HarnessOptions["respond"]> = [
    // The Runner's own "no fact" answer.
    async (request) => answer(request, { outcome: "unavailable", environmentRevisionId: null }),
    // A protocol difference: the echo names another environment.
    async (request) => malformed(request, { environmentId: "environment-2" }),
    async (request) => malformed(request, { requestId: "request-2" }),
    async (request) => malformed(request, { environmentRevisionId: "revision-2" }),
    async (request) => malformed(request, { sourceKind: "checkout" }),
    async (request) => malformed(request, { revision: "not-a-revision" }),
    async (request) => malformed(request, { checkedAt: "yesterday" }),
    // The outcome must follow from the reported checks.
    async (request) => malformed(request, { outcome: "blocked" }),
    // A short list is not a fact set.
    async (request) => malformed(request, { checks: checks().slice(1) }),
    // The transport failed outright.
    async () => {
      throw new Error("runner offline");
    },
  ];
  for (const respond of cases) {
    const test = harness({ respond });
    const result = await test.service.check(IDENTITY, PLAN_ID);
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(test.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
  }
});

test("RT-SVC-04 a timeout aborts the Runner call and stores nothing", async () => {
  const test = harness({
    runtime: runtime([{ ...BINDING, timeoutMs: 1_000 }]),
    respond: async (_request, signal) =>
      await new Promise<ScienceFlowRuntimeProbeResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const result = await test.service.check(IDENTITY, PLAN_ID);
  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(test.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
});

test("RT-SVC-05 disabled and retired configuration are distinct from failures", async () => {
  assert.deepEqual(
    await harness({ profiles: undefined }).service.check(IDENTITY, PLAN_ID),
    { status: "disabled" },
  );
  assert.deepEqual(
    await harness({ runtime: undefined }).service.check(IDENTITY, PLAN_ID),
    { status: "disabled" },
  );
  // A withdrawn profile and a withdrawn binding both leave the record readable
  // but make a new check unavailable, with no fallback to another binding.
  assert.deepEqual(
    await harness({ profiles: { profileFor: () => undefined, profiles: [] } }).service.check(
      IDENTITY,
      PLAN_ID,
    ),
    { status: "disabled" },
  );
  assert.deepEqual(
    await harness({ runtime: runtime([]) }).service.check(IDENTITY, PLAN_ID),
    { status: "disabled" },
  );
});

test("RT-SVC-06 the Session's runner selection is checked before and after the await", async () => {
  const before = harness({ runnerAllowed: () => false });
  assert.deepEqual(await before.service.check(IDENTITY, PLAN_ID), { status: "runner-denied" });
  assert.equal(before.runnerCalls.length, 0);

  let allowed = true;
  const during = harness({
    runnerAllowed: () => allowed,
    respond: async (request) => {
      // The Session's selection changes while the Runner answers.
      allowed = false;
      return answer(request);
    },
  });
  assert.deepEqual(await during.service.check(IDENTITY, PLAN_ID), { status: "runner-denied" });
  assert.equal(during.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
});

test("RT-SVC-07 a write refusal stops the check before the Runner is asked", async () => {
  const test = harness();
  test.state.writableError = new Error("session is archived");
  await assert.rejects(test.service.check(IDENTITY, PLAN_ID), /session is archived/);
  assert.equal(test.runnerCalls.length, 0);
});

test("RT-SVC-08 a Session deleted during the await discards the result", async () => {
  const test = harness({
    respond: async (request) => {
      test.state.sessionMissing = true;
      return answer(request);
    },
  });
  const result = await test.service.check(IDENTITY, PLAN_ID);
  assert.deepEqual(result, { status: "not-found", resource: "session" });
  assert.equal(test.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
});

test("RT-SVC-09 each check advances the plan's generation", async () => {
  const test = harness();
  const first = await test.service.check(IDENTITY, PLAN_ID);
  if (first.status !== "ok") assert.fail(`expected ok, got ${first.status}`);
  assert.equal(first.check.generation, 1);
  const second = await test.service.check(IDENTITY, PLAN_ID);
  if (second.status !== "ok") assert.fail(`expected ok, got ${second.status}`);
  assert.equal(second.check.generation, 2);
  const latest = await test.service.latest(IDENTITY, PLAN_ID);
  if (latest.status !== "ok") assert.fail("expected a stored result");
  assert.equal(latest.state.check?.generation, 2);
});

test("RT-SVC-10 missing identities, a missing plan, and invalid ids are distinct", async () => {
  assert.deepEqual(
    await harness().service.check({ projectId: "project-9", sessionId: IDENTITY.sessionId }, PLAN_ID),
    { status: "not-found", resource: "project" },
  );
  assert.deepEqual(
    await harness().service.check({ projectId: IDENTITY.projectId, sessionId: "session-9" }, PLAN_ID),
    { status: "not-found", resource: "session" },
  );
  assert.deepEqual(
    await harness().service.check(IDENTITY, "plan-9"),
    { status: "not-found", resource: "plan" },
  );
  assert.deepEqual(
    await harness().service.check(IDENTITY, ""),
    { status: "invalid", reason: "query" },
  );
  assert.deepEqual(
    await harness().service.latest(IDENTITY, ""),
    { status: "invalid", reason: "query" },
  );
  assert.deepEqual(
    await harness().service.latest(IDENTITY, "plan-9"),
    { status: "not-found", resource: "plan" },
  );
});

test("RT-SVC-11 the stored answer leaks no host path, command, or interpreter detail", async () => {
  const test = harness();
  const result = await test.service.check(IDENTITY, PLAN_ID);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  const serialized = JSON.stringify(result.check);
  for (const forbidden of ["/srv", "/opt", "sys.path", "python", "sourceRoot", "stderr"]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

// --- overlapping checks -----------------------------------------------------

interface PendingCall {
  readonly request: ScienceFlowRuntimeProbeRequest;
  readonly answer: (overrides?: Partial<ScienceFlowRuntimeProbeResult>) => void;
  readonly fail: () => void;
}

/**
 * A Runner whose calls stay pending until the test settles them, in any order.
 * Each call records the request it received so the answer can echo it.
 */
function overlapping(): { respond: HarnessOptions["respond"]; calls: PendingCall[] } {
  const calls: PendingCall[] = [];
  const respond = (
    request: ScienceFlowRuntimeProbeRequest,
  ): Promise<ScienceFlowRuntimeProbeResult> =>
    new Promise<ScienceFlowRuntimeProbeResult>((resolve, reject) => {
      calls.push({
        request,
        answer: (overrides = {}) => resolve(answer(request, overrides)),
        fail: () => reject(new Error("runner offline")),
      });
    });
  return { respond, calls };
}

function blockedAnswer(): Partial<ScienceFlowRuntimeProbeResult> {
  return {
    outcome: "blocked",
    sourceKind: "installed-distribution",
    revision: OTHER_REVISION,
    checks: SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({
      code,
      status: code === "source_root" ? ("failed" as const) : ("passed" as const),
    })),
  };
}

function allocated(test: ReturnType<typeof harness>): number {
  const row = test.store.database
    .prepare("SELECT allocated FROM science_flow_runtime_check_generations WHERE plan_id = ?")
    .get(PLAN_ID) as { allocated: number } | undefined;
  return row?.allocated ?? 0;
}

test("RT-SVC-12 overlapping checks get distinct generations and the newer fact wins in either order", async () => {
  for (const order of ["older-first", "newer-first"] as const) {
    const runner = overlapping();
    const test = harness({ respond: runner.respond });
    // Both requests reserve before either Runner call answers.
    const older = test.service.check(IDENTITY, PLAN_ID);
    const newer = test.service.check(IDENTITY, PLAN_ID);
    assert.equal(runner.calls.length, 2, order);
    assert.equal(allocated(test), 2, `${order}: each request reserved its own generation`);

    const [first, second] =
      order === "older-first"
        ? [runner.calls[0], runner.calls[1]]
        : [runner.calls[1], runner.calls[0]];
    first.answer(order === "older-first" ? undefined : blockedAnswer());
    const firstResult = await (order === "older-first" ? older : newer);
    second.answer(order === "older-first" ? blockedAnswer() : undefined);
    const olderResult = await older;
    const newerResult = await newer;

    if (order === "older-first") {
      if (firstResult.status !== "ok" || olderResult.status !== "ok" || newerResult.status !== "ok") {
        assert.fail(`${order}: both checks completed`);
      }
      assert.equal(olderResult.check.generation, 1);
      assert.equal(olderResult.check.outcome, "verified");
      assert.equal(newerResult.check.generation, 2);
      assert.equal(newerResult.check.outcome, "blocked");
    } else {
      // The newer request completes first and stores the blocked fact. The
      // older request's verified evidence then arrives late: it may not replace
      // the newer row, and it is never returned as this request's own success.
      if (firstResult.status !== "ok" || olderResult.status !== "ok" || newerResult.status !== "ok") {
        assert.fail(`${order}: both checks completed`);
      }
      assert.equal(newerResult.check.generation, 2);
      assert.equal(newerResult.check.outcome, "blocked");
      assert.equal(olderResult.check.generation, 2);
      assert.equal(olderResult.check.outcome, "blocked");
    }
    const latest = await test.service.latest(IDENTITY, PLAN_ID);
    if (latest.status !== "ok") assert.fail("expected a stored result");
    assert.equal(latest.state.check?.generation, 2);
    assert.equal(latest.state.check?.outcome, "blocked");
  }
});

test("RT-SVC-13 a newer check that fails leaves the older evidence as history", async () => {
  const runner = overlapping();
  const test = harness({ respond: runner.respond });
  const older = test.service.check(IDENTITY, PLAN_ID);
  const newer = test.service.check(IDENTITY, PLAN_ID);
  assert.equal(allocated(test), 2);
  // The newer request fails outright, so it records no fact at all.
  runner.calls[1].fail();
  assert.deepEqual(await newer, { status: "unavailable" });
  assert.equal(test.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
  // The older request still lands. Generation 1 is older than the issued 2, but
  // no newer fact exists, so it is stored as the latest valid history.
  runner.calls[0].answer();
  const olderResult = await older;
  if (olderResult.status !== "ok") assert.fail(`expected ok, got ${olderResult.status}`);
  assert.equal(olderResult.check.generation, 1);
  assert.equal(olderResult.check.outcome, "verified");
  const latest = await test.service.latest(IDENTITY, PLAN_ID);
  if (latest.status !== "ok") assert.fail("expected a stored result");
  assert.equal(latest.state.check?.generation, 1);
});

test("RT-SVC-14 storage removed during the await is not resurrected by a late save", async () => {
  let test!: ReturnType<typeof harness>;
  test = harness({
    respond: async (request) => {
      // The Session's rows are removed while the Runner answers, but the
      // identity read after the await still succeeds.
      test.store.deleteSession(IDENTITY.sessionId);
      return answer(request);
    },
  });
  const result = await test.service.check(IDENTITY, PLAN_ID);
  assert.deepEqual(result, { status: "not-found", resource: "session" });
  assert.equal(test.store.latest(IDENTITY.projectId, IDENTITY.sessionId, PLAN_ID), undefined);
  const remaining = test.store.database
    .prepare("SELECT COUNT(*) AS count FROM science_flow_runtime_check_generations")
    .get() as { count: number };
  assert.equal(remaining.count, 0);
});
