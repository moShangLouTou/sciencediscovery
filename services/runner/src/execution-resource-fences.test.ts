// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnvironmentAccess } from "./environment-access.js";
import { assertEnvironmentMutationAllowed } from "./execution-resource-fences.js";

test("a durable environment fence rejects queued mutations after the runtime reader releases and after restart", async context => {
  await mkdir(resolve(process.cwd(), ".tmp/r"), { recursive: true });
  const root = await mkdtemp(resolve(process.cwd(), ".tmp/r/resource-fence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "executions.sqlite");
  const db = new DatabaseSync(path);
  context.after(() => db.close());
  db.exec("CREATE TABLE executions (id TEXT, record TEXT); CREATE TABLE execution_resources (execution TEXT, environment TEXT)");
  db.prepare("INSERT INTO executions VALUES (?, ?)").run("child", JSON.stringify({ state: "running" }));
  db.prepare("INSERT INTO execution_resources VALUES (?, ?)").run("child", "selected");
  const access = new EnvironmentAccess(id => assertEnvironmentMutationAllowed(path, id));
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const reader = access.run("selected", false, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let wrote = false;
  const mutation = assert.rejects(access.run("selected", true, async () => { wrote = true; }),
    { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  release.resolve();
  await reader;
  await mutation;
  assert.equal(wrote, false);
  db.prepare("UPDATE executions SET record = ?").run(JSON.stringify({ state: "unknown" }));
  const restarted = new EnvironmentAccess(id => assertEnvironmentMutationAllowed(path, id));
  await assert.rejects(restarted.run("selected", true, async () => assert.fail("restart released environment")),
    { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  await restarted.run("other", true, async () => {});
  db.exec("DELETE FROM execution_resources; DELETE FROM executions");
  await restarted.run("selected", true, async () => { wrote = true; });
  assert.equal(wrote, true);
});

test("unknown default environments, legacy unknown records and malformed ledger records fail closed", async context => {
  await mkdir(resolve(process.cwd(), ".tmp/r"), { recursive: true });
  const root = await mkdtemp(resolve(process.cwd(), ".tmp/r/resource-legacy-"));
  const path = resolve(root, "executions.sqlite");
  const db = new DatabaseSync(path);
  context.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE executions (id TEXT, record TEXT); CREATE TABLE execution_resources (execution TEXT, environment TEXT)");
  db.prepare("INSERT INTO executions VALUES (?, ?)").run("old", JSON.stringify({ state: "unknown" }));
  assert.throws(() => assertEnvironmentMutationAllowed(path, "any"), { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  db.prepare("INSERT INTO execution_resources VALUES (?, NULL)").run("old");
  assert.throws(() => assertEnvironmentMutationAllowed(path, "any"), { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  db.exec("DELETE FROM execution_resources");
  db.prepare("UPDATE executions SET record = ?").run(JSON.stringify({ state: "failed", startedAt: new Date().toISOString() }));
  assert.throws(() => assertEnvironmentMutationAllowed(path, "any"), { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  db.prepare("INSERT INTO execution_resources VALUES (?, ?)").run("old", "");
  assert.throws(() => assertEnvironmentMutationAllowed(path, "any"), { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
  db.exec("DELETE FROM execution_resources");
  db.prepare("UPDATE executions SET record = ?").run("{not-json");
  assert.throws(() => assertEnvironmentMutationAllowed(path, "any"), { code: "ENVIRONMENT_EXECUTION_UNVERIFIED" });
});
