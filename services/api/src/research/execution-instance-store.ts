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
 * Durable identity and state for one execution instance.
 *
 * An instance is one attempt to run a trusted launch specification under this
 * host. Its identity is deliberately separate from a product plan id, a
 * managed run id, and a registration id: none of those is ever used as the
 * execution handle, and this id is never passed to the engine.
 *
 * The stored record is the only source of truth after the launching process is
 * gone. It is written with an atomic replace, carries a schema version, and is
 * validated strictly on read: a damaged record is reported, never repaired,
 * deleted, or guessed around.
 *
 * One instance directory per execution id is created without `recursive`, so the
 * filesystem decides which concurrent start wins. Only the recorded owner may
 * request a stop; readers are unrestricted within the process that holds the
 * state root.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

/** The only record version this module writes or reads. */
export const EXECUTION_INSTANCE_SCHEMA_VERSION = 1;
/** A safe single path component: no separators, no leading dot, bounded. */
const EXECUTION_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Real lifecycle states. "stopped" means a stop was requested and the instance
 * was then observed to be gone; "exited" means the launcher observed the process
 * end on its own; "lost" means the process is verifiably gone but nobody saw it
 * end, so no exit code may be claimed.
 */
export const EXECUTION_INSTANCE_STATES = [
  "starting",
  "running",
  "stop_requested",
  "stopped",
  "exited",
  "lost",
  "unknown",
] as const;

export type ExecutionInstanceState =
  (typeof EXECUTION_INSTANCE_STATES)[number];

/** Why an instance can never be observed or stopped. Static; never free text. */
export const EXECUTION_INSTANCE_UNKNOWN_REASONS = [
  /** The process was spawned but its kernel identity was never recorded. */
  "launch-unrecorded",
  /** The process could not be started at all; nothing was launched. */
  "launch-failed",
] as const;

export type ExecutionInstanceUnknownReason =
  (typeof EXECUTION_INSTANCE_UNKNOWN_REASONS)[number];

/** Kernel facts captured once, at launch. Never inferred from a command line. */
export interface ExecutionInstanceProcess {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  /** Field 22 of /proc/[pid]/stat: clock ticks since boot, as decimal text. */
  readonly startTimeTicks: string;
  /** /proc/sys/kernel/random/boot_id at launch. */
  readonly bootId: string;
  /** Effective uid of the started process; must match the launcher. */
  readonly uid: number;
  /** /proc/[pid]/comm at launch. Informational only; never an identity. */
  readonly commandName: string;
}

export interface ExecutionInstanceExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly endedAt: string;
}

export interface ExecutionInstanceStopRecord {
  readonly requestId: string | null;
  readonly requestedAt: string | null;
  readonly requestedBy: "caller" | "deadline" | null;
  readonly termSignalSentAt: string | null;
  readonly killSignalSentAt: string | null;
}

export interface ExecutionInstanceLogRecord {
  /** File names inside the instance directory, never host paths. */
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface ExecutionInstanceRecord {
  readonly schemaVersion: typeof EXECUTION_INSTANCE_SCHEMA_VERSION;
  readonly executionId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly launch: {
    readonly requestId: string;
    /** SHA-256 of the canonical launch specification that created this attempt. */
    readonly specDigest: string;
    readonly deadlineAt: string | null;
  };
  readonly state: ExecutionInstanceState;
  readonly process: ExecutionInstanceProcess | null;
  readonly stop: ExecutionInstanceStopRecord;
  readonly exit: ExecutionInstanceExit | null;
  readonly logs: ExecutionInstanceLogRecord;
  readonly unknownReason: ExecutionInstanceUnknownReason | null;
}

/** A record that can be handed out: no host paths, no launch text. */
export interface ExecutionInstanceSnapshot {
  readonly executionId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly state: ExecutionInstanceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string | null;
  /** True when a deadline is recorded and has passed. Never enforced on its own. */
  readonly overdue: boolean;
  readonly stopRequestedAt: string | null;
  readonly stopRequestedBy: "caller" | "deadline" | null;
  readonly processId: number | null;
  readonly processGroupId: number | null;
  readonly exit: ExecutionInstanceExit | null;
  /** What the recorded facts support; never a research outcome. */
  readonly outcome: ExecutionInstanceOutcome;
  readonly logTruncated: boolean;
  readonly unknownReason: ExecutionInstanceUnknownReason | null;
}

export type ExecutionInstanceOutcome =
  | "running"
  | "completed"
  | "failed"
  | "signalled"
  | "stopped"
  | "lost"
  | "unknown";

export type ExecutionInstanceReadResult =
  | { readonly status: "ok"; readonly record: ExecutionInstanceRecord }
  | { readonly status: "missing" }
  /** The file exists but its content cannot be trusted. Static reason only. */
  | {
      readonly status: "invalid";
      readonly reason:
        | "unreadable"
        | "not-json"
        | "not-an-object"
        | "schema-version"
        | "field"
        | "identity";
    };

export function isExecutionInstanceId(value: string): boolean {
  return EXECUTION_INSTANCE_ID_PATTERN.test(value);
}

/** The digest binds one start request to the exact specification it launched. */
export function launchSpecDigest(specification: unknown): string {
  return createHash("sha256").update(canonicalJson(specification)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

/** Project the durable record onto what a caller may see. */
export function executionInstanceSnapshot(
  record: ExecutionInstanceRecord,
  now: Date = new Date(),
): ExecutionInstanceSnapshot {
  const overdue =
    record.launch.deadlineAt !== null &&
    Date.parse(record.launch.deadlineAt) <= now.getTime() &&
    record.state !== "stopped" &&
    record.state !== "exited" &&
    record.state !== "lost";
  return {
    executionId: record.executionId,
    attemptId: record.attemptId,
    owner: record.owner,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadlineAt: record.launch.deadlineAt,
    overdue,
    stopRequestedAt: record.stop.requestedAt,
    stopRequestedBy: record.stop.requestedBy,
    processId: record.process?.pid ?? null,
    processGroupId: record.process?.processGroupId ?? null,
    exit: record.exit,
    outcome: instanceOutcome(record),
    logTruncated: record.logs.truncated,
    unknownReason: record.unknownReason,
  };
}

function instanceOutcome(record: ExecutionInstanceRecord): ExecutionInstanceOutcome {
  switch (record.state) {
    case "starting":
    case "running":
    case "stop_requested":
      return "running";
    case "stopped":
      return "stopped";
    case "lost":
      return "lost";
    case "unknown":
      return "unknown";
    case "exited": {
      if (record.exit === null) return "unknown";
      if (record.exit.signal !== null) return "signalled";
      if (record.exit.code === 0) return "completed";
      return typeof record.exit.code === "number" ? "failed" : "unknown";
    }
  }
}

/**
 * Records live in `<root>/<executionId>/instance.json`. The store never deletes
 * a record except for a launch that provably started nothing (see
 * `discardFailedLaunch`).
 */
export class ExecutionInstanceStore {
  constructor(readonly root: string) {
    if (!root) throw new TypeError("state root must be a non-empty path");
  }

  directoryFor(executionId: string): string {
    if (!isExecutionInstanceId(executionId)) {
      throw new TypeError("executionId is not a valid instance id");
    }
    return resolve(this.root, executionId);
  }

  logPath(executionId: string, name: string): string {
    if (name !== "stdout.log" && name !== "stderr.log") {
      throw new TypeError("log name must be stdout.log or stderr.log");
    }
    return resolve(this.directoryFor(executionId), name);
  }

  /** Atomic and non-recursive: exactly one concurrent start creates the dir. */
  async createDirectory(executionId: string): Promise<"created" | "exists"> {
    try {
      await mkdir(this.directoryFor(executionId), { mode: 0o700 });
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw error;
    }
  }

  async read(executionId: string): Promise<ExecutionInstanceReadResult> {
    let text: string;
    try {
      text = await readFile(
        resolve(this.directoryFor(executionId), "instance.json"),
        "utf8",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "missing" };
      return { status: "invalid", reason: "unreadable" };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { status: "invalid", reason: "not-json" };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { status: "invalid", reason: "not-an-object" };
    }
    // The version is checked before the shape: a future record is not a
    // malformed record, and neither may be reinterpreted.
    if (
      (value as Readonly<Record<string, unknown>>).schemaVersion !==
      EXECUTION_INSTANCE_SCHEMA_VERSION
    ) {
      return { status: "invalid", reason: "schema-version" };
    }
    const parsed = parseRecord(value);
    if (parsed === null) return { status: "invalid", reason: "field" };
    if (violatesIdentity(parsed)) return { status: "invalid", reason: "identity" };
    return { status: "ok", record: parsed };
  }

  /** Replace the record atomically; a partial file is never observable. */
  async write(record: ExecutionInstanceRecord): Promise<void> {
    const directory = this.directoryFor(record.executionId);
    const target = resolve(directory, "instance.json");
    const temporary = resolve(directory, `.instance.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove the directory of a launch that provably started no process. The
   * caller must have established that no pid was ever recorded; this is never
   * used to forget a real instance.
   */
  async discardFailedLaunch(executionId: string): Promise<void> {
    await unlink(resolve(this.directoryFor(executionId), "instance.json")).catch(
      () => undefined,
    );
  }
}

function parseRecord(value: unknown): ExecutionInstanceRecord | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== EXECUTION_INSTANCE_SCHEMA_VERSION) return null;
  const executionId = patternValue(value.executionId, EXECUTION_INSTANCE_ID_PATTERN);
  const attemptId = patternValue(value.attemptId, REQUEST_ID_PATTERN);
  const owner = patternValue(value.owner, OWNER_PATTERN);
  const createdAt = requireTimestamp(value.createdAt);
  const updatedAt = requireTimestamp(value.updatedAt);
  if (
    executionId === undefined ||
    attemptId === undefined ||
    owner === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return null;
  }
  const launch = value.launch;
  if (!isRecord(launch)) return null;
  const requestId = patternValue(launch.requestId, REQUEST_ID_PATTERN);
  const specDigest = patternValue(launch.specDigest, SHA256_PATTERN);
  const deadlineAt =
    launch.deadlineAt === null ? null : requireTimestamp(launch.deadlineAt);
  if (
    requestId === undefined ||
    specDigest === undefined ||
    deadlineAt === undefined
  ) {
    return null;
  }
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(EXECUTION_INSTANCE_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  const process = parseProcess(value.process);
  if (process === undefined) return null;
  const stop = parseStop(value.stop);
  if (stop === null) return null;
  const exit = parseExit(value.exit);
  if (exit === undefined) return null;
  const logs = parseLogs(value.logs);
  if (logs === null) return null;
  const unknownReason = value.unknownReason;
  if (
    unknownReason !== null &&
    (typeof unknownReason !== "string" ||
      !(EXECUTION_INSTANCE_UNKNOWN_REASONS as readonly string[]).includes(
        unknownReason,
      ))
  ) {
    return null;
  }
  // The identity must agree with the record: no process facts on a failed
  // launch, and no "running" state without them.
  return {
    schemaVersion: EXECUTION_INSTANCE_SCHEMA_VERSION,
    executionId,
    attemptId,
    owner,
    createdAt,
    updatedAt,
    launch: { requestId, specDigest, deadlineAt },
    state: state as ExecutionInstanceState,
    process,
    stop,
    exit,
    logs,
    unknownReason: unknownReason as ExecutionInstanceUnknownReason | null,
  };
}

function parseProcess(
  value: unknown,
): ExecutionInstanceProcess | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const pid = value.pid;
  const processGroupId = value.processGroupId;
  const sessionId = value.sessionId;
  const uid = value.uid;
  if (!isPositiveInteger(pid)) return undefined;
  if (!isPositiveInteger(processGroupId)) return undefined;
  if (!isPositiveInteger(sessionId)) return undefined;
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) return undefined;
  const effectiveUid = uid as number;
  const startTimeTicks = value.startTimeTicks;
  if (
    typeof startTimeTicks !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(startTimeTicks)
  ) {
    return undefined;
  }
  const bootId = patternValue(value.bootId, BOOT_ID_PATTERN);
  if (bootId === undefined) return undefined;
  if (typeof value.commandName !== "string" || value.commandName.length === 0) {
    return undefined;
  }
  return {
    pid,
    processGroupId,
    sessionId,
    startTimeTicks,
    bootId,
    uid: effectiveUid,
    commandName: value.commandName,
  };
}

function parseStop(
  value: unknown,
): ExecutionInstanceStopRecord | null {
  if (!isRecord(value)) return null;
  const requestId =
    value.requestId === null
      ? null
      : patternValue(value.requestId, REQUEST_ID_PATTERN);
  if (requestId === undefined) return null;
  const requestedAt =
    value.requestedAt === null ? null : requireTimestamp(value.requestedAt);
  if (requestedAt === undefined) return null;
  const requestedBy = value.requestedBy;
  if (
    requestedBy !== null &&
    requestedBy !== "caller" &&
    requestedBy !== "deadline"
  ) {
    return null;
  }
  const termSignalSentAt =
    value.termSignalSentAt === null
      ? null
      : requireTimestamp(value.termSignalSentAt);
  const killSignalSentAt =
    value.killSignalSentAt === null
      ? null
      : requireTimestamp(value.killSignalSentAt);
  if (termSignalSentAt === undefined || killSignalSentAt === undefined) {
    return null;
  }
  if (
    (requestedAt === null && (requestedBy !== null || termSignalSentAt !== null)) ||
    (requestedAt !== null && requestedBy === null)
  ) {
    return null;
  }
  return {
    requestId,
    requestedAt,
    requestedBy,
    termSignalSentAt,
    killSignalSentAt,
  };
}

function parseExit(value: unknown): ExecutionInstanceExit | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const code = value.code;
  if (code !== null && !Number.isSafeInteger(code)) return undefined;
  const signal = value.signal;
  if (signal !== null && typeof signal !== "string") return undefined;
  const endedAt = requireTimestamp(value.endedAt);
  if (endedAt === undefined) return undefined;
  if (code === null && signal === null) return undefined;
  return { code: code as number | null, signal: signal as string | null, endedAt };
}

function parseLogs(value: unknown): ExecutionInstanceLogRecord | null {
  if (!isRecord(value)) return null;
  if (value.stdout !== "stdout.log" || value.stderr !== "stderr.log") {
    return null;
  }
  if (typeof value.truncated !== "boolean") return null;
  return { stdout: "stdout.log", stderr: "stderr.log", truncated: value.truncated };
}

function violatesIdentity(record: ExecutionInstanceRecord): boolean {
  // No process facts without a live attempt, and none on a failed launch.
  if (
    (record.state === "running" || record.state === "stop_requested") &&
    record.process === null
  ) {
    return true;
  }
  return record.unknownReason !== null && record.process !== null;
}

function patternValue(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function requireTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
