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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import type { ScienceFlowRunRegistrationDto } from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT,
  SCIENCE_FLOW_REGISTRATION_LIST_MAX_LIMIT,
  createScienceFlowRegistrationService,
} from "./registration.js";
import {
  ScienceFlowRegistrationCorruptError,
  type ScienceFlowRegistrationStore,
  type ScienceFlowRunRegistrationDraft,
} from "./registration-repository.js";
import type { ScienceFlowRunBinding, ScienceFlowRunQuery } from "./run-snapshot.js";

const IDENTITY = { projectId: "project-1", sessionId: "session-1" };

interface HarnessOptions {
  readonly projectMissing?: boolean;
  readonly sessionMissing?: boolean;
  readonly sessionProject?: string;
  readonly writableError?: unknown;
  readonly readerDisabled?: boolean;
  readonly binding?: ScienceFlowRunBinding | undefined;
  readonly storeError?: unknown;
  /** Lets a test pause the binding lookup and change state while it waits. */
  readonly awaitBinding?: Promise<void>;
}

interface Harness {
  readonly service: ReturnType<typeof createScienceFlowRegistrationService>;
  readonly drafts: ScienceFlowRunRegistrationDraft[];
  readonly bindingQueries: ScienceFlowRunQuery[];
  readonly listArgs: Array<{ limit: number; offset: number }>;
  writableCalls(): number;
  setBinding(binding: ScienceFlowRunBinding | undefined): void;
  setSessionMissing(missing: boolean): void;
  /** Applied from the next `requireWritable` call on. */
  setWritableError(error: unknown): void;
}

function harness(options: HarnessOptions = {}): Harness {
  const byId = new Map<string, ScienceFlowRunRegistrationDto>();
  const byKey = new Map<string, ScienceFlowRunRegistrationDto>();
  const drafts: ScienceFlowRunRegistrationDraft[] = [];
  const bindingQueries: ScienceFlowRunQuery[] = [];
  const listArgs: Array<{ limit: number; offset: number }> = [];
  let writableCalls = 0;
  let generated = 0;
  let sessionMissing = options.sessionMissing ?? false;
  let sessionProject = options.sessionProject ?? IDENTITY.projectId;
  let writableError = options.writableError;
  let binding: ScienceFlowRunBinding | undefined =
    "binding" in options ? options.binding : defaultBinding();

  const store: ScienceFlowRegistrationStore = {
    create(draft) {
      drafts.push(draft);
      if (options.storeError !== undefined) throw options.storeError;
      const key = `${draft.projectId}\u0000${draft.sessionId}\u0000${draft.runId}`;
      const existing = byKey.get(key);
      if (existing) return { created: false, record: existing };
      const record: ScienceFlowRunRegistrationDto = Object.freeze({
        schemaVersion: 1,
        registrationId: draft.registrationId,
        projectId: draft.projectId,
        sessionId: draft.sessionId,
        runId: draft.runId,
        createdAt: draft.createdAt,
      });
      byKey.set(key, record);
      byId.set(draft.registrationId, record);
      return { created: true, record };
    },
    list(projectId, sessionId, limit, offset) {
      listArgs.push({ limit, offset });
      if (options.storeError !== undefined) throw options.storeError;
      return [...byId.values()]
        .filter((record) => record.projectId === projectId && record.sessionId === sessionId)
        .slice(offset, offset + limit);
    },
    get(projectId, sessionId, registrationId) {
      if (options.storeError !== undefined) throw options.storeError;
      const record = byId.get(registrationId);
      return record && record.projectId === projectId && record.sessionId === sessionId
        ? record
        : undefined;
    },
  };

  const service = createScienceFlowRegistrationService({
    identities: {
      getProject: (projectId) =>
        options.projectMissing ? undefined : projectId === IDENTITY.projectId ? { id: projectId } : undefined,
      getSession: (sessionId) =>
        sessionMissing
          ? undefined
          : sessionId === IDENTITY.sessionId
            ? { projectId: sessionProject }
            : undefined,
    },
    requireWritable: () => {
      writableCalls++;
      if (writableError !== undefined) throw writableError;
    },
    resolveBinding: options.readerDisabled
      ? undefined
      : async (query) => {
          bindingQueries.push(query);
          if (options.awaitBinding !== undefined) await options.awaitBinding;
          return binding;
        },
    store: () => store,
    generateRegistrationId: () => `registration-${++generated}`,
    now: () => "2026-11-10T00:00:00.000Z",
  });

  return {
    service,
    drafts,
    bindingQueries,
    listArgs,
    writableCalls: () => writableCalls,
    setBinding: (next) => {
      binding = next;
    },
    setSessionMissing: (missing) => {
      sessionMissing = missing;
    },
    setWritableError: (error) => {
      writableError = error;
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

function defaultBinding(): ScienceFlowRunBinding {
  return {
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    runRecordPath: "/srv/runs/run-1/record.json",
    allowedTaskRoots: ["/srv/runs/run-1"],
  };
}

test("REG-S01 create refuses a missing Project, Session, or usable run id before any write", async () => {
  const noProject = harness({ projectMissing: true });
  assert.deepEqual(await noProject.service.create(IDENTITY, "run-1"), {
    status: "not-found",
    resource: "project",
  });
  assert.equal(noProject.drafts.length, 0);
  assert.equal(noProject.writableCalls(), 0);

  const noSession = harness({ sessionMissing: true });
  assert.deepEqual(await noSession.service.create(IDENTITY, "run-1"), {
    status: "not-found",
    resource: "session",
  });
  assert.equal(noSession.drafts.length, 0);

  // A Session owned by another Project is one answer with a missing one.
  const otherProject = harness({ sessionProject: "project-2" });
  assert.deepEqual(await otherProject.service.create(IDENTITY, "run-1"), {
    status: "not-found",
    resource: "session",
  });
  assert.equal(otherProject.drafts.length, 0);

  for (const runId of ["", "   ", "run/1", "run\\1", "run\0 1"]) {
    const invalid = harness();
    assert.deepEqual(await invalid.service.create(IDENTITY, runId), {
      status: "invalid",
      reason: "query",
    });
    assert.equal(invalid.drafts.length, 0);
    assert.equal(invalid.bindingQueries.length, 0);
  }
});

test("REG-S02 create keeps the established write-gate failure for the HTTP layer to map", async () => {
  const error = Object.assign(new Error("Session is archived and read-only"), { statusCode: 409 });
  const h = harness({ writableError: error });
  // The service never converts it: the central mapping must still see the
  // original error, not a generic internal failure.
  await assert.rejects(h.service.create(IDENTITY, "run-1"), (thrown) => thrown === error);
  assert.equal(h.drafts.length, 0);
  assert.equal(h.bindingQueries.length, 0);
});

test("REG-S03 create needs a current admin binding and never writes a false success", async () => {
  // Reader never configured: a create cannot be bound to anything.
  const disabled = harness({ readerDisabled: true });
  assert.deepEqual(await disabled.service.create(IDENTITY, "run-1"), { status: "disabled" });
  assert.equal(disabled.drafts.length, 0);

  // Configured, but this exact run is not bound.
  const unbound = harness({ binding: undefined });
  assert.deepEqual(await unbound.service.create(IDENTITY, "run-1"), {
    status: "not-found",
    resource: "binding",
  });
  assert.equal(unbound.drafts.length, 0);

  // A resolver that names a different run is a trusted-wiring defect.
  const mismatched = harness({ binding: { ...defaultBinding(), runId: "run-2" } });
  assert.deepEqual(await mismatched.service.create(IDENTITY, "run-1"), {
    status: "invalid",
    reason: "binding",
  });
  assert.equal(mismatched.drafts.length, 0);
});

test("REG-S04 a successful create stores the server-generated fields, not caller input", async () => {
  const h = harness();
  const result = await h.service.create(IDENTITY, "run-1");
  assert.equal(result.status, "created");
  assert.deepEqual(h.drafts, [
    {
      registrationId: "registration-1",
      projectId: "project-1",
      sessionId: "session-1",
      runId: "run-1",
      createdAt: "2026-11-10T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(result.status === "created" ? result.registration : undefined, {
    schemaVersion: 1,
    registrationId: "registration-1",
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    createdAt: "2026-11-10T00:00:00.000Z",
  });
  assert.deepEqual(h.bindingQueries, [
    { projectId: "project-1", sessionId: "session-1", runId: "run-1" },
  ]);
});

test("REG-S05 a retry re-runs every gate instead of trusting the stored row", async () => {
  const h = harness();
  const first = await h.service.create(IDENTITY, "run-1");
  assert.equal(first.status, "created");
  assert.equal(h.drafts.length, 1);

  // The admin withdrew the binding between the two calls. The existing
  // registration must not be returned as a success.
  h.setBinding(undefined);
  assert.deepEqual(await h.service.create(IDENTITY, "run-1"), {
    status: "not-found",
    resource: "binding",
  });
  assert.equal(h.drafts.length, 1, "a failed gate must not reach the store");

  h.setBinding(defaultBinding());
  const retry = await h.service.create(IDENTITY, "run-1");
  assert.equal(retry.status, "existing");
  assert.deepEqual(
    retry.status === "existing" ? retry.registration : undefined,
    first.status === "created" ? first.registration : undefined,
  );
});

test("REG-S06 list and get read metadata only: no binding lookup and no write-gate call", async () => {
  const h = harness();
  await h.service.create(IDENTITY, "run-1");
  const writableBefore = h.writableCalls();
  const bindingsBefore = h.bindingQueries.length;

  assert.equal((await h.service.list(IDENTITY)).status, "ok");
  assert.equal((await h.service.get(IDENTITY, "registration-1")).status, "ok");
  assert.deepEqual(await h.service.get(IDENTITY, "registration-missing"), {
    status: "not-found",
    resource: "registration",
  });

  assert.equal(h.writableCalls(), writableBefore);
  assert.equal(h.bindingQueries.length, bindingsBefore);
});

test("REG-S07 list and get still report a missing Project or Session first", async () => {
  const h = harness({ projectMissing: true });
  assert.deepEqual(await h.service.list(IDENTITY), {
    status: "not-found",
    resource: "project",
  });
  assert.deepEqual(await h.service.get(IDENTITY, "registration-1"), {
    status: "not-found",
    resource: "project",
  });
});

test("REG-S08 list pagination is clamped to the documented bounds", async () => {
  const h = harness();
  await h.service.list(IDENTITY);
  await h.service.list(IDENTITY, { limit: 0 });
  await h.service.list(IDENTITY, { limit: 10_000 });
  await h.service.list(IDENTITY, { offset: -5 });
  await h.service.list(IDENTITY, { limit: Number.NaN, offset: 12 });

  assert.deepEqual(h.listArgs, [
    { limit: SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT, offset: 0 },
    { limit: 1, offset: 0 },
    { limit: SCIENCE_FLOW_REGISTRATION_LIST_MAX_LIMIT, offset: 0 },
    { limit: SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT, offset: 0 },
    { limit: SCIENCE_FLOW_REGISTRATION_LIST_DEFAULT_LIMIT, offset: 12 },
  ]);
});

test("REG-S09 a corrupt row is a distinct answer from an internal defect", async () => {
  const corruptHarness = harness({ storeError: new ScienceFlowRegistrationCorruptError() });
  assert.deepEqual(await corruptHarness.service.list(IDENTITY), { status: "corrupt" });
  assert.deepEqual(await corruptHarness.service.get(IDENTITY, "registration-1"), {
    status: "corrupt",
  });

  const broken = harness({ storeError: new Error("boom SYNTHETIC-SECRET") });
  const result = await broken.service.create(IDENTITY, "run-1");
  assert.deepEqual(result, { status: "internal-error" });
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC-SECRET"));
});

test("REG-S10 a binding resolver that throws is an internal failure, not a success", async () => {
  const service = createScienceFlowRegistrationService({
    identities: {
      getProject: () => ({ id: "project-1" }),
      getSession: () => ({ projectId: "project-1" }),
    },
    requireWritable: () => undefined,
    resolveBinding: () => {
      throw new Error("resolver exploded SYNTHETIC-SECRET");
    },
    store: () => {
      throw new Error("store must not be reached");
    },
  });
  const result = await service.create(IDENTITY, "run-1");
  assert.deepEqual(result, { status: "internal-error" });
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC-SECRET"));
});

test("REG-S11 a Session deleted while the binding resolves is not registered", async () => {
  const gate = deferred();
  const h = harness({ awaitBinding: gate.promise });
  const pending = h.service.create(IDENTITY, "run-1");
  // The lookup started and is paused; the first write gate already passed.
  assert.equal(h.bindingQueries.length, 1);
  assert.equal(h.writableCalls(), 1);

  // A concurrent delete removes the Session while the create waits.
  h.setSessionMissing(true);
  gate.resolve();
  assert.deepEqual(await pending, { status: "not-found", resource: "session" });
  assert.equal(h.drafts.length, 0);
  // The post-lookup check returns first; no second gate call was needed.
  assert.equal(h.writableCalls(), 1);
});

test("REG-S12 a released, unchanged lookup writes exactly one registration", async () => {
  const gate = deferred();
  const h = harness({ awaitBinding: gate.promise });
  const pending = h.service.create(IDENTITY, "run-1");
  gate.resolve();
  assert.equal((await pending).status, "created");
  assert.equal(h.drafts.length, 1);
  // The write gate is checked before and again after the lookup.
  assert.equal(h.writableCalls(), 2);
});

test("REG-S13 write permission withdrawn while the binding resolves is never bypassed", async () => {
  const gate = deferred();
  const h = harness({ awaitBinding: gate.promise });
  const pending = h.service.create(IDENTITY, "run-1");
  assert.equal(h.bindingQueries.length, 1);

  const error = Object.assign(new Error("Session is archived and read-only"), { statusCode: 409 });
  h.setWritableError(error);
  gate.resolve();
  // The same rejection the first gate produces, so the HTTP layer still maps
  // it to its established 409 rather than a generic 500.
  await assert.rejects(pending, (thrown) => thrown === error);
  assert.equal(h.drafts.length, 0);
});
