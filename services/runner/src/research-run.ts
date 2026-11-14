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
 * - the request names an identity, one input content identity and a time
 *   schedule; it cannot name a program, an interpreter, a module, a host path,
 *   a bundle root, a file list, replacement bytes, a mount point, an
 *   environment variable, a state root, or a control-file location;
 * - the input bundle is verified through the Runner's own content-addressed
 *   store and copied into a directory derived from the execution id, before any
 *   sandbox exists. The copy is written from the buffers those checks
 *   described, re-verified, published with one rename and mounted read-only at
 *   a fixed path after the workspace and control binds; the shared cache
 *   directory is never mounted;
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
import { lstat, mkdir, open, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  parseScienceFlowInputBundleManifest,
  RESEARCH_RUN_SCHEMA_VERSION,
  RESEARCH_WORKLOAD_KINDS,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  isScienceFlowInputBundleDigest,
  type ResearchEngineEvidence,
  type ResearchInputEvidence,
  type ResearchInputFileEvidence,
  type ResearchInputIdentity,
  type ResearchOutcome,
  type ResearchPhase,
  type ResearchProcessEvidence,
  type ResearchRefusalCode,
  type ResearchReportOutcome,
  type ResearchRunRequest,
  type ResearchRunStatus,
  type ResearchStopState,
  type ResearchTimeSchedule,
  type ShellExecutionResult,
} from "@sciencediscovery/schema";
import { SYSTEM_SHELL_ENVIRONMENT_REVISION_ID } from "@sciencediscovery/schema";
import { checkEngineRevision } from "@sciencediscovery/scienceflow-reader";

import {
  scienceFlowInputBundleDigest,
  verifyScienceFlowInputCopy,
  type ScienceFlowInputSnapshot,
} from "./scienceflow-input-bundles.js";
import {
  parseScienceFlowEngineLink,
  researchEngineStateRoot,
  SCIENCEFLOW_ENGINE_BRIDGE_SOURCE,
  SCIENCEFLOW_ENGINE_MOUNT,
  SCIENCEFLOW_ENGINE_STATE_MOUNT,
} from "./scienceflow-engine-bridge.js";

import type { EnvironmentRuntime, EnvironmentStore } from "./environment-store.js";
import {
  boundaryTerminationVerified,
  terminateExecutionBoundary,
  type ExecutionBoundaryHandle,
  type ExecutionLifecycle,
  type ExecutionObservation,
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
/**
 * Fixed mount point of this execution's verified input copy. It is Runner code,
 * never a manifest or request value, and it is bound read-only after the
 * workspace and control mounts so nothing later can replace it with a writable
 * one.
 */
export const RESEARCH_INPUTS_MOUNT = "/research-inputs";

const CONTROL_DIRECTORY = "control";
const RECORD_FILE = "status";
const ENGINE_LINK_FILE = "engine";
const STOP_FILE = "stop";
const STOP_CONSUMED_FILE = "stop.consumed";
const STOP_PENDING_FILE = "stop.pending";
const STATE_DIRECTORY = "runner-research";
const INPUT_STATE_DIRECTORY = "runner-research-inputs";
/** Observation cadence; the deadline checks run on the same turn. */
const POLL_MS = 25;
/**
 * Bound on the spawn handshake before the monotonic schedule exists. It is not
 * part of the run budget; it only prevents a spawn that never returns (a hung
 * sandbox preparation) from parking the operation forever.
 */
const SPAWN_HANDSHAKE_BOUND_MS = 10_000;
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
  RESEARCH_RECORD_MISSING: "The research workload's final record is not at its name after the process ended",
  RESEARCH_RECORD_OVERSIZE: "The research workload record exceeds its fixed size bound",
  RESEARCH_RECORD_MALFORMED: "The research workload record is not valid fixed-vocabulary JSON",
  RESEARCH_RECORD_VERSION_UNKNOWN: "The research workload record names an unknown protocol version",
  RESEARCH_RECORD_IDENTITY_MISMATCH: "The research workload record names another execution, attempt or stop",
  RESEARCH_RECORD_TRANSITION_INVALID: "The research workload record made an illegal phase or terminal transition",
  RESEARCH_STOP_NOT_DURABLE: "The research stop intent could not be persisted, so no stop was requested",
  RESEARCH_ENVIRONMENT_REQUIRED: "A research run requires an explicit managed environment binding",
  RESEARCH_STATE_SAVE_FAILED: "A research lifecycle fact could not be persisted to the execution ledger",
  RESEARCH_ENVIRONMENT_UNAVAILABLE: "The managed environment for this research run could not be leased",
  RESEARCH_ENVIRONMENT_REVISION_MISMATCH: "The managed environment is no longer at the revision the caller expected",
  RESEARCH_SANDBOX_UNSUPPORTED: "The research workload requires the bubblewrap sandbox",
  RESEARCH_LAUNCH_FAILED: "The research workload could not be launched inside its sandbox",
  RESEARCH_INPUT_REQUIRED: "A research run requires the prepared input bundle it consumes",
  RESEARCH_INPUT_UNAVAILABLE: "The prepared input bundle this run named is not available or is not the one it claims",
  RESEARCH_INPUT_COPY_FAILED: "The execution's private input copy could not be prepared and verified",
  RESEARCH_ENGINE_NOT_CONFIGURED: "This Runner has no revision-pinned ScienceFlow engine to run",
  RESEARCH_ENGINE_UNAVAILABLE: "The pinned ScienceFlow checkout is not the verified revision this Runner requires",
  RESEARCH_ENGINE_IDENTITY_MISMATCH: "The engine run does not match the pinned revision and version this Runner requires",
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
    "agentId", "environmentId", "executionId", "expectedEnvironmentRevisionId", "inputs", "kind",
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
  // Inputs are an identity, never a locator: two digests and nothing else.
  // Absent is accepted here so a pre-consumption request or stored record still
  // parses; the internal submission path refuses a new execution without one.
  const inputs = value.inputs === undefined ? undefined : parseResearchInputIdentity(value.inputs);
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
    ...(inputs !== undefined ? { inputs } : {}),
    ...(Array.isArray(npuDevices) ? { npuDevices: [...npuDevices as number[]] } : {}),
    permissionEpoch: epoch as unknown as ResearchRunRequest["permissionEpoch"],
    ...(optional("runnerWorkspaceKey", 160) ? { runnerWorkspaceKey: value.runnerWorkspaceKey as string } : {}),
    schedule: parseResearchTimeSchedule(value.schedule),
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    workload: value.workload as ResearchRunRequest["workload"],
    workspaceRoot,
  };
}

/** One input identity: exactly two lowercase SHA-256 digests, nothing else. */
export function parseResearchInputIdentity(value: unknown): ResearchInputIdentity {
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "bundleDigest" || keys[1] !== "contractDigest") {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  if (!isScienceFlowInputBundleDigest(value.contractDigest)
    || !isScienceFlowInputBundleDigest(value.bundleDigest)) {
    throw new ResearchRunError("RESEARCH_REQUEST_INVALID");
  }
  return { contractDigest: value.contractDigest, bundleDigest: value.bundleDigest };
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

/**
 * The private input copy for one execution. Like the state root it is derived
 * from the execution id by digest, so no id text becomes a path component and
 * two executions can never share a copy. It lives outside every workspace and
 * every workload-writable bind, and the shared bundle cache is never mounted.
 */
export function researchInputRoot(dataDir: string, executionId: string): string {
  const digest = createHash("sha256").update(`research-inputs\n${executionId}`, "utf8").digest("hex");
  return resolve(dataDir, INPUT_STATE_DIRECTORY, digest.slice(0, 32));
}

/** One directory identity, as the filesystem itself reports it. */
interface HostDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** A path's ancestors, plus whether the path itself exists. */
interface HostPathChain {
  readonly exists: boolean;
  /**
   * The path with every existing component resolved and every missing one
   * appended: two spellings of one future location compare equal even when
   * neither exists yet.
   */
  readonly canonical: string;
  readonly identities: readonly HostDirectoryIdentity[];
}

/**
 * Resolve a path and every existing ancestor, following links once.
 *
 * A path that does not exist yet is anchored at its deepest existing ancestor:
 * that chain still names every directory the future path would live in.
 * Identities are device and inode numbers rather than strings, so a symlink or
 * a bind mount naming the same directory compares equal. `undefined` means the
 * question could not be answered, which callers treat as an overlap.
 */
async function hostPathChain(path: string): Promise<HostPathChain | undefined> {
  let candidate = path;
  let resolved: string | undefined;
  const missing: string[] = [];
  let exists = true;
  for (;;) {
    try {
      resolved = await realpath(candidate);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      // Only the first failure is about the requested path; its ancestors are
      // being probed, so they do not make the requested path exist.
      if (candidate === path) exists = false;
      const parent = dirname(candidate);
      if (parent === candidate) {
        // Nothing on this path resolves: the root itself is unreadable.
        return undefined;
      }
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
  const identities: HostDirectoryIdentity[] = [];
  for (let cursor = resolved; ; cursor = dirname(cursor)) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(cursor, { bigint: true });
    } catch {
      return undefined;
    }
    if (!info.isDirectory()) return undefined;
    identities.push({ dev: info.dev, ino: info.ino });
    if (dirname(cursor) === cursor) break;
  }
  return {
    canonical: missing.length === 0 ? resolved : resolve(resolved, ...missing),
    exists,
    identities,
  };
}

function sameDirectory(left: HostDirectoryIdentity, right: HostDirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** True when `descendant` is `ancestor` itself or lives below it. */
function pathWithin(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}${sep}`);
}

/**
 * True when one host path is at or below the other, through links and mounts.
 *
 * Existing directories are compared by device and inode, so a symlink or a
 * bind mount naming the same directory is caught. A path that does not exist
 * yet is compared by its canonical future spelling, so a request naming the
 * copy root before the Runner creates it is still an overlap. A shared ancestor
 * such as `/` is not. `undefined` withholds an answer when a path cannot be
 * resolved, which callers treat as an overlap.
 */
async function hostPathsOverlap(left: string, right: string): Promise<boolean | undefined> {
  const leftChain = await hostPathChain(left);
  const rightChain = await hostPathChain(right);
  if (leftChain === undefined || rightChain === undefined) return undefined;
  const leftIdentity = leftChain.identities[0];
  const rightIdentity = rightChain.identities[0];
  if (leftIdentity === undefined || rightIdentity === undefined) return undefined;
  if (rightChain.exists && leftChain.identities.some((entry) => sameDirectory(entry, rightIdentity))) {
    return true;
  }
  if (leftChain.exists && rightChain.identities.some((entry) => sameDirectory(entry, leftIdentity))) {
    return true;
  }
  return pathWithin(rightChain.canonical, leftChain.canonical)
    || pathWithin(leftChain.canonical, rightChain.canonical);
}

/**
 * Refuse a launch whose writable binds would expose the verified input bytes a
 * second time.
 *
 * `--ro-bind /research-inputs` only removes writability through that mount
 * point. A workspace or control bind that covers the same host directory still
 * gives the workload a second, writable name for the same inode, and the
 * workload runs as the owning account, so it can chmod the copy back. Neither
 * a string comparison of requested paths nor file modes answer this: the
 * comparison is by the filesystem's own directory identities, so a symlinked or
 * bind-mounted alias compares equal, and a path that cannot be resolved is a
 * refusal rather than an assumption.
 */
async function assertInputLocationsPrivate(
  protectedPaths: readonly string[],
  writableHostRoots: readonly string[],
): Promise<void> {
  for (const protectedPath of protectedPaths) {
    for (const writable of writableHostRoots) {
      if (await hostPathsOverlap(protectedPath, writable) !== false) {
        throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
      }
    }
  }
}

/** The fixed base this workload runs in. It manages no packages. */
export const RESEARCH_SYSTEM_ENVIRONMENT_REVISION_ID = SYSTEM_SHELL_ENVIRONMENT_REVISION_ID;

/** What the Runner reads back from the workload's own record. */
export interface ResearchWorkloadRecord {
  readonly execution: string;
  readonly phase: ResearchPhase;
  readonly outcome: ResearchOutcome | null;
  readonly report: ResearchReportOutcome;
  readonly stopId: string | null;
}

/**
 * Parse the workload's record against a fixed whitelist and bind it to this
 * execution.
 *
 * Every branch that does not match is a named refusal. A bad field is never
 * dropped to make the rest readable: a record that cannot be understood is not
 * evidence about the run. Each record names the execution it belongs to, so a
 * record left by another attempt can never be read as this run's result, and
 * the research and report facts are stated separately instead of being folded
 * into one outcome.
 */
export function parseResearchWorkloadRecord(text: string, executionId: string): ResearchWorkloadRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  const allowed = ["execution", "outcome", "phase", "report", "stopId", "version"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (typeof value.version !== "number") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  if (value.version !== RESEARCH_CONTROL_PROTOCOL_VERSION) {
    throw new ResearchRunError("RESEARCH_RECORD_VERSION_UNKNOWN");
  }
  if (typeof value.execution !== "string") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  if (value.execution !== executionId) throw new ResearchRunError("RESEARCH_RECORD_IDENTITY_MISMATCH");
  const phase = value.phase;
  if (phase !== "research" && phase !== "reporting" && phase !== "finished") {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  const outcome = value.outcome;
  const report = value.report;
  const terminal = (entry: unknown): entry is ResearchOutcome =>
    entry === "not-started" || entry === "completed" || entry === "stopped" || entry === "failed";
  if (phase === "research") {
    // Research is in progress: neither fact is known yet.
    if (outcome !== undefined || report !== undefined) throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  } else if (phase === "reporting") {
    // Entering reporting states what the research phase did; it is never
    // inferred from the phase alone.
    if (!terminal(outcome) || outcome === "not-started") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
    if (report !== undefined && report !== "generating") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  } else {
    if (!terminal(outcome)) throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
    // A finished record states the report fact too. A run that stopped before
    // any reporting says `none`; every other terminal outcome says how the
    // report ended, so a completed research phase is never read as a successful
    // run without a ready report.
    if (outcome === "not-started") {
      if (report !== undefined && report !== "none") throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
    } else if (report !== "ready" && report !== "incomplete" && report !== "failed") {
      throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
    }
  }
  const stopId = value.stopId;
  if (stopId !== undefined && (typeof stopId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(stopId))) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  return {
    execution: executionId,
    outcome: phase === "research" ? null : outcome as ResearchOutcome,
    phase,
    report: phase === "research" ? "none"
      : phase === "reporting" ? (report ?? "generating") as ResearchReportOutcome
        : (report ?? "none") as ResearchReportOutcome,
    stopId: stopId ?? null,
  };
}

/**
 * Parse the workload's acknowledgement that it consumed a stop.
 *
 * The marker is deliberately smaller than a status record: it names the
 * protocol version and the stop only. Anything else at that name is not an
 * acknowledgement and is ignored by the caller.
 */
export function parseStopMarker(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (!isRecord(value)) throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  if (Object.keys(value).some((key) => key !== "stopId" && key !== "version")) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  if (value.version !== RESEARCH_CONTROL_PROTOCOL_VERSION) {
    throw new ResearchRunError("RESEARCH_RECORD_VERSION_UNKNOWN");
  }
  const stopId = value.stopId;
  if (typeof stopId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(stopId)) {
    throw new ResearchRunError("RESEARCH_RECORD_MALFORMED");
  }
  return stopId;
}

/** The business facts one run has established so far. */
export interface ResearchRecordFacts {
  readonly phase: ResearchPhase;
  /** Terminal-by-definition for the fold; `unknown` until a record states one. */
  readonly outcome: ResearchOutcome;
  readonly report: ResearchReportOutcome;
  readonly stopId: string | null;
}

export type ResearchRecordUpdate =
  | { readonly status: "applied"; readonly facts: ResearchRecordFacts }
  | { readonly status: "refused"; readonly code: ResearchRefusalCode };

const PHASE_RANK = { finished: 2, reporting: 1, research: 0 } as const satisfies Record<ResearchPhase, number>;

/**
 * Fold one record into the run's business facts.
 *
 * Identity is checked first: a record naming a stop this run did not persist is
 * another attempt's record, not evidence. The phase only moves forward, a
 * terminal record is final (terminal → non-terminal and terminal → a different
 * terminal are both refused), a research outcome already stated is never
 * rewritten by a later phase, and a stop outcome requires the stop this run
 * actually persisted. Anything else is a named refusal, never a silent repair.
 */
export function nextResearchRecordState(
  current: ResearchRecordFacts | null,
  record: ResearchWorkloadRecord,
  context: { readonly stopId: string | null; readonly stopRequested: boolean },
): ResearchRecordUpdate {
  if (record.stopId !== null && record.stopId !== context.stopId) {
    return { status: "refused", code: "RESEARCH_RECORD_IDENTITY_MISMATCH" };
  }
  if ((record.outcome === "stopped" || record.outcome === "not-started") && !context.stopRequested) {
    // Nothing asked this run to stop, so a record that claims it was stopped is
    // not a stop: it is a claim without an intent behind it.
    return { status: "refused", code: "RESEARCH_RECORD_IDENTITY_MISMATCH" };
  }
  if (current === null) {
    return {
      status: "applied",
      facts: {
        outcome: record.outcome ?? "unknown",
        phase: record.phase,
        report: record.report,
        stopId: record.stopId,
      },
    };
  }
  if (PHASE_RANK[record.phase] < PHASE_RANK[current.phase]) {
    return { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" };
  }
  if (current.phase === "finished") {
    // The operation re-reads the file after the join; the same terminal record
    // is not a second transition, but a different one would rewrite history.
    const same = record.phase === "finished" && record.outcome === current.outcome
      && record.report === current.report;
    return same ? { status: "applied", facts: current }
      : { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" };
  }
  // The research outcome, once stated, is the run's research fact for the rest
  // of the run. A later phase may add how reporting ended (`completed` with a
  // failed report stays `completed` + `failed`), but it may never rewrite what
  // the research phase already did: a finished record does not turn a
  // completed research phase into a failure, and a stopped or failed research
  // phase is not upgraded to a completion.
  if (current.outcome !== "unknown" && record.outcome !== null && record.outcome !== current.outcome) {
    return { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" };
  }
  // A stated report only moves forward: `generating` may become a terminal
  // report, never the reverse, and two different terminal reports conflict.
  if (record.report !== "none" && current.report !== "none" && record.report !== current.report
    && current.report !== "generating") {
    return { status: "refused", code: "RESEARCH_RECORD_TRANSITION_INVALID" };
  }
  return {
    status: "applied",
    facts: {
      outcome: record.outcome ?? current.outcome,
      phase: record.phase,
      report: record.report === "none" ? current.report : record.report,
      stopId: record.stopId ?? current.stopId,
    },
  };
}

/**
 * Stable stop identity for one durable intent. It is derived from the execution
 * and the instant the intent was persisted, so the manager can recompute the
 * same id from the durable row and nothing depends on an in-memory UUID. The
 * alphabet is the record's stop-id alphabet.
 */
export function researchStopId(executionId: string, stopRequestedAt: string): string {
  return createHash("sha256").update(`research-stop\n${executionId}\n${stopRequestedAt}`, "utf8")
    .digest("hex").slice(0, 32);
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

  /**
   * Read one control entry without ever blocking the supervision turn.
   *
   * `O_NONBLOCK` matters as much as `O_NOFOLLOW` here: a FIFO at a fixed name
   * would otherwise park the open until a writer appeared, which stops the
   * deadline checks and wedges the manager queue. The open is therefore
   * non-blocking and the *descriptor* decides the type (`fstat`); a FIFO,
   * device or directory is refused immediately instead of being read.
   *
   * A regular file is read through a limit+1 buffer and must reach EOF: the
   * buffer is never sized from an earlier `stat` and a record that grew past
   * the bound is refused rather than published truncated.
   */
  async read(name: string): Promise<ControlRead> {
    let handle: FileHandle;
    try {
      handle = await open(this.entry(name), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "refused", code: "RESEARCH_CONTROL_REPLACED" };
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { status: "refused", code: "RESEARCH_CONTROL_REPLACED" };
      if (info.size > RESEARCH_RECORD_MAX_BYTES) return { status: "refused", code: "RESEARCH_RECORD_OVERSIZE" };
      const buffer = Buffer.alloc(RESEARCH_RECORD_MAX_BYTES + 1);
      let offset = 0;
      for (;;) {
        if (offset >= buffer.length) return { status: "refused", code: "RESEARCH_RECORD_OVERSIZE" };
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

/**
 * The real engine, as the Runner's own trusted configuration binds it.
 *
 * Every field is Runner-side configuration: a request, a route, a bundle or an
 * environment variable cannot name a checkout, a revision or a version. The
 * checkout is verified as the declared commit before any process exists, and
 * is bound read-only into the sandbox at a fixed mount.
 */
export interface ResearchEngineBinding {
  /** Absolute path of the revision-pinned checkout. */
  readonly sourceRoot: string;
  /** The full commit the checkout must be at. */
  readonly revision: string;
  /** The package version the checkout must declare and the bridge must report. */
  readonly version: string;
  /**
   * Test-only seam: an importable module inside the sandbox that supplies the
   * research step (`run(manifest)`). Production never sets it; the engine's own
   * `run_manifest` is then the only research step.
   */
  readonly researchStepModule?: string;
}

/** What the fixed program may be, and how the Runner reaches it. */
export interface ResearchRunWiring {
  /**
   * The trusted fixed program. It is Runner code: a request, a route, a config
   * file or an environment variable can never supply or replace it. Exactly one
   * of `program` and `engine` is configured.
   */
  readonly program?: string;
  /**
   * The real patched engine. When set, the program is the Runner's fixed
   * bridge, the engine checkout is mounted read-only and the engine's managed
   * lifecycle is what runs inside the sandbox.
   */
  readonly engine?: ResearchEngineBinding;
  readonly config: ExecutorConfig;
  /**
   * The real store leases the environment and keeps its mutation gate for the
   * whole workload. A production wiring always sets it; a request without an
   * environment is refused rather than falling back to the host interpreter.
   */
  readonly environmentStore?: Pick<EnvironmentStore, "withRuntime">;
  /**
   * The Runner's own content-addressed bundle store. A request names a digest;
   * this store re-verifies that the named bundle is exactly the manifest and
   * bytes it claims. It is a constructor dependency like the program: no
   * request field can substitute another source, and a wiring without one
   * refuses an input-bound execution before spawn.
   */
  readonly inputBundles?: {
    snapshot(bundleDigest: string): Promise<ScienceFlowInputSnapshot>;
    /** Host roots this store owns, so a launcher can prove no writable bind covers them. */
    hostRoots(): readonly string[];
  };
  /**
   * Test-only host runtime for fixtures that do not lease a managed
   * environment. Production never sets it: the run then records this fixture
   * identity in its result instead of pretending a managed revision was leased,
   * and the choice is made by Runner construction, never by a request field.
   */
  readonly fixtureRuntime?: { readonly identity: string; readonly interpreterPath: string };
  /** Test seam: a synthetic `/proc` root for boundary observation. */
  readonly procRoot?: string;
  readonly onDiagnostic?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Validate a stored or returned `verified` input evidence record.
 *
 * The manifest parser is the protocol's own, and the digest is recomputed from
 * the canonical manifest, so evidence carried across a restart can never name a
 * file set whose bytes and identity disagree. `null` means the record is not
 * evidence this Runner may publish.
 */
export function verifiedResearchInputs(value: unknown): ResearchInputEvidence | null {
  if (!isRecord(value) || value.state !== "verified") return null;
  if (!isScienceFlowInputBundleDigest(value.contractDigest)
    || !isScienceFlowInputBundleDigest(value.bundleDigest)) {
    return null;
  }
  const parsed = parseScienceFlowInputBundleManifest({
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: value.contractDigest,
    files: value.files,
  });
  if (parsed.status !== "ok") return null;
  const digest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(parsed.manifest), "utf8")
    .digest("hex");
  if (digest !== value.bundleDigest) return null;
  return {
    contractDigest: value.contractDigest,
    bundleDigest: value.bundleDigest,
    state: "verified",
    files: parsed.manifest.files.map((file) => Object.freeze({
      path: file.path,
      roles: [...file.roles],
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

/** One execution's private, verified input copy. Runner-internal only. */
interface PreparedResearchInputs {
  /** Host path of the published copy; never leaves this process. */
  readonly root: string;
  /** The plain index the fixed program receives, with no host path in it. */
  readonly index: string;
  readonly evidence: ResearchInputEvidence;
  readonly cleanup: () => Promise<void>;
}

/**
 * Verify the named bundle and materialize this execution's private copy.
 *
 * The bytes written are the buffers the store read through its held directory
 * descriptor, not a second read of the same path. The copy is built in an
 * exclusive staging directory, re-verified against the canonical manifest, and
 * published with one rename; a half-written tree is never mountable. A leftover
 * copy from an earlier attempt at the same execution id is neither reused nor
 * repaired: it is a fixed refusal. Before any of that, the location itself must
 * be private: a writable bind that covers the copy or the shared cache would
 * undo the read-only mount, so it is refused before anything is created.
 */
async function prepareResearchInputs(
  wiring: ResearchRunWiring,
  request: ResearchRunRequest,
  writableHostRoots: readonly string[],
): Promise<PreparedResearchInputs> {
  const inputs = request.inputs;
  if (inputs === undefined) throw new ResearchRunError("RESEARCH_INPUT_REQUIRED");
  const store = wiring.inputBundles;
  if (store === undefined) throw new ResearchRunError("RESEARCH_INPUT_UNAVAILABLE");
  let snapshot: ScienceFlowInputSnapshot;
  try {
    snapshot = await store.snapshot(inputs.bundleDigest);
  } catch {
    throw new ResearchRunError("RESEARCH_INPUT_UNAVAILABLE");
  }
  const manifest = snapshot.manifest;
  if (manifest.contractDigest !== inputs.contractDigest
    || scienceFlowInputBundleDigest(manifest) !== inputs.bundleDigest) {
    throw new ResearchRunError("RESEARCH_INPUT_UNAVAILABLE");
  }
  for (const file of manifest.files) {
    if (snapshot.contents.get(file.path) === undefined) {
      throw new ResearchRunError("RESEARCH_INPUT_UNAVAILABLE");
    }
  }

  const parent = resolve(wiring.config.dataDir, INPUT_STATE_DIRECTORY);
  const root = researchInputRoot(wiring.config.dataDir, request.executionId);
  // Nothing Runner-owned may sit where this launch will bind a writable host
  // directory: the copy root, its staging parent and the shared cache have to
  // be disjoint from every writable bind source, including through links and
  // mount aliases. This runs before anything is created, so a refusal leaves
  // no partial copy behind.
  await assertInputLocationsPrivate([parent, root, ...store.hostRoots()], writableHostRoots);
  await mkdir(parent, { recursive: true, mode: 0o700 })
    .catch(() => { throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED"); });
  // The private root is Runner-owned: a link, a non-directory, or a directory
  // another account can write is not a place to materialize verified bytes.
  let parentInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    parentInfo = await lstat(parent);
  } catch {
    throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o022) !== 0) {
    throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
  }
  const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
  });
  if (existing !== undefined) throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");

  const staging = resolve(parent, `.${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const file of manifest.files) {
      const target = resolve(staging, file.path);
      if (!target.startsWith(`${staging}${sep}`)) {
        throw new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, snapshot.contents.get(file.path)!, { flag: "wx", mode: 0o444 });
    }
    // The copy that will be mounted is checked against the same manifest the
    // bytes were verified against; a partial or damaged staging tree never
    // reaches the rename.
    await verifyScienceFlowInputCopy(staging, manifest.files);
    await rename(staging, root);
  } catch (error) {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined);
    throw error instanceof ResearchRunError ? error : new ResearchRunError("RESEARCH_INPUT_COPY_FAILED");
  }

  const files: readonly ResearchInputFileEvidence[] = manifest.files.map((file) => Object.freeze({
    path: file.path,
    roles: [...file.roles],
    size: file.size,
    sha256: file.sha256,
  }));
  const evidence: ResearchInputEvidence = Object.freeze({
    contractDigest: inputs.contractDigest,
    bundleDigest: inputs.bundleDigest,
    state: "verified",
    files,
  });
  return {
    root,
    index: JSON.stringify({
      schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
      contractDigest: inputs.contractDigest,
      bundleDigest: inputs.bundleDigest,
      files,
    }),
    evidence,
    cleanup: async () => { await rm(root, { force: true, recursive: true }); },
  };
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
  if ((wiring.program === undefined) === (wiring.engine === undefined)) {
    // Exactly one program source: the fixture program a test injects, or the
    // Runner's fixed bridge to a pinned engine. Neither is reachable from a
    // request, and a wiring with both is ambiguous rather than convenient.
    throw new ResearchRunError(wiring.engine === undefined ? "RESEARCH_RUN_NOT_CONFIGURED" : "RESEARCH_ENGINE_NOT_CONFIGURED");
  }
  if (wiring.engine !== undefined) {
    const engine = wiring.engine;
    if (!engine.sourceRoot.startsWith("/") || engine.sourceRoot.split("/").includes("..")
      || !/^[0-9a-f]{40}$/.test(engine.revision)
      || typeof engine.version !== "string" || engine.version.trim().length === 0
      || (engine.researchStepModule !== undefined
        && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(engine.researchStepModule))) {
      throw new ResearchRunError("RESEARCH_ENGINE_NOT_CONFIGURED");
    }
  } else if (typeof wiring.program !== "string" || wiring.program.trim().length === 0) {
    throw new ResearchRunError("RESEARCH_RUN_NOT_CONFIGURED");
  }
  return {
    run: (request, launch) => runResearchWorkload(wiring, request, launch),
  };
}

/** Refusals that mean the business evidence itself is unusable. */
const RECORD_INTEGRITY_REFUSALS: ReadonlySet<ResearchRefusalCode> = new Set([
  "RESEARCH_CONTROL_REPLACED",
  "RESEARCH_RECORD_MISSING",
  "RESEARCH_RECORD_OVERSIZE",
  "RESEARCH_RECORD_MALFORMED",
  "RESEARCH_RECORD_VERSION_UNKNOWN",
  "RESEARCH_RECORD_IDENTITY_MISMATCH",
  "RESEARCH_RECORD_TRANSITION_INVALID",
  "RESEARCH_STATE_SAVE_FAILED",
  "RESEARCH_ENGINE_IDENTITY_MISMATCH",
]);

/**
 * A record this Runner could not read or could not trust is not evidence, even
 * when an earlier read looked like a completion. This is the policy gate the
 * ledger applies; the operation already replaces such facts with `unknown`.
 */
export function researchRecordUnusable(status: ResearchRunStatus): boolean {
  return status.refusal !== undefined && RECORD_INTEGRITY_REFUSALS.has(status.refusal);
}

/**
 * What the ledger state may become after a research operation returned.
 *
 * An unproven process or an unknown research outcome is `unknown`: it is
 * terminal for the control plane and keeps every fence. A completion comes only
 * from the workload's own terminal record, never from an exit code, and it
 * needs a ready report: research completed while reporting was stopped is a
 * cancelled run that keeps both facts.
 */
export function researchExecutionState(
  status: ResearchRunStatus,
  aborted: boolean,
): "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown" {
  if (status.process === "not_started") return status.refusal !== undefined ? "failed" : "unknown";
  if (status.process !== "spawned-then-terminated") return "unknown";
  // §5.6: proof that does not complete inside the hard deadline is `unknown`,
  // whatever the business record says. The fact of a late proof is never
  // rewritten as an on-time completion.
  if (status.deadlineViolated) return "unknown";
  if (researchRecordUnusable(status)) return "unknown";
  if (status.outcome === null || status.outcome === "unknown") return "unknown";
  if (status.outcome === "stopped" || status.outcome === "not-started") return "cancelled";
  if (status.outcome === "failed") return "failed";
  // Research completed. The report is a separate fact: only a ready report is a
  // completed execution. A report stopped by a durable stop is cancelled; a
  // report that failed or never finished on its own is a failed run.
  if (status.report === "ready") return "completed";
  if (status.stop !== "none") return "cancelled";
  return aborted ? "cancelled" : "failed";
}

/**
 * Publication needs a proven process boundary and business evidence that is
 * valid, complete and correlated. A missing, unreadable or foreign record is
 * `unknown`, so nothing is published from it.
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
  // A spawned execution must have consumed a verified input set. This Runner
  // records that set before the process exists, so a record that still carries
  // only the caller's declaration has no evidence the run read the bytes its
  // contract named. A pre-spawn refusal above is a different, positive fact.
  if (status.inputs !== undefined && status.inputs.state !== "verified") return false;
  if (status.deadlineViolated) return false;
  if (researchRecordUnusable(status)) return false;
  if (status.outcome === null || status.outcome === "unknown") return false;
  // A stop outcome without the durable intent behind it is a claim, not a fact.
  if ((status.outcome === "stopped" || status.outcome === "not-started") && status.stop === "none") return false;
  return true;
}

/** Mutable observation state for one run, so failures keep their owner. */
interface RunState {
  stopState: ResearchStopState;
  stopId: string | null;
  stopCause: "user" | "budget" | null;
  stopRequestedAtMs: number | null;
  phase: ResearchPhase | "unknown";
  outcome: ResearchOutcome | null;
  report: ResearchReportOutcome;
  /** The folded business facts; `null` until a valid record exists. */
  facts: ResearchRecordFacts | null;
  /** The declared identity, replaced by the verified file set before spawn. */
  inputs: ResearchInputEvidence | undefined;
  /** The engine run this execution created, once the bridge reported it. */
  engine: ResearchEngineEvidence | undefined;
  /** Whether this wiring runs the real engine, so a link is required. */
  engineRequired: boolean;
  refusal: ResearchRefusalCode | undefined;
  /** A record was unusable, so no earlier business value may be published. */
  invalid: boolean;
  consumed: boolean;
  forceReclaimRequested: boolean;
  deadlineViolated: boolean;
  spawnedAt: string | undefined;
}

function runResearchWorkload(
  wiring: ResearchRunWiring,
  request: ResearchRunRequest,
  launch: ResearchRunLaunch,
): Promise<ResearchRunOutcome> {
  const startedAt = new Date().toISOString();
  const schedule = request.schedule;
  const deadlines = researchRunDeadlines(schedule);
  // The time base is the spawn instant (§5.6), so it stays unset until the
  // sandbox really exists: environment lease and sandbox preparation never
  // consume the schedule, and no stop/kill can fire before the spawn turn.
  let spawnedAtNs: bigint | null = null;
  const elapsedMs = (): number =>
    spawnedAtNs === null ? 0 : Number((process.hrtime.bigint() - spawnedAtNs) / 1_000_000n);
  const startClock = (): string => {
    spawnedAtNs = process.hrtime.bigint();
    state.spawnedAt = new Date().toISOString();
    return state.spawnedAt;
  };
  const state: RunState = {
    consumed: false,
    deadlineViolated: false,
    engine: undefined,
    engineRequired: wiring.engine !== undefined,
    facts: null,
    forceReclaimRequested: false,
    inputs: request.inputs === undefined
      ? undefined
      : { ...request.inputs, state: "declared" },
    invalid: false,
    outcome: null,
    phase: "unknown",
    refusal: undefined,
    report: "none",
    spawnedAt: undefined,
    stopCause: null,
    stopId: null,
    stopRequestedAtMs: null,
    stopState: "none",
  };
  const diagnose = (event: string, detail?: Record<string, unknown>) => {
    wiring.onDiagnostic?.(event, detail);
  };
  /**
   * Persist a whitelisted fact in the ledger. In the spawn turn a failure must
   * reach the launcher (it still owns the child); later in the run it turns the
   * record into `unknown` and the namespace is reclaimed instead of leaving the
   * operation and the ledger describing different things.
   */
  const observe = (facts: ExecutionObservation, required: boolean): void => {
    try {
      launch.lifecycle?.observed?.(facts);
    } catch (error) {
      state.refusal ??= "RESEARCH_STATE_SAVE_FAILED";
      diagnose("research_state_save_failed");
      if (required) throw error;
    }
  };

  const emptyResult = (exitCode: number, environment?: EnvironmentRuntime): ShellExecutionResult => ({
    cgroupMode: "none",
    createdFiles: [],
    environmentRevisionId: environment?.revision.id
      ?? wiring.fixtureRuntime?.identity
      ?? RESEARCH_SYSTEM_ENVIRONMENT_REVISION_ID,
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
    overrides: Partial<Pick<ResearchRunStatus, "phase" | "outcome" | "report" | "refusal">> = {},
  ): ResearchRunStatus => ({
    deadlineViolated: state.deadlineViolated,
    forceReclaimRequested: state.forceReclaimRequested,
    observedAt: new Date().toISOString(),
    outcome: overrides.outcome !== undefined ? overrides.outcome : state.outcome,
    phase: overrides.phase ?? state.phase,
    process,
    refusal: overrides.refusal ?? state.refusal,
    report: overrides.report ?? state.report,
    schedule,
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    ...(state.inputs !== undefined ? { inputs: state.inputs } : {}),
    ...(state.engine !== undefined ? { engine: state.engine } : {}),
    ...(state.spawnedAt !== undefined ? { spawnedAt: state.spawnedAt } : {}),
    stop: state.stopState,
    ...(state.stopCause !== null ? { stopCause: state.stopCause } : {}),
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

  // A research run must be bound to an explicit environment. Production never
  // falls back to the host interpreter; a test wiring may name a fixture
  // runtime, and that identity is what the result records. This is a typed
  // pre-spawn refusal: no channel is opened and no process exists.
  const fixture = wiring.fixtureRuntime;
  if (request.environmentId === undefined
    && (request.expectedEnvironmentRevisionId !== undefined || fixture === undefined
      || fixture.identity.length === 0 || !fixture.interpreterPath.startsWith("/"))) {
    return Promise.resolve(refused("RESEARCH_ENVIRONMENT_REQUIRED"));
  }
  if (request.environmentId !== undefined && wiring.environmentStore === undefined) {
    return Promise.resolve(refused("RESEARCH_ENVIRONMENT_UNAVAILABLE"));
  }
  const environmentStore = wiring.environmentStore;

  // A new execution without an input identity is refused before the state root
  // or any control channel exists. There is no fallback to workspace files and
  // nothing is collected on the API's behalf.
  if (request.inputs === undefined) {
    return Promise.resolve(refused("RESEARCH_INPUT_REQUIRED"));
  }

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
  //
  // Every stop, user or budget, first obtains a durable identity from the
  // manager and only then writes the control file. A failed save therefore
  // leaves no channel write, no abort and no signal behind: the intent does not
  // exist, so nothing may act as if it did, and the hard deadline stays the
  // only reclaim until a later tick can persist the intent.
  let stopApplied = false;
  let stopTask: Promise<void> = Promise.resolve();
  let lastPersistAttemptMs = Number.NEGATIVE_INFINITY;

  const applyStop = async (stopId: string, cause: "user" | "budget"): Promise<void> => {
    state.stopCause ??= cause;
    state.stopId = stopId;
    state.stopState = "requested";
    state.stopRequestedAtMs = elapsedMs();
    observe({ research: { stop: "requested" } }, false);
    const channel = await channelPromise.catch(() => undefined);
    if (!channel) {
      state.stopState = "unconfirmed";
      return;
    }
    try {
      await channel.writeStop(stopId);
    } catch (error) {
      // The intent is durable in the ledger; the channel is not. Nothing is
      // trusted from it afterwards and the run is reclaimed by the deadline.
      state.stopState = "unconfirmed";
      state.refusal ??= error instanceof ResearchRunError ? error.code : "RESEARCH_CONTROL_WRITE_FAILED";
      diagnose("research_stop_channel_unconfirmed");
      observe({ research: { stop: "unconfirmed" } }, false);
    }
  };

  const requestStop = (cause: "user" | "budget" = "user", durableId?: string): Promise<void> => {
    if (stopApplied) return stopTask;
    if (durableId !== undefined) {
      // The manager already persisted this intent and handed back its identity.
      stopApplied = true;
      stopTask = applyStop(durableId, cause);
      return stopTask;
    }
    // Retrying a failed persist is bounded but must never become an unrecorded
    // stop: the throttle only limits SQLite attempts, not the deadline checks.
    const now = elapsedMs();
    if (now - lastPersistAttemptMs < 250) return stopTask;
    lastPersistAttemptMs = now;
    stopApplied = true;
    stopTask = (async () => {
      let durableId: string;
      try {
        const persist = launch.lifecycle?.persistStopIntent;
        if (!persist) throw new Error("no durable stop-intent path");
        durableId = await persist(cause);
      } catch {
        // No durable intent exists, so no stop exists: nothing was written to
        // the control channel, nothing was aborted and no signal was sent. A
        // later tick retries under the same throttle; the hard deadline stays
        // the only unconditional reclaim until then.
        diagnose("research_stop_intent_unpersisted");
        stopApplied = false;
        return;
      }
      await applyStop(durableId, cause);
    })();
    return stopTask;
  };
  launch.lifecycle?.requestStop?.((stopId) => requestStop("user", stopId));
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
        observe,
        request,
        requestStop: () => requestStop("budget"),
        schedule,
        startClock,
        state,
        statusOf,
        wiring,
      });
      if (!request.environmentId || environmentStore === undefined) return await run();
      try {
        return await environmentStore.withRuntime(request.environmentId, async (environment) => {
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
  /** Persist one whitelisted lifecycle fact; throws when `required`. */
  readonly observe: (facts: ExecutionObservation, required: boolean) => void;
  readonly request: ResearchRunRequest;
  /** Ask the workload to stop because its research phase budget is spent. */
  readonly requestStop: () => Promise<void>;
  readonly schedule: ResearchTimeSchedule;
  /** Start the monotonic base inside the spawn turn; returns the wall clock. */
  readonly startClock: () => string;
  readonly state: RunState;
  readonly statusOf: (
    process: ResearchProcessEvidence,
    overrides?: Partial<Pick<ResearchRunStatus, "phase" | "outcome" | "report" | "refusal">>,
  ) => ResearchRunStatus;
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
  const fixture = wiring.fixtureRuntime;
  if (!environment && !fixture) {
    // The request guard refuses this shape before the channel is opened. The
    // engine keeps the same refusal here so no future caller can reach a host
    // interpreter by omitting the binding: there is no fallback path at all.
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: "RESEARCH_ENVIRONMENT_REQUIRED" }),
      result: options.emptyResult(1),
    };
  }

  // The real engine, when this wiring runs it, must be the pinned checkout
  // before anything else happens: a source root that is not the declared
  // commit is a fixed pre-spawn refusal, never a fallback to another checkout
  // or another interpreter.
  const engine = wiring.engine;
  let engineRoot: string | undefined;
  if (engine !== undefined) {
    let check: Awaited<ReturnType<typeof checkEngineRevision>> | undefined;
    try {
      check = await checkEngineRevision({ path: engine.sourceRoot, expectedRevision: engine.revision });
    } catch {
      check = undefined;
    }
    if (check === undefined || check.status !== "verified-clean") {
      return {
        research: statusOf("not_started", {
          phase: "unknown", outcome: null, refusal: "RESEARCH_ENGINE_UNAVAILABLE",
        }),
        result: options.emptyResult(1, environment),
      };
    }
    engineRoot = researchEngineStateRoot(config.dataDir, request.executionId);
    try {
      await mkdir(engineRoot, { recursive: true, mode: 0o700 });
      const info = await lstat(engineRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
        throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE");
      }
    } catch (error) {
      return {
        research: statusOf("not_started", {
          phase: "unknown",
          outcome: null,
          refusal: error instanceof ResearchRunError ? error.code : "RESEARCH_STATE_ROOT_UNSAFE",
        }),
        result: options.emptyResult(1, environment),
      };
    }
  }

  // Verify the named bundle and build this execution's private copy inside the
  // workspace admission gate, before any sandbox exists. The workload is only
  // launched once these bytes are the ones that were checked.
  let inputs: PreparedResearchInputs;
  try {
    // The only writable host sources this launch will bind are the workspace
    // root, the control directory and, for a real engine, its state directory;
    // all are checked against every Runner-owned input location before the copy
    // is materialized.
    inputs = await prepareResearchInputs(wiring, request, [
      request.workspaceRoot, channel.hostPath, ...(engineRoot === undefined ? [] : [engineRoot]),
    ]);
  } catch (error) {
    const code = error instanceof ResearchRunError ? error.code : "RESEARCH_INPUT_UNAVAILABLE";
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: code }),
      result: options.emptyResult(1, environment),
    };
  }
  // A spawned record must never carry only the caller's declaration. The
  // verified set is persisted before the process can exist; if the ledger
  // cannot accept it, nothing is launched.
  try {
    state.inputs = inputs.evidence;
    options.observe({ research: { inputs: inputs.evidence } }, true);
  } catch {
    await inputs.cleanup().catch(() => undefined);
    return {
      research: statusOf("not_started", {
        phase: "unknown", outcome: null, refusal: "RESEARCH_STATE_SAVE_FAILED",
      }),
      result: options.emptyResult(1, environment),
    };
  }
  // From this point a spawn is possible, so cleanup belongs to the manager's
  // resource owner and runs only after termination is proven. A direct executor
  // call (no manager) keeps ownership here.
  let ownsInputs = true;
  if (launch.lifecycle?.retainResource) {
    launch.lifecycle.retainResource(inputs.cleanup, "research-input-copy");
    ownsInputs = false;
  }

  const workspaceBinds = workspaceBindArguments(request.workspaceRoot, undefined);
  // The engine checkout is read-only and the engine's state directory is the
  // only extra writable bind; both mount points are Runner constants. They are
  // bound after the workspace and control binds for the same reason the input
  // copy is: nothing later can replace them with a writable view.
  const engineBinds = engine === undefined || engineRoot === undefined ? [] : [
    "--ro-bind", engine.sourceRoot, SCIENCEFLOW_ENGINE_MOUNT,
    "--bind", engineRoot, SCIENCEFLOW_ENGINE_STATE_MOUNT,
  ];
  let prepared: SandboxLaunch;
  try {
    prepared = await prepareSandboxLaunch(config, {
      chdir: workspaceBinds.chdir,
      environmentBinds: environment ? environmentPrefixBindArguments(environment.prefixPath) : [],
      environmentPaths: environment ? [environment.prefixPath] : [],
      // Mask the host interpreters only when a managed environment supplies the
      // interpreter: masking them unconditionally would bind /dev/null over the
      // very host interpreter a fixture runtime was explicitly wired to use.
      hostInterpreterMasks: environment ? await hostInterpreterMaskArguments() : [],
      hostRuntimeSupport: await resolveHostRuntimeSupport(config.dataDir),
      language: "python",
      pathEnv: environment ? "/opt/science-env/bin:/usr/bin" : "/usr/bin",
      workspaceBindArgs: [...workspaceBinds.args, "--bind", channel.hostPath, RESEARCH_CONTROL_MOUNT,
        "--ro-bind", inputs.root, RESEARCH_INPUTS_MOUNT, ...engineBinds],
      workspaceRoot: request.workspaceRoot,
    });
  } catch {
    if (ownsInputs) await inputs.cleanup().catch(() => undefined);
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: "RESEARCH_LAUNCH_FAILED" }),
      result: options.emptyResult(1, environment),
    };
  }

  // The interpreter is the leased environment's or the explicitly wired
  // fixture runtime's. The execution id is passed as argv, so every business
  // record is bound to this execution by the Runner itself rather than by a
  // value the workload could choose. The input index is Runner-derived JSON:
  // logical paths and digests only, never a host path. With a real engine the
  // remaining arguments are the pinned mounts, the declared identity, the
  // phase budgets and, for a test wiring only, the substituted research step.
  const interpreter = environment
    ? sandboxCommandPath(prepared, "/opt/science-env/bin/python", environment.interpreterPath)
    : sandboxCommandPath(prepared, fixture!.interpreterPath, fixture!.interpreterPath);
  const engineArguments = engine === undefined ? [] : [
    SCIENCEFLOW_ENGINE_MOUNT,
    SCIENCEFLOW_ENGINE_STATE_MOUNT,
    engine.revision,
    engine.version,
    JSON.stringify({ reportBudgetMs: schedule.reportBudgetMs, researchBudgetMs: schedule.researchBudgetMs }),
    ...(engine.researchStepModule === undefined ? [] : [engine.researchStepModule]),
  ];
  const commandArguments = [interpreter, "-I", "-B", "-", RESEARCH_CONTROL_MOUNT, request.executionId,
    RESEARCH_INPUTS_MOUNT, inputs.index, ...engineArguments];
  const program = engine === undefined ? wiring.program! : SCIENCEFLOW_ENGINE_BRIDGE_SOURCE;

  let spawned = false;
  let boundary: ExecutionBoundaryHandle | "ended" | "unavailable" | undefined;
  let exitCode = 1;
  let settled = false;
  let forced = false;
  let lastObserved = "";
  let deadlineTimer: NodeJS.Timeout | undefined;
  const controller = new AbortController();

  /**
   * Drop every business value this run has read so far. A record that cannot be
   * understood, that names another execution or stop, or that makes an illegal
   * transition is not evidence, and an earlier read is not a cache to fall back
   * on: nothing may be published from a run whose record became untrustworthy.
   */
  const invalidate = (code: ResearchRefusalCode): void => {
    if (state.invalid) return;
    state.invalid = true;
    state.refusal ??= code;
    state.facts = null;
    state.phase = "unknown";
    state.outcome = null;
    state.report = "none";
    options.diagnose("research_record_invalid", { code });
  };

  const recordState = (text: string): void => {
    if (state.invalid) return;
    let record: ResearchWorkloadRecord;
    try {
      record = parseResearchWorkloadRecord(text, request.executionId);
    } catch (error) {
      invalidate(error instanceof ResearchRunError ? error.code : "RESEARCH_RECORD_MALFORMED");
      return;
    }
    const update = nextResearchRecordState(state.facts, record, {
      stopId: state.stopId,
      stopRequested: state.stopState !== "none",
    });
    if (update.status === "refused") {
      invalidate(update.code);
      return;
    }
    state.facts = update.facts;
    state.phase = update.facts.phase;
    state.outcome = update.facts.outcome === "unknown" ? null : update.facts.outcome;
    state.report = update.facts.report;
    if (record.stopId !== null && record.stopId === state.stopId && state.stopState !== "consumed") {
      state.consumed = true;
      state.stopState = "consumed";
    }
    // Persist what the read established, so a ledger reader during the run sees
    // the same facts the operation holds. A failed write is named and leaves the
    // run unpublishable; the child stays with this operation either way.
    const facts = {
      phase: state.phase as ResearchPhase,
      outcome: state.outcome,
      report: state.report,
      ...(state.consumed ? { stop: "consumed" as const } : {}),
    };
    const signature = JSON.stringify(facts);
    if (signature !== lastObserved) {
      lastObserved = signature;
      options.observe({ research: facts }, false);
    }
  };

  /**
   * Reclaim the namespace. Every grace is drawn from the remaining budget, so
   * neither the stop grace nor the two termination phases can extend the hard
   * deadline. This records a *request*; `deadlineViolated` is decided later by
   * the instant termination was proven.
   */
  const forceReclaim = async (): Promise<void> => {
    if (forced) return;
    forced = true;
    state.forceReclaimRequested = true;
    options.diagnose("research_run_force_reclaim");
    const remaining = Math.max(0, deadlines.hardDeadlineMs - options.elapsedMs());
    const termGraceMs = Math.max(0, Math.min(remaining, Math.min(1_000, schedule.verificationWindowMs)));
    const killGraceMs = Math.max(0, remaining - termGraceMs);
    const pollMs = Math.max(1, Math.min(POLL_MS, termGraceMs || killGraceMs || 1));
    // A requested kill is a request, not proof: the namespace check is what
    // decides, and the manager checks again from the durable row.
    controller.abort();
    if (boundary !== undefined && boundary !== "unavailable" && boundary !== "ended") {
      await terminateExecutionBoundary(boundary, {
        killGraceMs,
        pollMs,
        procRoot: wiring.procRoot,
        termGraceMs,
      }).catch(() => undefined);
    }
  };

  /**
   * Arm one absolute watchdog. Before the spawn it covers only a spawn handshake
   * that never returns; the moment the process exists it is re-armed from the
   * spawn instant, so no later phase can extend what §5.6 fixed.
   */
  const armDeadline = (ms: number): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => { void forceReclaim(); }, Math.max(0, ms));
    deadlineTimer.unref?.();
  };
  // The spawn handshake is not part of the run budget. This bound only stops a
  // spawn that never completes from parking the operation forever.
  armDeadline(deadlines.hardDeadlineMs + SPAWN_HANDSHAKE_BOUND_MS);

  const runPromise = runSandboxed(
    config,
    prepared,
    commandArguments,
    `${program}\n`,
    // The schedule is enforced by the spawn-based timer below, so the
    // executor's own timer is disabled here. It starts before the process
    // exists, and a full budget counted from there would shorten a run by its
    // sandbox setup time, which §5.6 does not allow.
    0,
    request.workspaceRoot,
    controller.signal,
    "Research workload",
    request.maxWorkspaceBytes ?? 0,
    Math.min(request.maxOutputBytes ?? RESEARCH_RECORD_MAX_BYTES, RESEARCH_RECORD_MAX_BYTES),
    // The research workload's own filter: the baseline plus `AF_UNIX`
    // socketpair, which a real asyncio loop needs. The choice is Runner code,
    // bound to this workload kind; no request or profile can select a variant.
    "research",
    undefined,
    (child, sandbox) => {
      // §5.6: the schedule starts at the spawn instant, not at submission,
      // environment lease or sandbox preparation.
      const spawnedAt = options.startClock();
      armDeadline(deadlines.hardDeadlineMs);
      spawned = true;
      // The positive process fact is persisted before anything else is said
      // about this run: a reader must never see `not_started` for a process
      // that exists. A ledger failure throws inside the spawn turn, where the
      // executor still owns the child and must stop it.
      options.observe({ process: "spawned", spawnedAt }, true);
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
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  });

  // Observe on the same turn as the deadline checks. Nothing here infers a
  // business result from the process; the record is the only business source.
  while (!settled) {
    const now = options.elapsedMs();
    // The research phase budget ends at `stopAt`. A workload still researching
    // is asked to stop gracefully; a workload that already reported the
    // reporting phase keeps the rest of the budget. Only the hard deadline
    // (less the verification window) reclaims the namespace uninvited.
    if ((state.phase === "research" || state.phase === "unknown") && now >= deadlines.stopAtMs) {
      void options.requestStop();
    }
    if (now >= deadlines.forceKillAtMs) {
      await forceReclaim();
    } else if (state.stopRequestedAtMs !== null
      && now >= Math.min(state.stopRequestedAtMs + schedule.stopGraceMs, deadlines.forceKillAtMs)) {
      await forceReclaim();
    }
    const record = await channel.read(RECORD_FILE);
    if (record.status === "text") {
      recordState(record.text);
    } else if (record.status === "refused") {
      invalidate(record.code);
      // A replaced channel can never be observed again; clean up now instead
      // of polling a suspect path until the deadline. Every other refusal is
      // business evidence: the workload keeps running and is stopped on time.
      if (record.code === "RESEARCH_CONTROL_REPLACED") await forceReclaim();
    }
    if (!state.consumed && !state.invalid) {
      const consumed = await channel.read(STOP_CONSUMED_FILE);
      if (consumed.status === "text") {
        try {
          const marker = parseStopMarker(consumed.text);
          if (marker === state.stopId) {
            state.consumed = true;
            state.stopState = "consumed";
          }
        } catch {
          // A workload-defined file that is not our marker is not consumption.
        }
      }
    }
    // The bridge reports the engine run it created once. It is evidence only
    // when it names this execution at the declared revision and version; a
    // link that does not is not a different engine run, it is no engine run.
    if (engine !== undefined && state.engine === undefined && !state.invalid) {
      const link = await channel.read(ENGINE_LINK_FILE);
      if (link.status === "text") {
        const parsed = parseScienceFlowEngineLink(link.text, request.executionId, engine);
        if (parsed === null) invalidate("RESEARCH_ENGINE_IDENTITY_MISMATCH");
        else {
          state.engine = parsed;
          options.observe({ research: { engine: parsed } }, false);
        }
      } else if (link.status === "refused") {
        invalidate(link.code);
      }
    }
    if (!settled) await delay(POLL_MS);
  }
  await runPromise;

  // The workload may have written its final record between the last poll and
  // its exit; read once more before deciding it never reported.
  const finalRecord = await channel.read(RECORD_FILE);
  if (finalRecord.status === "text") recordState(finalRecord.text);
  else if (finalRecord.status === "refused") invalidate(finalRecord.code);
  else {
    // The record the run is judged by must still be at its name once the
    // process is gone. An earlier read is not a receipt for a withdrawn one:
    // there is no immutable terminal acknowledgement in this protocol, so a
    // missing final record leaves no business evidence at all. Waiting for the
    // name to appear during the run is normal; its absence at exit is not.
    invalidate("RESEARCH_RECORD_MISSING");
  }

  if (!spawned) {
    // No process was created. Only here may the run be described as
    // `not_started`, and only with the refusal that prevented it.
    const code = state.refusal ?? "RESEARCH_LAUNCH_FAILED";
    options.diagnose("research_run_not_started", { code });
    if (ownsInputs) await inputs.cleanup().catch(() => undefined);
    return {
      research: statusOf("not_started", { phase: "unknown", outcome: null, refusal: code }),
      result: options.emptyResult(1, environment),
    };
  }

  // A real engine run must have reported its engine identity. A workload that
  // ran but never named the engine run it created leaves the association
  // unproven, and an unproven association is not published.
  if (state.engineRequired && state.engine === undefined && !state.invalid) {
    invalidate("RESEARCH_ENGINE_IDENTITY_MISMATCH");
  }

  const proven = await waitForBoundary(
    boundary,
    verificationWindowFor(schedule, deadlines, options.elapsedMs()),
    wiring.procRoot,
  );
  const provedAtMs = options.elapsedMs();
  // §5.6: the violation is a fact about the proof instant. A user-caused
  // reclaim proven late is still late, and a budget reclaim proven on time is
  // not a violation; neither cause may override the measurement.
  state.deadlineViolated = !proven || provedAtMs > deadlines.hardDeadlineMs;
  const processFact: ResearchProcessEvidence = proven ? "spawned-then-terminated" : "unverified";
  if (!proven) options.diagnose("research_run_boundary_unverified");
  // A record must say the run finished; anything else (missing, late, corrupt)
  // is `unknown`, never "nothing ran". An unknown research outcome keeps every
  // fence because neither publication nor release is justified.
  const reported = state.facts !== null && state.facts.phase === "finished"
    && state.facts.outcome !== "unknown";
  const outcome: ResearchOutcome | null = reported ? state.facts!.outcome : "unknown";
  // A manager-owned copy is released only by the manager, after it proves this
  // process tree gone; a direct executor call releases its own.
  if (ownsInputs) await inputs.cleanup().catch(() => undefined);
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

/**
 * Poll until the namespace is empty or the verification window is spent.
 *
 * A zero window still performs one observation: after the hard deadline the
 * Runner may keep observing and cleaning up conservatively, but the proof
 * instant is what the caller records, so a late proof is never rewritten as an
 * on-time one.
 */
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
