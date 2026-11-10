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
 * Admin-trusted execution profiles for ScienceFlow execution plans.
 *
 * This is a separate, optional file from the reader configuration: a server may
 * serve plans, only existing-run snapshots, or neither. One environment variable
 * names the JSON file; when it is unset the capability is off and no profile is
 * read. The file is loaded once at server construction, so changing it needs a
 * restart.
 *
 * A profile selects files; it never authorizes execution. It carries no model
 * credential, no shell command, and no budget override. Every path is absolute
 * and comes only from the administrator; a request, an upload, or a manifest
 * reference can never supply or widen one.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Points at the administrator's JSON file; unset means the feature is off. */
export const SCIENCE_FLOW_EXECUTION_CONFIG_ENV =
  "SCIENCE_AGENT_SCIENCEFLOW_EXECUTION_CONFIG_PATH";
/** The only configuration version this loader accepts. */
export const SCIENCE_FLOW_EXECUTION_CONFIG_SCHEMA_VERSION = 1;
/** Profiles name files and roots; anything larger is not a config we understand. */
export const SCIENCE_FLOW_EXECUTION_CONFIG_MAX_BYTES = 1024 * 1024;
/** A declared engine revision is a full lowercase git commit id. */
const DECLARED_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** One administrator-selected task package and manifest. */
export interface ScienceFlowExecutionProfile {
  readonly profileId: string;
  /** Frozen engine revision as declared; not proof of an installed revision. */
  readonly scienceFlowRevision: string;
  readonly manifestPath: string;
  /** The task package directory that owns `task.yaml`. */
  readonly taskPackageRoot: string;
  /** Every file the static check reads must resolve inside one of these roots. */
  readonly allowedReadRoots: readonly string[];
}

/** Validated settings handed to the composition root. */
export interface ScienceFlowExecutionSettings {
  /** Exact profile lookup; never derived from a request path or a manifest. */
  readonly profileFor: (
    profileId: string,
  ) => ScienceFlowExecutionProfile | undefined;
}

/** A configuration problem. Messages are static: no paths, values, or parse errors. */
function configError(reason: string): Error {
  return new Error(`${SCIENCE_FLOW_EXECUTION_CONFIG_ENV}: ${reason}`);
}

/**
 * Load the optional configuration. Throws on any invalid file so the server
 * fails to start rather than serving a partially trusted profile table.
 */
export function loadScienceFlowExecutionConfig(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = process.cwd(),
): ScienceFlowExecutionSettings | undefined {
  // An unset or blank variable is "disabled", matching the other optional
  // environment switches: it never selects a default directory.
  const rawPath = env[SCIENCE_FLOW_EXECUTION_CONFIG_ENV]?.trim();
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
  if (stats.size > SCIENCE_FLOW_EXECUTION_CONFIG_MAX_BYTES) {
    throw configError(
      `must not exceed ${SCIENCE_FLOW_EXECUTION_CONFIG_MAX_BYTES} bytes`,
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

function parseConfig(value: unknown): ScienceFlowExecutionSettings {
  if (!isRecord(value)) throw configError("must be a JSON object");
  rejectUnknownKeys(value, ["schemaVersion", "profiles"], "");
  if (value.schemaVersion !== SCIENCE_FLOW_EXECUTION_CONFIG_SCHEMA_VERSION) {
    throw configError(
      `schemaVersion must be ${SCIENCE_FLOW_EXECUTION_CONFIG_SCHEMA_VERSION}`,
    );
  }
  const byId = parseProfiles(value.profiles);
  return Object.freeze({
    profileFor: (profileId: string) => byId.get(profileId),
  });
}

function parseProfiles(
  value: unknown,
): ReadonlyMap<string, ScienceFlowExecutionProfile> {
  if (!Array.isArray(value) || value.length === 0) {
    throw configError("profiles must be a non-empty array");
  }
  const byId = new Map<string, ScienceFlowExecutionProfile>();
  // An index rather than a value keeps the message free of configured content.
  for (const [index, entry] of value.entries()) {
    const profile = parseProfile(entry, `profiles[${index}]`);
    // A repeated profile id is ambiguous: refuse the whole file rather than
    // letting file order decide which files a plan is frozen from.
    if (byId.has(profile.profileId)) {
      throw configError(`profiles[${index}] repeats a profile id`);
    }
    byId.set(profile.profileId, profile);
  }
  return byId;
}

function parseProfile(
  value: unknown,
  field: string,
): ScienceFlowExecutionProfile {
  if (!isRecord(value)) {
    throw configError(`${field} must be an object`);
  }
  rejectUnknownKeys(
    value,
    [
      "profileId",
      "scienceFlowRevision",
      "manifestPath",
      "taskPackageRoot",
      "allowedReadRoots",
    ],
    field,
  );
  const profileId = requireIdentity(value.profileId, `${field}.profileId`);
  const declared = value.scienceFlowRevision;
  if (typeof declared !== "string" || !DECLARED_REVISION_PATTERN.test(declared)) {
    throw configError(
      `${field}.scienceFlowRevision must be a 40-character lowercase hex commit id`,
    );
  }
  const manifestPath = requireAbsolutePath(
    value.manifestPath,
    `${field}.manifestPath`,
  );
  const taskPackageRoot = requireAbsolutePath(
    value.taskPackageRoot,
    `${field}.taskPackageRoot`,
  );
  const roots: unknown = value.allowedReadRoots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw configError(`${field}.allowedReadRoots must be a non-empty array`);
  }
  const allowedReadRoots = roots.map((root, index) =>
    requireAbsolutePath(root, `${field}.allowedReadRoots[${index}]`),
  );
  return Object.freeze({
    profileId,
    scienceFlowRevision: declared,
    manifestPath,
    taskPackageRoot,
    allowedReadRoots: Object.freeze(allowedReadRoots),
  });
}

/** Profile ids are opaque; only "usable as a lookup key" is required. */
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
