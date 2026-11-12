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
 * Admin-trusted runtime bindings for the ScienceFlow identity check.
 *
 * One optional JSON file, named by one environment variable, maps an execution
 * profile's `runtimeBindingId` to the Runner that owns the selected environment.
 * It carries identities only: the environment id, its expected revision, and
 * the Runner-side binding id. A Runner host path never appears here and never
 * reaches the API.
 *
 * The file is loaded once at server construction. Any invalid entry fails the
 * whole load, so the server starts with the full table or not at all. Nothing
 * in a request, a plan, or a manifest can add or change a binding.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Points at the administrator's JSON file; unset means the feature is off. */
export const SCIENCE_FLOW_RUNTIME_CONFIG_ENV =
  "SCIENCE_AGENT_SCIENCEFLOW_RUNTIME_CONFIG_PATH";
/** The only configuration version this loader accepts. */
export const SCIENCE_FLOW_RUNTIME_CONFIG_SCHEMA_VERSION = 1;
/** The file holds identities only; anything larger is not a config we understand. */
export const SCIENCE_FLOW_RUNTIME_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * Bound on one API-to-Runner check. The Runner's own probe is bounded at 10 s
 * (30 s maximum); the transport bound sits above it so a slow probe is reported
 * as unavailable instead of hanging the request.
 */
export const SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS = 20_000;
export const SCIENCE_FLOW_RUNTIME_CHECK_MIN_TIMEOUT_MS = 1_000;
export const SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS = 60_000;

/** The Runner-side request parser caps every identity it receives at 160. */
const RUNNER_IDENTITY_MAX_LENGTH = 160;
/** The API's own opaque ids are planned with the same practical bound. */
const API_IDENTITY_MAX_LENGTH = 200;

/**
 * One profile-to-Runner mapping. `runnerBindingId` names the binding in the
 * Runner's own configuration; `sourceRoot` exists only there.
 */
export interface ScienceFlowRuntimeBinding {
  readonly bindingId: string;
  readonly runnerId: string;
  readonly runnerBindingId: string;
  readonly environmentId: string;
  readonly expectedEnvironmentRevisionId: string;
  /** Transport bound for one check; resolved from the file's optional value. */
  readonly timeoutMs: number;
}

/** Validated settings handed to the composition root. */
export interface ScienceFlowRuntimeSettings {
  /** Exact lookup; never derived from a request path or a plan. */
  readonly bindingFor: (
    bindingId: string,
  ) => ScienceFlowRuntimeBinding | undefined;
  readonly has: (bindingId: string) => boolean;
}

/** A configuration problem. Messages are static: no ids, paths, or values. */
function configError(reason: string): Error {
  return new Error(`${SCIENCE_FLOW_RUNTIME_CONFIG_ENV}: ${reason}`);
}

/**
 * Load the optional configuration. Throws on any invalid file so the server
 * fails to start rather than serving a partially trusted binding table.
 */
export function loadScienceFlowRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = process.cwd(),
): ScienceFlowRuntimeSettings | undefined {
  // An unset or blank variable is "disabled", matching the other optional
  // switches: it never selects a default file or binding.
  const rawPath = env[SCIENCE_FLOW_RUNTIME_CONFIG_ENV]?.trim();
  if (!rawPath) return undefined;

  // Resolved like the other config paths: relative to the repository root,
  // never the process working directory.
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
  if (stats.size > SCIENCE_FLOW_RUNTIME_CONFIG_MAX_BYTES) {
    throw configError(
      `must not exceed ${SCIENCE_FLOW_RUNTIME_CONFIG_MAX_BYTES} bytes`,
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

function parseConfig(value: unknown): ScienceFlowRuntimeSettings {
  if (!isRecord(value)) throw configError("must be a JSON object");
  rejectUnknownKeys(value, ["schemaVersion", "bindings"], "");
  if (value.schemaVersion !== SCIENCE_FLOW_RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw configError(
      `schemaVersion must be ${SCIENCE_FLOW_RUNTIME_CONFIG_SCHEMA_VERSION}`,
    );
  }
  const byId = parseBindings(value.bindings);
  return Object.freeze({
    bindingFor: (bindingId: string) => byId.get(bindingId),
    has: (bindingId: string) => byId.has(bindingId),
  });
}

function parseBindings(
  value: unknown,
): ReadonlyMap<string, ScienceFlowRuntimeBinding> {
  if (!Array.isArray(value) || value.length === 0) {
    throw configError("bindings must be a non-empty array");
  }
  const byId = new Map<string, ScienceFlowRuntimeBinding>();
  // An index rather than a value keeps the message free of configured content.
  for (const [index, entry] of value.entries()) {
    const binding = parseBinding(entry, `bindings[${index}]`);
    // A repeated binding id is ambiguous: refuse the whole file rather than
    // letting file order decide which Runner one profile means.
    if (byId.has(binding.bindingId)) {
      throw configError(`bindings[${index}] repeats a binding id`);
    }
    byId.set(binding.bindingId, binding);
  }
  return byId;
}

function parseBinding(
  value: unknown,
  field: string,
): ScienceFlowRuntimeBinding {
  if (!isRecord(value)) {
    throw configError(`${field} must be an object`);
  }
  rejectUnknownKeys(
    value,
    [
      "bindingId",
      "runnerId",
      "runnerBindingId",
      "environmentId",
      "expectedEnvironmentRevisionId",
      "timeoutMs",
    ],
    field,
  );
  const bindingId = requireIdentity(
    value.bindingId,
    `${field}.bindingId`,
    API_IDENTITY_MAX_LENGTH,
  );
  const runnerId = requireIdentity(
    value.runnerId,
    `${field}.runnerId`,
    API_IDENTITY_MAX_LENGTH,
  );
  // Every identity that crosses to the Runner must fit its parser's bound.
  const runnerBindingId = requireIdentity(
    value.runnerBindingId,
    `${field}.runnerBindingId`,
    RUNNER_IDENTITY_MAX_LENGTH,
  );
  const environmentId = requireIdentity(
    value.environmentId,
    `${field}.environmentId`,
    RUNNER_IDENTITY_MAX_LENGTH,
  );
  const expectedEnvironmentRevisionId = requireIdentity(
    value.expectedEnvironmentRevisionId,
    `${field}.expectedEnvironmentRevisionId`,
    RUNNER_IDENTITY_MAX_LENGTH,
  );
  const timeoutMs = parseTimeout(value.timeoutMs, `${field}.timeoutMs`);
  return Object.freeze({
    bindingId,
    runnerId,
    runnerBindingId,
    environmentId,
    expectedEnvironmentRevisionId,
    timeoutMs,
  });
}

function parseTimeout(value: unknown, field: string): number {
  if (value === undefined) {
    return SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < SCIENCE_FLOW_RUNTIME_CHECK_MIN_TIMEOUT_MS ||
    value > SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS
  ) {
    throw configError(
      `${field} must be an integer between ${SCIENCE_FLOW_RUNTIME_CHECK_MIN_TIMEOUT_MS} and ${SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** Bindings are opaque keys; only "usable as a lookup key" is required. */
function requireIdentity(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw configError(`${field} must not exceed ${maxLength} characters`);
  }
  if (value.includes("\0")) {
    throw configError(`${field} must not contain NUL`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // The key comes from the file, so the message names only the level: a
      // typo stays locatable without echoing configured content.
      throw configError(
        field
          ? `${field} has an unsupported key`
          : "the file has an unsupported key",
      );
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
