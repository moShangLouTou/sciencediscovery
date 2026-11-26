// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { cleanupExecutionResource, ProcessTerminationUnverifiedError, retainedTerminationResources } from "./termination-resources.js";

test("unverified termination owns deferred resources without blocking the execution and cleans each once after proof", async () => {
  const proof = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const error = new ProcessTerminationUnverifiedError("synthetic unverified process", { termination: proof.promise });
  let calls = 0;
  const cleanup = async () => { calls++; cleaned.resolve(); };
  await cleanupExecutionResource(error, cleanup, "synthetic-launch");
  await cleanupExecutionResource(error, cleanup, "synthetic-launch");
  assert.equal(calls, 0);
  assert.ok(retainedTerminationResources().some(value => value.resources.includes("synthetic-launch")));
  proof.resolve();
  await cleaned.promise;
  await cleanupExecutionResource(error, cleanup, "synthetic-launch");
  assert.equal(calls, 1);
});

test("ordinary joined failures clean resources immediately", async () => {
  let cleaned = false;
  await cleanupExecutionResource(new Error("joined storage failure"), async () => { cleaned = true; }, "joined-launch");
  assert.equal(cleaned, true);
});

test("concurrent confirmed resource registration keeps failed cleanup diagnostics owned", async () => {
  const proof = Promise.withResolvers<void>();
  const firstEntered = Promise.withResolvers<void>();
  const firstResult = Promise.withResolvers<void>();
  const secondCleaned = Promise.withResolvers<void>();
  const error = new ProcessTerminationUnverifiedError("synthetic cleanup race", { termination: proof.promise });
  let secondCalls = 0;
  await cleanupExecutionResource(error, async () => {
    firstEntered.resolve();
    await firstResult.promise;
    throw new Error("synthetic cleanup refusal");
  }, "controlled-failed-cleanup");
  proof.resolve();
  await firstEntered.promise;
  await cleanupExecutionResource(error, async () => { secondCalls++; secondCleaned.resolve(); }, "controlled-later-cleanup");
  assert.equal(secondCalls, 0, "one owner flushes its callbacks serially");
  firstResult.resolve();
  await secondCleaned.promise;
  assert.ok(retainedTerminationResources().some(value => value.cleanupFailed
    && value.resources.includes("controlled-failed-cleanup")));
});
