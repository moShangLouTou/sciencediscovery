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
import type { ArtifactOrigin, ArtifactOriginMeta, ModelInvocationUsage, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";
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
  preparedTaskId,
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
import {
  contractGroupId,
  createResearchSelection,
  deriveResearchResultGroups,
  projectResearchParent,
  readEngineSourceIdentity,
  readExecutionEnvironment,
  type EngineSourceIdentity,
  type ExecutionEnvironmentIdentity,
  researchContractIdentity,
  researchContractIdentityFrom,
  researchGroupId,
  researchLineRefusal,
  researchParentView,
  researchResultRelations,
  ResearchResultRefusal,
  withParentDecision,
  type ResearchParentView,
  type ResearchResultRelation,
  type ScienceFlowResearchParent,
  type ScienceFlowResearchResultGroupView,
} from "./local-research-results.js";
import type {
  ResearchParentStore,
  ResearchResultSelectionStore,
} from "./local-research-results-repository.js";
import {
  RESEARCH_PREPARATION_VERSION,
  type ResearchPreparationStore,
  type ScienceFlowResearchPreparation,
} from "./local-research-overhead-repository.js";
import {
  assertExperimentProposalAdvances,
  evidenceKey,
  ExperimentProposalRefusal,
  parseExperimentProposal,
  type ExperimentProposal,
  type ExperimentProposalInput,
} from "./local-research-proposal.js";
import {
  buildEvolvePilotArtifacts,
  EvolvePilotRefusal,
  evolvePilotShapeGaps,
  EVOLVE_PILOT_CANDIDATE_FORMAT,
  EVOLVE_PILOT_SHARD_COUNT,
  EVOLVE_PILOT_SPLIT,
  type EvolvePilotContract,
} from "./evolve-pilot-adapter.js";
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
  | "continuation-provenance-unknown"
  | "research-line-busy"
  | "research-line-stopped"
  | "parent-budget-exhausted"
  | "parent-deadline-exceeded"
  | "result-not-selectable"
  | "selection-conflict"
  | "selection-stale"
  | "proposal-invalid"
  | "proposal-not-new";

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
  /** Explicit `selected_for_next` decisions, one per contract group. */
  readonly scienceFlowResearchResultSelections: ResearchResultSelectionStore;
  /** Per-contract research-line budgets and decision history. */
  readonly scienceFlowResearchParents: ResearchParentStore;
  /** Preparation and evaluator-probe overhead for the research line. */
  readonly scienceFlowResearchPreparations: ResearchPreparationStore;
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
  /** The Session's recorded model usage; used to account for Agent decisions. */
  readonly listModelInvocationUsage?: (sessionId: string) => Promise<ModelInvocationUsage[]>;
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
  /** The structured experiment proposal for this round, when supplied. */
  readonly proposal?: ExperimentProposalInput;
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
  /** The structured proposal this round was accepted on, when one was supplied. */
  readonly proposal?: ExperimentProposal;
  /** The explicit selection this round actually followed, when one was used. */
  readonly followedSelection?: {
    readonly operationId: string;
    readonly versionId: string;
    readonly reason: string;
    readonly selectedAt: string;
    readonly isBestValid: boolean;
  };
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
  /** The Agent's captured conversation-run usage for this operation, when recorded. */
  readonly agentUsage?: NonNullable<ScienceFlowLocalResearchOperation["agentUsage"]>;
  readonly delivery: ScienceFlowLocalResearchDelivery;
  readonly stop: ScienceFlowLocalResearchStop;
  readonly error: { readonly step: string; readonly message: string } | null;
  /** True for this experimental local mode; never a sandbox guarantee. */
  readonly experimentalLocalExecution: true;
  readonly formalRunnerSandbox: false;
  readonly instruction: string;
  /** This operation's relation to the best/latest/explicitly selected result. */
  readonly resultRelation?: ResearchResultRelation;
  /** The actual host/interpreter environment, when it could be observed. */
  readonly executionEnvironment?: ExecutionEnvironmentIdentity;
  /** The research line's total-budget projection for this contract. */
  readonly parent?: ResearchParentView;
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

/**
 * The result of checking whether one delivered SF result can enter the CPU
 * Evolve pilot. It freezes the adapter and the seed when the shape is
 * supported; it never starts a model search and never claims an SF score.
 */
export interface EvolvePilotCheckView {
  /** Whether the single candidate format can be described. Never an execution claim. */
  readonly adapterShapeSupported: boolean;
  /** This pilot's execution path is unsupported; see the reasons below. */
  readonly executionSupported: false;
  readonly executionUnsupportedReasons: readonly string[];
  readonly operationId: string;
  readonly groupId: string | null;
  readonly contractTaskId: string | null;
  /** Why this exact task cannot enter the pilot. Empty when supported. */
  readonly gaps: readonly string[];
  /** Additional shape limits of the adapter analysis. */
  readonly adapterLimits: readonly string[];
  readonly adapter: {
    readonly candidateFormat: typeof EVOLVE_PILOT_CANDIDATE_FORMAT;
    readonly dataset: { readonly name: string; readonly rows: number; readonly sha256: string };
    readonly evaluatorSourceSha256: string;
    readonly seedSourceSha256: string;
    readonly shardCount: typeof EVOLVE_PILOT_SHARD_COUNT;
    readonly split: typeof EVOLVE_PILOT_SPLIT;
  } | null;
  readonly plan: {
    readonly expansions: number;
    readonly workers: number;
    readonly statement: string;
  } | null;
}

/** Session-level preparation/probe overhead that no contract group can own. */
export interface ResearchSessionOverheadView {
  readonly preparations: {
    readonly attempts: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly knownSeconds: number;
    readonly unknown: number;
    readonly probeEvaluations: number;
    readonly unknownProbes: number;
    readonly unattributedAttempts: number;
    readonly tokens: "not-applicable";
  };
  readonly ideaTree: { readonly executed: false; readonly reason: string };
  readonly evolve: { readonly executed: false; readonly reason: string };
  readonly tokens: {
    readonly coverage: "recorded-per-operation";
    readonly note: string;
    readonly hardCap: null;
  };
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
  /** Reads the engine checkout's HEAD without requiring it; tests substitute. */
  readonly readEngineIdentity?: (engineCheckout: string) => Promise<EngineSourceIdentity | undefined>;
  /** Reads the actual host/interpreter environment; tests substitute. */
  readonly readExecutionEnvironment?: (pythonExecutable: string) => Promise<ExecutionEnvironmentIdentity | undefined>;
  /** Reads the Session's model usage; tests substitute. */
  readonly readModelUsage?: (sessionId: string) => Promise<ModelInvocationUsage[]>;
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
  /** The enforceable per-contract budget, or null when only serial execution is enforced. */
  readonly parentBudget: { readonly maxChildRuns: number; readonly totalAllowanceSec: number } | null;
  /** Upper bound for one bounded observation wait a tool may request. */
  readonly observeMaxWaitMs: number;
  /** The engine's registered task packages. Task-dynamic mode only. */
  listTasks(input: { readonly projectId: string; readonly sessionId: string }): Promise<readonly ScienceFlowCatalogTask[]>;
  /** Prepare a new task contract version from a scientific objective. */
  prepareTask(input: LocalResearchTaskPrepareInput): Promise<PreparedTaskPublication>;
  /** Check one delivered result against the supported SF → Evolve pilot shape. */
  checkEvolvePilot(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly expansions?: number;
    readonly workers?: number;
    readonly statement?: string;
  }): Promise<EvolvePilotCheckView>;
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
  /**
   * Every comparison group of this Session. Only results from the exact same
   * frozen scientific contract are rankable together; `best_valid` is always
   * recomputable and `selected_for_next` is the explicit decision.
   */
  results(input: { readonly projectId: string; readonly sessionId: string }): readonly ScienceFlowResearchResultGroupView[];
  /** Preparation/probe overhead and explicit not-executed fusion modes for this Session. */
  overhead(input: { readonly projectId: string; readonly sessionId: string }): ResearchSessionOverheadView;
  /** Record an explicit starting point, including a deliberately non-optimal one. */
  selectForNext(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly reason: string;
    readonly selectedBy?: "tool" | "web";
  }): ScienceFlowResearchResultGroupView;
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
  const selections = (): ResearchResultSelectionStore => store.scienceFlowResearchResultSelections;
  const parents = (): ResearchParentStore => store.scienceFlowResearchParents;
  const preparations = (): ResearchPreparationStore => store.scienceFlowResearchPreparations;
  const engineIdentityOf = dependencies.readEngineIdentity ?? readEngineSourceIdentity;
  const executionEnvironmentOf = dependencies.readExecutionEnvironment ?? readExecutionEnvironment;
  const readModelUsage = dependencies.readModelUsage
    ?? (store.listModelInvocationUsage ? (sessionId: string) => store.listModelInvocationUsage!(sessionId) : undefined);
  const preparationsFor = (projectId: string, sessionId: string): readonly ScienceFlowResearchPreparation[] =>
    preparations().listForSession(projectId, sessionId);

  /** All durable rows of one frozen contract, oldest first. */
  const groupOperations = (projectId: string, sessionId: string, groupId: string): ScienceFlowLocalResearchOperation[] =>
    operations().listForSession(projectId, sessionId).filter((operation) => researchGroupId(operation) === groupId);

  /** Project the research line, then keep the durable budget/history row current. */
  const persistParent = (
    contract: Parameters<typeof projectResearchParent>[0]["contract"],
    groupId: string,
    identity: { readonly projectId: string; readonly sessionId: string },
    groupOps: readonly ScienceFlowLocalResearchOperation[],
    decision?: {
      readonly kind: "start" | "stop-requested" | "stop-confirmed" | "select";
      readonly operationId?: string;
      readonly ownerRunId?: string;
      readonly summary: string;
    },
  ): ScienceFlowResearchParent => {
    const existing = parents().get(identity.projectId, identity.sessionId, groupId);
    let parent = projectResearchParent({
      contract,
      existing,
      groupId,
      identity,
      limits: settings.parentBudget,
      now: now(),
      operations: groupOps,
    });
    if (decision) {
      // A stop blocks the conversation that requested it. A later conversation
      // run starting this line explicitly supersedes that stop; the stop event
      // itself stays in the decision history.
      if (decision.kind === "start" && parent.stop.requestedAt !== undefined
        && decision.ownerRunId !== undefined && parent.stop.ownerRunId !== decision.ownerRunId) {
        parent = { ...parent, stop: {} };
      }
      parent = withParentDecision(parent, {
        at: now(),
        kind: decision.kind,
        ...(decision.operationId === undefined ? {} : { operationId: decision.operationId }),
        summary: decision.summary,
      });
    }
    if (existing !== undefined && decision === undefined
      && JSON.stringify(existing) === JSON.stringify(parent)) {
      return existing;
    }
    parents().put(parent);
    return parent;
  };

  /**
   * Record the Agent's own model usage for each operation's conversation run.
   * A missing usage record is `not-recorded`; a provider that did not report
   * tokens leaves them unknown, never zero.
   */
  const captureAgentUsage = async (records: readonly ScienceFlowLocalResearchOperation[]): Promise<void> => {
    if (readModelUsage === undefined || records.length === 0) return;
    const usage = await readModelUsage(records[0]!.identity.sessionId).catch(() => undefined);
    if (usage === undefined) return;
    for (const record of records) {
      const rows = usage.filter((entry) => entry.runId === record.ownerRunId);
      const known = rows.filter((entry) => entry.usageStatus === "reported"
        && entry.inputTokens !== null && entry.outputTokens !== null);
      const status: NonNullable<ScienceFlowLocalResearchOperation["agentUsage"]>["status"] =
        rows.length === 0 ? "not-recorded" : known.length === 0 ? "unknown" : known.length === rows.length ? "known" : "partially-known";
      const agentUsage = {
        calls: rows.length,
        capturedAt: now(),
        inputTokens: known.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0),
        outputTokens: known.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0),
        status,
        unknownUsageCalls: rows.length - known.length,
      };
      mutate(record.operationId, (current) => ({ ...current, agentUsage }));
    }
  };

  /** Keep the line's settlement audit current once a child is terminal. */
  const settleParentFor = (record: ScienceFlowLocalResearchOperation): void => {
    if (!isTerminalResearchState(record.state)) return;
    const groupId = researchGroupId(record);
    persistParent(
      researchContractIdentity(record),
      groupId,
      record.identity,
      groupOperations(record.identity.projectId, record.identity.sessionId, groupId),
    );
  };

  /**
   * The last check before a launch. Staging and task materialisation are
   * asynchronous, so the reservation that fit at `start` may no longer fit
   * before the line's deadline. This either passes, tightens the frozen grant
   * to the remaining wall clock, or refuses the launch.
   */
  const lineDeadlineVerdict = (
    record: ScienceFlowLocalResearchOperation,
  ): { readonly kind: "ok" } | { readonly kind: "refused"; readonly message: string } | {
    readonly kind: "tighten";
    readonly grant: ScienceFlowLocalResearchGrant;
  } => {
    const groupId = researchGroupId(record);
    const projected = projectResearchParent({
      contract: researchContractIdentity(record),
      existing: parents().get(record.identity.projectId, record.identity.sessionId, groupId),
      groupId,
      identity: record.identity,
      limits: settings.parentBudget,
      now: now(),
      operations: groupOperations(record.identity.projectId, record.identity.sessionId, groupId),
    });
    if (projected.limits === null) return { kind: "ok" };
    const deadlineMs = Date.parse(projected.limits.deadlineAt);
    const nowMs = Date.parse(now());
    const remainingSec = Number.isFinite(deadlineMs) && Number.isFinite(nowMs)
      ? (deadlineMs - nowMs) / 1_000
      : 0;
    if (remainingSec <= 0) {
      return {
        kind: "refused",
        message: `The research line deadline (${projected.limits.deadlineAt}) passed while this run was preparing; it was not launched`,
      };
    }
    const grant = record.launch.grant;
    if (remainingSec >= grant.totalAllowanceSec) return { kind: "ok" };
    const totalAllowanceSec = Math.floor(remainingSec);
    // The pilot's own floor is 60s total, 30s research and 10s report. Below
    // those it cannot start a meaningful run at all, so refuse instead of
    // silently granting a different budget.
    if (totalAllowanceSec < 60) {
      return {
        kind: "refused",
        message: `The research line has ${totalAllowanceSec}s before its deadline; a launch needs at least 60s`,
      };
    }
    const reportBudgetSec = Math.min(grant.reportBudgetSec, Math.max(10, totalAllowanceSec - 30));
    const researchBudgetSec = Math.min(grant.researchBudgetSec, totalAllowanceSec - reportBudgetSec);
    if (researchBudgetSec < 30) {
      return {
        kind: "refused",
        message: `The research line has ${totalAllowanceSec}s before its deadline; the engine's research/report minimums do not fit`,
      };
    }
    return {
      grant: { ...grant, reportBudgetSec, researchBudgetSec, totalAllowanceSec },
      kind: "tighten",
    };
  };

  /**
   * Reconcile the line's stored children with the engine before a new child is
   * reserved. This is not a relaunch: it reads the same control files `get`
   * reads and may publish an already-ended run's artifacts (delivery is a
   * publication, not a rerun), so a service restart cannot make a finished run
   * look active forever or lose its result before the next comparison.
   */
  const reconcileLine = async (
    records: readonly ScienceFlowLocalResearchOperation[],
  ): Promise<ScienceFlowLocalResearchOperation[]> => {
    for (const record of records) {
      if (isTerminalResearchState(record.state)) continue;
      const facts = await readEngineFacts(record);
      if (!facts.status || !TERMINAL_ENGINE_STATUSES.has(facts.status)) continue;
      const settled = mutate(record.operationId, (current) => ({
        ...current,
        state: stateFromFacts(current, facts),
        engine: facts,
      }));
      if (settled.delivery.state === "pending") await deliverOperation(settled.operationId);
      settleParentFor(operations().get(settled.operationId) ?? settled);
    }
    return records.map((record) => operations().get(record.operationId) ?? record);
  };
  /**
   * Record a stop on the research line itself, so a later start in the same
   * conversation cannot quietly reserve another child.
   */
  const markLineStop = (
    record: ScienceFlowLocalResearchOperation,
    requestedBy: "tool" | "conversation-cancel",
    requestedAt: string,
    confirmed: boolean,
  ): void => {
    const groupId = researchGroupId(record);
    const contract = researchContractIdentity(record);
    const groupOps = groupOperations(record.identity.projectId, record.identity.sessionId, groupId);
    let parent = projectResearchParent({
      contract,
      existing: parents().get(record.identity.projectId, record.identity.sessionId, groupId),
      groupId,
      identity: record.identity,
      limits: settings.parentBudget,
      now: requestedAt,
      operations: groupOps,
    });
    const previousStop = parent.stop;
    const alreadyRequested = previousStop.requestedAt !== undefined
      && previousStop.operationId === record.operationId;
    parent = {
      ...parent,
      stop: {
        ...parent.stop,
        operationId: record.operationId,
        ownerRunId: record.ownerRunId,
        requestedAt,
        requestedBy,
        ...(confirmed ? { confirmedAt: requestedAt } : {}),
      },
      updatedAt: requestedAt,
    };
    if (!alreadyRequested) {
      parent = withParentDecision(parent, {
        at: requestedAt,
        kind: "stop-requested",
        operationId: record.operationId,
        summary: `stop requested by ${requestedBy} for ${record.operationId}`,
      });
    }
    if (confirmed && previousStop.confirmedAt === undefined) {
      parent = withParentDecision(parent, {
        at: requestedAt,
        kind: "stop-confirmed",
        operationId: record.operationId,
        summary: `engine confirmed termination of ${record.operationId}`,
      });
    }
    parents().put(parent);
  };

  const parentViewFor = (
    record: ScienceFlowLocalResearchOperation,
    contract: Parameters<typeof projectResearchParent>[0]["contract"],
    groupId: string,
    groupOps: readonly ScienceFlowLocalResearchOperation[],
  ): ResearchParentView => {
    const existing = parents().get(record.identity.projectId, record.identity.sessionId, groupId);
    const projected = projectResearchParent({
      contract,
      existing,
      groupId,
      identity: record.identity,
      limits: settings.parentBudget,
      now: now(),
      operations: groupOps,
    });
    const view = researchParentView(
      projected,
      groupOps,
      now(),
      preparationsFor(record.identity.projectId, record.identity.sessionId),
      groupOps.flatMap((operation) => operation.agentUsage === undefined ? [] : [operation.agentUsage]),
    );
    return { ...view, decisions: view.decisions.slice(-20) };
  };
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

  /** The absolute parent-line deadline, when this deployment configured one. */
  const lineDeadlineFor = (record: ScienceFlowLocalResearchOperation): string | undefined => {
    const groupId = researchGroupId(record);
    const projected = projectResearchParent({
      contract: researchContractIdentity(record),
      existing: parents().get(record.identity.projectId, record.identity.sessionId, groupId),
      groupId,
      identity: record.identity,
      limits: settings.parentBudget,
      now: now(),
      operations: groupOperations(record.identity.projectId, record.identity.sessionId, groupId),
    });
    return projected.limits?.deadlineAt;
  };

  const pilotRequest = (record: ScienceFlowLocalResearchOperation) => {
    const deadlineAt = lineDeadlineFor(record);
    return {
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
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    };
  };

  const readEngineFacts = async (record: ScienceFlowLocalResearchOperation): Promise<ScienceFlowLocalResearchEngineFacts> => {
    const controlPath = join(record.workDir, "state", "scienceflow", "managed_runs", record.engineRunId, "control.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(controlPath, "utf8"));
    } catch {
      return { observedAt: now() };
    }
    if (!isRecord(parsed)) return { observedAt: now() };
    const evaluator = await readExecutedEvaluatorIdentity(record);
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
      ...(typeof parsed.research_status === "string" ? { researchStatus: parsed.research_status } : {}),
      ...(typeof parsed.report_status === "string" ? { reportStatus: parsed.report_status } : {}),
      ...(typeof parsed.alive === "boolean" ? { alive: parsed.alive } : {}),
      ...(typeof parsed.pid === "number" ? { supervisorPid: parsed.pid } : {}),
      ...(evaluator === undefined ? {} : { evaluator }),
      observedAt: now(),
    };
  };

  /**
   * The evaluator package the engine actually registered for this run, read
   * from its own task_runtime registry. A dirty checkout can produce a
   * different package than a previous run; this file proves which bytes ran.
   */
  const readExecutedEvaluatorIdentity = async (
    record: ScienceFlowLocalResearchOperation,
  ): Promise<ScienceFlowLocalResearchEngineFacts["evaluator"]> => {
    const path = join(record.workDir, "runs", record.engineRunId, record.task, "task_runtime", "registry.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const entrypointSha256 = typeof parsed.entrypoint_sha256 === "string" ? parsed.entrypoint_sha256 : undefined;
    const packageSha256 = typeof parsed.package_sha256 === "string" ? parsed.package_sha256 : undefined;
    const taskId = typeof parsed.task_id === "string" ? parsed.task_id : undefined;
    if (entrypointSha256 === undefined && packageSha256 === undefined && taskId === undefined) return undefined;
    return {
      ...(taskId === undefined ? {} : { taskId }),
      ...(entrypointSha256 === undefined ? {} : { entrypointSha256 }),
      ...(packageSha256 === undefined ? {} : { packageSha256 }),
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
        ...(typeof row.selectionEligible === "boolean" ? { selectionEligible: row.selectionEligible } : {}),
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
      ...(typeof launch?.elapsedSec === "number" && Number.isFinite(launch.elapsedSec)
        ? { elapsedSec: launch.elapsedSec }
        : {}),
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
      launch: {
        ...record.launch,
        model,
        // The pilot may tighten the grant again at its own launch boundary.
        grant: {
          ...record.launch.grant,
          reportBudgetSec: receipt.engine.grant.reportBudgetSec,
          researchBudgetSec: receipt.engine.grant.researchBudgetSec,
          totalAllowanceSec: receipt.engine.grant.totalAllowanceSec,
        },
      },
      progress: {
        stages: (receipt.result?.stages ?? []).map((stage) => ({
          stageId: stage.stageId,
          parentStageId: stage.parentStageId,
          metricName: stage.metricName,
          metricValue: stage.metricValue,
          artifactSha256: stage.artifactSha256,
          validationOk: stage.validationOk,
          ...(typeof stage.selectionEligible === "boolean" ? { selectionEligible: stage.selectionEligible } : {}),
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
      // Final pre-launch re-check. Preparation is asynchronous and may have
      // outlived the conversation or the line's deadline; the engine must not
      // receive a full grant that crosses the parent deadline.
      current = operations().get(operationId) ?? current;
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
      const deadline = lineDeadlineVerdict(current);
      if (deadline.kind === "refused") {
        const refused = mutate(operationId, (record) => ({
          ...record,
          state: "failed",
          error: { step: "budget", message: deadline.message },
        }));
        settleParentFor(refused);
        return;
      }
      if (deadline.kind === "tighten") {
        current = mutate(operationId, (record) => ({
          ...record,
          launch: { ...record.launch, grant: deadline.grant },
        }));
        persistParent(
          researchContractIdentity(current),
          researchGroupId(current),
          current.identity,
          groupOperations(current.identity.projectId, current.identity.sessionId, researchGroupId(current)),
        );
      }
      mutate(operationId, (record) => ({
        ...record,
        state: "running",
        launch: { ...record.launch, launchedAt: now() },
      }));
      const receipt = await runResearchPilot(store, pilotRequest(current), {
        ...(dependencies.launch ? { launch: dependencies.launch } : {}),
        ...(dependencies.readSnapshot ? { readSnapshot: dependencies.readSnapshot } : {}),
        now,
      });
      const observedEngine = await readEngineFacts(current);
      mutate(operationId, (record) => {
        const applied = applyReceipt(record, receipt);
        return {
          ...applied,
          engine: {
            ...applied.engine,
            ...(observedEngine.evaluator === undefined ? {} : { evaluator: observedEngine.evaluator }),
          },
          ...(record.stop.requestedAt && receipt.launch?.status === "stopped"
            ? { stop: { ...record.stop, confirmedAt: now(), engineStatus: "stopped" } }
            : {}),
        };
      });
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
    if (record.state === "failed" && record.engine.status === undefined
      && record.error?.step === "budget") {
      return `The run was not launched: ${record.error.message}. No research was performed and no candidate exists.`;
    }
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

  const view = (
    record: ScienceFlowLocalResearchOperation,
    relation?: ResearchResultRelation,
    parent?: ResearchParentView,
  ): ScienceFlowLocalResearchView => ({
    operationId: record.operationId,
    engineRunId: record.engineRunId,
    task: record.task,
    intent: record.intent,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    planVersionId: record.planVersionId ?? null,
    incumbentVersionId: record.incumbentVersionId ?? null,
    ...(record.proposal === undefined ? {} : { proposal: record.proposal }),
    ...(record.followedSelection === undefined ? {} : { followedSelection: record.followedSelection }),
    ...(record.launch.executionEnvironment === undefined ? {} : { executionEnvironment: record.launch.executionEnvironment }),
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
    ...(record.agentUsage === undefined ? {} : { agentUsage: record.agentUsage }),
    delivery: record.delivery,
    stop: record.stop,
    error: record.error ?? null,
    ...(relation ? { resultRelation: relation } : {}),
    ...(parent ? { parent } : {}),
    experimentalLocalExecution: true,
    formalRunnerSandbox: false,
    instruction: nextInstruction(record),
  });

  /**
   * Build the public view(s) with each operation's relation to its contract's
   * latest/best/selected result and its research-line budget. The computation is
   * derived from durable rows, so a rebuilt service reaches the same answer.
   */
  const viewsFor = (
    projectId: string,
    sessionId: string,
    records: readonly ScienceFlowLocalResearchOperation[],
  ): readonly ScienceFlowLocalResearchView[] => {
    const all = operations().listForSession(projectId, sessionId);
    const groups = deriveResearchResultGroups(all, selections().listForSession(projectId, sessionId));
    const relations = researchResultRelations(groups, records);
    return records.map((record) => {
      const groupId = researchGroupId(record);
      const group = groups.find((candidate) => candidate.groupId === groupId);
      const groupOps = all.filter((operation) => researchGroupId(operation) === groupId);
      return view(
        record,
        relations.get(record.operationId),
        group ? parentViewFor(record, group.contract, groupId, groupOps) : undefined,
      );
    });
  };

  const singleView = (record: ScienceFlowLocalResearchOperation): ScienceFlowLocalResearchView =>
    viewsFor(record.identity.projectId, record.identity.sessionId, [record])[0]!;

  const idempotencyKey = (request: LocalResearchStartInput): string => createHash("sha256")
    .update(JSON.stringify({
      incumbentVersionId: request.incumbentVersionId ?? null,
      inputVersionIds: request.inputVersionIds ?? [],
      intent: request.intent,
      ownerRunId: request.ownerRunId,
      planVersionId: request.planVersionId ?? null,
      proposal: request.proposal ?? null,
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
        evaluator: {
          entrypoint: described.evaluatorEntrypoint,
          kind: "task-package",
          ...(described.entrypointSha256 === null ? {} : { entrypointSha256: described.entrypointSha256 }),
          ...(described.packageSha256 === null ? {} : { packageSha256: described.packageSha256 }),
        },
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
    parentBudget: settings.parentBudget ?? null,
    observeMaxWaitMs: settings.defaults.observeMaxWaitMs,

    async listTasks(input): Promise<readonly ScienceFlowCatalogTask[]> {
      const adapter = requireTaskDynamic();
      assertSessionIdentity(input.projectId, input.sessionId);
      return await (dependencies.listTasks ?? listCatalogTasks)(adapter);
    },

    async prepareTask(input: LocalResearchTaskPrepareInput): Promise<PreparedTaskPublication> {
      const adapter = requireTaskDynamic();
      const startedAt = now();
      let publication: PreparedTaskPublication | undefined;
      let failure: unknown;
      try {
        publication = await prepareResearchTask(store, input, {
          now,
          readBytes: readArtifactBytes,
          settings: adapter,
          tasksRoot: join(settings.workRoot, "tasks"),
          ...(dependencies.probeTask ? { probe: dependencies.probeTask } : {}),
        });
      } catch (error) {
        failure = error;
      }
      const finishedAt = now();
      const startedMs = Date.parse(startedAt);
      const finishedMs = Date.parse(finishedAt);
      const wallClockKnown = Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs;
      const preparation: ScienceFlowResearchPreparation = {
        error: failure === undefined ? undefined : errorMessage(failure),
        finishedAt,
        identity: { projectId: input.projectId, sessionId: input.sessionId },
        outcome: failure === undefined ? "succeeded" : "failed",
        preparationId: newOperationId(),
        probe: {
          evaluations: publication === undefined ? 0 : 2,
          evaluatorSha256: publication?.evaluatorSha256 ?? null,
          status: publication === undefined ? "unknown" : "known",
        },
        runId: input.runId,
        schemaVersion: RESEARCH_PREPARATION_VERSION,
        startedAt,
        taskId: publication?.taskId ?? preparedTaskId(input.slug, input.objective),
        taskVersionId: publication?.taskVersionId ?? null,
        tokens: {
          note: "The evaluator probe runs code, not a model call; this is not a zero-token model invocation.",
          status: "not-applicable",
        },
        wallClock: {
          seconds: wallClockKnown ? (finishedMs - startedMs) / 1_000 : 0,
          status: wallClockKnown ? "known" : "unknown",
        },
      };
      preparations().record(preparation);
      if (failure !== undefined) throw failure;
      return publication!;
    },

    async checkEvolvePilot(input): Promise<EvolvePilotCheckView> {
      const executionUnsupportedReasons = [
        "The candidate and the original evaluator would run in one Python process. The candidate can mutate scratch state, replace or monkeypatch the evaluator/result path, or spawn its own process; chmod 0400 is not a permission boundary.",
        "The adapter source embeds every bound CSV row, so a candidate that reads the adapter can see the gate and test rows. It cannot provide a held-out evaluation boundary.",
        "The Evolve sidecar exposes only /probe, /runs and /stop; it has no generic sandboxed candidate re-evaluation endpoint. The original SF artifact_command evaluator cannot be re-run on the Evolve winner's full task data without executing model-written code outside an existing boundary.",
        "No Evolve execution is linked to the research line's parent budget, reservation settlement or stop chain. Starting one would bypass the committed wall-clock and run-count controls.",
      ];
      const adapterLimits = [
        "This check only describes the single supported candidate format; it does not start an Evolve search, spend model tokens or create a result record.",
        "The adapter assumes the evaluator reads the single bound CSV as dataset/<name> relative to its working directory. An evaluator that uses another path or extra assets is unsupported.",
        "The Evolve candidate runtime must already provide every module the original evaluator imports (for example NumPy or SciPy). This check does not inspect or install that environment.",
      ];
      if (!store.getProject(input.projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(input.sessionId);
      if (!session || session.projectId !== input.projectId) {
        throw new LocalResearchRefusal("session-not-found", "The Session does not exist in this Project");
      }
      const operation = operations().get(input.operationId);
      if (!operation || operation.identity.projectId !== input.projectId
        || operation.identity.sessionId !== input.sessionId) {
        throw new LocalResearchRefusal("operation-not-found", "This Session has no research operation with that id");
      }
      const unsupported = (gaps: readonly string[]): EvolvePilotCheckView => ({
        adapter: null,
        adapterLimits,
        adapterShapeSupported: false,
        contractTaskId: operation.taskBinding?.taskId ?? null,
        executionSupported: false,
        executionUnsupportedReasons,
        gaps,
        groupId: operation.taskBinding ? researchGroupId(operation) : null,
        operationId: operation.operationId,
        plan: null,
      });
      const delivery = operation.delivery;
      if (delivery.state !== "delivered" || !delivery.solution) {
        return unsupported(["The operation has no delivered solution; run and deliver one first."]);
      }
      const binding = operation.taskBinding;
      if (!binding) {
        return unsupported(["This operation ran the fixed administrator task, not a prepared task contract."]);
      }
      const contract: EvolvePilotContract = {
        artifactKind: binding.artifactKind,
        artifactPath: binding.artifactPath,
        evaluatorKind: binding.evaluator.kind,
        lowerIsBetter: binding.lowerIsBetter,
        metricJsonPath: binding.metricJsonPath ?? null,
        metricName: binding.metricName,
        source: binding.source,
      };
      const readVersionBytes = async (versionId: string, expectedSha?: string, expectedSize?: number) => {
        const version = store.getProjectArtifactVersion(input.projectId, versionId);
        const artifact = version ? store.getProjectArtifact(input.projectId, version.artifactId) : undefined;
        if (!version || !artifact || artifact.deletedAt || artifact.createdInSessionId !== input.sessionId) {
          return undefined;
        }
        const bytes = await readArtifactBytes(version.content.hash).catch(() => undefined);
        if (!bytes) return undefined;
        const actual = sha256(bytes);
        if (actual !== version.content.hash
          || (expectedSha !== undefined && actual !== expectedSha)
          || (expectedSize !== undefined && bytes.length !== expectedSize)) {
          return undefined;
        }
        return bytes;
      };
      let evaluatorBytes: Buffer | undefined;
      if (binding.evaluator.kind === "generated-command") {
        evaluatorBytes = await readVersionBytes(binding.evaluator.versionId, binding.evaluator.sha256);
      }
      let dataset: { readonly name: string; readonly bytes: Buffer } | undefined;
      if (binding.inputs.length === 1) {
        const bindingInput = binding.inputs[0]!;
        const bytes = await readVersionBytes(bindingInput.versionId, bindingInput.sha256, bindingInput.size);
        if (bytes) dataset = { bytes, name: bindingInput.logicalName };
      }
      const solutionVersion = delivery.solution;
      const incumbent = await readVersionBytes(solutionVersion.versionId);
      const gaps = [...evolvePilotShapeGaps({ contract, dataset, evaluatorBytes })];
      if (binding.inputs.length !== 1) {
        gaps.push(`The task binds ${binding.inputs.length} input files; this pilot supports exactly one CSV input.`);
      }
      if (!incumbent) gaps.push("The delivered solution bytes are unavailable or do not match their recorded digest.");
      const expansions = input.expansions ?? 8;
      const workers = input.workers ?? 1;
      if (!Number.isSafeInteger(expansions) || expansions < 4 || expansions > 32) {
        gaps.push("expansions must be an integer from 4 to 32.");
      }
      if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4 || expansions < workers * 4) {
        gaps.push("workers must be 1-4 and expansions must be at least four times the worker count.");
      }
      const statement = input.statement?.trim()
        || `Improve ${binding.title} under metric ${binding.metricName} from the delivered candidate.`;
      if (!statement || statement.length > 500 || statement.includes("\u0000")) {
        gaps.push("statement must be 1-500 characters without NUL bytes.");
      }
      if (gaps.length || !dataset || !evaluatorBytes || !incumbent) return unsupported(gaps);
      let artifacts;
      try {
        artifacts = buildEvolvePilotArtifacts({
          artifactKind: binding.artifactKind,
          artifactPath: binding.artifactPath,
          dataset,
          evaluatorBytes,
          lowerIsBetter: binding.lowerIsBetter ?? false,
          metricJsonPath: binding.metricJsonPath ?? "metric",
          metricName: binding.metricName,
          timeoutSeconds: 120,
        }, incumbent);
      } catch (error) {
        return unsupported([error instanceof EvolvePilotRefusal ? error.message : errorMessage(error)]);
      }
      return {
        adapter: {
          candidateFormat: artifacts.candidateFormat,
          dataset: artifacts.dataset,
          evaluatorSourceSha256: artifacts.evaluatorSourceSha256,
          seedSourceSha256: artifacts.seedSourceSha256,
          shardCount: artifacts.shardCount,
          split: artifacts.split,
        },
        adapterLimits,
        adapterShapeSupported: true,
        contractTaskId: binding.taskId,
        executionSupported: false,
        executionUnsupportedReasons,
        gaps: [],
        groupId: researchGroupId(operation),
        operationId: operation.operationId,
        plan: { expansions, statement, workers },
      };
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
        return { attached: true, attachedReason: "same-request", operation: singleView(existing) };
      }
      // One conversation run owns at most one live experiment. A second start
      // that names different intent while the first is live attaches instead of
      // launching a second paid run; the user still has the one stop action.
      const active = operations()
        .listForSession(request.projectId, request.sessionId)
        .find((candidate) => candidate.ownerRunId === request.ownerRunId && !isTerminalResearchState(candidate.state));
      if (active) {
        return { attached: true, attachedReason: "active-operation", operation: singleView(active) };
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
      const taskId = selection?.taskId ?? settings.task!;
      // A catalog task's evaluator identity includes the checkout revision and
      // the actual evaluator/package digests. An unknown identity is recorded
      // as unknown and that group is shown but not ranked.
      const [engineIdentity, executionEnvironment] = await Promise.all([
        engineIdentityOf(settings.engineCheckout),
        executionEnvironmentOf(settings.pythonExecutable),
      ]);
      const contract = researchContractIdentityFrom(selection?.binding, taskId, {
        executionEnvironment,
        revision: engineIdentity?.revision,
        statusDigest: engineIdentity?.statusDigest,
        worktreeDirty: engineIdentity?.dirty,
      });
      const groupId = contractGroupId(contract);
      await captureAgentUsage(groupOperations(request.projectId, request.sessionId, groupId));
      // A rebuilt service reconciles the line's stored children from the engine
      // record before it decides on a new reservation. It never starts one.
      const groupOps = await reconcileLine(
        groupOperations(request.projectId, request.sessionId, groupId),
      );
      // An explicit `selected_for_next` is a decision, not a display. A start
      // without an incumbent follows it; a different incumbent conflicts; a
      // stale selection cannot be silently ignored.
      let effectiveRequest = request;
      let followedSelection: NonNullable<ScienceFlowLocalResearchOperation["followedSelection"]> | undefined;
      const selectionRow = selections().get(request.projectId, request.sessionId, groupId);
      if (selectionRow) {
        const selectedGroup = deriveResearchResultGroups(groupOps, [selectionRow])
          .find((candidate) => candidate.groupId === groupId);
        const selectedView = selectedGroup?.selection;
        if (selectedView?.valid === true) {
          if (request.incumbentVersionId !== undefined
            && request.incumbentVersionId !== selectionRow.versionId) {
            throw new LocalResearchRefusal(
              "selection-conflict",
              `This research line explicitly selected result ${selectionRow.operationId} (version ${selectionRow.versionId}). `
                + "Pass that version, or change the selection first; a different incumbent would silently ignore the decision.",
            );
          }
          if (request.incumbentVersionId === undefined) {
            effectiveRequest = { ...request, incumbentVersionId: selectionRow.versionId };
          }
          followedSelection = {
            isBestValid: selectedView.isBestValid,
            operationId: selectionRow.operationId,
            reason: selectionRow.reason,
            selectedAt: selectionRow.selectedAt,
            versionId: selectionRow.versionId,
          };
        } else if (request.incumbentVersionId === undefined) {
          throw new LocalResearchRefusal(
            "selection-stale",
            "The research line's explicit selection is no longer a valid result. "
              + "Select a valid result or pass an explicit incumbent before starting.",
          );
        }
      }
      if (followedSelection !== undefined && settings.inputMode === "dynamic"
        && settings.dynamicInputs?.incumbent === undefined) {
        throw new LocalResearchRefusal(
          "invalid-option",
          "This research profile does not stage an incumbent, so the explicit selection cannot be followed",
        );
      }
      // The early key was computed before the explicit selection was resolved.
      // Re-check now, before any proposal novelty or continuation requirement:
      // a replay of the same request after an automatic selection must attach
      // to its existing operation instead of being refused as a repeated
      // experiment.
      const resolvedKey = idempotencyKey({ ...effectiveRequest, intent });
      if (resolvedKey !== key) {
        const resolvedExisting = operations().findByIdempotency(
          request.projectId,
          request.sessionId,
          resolvedKey,
        );
        if (resolvedExisting) {
          return { attached: true, attachedReason: "same-request", operation: singleView(resolvedExisting) };
        }
      }
      // Freeze the fixed input bytes this run will actually use, and prove a
      // named version is exactly that input before any record or launch exists.
      const inputs = await resolveInputs(effectiveRequest);
      assertContinuationCompatible(effectiveRequest, selection);

      // Every continuation round must explain its evidence and make a concrete
      // method change. First rounds stay compatible with the older entry; the
      // production tool always supplies the structured proposal.
      let proposal: ExperimentProposal | undefined;
      const previousOperation = [...groupOps].reverse().find((operation) => operation.proposal !== undefined);
      if (request.proposal !== undefined) {
        try {
          const parsed = parseExperimentProposal(request.proposal, {
            maxSubBudgetSeconds: settings.defaults.totalAllowanceSec,
            now: now(),
          });
          const resolvedEvidence: Array<ExperimentProposal["evidence"][number]> = [];
          for (const entry of parsed.evidence) {
            if (entry.kind === "artifact-version" && entry.versionId !== undefined) {
              const version = store.getProjectArtifactVersion(request.projectId, entry.versionId);
              const artifact = version ? store.getProjectArtifact(request.projectId, version.artifactId) : undefined;
              const ownsArtifact = artifact !== undefined && artifact.deletedAt === undefined
                && artifact.createdInSessionId === request.sessionId;
              const ownsVersion = version !== undefined && version.sessionId === request.sessionId;
              if (!version || !artifact || artifact.deletedAt || (!ownsArtifact && !ownsVersion)) {
                throw new LocalResearchRefusal(
                  "proposal-invalid",
                  `Evidence artifact version ${entry.versionId} is not a live version of this Session`,
                );
              }
              resolvedEvidence.push({ ...entry, sha256: version.content.hash });
            } else if (entry.kind === "operation-result" && entry.operationId !== undefined) {
              const evidenceOperation = operations().get(entry.operationId);
              if (!evidenceOperation || evidenceOperation.identity.projectId !== request.projectId
                || evidenceOperation.identity.sessionId !== request.sessionId) {
                throw new LocalResearchRefusal(
                  "proposal-invalid",
                  `Evidence operation ${entry.operationId} is not a research operation of this Session`,
                );
              }
              resolvedEvidence.push({ ...entry });
            }
          }
          proposal = { ...parsed, evidence: resolvedEvidence };
          assertExperimentProposalAdvances(
            proposal,
            previousOperation?.proposal === undefined
              ? undefined
              : {
                  incumbentVersionId: previousOperation.incumbentVersionId ?? null,
                  proposal: previousOperation.proposal,
                },
            effectiveRequest.incumbentVersionId ?? null,
          );
        } catch (error) {
          if (error instanceof LocalResearchRefusal) throw error;
          if (error instanceof ExperimentProposalRefusal) {
            throw new LocalResearchRefusal(
              error.reason === "proposal-not-new" ? "proposal-not-new" : "proposal-invalid",
              error.message,
            );
          }
          throw new LocalResearchRefusal("proposal-invalid", errorMessage(error));
        }
      } else if (settings.taskMode === "task-dynamic" && groupOps.length > 0) {
        throw new LocalResearchRefusal(
          "proposal-invalid",
          "A continuation round needs a structured experiment proposal with its evidence, method change, expected observation, evaluation method, stop condition and sub-budget",
        );
      }

      const childTotalAllowanceSec = proposal?.subBudgetSeconds ?? settings.defaults.totalAllowanceSec;
      const childReportBudgetSec = Math.min(
        settings.defaults.reportBudgetSec,
        Math.max(10, childTotalAllowanceSec - 30),
      );
      const childResearchBudgetSec = Math.min(
        settings.defaults.researchBudgetSec,
        childTotalAllowanceSec - childReportBudgetSec,
      );
      if (childResearchBudgetSec < 30) {
        throw new LocalResearchRefusal("invalid-option", "The proposed sub-budget cannot cover the engine's research minimum");
      }
      const projectedParent = projectResearchParent({
        contract,
        existing: parents().get(request.projectId, request.sessionId, groupId),
        groupId,
        identity: { projectId: request.projectId, sessionId: request.sessionId },
        limits: settings.parentBudget,
        now: now(),
        operations: groupOps,
      });
      // The line is serial and, when configured, budgeted. This check runs
      // before an operation row exists, so a refused start spends nothing.
      const lineRefusal = researchLineRefusal({
        allowanceSec: childTotalAllowanceSec,
        now: now(),
        operations: groupOps,
        ownerRunId: request.ownerRunId,
        parent: projectedParent,
        agentUsage: groupOps.flatMap((operation) => operation.agentUsage === undefined ? [] : [operation.agentUsage]),
        preparations: preparationsFor(request.projectId, request.sessionId),
      });
      if (lineRefusal) throw new LocalResearchRefusal(lineRefusal.reason, lineRefusal.message);
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
      const baseTaskDescription = selection
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
            planVersionId: planRole?.versionId ?? effectiveRequest.planVersionId ?? "",
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
      const taskDescription = withRoundContext(baseTaskDescription, proposal, followedSelection);
      const grant: ScienceFlowLocalResearchGrant = {
        task: taskId,
        researchBudgetSec: childResearchBudgetSec,
        reportBudgetSec: childReportBudgetSec,
        totalAllowanceSec: childTotalAllowanceSec,
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
        idempotencyKey: resolvedKey,
        identity: { projectId: request.projectId, sessionId: request.sessionId },
        ownerRunId: request.ownerRunId,
        intent,
        ...(effectiveRequest.planVersionId ? { planVersionId: effectiveRequest.planVersionId } : {}),
        ...(effectiveRequest.incumbentVersionId ? { incumbentVersionId: effectiveRequest.incumbentVersionId } : {}),
        ...(inputs.length ? { inputs } : {}),
        ...(selection ? { taskBinding: selection.binding } : {}),
        ...(proposal === undefined ? {} : { proposal }),
        ...(followedSelection === undefined ? {} : { followedSelection }),
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
          ...(engineIdentity?.revision === undefined ? {} : { engineRevision: engineIdentity.revision }),
          ...(engineIdentity?.dirty === undefined ? {} : { engineWorktreeDirty: engineIdentity.dirty }),
          ...(engineIdentity?.statusDigest === undefined ? {} : { engineStatusDigest: engineIdentity.statusDigest }),
          ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
        },
        engine: {},
        progress: { stages: [], usage: null },
        delivery: { state: "pending", attempts: 0, updatedAt: createdAt },
        stop: {},
      };
      const stored = operations().createIfAbsent(record);
      if (!stored.created) {
        return { attached: true, attachedReason: "same-request", operation: singleView(stored.record) };
      }
      // The accepted child is the line's one reservation until it reaches a
      // terminal state. Persisting this projection is also the durable audit of
      // what was reserved and for which contract group.
      persistParent(
        contract,
        groupId,
        record.identity,
        groupOperations(request.projectId, request.sessionId, groupId),
        {
          kind: "start",
          operationId,
          ownerRunId: request.ownerRunId,
          summary: `started ${operationId} with a ${settings.defaults.totalAllowanceSec}s reservation`,
        },
      );
      // Return the operation identity now; the engine run continues in the
      // background so one HTTP request or tool call is not held open for it.
      void execute(operationId).catch(() => undefined);
      return { attached: false, operation: singleView(stored.record) };
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
          settleParentFor(record);
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(OBSERVE_POLL_MS, Math.max(0, deadline - Date.now())));
      }
      await captureAgentUsage([record]);
      return singleView(operations().get(record.operationId) ?? record);
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
        // Even an already-terminal run records the user's intent to end this
        // line, so a later same-conversation start cannot reserve another child.
        markLineStop(updated, "tool", now(), true);
        settleParentFor(updated);
        await captureAgentUsage([updated]);
        return { confirmed: true, operation: singleView(operations().get(updated.operationId) ?? updated), reason: "already-terminal", requested: false };
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
      markLineStop(record, "tool", requestedAt, false);
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
      if (confirmed) markLineStop(updated, "tool", now(), true);
      settleParentFor(updated);
      await captureAgentUsage([updated]);
      return { confirmed, operation: singleView(operations().get(updated.operationId) ?? updated), requested: true };
    },

    async retryDelivery(request): Promise<ScienceFlowLocalResearchView> {
      const record = resolveRecord(request);
      // Publication only: the experiment's identity and state are untouched.
      // A delivered result is republished idempotently (unchanged bytes reuse
      // their version) so a corrected note can reach the Session.
      await deliverOperation(record.operationId, true);
      const updated = operations().get(record.operationId) ?? record;
      await captureAgentUsage([updated]);
      return singleView(operations().get(record.operationId) ?? updated);
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
          if (facts.status && TERMINAL_ENGINE_STATUSES.has(facts.status)) {
            const settled = mutate(record.operationId, (current) => ({
              ...current,
              state: stateFromFacts(current, facts),
              engine: facts,
            }));
            markLineStop(settled, "conversation-cancel", now(), true);
            settleParentFor(settled);
            continue;
          }
          markLineStop(record, "conversation-cancel", now(), false);
          mutate(record.operationId, (current) => ({
            ...current,
            stop: { ...current.stop, requestedAt: now(), requestedBy: "conversation-cancel" },
          }));
          await stopEngineRun(record);
          // Cancellation waits for the engine's own termination record instead
          // of declaring success when the stop request returned. The bounded
          // confirmation is the same one the tool path uses.
          const confirmed = await confirmStop(record, sleep);
          const updated = mutate(record.operationId, (current) => ({
            ...current,
            state: confirmed ? "stopped" : current.state,
            engine: { ...current.engine, ...(confirmed ? { status: "stopped" } : {}) },
            stop: {
              ...current.stop,
              ...(confirmed ? { confirmedAt: now(), engineStatus: "stopped" } : {}),
            },
          }));
          if (confirmed) markLineStop(updated, "conversation-cancel", now(), true);
          settleParentFor(updated);
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
      return viewsFor(projectId, sessionId, operations().listForSession(projectId, sessionId));
    },

    overhead(input): ResearchSessionOverheadView {
      if (!store.getProject(input.projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(input.sessionId);
      if (!session || session.projectId !== input.projectId) {
        throw new LocalResearchRefusal("session-not-found", "This Session is not in the given Project");
      }
      const rows = preparationsFor(input.projectId, input.sessionId);
      return {
        evolve: {
          executed: false,
          reason: "No Evolve search is executed by this Session's local research path; the Evolve check is analysis only.",
        },
        ideaTree: {
          executed: false,
          reason: "No Idea Tree execution is linked to a local research line in this Session.",
        },
        preparations: {
          attempts: rows.length,
          failed: rows.filter((row) => row.outcome === "failed").length,
          knownSeconds: rows.reduce((total, row) => total + (row.wallClock.status === "known" ? row.wallClock.seconds : 0), 0),
          probeEvaluations: rows.reduce((total, row) => total + (row.probe.status === "known" ? row.probe.evaluations : 0), 0),
          succeeded: rows.filter((row) => row.outcome === "succeeded").length,
          tokens: "not-applicable",
          unattributedAttempts: rows.filter((row) => row.taskVersionId === null).length,
          unknown: rows.filter((row) => row.wallClock.status === "unknown").length,
          unknownProbes: rows.filter((row) => row.probe.status === "unknown").length,
        },
        tokens: {
          coverage: "recorded-per-operation",
          hardCap: null,
          note: "Agent decision tokens are recorded per operation from the Session's model usage log. This path cannot enforce a total token hard cap.",
        },
      };
    },

    results(input): readonly ScienceFlowResearchResultGroupView[] {
      if (!store.getProject(input.projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(input.sessionId);
      if (!session || session.projectId !== input.projectId) {
        throw new LocalResearchRefusal("session-not-found", "This Session is not in the given Project");
      }
      const all = operations().listForSession(input.projectId, input.sessionId);
      const groups = deriveResearchResultGroups(all, selections().listForSession(input.projectId, input.sessionId));
      return groups.map((group) => {
        const groupOps = all.filter((operation) => researchGroupId(operation) === group.groupId);
        const projected = projectResearchParent({
          contract: group.contract,
          existing: parents().get(input.projectId, input.sessionId, group.groupId),
          groupId: group.groupId,
          identity: { projectId: input.projectId, sessionId: input.sessionId },
          limits: settings.parentBudget,
          now: now(),
          operations: groupOps,
        });
        const parentView = researchParentView(
          projected,
          groupOps,
          now(),
          preparationsFor(input.projectId, input.sessionId),
          groupOps.flatMap((operation) => operation.agentUsage === undefined ? [] : [operation.agentUsage]),
        );
        // The record keeps the full bounded history; the Agent-facing view
        // carries the recent decisions only so a long line does not flood the
        // conversation context.
        return { ...group, parent: { ...parentView, decisions: parentView.decisions.slice(-20) } };
      });
    },

    selectForNext(input): ScienceFlowResearchResultGroupView {
      if (!store.getProject(input.projectId)) {
        throw new LocalResearchRefusal("project-not-found", "The Project does not exist");
      }
      const session = store.getSession(input.sessionId);
      if (!session || session.projectId !== input.projectId) {
        throw new LocalResearchRefusal("session-not-found", "This Session is not in the given Project");
      }
      store.assertSessionWritable(input.sessionId);
      const all = operations().listForSession(input.projectId, input.sessionId);
      const groups = deriveResearchResultGroups(all, selections().listForSession(input.projectId, input.sessionId));
      let selected;
      try {
        selected = createResearchSelection(groups, {
          now: now(),
          operationId: input.operationId,
          projectId: input.projectId,
          reason: input.reason,
          selectedBy: input.selectedBy ?? "tool",
          sessionId: input.sessionId,
        });
      } catch (error) {
        if (error instanceof ResearchResultRefusal) {
          throw new LocalResearchRefusal(
            error.reason === "operation-not-found" ? "operation-not-found" : "result-not-selectable",
            error.message,
          );
        }
        throw error;
      }
      selections().put(selected.selection);
      // The decision is part of the line's durable history, not only the
      // selection row: an auditor can see that a non-optimal start was chosen.
      const groupOps = all.filter((operation) => researchGroupId(operation) === selected.group.groupId);
      persistParent(
        selected.group.contract,
        selected.group.groupId,
        { projectId: input.projectId, sessionId: input.sessionId },
        groupOps,
        {
          kind: "select",
          operationId: selected.selection.operationId,
          summary: selected.selection.wasBestValid
            ? `selected best valid result ${selected.selection.operationId}`
            : `selected non-optimal result ${selected.selection.operationId}: ${selected.selection.reason.slice(0, 200)}`,
        },
      );
      const updatedGroups = deriveResearchResultGroups(
        operations().listForSession(input.projectId, input.sessionId),
        selections().listForSession(input.projectId, input.sessionId),
      );
      const group = updatedGroups.find((candidate) => candidate.groupId === selected.group.groupId)!;
      const projected = projectResearchParent({
        contract: group.contract,
        existing: parents().get(input.projectId, input.sessionId, group.groupId),
        groupId: group.groupId,
        identity: { projectId: input.projectId, sessionId: input.sessionId },
        limits: settings.parentBudget,
        now: now(),
        operations: groupOps,
      });
      const parentView = researchParentView(
        projected,
        groupOps,
        now(),
        preparationsFor(input.projectId, input.sessionId),
        groupOps.flatMap((operation) => operation.agentUsage === undefined ? [] : [operation.agentUsage]),
      );
      return { ...group, parent: { ...parentView, decisions: parentView.decisions.slice(-20) } };
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
  if (left.kind === "task-package" && right.kind === "task-package") {
    if (left.entrypoint !== right.entrypoint) return false;
    // When both sides carry the actual package identity, it must agree. An
    // older record without hashes is left readable but never treated as proof
    // that the evaluated bytes were the same.
    if (left.entrypointSha256 !== undefined && right.entrypointSha256 !== undefined
      && left.entrypointSha256 !== right.entrypointSha256) return false;
    if (left.packageSha256 !== undefined && right.packageSha256 !== undefined
      && left.packageSha256 !== right.packageSha256) return false;
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

/**
 * Append the round's structured proposal and the explicit selection reason to
 * the researcher's instruction. The engine still runs one bounded task; this
 * text is what makes the round's evidence and stopping rule visible to it.
 */
function withRoundContext(
  base: string | undefined,
  proposal: ExperimentProposal | undefined,
  selection: ScienceFlowLocalResearchOperation["followedSelection"] | undefined,
): string | undefined {
  const parts: string[] = [];
  if (base?.trim()) parts.push(base.trim());
  if (selection) {
    parts.push([
      "## Explicit starting-point decision",
      "",
      `This round follows the result of operation \`${selection.operationId}\` (artifact version \`${selection.versionId}\`).`,
      `Recorded reason: ${selection.reason}`,
      "Do not silently replace this starting candidate; report any deviation.",
    ].join("\n"));
  }
  if (proposal) {
    const evidence = proposal.evidence.map((entry) => entry.kind === "artifact-version"
      ? `- artifact version \`${entry.versionId}\`: ${entry.fact}`
      : `- research operation \`${entry.operationId}\`: ${entry.fact}`).join("\n");
    parts.push([
      "## This round's structured proposal",
      "",
      `Research question: ${proposal.researchQuestion}`,
      "",
      `Evidence read for this round:\n${evidence}`,
      "",
      `Concrete method change: ${proposal.methodChange}`,
      "",
      `Expected observable result: ${proposal.expectedObservation}`,
      "",
      `Fixed evaluation method: ${proposal.evaluationMethod}`,
      "",
      `Stop condition for this round: ${proposal.stopCondition}`,
      ...(proposal.subBudgetSeconds === null ? [] : ["", `Sub-budget: ${proposal.subBudgetSeconds}s of engine wall clock.`]),
      ...(proposal.repeat === null ? [] : [
        "",
        `Declared randomized repeat (${proposal.repeat.repetitions} repetitions): ${proposal.repeat.purpose}. Randomness: ${proposal.repeat.randomness}.`,
      ]),
      "",
      "Carry out this method change. Do not merely restate the previous plan, and do not substitute a different experiment.",
    ].join("\n"));
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
