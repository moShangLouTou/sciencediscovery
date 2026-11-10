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
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ScienceFlowExecutionPlanDto,
  ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";

import { SCIENCE_FLOW_EXECUTION_BLOCKERS } from "./execution-contract.js";
import { handleScienceFlowExecutionPlanRequest } from "./execution-plan-http.js";
import type {
  ScienceFlowExecutionPlanCreateResult,
  ScienceFlowExecutionPlanGetResult,
  ScienceFlowExecutionPlanIdentity,
  ScienceFlowExecutionPlanInput,
  ScienceFlowExecutionPlanListResult,
  ScienceFlowExecutionPlanPreflightResult,
  ScienceFlowExecutionPlanService,
} from "./execution-plan.js";

const MARKER = "SYNTHETIC-PLAN-SECRET-MARKER-4f2a";
const BASE = "http://localhost";
const LIST_PATH = "/api/projects/project-1/sessions/session-1/scienceflow/plans";
const DETAIL_PATH = `${LIST_PATH}/plan-1`;
const PREFLIGHT_PATH = `${DETAIL_PATH}/preflight`;

function plan(overrides: Partial<ScienceFlowExecutionPlanDto> = {}): ScienceFlowExecutionPlanDto {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    projectId: "project-1",
    sessionId: "session-1",
    profileId: "profile-1",
    requestId: "request-1",
    createdAt: "2026-11-10T00:00:00.000Z",
    contractDigest: "a".repeat(64),
    contract: {
      scienceflow: {
        declaredRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
        verification: "unverified",
      },
      task: { taskId: "circle-packing", category: null, profile: null },
      metric: { name: "m", lowerIsBetter: false, type: null, authoritative: null },
      artifact: { path: "a.json", kind: null },
      evaluator: {
        entrypoint: "evaluate.py:score",
        path: "evaluate.py",
        function: "score",
        sha256: "b".repeat(64),
        timeoutSec: null,
      },
      description: { path: "description.md", sha256: "c".repeat(64) },
      taskYamlSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
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
    },
    execution: { canStart: false, blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS },
    latestPreflight: null,
    ...overrides,
  };
}

function preflight(): ScienceFlowPreflightDto {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    contractDigest: "a".repeat(64),
    observedContractDigest: "a".repeat(64),
    checkedAt: "2026-11-10T00:00:01.000Z",
    outcome: "passed",
    canStart: false,
    checks: [
      { code: "contract_changed", status: "passed", description: "unchanged" },
    ],
    blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
  };
}

interface Captured {
  statusCode: number;
  headers: Map<string, string>;
  body: string;
}

function fakeResponse(): { captured: Captured; response: ServerResponse } {
  const captured: Captured = { statusCode: 0, headers: new Map(), body: "" };
  const response = {
    setHeader(name: string, value: string | number) {
      captured.headers.set(name.toLowerCase(), String(value));
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      captured.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) {
        captured.headers.set(name.toLowerCase(), String(value));
      }
      return response;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) captured.body += body.toString();
    },
  };
  return { captured, response: response as unknown as ServerResponse };
}

function fakeRequest(options: {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
} = {}): IncomingMessage {
  const request = {
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body, "utf8");
    },
  };
  return request as unknown as IncomingMessage;
}

interface Calls {
  readonly creates: Array<{ identity: ScienceFlowExecutionPlanIdentity; input: ScienceFlowExecutionPlanInput }>;
  readonly lists: Array<{
    identity: ScienceFlowExecutionPlanIdentity;
    options: { limit?: number; offset?: number } | undefined;
  }>;
  readonly gets: Array<{ identity: ScienceFlowExecutionPlanIdentity; planId: string }>;
}

function fakeService(results: {
  readonly create?: ScienceFlowExecutionPlanCreateResult;
  readonly list?: ScienceFlowExecutionPlanListResult;
  readonly get?: ScienceFlowExecutionPlanGetResult;
  readonly preflight?: ScienceFlowExecutionPlanPreflightResult;
}): { service: ScienceFlowExecutionPlanService; calls: Calls } {
  const calls: Calls = { creates: [], lists: [], gets: [] };
  const service: ScienceFlowExecutionPlanService = {
    async create(identity, input) {
      calls.creates.push({ identity, input });
      return results.create ?? { status: "created", plan: plan() };
    },
    async list(identity, options) {
      calls.lists.push({ identity, options });
      return results.list ?? { status: "ok", plans: [plan()] };
    },
    async get(identity, planId) {
      calls.gets.push({ identity, planId });
      return results.get ?? { status: "ok", plan: plan() };
    },
    async preflight() {
      return results.preflight ?? { status: "ok", plan: plan(), preflight: preflight() };
    },
  };
  return { service, calls };
}

async function dispatch(
  service: ScienceFlowExecutionPlanService,
  options: {
    readonly path: string;
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
  },
): Promise<{ handled: boolean; captured: Captured }> {
  const { captured, response } = fakeResponse();
  const handled = await handleScienceFlowExecutionPlanRequest(
    fakeRequest({ method: options.method, body: options.body, headers: options.headers }),
    response,
    new URL(options.path, BASE),
    service,
  );
  return { handled, captured };
}

function json(captured: Captured): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

test("HTTP-01 create answers 201 then 200 for an idempotent retry", async () => {
  const created = await dispatch(fakeService({ create: { status: "created", plan: plan() } }).service, {
    path: LIST_PATH,
    method: "POST",
    body: JSON.stringify({ profileId: "profile-1", requestId: "request-1" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(created.handled, true);
  assert.equal(created.captured.statusCode, 201);
  assert.equal(json(created.captured).planId, "plan-1");
  assert.equal(created.captured.headers.get("cache-control"), "no-store");

  const existing = await dispatch(fakeService({ create: { status: "existing", plan: plan() } }).service, {
    path: LIST_PATH,
    method: "POST",
    body: JSON.stringify({ profileId: "profile-1", requestId: "request-1" }),
  });
  assert.equal(existing.captured.statusCode, 200);
});

test("HTTP-02 a request id reused with another profile is a 409", async () => {
  const { captured } = await dispatch(fakeService({ create: { status: "conflict", plan: plan() } }).service, {
    path: LIST_PATH,
    method: "POST",
    body: JSON.stringify({ profileId: "profile-2", requestId: "request-1" }),
  });
  assert.equal(captured.statusCode, 409);
  assert.equal(json(captured).code, "SCIENCEFLOW_PLAN_CONFLICT");
});

test("HTTP-03 an unsupported contract is a 422 with fixed checks only", async () => {
  const { captured } = await dispatch(
    fakeService({
      create: {
        status: "contract-invalid",
        checks: [
          { code: "manifest_readable", status: "failed", description: `no ${MARKER}` },
        ],
      },
    }).service,
    {
      path: LIST_PATH,
      method: "POST",
      body: JSON.stringify({ profileId: "profile-1", requestId: "request-1" }),
    },
  );
  assert.equal(captured.statusCode, 422);
  const body = json(captured);
  assert.equal(body.code, "SCIENCEFLOW_PLAN_CONTRACT_INVALID");
  assert.deepEqual((body.details as { checks: unknown }).checks, [
    { code: "manifest_readable", status: "failed", description: `no ${MARKER}` },
  ]);
  assert.equal(captured.headers.get("cache-control"), "no-store");
});

test("HTTP-04 the create body is exactly profileId and requestId", async () => {
  const service = fakeService({}).service;
  for (const body of [
    JSON.stringify({ profileId: "profile-1" }),
    JSON.stringify({ profileId: "profile-1", requestId: "r", extra: true }),
    JSON.stringify({ profileId: "profile-1", requestId: "a/b" }),
    JSON.stringify({ profileId: "profile-1", requestId: "r", profilePath: "/etc" }),
    "[]",
  ]) {
    const { captured } = await dispatch(service, { path: LIST_PATH, method: "POST", body });
    assert.equal(captured.statusCode, 400);
    assert.equal(json(captured).code, "SCIENCEFLOW_INVALID_REQUEST");
  }
});

test("HTTP-05 a disabled feature answers 503 for create and preflight", async () => {
  const create = await dispatch(fakeService({ create: { status: "disabled" } }).service, {
    path: LIST_PATH,
    method: "POST",
    body: JSON.stringify({ profileId: "profile-1", requestId: "request-1" }),
  });
  assert.equal(create.captured.statusCode, 503);
  assert.equal(json(create.captured).code, "SCIENCEFLOW_EXECUTION_DISABLED");

  const preflightResult = await dispatch(
    fakeService({ preflight: { status: "disabled" } }).service,
    { path: PREFLIGHT_PATH, method: "POST" },
  );
  assert.equal(preflightResult.captured.statusCode, 503);
});

test("HTTP-06 list is bounded pagination and rejects stray parameters", async () => {
  const { service, calls } = fakeService({ list: { status: "ok", plans: [plan()] } });
  const listed = await dispatch(service, { path: `${LIST_PATH}?limit=5&offset=2` });
  assert.equal(listed.captured.statusCode, 200);
  assert.equal(Array.isArray(json(listed.captured)), true);
  assert.deepEqual(calls.lists[0]?.options, { limit: 5, offset: 2 });

  const stray = await dispatch(service, { path: `${LIST_PATH}?profileId=other` });
  assert.equal(stray.captured.statusCode, 400);

  const negative = await dispatch(service, { path: `${LIST_PATH}?limit=-1` });
  assert.equal(negative.captured.statusCode, 400);

  const notFound = await dispatch(
    fakeService({ list: { status: "not-found", resource: "session" } }).service,
    { path: LIST_PATH },
  );
  assert.equal(notFound.captured.statusCode, 404);
  assert.equal(json(notFound.captured).code, "SCIENCEFLOW_PLAN_NOT_FOUND");
});

test("HTTP-07 detail is GET-only and answers 200 or a unified 404", async () => {
  const found = await dispatch(fakeService({}).service, { path: DETAIL_PATH });
  assert.equal(found.captured.statusCode, 200);
  assert.equal(json(found.captured).planId, "plan-1");

  const missing = await dispatch(
    fakeService({ get: { status: "not-found", resource: "plan" } }).service,
    { path: DETAIL_PATH },
  );
  assert.equal(missing.captured.statusCode, 404);
  assert.equal(json(missing.captured).code, "SCIENCEFLOW_PLAN_NOT_FOUND");

  const wrongMethod = await dispatch(fakeService({}).service, { path: DETAIL_PATH, method: "POST" });
  assert.equal(wrongMethod.captured.statusCode, 405);
  assert.equal(wrongMethod.captured.headers.get("allow"), "GET");

  const withBody = await dispatch(fakeService({}).service, {
    path: DETAIL_PATH,
    headers: { "content-length": "2" },
  });
  assert.equal(withBody.captured.statusCode, 400);
});

test("HTTP-08 preflight answers with the stored latest result", async () => {
  const { service } = fakeService({});
  const result = await dispatch(service, { path: PREFLIGHT_PATH, method: "POST" });
  assert.equal(result.captured.statusCode, 200);
  const body = json(result.captured);
  assert.equal(body.outcome, "passed");
  assert.equal(body.canStart, false);
  assert.equal((body.blockers as unknown[]).length, SCIENCE_FLOW_EXECUTION_BLOCKERS.length);

  const wrongMethod = await dispatch(service, { path: PREFLIGHT_PATH });
  assert.equal(wrongMethod.captured.statusCode, 405);
  assert.equal(wrongMethod.captured.headers.get("allow"), "POST");
});

test("HTTP-09 internal and corrupt storage are 500s, never a blocked check", async () => {
  const corrupt = await dispatch(
    fakeService({ preflight: { status: "corrupt" } }).service,
    { path: PREFLIGHT_PATH, method: "POST" },
  );
  assert.equal(corrupt.captured.statusCode, 500);
  assert.equal(json(corrupt.captured).code, "SCIENCEFLOW_PLAN_CORRUPT");

  const internal = await dispatch(
    fakeService({ preflight: { status: "internal-error" } }).service,
    { path: PREFLIGHT_PATH, method: "POST" },
  );
  assert.equal(internal.captured.statusCode, 500);
  assert.equal(json(internal.captured).code, "SCIENCEFLOW_INTERNAL_ERROR");
});

test("HTTP-10 another route is not claimed and no error echoes the marker", async () => {
  const notMine = await dispatch(fakeService({}).service, {
    path: "/api/projects/project-1/scienceflow/plans",
  });
  assert.equal(notMine.handled, false);

  const { captured } = await dispatch(
    fakeService({ create: { status: "internal-error" } }).service,
    {
      path: LIST_PATH,
      method: "POST",
      body: JSON.stringify({ profileId: MARKER, requestId: "request-1" }),
    },
  );
  // The marker is accepted as an opaque id and never echoed in an error body.
  assert.equal(captured.statusCode, 500);
  assert.equal(captured.body.includes(MARKER), false);
  assert.equal(captured.headers.get("cache-control"), "no-store");
});
