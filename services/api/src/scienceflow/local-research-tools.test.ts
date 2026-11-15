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
  createLocalResearchTools,
  GET_RESEARCH_TOOL,
  localResearchInstructions,
  START_RESEARCH_TOOL,
  STOP_RESEARCH_TOOL,
} from "./local-research-tools.js";
import {
  LocalResearchRefusal,
  LOCAL_RESEARCH_PERMISSION_RESOURCE,
  type LocalResearchService,
  type ScienceFlowLocalResearchView,
} from "./local-research.js";

function baseView(overrides: Partial<Record<string, unknown>> = {}): ScienceFlowLocalResearchView {
  const view: ScienceFlowLocalResearchView = {
    createdAt: "2026-11-15T00:00:00Z",
    delivery: { attempts: 0, state: "pending", updatedAt: "2026-11-15T00:00:00Z" },
    engine: { observedAt: "2026-11-15T00:00:00Z", status: "running" },
    engineRunId: "sd-research-0123456789ab",
    error: null,
    experimentalLocalExecution: true,
    formalRunnerSandbox: false,
    grant: {
      bashTimeoutSec: 60,
      codeMaxTokens: 1_024,
      feedbackMaxTokens: 1_024,
      httpTimeoutSec: 60,
      maxSteps: 8,
      refusePackageInstall: true,
      reportBudgetSec: 60,
      researchBudgetSec: 240,
      stageCaptureMax: 3,
      task: "circle-packing",
      taskDescriptionPinned: true,
      totalAllowanceSec: 320,
    },
    incumbentVersionId: null,
    inputs: [],
    instruction: "Observe the run with get_research.",
    intent: "Run the bounded experiment.",
    model: { profileName: "Fixture", providerModel: "fixture-model", selectionSource: "session" },
    operationId: "operation-1",
    planVersionId: null,
    stages: [],
    state: "running",
    stop: {},
    task: "circle-packing",
    updatedAt: "2026-11-15T00:00:00Z",
    usage: null,
  };
  return { ...view, ...overrides } as ScienceFlowLocalResearchView;
}

function fakeService(overrides: Partial<LocalResearchService> = {}): LocalResearchService {
  return {
    enabled: true,
    get: async () => baseView(),
    latest: () => undefined,
    observeMaxWaitMs: 3_000,
    permissionResource: LOCAL_RESEARCH_PERMISSION_RESOURCE,
    profileId: "round23-local",
    requestStopForConversationRun: async () => undefined,
    retryDelivery: async () => baseView({ delivery: baseView().delivery }),
    start: async () => ({ attached: false, operation: baseView() }),
    stop: async () => ({ confirmed: true, operation: baseView({ state: "stopped" }), requested: true }),
    ...overrides,
  };
}

function toolsFor(service: LocalResearchService, options: {
  readonly beginExternalWait?: () => () => void;
  readonly requirePrivilege?: (request: {
    readonly resource: string;
    readonly summary: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
} = {}) {
  const privileges: Array<{ resource: string; summary: string; toolCallId?: string }> = [];
  const tools = createLocalResearchTools({
    projectId: "project-1",
    requirePrivilege: options.requirePrivilege ?? (async (request) => {
      privileges.push(request);
    }),
    ...(options.beginExternalWait ? { beginExternalWait: options.beginExternalWait } : {}),
    runId: "conversation-run-1",
    service,
    sessionId: "session-1",
  });
  return { privileges, tools };
}

function text(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function byName(tools: ReturnType<typeof createLocalResearchTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be exposed`);
  return tool;
}

test("exposes the three research tools and states the experimental boundary", () => {
  const { tools } = toolsFor(fakeService());
  assert.deepEqual(tools.map((tool) => tool.name), [START_RESEARCH_TOOL, GET_RESEARCH_TOOL, STOP_RESEARCH_TOOL]);
  const instructions = localResearchInstructions(fakeService());
  assert.match(instructions, /experimental local execution, not the formal Runner sandbox/);
  assert.match(instructions, /wait_seconds/);
  assert.match(instructions, /retry_delivery/);
  // The tool must state that a named version has to match the configured input.
  assert.match(instructions, /byte-identical/);
});

test("start asks for the governed privilege and returns only the public operation view", async () => {
  const { privileges, tools } = toolsFor(fakeService());
  const result = text(await byName(tools, START_RESEARCH_TOOL).execute("call-1", {
    intent: "Run the bounded experiment and report the trial log.",
  }, undefined));
  assert.equal(privileges.length, 1);
  assert.equal(privileges[0]!.resource, LOCAL_RESEARCH_PERMISSION_RESOURCE);
  assert.match(privileges[0]!.summary, /round23-local/);
  assert.equal(privileges[0]!.toolCallId, "call-1");
  const operation = result.operation as Record<string, unknown>;
  assert.equal(operation.operationId, "operation-1");
  assert.equal(operation.experimentalLocalExecution, true);
  assert.equal(operation.formalRunnerSandbox, false);
  assert.match(String(result.instruction), /do not call start_research again/);
});

test("a service refusal is reported as a stable reason instead of a stack trace", async () => {
  const { tools } = toolsFor(fakeService({
    start: async () => {
      throw new LocalResearchRefusal("unsupported-model", "The pilot carries only openai-chat-completions");
    },
  }));
  const result = text(await byName(tools, START_RESEARCH_TOOL).execute("call-1", {
    intent: "Run the experiment.",
  }, undefined));
  assert.equal(result.error, "unsupported-model");
  assert.match(String(result.message), /openai-chat-completions/);
});

test("cancelling during the permission wait starts no research after it resolves", async () => {
  let permit!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let privileges = 0;
  let starts = 0;
  const { tools } = toolsFor(fakeService({
    start: async () => {
      starts += 1;
      return { attached: false, operation: baseView() };
    },
  }), {
    requirePrivilege: () => {
      privileges += 1;
      entered();
      // The permission decision is held until after the conversation aborts.
      return new Promise<void>((resolve) => {
        permit = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = byName(tools, START_RESEARCH_TOOL).execute("call-6", {
    intent: "Run the configured experiment.",
  }, controller.signal);
  await enteredPromise;
  controller.abort();
  permit();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(privileges, 1);
  assert.equal(starts, 0, "a cancelled start must not create a research operation");
});

test("a bounded observation wait pauses and releases the Agent idle clock", async () => {
  let releases = 0;
  let begins = 0;
  const waited: number[] = [];
  const { tools } = toolsFor(fakeService({
    get: async (_input, options) => {
      waited.push(options?.waitMs ?? -1);
      return baseView({ state: "completed" });
    },
  }), {
    beginExternalWait: () => {
      begins += 1;
      return () => {
        releases += 1;
      };
    },
  });
  const result = text(await byName(tools, GET_RESEARCH_TOOL).execute("call-2", {
    operation_id: "operation-1",
    wait_seconds: 20,
  }, undefined));
  assert.equal(begins, 1);
  assert.equal(releases, 1);
  // The service's own observed maximum caps the requested wait.
  assert.deepEqual(waited, [3_000]);
  assert.equal(result.state, "completed");
});

test("retry_delivery republishes and never observes as a second run", async () => {
  let retried = 0;
  let observed = 0;
  const { tools } = toolsFor(fakeService({
    get: async () => {
      observed += 1;
      return baseView();
    },
    retryDelivery: async () => {
      retried += 1;
      return baseView({ delivery: { attempts: 2, state: "delivered", updatedAt: "2026-11-15T00:00:00Z" } });
    },
  }));
  const result = text(await byName(tools, GET_RESEARCH_TOOL).execute("call-3", {
    action: "retry_delivery",
    operation_id: "operation-1",
  }, undefined));
  assert.equal(retried, 1);
  assert.equal(observed, 0);
  assert.equal((result.delivery as Record<string, unknown>).state, "delivered");
});

test("stop reports requested and confirmed termination", async () => {
  const { tools } = toolsFor(fakeService({
    stop: async () => ({ confirmed: false, operation: baseView({ state: "stopping" }), requested: true }),
  }));
  const result = text(await byName(tools, STOP_RESEARCH_TOOL).execute("call-4", {}, undefined));
  assert.equal(result.requested, true);
  assert.equal(result.confirmed, false);
  assert.match(String(result.instruction), /not confirmed/);
});

test("host paths and credentials never reach the model even if a view carried one", async () => {
  const { tools } = toolsFor(fakeService({
    get: async () => baseView({
      workDir: "/home/operator/secret-work",
      launch: { engineCheckout: "/home/operator/engine", apiToken: "sk-secret" },
      receiptPath: "/home/operator/secret-work/receipt.json",
    }) as ScienceFlowLocalResearchView,
  }));
  const result = text(await byName(tools, GET_RESEARCH_TOOL).execute("call-5", {}, undefined));
  const serialized = JSON.stringify(result);
  for (const forbidden of ["secret-work", "engineCheckout", "apiToken", "sk-secret"]) {
    assert.ok(!serialized.includes(forbidden), `the tool result must not expose ${forbidden}`);
  }
  assert.equal(result.operationId, "operation-1");
});
