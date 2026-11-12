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
 * Invoke the read-only ScienceFlow snapshot CLI and return a structured result.
 *
 * This module only launches the interpreter the caller names. It does not
 * install dependencies, discover a default user directory, or start
 * ScienceFlow itself.
 *
 * The child process writes exactly one JSON object to stdout, and its exit code
 * is part of the contract: 0 means the read completed, 2 means the input was
 * unusable, 1 means another failure. A non-zero exit is never turned into
 * success, and exit 0 with an unparsable or structurally invalid payload is a
 * protocol error rather than a snapshot.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** Snapshot schema version this caller understands. */
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSION = 1;
/** Upper bound for the reader's stdout protocol channel (4 MiB). */
export const MAX_SNAPSHOT_STDOUT_BYTES = 4 * 1024 * 1024;
/** Upper bound for stderr; its content is counted but never returned. */
export const MAX_SNAPSHOT_STDERR_BYTES = 1 * 1024 * 1024;

export interface ScienceFlowSnapshotDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly taskRoot?: string;
}

export interface ScienceFlowTaskSnapshot {
  readonly taskRoot: string | null;
  readonly reportedBestMetric: Readonly<Record<string, unknown>> | null;
  readonly candidateArtifact: Readonly<Record<string, unknown>> | null;
  readonly evidenceReferences: readonly string[];
}

export interface ScienceFlowRunSnapshot {
  readonly schemaVersion: typeof SUPPORTED_SNAPSHOT_SCHEMA_VERSION;
  readonly runId: string | null;
  readonly rawStatus: string | null;
  readonly phase: string | null;
  readonly tasks: readonly ScienceFlowTaskSnapshot[];
  readonly diagnostics: readonly ScienceFlowSnapshotDiagnostic[];
}

export interface ReadScienceFlowRunSnapshotOptions {
  readonly pythonExecutable: string;
  readonly readerScriptPath: string;
  readonly runRecordPath: string;
  readonly allowedTaskRoots: readonly string[];
  readonly timeoutMs: number;
}

export type SnapshotProtocolErrorReason =
  | "invalid-json"
  | "invalid-shape"
  | "unsupported-schema-version";

export type ScienceFlowSnapshotReadResult =
  /** Exit code 0 and a structurally valid snapshot. Diagnostics may still exist. */
  | { readonly status: "ok"; readonly snapshot: ScienceFlowRunSnapshot }
  /** The reader exited non-zero but still printed a valid snapshot with diagnostics. */
  | {
      readonly status: "reader-failed";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly snapshot: ScienceFlowRunSnapshot;
    }
  /** The interpreter could not be started at all. */
  | { readonly status: "spawn-failed"; readonly code: string | null }
  /** The read exceeded the caller's deadline and was killed. */
  | { readonly status: "timeout"; readonly timeoutMs: number }
  /** The child exceeded a stream cap and was killed. */
  | {
      readonly status: "output-limit";
      readonly limitBytes: number;
      readonly stream: "stdout" | "stderr";
    }
  /** Exit status and/or stdout did not satisfy the protocol. */
  | {
      readonly status: "protocol-error";
      readonly reason: SnapshotProtocolErrorReason;
      readonly exitCode: number | null;
    };

/**
 * Run the snapshot CLI once and classify the outcome. The promise settles only
 * after the child has been reaped (or after a spawn error shows there is no
 * child), so a timeout or over-limit read never leaves a process behind.
 */
export {
  checkEngineRevision,
  DEFAULT_REVISION_MAX_OUTPUT_BYTES,
  DEFAULT_REVISION_TIMEOUT_MS,
  parsePorcelain,
  type EngineRevisionCheckOptions,
  type EngineRevisionCheckResult,
  type EngineRevisionReason,
  type EngineRevisionStatus,
} from "./source-revision.js";

export async function readScienceFlowRunSnapshot(
  options: ReadScienceFlowRunSnapshotOptions,
): Promise<ScienceFlowSnapshotReadResult> {
  assertOptions(options);

  return await new Promise<ScienceFlowSnapshotReadResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let exceeded: "stdout" | "stderr" | null = null;
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: ScienceFlowSnapshotReadResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(result);
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        options.pythonExecutable,
        [
          options.readerScriptPath,
          options.runRecordPath,
          ...options.allowedTaskRoots,
        ],
        {
          // Argument arrays only: never let a shell interpret a path.
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      settle({ status: "spawn-failed", code: null });
      return;
    }

    const stop = (): void => {
      if (!child.killed) child.kill("SIGKILL");
    };

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (exceeded !== null) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_SNAPSHOT_STDOUT_BYTES) {
        exceeded = "stdout";
        stop();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (exceeded !== null) return;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > MAX_SNAPSHOT_STDERR_BYTES) {
        exceeded = "stderr";
        stop();
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      // A child that never started has no exit status and no output to judge.
      stop();
      settle({
        status: "spawn-failed",
        code: typeof error.code === "string" ? error.code : null,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        settle({ status: "timeout", timeoutMs: options.timeoutMs });
        return;
      }
      if (exceeded !== null) {
        settle({
          status: "output-limit",
          limitBytes:
            exceeded === "stdout"
              ? MAX_SNAPSHOT_STDOUT_BYTES
              : MAX_SNAPSHOT_STDERR_BYTES,
          stream: exceeded,
        });
        return;
      }

      const parsed = parseSnapshot(stdout);
      if ("reason" in parsed) {
        settle({
          status: "protocol-error",
          reason: parsed.reason,
          exitCode,
        });
        return;
      }
      if (exitCode === 0) {
        settle({ status: "ok", snapshot: parsed.snapshot });
        return;
      }
      settle({
        status: "reader-failed",
        exitCode,
        signal,
        snapshot: parsed.snapshot,
      });
    });
  });
}

function assertOptions(options: ReadScienceFlowRunSnapshotOptions): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  for (const key of [
    "pythonExecutable",
    "readerScriptPath",
    "runRecordPath",
  ] as const) {
    const value = options[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${key} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(options.allowedTaskRoots) ||
    !options.allowedTaskRoots.every(
      (root) => typeof root === "string" && root.length > 0,
    )
  ) {
    throw new TypeError(
      "allowedTaskRoots must be an array of non-empty strings",
    );
  }
  if (
    typeof options.timeoutMs !== "number" ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
}

type ParsedSnapshot =
  | { readonly snapshot: ScienceFlowRunSnapshot }
  | { readonly reason: SnapshotProtocolErrorReason };

function parseSnapshot(raw: string): ParsedSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reason: "invalid-json" };
  }
  if (!isRecord(value)) return { reason: "invalid-shape" };
  if (!("schemaVersion" in value) || typeof value.schemaVersion !== "number") {
    return { reason: "invalid-shape" };
  }
  if (value.schemaVersion !== SUPPORTED_SNAPSHOT_SCHEMA_VERSION) {
    return { reason: "unsupported-schema-version" };
  }
  const snapshot = asSnapshot(value);
  return snapshot === null ? { reason: "invalid-shape" } : { snapshot };
}

function asSnapshot(
  value: Readonly<Record<string, unknown>>,
): ScienceFlowRunSnapshot | null {
  const { runId, rawStatus, phase } = value;
  if (
    !isStringOrNull(runId) ||
    !isStringOrNull(rawStatus) ||
    !isStringOrNull(phase)
  ) {
    return null;
  }

  const tasksValue: unknown = value.tasks;
  if (!Array.isArray(tasksValue)) return null;
  const tasks: ScienceFlowTaskSnapshot[] = [];
  for (const entry of tasksValue) {
    const task = asTask(entry);
    if (task === null) return null;
    tasks.push(task);
  }

  const diagnosticsValue: unknown = value.diagnostics;
  if (!Array.isArray(diagnosticsValue)) return null;
  const diagnostics: ScienceFlowSnapshotDiagnostic[] = [];
  for (const entry of diagnosticsValue) {
    const diagnostic = asDiagnostic(entry);
    if (diagnostic === null) return null;
    diagnostics.push(diagnostic);
  }

  return {
    schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    runId,
    rawStatus,
    phase,
    tasks,
    diagnostics,
  };
}

function asTask(value: unknown): ScienceFlowTaskSnapshot | null {
  if (!isRecord(value)) return null;
  const { taskRoot, reportedBestMetric, candidateArtifact, evidenceReferences } =
    value;
  if (!isStringOrNull(taskRoot)) return null;
  if (!isRecordOrNull(reportedBestMetric)) return null;
  if (!isRecordOrNull(candidateArtifact)) return null;
  if (!isStringArray(evidenceReferences)) return null;
  return {
    taskRoot,
    reportedBestMetric,
    candidateArtifact,
    evidenceReferences,
  };
}

function asDiagnostic(value: unknown): ScienceFlowSnapshotDiagnostic | null {
  if (!isRecord(value)) return null;
  const { code, message, taskRoot } = value;
  if (typeof code !== "string" || typeof message !== "string") return null;
  if (taskRoot !== undefined && typeof taskRoot !== "string") return null;
  return {
    code,
    message,
    ...(typeof taskRoot === "string" ? { taskRoot } : {}),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOrNull(
  value: unknown,
): value is Readonly<Record<string, unknown>> | null {
  return value === null || isRecord(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  );
}
