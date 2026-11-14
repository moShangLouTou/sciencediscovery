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

/**
 * The engine association as a durable ledger fact.
 *
 * The executor reports the engine run it created while the run is still
 * active; the manager is what makes that association survive. These cases
 * drive the manager's observation path (a stub executor still goes through the
 * real ledger) and check readback during the run, durability across a reopen,
 * and refusal of an association that is invalid or conflicts with the one
 * already recorded.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  ResearchEngineEvidence,
  ResearchRunRequest,
  ResearchRunStatus,
  ShellExecutionResult,
} from "@sciencediscovery/schema";
import { canonicalScienceFlowInputBundleManifest, SCIENCE_FLOW_INPUT_BUNDLE_VERSION } from "@sciencediscovery/schema";

import { ExecutionManager, mergeResearchEngine, validResearchEngine } from "./execution-manager.js";
import type { ResearchRunExecutor } from "./research-run.js";

const OWNER = { agentId: "agent", sessionId: "session" } as const;
const REVISION = "d".repeat(40);
const DIGEST = "c".repeat(64);

/**
 * A verified input set that rebuilds to its own bundle digest.
 *
 * A research run is publishable only with `verified` inputs, so the stub
 * executor has to carry one; this is the same canonical-manifest contract the
 * real executor records, not a shortcut around it.
 */
const INPUTS = (() => {
  const contractDigest = "a".repeat(64);
  const entries = [
    { content: "contract\n", path: "manifest.yaml", roles: ["manifest"] as const },
    { content: "id: probe\n", path: "package/task.yaml", roles: ["task_yaml"] as const },
    { content: "description\n", path: "package/description.md", roles: ["description"] as const },
    { content: "def evaluate():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] as const },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = entries.map((entry) => ({
    path: entry.path,
    roles: entry.roles,
    size: Buffer.byteLength(entry.content),
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  }));
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION as typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files,
  };
  const bundleDigest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
  return {
    identity: { bundleDigest, contractDigest },
    evidence: { bundleDigest, contractDigest, files, state: "verified" as const },
  };
})();


function engine(overrides: Partial<ResearchEngineEvidence> = {}): ResearchEngineEvidence {
  return {
    attempt: 1,
    derivedManifestDigest: DIGEST,
    engineRunId: "sf-run-0123456789abcdef",
    mappingVersion: 2,
    revision: REVISION,
    version: "0.2.0",
    ...overrides,
  };
}

function request(id: string, workspace: string): ResearchRunRequest {
  return {
    agentId: OWNER.agentId,
    executionId: id,
    inputs: { ...INPUTS.identity },
    kind: "research",
    permissionEpoch: { sessionId: OWNER.sessionId } as ResearchRunRequest["permissionEpoch"],
    schedule: {
      drainGraceMs: 100, reportBudgetMs: 1_000, researchBudgetMs: 5_000,
      stopGraceMs: 100, verificationWindowMs: 500,
    },
    schemaVersion: 1,
    workload: "scienceflow-fixed",
    workspaceRoot: workspace,
  };
}

function status(engineEvidence: ResearchEngineEvidence | undefined): ResearchRunStatus {
  return {
    deadlineViolated: false,
    forceReclaimRequested: false,
    observedAt: new Date().toISOString(),
    outcome: "failed",
    phase: "finished",
    process: "spawned-then-terminated",
    report: "failed",
    schedule: request("schedule", "/tmp").schedule,
    schemaVersion: 1,
    stop: "none",
    verificationWindowMs: 500,
    workload: "scienceflow-fixed",
    inputs: INPUTS.evidence,
    ...(engineEvidence !== undefined ? { engine: engineEvidence } : {}),
  };
}

function result(id: string): ShellExecutionResult {
  return {
    cgroupMode: "none", createdFiles: [], environmentRevisionId: "fixture",
    environmentVariables: {}, executionId: id, exitCode: 1, finishedAt: new Date().toISOString(),
    kernelId: `ephemeral:${id}`, kernelMode: "ephemeral", language: "shell", modifiedFiles: [],
    networkPolicy: "none", runnerVersion: "test", sandbox: "bubblewrap",
    startedAt: new Date().toISOString(), stderr: "", stdout: "",
    workingDirectory: "/workspace",
  };
}

async function fixture(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(resolve(tmpdir(), "engine-association-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("execution did not reach the expected state");
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("valid engine evidence is whitelisted, and a foreign field is not evidence", () => {
  assert.deepEqual(validResearchEngine(engine()), engine());
  for (const rejected of [
    { ...engine(), attempt: 0 },
    { ...engine(), engineRunId: "../escape" },
    { ...engine(), revision: "short" },
    { ...engine(), version: "" },
    { ...engine(), derivedManifestDigest: "nope" },
    { ...engine(), mappingVersion: 0 },
    { ...engine(), pid: 42 },
    null,
    [],
    "engine",
  ]) {
    assert.equal(validResearchEngine(rejected), null, JSON.stringify(rejected));
  }
});

test("the first durable association is kept and a later one is a conflict", () => {
  const first = engine();
  const second = engine({ engineRunId: "sf-run-ffffffffffffffff" });
  assert.deepEqual(mergeResearchEngine(undefined, first), { conflict: false, engine: first });
  assert.deepEqual(mergeResearchEngine(first, undefined), { conflict: false, engine: first });
  assert.deepEqual(mergeResearchEngine(first, first), { conflict: false, engine: first });
  assert.deepEqual(mergeResearchEngine(first, second), { conflict: true, engine: first });
  // A stored value that cannot be validated is a conflict, never a slot to fill.
  assert.deepEqual(mergeResearchEngine({ engineRunId: "x" }, first), { conflict: true, engine: undefined });
  assert.deepEqual(mergeResearchEngine(undefined, { engineRunId: "x" }), { conflict: true, engine: undefined });
});

test("an active run's association is readable and survives reopening the ledger", async (context) => {
  const { root, workspace } = await fixture(context);
  let release: () => void = () => undefined;
  const gateway = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<ResearchEngineEvidence>();
  const research: ResearchRunExecutor = {
    run: async (submitted, launch) => {
      launch.lifecycle?.observed?.({ research: { engine: engine() } });
      observed.resolve(engine());
      release = gateway.resolve;
      await gateway.promise;
      return { research: status(engine()), result: result(submitted.executionId) };
    },
  };
  const manager = new ExecutionManager(root, undefined, { research });
  context.after(async () => {
    // The case closes the first manager itself to reopen the same ledger.
    await manager.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  manager.submitResearch(request("live-engine", workspace));
  await observed.promise;
  await until(() => manager.get("live-engine", OWNER).research?.engine !== undefined);
  // Read back while the operation is still active: the association is in the
  // ledger, not only in the operation's memory.
  assert.equal(manager.get("live-engine", OWNER).research?.engine?.engineRunId, engine().engineRunId);
  release();
  await until(() => manager.get("live-engine", OWNER).state === "failed");
  await manager.close();
  // A restarted Runner sees the same association from the durable row.
  const reopened = new ExecutionManager(root);
  context.after(() => reopened.close());
  assert.deepEqual(reopened.get("live-engine", OWNER).research?.engine, engine());
});

test("a returned association that contradicts the recorded one is refused", async (context) => {
  const { root, workspace } = await fixture(context);
  const research: ResearchRunExecutor = {
    run: async (submitted, launch) => {
      launch.lifecycle?.observed?.({ research: { engine: engine() } });
      // The final result claims a different engine run for the same execution.
      return {
        research: status(engine({ engineRunId: "sf-run-ffffffffffffffff" })),
        result: result(submitted.executionId),
      };
    },
  };
  const manager = new ExecutionManager(root, undefined, { research });
  context.after(async () => { await manager.close(); await rm(root, { force: true, recursive: true }); });
  manager.submitResearch(request("conflict-engine", workspace));
  await until(() => manager.get("conflict-engine", OWNER).state === "unknown");
  const record = manager.get("conflict-engine", OWNER);
  assert.match(record.error ?? "", /conflicts with the one this ledger already recorded/u);
  // Neither association is published: the stored one stays as it was.
  assert.equal(record.research?.engine?.engineRunId, engine().engineRunId);
});

test("an invalid association never enters the ledger", async (context) => {
  const { root, workspace } = await fixture(context);
  const research: ResearchRunExecutor = {
    run: async (submitted, launch) => {
      launch.lifecycle?.observed?.({
        research: { engine: engine({ attempt: 0 }) },
      });
      return { research: status(undefined), result: result(submitted.executionId) };
    },
  };
  const manager = new ExecutionManager(root, undefined, { research });
  context.after(async () => { await manager.close(); await rm(root, { force: true, recursive: true }); });
  manager.submitResearch(request("invalid-engine", workspace));
  await until(() => manager.get("invalid-engine", OWNER).state === "failed" || manager.get("invalid-engine", OWNER).state === "unknown");
  const record = manager.get("invalid-engine", OWNER);
  assert.equal(record.research?.engine, undefined);
});
