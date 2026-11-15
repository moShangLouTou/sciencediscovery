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
 * Deliver one external ScienceFlow run result into the Session that owns it.
 *
 * The run was started by the engine, not by ScienceDiscovery: this operation
 * reads the run through the same trusted binding, reader and DTO used by the
 * research pilot, and publishes two normal Session artifacts — the selected
 * stage's unchanged solution file and a factual result note. It never starts a
 * run, never re-evaluates the solution and never treats an operator receipt as
 * the artifact locator: the selected artifact and its digest come from the
 * reader's snapshot, and the bytes are re-hashed before publication. The
 * receipt is read only for the model identity and the launch lifecycle it
 * recorded, and only when it names the same Project, Session and run.
 *
 * Repeated delivery is safe: an existing version of the same artifact carrying
 * the same bytes is returned instead of a duplicate, so a retry after a partial
 * publication finishes only the missing part.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import type {
  CasObjectRef,
  ScienceFlowPublicRunPhase,
  ScienceFlowPublicRunStatus,
  ScienceFlowRunSnapshotDto,
  ScientificArtifactKind,
} from "@sciencediscovery/schema";
import type {
  ReadScienceFlowRunSnapshotOptions,
  ScienceFlowRunSnapshot,
  ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";

import type { SessionStore } from "../store.js";
import { projectScienceFlowRunSnapshot } from "./dto.js";
import { createScienceFlowRegistrationService } from "./registration.js";
import { readStageRows, type ResearchPilotStageRow } from "./research-pilot.js";
import {
  createScienceFlowRunSnapshotQuery,
  type ScienceFlowRunBinding,
} from "./run-snapshot.js";

/** Version of the delivery record, independent of the DTO contracts. */
export const SCIENCE_FLOW_RESULT_DELIVERY_VERSION = 1;

/** The reader's own deadline. Delivery reads one run, exactly like the pilot. */
export const SCIENCE_FLOW_RESULT_DELIVERY_READER_TIMEOUT_MS = 30_000;

/** The engine task id used when the operator does not name one. */
export const SCIENCE_FLOW_RESULT_DELIVERY_DEFAULT_TASK = "circle-packing";

/** A delivered artifact is a result file, not a workspace export: keep one. */
const MAX_DELIVERY_BYTES = 16 * 1024 * 1024;

/**
 * Short task descriptions for the note. An unknown task is described by its id
 * only, never guessed.
 */
const TASK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "circle-packing":
    "place exactly 26 circles inside the unit square [0, 1] x [0, 1] without overlap; maximize the sum of radii",
};

/** The two outputs of one delivery. Names are stable per run and output. */
const DELIVERY_OUTPUTS = {
  note: "result-note.md",
  solution: "best-solution.json",
} as const;

export interface ScienceFlowResultDeliveryRequest {
  readonly projectId: string;
  readonly sessionId: string;
  /** The engine's managed-run id. Not a host path. */
  readonly runId: string;
  /** The pilot work dir the run was started in: it locates the run record. */
  readonly workDir: string;
  readonly pythonExecutable: string;
  readonly readerScriptPath: string;
  readonly task?: string;
  /** Where the delivery record is written; defaults to `<work-dir>/delivery.json`. */
  readonly recordPath?: string;
  /**
   * The pilot receipt for this run, read only for the model identity and launch
   * lifecycle it recorded; defaults to `<work-dir>/receipt.json`.
   */
  readonly launchReceiptPath?: string;
}

export interface ScienceFlowResultDeliveryDependencies {
  /** Passed to the existing snapshot query; tests substitute a stub. */
  readonly readSnapshot?: (
    options: ReadScienceFlowRunSnapshotOptions,
  ) => Promise<ScienceFlowSnapshotReadResult>;
  readonly now?: () => string;
}

export type ScienceFlowResultDeliveryFailureReason =
  | "invalid-option"
  | "project-not-found"
  | "session-not-found"
  | "session-not-writable"
  | "registration-failed"
  | "readback-failed"
  | "no-candidate"
  | "candidate-path-out-of-bounds"
  | "candidate-file-missing"
  | "candidate-too-large"
  | "candidate-sha-mismatch"
  | "candidate-unreadable"
  | "stage-ledger-conflict"
  | "publication-failed";

export type ScienceFlowResultDeliveryStep =
  | "validate"
  | "identity"
  | "registration"
  | "readback"
  | "resolve"
  | "verify"
  | "publish-solution"
  | "publish-note";

/** The selected captured stage, as the reader resolved and verified it. */
export interface ScienceFlowDeliveredSelection {
  readonly stageId: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly lowerIsBetter: boolean | null;
  readonly artifactSha256: string;
  readonly digestVerified: boolean | null;
  readonly bytes: number;
  /** Path relative to the run's task root; never an absolute host path. */
  readonly sourcePath: string;
}

export interface ScienceFlowDeliveredArtifact {
  readonly artifactId: string;
  readonly content: CasObjectRef;
  readonly kind: ScientificArtifactKind;
  readonly logicalName: string;
  readonly mediaType: string;
  /** `reused` means an existing version already held these exact bytes. */
  readonly status: "created" | "reused";
  readonly version: number;
  readonly versionId: string;
}

export interface ScienceFlowResultDeliveryRecord {
  readonly schemaVersion: typeof SCIENCE_FLOW_RESULT_DELIVERY_VERSION;
  readonly invocation: "scienceflow-result-delivery";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly run: { readonly runId: string; readonly task: string };
  readonly registration: {
    readonly status: "created" | "existing";
    readonly registrationId: string;
    readonly createdAt: string;
  } | null;
  readonly runState: {
    readonly status: ScienceFlowPublicRunStatus;
    readonly phase: ScienceFlowPublicRunPhase;
  } | null;
  /** The public allow-listed snapshot; no host paths or reader prose. */
  readonly snapshot: ScienceFlowRunSnapshotDto | null;
  readonly selected: ScienceFlowDeliveredSelection | null;
  readonly stages: readonly ResearchPilotStageRow[] | null;
  readonly artifacts: {
    readonly solution?: ScienceFlowDeliveredArtifact;
    readonly note?: ScienceFlowDeliveredArtifact;
  };
  readonly outcome:
    | { readonly status: "delivered" }
    | {
        readonly status: "failed";
        readonly failedStep: ScienceFlowResultDeliveryStep;
        readonly reason: ScienceFlowResultDeliveryFailureReason;
        readonly message: string;
      };
}

/** A delivery that cannot complete, with a stable reason and a safe message. */
class DeliveryRefusal extends Error {
  readonly reason: ScienceFlowResultDeliveryFailureReason;
  constructor(reason: ScienceFlowResultDeliveryFailureReason, message: string) {
    super(message);
    this.name = "DeliveryRefusal";
    this.reason = reason;
  }
}

interface DeliveryTarget {
  readonly workDir: string;
  readonly runId: string;
  readonly task: string;
  readonly stateHome: string;
  readonly taskRoot: string;
  readonly runRecordPath: string;
  readonly stageLedgerPath: string;
  readonly launchReceiptPath: string;
  readonly recordPath: string;
}

/**
 * Deliver the selected result of an already existing engine run for one
 * persisted SD Project/Session. Expected failures are returned as a record, not
 * thrown, so the caller can act on the reason and retry.
 */
export async function deliverScienceFlowResult(
  store: SessionStore,
  request: ScienceFlowResultDeliveryRequest,
  dependencies: ScienceFlowResultDeliveryDependencies = {},
): Promise<ScienceFlowResultDeliveryRecord> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const identity = { projectId: request.projectId, sessionId: request.sessionId };
  const artifacts: { solution?: ScienceFlowDeliveredArtifact; note?: ScienceFlowDeliveredArtifact } = {};
  let step: ScienceFlowResultDeliveryStep = "validate";
  let target: DeliveryTarget | undefined;
  let registration: ScienceFlowResultDeliveryRecord["registration"] = null;
  let runState: ScienceFlowResultDeliveryRecord["runState"] = null;
  let snapshot: ScienceFlowRunSnapshotDto | null = null;
  let selected: ScienceFlowDeliveredSelection | null = null;
  let stages: readonly ResearchPilotStageRow[] | null = null;

  const failed = (
    failedStep: ScienceFlowResultDeliveryStep,
    reason: ScienceFlowResultDeliveryFailureReason,
    message: string,
  ): ScienceFlowResultDeliveryRecord => ({
    artifacts,
    finishedAt: now(),
    identity,
    invocation: "scienceflow-result-delivery",
    outcome: { failedStep, message, reason, status: "failed" },
    registration,
    run: { runId: request.runId, task: target?.task ?? request.task ?? SCIENCE_FLOW_RESULT_DELIVERY_DEFAULT_TASK },
    runState,
    schemaVersion: SCIENCE_FLOW_RESULT_DELIVERY_VERSION,
    selected,
    snapshot,
    stages,
    startedAt,
  });

  try {
    target = resolveDeliveryTarget(request);

    step = "identity";
    if (!isUsableId(identity.projectId) || !isUsableId(identity.sessionId) || !isUsableId(target.runId)) {
      throw new DeliveryRefusal("invalid-option", "The Project, Session and run ids must be non-blank business ids");
    }
    if (!store.getProject(identity.projectId)) {
      throw new DeliveryRefusal("project-not-found", "The Project does not exist");
    }
    const session = store.getSession(identity.sessionId);
    if (!session || session.projectId !== identity.projectId) {
      throw new DeliveryRefusal("session-not-found", "The Session does not exist in this Project");
    }
    assertWritable(store, identity.sessionId);

    step = "registration";
    registration = await registerRun(store, target, identity);

    step = "readback";
    const snapshotQuery = createScienceFlowRunSnapshotQuery({
      identities: store,
      readerConfig: {
        pythonExecutable: request.pythonExecutable,
        readerScriptPath: request.readerScriptPath,
        timeoutMs: SCIENCE_FLOW_RESULT_DELIVERY_READER_TIMEOUT_MS,
      },
      resolveBinding: () => bindingFor(target!, identity),
      ...(dependencies.readSnapshot ? { readSnapshot: dependencies.readSnapshot } : {}),
    });
    const query = await snapshotQuery({ ...identity, runId: target.runId });
    if (query.status !== "ok") {
      throw new DeliveryRefusal("readback-failed", `The run could not be read: ${query.status}`);
    }
    const raw = query.snapshot;
    snapshot = projectScienceFlowRunSnapshot(target.runId, raw);
    runState = { phase: snapshot.run.phase, status: snapshot.run.status };

    step = "resolve";
    selected = selectCandidate(raw, target, snapshot);

    step = "verify";
    const bytes = await readVerifiedCandidate(selected, target);
    selected = { ...selected, bytes: bytes.length };

    // The ledger is small run evidence, not the artifact locator. A missing
    // ledger leaves the note without a stage table instead of failing the
    // delivery, but a ledger that contradicts the selected digest does fail.
    stages = await readStageRows(target.stageLedgerPath);
    const selectedStage = stages.find((row) => row.stageId === selected!.stageId);
    if (selectedStage?.artifactSha256 && selectedStage.artifactSha256 !== selected.artifactSha256) {
      throw new DeliveryRefusal(
        "stage-ledger-conflict",
        "The stage ledger records a different digest for the selected stage",
      );
    }
    const receipt = await readReceiptFacts(target, identity);

    step = "publish-solution";
    const solution = await publishDeliveredArtifact(store, {
      bytes,
      description: `Unchanged solution artifact of ScienceFlow run ${target.runId}, stage ${selected.stageId}`,
      digest: selected.artifactSha256,
      kind: "json",
      mediaType: "application/json",
      logicalName: `scienceflow/${target.runId}/${DELIVERY_OUTPUTS.solution}`,
      originMeta: deliveryOriginMeta(target.runId, selected.stageId, selected.artifactSha256),
      sessionId: identity.sessionId,
      title: `ScienceFlow ${target.runId} solution (${selected.stageId}, ${selected.metricName} ${selected.metricValue})`,
    });
    artifacts.solution = solution;

    step = "publish-note";
    const noteText = buildResultNote({
      identity,
      receipt,
      registration,
      runState,
      selected,
      snapshot,
      solution,
      stages: stages ?? [],
      target,
    });
    const note = await publishDeliveredArtifact(store, {
      bytes: Buffer.from(noteText, "utf8"),
      description: `Delivered result note for ScienceFlow run ${target.runId} (selected stage ${selected.stageId})`,
      digest: undefined,
      inputArtifactVersionIds: [solution.versionId],
      kind: "markdown",
      mediaType: "text/markdown",
      logicalName: `scienceflow/${target.runId}/${DELIVERY_OUTPUTS.note}`,
      originMeta: deliveryOriginMeta(target.runId, selected.stageId, selected.artifactSha256),
      sessionId: identity.sessionId,
      title: `ScienceFlow ${target.runId} result note`,
    });
    artifacts.note = note;

    return {
      artifacts,
      finishedAt: now(),
      identity,
      invocation: "scienceflow-result-delivery",
      outcome: { status: "delivered" },
      registration,
      run: { runId: target.runId, task: target.task },
      runState,
      schemaVersion: SCIENCE_FLOW_RESULT_DELIVERY_VERSION,
      selected,
      snapshot,
      stages,
      startedAt,
    };
  } catch (error) {
    if (error instanceof DeliveryRefusal) return failed(step, error.reason, error.message);
    if (isNotWritable(error)) {
      return failed(
        step,
        "session-not-writable",
        Object.keys(artifacts).length
          ? "The Session became read-only; no further output was published"
          : "The Session is read-only; nothing was published",
      );
    }
    if (step === "publish-solution" || step === "publish-note") {
      return failed(step, "publication-failed", errorMessage(error));
    }
    if (step === "resolve" || step === "verify") {
      // An unexpected file-system error on the selected artifact: the reason is
      // the read, and its message may carry a host path, so it is not copied.
      return failed(step, "candidate-unreadable", "The selected artifact could not be read");
    }
    return failed(step, "readback-failed", errorMessage(error));
  }
}

/** Write one delivery record as JSON, creating its directory when needed. */
export async function writeDeliveryRecord(
  path: string,
  record: ScienceFlowResultDeliveryRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Validate operator options and derive every run-scoped path. Delivery reads
 * the run; it never derives paths from the receipt or from the snapshot.
 */
export function resolveDeliveryTarget(
  request: ScienceFlowResultDeliveryRequest,
): DeliveryTarget {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(request.runId)) {
    throw new DeliveryRefusal(
      "invalid-option",
      "The run id must be 1-64 characters of letters, digits, dot, underscore or hyphen",
    );
  }
  const task = request.task ?? SCIENCE_FLOW_RESULT_DELIVERY_DEFAULT_TASK;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(task)) {
    throw new DeliveryRefusal("invalid-option", "The task id is not a usable engine task name");
  }
  for (const [field, value] of Object.entries({
    workDir: request.workDir,
    pythonExecutable: request.pythonExecutable,
    readerScriptPath: request.readerScriptPath,
  })) {
    if (!isAbsolute(value) || !value.trim()) {
      throw new DeliveryRefusal("invalid-option", `The ${field} must be an absolute path`);
    }
  }
  const workDir = resolve(request.workDir);
  const stateHome = join(workDir, "state");
  return {
    launchReceiptPath: request.launchReceiptPath
      ? resolve(request.launchReceiptPath)
      : join(workDir, "receipt.json"),
    recordPath: request.recordPath
      ? resolve(request.recordPath)
      : join(workDir, "delivery.json"),
    runId: request.runId,
    runRecordPath: join(stateHome, "scienceflow", "managed_runs", request.runId, "control.json"),
    stageLedgerPath: join(workDir, "runs", request.runId, task, "task_logs", "lhr_stage_performance.csv"),
    stateHome,
    task,
    taskRoot: join(workDir, "runs", request.runId, task),
    workDir,
  };
}

/** The trusted binding the readback may use for this one operator run. */
function bindingFor(
  target: DeliveryTarget,
  identity: { readonly projectId: string; readonly sessionId: string },
): ScienceFlowRunBinding {
  return {
    allowedTaskRoots: [target.taskRoot],
    projectId: identity.projectId,
    runId: target.runId,
    runRecordPath: target.runRecordPath,
    sessionId: identity.sessionId,
  };
}

async function registerRun(
  store: SessionStore,
  target: DeliveryTarget,
  identity: { readonly projectId: string; readonly sessionId: string },
): Promise<NonNullable<ScienceFlowResultDeliveryRecord["registration"]>> {
  const registrationService = createScienceFlowRegistrationService({
    identities: store,
    requireWritable: (sessionId) => store.assertSessionWritable(sessionId),
    resolveBinding: () => bindingFor(target, identity),
    store: () => store.scienceFlowRegistrations,
  });
  const registration = await registrationService.create(identity, target.runId);
  if (registration.status === "created" || registration.status === "existing") {
    return {
      createdAt: registration.registration.createdAt,
      registrationId: registration.registration.registrationId,
      status: registration.status,
    };
  }
  throw new DeliveryRefusal(
    "registration-failed",
    registration.status === "not-found"
      ? `The run is not registered for this Session: ${registration.resource}`
      : `The run could not be registered: ${registration.status}`,
  );
}

/**
 * Narrow the reader's snapshot to the selected captured candidate. The reader
 * has already resolved the path inside the allowed roots and hashed the file;
 * every value is re-checked here because these bytes are about to be published.
 */
function selectCandidate(
  raw: ScienceFlowRunSnapshot,
  target: DeliveryTarget,
  dto: ScienceFlowRunSnapshotDto,
): ScienceFlowDeliveredSelection {
  const candidate = raw.tasks[0]?.candidateArtifact;
  const sha256 = candidate && isRecord(candidate) ? candidate.sha256 : undefined;
  const path = candidate && isRecord(candidate) ? candidate.path : undefined;
  if (!candidate || !isRecord(candidate) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)
    || typeof path !== "string" || !path.trim()) {
    throw new DeliveryRefusal(
      "no-candidate",
      "The run has no readable captured candidate to deliver",
    );
  }
  const published = dto.tasks[0]?.candidate;
  if (!published || published.sha256 !== sha256) {
    throw new DeliveryRefusal(
      "stage-ledger-conflict",
      "The public snapshot and the reader disagree about the selected artifact digest",
    );
  }
  if (candidate.digestVerified === false) {
    throw new DeliveryRefusal(
      "candidate-sha-mismatch",
      "The reader recorded a digest mismatch for the selected artifact",
    );
  }
  if (!isAbsolute(path)) {
    throw new DeliveryRefusal("candidate-path-out-of-bounds", "The selected artifact path is not absolute");
  }
  const resolvedPath = resolve(path);
  if (!isWithin(target.taskRoot, resolvedPath)) {
    throw new DeliveryRefusal(
      "candidate-path-out-of-bounds",
      "The selected artifact is outside the run's allowed task root",
    );
  }
  const metricName = candidate.metricName;
  const metricValue = candidate.metricValue;
  const stageId = candidate.stageId;
  if (typeof metricName !== "string" || !metricName.trim()
    || typeof metricValue !== "number" || !Number.isFinite(metricValue)
    || typeof stageId !== "string" || !stageId.trim()) {
    throw new DeliveryRefusal(
      "no-candidate",
      "The selected stage does not carry a usable metric name, value and stage id",
    );
  }
  return {
    artifactSha256: sha256,
    bytes: 0,
    digestVerified: typeof candidate.digestVerified === "boolean" ? candidate.digestVerified : null,
    lowerIsBetter: typeof candidate.lowerIsBetter === "boolean" ? candidate.lowerIsBetter : null,
    metricName,
    metricValue,
    sourcePath: relative(resolve(target.taskRoot), resolvedPath).split(sep).join("/"),
    stageId,
  };
}

/** Read the selected file once; its bytes are the published content. */
async function readVerifiedCandidate(
  selected: ScienceFlowDeliveredSelection,
  target: DeliveryTarget,
): Promise<Buffer> {
  const path = resolve(target.taskRoot, selected.sourcePath);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(target.taskRoot);
    realFile = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DeliveryRefusal("candidate-file-missing", "The selected artifact file is missing");
    }
    throw error;
  }
  if (!isWithin(realRoot, realFile)) {
    throw new DeliveryRefusal(
      "candidate-path-out-of-bounds",
      "The selected artifact resolves outside the run's allowed task root",
    );
  }
  const metadata = await stat(realFile);
  if (!metadata.isFile()) {
    throw new DeliveryRefusal("candidate-file-missing", "The selected artifact is not a file");
  }
  if (metadata.size > MAX_DELIVERY_BYTES) {
    throw new DeliveryRefusal("candidate-too-large", "The selected artifact exceeds the delivery size limit");
  }
  const bytes = await readFile(realFile);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== selected.artifactSha256) {
    throw new DeliveryRefusal(
      "candidate-sha-mismatch",
      "The selected artifact bytes do not match the digest the run recorded",
    );
  }
  return bytes;
}

/**
 * Publish one output through the canonical CAS and Artifact/version catalog.
 * An existing version of the same artifact with identical bytes is returned
 * instead of a duplicate, so repeated delivery and retries are idempotent.
 */
async function publishDeliveredArtifact(
  store: SessionStore,
  input: {
    readonly bytes: Buffer;
    readonly description: string;
    /** The digest the source is required to have; absent for generated text. */
    readonly digest: string | undefined;
    readonly inputArtifactVersionIds?: readonly string[];
    readonly kind: ScientificArtifactKind;
    readonly logicalName: string;
    readonly mediaType: string;
    readonly originMeta: Record<string, string>;
    readonly sessionId: string;
    readonly title: string;
  },
): Promise<ScienceFlowDeliveredArtifact> {
  const session = store.getSession(input.sessionId);
  if (!session) throw new DeliveryRefusal("session-not-found", "The Session does not exist");
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  if (input.digest !== undefined && digest !== input.digest) {
    throw new DeliveryRefusal(
      "candidate-sha-mismatch",
      "The published content does not match the selected artifact digest",
    );
  }
  const content: CasObjectRef = { hash: digest, size: input.bytes.length };

  const existing = store.getArtifactByName(input.sessionId, input.logicalName);
  if (existing) {
    const versions = store.listProjectArtifactVersions(session.projectId, existing.id);
    const match = versions.find((version) =>
      version.content.hash === content.hash && version.content.size === content.size);
    if (match) {
      return {
        artifactId: existing.id,
        content: match.content,
        kind: existing.kind,
        logicalName: input.logicalName,
        mediaType: match.mediaType,
        status: "reused",
        version: match.version,
        versionId: match.id,
      };
    }
  }

  const cas = new CasStore(store.dataDir);
  const stored = await cas.put(input.bytes);
  if (stored.hash !== content.hash || stored.size !== content.size) {
    throw new DeliveryRefusal("publication-failed", "The content store did not retain the delivered bytes");
  }
  const latest = existing
    ? store.listProjectArtifactVersions(session.projectId, existing.id).at(-1)
    : undefined;
  const { artifact, version } = await store.createArtifactVersion({
    ...(existing && latest ? { artifactId: existing.id, baseVersionId: latest.id } : {}),
    content: stored,
    description: input.description,
    ...(input.inputArtifactVersionIds?.length
      ? { inputArtifactVersionIds: [...input.inputArtifactVersionIds] }
      : {}),
    kind: input.kind,
    logicalName: input.logicalName,
    mediaType: input.mediaType,
    origin: "server_generated",
    originMeta: { ...input.originMeta },
    sessionId: input.sessionId,
    title: input.title,
  });
  return {
    artifactId: artifact.id,
    content: version.content,
    kind: artifact.kind,
    logicalName: input.logicalName,
    mediaType: version.mediaType,
    status: "created",
    version: version.version,
    versionId: version.id,
  };
}

function deliveryOriginMeta(
  runId: string,
  stageId: string,
  sourceSha256: string,
): Record<string, string> {
  return {
    deliveredBy: "scienceflow-result-delivery",
    externalEngine: "scienceflow",
    sourceSha256,
    sourceStageId: stageId,
    sourceRunId: runId,
  };
}

interface ReceiptFacts {
  readonly model: {
    readonly profileName: string;
    readonly providerModel: string;
    readonly selectionSource: string;
  } | null;
  readonly stoppedByAllowance: boolean | null;
  readonly elapsedSec: number | null;
}

/**
 * Read the operator receipt for facts only: the frozen model identity and the
 * launch lifecycle. The receipt is not the artifact locator, and it is used
 * only when it names this exact Project, Session and run.
 */
async function readReceiptFacts(
  target: DeliveryTarget,
  identity: { readonly projectId: string; readonly sessionId: string },
): Promise<ReceiptFacts> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target.launchReceiptPath, "utf8"));
  } catch {
    return { elapsedSec: null, model: null, stoppedByAllowance: null };
  }
  if (!isRecord(parsed)) return { elapsedSec: null, model: null, stoppedByAllowance: null };
  const recordedIdentity = parsed.identity;
  const engine = parsed.engine;
  if (!isRecord(recordedIdentity) || !isRecord(engine)
    || recordedIdentity.projectId !== identity.projectId
    || recordedIdentity.sessionId !== identity.sessionId
    || engine.runId !== target.runId) {
    return { elapsedSec: null, model: null, stoppedByAllowance: null };
  }
  const model = isRecord(parsed.model)
    ? (() => {
        const profileName = safeFact(parsed.model!.profileName);
        const providerModel = safeFact(parsed.model!.providerModel);
        const selectionSource = safeFact(parsed.model!.selectionSource);
        return profileName && providerModel && selectionSource
          ? { profileName, providerModel, selectionSource }
          : null;
      })()
    : null;
  const launch = isRecord(parsed.launch) ? parsed.launch : undefined;
  return {
    elapsedSec: launch && typeof launch.elapsedSec === "number" && Number.isFinite(launch.elapsedSec)
      ? launch.elapsedSec
      : null,
    model,
    stoppedByAllowance: launch && typeof launch.stoppedByAllowance === "boolean"
      ? launch.stoppedByAllowance
      : null,
  };
}

/**
 * The factual result note. It is generated from the readback and the engine's
 * ledger only: no host paths, credentials or model interpretation. A later
 * Agent reading of it is separate from this text.
 */
function buildResultNote(input: {
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly receipt: ReceiptFacts;
  readonly registration: NonNullable<ScienceFlowResultDeliveryRecord["registration"]>;
  readonly runState: NonNullable<ScienceFlowResultDeliveryRecord["runState"]>;
  readonly selected: ScienceFlowDeliveredSelection;
  readonly snapshot: ScienceFlowRunSnapshotDto;
  readonly solution: ScienceFlowDeliveredArtifact;
  readonly stages: readonly ResearchPilotStageRow[];
  readonly target: DeliveryTarget;
}): string {
  const { identity, receipt, registration, runState, selected, solution, stages, target } = input;
  const lines: string[] = [];
  const direction = selected.lowerIsBetter === true
    ? "lower is better"
    : selected.lowerIsBetter === false
      ? "higher is better"
      : "direction not recorded";

  lines.push(`# ScienceFlow research result: \`${target.runId}\``, "");
  lines.push(
    "This Session holds the delivered output of one **external ScienceFlow managed run**.",
    "ScienceDiscovery did not start or evaluate this experiment, and this note is a factual",
    "delivery record, not a model interpretation of it.",
    "",
    "## Task and identity",
    "",
    `- Engine task: \`${target.task}\`${taskDescription(target.task)}.`,
    `- Metric: \`${codeText(selected.metricName)}\`, ${direction}.`,
    `- SD Project / Session: \`${identity.projectId}\` / \`${identity.sessionId}\`.`,
    `- ScienceFlow run: \`${target.runId}\`; SD registration \`${registration.registrationId}\`.`,
    receipt.model
      ? `- Model that produced the candidates: \`${receipt.model.providerModel}\` (SD profile "${receipt.model.profileName}", source layer \`${receipt.model.selectionSource}\`), as recorded in the run's operator launch receipt.`
      : "- Model that produced the candidates: not recorded in an operator receipt.",
    `- Run state: status \`${runState.status}\`, phase \`${runState.phase}\`.${lifecycleSentence(receipt)}`,
    "- The engine's task-package evaluator is the only authoritative score source for these stages.",
    "",
  );

  if (stages.length) {
    lines.push(
      "## Evaluated stages",
      "",
      "| Stage | Parent | Origin | " + cell(selected.metricName) + " | Artifact sha256 | Evaluator | Gate | Captured (UTC) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const stage of stages) {
      lines.push([
        `| ${cell(stage.stageId)}`,
        cell(stage.parentStageId),
        stage.parentStageId ? "new candidate" : "carried-in seed (first stage)",
        formatNumber(stage.metricValue),
        `\`${cell(stage.artifactSha256)}\``,
        cell(stage.evaluatorStatus),
        `${stage.gateAccepted ? "accepted" : "not accepted"}${stage.validationOk ? " / valid" : " / not valid"}`,
        cell(stage.createdAtUtc),
      ].join(" | ") + " |");
    }
    lines.push(
      "",
      "The pilot starts every run from a carried-in seed artifact, so the stage with no parent",
      "reproduces carried work rather than a new model candidate. Each later stage is a new",
      "candidate produced after the engine returned the previous stage's evaluated metric to the",
      "model; parent links and timestamps above are the engine's own stage ledger.",
      "",
    );
  } else {
    lines.push(
      "## Evaluated stages",
      "",
      "The engine's stage ledger was not readable for this run, so only the selected stage below",
      "is documented.",
      "",
    );
  }

  lines.push(
    "## Selected solution",
    "",
    `- Selected stage: \`${codeText(selected.stageId)}\`, \`${codeText(selected.metricName)}\` = \`${formatNumber(selected.metricValue)}\`.`,
    `- Delivered artifact: \`${solution.logicalName}\` version ${solution.version} (artifact \`${solution.artifactId}\`, version \`${solution.versionId}\`).`,
    `- Content sha256: \`${solution.content.hash}\` (${solution.content.size} bytes).`,
    `- This is the digest the engine recorded for the stage and the digest the ScienceDiscovery reader recomputed from the selected snapshot file (digest verified: ${selected.digestVerified === true ? "yes" : "not confirmed"}); the delivered bytes are unchanged.`,
    "",
    "## Comparison",
    "",
  );
  const comparison = stageComparisons(stages);
  if (comparison.length) {
    for (const line of comparison) lines.push(`- ${line}`);
  } else {
    lines.push("- Only one stage is recorded, so there is no stage-to-stage comparison to report.");
  }
  lines.push(
    `- The selection is the best captured stage in the engine's ledger: evaluated candidates that were not captured as stages are not represented here.`,
    "",
    "## Limits",
    "",
    "- One bounded run: one worker, CPU only, one task package. This is not a benchmark campaign.",
    "- The score is the engine's recorded metric. ScienceDiscovery re-read the selected artifact's bytes and digest but did not independently re-evaluate the solution.",
    `- The run ended \`${runState.status}\`${runState.phase === "finished" ? " with its phase finished" : ""}; this is not an independently validated research record.`,
    "- No benchmark, optimum or scientific-record claim is made by this note.",
    "",
    "## Proposed next experiment (not run)",
    "",
    `- Start one new bounded pilot run on the same task and evaluator, seeded with this delivered solution, with one CPU worker and the same research allowance.`,
    `- Evaluation criterion: accept a new captured candidate only when the engine's evaluator reports \`ok\`, the gate accepts it, the solution is valid, and \`${codeText(selected.metricName)}\` improves on \`${formatNumber(selected.metricValue)}\` by at least \`${formatThreshold(proposedMargin(stages))}\` (target \`${formatThreshold(selected.metricValue + proposedMargin(stages))}\`) — twice the largest stage-to-stage step observed in this run.`,
    "- If the allowance ends without such a candidate, report that no improvement was observed rather than a new best.",
    "- This experiment has not been run; every number above comes from the single delivered run.",
    "",
  );
  return `${lines.join("\n")}`;
}

function taskDescription(task: string): string {
  const description = TASK_DESCRIPTIONS[task];
  return description ? ` — ${description}` : "";
}

function lifecycleSentence(receipt: ReceiptFacts): string {
  if (receipt.stoppedByAllowance === true) {
    const elapsed = receipt.elapsedSec === null ? "" : ` after ${receipt.elapsedSec} s`;
    return ` The operator's wall-clock allowance stopped it${elapsed}; the run did not end on its own research budget.`;
  }
  if (receipt.stoppedByAllowance === false) {
    return " The operator receipt did not attribute the end of the run to its wall-clock allowance.";
  }
  return "";
}

function stageComparisons(stages: readonly ResearchPilotStageRow[]): string[] {
  const lines: string[] = [];
  for (let index = 1; index < stages.length; index += 1) {
    const before = stages[index - 1]!;
    const after = stages[index]!;
    lines.push(`${cell(after.stageId)} vs ${cell(before.stageId)}: ${signed(after.metricValue - before.metricValue)} (${percentChange(before.metricValue, after.metricValue)})`);
  }
  const first = stages[0];
  const last = stages.at(-1);
  if (first && last && stages.length > 2) {
    lines.push(`${last.stageId} vs ${first.stageId}: ${signed(last.metricValue - first.metricValue)} (${percentChange(first.metricValue, last.metricValue)})`);
  }
  return lines;
}

/**
 * A required improvement of twice the largest observed step, so a proposed
 * experiment cannot mistake evaluator noise for progress. A run without a
 * ledger keeps a small absolute floor instead of claiming a measured step.
 */
function proposedMargin(stages: readonly ResearchPilotStageRow[]): number {
  const steps = stages.slice(1).map((stage, index) => Math.abs(stage.metricValue - stages[index]!.metricValue));
  return Math.max(1e-3, steps.length ? Math.max(...steps) * 2 : 0);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${Number(value.toPrecision(12))}`;
}

function percentChange(before: number, after: number): string {
  if (before === 0) return "change not computable";
  return `${((after - before) / Math.abs(before) * 100).toFixed(4)}%`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "not recorded";
}

/** A proposal threshold: six significant digits is a criterion, not a measurement. */
function formatThreshold(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "not recorded";
}

/**
 * Operator-recorded text that may be published: one short line, with no
 * markdown or host-path shape that could forge a line or leak an address. An
 * unusable value is dropped rather than repaired.
 */
function safeFact(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const singleLine = value.replace(/[\r\n\t]+/gu, " ").trim();
  if (!singleLine || singleLine.length > 120) return undefined;
  if (/[|`]/u.test(singleLine) || singleLine.includes("://")) return undefined;
  if (singleLine.startsWith("/") || singleLine.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(singleLine)) return undefined;
  return singleLine;
}

/** One markdown table cell: the values are engine-ledger text, never trusted markup. */
function cell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const singleLine = value.replace(/[\r\n\t]+/gu, " ").replace(/\|/gu, "\\|").trim();
  return singleLine || "—";
}

/** Inline code text for prose: no newline or backtick can break the span. */
function codeText(value: string): string {
  return cell(value).replace(/`/gu, "'");
}

function assertWritable(store: SessionStore, sessionId: string): void {
  try {
    store.assertSessionWritable(sessionId);
  } catch (error) {
    throw new DeliveryRefusal(
      "session-not-writable",
      errorMessage(error) || "The Session cannot accept new artifacts",
    );
  }
}

/** A locked/archived Session keeps its established error, never a generic one. */
function isNotWritable(error: unknown): boolean {
  return error instanceof Error && (error.name === "SessionEvidenceLockedError"
    || error.message === "Session is archived and read-only");
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
