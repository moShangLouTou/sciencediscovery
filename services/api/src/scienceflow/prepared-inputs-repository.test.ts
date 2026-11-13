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
import { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
  type ScienceFlowPreparedInputFileDto,
  type ScienceFlowPreparedInputsDto,
} from "@sciencediscovery/schema";

import {
  ScienceFlowPreparedInputsCorruptError,
  ScienceFlowPreparedInputsRepository,
  preparedInputsState,
} from "./prepared-inputs-repository.js";

const PLAN_ID = "plan-1";
const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";
const DIGEST = "a".repeat(64);

function files(): readonly ScienceFlowPreparedInputFileDto[] {
  return [
    { role: "manifest", path: "manifest.yaml", size: 10, sha256: "b".repeat(64) },
    {
      role: "task_yaml",
      path: "package/task.yaml",
      size: 20,
      sha256: "c".repeat(64),
    },
    {
      role: "description",
      path: "package/description.md",
      size: 30,
      sha256: "d".repeat(64),
    },
    {
      role: "evaluator",
      path: "package/evaluate.py",
      size: 40,
      sha256: "e".repeat(64),
    },
  ];
}

function prepared(
  overrides: Partial<ScienceFlowPreparedInputsDto> = {},
): ScienceFlowPreparedInputsDto {
  return Object.freeze({
    schemaVersion: SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
    planId: PLAN_ID,
    contractDigest: DIGEST,
    bundleDigest: "f".repeat(64),
    runnerId: "runner-1",
    preparedAt: "2026-11-13T00:00:00.000Z",
    outcome: "prepared" as const,
    canStart: false as const,
    fileCount: 4,
    totalBytes: 100,
    files: files(),
    generation: 1,
    ...overrides,
  });
}

function repository(): ScienceFlowPreparedInputsRepository {
  return new ScienceFlowPreparedInputsRepository(new DatabaseSync(":memory:"));
}

test("PREP-REPO-01 a stored receipt reads back with its role summary", () => {
  const store = repository();
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  const result = store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation: 1,
    prepared: prepared(),
  });
  assert.equal(result.saved, true);
  const stored = store.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  if (!stored) assert.fail("expected a stored receipt");
  assert.equal(stored.generation, 1);
  assert.equal(stored.prepared.outcome, "prepared");
  assert.equal(stored.prepared.canStart, false);
  assert.equal(stored.prepared.fileCount, 4);
  assert.equal(stored.prepared.totalBytes, 100);
  assert.deepEqual(
    stored.prepared.files.map((file) => file.role),
    ["manifest", "task_yaml", "description", "evaluator"],
  );
  // A different owner never reads the row.
  assert.equal(store.latest("project-2", SESSION_ID, PLAN_ID), undefined);
  assert.equal(
    preparedInputsState(PLAN_ID, stored).prepared?.bundleDigest,
    "f".repeat(64),
  );
  assert.equal(preparedInputsState(PLAN_ID, undefined).prepared, null);
});

test("PREP-REPO-02 only a strictly newer generation replaces a receipt", () => {
  const store = repository();
  const first = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(first, 1);
  assert.equal(
    store.save({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      generation: first,
      prepared: prepared({ generation: first }),
    }).saved,
    true,
  );

  const second = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(second, 2);
  // A late write at the older generation is refused and reports the winner.
  const late = store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation: first,
    prepared: prepared({
      generation: first,
      preparedAt: "2026-11-13T00:00:01.000Z",
    }),
  });
  assert.equal(late.saved, false);
  assert.equal(late.stored?.generation, 1);

  assert.equal(
    store.save({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      generation: second,
      prepared: prepared({
        generation: second,
        preparedAt: "2026-11-13T00:00:02.000Z",
        bundleDigest: "1".repeat(64),
      }),
    }).saved,
    true,
  );
  assert.equal(
    store.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.prepared.bundleDigest,
    "1".repeat(64),
  );
});

test("PREP-REPO-03 a session or project delete removes receipts and allocations", () => {
  const store = repository();
  const generation = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });

  store.deleteSession(SESSION_ID);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  // A receipt that was in flight when the delete committed cannot come back.
  const resurrect = store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });
  assert.equal(resurrect.saved, false);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);

  const next = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(next, 1, "the generation counter starts over after deletion");
  store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation: next,
    prepared: prepared({ generation: next }),
  });
  store.deleteProject(PROJECT_ID);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
});

test("PREP-REPO-04 a corrupt row throws instead of being repaired", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ScienceFlowPreparedInputsRepository(database);
  const generation = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });

  database
    .prepare("UPDATE science_flow_prepared_inputs SET record_json = ? WHERE plan_id = ?")
    .run(
      JSON.stringify({
        contractDigest: DIGEST,
        bundleDigest: "f".repeat(64),
        runnerId: "runner-1",
        preparedAt: "2026-11-13T00:00:00.000Z",
        outcome: "prepared",
        fileCount: 5,
        totalBytes: 100,
        files: files().map(({ role, path, size, sha256 }) => ({ role, path, size, sha256 })),
      }),
      PLAN_ID,
    );
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    (error: unknown) => error instanceof ScienceFlowPreparedInputsCorruptError,
  );
});

test("PREP-REPO-05 an unissued generation is never written", () => {
  const store = repository();
  const result = store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation: 7,
    prepared: prepared({ generation: 7 }),
  });
  assert.equal(result.saved, false);
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
});
