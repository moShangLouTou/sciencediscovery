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
 * Control-plane registration of an existing ScienceFlow managed run.
 *
 * Creating a registration checks the same trusted gates as any write: the
 * Project and Session exist and own each other, the Session is writable, and
 * the admin's current binding table still names this exact run. Because the
 * binding lookup is allowed to await, the ownership and write gate are checked
 * again after it resolves and before the row is written: a Session deleted or
 * made read-only during that window is never registered. It never starts
 * Python, never reads the run record, and never claims the engine is running.
 * The write gate stays outside this module's own try/catch so its existing
 * `SessionStoreHttpError` variants reach the HTTP layer's status mapping.
 */
import { randomUUID } from "node:crypto";

import type { ScienceFlowRunRegistrationDto } from "@sciencediscovery/schema";

import {
  ScienceFlowRegistrationCorruptError,
  type ScienceFlowRegistrationStore,
} from "./registration-repository.js";
import type {
  ScienceFlowIdentityStore,
  ScienceFlowRunBinding,
  ScienceFlowRunBindingResolver,
} from "./run-snapshot.js";

/** The Project/Session a registration belongs to; the run id comes separately. */
export interface ScienceFlowRegistrationIdentity {
  readonly projectId: string;
  readonly sessionId: string;
}

export interface ScienceFlowRegistrationDependencies {
  /** Minimal read-only identity store: `getProject`/`getSession`. */
  readonly identities: ScienceFlowIdentityStore;
  /** The existing write constraint (`store.assertSessionWritable`); may throw. */
  readonly requireWritable: (sessionId: string) => unknown;
  /**
   * Trusted current binding lookup. Undefined when the administrator never
   * configured the reader: a create then answers `disabled` while list/detail
   * still read persisted metadata.
   */
  readonly resolveBinding?: ScienceFlowRunBindingResolver;
  /** Deferred: the SQLite store exists only once `SessionStore.load()` ran. */
  readonly store: () => ScienceFlowRegistrationStore;
  readonly generateRegistrationId?: () => string;
  readonly now?: () => string;
}

export type ScienceFlowRegistrationCreateResult =
  | { readonly status: "created"; readonly registration: ScienceFlowRunRegistrationDto }
  | { readonly status: "existing"; readonly registration: ScienceFlowRunRegistrationDto }
  | { readonly status: "not-found"; readonly resource: "project" | "session" | "binding" }
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: "query" | "binding" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowRegistrationListResult =
  | { readonly status: "ok"; readonly registrations: readonly ScienceFlowRunRegistrationDto[] }
  | { readonly status: "not-found"; readonly resource: "project" | "session" }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export type ScienceFlowRegistrationGetResult =
  | { readonly status: "ok"; readonly registration: ScienceFlowRunRegistrationDto }
  | { readonly status: "not-found"; readonly resource: "project" | "session" | "registration" }
  | { readonly status: "invalid"; readonly reason: "query" }
  | { readonly status: "corrupt" }
  | { readonly status: "internal-error" };

export interface ScienceFlowRegistrationService {
  create(
    query: ScienceFlowRegistrationIdentity,
    runId: string,
  ): Promise<ScienceFlowRegistrationCreateResult>;
  list(
    query: ScienceFlowRegistrationIdentity,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<ScienceFlowRegistrationListResult>;
  get(
    query: ScienceFlowRegistrationIdentity,
    registrationId: string,
  ): Promise<ScienceFlowRegistrationGetResult>;
}

/** Default and maximum list sizes keep one request from reading the whole table. */
export const SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT = 100;
export const SCIENCE_FLOW_REGISTRATION_LIST_MAX_LIMIT = 250;

export function createScienceFlowRegistrationService(
  dependencies: ScienceFlowRegistrationDependencies,
): ScienceFlowRegistrationService {
  const generateRegistrationId =
    dependencies.generateRegistrationId ?? (() => randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());

  return {
    async create(query, runId) {
      if (!isIdentity(query) || !isUsableIdentity(runId)) {
        return { status: "invalid", reason: "query" };
      }
      const missing = resolveMissing(dependencies.identities, query);
      if (missing) return missing;
      // Deliberately before the try/catch: a locked/archived Session must keep
      // its established 409 (and a missing one its 404), not become a 500.
      dependencies.requireWritable(query.sessionId);
      if (dependencies.resolveBinding === undefined) return { status: "disabled" };
      let binding: ScienceFlowRunBinding | undefined;
      try {
        binding = await dependencies.resolveBinding({
          projectId: query.projectId,
          sessionId: query.sessionId,
          runId,
        });
      } catch (error) {
        return mapFailure(error);
      }
      if (binding === undefined) return { status: "not-found", resource: "binding" };
      if (!bindingMatches(binding, query.projectId, query.sessionId, runId)) {
        return { status: "invalid", reason: "binding" };
      }
      // The resolver may have awaited, so the Project, Session, or write
      // permission observed above can be gone by now. Re-check both before the
      // write; the write gate stays outside the try/catch so a locked/archived
      // Session keeps its established 409 (and a vanished one its 404).
      const vanished = resolveMissing(dependencies.identities, query);
      if (vanished) return vanished;
      dependencies.requireWritable(query.sessionId);
      try {
        const { created, record } = dependencies.store().create({
          registrationId: generateRegistrationId(),
          projectId: query.projectId,
          sessionId: query.sessionId,
          runId,
          createdAt: now(),
        });
        return created
          ? { status: "created", registration: record }
          : { status: "existing", registration: record };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async list(query, options = {}) {
      if (!isIdentity(query)) return { status: "invalid", reason: "query" };
      const missing = resolveMissing(dependencies.identities, query);
      if (missing) return missing;
      try {
        const registrations = dependencies.store().list(
          query.projectId,
          query.sessionId,
          boundedInteger(
            options.limit,
            SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT,
            1,
            SCIENCE_FLOW_REGISTRATION_LIST_MAX_LIMIT,
          ),
          boundedInteger(options.offset, 0, 0),
        );
        return { status: "ok", registrations };
      } catch (error) {
        return mapFailure(error);
      }
    },

    async get(query, registrationId) {
      if (!isIdentity(query) || !isUsableIdentity(registrationId)) {
        return { status: "invalid", reason: "query" };
      }
      const missing = resolveMissing(dependencies.identities, query);
      if (missing) return missing;
      try {
        const registration = dependencies.store().get(
          query.projectId,
          query.sessionId,
          registrationId,
        );
        if (!registration) return { status: "not-found", resource: "registration" };
        return { status: "ok", registration };
      } catch (error) {
        return mapFailure(error);
      }
    },
  };
}

function resolveMissing(
  identities: ScienceFlowIdentityStore,
  query: ScienceFlowRegistrationIdentity,
): { status: "not-found"; resource: "project" | "session" } | undefined {
  if (!identities.getProject(query.projectId)) {
    return { status: "not-found", resource: "project" };
  }
  const session = identities.getSession(query.sessionId);
  // A Session in another Project is reported exactly like a missing one.
  if (!session || session.projectId !== query.projectId) {
    return { status: "not-found", resource: "session" };
  }
  return undefined;
}

function bindingMatches(
  binding: ScienceFlowRunBinding,
  projectId: string,
  sessionId: string,
  runId: string,
): boolean {
  return (
    binding.projectId === projectId &&
    binding.sessionId === sessionId &&
    binding.runId === runId
  );
}

function mapFailure(
  error: unknown,
): { status: "corrupt" } | { status: "internal-error" } {
  return error instanceof ScienceFlowRegistrationCorruptError
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

function isIdentity(value: unknown): value is ScienceFlowRegistrationIdentity {
  if (!isRecord(value)) return false;
  return isUsableIdentity(value.projectId) && isUsableIdentity(value.sessionId);
}

/** Business ids are opaque: non-blank, and never a path or NUL. */
function isUsableIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
