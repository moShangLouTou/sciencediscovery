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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ScienceFlowRegistrationCorruptError,
  ScienceFlowRegistrationRepository,
  type ScienceFlowRunRegistrationDraft,
} from "./registration-repository.js";

function draft(
  overrides: Partial<ScienceFlowRunRegistrationDraft> = {},
): ScienceFlowRunRegistrationDraft {
  return {
    registrationId: "registration-1",
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    createdAt: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function repository(): {
  database: DatabaseSync;
  repository: ScienceFlowRegistrationRepository;
} {
  const database = new DatabaseSync(":memory:");
  return { database, repository: new ScienceFlowRegistrationRepository(database) };
}

test("REG-R01 an existing data directory gains the table and keeps records across a reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-registration-"));
  const file = join(directory, "catalog.sqlite");
  try {
    // A directory written by a build that predates registrations.
    const original = new DatabaseSync(file);
    original.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    original.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run("session-1", "Existing");
    const first = new ScienceFlowRegistrationRepository(original);
    const created = first.create(draft());
    assert.equal(created.created, true);
    original.close();

    // A rebuild opens the same data directory: no migration, records still there.
    const reopened = new DatabaseSync(file);
    const second = new ScienceFlowRegistrationRepository(reopened);
    assert.deepEqual(second.get("project-1", "session-1", "registration-1"), created.record);
    assert.deepEqual(second.list("project-1", "session-1", 100, 0), [created.record]);
    // The pre-existing table is untouched.
    assert.deepEqual(
      { ...(reopened.prepare("SELECT id, name FROM sessions").get() as object) },
      { id: "session-1", name: "Existing" },
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("REG-R02 a repeated create returns the stored record and never duplicates it", () => {
  const { database, repository: store } = repository();
  try {
    const first = store.create(draft());
    assert.equal(first.created, true);
    assert.equal(first.record.registrationId, "registration-1");

    // A retry carries a different server-generated id but the same business
    // triple; the original row and identity win.
    const retry = store.create(
      draft({ registrationId: "registration-2", createdAt: "2026-11-10T00:05:00.000Z" }),
    );
    assert.equal(retry.created, false);
    assert.deepEqual(retry.record, first.record);

    const count = database
      .prepare("SELECT COUNT(*) AS n FROM science_flow_run_registrations")
      .get() as { n: number };
    assert.equal(count.n, 1);
    assert.deepEqual(store.list("project-1", "session-1", 100, 0), [first.record]);
  } finally {
    database.close();
  }
});

test("REG-R03 the business triple is unique, so the same run in two Sessions is two records", () => {
  const { database, repository: store } = repository();
  try {
    const one = store.create(draft());
    const two = store.create(
      draft({ registrationId: "registration-2", sessionId: "session-2", runId: "run-1" }),
    );
    const three = store.create(
      draft({ registrationId: "registration-3", projectId: "project-2", runId: "run-1" }),
    );
    assert.equal(one.created, true);
    assert.equal(two.created, true);
    assert.equal(three.created, true);

    assert.deepEqual(store.list("project-1", "session-1", 100, 0), [one.record]);
    assert.deepEqual(store.list("project-1", "session-2", 100, 0), [two.record]);
    assert.deepEqual(store.list("project-2", "session-1", 100, 0), [three.record]);
    // A record is only reachable through its own Project and Session.
    assert.equal(store.get("project-2", "session-1", "registration-1"), undefined);
    assert.equal(store.get("project-1", "session-2", "registration-1"), undefined);
  } finally {
    database.close();
  }
});

test("REG-R04 a storage failure throws instead of reporting a success", () => {
  const { database, repository: store } = repository();
  database.close();
  assert.throws(() => store.create(draft()));
});

test("REG-R05 list is ordered, paginated, and bounded by the caller's limit", () => {
  const { database, repository: store } = repository();
  try {
    for (let index = 0; index < 3; index++) {
      store.create(
        draft({
          registrationId: `registration-${index}`,
          runId: `run-${index}`,
          createdAt: `2026-11-10T00:0${index}:00.000Z`,
        }),
      );
    }
    const ordered = store.list("project-1", "session-1", 100, 0);
    assert.deepEqual(
      ordered.map((record) => record.registrationId),
      ["registration-0", "registration-1", "registration-2"],
    );
    assert.deepEqual(
      store.list("project-1", "session-1", 2, 1).map((record) => record.registrationId),
      ["registration-1", "registration-2"],
    );
    assert.deepEqual(store.list("project-1", "session-1", 2, 5), []);
  } finally {
    database.close();
  }
});

test("REG-R06 deleteSession and deleteProject remove exactly their own rows", () => {
  const { database, repository: store } = repository();
  try {
    store.create(draft());
    store.create(draft({ registrationId: "registration-2", sessionId: "session-2", runId: "run-2" }));
    store.create(
      draft({
        registrationId: "registration-3",
        projectId: "project-2",
        sessionId: "session-3",
        runId: "run-3",
      }),
    );

    // Sessions are catalog-wide ids: deleting one removes its rows in any Project.
    store.deleteSession("session-1");
    assert.equal(store.get("project-1", "session-1", "registration-1"), undefined);
    assert.equal(store.get("project-1", "session-2", "registration-2")?.runId, "run-2");
    assert.equal(store.get("project-2", "session-3", "registration-3")?.runId, "run-3");

    // Deleting a Project removes every Session's registrations below it.
    store.deleteProject("project-1");
    assert.equal(store.get("project-1", "session-2", "registration-2"), undefined);
    assert.equal(store.get("project-2", "session-3", "registration-3")?.runId, "run-3");
  } finally {
    database.close();
  }
});

test("REG-R07 a corrupt, unknown-version, or mismatched row is refused, never repaired", () => {
  const cases: Array<{ readonly label: string; readonly recordJson: string }> = [
    { label: "invalid JSON", recordJson: "{not json" },
    {
      label: "unknown version",
      recordJson: JSON.stringify({
        schemaVersion: 99,
        registrationId: "registration-1",
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
        createdAt: "2026-11-10T00:00:00.000Z",
      }),
    },
    {
      label: "missing field",
      recordJson: JSON.stringify({
        schemaVersion: 1,
        registrationId: "registration-1",
        projectId: "project-1",
        runId: "run-1",
        createdAt: "2026-11-10T00:00:00.000Z",
      }),
    },
    {
      label: "row and payload disagree",
      recordJson: JSON.stringify({
        schemaVersion: 1,
        registrationId: "registration-1",
        projectId: "project-1",
        sessionId: "another-session",
        runId: "run-1",
        createdAt: "2026-11-10T00:00:00.000Z",
      }),
    },
    {
      label: "blank createdAt",
      recordJson: JSON.stringify({
        schemaVersion: 1,
        registrationId: "registration-1",
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
        createdAt: "   ",
      }),
    },
  ];

  for (const item of cases) {
    const { database, repository: store } = repository();
    try {
      database
        .prepare(
          `INSERT INTO science_flow_run_registrations
             (id, project_id, session_id, run_id, created_at, record_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "registration-1",
          "project-1",
          "session-1",
          "run-1",
          "2026-11-10T00:00:00.000Z",
          item.recordJson,
        );
      assert.throws(() => store.get("project-1", "session-1", "registration-1"), ScienceFlowRegistrationCorruptError, item.label);
      assert.throws(() => store.list("project-1", "session-1", 100, 0), ScienceFlowRegistrationCorruptError, item.label);
      // The bad row is left in place for an operator; it is not erased.
      const count = database
        .prepare("SELECT COUNT(*) AS n FROM science_flow_run_registrations")
        .get() as { n: number };
      assert.equal(count.n, 1, item.label);
    } finally {
      database.close();
    }
  }
});
