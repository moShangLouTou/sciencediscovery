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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionStore } from "../store.js";

/**
 * These tests use the real `SessionStore` and its real deletion entry points,
 * not the repository in isolation: the point is that a real catalog rebuild
 * keeps the rows and that deleting a Session or Project through the store
 * removes exactly the registrations below it.
 */
async function temporaryRoot(): Promise<string> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(resolve(parent, "registrations-store-"));
}

test("REG-T01 registrations survive a real SessionStore close and reload", async (context) => {
  const root = await temporaryRoot();
  const open = new Set<SessionStore>();
  const openStore = async (): Promise<SessionStore> => {
    const store = new SessionStore(root);
    open.add(store);
    await store.load();
    return store;
  };
  const closeStore = async (store: SessionStore): Promise<void> => {
    if (!open.delete(store)) return;
    await store.whenDeletionsSettle().catch(() => undefined);
    store.close();
  };
  context.after(async () => {
    for (const store of [...open]) await closeStore(store);
    await rm(root, { recursive: true, force: true });
  });

  const first = await openStore();
  const project = await first.createProject("Registration persistence");
  const session = await first.createSession(project.id, "Registered", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const created = first.scienceFlowRegistrations.create({
    registrationId: "registration-1",
    projectId: project.id,
    sessionId: session.id,
    runId: "run-1",
    createdAt: "2026-11-10T00:00:00.000Z",
  });
  assert.equal(created.created, true);
  await closeStore(first);

  // A rebuild opens the same data directory: the additive table is created on
  // load and the row is still there, with the pre-existing Session intact.
  const reopened = await openStore();
  assert.deepEqual(
    reopened.scienceFlowRegistrations.get(project.id, session.id, "registration-1"),
    created.record,
  );
  assert.deepEqual(reopened.scienceFlowRegistrations.list(project.id, session.id, 100, 0), [
    created.record,
  ]);
  assert.equal(reopened.getSession(session.id)?.title, "Registered");
});

test("REG-T02 the real delete entry points clear only the rows below the target", async (context) => {
  const root = await temporaryRoot();
  const store = new SessionStore(root);
  context.after(async () => {
    await store.whenDeletionsSettle().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.load();

  const first = await store.createProject("Registrations A");
  const second = await store.createProject("Registrations B");
  const doomed = await store.createSession(first.id, "Doomed", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const kept = await store.createSession(first.id, "Kept", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const other = await store.createSession(second.id, "Other", {}, {}, {
    allowUnconfiguredModel: true,
  });
  const rows: Array<readonly [string, string, string, string]> = [
    ["registration-1", first.id, doomed.id, "run-1"],
    ["registration-2", first.id, kept.id, "run-2"],
    ["registration-3", second.id, other.id, "run-3"],
  ];
  for (const [registrationId, projectId, sessionId, runId] of rows) {
    store.scienceFlowRegistrations.create({
      registrationId,
      projectId,
      sessionId,
      runId,
      createdAt: "2026-11-10T00:00:00.000Z",
    });
  }

  // Deleting one Session through the store removes its registration only.
  await store.deleteSession(doomed.id, doomed.id);
  assert.equal(store.getSession(doomed.id), undefined);
  assert.equal(
    store.scienceFlowRegistrations.get(first.id, doomed.id, "registration-1"),
    undefined,
  );
  assert.equal(
    store.scienceFlowRegistrations.get(first.id, kept.id, "registration-2")?.runId,
    "run-2",
  );
  assert.equal(
    store.scienceFlowRegistrations.get(second.id, other.id, "registration-3")?.runId,
    "run-3",
  );

  // Deleting the Project removes every registration below it, including rows
  // whose Session was already deleted, and leaves the other Project alone.
  await store.deleteProject(first.id, first.id);
  assert.equal(store.getProject(first.id), undefined);
  assert.equal(
    store.scienceFlowRegistrations.get(first.id, kept.id, "registration-2"),
    undefined,
  );
  assert.deepEqual(store.scienceFlowRegistrations.list(first.id, kept.id, 100, 0), []);
  assert.equal(
    store.scienceFlowRegistrations.get(second.id, other.id, "registration-3")?.runId,
    "run-3",
  );
});
