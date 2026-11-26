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
 * The explicit ScienceFlow runtime identity check.
 *
 * One immutable plan, one administrator-declared binding, one Runner probe. The
 * service revalidates the same trusted gates as a preflight: Project/Session
 * ownership, write permission, the plan's current profile and binding, and the
 * Session's runner selection. The Runner call may await, so everything that can
 * vanish while it runs is checked again before a result is stored.
 *
 * The stored result is evidence, never an authorization: `canStart` stays false
 * and the check answers only where the selected environment would resolve
 * ScienceFlow from, and at which revision. Each request reserves its generation
 * atomically before contacting the Runner and writes conditionally on it, so
 * overlapping checks cannot share a generation and an older result can never
 * replace a newer fact. A check that fails or is superseded leaves the last
 * valid row intact as history.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
  SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowRuntimeCheckCode,
  type ScienceFlowRuntimeCheckDto,
  type ScienceFlowRuntimeCheckStateDto,
  type ScienceFlowRuntimeProbeRequest,
  type ScienceFlowRuntimeProbeResult,
  type ScienceFlowRuntimeSourceKind,
} from "@sciencediscovery/schema";

import type { ScienceFlowExecutionPlanIdentity } from "./execution-plan.js";
import {
  ScienceFlowExecutionPlanCorruptError,
  type ScienceFlowExecutionPlanStore,
  type ScienceFlowStoredExecutionPlan,
} from "./execution-plan-repository.js";
import { isUsableIdentity } from "./http.js";
import type { ScienceFlowIdentityStore } from "./run-snapshot.js";
import {
  canonicalRuntimeChecks,
  isScienceFlowRuntimeSourceKind,
  isVerifiedRuntimeCheck,
  runtimeCheckChecksDto,
  SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
} from "./runtime-check-dto.js";
import {
  ScienceFlowRuntimeCheckCorruptError,
  runtimeCheckState,
  type ScienceFlowRuntimeCheckStore,
} from "./runtime-check-repository.js";
import type { ScienceFlowExecutionSettings } from "./execution-config.js";
import {
  SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS,
  type ScienceFlowRuntimeBinding,
  type ScienceFlowRuntimeSettings,
} from "./runtime-config.js";

/** What the service needs from a signed Runner client; satisfied structurally. */
export interface ScienceFlowRuntimeCheckRunner {
  scienceFlowRuntimeCheck(
    request: ScienceFlowRuntimeProbeRequest,
    signal?: AbortSignal,
  ): Promise<ScienceFlowRuntimeProbeResult>;
}

export interface ScienceFlowRuntimeCheckDependencies {
  /** Minimal read-only identity store: `getProject`/`getSession`. */
  readonly identities: ScienceFlowIdentityStore;
  /** The existing write constraint (`store.assertSessionWritable`); may throw. */
  readonly requireWritable: (sessionId: string) => unknown;
  /**
   * True only when the Session may use the binding's Runner. The store's own
   * `assertSessionAllowsRunner` is wrapped here so a refusal becomes a fixed
   * answer instead of an internal error.
   */
  readonly runnerAllowed: (sessionId: string, runnerId: string) => boolean;
  /** Administrator profiles; undefined when the execution feature is off. */
  readonly profiles?: ScienceFlowExecutionSettings;
  /** Administrator runtime bindings; undefined when the check feature is off. */
  readonly runtime?: ScienceFlowRuntimeSettings;
  readonly plans: () => ScienceFlowExecutionPlanStore;
  readonly store: () => ScienceFlowRuntimeCheckStore;
  /** Runner selection: local client, otherwise the connected remote Runner. */
  readonly runnerFor: (runnerId: string) => ScienceFlowRuntimeCheckRunner;
  readonly generateRequestId?: () => string;
}

export type ScienceFlowRuntimeCheckRunResult =
  | { readonly status: "ok"; readonly check: ScienceFlowRuntimeCheckDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  /** The feature is off, or the plan's profile/binding was withdrawn. */
  | { readonly status: "disabled" }
  /** The selected Session does not allow the binding's Runner. */
  | { readonly status: "runner-denied" }
  | { readonly status: "invalid"; readonly reason: "query" }
  /** No fact was established; nothing was persisted. */
  | { readonly status: "unavailable" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowRuntimeCheckReadResult =
  | { readonly status: "ok"; readonly state: ScienceFlowRuntimeCheckStateDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export interface ScienceFlowRuntimeCheckService {
  /** Run one check now and persist its result. */
  check(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowRuntimeCheckRunResult>;
  /** The latest stored result, or none; never contacts a Runner. */
  latest(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowRuntimeCheckReadResult>;
}

export function createScienceFlowRuntimeCheckService(
  dependencies: ScienceFlowRuntimeCheckDependencies,
): ScienceFlowRuntimeCheckService {
  const generateRequestId =
    dependencies.generateRequestId ?? (() => randomUUID());

  function missingIdentity(
    query: ScienceFlowExecutionPlanIdentity,
  ):
    | { status: "not-found"; resource: "project" | "session" }
    | undefined {
    if (!dependencies.identities.getProject(query.projectId)) {
      return { status: "not-found", resource: "project" };
    }
    const session = dependencies.identities.getSession(query.sessionId);
    // A Session in another Project is reported exactly like a missing one.
    if (!session || session.projectId !== query.projectId) {
      return { status: "not-found", resource: "session" };
    }
    return undefined;
  }

  return {
    async check(query, planId) {
      if (!isIdentity(query) || !isBoundedIdentity(planId)) {
        return { status: "invalid", reason: "query" };
      }
      const profiles = dependencies.profiles;
      const runtime = dependencies.runtime;
      if (profiles === undefined || runtime === undefined) {
        return { status: "disabled" };
      }
      const missing = missingIdentity(query);
      if (missing) return missing;
      // A check is persisted, so it is a write: gate before the read, and again
      // after the Runner's await.
      dependencies.requireWritable(query.sessionId);

      let stored: ScienceFlowStoredExecutionPlan | undefined;
      try {
        stored = dependencies.plans().get(query.projectId, query.sessionId, planId);
      } catch (error) {
        return mapFailure(error);
      }
      if (!stored) return { status: "not-found", resource: "plan" };
      const profile = profiles.profileFor(stored.plan.profileId);
      // The plan's profile was withdrawn from the current configuration. The
      // record stays readable; a new check is unavailable, with no fallback.
      if (profile === undefined) return { status: "disabled" };
      const binding =
        profile.runtimeBindingId === undefined
          ? undefined
          : runtime.bindingFor(profile.runtimeBindingId);
      if (binding === undefined) return { status: "disabled" };
      if (!dependencies.runnerAllowed(query.sessionId, binding.runnerId)) {
        return { status: "runner-denied" };
      }

      // The generation is reserved atomically before the await. Two overlapping
      // requests therefore get distinct integers, and the conditional write
      // below only lets the newer one replace the stored row.
      let generation: number;
      try {
        generation = dependencies
          .store()
          .allocate(query.projectId, query.sessionId, planId);
      } catch (error) {
        return mapFailure(error);
      }

      // The frozen plan is the authority on the declared revision. A profile
      // edited later cannot retroactively change what this plan declared.
      const declaredRevision = stored.plan.contract.scienceflow.declaredRevision;
      const request: ScienceFlowRuntimeProbeRequest = Object.freeze({
        schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
        requestId: generateRequestId(),
        bindingId: binding.runnerBindingId,
        environmentId: binding.environmentId,
        expectedEnvironmentRevisionId: binding.expectedEnvironmentRevisionId,
        expectedRevision: declaredRevision,
      });
      const bindingDigest = digestRuntimeBinding({
        planId,
        contractDigest: stored.plan.contractDigest,
        profileId: stored.plan.profileId,
        declaredRevision,
        binding,
      });

      let answer: ScienceFlowRuntimeProbeResult;
      try {
        const runner = dependencies.runnerFor(binding.runnerId);
        answer = await runWithTimeout(runner, request, binding.timeoutMs);
      } catch {
        // Transport failure, an abort, or a disconnected remote Runner. No fact
        // was established, so nothing is persisted.
        return { status: "unavailable" };
      }

      // The await can span a Session deletion or a runner-selection change.
      const vanished = missingIdentity(query);
      if (vanished) return vanished;
      dependencies.requireWritable(query.sessionId);
      if (!dependencies.runnerAllowed(query.sessionId, binding.runnerId)) {
        return { status: "runner-denied" };
      }

      const evidence = parseProbeEvidence(answer, request, binding);
      if (evidence === null) return { status: "unavailable" };

      const check: ScienceFlowRuntimeCheckDto = Object.freeze({
        schemaVersion: SCIENCE_FLOW_RUNTIME_CHECK_DTO_VERSION,
        planId,
        contractDigest: stored.plan.contractDigest,
        bindingDigest,
        runnerId: binding.runnerId,
        environmentId: binding.environmentId,
        environmentRevisionId: evidence.environmentRevisionId,
        checkedAt: evidence.checkedAt,
        outcome: evidence.outcome,
        canStart: false as const,
        sourceKind: evidence.sourceKind,
        sourceRevision: evidence.sourceRevision,
        checks: runtimeCheckChecksDto(evidence.checks),
        unknowns: SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
        generation,
      });

      try {
        const { saved, stored: persisted } = dependencies
          .store()
          .save({
            projectId: query.projectId,
            sessionId: query.sessionId,
            generation,
            check,
          });
        if (saved) return { status: "ok", check };
        if (persisted && persisted.generation > generation) {
          // A strictly newer check already recorded the current fact. Returning
          // it is honest — the DTO's generation shows it is not this request's
          // observation. An older row is never returned as this request's
          // success.
          return { status: "ok", check: persisted.check };
        }
        if (!persisted) {
          // The Session or Project was deleted while this check ran; nothing is
          // resurrected.
          return { status: "not-found", resource: "session" };
        }
        // A newer check is in flight (or failed) and no newer fact exists yet.
        // This request's evidence was discarded rather than presented as the
        // latest result; the stored row stays as the last valid history.
        return { status: "unavailable" };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async latest(query, planId) {
      if (!isIdentity(query) || !isBoundedIdentity(planId)) {
        return { status: "invalid", reason: "query" };
      }
      const missing = missingIdentity(query);
      if (missing) return missing;
      try {
        // The plan must exist; a row without one is never served.
        if (!dependencies.plans().get(query.projectId, query.sessionId, planId)) {
          return { status: "not-found", resource: "plan" };
        }
        const stored = dependencies
          .store()
          .latest(query.projectId, query.sessionId, planId);
        return { status: "ok", state: runtimeCheckState(planId, stored) };
      } catch (error) {
        return mapFailure(error);
      }
    },
  };
}

// --- evidence --------------------------------------------------------------

interface ProbeEvidence {
  readonly checkedAt: string;
  readonly outcome: "verified" | "blocked";
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  readonly sourceRevision: string | null;
  readonly environmentRevisionId: string | null;
  readonly checks: readonly {
    readonly code: ScienceFlowRuntimeCheckCode;
    readonly status: ScienceFlowPlanCheckStatus;
  }[];
}

/**
 * Validate one Runner answer. It is untrusted JSON: only the fixed shape is
 * read, the echo must match the request, and the outcome must follow from the
 * reported checks. Anything else is a protocol difference, never a check that
 * happened to fail.
 */
function parseProbeEvidence(
  answer: ScienceFlowRuntimeProbeResult,
  request: ScienceFlowRuntimeProbeRequest,
  binding: ScienceFlowRuntimeBinding,
): ProbeEvidence | null {
  if (typeof answer !== "object" || answer === null) return null;
  const value = answer as unknown as Readonly<Record<string, unknown>>;
  if (value.schemaVersion !== SCIENCE_FLOW_RUNTIME_PROBE_VERSION) return null;
  if (
    value.requestId !== request.requestId ||
    value.bindingId !== request.bindingId ||
    value.environmentId !== request.environmentId
  ) {
    return null;
  }
  if (value.outcome !== "verified" && value.outcome !== "blocked") return null;
  const checkedAt = value.checkedAt;
  if (!isTimestamp(checkedAt)) return null;
  const sourceKind = value.sourceKind;
  if (!isScienceFlowRuntimeSourceKind(sourceKind)) return null;
  // The probe names the observed HEAD `revision`; the stored result calls it
  // `sourceRevision` so the two never read alike.
  const revision = value.revision;
  if (revision !== null && !isRevision(revision)) return null;
  const environmentRevisionId = value.environmentRevisionId;
  if (environmentRevisionId !== null) {
    // The Runner reports a revision id only for the environment it leased; a
    // different one cannot be evidence about the configured environment.
    if (
      typeof environmentRevisionId !== "string" ||
      environmentRevisionId !== binding.expectedEnvironmentRevisionId
    ) {
      return null;
    }
  }
  const checks = canonicalRuntimeChecks(value.checks);
  if (checks === null) return null;
  if (isVerifiedRuntimeCheck(checks) !== (value.outcome === "verified")) {
    return null;
  }
  return {
    checkedAt,
    outcome: value.outcome,
    sourceKind,
    sourceRevision: revision,
    environmentRevisionId,
    checks,
  };
}

/**
 * Digest over everything that decides what was checked. Two results with the
 * same digest were produced for the same plan, profile, Runner, environment,
 * and expected revisions; a stored digest that no longer matches is history.
 */
function digestRuntimeBinding(input: {
  readonly planId: string;
  readonly contractDigest: string;
  readonly profileId: string;
  readonly declaredRevision: string;
  readonly binding: ScienceFlowRuntimeBinding;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "scienceflow-runtime-binding.v1",
        input.planId,
        input.contractDigest,
        input.profileId,
        input.binding.bindingId,
        input.binding.runnerBindingId,
        input.binding.runnerId,
        input.binding.environmentId,
        input.binding.expectedEnvironmentRevisionId,
        input.declaredRevision,
      ]),
    )
    .digest("hex");
}

/** One Runner call bounded by the administrator's transport timeout. */
async function runWithTimeout(
  runner: ScienceFlowRuntimeCheckRunner,
  request: ScienceFlowRuntimeProbeRequest,
  timeoutMs: number,
): Promise<ScienceFlowRuntimeProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs > 0 ? timeoutMs : SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS,
  );
  try {
    return await runner.scienceFlowRuntimeCheck(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// --- helpers ---------------------------------------------------------------

/** Identity fields are opaque keys, but stored ones cannot be unbounded. */
const IDENTITY_MAX_LENGTH = 200;

function mapFailure(
  error: unknown,
): { status: "corrupt" } | { status: "internal-error" } {
  return error instanceof ScienceFlowExecutionPlanCorruptError ||
    error instanceof ScienceFlowRuntimeCheckCorruptError
    ? { status: "corrupt" }
    : { status: "internal-error" };
}

function isIdentity(
  value: unknown,
): value is ScienceFlowExecutionPlanIdentity {
  if (!isRecord(value)) return false;
  return (
    isBoundedIdentity(value.projectId) && isBoundedIdentity(value.sessionId)
  );
}

/** Business ids are opaque: non-blank, bounded, and never a path or NUL. */
function isBoundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= IDENTITY_MAX_LENGTH &&
    isUsableIdentity(value)
  );
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** The Runner emits `Date#toISOString()`; anything else is not evidence. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
