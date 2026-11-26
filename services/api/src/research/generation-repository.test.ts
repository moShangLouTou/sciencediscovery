// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ResearchGenerationRepository, ResearchGenerationCorruptError } from "./generation-repository.js";

interface Observation { readonly time: string; readonly evidence: string; readonly privatePath?: string }
function repository(database: DatabaseSync) {
  return new ResearchGenerationRepository<Observation>(database, {
    table: "product_observations", generationsTable: "product_generations", keyColumn: "plan_id", timeColumn: "checked_at",
    encode: ({ time, evidence }) => ({ time, evidence }),
    decode(value, identity) {
      if (typeof value !== "object" || value === null || !("time" in value) || value.time !== identity.recordedAt
        || !("evidence" in value) || typeof value.evidence !== "string") throw new ResearchGenerationCorruptError();
      return { time: identity.recordedAt, evidence: value.evidence };
    },
  });
}
const identity = { key: "contract", projectId: "project", sessionId: "session", recordedAt: "time" };
const draft = (generation: number, evidence = "proof") => ({ ...identity, generation, record: { time: "time", evidence, privatePath: "/private" } });

test("generations survive reconstruction and older results cannot replace a newer observation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = repository(db);
    assert.equal(store.allocate("project", "session", "contract"), 1);
    assert.equal(repository(db).allocate("project", "session", "contract"), 2);
    assert.equal(store.save(draft(2)).saved, true);
    assert.deepEqual(store.save(draft(1, "slow")), { saved: false, stored: { generation: 2, record: { time: "time", evidence: "proof" } } });
    assert.equal(store.save(draft(2, "changed")).saved, false);
    assert.equal(store.save(draft(3)).saved, false);
    assert.equal(store.latest("other", "session", "contract"), undefined);
    assert.equal(db.prepare("SELECT record_json FROM product_observations").get()?.record_json, '{"time":"time","evidence":"proof"}');
    db.exec("DELETE FROM product_generations");
    assert.equal(repository(db).allocate("project", "session", "contract"), 3, "legacy observations seed the counter");
  } finally { db.close(); }
});

test("owner deletion prevents a late write across SQLite connections", () => {
  const base = resolve(".tmp/r"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, "generations-"));
  const db = new DatabaseSync(resolve(root, "catalog.sqlite"));
  const other = new DatabaseSync(resolve(root, "catalog.sqlite"));
  try {
    const store = repository(db), deletion = repository(other);
    store.allocate("project", "session", "contract");
    deletion.deleteSession("session");
    assert.deepEqual(store.save(draft(1)), { saved: false });
    store.allocate("project", "session", "contract");
    store.save(draft(1));
    deletion.deleteProject("project");
    assert.equal(store.latest("project", "session", "contract"), undefined);
    assert.deepEqual(store.save(draft(1)), { saved: false });
  } finally { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("corrupt evidence and invalid generations fail without silently repairing storage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = repository(db);
    assert.throws(() => store.allocate("", "session", "contract"), ResearchGenerationCorruptError);
    store.allocate("project", "session", "contract");
    assert.throws(() => store.allocate("foreign", "session", "contract"), ResearchGenerationCorruptError);
    assert.throws(() => store.save(draft(0)), ResearchGenerationCorruptError);
    assert.throws(() => store.save({ ...draft(1), recordedAt: "different" }), ResearchGenerationCorruptError);
    store.save(draft(1));
    db.exec("UPDATE product_observations SET record_json = '{'");
    assert.throws(() => store.latest("project", "session", "contract"), ResearchGenerationCorruptError);
    assert.throws(() => store.allocate("project", "session", "contract"), ResearchGenerationCorruptError);
    db.exec("UPDATE product_observations SET record_json = '{\"time\":\"time\",\"evidence\":\"proof\"}'; UPDATE product_generations SET allocated = 9007199254740991");
    assert.throws(() => store.allocate("project", "session", "contract"), ResearchGenerationCorruptError);
    assert.equal(db.prepare("SELECT allocated FROM product_generations").get()?.allocated, Number.MAX_SAFE_INTEGER);
  } finally { db.close(); }
});

test("SQL names are validated before schema mutation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => new ResearchGenerationRepository(db, { table: "unsafe;", generationsTable: "generations", encode: value => value, decode: value => value }), /Unsafe/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count, 0);
  } finally { db.close(); }
});
