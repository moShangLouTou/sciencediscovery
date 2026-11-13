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

/** Workloads the Runner may run. One fixed workload exists; nothing is generic. */
export const RESEARCH_WORKLOAD_KINDS = ["scienceflow-fixed"] as const;
export type ResearchWorkloadKind = typeof RESEARCH_WORKLOAD_KINDS[number];

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
  /** Managed environment leased for the whole workload; absent means system Python. */
  readonly environmentId?: string;
  /** Revision the caller believes is current; a mismatch is refused, never re-pointed. */
  readonly expectedEnvironmentRevisionId?: string;
  readonly npuDevices?: number[];
  readonly maxOutputBytes?: number;
  readonly maxWorkspaceBytes?: number;
  readonly schedule: ResearchTimeSchedule;
}

/** Operating-system facts about the workload process, never a business result. */
export type ResearchProcessEvidence = "not_started" | "spawned-then-terminated" | "unverified";

/** Business phases the fixed workload may report about itself. */
export type ResearchPhase = "research" | "reporting" | "finished";

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
  "RESEARCH_RECORD_OVERSIZE",
  "RESEARCH_RECORD_MALFORMED",
  "RESEARCH_RECORD_VERSION_UNKNOWN",
  "RESEARCH_ENVIRONMENT_UNAVAILABLE",
  "RESEARCH_ENVIRONMENT_REVISION_MISMATCH",
  "RESEARCH_SANDBOX_UNSUPPORTED",
  "RESEARCH_LAUNCH_FAILED",
] as const;
export type ResearchRefusalCode = typeof RESEARCH_REFUSAL_CODES[number];

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
  readonly outcome: ResearchOutcome | null;
  readonly process: ResearchProcessEvidence;
  readonly stop: ResearchStopState;
  /**
   * True when the run's budget was spent and the namespace had to be
   * force-reclaimed instead of the workload stopping itself. It records what
   * actually happened, not merely that a deadline existed.
   */
  readonly deadlineViolated: boolean;
  /** Poll bound the Runner used before declaring the boundary unproven. */
  readonly verificationWindowMs: number;
  readonly refusal?: ResearchRefusalCode;
  readonly observedAt: string;
}
