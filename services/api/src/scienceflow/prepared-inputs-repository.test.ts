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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  SCIENCE_FLOW_INPUT_FILE_ROLES,
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
const CONTRACT = "a".repeat(64);
const PREPARED_AT = "2026-11-13T00:00:00.000Z";

const corrupt = (error: unknown): boolean =>
  error instanceof ScienceFlowPreparedInputsCorruptError;

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

/** The same four roles over different evaluator bytes. */
function variantFiles(): readonly ScienceFlowPreparedInputFileDto[] {
  return files().map((file) =>
    file.role === "evaluator" ? { ...file, sha256: "9".repeat(64) } : file,
  );
}

const ROLE_INDEX = new Map(
  SCIENCE_FLOW_INPUT_FILE_ROLES.map((role, index) => [role, index]),
);

/**
 * The digest the Runner would compute: built from the canonical manifest the
 * receipt files describe, never from an arbitrary constant.
 */
function bundleDigestFor(
  contractDigest: string,
  list: readonly ScienceFlowPreparedInputFileDto[],
): string {
  const merged = new Map<
    string,
    { roles: ScienceFlowPreparedInputFileDto["role"][]; size: number; sha256: string }
  >();
  for (const file of list) {
    const existing = merged.get(file.path);
    if (existing === undefined) {
      merged.set(file.path, {
        roles: [file.role],
        size: file.size,
        sha256: file.sha256,
      });
      continue;
    }
    existing.roles.push(file.role);
  }
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files: [...merged.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([path, file]) => ({
        path,
        roles: [...file.roles].sort(
          (left, right) =>
            (ROLE_INDEX.get(left) as number) - (ROLE_INDEX.get(right) as number),
        ),
        size: file.size,
        sha256: file.sha256,
      })),
  };
  return createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
}

/** Distinct byte sets, as the receipt counts them. */
function summary(list: readonly ScienceFlowPreparedInputFileDto[]): {
  fileCount: number;
  totalBytes: number;
} {
  const sizes = new Map<string, number>();
  for (const file of list) {
    if (!sizes.has(file.path)) sizes.set(file.path, file.size);
  }
  return {
    fileCount: sizes.size,
    totalBytes: [...sizes.values()].reduce((total, size) => total + size, 0),
  };
}

function prepared(
  overrides: Partial<ScienceFlowPreparedInputsDto> = {},
): ScienceFlowPreparedInputsDto {
  const list = overrides.files ?? files();
  const contractDigest = overrides.contractDigest ?? CONTRACT;
  const counts = summary(list);
  return Object.freeze({
    schemaVersion: SCIENCE_FLOW_PREPARED_INPUTS_DTO_VERSION,
    planId: PLAN_ID,
    contractDigest,
    bundleDigest: bundleDigestFor(contractDigest, list),
    runnerId: "runner-1",
    preparedAt: PREPARED_AT,
    outcome: "prepared" as const,
    canStart: false as const,
    fileCount: counts.fileCount,
    totalBytes: counts.totalBytes,
    files: list,
    generation: 1,
    ...overrides,
  });
}

/** The reduced record the repository actually stores. */
function record(value: ScienceFlowPreparedInputsDto): string {
  return JSON.stringify({
    contractDigest: value.contractDigest,
    bundleDigest: value.bundleDigest,
    runnerId: value.runnerId,
    preparedAt: value.preparedAt,
    outcome: "prepared",
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    files: value.files.map(({ role, path, size, sha256 }) => ({
      role,
      path,
      size,
      sha256,
    })),
  });
}

/** A row written past `save`, to prove the read path also refuses it. */
function inject(
  database: DatabaseSync,
  value: ScienceFlowPreparedInputsDto,
  generation = value.generation,
): void {
  database
    .prepare(
      `INSERT INTO science_flow_prepared_inputs
         (plan_id, project_id, session_id, generation, prepared_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         generation = excluded.generation,
         prepared_at = excluded.prepared_at,
         record_json = excluded.record_json`,
    )
    .run(PLAN_ID, PROJECT_ID, SESSION_ID, generation, value.preparedAt, record(value));
}

function repository(): ScienceFlowPreparedInputsRepository {
  return new ScienceFlowPreparedInputsRepository(new DatabaseSync(":memory:"));
}

async function catalogFile(context: {
  after(callback: () => Promise<void>): void;
}): Promise<string> {
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  const root = await mkdtemp(
    resolve(process.cwd(), ".tmp", "prepared-inputs-race-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  return resolve(root, "catalog.sqlite");
}

/** A second real connection that must not wait for a lock. */
function connection(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 0");
  return database;
}

/** Runs `hook` inside the transaction, immediately before its commit. */
function interceptCommit(
  database: DatabaseSync,
  hook: () => void,
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string) => {
          if (sql === "COMMIT") hook();
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Fails the receipt upsert once, after the transaction has started. */
function failFirstUpsert(database: DatabaseSync): DatabaseSync {
  let failed = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (failed || !sql.includes("INSERT INTO science_flow_prepared_inputs")) {
            return statement;
          }
          return new Proxy(statement, {
            get(stmtTarget, stmtProperty) {
              if (stmtProperty === "run") {
                return () => {
                  failed = true;
                  throw new Error("injected sqlite write failure");
                };
              }
              const value = Reflect.get(stmtTarget, stmtProperty, stmtTarget) as unknown;
              return typeof value === "function"
                ? value.bind(stmtTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("PREP-REPO-01 a stored receipt reads back with its role summary", () => {
  const store = repository();
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.equal(store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID), 1);
  const value = prepared();
  const result = store.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation: 1,
    prepared: value,
  });
  assert.equal(result.saved, true);
  const stored = store.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  if (!stored) assert.fail("expected a stored receipt");
  assert.equal(stored.generation, 1);
  assert.equal(stored.prepared.outcome, "prepared");
  assert.equal(stored.prepared.canStart, false);
  assert.equal(stored.prepared.fileCount, 4);
  assert.equal(stored.prepared.totalBytes, 100);
  assert.equal(stored.prepared.bundleDigest, value.bundleDigest);
  assert.deepEqual(
    stored.prepared.files.map((file) => file.role),
    ["manifest", "task_yaml", "description", "evaluator"],
  );
  // A different owner never reads the row.
  assert.equal(store.latest("project-2", SESSION_ID, PLAN_ID), undefined);
  assert.equal(
    preparedInputsState(PLAN_ID, stored).prepared?.bundleDigest,
    value.bundleDigest,
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

  const next = prepared({
    generation: second,
    preparedAt: "2026-11-13T00:00:02.000Z",
    files: variantFiles(),
  });
  assert.equal(
    store.save({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      generation: second,
      prepared: next,
    }).saved,
    true,
  );
  assert.equal(
    store.latest(PROJECT_ID, SESSION_ID, PLAN_ID)?.prepared.bundleDigest,
    next.bundleDigest,
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

  // The counts no longer describe the stored file list.
  inject(database, prepared({ generation, fileCount: 5 }));
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    corrupt,
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

test("PREP-REPO-06 a receipt without every required role is refused", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ScienceFlowPreparedInputsRepository(database);
  const generation = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  // Counts and digest describe exactly this one-role list, so the only defect
  // is the missing manifest/task_yaml/description roles.
  const incomplete = prepared({
    generation,
    files: files().filter((file) => file.role === "evaluator"),
  });
  assert.throws(
    () =>
      store.save({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        generation,
        prepared: incomplete,
      }),
    corrupt,
  );
  assert.equal(store.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);

  inject(database, incomplete);
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    corrupt,
  );
});

test("PREP-REPO-07 one path with two roles must name one byte set", () => {
  const conflicting: readonly ScienceFlowPreparedInputFileDto[] = [
    { role: "manifest", path: "manifest.yaml", size: 10, sha256: "b".repeat(64) },
    {
      role: "task_yaml",
      path: "package/task.yaml",
      size: 20,
      sha256: "c".repeat(64),
    },
    // Same path and size, different bytes: two roles cannot disagree.
    {
      role: "description",
      path: "package/evaluate.py",
      size: 40,
      sha256: "d".repeat(64),
    },
    {
      role: "evaluator",
      path: "package/evaluate.py",
      size: 40,
      sha256: "e".repeat(64),
    },
  ];
  const database = new DatabaseSync(":memory:");
  const store = new ScienceFlowPreparedInputsRepository(database);
  const generation = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  const value = prepared({ generation, files: conflicting });
  assert.throws(
    () =>
      store.save({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        generation,
        prepared: value,
      }),
    corrupt,
  );
  inject(database, value);
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    corrupt,
  );
});

test("PREP-REPO-08 the bundle digest is rebuilt from the stored file set", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ScienceFlowPreparedInputsRepository(database);
  const generation = store.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  const forged = prepared({ generation, bundleDigest: "0".repeat(64) });
  assert.throws(
    () =>
      store.save({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        generation,
        prepared: forged,
      }),
    corrupt,
  );
  inject(database, forged);
  assert.throws(
    () => store.latest(PROJECT_ID, SESSION_ID, PLAN_ID),
    corrupt,
  );
});

test("PREP-REPO-09 a delete on another connection cannot enter the save transaction", async (context) => {
  const path = await catalogFile(context);
  const writerConnection = connection(path);
  const deleterConnection = connection(path);
  const deleter = new ScienceFlowPreparedInputsRepository(deleterConnection);
  let blocked: unknown = "not attempted";
  const writer = new ScienceFlowPreparedInputsRepository(
    interceptCommit(writerConnection, () => {
      // The writer's transaction is still open here: the delete must be
      // refused rather than slip between the allocation check and the write.
      try {
        deleter.deleteSession(SESSION_ID);
        blocked = "deleted";
      } catch (error) {
        blocked = error;
      }
    }),
  );

  const generation = writer.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  const stored = writer.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });
  assert.equal(stored.saved, true);
  assert.ok(
    blocked instanceof Error,
    `the delete had to be refused, got ${String(blocked)}`,
  );
  assert.match((blocked as Error).message, /locked/i);

  // Once the transaction has committed, the same delete succeeds.
  assert.ok(deleter.latest(PROJECT_ID, SESSION_ID, PLAN_ID));
  deleter.deleteSession(SESSION_ID);
  assert.equal(deleter.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
});

test("PREP-REPO-10 a delete committed on another connection refuses the late save", async (context) => {
  const path = await catalogFile(context);
  const writer = new ScienceFlowPreparedInputsRepository(connection(path));
  const deleterConnection = connection(path);
  const deleter = new ScienceFlowPreparedInputsRepository(deleterConnection);

  const generation = writer.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  deleter.deleteSession(SESSION_ID);

  const late = writer.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });
  assert.equal(late.saved, false);
  assert.equal(writer.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  assert.equal(deleter.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
  // The allocation is gone too: retrying the same generation revives nothing.
  assert.equal(
    writer.save({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      generation,
      prepared: prepared({ generation }),
    }).saved,
    false,
  );
  const rows = deleterConnection
    .prepare("SELECT COUNT(*) AS count FROM science_flow_prepared_inputs")
    .get() as { count: number };
  const allocations = deleterConnection
    .prepare("SELECT COUNT(*) AS count FROM science_flow_prepared_input_generations")
    .get() as { count: number };
  assert.equal(rows.count, 0);
  assert.equal(allocations.count, 0);

  // A Project delete from the other connection behaves the same way.
  const next = writer.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(next, 1, "the counter restarts after the delete");
  deleter.deleteProject(PROJECT_ID);
  assert.equal(
    writer.save({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      generation: next,
      prepared: prepared({ generation: next }),
    }).saved,
    false,
  );
  assert.equal(deleter.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);
});

test("PREP-REPO-11 a failed save rolls back and the same generation may be retried", async (context) => {
  const path = await catalogFile(context);
  const database = connection(path);
  const observer = new ScienceFlowPreparedInputsRepository(connection(path));
  const writer = new ScienceFlowPreparedInputsRepository(failFirstUpsert(database));

  const generation = writer.allocate(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.throws(
    () =>
      writer.save({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        generation,
        prepared: prepared({ generation }),
      }),
    /injected sqlite write failure/,
  );
  // The failed transaction left neither a receipt nor a visible partial row.
  assert.equal(observer.latest(PROJECT_ID, SESSION_ID, PLAN_ID), undefined);

  const retried = writer.save({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    generation,
    prepared: prepared({ generation }),
  });
  assert.equal(retried.saved, true);
  const seen = observer.latest(PROJECT_ID, SESSION_ID, PLAN_ID);
  assert.equal(seen?.generation, generation);
  assert.equal(seen?.prepared.bundleDigest, prepared().bundleDigest);
});
