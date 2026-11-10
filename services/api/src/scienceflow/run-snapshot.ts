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
 * Read-only server-side access to one ScienceFlow managed run.
 *
 * A request carries business identity only. Host paths, the interpreter, and
 * the deadline come from trusted server-side dependencies, so a request can
 * never point the reader at an arbitrary directory. The module is not wired
 * into the HTTP entry point: a future route must call it after the existing
 * authentication and must project the snapshot through a field allow-list.
 */
import {
  readScienceFlowRunSnapshot,
  type ReadScienceFlowRunSnapshotOptions,
  type ScienceFlowRunSnapshot,
  type ScienceFlowSnapshotReadResult,
  type SnapshotProtocolErrorReason,
} from "@sciencediscovery/scienceflow-reader";

/** Business identity. `runId` is a ScienceFlow managed-run id, not a host path. */
export interface ScienceFlowRunQuery {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
}

/** Trusted reader settings supplied by the server composition root. */
export interface ScienceFlowReaderConfig {
  readonly pythonExecutable: string;
  readonly readerScriptPath: string;
  readonly timeoutMs: number;
}

/** One business identity bound to the run record and task roots it may read. */
export interface ScienceFlowRunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly runRecordPath: string;
  readonly allowedTaskRoots: readonly string[];
}

/** Minimal read-only view of the identity store this module depends on. */
export interface ScienceFlowIdentityStore {
  getProject(projectId: string): { readonly id: string } | undefined;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
}

/**
 * Trusted binding lookup. It resolves host paths from server state; the query
 * never supplies them. Returning a binding for another identity is rejected by
 * the caller below.
 */
export interface ScienceFlowRunBindingResolver {
  (
    query: ScienceFlowRunQuery,
  ): ScienceFlowRunBinding | undefined | Promise<ScienceFlowRunBinding | undefined>;
}

/** The reader invocation, injectable so tests never spawn an interpreter. */
export type ScienceFlowSnapshotReader = (
  options: ReadScienceFlowRunSnapshotOptions,
) => Promise<ScienceFlowSnapshotReadResult>;

export interface ScienceFlowRunSnapshotQueryDependencies {
  readonly identities: ScienceFlowIdentityStore;
  readonly resolveBinding: ScienceFlowRunBindingResolver;
  readonly readerConfig: ScienceFlowReaderConfig;
  /** Defaults to the real CLI invocation; tests substitute a stub. */
  readonly readSnapshot?: ScienceFlowSnapshotReader;
}

/**
 * Result of one query. Statuses are structural: callers branch on `status`
 * and `reason`, never on message text. No variant carries exception messages,
 * stderr, or the trusted configuration object.
 */
export type ScienceFlowRunSnapshotQueryResult =
  /** Exit code 0, structurally valid, and the snapshot names the requested run. */
  | { readonly status: "ok"; readonly snapshot: ScienceFlowRunSnapshot }
  /** The identity or its binding does not exist. */
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "binding";
    }
  /** Input or trusted dependencies are unusable; the reader was not called. */
  | {
      readonly status: "invalid";
      readonly reason: "query" | "configuration" | "binding";
    }
  /** The reader read a different run than the binding names. */
  | { readonly status: "run-mismatch" }
  /** The reader exited non-zero but printed a valid snapshot for the same run. */
  | {
      readonly status: "reader-failed";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly snapshot: ScienceFlowRunSnapshot;
    }
  /** The interpreter could not be started. */
  | { readonly status: "spawn-failed"; readonly code: string | null }
  /** The read exceeded the configured deadline and was killed. */
  | { readonly status: "timeout"; readonly timeoutMs: number }
  /** The reader exceeded a protocol stream cap and was killed. */
  | {
      readonly status: "output-limit";
      readonly limitBytes: number;
      readonly stream: "stdout" | "stderr";
    }
  /** Exit status and/or stdout did not satisfy the reader protocol. */
  | {
      readonly status: "protocol-error";
      readonly reason: SnapshotProtocolErrorReason;
      readonly exitCode: number | null;
    }
  /** A trusted dependency threw; details stay server-side. */
  | { readonly status: "internal-error" };

/**
 * Build a query function from trusted dependencies. Every call re-reads the
 * identity, the binding, and the run: there is no cache, retry, or write.
 */
export function createScienceFlowRunSnapshotQuery(
  dependencies: ScienceFlowRunSnapshotQueryDependencies,
): (query: ScienceFlowRunQuery) => Promise<ScienceFlowRunSnapshotQueryResult> {
  return async (query) => {
    try {
      return await queryRunSnapshot(dependencies, query);
    } catch {
      // A trusted dependency (store, resolver, or injected reader) threw.
      // Its message, stack, and any stderr content stay out of the result.
      return { status: "internal-error" };
    }
  };
}

async function queryRunSnapshot(
  dependencies: ScienceFlowRunSnapshotQueryDependencies,
  query: ScienceFlowRunQuery,
): Promise<ScienceFlowRunSnapshotQueryResult> {
  if (!isRunQuery(query)) return { status: "invalid", reason: "query" };
  if (!isReaderConfig(dependencies.readerConfig)) {
    return { status: "invalid", reason: "configuration" };
  }

  const project = dependencies.identities.getProject(query.projectId);
  if (!project) return { status: "not-found", resource: "project" };
  const session = dependencies.identities.getSession(query.sessionId);
  // A session in another Project is reported exactly like a missing one: the
  // caller learns that the run is not in this Project, nothing about the other.
  if (!session || session.projectId !== query.projectId) {
    return { status: "not-found", resource: "session" };
  }

  const binding = await dependencies.resolveBinding(query);
  if (binding === undefined) return { status: "not-found", resource: "binding" };
  if (!bindingMatchesQuery(binding, query)) {
    return { status: "invalid", reason: "binding" };
  }

  const config = dependencies.readerConfig;
  const read = dependencies.readSnapshot ?? readScienceFlowRunSnapshot;
  const outcome = await read({
    pythonExecutable: config.pythonExecutable,
    readerScriptPath: config.readerScriptPath,
    runRecordPath: binding.runRecordPath,
    allowedTaskRoots: binding.allowedTaskRoots,
    timeoutMs: config.timeoutMs,
  });

  return projectOutcome(outcome, binding.runId);
}

function projectOutcome(
  outcome: ScienceFlowSnapshotReadResult,
  runId: string,
): ScienceFlowRunSnapshotQueryResult {
  switch (outcome.status) {
    case "ok":
      return outcome.snapshot.runId === runId
        ? { status: "ok", snapshot: outcome.snapshot }
        : { status: "run-mismatch" };
    case "reader-failed":
      // A non-zero exit stays a failure even when the payload is valid JSON.
      // Only a snapshot that names the requested run may travel with it.
      return outcome.snapshot.runId === runId
        ? {
            status: "reader-failed",
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            snapshot: outcome.snapshot,
          }
        : { status: "run-mismatch" };
    case "spawn-failed":
      return { status: "spawn-failed", code: outcome.code };
    case "timeout":
      return { status: "timeout", timeoutMs: outcome.timeoutMs };
    case "output-limit":
      return {
        status: "output-limit",
        limitBytes: outcome.limitBytes,
        stream: outcome.stream,
      };
    case "protocol-error":
      return {
        status: "protocol-error",
        reason: outcome.reason,
        exitCode: outcome.exitCode,
      };
    default:
      // An injected reader that does not follow the contract is a dependency
      // failure, not a snapshot.
      return { status: "internal-error" };
  }
}

function isRunQuery(value: unknown): value is ScienceFlowRunQuery {
  if (!isRecord(value)) return false;
  const { projectId, sessionId, runId } = value;
  return (
    isNonEmptyString(projectId) &&
    isNonEmptyString(sessionId) &&
    isNonEmptyString(runId)
  );
}

function isReaderConfig(value: unknown): value is ScienceFlowReaderConfig {
  if (!isRecord(value)) return false;
  const { pythonExecutable, readerScriptPath, timeoutMs } = value;
  return (
    isNonEmptyString(pythonExecutable) &&
    isNonEmptyString(readerScriptPath) &&
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  );
}

function bindingMatchesQuery(
  binding: unknown,
  query: ScienceFlowRunQuery,
): boolean {
  if (!isRecord(binding)) return false;
  const { projectId, sessionId, runId, runRecordPath, allowedTaskRoots } =
    binding;
  if (
    projectId !== query.projectId ||
    sessionId !== query.sessionId ||
    runId !== query.runId
  ) {
    return false;
  }
  if (!isNonEmptyString(runRecordPath)) return false;
  return (
    Array.isArray(allowedTaskRoots) &&
    allowedTaskRoots.length > 0 &&
    allowedTaskRoots.every(isNonEmptyString)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
