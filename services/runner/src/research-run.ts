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
 * The Runner-side fixed research workload.
 *
 * This module owns exactly one kind of work: a trusted program (supplied by
 * Runner code, never by a request) that runs inside the ordinary supervised
 * bubblewrap sandbox and reports its own business phase through a Runner-owned
 * control channel. It does not add an executor, a queue, or a process manager:
 * lifecycle, admission, fences, resource rows, boundary proof, and publication
 * all stay with `ExecutionManager`.
 *
 * Trust boundaries:
 *
 * - the request names an identity and a time schedule; it cannot name a
 *   program, an interpreter, a module, a path, an environment variable, a
 *   state root, or a control-file location;
 * - the state root is derived from the execution id by digest, so `.`, `..`,
 *   separators and collisions are not representable;
 * - the control directory is held open by a directory descriptor for the whole
 *   run. Every read and write is addressed through `/proc/self/fd/<fd>/<name>`
 *   with `O_NOFOLLOW` and validated with `fstat` on the opened handle, which is
 *   the Node equivalent of `openat` here: no `exists`/`lstat`-then-open gap, and
 *   a workload that replaces a name with a link or a device node cannot make
 *   the Runner write somewhere else on the host;
 * - the workload's own output is never projected. Only a fixed protocol JSON
 *   with a whitelisted field set is read, size-bounded, and any missing,
 *   oversized, malformed or unknown-version record is a named refusal or
 *   `unknown`, never a silently filtered one.
 *
 * Process and business facts are separate. `ready`/`consumed`/`ack` are the
 * workload's self-reports; nothing is published and no fence is released until
 * the full PID namespace is proven empty by the ledger's own boundary check.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import {
  RESEARCH_RUN_SCHEMA_VERSION,
  RESEARCH_WORKLOAD_KINDS,
  type ResearchOutcome,
  type ResearchPhase,
  type ResearchProcessEvidence,
  type ResearchRefusalCode,
  type ResearchRunRequest,
  type ResearchRunStatus,
  type ResearchStopState,
  type ResearchTimeSchedule,
  type ShellExecutionResult,
} from "@sciencediscovery/schema";
import { SYSTEM_SHELL_ENVIRONMENT_REVISION_ID } from "@sciencediscovery/schema";

import type { EnvironmentRuntime, EnvironmentStore } from "./environment-store.js";
import {
  boundaryTerminationVerified,
  terminateExecutionBoundary,
  type ExecutionBoundaryHandle,
  type ExecutionLifecycle,
} from "./execution-boundary.js";
import {
  environmentPrefixBindArguments,
  executorSandboxKind,
  hostInterpreterMaskArguments,
  prepareSandboxLaunch,
  resolveHostRuntimeSupport,
  runSandboxed,
  sandboxCommandPath,
  workspaceBindArguments,
  type ExecutorConfig,
  type SandboxLaunch,
} from "./executor.js";
import { RUNNER_VERSION } from "./version.js";

/** The protocol the fixed program and this module share. */
export const RESEARCH_CONTROL_PROTOCOL_VERSION = 1;
/** Mount point of the control directory inside the sandbox. */
export const RESEARCH_CONTROL_MOUNT = "/runner-control";
/** Largest record the Runner will read; anything bigger is a refusal. */
export const RESEARCH_RECORD_MAX_BYTES = 4_096;

const CONTROL_DIRECTORY = "control";
const RECORD_FILE = "status";
const STOP_FILE = "stop";
const STOP_CONSUMED_FILE = "stop.consumed";
const STOP_PENDING_FILE = "stop.pending";
const STATE_DIRECTORY = "runner-research";
/** Observation cadence; the deadline checks run on the same turn. */
const POLL_MS = 25;
/** Upper bound for any single schedule field. */
const MAX_SCHEDULE_MS = 7 * 24 * 60 * 60 * 1000;

const REFUSAL_MESSAGES: Readonly<Record<ResearchRefusalCode, string>> = {
  RESEARCH_RUN_NOT_CONFIGURED: "This Runner has no trusted research workload configured",
  RESEARCH_REQUEST_INVALID: "The research request is not a valid internal research submission",
  RESEARCH_SCHEDULE_INVALID: "The research time schedule is out of range and was not adjusted",
  RESEARCH_WORKLOAD_UNKNOWN: "The requested research workload is not one this Runner can run",
  RESEARCH_STATE_ROOT_UNSAFE: "The research state directory could not be established safely",
  RESEARCH_CONTROL_OPEN_FAILED: "The research control channel could not be opened",
  RESEARCH_CONTROL_REPLACED: "The research control channel was replaced by another file",
  RESEARCH_CONTROL_WRITE_FAILED: "The research stop request could not be written safely",
  RESEARCH_RECORD_OVERSIZE: "The research workload record exceeds its fixed size bound",
  RESEARCH_RECORD_MALFORMED: "The research workload record is not valid fixed-vocabulary JSON",
  RESEARCH_RECORD_VERSION_UNKNOWN: "The research workload record names an unknown protocol version",
  RESEARCH_ENVIRONMENT_UNAVAILABLE: "The managed environment for this research run could not be leased",
  RESEARCH_ENVIRONMENT_REVISION_MISMATCH: "The managed environment is no longer at the revision the caller expected",
  RESEARCH_SANDBOX_UNSUPPORTED: "The research workload requires the bubblewrap sandbox",
  RESEARCH_LAUNCH_FAILED: "The research workload could not be launched inside its sandbox",
};

/** A fixed refusal. The message is from the table above, never an inner one. */
export class ResearchRunError extends Error {
  readonly code: ResearchRefusalCode;

  constructor(code: ResearchRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
    this.name = "ResearchRunError";
    this.code = code;
  }
}

export function researchRefusalMessage(code: ResearchRefusalCode): string {
  return REFUSAL_MESSAGES[code];
}

/**
 * Validate a time schedule without adjusting it. A budget that is out of range
 * refuses the submission: shortening a research or verification window
 * silently would make the record describe a run that was never performed.
 */
export function parseResearchTimeSchedule(value: unknown): ResearchTimeSchedule {
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_SCHEDULE_INVALID");
  const allowed = ["drainGraceMs", "reportBudgetMs", "researchBudgetMs", "stopGraceMs", "verificationWindowMs"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ResearchRunError("RESEARCH_SCHEDULE_INVALID");
  }
  const read = (key: string, minimum: number): number => {
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || (entry as number) < minimum || (entry as number) > MAX_SCHEDULE_MS) {
      throw new ResearchRunError("RESEARCH_SCHEDULE_INVALID");
    }
    return entry as number;
  };
  const schedule: ResearchTimeSchedule = {
    drainGraceMs: read("drainGraceMs", 0),
    reportBudgetMs: read("reportBudgetMs", 0),
    researchBudgetMs: read("researchBudgetMs", 1),
    stopGraceMs: read("stopGraceMs", 1),
    verificationWindowMs: read("verificationWindowMs", 1),
  };
  const total = schedule.researchBudgetMs + schedule.reportBudgetMs + schedule.drainGraceMs
    + schedule.verificationWindowMs;
  if (!Number.isSafeInteger(total) || total > MAX_SCHEDULE_MS) {
    throw new ResearchRunError("RESEARCH_SCHEDULE_INVALID");
  }
  return schedule;
}

/**
 * Validate one internal research submission. Strict on purpose: an unknown key
 * is a request for an override this contract does not have, and there is no
 * field that could name a program, a path or a control file.
 */
export function parseResearchRunRequest(value: unknown): ResearchRunRequest {
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  const allowed = [
    "agentId", "environmentId", "executionId", "expectedEnvironmentRevisionId", "kind",
    "maxOutputBytes", "maxWorkspaceBytes", "npuDevices", "permissionEpoch", "runnerWorkspaceKey",
    "schedule", "schemaVersion", "workload", "workspaceRoot",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  if (value.kind !== "research" || value.schemaVersion !== RESEARCH_RUN_SCHEMA_VERSION) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  if (!RESEARCH_WORKLOAD_KINDS.includes(value.workload as never)) {
    throw new ResearchRunError("RESEARCH_WORKLOAD_UNKNOWN");
  }
  const required = (key: string, maximum: number): string => {
    const entry = value[key];
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maximum || entry.includes("\0")) {
      throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
    }
    return entry;
  };
  const optional = (key: string, maximum: number): string | undefined => {
    if (value[key] === undefined) return undefined;
    return required(key, maximum);
  };
  const executionId = required("executionId", 160);
  if (!/^[A-Za-z0-9_:.-]+$/.test(executionId)) throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  const workspaceRoot = required("workspaceRoot", 4_096);
  if (!workspaceRoot.startsWith("/") || workspaceRoot.split("/").includes("..")) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  const epoch = value.permissionEpoch;
  if (!isRecord(epoch) || typeof epoch.sessionId !== "string" || epoch.sessionId.length === 0
    || epoch.sessionId.length > 160 || epoch.sessionId.includes("\0")) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  const npuDevices = value.npuDevices;
  if (npuDevices !== undefined && (!Array.isArray(npuDevices)
    || npuDevices.some((device) => !Number.isSafeInteger(device) || (device as number) < 0))) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  const budget = (key: string): number | undefined => {
    const entry = value[key];
    if (entry === undefined) return undefined;
    if (!Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) > MAX_SCHEDULE_MS) {
      throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
    }
    return entry as number;
  };
  return {
    agentId: required("agentId", 160),
    ...(optional("environmentId", 160) ? { environmentId: value.environmentId as string } : {}),
    executionId,
    ...(optional("expectedEnvironmentRevisionId", 160)
      ? { expectedEnvironmentRevisionId: value.expectedEnvironmentRevisionId as string }
      : {}),
    kind: "research",
    ...(budget("maxOutputBytes") !== undefined ? { maxOutputBytes: value.maxOutputBytes as number } : {}),
    ...(budget("maxWorkspaceBytes") !== undefined ? { maxWorkspaceBytes: value.maxWorkspaceBytes as number } : {}),
    ...(Array.isArray(npuDevices) ? { npuDevices: [...npuDevices as number[]] } : {}),
    permissionEpoch: epoch as unknown as ResearchRunRequest["permissionEpoch"],
    ...(optional("runnerWorkspaceKey", 160) ? { runnerWorkspaceKey: value.runnerWorkspaceKey as string } : {}),
    schedule: parseResearchTimeSchedule(value.schedule),
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    workload: value.workload as ResearchRunRequest["workload"],
    workspaceRoot,
  };
}

/** Fixed run deadlines, all counted from the instant the operation starts. */
export interface ResearchRunDeadlines {
  readonly stopAtMs: number;
  readonly forceKillAtMs: number;
  readonly hardDeadlineMs: number;
}

export function researchRunDeadlines(schedule: ResearchTimeSchedule): ResearchRunDeadlines {
  const hardDeadlineMs = schedule.researchBudgetMs + schedule.reportBudgetMs + schedule.drainGraceMs
    + schedule.verificationWindowMs;
  return {
    // The research phase ends here; after it the workload may only report.
    stopAtMs: schedule.researchBudgetMs,
    // The last instant at which a kill still leaves the verification window.
    forceKillAtMs: hardDeadlineMs - schedule.verificationWindowMs,
    hardDeadlineMs,
  };
}

/**
 * Digest-derived state root. The execution id never becomes a path component,
 * so `.`, `..`, separators, links and profile collisions are not representable
 * and two executions can never share one directory.
 */
export function researchStateRoot(dataDir: string, executionId: string): string {
  const digest = createHash("sha256").update(`research-run\n${executionId}`, "utf8").digest("hex");
  return resolve(dataDir, STATE_DIRECTORY, digest.slice(0, 32));
}

/** The fixed base this workload runs in. It manages no packages. */
export const RESEARCH_SYSTEM_ENVIRONMENT_REVISION_ID = SYSTEM_SHELL_ENVIRONMENT_REVISION_ID;

/** What the Runner reads back from the workload's own record. */
export interface ResearchWorkloadRecord {
  readonly phase: ResearchPhase;
  readonly outcome: ResearchOutcome | null;
  readonly stopId: string | null;
}

/**
 * Parse the workload's record against a fixed whitelist.
 *
 * Every branch that does not match is a named refusal. A bad field is never
 * dropped to make the rest readable: a record that cannot be understood is not
 * evidence about the run.
 */
export function parseResearchWorkloadRecord(text: string): ResearchWorkloadRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  const allowed = ["outcome", "phase", "stopId", "version"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (typeof value.version !== "number") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  if (value.version !== RESEARCH_CONTROL_PROTOCOL_VERSION) {
    throw new ResearchRunError("RESEARCH_RECORD_VERSION_UNKNOWN");
  }
  const phase = value.phase;
  if (phase !== "research" && phase !== "reporting" && phase !== "finished") {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  const outcome = value.outcome;
  if (phase === "finished") {
    if (outcome !== "not-started" && outcome !== "completed" && outcome !== "stopped" && outcome !== "failed") {
      throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
    }
  } else if (outcome !== undefined) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  const stopId = value.stopId;
  if (stopId !== undefined && (typeof stopId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(stopId))) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  return { outcome: phase === "finished" ? outcome as ResearchOutcome : null, phase, stopId: stopId ?? null };
}

/** One read from the control channel, already classified. */
type ControlRead =
  | { readonly status: "missing" }
  | { readonly status: "text"; readonly text: string }
  | { readonly status: "refused"; readonly code: ResearchRefusalCode };

/**
 * The Runner-owned control directory.
 *
 * The directory descriptor is opened once with `O_DIRECTORY | O_NOFOLLOW` and
 * kept for the whole run. Names are always addressed under that descriptor via
 * `/proc/self/fd/<fd>/<name>`, so a workload that replaces a name with a
 * symlink, a device node or a directory either fails `O_NOFOLLOW` or fails the
 * `fstat` type check — the Runner never follows such a replacement to another
 * host location.
 */
export class ResearchControlChannel {
  private constructor(
    private readonly directory: FileHandle,
    readonly hostPath: string,
  ) {}

  static async open(stateRoot: string): Promise<ResearchControlChannel> {
    const hostPath = resolve(stateRoot, CONTROL_DIRECTORY);
    try {
      await mkdir(hostPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE");
      }
    }
    let directory: FileHandle;
    try {
      directory = await open(hostPath, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
    } catch {
      throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE");
    }
    try {
      const info = await directory.stat();
      // Group- or world-writable would let another account plant records.
      if (!info.isDirectory() || (info.mode & 0o022) !== 0) {
        throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE");
      }
    } catch (error) {
      await directory.close().catch(() => undefined);
      throw error instanceof ResearchRunError ? error : new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE");
    }
    return new ResearchControlChannel(directory, hostPath);
  }

  private entry(name: string): string {
    return `/proc/self/fd/${this.directory.fd}/${name}`;
  }

  async read(name: string): Promise<ControlRead> {
    let handle: FileHandle;
    try {
      handle = await open(this.entry(name), FS.O_RDONLY | FS.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "refused", code: "RESEARCH_CONTROL_REPLACED" };
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { status: "refused", code: "RESEARCH_CONTROL_REPLACED" };
      if (info.size > RESEARCH_RECORD_MAX_BYTES) return { status: "refused", code: "RESEARCH_RECORD_OVERSIZE" };
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > RESEARCH_RECORD_MAX_BYTES) return { status: "refused", code: "RESEARCH_RECORD_OVERSIZE" };
      return { status: "text", text: buffer.subarray(0, offset).toString("utf8") };
    } catch {
      return { status: "refused", code: "RESEARCH_CONTROL_REPLACED" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Write the stop request exactly once.
   *
   * The payload is created under a fixed name with `O_CREAT | O_EXCL |
   * O_NOFOLLOW`, validated on its own descriptor, and published with `rename`
   * between two names under the same held descriptor. `rename` replaces the
   * destination entry instead of following it, so a workload that pre-created a
   * link at the stop path cannot redirect this write.
   */
  async writeStop(stopId: string): Promise<void> {
    const payload = `${JSON.stringify({ version: RESEARCH_CONTROL_PROTOCOL_VERSION, stopId })}\n`;
    await unlink(this.entry(STOP_PENDING_FILE)).catch(() => undefined);
    let handle: FileHandle;
    try {
      handle = await open(this.entry(STOP_PENDING_FILE),
        FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    } catch {
      throw new ResearchRunError("RESEARCH_CONTROL_WRITE_FAILED");
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) throw new ResearchRunError("RESEARCH_CONTROL_REPLACED");
      await handle.writeFile(payload, "utf8");
      const after = await handle.stat();
      if (after.size !== Buffer.byteLength(payload)) throw new ResearchRunError("RESEARCH_CONTROL_WRITE_FAILED");
    } catch (error) {
      throw error instanceof ResearchRunError ? error : new ResearchRunError("RESEARCH_CONTROL_WRITE_FAILED");
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await rename(this.entry(STOP_PENDING_FILE), this.entry(STOP_FILE));
    } catch {
      throw new ResearchRunError("RESEARCH_CONTROL_WRITE_FAILED");
    }
    const readBack = await this.read(STOP_FILE);
    // A workload that consumed the request between rename and read-back is not
    // a replacement; any other disagreement means our bytes are not in place.
    if (readBack.status === "refused") throw new ResearchRunError(readBack.code);
    if (readBack.status === "text" && readBack.text !== payload) {
      throw new ResearchRunError("RESEARCH_CONTROL_REPLACED");
    }
  }

  async close(): Promise<void> {
    await this.directory.close().catch(() => undefined);
  }
}

/** What the fixed program may be, and how the Runner reaches it. */
export interface ResearchRunWiring {
  /**
   * The trusted fixed program. It is Runner code: a request, a route, a config
   * file or an environment variable can never supply or replace it.
   */
  readonly program: string;
  readonly config: ExecutorConfig;
  /**
   * The real store leases the environment and keeps its mutation gate for the
   * whole workload. Absent means only the fixed base sandbox can be used.
   */
  readonly environmentStore?: Pick<EnvironmentStore, "withRuntime">;
  /** Test seam: a synthetic `/proc` root for boundary observation. */
  readonly procRoot?: string;
  readonly onDiagnostic?: (event: string, detail?: Record<string, unknown>) => void;
}

/** What the manager hands to one research launch. */
export interface ResearchRunLaunch {
  readonly signal: AbortSignal;
  /** Revision the caller expected, resolved by the manager under its own rules. */
  readonly expectedEnvironmentRevisionId?: string;
  readonly lifecycle?: ExecutionLifecycle;
}

/** Process facts plus the additive research projection. */
export interface ResearchRunOutcome {
  readonly research: ResearchRunStatus;
  /** Operating-system facts only; workload output is never projected. */
  readonly result: ShellExecutionResult;
}

export interface ResearchRunExecutor {
  run(request: ResearchRunRequest, launch: ResearchRunLaunch): Promise<ResearchRunOutcome>;
}

/**
 * Build the fixed-workload launcher. This is the only place the program is
 * bound, and it is a constructor dependency: nothing reachable from a request
 * can reach it.
 */
export function createResearchRunExecutor(wiring: ResearchRunWiring): ResearchRunExecutor {
  if (typeof wiring.program !== "string" || wiring.program.trim().length === 0) {
    throw new ResearchRunError("RESEARCH_RUN_NOT_CONFIGURED");
  }
  return {
    run: (request, launch) => runResearchWorkload(wiring, request, launch),
  };
}

/**
 * What the ledger state may become after a research operation returned.
 *
 * An unproven process or an unknown research outcome is `unknown`: it is
 * terminal for the control plane and keeps every fence. A completion comes
 * only from the workload's own terminal record, never from an exit code.
 */
export function researchExecutionState(
  status: ResearchRunStatus,
  aborted: boolean,
): "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown" {
  if (status.process === "unverified") return "unknown";
  if (status.outcome === "completed") return "completed";
  if (status.outcome === "stopped" || status.outcome === "not-started") return "cancelled";
  if (status.outcome === "unknown") return "unknown";
  if (status.outcome === "failed" || status.refusal !== undefined) return "failed";
  return aborted ? "cancelled" : "failed";
}

/**
 * Publication needs both a proven process boundary and a terminal research
 * fact. A missing record is `unknown`, so nothing is published from it.
 */
export function researchPublishable(status: ResearchRunStatus | undefined): boolean {
  if (!status) return false;
  if (status.process === "not_started") {
    // Nothing was launched, so there is no process fact to prove. A typed
    // pre-spawn refusal is a definite answer and is published as such; any
    // other `not_started` record (for example one that never ran) is not.
    return status.refusal !== undefined;
  }
  if (status.process !== "spawned-then-terminated") return false;
  return status.outcome !== null && status.outcome !== "unknown";
}

/** Mutable observation state for one run, so failures keep their owner. */
interface RunState {  stopState: ResearchStopState;
  stopId: string | null;
  stopRequestedAtMs: number | null;
  phase: ResearchPhase | "unknown";
  outcome: ResearchOutcome | null;
  refusal: ResearchRefusalCode | undefined;
  consumed: boolean;
  deadlineViolated: boolean;
}

function runResearchWorkload(
  wiring: ResearchRunWiring,
  request: ResearchRunRequest,
  launch: ResearchRunLaunch,
): Promise<ResearchRunOutcome> {
  const startedAt = new Date().toISOString();
  const t0 = process.hrtime.bigint();
  const elapsedMs = (): number => Number((process.hrtime.bigint() - t0) / 1_000_000n);
  const schedule = request.schedule;
  const deadlines = researchRunDeadlines(schedule);
  const state: RunState = {
    consumed: false,
    deadlineViolated: false,
    outcome: null,
    phase: "unknown",
    refusal: undefined,
    stopId: null,
    stopRequestedAtMs: null,
    stopState: "none",
  };
  const diagnose = (event: string, detail?: Record<string, unknown>) => {
    wiring.onDiagnostic?.(event, detail);
  };

  const emptyResult = (exitCode: number, environment?: EnvironmentRuntime): ShellExecutionResult => ({
    cgroupMode: "none",
    createdFiles: [],
    environmentRevisionId: environment?.revision.id ?? RESEARCH_SYSTEM_ENVIRONMENT_REVISION_ID,
    environmentVariables: {},
    executionId: request.executionId,
    exitCode,
    finishedAt: new Date().toISOString(),
    kernelId: `ephemeral:${request.executionId}`,
    kernelMode: "ephemeral",
    language: "shell",
    modifiedFiles: [],
    networkPolicy: "none",
    runnerVersion: RUNNER_VERSION,
    sandbox: "bubblewrap",
    startedAt,
    stderr: "",
    stdout: "",
    workingDirectory: request.workspaceRoot,
  });

  const statusOf = (
    process: ResearchProcessEvidence,
    overrides: Partial<Pick<ResearchRunStatus, "phase" | "outcome" | "refusal">> = {},
  ): ResearchRunStatus => ({
    deadlineViolated: state.deadlineViolated,
    observedAt: new Date().toISOString(),
    outcome: overrides.outcome !== undefined ? overrides.outcome : state.outcome,
    phase: overrides.phase ?? state.phase,
    process,
    refusal: overrides.refusal ?? state.refusal,
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    stop: state.stopState,
    verificationWindowMs: schedule.verificationWindowMs,
    workload: request.workload,
  });

  const refused = (code: ResearchRefusalCode): ResearchRunOutcome => {
    diagnose("research_run_refused", { code });
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: code }),
      result: emptyResult(1),
    };
  };

  // The state root is derived here, never supplied: no caller names this path.
  const channelPromise = (async (): Promise<ResearchControlChannel> => {
    const stateRoot = researchStateRoot(wiring.config.dataDir, request.executionId);
    await mkdir(resolve(wiring.config.dataDir, STATE_DIRECTORY), { recursive: true, mode: 0o700 })
      .catch(() => { throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE"); });
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
      .catch(() => { throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE"); });
    return ResearchControlChannel.open(stateRoot);
  })();
  channelPromise.catch(() => undefined);

  // Register the graceful stop before any await: a cancellation that arrives
  // between the ledger write and the sandbox launch must still be able to ask
  // the workload to stop instead of being reduced to an immediate abort.
  let stopApplied = false;
  let stopCause: "user" | "budget" | null = null;
  let stopTask: Promise<void> = Promise.resolve();
  const requestStop = (cause: "user" | "budget" = "user"): Promise<void> => {
    stopCause ??= cause;
    if (stopApplied) return stopTask;
    stopApplied = true;
    state.stopState = "requested";
    state.stopId = randomUUID();
    state.stopRequestedAtMs = elapsedMs();
    stopTask = (async () => {
      const channel = await channelPromise.catch(() => undefined);
      if (!channel) {
        state.stopState = "unconfirmed";
        return;
      }
      try {
        await channel.writeStop(state.stopId!);
      } catch (error) {
        // The intent is durable in the ledger; the channel is not. Nothing is
        // trusted from it afterwards and the run is reclaimed by the deadline.
        state.stopState = "unconfirmed";
        state.refusal ??= error instanceof ResearchRunError ? error.code : "RESEARCH_CONTROL_WRITE_FAILED";
        diagnose("research_stop_channel_unconfirmed");
      }
    })();
    return stopTask;
  };
  launch.lifecycle?.requestStop?.(() => requestStop("user"));
  if (launch.signal.aborted) void requestStop();
  else launch.signal.addEventListener("abort", () => { void requestStop(); }, { once: true });

  return (async (): Promise<ResearchRunOutcome> => {
    let channel: ResearchControlChannel;
    try {
      channel = await channelPromise;
    } catch (error) {
      return refused(error instanceof ResearchRunError ? error.code : "RESEARCH_CONTROL_OPEN_FAILED");
    }
    try {
      // A stop that arrived before this operation began means nothing was ever
      // launched: the record says so positively instead of inferring it.
      if (launch.signal.aborted) {
        await stopTask.catch(() => undefined);
        return {
          research: statusOf("not_started", { phase: "finished", outcome: "not-started" }),
          result: emptyResult(0),
        };
      }
      const run = (environment?: EnvironmentRuntime) => launchWorkload({
        channel,
        deadlines,
        diagnose,
        elapsedMs,
        emptyResult,
        environment,
        launch,
        request,
        requestStop: () => requestStop("budget"),
        schedule,
        state,
        statusOf,
        stopCause: () => stopCause,
        wiring,
      });
      if (!request.environmentId) return await run();
      if (!wiring.environmentStore) return refused("RESEARCH_ENVIRONMENT_UNAVAILABLE");
      try {
        return await wiring.environmentStore.withRuntime(request.environmentId, async (environment) => {
          if (request.expectedEnvironmentRevisionId !== undefined
            && environment.revision.id !== request.expectedEnvironmentRevisionId) {
            return refused("RESEARCH_ENVIRONMENT_REVISION_MISMATCH");
          }
          if (request.environmentId !== environment.environment.id) {
            return refused("RESEARCH_ENVIRONMENT_UNAVAILABLE");
          }
          return await run(environment);
        });
      } catch (error) {
        return refused(error instanceof ResearchRunError ? error.code : "RESEARCH_ENVIRONMENT_UNAVAILABLE");
      }
    } finally {
      await channel.close();
    }
  })();
}

interface LaunchOptions {
  readonly channel: ResearchControlChannel;
  readonly deadlines: ResearchRunDeadlines;
  readonly diagnose: (event: string, detail?: Record<string, unknown>) => void;
  readonly elapsedMs: () => number;
  readonly emptyResult: (exitCode: number, environment?: EnvironmentRuntime) => ShellExecutionResult;
  readonly environment: EnvironmentRuntime | undefined;
  readonly launch: ResearchRunLaunch;
  readonly request: ResearchRunRequest;
  /** Ask the workload to stop because its research phase budget is spent. */
  readonly requestStop: () => Promise<void>;
  readonly schedule: ResearchTimeSchedule;
  readonly state: RunState;
  readonly statusOf: (
    process: ResearchProcessEvidence,
    overrides?: Partial<Pick<ResearchRunStatus, "phase" | "outcome" | "refusal">>,
  ) => ResearchRunStatus;
  /** Why a stop was requested, so a reclaim is attributed honestly. */
  readonly stopCause: () => "user" | "budget" | null;
  readonly wiring: ResearchRunWiring;
}

/** Launch the fixed program and observe it until it is proven gone. */
async function launchWorkload(options: LaunchOptions): Promise<ResearchRunOutcome> {
  const { channel, deadlines, environment, launch, request, schedule, state, statusOf, wiring } = options;
  const config = wiring.config;
  if (executorSandboxKind(config) !== "bubblewrap") {
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: "RESEARCH_SANDBOX_UNSUPPORTED" }),
      result: options.emptyResult(1, environment),
    };
  }
  const workspaceBinds = workspaceBindArguments(request.workspaceRoot, undefined);
  let prepared: SandboxLaunch;
  try {
    prepared = await prepareSandboxLaunch(config, {
      chdir: workspaceBinds.chdir,
      environmentBinds: environment ? environmentPrefixBindArguments(environment.prefixPath) : [],
      environmentPaths: environment ? [environment.prefixPath] : [],
      // Mask the host interpreters only when a managed environment supplies the
      // interpreter: masking them unconditionally would bind /dev/null over the
      // very `/usr/bin/python3` the no-environment path executes.
      hostInterpreterMasks: environment ? await hostInterpreterMaskArguments() : [],
      hostRuntimeSupport: await resolveHostRuntimeSupport(config.dataDir),
      language: "python",
      pathEnv: environment ? "/opt/science-env/bin:/usr/bin" : "/usr/bin",
      // The control directory is the only extra mount. It is Runner-owned, has
      // no host data, and is the one writable place the workload is given
      // outside its own workspace.
      workspaceBindArgs: [...workspaceBinds.args, "--bind", channel.hostPath, RESEARCH_CONTROL_MOUNT],
      workspaceRoot: request.workspaceRoot,
    });
  } catch {
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: "RESEARCH_LAUNCH_FAILED" }),
      result: options.emptyResult(1, environment),
    };
  }

  const interpreter = environment
    ? sandboxCommandPath(prepared, "/opt/science-env/bin/python", environment.interpreterPath)
    : sandboxCommandPath(prepared, "/usr/bin/python3", "/usr/bin/python3");
  const commandArguments = [interpreter, "-I", "-B", "-", RESEARCH_CONTROL_MOUNT];

  let spawned = false;
  let boundary: ExecutionBoundaryHandle | "ended" | "unavailable" | undefined;
  let exitCode = 1;
  let settled = false;
  let forced = false;
  const controller = new AbortController();

  const recordState = (text: string): void => {
    let record;
    try {
      record = parseResearchWorkloadRecord(text);
    } catch (error) {
      // A record this Runner cannot read is not evidence; keep the first named
      // refusal and stop treating later values as trustworthy.
      state.refusal ??= error instanceof ResearchRunError ? error.code : "RESEARCH_RECORD_MALFORMED";
      return;
    }
    state.phase = record.phase;
    if (record.outcome !== null) state.outcome = record.outcome;
    if (record.stopId !== null && record.stopId === state.stopId) {
      state.consumed = true;
      state.stopState = "consumed";
    }
  };

  const forceReclaim = async (byDeadline: boolean): Promise<void> => {
    if (forced) return;
    forced = true;
    if (byDeadline) state.deadlineViolated = true;
    options.diagnose("research_run_force_reclaim");
    // A requested kill is a request, not proof: the namespace check below is
    // what decides, and the manager checks again from the durable row.
    controller.abort();
    if (boundary !== undefined && boundary !== "unavailable" && boundary !== "ended") {
      const grace = Math.max(50, Math.min(1_000, schedule.verificationWindowMs));
      await terminateExecutionBoundary(boundary, {
        killGraceMs: grace,
        pollMs: Math.min(POLL_MS, grace),
        procRoot: wiring.procRoot,
        termGraceMs: grace,
      }).catch(() => undefined);
    }
  };

  const runPromise = runSandboxed(
    config,
    prepared,
    commandArguments,
    `${wiring.program}\n`,
    deadlines.hardDeadlineMs,
    request.workspaceRoot,
    controller.signal,
    "Research workload",
    request.maxWorkspaceBytes ?? 0,
    Math.min(request.maxOutputBytes ?? RESEARCH_RECORD_MAX_BYTES, RESEARCH_RECORD_MAX_BYTES),
    "baseline",
    undefined,
    (child, sandbox) => {
      spawned = true;
      // The manager captures and persists the identity in this same turn; ours
      // is only the read-back used for escalation and proof.
      launch.lifecycle?.spawned({
        kind: sandbox === "bubblewrap" ? "pid-namespace" : "process",
        pid: child.pid ?? 0,
        sandbox,
      });
      const report = launch.lifecycle?.boundary?.();
      boundary = report === undefined
        ? undefined
        : report.state === "captured" ? report.handle : report.state;
    },
  ).then((result) => {
    exitCode = result.exitCode;
  }).catch((error: unknown) => {
    options.diagnose("research_run_launch_error", { spawned });
    void error;
  }).finally(() => {
    settled = true;
  });

  // Observe on the same turn as the deadline checks. Nothing here infers a
  // business result from the process; the record is the only business source.
  while (!settled) {
    const now = options.elapsedMs();
    // The research phase budget ends at `stopAt`. A workload still researching
    // is asked to stop gracefully; a workload that already reported the
    // reporting phase keeps the rest of the budget. Only the hard deadline
    // (less the verification window) reclaims the namespace uninvited.
    if (state.phase === "research" && now >= deadlines.stopAtMs) void options.requestStop();
    if (now >= deadlines.forceKillAtMs) {
      await forceReclaim(options.stopCause() !== "user");
    } else if (state.stopRequestedAtMs !== null
      && now >= Math.min(state.stopRequestedAtMs + schedule.stopGraceMs, deadlines.forceKillAtMs)) {
      await forceReclaim(options.stopCause() !== "user");
    }
    const record = await channel.read(RECORD_FILE);
    if (record.status === "text") recordState(record.text);
    else if (record.status === "refused") state.refusal ??= record.code;
    if (!state.consumed) {
      const consumed = await channel.read(STOP_CONSUMED_FILE);
      if (consumed.status === "text") {
        try {
          const marker = parseResearchWorkloadRecord(consumed.text);
          if (marker.stopId !== null && marker.stopId === state.stopId) {
            state.consumed = true;
            state.stopState = "consumed";
          }
        } catch {
          // A workload-defined file that is not our marker is not consumption.
        }
      }
    }
    if (!settled) await delay(POLL_MS);
  }
  await runPromise;

  // The workload may have written its final record between the last poll and
  // its exit; read once more before deciding it never reported.
  const finalRecord = await channel.read(RECORD_FILE);
  if (finalRecord.status === "text") recordState(finalRecord.text);
  else if (finalRecord.status === "refused") state.refusal ??= finalRecord.code;

  if (!spawned) {
    // No process was created. Only here may the run be described as
    // `not_started`, and only with the refusal that prevented it.
    const code = state.refusal ?? "RESEARCH_LAUNCH_FAILED";
    options.diagnose("research_run_not_started", { code });
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: code }),
      result: options.emptyResult(1, environment),
    };
  }

  const proven = await waitForBoundary(boundary, verificationWindowFor(schedule, deadlines, options.elapsedMs()), wiring.procRoot);
  const processFact: ResearchProcessEvidence = proven ? "spawned-then-terminated" : "unverified";
  if (!proven) options.diagnose("research_run_boundary_unverified");
  // A record must say the run finished; anything else (missing, late, corrupt)
  // is `unknown`, never "nothing ran". An unknown research outcome keeps every
  // fence because neither publication nor release is justified.
  const reported = state.phase === "finished" && state.outcome !== null;
  const outcome: ResearchOutcome | null = reported ? state.outcome : "unknown";
  return {
    research: statusOf(processFact, { outcome }),
    result: options.emptyResult(exitCode, environment),
  };
}

/**
 * The verification window actually available: the reserved window, less any
 * time the force-reclaim and join already spent, and never past the hard
 * deadline. The run's budget therefore counts the wait instead of extending it.
 */
function verificationWindowFor(
  schedule: ResearchTimeSchedule,
  deadlines: ResearchRunDeadlines,
  elapsedMs: number,
): number {
  return Math.max(0, Math.min(schedule.verificationWindowMs, deadlines.hardDeadlineMs - elapsedMs));
}

/** Poll until the namespace is empty or the verification window is spent. */
async function waitForBoundary(
  boundary: ExecutionBoundaryHandle | "ended" | "unavailable" | undefined,
  windowMs: number,
  procRoot: string | undefined,
): Promise<boolean> {
  // The manager observed the sandbox ending in its own spawn turn: the kernel
  // already showed no process, which is the same proof it will re-check.
  if (boundary === "ended") return true;
  if (boundary === undefined || boundary === "unavailable") return false;
  const started = process.hrtime.bigint();
  for (;;) {
    if (boundaryTerminationVerified(boundary, procRoot)) return true;
    if (Number((process.hrtime.bigint() - started) / 1_000_000n) >= windowMs) return false;
    await delay(POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
