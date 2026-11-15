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
 * Experimental local operator entry: SD configuration → one evaluated
 * ScienceFlow research run → same-Session readback.
 *
 * Round 19 closed the research loop, but with a separately maintained engine
 * model registry, an ad hoc Python launcher and an in-memory Project/Session
 * identity adapter. This module removes those joins and nothing else. One
 * invocation:
 *
 * 1. resolves the Project/Session and the Session's *effective* SD model
 *    (`resolveRuntimeSettings(...).effective.modelId`), its profile or
 *    provider-shared credential (`getModelApiToken`) and its resolved proxy
 *    policy;
 * 2. refuses, before anything is launched, a profile this pilot cannot carry
 *    faithfully: another API protocol, another variant, a request-time thinking
 *    control, or an unusable credential/proxy;
 * 3. freezes that selection and generates a run-scoped private engine model
 *    registry and settings file from it — generated execution input, not a
 *    second user-maintained catalog;
 * 4. starts one engine managed run through the engine's own control entry,
 *    observes it within a process-level allowance, and stops it through the
 *    engine's own stop path when the allowance runs out;
 * 5. registers the resulting run for the original persisted Session and reads
 *    it back through the existing registration, reader and DTO services;
 * 6. writes a credential-free receipt with the engine's own stage rows and the
 *    per-run provider usage the engine recorded.
 *
 * Boundaries this module keeps: `canStart` and the five public-start blockers
 * are untouched; nothing here is an HTTP route or the product research-start
 * feature; the engine's workspace path guard is the tool boundary, not an OS
 * sandbox; the credential lives in a private run-scoped file (0600, in a 0700
 * directory) and is never copied into the research workspace, the dataset, the
 * seed or the receipt. This is not the unimplemented no-bypass model gateway.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  ModelApiProtocol,
  ModelApiVariant,
  ModelProfile,
  ResolvedProxy,
  ResolvedRuntimeSettings,
  RuntimeSettingsSource,
  ScienceFlowRunRegistrationDto,
  ScienceFlowRunSnapshotDto,
} from "@sciencediscovery/schema";
import type {
  ReadScienceFlowRunSnapshotOptions,
  ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";
import { resolveProxyForUrl } from "@sciencediscovery/data-source";

import { projectScienceFlowRunSnapshot } from "./dto.js";
import { createScienceFlowRegistrationService } from "./registration.js";
import type { ScienceFlowRegistrationStore } from "./registration-repository.js";
import {
  createScienceFlowRunSnapshotQuery,
  type ScienceFlowRunBinding,
} from "./run-snapshot.js";

/** Version of the operator receipt, independent of the DTO contracts. */
export const RESEARCH_PILOT_RECEIPT_VERSION = 1;

/** The engine surface this pilot is written against. A checkout path alone is
 *  not an identity, so the receipt records both. */
export const RESEARCH_PILOT_ENGINE_ENTRY = "scienceflow.runtime.parallel.control";

/** Round-20 standing allowance defaults; these are scheduling limits, not a
 *  verified monetary or provider-token cap. */
export const RESEARCH_PILOT_DEFAULTS = {
  reportBudgetSec: 60,
  researchBudgetSec: 840,
  maxSteps: 24,
  stageCaptureMax: 3,
  totalAllowanceSec: 900,
  bashTimeoutSec: 60,
  codeMaxTokens: 8_192,
  feedbackMaxTokens: 4_096,
  httpTimeoutSec: 60,
  task: "circle-packing",
} as const;

/** Variants this pilot can carry without adding a request-time control. */
const SUPPORTED_VARIANTS: readonly ModelApiVariant[] = ["openai", "qwen"];

/**
 * The narrow store surface the resolution needs. `SessionStore` satisfies it and
 * tests use a double. It is deliberately read-only: this module never writes SD
 * configuration.
 */
export interface ResearchPilotSessionStore {
  readonly resolveRuntimeSettings: (sessionId: string) => ResolvedRuntimeSettings;
  readonly getModel: (modelId?: string) => ModelProfile | undefined;
  readonly getModelApiToken: (modelId?: string) => string | undefined;
  readonly resolveProxy: (policy?: ModelProfile["proxyPolicy"]) => ResolvedProxy;
  readonly getProject: (projectId: string) => { readonly id: string } | undefined;
  readonly getSession: (sessionId: string) => { readonly projectId: string } | undefined;
  readonly assertSessionWritable: (sessionId: string) => unknown;
}

/** The persisted-Session services the readback reuses. `SessionStore`
 *  satisfies the identity, write gate and registration-store parts. */
export interface ResearchPilotReadbackStore extends ResearchPilotSessionStore {
  readonly scienceFlowRegistrations: ScienceFlowRegistrationStore;
}

export type ResearchPilotRefusalReason =
  | "project-not-found"
  | "session-not-found"
  | "session-not-writable"
  | "no-effective-model"
  | "model-unavailable"
  | "credential-unavailable"
  | "unsupported-protocol"
  | "unsupported-variant"
  | "unsupported-thinking"
  | "unsupported-proxy"
  | "invalid-option";

/** A configuration refusal: a stable reason and a message, never a credential. */
export class ResearchPilotRefusal extends Error {
  readonly reason: ResearchPilotRefusalReason;
  constructor(reason: ResearchPilotRefusalReason, message: string) {
    super(message);
    this.name = "ResearchPilotRefusal";
    this.reason = reason;
  }
}

/** The credential-free half of the frozen selection; safe to print and store. */
export interface ResearchPilotModelSelection {
  readonly projectId: string;
  readonly sessionId: string;
  /** Which settings layer supplied the effective model id. */
  readonly selectionSource: RuntimeSettingsSource;
  readonly profileId: string;
  readonly profileName: string;
  /** The provider's own model name, as the engine will request it. */
  readonly providerModel: string;
  /** Provider host only: the full endpoint is generated input, not evidence. */
  readonly providerHost: string;
  readonly apiProtocol: ModelApiProtocol;
  readonly apiVariant: ModelApiVariant;
  readonly proxyMode: ResolvedProxy["mode"];
}

/**
 * One resolved model. `apiToken`, `endpointUrl` and `proxyUrl` are private and
 * are never serialized into the receipt.
 */
export interface ResearchPilotResolvedModel {
  readonly selection: ResearchPilotModelSelection;
  readonly apiToken: string;
  readonly endpointUrl: string;
  readonly proxyUrl?: string;
}

/**
 * Resolve the Session's effective model and validate it against what this pilot
 * can carry. Everything that cannot be carried is refused here, before any file
 * is generated or process is started.
 */
export function resolveResearchPilotModel(
  store: ResearchPilotSessionStore,
  identity: { readonly projectId: string; readonly sessionId: string },
): ResearchPilotResolvedModel {
  if (!store.getProject(identity.projectId)) {
    throw new ResearchPilotRefusal("project-not-found", "The Project does not exist");
  }
  const session = store.getSession(identity.sessionId);
  if (!session || session.projectId !== identity.projectId) {
    throw new ResearchPilotRefusal("session-not-found", "The Session does not exist in this Project");
  }
  const settings = store.resolveRuntimeSettings(identity.sessionId);
  const modelId = settings.effective.modelId;
  if (!isUsableString(modelId)) {
    throw new ResearchPilotRefusal(
      "no-effective-model",
      "The Session has no effective model; select one before launching the pilot",
    );
  }
  const profile = store.getModel(modelId);
  if (!profile) {
    throw new ResearchPilotRefusal(
      "model-unavailable",
      "The Session's effective model profile is no longer installed",
    );
  }
  const apiToken = store.getModelApiToken(profile.id);
  if (!isUsableString(apiToken)) {
    throw new ResearchPilotRefusal(
      "credential-unavailable",
      "The effective model has no usable credential: neither its own nor its provider's",
    );
  }
  if (profile.apiProtocol !== "openai-chat-completions") {
    throw new ResearchPilotRefusal(
      "unsupported-protocol",
      `The pilot carries only openai-chat-completions; the selected profile uses ${profile.apiProtocol ?? "an unset protocol"}`,
    );
  }
  const variant: ModelApiVariant = profile.apiVariant ?? "openai";
  if (!SUPPORTED_VARIANTS.includes(variant)) {
    throw new ResearchPilotRefusal(
      "unsupported-variant",
      `The pilot carries only the openai and qwen variants; the selected profile uses ${variant}`,
    );
  }
  // SD sends a wire-level thinking control for the qwen variant; the engine
  // registry has no equivalent, so an explicit mode is refused, not dropped.
  if (variant === "qwen" && profile.thinkingMode !== undefined && profile.thinkingMode !== "auto") {
    throw new ResearchPilotRefusal(
      "unsupported-thinking",
      "The pilot cannot carry an explicit thinking mode for the qwen variant",
    );
  }
  const proxy = store.resolveProxy(profile.proxyPolicy);
  if (!isUsableString(profile.baseUrl)) {
    throw new ResearchPilotRefusal("unsupported-proxy", "The selected profile has no usable endpoint");
  }
  // Resolve the policy for this endpoint with the same helper SD's own model
  // calls use, so an "environment" policy is not mistaken for a live proxy.
  let route: Exclude<ResolvedProxy, { mode: "environment" }>;
  try {
    route = resolveProxyForUrl(proxy, profile.baseUrl);
  } catch {
    throw new ResearchPilotRefusal(
      "unsupported-proxy",
      "The selected profile's proxy policy cannot be resolved for its endpoint",
    );
  }
  if (route.mode === "url" && !isUsableString(route.url)) {
    throw new ResearchPilotRefusal("unsupported-proxy", "The selected proxy URL is unusable");
  }
  return {
    selection: {
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      selectionSource: settings.sources.modelId,
      profileId: profile.id,
      profileName: profile.name,
      providerModel: profile.model,
      providerHost: hostOf(profile.baseUrl),
      apiProtocol: profile.apiProtocol,
      apiVariant: variant,
      proxyMode: route.mode,
    },
    apiToken,
    endpointUrl: profile.baseUrl,
    ...(route.mode === "url" ? { proxyUrl: route.url } : {}),
  };
}

/** Options an operator supplies. Provider endpoint, credential and model name
 *  always come from SD resolution, never from here. */
export interface ResearchPilotOptions {
  readonly runId: string;
  readonly workDir: string;
  /** Private root for generated credential-bearing inputs: 0700, outside the work dir. */
  readonly privateRoot: string;
  readonly engineCheckout: string;
  readonly pythonExecutable: string;
  readonly readerScriptPath: string;
  readonly seedDir: string;
  readonly task?: string;
  readonly researchBudgetSec?: number;
  readonly reportBudgetSec?: number;
  readonly maxSteps?: number;
  readonly stageCaptureMax?: number;
  readonly totalAllowanceSec?: number;
  readonly bashTimeoutSec?: number;
  readonly codeMaxTokens?: number;
  readonly feedbackMaxTokens?: number;
  readonly httpTimeoutSec?: number;
  readonly refusePackageInstall?: boolean;
  readonly receiptPath?: string;
}

export interface ResearchPilotGrant {
  readonly task: string;
  readonly researchBudgetSec: number;
  readonly reportBudgetSec: number;
  readonly maxSteps: number;
  readonly stageCaptureMax: number;
  readonly totalAllowanceSec: number;
  readonly bashTimeoutSec: number;
  readonly codeMaxTokens: number;
  readonly feedbackMaxTokens: number;
  readonly httpTimeoutSec: number;
  readonly refusePackageInstall: boolean;
}

export interface ResearchPilotPaths {
  readonly workDir: string;
  readonly privateRoot: string;
  readonly stateHome: string;
  readonly runsRoot: string;
  readonly manifestPath: string;
  readonly receiptPath: string;
  readonly modelConfigPath: string;
  readonly settingsPath: string;
  readonly engineConfigPath: string;
  readonly taskRoot: string;
  readonly stageCsvPath: string;
  readonly providerCallsPath: string;
}

export interface ResearchPilotLaunchOutcome {
  readonly outcome: "finished" | "launch-failed" | "observation-failed" | "observation-timeout";
  readonly status?: string;
  readonly phase?: string;
  readonly researchStatus?: string;
  readonly reportStatus?: string;
  readonly supervisorPid?: number;
  readonly supervisorAliveAfterFinish?: boolean;
  readonly elapsedSec?: number;
  readonly stoppedByAllowance?: boolean;
  readonly error?: { readonly type: string; readonly message: string };
  readonly record?: Readonly<Record<string, unknown>>;
  /** Bounded stderr tail. The launcher is given no credential on its argv. */
  readonly stderrTail?: string;
}

export type ResearchPilotLauncher = (input: {
  readonly manifestPath: string;
  readonly runId: string;
  readonly totalAllowanceSec: number;
  readonly pythonExecutable: string;
  readonly engineCheckout: string;
  readonly workDir: string;
  readonly stateHome: string;
  readonly noInstallPathPrefix?: string;
  readonly proxyUrl?: string;
}) => Promise<ResearchPilotLaunchOutcome>;

export interface ResearchPilotStageRow {
  readonly stageId: string;
  readonly parentStageId: string | null;
  readonly candidateId: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly artifactSha256: string | null;
  readonly artifactPath: string | null;
  /** The stage's own snapshot directory, as the engine recorded it. */
  readonly snapshotPath: string | null;
  readonly validationOk: boolean;
  readonly selectionEligible: boolean;
  readonly gateAccepted: boolean;
  readonly evaluatorStatus: string;
  readonly createdAtUtc: string;
}

export interface ResearchPilotUsage {
  readonly calls: number;
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly unknownUsageCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly models: readonly string[];
}

export type ResearchPilotOutcomeStatus =
  | "completed"
  | "configuration-refused"
  | "invalid-option"
  | "launch-pending"
  | "launch-unknown"
  | "launch-failed"
  | "observation-failed"
  | "run-already-exists"
  | "registration-failed"
  | "readback-failed";

export interface ResearchPilotResult {
  readonly stages: readonly ResearchPilotStageRow[];
  readonly selectedStageId: string | null;
  readonly selectedMetric: { readonly name: string; readonly value: number } | null;
  readonly selectedArtifactSha256: string | null;
  readonly digestVerified: boolean | null;
  readonly conclusion: string;
}

export interface ResearchPilotReceipt {
  readonly schemaVersion: typeof RESEARCH_PILOT_RECEIPT_VERSION;
  readonly invocation: "scienceflow-research-pilot";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly model: ResearchPilotModelSelection | null;
  readonly engine: {
    readonly entry: typeof RESEARCH_PILOT_ENGINE_ENTRY;
    readonly checkout: string;
    readonly runId: string;
    readonly task: string;
    readonly workDir: string;
    readonly stateHome: string;
    readonly grant: ResearchPilotGrant;
    readonly generatedInputs: {
      readonly alias: string;
      readonly modelConfigPath: string;
      readonly settingsPath: string;
      readonly engineConfigPath: string;
    } | null;
    readonly manifestPath: string | null;
  };
  readonly outcome: {
    readonly status: ResearchPilotOutcomeStatus;
    readonly failedStep?: string;
    readonly reason?: string;
    readonly message?: string;
    readonly engineRunId: string | null;
  };
  readonly launch: ResearchPilotLaunchOutcome | null;
  readonly registration: {
    readonly status: "created" | "existing";
    readonly registration: ScienceFlowRunRegistrationDto;
  } | null;
  readonly snapshot: ScienceFlowRunSnapshotDto | null;
  readonly result: ResearchPilotResult | null;
  readonly usage: ResearchPilotUsage | null;
}

export interface ResearchPilotDependencies {
  /** Defaults to the real detached-supervisor launcher. */
  readonly launch?: ResearchPilotLauncher;
  /** Passed to the existing snapshot query; tests substitute a stub. */
  readonly readSnapshot?: (
    options: ReadScienceFlowRunSnapshotOptions,
  ) => Promise<ScienceFlowSnapshotReadResult>;
  readonly now?: () => string;
}

type ResearchPilotRequest = ResearchPilotOptions & {
  readonly projectId: string;
  readonly sessionId: string;
};

interface ResearchPilotContext {
  readonly store: ResearchPilotReadbackStore;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly request: ResearchPilotRequest;
  readonly grant: ResearchPilotGrant;
  readonly paths: ResearchPilotPaths;
  readonly now: () => string;
}

/**
 * Validate operator options and derive every run-scoped path. The private root
 * must not sit inside the work dir or the seed, so generated credentials can
 * never be linked into the engine's dataset or land in pilot evidence.
 */
export function researchPilotPlan(options: ResearchPilotOptions): {
  readonly grant: ResearchPilotGrant;
  readonly paths: ResearchPilotPaths;
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.runId)) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The run id must be 1-64 characters of letters, digits, dot, underscore or hyphen",
    );
  }
  const task = options.task ?? RESEARCH_PILOT_DEFAULTS.task;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(task)) {
    throw new ResearchPilotRefusal("invalid-option", "The task id is not a usable engine task name");
  }
  for (const [field, value] of Object.entries({
    workDir: options.workDir,
    privateRoot: options.privateRoot,
    engineCheckout: options.engineCheckout,
    pythonExecutable: options.pythonExecutable,
    readerScriptPath: options.readerScriptPath,
    seedDir: options.seedDir,
  })) {
    if (!isAbsolute(value) || !isUsableString(value)) {
      throw new ResearchPilotRefusal("invalid-option", `The ${field} must be an absolute path`);
    }
  }
  const workDir = resolve(options.workDir);
  const privateRoot = resolve(options.privateRoot);
  const seedDir = resolve(options.seedDir);
  if (isInside(privateRoot, workDir) || isInside(privateRoot, seedDir)) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The private root must be outside the work dir and the seed dir",
    );
  }
  const grant: ResearchPilotGrant = {
    task,
    researchBudgetSec: boundedInt(options.researchBudgetSec, RESEARCH_PILOT_DEFAULTS.researchBudgetSec, 30, 840),
    reportBudgetSec: boundedInt(options.reportBudgetSec, RESEARCH_PILOT_DEFAULTS.reportBudgetSec, 10, 600),
    maxSteps: boundedInt(options.maxSteps, RESEARCH_PILOT_DEFAULTS.maxSteps, 1, 200),
    stageCaptureMax: boundedInt(options.stageCaptureMax, RESEARCH_PILOT_DEFAULTS.stageCaptureMax, 1, 20),
    totalAllowanceSec: boundedInt(options.totalAllowanceSec, RESEARCH_PILOT_DEFAULTS.totalAllowanceSec, 60, 1_800),
    bashTimeoutSec: boundedInt(options.bashTimeoutSec, RESEARCH_PILOT_DEFAULTS.bashTimeoutSec, 5, 600),
    codeMaxTokens: boundedInt(options.codeMaxTokens, RESEARCH_PILOT_DEFAULTS.codeMaxTokens, 256, 32_768),
    feedbackMaxTokens: boundedInt(options.feedbackMaxTokens, RESEARCH_PILOT_DEFAULTS.feedbackMaxTokens, 256, 32_768),
    httpTimeoutSec: boundedInt(options.httpTimeoutSec, RESEARCH_PILOT_DEFAULTS.httpTimeoutSec, 5, 600),
    refusePackageInstall: options.refusePackageInstall === true,
  };
  if (grant.totalAllowanceSec < grant.researchBudgetSec + grant.reportBudgetSec) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The total allowance must cover the research and report budgets",
    );
  }
  const stateHome = join(workDir, "state");
  const runsRoot = join(workDir, "runs");
  const taskRoot = join(runsRoot, options.runId, task);
  const paths: ResearchPilotPaths = {
    workDir,
    privateRoot,
    stateHome,
    runsRoot,
    manifestPath: join(workDir, "pilot-manifest.yaml"),
    receiptPath: resolve(options.receiptPath ?? join(workDir, "receipt.json")),
    modelConfigPath: join(privateRoot, "models.json"),
    settingsPath: join(privateRoot, "pilot-settings.json"),
    engineConfigPath: join(privateRoot, "engine-config.yaml"),
    taskRoot,
    stageCsvPath: join(taskRoot, "task_logs", "lhr_stage_performance.csv"),
    providerCallsPath: join(
      taskRoot,
      "workers",
      "w00",
      "logs",
      "agent_runtime_audit",
      "agent_provider_calls.jsonl",
    ),
  };
  return { grant, paths };
}

/**
 * Write the run-scoped engine inputs generated from the frozen selection:
 *
 * - a private model registry (0600) whose only entry is this model;
 * - a private pilot settings file (0600) that references it for both roles;
 * - a private engine config (0600) that includes the pinned engine's defaults.
 *
 * The directory is 0700. The credential is written once, never echoed, and
 * never appears in the manifest, the work dir or the receipt.
 */
export async function materializeResearchPilotModelInputs(input: {
  readonly resolved: ResearchPilotResolvedModel;
  readonly grant: ResearchPilotGrant;
  readonly paths: ResearchPilotPaths;
  readonly engineCheckout: string;
  readonly pythonExecutable: string;
}): Promise<{ readonly alias: string; readonly useProxy: boolean }> {
  const { resolved, grant, paths } = input;
  await mkdir(paths.privateRoot, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to the umask; the directory that holds the
  // credential is made 0700 explicitly.
  await chmod(paths.privateRoot, 0o700);
  const alias = modelAlias(resolved.selection);
  const useProxy = resolved.selection.proxyMode !== "direct";
  const registry = {
    version: 1,
    models: {
      [alias]: {
        model: resolved.selection.providerModel,
        endpoints: [{ url: resolved.endpointUrl, key: resolved.apiToken }],
        use_proxy: useProxy,
        // Fixed pilot policy: the engine replays provider reasoning turns.
        reasoning_replay: "preserve",
      },
    },
    defaults: {
      code_models: [alias],
      feedback_models: [alias],
      selection: "fixed",
    },
  };
  const stage = (maxTokens: number) => ({
    model_aliases: [alias],
    model_config_path: paths.modelConfigPath,
    model_selection: "fixed",
    max_tokens: maxTokens,
    http_timeout: grant.httpTimeoutSec,
    use_proxy: useProxy,
  });
  const settings = {
    agent: { code: stage(grant.codeMaxTokens), feedback: stage(grant.feedbackMaxTokens) },
    lnr: {
      num_workers: 1,
      wall_clock_budget_sec: grant.researchBudgetSec,
      max_steps: grant.maxSteps,
    },
  };
  const engineConfig = [
    "# Generated by the ScienceDiscovery research pilot operator for one run.",
    "# Neither the credential nor its private directory is copied anywhere else.",
    "include:",
    `  - ${yamlString(join(input.engineCheckout, "scienceflow", "foundation", "config", "default.yaml"))}`,
    `  - ${yamlString(paths.settingsPath)}`,
    "evaluator:",
    "  command:",
    `    python_executable: ${yamlString(input.pythonExecutable)}`,
    "",
  ].join("\n");
  await writePrivateJson(paths.modelConfigPath, registry);
  await writePrivateJson(paths.settingsPath, settings);
  await writePrivateText(paths.engineConfigPath, engineConfig);
  return { alias, useProxy };
}

/** One engine launch manifest derived from the frozen grant. */
export function researchPilotManifest(input: {
  readonly grant: ResearchPilotGrant;
  readonly paths: ResearchPilotPaths;
  readonly runId: string;
  readonly engineConfigPath: string;
  readonly seedDir: string;
}): string {
  const { grant, paths, runId } = input;
  return [
    "# Generated by the ScienceDiscovery research pilot operator for one run.",
    "defaults:",
    `  config: ${yamlString(input.engineConfigPath)}`,
    `  workspace_base: ${yamlString(paths.runsRoot)}`,
    `  input_data_dir: ${yamlString(resolve(input.seedDir))}`,
    "  gpu_list: cpu",
    "  scienceflow_interaction_log_full: true",
    `  scienceflow_bash_timeout_sec: ${grant.bashTimeoutSec}`,
    "tasks:",
    `  - exp_id: ${grant.task}`,
    `    run_id: ${yamlString(runId)}`,
    "lnr:",
    "  num_workers: 1",
    "  merge_enabled: false",
    `  wall_clock_budget_sec: ${grant.researchBudgetSec}`,
    `  max_steps: ${grant.maxSteps}`,
    `  stage_capture_max_count: ${grant.stageCaptureMax}`,
    `report_budget_sec: ${grant.reportBudgetSec}`,
    "",
  ].join("\n");
}

/**
 * The full operator invocation. Returns the receipt it also wrote to disk.
 * A refusal, launch failure or readback failure is reported at its own step;
 * once the engine created a run, `outcome.engineRunId` is retained so a retry
 * attaches to that run instead of starting another paid launch. The frozen
 * selection is written before the paid launch, so a duplicate `launch` refuses
 * without touching that receipt and a post-launch failure still leaves
 * `attach` something to read.
 */
export async function runResearchPilot(
  store: ResearchPilotReadbackStore,
  request: ResearchPilotRequest,
  dependencies: ResearchPilotDependencies = {},
): Promise<ResearchPilotReceipt> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const identity = { projectId: request.projectId, sessionId: request.sessionId };

  let plan: ReturnType<typeof researchPilotPlan>;
  try {
    plan = researchPilotPlan(request);
  } catch (error) {
    return writeReceipt(
      refusalReceipt({ identity, startedAt, now, request, error, status: "invalid-option" }),
      request.receiptPath
        ? resolve(request.receiptPath)
        : join(resolve(request.workDir), "receipt.json"),
      { preserveExisting: true },
    );
  }
  const context: ResearchPilotContext = { store, identity, request, ...plan, now };

  // A run id names one engine run. If the engine already owns it, the only
  // valid continuation is `attach`; starting again would be a second paid run.
  // The refusal is returned, never written: the receipt at this path may be the
  // only record of the model and grant the run was actually started with.
  if (
    await fileExists(
      join(plan.paths.stateHome, "scienceflow", "managed_runs", request.runId, "control.json"),
    )
  ) {
    return existingRunReceipt({ identity, startedAt, now, request, plan });
  }

  let resolved: ResearchPilotResolvedModel;
  try {
    resolved = resolveResearchPilotModel(store, identity);
  } catch (error) {
    return writeReceipt(
      refusalReceipt({ identity, startedAt, now, request, error, status: "configuration-refused", ...plan }),
      plan.paths.receiptPath,
      { preserveExisting: true },
    );
  }

  // A Session that is already read-only is refused before any credential file
  // or process exists. The write gate is checked again after the launch, where
  // the Session may have become read-only while the engine was running.
  try {
    store.assertSessionWritable(identity.sessionId);
  } catch (error) {
    return writeReceipt(
      refusalReceipt({
        identity,
        startedAt,
        now,
        request,
        error: new ResearchPilotRefusal(
          "session-not-writable",
          `The Session cannot be registered; refusing before launch: ${errorMessage(error)}`,
        ),
        status: "configuration-refused",
        ...plan,
      }),
      plan.paths.receiptPath,
      { preserveExisting: true },
    );
  }

  await materializeResearchPilotModelInputs({
    resolved,
    grant: plan.grant,
    paths: plan.paths,
    engineCheckout: request.engineCheckout,
    pythonExecutable: request.pythonExecutable,
  });
  await mkdir(plan.paths.runsRoot, { recursive: true });
  await writeFile(
    plan.paths.manifestPath,
    researchPilotManifest({
      grant: plan.grant,
      paths: plan.paths,
      runId: request.runId,
      engineConfigPath: plan.paths.engineConfigPath,
      seedDir: request.seedDir,
    }),
    "utf8",
  );

  const noInstallPathPrefix = plan.grant.refusePackageInstall
    ? await writeInstallRefusalShims(plan.paths.workDir)
    : undefined;
  // Persist the frozen identity/selection before the paid launch. If this
  // process ends during the launch, registration or readback, `attach` can
  // still recover from this receipt instead of starting another run.
  await writeReceipt(
    preLaunchReceipt({
      identity,
      startedAt,
      now,
      request,
      grant: plan.grant,
      paths: plan.paths,
      model: resolved.selection,
      status: "launch-pending",
      message: "The run is frozen; no launch result has been recorded yet",
    }),
    plan.paths.receiptPath,
  );
  const launch = dependencies.launch ?? launchManagedRun;
  let launched: ResearchPilotLaunchOutcome;
  try {
    launched = await launch({
      manifestPath: plan.paths.manifestPath,
      runId: request.runId,
      totalAllowanceSec: plan.grant.totalAllowanceSec,
      pythonExecutable: request.pythonExecutable,
      engineCheckout: request.engineCheckout,
      workDir: plan.paths.workDir,
      stateHome: plan.paths.stateHome,
      ...(noInstallPathPrefix ? { noInstallPathPrefix } : {}),
      ...(resolved.proxyUrl ? { proxyUrl: resolved.proxyUrl } : {}),
    });
  } catch (error) {
    // The launcher threw, so whether the engine started is not known from here.
    // The run id is retained for `attach`; this command does not launch again.
    return writeReceipt(
      preLaunchReceipt({
        identity,
        startedAt,
        now,
        request,
        grant: plan.grant,
        paths: plan.paths,
        model: resolved.selection,
        status: "launch-unknown",
        message: errorMessage(error),
      }),
      plan.paths.receiptPath,
    );
  }

  return finishResearchPilot({
    context,
    resolved,
    launch: launched,
    dependencies,
    startedAt,
  });
}

/**
 * Re-run only registration and readback for a run an earlier invocation already
 * started. The launch-time model selection is read back from the receipt, so a
 * later SD selection change cannot relabel this run.
 */
export async function attachResearchPilotRun(
  store: ResearchPilotReadbackStore,
  request: ResearchPilotRequest,
  dependencies: ResearchPilotDependencies = {},
): Promise<ResearchPilotReceipt> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const identity = { projectId: request.projectId, sessionId: request.sessionId };
  const requested = researchPilotPlan(request);
  let previous: ResearchPilotReceipt;
  try {
    previous = JSON.parse(
      await readFile(requested.paths.receiptPath, "utf8"),
    ) as ResearchPilotReceipt;
  } catch {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "No readable receipt exists for this invocation; run launch first",
    );
  }
  if (
    !isRecord(previous) ||
    !isRecord(previous.identity) ||
    !isRecord(previous.engine) ||
    !isRecord(previous.engine.grant) ||
    previous.identity.projectId !== identity.projectId ||
    previous.identity.sessionId !== identity.sessionId ||
    previous.engine.runId !== request.runId
  ) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The existing receipt belongs to another Project, Session or run",
    );
  }
  // The run's own task, work dir and grant are facts of the launch. A retry
  // that names another task or another work dir would read the wrong run.
  if (request.task !== undefined && request.task !== previous.engine.task) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The requested task does not match the run this receipt recorded",
    );
  }
  const plan = researchPilotPlan({
    ...request,
    workDir: previous.engine.workDir,
    task: previous.engine.task,
  });
  if (plan.paths.receiptPath !== requested.paths.receiptPath) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The requested work dir does not contain the receipt this run recorded",
    );
  }
  const grant = previous.engine.grant;
  const context: ResearchPilotContext = { store, identity, request, grant, paths: plan.paths, now };
  if (
    !(await fileExists(
      join(plan.paths.stateHome, "scienceflow", "managed_runs", request.runId, "control.json"),
    ))
  ) {
    throw new ResearchPilotRefusal(
      "invalid-option",
      "The engine has no run record for this run id; there is nothing to attach",
    );
  }
  return finishResearchPilot({
    context,
    resolved: null,
    // The launch step already happened before this invocation: only the
    // readback is being retried, so its status is not this attempt's failure.
    launch:
      previous.launch === null
        ? ({
            outcome: "observation-failed",
            error: { type: "AttachOnly", message: "The launch outcome is not recorded" },
          } satisfies ResearchPilotLaunchOutcome)
        : { ...previous.launch, outcome: "finished" },
    dependencies,
    startedAt,
    previous,
  });
}

async function finishResearchPilot(input: {
  readonly context: ResearchPilotContext;
  readonly resolved: ResearchPilotResolvedModel | null;
  readonly launch: ResearchPilotLaunchOutcome;
  readonly dependencies: ResearchPilotDependencies;
  readonly startedAt: string;
  readonly previous?: ResearchPilotReceipt;
}): Promise<ResearchPilotReceipt> {
  const { context, resolved, launch, dependencies, startedAt, previous } = input;
  const { store, identity, request, grant, paths } = context;
  const engineRunId = launch.outcome === "launch-failed" ? null : request.runId;
  const model = resolved?.selection ?? previous?.model ?? null;
  const launchRecord = receiptLaunch(launch);
  const base = {
    schemaVersion: RESEARCH_PILOT_RECEIPT_VERSION,
    invocation: "scienceflow-research-pilot",
    startedAt,
    identity,
    model,
    engine: {
      entry: RESEARCH_PILOT_ENGINE_ENTRY,
      checkout: previous?.engine.checkout ?? request.engineCheckout,
      runId: request.runId,
      task: grant.task,
      workDir: paths.workDir,
      stateHome: paths.stateHome,
      grant,
      generatedInputs: previous
        ? previous.engine.generatedInputs
        : {
            alias: modelAlias(resolved!.selection),
            modelConfigPath: paths.modelConfigPath,
            settingsPath: paths.settingsPath,
            engineConfigPath: paths.engineConfigPath,
          },
      manifestPath: paths.manifestPath,
    },
  } as const;

  if (launch.outcome === "launch-failed") {
    return writeReceipt(
      {
        ...base,
        finishedAt: context.now(),
        outcome: {
          status: "launch-failed",
          failedStep: "launch",
          ...(launch.error ? { message: `${launch.error.type}: ${launch.error.message}` } : {}),
          engineRunId: null,
        },
        launch: launchRecord,
        registration: null,
        snapshot: null,
        result: null,
        usage: null,
      },
      paths.receiptPath,
    );
  }

  const registrationService = createScienceFlowRegistrationService({
    identities: store,
    requireWritable: (sessionId) => store.assertSessionWritable(sessionId),
    resolveBinding: () => bindingFor(identity, request.runId, paths),
    store: () => store.scienceFlowRegistrations,
  });
  let registered: ResearchPilotReceipt["registration"] = null;
  let step: "register" | "readback" = "register";
  try {
    const registration = await registrationService.create(
      { projectId: identity.projectId, sessionId: identity.sessionId },
      request.runId,
    );
    registered =
      registration.status === "created" || registration.status === "existing"
        ? { status: registration.status, registration: registration.registration }
        : null;

    step = "readback";
    const snapshotQuery = createScienceFlowRunSnapshotQuery({
      identities: store,
      resolveBinding: () => bindingFor(identity, request.runId, paths),
      readerConfig: {
        pythonExecutable: request.pythonExecutable,
        readerScriptPath: request.readerScriptPath,
        timeoutMs: 30_000,
      },
      ...(dependencies.readSnapshot ? { readSnapshot: dependencies.readSnapshot } : {}),
    });
    const query = await snapshotQuery({
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      runId: request.runId,
    });

    const stages = await readStageRows(paths.stageCsvPath);
    const usage = await readUsage(paths.providerCallsPath);
    const dto =
      query.status === "ok"
        ? projectScienceFlowRunSnapshot(request.runId, query.snapshot)
        : null;
    const status: ResearchPilotOutcomeStatus =
      launch.outcome !== "finished"
        ? "observation-failed"
        : registered === null
          ? "registration-failed"
          : query.status !== "ok"
            ? "readback-failed"
            : "completed";
    const failedStep =
      status === "observation-failed"
        ? "observe"
        : status === "registration-failed"
          ? "register"
          : status === "readback-failed"
            ? "readback"
            : undefined;
    const message =
      status === "observation-failed" && launch.error
        ? `${launch.error.type}: ${launch.error.message}`
        : status === "registration-failed"
          ? `registration ${registration.status}${"resource" in registration ? `: ${registration.resource}` : ""}`
          : undefined;
    return writeReceipt(
      {
        ...base,
        finishedAt: context.now(),
        outcome: {
          status,
          ...(failedStep ? { failedStep } : {}),
          ...(status === "readback-failed" && query.status !== "ok" ? { reason: query.status } : {}),
          ...(message ? { message } : {}),
          engineRunId,
        },
        launch: launchRecord,
        registration: registered,
        snapshot: dto,
        result: summarizeResult(stages, dto),
        usage,
      },
      paths.receiptPath,
    );
  } catch (error) {
    // Registration and readback run after the paid launch. Their failure must
    // not remove the receipt: it is what `attach` reads to retry this step
    // without starting another run. The launch record keeps its own outcome;
    // the failed step here is the step this attempt actually failed at.
    const status: ResearchPilotOutcomeStatus =
      step === "register" ? "registration-failed" : "readback-failed";
    return writeReceipt(
      {
        ...base,
        finishedAt: context.now(),
        outcome: {
          status,
          failedStep: step,
          message: errorMessage(error),
          engineRunId,
        },
        launch: launchRecord,
        registration: registered,
        snapshot: null,
        result: null,
        usage: null,
      },
      paths.receiptPath,
    );
  }
}

/** The trusted binding the readback may use for this one operator run. */
function bindingFor(
  identity: { readonly projectId: string; readonly sessionId: string },
  runId: string,
  paths: ResearchPilotPaths,
): ScienceFlowRunBinding {
  return {
    projectId: identity.projectId,
    sessionId: identity.sessionId,
    runId,
    runRecordPath: join(paths.stateHome, "scienceflow", "managed_runs", runId, "control.json"),
    allowedTaskRoots: [paths.taskRoot],
  };
}

/** Fields of the engine's record the receipt may carry; the raw record stays in
 *  the engine's own `control.json`. */
const RECEIPT_RECORD_FIELDS = [
  "run_id",
  "status",
  "phase",
  "research_status",
  "report_status",
  "created_at",
  "attempt",
  "pid",
  "alive",
] as const;

/** Strip the launch outcome down to bounded, credential-free facts. */
function receiptLaunch(launch: ResearchPilotLaunchOutcome): ResearchPilotLaunchOutcome {
  const record = isRecord(launch.record)
    ? Object.fromEntries(
        RECEIPT_RECORD_FIELDS.flatMap((field) =>
          field in launch.record! ? [[field, launch.record![field]]] : [],
        ),
      )
    : undefined;
  return {
    ...launch,
    ...(record ? { record } : {}),
    ...(launch.stderrTail ? { stderrTail: launch.stderrTail.slice(-2_000) } : {}),
  };
}

/**
 * The credential-free receipt written around the paid launch: the frozen
 * identity, selection, grant and generated-input paths, with no registration or
 * readback. `launch-pending` is written first; `launch-unknown` replaces it when
 * the launcher itself threw and whether the engine started cannot be told from
 * here. Neither claims a confirmed engine run.
 */
function preLaunchReceipt(input: {
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly startedAt: string;
  readonly now: () => string;
  readonly request: ResearchPilotRequest;
  readonly grant: ResearchPilotGrant;
  readonly paths: ResearchPilotPaths;
  readonly model: ResearchPilotModelSelection;
  readonly status: "launch-pending" | "launch-unknown";
  readonly message: string;
}): ResearchPilotReceipt {
  return {
    schemaVersion: RESEARCH_PILOT_RECEIPT_VERSION,
    invocation: "scienceflow-research-pilot",
    startedAt: input.startedAt,
    finishedAt: input.now(),
    identity: input.identity,
    model: input.model,
    engine: {
      entry: RESEARCH_PILOT_ENGINE_ENTRY,
      checkout: input.request.engineCheckout,
      runId: input.request.runId,
      task: input.grant.task,
      workDir: input.paths.workDir,
      stateHome: input.paths.stateHome,
      grant: input.grant,
      generatedInputs: {
        alias: modelAlias(input.model),
        modelConfigPath: input.paths.modelConfigPath,
        settingsPath: input.paths.settingsPath,
        engineConfigPath: input.paths.engineConfigPath,
      },
      manifestPath: input.paths.manifestPath,
    },
    outcome: {
      status: input.status,
      ...(input.status === "launch-unknown" ? { failedStep: "launch" } : {}),
      message: input.message,
      // A pending launch has no confirmed run yet; an unknown one reserves this
      // run id for `attach` but cannot assert that the engine created it.
      engineRunId: input.status === "launch-unknown" ? input.request.runId : null,
    },
    launch: null,
    registration: null,
    snapshot: null,
    result: null,
    usage: null,
  };
}

/** The receipt for a launch refused because the engine already owns the run id. */
function existingRunReceipt(input: {
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly startedAt: string;
  readonly now: () => string;
  readonly request: ResearchPilotRequest;
  readonly plan: { readonly grant: ResearchPilotGrant; readonly paths: ResearchPilotPaths };
}): ResearchPilotReceipt {
  return {
    schemaVersion: RESEARCH_PILOT_RECEIPT_VERSION,
    invocation: "scienceflow-research-pilot",
    startedAt: input.startedAt,
    finishedAt: input.now(),
    identity: input.identity,
    model: null,
    engine: {
      entry: RESEARCH_PILOT_ENGINE_ENTRY,
      checkout: input.request.engineCheckout,
      runId: input.request.runId,
      task: input.plan.grant.task,
      workDir: input.plan.paths.workDir,
      stateHome: input.plan.paths.stateHome,
      grant: input.plan.grant,
      generatedInputs: null,
      manifestPath: null,
    },
    outcome: {
      status: "run-already-exists",
      failedStep: "launch",
      message: "The engine already owns this run id; use attach to register and read it",
      engineRunId: input.request.runId,
    },
    launch: null,
    registration: null,
    snapshot: null,
    result: null,
    usage: null,
  };
}

function refusalReceipt(input: {
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly startedAt: string;
  readonly now: () => string;
  readonly request: ResearchPilotRequest;
  readonly error: unknown;
  readonly status: "configuration-refused" | "invalid-option";
  readonly grant?: ResearchPilotGrant;
  readonly paths?: ResearchPilotPaths;
}): ResearchPilotReceipt {
  const grant = input.grant ?? planFallbackGrant(input.request);
  const paths = input.paths ?? planFallbackPaths(input.request, grant);
  const reason = input.error instanceof ResearchPilotRefusal ? input.error.reason : undefined;
  const message = input.error instanceof Error ? input.error.message : "The options are unusable";
  return {
    schemaVersion: RESEARCH_PILOT_RECEIPT_VERSION,
    invocation: "scienceflow-research-pilot",
    startedAt: input.startedAt,
    finishedAt: input.now(),
    identity: input.identity,
    model: null,
    engine: {
      entry: RESEARCH_PILOT_ENGINE_ENTRY,
      checkout: input.request.engineCheckout,
      runId: input.request.runId,
      task: grant.task,
      workDir: paths.workDir,
      stateHome: paths.stateHome,
      grant,
      generatedInputs: null,
      manifestPath: null,
    },
    outcome: {
      status: input.status,
      failedStep: "resolve",
      ...(reason ? { reason } : {}),
      message,
      engineRunId: null,
    },
    launch: null,
    registration: null,
    snapshot: null,
    result: null,
    usage: null,
  };
}

/** The grant as written down when validation itself refused the options. */
function planFallbackGrant(options: ResearchPilotOptions): ResearchPilotGrant {
  return {
    task: options.task ?? RESEARCH_PILOT_DEFAULTS.task,
    researchBudgetSec: options.researchBudgetSec ?? RESEARCH_PILOT_DEFAULTS.researchBudgetSec,
    reportBudgetSec: options.reportBudgetSec ?? RESEARCH_PILOT_DEFAULTS.reportBudgetSec,
    maxSteps: options.maxSteps ?? RESEARCH_PILOT_DEFAULTS.maxSteps,
    stageCaptureMax: options.stageCaptureMax ?? RESEARCH_PILOT_DEFAULTS.stageCaptureMax,
    totalAllowanceSec: options.totalAllowanceSec ?? RESEARCH_PILOT_DEFAULTS.totalAllowanceSec,
    bashTimeoutSec: options.bashTimeoutSec ?? RESEARCH_PILOT_DEFAULTS.bashTimeoutSec,
    codeMaxTokens: options.codeMaxTokens ?? RESEARCH_PILOT_DEFAULTS.codeMaxTokens,
    feedbackMaxTokens: options.feedbackMaxTokens ?? RESEARCH_PILOT_DEFAULTS.feedbackMaxTokens,
    httpTimeoutSec: options.httpTimeoutSec ?? RESEARCH_PILOT_DEFAULTS.httpTimeoutSec,
    refusePackageInstall: options.refusePackageInstall === true,
  };
}

function planFallbackPaths(
  options: ResearchPilotOptions,
  grant: ResearchPilotGrant,
): ResearchPilotPaths {
  const workDir = resolve(options.workDir);
  const privateRoot = resolve(options.privateRoot);
  const runsRoot = join(workDir, "runs");
  const taskRoot = join(runsRoot, options.runId, grant.task);
  return {
    workDir,
    privateRoot,
    stateHome: join(workDir, "state"),
    runsRoot,
    manifestPath: join(workDir, "pilot-manifest.yaml"),
    receiptPath: resolve(options.receiptPath ?? join(workDir, "receipt.json")),
    modelConfigPath: join(privateRoot, "models.json"),
    settingsPath: join(privateRoot, "pilot-settings.json"),
    engineConfigPath: join(privateRoot, "engine-config.yaml"),
    taskRoot,
    stageCsvPath: join(taskRoot, "task_logs", "lhr_stage_performance.csv"),
    providerCallsPath: join(
      taskRoot,
      "workers",
      "w00",
      "logs",
      "agent_runtime_audit",
      "agent_provider_calls.jsonl",
    ),
  };
}

async function writeReceipt(
  receipt: ResearchPilotReceipt,
  receiptPath: string,
  options: { readonly preserveExisting?: boolean } = {},
): Promise<ResearchPilotReceipt> {
  // A refusal or a retry must not replace facts an earlier invocation froze
  // about a run that already exists.
  if (options.preserveExisting && (await fileExists(receiptPath))) return receipt;
  await mkdir(dirname(receiptPath), { recursive: true });
  // A receipt carries no credential: the private inputs appear as paths only,
  // and their content is never read here.
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(receiptPath, 0o600);
  return receipt;
}

/** Stage rows from the engine's own ledger, in capture order. */
export async function readStageRows(csvPath: string): Promise<readonly ResearchPilotStageRow[]> {
  let text: string;
  try {
    text = await readFile(csvPath, "utf8");
  } catch {
    return [];
  }
  const records = parseCsv(text);
  const header = records.shift();
  if (!header) return [];
  const column = (name: string): number => header.indexOf(name);
  const index = {
    stageId: column("stage_id"),
    parentStageId: column("parent_stage_id"),
    candidateId: column("candidate_id"),
    metricName: column("metric_name"),
    metricValue: column("metric_value"),
    artifactSha: column("artifact_sha"),
    artifactPath: column("artifact_path"),
    snapshotPath: column("snapshot_path"),
    validationOk: column("validation_ok"),
    selectionEligible: column("selection_eligible"),
    gateAccepted: column("gate_accepted"),
    evaluatorStatus: column("evaluator_status"),
    createdAt: column("created_at_utc"),
  };
  const rows: ResearchPilotStageRow[] = [];
  for (const record of records) {
    const value = (position: number): string => (position >= 0 ? (record[position] ?? "") : "");
    const metric = Number.parseFloat(value(index.metricValue));
    const stageId = value(index.stageId);
    if (!Number.isFinite(metric) || !stageId) continue;
    rows.push({
      stageId,
      parentStageId: value(index.parentStageId) || null,
      candidateId: value(index.candidateId),
      metricName: value(index.metricName),
      metricValue: metric,
      artifactSha256: value(index.artifactSha) || null,
      artifactPath: value(index.artifactPath) || null,
      snapshotPath: value(index.snapshotPath) || null,
      validationOk: value(index.validationOk) === "1",
      selectionEligible: value(index.selectionEligible) === "1",
      gateAccepted: value(index.gateAccepted) === "1",
      evaluatorStatus: value(index.evaluatorStatus),
      createdAtUtc: value(index.createdAt),
    });
  }
  return rows;
}

/** Per-run provider usage as the engine recorded it; not a monetary cap proof. */
export async function readUsage(jsonlPath: string): Promise<ResearchPilotUsage | null> {
  let text: string;
  try {
    text = await readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  let calls = 0;
  let completed = 0;
  let failed = 0;
  let unknown = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const models = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    calls += 1;
    if (record.phase === "completed") completed += 1;
    else if (record.phase === "failed") failed += 1;
    if (record.usage_status !== "known") unknown += 1;
    if (typeof record.tokens_input === "number") inputTokens += record.tokens_input;
    if (typeof record.tokens_output === "number") outputTokens += record.tokens_output;
    if (typeof record.model === "string" && record.model) models.add(record.model);
  }
  return {
    calls,
    completedCalls: completed,
    failedCalls: failed,
    unknownUsageCalls: unknown,
    inputTokens,
    outputTokens,
    models: [...models],
  };
}

/**
 * The honest comparison. The first captured stage is the carried seed when the
 * run was seeded; every later captured stage is a new model-produced result. An
 * engine-evaluated but uncaptured candidate is never presented as the selected
 * stage: only the DTO's captured binding is.
 */
export function summarizeResult(
  stages: readonly ResearchPilotStageRow[],
  dto: ScienceFlowRunSnapshotDto | null,
): ResearchPilotResult | null {
  if (!stages.length && dto === null) return null;
  const candidate = dto?.tasks[0]?.candidate ?? null;
  const selectedStageId = candidate?.stageId ?? null;
  const selectedStage = selectedStageId
    ? stages.find((stage) => stage.stageId === selectedStageId)
    : undefined;
  // Only a captured stage binding can present a metric as selected. An
  // engine-*reported* metric without a candidate binding is not a selection.
  const selectedMetric = candidate?.metric
    ? { name: candidate.metric.metricName, value: candidate.metric.metricValue }
    : selectedStage
      ? { name: selectedStage.metricName, value: selectedStage.metricValue }
      : null;
  const seed = stages.at(0);
  const newest = stages.at(-1);
  let conclusion: string;
  if (!seed || !newest) {
    conclusion = "The engine captured no stage for this run; the snapshot has no selected stage.";
  } else if (selectedStageId === null) {
    conclusion = `The engine recorded ${stages.length} captured stages, but the snapshot binds no candidate; no stage is presented as selected.`;
  } else if (stages.length === 1) {
    conclusion = `The engine captured one stage (${seed.stageId}); there is no new model-produced candidate to compare.`;
  } else if (seed.metricName === newest.metricName) {
    const direction = newest.metricValue - seed.metricValue;
    conclusion = `The engine captured ${stages.length} stages: seed ${seed.stageId} ${seed.metricValue}, new ${newest.stageId} ${newest.metricValue} (${direction >= 0 ? "+" : ""}${direction}).`;
  } else {
    conclusion = `The engine captured ${stages.length} stages; their metric names differ, so no comparison is made.`;
  }
  return {
    stages,
    selectedStageId,
    selectedMetric,
    selectedArtifactSha256: candidate?.sha256 ?? selectedStage?.artifactSha256 ?? null,
    digestVerified: candidate?.digestVerified ?? null,
    conclusion,
  };
}

/**
 * The fixed program the operator runs: the engine's own control entry, not a
 * reimplementation. It starts the run, polls the engine record, stops through
 * the engine's own path at the allowance, and prints one JSON document. The
 * program is a constant here, like the Runner's fixed bridge text: no option,
 * manifest or configuration file can replace it.
 */
export const RESEARCH_PILOT_LAUNCHER_PROGRAM = String.raw`
import json, os, sys, time
from pathlib import Path

PROTOCOL = 1

def emit(payload):
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()

def process_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        state = Path("/proc/%d/stat" % pid).read_text().split()[2]
    except (OSError, IndexError):
        return True
    return state != "Z"

def main():
    if len(sys.argv) != 4:
        emit({"protocol": PROTOCOL, "outcome": "invalid-arguments"})
        return 2
    manifest, run_id, allowance = sys.argv[1], sys.argv[2], float(sys.argv[3])
    from scienceflow.runtime.parallel.control import get_run, start_run, stop_run
    started = time.time()
    try:
        record = start_run(manifest)
    except Exception as error:
        emit({"protocol": PROTOCOL, "outcome": "launch-failed",
              "error": {"type": type(error).__name__, "message": str(error)[:500]}})
        return 1
    supervisor = int(record.get("pid") or 0)
    failure = None
    stop = None
    state = record
    while True:
        elapsed = time.time() - started
        try:
            state = get_run(run_id)
        except Exception as error:
            failure = {"type": type(error).__name__, "message": str(error)[:500]}
            break
        status = str(state.get("status"))
        if status in {"completed", "failed", "stopped"}:
            break
        if status == "interrupted" or (
            not state.get("alive") and status in {"starting", "running", "stopping"}
        ):
            failure = {"type": "SupervisorNotAlive", "message": "status=%s" % status}
            break
        if elapsed >= allowance:
            try:
                stop = stop_run(run_id, timeout=30)
            except Exception as error:
                stop = {"error": {"type": type(error).__name__, "message": str(error)[:300]}}
            break
        time.sleep(2)
    try:
        final = get_run(run_id)
    except Exception:
        final = state
    emit({
        "protocol": PROTOCOL,
        "outcome": "observation-failed" if failure else "finished",
        "runId": run_id,
        "supervisorPid": supervisor,
        "status": final.get("status"),
        "phase": final.get("phase"),
        "researchStatus": final.get("research_status"),
        "reportStatus": final.get("report_status"),
        "elapsedSec": round(time.time() - started, 1),
        "supervisorAliveAfterFinish": process_alive(supervisor),
        "stoppedByAllowance": stop is not None,
        "stop": stop,
        "error": failure,
        "record": final,
    })
    return 0 if final.get("status") == "completed" else 1

sys.exit(main())
`;

/**
 * Start the real engine managed run as a detached supervisor and observe it.
 * The launcher makes no model call; research and reporting run inside the
 * engine. A wedged launcher is killed at the allowance plus a grace period, and
 * the engine's own budget still bounds the run.
 */
export const launchManagedRun: ResearchPilotLauncher = async (input) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.XDG_STATE_HOME = input.stateHome;
  env.PYTHONPATH = input.engineCheckout;
  env.PYTHONDONTWRITEBYTECODE = "1";
  if (input.proxyUrl) {
    env.http_proxy = input.proxyUrl;
    env.https_proxy = input.proxyUrl;
    env.HTTP_PROXY = input.proxyUrl;
    env.HTTPS_PROXY = input.proxyUrl;
  } else {
    for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      delete env[key];
    }
  }
  if (input.noInstallPathPrefix) {
    env.PATH = `${input.noInstallPathPrefix}:${env.PATH ?? ""}`;
  }
  const child = spawn(
    input.pythonExecutable,
    ["-P", "-c", RESEARCH_PILOT_LAUNCHER_PROGRAM, input.manifestPath, input.runId, String(input.totalAllowanceSec)],
    { cwd: input.workDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 1_048_576) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_096);
  });
  const deadline = (input.totalAllowanceSec + 120) * 1_000;
  let spawnError: string | undefined;
  const timedOut = await new Promise<boolean>((done) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => settle(true), deadline);
    child.once("error", (error: Error) => {
      spawnError = error.message;
      settle(false);
    });
    child.once("exit", () => settle(false));
  });
  if (timedOut) child.kill("SIGKILL");
  return parseLauncherOutput(stdout, stderr, timedOut, spawnError);
};

/** Map the launcher's one JSON document onto the outcome. */
export function parseLauncherOutput(
  stdout: string,
  stderr: string,
  timedOut: boolean,
  spawnError?: string,
): ResearchPilotLaunchOutcome {
  let payload: unknown;
  for (const line of stdout.split("\n").map((value) => value.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const candidate = JSON.parse(line) as unknown;
      if (isRecord(candidate) && candidate.protocol === 1) {
        payload = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  const stderrTail = stderr.trim() ? stderr.trim().slice(-2_000) : undefined;
  if (!isRecord(payload)) {
    // A spawn error means the process never ran, so the engine cannot have
    // started. Without one the launcher may have died after `start_run`, so the
    // outcome is unknown rather than a confirmed non-start.
    return {
      outcome: timedOut ? "observation-timeout" : spawnError ? "launch-failed" : "observation-failed",
      ...(stderrTail ? { stderrTail } : {}),
      error: {
        type: timedOut ? "LauncherTimeout" : spawnError ? "LauncherSpawnFailed" : "LauncherProtocolError",
        message: timedOut
          ? "The launcher exceeded the allowance plus grace; the engine budget still bounds the run"
          : (spawnError ?? "The launcher did not report a usable outcome"),
      },
    };
  }
  const error = isRecord(payload.error)
    ? {
        type: typeof payload.error.type === "string" ? payload.error.type : "Error",
        message: typeof payload.error.message === "string" ? payload.error.message : "",
      }
    : undefined;
  return {
    outcome: timedOut
      ? "observation-timeout"
      : payload.outcome === "finished" || payload.outcome === "observation-failed"
        ? payload.outcome
        : "launch-failed",
    ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}),
    ...(typeof payload.researchStatus === "string" ? { researchStatus: payload.researchStatus } : {}),
    ...(typeof payload.reportStatus === "string" ? { reportStatus: payload.reportStatus } : {}),
    ...(typeof payload.supervisorPid === "number" ? { supervisorPid: payload.supervisorPid } : {}),
    ...(typeof payload.supervisorAliveAfterFinish === "boolean"
      ? { supervisorAliveAfterFinish: payload.supervisorAliveAfterFinish }
      : {}),
    ...(typeof payload.elapsedSec === "number" ? { elapsedSec: payload.elapsedSec } : {}),
    ...(payload.stoppedByAllowance === true ? { stoppedByAllowance: true } : {}),
    ...(error ? { error } : {}),
    ...(isRecord(payload.record) ? { record: payload.record } : {}),
    ...(stderrTail ? { stderrTail } : {}),
  };
}

/** Refuse package installation in the run as an environment fact, not a prompt. */
async function writeInstallRefusalShims(workDir: string): Promise<string> {
  const directory = join(workDir, "noinstall", "bin");
  await mkdir(directory, { recursive: true });
  const script = [
    "#!/bin/sh",
    "# Research pilot control: package installation is not authorized for this run.",
    'echo "package installation is disabled for this pilot run" >&2',
    "exit 1",
    "",
  ].join("\n");
  for (const name of ["pip", "pip3", "uv"]) {
    const path = join(directory, name);
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }
  return directory;
}

function modelAlias(selection: ResearchPilotModelSelection): string {
  const slug = selection.providerModel
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `sd-${slug || "model"}`;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

/** True when `candidate` is `parent` itself or lies below it. */
function isInside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, JSON.stringify(value, null, 2) + "\n");
}

async function writePrivateText(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/** Minimal RFC 4180 reader for the engine's stage ledger. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value !== ""));
}
