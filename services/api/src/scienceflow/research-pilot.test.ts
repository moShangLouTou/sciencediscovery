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
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelProfile,
  ResolvedProxy,
  ResolvedRuntimeSettings,
  RuntimeSettingsSource,
} from "@sciencediscovery/schema";
import {
  SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
  type ScienceFlowRunSnapshot,
} from "@sciencediscovery/scienceflow-reader";

import { SessionStore } from "../store.js";
import {
  RESEARCH_PILOT_LAUNCHER_PROGRAM,
  ResearchPilotRefusal,
  attachResearchPilotRun,
  materializeResearchPilotModelInputs,
  parseCsv,
  parseLauncherOutput,
  readStageRows,
  readUsage,
  researchPilotPlan,
  resolveResearchPilotModel,
  runResearchPilot,
  summarizeResult,
  type ResearchPilotOptions,
  type ResearchPilotResolvedModel,
  type ResearchPilotSessionStore,
} from "./research-pilot.js";

// Synthetic credentials are generated per test run; no literal stands in for a
// real or realistic secret.
const MODEL_TOKEN = `sk-pilot-${randomUUID()}`;
const OTHER_TOKEN = `sk-other-${randomUUID()}`;

interface FakeModelInput {
  readonly id: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiProtocol?: ModelProfile["apiProtocol"];
  readonly apiVariant?: ModelProfile["apiVariant"];
  readonly thinkingMode?: ModelProfile["thinkingMode"];
  readonly token?: string;
}

function modelProfile(input: FakeModelInput): ModelProfile {
  return {
    apiProtocol: input.apiProtocol ?? "openai-chat-completions",
    apiVariant: input.apiVariant ?? "qwen",
    baseUrl: input.baseUrl ?? "https://gateway.example.com/v1",
    createdAt: "2026-11-15T00:00:00Z",
    hasApiToken: true,
    id: input.id,
    model: input.model ?? "Qwen3.8-Flash",
    name: input.model ?? input.id,
    proxyPolicy: "inherit",
    updatedAt: "2026-11-15T00:00:00Z",
    vision: false,
    ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
  };
}

interface FakeStoreOptions {
  readonly models: readonly [ModelProfile, string][];
  readonly globalModel?: string;
  readonly projectModel?: string;
  readonly sessionModel?: string;
  readonly proxy?: ResolvedProxy;
  readonly projects?: readonly string[];
}

/**
 * A read-only double for the two settings layers this module reads. Credentials
 * are keyed by model id, the way `getModelApiToken` reports a profile's own
 * token or its provider's shared one.
 */
function fakeStore(options: FakeStoreOptions): ResearchPilotSessionStore {
  const models = new Map(options.models.map(([profile, token]) => [profile.id, { profile, token }]));
  const projects = new Set(options.projects ?? ["project-1"]);
  const sources: RuntimeSettingsSource = options.sessionModel
    ? "session"
    : options.projectModel
      ? "project"
      : options.globalModel
        ? "global"
        : "unset";
  const effective =
    options.sessionModel ?? options.projectModel ?? options.globalModel ?? undefined;
  const settings: ResolvedRuntimeSettings = {
    effective: { ...(effective ? { modelId: effective } : {}) } as ResolvedRuntimeSettings["effective"],
    sources: { modelId: sources } as ResolvedRuntimeSettings["sources"],
  };
  return {
    resolveRuntimeSettings: () => settings,
    getModel: (modelId) => (modelId ? models.get(modelId)?.profile : undefined),
    getModelApiToken: (modelId) => (modelId ? models.get(modelId)?.token : undefined),
    resolveProxy: () => options.proxy ?? { mode: "direct" },
    getProject: (projectId) => (projects.has(projectId) ? { id: projectId } : undefined),
    getSession: (sessionId) => (sessionId === "session-1" ? { projectId: "project-1" } : undefined),
    assertSessionWritable: () => undefined,
  };
}

function planFor(workDir: string, overrides: Partial<ResearchPilotOptions> = {}) {
  return researchPilotPlan({
    runId: "round20-test-run",
    workDir,
    privateRoot: join(workDir, "..", "private"),
    engineCheckout: "/opt/engine",
    pythonExecutable: "/opt/python/bin/python",
    readerScriptPath: "/opt/reader/snapshot.py",
    seedDir: join(workDir, "..", "seed"),
    ...overrides,
  });
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("resolution follows the Session override and freezes the selection", async () => {
  const store = fakeStore({
    models: [
      [modelProfile({ id: "global-model", model: "Global-Model", token: OTHER_TOKEN }), OTHER_TOKEN],
      [modelProfile({ id: "project-model", model: "Project-Model", token: OTHER_TOKEN }), OTHER_TOKEN],
      [modelProfile({ id: "session-model", model: "Qwen3.8-Flash", token: MODEL_TOKEN }), MODEL_TOKEN],
    ],
    globalModel: "global-model",
    projectModel: "project-model",
    sessionModel: "session-model",
  });
  const resolved = resolveResearchPilotModel(store, {
    projectId: "project-1",
    sessionId: "session-1",
  });
  assert.equal(resolved.selection.profileId, "session-model");
  assert.equal(resolved.selection.selectionSource, "session");
  assert.equal(resolved.selection.providerModel, "Qwen3.8-Flash");
  assert.equal(resolved.selection.providerHost, "gateway.example.com");
  assert.equal(resolved.apiToken, MODEL_TOKEN);
  assert.ok(
    !JSON.stringify(resolved.selection).includes(MODEL_TOKEN),
    "the public selection must not carry the credential",
  );
});

test("resolution inherits the Project layer when the Session has no override", () => {
  const store = fakeStore({
    models: [[modelProfile({ id: "project-model", token: MODEL_TOKEN }), MODEL_TOKEN]],
    globalModel: "global-model",
    projectModel: "project-model",
  });
  const resolved = resolveResearchPilotModel(store, {
    projectId: "project-1",
    sessionId: "session-1",
  });
  assert.equal(resolved.selection.profileId, "project-model");
  assert.equal(resolved.selection.selectionSource, "project");
});

test("resolution reuses the store's provider-shared credential fallback", () => {
  // `getModelApiToken` is the only credential accessor this module uses; a
  // profile with no token of its own resolves through its provider's token.
  const profile = { ...modelProfile({ id: "provider-model" }), providerId: "provider-1" };
  const store = fakeStore({ models: [[profile, MODEL_TOKEN]], sessionModel: "provider-model" });
  const resolved = resolveResearchPilotModel(store, {
    projectId: "project-1",
    sessionId: "session-1",
  });
  assert.equal(resolved.apiToken, MODEL_TOKEN);
});

test("resolution resolves an environment proxy policy for the endpoint", () => {
  const profile = modelProfile({ id: "model-1", token: MODEL_TOKEN });
  const environmentStore = fakeStore({
    models: [[profile, MODEL_TOKEN]],
    sessionModel: "model-1",
    proxy: { mode: "environment" },
  });
  const keys = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const direct = resolveResearchPilotModel(environmentStore, {
      projectId: "project-1",
      sessionId: "session-1",
    });
    assert.equal(direct.selection.proxyMode, "direct", "no proxy variable at all means a direct route");
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const proxied = resolveResearchPilotModel(environmentStore, {
      projectId: "project-1",
      sessionId: "session-1",
    });
    assert.equal(proxied.selection.proxyMode, "url");
    assert.equal(proxied.proxyUrl, "http://proxy.example.com:3128");
    assert.ok(!JSON.stringify(proxied.selection).includes("proxy.example.com"));
  } finally {
    for (const key of keys) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  const explicit = fakeStore({
    models: [[profile, MODEL_TOKEN]],
    sessionModel: "model-1",
    proxy: { mode: "url", url: "http://proxy.example.com:3128" },
  });
  const resolved = resolveResearchPilotModel(explicit, {
    projectId: "project-1",
    sessionId: "session-1",
  });
  assert.equal(resolved.selection.proxyMode, "url");
  assert.equal(resolved.proxyUrl, "http://proxy.example.com:3128");
});

test("resolution refuses what it cannot resolve", () => {
  const missingProfile = fakeStore({
    models: [],
    sessionModel: "gone",
  });
  assert.throws(
    () => resolveResearchPilotModel(missingProfile, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "model-unavailable",
  );
  const noModel = fakeStore({ models: [] });
  assert.throws(
    () => resolveResearchPilotModel(noModel, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "no-effective-model",
  );
  const noCredential = fakeStore({
    models: [[modelProfile({ id: "model-1" }), ""]],
    sessionModel: "model-1",
  });
  assert.throws(
    () => resolveResearchPilotModel(noCredential, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "credential-unavailable",
  );
  assert.throws(
    () => resolveResearchPilotModel(noCredential, { projectId: "project-1", sessionId: "elsewhere" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "session-not-found",
  );
  assert.throws(
    () => resolveResearchPilotModel(noCredential, { projectId: "other-project", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "project-not-found",
  );
});

test("resolution refuses profiles the pilot cannot carry", () => {
  const anthropic = fakeStore({
    models: [
      [
        modelProfile({
          id: "claude",
          apiProtocol: "anthropic-messages",
          apiVariant: "anthropic-adaptive",
          token: MODEL_TOKEN,
        }),
        MODEL_TOKEN,
      ],
    ],
    sessionModel: "claude",
  });
  assert.throws(
    () => resolveResearchPilotModel(anthropic, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "unsupported-protocol",
  );
  const deepseek = fakeStore({
    models: [[modelProfile({ id: "deepseek", apiVariant: "deepseek", token: MODEL_TOKEN }), MODEL_TOKEN]],
    sessionModel: "deepseek",
  });
  assert.throws(
    () => resolveResearchPilotModel(deepseek, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "unsupported-variant",
  );
  const thinking = fakeStore({
    models: [
      [modelProfile({ id: "qwen", thinkingMode: "enabled", token: MODEL_TOKEN }), MODEL_TOKEN],
    ],
    sessionModel: "qwen",
  });
  assert.throws(
    () => resolveResearchPilotModel(thinking, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "unsupported-thinking",
  );
  const noEndpoint = fakeStore({
    models: [[modelProfile({ id: "qwen", baseUrl: "", token: MODEL_TOKEN }), MODEL_TOKEN]],
    sessionModel: "qwen",
  });
  assert.throws(
    () => resolveResearchPilotModel(noEndpoint, { projectId: "project-1", sessionId: "session-1" }),
    (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "unsupported-proxy",
  );
});

test("the plan refuses a private root that could reach the research inputs", async () => {
  await withTempDir("pilot-plan-", async (base) => {
    assert.throws(
      () => planFor(base, { privateRoot: join(base, "private") }),
      (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "invalid-option",
    );
    assert.throws(
      () => planFor(base, { runId: "../escape" }),
      (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "invalid-option",
    );
    assert.throws(
      () => planFor(base, { researchBudgetSec: 800, reportBudgetSec: 60, totalAllowanceSec: 600 }),
      (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "invalid-option",
    );
    assert.throws(
      () => planFor(base, { workDir: "relative/dir" }),
      (error: unknown) => error instanceof ResearchPilotRefusal && error.reason === "invalid-option",
    );
  });
});

test("generated model inputs stay private and outside everything else", async () => {
  await withTempDir("pilot-private-", async (base) => {
    const workDir = join(base, "work");
    const { grant, paths } = planFor(workDir, {
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
    });
    const resolved: ResearchPilotResolvedModel = {
      selection: {
        projectId: "project-1",
        sessionId: "session-1",
        selectionSource: "session",
        profileId: "model-1",
        profileName: "Qwen",
        providerModel: "Qwen3.8-Flash",
        providerHost: "gateway.example.com",
        apiProtocol: "openai-chat-completions",
        apiVariant: "qwen",
        proxyMode: "direct",
      },
      apiToken: MODEL_TOKEN,
      endpointUrl: "https://gateway.example.com/v1",
    };
    const inputs = await materializeResearchPilotModelInputs({
      resolved,
      grant,
      paths,
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
    });
    assert.equal(inputs.alias, "sd-qwen3-8-flash");
    assert.equal(inputs.useProxy, false);
    assert.equal((await stat(paths.privateRoot)).mode & 0o777, 0o700);
    const registry = JSON.parse(await readFile(paths.modelConfigPath, "utf8")) as {
      models: Record<string, { model: string; endpoints: { url: string; key: string }[]; use_proxy: boolean }>;
      defaults: { code_models: string[]; feedback_models: string[]; selection: string };
    };
    assert.equal(registry.models["sd-qwen3-8-flash"]?.model, "Qwen3.8-Flash");
    assert.deepEqual(registry.models["sd-qwen3-8-flash"]?.endpoints, [
      { url: "https://gateway.example.com/v1", key: MODEL_TOKEN },
    ]);
    assert.deepEqual(registry.defaults.code_models, ["sd-qwen3-8-flash"]);
    assert.equal((await stat(paths.modelConfigPath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.settingsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.engineConfigPath)).mode & 0o777, 0o600);
    const settings = JSON.parse(await readFile(paths.settingsPath, "utf8")) as {
      agent: { code: { model_config_path: string; max_tokens: number; use_proxy: boolean }; feedback: { max_tokens: number } };
      lnr: { num_workers: number; wall_clock_budget_sec: number; max_steps: number };
    };
    assert.equal(settings.agent.code.model_config_path, paths.modelConfigPath);
    assert.equal(settings.agent.code.max_tokens, 8_192);
    assert.equal(settings.agent.feedback.max_tokens, 4_096);
    assert.equal(settings.agent.code.use_proxy, false);
    assert.deepEqual(settings.lnr, { num_workers: 1, wall_clock_budget_sec: 840, max_steps: 24 });
    const engineConfig = await readFile(paths.engineConfigPath, "utf8");
    assert.match(engineConfig, /foundation\/config\/default\.yaml/u);
    assert.ok(!engineConfig.includes(MODEL_TOKEN));
  });
});

test("a refused profile never reaches the engine", async () => {
  await withTempDir("pilot-refused-", async (base) => {
    const store = fakeStore({
      models: [[modelProfile({ id: "deepseek", apiVariant: "deepseek", token: MODEL_TOKEN }), MODEL_TOKEN]],
      sessionModel: "deepseek",
    });
    let launches = 0;
    const receipt = await runResearchPilot(
      { ...store, scienceFlowRegistrations: neverUsedRegistrationStore() },
      {
        projectId: "project-1",
        sessionId: "session-1",
        runId: "round20-test-run",
        workDir: join(base, "work"),
        privateRoot: join(base, "private"),
        seedDir: join(base, "seed"),
        engineCheckout: "/opt/engine",
        pythonExecutable: "/opt/python/bin/python",
        readerScriptPath: "/opt/reader/snapshot.py",
      },
      {
        launch: async () => {
          launches += 1;
          return { outcome: "finished" };
        },
      },
    );
    assert.equal(launches, 0);
    assert.equal(receipt.outcome.status, "configuration-refused");
    assert.equal(receipt.outcome.reason, "unsupported-variant");
    assert.equal(receipt.outcome.engineRunId, null);
    assert.equal(receipt.model, null);
    await assert.rejects(readFile(join(base, "private", "models.json"), "utf8"));
    const written = JSON.parse(
      await readFile(join(base, "work", "receipt.json"), "utf8"),
    ) as { outcome: { status: string } };
    assert.equal(written.outcome.status, "configuration-refused");
  });
});

test("a launch failure is reported at launch and registers nothing", async () => {
  await withTempDir("pilot-launchfail-", async (base) => {
    const store = fakeStore({
      models: [[modelProfile({ id: "model-1", token: MODEL_TOKEN }), MODEL_TOKEN]],
      sessionModel: "model-1",
    });
    const receipt = await runResearchPilot(
      { ...store, scienceFlowRegistrations: neverUsedRegistrationStore() },
      {
        projectId: "project-1",
        sessionId: "session-1",
        runId: "round20-test-run",
        workDir: join(base, "work"),
        privateRoot: join(base, "private"),
        seedDir: join(base, "seed"),
        engineCheckout: "/opt/engine",
        pythonExecutable: "/opt/python/bin/python",
        readerScriptPath: "/opt/reader/snapshot.py",
      },
      {
        launch: async () => ({
          outcome: "launch-failed",
          error: { type: "ValueError", message: "Manifest contains no tasks." },
        }),
      },
    );
    assert.equal(receipt.outcome.status, "launch-failed");
    assert.equal(receipt.outcome.failedStep, "launch");
    assert.equal(receipt.outcome.engineRunId, null);
    assert.equal(receipt.registration, null);
    assert.equal(receipt.snapshot, null);
  });
});

test("a completed run registers and reads back through the real store", async () => {
  await withTempDir("pilot-live-", async (base) => {
    const { store, projectId, sessionId, modelId } = await provisionStore(base);
    const options: ResearchPilotOptions & { projectId: string; sessionId: string } = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
      refusePackageInstall: true,
    };
    const { paths } = researchPilotPlan(options);
    await writeFakeStageLedger(paths.stageCsvPath);
    await writeFakeProviderCalls(paths.providerCallsPath);
    let launcherSaw: { manifestPath: string; runId: string; noInstallPathPrefix?: string } | undefined;
    const receipt = await runResearchPilot(store, options, {
      launch: async (input) => {
        launcherSaw = input;
        const manifest = await readFile(input.manifestPath, "utf8");
        assert.match(manifest, /run_id: "round20-test-run"/u);
        assert.match(manifest, /input_data_dir: /u);
        assert.match(manifest, /wall_clock_budget_sec: 840/u);
        assert.match(manifest, /stage_capture_max_count: 3/u);
        assert.match(manifest, /merge_enabled: false/u);
        return { outcome: "finished", status: "completed", phase: "finished", elapsedSec: 12.5 };
      },
      readSnapshot: async () => ({ status: "ok", snapshot: fakeSnapshot("round20-test-run") }),
    });
    assert.equal(receipt.outcome.status, "completed");
    assert.equal(receipt.outcome.engineRunId, "round20-test-run");
    assert.equal(receipt.model?.profileId, modelId);
    assert.equal(receipt.model?.selectionSource, "session");
    assert.equal(receipt.registration?.status, "created");
    assert.equal(receipt.snapshot?.run.runId, "round20-test-run");
    assert.equal(receipt.snapshot?.run.status, "completed");
    assert.equal(receipt.result?.selectedStageId, "S02");
    assert.equal(receipt.result?.selectedArtifactSha256, "b".repeat(64));
    assert.equal(receipt.result?.digestVerified, true);
    assert.equal(receipt.result?.stages.length, 2);
    assert.match(receipt.result?.conclusion ?? "", /seed S01 2\.6166/u);
    assert.equal(receipt.usage?.calls, 2);
    assert.equal(receipt.usage?.inputTokens, 300);
    assert.equal(launcherSaw?.runId, "round20-test-run");
    assert.ok(launcherSaw?.noInstallPathPrefix, "the install refusal must be part of the run");
    // The credential is in exactly one file: the private registry.
    const receiptText = await readFile(paths.receiptPath, "utf8");
    const manifestText = await readFile(paths.manifestPath, "utf8");
    const settingsText = await readFile(paths.settingsPath, "utf8");
    const engineConfigText = await readFile(paths.engineConfigPath, "utf8");
    for (const text of [receiptText, manifestText, settingsText, engineConfigText]) {
      assert.ok(!text.includes(MODEL_TOKEN), "no credential may appear outside the private registry");
    }
    assert.ok((await readFile(paths.modelConfigPath, "utf8")).includes(MODEL_TOKEN));
    // The registration is a real row in the store's own registration table.
    const listed = await store.scienceFlowRegistrations.list(projectId, sessionId, 10, 0);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.runId, "round20-test-run");
    assert.equal(receipt.registration?.registration.registrationId, listed[0]?.registrationId);
    assert.equal((await stat(paths.receiptPath)).mode & 0o777, 0o600, "the receipt is private evidence");
  });
});

test("a readback failure keeps the engine run id for attachment", async () => {
  await withTempDir("pilot-readbackfail-", async (base) => {
    const { store, projectId, sessionId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    const receipt = await runResearchPilot(store, options, {
      launch: async () => ({ outcome: "finished", status: "completed" }),
      readSnapshot: async () => ({
        status: "reader-failed",
        exitCode: 3,
        signal: null,
        snapshot: { ...fakeSnapshot("round20-test-run"), rawStatus: null },
      }),
    });
    assert.equal(receipt.outcome.status, "readback-failed");
    assert.equal(receipt.outcome.failedStep, "readback");
    assert.equal(receipt.outcome.engineRunId, "round20-test-run");
    assert.equal(receipt.registration?.status, "created");
    assert.equal(receipt.snapshot, null);
    assert.equal(receipt.result, null);
    const written = JSON.parse(await readFile(paths.receiptPath, "utf8")) as {
      outcome: { engineRunId: string | null };
      launch: { status?: string };
    };
    assert.equal(written.outcome.engineRunId, "round20-test-run");
    assert.equal(written.launch.status, "completed");
  });
});

test("attach re-reads an existing run and keeps its frozen model selection", async () => {
  await withTempDir("pilot-attach-", async (base) => {
    const { store, projectId, sessionId, modelId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    await writeFakeStageLedger(paths.stageCsvPath);
    await runResearchPilot(store, options, {
      launch: async () => ({ outcome: "finished", status: "completed" }),
      readSnapshot: async () => ({ status: "protocol-error", reason: "invalid-shape", exitCode: null }),
    });
    // A later selection change must not relabel the run being attached.
    const other = await store.createModel({
      apiToken: OTHER_TOKEN,
      apiProtocol: "openai-chat-completions",
      apiVariant: "qwen",
      baseUrl: "https://other.example.com/v1",
      model: "Other-Model",
      name: "Other",
    });
    await store.updateSession(sessionId, { modelId: other.id });
    assert.notEqual(other.id, modelId);
    // The engine record now exists because the launch succeeded.
    const recordDir = join(paths.stateHome, "scienceflow", "managed_runs", "round20-test-run");
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "control.json"), JSON.stringify({ run_id: "round20-test-run" }), "utf8");
    const attached = await attachResearchPilotRun(store, options, {
      launch: async () => {
        throw new Error("attach must never launch");
      },
      readSnapshot: async () => ({ status: "ok", snapshot: fakeSnapshot("round20-test-run") }),
    });
    assert.equal(attached.outcome.status, "completed");
    assert.equal(attached.model?.profileId, modelId);
    assert.equal(attached.model?.selectionSource, "session");
    assert.equal(attached.snapshot?.run.runId, "round20-test-run");
  });
});

test("a second launch for an engine-owned run id is refused before any work", async () => {
  await withTempDir("pilot-duplicate-", async (base) => {
    const store = fakeStore({
      models: [[modelProfile({ id: "model-1", token: MODEL_TOKEN }), MODEL_TOKEN]],
      sessionModel: "model-1",
    });
    const options = {
      projectId: "project-1",
      sessionId: "session-1",
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    const recordDir = join(paths.stateHome, "scienceflow", "managed_runs", "round20-test-run");
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "control.json"), JSON.stringify({ run_id: "round20-test-run" }), "utf8");
    let launches = 0;
    const receipt = await runResearchPilot(
      { ...store, scienceFlowRegistrations: neverUsedRegistrationStore() },
      options,
      {
        launch: async () => {
          launches += 1;
          return { outcome: "finished" };
        },
      },
    );
    assert.equal(launches, 0);
    assert.equal(receipt.outcome.status, "run-already-exists");
    assert.equal(receipt.outcome.engineRunId, "round20-test-run");
    assert.match(receipt.outcome.message ?? "", /attach/u);
    // The refusal is returned only: no receipt exists to fabricate a model from.
    await assert.rejects(readFile(paths.receiptPath, "utf8"));
  });
});

test("a duplicate launch keeps the run's frozen receipt for attach", async () => {
  await withTempDir("pilot-duplicate-receipt-", async (base) => {
    const { store, projectId, sessionId, modelId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    await runResearchPilot(store, options, {
      launch: async () => ({ outcome: "finished", status: "completed" }),
      readSnapshot: async () => ({ status: "ok", snapshot: fakeSnapshot("round20-test-run") }),
    });
    const frozen = await readFile(paths.receiptPath, "utf8");
    const recordDir = join(paths.stateHome, "scienceflow", "managed_runs", "round20-test-run");
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "control.json"), JSON.stringify({ run_id: "round20-test-run" }), "utf8");

    let launches = 0;
    const refused = await runResearchPilot(store, options, {
      launch: async () => {
        launches += 1;
        return { outcome: "finished" };
      },
    });
    assert.equal(launches, 0);
    assert.equal(refused.outcome.status, "run-already-exists");
    assert.equal(
      await readFile(paths.receiptPath, "utf8"),
      frozen,
      "the duplicate refusal must not rewrite the original receipt",
    );

    const attached = await attachResearchPilotRun(store, options, {
      launch: async () => {
        launches += 1;
        return { outcome: "finished" };
      },
      readSnapshot: async () => ({ status: "ok", snapshot: fakeSnapshot("round20-test-run") }),
    });
    assert.equal(launches, 0);
    assert.equal(attached.outcome.status, "completed");
    assert.equal(attached.model?.profileId, modelId);
    assert.equal(attached.model?.selectionSource, "session");
    assert.equal(attached.registration?.status, "existing");
  });
});

test("a Session that becomes read-only after launch keeps a receipt attach can finish", async () => {
  await withTempDir("pilot-register-fail-", async (base) => {
    const { store, projectId, sessionId, modelId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    let launched = false;
    const gated = storeWithWriteGate(store, () => !launched);
    const failed = await runResearchPilot(gated, options, {
      launch: async () => {
        launched = true;
        return { outcome: "finished", status: "completed" };
      },
    });
    assert.equal(launched, true);
    assert.equal(failed.outcome.status, "registration-failed");
    assert.equal(failed.outcome.failedStep, "register");
    assert.equal(failed.outcome.engineRunId, "round20-test-run");
    assert.equal(failed.model?.profileId, modelId);
    assert.match(failed.outcome.message ?? "", /archived/u);

    // The launch-time facts survive the registration failure on disk.
    const written = JSON.parse(await readFile(paths.receiptPath, "utf8")) as {
      outcome: { status: string; engineRunId: string | null };
      model: { profileId: string; selectionSource: string } | null;
      engine: { generatedInputs: { modelConfigPath: string } | null };
    };
    assert.equal(written.outcome.status, "registration-failed");
    assert.equal(written.outcome.engineRunId, "round20-test-run");
    assert.equal(written.model?.profileId, modelId);
    assert.equal(written.model?.selectionSource, "session");
    assert.equal(written.engine.generatedInputs?.modelConfigPath, paths.modelConfigPath);

    // The engine record the real launch would have created.
    const recordDir = join(paths.stateHome, "scienceflow", "managed_runs", "round20-test-run");
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "control.json"), JSON.stringify({ run_id: "round20-test-run" }), "utf8");

    // Once writable again, attach finishes registration and readback without
    // launching another run.
    let attachLaunches = 0;
    const attached = await attachResearchPilotRun(store, options, {
      launch: async () => {
        attachLaunches += 1;
        return { outcome: "finished" };
      },
      readSnapshot: async () => ({ status: "ok", snapshot: fakeSnapshot("round20-test-run") }),
    });
    assert.equal(attachLaunches, 0);
    assert.equal(attached.outcome.status, "completed");
    assert.equal(attached.model?.profileId, modelId);
    assert.equal(attached.registration?.status, "created");
  });
});

test("a launcher exception leaves a frozen launch-unknown receipt", async () => {
  await withTempDir("pilot-launch-unknown-", async (base) => {
    const { store, projectId, sessionId, modelId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    const receipt = await runResearchPilot(store, options, {
      launch: async () => {
        throw new Error("launcher died");
      },
    });
    assert.equal(receipt.outcome.status, "launch-unknown");
    assert.equal(receipt.outcome.failedStep, "launch");
    assert.equal(receipt.outcome.engineRunId, "round20-test-run");
    assert.equal(receipt.model?.profileId, modelId);
    assert.match(receipt.outcome.message ?? "", /launcher died/u);
    const written = JSON.parse(await readFile(paths.receiptPath, "utf8")) as {
      outcome: { status: string; engineRunId: string | null };
      model: { profileId: string } | null;
    };
    assert.equal(written.outcome.status, "launch-unknown");
    assert.equal(written.outcome.engineRunId, "round20-test-run");
    assert.equal(written.model?.profileId, modelId);
  });
});

test("a read-only Session is refused before a credential file or launch", async () => {
  await withTempDir("pilot-prelaunch-locked-", async (base) => {
    const { store, projectId, sessionId } = await provisionStore(base);
    const options = {
      projectId,
      sessionId,
      runId: "round20-test-run",
      workDir: join(base, "work"),
      privateRoot: join(base, "private"),
      seedDir: join(base, "seed"),
      engineCheckout: "/opt/engine",
      pythonExecutable: "/opt/python/bin/python",
      readerScriptPath: "/opt/reader/snapshot.py",
    };
    const { paths } = researchPilotPlan(options);
    let launches = 0;
    const receipt = await runResearchPilot(storeWithWriteGate(store, () => false), options, {
      launch: async () => {
        launches += 1;
        return { outcome: "finished" };
      },
    });
    assert.equal(launches, 0);
    assert.equal(receipt.outcome.status, "configuration-refused");
    assert.equal(receipt.outcome.reason, "session-not-writable");
    assert.equal(receipt.outcome.engineRunId, null);
    assert.equal(receipt.model, null);
    await assert.rejects(readFile(paths.modelConfigPath, "utf8"));
    const written = JSON.parse(await readFile(paths.receiptPath, "utf8")) as {
      outcome: { reason: string };
    };
    assert.equal(written.outcome.reason, "session-not-writable");
  });
});

test("the launcher protocol is parsed strictly", () => {
  const finished = parseLauncherOutput(
    `${JSON.stringify({
      protocol: 1,
      outcome: "finished",
      status: "completed",
      phase: "finished",
      elapsedSec: 846,
      supervisorPid: 42,
      supervisorAliveAfterFinish: false,
      record: { run_id: "r" },
    })}\n`,
    "",
    false,
  );
  assert.equal(finished.outcome, "finished");
  assert.equal(finished.status, "completed");
  assert.equal(finished.supervisorAliveAfterFinish, false);
  assert.deepEqual(finished.record, { run_id: "r" });
  const garbage = parseLauncherOutput("not json\n", "Traceback: boom\n", false);
  assert.equal(garbage.outcome, "observation-failed", "a silent launcher may have started the run");
  assert.equal(garbage.error?.type, "LauncherProtocolError");
  const spawnFailure = parseLauncherOutput("", "", false, "spawn python ENOENT");
  assert.equal(spawnFailure.outcome, "launch-failed", "a spawn error confirms the run did not start");
  assert.equal(spawnFailure.error?.type, "LauncherSpawnFailed");
  const timedOut = parseLauncherOutput("", "", true);
  assert.equal(timedOut.outcome, "observation-timeout");
  assert.match(RESEARCH_PILOT_LAUNCHER_PROGRAM, /start_run/u);
  assert.match(RESEARCH_PILOT_LAUNCHER_PROGRAM, /stop_run/u);
});

test("stage rows, provider usage and the comparison are read from the engine files", async () => {
  await withTempDir("pilot-readers-", async (base) => {
    const csvPath = join(base, "lhr_stage_performance.csv");
    await writeFakeStageLedger(csvPath);
    const stages = await readStageRows(csvPath);
    assert.equal(stages.length, 2);
    assert.deepEqual(
      stages.map((stage) => [stage.stageId, stage.parentStageId, stage.metricValue]),
      [
        ["S01", null, 2.61661905326],
        ["S02", "S01", 2.621352304043],
      ],
    );
    const usage = await readUsage(
      await (async () => {
        const path = join(base, "calls.jsonl");
        await writeFakeProviderCalls(path);
        return path;
      })(),
    );
    assert.deepEqual(usage, {
      calls: 2,
      completedCalls: 1,
      failedCalls: 1,
      unknownUsageCalls: 1,
      inputTokens: 300,
      outputTokens: 30,
      models: ["Qwen3.8-Flash"],
    });
    const dto = {
      schemaVersion: 1 as const,
      run: { runId: "r", status: "completed" as const, phase: "finished" as const },
      tasks: [
        {
          taskIndex: 0,
          reportedMetric: { metricName: "radii_sum", metricValue: 2.621352304043, lowerIsBetter: false, source: "lhr_stage_performance" as const },
          candidate: { sha256: "b".repeat(64), digestVerified: true, metric: { metricName: "radii_sum", metricValue: 2.621352304043, lowerIsBetter: false }, stageId: "S02" },
        },
      ],
      diagnostics: [],
    };
    const result = summarizeResult(stages, dto);
    assert.equal(result?.selectedStageId, "S02");
    assert.match(result?.conclusion ?? "", /\+0\.0047/u);
    // An uncaptured evaluated candidate is never presented as the selected
    // stage, and an engine-reported metric without a binding is not a selection.
    const uncaptured = summarizeResult(stages, {
      ...dto,
      tasks: [
        {
          taskIndex: 0,
          reportedMetric: {
            metricName: "radii_sum",
            metricValue: 2.63,
            lowerIsBetter: false,
            source: "lhr_stage_performance",
          },
          candidate: null,
        },
      ],
    });
    assert.equal(uncaptured?.selectedStageId, null);
    assert.equal(uncaptured?.selectedMetric, null);
    assert.match(uncaptured?.conclusion ?? "", /binds no candidate/u);
    assert.deepEqual(parseCsv('a,b\n"x, y",z\n'), [
      ["a", "b"],
      ["x, y", "z"],
    ]);
  });
});

async function provisionStore(base: string): Promise<{
  store: SessionStore;
  projectId: string;
  sessionId: string;
  modelId: string;
}> {
  const store = new SessionStore(join(base, "store"));
  await store.load();
  const project = await store.createProject("Pilot");
  const session = await store.createSession(project.id, "Pilot session", {}, {}, {
    allowUnconfiguredModel: true,
  });
  // Provision once through the normal configuration transaction, exactly as the
  // product's model-connect path does: a provider holds the credential and the
  // profile owns none, so `getModelApiToken` must apply the provider fallback.
  const connected = await store.runConfigurationTransaction(session.id, () =>
    store.applyConfigurationDomainSync(
      session.id,
      "model.connect",
      {
        name: "Pilot gateway",
        baseUrl: "https://gateway.example.com/v1",
        apiProtocol: "openai-chat-completions",
        apiVariant: "qwen",
        model: "Qwen3.8-Flash",
      },
      MODEL_TOKEN,
    ),
  );
  const modelId = connected.modelId!;
  await store.updateSession(session.id, { modelId });
  return { store, projectId: project.id, sessionId: session.id, modelId };
}

function neverUsedRegistrationStore() {
  return {
    create: () => {
      throw new Error("registration must not be attempted");
    },
    get: () => undefined,
    list: () => [],
  } as unknown as Parameters<typeof runResearchPilot>[0]["scienceFlowRegistrations"];
}

/** The real store with its established write gate made conditional on `writable`. */
function storeWithWriteGate(store: SessionStore, writable: () => boolean): SessionStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "assertSessionWritable") {
        return (sessionId: string) => {
          if (!writable()) throw new Error("Session is archived and read-only");
          return target.assertSessionWritable(sessionId);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

async function writeFakeStageLedger(csvPath: string): Promise<void> {
  await mkdir(join(csvPath, ".."), { recursive: true });
  const header = [
    "row_order",
    "candidate_id",
    "stage_id",
    "parent_stage_id",
    "metric_value",
    "metric_name",
    "validation_ok",
    "selection_eligible",
    "artifact_path",
    "artifact_sha",
    "evaluator_status",
    "gate_accepted",
    "created_at_utc",
  ].join(",");
  const rows = [
    [
      1,
      "W00:L01:S01",
      "S01",
      "",
      "2.61661905326",
      "radii_sum",
      1,
      1,
      "artifacts/best_solution.json",
      "a".repeat(64),
      "ok",
      1,
      "2026-11-15T03:38:10Z",
    ].join(","),
    [
      2,
      "W00:L01:S02",
      "S02",
      "S01",
      "2.621352304043",
      "radii_sum",
      1,
      1,
      "artifacts/best_solution.json",
      "b".repeat(64),
      "ok",
      1,
      "2026-11-15T03:42:50Z",
    ].join(","),
  ];
  await writeFile(csvPath, `${header}\n${rows.join("\n")}\n`, "utf8");
}

async function writeFakeProviderCalls(jsonlPath: string): Promise<void> {
  await mkdir(join(jsonlPath, ".."), { recursive: true });
  const lines = [
    { phase: "completed", usage_status: "known", tokens_input: 100, tokens_output: 10, model: "Qwen3.8-Flash" },
    { phase: "failed", usage_status: "unknown", tokens_input: 200, tokens_output: 20, model: "Qwen3.8-Flash" },
  ];
  await writeFile(jsonlPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

function fakeSnapshot(runId: string): ScienceFlowRunSnapshot {
  return {
    schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    runId,
    rawStatus: "completed",
    phase: "finished",
    tasks: [
      {
        taskRoot: "/pilot/runs/round20-test-run/circle-packing",
        reportedBestMetric: {
          metricName: "radii_sum",
          metricValue: 2.621352304043,
          lowerIsBetter: false,
          source: "lhr_stage_performance",
        },
        candidateArtifact: {
          metricName: "radii_sum",
          metricValue: 2.621352304043,
          lowerIsBetter: false,
          sha256: "b".repeat(64),
          digestVerified: true,
          stageId: "S02",
        },
        evidenceReferences: [],
      },
    ],
    diagnostics: [],
  };
}
