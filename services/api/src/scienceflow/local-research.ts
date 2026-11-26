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
import type { ResearchArtifactStore } from "../research/artifact-publisher.js";
import { observeResearchPreparation } from "../research/preparation.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import type { ArtifactOrigin, ArtifactOriginMeta, ModelInvocationUsage, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type {
  ReadScienceFlowRunSnapshotOptions,
  ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";

import type { ResearchEngineAdapter } from "../research/engine-adapter.js";
import {
  bindExactVersionInput,
  digestInputFile,
  readVerifiedVersionBytes,
  resolveSessionArtifactVersion,
  ResearchInputRefusal,
} from "../research/input-binding.js";
import {
  createResearchTaskService,
  type ResearchTaskLineStore,
  type ResearchTaskProduct,
  type ResearchStartPlan,
} from "../research/task-service.js";
import type { ResearchBudgetLine } from "../research/budget.js";
import { createScienceFlowEngineAdapter } from "./engine-adapter.js";
import {
  deliverScienceFlowResult,
  type ScienceFlowResultDeliveryRecord,
  type ScienceFlowResultDeliveryRequest,
} from "./result-delivery.js";
import {
  SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES,
  type ScienceFlowLocalResearchSettings,
} from "./local-research-config.js";
import {
  composeDynamicTaskText,
  sha256,
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
} from "../research/plan-publication.js";
import {
  isTerminalResearchState,
  SCIENCE_FLOW_LOCAL_RESEARCH_OPERATION_VERSION,
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
  type ResearchContractIdentity,
  researchContractIdentity,
  researchContractIdentityFrom,
  researchGroupId,
  attributableResearchPreparations,
  researchBudgetChild,
  researchLineRefusal,
  researchParentBudgetLine,
  researchParentFromBudgetLine,
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
  resolveResearchPilotModel,
  ResearchPilotRefusal,
  type ResearchPilotLauncher,
  type ResearchPilotReadbackStore,
} from "./research-pilot.js";

/** The stable permission resource a start request is governed under. */
export const LOCAL_RESEARCH_PERMISSION_RESOURCE = "scienceflow:local-research";

/** Kept at this module's original surface; the program now lives with the adapter. */
export { LOCAL_RESEARCH_STOP_PROGRAM } from "./engine-adapter.js";

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
  readonly createArtifactVersion: ResearchArtifactStore["createArtifactVersion"];
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
  /**
   * The engine adapter. Defaults to the ScienceFlow adapter built from the rest
   * of these dependencies; an explicit one substitutes the engine while the
   * shared operation lifecycle, permissions, version binding, cancellation and
   * delivery retry stay unchanged.
   */
  readonly adapter?: ResearchEngineAdapter<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery>;
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

  /** The absolute parent-line deadline, when this deployment configured one. */
  const lineDeadlineFor = (record: ScienceFlowLocalResearchOperation): string | undefined => {
    return parents().get(record.identity.projectId, record.identity.sessionId, researchGroupId(record))?.limits?.deadlineAt;
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
    try {
      return resolveSessionArtifactVersion(
        store,
        { projectId, sessionId },
        versionId,
        label,
      );
    } catch (error) {
      throw inputRefusal(error);
    }
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
    try {
      return await digestInputFile(
        () => readFile(path),
        SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES,
        role,
      );
    } catch (error) {
      throw inputRefusal(error);
    }
  };

  /** Read and verify one linked version's CAS bytes. */
  const readLinkedInput = async (
    role: ScienceFlowLocalResearchInputRole,
    version: NonNullable<ReturnType<LocalResearchServiceStore["getProjectArtifactVersion"]>>,
  ): Promise<{ readonly sha256: string; readonly size: number }> => {
    try {
      return await readVerifiedVersionBytes(store, version, role, readArtifactBytes);
    } catch (error) {
      throw inputRefusal(error);
    }
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
        const expected = await readConfiguredInput(role, configured);
        let bound;
        try {
          bound = await bindExactVersionInput({
            expected,
            identity: { projectId: request.projectId, sessionId: request.sessionId },
            label: role,
            readBytes: readArtifactBytes,
            store,
            versionId,
          });
        } catch (error) {
          if (error instanceof ResearchInputRefusal && error.reason === "link-version-mismatch") {
            throw new LocalResearchRefusal(
              "link-version-mismatch",
              `The ${role} version is not this research profile's configured ${role} input`,
            );
          }
          throw inputRefusal(error);
        }
        inputs.push({ role, sha256: bound.sha256, size: bound.size, versionId });
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

  // ScienceFlow is one concrete engine behind the shared operation lifecycle.
  // The adapter owns engine calls and domain minimums. Product hooks supply
  // task contracts and comparisons to the shared task/budget service.
  const engineAdapter = dependencies.adapter ?? createScienceFlowEngineAdapter({
    deadlineFor: lineDeadlineFor,
    deliver,
    now,
    ownerStopped,
    readArtifactBytes,
    ...(dependencies.launch ? { launch: dependencies.launch } : {}),
    ...(dependencies.readSnapshot ? { readSnapshot: dependencies.readSnapshot } : {}),
    settings,
    sleep,
    store,
  });
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

  /** Preparation wall clock attributable to one frozen scientific contract. */
  const attributablePreparationSeconds = (
    projectId: string,
    sessionId: string,
    contract: ResearchContractIdentity,
  ): number => {
    return attributableResearchPreparations(contract, preparationsFor(projectId, sessionId))
      .reduce(
        (total, preparation) => total
          + (preparation.wallClock.status === "known" ? preparation.wallClock.seconds : 0),
        0,
      );
  };

  const lineFactsFor = (
    record: ScienceFlowLocalResearchOperation,
  ): { children: readonly ReturnType<typeof researchBudgetChild>[]; extraChargedSeconds: number; limits?: { maxChildRuns: number; totalAllowanceSec: number }; lineId: string; lineKey: string } => {
    const groupId = researchGroupId(record);
    const contract = researchContractIdentity(record);
    const groupOps = groupOperations(record.identity.projectId, record.identity.sessionId, groupId);
    return {
      children: groupOps.map(researchBudgetChild),
      extraChargedSeconds: attributablePreparationSeconds(
        record.identity.projectId,
        record.identity.sessionId,
        contract,
      ),
      ...(settings.parentBudget === undefined ? {} : { limits: settings.parentBudget }),
      lineId: `sf-parent-${groupId.replace(/^sfc-/u, "")}`,
      lineKey: groupId,
    };
  };

  /** The shared budget ledger over the existing ScienceFlow parent rows. */
  const lines: ResearchTaskLineStore<ScienceFlowLocalResearchOperation> = {
    get(projectId, sessionId, lineKey) {
      const parent = parents().get(projectId, sessionId, lineKey);
      return parent === undefined ? undefined : researchParentBudgetLine(parent);
    },
    put(line: ResearchBudgetLine, record) {
      const existing = parents().get(record.identity.projectId, record.identity.sessionId, line.lineKey);
      // Preserve the frozen scientific contract when the shared ledger updates
      // reservations, settlements, decisions or the stop marker.
      parents().put(researchParentFromBudgetLine(
        line,
        existing?.contract ?? researchContractIdentity(record),
        line.lineKey,
      ));
    },
  };

  /**
   * ScienceFlow's product half of the shared task service: its model resolution,
   * task selection, input binding, proposal rules, frozen grant and engine
   * adapter. Deduplication, admission, persistence, budget reservation,
   * observation, cancellation and delivery retry are the shared service.
   */
  const planStart = async (
    request: LocalResearchStartInput,
  ): Promise<ResearchStartPlan<ScienceFlowLocalResearchOperation>> => {
    request.signal?.throwIfAborted();
    const intent = request.intent.trim();
    if (!intent || intent.length > 2_000 || intent.includes("\u0000")) {
      throw new LocalResearchRefusal("invalid-option", "The research intent must be 1-2000 characters without NUL bytes");
    }
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
    const groupOps = await taskService.lifecycle.reconcile(
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
    const resolvedKey = idempotencyKey({ ...effectiveRequest, intent });
    // A replay of the same request after an automatic selection must attach to
    // its existing operation instead of being refused as a repeated experiment.
    const resolvedExisting = operations().findByIdempotency(
      request.projectId,
      request.sessionId,
      resolvedKey,
    );
    if (resolvedExisting) return { attachTo: resolvedExisting };
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
      engineId: settings.profileId,
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
    return {
      dedupeKey: resolvedKey,
      line: {
        allowanceSec: childTotalAllowanceSec,
        children: groupOps.map(researchBudgetChild),
        extraChargedSeconds: attributablePreparationSeconds(request.projectId, request.sessionId, contract),
        ...(settings.parentBudget === undefined ? {} : { limits: settings.parentBudget }),
        lineId: `sf-parent-${groupId.replace(/^sfc-/u, "")}`,
        lineKey: groupId,
        startSummary: `started ${operationId} with a ${settings.defaults.totalAllowanceSec}s reservation`,
      },
      record,
    };
  };

  const taskProduct: ResearchTaskProduct<
    LocalResearchStartInput,
    ScienceFlowLocalResearchDelivery,
    ScienceFlowLocalResearchOperation,
    ScienceFlowLocalResearchView
  > = {
    engineId: settings.profileId,
    capabilities: {
      asynchronousLaunch: true,
      confirmsStop: true,
      delivers: "Session artifacts with a result note and captured stages",
      reportsElapsedSec: true,
      reportsTokenUsage: true,
    },
    engine: engineAdapter,
    requestIdentity: (request) => ({
      ownerRunId: request.ownerRunId,
      projectId: request.projectId,
      sessionId: request.sessionId,
    }),
    // The production tool has already passed the governed execution permission;
    // the shared service below still proves Project/Session ownership and write
    // access before this hook runs.
    authorize: () => undefined,
    idempotencyKey: (request) => idempotencyKey({ ...request, intent: request.intent.trim() }),
    planStart: (request) => planStart(request),
    refuse: (reason, message) => new LocalResearchRefusal(reason as LocalResearchRefusalReason, message),
    present: (record) => singleView(record),
    list: (projectId, sessionId, records) => viewsFor(projectId, sessionId, records),
    lineFactsFor,
    afterObserve: async (record) => captureAgentUsage([record]),
    afterStop: async (record) => captureAgentUsage([record]),
  };

  // The shared task service owns admission, deduplication, persistence, budget
  // reservation, background execution, observation, cancellation and retry.
  // ScienceFlow supplies the engine adapter and its scientific rules above.
  const taskService = createResearchTaskService<
    LocalResearchStartInput,
    ScienceFlowLocalResearchDelivery,
    ScienceFlowLocalResearchOperation,
    ScienceFlowLocalResearchView
  >({
    errorMessage,
    lines,
    newOperationId,
    now,
    observeMaxWaitMs: settings.defaults.observeMaxWaitMs,
    operations: operations(),
    ownerStopped,
    product: taskProduct,
    sleep,
    store,
  });

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
      return observeResearchPreparation({
        now,
        work: () => prepareResearchTask(store, input, {
          now, readBytes: readArtifactBytes, settings: adapter, tasksRoot: join(settings.workRoot, "tasks"),
          ...(dependencies.probeTask ? { probe: dependencies.probeTask } : {}),
        }),
        record: (observation) => {
          const publication = observation.outcome === "succeeded" ? observation.value : undefined;
          const failure = observation.outcome === "failed" ? observation.error : undefined;
          const { startedAt, finishedAt } = observation;
          const preparation: ScienceFlowResearchPreparation = {
            error: failure === undefined ? undefined : errorMessage(failure),
            finishedAt,
            identity: { projectId: input.projectId, sessionId: input.sessionId },
            outcome: observation.outcome,
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
              seconds: observation.elapsedSeconds ?? 0,
              status: observation.elapsedSeconds === null ? "unknown" : "known",
            },
          };
          preparations().record(preparation);
        },
      });
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
      const outcome = await taskService.start(request);
      return {
        attached: outcome.attached,
        operation: outcome.view,
        ...(outcome.attachedReason === undefined ? {} : { attachedReason: outcome.attachedReason }),
      };
    },

    async get(
      request: LocalResearchOperationInput,
      options: { readonly waitMs?: number; readonly signal?: AbortSignal } = {},
    ): Promise<ScienceFlowLocalResearchView> {
      const observed = await taskService.get(request, options);
      return observed.view;
    },

    async stop(request: LocalResearchOperationInput): Promise<LocalResearchStopOutcome> {
      const outcome = await taskService.stop(request);
      return {
        confirmed: outcome.confirmed,
        operation: outcome.view,
        requested: outcome.requested,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    },

    async retryDelivery(request: LocalResearchOperationInput): Promise<ScienceFlowLocalResearchView> {
      // Publication only: the experiment's identity and state are untouched.
      // A delivered result is republished idempotently (unchanged bytes reuse
      // their version) so a corrected note can reach the Session.
      const updated = await taskService.retryDelivery(request);
      return updated.view;
    },

    async requestStopForConversationRun(sessionId: string, runId: string): Promise<void> {
      await taskService.cancelOwnerRun(sessionId, runId);
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
      return taskService.latest(projectId, sessionId);
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

/** Map a shared input-binding refusal to this service's stable reason codes. */
function inputRefusal(error: unknown): unknown {
  if (!(error instanceof ResearchInputRefusal)) return error;
  const reason: LocalResearchRefusalReason = error.reason;
  return new LocalResearchRefusal(reason, error.message);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}
