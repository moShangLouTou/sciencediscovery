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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  handleScienceFlowLocalResearchRequest,
  type LocalResearchHttpStore,
} from "./local-research-http.js";
import {
  LocalResearchRefusal,
  type LocalResearchService,
  type ScienceFlowLocalResearchView,
} from "./local-research.js";

function view(operationId: string, overrides: Partial<ScienceFlowLocalResearchView> = {}): ScienceFlowLocalResearchView {
  return {
    createdAt: "2026-11-16T00:00:00.000Z",
    delivery: { attempts: 0, state: "pending", updatedAt: "2026-11-16T00:00:00.000Z" },
    engine: {},
    engineRunId: `sd-research-${operationId.slice(0, 8)}`,
    error: null,
    experimentalLocalExecution: true,
    formalRunnerSandbox: false,
    grant: {} as ScienceFlowLocalResearchView["grant"],
    incumbentVersionId: null,
    inputMode: "dynamic",
    inputs: [],
    instruction: "Run the experiment",
    intent: `Intent ${operationId}`,
    model: null,
    operationId,
    planVersionId: null,
    stages: [],
    state: "running",
    stop: {},
    task: "circle-packing",
    updatedAt: "2026-11-16T00:00:00.000Z",
    usage: null,
    ...overrides,
  };
}

function fakeService(overrides: Partial<LocalResearchService> = {}): LocalResearchService {
  return {
    enabled: true,
    inputMode: "dynamic",
    observeMaxWaitMs: 120_000,
    permissionResource: "scienceflow:local-research",
    profileId: "round25-local-dynamic",
    list: () => [],
    get: async () => view("operation-0001"),
    stop: async () => ({ confirmed: true, operation: view("operation-0001"), requested: true }),
    retryDelivery: async () => view("operation-0001", { delivery: { attempts: 1, state: "delivered", updatedAt: "2026-11-16T00:00:00.000Z" } }),
    start: async () => { throw new Error("not used"); },
    publishPlan: async () => { throw new Error("not used"); },
    requestStopForConversationRun: async () => undefined,
    latest: () => undefined,
    ...overrides,
  } as LocalResearchService;
}

const store: LocalResearchHttpStore = {
  assertSessionWritable: () => undefined,
  getSession: (sessionId) => sessionId === "session-a" ? { projectId: "project-a" } : undefined,
};

interface Invocation {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly query?: string;
  readonly writable?: boolean;
}

async function invoke(service: LocalResearchService | undefined, options: Invocation) {
  let status = 0;
  let result: unknown;
  const headers: Record<string, string> = {};
  const response = {
    end(value: string) { result = JSON.parse(value); },
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(value: number) { status = value; },
  } as unknown as ServerResponse;
  const request = {
    headers: { ...(options.body === undefined ? {} : { "content-length": String(Buffer.byteLength(options.body)) }) },
    method: options.method,
  } as unknown as IncomingMessage;
  const customStore: LocalResearchHttpStore = {
    assertSessionWritable: options.writable === false
      ? () => { throw new Error("Session is archived and read-only"); }
      : () => undefined,
    getSession: store.getSession,
  };
  const handled = await handleScienceFlowLocalResearchRequest(
    request,
    response,
    new URL(`${options.path}${options.query ?? ""}`, "http://api.test"),
    service,
    customStore,
  );
  return { handled, headers, result: result as Record<string, unknown>, status };
}

test("disabled mode lists an empty, explicitly disabled status and hides operations", async () => {
  const list = await invoke(undefined, { method: "GET", path: "/api/sessions/session-a/research-operations" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.result, { enabled: false, operations: [] });

  const detail = await invoke(undefined, { method: "GET", path: "/api/sessions/session-a/research-operations/operation-0001" });
  assert.equal(detail.status, 404);
  assert.equal(detail.result.code, "LOCAL_RESEARCH_DISABLED");
});

test("enabled mode lists and reads only this Session's public operation views", async () => {
  const operations = [view("operation-0001"), view("operation-0002", { state: "completed" })];
  const list = await invoke(fakeService({ list: () => operations }), {
    method: "GET",
    path: "/api/sessions/session-a/research-operations",
  });
  assert.equal(list.status, 200);
  assert.equal(list.result.enabled, true);
  assert.equal(list.result.profileId, "round25-local-dynamic");
  assert.equal(list.result.inputMode, "dynamic");
  assert.deepEqual((list.result.operations as ScienceFlowLocalResearchView[]).map(item => item.operationId), ["operation-0001", "operation-0002"]);

  const seen: unknown[] = [];
  const detail = await invoke(fakeService({
    get: async (input, options) => {
      seen.push({ input, options });
      return view(input.operationId!);
    },
  }), { method: "GET", path: "/api/sessions/session-a/research-operations/operation-0002" });
  assert.equal(detail.status, 200);
  assert.equal(detail.result.operationId, "operation-0002");
  assert.deepEqual(seen, [{
    input: { operationId: "operation-0002", projectId: "project-a", sessionId: "session-a" },
    options: { waitMs: 0 },
  }]);
});

test("a stop names this Session's operation and reports requested versus confirmed", async () => {
  const calls: unknown[] = [];
  const stopped = await invoke(fakeService({
    stop: async (input) => {
      calls.push(input);
      return { confirmed: false, operation: view(input.operationId!, { state: "stopping" }), requested: true };
    },
  }), { method: "POST", path: "/api/sessions/session-a/research-operations/operation-0001/stop" });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.result.requested, true);
  assert.equal(stopped.result.confirmed, false);
  assert.deepEqual(calls, [{ operationId: "operation-0001", projectId: "project-a", sessionId: "session-a" }]);

  const refused = await invoke(fakeService({
    stop: async () => {
      throw new LocalResearchRefusal("operation-not-found", "This Session has no such research operation");
    },
  }), { method: "POST", path: "/api/sessions/session-a/research-operations/other-session-op/stop" });
  assert.equal(refused.status, 404);
  assert.equal(refused.result.code, "LOCAL_RESEARCH_OPERATION_NOT_FOUND");
});

test("a read-only Session refuses stop and delivery retry before the service is called", async () => {
  let called = 0;
  const service = fakeService({
    retryDelivery: async () => { called += 1; return view("operation-0001"); },
    stop: async () => { called += 1; return { confirmed: false, operation: view("operation-0001"), requested: false }; },
  });
  for (const path of [
    "/api/sessions/session-a/research-operations/operation-0001/stop",
    "/api/sessions/session-a/research-operations/operation-0001/delivery-retry",
  ]) {
    const refused = await invoke(service, { method: "POST", path, writable: false });
    assert.equal(refused.status, 409);
    assert.equal(refused.result.code, "LOCAL_RESEARCH_READONLY");
  }
  assert.equal(called, 0);
});

test("delivery retry returns the same operation's republished view", async () => {
  const retried = await invoke(fakeService(), {
    method: "POST",
    path: "/api/sessions/session-a/research-operations/operation-0001/delivery-retry",
  });
  assert.equal(retried.status, 200);
  assert.equal((retried.result.delivery as { state: string }).state, "delivered");
});

test("unknown sessions, stray bodies and query parameters are refused", async () => {
  const missing = await invoke(fakeService(), { method: "GET", path: "/api/sessions/session-b/research-operations" });
  assert.equal(missing.status, 404);
  assert.equal(missing.result.code, "LOCAL_RESEARCH_SESSION_NOT_FOUND");

  const body = await invoke(fakeService(), {
    body: "{\"operationId\":\"forged\"}",
    method: "POST",
    path: "/api/sessions/session-a/research-operations/operation-0001/stop",
  });
  assert.equal(body.status, 400);

  const query = await invoke(fakeService(), {
    method: "GET",
    path: "/api/sessions/session-a/research-operations",
    query: "?all=1",
  });
  assert.equal(query.status, 400);

  const unrelated = await invoke(fakeService(), { method: "GET", path: "/api/sessions/session-a/artifacts" });
  assert.equal(unrelated.handled, false);
});
