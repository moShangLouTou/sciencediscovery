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
 * Narrow execution backend for one detached process tree on Linux.
 *
 * It exists because the shared Runner is not a detached supervisor: its
 * executions are bound to an agent session and a CAS workspace, its restart
 * turns every unfinished execution into `unknown` without a handle, and its
 * cancellation reaches the sandbox process group (bubblewrap) or only the
 * direct child (posix/seatbelt). Those are deliberate Runner contracts, not
 * defects; a research engine neither fits them nor should weaken them.
 *
 * Responsibilities stop at the process boundary:
 *
 * - start one trusted argv (never a shell, never inherited environment);
 * - record kernel identity: PID, process-group id, session id, kernel start
 *   time, boot id, uid, command name;
 * - observe that identity against /proc, never against a command line;
 * - stop only a verified member of this instance: TERM, bounded wait, KILL,
 *   then confirm via the kernel rather than claiming success from a signal;
 * - keep every state fact in the durable record so a rebuilt caller (or a
 *   restarted backend) can observe and stop without the original ChildProcess.
 *
 * It deliberately does not: schedule work, retry, resume, restart a stopped
 * instance, enforce a model budget, install anything, launch an engine, or
 * expose any HTTP route. A deadline is armed only by the launcher that is still
 * alive; a rebuilt backend reports an overdue instance and the caller decides.
 *
 * Cancellation guarantee: a descendant that calls setsid() moves to another
 * session and is invisible to this backend. `capabilities().cancellation`
 * states that as unsupported; no test result may be read as a broader promise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { isAbsolute } from "node:path";

import {
  captureProcessIdentitySync,
  readBootId,
  readProcessStat,
  scanSessionMembers,
  sendSignal,
  type SessionMember,
  type SessionScan,
} from "@sciencediscovery/sandbox-capability";

// The /proc identity rules live in the shared package so the Runner and this
// prototype cannot drift. Re-exported because this module's contract (and its
// tests) name it here.
export { parseProcessStat } from "@sciencediscovery/sandbox-capability";
export type { ProcessStat, ProcessStatRead, SessionMember, SessionScan } from "@sciencediscovery/sandbox-capability";

import {
  EXECUTION_INSTANCE_SCHEMA_VERSION,
  ExecutionInstanceStore,
  executionInstanceSnapshot,
  isExecutionInstanceId,
  launchSpecDigest,
  type ExecutionInstanceExit,
  type ExecutionInstanceProcess,
  type ExecutionInstanceReadResult,
  type ExecutionInstanceRecord,
  type ExecutionInstanceSnapshot,
} from "./execution-instance-store.js";

/** Combined retained stdout budget per instance; 0 disables truncation. */
export const DEFAULT_EXECUTION_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Bounded wait after SIGTERM before SIGKILL. */
export const DEFAULT_TERM_GRACE_MS = 3_000;
/** Bounded wait after SIGKILL before the stop is reported as unverified. */
export const DEFAULT_KILL_GRACE_MS = 3_000;
/** Kernel re-read interval while a stop waits. */
export const DEFAULT_POLL_INTERVAL_MS = 100;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 128;

export interface ExecutionLaunchSpec {
  /** This backend's own instance id; never a plan, run, or registration id. */
  readonly executionId: string;
  readonly attemptId: string;
  readonly owner: string;
  /** Idempotency key for this start request. */
  readonly requestId: string;
  /** Absolute path of the program; it is executed directly, never via a shell. */
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  /** The exact environment for the child; nothing is inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** Optional wall-clock bound armed by the launching backend only. */
  readonly deadlineMs?: number;
  /** Retained stdout/stderr bytes; defaults to DEFAULT_EXECUTION_MAX_OUTPUT_BYTES. */
  readonly maxOutputBytes?: number;
}

export interface ExecutionBackendCapabilities {
  readonly supported: boolean;
  readonly backend: "posix-process-group";
  readonly platform: NodeJS.Platform;
  readonly identity: {
    readonly pid: true;
    readonly kernelStartTime: true;
    readonly bootId: true;
    readonly sessionId: true;
    readonly uid: true;
  };
  readonly start: "supported" | "unsupported";
  readonly observe: "supported" | "unsupported";
  readonly stop: "supported" | "unsupported";
  readonly cancellation: {
    /** Which processes a stop reaches. */
    readonly scope: "process-group";
    readonly descendantsInSameSession: "supported";
    /** A descendant that calls setsid() leaves this backend's reach. */
    readonly escapedDescendant: "unsupported";
    readonly escalation: "TERM-then-KILL";
    readonly verification: "kernel-session-and-start-time";
    /** Never claim full descendant cancellation. */
    readonly guaranteesCompleteDescendantStop: false;
  };
  readonly restart: {
    /** A new caller instance observes and stops from the durable record. */
    readonly clientRebuild: "supported";
    /** No in-memory handle is required after the launching process is gone. */
    readonly backendRestart: "supported";
    readonly automaticRecoveryOrResume: "unsupported";
  };
  readonly outputRetention: "bounded";
  readonly deadlineEnforcement: "while-launcher-alive";
}

export type ExecutionStartResult =
  | { readonly status: "started"; readonly instance: ExecutionInstanceSnapshot }
  /** The same start request was already accepted; nothing was launched twice. */
  | { readonly status: "existing"; readonly instance: ExecutionInstanceSnapshot }
  | {
      readonly status: "conflict";
      readonly reason: "request" | "attempt";
    }
  | { readonly status: "unsupported"; readonly reason: "platform" }
  | {
      readonly status: "failed";
      readonly reason: "launch" | "record-invalid" | "store";
    };

export type ExecutionProcessIdentity =
  | "verified"
  /** The recorded PID now belongs to a different process. */
  | "mismatched"
  /** /proc could not be read, so nothing about the process is known. */
  | "unverified";

export type ExecutionInstanceObservation =
  | { readonly status: "not-found" }
  | {
      readonly status: "record-invalid";
      readonly reason: Extract<
        ExecutionInstanceReadResult,
        { status: "invalid" }
      >["reason"];
    }
  | {
      readonly status: "observed";
      readonly instance: ExecutionInstanceSnapshot;
      readonly identity: ExecutionProcessIdentity;
      /** The recorded PID is a live process with matching kernel identity. */
      readonly processAlive: boolean;
      /** At least one live process still belongs to this instance's session. */
      readonly groupAlive: boolean;
      /** How many such processes were seen; a count only, never PIDs. */
      readonly members: number;
      /**
       * False when the kernel view could not be read completely (or there is no
       * recorded identity to observe). Absence of a member is then unproven, so
       * nothing may be settled as gone and no exit may be confirmed.
       */
      readonly observationComplete: boolean;
    };

export interface ExecutionStopRequest {
  readonly requestId: string;
  readonly owner: string;
  readonly reason?: "caller" | "deadline";
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

export type ExecutionStopResult =
  /** Signals were sent and the kernel confirms no live member remains. */
  | { readonly status: "stopped"; readonly instance: ExecutionInstanceSnapshot }
  /** Nothing to signal: the instance is already terminal. */
  | {
      readonly status: "already-terminal";
      readonly instance: ExecutionInstanceSnapshot;
    }
  /** No signal was sent. */
  | {
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "owner-mismatch"
        | "record-invalid"
        | "identity-unverified"
        /** The recorded PID now belongs to another process (reuse). */
        | "identity-mismatch"
        /** The record was written under a different host boot. */
        | "boot-mismatch"
        /** The signal was refused by the kernel (EPERM). */
        | "not-permitted";
    }
  /** Signals were sent but a live member could not be confirmed gone. */
  | {
      readonly status: "unverified";
      readonly instance: ExecutionInstanceSnapshot;
      readonly survivors: number;
      /** False when the survivor count itself could not be read completely. */
      readonly observationComplete: boolean;
    }
  | { readonly status: "unsupported"; readonly reason: "platform" };

export interface ExecutionExitConfirmation {
  readonly confirmed: boolean;
  readonly instance: ExecutionInstanceSnapshot;
}

export interface ExecutionInstanceBackendOptions {
  /** Trusted directory that owns every instance; no default is supplied. */
  readonly stateRoot: string;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Kernel filesystem root, default `/proc`. Not a request field: only a
   * trusted caller or a test sets it, so identity facts cannot be redirected by
   * input. A test points it at a fixture tree to exercise an unreadable kernel
   * view; production never passes it.
   */
  readonly procRoot?: string;
}

interface LaunchedInstance {
  readonly child: ChildProcess;
  readonly stdout: ReturnType<typeof createWriteStream>;
  readonly stderr: ReturnType<typeof createWriteStream>;
  readonly maxOutputBytes: number;
  retained: number;
  truncated: boolean;
}

function unsupportedOnThisPlatform(): boolean {
  return process.platform !== "linux";
}

/**
 * The backend is constructed by a trusted caller. It never resolves a path from
 * a request, reads configuration, or decides that something should run: the
 * launch specification is supplied by code.
 */
export class ExecutionInstanceBackend {
  private readonly store: ExecutionInstanceStore;
  private readonly termGraceMs: number;
  private readonly killGraceMs: number;
  private readonly pollIntervalMs: number;
  /** Kernel filesystem root; `/proc` unless a test supplies a fixture. */
  private readonly procRoot: string;
  /** Kernels handles only; the durable record is authoritative. */
  private readonly launched = new Map<string, LaunchedInstance>();
  /** Execution ids whose start() is still running in this process. */
  private readonly pendingLaunches = new Set<string>();
  private readonly deadlines = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(options: ExecutionInstanceBackendOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    this.store = new ExecutionInstanceStore(options.stateRoot);
    this.termGraceMs = positiveInteger(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    this.killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
    if (
      options.procRoot !== undefined &&
      (typeof options.procRoot !== "string" ||
        !isAbsolute(options.procRoot) ||
        options.procRoot.includes("\0"))
    ) {
      throw new TypeError("procRoot must be an absolute path");
    }
    this.procRoot = options.procRoot ?? "/proc";
  }

  capabilities(): ExecutionBackendCapabilities {
    const supported = !unsupportedOnThisPlatform();
    return {
      supported,
      backend: "posix-process-group",
      platform: process.platform,
      identity: {
        pid: true,
        kernelStartTime: true,
        bootId: true,
        sessionId: true,
        uid: true,
      },
      start: supported ? "supported" : "unsupported",
      observe: supported ? "supported" : "unsupported",
      stop: supported ? "supported" : "unsupported",
      cancellation: {
        scope: "process-group",
        descendantsInSameSession: "supported",
        escapedDescendant: "unsupported",
        escalation: "TERM-then-KILL",
        verification: "kernel-session-and-start-time",
        guaranteesCompleteDescendantStop: false,
      },
      restart: {
        clientRebuild: "supported",
        backendRestart: "supported",
        automaticRecoveryOrResume: "unsupported",
      },
      outputRetention: "bounded",
      deadlineEnforcement: "while-launcher-alive",
    };
  }

  async start(specification: ExecutionLaunchSpec): Promise<ExecutionStartResult> {
    validateLaunchSpec(specification);
    if (this.closed) throw new Error("execution backend is closed");
    if (unsupportedOnThisPlatform()) {
      return { status: "unsupported", reason: "platform" };
    }
    const { executionId } = specification;
    // A program that cannot be executed must not create an instance directory.
    try {
      await access(specification.executable, constants.X_OK);
    } catch {
      return { status: "failed", reason: "launch" };
    }
    const digest = launchSpecDigest({
      executable: specification.executable,
      arguments: specification.arguments,
      cwd: specification.cwd,
      environment: specification.environment,
      deadlineMs: specification.deadlineMs ?? null,
      maxOutputBytes:
        specification.maxOutputBytes ?? DEFAULT_EXECUTION_MAX_OUTPUT_BYTES,
    });
    const outcome = await this.store.createDirectory(executionId);
    if (outcome === "exists") {
      const existing = await this.store.read(executionId);
      if (existing.status !== "ok") {
        return { status: "failed", reason: "record-invalid" };
      }
      const record = existing.record;
      if (record.attemptId !== specification.attemptId) {
        return { status: "conflict", reason: "attempt" };
      }
      if (record.launch.requestId !== specification.requestId) {
        return { status: "conflict", reason: "request" };
      }
      if (record.launch.specDigest !== digest) {
        return { status: "conflict", reason: "request" };
      }
      // A launch that provably started nothing may be retried; the record says
      // so only when no kernel identity was ever captured.
      if (
        record.state === "unknown" &&
        record.unknownReason === "launch-failed" &&
        record.process === null
      ) {
        await this.store.discardFailedLaunch(executionId);
      } else {
        return {
          status: "existing",
          instance: executionInstanceSnapshot(record),
        };
      }
    }
    // Held so an in-flight launch is never mistaken for an abandoned instance
    // by a concurrent observe() or stop request.
    this.pendingLaunches.add(executionId);
    try {
      return await this.launch(specification, digest);
    } finally {
      this.pendingLaunches.delete(executionId);
    }
  }

  observe(executionId: string): Promise<ExecutionInstanceObservation> {
    return this.serialized(executionId, async () => {
      const read = await this.store.read(executionId);
      if (read.status === "missing") return { status: "not-found" };
      if (read.status === "invalid") {
        return { status: "record-invalid", reason: read.reason };
      }
      if (unsupportedOnThisPlatform()) {
        return {
          status: "observed",
          instance: executionInstanceSnapshot(read.record),
          identity: "unverified",
          processAlive: false,
          groupAlive: false,
          members: 0,
          // Nothing can be observed here, so absence is never proven.
          observationComplete: false,
        };
      }
      return await this.inspect(read.record);
    });
  }

  /** Explicit exit confirmation; a terminal state alone is not enough. */
  async confirmExit(executionId: string): Promise<ExecutionExitConfirmation> {
    const observation = await this.observe(executionId);
    if (observation.status !== "observed") {
      throw Object.assign(new Error("execution instance is not observable"), {
        code:
          observation.status === "not-found"
            ? "EXECUTION_INSTANCE_NOT_FOUND"
            : "EXECUTION_INSTANCE_RECORD_INVALID",
      });
    }
    const { instance, processAlive, groupAlive, observationComplete } = observation;
    const terminal =
      instance.state === "stopped" ||
      instance.state === "exited" ||
      instance.state === "lost" ||
      instance.state === "unknown";
    return {
      // Unproven absence is not an exit: a terminal record alone never confirms.
      confirmed: terminal && observationComplete && !processAlive && !groupAlive,
      instance,
    };
  }

  requestStop(
    executionId: string,
    request: ExecutionStopRequest,
  ): Promise<ExecutionStopResult> {
    return this.serialized(executionId, async () => {
      if (!isExecutionInstanceId(executionId)) {
        return { status: "refused", reason: "not-found" };
      }
      if (
        !request ||
        typeof request.requestId !== "string" ||
        !request.requestId.trim() ||
        typeof request.owner !== "string" ||
        !request.owner.trim()
      ) {
        throw new TypeError("requestId and owner are required");
      }
      if (unsupportedOnThisPlatform()) {
        return { status: "unsupported", reason: "platform" };
      }
      const read = await this.store.read(executionId);
      if (read.status === "missing") {
        return { status: "refused", reason: "not-found" };
      }
      if (read.status === "invalid") {
        return { status: "refused", reason: "record-invalid" };
      }
      let record = read.record;
      // A signal is only ever sent on behalf of the recorded owner.
      if (record.owner !== request.owner) {
        return { status: "refused", reason: "owner-mismatch" };
      }
      if (record.process === null) {
        return isTerminal(record.state)
          ? {
              status: "already-terminal",
              instance: executionInstanceSnapshot(record),
            }
          : { status: "refused", reason: "identity-unverified" };
      }
      // Reassignment above defeats property narrowing: keep the verified facts
      // in a local that later awaits cannot invalidate.
      const identity = record.process;
      // Identity is established before the record is touched: a refused stop
      // must leave no trace that a stop was underway.
      //
      // 1. The record must belong to this host boot. After a reboot the same pid
      //    and starttime can occur again, so pid/starttime/session alone never
      //    authorize a signal.
      const bootId = await readBootId(this.procRoot);
      if (bootId === null) {
        return { status: "refused", reason: "identity-unverified" };
      }
      if (identity.bootId !== bootId) {
        return { status: "refused", reason: "boot-mismatch" };
      }
      // 2. The kernel view must be readable: an unreadable /proc is not an
      //    absent process, and nothing may be signaled or settled on a guess.
      const leader = await readProcessStat(this.procRoot, identity.pid);
      if (leader.status === "unobservable") {
        return { status: "refused", reason: "identity-unverified" };
      }
      const leaderVerified =
        leader.status === "ok" &&
        leader.stat.startTimeTicks === identity.startTimeTicks &&
        leader.stat.sessionId === identity.sessionId;
      if (leader.status === "ok" && !leaderVerified) {
        // The PID was reused: the recorded process is gone, and signaling this
        // PID (or its group) would hit an unrelated process. Refuse rather than
        // declare an outcome for a process this instance no longer owns.
        return { status: "refused", reason: "identity-mismatch" };
      }
      // A terminal state for the launched process does not mean the tree is
      // gone: descendants may still live in the recorded session.
      const initial = await scanSessionMembers(this.procRoot, identity.sessionId);
      if (!initial.complete) {
        return { status: "refused", reason: "identity-unverified" };
      }
      if (initial.members.length === 0) {
        return {
          status: "already-terminal",
          instance: executionInstanceSnapshot(
            isTerminal(record.state)
              ? record
              : await this.settleTerminal(executionId, "stopped"),
          ),
        };
      }
      const termGraceMs = positiveInteger(request.termGraceMs, this.termGraceMs);
      const killGraceMs = positiveInteger(request.killGraceMs, this.killGraceMs);
      const now = new Date().toISOString();
      if (record.state !== "stop_requested") {
        record = {
          ...record,
          state: "stop_requested",
          updatedAt: now,
          stop: {
            ...record.stop,
            requestId: request.requestId,
            requestedAt: now,
            requestedBy: request.reason ?? "caller",
          },
        };
        await this.store.write(record);
      }

      // First signal: verified group when its leader is still ours, otherwise
      // exact PIDs whose kernel identity was just re-read. The boot id verified
      // above is passed along so the signal path cannot bypass it.
      const term = await this.signal(record, "SIGTERM", bootId);
      if (term === "denied") return { status: "refused", reason: "not-permitted" };
      if (term === "boot-mismatch") {
        return { status: "refused", reason: "boot-mismatch" };
      }
      if (term === "unobservable") {
        return { status: "refused", reason: "identity-unverified" };
      }
      if (term === "sent") {
        await this.patchStop(executionId, { termSignalSentAt: now });
      }
      if ((await this.awaitGone(identity.sessionId, termGraceMs)) === "gone") {
        return {
          status: "stopped",
          instance: executionInstanceSnapshot(
            await this.settleTerminal(executionId, "stopped"),
          ),
        };
      }
      const killed = await this.signal(record, "SIGKILL", bootId);
      if (killed === "boot-mismatch") {
        return { status: "refused", reason: "boot-mismatch" };
      }
      // An unobservable kill attempt falls through: absence may still become
      // provable by the poll below, and otherwise the result stays unverified.
      if (killed === "sent") {
        await this.patchStop(executionId, {
          killSignalSentAt: new Date().toISOString(),
        });
      }
      if (killed !== "gone" && (await this.awaitGone(identity.sessionId, killGraceMs)) === "gone") {
        return {
          status: "stopped",
          instance: executionInstanceSnapshot(
            await this.settleTerminal(executionId, "stopped"),
          ),
        };
      }
      // Without a complete kernel view the survivor count is a lower bound, and
      // the stop stays unverified rather than being called stopped.
      const finalScan = await scanSessionMembers(this.procRoot, identity.sessionId);
      const latest = await this.store.read(executionId);
      return {
        status: "unverified",
        instance: executionInstanceSnapshot(
          latest.status === "ok" ? latest.record : record,
        ),
        survivors: finalScan.members.length,
        observationComplete: finalScan.complete,
      };
    });
  }

  /**
   * Forget in-memory handles and timers. Running instances are untouched: the
   * durable record is all a later caller needs. Never kills anything.
   */
  dispose(): void {
    this.closed = true;
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    for (const launched of this.launched.values()) {
      launched.stdout.end();
      launched.stderr.end();
    }
    this.launched.clear();
  }

  private async launch(
    specification: ExecutionLaunchSpec,
    digest: string,
  ): Promise<ExecutionStartResult> {
    const { executionId } = specification;
    const createdAt = new Date().toISOString();
    const maxOutputBytes = resolveOutputBytes(specification.maxOutputBytes);
    const deadlineAt =
      specification.deadlineMs === undefined
        ? null
        : new Date(Date.now() + specification.deadlineMs).toISOString();
    const starting: ExecutionInstanceRecord = {
      schemaVersion: EXECUTION_INSTANCE_SCHEMA_VERSION,
      executionId,
      attemptId: specification.attemptId,
      owner: specification.owner,
      createdAt,
      updatedAt: createdAt,
      launch: { requestId: specification.requestId, specDigest: digest, deadlineAt },
      state: "starting",
      process: null,
      stop: {
        requestId: null,
        requestedAt: null,
        requestedBy: null,
        termSignalSentAt: null,
        killSignalSentAt: null,
      },
      exit: null,
      logs: { stdout: "stdout.log", stderr: "stderr.log", truncated: false },
      unknownReason: null,
    };
    try {
      await this.store.write(starting);
    } catch {
      await this.store.discardFailedLaunch(executionId);
      return { status: "failed", reason: "store" };
    }

    let child: ChildProcess;
    try {
      child = spawn(specification.executable, [...specification.arguments], {
        cwd: specification.cwd,
        env: { ...specification.environment },
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      await this.store.discardFailedLaunch(executionId);
      return { status: "failed", reason: "launch" };
    }
    const stdout = createWriteStream(this.store.logPath(executionId, "stdout.log"), {
      flags: "a",
      mode: 0o600,
    });
    const stderr = createWriteStream(this.store.logPath(executionId, "stderr.log"), {
      flags: "a",
      mode: 0o600,
    });
    const launched: LaunchedInstance = {
      child,
      stdout,
      stderr,
      maxOutputBytes,
      retained: 0,
      truncated: false,
    };
    // A log write failing (disk full, removed file) must not surface as an
    // unhandled stream error and take the API down.
    stdout.on("error", () => undefined);
    stderr.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);

    let spawnError: Error | undefined;
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.appendLog(executionId, launched, stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.appendLog(executionId, launched, stderr, chunk);
    });
    child.once("exit", (code, signal) => {
      this.onLauncherExit(executionId, code, signal);
    });
    // Detach from the event loop: the instance outlives this request, and a
    // surviving descendant must never keep the API alive.
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    child.unref();
    // Registered before the (synchronous) identity capture: an exit that lands
    // between the two must find the handle and remove it itself.
    this.launched.set(executionId, launched);

    const identity = captureIdentity(this.procRoot, child.pid ?? 0);
    const pid = child.pid ?? 0;
    if (identity === null) {
      stdout.end();
      stderr.end();
      // No pid at all, or spawn() reported an error: nothing ran.
      if (pid <= 0 || spawnError !== undefined) {
        this.launched.delete(executionId);
        await this.store.discardFailedLaunch(executionId);
        return { status: "failed", reason: "launch" };
      }
      // A process existed but its kernel identity was never captured. Claim
      // neither an outcome nor the ability to cancel it; keep whatever exit
      // the launcher already saw as data, never as a completion claim.
      const unrecorded = await this.serialized(executionId, async () => {
        const latest = await this.store.read(executionId);
        const settled: ExecutionInstanceRecord =
          latest.status === "ok" ? latest.record : starting;
        const record: ExecutionInstanceRecord = {
          ...settled,
          state: "unknown",
          process: null,
          unknownReason: "launch-unrecorded",
          updatedAt: new Date().toISOString(),
        };
        await this.store.write(record);
        return record;
      });
      return { status: "started", instance: executionInstanceSnapshot(unrecorded) };
    }

    const running: ExecutionInstanceRecord = {
      ...starting,
      state: "running",
      process: { ...identity, pid },
      updatedAt: new Date().toISOString(),
    };
    let transitioned: ExecutionInstanceRecord;
    try {
      // The exit listener may have settled the record first (a process can end
      // before the capture loop looks at /proc). A terminal record is never
      // overwritten with "running".
      transitioned = await this.serialized(executionId, async () => {
        const latest = await this.store.read(executionId);
        if (latest.status === "ok" && latest.record.state !== "starting") {
          return latest.record;
        }
        await this.store.write(running);
        return running;
      });
    } catch {
      // The process is real; report it rather than pretending nothing ran.
      return { status: "failed", reason: "store" };
    }
    if (transitioned.state !== "running") {
      return { status: "started", instance: executionInstanceSnapshot(transitioned) };
    }
    if (specification.deadlineMs !== undefined) {
      const timer = setTimeout(() => {
        this.deadlines.delete(executionId);
        void this.requestStop(executionId, {
          requestId: `deadline:${specification.attemptId}`,
          owner: specification.owner,
          reason: "deadline",
        }).catch(() => undefined);
      }, specification.deadlineMs);
      timer.unref();
      this.deadlines.set(executionId, timer);
    }
    return {
      status: "started",
      instance: executionInstanceSnapshot(transitioned),
    };
  }

  private appendLog(
    executionId: string,
    launched: LaunchedInstance,
    stream: ReturnType<typeof createWriteStream>,
    chunk: Buffer,
  ): void {
    if (launched.maxOutputBytes === 0) {
      stream.write(chunk);
      return;
    }
    const room = launched.maxOutputBytes - launched.retained;
    if (room <= 0) {
      if (!launched.truncated) {
        launched.truncated = true;
        void this.markTruncated(executionId);
      }
      return;
    }
    if (chunk.length > room) {
      stream.write(chunk.subarray(0, room));
      launched.retained += room;
      if (!launched.truncated) {
        launched.truncated = true;
        void this.markTruncated(executionId);
      }
      return;
    }
    stream.write(chunk);
    launched.retained += chunk.length;
  }

  private markTruncated(executionId: string): Promise<void> {
    return this.serialized(executionId, async () => {
      const read = await this.store.read(executionId);
      if (read.status !== "ok" || read.record.logs.truncated) return;
      await this.store.write({
        ...read.record,
        logs: { ...read.record.logs, truncated: true },
        updatedAt: new Date().toISOString(),
      });
    }).catch(() => undefined);
  }

  private onLauncherExit(
    executionId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // The handle stays registered until the exit is written: `observe` uses it
    // to tell "the launcher still owes an exit report" from "nobody saw it end",
    // and must not settle the record as lost while this report is pending.
    void this.serialized(executionId, async () => {
      const launched = this.launched.get(executionId);
      if (launched) {
        launched.stdout.end();
        launched.stderr.end();
        this.launched.delete(executionId);
      }
      const deadline = this.deadlines.get(executionId);
      if (deadline) {
        clearTimeout(deadline);
        this.deadlines.delete(executionId);
      }
      const read = await this.store.read(executionId);
      if (read.status !== "ok") return;
      const record = read.record;
      const exit: ExecutionInstanceExit = {
        code,
        signal,
        endedAt: new Date().toISOString(),
      };
      // The launched process ending does not mean the instance ended: a
      // descendant can outlive it inside the recorded session. The exit facts are
      // kept as data, but no completion is claimed while a member still lives —
      // and an unreadable kernel view proves nothing at all.
      const membersLeft =
        record.process === null
          ? false
          : await this.sessionHasMembers(record.process.sessionId);
      if (record.state === "running" || record.state === "starting") {
        await this.store.write({
          ...record,
          state: membersLeft ? record.state : "exited",
          exit,
          updatedAt: exit.endedAt,
        });
        return;
      }
      if (record.state === "stop_requested") {
        // The stop requested the end; keep that fact and record what the kernel
        // reported. Process exit is still confirmed by `observe` for descendants.
        await this.store.write({
          ...record,
          state: membersLeft ? "stop_requested" : "stopped",
          exit,
          updatedAt: exit.endedAt,
        });
        return;
      }
      if (record.state === "exited" && record.exit === null) {
        await this.store.write({ ...record, exit, updatedAt: exit.endedAt });
        return;
      }
      // The stop path can settle the record before this listener runs; keep the
      // kernel-reported facts rather than losing them.
      if (record.state === "stopped" && record.exit === null) {
        await this.store.write({ ...record, exit, updatedAt: exit.endedAt });
      }
    }).catch(() => undefined);
  }

  /** True while this process still holds the kernel handle for the instance. */
  private launcherOwns(executionId: string): boolean {
    return this.pendingLaunches.has(executionId) || this.launched.has(executionId);
  }

  private async inspect(
    record: ExecutionInstanceRecord,
  ): Promise<ExecutionInstanceObservation> {
    const bootId = await readBootId(this.procRoot);
    if (bootId === null) {
      // Without a boot identity no kernel fact here can be trusted.
      return {
        status: "observed",
        instance: executionInstanceSnapshot(record),
        identity: "unverified",
        processAlive: false,
        groupAlive: false,
        members: 0,
        observationComplete: false,
      };
    }
    if (record.process === null) {
      if (record.state === "starting" && !this.launcherOwns(record.executionId)) {
        const settled = await this.settleTerminal(record.executionId, "unknown", {
          unknownReason: "launch-unrecorded",
        });
        return {
          status: "observed",
          instance: executionInstanceSnapshot(settled),
          identity: "unverified",
          processAlive: false,
          groupAlive: false,
          members: 0,
          // No session was ever recorded, so descendants cannot be ruled out.
          observationComplete: false,
        };
      }
      return {
        status: "observed",
        instance: executionInstanceSnapshot(record),
        identity: "unverified",
        processAlive: false,
        groupAlive: false,
        members: 0,
        observationComplete: false,
      };
    }
    if (record.process.bootId !== bootId) {
      // The recorded process belongs to an earlier boot; nothing from that boot
      // can still be running, so absence is proven without reading a pid.
      const settled = await this.settleTerminal(record.executionId, "lost");
      return {
        status: "observed",
        instance: executionInstanceSnapshot(settled),
        identity: "unverified",
        processAlive: false,
        groupAlive: false,
        members: 0,
        observationComplete: true,
      };
    }
    const stat = await readProcessStat(this.procRoot, record.process.pid);
    if (stat.status === "unobservable") {
      return {
        status: "observed",
        instance: executionInstanceSnapshot(record),
        identity: "unverified",
        processAlive: false,
        groupAlive: false,
        members: 0,
        observationComplete: false,
      };
    }
    const identity: ExecutionProcessIdentity =
      stat.status === "gone"
        ? "unverified"
        : stat.stat.startTimeTicks === record.process.startTimeTicks
          ? "verified"
          : "mismatched";
    const processAlive =
      identity === "verified" && stat.status === "ok" && stat.stat.state !== "Z";
    const scan = await scanSessionMembers(this.procRoot, record.process.sessionId);
    const groupAlive = scan.members.length > 0;
    if (
      !processAlive &&
      !groupAlive &&
      scan.complete &&
      !isTerminal(record.state)
    ) {
      // A launcher still holding the ChildProcess will record the real exit; a
      // rebuilt caller sees that nobody is left and must not claim an exit code.
      if (!this.launcherOwns(record.executionId)) {
        const settled = await this.settleTerminal(
          record.executionId,
          record.state === "stop_requested" ? "stopped" : "lost",
        );
        return {
          status: "observed",
          instance: executionInstanceSnapshot(settled),
          identity,
          processAlive: false,
          groupAlive: false,
          members: 0,
          observationComplete: true,
        };
      }
    }
    return {
      status: "observed",
      instance: executionInstanceSnapshot(record),
      identity,
      processAlive,
      groupAlive,
      members: scan.members.length,
      observationComplete: scan.complete,
    };
  }

  private async settleTerminal(
    executionId: string,
    state: "stopped" | "lost" | "unknown",
    options?: { unknownReason?: "launch-unrecorded" | "launch-failed" },
  ): Promise<ExecutionInstanceRecord> {
    const latest = await this.store.read(executionId);
    if (latest.status !== "ok") throw new Error("execution record disappeared");
    const record = latest.record;
    if (isTerminal(record.state)) return record;
    const updated: ExecutionInstanceRecord = {
      ...record,
      state,
      updatedAt: new Date().toISOString(),
      unknownReason: options?.unknownReason ?? null,
    };
    await this.store.write(updated);
    return updated;
  }

  private async patchStop(
    executionId: string,
    patch: { termSignalSentAt?: string; killSignalSentAt?: string },
  ): Promise<void> {
    const read = await this.store.read(executionId);
    if (read.status !== "ok") return;
    const record = read.record;
    await this.store.write({
      ...record,
      updatedAt: new Date().toISOString(),
      stop: {
        ...record.stop,
        ...(patch.termSignalSentAt
          ? { termSignalSentAt: patch.termSignalSentAt }
          : {}),
        ...(patch.killSignalSentAt
          ? { killSignalSentAt: patch.killSignalSentAt }
          : {}),
      },
    });
  }

  /**
   * Signal only this instance. The boot identity is re-checked here so this
   * path can never authorize a signal by itself, and an unreadable kernel view
   * aborts the attempt instead of guessing at a target. With a verified leader
   * the whole process group is signaled; otherwise each live session member is
   * re-read and signaled by exact PID, so a recycled group id is never hit.
   */
  private async signal(
    record: ExecutionInstanceRecord,
    signal: NodeJS.Signals,
    bootId: string,
  ): Promise<SignalOutcome> {
    const process = record.process;
    if (process === null) return "gone";
    if (process.bootId !== bootId) return "boot-mismatch";
    const leader = await readProcessStat(this.procRoot, process.pid);
    if (leader.status === "unobservable") return "unobservable";
    if (
      leader.status === "ok" &&
      leader.stat.startTimeTicks === process.startTimeTicks &&
      leader.stat.sessionId === process.sessionId &&
      leader.stat.processGroupId === process.processGroupId
    ) {
      return sendSignal(-process.processGroupId, signal);
    }
    const scan = await scanSessionMembers(this.procRoot, process.sessionId);
    // Without a complete scan the target set is unknown; signal nothing.
    if (!scan.complete) return "unobservable";
    let sent = false;
    let denied = false;
    for (const member of scan.members) {
      // Re-read immediately before the signal: never signal a reused PID.
      const current = await readProcessStat(this.procRoot, member.pid);
      if (current.status === "unobservable") {
        // A refused outcome promises that no signal was sent. Once one has been
        // sent, report it as sent and let the polling decide the outcome.
        return sent ? "sent" : "unobservable";
      }
      if (current.status === "gone") continue;
      if (current.stat.startTimeTicks !== member.startTimeTicks) continue;
      if (current.stat.sessionId !== process.sessionId) continue;
      const outcome = sendSignal(member.pid, signal);
      if (outcome === "sent") sent = true;
      if (outcome === "denied") denied = true;
    }
    if (denied) return "denied";
    return sent ? "sent" : "gone";
  }

  private async awaitGone(
    sessionId: number,
    timeoutMs: number,
  ): Promise<"gone" | "surviving" | "unobservable"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const scan = await scanSessionMembers(this.procRoot, sessionId);
      if (scan.complete && scan.members.length === 0) return "gone";
      if (Date.now() >= deadline) {
        return scan.complete ? "surviving" : "unobservable";
      }
      await delay(this.pollIntervalMs);
    }
  }

  /** True unless the kernel view was read completely and found empty. */
  private async sessionHasMembers(sessionId: number): Promise<boolean> {
    const scan = await scanSessionMembers(this.procRoot, sessionId);
    return !scan.complete || scan.members.length > 0;
  }

  private serialized<T>(
    executionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(executionId) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.queues.set(
      executionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

function isTerminal(state: ExecutionInstanceRecord["state"]): boolean {
  return (
    state === "stopped" || state === "exited" || state === "lost" || state === "unknown"
  );
}

function resolveOutputBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EXECUTION_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("maxOutputBytes must be a non-negative integer");
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("grace and poll values must be non-negative integers");
  }
  return value;
}

function validateLaunchSpec(specification: ExecutionLaunchSpec): void {
  if (!specification || typeof specification !== "object") {
    throw new TypeError("launch specification must be an object");
  }
  for (const [label, value] of [
    ["executionId", specification.executionId],
    ["attemptId", specification.attemptId],
    ["owner", specification.owner],
    ["requestId", specification.requestId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
  }
  if (!isExecutionInstanceId(specification.executionId)) {
    throw new TypeError("executionId is not a valid instance id");
  }
  if (
    typeof specification.executable !== "string" ||
    !isAbsolute(specification.executable) ||
    specification.executable.includes("\0")
  ) {
    throw new TypeError("executable must be an absolute path");
  }
  if (
    typeof specification.cwd !== "string" ||
    !isAbsolute(specification.cwd) ||
    specification.cwd.includes("\0")
  ) {
    throw new TypeError("cwd must be an absolute path");
  }
  if (
    !Array.isArray(specification.arguments) ||
    specification.arguments.length > MAX_ARGUMENTS
  ) {
    throw new TypeError(`arguments must be an array of at most ${MAX_ARGUMENTS} strings`);
  }
  for (const argument of specification.arguments) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new TypeError("arguments must be strings without NUL");
    }
    if (Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new TypeError(`arguments must be at most ${MAX_ARGUMENT_BYTES} bytes`);
    }
  }
  const environment = specification.environment;
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new TypeError("environment must be an object");
  }
  const entries = Object.entries(environment);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new TypeError(
      `environment must have at most ${MAX_ENVIRONMENT_ENTRIES} entries`,
    );
  }
  for (const [name, value] of entries) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new TypeError("environment variable names must be plain identifiers");
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("environment values must be strings without NUL");
    }
  }
  if (
    specification.deadlineMs !== undefined &&
    (!Number.isSafeInteger(specification.deadlineMs) || specification.deadlineMs <= 0)
  ) {
    throw new TypeError("deadlineMs must be a positive integer");
  }
  if (specification.maxOutputBytes !== undefined) {
    resolveOutputBytes(specification.maxOutputBytes);
  }
}

function unrefStream(stream: NodeJS.ReadableStream | null | undefined): void {
  const unref = (stream as unknown as { unref?: () => void } | null)?.unref;
  if (typeof unref === "function") unref.call(stream);
}

function delay(ms: number): Promise<void> {
  // Referenced on purpose: every caller is awaiting this wait, so the event loop
  // must stay alive until it resolves.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What a signal attempt established about the target set. */
type SignalOutcome =
  | "sent"
  | "gone"
  | "denied"
  /** The record was written by a different host boot; never signal for it. */
  | "boot-mismatch"
  /** The kernel view could not be read; nothing was signaled on a guess. */
  | "unobservable";

/**
 * Capture the kernel identity of a just-spawned child, plus the command name
 * this prototype records for diagnostics. The identity rules — exact session,
 * boot id, start time, tri-state absence — live in the shared package so the
 * Runner cannot grow a second, drifting implementation of them.
 */
function captureIdentity(
  procRoot: string,
  pid: number,
): Omit<ExecutionInstanceProcess, "pid"> | null {
  const captured = captureProcessIdentitySync(procRoot, pid, {
    commandName: true,
  });
  if (captured === null) return null;
  return {
    processGroupId: captured.processGroupId,
    sessionId: captured.sessionId,
    startTimeTicks: captured.startTimeTicks,
    bootId: captured.bootId,
    uid: captured.uid,
    commandName: captured.commandName ?? "unknown",
  };
}
