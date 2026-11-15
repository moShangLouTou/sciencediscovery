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
 * Admin-trusted configuration for the experimental local research mode.
 *
 * One environment variable names a JSON file written by the administrator.
 * When it is unset, unreadable, or says `"enabled": false`, the mode is off:
 * no research tool is exposed, no directory is scanned and no engine process
 * can be started from a conversation. The file is loaded once at server
 * construction, so enabling or changing it needs a restart.
 *
 * The file binds one named research profile to the trusted engine checkout, the
 * interpreter, the task package input, and the run/private roots. Every path is
 * absolute and comes only from the administrator; a model, a request, an
 * upload, a manifest or an engine record can never supply or widen one. The
 * fixed task text is read from a configured file so the conversation supplies
 * research intent and business identities only.
 *
 * This is execution configuration, not an authorization decision: a Session's
 * own permission check still runs before a research run is started.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Points at the administrator's JSON file; unset means the mode is off. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV =
  "SCIENCE_AGENT_SCIENCEFLOW_LOCAL_RESEARCH_CONFIG_PATH";
/** The only configuration version this loader accepts. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_SCHEMA_VERSION = 1;
/** A single profile and its defaults; anything larger is not a config we understand. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_MAX_BYTES = 1024 * 1024;
/** The pinned task text is execution input, bounded like a manifest field. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_TASK_TEXT_MAX_BYTES = 32_768;
/** A plan or incumbent reference file is small; bound what the loader will trust. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES = 4 * 1024 * 1024;
/** A tool wait is a scheduling bound, not a research budget. */
export const SCIENCE_FLOW_LOCAL_RESEARCH_OBSERVE_MAX_WAIT_MS = 300_000;

/** Operational defaults for one research run. */
export interface ScienceFlowLocalResearchDefaults {
  readonly researchBudgetSec: number;
  readonly reportBudgetSec: number;
  readonly totalAllowanceSec: number;
  readonly maxSteps: number;
  readonly stageCaptureMax: number;
  readonly bashTimeoutSec: number;
  readonly codeMaxTokens: number;
  readonly feedbackMaxTokens: number;
  readonly httpTimeoutSec: number;
  /** Upper bound for one bounded observation wait a tool may request. */
  readonly observeMaxWaitMs: number;
}

/** The validated experimental profile. */
export interface ScienceFlowLocalResearchSettings {
  readonly profileId: string;
  readonly engineCheckout: string;
  readonly pythonExecutable: string;
  readonly readerScriptPath: string;
  /** The single engine task package this mode can run. */
  readonly task: string;
  /** Fixed seed directory the administrator staged for the task. */
  readonly seedDir: string;
  /**
   * The seed file that carries each fixed input role, when the profile declares
   * them. A start that names a Session version for a role must match that file
   * byte for byte; otherwise the start is refused before anything runs. The
   * paths are resolved and contained under `seedDir` at load.
   */
  readonly inputs?: ScienceFlowLocalResearchInputs;
  /** Root for per-operation work dirs, receipts and delivery records. */
  readonly workRoot: string;
  /** Root for per-operation private engine inputs (0700); outside the work root. */
  readonly privateRoot: string;
  /** Fixed task text pinned as the researcher's first message; absent means the
   *  task package's own description. */
  readonly taskDescription?: string;
  /** Put pip/pip3/uv refusal shims on the run's PATH. */
  readonly refusePackageInstall: boolean;
  readonly defaults: ScienceFlowLocalResearchDefaults;
}

/** Seed files that carry the profile's fixed plan and incumbent inputs. */
export interface ScienceFlowLocalResearchInputs {
  readonly plan?: string;
  readonly incumbent?: string;
}

const DEFAULT_DEFAULTS: ScienceFlowLocalResearchDefaults = {
  researchBudgetSec: 840,
  reportBudgetSec: 60,
  totalAllowanceSec: 900,
  maxSteps: 24,
  stageCaptureMax: 3,
  bashTimeoutSec: 60,
  codeMaxTokens: 8_192,
  feedbackMaxTokens: 4_096,
  httpTimeoutSec: 60,
  observeMaxWaitMs: 120_000,
};

/** A configuration problem. Messages are static: no paths, values, or parse errors. */
function configError(reason: string): Error {
  return new Error(`${SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV}: ${reason}`);
}

/**
 * Load the optional configuration. Throws on any invalid file so the server
 * fails to start rather than serving a half-trusted profile; an explicitly
 * disabled file yields `undefined` and exposes nothing.
 */
export function loadScienceFlowLocalResearchConfig(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = process.cwd(),
): ScienceFlowLocalResearchSettings | undefined {
  // An unset or blank variable is "disabled", matching the other optional
  // environment switches: it never selects a default directory.
  const rawPath = env[SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV]?.trim();
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
  if (stats.size > SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_MAX_BYTES) {
    throw configError(
      `must not exceed ${SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_MAX_BYTES} bytes`,
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

function parseConfig(value: unknown): ScienceFlowLocalResearchSettings | undefined {
  if (!isRecord(value)) throw configError("must be a JSON object");
  rejectUnknownKeys(value, ["schemaVersion", "enabled", "research", "defaults"], "");
  if (value.schemaVersion !== SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_SCHEMA_VERSION) {
    throw configError(
      `schemaVersion must be ${SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_SCHEMA_VERSION}`,
    );
  }
  // Anything other than an explicit `true` is off. A typo therefore disables the
  // mode instead of enabling it by accident, and the rest of the file is not
  // read: a disabled deployment holds no profile to validate.
  if (value.enabled !== true) return undefined;
  const defaults = parseDefaults(value.defaults);
  return parseResearch(value.research, defaults);
}

function parseResearch(
  value: unknown,
  defaults: ScienceFlowLocalResearchDefaults,
): ScienceFlowLocalResearchSettings {
  if (!isRecord(value)) throw configError("research must be an object");
  rejectUnknownKeys(
    value,
    [
      "profileId",
      "engineCheckout",
      "pythonExecutable",
      "readerScriptPath",
      "task",
      "seedDir",
      "inputs",
      "workRoot",
      "privateRoot",
      "taskDescriptionPath",
      "refusePackageInstall",
    ],
    "research",
  );
  const profileId = requireIdentity(value.profileId, "research.profileId");
  const engineCheckout = requireAbsolutePath(value.engineCheckout, "research.engineCheckout");
  const pythonExecutable = requireAbsolutePath(value.pythonExecutable, "research.pythonExecutable");
  const readerScriptPath = requireAbsolutePath(value.readerScriptPath, "research.readerScriptPath");
  const task = requireTaskId(value.task, "research.task");
  const seedDir = requireAbsolutePath(value.seedDir, "research.seedDir");
  const inputs = parseInputs(value.inputs, seedDir);
  const workRoot = requireAbsolutePath(value.workRoot, "research.workRoot");
  const privateRoot = requireAbsolutePath(value.privateRoot, "research.privateRoot");
  // Generated credentials live under privateRoot and the engine writes under
  // workRoot: overlapping roots would let one run's output sit beside another
  // run's credential, and the pilot already refuses the narrower overlap.
  if (isInside(privateRoot, workRoot) || isInside(privateRoot, seedDir)) {
    throw configError("research.privateRoot must be outside the work root and the seed dir");
  }
  if (isInside(workRoot, seedDir) || isInside(seedDir, workRoot)) {
    throw configError("research.workRoot must not overlap the seed dir");
  }
  const taskDescription =
    value.taskDescriptionPath === undefined
      ? undefined
      : readTaskDescription(
          requireAbsolutePath(value.taskDescriptionPath, "research.taskDescriptionPath"),
        );
  const refusePackageInstall = value.refusePackageInstall === undefined
    ? true
    : requireBoolean(value.refusePackageInstall, "research.refusePackageInstall");
  return Object.freeze({
    profileId,
    engineCheckout,
    pythonExecutable,
    readerScriptPath,
    task,
    seedDir,
    ...(inputs === undefined ? {} : { inputs }),
    workRoot,
    privateRoot,
    ...(taskDescription === undefined ? {} : { taskDescription }),
    refusePackageInstall,
    defaults,
  });
}

/**
 * The profile runs one fixed experiment. These bindings name which seed file
 * carries the plan and which carries the incumbent, so a start can refuse a
 * Session version whose bytes are not that experiment's input instead of
 * linking it in the result metadata only.
 */
function parseInputs(value: unknown, seedDir: string): ScienceFlowLocalResearchInputs | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw configError("research.inputs must be an object");
  rejectUnknownKeys(value, ["plan", "incumbent"], "research.inputs");
  const read = (role: "plan" | "incumbent"): string | undefined => {
    const name = value[role];
    if (name === undefined) return undefined;
    if (typeof name !== "string" || name.trim().length === 0 || name.includes("\0") || isAbsolute(name)) {
      throw configError(`research.inputs.${role} must be a relative file name under the seed dir`);
    }
    const path = resolve(seedDir, name);
    let realSeed: string;
    let realInput: string;
    let stats: ReturnType<typeof statSync>;
    try {
      realSeed = realpathSync(seedDir);
      realInput = realpathSync(path);
      stats = statSync(realInput);
    } catch {
      throw configError(`research.inputs.${role} must name a readable file under the seed dir`);
    }
    if (!isInside(realInput, realSeed) || realInput === realSeed) {
      throw configError(`research.inputs.${role} must stay inside the seed dir`);
    }
    if (!stats.isFile()) {
      throw configError(`research.inputs.${role} must name a regular file`);
    }
    if (stats.size > SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES) {
      throw configError(
        `research.inputs.${role} must not exceed ${SCIENCE_FLOW_LOCAL_RESEARCH_INPUT_MAX_BYTES} bytes`,
      );
    }
    return realInput;
  };
  const plan = read("plan");
  const incumbent = read("incumbent");
  if (plan === undefined && incumbent === undefined) return undefined;
  return Object.freeze({
    ...(plan === undefined ? {} : { plan }),
    ...(incumbent === undefined ? {} : { incumbent }),
  });
}

function parseDefaults(value: unknown): ScienceFlowLocalResearchDefaults {
  if (value === undefined) return DEFAULT_DEFAULTS;
  if (!isRecord(value)) throw configError("defaults must be an object");
  const keys = [
    "researchBudgetSec",
    "reportBudgetSec",
    "totalAllowanceSec",
    "maxSteps",
    "stageCaptureMax",
    "bashTimeoutSec",
    "codeMaxTokens",
    "feedbackMaxTokens",
    "httpTimeoutSec",
    "observeMaxWaitMs",
  ] as const;
  rejectUnknownKeys(value, keys, "defaults");
  const read = (
    key: (typeof keys)[number],
    minimum: number,
    maximum: number,
  ): number =>
    value[key] === undefined
      ? DEFAULT_DEFAULTS[key]
      : requireInteger(value[key], `defaults.${key}`, minimum, maximum);
  const researchBudgetSec = read("researchBudgetSec", 30, 840);
  const reportBudgetSec = read("reportBudgetSec", 10, 600);
  const totalAllowanceSec = read("totalAllowanceSec", 60, 1_800);
  if (totalAllowanceSec < researchBudgetSec + reportBudgetSec) {
    throw configError("defaults.totalAllowanceSec must cover the research and report budgets");
  }
  return Object.freeze({
    researchBudgetSec,
    reportBudgetSec,
    totalAllowanceSec,
    maxSteps: read("maxSteps", 1, 200),
    stageCaptureMax: read("stageCaptureMax", 1, 20),
    bashTimeoutSec: read("bashTimeoutSec", 5, 600),
    codeMaxTokens: read("codeMaxTokens", 256, 32_768),
    feedbackMaxTokens: read("feedbackMaxTokens", 256, 32_768),
    httpTimeoutSec: read("httpTimeoutSec", 5, 600),
    observeMaxWaitMs: read("observeMaxWaitMs", 0, SCIENCE_FLOW_LOCAL_RESEARCH_OBSERVE_MAX_WAIT_MS),
  });
}

/**
 * Read the fixed task text once, at load. It is pinned as the researcher's first
 * user message, so it is execution input; the conversation cannot supply it.
 */
function readTaskDescription(path: string): string {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw configError("research.taskDescriptionPath must name a readable file");
  }
  if (!stats.isFile()) {
    throw configError("research.taskDescriptionPath must name a regular file");
  }
  if (stats.size > SCIENCE_FLOW_LOCAL_RESEARCH_TASK_TEXT_MAX_BYTES) {
    throw configError(
      `research.taskDescriptionPath must not exceed ${SCIENCE_FLOW_LOCAL_RESEARCH_TASK_TEXT_MAX_BYTES} bytes`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw configError("research.taskDescriptionPath must name a readable file");
  }
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\u0000")) {
    throw configError("research.taskDescriptionPath must contain usable text");
  }
  return trimmed;
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

/** The engine accepts one task name, so the profile names one. */
function requireTaskId(value: unknown, field: string): string {
  const task = requireIdentity(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(task)) {
    throw configError(`${field} is not a usable engine task name`);
  }
  return task;
}

function requireAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty absolute path`);
  }
  // A NUL byte cannot name a path; never let it reach spawn or a file read.
  if (value.includes("\0") || !isAbsolute(value)) {
    throw configError(`${field} must be an absolute path`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw configError(`${field} must be a boolean`);
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
        field ? `${field} has an unsupported key` : "the file has an unsupported key",
      );
    }
  }
}

/** True when `candidate` is `parent` itself or lies below it. */
function isInside(candidate: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
