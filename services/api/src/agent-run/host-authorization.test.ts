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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";
import { snapshotWorkspace, VersionStore } from "@sciencediscovery/cas";
import { DEFAULT_ENVIRONMENT_REVISION_ID, type RunnerClient } from "@sciencediscovery/executor";
import { createAgentPermissionRuntime } from "@sciencediscovery/governance";
import { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { HostExecutionAuthorization, PermissionDecision, PermissionRequest, ScientificExecutionRequest, ShellExecutionRequest } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { createWorkspaceExecutionBindings } from "./workspace-bindings.js";

const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });

type Request = ScientificExecutionRequest | ShellExecutionRequest;
async function fixture(t: TestContext, sandbox: "none" | "bubblewrap" = "none") {
  const dataDir = await mkdtemp(join(tmpdir(), "host-authorization-"));
  const store = new SessionStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "synthetic-key", baseUrl: "http://127.0.0.1:1/v1", model: "fixture", name: "Fixture" });
  const project = await store.createProject("Host consent");
  // Even always_allow must request explicit host consent; ordinary code checks
  // remain automatic so the test observes the added authorization boundary.
  const session = await store.createSession(project.id, "Host consent", { modelId: model.id }, { approvalMode: "always_allow" });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Compute after explicit host consent", settingsSnapshot: {
    ...store.getSessionSettings(session.id).effective, ideaTreeEnabled: false,
  } });
  await store.updateSessionRunStatus(session.id, run.id, "running");
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(join(workspaceRoot, "nested"), { recursive: true });
  const versions = new VersionStore(join(dataDir, "versioning"));
  const snapshot = await snapshotWorkspace(versions, workspaceRoot);
  const recorder = new ProvenanceRecorder(dataDir, store);
  const requests: PermissionRequest[] = [];
  const payloads: Array<{ kind: string; request: Request }> = [];
  let target = "fixture-host:instance", account = "fixture-user:1000:1000";
  let decision: PermissionDecision = "allow_once";
  let afterConsent: (() => Promise<void> | void) | undefined;
  const permission = createAgentPermissionRuntime(store.getSessionPermissionEpoch(session.id)!, {
    emitRequired: request => requests.push(request),
    readAuthorization: id => store.getPermissionAuthorization(id),
    readEpoch: () => store.getSessionPermissionEpoch(session.id),
    requestPermission: (action, resource, summary, context) => store.requestPermission(session.id, action, resource, summary, context),
    waitForDecision: async request => {
      const result = await store.decidePermissionRequest(request.id, decision);
      await afterConsent?.();
      return result.request;
    },
  });
  const result = (request: Request, language: "python" | "shell") => ({
    cgroupMode: "none" as const, createdFiles: [], modifiedFiles: [], environmentVariables: {},
    environmentRevisionId: language === "python" ? DEFAULT_ENVIRONMENT_REVISION_ID : "system-shell-direct-v1",
    executionId: request.executionId, exitCode: 0, finishedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    kernelId: `ephemeral:${request.executionId}`, kernelMode: "ephemeral" as const, language,
    networkPolicy: request.hostAuthorization ? "host" as const : "none" as const,
    runnerVersion: "fixture", sandbox, stdout: "computed\n", stderr: "", workingDirectory: workspaceRoot,
    workspaceSnapshot: snapshot,
    ...(request.hostAuthorization ? { directAuthorization: request.hostAuthorization } : {}),
  });
  const runner = {
    executionCapability: async () => ({ ready: true, sandbox, sandboxUsable: sandbox !== "none" }),
    directExecutionCapability: async (_signal: AbortSignal | undefined, scope: { cwd: string }) => ({
      available: true, target, account, workspaceRoot,
      cwd: relative(workspaceRoot, await realpath(resolve(workspaceRoot, scope.cwd))),
    }),
    health: async () => ({ sandbox }),
    listEnvironmentRevisions: async () => [], listEnvironments: async () => [],
    execute: async (request: ScientificExecutionRequest) => { payloads.push({ kind: "python", request }); return result(request, "python"); },
    executeShell: async (request: ShellExecutionRequest) => { payloads.push({ kind: "shell", request }); return result(request, "shell"); },
    startShellExecution: async (request: ShellExecutionRequest) => {
      payloads.push({ kind: "managed-shell", request });
      return { id: request.executionId, agentId: "main", sessionId: session.id, state: "completed",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        version: { ...snapshot, workspaceId: store.workspaceIdentity(session.id, "main", "local").id }, result: result(request, "shell") };
    },
  } as unknown as RunnerClient;
  const bindings = createWorkspaceExecutionBindings({ agentId: "main", executionId: run.id, rootRunId: run.id,
    sessionId: session.id, workspaceRoot, permissionScopeLabel: "in the fixture workspace", store,
    permission, runnerClient: runner, provenanceRecorder: recorder, scientificEnvironments: [],
  });
  return { store, session, run, recorder, bindings, requests, payloads, workspaceRoot,
    decide: (value: PermissionDecision) => { decision = value; },
    afterConsent: (callback: () => Promise<void> | void) => { afterConsent = callback; },
    changeTarget: () => { target = "replacement-host:instance"; },
    changeAccount: () => { account = "replacement-user:1001:1001"; },
  };
}

const executionKinds = ["python", "scientific", "shell", "managed-shell"] as const;
type Kind = typeof executionKinds[number];
async function execute(f: Awaited<ReturnType<typeof fixture>>, kind: Kind, code = "print('computed')") {
  if (kind === "python") return f.bindings.executePython!(code);
  if (kind === "scientific") return f.bindings.executeScientific!("python", code, undefined, "ephemeral");
  if (kind === "shell") return f.bindings.executeShell!(code, "ephemeral");
  const started = await f.bindings.shellExecutions!.start(code, {});
  const finished = await f.bindings.shellExecutions!.wait(started.id, 5_000);
  assert.equal(finished.state, "completed", JSON.stringify(finished));
  assert.equal(finished.provenance, "committed", JSON.stringify(finished));
  return finished;
}

for (const kind of executionKinds) {
  test(`${kind}: host consent survives the real permission/provenance chain to the Runner`, async t => {
    const f = await fixture(t);
    const code = kind.includes("shell") ? "echo computed" : "print('computed')";
    await execute(f, kind, code);
    assert.equal(f.payloads.length, 1);
    assert.equal(f.requests.length, 1, "always_allow must still ask for host consent");
    const request = f.payloads[0]!.request;
    const authorization = request.hostAuthorization;
    assert.ok(authorization);
    assert.equal(authorization.language, kind.includes("shell") ? "shell" : "python");
    assert.equal(authorization.codeHash, createHash("sha256").update(code).digest("hex"));
    assert.equal(authorization.target, "fixture-host:instance");
    assert.equal(authorization.account, "fixture-user:1000:1000");
    assert.equal(authorization.workspaceRoot, f.workspaceRoot);
    assert.equal(authorization.cwd, "");
    assert.equal(authorization.runId, f.run.id);
    assert.equal(authorization.agentId, "main");
    const grant = f.store.getPermissionAuthorization(authorization.authorizationId)!;
    assert.equal(grant.action, "direct_code");
    assert.equal(grant.outcome, "allowed");
    assert.equal(grant.resource, f.requests[0]!.resource);
    assert.equal(grant.executionId, f.run.id);
    assert.match(f.requests[0]!.summary, /Network mode is host/);
    assert.ok(f.requests[0]!.summary.includes(code));
    const recorded = await f.store.listExecutionRuns(f.session.id);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.networkPolicy, "host");
    assert.equal(recorded[0]!.directAuthorization?.authorizationId, authorization.authorizationId);
  });
  test(`${kind}: denied host consent prevents dispatch`, async t => {
    const f = await fixture(t); f.decide("deny");
    await assert.rejects(execute(f, kind), /Permission denied/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.payloads.length, 0);
    assert.equal((await f.store.listExecutionRuns(f.session.id)).length, 0);
  });
}

test("a matching host grant cannot authorize the next identical execution", async t => {
  const f = await fixture(t); f.decide("allow_matching");
  await execute(f, "python");
  await execute(f, "python");
  assert.equal(f.payloads.length, 2);
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0]!.resource, f.requests[1]!.resource);
  assert.notEqual(f.payloads[0]!.request.hostAuthorization!.authorizationId, f.payloads[1]!.request.hostAuthorization!.authorizationId);
});

for (const change of ["target", "account", "run-end", "cancel"] as const) {
  test(`host consent rejects ${change} before dispatch`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    f.afterConsent(async () => {
      if (change === "target") f.changeTarget();
      if (change === "account") f.changeAccount();
      if (change === "run-end") await f.store.updateSessionRunStatus(f.session.id, f.run.id, "completed");
      if (change === "cancel") controller.abort();
    });
    await assert.rejects(f.bindings.executePython!("print('computed')", controller.signal), change === "cancel" ? /abort/i : /changed|ended/);
    assert.equal(f.payloads.length, 0);
  });
}

test("sandboxed Runner executions do not request host authorization", async t => {
  const f = await fixture(t, "bubblewrap");
  await execute(f, "python");
  assert.equal(f.requests.length, 0);
  assert.equal(f.payloads[0]!.request.hostAuthorization, undefined);
});

test("named environment and cwd are pinned in the approved shell/scientific scope", async t => {
  const f = await fixture(t);
  const seen: Array<{ hostAuthorization?: HostExecutionAuthorization; environmentId?: string; environmentRevisionId?: string; cwd?: string }> = [];
  t.mock.method(f.recorder, "executeShell", async (input: Parameters<ProvenanceRecorder["executeShell"]>[0]) => { seen.push(input); return {} as never; });
  t.mock.method(f.recorder, "executeScientific", async (input: Parameters<ProvenanceRecorder["executeScientific"]>[0]) => { seen.push(input); return {} as never; });
  await f.bindings.executeShell!("echo selected", "ephemeral", undefined, undefined, undefined, { cwd: "nested", environmentId: "named-environment" });
  await f.bindings.executeScientific!("python", "print('selected')", "pinned-revision", "ephemeral");
  assert.equal(seen[0]!.hostAuthorization?.cwd, "nested");
  assert.equal(seen[0]!.hostAuthorization?.environment, "named-environment");
  assert.equal(seen[0]!.environmentId, "named-environment");
  assert.equal(seen[1]!.hostAuthorization?.environment, "pinned-revision");
  assert.equal(seen[1]!.environmentRevisionId, "pinned-revision");
  assert.match(f.requests[0]!.summary, /named-environment/);
  assert.match(f.requests[1]!.summary, /pinned-revision/);
});
