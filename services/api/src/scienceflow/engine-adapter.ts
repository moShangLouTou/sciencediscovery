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
 * ScienceFlow as the first concrete research engine adapter.
 *
 * Everything engine-specific about one operation lives here: staging the frozen
 * input bytes, materialising a prepared task's evaluator, refusing a model that
 * changed after acceptance, invoking the Python pilot, reading the engine's
 * control record / stage ledger / provider usage, stopping the managed run and
 * publishing its result through `result-delivery`. The shared lifecycle in
 * `../research/operation-lifecycle.ts` decides when each of these may run.
 *
 * What stays in `local-research.ts`: the SF domain on top of the adapter —
 * accepted-request validation, task catalog/preparation, experiment proposals,
 * result groups, best/selected relations and research-line budgets. The budget
 * verdict is passed in as a callback so this module does not own ranking or
 * continuation semantics.
 *
 * The adapter keeps the engine's original behaviour unchanged: the same record
 * shapes, the same Python stop program, the same receipt semantics and the same
 * "an unreadable run is unknown, never relaunched" rule.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReadScienceFlowRunSnapshotOptions,
  ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";

import type {
  ResearchEngineAdapter,
  ResearchEngineBeforeLaunch,
  ResearchEngineInspection,
  ResearchEngineLaunch,
  ResearchEngineObservation,
  ResearchEnginePreparation,
  ResearchLifecycleTransitions,
  ResearchOperationWriter,
} from "../research/engine-adapter.js";
import {
  writeDeliveryRecord,
  type ScienceFlowResultDeliveryRecord,
  type ScienceFlowResultDeliveryRequest,
} from "./result-delivery.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import {
  InputPreparationRefusal,
  sha256,
  stageResearchOperationInputs,
  type StagedDataSelection,
  type StagedInputSelection,
} from "./local-research-inputs.js";
import { materializePreparedTaskAssets } from "./local-research-task-service.js";
import {
  isTerminalResearchState,
  type ScienceFlowLocalResearchArtifactRef,
  type ScienceFlowLocalResearchDelivery,
  type ScienceFlowLocalResearchEngineFacts,
  type ScienceFlowLocalResearchGrant,
  type ScienceFlowLocalResearchOperation,
  type ScienceFlowLocalResearchStage,
  type ScienceFlowLocalResearchState,
  type ScienceFlowLocalResearchUsage,
} from "./local-research-record.js";
import {
  readStageRows,
  readUsage,
  resolveResearchPilotModel,
  ResearchPilotRefusal,
  runResearchPilot,
  type ResearchPilotLauncher,
  type ResearchPilotReceipt,
} from "./research-pilot.js";
import type { LocalResearchServiceStore } from "./local-research.js";

/** Engine lifecycle states after which a run never continues on its own. */
const TERMINAL_ENGINE_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);

/** A bounded wait polls the engine record at this interval. */
const OBSERVE_POLL_MS = 2_000;
/** How long one stop request waits for the engine to record termination. */
const STOP_CONFIRM_TIMEOUT_MS = 30_000;
/** The engine's own stop call deadline; the confirmation poll outlasts it. */
const ENGINE_STOP_TIMEOUT_SEC = 20;

/** The delivery callable the service already substitutes in tests. */
export type ScienceFlowResultDelivery = (
  store: LocalResearchServiceStore,
  request: ScienceFlowResultDeliveryRequest,
  dependencies: { readonly now?: () => string },
) => Promise<ScienceFlowResultDeliveryRecord>;

/** The research-line budget verdict the lifecycle asks for before a launch. */
export type ScienceFlowDeadlineVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "tighten"; readonly grant: ScienceFlowLocalResearchGrant };

export interface ScienceFlowEngineAdapterInput {
  readonly store: LocalResearchServiceStore;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly readArtifactBytes: (hash: string) => Promise<Buffer>;
  readonly deliver: ScienceFlowResultDelivery;
  readonly ownerStopped: (sessionId: string, runId: string) => Promise<boolean>;
  /** The absolute research-line deadline for this operation, when configured. */
  readonly deadlineFor: (record: ScienceFlowLocalResearchOperation) => string | undefined;
  /** The last budget verdict before a launch; SF research-line policy stays outside. */
  readonly deadlineVerdict: (record: ScienceFlowLocalResearchOperation) => ScienceFlowDeadlineVerdict;
  /** Persist the line projection after the grant was tightened to its deadline. */
  readonly persistLineAfterTighten: (record: ScienceFlowLocalResearchOperation) => void;
  /** The real detached-supervisor launcher; tests substitute one. */
  readonly launch?: ResearchPilotLauncher;
  /** Passed to the existing snapshot query during readback; tests substitute one. */
  readonly readSnapshot?: (
    options: ReadScienceFlowRunSnapshotOptions,
  ) => Promise<ScienceFlowSnapshotReadResult>;
}

/** Build the ScienceFlow adapter over the service's existing helpers. */
export function createScienceFlowEngineAdapter(
  input: ScienceFlowEngineAdapterInput,
): ResearchEngineAdapter<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery> {
  const { store, settings, now, sleep } = input;
  const { readArtifactBytes, deliver } = input;

  const transitions: ResearchLifecycleTransitions<ScienceFlowLocalResearchOperation> = {
    deliveryFailed(record, message) {
      return {
        ...record,
        delivery: {
          attempts: record.delivery.attempts + 1,
          message,
          reason: "publication-failed",
          state: "failed",
          updatedAt: now(),
        },
      };
    },
    failed(record, step, message) {
      return { ...record, state: "failed", error: { message, step } };
    },
    stopped(record) {
      return { ...record, state: "stopped" };
    },
    stoppedByConversation(record, at) {
      return {
        ...record,
        state: "stopped",
        stop: record.stop.requestedAt
          ? record.stop
          : { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" },
      };
    },
    stopping(record, at, requestedBy) {
      return {
        ...record,
        state: record.state === "completed" || record.state === "failed" ? record.state : "stopping",
        stop: { ...record.stop, requestedAt: at, requestedBy },
      };
    },
    stopRequestedByConversation(record, at) {
      return {
        ...record,
        stop: { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" },
      };
    },
    stopResult(record, at, result) {
      return {
        ...record,
        state: result.confirmed ? "stopped" : record.state,
        engine: { ...record.engine, ...(result.confirmed ? { status: "stopped" } : {}) },
        stop: {
          ...record.stop,
          ...(result.confirmed ? { confirmedAt: at, engineStatus: "stopped" } : {}),
          ...(result.error ? { lastError: result.error } : {}),
        },
      };
    },
    unknown(record) {
      return { ...record, state: "unknown" };
    },
  };

  const pilotRequest = (record: ScienceFlowLocalResearchOperation) => {
    const deadlineAt = input.deadlineFor(record);
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

  const readEngineFacts = async (
    record: ScienceFlowLocalResearchOperation,
  ): Promise<ScienceFlowLocalResearchEngineFacts> => {
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
   * from its own task_runtime registry. A dirty checkout can produce a different
   * package than a previous run; this file proves which bytes ran.
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

  const readProgress = async (record: ScienceFlowLocalResearchOperation): Promise<{
    readonly stages: readonly ScienceFlowLocalResearchStage[];
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

  /**
   * Stage this operation's own input directory, if the profile uses dynamic
   * inputs. The staged bytes are proven equal to the digests frozen at start.
   */
  const stageInputs = async (
    record: ScienceFlowLocalResearchOperation,
    signal: AbortSignal,
    writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
  ): Promise<ScienceFlowLocalResearchOperation | undefined> => {
    const roles: StagedInputSelection[] = (record.inputs ?? []).flatMap((stagedInput) =>
      stagedInput.stagedName !== undefined && stagedInput.versionId !== null
        ? [{
            role: stagedInput.role,
            sha256: stagedInput.sha256,
            size: stagedInput.size,
            stagedName: stagedInput.stagedName,
            versionId: stagedInput.versionId,
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
      return writer.mutate(record.operationId, (current) => ({
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
        writer.mutate(record.operationId, (current) => ({
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
      writer.mutate(record.operationId, (current) => current.stop.requestedAt
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
    writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
  ): Promise<ScienceFlowLocalResearchOperation | undefined> => {
    const binding = record.taskBinding;
    if (!binding || binding.source !== "prepared") return record;
    if (binding.assetDir !== undefined) return record;
    if (binding.taskVersionId === undefined || binding.contractHash === undefined) {
      writer.mutate(record.operationId, (current) => ({
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
      return writer.mutate(record.operationId, (current) => ({
        ...current,
        taskBinding: {
          ...binding,
          assetDir: join(record.workDir, "task"),
          assetManifestSha256: assets.manifestSha256,
        },
      }));
    } catch (error) {
      writer.mutate(record.operationId, (current) => ({
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

  return {
    engine: "scienceflow",
    transitions,
    async prepare(
      record: ScienceFlowLocalResearchOperation,
      signal: AbortSignal,
      writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
    ): Promise<ResearchEnginePreparation<ScienceFlowLocalResearchOperation>> {
      if (settings.inputMode !== "dynamic") return { proceed: true, record };
      const staged = await stageInputs(record, signal, writer);
      if (!staged) return { proceed: false, record: writer.get(record.operationId) ?? record };
      let current = staged;
      // Preparation is asynchronous: the session may have been cancelled or the
      // run stopped while the bytes were staged, with no worker left to read a
      // result. Re-check both before the launch.
      if (current.stop.requestedAt) {
        return { proceed: false, record: writer.mutate(current.operationId, (item) => ({ ...item, state: "stopped" })) };
      }
      if (await input.ownerStopped(current.identity.sessionId, current.ownerRunId)) {
        return {
          proceed: false,
          record: writer.mutate(current.operationId, (item) => transitions.stoppedByConversation(item, now())),
        };
      }
      const modelRefusal = frozenModelRefusal(current);
      if (modelRefusal !== undefined) {
        return {
          proceed: false,
          record: writer.mutate(current.operationId, (item) => transitions.failed(item, "model-selection", modelRefusal)),
        };
      }
      const withAssets = await stageTaskAssets(current, writer);
      if (!withAssets) return { proceed: false, record: writer.get(record.operationId) ?? current };
      current = withAssets;
      return { proceed: true, record: current };
    },

    beforeLaunch(
      record: ScienceFlowLocalResearchOperation,
      writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
    ): ResearchEngineBeforeLaunch<ScienceFlowLocalResearchOperation> {
      const verdict = input.deadlineVerdict(record);
      if (verdict.kind === "refused") {
        return { record, refusal: { message: verdict.message, step: "budget" } };
      }
      if (verdict.kind === "tighten") {
        const tightened = writer.mutate(record.operationId, (current) => ({
          ...current,
          launch: { ...current.launch, grant: verdict.grant },
        }));
        input.persistLineAfterTighten(tightened);
        return { record: tightened };
      }
      return { record };
    },

    async launch(
      record: ScienceFlowLocalResearchOperation,
      writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
    ): Promise<ResearchEngineLaunch<ScienceFlowLocalResearchOperation>> {
      writer.mutate(record.operationId, (current) => ({
        ...current,
        state: "running",
        launch: { ...current.launch, launchedAt: now() },
      }));
      const current = writer.get(record.operationId) ?? record;
      const receipt = await runResearchPilot(store, pilotRequest(current), {
        ...(input.launch ? { launch: input.launch } : {}),
        ...(input.readSnapshot ? { readSnapshot: input.readSnapshot } : {}),
        now,
      });
      const observedEngine = await readEngineFacts(current);
      const updated = writer.mutate(record.operationId, (stored) => {
        const applied = applyReceipt(stored, receipt);
        return {
          ...applied,
          engine: {
            ...applied.engine,
            ...(observedEngine.evaluator === undefined ? {} : { evaluator: observedEngine.evaluator }),
          },
          ...(stored.stop.requestedAt && receipt.launch?.status === "stopped"
            ? { stop: { ...stored.stop, confirmedAt: now(), engineStatus: "stopped" } }
            : {}),
        };
      });
      return { engineRunId: receipt.outcome.engineRunId, record: updated };
    },

    async inspect(record: ScienceFlowLocalResearchOperation): Promise<ResearchEngineInspection<ScienceFlowLocalResearchOperation>> {
      const facts = await readEngineFacts(record);
      return {
        engineRecordObserved: facts.status !== undefined,
        engineTerminal: facts.status !== undefined && TERMINAL_ENGINE_STATUSES.has(facts.status),
        record: { ...record, engine: facts, state: stateFromFacts(record, facts) },
      };
    },

    async observe(
      record: ScienceFlowLocalResearchOperation,
      writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
    ): Promise<ResearchEngineObservation<ScienceFlowLocalResearchOperation>> {
      const facts = await readEngineFacts(record);
      const progress = await readProgress(record);
      // With no engine record, the receipt is the only local record of how the
      // launch ended. It is read, never trusted as a run identity.
      const receiptOutcome = facts.status === undefined ? await readReceiptOutcome(record) : undefined;
      const updated = writer.mutate(record.operationId, (current) => ({
        ...current,
        state: stateFromFacts(current, facts, receiptOutcome),
        engine: facts,
        progress: { ...progress, observedAt: now() },
      }));
      return {
        engineRecordObserved: facts.status !== undefined,
        engineTerminal: facts.status !== undefined && TERMINAL_ENGINE_STATUSES.has(facts.status),
        record: updated,
        stateAfterObservation: updated.state,
      };
    },

    async requestStop(record: ScienceFlowLocalResearchOperation): Promise<{ readonly error?: string }> {
      return await stopEngineRun(record);
    },

    async confirmStop(record: ScienceFlowLocalResearchOperation): Promise<boolean> {
      return await confirmStop(record, sleep);
    },

    async deliver(
      record: ScienceFlowLocalResearchOperation,
      _options: { readonly force: boolean },
    ): Promise<ScienceFlowLocalResearchDelivery> {
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
      return deliveryState(record, delivered);
    },
  };
}

function artifactRef(
  artifact: {
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
