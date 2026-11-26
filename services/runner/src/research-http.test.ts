// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedExecution, ResearchRunRequest } from "@sciencediscovery/schema";
import { createRunnerServer, loadRunnerConfig } from "./server.js";
import { createExecutionSignature, EXECUTION_SIGNATURE_HEADER, EXECUTION_TIMESTAMP_HEADER } from "./request-auth.js";
import { researchInputBundleDigest } from "./research-input-bundles.js";
import { PROOF_PROGRAM as program } from "../../../test/support/research/proof-program.mjs";

test("signed neutral HTTP submission consumes one plain file and publishes a managed execution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sd-neutral-http-"));
  const dataDir = join(root, "data"), workspaceRoot = join(dataDir, "projects", "proof");
  await mkdir(workspaceRoot, { recursive: true });
  const token = randomUUID();
  const config = { ...loadRunnerConfig({}, root), dataDir, authToken: token, npuBrokerEnabled: false,
    researchWorkloads: [{ workloadId: "proof-checker", program,
      fixtureRuntime: { identity: "fixture-python", interpreterPath: "/usr/bin/python3" } }] };
  const server = createRunnerServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: unknown, signed = true) => {
    const body = JSON.stringify(value), timestamp = String(Date.now());
    return fetch(url + path, { method: "POST", body, headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json", ...(signed ? {
        [EXECUTION_TIMESTAMP_HEADER]: timestamp, [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(token, timestamp, body),
      } : {}) } });
  };
  const bytes = Buffer.from("2 + 2 = 4\n");
  const file = { path: "fact.txt", roles: ["facts"], size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifest = { schemaVersion: 1 as const, contractDigest: "d".repeat(64), files: [file] };
  const bundleDigest = researchInputBundleDigest(manifest);
  const bundle = { schemaVersion: 1, contractDigest: manifest.contractDigest, bundleDigest,
    entries: [{ ...file, content: bytes.toString("base64") }] };
  assert.equal((await post("/research/input-bundles", bundle, false)).status, 401);
  assert.equal((await post("/research/input-bundles", bundle)).status, 200);
  const request: ResearchRunRequest = { kind: "research", schemaVersion: 1, workload: "proof-checker",
    executionId: "proof", agentId: "agent", workspaceRoot,
    permissionEpoch: { sessionId: "session", createdAt: new Date().toISOString(), id: "epoch",
      environmentRevisionId: "fixture-python", mounts: [{ source: "workspace", mode: "read-write" }],
      networkPolicy: "none", reason: "test", secretRefs: [] },
    inputs: { contractDigest: manifest.contractDigest, bundleDigest },
    schedule: { researchBudgetMs: 4000, reportBudgetMs: 2000, drainGraceMs: 200, verificationWindowMs: 1000, stopGraceMs: 200 } };
  assert.equal((await post("/research-executions", request, false)).status, 401);
  assert.equal((await post("/research-executions", { ...request, workload: "unregistered" })).status, 400);
  assert.equal((await post("/research-executions", { ...request, program: "untrusted" })).status, 400);
  const accepted = await post("/research-executions", request);
  assert.equal(accepted.status, 202, await accepted.text());
  assert.equal((await post("/research-executions", request)).status, 200);
  const read = (session = "session") => fetch(`${url}/research-executions/proof?agentId=agent&sessionId=${session}`,
    { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await read("another-session")).status, 404);
  let execution: ManagedExecution | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    execution = await (await read()).json();
    if (execution?.state === "completed" || execution?.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(execution?.state, "completed", JSON.stringify(execution));
  assert.equal(execution.research?.inputs?.state, "verified");
  assert.ok(execution.version);
  assert.equal(await readFile(join(workspaceRoot, "proof.txt"), "utf8"), "checked: 2 + 2 = 4\n");
  await writeFile(join(workspaceRoot, "proof.txt"), "later uncommitted change");
  const output = await fetch(`${url}/research-executions/proof/files?agentId=agent&sessionId=session&path=proof.txt`,
    { headers: { authorization: `Bearer ${token}` } });
  assert.equal(output.status, 200);
  assert.equal(await output.text(), "checked: 2 + 2 = 4\n");
});
