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

import type { ScienceFlowRunRegistrationDto } from "@sciencediscovery/schema";
import type { ScienceFlowRunSnapshot } from "@sciencediscovery/scienceflow-reader";

import { handleScienceFlowRegistrationRequest } from "./registration-http.js";
import type {
  ScienceFlowRegistrationCreateResult,
  ScienceFlowRegistrationGetResult,
  ScienceFlowRegistrationIdentity,
  ScienceFlowRegistrationListResult,
  ScienceFlowRegistrationService,
} from "./registration.js";
import type {
  ScienceFlowRunQuery,
  ScienceFlowRunSnapshotQueryResult,
  ScienceFlowRunSnapshotService,
} from "./run-snapshot.js";

const MARKER = "SYNTHETIC-SENSITIVE-MARKER-7c1d";
const BASE = "http://localhost";
const LIST_PATH = "/api/projects/project-1/sessions/session-1/scienceflow/registrations";
const DETAIL_PATH = `${LIST_PATH}/registration-1`;
const SNAPSHOT_PATH = `${DETAIL_PATH}/snapshot`;

function record(overrides: Partial<ScienceFlowRunRegistrationDto> = {}): ScienceFlowRunRegistrationDto {
  return {
    schemaVersion: 1,
    registrationId: "registration-1",
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    createdAt: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<ScienceFlowRunSnapshot> = {}): ScienceFlowRunSnapshot {
  return {
    schemaVersion: 1,
    runId: "run-1",
    rawStatus: "running",
    phase: "research",
    tasks: [],
    diagnostics: [],
    ...overrides,
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
  readonly creates: Array<{ identity: ScienceFlowRegistrationIdentity; runId: string }>;
  readonly lists: Array<{
    identity: ScienceFlowRegistrationIdentity;
    options: { limit?: number; offset?: number } | undefined;
  }>;
  readonly gets: Array<{ identity: ScienceFlowRegistrationIdentity; registrationId: string }>;
}

interface FakeService {
  readonly service: ScienceFlowRegistrationService;
  readonly calls: Calls;
}

function fakeService(results: {
  readonly create?: ScienceFlowRegistrationCreateResult;
  readonly list?: ScienceFlowRegistrationListResult;
  readonly get?: ScienceFlowRegistrationGetResult;
}): FakeService {
  const calls: Calls = { creates: [], lists: [], gets: [] };
  const service: ScienceFlowRegistrationService = {
    async create(identity, runId) {
      calls.creates.push({ identity, runId });
      return results.create ?? { status: "created", registration: record() };
    },
    async list(identity, options) {
      calls.lists.push({ identity, options });
      return results.list ?? { status: "ok", registrations: [record()] };
    },
    async get(identity, registrationId) {
      calls.gets.push({ identity, registrationId });
      return results.get ?? { status: "ok", registration: record() };
    },
  };
  return { service, calls };
}

function snapshotService(
  result: ScienceFlowRunSnapshotQueryResult = { status: "ok", snapshot: snapshot() },
  queries: ScienceFlowRunQuery[] = [],
): ScienceFlowRunSnapshotService {
  return {
    enabled: true,
    query: async (query) => {
      queries.push(query);
      return result;
    },
  };
}

async function call(
  options: {
    readonly service?: FakeService;
    readonly runSnapshots?: ScienceFlowRunSnapshotService;
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<{
  handled: boolean;
  captured: Captured;
  body: Record<string, unknown>;
}> {
  const fake = options.service ?? fakeService({});
  const { captured, response } = fakeResponse();
  const handled = await handleScienceFlowRegistrationRequest(
    fakeRequest({ method: options.method, headers: options.headers, body: options.body }),
    response,
    new URL(`${BASE}${options.path ?? LIST_PATH}`),
    fake.service,
    options.runSnapshots ?? snapshotService(),
  );
  return {
    handled,
    captured,
    body: captured.body ? JSON.parse(captured.body) : {},
  };
}

test("REG-H01 leaves every other path to the existing dispatcher", async () => {
  for (const path of [
    "/api/projects",
    "/api/projects/project-1/sessions/session-1/scienceflow/runs/run-1/snapshot",
    // A malformed segment is not this route; the caller still answers 404.
    "/api/projects/project-1/sessions/session-1/scienceflow/registrations/registration-1/snapshot/extra",
  ]) {
    const { handled, captured } = await call({ path });
    assert.equal(handled, false, path);
    assert.equal(captured.statusCode, 0, path);
    assert.equal(captured.body, "", path);
  }
});

test("REG-H02 list returns a plain array with the decoded identity and pagination", async () => {
  const fake = fakeService({});
  const { handled, captured, body } = await call({
    service: fake,
    path: `${LIST_PATH}?limit=5&offset=2`,
  });
  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers.get("cache-control"), "no-store");
  assert.equal(captured.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(body, [record()]);
  assert.deepEqual(fake.calls.lists, [
    { identity: { projectId: "project-1", sessionId: "session-1" }, options: { limit: 5, offset: 2 } },
  ]);
});

test("REG-H03 list refuses unsupported query, invalid pagination, and a body", async () => {
  const cases: Array<{ readonly options: Parameters<typeof call>[0] }> = [
    { options: { path: `${LIST_PATH}?path=%2Fetc%2Fpasswd` } },
    { options: { path: `${LIST_PATH}?limit=abc` } },
    { options: { path: `${LIST_PATH}?limit=-1` } },
    { options: { path: `${LIST_PATH}?limit=1.5` } },
    { options: { path: `${LIST_PATH}?offset=99999999999999999999` } },
    { options: { headers: { "content-length": "12" } } },
    { options: { headers: { "transfer-encoding": "chunked" } } },
  ];
  for (const item of cases) {
    const fake = fakeService({});
    const { captured, body } = await call({ ...item.options, service: fake });
    assert.equal(captured.statusCode, 400, JSON.stringify(item.options));
    assert.equal(body.code, "SCIENCEFLOW_INVALID_REQUEST");
    assert.equal(fake.calls.lists.length, 0, JSON.stringify(item.options));
  }
});

test("REG-H04 create accepts only {runId} and maps 201 versus 200", async () => {
  const created = fakeService({});
  const first = await call({ service: created, method: "POST", body: JSON.stringify({ runId: "run-1" }) });
  assert.equal(first.captured.statusCode, 201);
  assert.deepEqual(first.body, record());
  assert.deepEqual(created.calls.creates, [
    { identity: { projectId: "project-1", sessionId: "session-1" }, runId: "run-1" },
  ]);

  const existing = fakeService({ create: { status: "existing", registration: record() } });
  const second = await call({ service: existing, method: "POST", body: JSON.stringify({ runId: "run-1" }) });
  assert.equal(second.captured.statusCode, 200);
  assert.deepEqual(second.body, record());
});

test("REG-H05 create refuses any field or body shape it does not own", async () => {
  const bodies = [
    "{}",
    JSON.stringify({ runId: "run-1", registrationId: "forged" }),
    JSON.stringify({ runId: "run-1", createdAt: "2026-11-10T00:00:00.000Z" }),
    JSON.stringify({ runId: "run-1", runRecordPath: `/${MARKER}` }),
    JSON.stringify({ runId: "" }),
    JSON.stringify({ runId: "run/1" }),
    JSON.stringify({ runId: 7 }),
    JSON.stringify(["run-1"]),
    JSON.stringify(null),
  ];
  for (const body of bodies) {
    const fake = fakeService({});
    const result = await call({ service: fake, method: "POST", body });
    assert.equal(result.captured.statusCode, 400, body);
    assert.equal(result.body.code, "SCIENCEFLOW_INVALID_REQUEST", body);
    assert.equal(fake.calls.creates.length, 0, body);
  }

  // Invalid JSON makes `readJson` throw; the API's central mapping turns that
  // into a 400. The unit-level handler must not swallow it into a success.
  await assert.rejects(
    call({ method: "POST", body: "{not json" }),
    /must be valid JSON/,
  );

  // A create carries no query string.
  const withQuery = fakeService({});
  const rejected = await call({
    service: withQuery,
    method: "POST",
    path: `${LIST_PATH}?runId=run-1`,
    body: JSON.stringify({ runId: "run-1" }),
  });
  assert.equal(rejected.captured.statusCode, 400);
  assert.equal(withQuery.calls.creates.length, 0);
});

test("REG-H06 create maps every service result to its documented status and code", async () => {
  const cases: Array<{
    readonly label: string;
    readonly result: ScienceFlowRegistrationCreateResult;
    readonly status: number;
    readonly code: string;
  }> = [
    {
      label: "missing project/session/binding",
      result: { status: "not-found", resource: "binding" },
      status: 404,
      code: "SCIENCEFLOW_REGISTRATION_NOT_FOUND",
    },
    {
      label: "reader disabled",
      result: { status: "disabled" },
      status: 503,
      code: "SCIENCEFLOW_READER_DISABLED",
    },
    {
      label: "invalid query",
      result: { status: "invalid", reason: "query" },
      status: 400,
      code: "SCIENCEFLOW_INVALID_REQUEST",
    },
    {
      label: "trusted binding defect",
      result: { status: "invalid", reason: "binding" },
      status: 500,
      code: "SCIENCEFLOW_BINDING_ERROR",
    },
    {
      label: "corrupt row",
      result: { status: "corrupt" },
      status: 500,
      code: "SCIENCEFLOW_REGISTRATION_CORRUPT",
    },
    {
      label: "internal error",
      result: { status: "internal-error" },
      status: 500,
      code: "SCIENCEFLOW_INTERNAL_ERROR",
    },
  ];
  for (const item of cases) {
    const fake = fakeService({ create: item.result });
    const { captured, body } = await call({
      service: fake,
      method: "POST",
      body: JSON.stringify({ runId: "run-1" }),
    });
    assert.equal(captured.statusCode, item.status, item.label);
    assert.equal(body.code, item.code, item.label);
    assert.equal(typeof body.error, "string", item.label);
    assert.equal(body.registration, undefined, item.label);
    assert.ok(!JSON.stringify(body).includes(MARKER), item.label);
  }
});

test("REG-H07 detail reads one registration and refuses query, body, and other methods", async () => {
  const fake = fakeService({});
  const ok = await call({ service: fake, path: DETAIL_PATH });
  assert.equal(ok.captured.statusCode, 200);
  assert.equal(ok.captured.headers.get("cache-control"), "no-store");
  assert.deepEqual(ok.body, record());
  assert.deepEqual(fake.calls.gets, [
    { identity: { projectId: "project-1", sessionId: "session-1" }, registrationId: "registration-1" },
  ]);

  const missing = await call({
    service: fakeService({ get: { status: "not-found", resource: "registration" } }),
    path: DETAIL_PATH,
  });
  assert.equal(missing.captured.statusCode, 404);
  assert.equal(missing.body.code, "SCIENCEFLOW_REGISTRATION_NOT_FOUND");

  for (const options of [
    { path: `${DETAIL_PATH}?x=1` },
    { headers: { "content-length": "1" } },
    { path: `${LIST_PATH}/registration%2F1` },
  ]) {
    const { captured } = await call({ ...options, service: fakeService({}) });
    assert.equal(captured.statusCode, 400, JSON.stringify(options));
  }

  const wrongMethod = await call({ service: fake, method: "POST", path: DETAIL_PATH });
  assert.equal(wrongMethod.captured.statusCode, 405);
  assert.equal(wrongMethod.captured.headers.get("allow"), "GET");
});

test("REG-H08 snapshot resolves the registration first, then reuses the run snapshot query", async () => {
  const queries: ScienceFlowRunQuery[] = [];
  const fake = fakeService({});
  const { captured, body } = await call({
    service: fake,
    path: SNAPSHOT_PATH,
    runSnapshots: snapshotService({ status: "ok", snapshot: snapshot() }, queries),
  });
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    schemaVersion: 1,
    run: { runId: "run-1", status: "running", phase: "research" },
    tasks: [],
    diagnostics: [],
  });
  // The persisted run id is queried; registrationId is never sent as a run id.
  assert.deepEqual(queries, [{ projectId: "project-1", sessionId: "session-1", runId: "run-1" }]);
  assert.deepEqual(fake.calls.gets, [
    { identity: { projectId: "project-1", sessionId: "session-1" }, registrationId: "registration-1" },
  ]);
});

test("REG-H09 snapshot distinguishes a missing registration from an unavailable read", async () => {
  // Missing registration: 404, and the reader is never consulted.
  const queries: ScienceFlowRunQuery[] = [];
  const missing = await call({
    service: fakeService({ get: { status: "not-found", resource: "registration" } }),
    path: SNAPSHOT_PATH,
    runSnapshots: snapshotService({ status: "ok", snapshot: snapshot() }, queries),
  });
  assert.equal(missing.captured.statusCode, 404);
  assert.equal(missing.body.code, "SCIENCEFLOW_REGISTRATION_NOT_FOUND");
  assert.equal(queries.length, 0);

  // The registration exists but the administrator withdrew the binding.
  const withdrawn = await call({
    service: fakeService({}),
    path: SNAPSHOT_PATH,
    runSnapshots: snapshotService({ status: "not-found", resource: "binding" }),
  });
  assert.equal(withdrawn.captured.statusCode, 503);
  assert.equal(withdrawn.body.code, "SCIENCEFLOW_REGISTRATION_SNAPSHOT_UNAVAILABLE");

  // The reader itself is not configured.
  const disabled = await call({
    service: fakeService({}),
    path: SNAPSHOT_PATH,
    runSnapshots: { enabled: false },
  });
  assert.equal(disabled.captured.statusCode, 503);
  assert.equal(disabled.body.code, "SCIENCEFLOW_READER_DISABLED");

  // A corrupt record is not a missing one.
  const corrupt = await call({
    service: fakeService({ get: { status: "corrupt" } }),
    path: SNAPSHOT_PATH,
  });
  assert.equal(corrupt.captured.statusCode, 500);
  assert.equal(corrupt.body.code, "SCIENCEFLOW_REGISTRATION_CORRUPT");
});

test("REG-H10 snapshot delegates every other reader outcome unchanged", async () => {
  const cases: Array<{
    readonly result: ScienceFlowRunSnapshotQueryResult;
    readonly status: number;
    readonly code: string;
  }> = [
    { result: { status: "timeout", timeoutMs: 5_000 }, status: 504, code: "SCIENCEFLOW_READ_TIMEOUT" },
    { result: { status: "spawn-failed", code: "ENOENT" }, status: 503, code: "SCIENCEFLOW_READER_UNAVAILABLE" },
    { result: { status: "run-mismatch" }, status: 502, code: "SCIENCEFLOW_RUN_MISMATCH" },
    { result: { status: "internal-error" }, status: 500, code: "SCIENCEFLOW_INTERNAL_ERROR" },
  ];
  for (const item of cases) {
    const { captured, body } = await call({
      service: fakeService({}),
      path: SNAPSHOT_PATH,
      runSnapshots: snapshotService(item.result),
    });
    assert.equal(captured.statusCode, item.status, item.code);
    assert.equal(body.code, item.code);
  }
});

test("REG-H11 method dispatch advertises the methods each route accepts", async () => {
  const listDelete = await call({ method: "DELETE" });
  assert.equal(listDelete.captured.statusCode, 405);
  assert.equal(listDelete.captured.headers.get("allow"), "GET, POST");
  assert.equal(listDelete.body.code, "SCIENCEFLOW_METHOD_NOT_ALLOWED");

  for (const method of ["PUT", "PATCH", "HEAD"]) {
    const snapshotCall = await call({ method, path: SNAPSHOT_PATH });
    assert.equal(snapshotCall.captured.statusCode, 405, method);
    assert.equal(snapshotCall.captured.headers.get("allow"), "GET", method);
  }
});
