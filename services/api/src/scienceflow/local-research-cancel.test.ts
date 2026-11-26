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
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { TestContext } from "node:test";

import { SessionStore } from "../store.js";
import type { LocalResearchService } from "./local-research.js";
import { cancelSessionRun } from "../runs/index.js";
import { clearLocalResearchService, setLocalResearchService } from "./local-research-runtime.js";

function fakeResponse(): ServerResponse {
  const response = {
    end: () => response,
    writeHead: () => response,
  };
  return response as unknown as ServerResponse;
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-cancel-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    clearLocalResearchService();
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Cancel");
  await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Cancel session");
  const run = await store.createSessionRun({
    prompt: "Start the experiment",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  await store.updateSessionRunStatus(session.id, run.id, "running", { startedAt: new Date().toISOString() });
  return { projectId: project.id, runId: run.id, sessionId: session.id, store };
}

test("cancelling the conversation asks only its owned research operation to stop", async (context) => {
  const target = await fixture(context);
  const stops: Array<{ sessionId: string; runId: string }> = [];
  const service = {
    requestStopForConversationRun: async (sessionId: string, runId: string) => {
      stops.push({ runId, sessionId });
    },
  } as unknown as LocalResearchService;
  setLocalResearchService(service);
  await cancelSessionRun(fakeResponse(), target.store, target.sessionId, target.runId);
  assert.deepEqual(stops, [{ runId: target.runId, sessionId: target.sessionId }]);
});

test("cancelling another Session's conversation does not reach this one", async (context) => {
  const target = await fixture(context);
  const stops: Array<{ sessionId: string; runId: string }> = [];
  setLocalResearchService({
    requestStopForConversationRun: async (sessionId: string, runId: string) => {
      stops.push({ runId, sessionId });
    },
  } as unknown as LocalResearchService);
  const other = await target.store.createSession(target.projectId, "Other session");
  const otherRun = await target.store.createSessionRun({
    prompt: "Other work",
    sessionId: other.id,
    settingsSnapshot: target.store.resolveRuntimeSettings(other.id).effective,
  });
  await target.store.updateSessionRunStatus(other.id, otherRun.id, "running", { startedAt: new Date().toISOString() });
  await cancelSessionRun(fakeResponse(), target.store, other.id, otherRun.id);
  // The wiring passes the cancelled conversation's own identity and nothing else.
  assert.deepEqual(stops, [{ runId: otherRun.id, sessionId: other.id }]);
});
