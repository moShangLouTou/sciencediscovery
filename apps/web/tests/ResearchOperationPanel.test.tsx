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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LocaleProvider } from "../src/i18n/index.js";
import type { ResearchOperation } from "../src/api/research-operations.js";
import {
  ResearchOperationPanel,
  type ResearchOperationsPort,
} from "../src/session/ResearchOperationPanel.js";
import {
  deliveryLabelKey,
  researchContinuationText,
  researchStages,
  researchStatus,
} from "../src/session/research-operation-model.js";

function operation(overrides: Partial<ResearchOperation> = {}): ResearchOperation {
  return {
    createdAt: "2026-11-16T00:00:00.000Z",
    delivery: { attempts: 0, state: "pending", updatedAt: "2026-11-16T00:00:00.000Z" },
    engine: {},
    engineRunId: "sd-research-12345678-abc",
    error: null,
    experimentalLocalExecution: true,
    formalRunnerSandbox: false,
    incumbentVersionId: "incumbent-version",
    inputMode: "dynamic",
    instruction: "Run the experiment",
    intent: "Test whether a perturbed start escapes the plateau",
    model: null,
    operationId: "operation-12345678",
    planVersionId: "plan-version",
    stages: [],
    state: "running",
    stop: {},
    task: "circle-packing",
    updatedAt: "2026-11-16T00:00:00.000Z",
    usage: null,
    ...overrides,
  };
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((candidate) => {
    const children = candidate.props.children;
    return Array.isArray(children) ? children.some((child) => child === label) : children === label;
  });
}

test("status keeps lifecycle, progress and delivery as separate facts", () => {
  const running = operation({
    stages: [
      { artifactSha256: "a".repeat(64), createdAtUtc: "2026-11-16T00:01:00Z", evaluatorStatus: "ok", gateAccepted: true, metricName: "radii_sum", metricValue: 2.62400316149487, parentStageId: null, stageId: "S01", validationOk: true },
      { artifactSha256: "b".repeat(64), createdAtUtc: "2026-11-16T00:02:00Z", evaluatorStatus: "ok", gateAccepted: true, metricName: "radii_sum", metricValue: 2.6241, parentStageId: "S01", stageId: "S02", validationOk: true },
    ],
    state: "running",
  });
  assert.deepEqual(researchStatus(running), { kind: "running", tone: "active" });
  assert.equal(researchStages(running).count, 2);
  assert.equal(researchStages(running).latest?.stageId, "S02");

  // A terminal run whose delivery failed is not a delivered success.
  const failedDelivery = operation({ delivery: { attempts: 2, message: "CAS write failed", state: "failed", updatedAt: "2026-11-16T00:03:00Z" }, state: "completed" });
  assert.deepEqual(researchStatus(failedDelivery), { kind: "completed", tone: "done" });
  assert.equal(failedDelivery.delivery.state, "failed");

  assert.deepEqual(researchStatus(operation({ state: "stopping", stop: { requestedAt: "2026-11-16T00:02:00Z" } })), { kind: "stop-requested", tone: "waiting" });
  assert.deepEqual(researchStatus(operation({ state: "stopping", stop: { confirmedAt: "2026-11-16T00:02:30Z", requestedAt: "2026-11-16T00:02:00Z" } })), { kind: "stopped", tone: "done" });
  assert.deepEqual(researchStatus(operation({ state: "unknown" })), { kind: "unknown", tone: "unknown" });
  assert.equal(deliveryLabelKey(operation({ delivery: { attempts: 0, state: "no-candidate", updatedAt: "x" } })), "noCandidate");
  assert.equal(deliveryLabelKey(operation({ delivery: { attempts: 1, state: "failed", updatedAt: "x" } })), "failed");
  assert.equal(deliveryLabelKey(operation({ delivery: { attempts: 1, state: "delivered", updatedAt: "x" } })), "delivered");
});

test("the continuation request names the exact delivered version and needs no run", () => {
  const delivered = operation({
    delivery: {
      attempts: 1,
      note: { artifactId: "note-artifact", logicalName: "scienceflow/run/result-note.md", role: "note", version: 2, versionId: "note-version-2" },
      solution: { artifactId: "solution-artifact", logicalName: "scienceflow/run/best-solution.json", role: "solution", version: 3, versionId: "solution-version-3" },
      state: "delivered",
      updatedAt: "2026-11-16T00:03:00Z",
    },
    state: "completed",
  });
  const request = researchContinuationText(delivered);
  assert.ok(request?.includes("solution-version-3"));
  assert.ok(request?.includes("scienceflow/run/best-solution.json"));
  assert.ok(request?.includes("note-version-2"));
  assert.equal(researchContinuationText(operation({ state: "completed" })), undefined);
  assert.equal(researchContinuationText(operation({
    delivery: { attempts: 1, solution: { artifactId: "s", logicalName: "n", role: "solution", version: 1, versionId: "v" }, state: "failed", updatedAt: "x" },
  })), undefined);
});

async function render(port: ResearchOperationsPort, callbacks: {
  onDelivered?: () => void;
  onOpenArtifact?: (ref: import("../src/api/research-operations.js").ResearchArtifactRef) => void;
  onPrefill?: (text: string) => void;
  renderPanel?: (panel: ReactNode) => ReactNode;
} = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, null, createElement(ResearchOperationPanel, {
      client: port,
      isRunning: true,
      onDelivered: callbacks.onDelivered,
      onOpenArtifact: callbacks.onOpenArtifact ?? (() => undefined),
      onPrefill: callbacks.onPrefill ?? (() => undefined),
      renderPanel: callbacks.renderPanel,
      sessionId: "session-1",
    })));
  });
  return renderer!;
}

test("renders live status, stage score, separate delivery and a stop action", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped: Array<[string, string]> = [];
  const live = operation({
    stages: [{ artifactSha256: "a".repeat(64), createdAtUtc: "2026-11-16T00:01:00Z", evaluatorStatus: "ok", gateAccepted: true, metricName: "radii_sum", metricValue: 2.62400316149487, parentStageId: null, stageId: "S01", validationOk: true }],
  });
  const port: ResearchOperationsPort = {
    getResearchOperation: async () => live,
    listResearchOperations: async () => ({ enabled: true, inputMode: "dynamic", operations: [live], profileId: "round25" }),
    retryResearchDelivery: async () => live,
    stopResearchOperation: async (sessionId, operationId) => {
      stopped.push([sessionId, operationId]);
      return { confirmed: false, operation: { ...live, state: "stopping", stop: { requestedAt: "2026-11-16T00:02:00Z", requestedBy: "tool" } }, requested: true };
    },
  };
  const renderer = await render(port);
  try {
    const markup = text(renderer);
    assert.ok(markup.includes("ScienceFlow"));
    assert.ok(markup.includes("Running"));
    assert.ok(markup.includes("2.62400316149487"));
    assert.ok(markup.includes("not delivered yet"));
    assert.ok(markup.includes("Stop research"));
    assert.ok(!markup.includes("Continue from this result"));
    assert.ok(!markup.includes("Retry delivery"));

    const stop = button(renderer, "Stop research");
    assert.ok(stop);
    await act(async () => { stop!.props.onClick(); });
    assert.deepEqual(stopped, [["session-1", "operation-12345678"]]);
    const afterStop = text(renderer);
    assert.ok(afterStop.includes("Stop requested. Waiting for the engine to confirm termination."));
    assert.ok(afterStop.includes("Stop requested"));
    // A followed stop is not repeatedly sent while the engine confirms.
    const disabledStop = button(renderer, "Stopping…");
    assert.ok(disabledStop?.props.disabled);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("delivered results link to their versions, prefill an editable request, and refresh artifacts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let deliveredCalls = 0;
  const opened: string[] = [];
  let prefilled = "";
  const delivered = operation({
    delivery: {
      attempts: 1,
      note: { artifactId: "note-artifact", logicalName: "scienceflow/run/result-note.md", role: "note", version: 2, versionId: "note-version-2" },
      solution: { artifactId: "solution-artifact", logicalName: "scienceflow/run/best-solution.json", role: "solution", version: 3, versionId: "solution-version-3" },
      state: "delivered",
      updatedAt: "2026-11-16T00:03:00Z",
    },
    state: "completed",
  });
  const renderer = await render({
    getResearchOperation: async () => delivered,
    listResearchOperations: async () => ({ enabled: true, inputMode: "dynamic", operations: [delivered], profileId: "round25" }),
    retryResearchDelivery: async () => delivered,
    stopResearchOperation: async () => ({ confirmed: true, operation: delivered, requested: true }),
  }, {
    onDelivered: () => { deliveredCalls += 1; },
    onOpenArtifact: (ref) => opened.push(ref.versionId),
    onPrefill: (value) => { prefilled = value; },
  });
  try {
    const markup = text(renderer);
    assert.ok(markup.includes("research-operation-delivery delivered"));
    assert.ok(markup.includes("Continue from this result"));
    assert.ok(markup.includes("Open selected solution (v3)"));
    assert.equal(deliveredCalls, 1);

    await act(async () => { button(renderer, "Open selected solution (v3)")!.props.onClick(); });
    await act(async () => { button(renderer, "Open result note (v2)")!.props.onClick(); });
    assert.deepEqual(opened, ["solution-version-3", "note-version-2"]);

    await act(async () => { button(renderer, "Continue from this result")!.props.onClick(); });
    assert.ok(prefilled.includes("solution-version-3"));
    assert.ok(prefilled.includes("Continue from research operation operation-12345678"));
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("delivery failure offers a retry that republishes the same run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retried: Array<[string, string]> = [];
  let state: ResearchOperation = operation({
    delivery: { attempts: 2, message: "CAS write failed", reason: "publication-failed", state: "failed", updatedAt: "2026-11-16T00:03:00Z" },
    state: "completed",
  });
  const renderer = await render({
    getResearchOperation: async () => state,
    listResearchOperations: async () => ({ enabled: true, inputMode: "dynamic", operations: [state], profileId: "round25" }),
    retryResearchDelivery: async (sessionId, operationId) => {
      retried.push([sessionId, operationId]);
      state = { ...state, delivery: { ...state.delivery, state: "delivered" } };
      return state;
    },
    stopResearchOperation: async () => ({ confirmed: true, operation: state, requested: true }),
  });
  try {
    const markup = text(renderer);
    assert.ok(markup.includes("delivery failed"));
    assert.ok(markup.includes("CAS write failed"));
    assert.ok(!markup.includes("Continue from this result"));
    await act(async () => { button(renderer, "Retry delivery")!.props.onClick(); });
    assert.deepEqual(retried, [["session-1", "operation-12345678"]]);
    assert.ok(text(renderer).includes("Delivery succeeded. The result artifacts are now available."));
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("disabled mode renders no panel or actions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const renderer = await render({
    getResearchOperation: async () => operation(),
    listResearchOperations: async () => ({ enabled: false, operations: [] }),
    retryResearchDelivery: async () => operation(),
    stopResearchOperation: async () => ({ confirmed: true, operation: operation(), requested: true }),
  });
  try {
    assert.equal(renderer.toJSON(), null);
  } finally {
    await act(async () => renderer.unmount());
  }
});


test("a hidden workspace keeps polling and refreshes delivered artifacts before reopening", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false;
  let deliveredCalls = 0;
  let reads = 0;
  let current = operation();
  const renderer = await render({
    getResearchOperation: async () => current,
    listResearchOperations: async () => {
      reads += 1;
      return { enabled: true, inputMode: "dynamic", operations: [current], profileId: "round25" };
    },
    retryResearchDelivery: async () => current,
    stopResearchOperation: async () => ({ confirmed: true, operation: current, requested: true }),
  }, {
    onDelivered: () => { deliveredCalls += 1; },
    renderPanel: (panel) => visible ? panel : null,
  });
  try {
    assert.equal(renderer.toJSON(), null);
    assert.equal(reads, 1);
    current = operation({
      state: "completed",
      delivery: { attempts: 1, state: "delivered", updatedAt: "2026-11-16T00:03:00Z" },
    });
    await act(async () => { t.mock.timers.tick(5_000); });
    assert.equal(reads, 2);
    assert.equal(deliveredCalls, 1);
    assert.equal(renderer.toJSON(), null);

    visible = true;
    await act(async () => { t.mock.timers.tick(10_000); });
    assert.ok(text(renderer).includes("Completed"));
    assert.equal(deliveredCalls, 1);
    const folder = renderer.root.findByProps({ "data-folder": "research" });
    assert.equal(folder.props.open, true);
    const closed = { open: false };
    await act(async () => { folder.props.onToggle({ target: closed, currentTarget: closed }); });
    await act(async () => { t.mock.timers.tick(10_000); });
    assert.equal(renderer.root.findByProps({ "data-folder": "research" }).props.open, false);
    assert.equal(reads, 4);
    assert.equal(deliveredCalls, 1);
  } finally {
    await act(async () => renderer.unmount());
  }
});
