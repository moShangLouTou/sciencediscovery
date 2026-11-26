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
 * Static contract extraction for a ScienceFlow execution plan.
 *
 * This module reads exactly the administrator-selected manifest, the task
 * package's `task.yaml` (merged with the sibling `_shared/task_defaults.yaml`
 * when present), the description and the evaluator entrypoint file. It never
 * imports or executes Python, never starts the engine, and never calls
 * `start_run`: the engine's own start path creates control records, claims
 * resources, and launches a supervisor, so it is not a validation tool.
 *
 * The supported manifest subset is a single `lnr` task with no external config
 * include, no inline task text, no model-gateway settings, and no resume. Any
 * other form is reported as `unsupported` rather than being silently ignored.
 *
 * Every read is bounded by the administrator's allowed roots and a size limit.
 * YAML is parsed with the `core` schema, duplicate keys refused, and alias
 * expansion capped. All emitted descriptions are fixed strings: no host path,
 * raw YAML, or exception message leaves this module.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseDocument } from "yaml";

import type {
  ScienceFlowExecutionBlockerCode,
  ScienceFlowExecutionPlanContractDto,
  ScienceFlowExecutionBudgetDto,
  ScienceFlowInputFileRole,
  ScienceFlowPlanBlockerDto,
  ScienceFlowPlanCheckCode,
  ScienceFlowPlanCheckDto,
  ScienceFlowPlanCheckStatus,
  ScienceFlowWorkspaceSource,
} from "@sciencediscovery/schema";
import {
  SCIENCE_FLOW_EXECUTION_BLOCKER_CODES,
  SCIENCE_FLOW_PLAN_CHECK_CODES,
} from "@sciencediscovery/schema";

import type { ScienceFlowExecutionProfile } from "./execution-config.js";

/** Structured contract files are small by nature; anything larger is refused. */
export const SCIENCE_FLOW_EXECUTION_STRUCTURED_FILE_MAX_BYTES = 256 * 1024;
/** An evaluator source file is hashed; keep a bound so one file cannot stall a request. */
export const SCIENCE_FLOW_EXECUTION_SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** YAML alias expansion cap: refuse a document that multiplies itself. */
export const SCIENCE_FLOW_EXECUTION_MAX_ALIASES = 100;

/** Result of one extraction attempt. */
export type ScienceFlowContractBuildResult =
  /**
   * The contract is complete and every structural check passed or is
   * `unknown`. `files` are the private bytes the contract was computed from:
   * the same `Buffer` that produced each role's digest, never a re-read.
   */
  | {
      readonly status: "ok";
      readonly contract: ScienceFlowExecutionPlanContractDto;
      readonly checks: readonly ScienceFlowPlanCheckDto[];
      readonly files: readonly ScienceFlowContractFile[];
    }
  /** The source files are missing, malformed, or use an unsupported form. */
  | { readonly status: "rejected"; readonly checks: readonly ScienceFlowPlanCheckDto[] }
  /** An I/O failure prevented a verdict; it is never reported as a blocked check. */
  | { readonly status: "internal" };

/**
 * One contract role and the exact bytes it was computed from. This is server
 * state: the bytes never enter a plan DTO, a stored contract, or a response.
 */
export interface ScienceFlowContractFile {
  readonly role: ScienceFlowInputFileRole;
  /** Logical bundle-relative label; never a host path. */
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Logical bundle labels for files whose host location is not the package tree.
 * Package files are labelled `package/<contract-relative path>` below.
 */
export const SCIENCE_FLOW_INPUT_LOGICAL_PATHS = Object.freeze({
  manifest: "manifest.yaml",
  taskYaml: "package/task.yaml",
  sharedDefaults: "package/_shared/task_defaults.yaml",
});

/** Injectable so a test can pause the check while a Session changes underneath. */
export type ScienceFlowContractBuilder = (
  profile: ScienceFlowExecutionProfile,
) => Promise<ScienceFlowContractBuildResult>;

/** Build a builder bound to the real filesystem. It has no cache and no write. */
export function createScienceFlowContractBuilder(): ScienceFlowContractBuilder {
  return async (profile) => {
    try {
      return evaluateProfile(profile);
    } catch {
      // A filesystem call threw something we did not classify. Its message and
      // stack stay server-side; the caller reports an internal failure.
      return { status: "internal" };
    }
  };
}

/** Canonical JSON: object keys sorted recursively, arrays preserved. */
export function canonicalScienceFlowContract(
  contract: ScienceFlowExecutionPlanContractDto,
): string {
  return JSON.stringify(canonicalValue(contract));
}

/** SHA-256 of the canonical contract. Deterministic across runs and hosts. */
export function digestScienceFlowContract(
  contract: ScienceFlowExecutionPlanContractDto,
): string {
  return sha256(Buffer.from(canonicalScienceFlowContract(contract), "utf8"));
}

/**
 * Merge provider-family defaults with a task file the way the engine does:
 * nested mappings merge recursively and the task wins on a leaf.
 */
export function mergeTaskPackageDefaults(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeTaskPackageDefaults(current, value)
        : value;
  }
  return merged;
}

// --- fixed descriptions ----------------------------------------------------

/** Neutral condition descriptions; a `failed` status means the condition did not hold. */
const CHECK_DESCRIPTIONS = {
  manifest_readable: "The manifest file is readable.",
  manifest_encoding: "The manifest is valid UTF-8 text.",
  manifest_size: "The manifest is within the size limit.",
  manifest_yaml: "The manifest is valid YAML.",
  manifest_duplicate_key: "The manifest does not repeat a key.",
  manifest_alias_limit: "The manifest stays within the alias expansion limit.",
  manifest_shape: "The manifest has the supported single-task shape.",
  manifest_key: "The manifest uses only supported keys.",
  manifest_multiple_tasks: "The manifest declares exactly one task.",
  manifest_max_concurrent: "The manifest requests at most one concurrent task.",
  manifest_phase: "The manifest selects the run phase.",
  manifest_type: "The manifest selects the lnr task type.",
  manifest_resume: "The manifest does not request resume behaviour.",
  manifest_config_include:
    "The manifest does not include an external configuration file.",
  manifest_task_text:
    "The manifest does not supply task text outside the task package.",
  manifest_model_gateway:
    "The manifest does not configure a model gateway or credentials.",
  manifest_evaluator: "The manifest selects the task-package evaluator.",
  manifest_budget: "Every declared budget is a positive finite number.",
  manifest_workspace: "The manifest names a non-empty task workspace source.",
  task_yaml_readable: "The task package task.yaml is readable.",
  task_yaml_encoding: "The task package task.yaml is valid UTF-8 text.",
  task_yaml_size: "The task package task.yaml is within the size limit.",
  task_yaml_yaml: "The task package task.yaml is valid YAML.",
  task_yaml_duplicate_key: "The task package task.yaml does not repeat a key.",
  task_yaml_alias_limit:
    "The task package task.yaml stays within the alias expansion limit.",
  task_yaml_shape: "The task package task.yaml has the supported shape.",
  task_yaml_key: "The task package task.yaml uses only supported keys.",
  shared_defaults: "The shared task defaults are readable and valid.",
  task_identity: "The task id matches the manifest exp_id.",
  task_metric: "The metric name and direction are declared.",
  task_artifact: "The artifact path is package-relative and supported.",
  evaluator_entrypoint:
    "The evaluator entrypoint is a package path and function reference.",
  evaluator_file: "The evaluator entrypoint file exists inside the task package.",
  description_reference:
    "The description reference is a supported package-relative path.",
  description_file: "The description file exists inside the task package.",
  path_allowed_roots:
    "Every referenced path resolves inside the administrator's allowed roots.",
  path_traversal: "No referenced path is absolute or escapes its package.",
  dataset_identity: "The task package declares no external dataset.",
  execution_environment: "The execution environment is not verified.",
  pricing: "Execution pricing is not verified.",
  model_gateway: "No model gateway is configured or verified for execution.",
  scienceflow_revision:
    "The declared ScienceFlow revision is not verified against an installation.",
  dependency_closure:
    "Only the supported entry, description, and contract files are pinned.",
  contract_changed: "The current profile or source files match the frozen contract.",
} satisfies Record<ScienceFlowPlanCheckCode, string>;

/** Status-specific notes for the few conditions whose wording really changes. */
const CHECK_STATUS_DESCRIPTIONS: Partial<
  Record<
    ScienceFlowPlanCheckCode,
    Partial<Record<ScienceFlowPlanCheckStatus, string>>
  >
> = {
  dataset_identity: {
    unknown:
      "The task package references an external dataset whose identity is not verified.",
  },
  manifest_workspace: {
    failed:
      "No non-blank `workspace` or `workspace_base` is declared for the task.",
    unsupported:
      "The declared workspace or workspace base is not a plain non-blank string.",
  },
  contract_changed: {
    failed: "The current profile or source files no longer match the frozen contract.",
  },
};

const BLOCKER_DESCRIPTIONS = {
  execution_backend_not_connected:
    "No ScienceFlow execution backend is connected.",
  model_gateway_not_configured:
    "No model gateway is configured for execution.",
  budget_enforcement_not_implemented:
    "Requested budgets are declarative and are not enforced.",
  process_cancellation_not_implemented:
    "Descendant process cancellation is not implemented.",
  scienceflow_revision_unverified:
    "The declared ScienceFlow revision has not been verified against an installation.",
} satisfies Record<ScienceFlowExecutionBlockerCode, string>;

/**
 * Fixed reasons execution is unavailable. Computed once and never configured.
 * Declared after the description table so module initialization has a value.
 */
export const SCIENCE_FLOW_EXECUTION_BLOCKERS: readonly ScienceFlowPlanBlockerDto[] =
  Object.freeze(
    SCIENCE_FLOW_EXECUTION_BLOCKER_CODES.map((code) =>
      Object.freeze({ code, description: BLOCKER_DESCRIPTIONS[code] }),
    ),
  );

// --- check collector -------------------------------------------------------

class CheckCollector {
  private readonly statuses = new Map<
    ScienceFlowPlanCheckCode,
    ScienceFlowPlanCheckStatus
  >();

  /** Record a condition once; a later `fail`/`override` always wins. */
  add(
    code: ScienceFlowPlanCheckCode,
    status: ScienceFlowPlanCheckStatus = "passed",
  ): void {
    if (!this.statuses.has(code)) this.statuses.set(code, status);
  }

  override(
    code: ScienceFlowPlanCheckCode,
    status: ScienceFlowPlanCheckStatus,
  ): void {
    this.statuses.set(code, status);
  }

  has(code: ScienceFlowPlanCheckCode): boolean {
    return this.statuses.has(code);
  }

  status(code: ScienceFlowPlanCheckCode): ScienceFlowPlanCheckStatus | undefined {
    return this.statuses.get(code);
  }

  /** Any failed or unsupported check makes the extracted contract unusable. */
  blocked(): boolean {
    for (const status of this.statuses.values()) {
      if (status === "failed" || status === "unsupported") return true;
    }
    return false;
  }

  /** Canonical order, so two equivalent runs produce the same response order. */
  list(): readonly ScienceFlowPlanCheckDto[] {
    return SCIENCE_FLOW_PLAN_CHECK_CODES.filter((code) =>
      this.statuses.has(code),
    ).map((code) => {
      const status = this.statuses.get(code) as ScienceFlowPlanCheckStatus;
      return {
        code,
        status,
        description: describeScienceFlowCheck(code, status),
      };
    });
  }
}

/**
 * The fixed description for one check. Stored preflights keep only code and
 * status, so a read rebuilds this text instead of trusting stored prose.
 */
export function describeScienceFlowCheck(
  code: ScienceFlowPlanCheckCode,
  status: ScienceFlowPlanCheckStatus,
): string {
  return CHECK_STATUS_DESCRIPTIONS[code]?.[status] ?? CHECK_DESCRIPTIONS[code];
}

// --- filesystem helpers ----------------------------------------------------

type FileRead =
  | { readonly status: "ok"; readonly bytes: Buffer; readonly sha256: string }
  | { readonly status: "missing" | "too-large" | "unreadable" };

function readFileBounded(path: string, maxBytes: number): FileRead {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    return { status: isMissing(error) ? "missing" : "unreadable" };
  }
  if (!stats.isFile()) return { status: "missing" };
  if (stats.size > maxBytes) return { status: "too-large" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { status: "unreadable" };
  }
  return { status: "ok", bytes, sha256: sha256(bytes) };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function prepareDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function resolveFile(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** True when `child` equals `parent` or sits below it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

/** Decode strict UTF-8; null when the bytes are not text. */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type YamlOutcome =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "duplicate" | "alias" | "invalid" };

function parseYaml(text: string): YamlOutcome {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, {
      uniqueKeys: true,
      prettyErrors: false,
      version: "1.2",
    });
  } catch {
    return { status: "invalid" };
  }
  if (document.errors.length > 0) {
    return {
      status: document.errors.some((error) => error.code === "DUPLICATE_KEY")
        ? "duplicate"
        : "invalid",
    };
  }
  let value: unknown;
  try {
    value = document.toJS({
      maxAliasCount: SCIENCE_FLOW_EXECUTION_MAX_ALIASES,
    });
  } catch {
    // The parser throws once alias expansion exceeds the cap; the thrown
    // message stays here, and the caller sees a fixed code.
    return { status: "alias" };
  }
  return { status: "ok", value };
}

type ReferenceOutcome =
  | { readonly status: "ok"; readonly relativePath: string }
  | { readonly status: "rejected" };

/**
 * Normalize a package-relative reference. Absolute paths, Windows drive paths,
 * NUL, and any `..` segment are refused. `.` and empty segments are dropped.
 */
function normalizePackageReference(raw: string): ReferenceOutcome {
  const text = raw.trim();
  if (!text || text.includes("\0")) return { status: "rejected" };
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    return { status: "rejected" };
  }
  const unified = text.replaceAll("\\", "/");
  if (unified.startsWith("/")) return { status: "rejected" };
  const parts = unified.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    return { status: "rejected" };
  }
  return { status: "ok", relativePath: parts.join("/") };
}

// --- manifest evaluation ---------------------------------------------------

const MANIFEST_ROOT_KEYS = new Set([
  "max_concurrent",
  "time_limit",
  "resume",
  "resume_budget_policy",
  "lnr",
  "defaults",
  "tasks",
]);

const MANIFEST_DEFAULT_KEYS = new Set([
  "phase",
  "type",
  "workspace_base",
  "lnr",
  "num_drafts",
  "draft_parallel",
  "evaluator",
]);

const MANIFEST_TASK_KEYS = new Set([
  "exp_id",
  "run_id",
  "time_limit",
  "cpu_list",
  "gpu_list",
  "lnr",
  "phase",
  "type",
  "input_data_dir",
  "num_drafts",
  "draft_parallel",
  "workspace",
  "workspace_base",
]);

const MANIFEST_LNR_KEYS = new Set([
  "max_steps",
  "num_workers",
  "wall_clock_budget_sec",
  "seed",
  "resource_control_mode",
  "omp_threads_cap",
  "resource_gpu_pool",
]);

const MODEL_GATEWAY_KEYS = new Set([
  "agent",
  "api_key",
  "api_keys",
  "base_url",
  "base_urls",
  "models",
  "llm_routing_mode",
  "llm_sticky_id",
]);

interface BudgetValue {
  readonly present: boolean;
  readonly value?: number;
  readonly valid: boolean;
}

function readBudget(value: unknown): BudgetValue {
  if (value === undefined) return { present: false, valid: true };
  // An explicit `null` states a budget without naming a value. Refuse it rather
  // than guessing whether the engine reads it as "no limit".
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { present: true, valid: false };
  }
  return { present: true, value, valid: true };
}

/** A declared workspace value: absent, a usable string, or a malformed form. */
function readWorkspaceText(value: unknown): {
  readonly text: string;
  readonly valid: boolean;
} {
  if (value === undefined || value === null) return { text: "", valid: true };
  if (typeof value !== "string") return { text: "", valid: false };
  const text = value.trim();
  // A control byte is not a path form the engine accepts, and it cannot be
  // described honestly in a response, so it is refused rather than trimmed.
  if (/[\u0000-\u001f\u007f]/.test(text)) return { text: "", valid: false };
  return { text, valid: true };
}

type WorkspaceResolution =
  | { readonly status: "ok"; readonly source: ScienceFlowWorkspaceSource }
  | { readonly status: "missing" | "unsupported" };

/**
 * The engine's workspace precedence: the task's explicit `workspace`, then the
 * task's `workspace_base`, then `defaults.workspace_base`, with a blank value
 * counted as absent. Nothing is resolved, expanded, or created here; only the
 * winning key is kept, so no host path enters the contract.
 */
function resolveWorkspaceSource(
  task: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>> | undefined,
): WorkspaceResolution {
  const explicit = readWorkspaceText(task.workspace);
  const taskBase = readWorkspaceText(task.workspace_base);
  const defaultBase = readWorkspaceText(defaults?.workspace_base);
  if (!explicit.valid || !taskBase.valid || !defaultBase.valid) {
    return { status: "unsupported" };
  }
  if (explicit.text) return { status: "ok", source: "task_workspace" };
  if (taskBase.text) return { status: "ok", source: "task_workspace_base" };
  if (defaultBase.text) return { status: "ok", source: "defaults_workspace_base" };
  return { status: "missing" };
}

interface ManifestFacts {
  readonly expId: string;
  readonly rootTimeLimit?: number;
  readonly taskTimeLimit?: number;
  readonly rootWallClock?: number;
  readonly defaultsWallClock?: number;
  readonly taskWallClock?: number;
  readonly inputDataDir: boolean;
  /** Which key supplies the workspace; the path itself is never resolved. */
  readonly workspaceSource: ScienceFlowWorkspaceSource;
}

/** Validate the supported manifest subset; returns facts or a rejected verdict. */
function evaluateManifest(
  manifest: Readonly<Record<string, unknown>>,
  checks: CheckCollector,
): ManifestFacts | undefined {
  for (const code of [
    "manifest_key",
    "manifest_multiple_tasks",
    "manifest_max_concurrent",
    "manifest_phase",
    "manifest_type",
    "manifest_resume",
    "manifest_config_include",
    "manifest_task_text",
    "manifest_model_gateway",
    "manifest_evaluator",
    "manifest_budget",
  ] as const) {
    checks.add(code);
  }
  // The workspace source needs the task record; a manifest rejected before it
  // is reached must report the check as unevaluated, not passed.
  checks.add("manifest_workspace", "unknown");

  for (const key of Object.keys(manifest)) {
    if (MODEL_GATEWAY_KEYS.has(key)) {
      checks.override("manifest_model_gateway", "unsupported");
    } else if (key === "config") {
      checks.override("manifest_config_include", "unsupported");
    } else if (!MANIFEST_ROOT_KEYS.has(key)) {
      checks.override("manifest_key", "unsupported");
    }
  }

  const maxConcurrent = manifest.max_concurrent;
  if (maxConcurrent !== undefined && maxConcurrent !== null) {
    if (
      typeof maxConcurrent !== "number" ||
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1
    ) {
      checks.override("manifest_shape", "failed");
    } else if (maxConcurrent > 1) {
      checks.override("manifest_max_concurrent", "unsupported");
    }
  }

  const rootTime = readBudget(manifest.time_limit);
  if (!rootTime.valid) checks.override("manifest_budget", "failed");

  if (manifest.resume !== undefined && manifest.resume !== null) {
    if (manifest.resume !== false) {
      checks.override("manifest_resume", "unsupported");
    }
  }
  if (manifest.resume_budget_policy !== undefined) {
    checks.override("manifest_resume", "unsupported");
  }

  const rootLnr = evaluateLnr(manifest.lnr, checks);

  const defaults = manifest.defaults;
  let defaultsWallClock: number | undefined;
  if (defaults !== undefined && defaults !== null) {
    if (!isRecord(defaults)) {
      checks.override("manifest_shape", "failed");
    } else {
      defaultsWallClock = evaluateDefaults(defaults, checks);
    }
  }

  const rawTasks = manifest.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    checks.override("manifest_shape", "failed");
    return undefined;
  }
  if (rawTasks.length > 1) {
    checks.override("manifest_multiple_tasks", "unsupported");
    return undefined;
  }
  const task = rawTasks[0];
  if (!isRecord(task)) {
    checks.override("manifest_shape", "failed");
    return undefined;
  }

  for (const key of Object.keys(task)) {
    if (MODEL_GATEWAY_KEYS.has(key)) {
      checks.override("manifest_model_gateway", "unsupported");
    } else if (key === "config") {
      checks.override("manifest_config_include", "unsupported");
    } else if (key === "task") {
      checks.override("manifest_task_text", "unsupported");
    } else if (key === "gate") {
      checks.override("manifest_evaluator", "unsupported");
    } else if (!MANIFEST_TASK_KEYS.has(key)) {
      checks.override("manifest_key", "unsupported");
    }
  }

  const expId = task.exp_id;
  if (typeof expId !== "string" || expId.trim().length === 0) {
    checks.override("manifest_shape", "failed");
    return undefined;
  }
  if (task.run_id !== undefined && typeof task.run_id !== "string") {
    checks.override("manifest_shape", "failed");
  }
  for (const key of ["cpu_list", "gpu_list"] as const) {
    const value = task[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      checks.override("manifest_shape", "failed");
    }
  }
  const workspace = resolveWorkspaceSource(
    task,
    defaults !== undefined && isRecord(defaults) ? defaults : undefined,
  );
  if (workspace.status === "ok") {
    checks.override("manifest_workspace", "passed");
  } else if (workspace.status === "missing") {
    checks.override("manifest_workspace", "failed");
  } else {
    checks.override("manifest_workspace", "unsupported");
  }
  if (task.phase !== undefined && String(task.phase).trim().toLowerCase() !== "run") {
    checks.override("manifest_phase", "unsupported");
  }
  if (task.type !== undefined && String(task.type).trim().toLowerCase() !== "lnr") {
    checks.override("manifest_type", "unsupported");
  }
  if (
    defaults !== undefined &&
    isRecord(defaults) &&
    defaults.phase !== undefined &&
    String(defaults.phase).trim().toLowerCase() !== "run"
  ) {
    checks.override("manifest_phase", "unsupported");
  }
  if (
    defaults !== undefined &&
    isRecord(defaults) &&
    defaults.type !== undefined &&
    String(defaults.type).trim().toLowerCase() !== "lnr"
  ) {
    checks.override("manifest_type", "unsupported");
  }

  const taskTime = readBudget(task.time_limit);
  if (!taskTime.valid) checks.override("manifest_budget", "failed");
  const taskLnr = evaluateLnr(task.lnr, checks);

  let inputDataDir = false;
  if (task.input_data_dir !== undefined && task.input_data_dir !== null) {
    if (typeof task.input_data_dir !== "string") {
      checks.override("manifest_shape", "failed");
    } else if (task.input_data_dir.trim().length > 0) {
      inputDataDir = true;
    }
  }
  if (task.num_drafts !== undefined && !isPositiveInteger(task.num_drafts)) {
    checks.override("manifest_shape", "failed");
  }
  if (task.draft_parallel !== undefined && !isPositiveInteger(task.draft_parallel)) {
    checks.override("manifest_shape", "failed");
  }

  // A manifest that names no workspace is what the engine refuses at run time;
  // the static check must refuse it too rather than supplying a directory.
  if (workspace.status !== "ok") return undefined;

  return {
    expId,
    ...(rootTime.value !== undefined ? { rootTimeLimit: rootTime.value } : {}),
    ...(taskTime.value !== undefined ? { taskTimeLimit: taskTime.value } : {}),
    ...(rootLnr.wallClock !== undefined ? { rootWallClock: rootLnr.wallClock } : {}),
    ...(defaultsWallClock !== undefined
      ? { defaultsWallClock }
      : {}),
    ...(taskLnr.wallClock !== undefined ? { taskWallClock: taskLnr.wallClock } : {}),
    inputDataDir,
    workspaceSource: workspace.source,
  };
}

function evaluateDefaults(
  defaults: Readonly<Record<string, unknown>>,
  checks: CheckCollector,
): number | undefined {
  for (const key of Object.keys(defaults)) {
    if (MODEL_GATEWAY_KEYS.has(key)) {
      checks.override("manifest_model_gateway", "unsupported");
    } else if (key === "config") {
      checks.override("manifest_config_include", "unsupported");
    } else if (key === "task") {
      checks.override("manifest_task_text", "unsupported");
    } else if (key === "gate") {
      checks.override("manifest_evaluator", "unsupported");
    } else if (!MANIFEST_DEFAULT_KEYS.has(key)) {
      checks.override("manifest_key", "unsupported");
    }
  }
  const evaluator = defaults.evaluator;
  if (evaluator !== undefined && evaluator !== null) {
    if (!isRecord(evaluator)) {
      checks.override("manifest_evaluator", "unsupported");
    } else {
      for (const key of Object.keys(evaluator)) {
        if (key !== "enabled" && key !== "backend") {
          checks.override("manifest_evaluator", "unsupported");
        }
      }
      if (evaluator.enabled !== undefined && evaluator.enabled !== true) {
        checks.override("manifest_evaluator", "unsupported");
      }
      if (evaluator.backend !== undefined && evaluator.backend !== "task_package") {
        checks.override("manifest_evaluator", "unsupported");
      }
    }
  }
  // `defaults.workspace_base` is judged with the task workspace source below:
  // a blank value is absent there, not a shape error on its own.
  for (const key of ["num_drafts", "draft_parallel"] as const) {
    if (defaults[key] !== undefined && !isPositiveInteger(defaults[key])) {
      checks.override("manifest_shape", "failed");
    }
  }
  return evaluateLnr(defaults.lnr, checks).wallClock;
}

function evaluateLnr(
  value: unknown,
  checks: CheckCollector,
): { readonly wallClock?: number } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    checks.override("manifest_shape", "failed");
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_LNR_KEYS.has(key)) {
      if (MODEL_GATEWAY_KEYS.has(key)) {
        checks.override("manifest_model_gateway", "unsupported");
      } else {
        checks.override("manifest_key", "unsupported");
      }
    }
  }
  const wallClock = readBudget(value.wall_clock_budget_sec);
  if (!wallClock.valid) checks.override("manifest_budget", "failed");
  return wallClock.value !== undefined ? { wallClock: wallClock.value } : {};
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// --- task package evaluation ----------------------------------------------

const TASK_YAML_KEYS = new Set([
  "id",
  "category",
  "provider",
  "profile",
  "description",
  "artifact",
  "metric",
  "problem",
  "evaluator",
  "validation",
  "inputs",
]);

const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface TaskFacts {
  readonly taskId: string;
  readonly category: string | null;
  readonly profile: string | null;
  readonly metricName: string;
  readonly lowerIsBetter: boolean;
  readonly metricType: string | null;
  readonly metricAuthoritative: boolean | null;
  readonly artifactPath: string;
  readonly artifactKind: string | null;
  readonly entrypoint: string;
  readonly entrypointPath: string;
  readonly entrypointFunction: string;
  readonly entrypointSha256: string;
  readonly timeoutSec: number | null;
  readonly descriptionPath: string;
  readonly descriptionSha256: string;
  readonly taskYamlSha256: string;
  readonly sharedDefaultsSha256: string | null;
  /** The package-tree bytes this contract came from, in read order. */
  readonly files: readonly ScienceFlowContractFile[];
}

const TASK_DEPENDENT_CHECKS = [
  "task_yaml_key",
  "task_identity",
  "task_metric",
  "task_artifact",
  "evaluator_entrypoint",
  "evaluator_file",
  "description_reference",
  "description_file",
  "path_allowed_roots",
  "path_traversal",
] as const satisfies readonly ScienceFlowPlanCheckCode[];

function evaluateTaskPackage(
  packageRoot: string,
  roots: readonly string[],
  expId: string,
  checks: CheckCollector,
): TaskFacts | undefined {
  // Bound to the exact read that produced each digest, so preparation can send
  // the verified bytes instead of re-reading a file that may have moved on.
  const files: ScienceFlowContractFile[] = [];
  // Registered as `unknown` and settled at the end of a complete evaluation: a
  // check that an earlier rejection skipped must not read as "passed".
  for (const code of TASK_DEPENDENT_CHECKS) {
    checks.add(code, "unknown");
  }

  const taskYamlPath = resolveFile(join(packageRoot, "task.yaml"));
  if (taskYamlPath === undefined) {
    checks.override("task_yaml_readable", "failed");
    return undefined;
  }
  if (!isInside(taskYamlPath, packageRoot)) {
    checks.override("task_yaml_readable", "failed");
    checks.override("path_allowed_roots", "failed");
    return undefined;
  }
  const taskYamlRead = readFileBounded(
    taskYamlPath,
    SCIENCE_FLOW_EXECUTION_STRUCTURED_FILE_MAX_BYTES,
  );
  if (taskYamlRead.status !== "ok") {
    checks.override(
      "task_yaml_readable",
      "failed",
    );
    if (taskYamlRead.status === "too-large") {
      checks.override("task_yaml_size", "failed");
    }
    return undefined;
  }
  checks.add("task_yaml_readable");
  checks.add("task_yaml_size");
  const taskYamlText = decodeUtf8(taskYamlRead.bytes);
  if (taskYamlText === null) {
    checks.override("task_yaml_encoding", "failed");
    return undefined;
  }
  checks.add("task_yaml_encoding");
  const taskYamlOutcome = parseYaml(taskYamlText);
  if (taskYamlOutcome.status === "duplicate") {
    checks.override("task_yaml_duplicate_key", "failed");
    checks.override("task_yaml_yaml", "failed");
    return undefined;
  }
  if (taskYamlOutcome.status === "alias") {
    checks.override("task_yaml_alias_limit", "failed");
    checks.override("task_yaml_yaml", "failed");
    return undefined;
  }
  if (taskYamlOutcome.status !== "ok" || !isRecord(taskYamlOutcome.value)) {
    checks.override("task_yaml_yaml", "failed");
    checks.override("task_yaml_shape", "failed");
    return undefined;
  }
  checks.add("task_yaml_yaml");
  files.push({
    role: "task_yaml",
    path: SCIENCE_FLOW_INPUT_LOGICAL_PATHS.taskYaml,
    bytes: taskYamlRead.bytes,
    sha256: taskYamlRead.sha256,
  });

  // The engine merges `<category>/_shared/task_defaults.yaml` beneath the task
  // file. Only that fixed sibling path is supported; no other include.
  let sharedDefaultsSha256: string | null = null;
  let sharedDefaults: Readonly<Record<string, unknown>> = {};
  const sharedPath = resolveFile(
    join(dirname(packageRoot), "_shared", "task_defaults.yaml"),
  );
  if (sharedPath !== undefined) {
    if (!roots.some((root) => isInside(sharedPath, root))) {
      checks.override("path_allowed_roots", "failed");
      return undefined;
    }
    const sharedRead = readFileBounded(
      sharedPath,
      SCIENCE_FLOW_EXECUTION_STRUCTURED_FILE_MAX_BYTES,
    );
    if (sharedRead.status !== "ok") {
      checks.override("shared_defaults", "failed");
      return undefined;
    }
    const sharedText = decodeUtf8(sharedRead.bytes);
    const sharedParsed = sharedText === null ? undefined : parseYaml(sharedText);
    if (
      sharedParsed === undefined ||
      sharedParsed.status !== "ok" ||
      !isRecord(sharedParsed.value)
    ) {
      checks.override("shared_defaults", "failed");
      return undefined;
    }
    checks.add("shared_defaults");
    sharedDefaults = sharedParsed.value;
    sharedDefaultsSha256 = sharedRead.sha256;
    files.push({
      role: "shared_task_defaults",
      path: SCIENCE_FLOW_INPUT_LOGICAL_PATHS.sharedDefaults,
      bytes: sharedRead.bytes,
      sha256: sharedRead.sha256,
    });
  }

  const merged = mergeTaskPackageDefaults(
    sharedDefaults,
    taskYamlOutcome.value,
  );
  for (const key of Object.keys(merged)) {
    if (!TASK_YAML_KEYS.has(key)) {
      checks.override("task_yaml_key", "unsupported");
    }
  }

  const taskId = merged.id;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    checks.override("task_yaml_shape", "failed");
    return undefined;
  }
  if (taskId !== expId) checks.override("task_identity", "failed");

  const category = optionalString(merged.category);
  const profileName = optionalString(merged.profile);
  if (merged.category !== undefined && category === null) {
    checks.override("task_yaml_shape", "failed");
  }
  if (merged.profile !== undefined && profileName === null) {
    checks.override("task_yaml_shape", "failed");
  }

  const metric = merged.metric;
  if (!isRecord(metric)) {
    checks.override("task_metric", "failed");
    return undefined;
  }
  const metricName = metric.name;
  const lowerIsBetter = metric.lower_is_better;
  const metricType = optionalString(metric.type);
  const authoritative = metric.authoritative;
  if (
    typeof metricName !== "string" ||
    metricName.trim().length === 0 ||
    typeof lowerIsBetter !== "boolean" ||
    (metric.type !== undefined && metricType === null) ||
    (authoritative !== undefined && typeof authoritative !== "boolean")
  ) {
    checks.override("task_metric", "failed");
    return undefined;
  }

  const artifact = merged.artifact;
  if (!isRecord(artifact) || typeof artifact.path !== "string") {
    checks.override("task_artifact", "failed");
    return undefined;
  }
  const artifactPath = normalizePackageReference(artifact.path);
  if (artifactPath.status !== "ok") {
    checks.override("task_artifact", "failed");
    checks.override("path_traversal", "failed");
    return undefined;
  }
  const artifactKind = optionalString(artifact.kind);
  if (artifact.kind !== undefined && artifactKind === null) {
    checks.override("task_artifact", "failed");
    return undefined;
  }

  const evaluator = merged.evaluator;
  if (!isRecord(evaluator) || typeof evaluator.entrypoint !== "string") {
    checks.override("evaluator_entrypoint", "failed");
    return undefined;
  }
  const separator = evaluator.entrypoint.lastIndexOf(":");
  if (separator <= 0 || separator === evaluator.entrypoint.length - 1) {
    checks.override("evaluator_entrypoint", "failed");
    return undefined;
  }
  const rawEntrypointPath = evaluator.entrypoint.slice(0, separator);
  const entrypointFunction = evaluator.entrypoint.slice(separator + 1).trim();
  if (!PYTHON_IDENTIFIER.test(entrypointFunction)) {
    checks.override("evaluator_entrypoint", "failed");
    return undefined;
  }
  const normalizedEntrypoint = normalizePackageReference(rawEntrypointPath);
  if (normalizedEntrypoint.status !== "ok") {
    checks.override("evaluator_entrypoint", "failed");
    checks.override("path_traversal", "failed");
    return undefined;
  }
  checks.add("evaluator_entrypoint");

  const timeoutSec = evaluator.timeout_sec;
  if (
    timeoutSec !== undefined &&
    (typeof timeoutSec !== "number" ||
      !Number.isFinite(timeoutSec) ||
      timeoutSec <= 0)
  ) {
    checks.override("task_yaml_shape", "failed");
    return undefined;
  }

  const descriptionRef = merged.description;
  if (typeof descriptionRef !== "string" || descriptionRef.trim().length === 0) {
    checks.override("description_reference", "failed");
    return undefined;
  }
  const normalizedDescription = normalizePackageReference(descriptionRef);
  if (normalizedDescription.status !== "ok") {
    checks.override("description_reference", "failed");
    checks.override("path_traversal", "failed");
    return undefined;
  }
  checks.add("description_reference");

  const entrypointFile = resolveFile(
    resolve(packageRoot, normalizedEntrypoint.relativePath),
  );
  if (
    entrypointFile === undefined ||
    !isInside(entrypointFile, packageRoot) ||
    !roots.some((root) => isInside(entrypointFile, root))
  ) {
    checks.override("evaluator_file", "failed");
    if (entrypointFile !== undefined) {
      checks.override("path_allowed_roots", "failed");
    }
    return undefined;
  }
  const entrypointRead = readFileBounded(
    entrypointFile,
    SCIENCE_FLOW_EXECUTION_SOURCE_FILE_MAX_BYTES,
  );
  if (entrypointRead.status !== "ok") {
    checks.override("evaluator_file", "failed");
    return undefined;
  }
  checks.add("evaluator_file");
  files.push({
    role: "evaluator",
    path: `package/${normalizedEntrypoint.relativePath}`,
    bytes: entrypointRead.bytes,
    sha256: entrypointRead.sha256,
  });

  const descriptionFile = resolveFile(
    resolve(packageRoot, normalizedDescription.relativePath),
  );
  if (
    descriptionFile === undefined ||
    !isInside(descriptionFile, packageRoot) ||
    !roots.some((root) => isInside(descriptionFile, root))
  ) {
    checks.override("description_file", "failed");
    if (descriptionFile !== undefined) {
      checks.override("path_allowed_roots", "failed");
    }
    return undefined;
  }
  const descriptionRead = readFileBounded(
    descriptionFile,
    SCIENCE_FLOW_EXECUTION_STRUCTURED_FILE_MAX_BYTES,
  );
  if (descriptionRead.status !== "ok") {
    checks.override("description_file", "failed");
    return undefined;
  }
  checks.add("description_file");
  files.push({
    role: "description",
    path: `package/${normalizedDescription.relativePath}`,
    bytes: descriptionRead.bytes,
    sha256: descriptionRead.sha256,
  });

  // Every dependent check was reached; only the ones still `unknown` passed.
  for (const code of TASK_DEPENDENT_CHECKS) {
    if (checks.status(code) === "unknown") checks.override(code, "passed");
  }

  return {
    taskId,
    category,
    profile: profileName,
    metricName,
    lowerIsBetter,
    metricType,
    metricAuthoritative:
      typeof authoritative === "boolean" ? authoritative : null,
    artifactPath: artifactPath.relativePath,
    artifactKind,
    entrypoint: evaluator.entrypoint,
    entrypointPath: normalizedEntrypoint.relativePath,
    entrypointFunction,
    entrypointSha256: entrypointRead.sha256,
    timeoutSec: typeof timeoutSec === "number" ? timeoutSec : null,
    descriptionPath: normalizedDescription.relativePath,
    descriptionSha256: descriptionRead.sha256,
    taskYamlSha256: taskYamlRead.sha256,
    sharedDefaultsSha256,
    files,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// --- full evaluation -------------------------------------------------------

function evaluateProfile(
  profile: ScienceFlowExecutionProfile,
): ScienceFlowContractBuildResult {
  const checks = new CheckCollector();

  const roots: string[] = [];
  for (const root of profile.allowedReadRoots) {
    const real = prepareDirectory(root);
    if (real === undefined) {
      checks.override("path_allowed_roots", "failed");
      return { status: "rejected", checks: checks.list() };
    }
    roots.push(real);
  }

  const packageRoot = prepareDirectory(profile.taskPackageRoot);
  if (packageRoot === undefined) {
    checks.override("task_yaml_readable", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  if (!roots.some((root) => isInside(packageRoot, root))) {
    checks.override("path_allowed_roots", "failed");
    return { status: "rejected", checks: checks.list() };
  }

  const manifestPath = resolveFile(profile.manifestPath);
  if (manifestPath === undefined) {
    checks.override("manifest_readable", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  if (!roots.some((root) => isInside(manifestPath, root))) {
    checks.override("path_allowed_roots", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  const manifestRead = readFileBounded(
    manifestPath,
    SCIENCE_FLOW_EXECUTION_STRUCTURED_FILE_MAX_BYTES,
  );
  if (manifestRead.status !== "ok") {
    checks.override("manifest_readable", "failed");
    if (manifestRead.status === "too-large") {
      checks.override("manifest_size", "failed");
    }
    return { status: "rejected", checks: checks.list() };
  }
  checks.add("manifest_readable");
  checks.add("manifest_size");
  const manifestText = decodeUtf8(manifestRead.bytes);
  if (manifestText === null) {
    checks.override("manifest_encoding", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  checks.add("manifest_encoding");
  const manifestOutcome = parseYaml(manifestText);
  if (manifestOutcome.status === "duplicate") {
    checks.override("manifest_duplicate_key", "failed");
    checks.override("manifest_yaml", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  if (manifestOutcome.status === "alias") {
    checks.override("manifest_alias_limit", "failed");
    checks.override("manifest_yaml", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  if (manifestOutcome.status !== "ok" || !isRecord(manifestOutcome.value)) {
    checks.override("manifest_yaml", "failed");
    checks.override("manifest_shape", "failed");
    return { status: "rejected", checks: checks.list() };
  }
  checks.add("manifest_yaml");

  const manifestFacts = evaluateManifest(manifestOutcome.value, checks);
  if (manifestFacts === undefined) {
    return { status: "rejected", checks: checks.list() };
  }

  const taskFacts = evaluateTaskPackage(
    packageRoot,
    roots,
    manifestFacts.expId,
    checks,
  );
  if (taskFacts === undefined) {
    return { status: "rejected", checks: checks.list() };
  }

  if (checks.blocked()) {
    return { status: "rejected", checks: checks.list() };
  }

  // Budgets are what the manifest requested; this round enforces none of them.
  const budgets: ScienceFlowExecutionBudgetDto[] = [];
  const wallClock =
    manifestFacts.taskWallClock ??
    manifestFacts.defaultsWallClock ??
    manifestFacts.rootWallClock;
  if (wallClock !== undefined) {
    budgets.push({
      name: "wall_clock_budget_sec",
      value: wallClock,
      unit: "seconds",
      nature: "requested",
    });
  }
  const timeLimit =
    manifestFacts.taskTimeLimit ?? manifestFacts.rootTimeLimit;
  if (timeLimit !== undefined) {
    budgets.push({
      name: "time_limit",
      value: timeLimit,
      unit: "seconds",
      nature: "requested",
    });
  }

  checks.override(
    "dataset_identity",
    manifestFacts.inputDataDir ? "unknown" : "passed",
  );
  checks.add("execution_environment", "unknown");
  checks.add("pricing", "unknown");
  checks.add("model_gateway", "unknown");
  checks.add("scienceflow_revision", "unknown");
  checks.add("dependency_closure", "unknown");

  const contract: ScienceFlowExecutionPlanContractDto = {
    scienceflow: {
      declaredRevision: profile.scienceFlowRevision,
      verification: "unverified",
    },
    task: {
      taskId: taskFacts.taskId,
      category: taskFacts.category,
      profile: taskFacts.profile,
    },
    metric: {
      name: taskFacts.metricName,
      lowerIsBetter: taskFacts.lowerIsBetter,
      type: taskFacts.metricType,
      authoritative: taskFacts.metricAuthoritative,
    },
    artifact: {
      path: taskFacts.artifactPath,
      kind: taskFacts.artifactKind,
    },
    evaluator: {
      entrypoint: taskFacts.entrypoint,
      path: taskFacts.entrypointPath,
      function: taskFacts.entrypointFunction,
      sha256: taskFacts.entrypointSha256,
      timeoutSec: taskFacts.timeoutSec,
    },
    description: {
      path: taskFacts.descriptionPath,
      sha256: taskFacts.descriptionSha256,
    },
    workspace: {
      source: manifestFacts.workspaceSource,
    },
    taskYamlSha256: taskFacts.taskYamlSha256,
    manifestSha256: manifestRead.sha256,
    sharedDefaultsSha256: taskFacts.sharedDefaultsSha256,
    budgets,
    unknowns: {
      dataset: manifestFacts.inputDataDir ? "unknown" : "not-applicable",
      environment: "unknown",
      pricing: "unknown",
      modelGateway: "unknown",
      revision: "unverified",
      dependencyClosure: "incomplete",
    },
  };

  return {
    status: "ok",
    contract,
    checks: checks.list(),
    files: [
      {
        role: "manifest",
        path: SCIENCE_FLOW_INPUT_LOGICAL_PATHS.manifest,
        bytes: manifestRead.bytes,
        sha256: manifestRead.sha256,
      },
      ...taskFacts.files,
    ],
  };
}

// --- small helpers ---------------------------------------------------------

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
