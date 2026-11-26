// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** The common task service's adapter to the common supervised Runner protocol. */
import { createHash } from "node:crypto";
import { CasStore } from "@sciencediscovery/cas";
import { RunnerHttpError, type RunnerClient } from "@sciencediscovery/executor";
import { canonicalResearchInputBundleManifest, type ManagedExecution, type ResearchRunRequest,
  type ScientificArtifactKind } from "@sciencediscovery/schema";
import { bindExactVersionInput, type ResearchInputStore } from "./input-binding.js";
import { publishArtifactVersion, resolveLinkedArtifactVersion, type PublishedArtifact,
  type ResearchLinkedVersionStore } from "./artifact-publisher.js";
import type { ResearchEngineAdapter, ResearchLifecycleState } from "./engine-adapter.js";
import type { ResearchTaskRecord } from "./task-record.js";

export interface RunnerTaskDelivery {
  readonly state: "pending" | "delivered" | "failed";
  readonly attempts: number;
  readonly updatedAt: string;
  readonly outputs: readonly PublishedArtifact[];
  readonly lastError?: string;
}
export interface RunnerTaskRecord extends ResearchTaskRecord<RunnerTaskDelivery> {
  readonly runner: {
    readonly request: ResearchRunRequest;
    readonly inputs: readonly { readonly versionId: string; readonly path: string; readonly roles: readonly string[];
      readonly sha256: string; readonly size: number }[];
    readonly outputs: readonly { readonly path: string; readonly logicalName: string; readonly title: string;
      readonly kind: ScientificArtifactKind; readonly mediaType: string }[];
  };
  readonly engine: { readonly status?: string; readonly elapsedSec?: number };
}
export type ResearchRunnerClient = Pick<RunnerClient, "prepareResearchInputBundle" | "submitResearchExecution"
  | "getShellExecution" | "cancelShellExecution" | "readResearchExecutionFile">;

function stateOf(execution: ManagedExecution): ResearchLifecycleState {
  if (execution.state === "queued" || execution.state === "running") return "running";
  if (execution.state === "unknown") return "unknown";
  // The ledger can expose completion while the immutable snapshot is still
  // being committed. Keep observing until successful output can be delivered.
  if (execution.state === "completed" && !execution.version) return "running";
  const outcome = execution.research?.outcome;
  if (outcome === "completed" || outcome === "failed" || outcome === "stopped") return outcome;
  if (execution.state === "cancelled") return "stopped";
  return execution.state === "failed" ? "failed" : "unknown";
}

export function createRunnerTaskEngine<Record extends RunnerTaskRecord>(options: {
  readonly client: ResearchRunnerClient;
  readonly store: ResearchLinkedVersionStore & ResearchInputStore;
  readonly now?: () => string;
  readonly stopWaitMs?: number;
}): ResearchEngineAdapter<Record, RunnerTaskDelivery> {
  const { client, store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const owner = (record: Record) => ({ agentId: record.runner.request.agentId, sessionId: record.identity.sessionId });
  const inspect = async (record: Record) => {
    if (!record.engineRunId) return { engineRecordObserved: false, engineTerminal: false, record };
    let execution: ManagedExecution;
    try { execution = await client.getShellExecution(record.engineRunId, owner(record)); }
    catch (error) {
      if (error instanceof RunnerHttpError && error.statusCode === 404) return { engineRecordObserved: false, engineTerminal: false, record };
      throw error;
    }
    const state = stateOf(execution);
    const started = Date.parse(execution.result?.startedAt ?? "");
    const finished = Date.parse(execution.result?.finishedAt ?? "");
    const elapsedSec = Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? (finished - started) / 1000 : undefined;
    return { engineRecordObserved: true, engineTerminal: state !== "running" && state !== "unknown",
      record: { ...record, state, engine: { ...record.engine, status: execution.state,
        ...(elapsedSec === undefined ? {} : { elapsedSec }) } } };
  };
  return {
    engine: "runner",
    transitions: {
      stopped: (record) => ({ ...record, state: "stopped", stop: { ...record.stop, confirmedAt: now() } }),
      stoppedByConversation: (record, at) => ({ ...record, state: "stopped",
        stop: { ...record.stop, requestedAt: at, confirmedAt: at, requestedBy: "conversation-cancel" } }),
      stopping: (record, at, requestedBy) => ({ ...record, state: "stopping", stop: { ...record.stop, requestedAt: at, requestedBy } }),
      stopRequestedByConversation: (record, at) => ({ ...record,
        stop: { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" } }),
      stopResult: (record, at, result) => ({ ...record, state: result.confirmed ? "stopped" : record.state,
        stop: { ...record.stop, ...(result.confirmed ? { confirmedAt: at } : {}), ...(result.error ? { lastError: result.error } : {}) } }),
      failed: (record, step, message) => ({ ...record, state: record.stop.requestedAt && !record.engineRunId ? "stopped" : step === "launch" && record.engineRunId ? "unknown" : "failed", error: { step, message } }),
      unknown: (record) => ({ ...record, state: "unknown" }),
      deliveryFailed: (record, message) => ({ ...record,
        delivery: { ...record.delivery, state: "failed", lastError: message, updatedAt: now() } }),
    },
    async prepare(record, signal) {
      const entries = [];
      for (const input of record.runner.inputs) {
        signal.throwIfAborted();
        const bytes = await new CasStore(store.dataDir).read(input.sha256);
        await bindExactVersionInput({ store, identity: record.identity, versionId: input.versionId, label: input.path,
          expected: input, readBytes: async () => bytes });
        entries.push({ path: input.path, roles: input.roles, size: input.size, sha256: input.sha256, content: bytes.toString("base64") });
      }
      const identity = record.runner.request.inputs;
      if (!identity) throw new Error("Runner task has no frozen input bundle identity");
      const manifest = { schemaVersion: 1 as const, contractDigest: identity.contractDigest,
        files: entries.map(({ content: _content, ...file }) => file) };
      if (createHash("sha256").update(canonicalResearchInputBundleManifest(manifest)).digest("hex") !== identity.bundleDigest) {
        throw new Error("Runner task inputs differ from the frozen bundle identity");
      }
      signal.throwIfAborted();
      await client.prepareResearchInputBundle({ schemaVersion: 1, contractDigest: manifest.contractDigest, bundleDigest: identity.bundleDigest, entries }, signal);
      return { proceed: true, record };
    },
    beforeLaunch(record, writer, budget) {
      const schedule = record.runner.request.schedule;
      const overhead = schedule.reportBudgetMs + schedule.drainGraceMs + schedule.verificationWindowMs;
      const researchBudgetMs = Math.min(schedule.researchBudgetMs, Math.floor((budget?.allowanceSec ?? Infinity) * 1000) - overhead);
      if (researchBudgetMs < 1) return { record, refusal: { step: "budget", message: "The remaining allowance cannot cover the Runner's phase schedule" } };
      const updated = writer.mutate(record.operationId, (current) => ({ ...current,
        runner: { ...current.runner, request: { ...current.runner.request, schedule: { ...schedule, researchBudgetMs } } } }));
      return { record: updated, appliedAllowanceSec: (researchBudgetMs + overhead) / 1000 };
    },
    async launch(record, writer) {
      if (record.runner.request.permissionEpoch.sessionId !== record.identity.sessionId) throw new Error("Runner task owner differs from the authorized Session");
      // Persist the id before the network call: a lost response never loses the
      // handle and observation can reconcile it without another submission.
      const current = writer.mutate(record.operationId, (value) => ({ ...value,
        engineRunId: value.runner.request.executionId, state: "running" }));
      await client.submitResearchExecution(current.runner.request);
      return { record: current, engineRunId: current.engineRunId };
    },
    inspect,
    async observe(record, writer) {
      const seen = await inspect(record);
      const updated = seen.engineRecordObserved ? writer.mutate(record.operationId, (current) => ({ ...current,
        state: seen.record.state, engine: seen.record.engine })) : record;
      return { ...seen, record: updated, stateAfterObservation: updated.state };
    },
    async requestStop(record) {
      if (record.engineRunId) await client.cancelShellExecution(record.engineRunId, owner(record));
      return {};
    },
    async confirmStop(record) {
      if (!record.engineRunId) return true;
      const deadline = Date.now() + (options.stopWaitMs ?? 5000);
      do {
        const execution = await client.getShellExecution(record.engineRunId, owner(record));
        if (execution.state !== "running" && execution.state !== "queued"
          && (execution.research?.process === "not_started" || execution.research?.process === "spawned-then-terminated")) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (true);
    },
    async deliver(record) {
      if (!record.engineRunId) throw new Error("Runner task has no execution handle");
      const execution = await client.getShellExecution(record.engineRunId, owner(record));
      if (!execution.version) throw new Error("Runner execution has no committed result to deliver");
      for (const input of record.runner.inputs) await resolveLinkedArtifactVersion(store, record.identity, input.versionId, input.path);
      const outputs: PublishedArtifact[] = [];
      for (const output of record.runner.outputs) {
        const bytes = await client.readResearchExecutionFile(record.engineRunId, owner(record), output.path);
        outputs.push(await publishArtifactVersion(store, { ...output, bytes, description: output.title,
          sessionId: record.identity.sessionId, inputArtifactVersionIds: record.runner.inputs.map((input) => input.versionId),
          originMeta: { operationId: record.operationId, executionId: execution.id, executionVersion: execution.version.digest } }));
      }
      return { state: "delivered", outputs, attempts: record.delivery.attempts + 1, updatedAt: now() };
    },
  };
}
