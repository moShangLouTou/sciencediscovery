// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ensureWorkspaceBaseline, fenceWorkspaceExecution, releaseWorkspaceExecutionFence, poisonWorkspace, RefStore, snapshotWorkspace, VersionStore, withWorkspaceLease, withWorkspaceAdmission, type AgentStateRef } from "@sciencediscovery/cas";
import { assertRecoveryContext, recoveryRelativePath, unknownRecovery } from "@sciencediscovery/schema";
import { collectExecutionRecovery, validateExecutionRecovery } from "./execution-recovery.js";
import { cleanupExecutionResource, ProcessTerminationUnverifiedError } from "./termination-resources.js";
import {
  captureExecutionBoundaryOutcome,
  isValidExecutionBoundaryHandle,
  observeExecutionBoundary,
  terminateExecutionBoundary,
  type BoundaryCaptureOutcome,
  type ExecutionBoundaryHandle,
  type ExecutionLifecycle,
  type ExecutionObservation,
  type SpawnedExecution,
} from "./execution-boundary.js";
import { ResearchRunError, parseResearchRunRequest, researchExecutionState, researchPublishable, researchRefusalMessage, researchRunDeadlines, researchStopId, verifiedResearchInputs, type ResearchRunExecutor } from "./research-run.js";
import type { ExecutionLogPage, ExecutionOwner, ManagedExecution, ResearchPhase, ResearchReportOutcome, ResearchRunRequest, ResearchRunStatus, ResearchStopState, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";

export type ExecutionLogSink = (stream: "stdout" | "stderr", chunk: Buffer) => void;
/**
 * What an operation resolves to. A shell operation resolves to its process
 * result; a research workload additionally states the research facts, which
 * are never derived from the process result.
 */
export interface ResearchOperationResult {
  readonly research: ResearchRunStatus;
  readonly result: ShellExecutionResult;
}
type OperationResult = ShellExecutionResult | ResearchOperationResult;
/** Resolving or rejecting must join every launched child, including cancellation. */
type Operation = (signal: AbortSignal, log: ExecutionLogSink, expectedEnvironmentRevisionId?: string,
  lifecycle?: ExecutionLifecycle) => Promise<OperationResult>;
/** Rejecting here records a deterministic pre-admission failure; no process is launched. */
type Preflight = (signal: AbortSignal) => Promise<void>;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";

export class ExecutionManagerError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) { super(message); }
}

/** Sort object keys recursively, preserving array order and JSON omission semantics. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
interface PublicationJournal {
  schemaVersion: 1;
  name: string;
  expected: AgentStateRef | null;
  target: AgentStateRef;
  execution: ManagedExecution;
}
const sameRef = (left: AgentStateRef | null | undefined, right: AgentStateRef | null | undefined) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
const conflict = () => new ExecutionManagerError("EXECUTION_ID_CONFLICT", "Execution ID conflicts with an existing submission", 409);

/**
 * Ordering used when a durable fact and an in-flight copy disagree. Only the
 * stronger value survives a merge, so a late operation save can never downgrade
 * a stop the manager already persisted, or a fact the ledger already recorded.
 */
const PHASE_RANK: Readonly<Record<ResearchPhase | "unknown", number>> = { unknown: 0, research: 1, reporting: 2, finished: 3 };
const REPORT_RANK: Readonly<Record<ResearchReportOutcome, number>> = { none: 0, unknown: 0, generating: 1, incomplete: 2, failed: 2, ready: 3 };
const STOP_RANK: Readonly<Record<ResearchStopState, number>> = { none: 0, requested: 1, unconfirmed: 2, consumed: 2 };

/**
 * A research request is the only shape with a workload kind. A shell request
 * has no `kind` field, so every record and request written before research
 * runs existed keeps its original meaning.
 */
function isResearchRequest(request: ShellExecutionRequest | ResearchRunRequest): request is ResearchRunRequest {
  return (request as { kind?: unknown }).kind === "research";
}

/**
 * What a research record publishes as its "code" object. The request carries
 * no shell text, so the published record describes the fixed workload instead
 * of inventing an empty program that could be mistaken for one.
 */
const RESEARCH_WORKLOAD_CODE_MARKER = [
  "# research workload: scienceflow-fixed",
  "# The program is Runner code, not submitted shell text.",
].join("\n");

export interface ExecutionQuarantineDiagnostic {
  phase: "startup" | "runtime" | "publication-recovery";
  executionId: string;
  scope: "runner" | "workspace-and-devices";
  workspaceKeyHash?: string;
  npuDevices?: number[];
}

export interface ExecutionManagerOptions {
  /**
   * Test seam for the kernel identity read that must happen inside the spawn
   * turn. Production leaves it unset and reads /proc directly; no request field
   * can supply or redirect a handle.
   */
  captureBoundary?: (executionId: string, spawned: SpawnedExecution) => BoundaryCaptureOutcome;
  /** Test-only pause after the durable fence, before the final abort check. */
  afterFence?: () => Promise<void>;
  /**
   * The Runner-side fixed research workload. This is a constructor dependency:
   * no route, config value, environment variable or request can supply or
   * replace it. While it is absent — which is every production wiring in this
   * round — a research submission is refused outright instead of falling back
   * to a shell run or the system interpreter.
   */
  research?: ResearchRunExecutor;
}

/** The Runner owns process lifetime; an HTTP request only submits or observes it. */
export class ExecutionManager {
  private readonly db: DatabaseSync;
  private readonly ownership: DatabaseSync;
  private readonly versions: VersionStore;
  private readonly runnerInstanceId: string;
  private readonly runnerBootId = randomUUID();
  private readonly captureBoundary: (executionId: string, spawned: SpawnedExecution) => BoundaryCaptureOutcome;
  private readonly afterFence: (() => Promise<void>) | undefined;
  private readonly resources = new Map<string, Map<() => Promise<void>, string>>();
  private readonly controllers = new Map<string, AbortController>();
  /** Graceful stop registered by a running workload, before any kill exists. */
  private readonly stopHandlers = new Map<string, (stopId: string) => Promise<void>>();
  private readonly research: ResearchRunExecutor | undefined;
  /** Whether the sandbox of one in-flight execution promised a durable boundary. */
  private readonly boundaryExpectations = new Map<string, "required" | "not-applicable" | "ended">();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly failedWorkspaces = new Set<string>();
  private readonly uncertainWorkspaces = new Set<string>();
  private readonly uncertainDevices = new Set<number>();
  private legacyQuarantine = false;
  private readonly reportedQuarantines = new Set<string>();
  private storageHealthy = true;
  private closing = false;
  private recoveryPending = false;
  private readonly recoveringIds = new Set<string>();
  private recovery: Promise<void> = Promise.resolve();
  private readonly recoveryStoreId: string;

  constructor(dataDir: string, private readonly onQuarantine?: (detail: ExecutionQuarantineDiagnostic) => void,
    options: ExecutionManagerOptions = {}) {
    this.captureBoundary = options.captureBoundary ?? captureExecutionBoundaryOutcome;
    this.afterFence = options.afterFence;
    this.research = options.research;
    const root = resolve(dataDir, "runner-executions");
    const ledgerPath = resolve(root, "executions.sqlite");
    const existingLedger = existsSync(ledgerPath);
    // SQLite treats an empty or missing file as a fresh database. That is unsafe
    // once the ledger directory existed: it could forget all previously used IDs.
    if (existsSync(root) && (!existsSync(ledgerPath) || statSync(ledgerPath).size === 0)) {
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger is missing or empty; restore its original data before accepting submissions", 503);
    }
    mkdirSync(root, { recursive: true });
    // A separate SQLite writer transaction is an OS-owned lifetime lock, just
    // like Workspace leases. It releases on crash without trusting a stale PID.
    // The execution ledger itself remains free for short durable transactions.
    this.ownership = new DatabaseSync(resolve(root, "runner-owner.sqlite"));
    try { this.ownership.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch (error) {
      this.ownership.close();
      if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
        throw new ExecutionManagerError("RUNNER_ALREADY_ACTIVE", "Another Runner already owns this execution ledger", 503);
      }
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger ownership cannot be established", 503);
    }
    try { this.db = new DatabaseSync(ledgerPath); }
    catch (error) { this.ownership.close(); throw error; }
    try {
      const schemaVersion = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (schemaVersion > 2) throw new Error("Execution ledger schema is newer than this Runner");
      if (existingLedger) {
        const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
        if (!tables.has("executions") || !tables.has("logs")) throw new Error("Execution ledger tables are missing");
      }
      const integrity = this.db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Execution ledger integrity check failed");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (execution TEXT NOT NULL, cursor INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
          PRIMARY KEY(execution, cursor));
        CREATE TABLE IF NOT EXISTS execution_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_publications (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_boundaries (execution TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_resources (execution TEXT PRIMARY KEY, environment TEXT);
        CREATE TABLE IF NOT EXISTS runtime_check_reservations (environment TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recovery_store (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);`);
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("INSERT OR IGNORE INTO recovery_store VALUES (1, ?)").run(randomUUID());
      this.recoveryStoreId = String(this.db.prepare("SELECT id FROM recovery_store WHERE singleton = 1").get()!.id);
      const records = this.db.prepare("SELECT id, session, agent, record FROM executions").all();
      const identity = this.db.prepare("SELECT value FROM execution_metadata WHERE key = 'runnerInstanceId'").get();
      // Never replace missing identity metadata if receipts already depended on it.
      if (!identity && records.some(row => (JSON.parse(String(row.record)) as ManagedExecution).receipt)) {
        throw new Error("Execution ledger identity is missing");
      }
      this.runnerInstanceId = identity ? String(identity.value) : randomUUID();
      if (!/^[a-f0-9-]{36}$/i.test(this.runnerInstanceId)) throw new Error("Execution ledger identity is invalid");
      if (!identity) this.db.prepare("INSERT INTO execution_metadata VALUES ('runnerInstanceId', ?)").run(this.runnerInstanceId);
      this.db.exec("PRAGMA user_version=2");
      for (const row of records) {
        const execution = JSON.parse(String(row.record)) as ManagedExecution;
        if (!execution || execution.id !== row.id || execution.sessionId !== row.session || execution.agentId !== row.agent
          || !["queued", "running", "completed", "failed", "cancelled", "unknown"].includes(execution.state)
          || !execution.queuedAt || (execution.receipt && (execution.receipt.runnerInstanceId !== this.runnerInstanceId
            || !Number.isSafeInteger(execution.receipt.revision) || execution.receipt.revision < 1))) {
          throw new Error("Execution ledger contains an invalid record");
        }
        if (!terminal(execution.state)) {
          execution.state = "unknown";
          delete execution.finishedAt;
          execution.error = "Runner restarted before completion was recorded; process state is unverified and the command was not replayed";
          // Preserve real exit evidence if it was durably recorded before a commit interruption.
          this.save(execution);
        }
        if (execution.state === "unknown") this.quarantine(execution, "startup");
        // Exit without a rooted version is not a safely committed Workspace, even across restart.
        if (execution.state === "failed" && execution.startedAt && execution.evidence?.processTerminated && !execution.version) this.quarantine(execution, "startup");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction may have begun */ }
      this.db.close();
      this.ownership.close();
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", `Execution ledger cannot be trusted; new submissions are disabled: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    // Reconcile observations for work the previous Runner process could not
    // settle, before any caller can ask about it.
    this.reconcileRecordedBoundaries();
    this.versions = new VersionStore(dataDir);
    if (this.db.prepare("SELECT 1 FROM execution_publications LIMIT 1").get()
      || this.uncertainWorkspaces.size > 0) {
      this.recoveryPending = true;
      for (const row of this.db.prepare("SELECT id FROM execution_publications").all()) this.recoveringIds.add(String(row.id));
      this.recovery = this.restoreExecutionFences().then(() => this.recoverPublications())
        .finally(() => { this.recoveryPending = false; });
      void this.recovery.catch(() => { this.storageHealthy = false; });
    }
  }

  /** Startup publication recovery never dispatches computation. Observers may keep polling meanwhile. */
  ready(): Promise<void> { return this.recovery; }

  get identity(): { runnerInstanceId: string; runnerBootId: string } {
    return { runnerInstanceId: this.runnerInstanceId, runnerBootId: this.runnerBootId };
  }

  /** Also guard synchronous Runner entry points sharing these resources. */
  assertResourcesAvailable(request: Pick<ShellExecutionRequest, "workspaceRoot" | "npuDevices">): void {
    if (!this.storageHealthy) throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger cannot be trusted; new submissions are disabled", 503);
    if (this.recoveryPending) throw new ExecutionManagerError("EXECUTION_RECOVERY_PENDING", "Runner is verifying interrupted result publications; retry observation shortly", 503);
    const devices = request.npuDevices ?? [];
    if (!Array.isArray(devices) || devices.some(device => !Number.isSafeInteger(device) || device < 0)) throw new Error("Invalid NPU device selection");
    if (this.legacyQuarantine || this.uncertainWorkspaces.has(request.workspaceRoot) || devices.some(device => this.uncertainDevices.has(device))) {
      throw new ExecutionManagerError("EXECUTION_RESOURCE_QUARANTINED", "An earlier execution has unverified process state; affected workspace or NPU resources cannot accept new work", 409);
    }
    if (this.failedWorkspaces.has(request.workspaceRoot)) throw new ExecutionManagerError("WORKSPACE_COMMIT_FAILED", "Workspace version commit failed; repair storage before restarting the Runner", 409);
  }

  start(request: ShellExecutionRequest, operation: Operation): ManagedExecution {
    return this.submit(request, operation).execution;
  }

  submit(request: ShellExecutionRequest, operation: Operation, preflight?: Preflight): { execution: ManagedExecution; accepted: boolean } {
    return this.submitInternal(request, operation, preflight);
  }

  /**
   * Accept one trusted internal research run.
   *
   * The caller supplies a research request, never an operation: the workload
   * program and its launcher are the Runner's own constructor dependencies, so
   * there is no parameter through which a caller could name a program, a path
   * or a fallback interpreter. A Runner without that dependency refuses before
   * anything is written to the ledger.
   */
  submitResearch(value: unknown): { execution: ManagedExecution; accepted: boolean } {
    const executor = this.research;
    if (!executor) {
      throw new ExecutionManagerError("RESEARCH_RUN_NOT_CONFIGURED",
        researchRefusalMessage("RESEARCH_RUN_NOT_CONFIGURED"), 409);
    }
    let request: ResearchRunRequest;
    try {
      request = parseResearchRunRequest(value);
    } catch (error) {
      if (error instanceof ResearchRunError) throw new ExecutionManagerError(error.code, error.message, 400);
      throw error;
    }
    // Every new execution consumes one prepared bundle. A request without that
    // identity is refused before the ledger is touched: there is no fallback to
    // workspace files, and no record is written that could imply one.
    if (request.inputs === undefined) {
      throw new ExecutionManagerError("RESEARCH_INPUT_REQUIRED",
        researchRefusalMessage("RESEARCH_INPUT_REQUIRED"), 400);
    }
    return this.submitInternal(request, (signal, _log, expectedEnvironmentRevisionId, lifecycle) =>
      executor.run(request, { expectedEnvironmentRevisionId, lifecycle, signal }));
  }

  private submitInternal(request: ShellExecutionRequest | ResearchRunRequest, operation: Operation,
    preflight?: Preflight): { execution: ManagedExecution; accepted: boolean } {
    if (this.closing) throw new ExecutionManagerError("RUNNER_SHUTTING_DOWN", "Runner is shutting down", 503);
    if (!this.storageHealthy) throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger cannot be trusted; new submissions are disabled", 503);
    if (!/^[A-Za-z0-9_:.-]{1,160}$/.test(request.executionId)) throw new Error("Invalid Execution ID");
    // Bind the deferred admission and the digest to one immutable request snapshot.
    request = structuredClone(request);
    // Identity and time fields are shared; recovery, handoff and shell text
    // exist only on a shell request and are never invented for a research one.
    const shell = isResearchRequest(request) ? undefined : request;
    const researchRequest = isResearchRequest(request) ? request : undefined;
    if (request.environmentId !== undefined && (typeof request.environmentId !== "string"
      || request.environmentId.length === 0 || request.environmentId.trim() !== request.environmentId)) {
      throw new Error("Invalid environment ID");
    }
    if (shell?.recoveryContext) assertRecoveryContext(shell.recoveryContext);
    if (shell?.recoveryMetadataPath !== undefined && !recoveryRelativePath(shell.recoveryMetadataPath)) throw new Error("UNSAFE_RECOVERY_PATH");
    const owner = { agentId: request.agentId, sessionId: request.permissionEpoch.sessionId };
    const requestDigest = digest(request);
    const key = request.workspaceRoot; // already canonicalized by the authenticated endpoint
    const npuDevices = request.npuDevices ?? [];
    if (!Array.isArray(npuDevices) || npuDevices.some(device => !Number.isSafeInteger(device) || device < 0)) throw new Error("Invalid NPU device selection");
    const acceptedAt = new Date().toISOString();
    const execution: ManagedExecution = { ...owner, id: request.executionId, state: "queued", queuedAt: acceptedAt,
      workspaceKey: key, npuDevices: [...npuDevices],
      // Acceptance itself is a research fact: the record exists and nothing has
      // been launched. `not_started` here is positive evidence about the record,
      // not an inference from a missing report, and the operation replaces it
      // as soon as the workload is actually spawned.
      ...(researchRequest ? { workload: "research" as const, research: {
        workload: researchRequest.workload, schemaVersion: researchRequest.schemaVersion,
        phase: "unknown" as const, outcome: null, report: "none" as const, process: "not_started" as const,
        stop: "none" as const, schedule: researchRequest.schedule,
        forceReclaimRequested: false, deadlineViolated: false,
        verificationWindowMs: researchRequest.schedule.verificationWindowMs, observedAt: acceptedAt,
        ...(researchRequest.inputs
          ? { inputs: { ...researchRequest.inputs, state: "declared" as const } }
          : {}),
      } } : {}),
      ...(shell?.recoveryContext ? { recoveryContext: shell.recoveryContext } : {}),
      receipt: { ...this.identity, revision: 1, requestDigest, acceptedAt } };
    // Duplicate lookup and insert share the transaction. No operation is scheduled until COMMIT.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT session, agent, record FROM executions WHERE id = ?").get(request.executionId);
      if (row) {
        if (row.session !== owner.sessionId || row.agent !== owner.agentId) throw conflict();
        const existing = JSON.parse(String(row.record)) as ManagedExecution;
        if (!existing.receipt || existing.receipt.requestDigest !== requestDigest) throw conflict();
        if (this.recoveringIds.has(existing.id)) throw this.recoveryInProgress();
        this.db.exec("COMMIT");
        return { execution: existing, accepted: false };
      }
      this.assertResourcesAvailable(request);
      this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(execution.id, owner.sessionId, owner.agentId, JSON.stringify(execution));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      if (!(error instanceof ExecutionManagerError)) this.storageHealthy = false;
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (preflight) {
        try {
          await preflight(controller.signal);
        } catch (error) {
          // A preflight rejection dispatched nothing, so it is a deterministic
          // pre-admission failure, not an unverified outcome. It carries
          // `not_started` evidence and no result or workspace version, and it
          // leaves the queue usable for later work.
          execution.state = controller.signal.aborted ? "cancelled" : "failed";
          execution.error = controller.signal.aborted ? "Execution cancelled before start"
            : error instanceof Error ? error.message : "Execution rejected before start";
          execution.evidence = { ...this.identity, revision: execution.receipt!.revision,
            processTerminated: true, terminationReason: "not_started" };
          execution.finishedAt = new Date().toISOString();
          this.save(execution);
          return;
        }
      }
      return withWorkspaceAdmission(this.versions, key, () => withWorkspaceLease(key, async () => {
      if (!shell?.explicitHandoff) await ensureWorkspaceBaseline(this.versions, key);
      let changed = false;
      let resourcesRecorded = false;
      let cursor = 0;
      let retained = 0;
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const log: ExecutionLogSink = (stream, chunk) => {
        // Bound retained logs independently of process lifetime; observation must not kill a job.
        const budget = request.maxOutputBytes ?? 10_000_000;
        if (budget > 0 && retained + chunk.length > budget && !execution.logTruncated) {
          execution.logTruncated = true;
          this.save(execution);
        }
        if (budget > 0 && retained >= budget) return;
        const bytes = budget > 0 ? chunk.subarray(0, Math.max(0, budget - retained)) : chunk;
        // Small chunks make cursor pagination bounded even for a single very long line.
        const characters = Array.from(decoders[stream].write(bytes));
        for (let offset = 0; offset < characters.length; offset += 4096) {
          const text = characters.slice(offset, offset + 4096).join("");
          this.db.prepare("INSERT INTO logs VALUES (?, ?, ?, ?)").run(execution.id, ++cursor, stream, text);
        }
        retained += bytes.length;
      };
      try {
        // Work admitted before an earlier execution was quarantined must not
        // launch into a workspace (or onto a device) whose process state is
        // still unverified; fail it instead of letting it run behind the fence.
        if (this.legacyQuarantine || this.uncertainWorkspaces.has(key)
          || npuDevices.some((device) => this.uncertainDevices.has(device))) {
          throw new ExecutionManagerError("EXECUTION_RESOURCE_QUARANTINED",
            "An earlier execution has unverified process state; affected workspace or NPU resources cannot accept new work", 409);
        }
        if (this.failedWorkspaces.has(key)) throw new Error("Workspace version commit failed; repair storage before restarting the Runner");
        if (controller.signal.aborted) throw new Error("Execution cancelled before start");
        const expectedEnvironmentRevisionId = shell?.recoveryContext
          ? await validateExecutionRecovery(this.versions, this.recoveryStoreId, shell,
              this.get(shell.recoveryContext.parentExecutionId, owner)) : undefined;
        if (shell?.recoveryContext && this.db.prepare("SELECT record FROM executions").all()
          .some(row => (JSON.parse(String(row.record)) as ManagedExecution).state === "unknown")) {
          // Older records have no reliable workspace binding. A restarted Runner
          // may still have an orphan writer, so do not guess which workspace is safe.
          throw new Error("RUNNER_EXECUTIONS_UNCONFIRMED: resolve unknown executions before controlled continuation");
        }
        // Cancellation can arrive while recovery validation above was awaited;
        // never launch a command the user already cancelled.
        if (controller.signal.aborted) throw new Error("Execution cancelled before start");
        // Persist the selected environment before the operation obtains its
        // runtime reader. Its release is not permission to mutate the prefix:
        // only the manager's later termination/publication check can give that.
        try {
          this.db.prepare("INSERT INTO execution_resources VALUES (?, ?)").run(execution.id, request.environmentId ?? null);
          resourcesRecorded = true;
        } catch (error) { this.storageHealthy = false; throw error; }
        await fenceWorkspaceExecution(this.versions, key, this.fenceOwner(execution.id));
        await this.afterFence?.();
        if (controller.signal.aborted) {
          await releaseWorkspaceExecutionFence(this.versions, key, this.fenceOwner(execution.id));
          this.db.prepare("DELETE FROM execution_resources WHERE execution = ?").run(execution.id);
          throw new Error("Execution cancelled before start");
        }
        execution.state = "running";
        execution.startedAt = new Date().toISOString();
        this.save(execution);
        changed = true;
        const returned = await operation(controller.signal, log, expectedEnvironmentRevisionId, this.lifecycleFor(execution.id));
        if ("research" in returned) {
          // Research facts are recorded next to, never derived from, the process
          // result. Workload output was never forwarded to the log sink.
          execution.result = returned.result;
          execution.research = returned.research;
          const reportedInputs = execution.research.inputs;
          const declaredInputs = researchRequest?.inputs;
          if (declaredInputs !== undefined && (reportedInputs === undefined
            || reportedInputs.contractDigest !== declaredInputs.contractDigest
            || reportedInputs.bundleDigest !== declaredInputs.bundleDigest)) {
            // The operation never reported evidence for the accepted identity.
            // Keep the declaration so the run can never be published as having
            // consumed inputs it did not verify.
            execution.research = { ...execution.research,
              inputs: { ...declaredInputs, state: "declared" } };
          } else if (reportedInputs?.state === "verified"
            && verifiedResearchInputs(reportedInputs) === null) {
            // Evidence that does not rebuild to its own bundle digest is not a
            // verified set, whatever it claims; only the declaration is left.
            execution.research = { ...execution.research, inputs: {
              contractDigest: reportedInputs.contractDigest,
              bundleDigest: reportedInputs.bundleDigest,
              state: "declared",
            } };
          }
          execution.state = researchExecutionState(returned.research, controller.signal.aborted);
          if (returned.research.refusal) execution.error = researchRefusalMessage(returned.research.refusal);
          else if (returned.research.outcome === "failed") {
            execution.error = "The research workload reported a failed outcome";
          }
        } else {
          execution.result = returned;
          execution.state = controller.signal.aborted ? "cancelled" : execution.result.exitCode === 0 && !execution.result.networkDeniedHosts?.length ? "completed" : "failed";
        }
      } catch (error) {
        if (!changed && resourcesRecorded) {
          this.db.prepare("DELETE FROM execution_resources WHERE execution = ?").run(execution.id);
        }
        if ((error as { code?: string }).code === "PROCESS_TERMINATION_UNVERIFIED") {
          // The kill did not join, so a writer may still hold the workspace.
          // Publishing a snapshot or claiming a cancelled exit would both be
          // fabrications: fence the workspace for verification, and let this
          // queue item resolve so later work is rejected instead of wedged.
          execution.state = "unknown";
          delete execution.finishedAt;
          execution.error = error instanceof Error ? error.message : String(error);
          this.quarantine(execution);
          this.save(execution);
          await this.releaseResources(execution.id, error);
          return;
        }
        execution.state = controller.signal.aborted ? "cancelled" : "failed";
        execution.error = error instanceof Error ? error.message : "Execution failed";
      }
      // A joined monitor is not proof that nothing it started is still alive.
      // When a durable boundary was recorded, the kernel must show that boundary
      // empty before exit evidence or a workspace snapshot is accepted;
      // otherwise the record becomes unknown and stays fenced.
      if (changed && !(await this.boundaryTerminationAfterRun(execution))) {
        execution.state = "unknown";
        delete execution.finishedAt;
        // The command may have returned, but its process tree was not proven
        // gone. Keeping its result would let an observer read an outcome the
        // Runner cannot vouch for; the retained logs still carry the output.
        delete execution.result;
        const reason = execution.boundary?.reason;
        // Name what was actually missing: a sandbox that promised an identity
        // but produced none is a different defect from one whose namespace the
        // kernel refused to verify, and both differ from a live leftover.
        execution.error = reason === "no-handle"
          ? "Execution ended, but the sandbox process identity was never recorded; its process state is unverified"
          : reason === "handle-invalid"
            ? "Execution ended, but its recorded process identity is corrupt; its process state is unverified"
            : reason === "namespace-unverified"
              ? "Execution ended, but the recorded process namespace is empty and cannot be verified; its process state is unverified"
              : "Execution ended, but its recorded process boundary could not be proven empty; state is unverified";
        this.quarantine(execution);
        this.save(execution);
        await this.releaseResources(execution.id, new ProcessTerminationUnverifiedError(execution.error));
        return;
      }
      // A research run publishes only when both facts hold: the namespace is
      // proven empty (above) and the workload reported a terminal business
      // state. A missing, late or unreadable record is `unknown`; this path
      // keeps the workspace, environment and device fences exactly like an
      // unverified process would.
      if (changed && researchRequest && !researchPublishable(execution.research)) {
        execution.state = "unknown";
        delete execution.finishedAt;
        delete execution.result;
        execution.error = execution.research?.inputs !== undefined
          && execution.research.inputs.state !== "verified"
          ? "Research workload ended without a verified input set for this execution; its business state is unknown and its resources stay fenced"
          : "Research workload ended without a terminal research record; its business state is unknown and its resources stay fenced";
        this.quarantine(execution);
        this.save(execution);
        await this.releaseResources(execution.id, new ProcessTerminationUnverifiedError(execution.error));
        return;
      }
      await this.releaseResources(execution.id);
      const endedState = execution.state;
      // A research refusal that happened before the sandbox was created is the
      // one path whose process fact is a positive "nothing ran", so the exit
      // evidence names it instead of the generic post-join wording.
      const unlaunched = execution.research?.process === "not_started";
      execution.evidence = { ...this.identity, revision: execution.receipt!.revision, processTerminated: true,
        terminationReason: !changed || unlaunched ? "not_started"
          : controller.signal.aborted ? "cancelled" : execution.result ? "exited" : "operation_rejected_after_join" };
      // Journal process exit before asynchronous result publication. A crash here remains
      // unknown with truthful exit evidence, not a fabricated committed terminal result.
      // Nothing was launched when `changed` is false, so there is no journal to write
      // and a record cancelled while queued must not briefly read as running again.
      if (changed) {
        execution.state = "running";
        this.save(execution);
        execution.state = endedState;
      }
      try {
        if (changed) {
          const workspace = shell?.explicitHandoff ? undefined : await snapshotWorkspace(this.versions, request.workspaceRoot);
          const readLog = (stream: string) => this.db.prepare("SELECT text FROM logs WHERE execution = ? AND stream = ? ORDER BY cursor")
            .all(execution.id, stream).map((row) => String(row.text)).join("");
          const stdout = await this.versions.put("agent-state", readLog("stdout") || execution.result?.stdout || "");
          const stderr = await this.versions.put("agent-state", readLog("stderr") || execution.result?.stderr || execution.error || "");
          const code = await this.versions.put("agent-state", shell?.code ?? RESEARCH_WORKLOAD_CODE_MARKER);
          const collected = shell
            ? await collectExecutionRecovery(this.versions, this.recoveryStoreId, shell, execution)
            : { recovery: unknownRecovery() };
          const version = await this.versions.putRecord("WorkspaceExecution", {
            executionId: execution.id, ...owner, ...(workspace ? { workspace } : {}), code, stdout, stderr,
            environmentRevisionId: execution.result?.environmentRevisionId ?? null,
            state: execution.state,
            // The published record keeps the exact input identity this
            // execution verified and consumed, so a later reader can trace the
            // run to its frozen task version without the private mount or the
            // operation's in-memory result.
            ...(execution.research?.inputs?.state === "verified"
              ? { researchInputs: execution.research.inputs } : {}),
            ...(collected.ref ? { recoveryManifest: collected.ref } : {}),
            ...(shell?.recoveryContext ? { recoveryContext: shell.recoveryContext } : {}),
          });
          const refs = await RefStore.open(this.versions);
          try {
            const name = `workspaces/${createHash("sha256").update(key).digest("hex")}/head`;
            const completed = structuredClone(execution);
            completed.version = version;
            completed.recovery = collected.recovery;
            completed.finishedAt = new Date().toISOString();
            completed.evidence!.workspaceVersionDigest = version.digest;
            if (completed.result) {
              completed.result.workspaceSnapshot = workspace;
              completed.result.workspaceVersion = version;
              completed.evidence!.resultDigest = digest(completed.result);
            }
            const journal: PublicationJournal = { schemaVersion: 1, name, expected: refs.head(name), target: version, execution: completed };
            // Persist the exact immutable target before publishing its head. Crash recovery
            // can finish this transaction, but has neither request code nor a launch closure.
            this.db.prepare("INSERT INTO execution_publications VALUES (?, ?)").run(execution.id, JSON.stringify(journal));
            await refs.commit(this.versions, name, journal.expected, version);
            Object.assign(execution, this.finishPublication(journal));
            await releaseWorkspaceExecutionFence(this.versions, key, this.fenceOwner(execution.id));
            this.db.prepare("DELETE FROM execution_resources WHERE execution = ?").run(execution.id);
            return;
          } finally { refs.close(); }
        }
      } catch (error) {
        this.failedWorkspaces.add(key);
        if (this.db.prepare("SELECT 1 FROM execution_publications WHERE id = ?").get(execution.id)) {
          execution.state = "unknown";
          delete execution.finishedAt;
          execution.error = `Execution ended, but result publication is pending recovery: ${error instanceof Error ? error.message : String(error)}`;
          this.quarantine(execution);
          this.save(execution);
          return;
        }
        execution.state = "failed";
        await poisonWorkspace(key).catch(() => undefined);
        execution.error = `Execution ended, but workspace version commit failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      execution.finishedAt = new Date().toISOString();
      this.save(execution); // before releasing this Workspace queue
      if (changed && execution.evidence?.processTerminated && execution.version) {
        await releaseWorkspaceExecutionFence(this.versions, key, this.fenceOwner(execution.id));
        this.db.prepare("DELETE FROM execution_resources WHERE execution = ?").run(execution.id);
      }
    }, controller.signal), controller.signal);
    }).then(() => {
      // Keep the journal until the Workspace lease (including its active marker)
      // was released. A crash after index commit can still retain a write fence.
      if (execution.version) this.clearPublication(execution.id);
    }).catch((error) => {
      if (execution.version && execution.evidence?.processTerminated) {
        // Publication already committed. Failure to clear its journal must not
        // rewrite the authoritative terminal state; startup can finish cleanup.
        this.storageHealthy = false;
        this.failedWorkspaces.add(key);
        return;
      }
      if (!controller.signal.aborted && (error as { code?: string }).code !== "WORKSPACE_RETIRED") this.failedWorkspaces.add(key);
      execution.state = controller.signal.aborted ? "cancelled" : "failed";
      execution.finishedAt = new Date().toISOString();
      execution.error = error instanceof Error ? error.message : "Workspace admission failed";
      // Admission failed before launch. Never invent exit evidence for an operation
      // which started but failed to persist its joined-process receipt.
      if (!execution.startedAt) execution.evidence = { ...this.identity, revision: execution.receipt!.revision,
        processTerminated: true, terminationReason: "not_started" };
      this.save(execution);
    }).finally(async () => {
      // A storage failure can bypass the ordinary post-run checks. Preserve
      // cleanup ownership and its diagnostic rather than dropping callbacks.
      await this.releaseResources(execution.id, new ProcessTerminationUnverifiedError(
        "Execution cleanup remains fenced because termination was not durably verified"));
      this.boundaryExpectations.delete(execution.id);
      this.controllers.delete(execution.id);
      // The graceful stop belongs to this operation's lifetime only. A cancel
      // after it ends must fall back to the terminal-state rules, never call
      // into a completed run's control channel.
      this.stopHandlers.delete(execution.id);
      if (this.queues.get(key) === work) this.queues.delete(key);
    });
    // Avoid unhandled rejections from storage failure; subsequent jobs must not overtake a failed commit.
    void work.catch(() => undefined);
    this.queues.set(key, work);
    return { execution: structuredClone(execution), accepted: true };
  }

  get(id: string, owner: ExecutionOwner): ManagedExecution {
    const execution = this.readStored(id, owner); // check owner before revealing recovery status
    if (this.recoveringIds.has(id)) throw this.recoveryInProgress();
    return execution;
  }

  private recoveryInProgress(): ExecutionManagerError {
    return new ExecutionManagerError("EXECUTION_RECOVERY_PENDING", "Runner is verifying interrupted result publication; retry observation shortly", 503);
  }

  private readStored(id: string, owner: ExecutionOwner): ManagedExecution {
    const row = this.db.prepare("SELECT record FROM executions WHERE id = ? AND session = ? AND agent = ?")
      .get(id, owner.sessionId, owner.agentId);
    if (!row) throw new ExecutionManagerError("EXECUTION_NOT_FOUND", "Execution not found for this Agent", 404);
    const execution = JSON.parse(String(row.record)) as ManagedExecution;
    return { ...execution, recovery: execution.recovery ?? unknownRecovery() };
  }

  /**
   * Load the durable handle for one execution. It is Runner-private and read
   * only from the ledger: no request field can supply or redirect it.
   * `undefined` means none was recorded (older ledger, unsupported platform, or
   * a crash between spawn and persistence); "invalid" means the stored row no
   * longer describes a trustworthy identity.
   */
  private loadBoundary(id: string): ExecutionBoundaryHandle | "invalid" | undefined {
    const row = this.db.prepare("SELECT record FROM execution_boundaries WHERE execution = ?").get(id);
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(String(row.record));
      return isValidExecutionBoundaryHandle(parsed) && parsed.executionId === id ? parsed : "invalid";
    } catch {
      return "invalid";
    }
  }

  /**
   * Persist the just-spawned monitor's identity. Called synchronously from the
   * executor's spawn turn, so no other event can run between the kernel
   * creating the process and this row being written.
   *
   * The callback also records whether this execution promised a durable
   * boundary, and throws when a promise was made but could not be kept. That
   * throws inside the spawn call on purpose: the executor still holds the child
   * and must terminate it before the execution may settle.
   */
  private lifecycleFor(id: string): ExecutionLifecycle {
    return {
      boundary: () => {
        const expectation = this.boundaryExpectations.get(id);
        // A sandbox the kernel already showed gone in its own spawn turn makes
        // no promise that needs a second proof; it is the same answer the
        // post-run check will give.
        if (expectation === "ended" || expectation === "not-applicable") return { state: "ended" };
        const handle = this.loadBoundary(id);
        return handle !== undefined && handle !== "invalid"
          ? { handle, state: "captured" }
          : { state: "unavailable" };
      },
      requestStop: (handler) => {
        this.stopHandlers.set(id, handler);
      },
      persistStopIntent: (cause) => this.persistStopIntent(id, cause),
      observed: (facts) => this.observeExecutionFacts(id, facts),
      retainResource: (cleanup, label) => {
        let owned = this.resources.get(id);
        if (!owned) { owned = new Map(); this.resources.set(id, owned); }
        owned.set(cleanup, label);
      },
      spawned: (spawned) => {
        const outcome = this.captureBoundary(id, spawned);
        if (outcome.status === "not-applicable" || outcome.status === "ended") {
          this.boundaryExpectations.set(id, outcome.status);
          return;
        }
        this.boundaryExpectations.set(id, "required");
        if (outcome.status !== "captured") {
          // The sandbox runs, but its identity was never read. It cannot be
          // observed, stopped, or proven ended later, so it must not be left
          // running under a record that will claim a verified termination.
          throw new Error(`Execution boundary identity is unavailable (${outcome.reason}); the started sandbox cannot be supervised`);
        }
        try {
          this.db.prepare("INSERT INTO execution_boundaries VALUES (?, ?) ON CONFLICT(execution) DO UPDATE SET record = excluded.record")
            .run(id, JSON.stringify(outcome.handle));
        } catch (error) {
          // Losing the identity row does not lose the process; it loses the
          // ability to prove anything about it later. Admission must stop
          // rather than keep accepting work it cannot fence.
          this.storageHealthy = false;
          throw error;
        }
      },
    };
  }

  /**
   * Persist a stop intent before anything may act on it.
   *
   * The returned identity is derived from the execution and the instant the
   * intent was first recorded, so the workload, the ledger and a restarted
   * Runner all name the same stop without keeping a UUID in memory. A failed
   * write throws: the caller must not then write the control channel, abort or
   * send a signal for an intent that does not exist.
   */
  private async persistStopIntent(id: string, cause: "user" | "budget"): Promise<string> {
    const stored = this.db.prepare("SELECT record FROM executions WHERE id = ?").get(id);
    if (!stored) throw new Error("Execution record is missing; the stop intent cannot be persisted");
    const execution = JSON.parse(String(stored.record)) as ManagedExecution;
    if (terminal(execution.state)) throw new Error("Execution already ended; no stop intent can be persisted");
    const observedAt = new Date().toISOString();
    const stopRequestedAt = execution.boundary?.stopRequestedAt ?? observedAt;
    const stopId = researchStopId(id, stopRequestedAt);
    execution.boundary = { ...execution.boundary, observedAt,
      state: execution.boundary?.state ?? "not-recorded",
      terminationConfirmed: execution.boundary?.terminationConfirmed ?? false, stopRequestedAt };
    if (execution.workload === "research" && execution.research) {
      const research = execution.research;
      execution.research = { ...research, observedAt,
        stop: research.stop === "none" ? "requested" : research.stop,
        ...(research.stopCause !== undefined ? {} : { stopCause: cause }) };
    }
    this.save(execution);
    return stopId;
  }

  /**
   * Persist whitelisted facts a running operation observed. The record read here
   * is the durable row, not the operation's in-memory copy, so a concurrent
   * cancel intent is never overwritten by a later observation. A write failure
   * throws: the operation still owns the child and follows its exception
   * contract instead of keeping facts the ledger does not have.
   */
  private observeExecutionFacts(id: string, facts: ExecutionObservation): void {
    const stored = this.db.prepare("SELECT record FROM executions WHERE id = ?").get(id);
    if (!stored) throw new Error("Execution record is missing; the observation cannot be persisted");
    const execution = JSON.parse(String(stored.record)) as ManagedExecution;
    if (terminal(execution.state)) throw new Error("Execution already ended; the observation is refused");
    const current = execution.research;
    if (!current) return;
    let research: ResearchRunStatus = { ...current, observedAt: new Date().toISOString() };
    if (facts.process === "spawned" && research.process === "not_started") {
      research = { ...research, process: "spawned" };
    }
    if (facts.spawnedAt !== undefined && research.spawnedAt === undefined) {
      research = { ...research, spawnedAt: facts.spawnedAt };
    }
    const observed = facts.research;
    const phase = observed?.phase;
    if (phase !== undefined && PHASE_RANK[phase] > PHASE_RANK[research.phase]) {
      research = { ...research, phase };
    }
    const outcome = observed?.outcome;
    if (outcome !== undefined && outcome !== null) {
      research = { ...research, outcome };
    }
    const report = observed?.report;
    if (report !== undefined && REPORT_RANK[report] > REPORT_RANK[research.report]) {
      research = { ...research, report };
    }
    const stop = observed?.stop;
    if (stop !== undefined && STOP_RANK[stop] > STOP_RANK[research.stop]) {
      research = { ...research, stop };
    }
    const inputs = observed?.inputs;
    if (inputs !== undefined) {
      const declared = research.inputs;
      // A run may only record evidence for the identity it was accepted under,
      // and a declaration already upgraded to `verified` is never downgraded.
      if (declared === undefined
        || declared.contractDigest !== inputs.contractDigest
        || declared.bundleDigest !== inputs.bundleDigest) {
        throw new Error("The observed input identity does not match the accepted request");
      }
      if (declared.state !== "verified") {
        const verified = verifiedResearchInputs(inputs);
        if (verified === null) throw new Error("The observed input evidence is not self-consistent");
        research = { ...research, inputs: verified };
      }
    }
    execution.research = research;
    this.save(execution);
  }

  private async releaseResources(id: string, error?: unknown): Promise<void> {
    const resources = this.resources.get(id);
    if (!resources) return;
    this.resources.delete(id);
    for (const [cleanup, label] of resources) await cleanupExecutionResource(error, cleanup, label);
  }

  /**
   * Prove the boundary empty after the operation reported the command joined.
   *
   * Returns true only when no durable boundary was required (an unsupported
   * sandbox keeps its existing semantics, and a sandbox that had already ended
   * in its spawn turn left nothing behind). Every other shape — no handle where
   * one was required, a corrupt row, an empty namespace list, or a namespace
   * that still has members or cannot be read — fails closed so the caller
   * fences the workspace instead of publishing over a possible live writer.
   */
  private async boundaryTerminationAfterRun(execution: ManagedExecution): Promise<boolean> {
    const expectation = this.boundaryExpectations.get(execution.id);
    this.boundaryExpectations.delete(execution.id);
    const stopRequestedAt = execution.boundary?.stopRequestedAt;
    const stop = stopRequestedAt ? { stopRequestedAt } : {};
    const handle = this.loadBoundary(execution.id);
    if (handle === "invalid") {
      execution.boundary = { observedAt: new Date().toISOString(), state: "unverifiable",
        terminationConfirmed: false, reason: "handle-invalid", ...stop };
      return false;
    }
    if (handle === undefined) {
      if (expectation !== "required") return true;
      // This sandbox promised an identity and none was persisted. The process
      // tree was started and is now unowned; the record must stay unverified.
      execution.boundary = { observedAt: new Date().toISOString(), state: "not-recorded",
        terminationConfirmed: false, reason: "no-handle", ...stop };
      return false;
    }
    if (handle.namespaces.length === 0) {
      // Observation already calls this namespace-unverified, and a valid
      // capture never produces an empty list. It can only come from a
      // corrupted or edited row, so it is never proof of termination.
      execution.boundary = observeExecutionBoundary(handle, stop);
      return false;
    }
    // Kernel teardown of a PID namespace is complete once its init exits, but
    // the monitor's own close can be delivered a tick later: re-read within a
    // small bound instead of quarantining a correct record. A research run
    // states the verification window it reserved for exactly this check; the
    // wait is what is left of that window inside the hard deadline measured
    // from the persisted spawn instant, so this check never extends the budget
    // the operation was given.
    let window = 100;
    if (execution.workload === "research") {
      const research = execution.research;
      const spawnedAt = research?.spawnedAt ? Date.parse(research.spawnedAt) : Number.NaN;
      const hardDeadlineMs = research ? researchRunDeadlines(research.schedule).hardDeadlineMs : 0;
      const remaining = Number.isFinite(spawnedAt) ? spawnedAt + hardDeadlineMs - Date.now() : 0;
      window = Math.max(0, Math.min(research?.verificationWindowMs ?? 0, remaining, 250));
    }
    const deadline = Date.now() + window;
    for (;;) {
      const status = observeExecutionBoundary(handle, stop);
      execution.boundary = status;
      if (status.terminationConfirmed) return true;
      if (status.state === "unverifiable" || Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Observe executions a previous Runner process left unverified. This never
   * changes a state, never releases a fence, and never re-runs anything: it
   * only replaces a stale observation with the current kernel truth, so a
   * client sees it before deciding whether to cancel.
   */
  private reconcileRecordedBoundaries(): void {
    for (const row of this.db.prepare("SELECT id, record FROM executions").all()) {
      const execution = JSON.parse(String(row.record)) as ManagedExecution;
      if (execution.state !== "unknown" || !execution.startedAt) continue;
      const handle = this.loadBoundary(String(row.id));
      if (handle === undefined) {
        // An older ledger has no handle at all. Persisting the explicit
        // `not-recorded` answer is still an observation, not a guess: it says
        // the Runner cannot vouch for this execution's processes, which is why
        // cancellation refuses and the quarantine stays.
        const stopRequestedAt = execution.boundary?.stopRequestedAt;
        execution.boundary = { observedAt: new Date().toISOString(), state: "not-recorded",
          terminationConfirmed: false, reason: "no-handle", ...(stopRequestedAt ? { stopRequestedAt } : {}) };
        try { this.save(execution); }
        catch { this.storageHealthy = false; }
        continue;
      }
      const stopRequestedAt = execution.boundary?.stopRequestedAt;
      const stop = stopRequestedAt ? { stopRequestedAt } : {};
      execution.boundary = handle === "invalid"
        ? { observedAt: new Date().toISOString(), state: "unverifiable", terminationConfirmed: false, reason: "handle-invalid", ...stop }
        : observeExecutionBoundary(handle, stop);
      try { this.save(execution); }
      catch { this.storageHealthy = false; }
    }
  }

  logs(id: string, owner: ExecutionOwner, cursor = 0): ExecutionLogPage {
    const execution = this.readStored(id, owner);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid log cursor");
    const rows = this.db.prepare("SELECT cursor, stream, text FROM logs WHERE execution = ? AND cursor > ? ORDER BY cursor LIMIT 4").all(id, cursor);
    const chunks = rows.map((row) => ({ cursor: Number(row.cursor), stream: String(row.stream) as "stdout" | "stderr", text: String(row.text) }));
    const nextCursor = chunks.at(-1)?.cursor ?? cursor;
    return { chunks, nextCursor, retentionTruncated: execution.logTruncated === true,
      truncated: Boolean(this.db.prepare("SELECT 1 FROM logs WHERE execution = ? AND cursor > ? LIMIT 1").get(id, nextCursor)) };
  }

  async cancel(id: string, owner: ExecutionOwner): Promise<ManagedExecution> {
    const execution = this.get(id, owner);
    if (execution.state === "queued") {
      // Nothing was launched, so cancelling needs no join and must not wait for
      // the executions queued ahead of this one. Recording the terminal state
      // now is deterministic; the aborted controller makes the later dispatch
      // skip this command instead of running it.
      execution.state = "cancelled";
      execution.error = "Execution cancelled before start";
      execution.finishedAt = new Date().toISOString();
      if (execution.workload === "research" && execution.research) {
        // A positive record, correlated by execution id: the stop was accepted
        // and nothing was ever launched. It is not inferred from a missing one.
        execution.research = { ...execution.research, observedAt: execution.finishedAt,
          outcome: "not-started", phase: "finished", stop: "requested" };
      }
      if (execution.receipt) execution.evidence = { ...this.identity, revision: execution.receipt.revision,
        processTerminated: true, terminationReason: "not_started" };
      this.save(execution);
      // The state above is already terminal, so abort explicitly: it is what
      // makes the eventual dispatch skip the command instead of running it.
      this.controllers.get(id)?.abort();
      return this.get(id, owner);
    }
    if (execution.state === "running") {
      // The operation is in this process image; its own stop path joins the
      // child. A graceful stop is durable before it reaches the workload: the
      // manager persists the intent, derives the stable stop identity from the
      // durable row and hands that identity to the operation. If the save
      // fails, nothing is written to the control channel, aborted or signaled.
      const handler = this.stopHandlers.get(id);
      if (handler) {
        let stopId: string;
        try {
          stopId = await this.persistStopIntent(id, "user");
        } catch {
          throw new ExecutionManagerError("RESEARCH_STOP_NOT_DURABLE",
            "The stop intent could not be persisted; nothing was sent to the workload and it keeps running", 409);
        }
        try {
          await handler(stopId);
        } catch {
          // The handler is bounded and reports its own refusal through the
          // research record; a failed request must not skip the forced reclaim.
          this.controllers.get(id)?.abort();
        }
        return this.get(id, owner);
      }
      // A run with no graceful stop (a shell execution, or a research run whose
      // operation already returned) keeps the immediate-abort semantics, with
      // the boundary intent persisted first for the same reason.
      execution.boundary = { ...execution.boundary,
        observedAt: new Date().toISOString(), state: execution.boundary?.state ?? "not-recorded",
        terminationConfirmed: execution.boundary?.terminationConfirmed ?? false,
        stopRequestedAt: execution.boundary?.stopRequestedAt ?? new Date().toISOString() };
      if (execution.workload === "research" && execution.research) {
        execution.research = { ...execution.research, observedAt: execution.boundary.observedAt,
          stop: execution.research.stop === "none" ? "requested" : execution.research.stop,
          ...(execution.research.stopCause !== undefined ? {} : { stopCause: "user" as const }) };
      }
      this.save(execution);
      this.controllers.get(id)?.abort();
      return this.get(id, owner);
    }
    if (execution.state !== "unknown") return this.get(id, owner);
    // Unknown: either nothing was ever launched, or a previous Runner process
    // died with the execution in flight. Only a recorded boundary can answer
    // which; without a trustworthy one nothing is signaled and nothing is
    // released.
    const stopRequestedAt = execution.boundary?.stopRequestedAt ?? new Date().toISOString();
    const handle = this.loadBoundary(id);
    if (handle === undefined || handle === "invalid") {
      // Persist the intent even on refusal: it is the durable record of what a
      // caller asked for, and it never becomes evidence of termination.
      execution.boundary = { observedAt: new Date().toISOString(), state: "unverifiable",
        terminationConfirmed: false, reason: handle === "invalid" ? "handle-invalid" : "no-handle", stopRequestedAt };
      this.save(execution);
      throw new ExecutionManagerError("EXECUTION_BOUNDARY_UNAVAILABLE",
        "No durable process boundary was recorded for this execution; nothing was signaled and its resources stay quarantined", 409);
    }
    // Intent is durable before the first signal. Observation alone never flips
    // a state, so this record stays unknown unless the boundary is proven gone.
    execution.boundary = { observedAt: new Date().toISOString(), state: "unverifiable",
      terminationConfirmed: false, stopRequestedAt };
    this.save(execution);
    const outcome = await terminateExecutionBoundary(handle, { stopRequestedAt });
    const latest = this.readStored(id, owner);
    latest.boundary = { ...outcome.status, stopRequestedAt };
    this.save(latest);
    if (!outcome.confirmed) {
      throw new ExecutionManagerError("EXECUTION_TERMINATION_UNVERIFIED",
        outcome.signaled
          ? "Stop intent recorded, but the process boundary could not be proven gone; its resources stay quarantined"
          : "Stop intent recorded, but no verified process was available to signal; its resources stay quarantined", 409);
    }
    // The process tree is gone, but its exit status was never observed and no
    // result was published. The state stays unknown; only the boundary status
    // is now proof of termination, and the quarantine is released by the
    // existing publication/workspace recovery, never here.
    return this.get(id, owner);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([this.recovery, ...this.queues.values()]);
    try { this.db.close(); } finally { this.ownership.close(); }
  }

  private finishPublication(journal: PublicationJournal): ManagedExecution {
    const previous = this.readStored(journal.execution.id, journal.execution);
    if (previous.state === journal.execution.state && previous.finishedAt === journal.execution.finishedAt
      && sameRef(previous.version, journal.target) && previous.evidence?.resultDigest === journal.execution.evidence?.resultDigest
      && canonicalJson(previous.result) === canonicalJson(journal.execution.result) && previous.error === journal.execution.error) return previous;
    const completed = structuredClone(journal.execution);
    completed.receipt!.revision = previous.receipt!.revision;
    this.db.exec("BEGIN IMMEDIATE");
    try { this.save(completed); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return completed;
  }

  private clearPublication(id: string): void {
    this.db.prepare("DELETE FROM execution_publications WHERE id = ?").run(id);
  }

  private fenceOwner(id: string): string { return `${this.runnerInstanceId}:${id}`; }

  private async restoreExecutionFences(): Promise<void> {
    for (const row of this.db.prepare("SELECT record FROM executions").all()) {
      const execution = JSON.parse(String(row.record)) as ManagedExecution;
      if (execution.workspaceKey && (execution.state === "unknown"
        || (execution.state === "failed" && execution.startedAt && !execution.version))) {
        await fenceWorkspaceExecution(this.versions, execution.workspaceKey, this.fenceOwner(execution.id));
      }
    }
  }

  private async recoverPublications(): Promise<void> {
    for (const row of this.db.prepare("SELECT id, record FROM execution_publications ORDER BY id").all()) {
      let previous: ManagedExecution | undefined;
      try {
        const journal = JSON.parse(String(row.record)) as PublicationJournal;
        const completed = journal.execution;
        previous = this.readStored(String(row.id), completed);
        const receipt = completed.receipt;
        if (journal.schemaVersion !== 1 || completed.id !== row.id || !receipt || !previous.receipt
          || receipt.runnerInstanceId !== this.runnerInstanceId || receipt.runnerBootId !== previous.receipt.runnerBootId
          || receipt.requestDigest !== previous.receipt.requestDigest || receipt.acceptedAt !== previous.receipt.acceptedAt
          || completed.workspaceKey !== previous.workspaceKey || !completed.workspaceKey
          || canonicalJson(completed.npuDevices) !== canonicalJson(previous.npuDevices)
          || completed.queuedAt !== previous.queuedAt || completed.startedAt !== previous.startedAt
          || !previous.evidence?.processTerminated
          || !["completed", "failed", "cancelled"].includes(completed.state) || !completed.finishedAt
          || !completed.evidence?.processTerminated || completed.evidence.runnerInstanceId !== receipt.runnerInstanceId
          || completed.evidence.runnerBootId !== receipt.runnerBootId || completed.evidence.revision !== receipt.revision
          || !sameRef(completed.version, journal.target)
          || completed.evidence.workspaceVersionDigest !== journal.target.digest
          || journal.name !== `workspaces/${createHash("sha256").update(completed.workspaceKey).digest("hex")}/head`
          || (completed.result && (completed.evidence.resultDigest !== digest(completed.result) || !sameRef(completed.result.workspaceVersion, journal.target)))) {
          throw new Error("Publication journal identity or result evidence is invalid");
        }
        await this.versions.validateClosure(journal.target);
        const value = (await this.versions.readRecord<{ executionId: string; sessionId: string; agentId: string; state: string; workspace?: AgentStateRef }>(journal.target, "WorkspaceExecution")).value;
        if (value.executionId !== completed.id || value.sessionId !== completed.sessionId || value.agentId !== completed.agentId
          || value.state !== completed.state || (completed.result && !sameRef(value.workspace, completed.result.workspaceSnapshot))) {
          throw new Error("Publication target does not match the original execution");
        }
        const refs = await RefStore.open(this.versions);
        try {
          const head = refs.head(journal.name);
          const alreadyRooted = sameRef(head, journal.target) || refs.history(journal.name).some(ref => sameRef(ref, journal.target));
          if (!alreadyRooted) {
            if (!sameRef(head, journal.expected)) throw new Error("Workspace head changed before interrupted publication could commit");
            await refs.commit(this.versions, journal.name, journal.expected, journal.target);
          }
          this.finishPublication(journal);
        } finally { refs.close(); }
        await releaseWorkspaceExecutionFence(this.versions, completed.workspaceKey, this.fenceOwner(completed.id));
        this.db.prepare("DELETE FROM execution_resources WHERE execution = ?").run(completed.id);
        // No private CAS lock paths or generic active-marker deletion here. A
        // real crash may leave its write fence: recover the result, but require
        // verified/manual fence recovery before admitting another writer.
        const busy = async (): Promise<void> => { throw new Error("Workspace recovery lease is busy"); };
        await withWorkspaceAdmission(this.versions, completed.workspaceKey,
          () => withWorkspaceLease(completed.workspaceKey!, async () => {}, undefined, busy), undefined, busy);
        this.clearPublication(completed.id);
      } catch (error) {
        if (!previous) { this.storageHealthy = false; continue; }
        const current = this.readStored(previous.id, previous);
        if (!current.version) {
          current.state = "unknown";
          delete current.finishedAt;
          current.error = `Result publication recovery is blocked: ${error instanceof Error ? error.message : String(error)}`;
          this.save(current);
        }
        this.quarantine(current, "publication-recovery");
      } finally {
        this.recoveringIds.delete(String(row.id));
      }
    }
    // Release only scopes whose entire unresolved set was repaired. A remaining
    // journal is also a persisted fence, even when its terminal result is readable.
    this.uncertainWorkspaces.clear(); this.uncertainDevices.clear(); this.legacyQuarantine = false;
    const pending = new Set(this.db.prepare("SELECT id FROM execution_publications").all().map(row => String(row.id)));
    for (const row of this.db.prepare("SELECT record FROM executions").all()) {
      const execution = JSON.parse(String(row.record)) as ManagedExecution;
      if (execution.state === "unknown" || (execution.state === "failed" && execution.startedAt && !execution.version)) this.quarantine(execution, "publication-recovery");
      else if (pending.has(execution.id)) this.quarantine({ ...execution, npuDevices: [] }, "publication-recovery");
    }
  }

  private quarantine(execution: ManagedExecution, phase: ExecutionQuarantineDiagnostic["phase"] = "runtime"): void {
    const scoped = typeof execution.workspaceKey === "string" && Boolean(execution.workspaceKey)
      && Array.isArray(execution.npuDevices) && execution.npuDevices.every(device => Number.isSafeInteger(device) && device >= 0);
    if (scoped) {
      this.uncertainWorkspaces.add(execution.workspaceKey!);
      for (const device of execution.npuDevices!) this.uncertainDevices.add(device);
    } else this.legacyQuarantine = true;
    if (this.onQuarantine) {
      // A fence diagnostic, not an assertion that computation failed or that
      // publication cannot recover. Never include command/output/error text.
      const detail: ExecutionQuarantineDiagnostic = { executionId: execution.id, phase,
        scope: scoped ? "workspace-and-devices" : "runner",
        ...(scoped ? { workspaceKeyHash: createHash("sha256").update(execution.workspaceKey!).digest("hex"), npuDevices: [...execution.npuDevices!] } : {}) };
      const key = canonicalJson({ ...detail, npuDevices: detail.npuDevices?.slice().sort((a, b) => a - b) });
      if (this.reportedQuarantines.has(key)) return;
      // Mark before calling the sink: a throwing/reentrant logger cannot flood
      // repeated recovery scans or affect the fence already installed above.
      this.reportedQuarantines.add(key);
      try { this.onQuarantine(detail); }
      catch { /* Logging failure must never change resource admission. */ }
    }
  }

  private save(execution: ManagedExecution): void {
    try {
      // Cancellation operates on a separately read DTO. Retain its durable
      // intent when the in-flight operation later saves its older copy.
      const stored = this.db.prepare("SELECT record FROM executions WHERE id = ?").get(execution.id);
      const previous = stored ? JSON.parse(String(stored.record)) as ManagedExecution : undefined;
      const stopRequestedAt = previous?.boundary?.stopRequestedAt;
      if (stopRequestedAt) execution.boundary = { ...execution.boundary,
        observedAt: execution.boundary?.observedAt ?? new Date().toISOString(),
        state: execution.boundary?.state ?? "not-recorded",
        terminationConfirmed: execution.boundary?.terminationConfirmed ?? false, stopRequestedAt };
      // A durable stop intent (and the cause that produced it) outranks the
      // in-flight copy: cancellation reads the record separately and an
      // operation that finishes later must not erase what was asked of it.
      if (execution.research && previous?.research) {
        const durableStop = previous.research.stop;
        const durableCause = previous.research.stopCause;
        const stopStronger = STOP_RANK[durableStop] > STOP_RANK[execution.research.stop];
        const causeMissing = durableCause !== undefined && execution.research.stopCause === undefined;
        if (stopStronger || causeMissing) {
          execution.research = { ...execution.research,
            ...(stopStronger ? { stop: durableStop } : {}),
            ...(causeMissing ? { stopCause: durableCause } : {}) };
        }
        // A verified input set is a durable fact of this instance. A later,
        // older copy of the record may not replace it with the declaration.
        const durableInputs = previous.research.inputs;
        if (durableInputs?.state === "verified" && execution.research.inputs?.state !== "verified") {
          execution.research = { ...execution.research, inputs: durableInputs };
        }
      }
      if (execution.receipt) {
        if (previous?.receipt) {
          if (!Number.isSafeInteger(previous.receipt.revision) || previous.receipt.revision < 1
            || previous.receipt.runnerInstanceId !== execution.receipt.runnerInstanceId
            || previous.receipt.runnerBootId !== execution.receipt.runnerBootId
            || previous.receipt.requestDigest !== execution.receipt.requestDigest
            || previous.receipt.acceptedAt !== execution.receipt.acceptedAt) throw new Error("Execution receipt identity changed");
          execution.receipt.revision = Math.max(execution.receipt.revision, previous.receipt.revision);
        }
        execution.receipt.revision += 1;
        if (!Number.isSafeInteger(execution.receipt.revision)) throw new Error("Execution revision exhausted");
        if (execution.evidence) execution.evidence.revision = execution.receipt.revision;
      }
      this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
        .run(execution.id, execution.sessionId, execution.agentId, JSON.stringify(execution));
    } catch (error) {
      this.storageHealthy = false;
      throw error;
    }
  }
}
