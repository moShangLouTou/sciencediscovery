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
 * Runner-side trusted bindings for the ScienceFlow runtime identity check.
 *
 * This is the only place a ScienceFlow source path exists. The API names a
 * binding by id; it never learns, supplies, or overrides `sourceRoot`, and a
 * request whose declared revision differs from this file's declaration is
 * refused before any process starts.
 *
 * One environment variable names the JSON file. When it is unset the capability
 * is off and no binding exists. The file is read once at Runner startup; a bad
 * file fails startup instead of silently serving a partial binding table.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Points at the administrator's JSON file; unset means the feature is off. */
export const SCIENCE_FLOW_RUNTIME_BINDING_ENV =
  "SCIENCE_AGENT_SCIENCEFLOW_RUNTIME_BINDING_PATH";
/** The only configuration version this loader accepts. */
export const SCIENCE_FLOW_RUNTIME_BINDING_SCHEMA_VERSION = 1;
/** Bindings are identities and one path; anything larger is not this config. */
export const SCIENCE_FLOW_RUNTIME_BINDING_MAX_BYTES = 64 * 1024;
/** A declared engine revision is a full lowercase git commit id. */
const EXPECTED_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** One administrator-declared checkout and the commit it must be at. */
export interface ScienceFlowRuntimeBinding {
  readonly bindingId: string;
  /** Absolute checkout root on this host; never leaves the Runner. */
  readonly sourceRoot: string;
  readonly expectedRevision: string;
}

/** Validated settings handed to the composition root. */
export interface ScienceFlowRuntimeBindings {
  readonly bindingFor: (bindingId: string) => ScienceFlowRuntimeBinding | undefined;
}

/** A configuration problem. Messages are static: no paths, values, or parse errors. */
function configError(reason: string): Error {
  return new Error(`${SCIENCE_FLOW_RUNTIME_BINDING_ENV}: ${reason}`);
}

/**
 * Load the optional configuration. Throws on any invalid file so the Runner
 * fails to start rather than accepting a probe against a half-read binding.
 */
export function loadScienceFlowRuntimeBindings(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = process.cwd(),
): ScienceFlowRuntimeBindings | undefined {
  const rawPath = env[SCIENCE_FLOW_RUNTIME_BINDING_ENV]?.trim();
  if (!rawPath) return undefined;

  const configPath = resolve(repositoryRoot, rawPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(configPath);
  } catch {
    throw configError("must name a readable file");
  }
  if (!stats.isFile()) throw configError("must name a regular file");
  if (stats.size > SCIENCE_FLOW_RUNTIME_BINDING_MAX_BYTES) {
    throw configError(
      `must not exceed ${SCIENCE_FLOW_RUNTIME_BINDING_MAX_BYTES} bytes`,
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

function parseConfig(value: unknown): ScienceFlowRuntimeBindings {
  if (!isRecord(value)) throw configError("must be a JSON object");
  rejectUnknownKeys(value, ["schemaVersion", "bindings"], "");
  if (value.schemaVersion !== SCIENCE_FLOW_RUNTIME_BINDING_SCHEMA_VERSION) {
    throw configError(
      `schemaVersion must be ${SCIENCE_FLOW_RUNTIME_BINDING_SCHEMA_VERSION}`,
    );
  }
  const byId = parseBindings(value.bindings);
  return Object.freeze({
    bindingFor: (bindingId: string) => byId.get(bindingId),
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
    // A repeated id is ambiguous: refuse the whole file rather than keeping the
    // first or last binding depending on file order.
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
  if (!isRecord(value)) throw configError(`${field} must be an object`);
  rejectUnknownKeys(
    value,
    ["bindingId", "sourceRoot", "expectedRevision"],
    field,
  );
  const bindingId = requireIdentity(value.bindingId, `${field}.bindingId`);
  const sourceRoot = requireAbsolutePath(
    value.sourceRoot,
    `${field}.sourceRoot`,
  );
  // Fail startup when the declared checkout is not a directory that exists now.
  // A checkout removed later is reported by the check as unavailable instead.
  let isDirectory = false;
  try {
    isDirectory = statSync(sourceRoot).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw configError(`${field}.sourceRoot must name an existing directory`);
  }
  const expectedRevision = value.expectedRevision;
  if (
    typeof expectedRevision !== "string" ||
    !EXPECTED_REVISION_PATTERN.test(expectedRevision)
  ) {
    throw configError(
      `${field}.expectedRevision must be a 40-character lowercase hex commit id`,
    );
  }
  return Object.freeze({ bindingId, expectedRevision, sourceRoot });
}

/** Binding ids are opaque; only "usable as a lookup key" is required. */
function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty string`);
  }
  if (value.length > 128) {
    throw configError(`${field} must not exceed 128 characters`);
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
  // A NUL byte cannot name a path; never let it reach a filesystem call.
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
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // The key comes from the file, so the message names only the level.
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
