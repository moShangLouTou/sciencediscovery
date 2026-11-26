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

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchExecutionTransport } from "../research/engine-service.js";
import type { ResearchEngineInspection, ResearchEngineLaunch, ResearchEngineObservation, ResearchOperationWriter } from "../research/engine-adapter.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import type { ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchEngineFacts, ScienceFlowLocalResearchState,
  ScienceFlowLocalResearchStage, ScienceFlowLocalResearchUsage, ScienceFlowLocalResearchDelivery } from "./local-research-record.js";
import { readStageRows, readUsage, runResearchPilotEngine, type ResearchPilotLauncher, type ResearchPilotReceipt, type ResearchPilotSessionStore } from "./research-pilot.js";
const TERMINAL_ENGINE_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);
const OBSERVE_POLL_MS = 2_000;
const STOP_CONFIRM_TIMEOUT_MS = 30_000;
const ENGINE_STOP_TIMEOUT_SEC = 20;
export interface ScienceFlowExecutionTransportInput {
  readonly store: ResearchPilotSessionStore;
  readonly settings: Pick<ScienceFlowLocalResearchSettings, "taskDescription">;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly deadlineFor: (record: ScienceFlowLocalResearchOperation) => string | undefined;
  readonly launch?: ResearchPilotLauncher;
}
/** Communicate with the managed engine and convert its receipts, states and progress. */
export function createScienceFlowExecutionTransport(input: ScienceFlowExecutionTransportInput):
  ResearchExecutionTransport<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery> {
  const { store, settings, now, sleep } = input;
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

  return {
    engine: "scienceflow",
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
      const receipt = await runResearchPilotEngine(store, pilotRequest(current), {
        ...(input.launch ? { launch: input.launch } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
