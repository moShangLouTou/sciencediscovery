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
 * Admin-trusted configuration for the read-only ScienceFlow run endpoint.
 *
 * One environment variable names a JSON file written by the administrator.
 * When it is unset the feature is off: no file is read, no directory is
 * scanned, and no ScienceFlow process is ever started. The file is loaded once
 * at server construction, so changing it needs a restart.
 *
 * The file is deliberately outside the research workspace and none of its
 * values can be supplied by a request, an upload, or an engine record. Every
 * path in it must be absolute; nothing is discovered through PATH or the
 * current directory.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type {
  ScienceFlowReaderConfig,
  ScienceFlowRunBinding,
  ScienceFlowRunQuery,
} from "./run-snapshot.js";

/** Points at the administrator's JSON file; unset means the feature is off. */
export const SCIENCE_FLOW_READER_CONFIG_ENV =
  "SCIENCE_AGENT_SCIENCEFLOW_READER_CONFIG_PATH";
/** The only configuration version this loader accepts. */
export const SCIENCE_FLOW_READER_CONFIG_SCHEMA_VERSION = 1;
/** A binding table is small; anything larger is not a config we understand. */
export const SCIENCE_FLOW_READER_CONFIG_MAX_BYTES = 1024 * 1024;
/**
 * Node stores a timer delay in a signed 32-bit integer and treats larger
 * values as 1 ms. Keep the accepted deadline below that so a configured
 * timeout can never fire immediately instead of waiting.
 */
export const SCIENCE_FLOW_READER_TIMEOUT_MAX_MS = 2_147_483_647;

/** Validated settings handed to the composition root. */
export interface ScienceFlowReaderSettings {
  readonly reader: ScienceFlowReaderConfig;
  /** Exact business-identity lookup; never derived from a request path. */
  readonly bindingFor: (
    query: ScienceFlowRunQuery,
  ) => ScienceFlowRunBinding | undefined;
}

/** A configuration problem. Messages are static: no paths, values, or parse errors. */
function configError(reason: string): Error {
  return new Error(`${SCIENCE_FLOW_READER_CONFIG_ENV}: ${reason}`);
}

/**
 * Load the optional configuration. Throws on any invalid file so the server
 * fails to start rather than serving a partially trusted binding table.
 */
export function loadScienceFlowReaderConfig(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = process.cwd(),
): ScienceFlowReaderSettings | undefined {
  // An unset or blank variable is "disabled", matching the other optional
  // environment switches: it never selects a default directory.
  const rawPath = env[SCIENCE_FLOW_READER_CONFIG_ENV]?.trim();
  if (!rawPath) return undefined;

  // The variable is resolved like the other config paths: relative to the
  // repository root, never the process working directory.
  const configPath = resolve(repositoryRoot, rawPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(configPath);
  } catch {
    throw configError("must name a readable file");
  }
  if (!stats.isFile()) {
    throw configError("must name a regular file");
  }
  if (stats.size > SCIENCE_FLOW_READER_CONFIG_MAX_BYTES) {
    throw configError(
      `must not exceed ${SCIENCE_FLOW_READER_CONFIG_MAX_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw configError("must name a readable file");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError("is not valid JSON");
  }

  return parseConfig(value);
}

function parseConfig(value: unknown): ScienceFlowReaderSettings {
  if (!isRecord(value)) throw configError("must be a JSON object");
  rejectUnknownKeys(value, ["schemaVersion", "reader", "bindings"], "");
  if (value.schemaVersion !== SCIENCE_FLOW_READER_CONFIG_SCHEMA_VERSION) {
    throw configError(
      `schemaVersion must be ${SCIENCE_FLOW_READER_CONFIG_SCHEMA_VERSION}`,
    );
  }
  const reader = parseReader(value.reader);
  const byProject = parseBindings(value.bindings);
  return Object.freeze({
    reader,
    bindingFor: (query: ScienceFlowRunQuery) =>
      byProject.get(query.projectId)?.get(query.sessionId)?.get(query.runId),
  });
}

function parseReader(value: unknown): ScienceFlowReaderConfig {
  if (!isRecord(value)) throw configError("reader must be an object");
  rejectUnknownKeys(
    value,
    ["pythonExecutable", "readerScriptPath", "timeoutMs"],
    "reader",
  );
  const pythonExecutable = requireAbsolutePath(
    value.pythonExecutable,
    "reader.pythonExecutable",
  );
  const readerScriptPath = requireAbsolutePath(
    value.readerScriptPath,
    "reader.readerScriptPath",
  );
  const timeoutMs = value.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > SCIENCE_FLOW_READER_TIMEOUT_MAX_MS
  ) {
    throw configError(
      `reader.timeoutMs must be an integer between 1 and ${SCIENCE_FLOW_READER_TIMEOUT_MAX_MS}`,
    );
  }
  return Object.freeze({ pythonExecutable, readerScriptPath, timeoutMs });
}

type BindingIndex = Map<string, Map<string, Map<string, ScienceFlowRunBinding>>>;

function parseBindings(value: unknown): BindingIndex {
  if (!Array.isArray(value) || value.length === 0) {
    throw configError("bindings must be a non-empty array");
  }
  const byProject: BindingIndex = new Map();
  // An index rather than a value keeps the message free of host paths.
  for (const [index, entry] of value.entries()) {
    const binding = parseBinding(entry, `bindings[${index}]`);
    let bySession = byProject.get(binding.projectId);
    if (!bySession) {
      bySession = new Map();
      byProject.set(binding.projectId, bySession);
    }
    let byRun = bySession.get(binding.sessionId);
    if (!byRun) {
      byRun = new Map();
      bySession.set(binding.sessionId, byRun);
    }
    // A repeated business identity is ambiguous: refuse the whole file rather
    // than letting file order decide which run a request reads.
    if (byRun.has(binding.runId)) {
      throw configError(`bindings[${index}] repeats a bound business identity`);
    }
    byRun.set(binding.runId, binding);
  }
  return byProject;
}

function parseBinding(value: unknown, field: string): ScienceFlowRunBinding {
  if (!isRecord(value)) {
    throw configError(`${field} must be an object`);
  }
  rejectUnknownKeys(
    value,
    [
      "projectId",
      "sessionId",
      "runId",
      "runRecordPath",
      "allowedTaskRoots",
    ],
    field,
  );
  const projectId = requireIdentity(value.projectId, `${field}.projectId`);
  const sessionId = requireIdentity(value.sessionId, `${field}.sessionId`);
  const runId = requireIdentity(value.runId, `${field}.runId`);
  const runRecordPath = requireAbsolutePath(
    value.runRecordPath,
    `${field}.runRecordPath`,
  );
  const roots: unknown = value.allowedTaskRoots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw configError(`${field}.allowedTaskRoots must be a non-empty array`);
  }
  const allowedTaskRoots = roots.map((root, index) =>
    requireAbsolutePath(root, `${field}.allowedTaskRoots[${index}]`),
  );
  return Object.freeze({
    projectId,
    sessionId,
    runId,
    runRecordPath,
    allowedTaskRoots: Object.freeze(allowedTaskRoots),
  });
}

/** Business ids are opaque; only "usable as a lookup key" is required. */
function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw configError(`${field} must not contain NUL`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty absolute path`);
  }
  // A NUL byte cannot name a path; never let it reach spawn or the reader.
  if (value.includes("\0") || !isAbsolute(value)) {
    throw configError(`${field} must be an absolute path`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  const prefix = field ? `${field}.` : "";
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw configError(`${prefix}${key} is not a supported key`);
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
