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
 * Experimental local research from a normal Session conversation.
 *
 * One accepted start request becomes one durable operation and one real
 * ScienceFlow managed run. The run is started through the same pilot code an
 * operator used (`runResearchPilot`): the Session's effective model, the
 * administrator's engine/interpreter/task profile and the fixed seed are frozen
 * before launch, and registration/readback reuse the existing services. When the
 * engine reaches a terminal outcome the operation automatically publishes the
 * selected stage and every captured attempt as ordinary Session artifacts
 * (`deliverScienceFlowResult`), so retrying a delivery never restarts research.
 *
 * Boundaries this module keeps:
 * - it is not the formal Runner execution plan: `canStart=false` and its
 *   blockers are untouched, and nothing here claims a sandbox;
 * - the conversation supplies research intent and fixed Artifact version ids
 *   only; host paths, interpreter, endpoint, credential and the pinned task text
 *   come from administrator configuration and the Session. The profile declares
 *   which seed file carries each fixed input, and a named version is accepted
 *   only when its content is byte-identical to that file — never linked to a run
 *   that executed different bytes;
 * - the operation record keeps host paths so a rebuilt service can observe the
 *   same run, but no Agent-visible view carries them;
 * - a run whose state cannot be read is reported `unknown`, never relaunched.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import type { ArtifactOrigin, ArtifactOriginMeta, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type {
  ReadScienceFlowRunSnapshotOptions,
  ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";

import {
  deliverScienceFlowResult,
  writeDeliveryRecord,
  type ScienceFlowResultDeliveryRecord,
  type ScienceFlowResultDeliveryRequest,
} from "./result-delivery.js";
import {
  SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES,
  type ScienceFlowLocalResearchSettings,
} from "./local-research-config.js";
import {
  composeDynamicTaskText,
  InputPreparationRefusal,
  sha256,
  stageResearchOperationInputs,
  type StagedDataSelection,
  type StagedInputSelection,
} from "./local-research-inputs.js";
import {
  TaskPreparationRefusal,
  composeTaskInstruction,
  describeCatalogTask,
  isUsableTaskId,
  listCatalogTasks,
  probePreparedEvaluator,
  taskSummary,
  type PreparedTaskInputBinding,
  type ScienceFlowCatalogTask,
  type ScienceFlowCatalogTaskDescription,
  type ScienceFlowTaskBinding,
  type TaskPreparationSettings,
} from "./local-research-task.js";
import {
  materializePreparedTaskAssets,
  prepareResearchTask,
  preparedTaskBinding,
  readPreparedTaskVersion,
  type PrepareTaskInput,
  type PreparedTaskPublication,
} from "./local-research-task-service.js";
import type { PreparedTaskValidationStore } from "./local-research-task-repository.js";
import {
  publishResearchPlan,
  ResearchPlanRefusal,
  type ResearchPlanPublication,
  type ResearchPlanStore,
} from "./research-plan-publication.js";
import {
  isTerminalResearchState,
  SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION,
  type ScienceFlowLocalResearchArtifactRef,
  type ScienceFlowLocalResearchDelivery,
  type ScienceFlowLocalResearchEngineFacts,
  type ScienceFlowLocalResearchGrant,
  type ScienceFlowLocalResearchInput,
  type ScienceFlowLocalResearchInputRole,
  type ScienceFlowLocalResearchOperation,
  type ScienceFlowLocalResearchStage,
  type ScienceFlowLocalResearchState,
  type ScienceFlowLocalResearchStop,
  type ScienceFlowLocalResearchUsage,
} from "./local-research-record.js";
import type { ScienceFlowLocalResearchStore } from "./local-research-repository.js";
import {
  readStageRows,
  readUsage,
  resolveResearchPilotModel,
  ResearchPilotRefusal,
  runResearchPilot,
  type ResearchPilotLauncher,
  type ResearchPilotReadbackStore,
  type ResearchPilotReceipt,
} from "./research-pilot.js";

/** Engine lifecycle states after which a run never continues on its own. */
const TERMINAL_ENGINE_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);

/** A bounded wait polls the engine record at this interval. */
const OBSERVE_POLL_MS = 2_000;
/** How long one stop request waits for the engine to record termination. */
const STOP_CONFIRM_TIMEOUT_MS = 30_000;
/** The engine's own stop call deadline; the confirmation poll outlasts it. */
const ENGINE_STOP_TIMEOUT_SEC = 20;

/** The stable permission resource a start request is governed under. */
export const LOCAL_RESEARCH_PERMISSION_RESOURCE = "scienceflow:local-research";

export type LocalResearchRefusalReason =
  | "mode-disabled"
  | "project-not-found"
  | "session-not-found"
  | "session-not-writable"
  | "unsupported-model"
  | "invalid-option"
  | "operation-not-found"
  | "operation-identity-mismatch"
  | "link-version-not-found"
  | "link-not-supported"
  | "link-version-mismatch"
  | "link-version-unreadable"
  | "link-version-missing"
  | "configured-input-unavailable"
  | "conversation-cancelled"
  | "staging-conflict"
  | "staging-failed"
  | "staging-unsafe"
  | "staging-too-large"
  | "staging-bytes-mismatch"
  | "task-text-invalid"
  | "model-selection-changed"
  | "plan-text-invalid"
  | "plan-not-found"
  | "plan-version-mismatch"
  | "plan-publication-failed"
  | "continuation-task-mismatch"
  | "continuation-provenance-unknown";

/** A refusal with a stable reason; messages never carry a credential or path. */
export class LocalResearchRefusal extends Error {
  readonly reason: LocalResearchRefusalReason;
  constructor(reason: LocalResearchRefusalReason, message: string) {
    super(message);
    this.name = "LocalResearchRefusal";
    this.reason = reason;
  }
}

/** The store surface this service uses. `SessionStore` satisfies it. */
export interface LocalResearchServiceStore extends ResearchPilotReadbackStore {
  readonly scienceFlowResearchOperations: ScienceFlowLocalResearchStore;
  /** The trusted preflight record a prepared task version must match. */
  readonly scienceFlowPreparedTaskValidations: PreparedTaskValidationStore;
  readonly dataDir: string;
  /** The owning conversation run's status, used to refuse a late launch. */
  readonly getSessionRun?: (
    sessionId: string,
    runId: string,
  ) => Promise<{ readonly status: string } | undefined>;
  readonly getProjectArtifactVersion: (projectId: string, versionId: string) => {
    readonly artifactId: string;
    readonly content: { readonly hash: string; readonly size: number };
    readonly id: string;
    readonly sessionId?: string;
    readonly version: number;
  } | undefined;
  readonly getProjectArtifact: (projectId: string, artifactId: string) => {
    readonly createdInSessionId?: string;
    readonly currentVersion: number;
    readonly deletedAt?: string;
    readonly id: string;
    readonly kind: string;
    readonly logicalName?: string;
    readonly name?: string;
    readonly origin?: string;
    readonly originMeta?: ArtifactOriginMeta;
  } | undefined;
  /** The plan-publication surface: the same catalog the artifact tools write. */
  readonly getArtifactByName: ResearchPlanStore["getArtifactByName"];
  readonly listProjectArtifactVersions: ResearchPlanStore["listProjectArtifactVersions"];
  readonly createArtifactVersion: (input: {
    readonly artifactId?: string;
    readonly baseVersionId?: string;
    readonly content: { readonly hash: string; readonly size: number };
    readonly description?: string;
    readonly forceNewArtifact?: boolean;
    readonly kind: "json" | "markdown" | "other";
    readonly logicalName: string;
    readonly mediaType: string;
    readonly origin?: ArtifactOrigin;
    readonly originMeta?: ArtifactOriginMeta;
    readonly sessionId: string;
    readonly title?: string;
  }) => Promise<{
    readonly artifact: ScientificArtifact;
    readonly version: ScientificArtifactVersion;
  }>;
}

export interface LocalResearchStartInput {
  readonly projectId: string;
  readonly sessionId: string;
  /** The conversation run that owns this experiment. */
  readonly ownerRunId: string;
  readonly intent: string;
  readonly planVersionId?: string;
  readonly incumbentVersionId?: string;
  /** Task-dynamic mode: a registered engine task package to run. */
  readonly taskPackageId?: string;
  /** Task-dynamic mode: a Session-prepared task contract version to run. */
  readonly taskVersionId?: string;
  /** Task-dynamic + catalog: ordinary Session data versions bound as input. */
  readonly inputVersionIds?: readonly string[];
  /** The tool's abort signal: a cancelled conversation must not reach a launch. */
  readonly signal?: AbortSignal;
}

/** A task-contract preparation request authored by the Agent. */
export type LocalResearchTaskPrepareInput = PrepareTaskInput;

export interface LocalResearchPlanInput {
  readonly projectId: string;
  readonly sessionId: string;
  /** The conversation run whose Agent authored the text (provenance only). */
  readonly runId: string;
  readonly content: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly artifactId?: string;
  readonly baseVersionId?: string;
  /** The tool call that authored this text; makes a retry resolve to one version. */
  readonly publicationId?: string;
  readonly signal?: AbortSignal;
}

export interface LocalResearchOperationInput {
  readonly projectId: string;
  readonly sessionId: string;
  /** Omitted means "the latest operation for this Session". */
  readonly operationId?: string;
}

/** The public, credential- and path-free operation view an Agent may read. */
export interface ScienceFlowLocalResearchView {
  readonly operationId: string;
  readonly engineRunId: string;
  readonly task: string;
  readonly intent: string;
  readonly state: ScienceFlowLocalResearchState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly planVersionId: string | null;
  readonly incumbentVersionId: string | null;
  /** The task identity this operation actually ran, when one was selected. */
  readonly taskIdentity?: {
    readonly source: "catalog" | "prepared";
    readonly taskId: string;
    readonly title: string;
    readonly taskVersionId: string | null;
    readonly metricName: string;
    readonly metricType: string;
    /** Dotted stdout path of the metric; null for a package evaluator. */
    readonly metricJsonPath: string | null;
    readonly lowerIsBetter: boolean | null;
    readonly authoritative: boolean;
    readonly artifactPath: string;
    readonly artifactKind: string;
    readonly evaluatorKind: "task-package" | "generated-command";
    readonly evaluatorSha256: string | null;
    readonly summary: string;
  };
  readonly inputMode: "fixed" | "dynamic";
  /** The fixed input bytes this run used, including the verified version id. */
  readonly inputs: readonly ScienceFlowLocalResearchInput[];
  readonly model: { readonly profileName: string; readonly providerModel: string; readonly selectionSource: string } | null;
  readonly grant: ScienceFlowLocalResearchGrant;
  readonly engine: ScienceFlowLocalResearchEngineFacts;
  readonly stages: readonly ScienceFlowLocalResearchStage[];
  readonly usage: ScienceFlowLocalResearchUsage | null;
  readonly delivery: ScienceFlowLocalResearchDelivery;
  readonly stop: ScienceFlowLocalResearchStop;
  readonly error: { readonly step: string; readonly message: string } | null;
  /** True for this experimental local mode; never a sandbox guarantee. */
  readonly experimentalLocalExecution: true;
  readonly formalRunnerSandbox: false;
  readonly instruction: string;
}

export interface LocalResearchStartOutcome {
  readonly operation: ScienceFlowLocalResearchView;
  readonly attached: boolean;
  readonly attachedReason?: "same-request" | "active-operation";
}

export interface LocalResearchStopOutcome {
  readonly operation: ScienceFlowLocalResearchView;
  readonly requested: boolean;
  readonly confirmed: boolean;
  /** Present when stop was not requested because the run already ended. */
  readonly reason?: "already-terminal";
}

export interface LocalResearchServiceDependencies {
  /** The real detached-supervisor launcher; tests substitute one. */
  readonly launch?: ResearchPilotLauncher;
  /** The real delivery; tests substitute one. */
  readonly deliver?: (
    store: LocalResearchServiceStore,
    request: ScienceFlowResultDeliveryRequest,
    dependencies: { readonly now?: () => string },
  ) => Promise<ScienceFlowResultDeliveryRecord>;
  /** Passed to the existing snapshot query during readback; tests substitute one. */
  readonly readSnapshot?: (
    options: ReadScienceFlowRunSnapshotOptions,
  ) => Promise<ScienceFlowSnapshotReadResult>;
  /** Reads a Session artifact version's CAS bytes; tests substitute one. */
  readonly readArtifactBytes?: (hash: string) => Promise<Buffer>;
  /** The owning conversation run's status; tests substitute one. */
  readonly ownerRunStatus?: (sessionId: string, runId: string) => Promise<string | undefined>;
  readonly now?: () => string;
  readonly newOperationId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The real task-catalog adapter; tests substitute a stub. */
  readonly listTasks?: typeof listCatalogTasks;
  /** The real task-description adapter; tests substitute a stub. */
  readonly describeTask?: typeof describeCatalogTask;
  /** The real evaluator probe; tests substitute a stub. */
  readonly probeTask?: typeof probePreparedEvaluator;
}

export interface LocalResearchService {
  readonly enabled: true;
  readonly profileId: string;
  readonly permissionResource: string;
  /** `fixed` unless the administrator enabled Session-supplied inputs. */
  readonly inputMode: "fixed" | "dynamic";
  readonly incumbentMode: "none" | "optional" | "required";
  /** `fixed` unless the administrator enabled conversation-chosen tasks. */
  readonly taskMode: "fixed" | "task-dynamic";
  /** Upper bound for one bounded observation wait a tool may request. */
  readonly observeMaxWaitMs: number;
  /** The engine's registered task packages. Task-dynamic mode only. */
  listTasks(input: { readonly projectId: string; readonly sessionId: string }): Promise<readonly ScienceFlowCatalogTask[]>;
  /** Prepare a new task contract version from a scientific objective. */
  prepareTask(input: LocalResearchTaskPrepareInput): Promise<PreparedTaskPublication>;
  start(input: LocalResearchStartInput): Promise<LocalResearchStartOutcome>;
  get(
    input: LocalResearchOperationInput,
    options?: { readonly waitMs?: number; readonly signal?: AbortSignal },
  ): Promise<ScienceFlowLocalResearchView>;
  stop(input: LocalResearchOperationInput): Promise<LocalResearchStopOutcome>;
  retryDelivery(input: LocalResearchOperationInput): Promise<ScienceFlowLocalResearchView>;
  /** Publish plan text the Agent authored as an ordinary Session artifact version. */
  publishPlan(input: LocalResearchPlanInput): Promise<ResearchPlanPublication>;
  /** Conversation cancellation: request stop for the run's owned experiments. */
  requestStopForConversationRun(sessionId: string, runId: string): Promise<void>;
  latest(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation | undefined;
  /** The Session's operations as public views, oldest first. */
  list(projectId: string, sessionId: string): readonly ScienceFlowLocalResearchView[];
}

/**
 * Build the service over one administrator profile. Constructing it touches no
 * file and starts no process; a start still resolves the Session and re-checks
 * its write gate before anything is written.
 */
export function createLocalResearchService(input: {
  readonly store: LocalResearchServiceStore;
  readonly settings: ScienceFlowLocalResearchSettings;
}, dependencies: LocalResearchServiceDependencies = {}): LocalResearchService {
  const { store, settings } = input;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const newOperationId = dependencies.newOperationId ?? (() => randomUUID());
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deliver = dependencies.deliver ?? ((target, request, deps) => deliverScienceFlowResult(
    target as unknown as Parameters<typeof deliverScienceFlowResult>[0],
    request,
    deps,
  ));
  const readArtifactBytes = dependencies.readArtifactBytes
    ?? ((hash: string) => new CasStore(store.dataDir).read(hash));
  const ownerRunStatus = dependencies.ownerRunStatus ?? (async (sessionId: string, runId: string) => {
    if (!store.getSessionRun) return undefined;
    return (await store.getSessionRun(sessionId, runId))?.status;
  });
  /** Operations whose launch/observe/deliver worker is alive in this process. */
  const activeWorkers = new Set<string>();
  /** Operations with a delivery attempt in flight in this process. */
  const deliveryInFlight = new Set<string>();
  /** Per-operation abort for the preparation window before a launch exists. */
  const operationAborts = new Map<string, AbortController>();

  const operations = (): ScienceFlowLocalResearchStore => store.scienceFlowResearchOperations;

  const mutate = (
    operationId: string,
    change: (current: ScienceFlowLocalResearchOperation) => ScienceFlowLocalResearchOperation,
  ): ScienceFlowLocalResearchOperation => {
    const current = operations().get(operationId);
    if (!current) throw new LocalResearchRefusal("operation-not-found", "The research operation does not exist");
    const next = { ...change(current), updatedAt: now() };
    operations().update(next);
    return next;
  };

  const resolveRecord = (request: LocalResearchOperationInput): ScienceFlowLocalResearchOperation => {
    if (!store.getProject(request.projectId)) {
      throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
    }
    const session = store.getSession(request.sessionId);
    if (!session || session.projectId !== request.projectId) {
      throw new LocalResearchRefusal("session-not-found", "The Session does not exist in this Project");
    }
    const rows = operations().listForSession(request.projectId, request.sessionId);
    const record = request.operationId
      ? rows.find((candidate) => candidate.operationId === request.operationId)
      : [...rows].reverse().find((candidate) => !isTerminalResearchState(candidate.state)) ?? rows.at(-1);
    if (!record) {
      throw new LocalResearchRefusal("operation-not-found", "This Session has no research operation to observe");
    }
    if (record.identity.projectId !== request.projectId || record.identity.sessionId !== request.sessionId) {
      // The lookup is already Session-scoped; keep the guard explicit so a future
      // lookup change cannot retarget another Session.
      throw new LocalResearchRefusal("operation-identity-mismatch", "The research operation belongs to another Session");
    }
    return record;
  };

  const pilotRequest = (record: ScienceFlowLocalResearchOperation) => ({
    projectId: record.identity.projectId,
    sessionId: record.identity.sessionId,
    runId: record.engineRunId,
    workDir: record.workDir,
    privateRoot: record.launch.privateRoot,
    engineCheckout: record.launch.engineCheckout,
    pythonExecutable: record.launch.pythonExecutable,
    readerScriptPath: record.launch.readerScriptPath,
    // A dynamic operation reads the directory it staged itself; a fixed one
    // reads the administrator's seed, exactly as before.
    seedDir: record.stagedInputs?.dataDir ?? record.launch.seedDir,
    task: record.task,
    ...(record.taskBinding?.source === "prepared" && record.taskBinding.assetDir !== undefined
      && record.taskBinding.lowerIsBetter !== null
      ? { evaluator: {
          artifactKind: record.taskBinding.artifactKind,
          artifactPath: record.taskBinding.artifactPath,
          commandPath: join(record.taskBinding.assetDir, "evaluator.py"),
          lowerIsBetter: record.taskBinding.lowerIsBetter,
          metricJsonPath: record.taskBinding.metricJsonPath ?? "metric",
          metricName: record.taskBinding.metricName,
          pythonExecutable: record.launch.pythonExecutable,
          timeoutSec: 120,
        } }
      : {}),
    ...(record.launch.taskDescription !== undefined
      ? { taskDescription: record.launch.taskDescription }
      : settings.taskDescription
        ? { taskDescription: settings.taskDescription }
        : {}),
    researchBudgetSec: record.launch.grant.researchBudgetSec,
    reportBudgetSec: record.launch.grant.reportBudgetSec,
    totalAllowanceSec: record.launch.grant.totalAllowanceSec,
    maxSteps: record.launch.grant.maxSteps,
    stageCaptureMax: record.launch.grant.stageCaptureMax,
    bashTimeoutSec: record.launch.grant.bashTimeoutSec,
    codeMaxTokens: record.launch.grant.codeMaxTokens,
    feedbackMaxTokens: record.launch.grant.feedbackMaxTokens,
    httpTimeoutSec: record.launch.grant.httpTimeoutSec,
    refusePackageInstall: record.launch.grant.refusePackageInstall,
    receiptPath: record.receiptPath,
  });

  const readEngineFacts = async (record: ScienceFlowLocalResearchOperation): Promise<ScienceFlowLocalResearchEngineFacts> => {
    const controlPath = join(record.workDir, "state", "scienceflow", "managed_runs", record.engineRunId, "control.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(controlPath, "utf8"));
    } catch {
      return { observedAt: now() };
    }
    if (!isRecord(parsed)) return { observedAt: now() };
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
      ...(typeof parsed.research_status === "string" ? { researchStatus: parsed.research_status } : {}),
      ...(typeof parsed.report_status === "string" ? { reportStatus: parsed.report_status } : {}),
      ...(typeof parsed.alive === "boolean" ? { alive: parsed.alive } : {}),
      ...(typeof parsed.pid === "number" ? { supervisorPid: parsed.pid } : {}),
      observedAt: now(),
    };
  };

  /** The receipt's own outcome status, when a receipt exists. Never a run id. */
  const readReceiptOutcome = async (record: ScienceFlowLocalResearchOperation): Promise<string | undefined> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(record.receiptPath, "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || !isRecord(parsed.outcome)) return undefined;
    return typeof parsed.outcome.status === "string" ? parsed.outcome.status : undefined;
  };

  const readProgress = async (record: ScienceFlowLocalResearchOperation): Promise<{    readonly stages: readonly ScienceFlowLocalResearchStage[];
    readonly usage: ScienceFlowLocalResearchUsage | null;
  }> => {
    const taskRoot = join(record.workDir, "runs", record.engineRunId, record.task);
    const [rows, usage] = await Promise.all([
      readStageRows(join(taskRoot, "task_logs", "lhr_stage_performance.csv")),
      readUsage(join(taskRoot, "workers", "w00", "logs", "agent_runtime_audit", "agent_provider_calls.jsonl")),
    ]);
    return {
      stages: rows.map((row) => ({
        stageId: row.stageId,
        parentStageId: row.parentStageId,
        metricName: row.metricName,
        metricValue: row.metricValue,
        artifactSha256: row.artifactSha256,
        validationOk: row.validationOk,
        gateAccepted: row.gateAccepted,
        evaluatorStatus: row.evaluatorStatus,
        createdAtUtc: row.createdAtUtc,
      })),
      usage,
    };
  };

  const stateFromFacts = (
    record: ScienceFlowLocalResearchOperation,
    facts: ScienceFlowLocalResearchEngineFacts,
    outcome?: string,
    launch?: ResearchPilotReceipt["launch"],
  ): ScienceFlowLocalResearchState => {
    if (record.stop.requestedAt && facts.status === "stopped") return "stopped";
    if (facts.status === "completed") return "completed";
    if (facts.status === "failed") return "failed";
    if (facts.status === "stopped") return "stopped";
    // The engine's launcher reports an interrupted run as an observation
    // failure; it is a terminal run that did not complete, not a live one.
    if (facts.status === "interrupted") return "failed";
    // `launch-unknown` means whether the engine started cannot be told from the
    // launcher. It stays unknown (and is never relaunched) until an engine
    // record is observed and reconciles it.
    if (outcome === "launch-unknown" || outcome === "run-already-exists") return "unknown";
    if (outcome === "completed") return "completed";
    if (outcome === "launch-failed" || outcome === "invalid-option" || outcome === "configuration-refused") return "failed";
    if (outcome === "registration-failed" || outcome === "readback-failed") {
      // The engine run ended; only the control-plane readback step failed.
      // Delivery performs its own registration/readback, so keep the research
      // state truthful and let publication be retried.
      return "completed";
    }
    if (outcome === "observation-failed") {
      if (launch?.stoppedByAllowance || launch?.status === "stopped") return "stopped";
      return "failed";
    }
    return record.state;
  };

  const applyReceipt = (
    record: ScienceFlowLocalResearchOperation,
    receipt: ResearchPilotReceipt,
  ): ScienceFlowLocalResearchOperation => {
    const launch = receipt.launch;
    const facts: ScienceFlowLocalResearchEngineFacts = {
      ...(typeof launch?.status === "string" ? { status: launch.status } : {}),
      ...(typeof launch?.phase === "string" ? { phase: launch.phase } : {}),
      ...(typeof launch?.researchStatus === "string" ? { researchStatus: launch.researchStatus } : {}),
      ...(typeof launch?.reportStatus === "string" ? { reportStatus: launch.reportStatus } : {}),
      ...(typeof launch?.supervisorPid === "number" ? { alive: launch.supervisorAliveAfterFinish, supervisorPid: launch.supervisorPid } : {}),
      observedAt: now(),
    };
    const model = receipt.model
      ? {
          profileName: receipt.model.profileName,
          providerModel: receipt.model.providerModel,
          selectionSource: receipt.model.selectionSource,
        }
      : record.launch.model;
    const outcome = receipt.outcome;
    return {
      ...record,
      state: stateFromFacts(record, facts, receipt.outcome.status, receipt.launch),
      engine: facts,
      launch: { ...record.launch, model },
      progress: {
        stages: (receipt.result?.stages ?? []).map((stage) => ({
          stageId: stage.stageId,
          parentStageId: stage.parentStageId,
          metricName: stage.metricName,
          metricValue: stage.metricValue,
          artifactSha256: stage.artifactSha256,
          validationOk: stage.validationOk,
          gateAccepted: stage.gateAccepted,
          evaluatorStatus: stage.evaluatorStatus,
          createdAtUtc: stage.createdAtUtc,
        })),
        usage: receipt.usage,
        observedAt: now(),
      },
      ...(outcome.status === "completed"
        ? {}
        : {
            error: {
              step: outcome.failedStep ?? "launch",
              message: outcome.message ?? outcome.reason ?? outcome.status,
            },
          }),
    };
  };

  const deliveryState = (
    record: ScienceFlowLocalResearchOperation,
    delivered: ScienceFlowResultDeliveryRecord,
  ): ScienceFlowLocalResearchDelivery => {
    const previous = record.delivery;
    const attempts = previous.attempts + 1;
    if (delivered.outcome.status === "delivered" && delivered.selected) {
      const solution = delivered.artifacts.solution
        ? artifactRef(delivered.artifacts.solution, "solution")
        : undefined;
      const note = delivered.artifacts.note ? artifactRef(delivered.artifacts.note, "note") : undefined;
      const staged = delivered.attempts.flatMap((attempt) => attempt.artifact
        ? [{
            ...artifactRef(attempt.artifact, attempt.role),
            metricName: attempt.metricName,
            metricValue: attempt.metricValue,
          }]
        : []);
      const researcher = delivered.researcherRecords.flatMap((entry) => entry.artifact
        ? [artifactRef(entry.artifact, "researcher_record")]
        : []);
      return {
        state: "delivered",
        attempts,
        updatedAt: now(),
        selectedStageId: delivered.selected.stageId,
        metricName: delivered.selected.metricName,
        metricValue: delivered.selected.metricValue,
        lowerIsBetter: delivered.selected.lowerIsBetter,
        ...(solution ? { solution } : {}),
        ...(note ? { note } : {}),
        ...(staged.length ? { staged } : {}),
        ...(researcher.length ? { researcher } : {}),
      };
    }
    const failure = delivered.outcome;
    if (failure.status === "failed" && failure.failedStep === "resolve" && failure.reason === "no-candidate") {
      return { state: "no-candidate", attempts, updatedAt: now(), reason: failure.reason, message: failure.message };
    }
    const failed: ScienceFlowLocalResearchDelivery = failure.status === "failed"
      ? {
          state: "failed",
          attempts,
          updatedAt: now(),
          reason: failure.reason,
          failedStep: failure.failedStep,
          message: failure.message,
        }
      : { state: "failed", attempts, updatedAt: now(), message: "Delivery returned no outcome" };
    // A retry that fails after a successful publication keeps the delivered
    // versions visible; the new failure is recorded beside them, not on top.
    if (previous.state === "delivered") {
      return { ...previous, attempts, updatedAt: now(), lastError: failed.reason ?? failed.message };
    }
    return failed;
  };

  const deliverOperation = async (operationId: string, force = false): Promise<void> => {
    if (deliveryInFlight.has(operationId)) return;
    deliveryInFlight.add(operationId);
    try {
      const record = operations().get(operationId);
      if (!record) return;
      // A retry may republish (delivery itself is idempotent by content), but an
      // automatic pass never re-publishes an already delivered result.
      if (!force && record.delivery.state === "delivered") return;
      const delivered = await deliver(store, {
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
        runId: record.engineRunId,
        workDir: record.workDir,
        pythonExecutable: record.launch.pythonExecutable,
        readerScriptPath: record.launch.readerScriptPath,
        task: record.task,
        ...(record.taskBinding
          ? {
              evaluatorAuthority: record.taskBinding.source === "prepared" ? "generated-command" as const : "task-package" as const,
              taskSummary: record.taskBinding.summary,
              ...(record.taskBinding.source === "prepared" && record.taskBinding.evaluator.kind === "generated-command"
                ? { evaluatorSha256: record.taskBinding.evaluator.sha256 }
                : {}),
            }
          : {}),
        ...(record.planVersionId ? { planVersionId: record.planVersionId } : {}),
        ...(record.incumbentVersionId ? { incumbentVersionId: record.incumbentVersionId } : {}),
        includeAttempts: true,
        includeResearcherRecords: true,
        recordPath: record.deliveryRecordPath,
        launchReceiptPath: record.receiptPath,
        // This deployment started the run; the note must not claim otherwise.
        runOrigin: "experimental-local",
      }, { now });
      // The operation record is authoritative; this file is the same delivery
      // record the operator command writes, kept for local evidence.
      await writeDeliveryRecord(record.deliveryRecordPath, delivered).catch(() => undefined);
      mutate(operationId, (current) => ({ ...current, delivery: deliveryState(current, delivered) }));
    } catch (error) {
      mutate(operationId, (current) => ({
        ...current,
        delivery: {
          state: "failed",
          attempts: current.delivery.attempts + 1,
          updatedAt: now(),
          reason: "publication-failed",
          message: errorMessage(error),
        },
      }));
    } finally {
      deliveryInFlight.delete(operationId);
    }
  };

  /**
   * Stage this operation's own input directory, if the profile uses dynamic
   * inputs. The staged bytes are proven equal to the digests frozen at start, and
   * the manifest is written beside the work dir so the engine's dataset holds
   * only the assets and the selected plan/incumbent.
   *
   * Returns the updated record, or `undefined` when preparation failed or was
   * abandoned: the caller must not launch in that case.
   */
  const stageInputs = async (
    record: ScienceFlowLocalResearchOperation,
    signal: AbortSignal,
  ): Promise<ScienceFlowLocalResearchOperation | undefined> => {
    const roles: StagedInputSelection[] = (record.inputs ?? []).flatMap((input) =>
      input.stagedName !== undefined && input.versionId !== null
        ? [{
            role: input.role,
            sha256: input.sha256,
            size: input.size,
            stagedName: input.stagedName,
            versionId: input.versionId,
          }]
        : []);
    // A selected or prepared task may bind ordinary Session data files; they are
    // staged beside the plan and incumbent so the engine's dataset holds exactly
    // the bytes this operation froze.
    const data: StagedDataSelection[] = (record.taskBinding?.inputs ?? []).map((binding) => ({
      logicalName: binding.logicalName,
      sha256: binding.sha256,
      size: binding.size,
      versionId: binding.versionId,
    }));
    const destination = join(record.workDir, "input");
    const manifestPath = join(record.workDir, "input-manifest.json");
    try {
      if (roles.length === 0 && data.length === 0) {
        throw new InputPreparationRefusal("staging-failed", "This operation has no accepted input to stage");
      }
      // The operation's own work dir may not exist yet; the input directory
      // itself is created non-recursively so a second staging attempt (or
      // another operation's leftovers) is a conflict, not a silent overwrite.
      await mkdir(record.workDir, { recursive: true, mode: 0o755 });
      const staged = await stageResearchOperationInputs({
        assetsDir: settings.seedDir,
        destination,
        readBytes: readArtifactBytes,
        roles,
        ...(data.length ? { data } : {}),
        signal,
      }, now);
      await writeFile(manifestPath, staged.manifestJson, "utf8");
      // Re-read the manifest so the recorded digest is the digest on disk.
      const written = await readFile(manifestPath);
      if (sha256(written) !== staged.manifestSha256) {
        throw new InputPreparationRefusal("staging-failed", "The input manifest did not retain its bytes");
      }
      return mutate(record.operationId, (current) => ({
        ...current,
        stagedInputs: {
          dataDir: destination,
          entries: staged.manifest.assets.entries,
          manifestPath,
          manifestSha256: staged.manifestSha256,
          stagedAt: staged.manifest.stagedAt,
          totalBytes: staged.manifest.assets.totalBytes,
        },
      }));
    } catch (error) {
      if (signal.aborted) {
        // A cancel landed during preparation: record the stop, never launch.
        mutate(record.operationId, (current) => ({
          ...current,
          state: isTerminalResearchState(current.state) ? current.state : "stopped",
          stop: current.stop.requestedAt
            ? current.stop
            : { ...current.stop, requestedAt: now(), requestedBy: "conversation-cancel" },
        }));
        return undefined;
      }
      // Every reason below is actionable: the record says the operation was
      // accepted and never launched, and why. A stop that landed during the
      // failure keeps its stopped state instead of becoming a failure.
      mutate(record.operationId, (current) => current.stop.requestedAt
        ? { ...current, state: isTerminalResearchState(current.state) ? current.state : "stopped" }
        : {
            ...current,
            state: "failed",
            error: {
              step: "staging",
              message: error instanceof InputPreparationRefusal
                ? `${error.reason}: ${error.message}`
                : errorMessage(error),
            },
          });
      return undefined;
    }
  };

  /**
   * Freeze a prepared task's evaluator and contract into this operation's own
   * directory. The contract body is re-read and its digest must equal the one
   * frozen at start, so a task version edited after acceptance cannot change
   * what this run executes.
   */
  const stageTaskAssets = async (
    record: ScienceFlowLocalResearchOperation,
  ): Promise<ScienceFlowLocalResearchOperation | undefined> => {
    const binding = record.taskBinding;
    if (!binding || binding.source !== "prepared") return record;
    if (binding.assetDir !== undefined) return record;
    if (binding.taskVersionId === undefined || binding.contractHash === undefined) {
      mutate(record.operationId, (current) => ({
        ...current,
        state: "failed",
        error: { step: "task", message: "The prepared task version is incomplete" },
      }));
      return undefined;
    }
    try {
      const assets = await materializePreparedTaskAssets(store, { readBytes: readArtifactBytes }, {
        contractHash: binding.contractHash,
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
        targetDir: join(record.workDir, "task"),
        taskVersionId: binding.taskVersionId,
      });
      return mutate(record.operationId, (current) => ({
        ...current,
        taskBinding: {
          ...binding,
          assetDir: join(record.workDir, "task"),
          assetManifestSha256: assets.manifestSha256,
        },
      }));
    } catch (error) {
      mutate(record.operationId, (current) => ({
        ...current,
        state: "failed",
        error: { step: "task", message: errorMessage(error) },
      }));
      return undefined;
    }
  };

  /** The model the Session resolves to must still be the one this start froze. */
  const frozenModelRefusal = (record: ScienceFlowLocalResearchOperation): string | undefined => {
    const frozen = record.launch.model;
    if (!frozen) return undefined;
    let resolved;
    try {
      resolved = resolveResearchPilotModel(store, {
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
      });
    } catch (error) {
      return error instanceof ResearchPilotRefusal ? error.message : errorMessage(error);
    }
    const mismatch = resolved.selection.providerModel !== frozen.providerModel
      || resolved.selection.selectionSource !== frozen.selectionSource
      || resolved.selection.profileName !== frozen.profileName;
    return mismatch
      ? "The Session's effective model changed after this operation was accepted; it was not launched"
      : undefined;
  };

  /** The background worker: prepare, launch-and-observe, then one delivery. */
  const execute = async (operationId: string): Promise<void> => {
    activeWorkers.add(operationId);
    const controller = new AbortController();
    operationAborts.set(operationId, controller);
    try {
      let current = operations().get(operationId);
      if (!current) return;
      // A stop requested before the launch began must not be overtaken by one.
      if (current.stop.requestedAt) {
        mutate(operationId, (record) => ({ ...record, state: "stopped" }));
        return;
      }
      // Cancellation can land between the tool's post-permission check and this
      // worker: when the owning run already ended by cancellation there is no
      // one left to read a result, so record the stop instead of launching.
      if (await ownerStopped(current.identity.sessionId, current.ownerRunId)) {
        mutate(operationId, (record) => ({
          ...record,
          state: "stopped",
          stop: record.stop.requestedAt
            ? record.stop
            : { ...record.stop, requestedAt: now(), requestedBy: "conversation-cancel" },
        }));
        return;
      }
      if (settings.inputMode === "dynamic") {
        const staged = await stageInputs(current, controller.signal);
        if (!staged) return;
        current = staged;
        // Preparation is asynchronous: the session may have been cancelled or
        // the run stopped while the bytes were staged, with no worker left to
        // read a result. Re-check both before the launch.
        if (current.stop.requestedAt) {
          mutate(operationId, (record) => ({ ...record, state: "stopped" }));
          return;
        }
        if (await ownerStopped(current.identity.sessionId, current.ownerRunId)) {
          mutate(operationId, (record) => ({
            ...record,
            state: "stopped",
            stop: record.stop.requestedAt
              ? record.stop
              : { ...record.stop, requestedAt: now(), requestedBy: "conversation-cancel" },
          }));
          return;
        }
        const modelRefusal = frozenModelRefusal(current);
        if (modelRefusal !== undefined) {
          mutate(operationId, (record) => ({
            ...record,
            state: "failed",
            error: { step: "model-selection", message: modelRefusal },
          }));
          return;
        }
        const withAssets = await stageTaskAssets(current);
        if (!withAssets) return;
        current = withAssets;
      }
      mutate(operationId, (record) => ({ ...record, state: "running" }));
      const receipt = await runResearchPilot(store, pilotRequest(current), {
        ...(dependencies.launch ? { launch: dependencies.launch } : {}),
        ...(dependencies.readSnapshot ? { readSnapshot: dependencies.readSnapshot } : {}),
        now,
      });
      mutate(operationId, (record) => ({
        ...applyReceipt(record, receipt),
        ...(record.stop.requestedAt && receipt.launch?.status === "stopped"
          ? { stop: { ...record.stop, confirmedAt: now(), engineStatus: "stopped" } }
          : {}),
      }));
      // Only a launch that produced an engine run leaves something to read
      // back. A confirmed non-start is reported as a failure without delivery.
      if (receipt.outcome.engineRunId !== null) await deliverOperation(operationId);
    } catch (error) {
      mutate(operationId, (record) => ({
        ...record,
        state: "failed",
        error: { step: "launch", message: errorMessage(error) },
      }));
    } finally {
      operationAborts.delete(operationId);
      activeWorkers.delete(operationId);
    }
  };

  const nextInstruction = (record: ScienceFlowLocalResearchOperation): string => {
    if (record.state === "stopped" && record.stop.requestedAt && record.engine.status === undefined) {
      return "The run was stopped before the engine produced a record; nothing was evaluated and there is nothing to deliver. Report that truthfully.";
    }
    if (record.stop.requestedAt && !record.stop.confirmedAt && !isTerminalResearchState(record.state)) {
      return "A stop was requested for this research run but the engine has not confirmed termination. Call get_research again to observe; do not start another run.";
    }
    if (!isTerminalResearchState(record.state)) {
      return `The research run is still in progress (${record.engine.status ?? record.state}). Call get_research with wait_seconds to keep observing; do not call start_research again for this experiment.`;
    }
    if (record.delivery.state === "delivered") {
      return "The run ended and its artifacts are delivered in this Session. Read the delivered result note and solution with read_artifact, then answer the user with what was tested, the actual evaluated result and the conclusion this run supports.";
    }
    if (record.delivery.state === "no-candidate") {
      return "The run ended without a captured candidate, so there is nothing to deliver. Report that truthfully; do not present a score or a selected solution.";
    }
    if (record.delivery.state === "failed") {
      return `Result delivery failed (${record.delivery.reason ?? "publication-failed"}). Call get_research with action retry_delivery to publish again; this does not rerun the research.`;
    }
    return "The run ended but delivery has not completed yet. Call get_research again to observe the delivery state.";
  };

  const view = (record: ScienceFlowLocalResearchOperation): ScienceFlowLocalResearchView => ({
    operationId: record.operationId,
    engineRunId: record.engineRunId,
    task: record.task,
    intent: record.intent,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    planVersionId: record.planVersionId ?? null,
    incumbentVersionId: record.incumbentVersionId ?? null,
    ...(record.taskBinding
      ? { taskIdentity: {
          artifactKind: record.taskBinding.artifactKind,
          artifactPath: record.taskBinding.artifactPath,
          authoritative: record.taskBinding.authoritative,
          evaluatorKind: record.taskBinding.evaluator.kind,
          evaluatorSha256: record.taskBinding.evaluator.kind === "generated-command"
            ? record.taskBinding.evaluator.sha256
            : null,
          lowerIsBetter: record.taskBinding.lowerIsBetter,
          metricJsonPath: record.taskBinding.metricJsonPath ?? null,
          metricName: record.taskBinding.metricName,
          metricType: record.taskBinding.metricType,
          source: record.taskBinding.source,
          summary: record.taskBinding.summary,
          taskId: record.taskBinding.taskId,
          taskVersionId: record.taskBinding.taskVersionId ?? null,
          title: record.taskBinding.title,
        } }
      : {}),
    inputMode: record.launch.inputMode ?? "fixed",
    inputs: record.inputs ?? [],
    model: record.launch.model,
    grant: record.launch.grant,
    engine: record.engine,
    stages: record.progress.stages,
    usage: record.progress.usage,
    delivery: record.delivery,
    stop: record.stop,
    error: record.error ?? null,
    experimentalLocalExecution: true,
    formalRunnerSandbox: false,
    instruction: nextInstruction(record),
  });

  const idempotencyKey = (request: LocalResearchStartInput): string => createHash("sha256")
    .update(JSON.stringify({
      incumbentVersionId: request.incumbentVersionId ?? null,
      inputVersionIds: request.inputVersionIds ?? [],
      intent: request.intent,
      ownerRunId: request.ownerRunId,
      planVersionId: request.planVersionId ?? null,
      projectId: request.projectId,
      sessionId: request.sessionId,
      taskPackageId: request.taskPackageId ?? null,
      taskVersionId: request.taskVersionId ?? null,
    }))
    .digest("hex");

  const assertLinkVersion = (
    sessionId: string,
    projectId: string,
    versionId: string,
    label: string,
  ): NonNullable<ReturnType<LocalResearchServiceStore["getProjectArtifactVersion"]>> => {
    const version = store.getProjectArtifactVersion(projectId, versionId);
    const artifact = version ? store.getProjectArtifact(projectId, version.artifactId) : undefined;
    if (!version || !artifact || artifact.deletedAt || artifact.createdInSessionId !== sessionId) {
      throw new LocalResearchRefusal(
        "link-version-not-found",
        `The ${label} version is not a live artifact version of this Session`,
      );
    }
    return version;
  };

  /**
   * Read one configured fixed input file and return its digest. The file is the
   * bytes the pilot's manifest will hand to the engine, so this is what a
   * selected Session version must match.
   */
  const readConfiguredInput = async (
    role: ScienceFlowLocalResearchInputRole,
    path: string,
  ): Promise<{ readonly sha256: string; readonly size: number }> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new LocalResearchRefusal(
        "configured-input-unavailable",
        `This research profile's configured ${role} input could not be read`,
      );
    }
    if (bytes.length > SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES) {
      throw new LocalResearchRefusal(
        "configured-input-unavailable",
        `This research profile's configured ${role} input is too large`,
      );
    }
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  };

  /** Read and verify one linked version's CAS bytes. */
  const readLinkedInput = async (
    role: ScienceFlowLocalResearchInputRole,
    version: NonNullable<ReturnType<LocalResearchServiceStore["getProjectArtifactVersion"]>>,
  ): Promise<{ readonly sha256: string; readonly size: number }> => {
    let bytes: Buffer;
    try {
      bytes = await readArtifactBytes(version.content.hash);
    } catch {
      throw new LocalResearchRefusal(
        "link-version-unreadable",
        `The ${role} version's content could not be read`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== version.content.hash || bytes.length !== version.content.size) {
      throw new LocalResearchRefusal(
        "link-version-unreadable",
        `The ${role} version's content does not match its recorded digest`,
      );
    }
    return { sha256: digest, size: bytes.length };
  };

  /**
   * Bind the accepted request to the bytes the engine will actually receive.
   *
   * Fixed mode accepts a named version only when the profile declares that role
   * and the version's content is byte-identical to the configured seed file; a
   * start never runs the old seed while linking a different version to it.
   *
   * Dynamic mode requires a live same-Session version for each supplied role
   * (and always for the plan). An optional incumbent may be omitted on a first
   * run. Every supplied version still passes the same ownership and CAS checks,
   * freezing its verified digest and staging name: the bytes are then staged into
   * this operation's own directory, so a later version, profile edit or rebuild
   * cannot change what runs.
   */
  const resolveInputs = async (
    request: LocalResearchStartInput,
  ): Promise<readonly ScienceFlowLocalResearchInput[]> => {
    const dynamic = settings.dynamicInputs;
    const named: Partial<Record<ScienceFlowLocalResearchInputRole, string>> = {
      ...(request.planVersionId ? { plan: request.planVersionId } : {}),
      ...(request.incumbentVersionId ? { incumbent: request.incumbentVersionId } : {}),
    };
    if (dynamic) {
      const inputs: ScienceFlowLocalResearchInput[] = [];
      for (const role of ["plan", "incumbent"] as const) {
        const stagedName = dynamic[role];
        if (stagedName === undefined) {
          // A named version for a role this profile does not stage would be
          // silently ignored, so it is refused instead.
          if (named[role]) {
            throw new LocalResearchRefusal(
              "link-not-supported",
              `This research profile does not stage a ${role} input`,
            );
          }
          continue;
        }
        const versionId = named[role];
        if (!versionId) {
          if (role === "incumbent" && dynamic.incumbentOptional === true) continue;
          throw new LocalResearchRefusal(
            "link-version-missing",
            `This research profile runs ${role === "plan" ? "a plan" : "an incumbent"} you select; pass its version id`,
          );
        }
        const version = assertLinkVersion(request.sessionId, request.projectId, versionId, role);
        const actual = await readLinkedInput(role, version);
        inputs.push({ role, sha256: actual.sha256, size: actual.size, stagedName, versionId });
      }
      return inputs;
    }
    const bindings = settings.inputs ?? {};
    const inputs: ScienceFlowLocalResearchInput[] = [];
    for (const role of ["plan", "incumbent"] as const) {
      const configured = bindings[role];
      const versionId = named[role];
      if (versionId) {
        if (!configured) {
          throw new LocalResearchRefusal(
            "link-not-supported",
            `This research profile runs a fixed experiment and does not accept a ${role} version`,
          );
        }
        const version = assertLinkVersion(request.sessionId, request.projectId, versionId, role);
        const actual = await readLinkedInput(role, version);
        const expected = await readConfiguredInput(role, configured);
        if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
          throw new LocalResearchRefusal(
            "link-version-mismatch",
            `The ${role} version is not this research profile's configured ${role} input`,
          );
        }
        inputs.push({ role, sha256: actual.sha256, size: actual.size, versionId });
      } else if (configured) {
        const expected = await readConfiguredInput(role, configured);
        inputs.push({ role, sha256: expected.sha256, size: expected.size, versionId: null });
      }
    }
    return inputs;
  };

  /** True when the owning conversation run was cancelled or interrupted. */
  const ownerStopped = async (sessionId: string, runId: string): Promise<boolean> => {
    const status = await ownerRunStatus(sessionId, runId);
    return status === "cancelled" || status === "interrupted";
  };

  /** The engine adapter settings; present only when the profile enables task choice. */
  const preparation: TaskPreparationSettings | undefined = settings.taskMode === "task-dynamic"
    ? {
        engineCheckout: settings.engineCheckout,
        preparationScriptPath: settings.preparationScriptPath!,
        probeTimeoutSec: settings.evaluatorProbeTimeoutSec ?? 60,
        pythonExecutable: settings.pythonExecutable,
      }
    : undefined;

  const requireTaskDynamic = (): TaskPreparationSettings => {
    if (!preparation) {
      throw new LocalResearchRefusal(
        "invalid-option",
        "This research profile runs one fixed administrator task; it does not accept a task choice",
      );
    }
    return preparation;
  };

  /** Both task-intake reads prove the caller's identity before any engine call. */
  const assertSessionIdentity = (projectId: string, sessionId: string): void => {
    if (!store.getProject(projectId)) {
      throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
    }
    const session = store.getSession(sessionId);
    if (!session || session.projectId !== projectId) {
      throw new LocalResearchRefusal("session-not-found", "The Session does not exist in this Project");
    }
  };

  /**
   * Bind ordinary Session artifact versions as task input data. Every version is
   * checked to belong to this Session and its bytes are re-hashed, so the input
   * the task contract records is the input the run later stages.
   */
  const resolveDataInputs = async (
    projectId: string,
    sessionId: string,
    versionIds: readonly string[] | undefined,
  ): Promise<readonly PreparedTaskInputBinding[]> => {
    const bindings: PreparedTaskInputBinding[] = [];
    for (const versionId of versionIds ?? []) {
      if (bindings.length >= 16) {
        throw new LocalResearchRefusal("invalid-option", "Too many task input versions");
      }
      const version = store.getProjectArtifactVersion(projectId, versionId);
      const artifact = version ? store.getProjectArtifact(projectId, version.artifactId) : undefined;
      // An upload in this Session may append a version to an artifact first
      // created by an earlier Session in the same Project. The data is still this
      // Session's bytes, so either the artifact or the version may establish
      // ownership; a version created elsewhere is refused.
      const ownsArtifact = artifact !== undefined && artifact.deletedAt === undefined
        && artifact.createdInSessionId === sessionId;
      const ownsVersion = version !== undefined && version.sessionId === sessionId;
      if (!version || !artifact || artifact.deletedAt || (!ownsArtifact && !ownsVersion)) {
        throw new LocalResearchRefusal(
          "link-version-not-found",
          "A task input is not a live artifact version of this Session",
        );
      }
      const logicalName = (artifact?.logicalName ?? "").split("/").at(-1) ?? "";
      if (!logicalName || bindings.some((binding) => binding.logicalName === logicalName)) {
        throw new LocalResearchRefusal("invalid-option", "Two task inputs would be staged under the same name");
      }
      const bytes = await readArtifactBytes(version.content.hash).catch(() => undefined);
      if (!bytes) {
        throw new LocalResearchRefusal("link-version-unreadable", "A task input version is unreadable");
      }
      if (sha256(bytes) !== version.content.hash || bytes.length !== version.content.size) {
        throw new LocalResearchRefusal("link-version-unreadable", "A task input version no longer matches its digest");
      }
      bindings.push({ logicalName, sha256: version.content.hash, size: bytes.length, versionId: version.id });
    }
    return bindings;
  };

  interface TaskSelection {
    readonly binding: ScienceFlowTaskBinding;
    readonly objective: string;
    readonly prepared: boolean;
    readonly taskId: string;
  }

  /**
   * Resolve the task this operation runs. Fixed profiles keep their configured
   * task; task-dynamic profiles must name exactly one source and never fall back
   * to another task.
   */
  const resolveTaskSelection = async (
    request: LocalResearchStartInput,
  ): Promise<TaskSelection | undefined> => {
    const namedPackage = request.taskPackageId?.trim();
    const namedVersion = request.taskVersionId?.trim();
    if (!preparation) {
      if (namedPackage || namedVersion || (request.inputVersionIds?.length ?? 0) > 0) {
        throw new LocalResearchRefusal(
          "invalid-option",
          "This research profile runs one fixed administrator task; it does not accept task or input choices",
        );
      }
      return undefined;
    }
    if (!!namedPackage === !!namedVersion) {
      throw new LocalResearchRefusal(
        "invalid-option",
        "Name exactly one task: task_package_id for a registered task or task_version_id for a task prepared in this Session",
      );
    }
    if (namedPackage) {
      if (!isUsableTaskId(namedPackage)) {
        throw new LocalResearchRefusal("invalid-option", "The task package id is not a usable engine task name");
      }
      let described: ScienceFlowCatalogTaskDescription;
      try {
        described = await (dependencies.describeTask ?? describeCatalogTask)(preparation, namedPackage, request.signal);
      } catch (error) {
        throw new LocalResearchRefusal(
          "invalid-option",
          error instanceof TaskPreparationRefusal ? error.message : errorMessage(error),
        );
      }
      // A task whose evaluator cannot import its dependencies would launch a
      // long research run that can never score a candidate. Refuse at selection,
      // naming the missing modules, instead of failing after the paid run.
      if (described.missingModules.length > 0) {
        throw new LocalResearchRefusal(
          "invalid-option",
          `The task package '${described.id}' needs Python modules this deployment does not have: `
            + `${described.missingModules.join(", ")}. Install them in the engine environment before starting this task.`,
        );
      }
      const inputs = await resolveDataInputs(request.projectId, request.sessionId, request.inputVersionIds);
      const title = titleFromDescription(described.description, described.id);
      const binding: ScienceFlowTaskBinding = {
        artifactKind: described.artifactKind,
        artifactPath: described.artifactPath,
        authoritative: described.authoritative,
        evaluator: { entrypoint: described.evaluatorEntrypoint, kind: "task-package" },
        inputs,
        lowerIsBetter: described.lowerIsBetter,
        metricName: described.metricName,
        metricType: described.metricType,
        source: "catalog",
        summary: taskSummary(title, described.metricName, described.lowerIsBetter, false),
        taskId: described.id,
        title,
      };
      return { binding, objective: described.description, prepared: false, taskId: described.id };
    }
    if ((request.inputVersionIds?.length ?? 0) > 0) {
      throw new LocalResearchRefusal(
        "invalid-option",
        "A prepared task carries its own bound inputs; do not pass input_version_ids",
      );
    }
    const versionId = namedVersion!;
    assertLinkVersion(request.sessionId, request.projectId, versionId, "task");
    let read;
    try {
      read = await readPreparedTaskVersion(store, { readBytes: readArtifactBytes }, {
        projectId: request.projectId,
        sessionId: request.sessionId,
        versionId,
      });
    } catch (error) {
      throw new LocalResearchRefusal(
        "invalid-option",
        error instanceof TaskPreparationRefusal ? error.message : errorMessage(error),
      );
    }
    return {
      binding: preparedTaskBinding(read.contract, versionId, read.contractHash),
      objective: read.contract.objective,
      prepared: true,
      taskId: read.contract.taskId,
    };
  };

  /**
   * A candidate this deployment delivered belongs to the operation (and the
   * frozen task contract) that produced it. Continuing a different task from
   * that candidate would carry an old score and an incompatible artifact format
   * into a new scientific contract, so it is refused. A version with no
   * delivery provenance is an explicit initial seed and stays supported.
   */
  const assertContinuationCompatible = (
    request: LocalResearchStartInput,
    selection: TaskSelection | undefined,
  ): void => {
    const versionId = request.incumbentVersionId;
    if (!selection || !versionId) return;
    const version = store.getProjectArtifactVersion(request.projectId, versionId);
    if (!version) return;
    const artifact = store.getProjectArtifact(request.projectId, version.artifactId);
    const operationsInSession = operations().listForSession(request.projectId, request.sessionId);
    const references = (operation: ScienceFlowLocalResearchOperation): boolean => {
      const refs = [operation.delivery.solution, ...(operation.delivery.staged ?? [])];
      return refs.some((ref) => ref !== undefined && ref.versionId === version.id);
    };
    let source = operationsInSession.find(references);
    if (!source) {
      const meta = artifact?.originMeta;
      if (meta?.deliveredBy !== "scienceflow-result-delivery" || meta.externalEngine !== "scienceflow"
        || typeof meta.sourceRunId !== "string") {
        // No delivery provenance: an ordinary uploaded or authored candidate.
        return;
      }
      const sourceRunId = meta.sourceRunId;
      source = operationsInSession.find((operation) => operation.engineRunId === sourceRunId);
      if (!source) {
        throw new LocalResearchRefusal(
          "continuation-provenance-unknown",
          "The starting candidate carries delivery metadata for a run this Session has no record of",
        );
      }
    }
    const sourceBinding = source.taskBinding;
    const compatible = sourceBinding === undefined
      ? source.task === selection.binding.taskId
      : compatibleTaskContracts(sourceBinding, selection.binding);
    if (!compatible) {
      throw new LocalResearchRefusal(
        "continuation-task-mismatch",
        "The starting candidate was delivered by a different task contract. Start a new experiment without it, "
          + "or import it deliberately as a new baseline; it cannot continue this task's run.",
      );
    }
  };

  return {
    enabled: true,
    profileId: settings.profileId,
    permissionResource: LOCAL_RESEARCH_PERMISSION_RESOURCE,
    inputMode: settings.inputMode ?? "fixed",
    incumbentMode: settings.dynamicInputs?.incumbent !== undefined
      ? settings.dynamicInputs.incumbentOptional === true ? "optional" : "required"
      : settings.inputs?.incumbent !== undefined ? "required" : "none",
    taskMode: settings.taskMode ?? "fixed",
    observeMaxWaitMs: settings.defaults.observeMaxWaitMs,

    async listTasks(input): Promise<readonly ScienceFlowCatalogTask[]> {
      const adapter = requireTaskDynamic();
      assertSessionIdentity(input.projectId, input.sessionId);
      return await (dependencies.listTasks ?? listCatalogTasks)(adapter);
    },

    async prepareTask(input: LocalResearchTaskPrepareInput): Promise<PreparedTaskPublication> {
      const adapter = requireTaskDynamic();
      return await prepareResearchTask(store, input, {
        now,
        readBytes: readArtifactBytes,
        settings: adapter,
        tasksRoot: join(settings.workRoot, "tasks"),
        ...(dependencies.probeTask ? { probe: dependencies.probeTask } : {}),
      });
    },

    async start(request: LocalResearchStartInput): Promise<LocalResearchStartOutcome> {
      request.signal?.throwIfAborted();
      const intent = request.intent.trim();
      if (!intent || intent.length > 2_000 || intent.includes("\u0000")) {
        throw new LocalResearchRefusal("invalid-option", "The research intent must be 1-2000 characters without NUL bytes");
      }
      if (!store.getProject(request.projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(request.sessionId);
      if (!session || session.projectId !== request.projectId) {
        throw new LocalResearchRefusal("session-not-found", "The Session does not exist in this Project");
      }
      store.assertSessionWritable(request.sessionId);
      // Resolve the Session's effective model before anything is written, so an
      // unsupported profile refuses the request instead of failing the launch.
      // The credential-free selection is frozen in the operation record; the
      // pilot receipt records the model the launch actually used.
      let resolvedModel;
      try {
        resolvedModel = resolveResearchPilotModel(store, { projectId: request.projectId, sessionId: request.sessionId });
      } catch (error) {
        throw new LocalResearchRefusal(
          "unsupported-model",
          error instanceof ResearchPilotRefusal ? error.message : errorMessage(error),
        );
      }
      if (request.planVersionId) assertLinkVersion(request.sessionId, request.projectId, request.planVersionId, "plan");
      if (request.incumbentVersionId) {
        assertLinkVersion(request.sessionId, request.projectId, request.incumbentVersionId, "incumbent");
      }

      const key = idempotencyKey({ ...request, intent });
      const existing = operations().findByIdempotency(request.projectId, request.sessionId, key);
      if (existing) {
        return { attached: true, attachedReason: "same-request", operation: view(existing) };
      }
      // One conversation run owns at most one live experiment. A second start
      // that names different intent while the first is live attaches instead of
      // launching a second paid run; the user still has the one stop action.
      const active = operations()
        .listForSession(request.projectId, request.sessionId)
        .find((candidate) => candidate.ownerRunId === request.ownerRunId && !isTerminalResearchState(candidate.state));
      if (active) {
        return { attached: true, attachedReason: "active-operation", operation: view(active) };
      }
      // A start that arrives after its conversation run was cancelled must not
      // create an operation no cancel path owns any more.
      if (await ownerStopped(request.sessionId, request.ownerRunId)) {
        throw new LocalResearchRefusal(
          "conversation-cancelled",
          "The conversation run that would own this experiment was cancelled",
        );
      }
      request.signal?.throwIfAborted();
      // Resolve the task before the input binding: a task-dynamic profile must
      // run the task the conversation named, never its old default package, and
      // a named task this profile does not allow is refused before any read.
      const selection = await resolveTaskSelection(request);
      request.signal?.throwIfAborted();
      // Freeze the fixed input bytes this run will actually use, and prove a
      // named version is exactly that input before any record or launch exists.
      const inputs = await resolveInputs(request);
      assertContinuationCompatible(request, selection);
      const taskId = selection?.taskId ?? settings.task!;
      request.signal?.throwIfAborted();

      const operationId = newOperationId();
      const createdAt = now();
      const workDir = join(settings.workRoot, "operations", operationId);
      const planRole = inputs.find((input) => input.role === "plan");
      const incumbentRole = inputs.find((input) => input.role === "incumbent");
      // The researcher's instruction is composed from frozen facts: a selected
      // package's own description or a prepared contract's objective, plus the
      // plan and intent. A template problem refuses the start instead of
      // launching a run with an unfilled instruction.
      const taskDescription = selection
        ? composeTaskInstruction({
            artifactKind: selection.binding.artifactKind,
            artifactPath: selection.binding.artifactPath,
            authoritative: selection.binding.authoritative,
            ...(incumbentRole?.stagedName && incumbentRole.versionId
              ? { incumbentFile: incumbentRole.stagedName, incumbentVersionId: incumbentRole.versionId }
              : {}),
            inputFiles: selection.binding.inputs.map((binding) => binding.logicalName),
            intent,
            lowerIsBetter: selection.binding.lowerIsBetter,
            metricName: selection.binding.metricName,
            objective: selection.objective,
            operationId,
            planFile: settings.dynamicInputs?.plan ?? "experiment_plan.md",
            planVersionId: planRole?.versionId ?? request.planVersionId ?? "",
            prepared: selection.prepared,
            title: selection.binding.title,
          })
        : settings.inputMode === "dynamic"
          ? composeDynamicTaskText(settings.taskTemplate ?? "", {
              intent,
              operationId,
              roles: inputs.flatMap((input) =>
                input.stagedName === undefined || input.versionId === null
                  ? []
                  : [{
                      role: input.role,
                      sha256: input.sha256,
                      size: input.size,
                      stagedName: input.stagedName,
                      versionId: input.versionId,
                    }]),
            })
          : settings.taskDescription;
      const grant: ScienceFlowLocalResearchGrant = {
        task: taskId,
        researchBudgetSec: settings.defaults.researchBudgetSec,
        reportBudgetSec: settings.defaults.reportBudgetSec,
        totalAllowanceSec: settings.defaults.totalAllowanceSec,
        maxSteps: settings.defaults.maxSteps,
        stageCaptureMax: settings.defaults.stageCaptureMax,
        bashTimeoutSec: settings.defaults.bashTimeoutSec,
        codeMaxTokens: settings.defaults.codeMaxTokens,
        feedbackMaxTokens: settings.defaults.feedbackMaxTokens,
        httpTimeoutSec: settings.defaults.httpTimeoutSec,
        refusePackageInstall: settings.refusePackageInstall,
        taskDescriptionPinned: taskDescription !== undefined,
      };
      const record: ScienceFlowLocalResearchOperation = {
        schemaVersion: SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION,
        operationId,
        idempotencyKey: key,
        identity: { projectId: request.projectId, sessionId: request.sessionId },
        ownerRunId: request.ownerRunId,
        intent,
        ...(request.planVersionId ? { planVersionId: request.planVersionId } : {}),
        ...(request.incumbentVersionId ? { incumbentVersionId: request.incumbentVersionId } : {}),
        ...(inputs.length ? { inputs } : {}),
        ...(selection ? { taskBinding: selection.binding } : {}),
        createdAt,
        updatedAt: createdAt,
        state: "accepted",
        engineRunId: `sd-research-${operationId.slice(0, 12)}`,
        task: taskId,
        workDir,
        receiptPath: join(workDir, "receipt.json"),
        deliveryRecordPath: join(workDir, "delivery.json"),
        launch: {
          profileId: settings.profileId,
          engineCheckout: settings.engineCheckout,
          pythonExecutable: settings.pythonExecutable,
          readerScriptPath: settings.readerScriptPath,
          seedDir: settings.seedDir,
          privateRoot: join(settings.privateRoot, operationId),
          model: {
            profileName: resolvedModel.selection.profileName,
            providerModel: resolvedModel.selection.providerModel,
            selectionSource: resolvedModel.selection.selectionSource,
          },
          grant,
          ...(settings.inputMode === "dynamic" ? { inputMode: "dynamic" as const } : {}),
          ...(taskDescription === undefined ? {} : { taskDescription }),
        },
        engine: {},
        progress: { stages: [], usage: null },
        delivery: { state: "pending", attempts: 0, updatedAt: createdAt },
        stop: {},
      };
      const stored = operations().createIfAbsent(record);
      if (!stored.created) {
        return { attached: true, attachedReason: "same-request", operation: view(stored.record) };
      }
      // Return the operation identity now; the engine run continues in the
      // background so one HTTP request or tool call is not held open for it.
      void execute(operationId).catch(() => undefined);
      return { attached: false, operation: view(stored.record) };
    },

    async get(request, options = {}): Promise<ScienceFlowLocalResearchView> {
      let record = resolveRecord(request);
      const waitMs = Math.max(0, Math.min(settings.defaults.observeMaxWaitMs, Math.trunc(options.waitMs ?? 0)));
      const deadline = Date.now() + waitMs;
      while (true) {
        options.signal?.throwIfAborted();
        // Re-read before observing: the launch worker may have advanced this
        // operation since the previous poll, and its state is authoritative.
        record = operations().get(record.operationId) ?? record;
        const facts = await readEngineFacts(record);
        const progress = await readProgress(record);
        // With no engine record, the receipt is the only local record of how the
        // launch ended. It is read, never trusted as a run identity.
        const receiptOutcome = facts.status === undefined ? await readReceiptOutcome(record) : undefined;
        // The state is derived against the record as it stands at write time:
        // the reads above are asynchronous, and a stale snapshot must not
        // overwrite a state the worker recorded while they were in flight.
        record = mutate(record.operationId, (current) => {
          let derived = stateFromFacts(current, facts, receiptOutcome);
          if (derived === current.state && facts.status === undefined
            && !activeWorkers.has(current.operationId)
            && (current.state === "accepted" || current.state === "running")) {
            // The process that was launching this experiment is gone and the
            // engine left no record: the outcome is unknown, not a silent relaunch.
            derived = "unknown";
          }
          return {
            ...current,
            state: derived,
            engine: facts,
            progress: { ...progress, observedAt: now() },
          };
        });
        if (isTerminalResearchState(record.state)) {
          // An existing terminal run is read back, never relaunched. Delivery is
          // the only step this observation may reconcile, and only when the
          // engine left a record whose stages can actually be read.
          if (facts.status !== undefined && !activeWorkers.has(record.operationId)
            && record.delivery.state === "pending") {
            await deliverOperation(record.operationId);
            record = operations().get(record.operationId) ?? record;
          }
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(OBSERVE_POLL_MS, Math.max(0, deadline - Date.now())));
      }
      return view(record);
    },

    async stop(request): Promise<LocalResearchStopOutcome> {
      const record = resolveRecord(request);
      const facts = await readEngineFacts(record);
      if (facts.status && TERMINAL_ENGINE_STATUSES.has(facts.status)) {
        const updated = mutate(record.operationId, (current) => ({
          ...current,
          state: stateFromFacts(current, facts),
          engine: facts,
        }));
        return { confirmed: true, operation: view(updated), reason: "already-terminal", requested: false };
      }
      const requestedAt = now();
      mutate(record.operationId, (current) => ({
        ...current,
        state: current.state === "completed" || current.state === "failed" ? current.state : "stopping",
        stop: { ...current.stop, requestedAt, requestedBy: "tool" },
      }));
      // A stop during the preparation window must abort the staging copy rather
      // than let a launch follow it.
      operationAborts.get(record.operationId)?.abort();
      const outcome = await stopEngineRun(record);
      const confirmed = await confirmStop(record, sleep);
      const updated = mutate(record.operationId, (current) => ({
        ...current,
        state: confirmed ? "stopped" : current.state,
        engine: { ...current.engine, ...(confirmed ? { status: "stopped" } : {}) },
        stop: {
          ...current.stop,
          ...(confirmed ? { confirmedAt: now(), engineStatus: "stopped" } : {}),
          ...(outcome.error ? { lastError: outcome.error } : {}),
        },
      }));
      return { confirmed, operation: view(updated), requested: true };
    },

    async retryDelivery(request): Promise<ScienceFlowLocalResearchView> {
      const record = resolveRecord(request);
      // Publication only: the experiment's identity and state are untouched.
      // A delivered result is republished idempotently (unchanged bytes reuse
      // their version) so a corrected note can reach the Session.
      await deliverOperation(record.operationId, true);
      return view(operations().get(record.operationId) ?? record);
    },

    async requestStopForConversationRun(sessionId: string, runId: string): Promise<void> {
      const session = store.getSession(sessionId);
      if (!session) return;
      const owned = operations()
        .listForSession(session.projectId, sessionId)
        .filter((candidate) => candidate.ownerRunId === runId && !isTerminalResearchState(candidate.state));
      for (const record of owned) {
        try {
          // Trip the preparation abort even when no engine record exists yet: a
          // cancel that lands while the operation is staging must not launch.
          operationAborts.get(record.operationId)?.abort();
          const facts = await readEngineFacts(record);
          if (facts.status && TERMINAL_ENGINE_STATUSES.has(facts.status)) continue;
          mutate(record.operationId, (current) => ({
            ...current,
            stop: { ...current.stop, requestedAt: now(), requestedBy: "conversation-cancel" },
          }));
          await stopEngineRun(record);
        } catch {
          // Cancellation is best effort: a failed stop leaves the recorded
          // request visible instead of failing the conversation cancellation.
        }
      }
    },

    async publishPlan(request: LocalResearchPlanInput): Promise<ResearchPlanPublication> {
      request.signal?.throwIfAborted();
      try {
        return await publishResearchPlan(store, {
          projectId: request.projectId,
          sessionId: request.sessionId,
          runId: request.runId,
          content: request.content,
          ...(request.name ? { name: request.name } : {}),
          ...(request.title ? { title: request.title } : {}),
          ...(request.description ? { description: request.description } : {}),
          ...(request.artifactId ? { artifactId: request.artifactId } : {}),
          ...(request.baseVersionId ? { baseVersionId: request.baseVersionId } : {}),
          ...(request.publicationId ? { publicationId: request.publicationId } : {}),
        });
      } catch (error) {
        if (error instanceof ResearchPlanRefusal) {
          throw new LocalResearchRefusal(
            error.reason === "invalid-option"
              ? "plan-text-invalid"
              : error.reason === "session-not-found"
                ? "session-not-found"
                : error.reason === "session-not-writable"
                  ? "session-not-writable"
                  : error.reason,
            error.message,
          );
        }
        throw error;
      }
    },

    latest(projectId: string, sessionId: string): ScienceFlowLocalResearchOperation | undefined {
      const rows = operations().listForSession(projectId, sessionId);
      return [...rows].reverse().find((candidate) => !isTerminalResearchState(candidate.state)) ?? rows.at(-1);
    },

    list(projectId: string, sessionId: string): readonly ScienceFlowLocalResearchView[] {
      if (!store.getProject(projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(sessionId);
      if (!session || session.projectId !== projectId) {
        throw new LocalResearchRefusal("session-not-found", "This Session is not in the given Project");
      }
      return operations().listForSession(projectId, sessionId).map(view);
    },
  };
}

/** A package description's first heading is a usable title; otherwise its id is. */
function titleFromDescription(description: string, taskId: string): string {
  const heading = description.split("\n", 20)
    .map((line) => line.trim())
    .find((line) => /^#\s+\S/u.test(line));
  if (!heading) return taskId;
  return heading.replace(/^#\s+/u, "").slice(0, 200) || taskId;
}

/**
 * Two operations run the same scientific contract only when the task, artifact
 * contract, metric, evaluator identity and bound input bytes all agree. A
 * re-prepared task (new contract version or digest) is a new experiment even
 * when its title or slug matches.
 */
function compatibleTaskContracts(source: ScienceFlowTaskBinding, target: ScienceFlowTaskBinding): boolean {
  if (source.source !== target.source || source.taskId !== target.taskId) return false;
  if (source.artifactPath !== target.artifactPath || source.artifactKind !== target.artifactKind) return false;
  if (source.metricName !== target.metricName || source.lowerIsBetter !== target.lowerIsBetter) return false;
  if (source.source === "prepared" && source.contractHash !== target.contractHash) return false;
  const left = source.evaluator;
  const right = target.evaluator;
  if (left.kind !== right.kind) return false;
  if (left.kind === "generated-command" && right.kind === "generated-command" && left.sha256 !== right.sha256) {
    return false;
  }
  if (left.kind === "task-package" && right.kind === "task-package" && left.entrypoint !== right.entrypoint) {
    return false;
  }
  return source.inputs.length === target.inputs.length && source.inputs.every((binding, index) => {
    const other = target.inputs[index];
    return other !== undefined && binding.logicalName === other.logicalName && binding.sha256 === other.sha256;
  });
}

function artifactRef(  artifact: {
    readonly artifactId: string;
    readonly logicalName: string;
    readonly version: number;
    readonly versionId: string;
  },
  role: ScienceFlowLocalResearchArtifactRef["role"],
): ScienceFlowLocalResearchArtifactRef {
  return {
    artifactId: artifact.artifactId,
    logicalName: artifact.logicalName,
    role,
    version: artifact.version,
    versionId: artifact.versionId,
  };
}

/** Stop the engine's own managed run; the command reaches only this run id. */
async function stopEngineRun(record: ScienceFlowLocalResearchOperation): Promise<{ readonly error?: string }> {
  const child = spawn(
    record.launch.pythonExecutable,
    ["-P", "-c", LOCAL_RESEARCH_STOP_PROGRAM, record.engineRunId, String(ENGINE_STOP_TIMEOUT_SEC)],
    {
      cwd: record.workDir,
      env: {
        ...process.env,
        PYTHONPATH: record.launch.engineCheckout,
        PYTHONDONTWRITEBYTECODE: "1",
        XDG_STATE_HOME: join(record.workDir, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 65_536) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  const completed = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), (ENGINE_STOP_TIMEOUT_SEC + 20) * 1_000);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
  if (!completed) {
    child.kill("SIGKILL");
    return { error: "The engine stop command did not finish in time" };
  }
  for (const line of stdout.split("\n").map((value) => value.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const payload = JSON.parse(line) as unknown;
      if (!isRecord(payload) || payload.protocol !== 1) continue;
      if (isRecord(payload.error)) {
        const message = typeof payload.error.message === "string" ? payload.error.message : "The engine stop failed";
        return { error: message.slice(0, 300) };
      }
      return {};
    } catch {
      continue;
    }
  }
  return { error: stderr.trim() ? stderr.trim().slice(-300) : "The engine stop command reported no outcome" };
}

/** Poll the engine record for a short, bounded confirmation window. */
async function confirmStop(
  record: ScienceFlowLocalResearchOperation,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(
        join(record.workDir, "state", "scienceflow", "managed_runs", record.engineRunId, "control.json"),
        "utf8",
      ));
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && typeof parsed.status === "string" && TERMINAL_ENGINE_STATUSES.has(parsed.status)) {
      return true;
    }
    await sleep(OBSERVE_POLL_MS);
  }
  return false;
}

/**
 * The engine's own stop entry. It is a constant, like the pilot launcher: no
 * option or configuration can replace it, and it receives no credential.
 */
export const LOCAL_RESEARCH_STOP_PROGRAM = String.raw`
import json, sys
PROTOCOL = 1
def emit(payload):
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()
if len(sys.argv) != 3:
    emit({"protocol": PROTOCOL, "outcome": "invalid-arguments"})
    raise SystemExit(2)
run_id, timeout = sys.argv[1], float(sys.argv[2])
from scienceflow.runtime.parallel.control import stop_run
try:
    stop_run(run_id, timeout=timeout)
except Exception as error:
    emit({"protocol": PROTOCOL, "outcome": "error",
          "error": {"type": type(error).__name__, "message": str(error)[:300]}})
    raise SystemExit(1)
emit({"protocol": PROTOCOL, "outcome": "stopped"})
`;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
