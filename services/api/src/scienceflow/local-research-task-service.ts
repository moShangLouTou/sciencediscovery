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
 * Prepare a conversation-defined computational task as immutable Session
 * artifact versions, after the engine's own evaluator backend accepted it.
 *
 * The published pair is the task version:
 *
 * - `research-tasks/<task-id>/evaluator.py` — the evaluator script bytes;
 * - `research-tasks/<task-id>/contract.json` — the objective, artifact and
 *   metric contract, probe evidence, the evaluator version identity and the
 *   input artifact versions.
 *
 * Nothing is published when a probe fails, so a Session cannot start research
 * from a contract whose evaluator never evaluated a sample. A prepared task is
 * exploratory by construction; it is not an authoritative benchmark.
 */
import { publishArtifactVersion, type ResearchArtifactStore } from "../research/artifact-publisher.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import type { ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";

import {
  PREPARED_TASK_LIMITS,
  TaskPreparationRefusal,
  assertProbeAccepted,
  composeTaskInstruction,
  parsePreparedTaskContract,
  preparedTaskId,
  probePreparedEvaluator,
  requireArtifactPath,
  requireInputName,
  requireMetricJsonPath,
  taskSummary,
  type PreparedTaskContract,
  type PreparedTaskInputBinding,
  type PreparedTaskProbe,
  type ScienceFlowTaskBinding,
  type TaskPreparationSettings,
} from "./local-research-task.js";
import {
  PREPARED_TASK_VALIDATION_VERSION,
  type PreparedTaskValidation,
  type PreparedTaskValidationStore,
} from "./local-research-task-repository.js";

/** The store surface this module uses. `SessionStore` satisfies it. */
export interface PreparedTaskStore {
  readonly dataDir: string;
  /** The trusted preflight record; contract bytes alone cannot prove a probe. */
  readonly scienceFlowPreparedTaskValidations: PreparedTaskValidationStore;
  assertSessionWritable(sessionId: string): void;
  getProject(projectId: string): { readonly id: string } | undefined;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
  getArtifactByName(sessionId: string, name: string):
    | {
        readonly createdInSessionId?: string;
        readonly currentVersion: number;
        readonly deletedAt?: string;
        readonly id: string;
        readonly kind: string;
      }
    | undefined;
  getProjectArtifactVersion(projectId: string, versionId: string):
    | {
        readonly artifactId: string;
        readonly content: { readonly hash: string; readonly size: number };
        readonly id: string;
        readonly sessionId?: string;
        readonly version: number;
      }
    | undefined;
  getProjectArtifact(projectId: string, artifactId: string):
    | {
        readonly createdInSessionId?: string;
        readonly currentVersion: number;
        readonly deletedAt?: string;
        readonly id: string;
        readonly kind: string;
        readonly logicalName?: string;
      }
    | undefined;
  listProjectArtifactVersions(projectId: string, artifactId: string): readonly {
    readonly content: { readonly hash: string; readonly size: number };
    readonly id: string;
    readonly version: number;
  }[];
  createArtifactVersion: ResearchArtifactStore["createArtifactVersion"];
}

export interface PrepareTaskInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly objective: string;
  readonly title: string;
  readonly slug?: string;
  readonly artifactPath: string;
  readonly artifactKind?: string;
  readonly metricName: string;
  readonly metricDirection: "minimize" | "maximize";
  readonly metricJsonPath?: string;
  readonly evaluatorSource: string;
  readonly validSample: { readonly name: string; readonly content: string };
  readonly invalidSample: { readonly name: string; readonly content: string };
  readonly inputs?: readonly { readonly versionId: string; readonly fileName?: string }[];
  readonly signal?: AbortSignal;
}

/** The public result of one preparation: business identities only. */
export interface PreparedTaskPublication {
  readonly taskId: string;
  readonly taskVersionId: string;
  readonly contractArtifactId: string;
  readonly contractVersion: number;
  readonly evaluatorArtifactId: string;
  readonly evaluatorVersionId: string;
  readonly evaluatorSha256: string;
  readonly title: string;
  readonly objective: string;
  readonly artifactPath: string;
  readonly artifactKind: string;
  readonly metric: { readonly name: string; readonly lowerIsBetter: boolean; readonly jsonPath: string };
  readonly probes: readonly ProofProbeView[];
  readonly inputs: readonly { readonly fileName: string; readonly versionId: string; readonly sha256: string; readonly size: number }[];
  readonly authority: "exploratory-generated";
  readonly summary: string;
}

interface ProofProbeView {
  readonly label: string;
  readonly expect: "accepted" | "rejected";
  readonly metricValue: number | null;
  readonly status: string;
}

export interface PrepareTaskDependencies {
  readonly settings: TaskPreparationSettings;
  readonly tasksRoot: string;
  readonly readBytes: (hash: string) => Promise<Buffer>;
  readonly now: () => string;
  /** Defaults to the real engine adapter; tests substitute a stub. */
  readonly probe?: typeof probePreparedEvaluator;
}

/** Prepare and publish one task version; nothing is published when a probe fails. */
export async function prepareResearchTask(
  store: PreparedTaskStore,
  input: PrepareTaskInput,
  dependencies: PrepareTaskDependencies,
): Promise<PreparedTaskPublication> {
  if (!store.getProject(input.projectId)) {
    throw new TaskPreparationRefusal("invalid-option", "The Project does not exist");
  }
  const session = store.getSession(input.sessionId);
  if (!session || session.projectId !== input.projectId) {
    throw new TaskPreparationRefusal("invalid-option", "The Session does not exist in this Project");
  }
  store.assertSessionWritable(input.sessionId);

  const objective = requireText(input.objective, PREPARED_TASK_LIMITS.objectiveBytes, "The task objective");
  const title = requireText(input.title?.trim() || objective.split("\n", 1)[0]!.slice(0, 120), PREPARED_TASK_LIMITS.titleCharacters, "The task title");
  const artifactPath = requireArtifactPath(input.artifactPath);
  const artifactKind = requireText(input.artifactKind?.trim() || "json", 60, "The artifact kind");
  const metricName = requireText(input.metricName, PREPARED_TASK_LIMITS.maxMetricNameLength, "The metric name");
  const jsonPath = requireMetricJsonPath(input.metricJsonPath ?? "metric");
  const lowerIsBetter = input.metricDirection === "minimize";
  if (Buffer.byteLength(input.evaluatorSource, "utf8") > PREPARED_TASK_LIMITS.evaluatorBytes
    || input.evaluatorSource.trim().length === 0 || input.evaluatorSource.includes("\u0000")) {
    throw new TaskPreparationRefusal("invalid-option", "The evaluator source must be non-empty Python within the size bound");
  }
  const samples = [
    { label: "valid", expect: "accepted" as const, name: requireInputName(input.validSample.name), content: input.validSample.content },
    { label: "invalid", expect: "rejected" as const, name: requireInputName(input.invalidSample.name), content: input.invalidSample.content },
  ];
  for (const sample of samples) {
    if (Buffer.byteLength(sample.content, "utf8") > PREPARED_TASK_LIMITS.sampleBytes) {
      throw new TaskPreparationRefusal("invalid-option", "A probe sample exceeds the size bound");
    }
  }

  const inputBindings = await resolveInputs(store, input, dependencies);
  const taskId = preparedTaskId(input.slug, objective);
  const preparedAt = dependencies.now();
  const evaluatorBytes = Buffer.from(input.evaluatorSource, "utf8");
  const evaluatorSha = createHash("sha256").update(evaluatorBytes).digest("hex");

  // Probe in a private preparation directory; nothing here becomes live state.
  await mkdir(dependencies.tasksRoot, { recursive: true, mode: 0o755 });
  const root = await mkdtemp(join(dependencies.tasksRoot, ".prepare-"));
  let probes: readonly PreparedTaskProbe[];  try {
    const evaluatorPath = join(root, "evaluator.py");
    await writeFile(evaluatorPath, evaluatorBytes, { mode: 0o600 });
    const datasetFiles: Array<{ name: string; path: string }> = [];
    for (const binding of inputBindings) {
      const bytes = await dependencies.readBytes(binding.sha256).catch(() => undefined);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== binding.sha256) {
        throw new TaskPreparationRefusal("evaluator-unavailable", "A bound input version is no longer readable");
      }
      const path = join(root, "dataset", binding.logicalName);
      await mkdir(join(root, "dataset"), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
      datasetFiles.push({ name: binding.logicalName, path });
    }
    const samplePaths = [];
    for (const sample of samples) {
      const path = join(root, "samples", sample.label, sample.name);
      await mkdir(join(root, "samples", sample.label), { recursive: true });
      await writeFile(path, sample.content, { mode: 0o600 });
      samplePaths.push({ artifactPath: path, expect: sample.expect, label: sample.label });
    }
    probes = await (dependencies.probe ?? probePreparedEvaluator)(dependencies.settings, {
      artifactKind,
      artifactPath,
      datasetFiles,
      evaluatorPath,
      metric: { jsonPath, lowerIsBetter, name: metricName },
      samples: samplePaths,
      taskId,
      taskRoot: join(root, "task-root"),
      workspaceRoot: join(root, "workspaces"),
    }, input.signal);
  } finally {
    await rm(root, { force: true, recursive: true }).catch(() => undefined);
  }

  assertProbeAccepted(probes, lowerIsBetter, metricName);

  // Publish the evaluator first: the contract refers to its version id, and a
  // later edit to the artifact creates a new version instead of changing this one.
  const cas = new CasStore(store.dataDir);
  const evaluatorStored = await cas.put(evaluatorBytes);
  const evaluatorPublication = await publishTaskFile(store, {
    artifactKind: "other",
    bytes: evaluatorBytes,
    logicalName: `research-tasks/${taskId}/evaluator.py`,
    mediaType: "text/x-python",
    originMeta: { agentRunId: input.runId, publishedBy: "research-task-tool" },
    sessionId: input.sessionId,
    stored: evaluatorStored,
    title: `${title} evaluator`,
  });

  const contract: PreparedTaskContract = {
    artifactKind,
    artifactPath,
    authority: "exploratory-generated",
    evaluator: {
      language: "python",
      scriptName: "evaluator.py",
      sha256: evaluatorSha,
      size: evaluatorBytes.length,
      versionId: evaluatorPublication.version.id,
    },
    inputs: inputBindings,
    metric: { jsonPath, lowerIsBetter, name: metricName },
    objective,
    probes: probes.map((probe) => ({
      artifactSha256: probe.artifactSha256,
      expect: probe.expect,
      label: probe.label,
      lowerIsBetter: probe.lowerIsBetter,
      metricName: probe.metricName,
      metricValue: probe.metricValue,
      ok: probe.ok,
      status: probe.status,
    })),
    provenance: {
      agentRunId: input.runId,
      preparedAt,
      publishedBy: "research-task-tool",
      sessionId: input.sessionId,
    },
    schemaVersion: 1,
    taskId,
    title,
  };
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
  // The contract is read back through the same parser a start uses, so a writing
  // bug cannot publish a contract this deployment cannot consume.
  parsePreparedTaskContract(contractBytes);
  const contractStored = await cas.put(contractBytes);
  const contractPublication = await publishTaskFile(store, {
    artifactKind: "json",
    bytes: contractBytes,
    logicalName: `research-tasks/${taskId}/contract.json`,
    mediaType: "application/json",
    originMeta: { agentRunId: input.runId, publishedBy: "research-task-tool" },
    sessionId: input.sessionId,
    stored: contractStored,
    title: `${title} task contract`,
  });

  // The trusted side of the preflight: the version id the store just assigned,
  // plus every identity the probe covered. A later edit of the contract — even
  // one that copies this probe array — cannot inherit this validation.
  const validation: PreparedTaskValidation = {
    artifact: { kind: artifactKind, path: artifactPath },
    contractHash: contractStored.hash,
    contractVersionId: contractPublication.version.id,
    evaluator: {
      sha256: evaluatorSha,
      size: evaluatorBytes.length,
      versionId: evaluatorPublication.version.id,
    },
    inputs: inputBindings,
    metric: { jsonPath, lowerIsBetter, name: metricName },
    probes: contract.probes,
    projectId: input.projectId,
    recordedAt: preparedAt,
    schemaVersion: PREPARED_TASK_VALIDATION_VERSION,
    sessionId: input.sessionId,
    taskId,
  };
  store.scienceFlowPreparedTaskValidations.record(validation);

  return {
    artifactKind,
    artifactPath,
    authority: "exploratory-generated",
    contractArtifactId: contractPublication.artifact.id,
    contractVersion: contractPublication.version.version,
    evaluatorArtifactId: evaluatorPublication.artifact.id,
    evaluatorSha256: evaluatorSha,
    evaluatorVersionId: evaluatorPublication.version.id,
    inputs: inputBindings.map((binding) => ({
      fileName: binding.logicalName,
      sha256: binding.sha256,
      size: binding.size,
      versionId: binding.versionId,
    })),
    metric: { jsonPath, lowerIsBetter, name: metricName },
    objective,
    probes: probes.map((probe) => ({
      expect: probe.expect,
      label: probe.label,
      metricValue: probe.metricValue,
      status: probe.status,
    })),
    summary: taskSummary(title, metricName, lowerIsBetter, true),
    taskId,
    taskVersionId: contractPublication.version.id,
    title,
  };
}

/**
 * Publish one task file idempotently: identical bytes already at the artifact's
 * head are reused, and a changed body becomes a new version of the same task.
 */
async function publishTaskFile(
  store: PreparedTaskStore,
  input: {
    readonly artifactKind: "json" | "other";
    readonly bytes: Buffer;
    readonly logicalName: string;
    readonly mediaType: string;
    readonly originMeta: Record<string, string>;
    readonly sessionId: string;
    readonly stored: { readonly hash: string; readonly size: number };
    readonly title: string;
  },
): Promise<{ artifact: { id: string }; version: { id: string; version: number } }> {
  try {
    const published = await publishArtifactVersion(store, {
      bytes: input.bytes, digest: input.stored.hash, description: input.title,
      kind: input.artifactKind, logicalName: input.logicalName, mediaType: input.mediaType,
      origin: "llm_declared", originMeta: input.originMeta, sessionId: input.sessionId, title: input.title,
    });
    return { artifact: { id: published.artifactId }, version: { id: published.versionId, version: published.version } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskPreparationRefusal("publication-failed", message.slice(0, 300));
  }
}

async function resolveInputs(
  store: PreparedTaskStore,
  input: PrepareTaskInput,
  dependencies: PrepareTaskDependencies,
): Promise<readonly PreparedTaskInputBinding[]> {
  const requested = input.inputs ?? [];
  if (requested.length > PREPARED_TASK_LIMITS.maxInputs) {
    throw new TaskPreparationRefusal("invalid-option", "Too many task input versions");
  }
  const bindings: PreparedTaskInputBinding[] = [];
  let totalBytes = 0;
  for (const reference of requested) {
    const version = store.getProjectArtifactVersion(input.projectId, reference.versionId);
    const artifact = version ? store.getProjectArtifact(input.projectId, version.artifactId) : undefined;
    const ownsArtifact = artifact !== undefined && artifact.deletedAt === undefined
      && artifact.createdInSessionId === input.sessionId;
    const ownsVersion = version !== undefined && version.sessionId === input.sessionId;
    if (!version || !artifact || artifact.deletedAt || (!ownsArtifact && !ownsVersion)) {
      throw new TaskPreparationRefusal("invalid-option", "A task input is not a live artifact version of this Session");
    }
    const bytes = await dependencies.readBytes(version.content.hash).catch(() => undefined);
    if (!bytes) {
      throw new TaskPreparationRefusal("evaluator-unavailable", "A task input version is unreadable");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== version.content.hash || bytes.length !== version.content.size) {
      throw new TaskPreparationRefusal("evaluator-unavailable", "A task input version no longer matches its digest");
    }
    totalBytes += bytes.length;
    if (totalBytes > PREPARED_TASK_LIMITS.maxInputBytes) {
      throw new TaskPreparationRefusal("invalid-option", "The bound task input exceeds the size bound");
    }
    const logicalName = reference.fileName === undefined
      ? requireInputName(basename(artifact.logicalName ?? ""))
      : requireInputName(reference.fileName);
    if (bindings.some((binding) => binding.logicalName === logicalName)) {
      throw new TaskPreparationRefusal("invalid-option", "Two task inputs would be staged under the same name");
    }
    bindings.push({ logicalName, sha256, size: bytes.length, versionId: version.id });
  }
  return bindings;
}

function requireText(value: string, maximum: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\u0000") || Buffer.byteLength(trimmed, "utf8") > maximum) {
    throw new TaskPreparationRefusal("invalid-option", `${label} must be non-empty and within the size bound`);
  }
  return trimmed;
}

/**
 * Read the frozen contract and evaluator bytes a prepared task version names,
 * and refuse a version that is not this Session's or whose evaluator changed.
 */
export async function readPreparedTaskVersion(
  store: PreparedTaskStore,
  dependencies: { readonly readBytes: (hash: string) => Promise<Buffer> },
  input: { readonly projectId: string; readonly sessionId: string; readonly versionId: string },
): Promise<{ readonly contract: PreparedTaskContract; readonly evaluatorBytes: Buffer; readonly contractHash: string }> {
  const version = store.getProjectArtifactVersion(input.projectId, input.versionId);
  const artifact = version ? store.getProjectArtifact(input.projectId, version.artifactId) : undefined;
  if (!version || !artifact || artifact.deletedAt || artifact.createdInSessionId !== input.sessionId) {
    throw new TaskPreparationRefusal(
      "contract-version-not-found",
      "The task version is not a live artifact version of this Session",
    );
  }
  const contractBytes = await dependencies.readBytes(version.content.hash).catch(() => undefined);
  if (!contractBytes) {
    throw new TaskPreparationRefusal("contract-version-not-found", "The task contract version is unreadable");
  }
  const contract = parsePreparedTaskContract(contractBytes);
  const evaluatorVersion = store.getProjectArtifactVersion(input.projectId, contract.evaluator.versionId);
  const evaluatorArtifact = evaluatorVersion
    ? store.getProjectArtifact(input.projectId, evaluatorVersion.artifactId)
    : undefined;
  if (!evaluatorVersion || !evaluatorArtifact || evaluatorArtifact.deletedAt
    || evaluatorArtifact.createdInSessionId !== input.sessionId) {
    throw new TaskPreparationRefusal("evaluator-unavailable", "The task's evaluator version is not in this Session");
  }
  const evaluatorBytes = await dependencies.readBytes(evaluatorVersion.content.hash).catch(() => undefined);
  if (!evaluatorBytes) {
    throw new TaskPreparationRefusal("evaluator-unavailable", "The task's evaluator bytes are unreadable");
  }
  const sha256 = createHash("sha256").update(evaluatorBytes).digest("hex");
  if (sha256 !== contract.evaluator.sha256 || evaluatorBytes.length !== contract.evaluator.size) {
    throw new TaskPreparationRefusal("evaluator-unavailable", "The task's evaluator bytes no longer match the contract");
  }
  // Probe success is a fact the server recorded against this exact version, not
  // a flag in the contract body: a normally appended contract version cannot
  // inherit an older probe, even if it copies that probe array verbatim.
  const validation = store.scienceFlowPreparedTaskValidations.get(input.projectId, input.versionId);
  if (!validation) {
    throw new TaskPreparationRefusal(
      "contract-invalid",
      "This task version has no accepted evaluator probe recorded by this deployment",
    );
  }
  if (validation.sessionId !== input.sessionId
    || validation.contractVersionId !== input.versionId
    || validation.contractHash !== version.content.hash
    || validation.taskId !== contract.taskId
    || validation.evaluator.versionId !== contract.evaluator.versionId
    || validation.evaluator.sha256 !== contract.evaluator.sha256
    || validation.evaluator.size !== contract.evaluator.size
    || validation.metric.name !== contract.metric.name
    || validation.metric.lowerIsBetter !== contract.metric.lowerIsBetter
    || validation.metric.jsonPath !== contract.metric.jsonPath
    || validation.artifact.path !== contract.artifactPath
    || validation.artifact.kind !== contract.artifactKind
    || !sameInputBindings(validation.inputs, contract.inputs)
    || !sameProbes(validation.probes, contract.probes)) {
    throw new TaskPreparationRefusal(
      "contract-invalid",
      "This task version does not match the evaluator probe that validated it",
    );
  }
  return { contract, contractHash: version.content.hash, evaluatorBytes };
}

function sameInputBindings(
  left: readonly PreparedTaskInputBinding[],
  right: readonly PreparedTaskInputBinding[],
): boolean {
  return left.length === right.length && left.every((binding, index) => {
    const other = right[index];
    return other !== undefined
      && binding.logicalName === other.logicalName
      && binding.sha256 === other.sha256
      && binding.size === other.size
      && binding.versionId === other.versionId;
  });
}

function sameProbes(left: readonly PreparedTaskProbe[], right: readonly PreparedTaskProbe[]): boolean {
  return left.length === right.length && left.every((probe, index) => {
    const other = right[index];
    return other !== undefined
      && probe.label === other.label
      && probe.expect === other.expect
      && probe.status === other.status
      && probe.ok === other.ok
      && probe.metricName === other.metricName
      && probe.metricValue === other.metricValue
      && probe.lowerIsBetter === other.lowerIsBetter
      && probe.artifactSha256 === other.artifactSha256;
  });
}

/** The binding a start records for a prepared task version. */
export function preparedTaskBinding(
  contract: PreparedTaskContract,
  contractVersionId: string,
  contractHash: string,
): ScienceFlowTaskBinding {
  return {
    artifactKind: contract.artifactKind,
    artifactPath: contract.artifactPath,
    authoritative: false,
    contractHash,
    evaluator: { kind: "generated-command", sha256: contract.evaluator.sha256, versionId: contract.evaluator.versionId },
    inputs: contract.inputs,
    lowerIsBetter: contract.metric.lowerIsBetter,
    metricJsonPath: contract.metric.jsonPath,
    metricName: contract.metric.name,
    metricType: "exploratory",
    source: "prepared",
    summary: taskSummary(contract.title, contract.metric.name, contract.metric.lowerIsBetter, true),
    taskId: contract.taskId,
    taskVersionId: contractVersionId,
    title: contract.title,
  };
}

/**
 * Freeze one prepared task version into the operation's own directory. Nothing
 * here is shared with another operation: a later task version, an edited
 * artifact or a rebuilt service cannot change what this run executes.
 */
export async function materializePreparedTaskAssets(
  store: PreparedTaskStore,
  dependencies: { readonly readBytes: (hash: string) => Promise<Buffer> },
  input: {
    readonly contractHash: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly targetDir: string;
    readonly taskVersionId: string;
  },
): Promise<{ readonly manifestSha256: string; readonly evaluatorPath: string }> {
  const { contract, contractHash, evaluatorBytes } = await readPreparedTaskVersion(store, dependencies, {
    projectId: input.projectId,
    sessionId: input.sessionId,
    versionId: input.taskVersionId,
  });
  if (contractHash !== input.contractHash) {
    throw new TaskPreparationRefusal(
      "evaluator-unavailable",
      "The task contract changed after this operation was accepted",
    );
  }
  await mkdir(input.targetDir, { recursive: false, mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
    throw new TaskPreparationRefusal(
      error.code === "EEXIST" ? "publication-failed" : "publication-failed",
      "This operation already has task assets",
    );
  });
  const evaluatorPath = join(input.targetDir, contract.evaluator.scriptName);
  const contractPath = join(input.targetDir, "contract.json");
  await writeFile(evaluatorPath, evaluatorBytes, { flag: "wx", mode: 0o644 });
  const contractBytes = await dependencies.readBytes(contractHash).catch(() => undefined);
  if (!contractBytes) {
    throw new TaskPreparationRefusal("evaluator-unavailable", "The task contract is no longer readable");
  }
  const reparsed = parsePreparedTaskContract(contractBytes);
  if (reparsed.evaluator.sha256 !== contract.evaluator.sha256) {
    throw new TaskPreparationRefusal("evaluator-unavailable", "The task contract and evaluator disagree");
  }
  await writeFile(contractPath, contractBytes, { flag: "wx", mode: 0o644 });
  const manifest = {
    schemaVersion: 1,
    taskId: contract.taskId,
    taskVersionId: input.taskVersionId,
    contractHash,
    evaluator: {
      sha256: contract.evaluator.sha256,
      size: evaluatorBytes.length,
      versionId: contract.evaluator.versionId,
    },
    metric: contract.metric,
    artifact: { path: contract.artifactPath, kind: contract.artifactKind },
    inputs: contract.inputs,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(input.targetDir, "task-manifest.json"), manifestJson, { flag: "wx", mode: 0o644 });
  return {
    evaluatorPath,
    manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
  };
}

/** Re-exported so the service composes the same instruction the tool describes. */
export { composeTaskInstruction };
