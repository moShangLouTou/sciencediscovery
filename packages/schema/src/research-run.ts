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
 * The internal, discriminated research-workload contract.
 *
 * This is not a public start interface. A research run names a fixed workload
 * the Runner already owns; the request carries no shell text, no executable,
 * no module, no script, no environment variable and no host source path. The
 * program itself comes from trusted Runner code, so the only thing a caller
 * chooses is which identity the run is accepted under and how long each phase
 * may take.
 *
 * Three facts stay separate and must never be collapsed into one another:
 * `execution` (the ledger record), `research` (what the fixed workload reported
 * about its own business phase) and `report` (the publication record). A
 * process exit code is an operating-system fact, not a research result.
 */
import type { PermissionEpoch } from "./permission.js";


export const RESEARCH_RUN_SCHEMA_VERSION = 1;

/** A business id resolved only through the Runner's trusted workload registry. */
export type ResearchWorkloadKind = string;

/**
 * The input evidence bundle one new research execution is bound to.
 *
 * Both digests are chosen by the trusted internal caller from a frozen plan; a
 * request can never name a bundle root, a mount path, a file list, replacement
 * bytes, a command, an interpreter or an environment. The Runner verifies the
 * named bundle against its own content-addressed store before anything is
 * launched, so this is an identity to check, not a locator to trust.
 */
export interface ResearchInputIdentity {
  readonly contractDigest: string;
  readonly bundleDigest: string;
}

/** One verified byte set, in canonical manifest order. */
export interface ResearchInputFileEvidence {
  /** Logical bundle path: never a host path. */
  readonly path: string;
  readonly roles: readonly string[];
  readonly size: number;
  readonly sha256: string;
}

/**
 * What the ledger knows about a run's inputs.
 *
 * `declared` is the caller's claim, recorded at acceptance. `verified` means
 * this Runner instance opened the bundle itself, re-derived its identity from
 * the canonical manifest, read every byte through a descriptor it held and
 * materialized the execution's private copy. A spawned execution must reach
 * `verified`; the declaration alone is never published as a consumed input.
 */
export type ResearchInputState = "declared" | "verified";

export interface ResearchInputEvidence extends ResearchInputIdentity {
  readonly state: ResearchInputState;
  /** Present only for `verified`: the exact set this execution reads. */
  readonly files?: readonly ResearchInputFileEvidence[];
}

/**
 * Bounded monotonic schedule for one run.
 *
 * All values are milliseconds and are validated without clamping: an
 * out-of-range value refuses the submission instead of being adjusted, because
 * a silently shortened research budget is a different run than the one asked
 * for.
 */
export interface ResearchTimeSchedule {
  /** Research phase budget, counted from the spawn instant. */
  readonly researchBudgetMs: number;
  /** Reporting phase budget that follows a completed research phase. */
  readonly reportBudgetMs: number;
  /** Drain allowance between the two phases' budgets. */
  readonly drainGraceMs: number;
  /**
   * Window reserved before the hard deadline for proving the namespace empty.
   * `forceKillAt = hardDeadline - verificationWindowMs`.
   */
  readonly verificationWindowMs: number;
  /** Grace from a stop request until the namespace is force-reclaimed. */
  readonly stopGraceMs: number;
}

/**
 * One trusted internal research submission.
 *
 * Identity fields are binding only: this round stores and compares them, it
 * does not re-derive the workspace key, permission epoch, or environment
 * revision from their producers. A submission that names a runtime state root
 * or a control-file location is not representable on purpose — both are
 * derived from the execution id inside the Runner.
 */
export interface ResearchRunRequest {
  readonly kind: "research";
  readonly schemaVersion: typeof RESEARCH_RUN_SCHEMA_VERSION;
  readonly workload: ResearchWorkloadKind;
  readonly executionId: string;
  readonly agentId: string;
  readonly permissionEpoch: PermissionEpoch;
  readonly workspaceRoot: string;
  readonly runnerWorkspaceKey?: string;
  /**
   * Managed environment leased for the whole workload. The production internal
   * contract requires it: a request without one is refused before any process
   * exists, and the system interpreter is never used as a fallback. A test
   * wiring may name a fixture runtime instead, and the run then records that
   * fixture identity instead of pretending a managed revision was leased.
   */
  readonly environmentId?: string;
  /**
   * Revision the caller believes is current; a mismatch is refused, never
   * re-pointed. Supplying it without an `environmentId` is a refusal too: there
   * is no revision to compare against and no fallback interpreter is chosen.
   */
  readonly expectedEnvironmentRevisionId?: string;
  readonly npuDevices?: number[];
  readonly maxOutputBytes?: number;
  readonly maxWorkspaceBytes?: number;
  /**
   * The prepared-input bundle this execution consumes. Optional only so records
   * and requests written before input consumption existed keep their meaning; a
   * new execution without it is refused before anything reaches the ledger.
   */
  readonly inputs?: ResearchInputIdentity;
  readonly schedule: ResearchTimeSchedule;
}

/**
 * Operating-system facts about the workload process, never a business result.
 *
 * `spawned` is the live fact: the process exists and its termination is not yet
 * proven. It is recorded as soon as the sandbox is created and is replaced by
 * `spawned-then-terminated` or `unverified` when the operation returns. It is
 * never publishable, so a record read mid-run cannot be mistaken for a result.
 */
export type ResearchProcessEvidence = "not_started" | "spawned" | "spawned-then-terminated" | "unverified";

/** Business phases the fixed workload may report about itself. */
export type ResearchPhase = "research" | "reporting" | "finished";

/**
 * What the workload reported about its reporting phase, kept apart from the
 * research outcome. A stopped or failed report never erases a completed
 * research phase: `research: completed` + `report: incomplete` is the truthful
 * description of a run that finished research and was stopped while writing.
 */
export type ResearchReportOutcome = "none" | "generating" | "ready" | "incomplete" | "failed" | "unknown";

/**
 * Research outcomes. `not-started` requires a positive pre-research record:
 * it is never inferred from a missing one. `unknown` is terminal for the
 * control plane and keeps every resource fence.
 */
export type ResearchOutcome = "not-started" | "completed" | "stopped" | "failed" | "unknown";

/** What the Runner knows about the stop channel; `unconfirmed` keeps fences. */
export type ResearchStopState = "none" | "requested" | "consumed" | "unconfirmed";

/** Fixed refusal vocabulary. No other code may reach a persisted record. */
export const RESEARCH_REFUSAL_CODES = [
  "RESEARCH_RUN_NOT_CONFIGURED",
  "RESEARCH_REQUEST_INVALID",
  "RESEARCH_SCHEDULE_INVALID",
  "RESEARCH_WORKLOAD_UNKNOWN",
  "RESEARCH_STATE_ROOT_UNSAFE",
  "RESEARCH_CONTROL_OPEN_FAILED",
  "RESEARCH_CONTROL_REPLACED",
  "RESEARCH_CONTROL_WRITE_FAILED",
  "RESEARCH_RECORD_MISSING",
  "RESEARCH_RECORD_OVERSIZE",
  "RESEARCH_RECORD_MALFORMED",
  "RESEARCH_RECORD_VERSION_UNKNOWN",
  "RESEARCH_RECORD_IDENTITY_MISMATCH",
  "RESEARCH_RECORD_TRANSITION_INVALID",
  "RESEARCH_STOP_NOT_DURABLE",
  "RESEARCH_ENVIRONMENT_REQUIRED",
  "RESEARCH_STATE_SAVE_FAILED",
  "RESEARCH_ENVIRONMENT_UNAVAILABLE",
  "RESEARCH_ENVIRONMENT_REVISION_MISMATCH",
  "RESEARCH_SANDBOX_UNSUPPORTED",
  "RESEARCH_LAUNCH_FAILED",
  "RESEARCH_INPUT_REQUIRED",
  "RESEARCH_INPUT_UNAVAILABLE",
  "RESEARCH_INPUT_COPY_FAILED",
  "RESEARCH_ENGINE_NOT_CONFIGURED",
  "RESEARCH_ENGINE_UNAVAILABLE",
  "RESEARCH_ENGINE_IDENTITY_MISMATCH",
  "RESEARCH_ENGINE_CONTRACT_UNSUPPORTED",
] as const;
export type ResearchRefusalCode = typeof RESEARCH_REFUSAL_CODES[number];

/**
 * The engine run one execution created, as the fixed bridge reported it.
 *
 * The engine's own run id and attempt are recorded next to, never in place of,
 * the execution id: they name the managed record the patched engine wrote, and
 * the association is persisted with the run. The engine's launch token is not
 * part of this evidence.
 */
export interface ResearchEngineEvidence {
  readonly engineRunId: string;
  readonly engineId?: string;
  /** Optional execution provenance; older records keep these exact fields. */
  readonly attempt?: number;
  readonly revision?: string;
  readonly version?: string;
  readonly derivedManifestDigest?: string;
  readonly mappingVersion?: number;
}

/**
 * The additive, host-free projection of one research run.
 *
 * It carries no path, no pid, no control-file body, no workload stderr and no
 * arbitrary exception text: everything here is from the fixed vocabulary above
 * plus timestamps and the validation window the Runner used.
 */
export interface ResearchRunStatus {
  readonly workload: ResearchWorkloadKind;
  readonly schemaVersion: typeof RESEARCH_RUN_SCHEMA_VERSION;
  readonly phase: ResearchPhase | "unknown";
  /** What the research phase itself reported; independent of `report`. */
  readonly outcome: ResearchOutcome | null;
  /** What the reporting phase reported; independent of `outcome`. */
  readonly report: ResearchReportOutcome;
  readonly process: ResearchProcessEvidence;
  readonly stop: ResearchStopState;
  /**
   * Why the first durable stop intent was persisted. It is stored with the
   * intent, so a record rebuilt after a restart still says whether a person or
   * the schedule asked for the stop; it never overrides the termination facts.
   */
  readonly stopCause?: "user" | "budget";
  /**
   * The schedule that actually governed the run, persisted with the record so
   * an observer never has to reconstruct the deadlines from a request it does
   * not hold. It is the validated schedule, never a clamped one.
   */
  readonly schedule: ResearchTimeSchedule;
  /** Wall-clock spawn instant; the monotonic base is `t0` inside the run. */
  readonly spawnedAt?: string;
  /**
   * True when the budget was spent and the namespace had to be force-reclaimed
   * instead of the workload stopping itself. It records that a reclaim was
   * *requested*; it is not by itself a deadline violation.
   */
  readonly forceReclaimRequested: boolean;
  /**
   * True only when termination was **not proven inside the hard deadline**. It
   * is decided by the proof instant, so a user-caused reclaim that is proven on
   * time is false and a budget reclaim proven on time is false too.
   */
  readonly deadlineViolated: boolean;
  /** Poll bound the Runner used before declaring the boundary unproven. */
  readonly verificationWindowMs: number;
  /**
   * The input identity this run was accepted under and, once this instance has
   * checked the bundle and materialized the execution's copy, the verified file
   * set. Absent on records written before input consumption existed.
   */
  readonly inputs?: ResearchInputEvidence;
  /**
   * The engine's own managed run this execution created. Present only when the
   * fixed bridge created one and reported it; it binds the two identities
   * without letting either stand in for the other.
   */
  readonly engine?: ResearchEngineEvidence;
  readonly refusal?: ResearchRefusalCode;
  readonly observedAt: string;
}
