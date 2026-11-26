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
 * Task selection and preparation for the experimental local research mode.
 *
 * Two task sources are supported, both bound before a launch:
 *
 * - a registered ScienceFlow task package, identified by the engine's own task
 *   id; the engine keeps its evaluator and metric authority;
 * - a task contract this Session prepared from a scientific objective, an
 *   evaluator script and valid/invalid sample artifacts. The contract and the
 *   evaluator are ordinary Session artifact versions, so their bytes and
 *   identities are immutable the way every other artifact version is.
 *
 * A prepared contract is deliberately small: the engine is still the only
 * execution engine and its own `artifact_command` backend runs the evaluator.
 * This module does not implement a second evaluator, and a generated evaluator
 * is always labelled exploratory, never an authoritative benchmark.
 *
 * The engine is reached through one narrow Python adapter executed with the
 * profile's own interpreter; it lists packages and runs probes through the
 * engine's real backend. No engine source is copied here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The only prepared-contract version this module writes and reads. */
export const PREPARED_TASK_CONTRACT_VERSION = 1;

/** Bounds for one prepared contract. */
export const PREPARED_TASK_LIMITS = Object.freeze({
  objectiveBytes: 16_384,
  titleCharacters: 200,
  evaluatorBytes: 128 * 1024,
  sampleBytes: 1 * 1024 * 1024,
  maxInputs: 16,
  maxInputBytes: 16 * 1024 * 1024,
  maxArtifactPathLength: 200,
  maxMetricNameLength: 100,
  adapterStdoutBytes: 4 * 1024 * 1024,
});

/** A refusal with a stable reason; messages never carry a host path. */
export class TaskPreparationRefusal extends Error {
  readonly reason:
    | "invalid-option"
    | "task-not-found"
    | "contract-invalid"
    | "contract-version-not-found"
    | "evaluator-unavailable"
    | "probe-failed"
    | "adapter-failed"
    | "adapter-timeout"
    | "publication-failed";
  constructor(reason: TaskPreparationRefusal["reason"], message: string) {
    super(message);
    this.name = "TaskPreparationRefusal";
    this.reason = reason;
  }
}

/** One registered engine task package, as the adapter reports it. */
export interface ScienceFlowCatalogTask {
  readonly authoritative: boolean;
  readonly artifactKind: string;
  readonly artifactPath: string;
  readonly category: string;
  readonly descriptionAvailable: boolean;
  readonly evaluatorEntrypoint: string;
  readonly id: string;
  readonly inputsRequired: boolean | null;
  readonly lowerIsBetter: boolean | null;
  readonly metricName: string;
  readonly metricType: string;
  readonly profile: string;
  readonly provider: string;
}

export interface ScienceFlowCatalogTaskDescription extends ScienceFlowCatalogTask {
  readonly description: string;
  /** Digest of the evaluator file this package declares, when observable. */
  readonly entrypointSha256: string | null;
  /** Digest of the package source tree the engine would import. */
  readonly packageSha256: string | null;
  /** Third-party modules the package's evaluator imports but this interpreter lacks. */
  readonly missingModules: readonly string[];
}

/** One evaluator probe the engine's backend actually ran. */
export interface PreparedTaskProbe {
  readonly label: string;
  readonly expect: "accepted" | "rejected";
  readonly status: string;
  readonly ok: boolean;
  readonly metricName: string;
  readonly metricValue: number | null;
  readonly lowerIsBetter: boolean | null;
  readonly artifactSha256: string;
}

/** The immutable scientific contract a prepared task version carries. */
export interface PreparedTaskContract {
  readonly schemaVersion: typeof PREPARED_TASK_CONTRACT_VERSION;
  readonly taskId: string;
  readonly title: string;
  readonly objective: string;
  readonly artifactPath: string;
  readonly artifactKind: string;
  readonly metric: {
    readonly name: string;
    readonly lowerIsBetter: boolean;
    readonly jsonPath: string;
  };
  readonly evaluator: {
    readonly language: "python";
    readonly scriptName: string;
    readonly versionId: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly probes: readonly PreparedTaskProbe[];
  readonly inputs: readonly PreparedTaskInputBinding[];
  readonly authority: "exploratory-generated";
  readonly provenance: {
    readonly preparedAt: string;
    readonly publishedBy: string;
    readonly sessionId: string;
    readonly agentRunId: string;
  };
}

/** One ordinary Session artifact version bound as task input data. */
export interface PreparedTaskInputBinding {
  readonly logicalName: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly size: number;
}

/** What `start_research` actually froze for the operation. */
export interface ScienceFlowTaskBinding {
  readonly source: "catalog" | "prepared";
  readonly taskId: string;
  readonly title: string;
  /** Present for a prepared task: the contract artifact version. */
  readonly taskVersionId?: string;
  /** The contract body digest frozen at start; re-read before launch. */
  readonly contractHash?: string;
  readonly metricName: string;
  readonly metricType: string;
  readonly lowerIsBetter: boolean | null;
  /** Dotted stdout path of the metric; prepared tasks only. */
  readonly metricJsonPath?: string;
  readonly authoritative: boolean;
  readonly artifactPath: string;
  readonly artifactKind: string;
  /** The evaluator identity the engine will run. */
  readonly evaluator:
    | {
        readonly kind: "task-package";
        readonly entrypoint: string;
        /** Digest of the evaluator file the package declares, when observable. */
        readonly entrypointSha256?: string;
        /** Digest of the package source tree the engine would import. */
        readonly packageSha256?: string;
      }
    | { readonly kind: "generated-command"; readonly sha256: string; readonly versionId: string };
  /** Where this operation's frozen task files live (control plane only). */
  readonly assetDir?: string;
  readonly assetManifestSha256?: string;
  /** Input bytes bound to the task, with their Session version identities. */
  readonly inputs: readonly PreparedTaskInputBinding[];
  /** A short note used by the delivered result note; never a host path. */
  readonly summary: string;
}

export interface TaskPreparationSettings {
  readonly engineCheckout: string;
  readonly pythonExecutable: string;
  readonly preparationScriptPath: string;
  readonly probeTimeoutSec: number;
}

/** The adapter's raw probe entry; parsed here into the published contract. */
interface AdapterProbeResult {
  readonly label: string;
  readonly expect: string;
  readonly status: string;
  readonly ok: boolean;
  readonly metricName?: string;
  readonly metricValue?: number | null;
  readonly lowerIsBetter?: boolean | null;
  readonly artifactSha256?: string;
}

/**
 * Run one adapter action. The request is handed over as a JSON file so argv
 * never carries task text, and the child is killed on a deadline so a wedged
 * probe cannot hold a conversation open.
 */
async function runAdapter(
  settings: TaskPreparationSettings,
  action: "list-tasks" | "describe-task" | "probe-evaluator",
  request: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "sd-sf-prepare-"));
  const requestPath = join(directory, "request.json");
  try {
    await writeFile(requestPath, JSON.stringify({ engineCheckout: settings.engineCheckout, ...request }), "utf8");
    const stdout = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let text = "";
      let timer: NodeJS.Timeout | undefined;
      const finish = (error: Error | undefined, value?: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      let child;
      try {
        child = spawn(settings.pythonExecutable, [settings.preparationScriptPath, action, requestPath], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        finish(new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter could not be started"));
        return;
      }
      const stop = (): void => {
        if (!child.killed) child.kill("SIGKILL");
      };
      timer = setTimeout(() => {
        stop();
        finish(new TaskPreparationRefusal("adapter-timeout", "The task-preparation adapter exceeded its deadline"));
      }, timeoutMs);
      signal?.addEventListener("abort", () => {
        stop();
        finish(new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter was cancelled"));
      }, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > PREPARED_TASK_LIMITS.adapterStdoutBytes) {
          stop();
          finish(new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter produced too much output"));
          return;
        }
        text += chunk;
      });
      child.stderr?.resume();
      child.on("error", () => {
        finish(new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter could not be started"));
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        if (exitCode !== 0) {
          finish(new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter refused the request"));
          return;
        }
        finish(undefined, text);
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new TaskPreparationRefusal("adapter-failed", "The task-preparation adapter returned no usable result");
    }
    if (!isRecord(parsed) || parsed.status !== "ok") {
      const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : undefined;
      const detail = isRecord(parsed) && typeof parsed.message === "string"
        ? parsed.message.slice(0, 300)
        : undefined;
      throw new TaskPreparationRefusal(
        code === "task_not_found" ? "task-not-found" : "adapter-failed",
        code === "task_not_found"
          ? "No registered task package has that id"
          : `The task-preparation adapter could not complete the request${detail ? `: ${detail}` : ""}`,
      );
    }
    return parsed;
  } finally {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function listCatalogTasks(
  settings: TaskPreparationSettings,
  signal?: AbortSignal,
): Promise<readonly ScienceFlowCatalogTask[]> {
  const response = await runAdapter(settings, "list-tasks", {}, 60_000, signal);
  const tasks = response.tasks;
  if (!Array.isArray(tasks)) {
    throw new TaskPreparationRefusal("adapter-failed", "The task catalog was not a list");
  }
  return tasks.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (typeof value.id !== "string" || typeof value.artifactPath !== "string"
      || typeof value.artifactKind !== "string" || typeof value.metricName !== "string") return [];
    return [{
      authoritative: value.authoritative === true,
      artifactKind: value.artifactKind,
      artifactPath: value.artifactPath,
      category: String(value.category ?? ""),
      descriptionAvailable: value.descriptionAvailable === true,
      evaluatorEntrypoint: String(value.evaluatorEntrypoint ?? ""),
      id: value.id,
      inputsRequired: typeof value.inputsRequired === "boolean" ? value.inputsRequired : null,
      lowerIsBetter: typeof value.lowerIsBetter === "boolean" ? value.lowerIsBetter : null,
      metricName: value.metricName,
      metricType: String(value.metricType ?? ""),
      profile: String(value.profile ?? ""),
      provider: String(value.provider ?? ""),
    }];
  });
}

export async function describeCatalogTask(
  settings: TaskPreparationSettings,
  taskId: string,
  signal?: AbortSignal,
): Promise<ScienceFlowCatalogTaskDescription> {
  const response = await runAdapter(settings, "describe-task", { taskId }, 60_000, signal);
  if (typeof response.description !== "string" || response.description.trim().length === 0) {
    throw new TaskPreparationRefusal("task-not-found", "The task package has no usable description");
  }
  return {
    authoritative: response.authoritative === true,
    artifactKind: String(response.artifactKind ?? ""),
    artifactPath: String(response.artifactPath ?? ""),
    category: "",
    description: response.description,
    descriptionAvailable: true,
    entrypointSha256: typeof response.entrypointSha256 === "string" && /^[a-f0-9]{64}$/u.test(response.entrypointSha256)
      ? response.entrypointSha256
      : null,
    evaluatorEntrypoint: String(response.evaluatorEntrypoint ?? ""),
    id: String(response.taskId ?? taskId),
    inputsRequired: null,
    lowerIsBetter: typeof response.lowerIsBetter === "boolean" ? response.lowerIsBetter : null,
    metricName: String(response.metricName ?? ""),
    metricType: String(response.metricType ?? ""),
    packageSha256: typeof response.packageSha256 === "string" && /^[a-f0-9]{64}$/u.test(response.packageSha256)
      ? response.packageSha256
      : null,
    missingModules: Array.isArray(response.missingModules)
      ? response.missingModules.flatMap((value) => (typeof value === "string" ? [value] : []))
      : [],
    profile: "",
    provider: "",
  };
}

/**
 * Run the engine's `artifact_command` backend against probe samples. The
 * evaluator command is built by this deployment from trusted values; the
 * adapter never accepts a caller's shell line.
 */
export async function probePreparedEvaluator(
  settings: TaskPreparationSettings,
  input: {
    readonly artifactKind: string;
    readonly artifactPath: string;
    readonly evaluatorPath: string;
    readonly datasetFiles: readonly { readonly name: string; readonly path: string }[];
    readonly metric: { readonly name: string; readonly lowerIsBetter: boolean; readonly jsonPath: string };
    readonly samples: readonly { readonly label: string; readonly expect: "accepted" | "rejected"; readonly artifactPath: string }[];
    readonly taskId: string;
    readonly taskRoot: string;
    readonly workspaceRoot: string;
  },
  signal?: AbortSignal,
): Promise<readonly PreparedTaskProbe[]> {
  const command = `${quoteArg(settings.pythonExecutable)} ${quoteArg(input.evaluatorPath)} {artifact_abs_path}`;
  const response = await runAdapter(settings, "probe-evaluator", {
    artifactKind: input.artifactKind,
    artifactPath: input.artifactPath,
    evaluatorCommand: command,
    metric: {
      jsonPath: input.metric.jsonPath,
      lowerIsBetter: input.metric.lowerIsBetter,
      name: input.metric.name,
      timeoutSec: settings.probeTimeoutSec,
    },
    pythonExecutable: settings.pythonExecutable,
    samples: input.samples.map((sample) => ({
      artifactPath: sample.artifactPath,
      datasetFiles: input.datasetFiles.map((file) => ({ name: file.name, source: file.path })),
      expect: sample.expect,
      label: sample.label,
    })),
    taskId: input.taskId,
    taskRoot: input.taskRoot,
    workspaceRoot: input.workspaceRoot,
  }, Math.max(30_000, settings.probeTimeoutSec * 4_000), signal);
  const results = response.results;
  if (!Array.isArray(results)) {
    throw new TaskPreparationRefusal("probe-failed", "The evaluator probe returned no results");
  }
  return results.flatMap((value) => {
    if (!isRecord(value)) return [];
    const result: AdapterProbeResult = {
      artifactSha256: typeof value.artifactSha256 === "string" ? value.artifactSha256 : undefined,
      expect: String(value.expect ?? "accepted"),
      label: String(value.label ?? ""),
      lowerIsBetter: typeof value.lowerIsBetter === "boolean" ? value.lowerIsBetter : null,
      metricName: typeof value.metricName === "string" ? value.metricName : undefined,
      metricValue: typeof value.metricValue === "number" && Number.isFinite(value.metricValue)
        ? value.metricValue
        : null,
      ok: value.ok === true,
      status: String(value.status ?? ""),
    };
    return [{
      artifactSha256: result.artifactSha256 ?? "",
      expect: result.expect === "rejected" ? "rejected" as const : "accepted" as const,
      label: result.label,
      lowerIsBetter: result.lowerIsBetter ?? null,
      metricName: result.metricName ?? "",
      metricValue: result.metricValue ?? null,
      ok: result.ok,
      status: result.status,
    }];
  });
}

/**
 * A probe is accepted only when every sample did what its expectation says:
 * a valid sample produced a finite metric through the backend, and an invalid
 * or domain-violating sample was rejected. A malformed evaluator, non-finite
 * value, exception and timeout all remain failures.
 */
export function assertProbeAccepted(
  probes: readonly PreparedTaskProbe[],
  lowerIsBetter: boolean,
  metricName?: string,
): void {
  const accepted = probes.find((probe) => probe.expect === "accepted");
  const rejected = probes.find((probe) => probe.expect === "rejected");
  if (!accepted || !rejected) {
    throw new TaskPreparationRefusal("probe-failed", "A prepared evaluator needs a valid and an invalid sample");
  }
  if (!accepted.ok || accepted.metricValue === null || !Number.isFinite(accepted.metricValue)) {
    throw new TaskPreparationRefusal(
      "probe-failed",
      `The evaluator did not return a finite metric for the valid sample (${accepted.status})`,
    );
  }
  if (rejected.ok) {
    throw new TaskPreparationRefusal(
      "probe-failed",
      "The evaluator accepted the invalid sample instead of rejecting it",
    );
  }
  if (accepted.lowerIsBetter !== lowerIsBetter) {
    throw new TaskPreparationRefusal(
      "probe-failed",
      "The evaluator reported a different metric direction than the contract",
    );
  }
  if (metricName !== undefined && accepted.metricName !== "" && accepted.metricName !== metricName) {
    throw new TaskPreparationRefusal(
      "probe-failed",
      "The evaluator reported a different metric name than the contract",
    );
  }
}

function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/gu, "\\$1")}"`;
}

/** A stable, engine-safe task id derived from the prepared contract. */
export function preparedTaskId(slug: string | undefined, objective: string): string {
  const stem = (slug ?? objective.split("\n", 1)[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  const digest = createHash("sha256").update(`${slug ?? ""}\n${objective}`).digest("hex").slice(0, 8);
  return `sd-${stem || "research"}-${digest}`.slice(0, 64);
}

/** True for an id the engine accepts as an exp_id / task-root segment. */
export function isUsableTaskId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

/** A relative artifact path that can only resolve inside a worker workspace. */
export function requireArtifactPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskPreparationRefusal("invalid-option", "The candidate artifact path must be a relative path");
  }
  if (value.includes("\0") || isAbsolute(value) || value.length > PREPARED_TASK_LIMITS.maxArtifactPathLength) {
    throw new TaskPreparationRefusal("invalid-option", "The candidate artifact path must be a relative path");
  }
  const parts = value.replace(/\\/gu, "/").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TaskPreparationRefusal("invalid-option", "The candidate artifact path must not contain empty, '.' or '..' segments");
  }
  return parts.join("/");
}

/**
 * A metric extraction path the engine can follow: dotted field names, with
 * numeric segments for list indices. The same value drives the probe and the
 * run, so an unsupported path is refused at preparation, never replaced.
 */
export function requireMetricJsonPath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || path.length > 100 || path.includes("\0")
    || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path)) {
    throw new TaskPreparationRefusal("invalid-option", "The metric JSON path must be a dotted field path");
  }
  return path;
}

/** A file name a task input may be staged under. */
export function requireInputName(value: unknown): string {  // The engine presents every bound input under `dataset/`; a caller naming
  // `dataset/fit.csv` means the same file as `fit.csv`.
  const name = typeof value === "string" && value.startsWith("dataset/") ? value.slice("dataset/".length) : value;
  if (typeof name !== "string" || name.length === 0 || name.length > 120) {
    throw new TaskPreparationRefusal("invalid-option", "A bound input file name is not usable");
  }
  if (name.includes("\0") || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new TaskPreparationRefusal("invalid-option", "A bound input file name must be one plain file name");
  }
  return name;
}

/** Parse one published contract artifact's bytes. */
export function parsePreparedTaskContract(bytes: Buffer): PreparedTaskContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract is not an object");
  }
  if (parsed.schemaVersion !== PREPARED_TASK_CONTRACT_VERSION) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract has an unsupported version");
  }
  const taskId = requireContractString(parsed.taskId, 64);
  if (!isUsableTaskId(taskId)) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract has an unusable task id");
  }
  const title = requireContractString(parsed.title, PREPARED_TASK_LIMITS.titleCharacters);
  const objective = requireContractString(parsed.objective, PREPARED_TASK_LIMITS.objectiveBytes);
  const artifactPath = requireArtifactPath(parsed.artifactPath);
  const artifactKind = requireContractString(parsed.artifactKind, 60);
  const metric = isRecord(parsed.metric) ? parsed.metric : {};
  const metricName = requireContractString(metric.name, PREPARED_TASK_LIMITS.maxMetricNameLength);
  if (typeof metric.lowerIsBetter !== "boolean") {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract needs a metric direction");
  }
  const jsonPath = requireContractString(metric.jsonPath, 100);
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(jsonPath)) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task metric path is not usable");
  }
  const evaluator = isRecord(parsed.evaluator) ? parsed.evaluator : {};
  if (evaluator.language !== "python") {
    throw new TaskPreparationRefusal("contract-invalid", "Only a Python evaluator is supported");
  }
  const evaluatorVersionId = requireContractString(evaluator.versionId, 200);
  const evaluatorSha = requireContractString(evaluator.sha256, 64);
  if (!/^[a-f0-9]{64}$/u.test(evaluatorSha)) {
    throw new TaskPreparationRefusal("contract-invalid", "The evaluator digest is not a sha256");
  }
  const evaluatorSize = evaluator.size;
  if (!Number.isSafeInteger(evaluatorSize) || (evaluatorSize as number) < 0) {
    throw new TaskPreparationRefusal("contract-invalid", "The evaluator size is not usable");
  }
  // Probe and input records are part of the contract, so a malformed entry is a
  // refusal, never silently dropped: a contract that only claims validation is
  // not a validated contract.
  const probes = requireContractProbes(parsed.probes);
  const inputs = requireContractInputBindings(parsed.inputs);
  return {
    artifactKind,
    artifactPath,
    authority: "exploratory-generated",
    evaluator: {
      language: "python",
      scriptName: "evaluator.py",
      sha256: evaluatorSha,
      size: evaluatorSize as number,
      versionId: evaluatorVersionId,
    },
    inputs,
    metric: { jsonPath, lowerIsBetter: metric.lowerIsBetter, name: metricName },
    objective,
    probes,
    provenance: {
      agentRunId: String((isRecord(parsed.provenance) ? parsed.provenance.agentRunId : "") ?? ""),
      preparedAt: String((isRecord(parsed.provenance) ? parsed.provenance.preparedAt : "") ?? ""),
      publishedBy: "research-task-tool",
      sessionId: String((isRecord(parsed.provenance) ? parsed.provenance.sessionId : "") ?? ""),
    },
    schemaVersion: PREPARED_TASK_CONTRACT_VERSION,
    taskId,
    title,
  };
}

/** At most the two samples one preparation runs; more is not this contract. */
const MAX_CONTRACT_PROBES = 2;

function requireContractProbes(value: unknown): readonly PreparedTaskProbe[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTRACT_PROBES) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract carries no usable probe record");
  }
  const probes = value.map((entry): PreparedTaskProbe => {
    if (!isRecord(entry)) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe record is not an object");
    }
    if (entry.expect !== "accepted" && entry.expect !== "rejected") {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no expectation");
    }
    const label = requireContractString(entry.label, 40);
    if (typeof entry.status !== "string" || entry.status.length === 0 || entry.status.includes("\0")) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no backend status");
    }
    if (typeof entry.ok !== "boolean") {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no outcome");
    }
    if (typeof entry.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.artifactSha256)) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no sample digest");
    }
    const metricValue = entry.metricValue;
    if (metricValue !== null && (typeof metricValue !== "number" || !Number.isFinite(metricValue))) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no finite metric value");
    }
    const lowerIsBetter = entry.lowerIsBetter;
    if (lowerIsBetter !== null && typeof lowerIsBetter !== "boolean") {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task probe has no metric direction");
    }
    return {
      artifactSha256: entry.artifactSha256,
      expect: entry.expect,
      label,
      lowerIsBetter,
      metricName: typeof entry.metricName === "string" ? entry.metricName : "",
      metricValue,
      ok: entry.ok,
      status: entry.status,
    };
  });
  if (probes.filter((probe) => probe.expect === "accepted").length !== 1
    || probes.filter((probe) => probe.expect === "rejected").length !== 1) {
    throw new TaskPreparationRefusal(
      "contract-invalid",
      "A prepared task contract needs exactly one accepted and one rejected probe",
    );
  }
  return probes;
}

function requireContractInputBindings(value: unknown): readonly PreparedTaskInputBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PREPARED_TASK_LIMITS.maxInputs) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task input bindings are not usable");
  }
  const bindings = value.map((entry): PreparedTaskInputBinding => {
    if (!isRecord(entry)) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task input binding is not an object");
    }
    let logicalName: string;
    try {
      logicalName = requireInputName(entry.logicalName);
    } catch {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task input has no usable file name");
    }
    if (typeof entry.versionId !== "string" || entry.versionId.length === 0 || entry.versionId.length > 200) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task input has no version identity");
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task input digest is not a sha256");
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new TaskPreparationRefusal("contract-invalid", "A prepared task input size is not usable");
    }
    return {
      logicalName,
      sha256: entry.sha256,
      size: entry.size as number,
      versionId: entry.versionId,
    };
  });
  if (new Set(bindings.map((binding) => binding.logicalName)).size !== bindings.length) {
    throw new TaskPreparationRefusal("contract-invalid", "Two prepared task inputs share a file name");
  }
  return bindings;
}

function requireContractString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TaskPreparationRefusal("contract-invalid", "The prepared task contract has an unusable field");
  }
  return value;
}

/** Read a file's bytes and digest without following it outside its directory. */
export async function readBoundedFile(path: string, maximum: number): Promise<{ bytes: Buffer; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) {
    throw new TaskPreparationRefusal("invalid-option", "A task file is not a regular file within its bound");
  }
  const bytes = await readFile(path);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The researcher-facing instruction for a selected or prepared task. */
export function composeTaskInstruction(input: {
  readonly artifactPath: string;
  readonly artifactKind: string;
  readonly authoritative: boolean;
  readonly incumbentFile?: string;
  readonly incumbentVersionId?: string;
  readonly inputFiles: readonly string[];
  readonly intent: string;
  readonly metricName: string;
  readonly lowerIsBetter: boolean | null;
  readonly objective: string;
  readonly operationId: string;
  readonly planFile: string;
  readonly planVersionId: string;
  readonly prepared: boolean;
  readonly title: string;
}): string {
  const direction = input.lowerIsBetter === true
    ? "lower is better"
    : input.lowerIsBetter === false
      ? "higher is better"
      : "direction is fixed by the engine's evaluator";
  const evaluator = input.prepared
    ? `This Session prepared the evaluator that scores the artifact. It is exploratory: passing its probe does not make it an authoritative benchmark. The evaluator is fixed for this run and its score cannot be redefined by anything the researcher writes.`
    : input.authoritative
      ? `The task package's own evaluator is the authoritative score and is fixed for this run.`
      : `The task package's own evaluator is fixed for this run; this task is not published as an authoritative benchmark.`;
  const start = input.incumbentFile && input.incumbentVersionId
    ? `The starting candidate of this run is \`${input.incumbentFile}\` (artifact version \`${input.incumbentVersionId}\`); use it as the starting point and do not overwrite it.`
    : `This run starts from scratch: no initial candidate is provided.`;
  const data = input.inputFiles.length
    ? `Bound input data (read-only, under \`dataset/\`): ${input.inputFiles.map((name) => `\`${name}\``).join(", ")}. Do not modify it.`
    : `This task needs no external input data; do not invent one.`;
  return [
    `# Research task: ${input.title}`,
    "",
    input.objective.trim(),
    "",
    "## The plan for this run",
    "",
    `A Session Agent wrote this plan from the evidence of earlier runs. The plan text is \`${input.planFile}\` (artifact version \`${input.planVersionId}\`). Read it before doing anything else.`,
    "",
    "## Research intent recorded with this run",
    "",
    input.intent,
    "",
    "## Execution contract (fixed before this run started)",
    "",
    `- Candidate artifact path: \`${input.artifactPath}\` (kind \`${input.artifactKind}\`). The engine evaluates it every time it changes.`,
    `- Metric: \`${input.metricName}\`, ${direction}. ${evaluator}`,
    `- ${start}`,
    `- ${data}`,
    `- Operation \`${input.operationId}\`.`,
    "",
    "## What to do",
    "",
    "1. Read the plan and decide the smallest faithful implementation of it.",
    "2. Carry out the method with the workspace tools. Keep the scripts you write in the workspace so the run records what actually executed.",
    `3. Before deep optimization, write one feasible candidate to \`${input.artifactPath}\` in the format the task requires and let the engine evaluate it. A run that never writes the artifact delivers nothing, whatever it computed.`,
    `4. Then use the engine's evaluator feedback to improve the candidate in separate bounded calls, rewriting \`${input.artifactPath}\` with each real improvement. Never treat a self-reported score as authoritative and never write your own evaluator.`,
    "5. Report what you actually ran, the scores the evaluator printed, whether the plan's acceptance rule was met, and every deviation from the plan. Do not describe a result the logs do not show.",
    "",
    "## Bounds",
    "",
    "- One run, one worker, CPU only. Do not start background processes and do not install packages.",
    `- The evaluator and the task contract are fixed. Do not write files that claim to replace them.`,
    "- If the plan asks for something this task cannot express, say so plainly instead of substituting a different experiment.",
    "",
  ].join("\n");
}

/** A short, path-free summary of a task for the operation view and result note. */
export function taskSummary(title: string, metricName: string, lowerIsBetter: boolean | null, prepared: boolean): string {
  const direction = lowerIsBetter === true ? "lower is better" : lowerIsBetter === false ? "higher is better" : "direction not recorded";
  return `${title} — metric \`${metricName}\` (${direction})${prepared ? "; evaluator prepared in this Session (exploratory)" : ""}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
