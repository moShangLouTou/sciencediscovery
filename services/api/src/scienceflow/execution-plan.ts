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
 * Immutable ScienceFlow execution plans and their static preflight.
 *
 * Creating a plan checks the same trusted gates as any write: the Project and
 * Session exist and own each other, the Session is writable, and the admin's
 * current profile table names this exact profile. The contract builder reads
 * files and may await, so ownership and write permission are checked again
 * after it resolves and before anything is persisted.
 *
 * A plan is frozen once. `(projectId, sessionId, requestId)` is its idempotency
 * identity: a retry returns the stored plan without re-reading a single file,
 * and reusing the identity with a different `profileId` is refused. Source
 * files changing later never rewrite the frozen contract; a preflight reports
 * `contract_changed` instead.
 *
 * Preflights are advisory static checks. `canStart` is always false and the
 * blockers are fixed: a valid contract is not an execution authorization.
 */
import { randomUUID } from "node:crypto";

import {
  SCIENCE_FLOW_EXECUTION_PLAN_LIST_DEFAULT_LIMIT,
  SCIENCE_FLOW_EXECUTION_PLAN_LIST_MAX_LIMIT,
  SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
  SCIENCE_FLOW_PLAN_CHECK_CODES,
  type ScienceFlowExecutionPlanDto,
  type ScienceFlowPlanCheckCode,
  type ScienceFlowPlanCheckDto,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_EXECUTION_BLOCKERS,
  describeScienceFlowCheck,
  digestScienceFlowContract,
  type ScienceFlowContractBuilder,
} from "./execution-contract.js";
import type { ScienceFlowExecutionSettings } from "./execution-config.js";
import {
  ScienceFlowExecutionPlanCorruptError,
  type ScienceFlowExecutionPlanStore,
  type ScienceFlowStoredExecutionPlan,
} from "./execution-plan-repository.js";
import type { ScienceFlowIdentityStore } from "./run-snapshot.js";

/** The Project/Session a plan belongs to. */
export interface ScienceFlowExecutionPlanIdentity {
  readonly projectId: string;
  readonly sessionId: string;
}

/** The only two fields a create accepts. Paths and overrides are not fields. */
export interface ScienceFlowExecutionPlanInput {
  readonly profileId: string;
  readonly requestId: string;
}

export interface ScienceFlowExecutionPlanDependencies {
  /** Minimal read-only identity store: `getProject`/`getSession`. */
  readonly identities: ScienceFlowIdentityStore;
  /** The existing write constraint (`store.assertSessionWritable`); may throw. */
  readonly requireWritable: (sessionId: string) => unknown;
  /**
   * Administrator profiles. Undefined when the execution feature is off: a
   * create or preflight then answers `disabled` while list/get keep reading
   * persisted metadata.
   */
  readonly profiles?: ScienceFlowExecutionSettings;
  /** Deferred: the SQLite store exists only once `SessionStore.load()` ran. */
  readonly store: () => ScienceFlowExecutionPlanStore;
  readonly buildContract: ScienceFlowContractBuilder;
  readonly generatePlanId?: () => string;
  readonly now?: () => string;
}

export type ScienceFlowExecutionPlanCreateResult =
  | { readonly status: "created"; readonly plan: ScienceFlowExecutionPlanDto }
  | { readonly status: "existing"; readonly plan: ScienceFlowExecutionPlanDto }
  /** Same `requestId`, different `profileId`: never merge two profiles. */
  | { readonly status: "conflict"; readonly plan: ScienceFlowExecutionPlanDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "profile";
    }
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: "query" | "body" }
  /** The selected files are missing, malformed, or use an unsupported form. */
  | {
      readonly status: "contract-invalid";
      readonly checks: readonly ScienceFlowPlanCheckDto[];
    }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowExecutionPlanListResult =
  | {
      readonly status: "ok";
      readonly plans: readonly ScienceFlowExecutionPlanDto[];
    }
  | { readonly status: "not-found"; readonly resource: "project" | "session" }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowExecutionPlanGetResult =
  | { readonly status: "ok"; readonly plan: ScienceFlowExecutionPlanDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowExecutionPlanPreflightResult =
  | {
      readonly status: "ok";
      readonly plan: ScienceFlowExecutionPlanDto;
      /** The latest persisted result, not necessarily this call's own. */
      readonly preflight: ScienceFlowPreflightDto;
    }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  /** The feature is off or the plan's profile was withdrawn. */
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export interface ScienceFlowExecutionPlanService {
  create(
    query: ScienceFlowExecutionPlanIdentity,
    input: ScienceFlowExecutionPlanInput,
  ): Promise<ScienceFlowExecutionPlanCreateResult>;
  list(
    query: ScienceFlowExecutionPlanIdentity,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<ScienceFlowExecutionPlanListResult>;
  get(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowExecutionPlanGetResult>;
  preflight(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowExecutionPlanPreflightResult>;
}

/** Identity fields are opaque keys, but stored ones cannot be unbounded. */
const IDENTITY_MAX_LENGTH = 200;

export function createScienceFlowExecutionPlanService(
  dependencies: ScienceFlowExecutionPlanDependencies,
): ScienceFlowExecutionPlanService {
  const generatePlanId = dependencies.generatePlanId ?? (() => randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());

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
    async create(query, input) {
      if (!isIdentity(query)) return { status: "invalid", reason: "query" };
      if (!isInput(input)) return { status: "invalid", reason: "body" };
      const profiles = dependencies.profiles;
      if (profiles === undefined) return { status: "disabled" };
      const missing = missingIdentity(query);
      if (missing) return missing;
      // Deliberately before the try/catch: a locked/archived Session must keep
      // its established 409 (and a missing one its 404), not become a 500.
      dependencies.requireWritable(query.sessionId);
      if (profiles.profileFor(input.profileId) === undefined) {
        return { status: "not-found", resource: "profile" };
      }

      // Idempotency is resolved before any source file is read: a retry must
      // return the frozen plan, never re-freeze content that changed since.
      let replay: ScienceFlowStoredExecutionPlan | undefined;
      try {
        replay = dependencies.store().findByRequest(
          query.projectId,
          query.sessionId,
          input.requestId,
        );
      } catch (error) {
        return mapFailure(error);
      }
      if (replay) {
        return replay.plan.profileId === input.profileId
          ? { status: "existing", plan: replay.plan }
          : { status: "conflict", plan: replay.plan };
      }

      let built;
      try {
        built = await dependencies.buildContract(profiles.profileFor(input.profileId)!);
      } catch {
        return { status: "internal-error" };
      }
      if (built.status === "internal") return { status: "internal-error" };
      if (built.status === "rejected") {
        // Nothing is persisted: a plan is either complete or absent.
        return { status: "contract-invalid", checks: built.checks };
      }

      // The builder performed filesystem reads and may have awaited, so the
      // Project, Session, and write permission seen above can be gone by now.
      const vanished = missingIdentity(query);
      if (vanished) return vanished;
      dependencies.requireWritable(query.sessionId);
      if (profiles.profileFor(input.profileId) === undefined) {
        return { status: "not-found", resource: "profile" };
      }

      try {
        const { created, stored } = dependencies.store().create({
          planId: generatePlanId(),
          projectId: query.projectId,
          sessionId: query.sessionId,
          profileId: input.profileId,
          requestId: input.requestId,
          createdAt: now(),
          contractDigest: digestScienceFlowContract(built.contract),
          contract: built.contract,
        });
        // A concurrent request may have inserted the same identity between the
        // replay lookup and this write. Same profile: the stored plan wins.
        if (stored.plan.profileId !== input.profileId) {
          return { status: "conflict", plan: stored.plan };
        }
        return created
          ? { status: "created", plan: stored.plan }
          : { status: "existing", plan: stored.plan };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async list(query, options = {}) {
      if (!isIdentity(query)) return { status: "invalid", reason: "query" };
      const missing = missingIdentity(query);
      if (missing) return missing;
      try {
        const stored = dependencies.store().list(
          query.projectId,
          query.sessionId,
          boundedInteger(
            options.limit,
            SCIENCE_FLOW_EXECUTION_PLAN_LIST_DEFAULT_LIMIT,
            1,
            SCIENCE_FLOW_EXECUTION_PLAN_LIST_MAX_LIMIT,
          ),
          boundedInteger(options.offset, 0, 0),
        );
        return { status: "ok", plans: stored.map((entry) => entry.plan) };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async get(query, planId) {
      if (!isIdentity(query) || !isUsableIdentity(planId)) {
        return { status: "invalid", reason: "query" };
      }
      const missing = missingIdentity(query);
      if (missing) return missing;
      try {
        const stored = dependencies.store().get(
          query.projectId,
          query.sessionId,
          planId,
        );
        if (!stored) return { status: "not-found", resource: "plan" };
        return { status: "ok", plan: stored.plan };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async preflight(query, planId) {
      if (!isIdentity(query) || !isUsableIdentity(planId)) {
        return { status: "invalid", reason: "query" };
      }
      const profiles = dependencies.profiles;
      if (profiles === undefined) return { status: "disabled" };
      const missing = missingIdentity(query);
      if (missing) return missing;
      // A preflight is persisted, so it is a write: check the gate before the
      // read, and again after the builder's await.
      dependencies.requireWritable(query.sessionId);

      let stored: ScienceFlowStoredExecutionPlan | undefined;
      try {
        stored = dependencies.store().get(
          query.projectId,
          query.sessionId,
          planId,
        );
      } catch (error) {
        return mapFailure(error);
      }
      if (!stored) return { status: "not-found", resource: "plan" };
      const profile = profiles.profileFor(stored.plan.profileId);
      // The plan's profile was withdrawn from the current configuration. The
      // metadata stays readable; a check is explicitly unavailable, and there
      // is no fallback to another profile or an old path.
      if (profile === undefined) return { status: "disabled" };

      let built;
      try {
        built = await dependencies.buildContract(profile);
      } catch {
        return { status: "internal-error" };
      }
      // An I/O failure is not a blocked check; never persist it as one.
      if (built.status === "internal") return { status: "internal-error" };

      const vanished = missingIdentity(query);
      if (vanished) return vanished;
      dependencies.requireWritable(query.sessionId);
      if (profiles.profileFor(stored.plan.profileId) === undefined) {
        return { status: "disabled" };
      }

      const observedContractDigest =
        built.status === "ok" ? digestScienceFlowContract(built.contract) : null;
      const unchanged =
        observedContractDigest !== null &&
        observedContractDigest === stored.plan.contractDigest;
      const checks = canonicalChecks([
        ...built.checks,
        {
          code: "contract_changed",
          status: unchanged ? "passed" : "failed",
        },
      ]);
      const outcome = checks.some(
        (check) => check.status === "failed" || check.status === "unsupported",
      )
        ? "blocked"
        : "passed";
      const preflight: ScienceFlowPreflightDto = Object.freeze({
        schemaVersion: SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
        planId: stored.plan.planId,
        contractDigest: stored.plan.contractDigest,
        observedContractDigest,
        checkedAt: now(),
        outcome,
        canStart: false as const,
        checks,
        blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
      });

      try {
        const { stored: current } = dependencies.store().savePreflight(
          query.projectId,
          query.sessionId,
          stored.plan.planId,
          stored.preflightRevision,
          preflight,
        );
        const latest = current.plan.latestPreflight;
        // A concurrent check may have replaced ours; the persisted result is
        // the one the plan reports, so return it rather than a discarded one.
        return latest === null
          ? { status: "internal-error" }
          : { status: "ok", plan: current.plan, preflight: latest };
      } catch (error) {
        return mapFailure(error);
      }
    },
  };
}

// --- helpers ---------------------------------------------------------------

interface RawCheck {
  readonly code: ScienceFlowPlanCheckCode;
  readonly status: ScienceFlowPlanCheckStatus;
}

/** Canonical order, one entry per code (the last occurrence wins). */
function canonicalChecks(
  raw: readonly RawCheck[],
): readonly ScienceFlowPlanCheckDto[] {
  const byCode = new Map<ScienceFlowPlanCheckCode, ScienceFlowPlanCheckStatus>();
  for (const { code, status } of raw) byCode.set(code, status);
  return Object.freeze(
    SCIENCE_FLOW_PLAN_CHECK_CODES.filter((code) => byCode.has(code)).map(
      (code) => {
        const status = byCode.get(code) as ScienceFlowPlanCheckStatus;
        return Object.freeze({
          code,
          status,
          description: describeScienceFlowCheck(code, status),
        });
      },
    ),
  );
}

function mapFailure(
  error: unknown,
): { status: "corrupt" } | { status: "internal-error" } {
  return error instanceof ScienceFlowExecutionPlanCorruptError
    ? { status: "corrupt" }
    : { status: "internal-error" };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.max(minimum, Math.trunc(value));
  return maximum === undefined ? integer : Math.min(maximum, integer);
}

function isIdentity(
  value: unknown,
): value is ScienceFlowExecutionPlanIdentity {
  if (!isRecord(value)) return false;
  return isUsableIdentity(value.projectId) && isUsableIdentity(value.sessionId);
}

function isInput(value: unknown): value is ScienceFlowExecutionPlanInput {
  if (!isRecord(value)) return false;
  return (
    isUsableIdentity(value.profileId) && isUsableIdentity(value.requestId)
  );
}

/** Business ids are opaque: non-blank, bounded, and never a path or NUL. */
function isUsableIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= IDENTITY_MAX_LENGTH &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
