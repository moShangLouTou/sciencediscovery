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
 * Explicit preparation of a frozen plan's enumerated input files.
 *
 * One immutable plan, one administrator-declared binding, one Runner call. The
 * service rebuilds the contract from the current profile, proves it still
 * equals the frozen one, assembles the bundle from the same bytes that produced
 * the digests, and only then asks the selected Runner to verify and hold it.
 * The Runner call may await, so every gate that can change meanwhile — Project
 * and Session ownership, write permission, the plan, the profile, the binding,
 * and the Session's Runner selection — is checked again before a receipt is
 * stored.
 *
 * This action never starts a process, never invokes the runtime identity probe,
 * never reads an engine, and never authorizes a start: `canStart` stays false
 * and the fixed blockers remain. A stored receipt is a record of one
 * preparation at one time, not a health claim about the Runner now.
 */
import {
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  SCIENCE_FLOW_INPUT_FILE_ROLES,
  SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowInputBundlePublication,
  type ScienceFlowInputBundleRequest,
  type ScienceFlowPlanCheckDto,
  type ScienceFlowPreparedInputFileDto,
  type ScienceFlowPreparedInputsDto,
  type ScienceFlowPreparedInputsStateDto,
} from "@sciencediscovery/schema";

import {
  digestScienceFlowContract,
  type ScienceFlowContractBuilder,
} from "./execution-contract.js";
import type { ScienceFlowExecutionSettings } from "./execution-config.js";
import type { ScienceFlowExecutionPlanIdentity } from "./execution-plan.js";
import {
  ScienceFlowExecutionPlanCorruptError,
  type ScienceFlowExecutionPlanStore,
  type ScienceFlowStoredExecutionPlan,
} from "./execution-plan-repository.js";
import { isUsableIdentity } from "./http.js";
import {
  assembleScienceFlowInputBundle,
  scienceFlowInputBundleDigest,
} from "./input-bundle.js";
import {
  ScienceFlowPreparedInputsCorruptError,
  preparedInputsState,
  type ScienceFlowPreparedInputsStore,
} from "./prepared-inputs-repository.js";
import type { ScienceFlowIdentityStore } from "./run-snapshot.js";
import type {
  ScienceFlowRuntimeBinding,
  ScienceFlowRuntimeSettings,
} from "./runtime-config.js";

/**
 * Transport bound for one preparation. Larger than the identity probe's bound
 * because a bundle carries file bytes; still a bound, so a stalled Runner
 * becomes a fixed `unavailable` instead of a hung request.
 */
export const SCIENCE_FLOW_PREPARE_INPUTS_TIMEOUT_MS = 120_000;

/** What the service needs from a signed Runner client; satisfied structurally. */
export interface ScienceFlowInputBundleRunner {
  prepareScienceFlowInputBundle(
    request: ScienceFlowInputBundleRequest,
    signal?: AbortSignal,
  ): Promise<ScienceFlowInputBundlePublication>;
}

export interface ScienceFlowPrepareInputsDependencies {
  /** Minimal read-only identity store: `getProject`/`getSession`. */
  readonly identities: ScienceFlowIdentityStore;
  /** The existing write constraint (`store.assertSessionWritable`); may throw. */
  readonly requireWritable: (sessionId: string) => unknown;
  /**
   * True only when the Session may use the binding's Runner. The store's own
   * `assertSessionAllowsRunner` is wrapped so a refusal becomes a fixed answer.
   */
  readonly runnerAllowed: (sessionId: string, runnerId: string) => boolean;
  /** Administrator profiles; undefined when the execution feature is off. */
  readonly profiles?: ScienceFlowExecutionSettings;
  /** Administrator runtime bindings; undefined when preparation is off. */
  readonly runtime?: ScienceFlowRuntimeSettings;
  readonly plans: () => ScienceFlowExecutionPlanStore;
  readonly store: () => ScienceFlowPreparedInputsStore;
  readonly buildContract: ScienceFlowContractBuilder;
  /** Runner selection: local client, otherwise the connected remote Runner. */
  readonly runnerFor: (runnerId: string) => ScienceFlowInputBundleRunner;
  readonly now?: () => string;
}

export type ScienceFlowPrepareInputsResult =
  | { readonly status: "ok"; readonly prepared: ScienceFlowPreparedInputsDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  /** The feature is off, or the plan's profile/binding was withdrawn. */
  | { readonly status: "disabled" }
  /** The selected Session does not allow the binding's Runner. */
  | { readonly status: "runner-denied" }
  | { readonly status: "invalid"; readonly reason: "query" }
  /** The current profile or files no longer match the frozen contract. */
  | { readonly status: "contract-changed" }
  /** The current files could not produce a complete contract. */
  | {
      readonly status: "blocked";
      readonly checks: readonly ScienceFlowPlanCheckDto[];
    }
  /** No evidence was established; nothing was persisted. */
  | { readonly status: "unavailable" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowPreparedInputsReadResult =
  | { readonly status: "ok"; readonly state: ScienceFlowPreparedInputsStateDto }
  | {
      readonly status: "not-found";
      readonly resource: "project" | "session" | "plan";
    }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export interface ScienceFlowPrepareInputsService {
  /** Prepare now and persist the receipt. The only method that contacts a Runner. */
  prepare(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowPrepareInputsResult>;
  /** The latest stored receipt, or none; never contacts a Runner or a source file. */
  latest(
    query: ScienceFlowExecutionPlanIdentity,
    planId: string,
  ): Promise<ScienceFlowPreparedInputsReadResult>;
}

export function createScienceFlowPrepareInputsService(
  dependencies: ScienceFlowPrepareInputsDependencies,
): ScienceFlowPrepareInputsService {
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
    async prepare(query, planId) {
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
      // A receipt is persisted, so this is a write: gate before any read, and
      // again after the Runner's await.
      dependencies.requireWritable(query.sessionId);

      let stored: ScienceFlowStoredExecutionPlan | undefined;
      try {
        stored = dependencies.plans().get(query.projectId, query.sessionId, planId);
      } catch (error) {
        return mapFailure(error);
      }
      if (!stored) return { status: "not-found", resource: "plan" };
      const binding = selectBinding(profiles, runtime, stored.plan.profileId);
      // The profile was withdrawn or names no live binding. There is no
      // fallback to another profile, the local Runner, or a default.
      if (binding === undefined) return { status: "disabled" };
      if (!dependencies.runnerAllowed(query.sessionId, binding.runnerId)) {
        return { status: "runner-denied" };
      }

      const profile = profiles.profileFor(stored.plan.profileId);
      if (profile === undefined) return { status: "disabled" };

      let built;
      try {
        built = await dependencies.buildContract(profile);
      } catch {
        return { status: "internal-error" };
      }
      // An I/O failure is not a blocked check; never report it as one.
      if (built.status === "internal") return { status: "internal-error" };
      if (built.status === "rejected") {
        // The sources cannot even produce a contract now, so this plan cannot
        // be prepared. Nothing is invented and nothing is persisted.
        return { status: "blocked", checks: built.checks };
      }
      if (digestScienceFlowContract(built.contract) !== stored.plan.contractDigest) {
        return { status: "contract-changed" };
      }
      const assembly = assembleScienceFlowInputBundle(
        stored.plan.contract,
        built.files,
      );
      if (assembly.status === "internal") return { status: "internal-error" };
      if (assembly.status === "contract-changed") {
        return { status: "contract-changed" };
      }
      const { request, manifest } = assembly;
      if (request.bundleDigest !== scienceFlowInputBundleDigest(manifest)) {
        return { status: "internal-error" };
      }

      // The generation is reserved before the await, so a late result from an
      // older request can never replace a newer recorded fact.
      let generation: number;
      try {
        generation = dependencies
          .store()
          .allocate(query.projectId, query.sessionId, planId);
      } catch (error) {
        return mapFailure(error);
      }

      let publication: ScienceFlowInputBundlePublication;
      try {
        const runner = dependencies.runnerFor(binding.runnerId);
        publication = await runWithTimeout(runner, request);
      } catch {
        // Transport failure, an abort, a refused bundle, or a disconnected
        // Runner. No fact was established, so nothing is persisted.
        return { status: "unavailable" };
      }

      // The await can span a Session deletion, a write revocation, a Runner
      // selection change, or a profile/binding withdrawal.
      const vanished = missingIdentity(query);
      if (vanished) return vanished;
      dependencies.requireWritable(query.sessionId);
      if (!dependencies.runnerAllowed(query.sessionId, binding.runnerId)) {
        return { status: "runner-denied" };
      }
      let current: ScienceFlowStoredExecutionPlan | undefined;
      try {
        current = dependencies.plans().get(query.projectId, query.sessionId, planId);
      } catch (error) {
        return mapFailure(error);
      }
      if (!current) return { status: "not-found", resource: "plan" };
      const currentBinding = selectBinding(
        profiles,
        runtime,
        current.plan.profileId,
      );
      if (
        currentBinding === undefined ||
        currentBinding.runnerId !== binding.runnerId ||
        currentBinding.bindingId !== binding.bindingId ||
        current.plan.contractDigest !== stored.plan.contractDigest
      ) {
        // The binding the Runner was asked about is no longer the current one.
        // The Runner may hold the content as an unassociated cache; it is not
        // recorded as a current preparation.
        return { status: "disabled" };
      }

      if (!publicationMatches(publication, request, manifest)) {
        return { status: "unavailable" };
      }

      const prepared: ScienceFlowPreparedInputsDto = Object.freeze({
        schemaVersion: SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
        planId,
        contractDigest: stored.plan.contractDigest,
        bundleDigest: request.bundleDigest,
        runnerId: binding.runnerId,
        preparedAt: now(),
        outcome: "prepared" as const,
        canStart: false as const,
        fileCount: manifest.files.length,
        totalBytes: manifest.files.reduce((total, file) => total + file.size, 0),
        files: receiptFiles(manifest),
        generation,
      });

      try {
        const { saved, stored: persisted } = dependencies.store().save({
          projectId: query.projectId,
          sessionId: query.sessionId,
          generation,
          prepared,
        });
        if (saved) return { status: "ok", prepared };
        if (persisted && persisted.generation > generation) {
          // A strictly newer preparation already recorded the current fact.
          // The receipt's generation shows it is not this request's
          // observation; an older row is never returned as this one's success.
          return { status: "ok", prepared: persisted.prepared };
        }
        if (!persisted) {
          // The Session or Project was deleted while this preparation ran;
          // nothing is resurrected.
          return { status: "not-found", resource: "session" };
        }
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
        // The plan must exist; a row without one is never served. Current
        // configuration is deliberately not consulted: a withdrawn binding does
        // not erase history, and it is never described as currently available.
        const plan = dependencies
          .plans()
          .get(query.projectId, query.sessionId, planId);
        if (!plan) return { status: "not-found", resource: "plan" };
        const stored = dependencies
          .store()
          .latest(query.projectId, query.sessionId, planId);
        // A receipt is history for exactly the frozen contract it names. A row
        // recorded under another contract is not this plan's preparation and
        // is never served as one.
        if (
          stored !== undefined &&
          stored.prepared.contractDigest !== plan.plan.contractDigest
        ) {
          return { status: "corrupt" };
        }
        return { status: "ok", state: preparedInputsState(planId, stored) };
      } catch (error) {
        return mapFailure(error);
      }
    },
  };
}

// --- helpers ---------------------------------------------------------------

/**
 * The selected Runner for a plan's profile, or undefined when the profile or
 * its binding no longer exists. Both are administrator state; a request can
 * never add one.
 */
function selectBinding(
  profiles: ScienceFlowExecutionSettings,
  runtime: ScienceFlowRuntimeSettings,
  profileId: string,
): ScienceFlowRuntimeBinding | undefined {
  const profile = profiles.profileFor(profileId);
  if (profile === undefined || profile.runtimeBindingId === undefined) {
    return undefined;
  }
  return runtime.bindingFor(profile.runtimeBindingId);
}

/**
 * One receipt file entry per role, in the protocol's canonical role order. A
 * merged byte set appears once per role it serves, so no association is lost.
 */
function receiptFiles(
  manifest: ScienceFlowInputBundleManifest,
): readonly ScienceFlowPreparedInputFileDto[] {
  const files: ScienceFlowPreparedInputFileDto[] = [];
  for (const role of SCIENCE_FLOW_INPUT_FILE_ROLES) {
    const file = manifest.files.find((candidate) =>
      candidate.roles.includes(role),
    );
    if (file === undefined) continue;
    files.push(
      Object.freeze({
        role,
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      }),
    );
  }
  return Object.freeze(files);
}

/**
 * Validate one Runner answer. It is untrusted JSON: only the fixed shape is
 * read, and every identity and count must echo what this request sent.
 */
function publicationMatches(
  answer: ScienceFlowInputBundlePublication,
  request: ScienceFlowInputBundleRequest,
  manifest: ScienceFlowInputBundleManifest,
): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const value = answer as unknown as Readonly<Record<string, unknown>>;
  const totalBytes = manifest.files.reduce((total, file) => total + file.size, 0);
  return (
    value.schemaVersion === SCIENCE_FLOW_INPUT_BUNDLE_VERSION &&
    value.status === "ready" &&
    value.bundleDigest === request.bundleDigest &&
    value.contractDigest === request.contractDigest &&
    value.fileCount === manifest.files.length &&
    value.totalBytes === totalBytes
  );
}

/** One Runner call bounded by the fixed preparation timeout. */
async function runWithTimeout(
  runner: ScienceFlowInputBundleRunner,
  request: ScienceFlowInputBundleRequest,
): Promise<ScienceFlowInputBundlePublication> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SCIENCE_FLOW_PREPARE_INPUTS_TIMEOUT_MS,
  );
  try {
    return await runner.prepareScienceFlowInputBundle(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Identity fields are opaque keys, but stored ones cannot be unbounded. */
const IDENTITY_MAX_LENGTH = 200;

function mapFailure(
  error: unknown,
): { status: "corrupt" } | { status: "internal-error" } {
  return error instanceof ScienceFlowExecutionPlanCorruptError ||
    error instanceof ScienceFlowPreparedInputsCorruptError
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
