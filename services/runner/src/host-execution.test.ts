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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { PythonExecutionRequest, ShellExecutionRequest, HostExecutionAuthorization } from "@sciencediscovery/schema";
import { directExecutionCapability, executePython, executeShell, prepareSandboxEgress, type ExecutorConfig } from "./executor.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";
import type { EnvironmentStore } from "./environment-store.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(resolve(tmpdir(), "host-execution-"));
  t.after(() => rm(dataDir, { force: true, recursive: true }));
  const workspaceRoot = resolve(dataDir, "projects", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const config: ExecutorConfig = { sandboxProvider: "none", pythonPath: "python3", bwrapPath: "unused",
    dataDir, execTimeoutMs: 5000, maxOutputBytes: 10000, maxWorkspaceBytes: 1000000 };
  const permissionEpoch = { id: "epoch", sessionId: "session", createdAt: new Date().toISOString(),
    environmentRevisionId: "system", mounts: [{ source: "workspace" as const, mode: "read-write" as const }],
    networkPolicy: "none" as const, reason: "test", secretRefs: [] };
  const request: PythonExecutionRequest = { agentId: "main", code: "from pathlib import Path; Path('result.txt').write_text('42'); print(42)",
    executionId: "execution", workspaceRoot, permissionEpoch };
  const identity = await directExecutionCapability();
  const consent = (code: string, language: "python" | "shell"): HostExecutionAuthorization => ({
    authorizationId: "consent", runId: "run", agentId: "main", workspaceRoot, cwd: "", target: identity.target,
    account: identity.account, codeHash: createHash("sha256").update(code).digest("hex"), language,
  });
  const gateways = new EgressGatewayRegistry(dataDir, () => {});
  t.after(() => gateways.close());
  return { dataDir, workspaceRoot, config, request, consent, gateways };
}

test("Python rejects absent or changed host consent before creating files", async t => {
  const f = await fixture(t);
  for (const change of ["missing", "codeHash", "target", "account", "workspaceRoot", "language", "environment", "agentId"] as const) {
    const hostAuthorization = f.consent(f.request.code, "python");
    if (change !== "missing") (hostAuthorization as unknown as Record<string, string>)[change] = "changed";
    await assert.rejects(executePython(f.config, { ...f.request, ...(change === "missing" ? {} : { hostAuthorization }) }, undefined, undefined, undefined, f.gateways), /explicit host authorization/);
    await assert.rejects(readFile(resolve(f.workspaceRoot, "result.txt")), { code: "ENOENT" });
  }
});

test("authorized host Python excludes inherited secrets and reports honest network audit", async t => {
  const f = await fixture(t);
  const previous = process.env.SCIENCE_AGENT_RUNNER_TOKEN;
  process.env.SCIENCE_AGENT_RUNNER_TOKEN = "synthetic-runner-secret";
  t.after(() => { if (previous === undefined) delete process.env.SCIENCE_AGENT_RUNNER_TOKEN; else process.env.SCIENCE_AGENT_RUNNER_TOKEN = previous; });
  const code = "import os; from pathlib import Path; assert 'SCIENCE_AGENT_RUNNER_TOKEN' not in os.environ; Path('result.txt').write_text('42'); print(42)";
  const authorization = f.consent(code, "python");
  const result = await executePython(f.config, { ...f.request, code, hostAuthorization: authorization }, undefined, undefined, undefined, f.gateways);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "42");
  assert.equal(await readFile(resolve(f.workspaceRoot, "result.txt"), "utf8"), "42");
  assert.equal(result.environmentVariables.SCIENCE_AGENT_RUNNER_TOKEN, undefined);
  assert.equal(result.networkPolicy, "host");
  assert.equal(result.networkAccessRevision, undefined);
  assert.deepEqual(result.directAuthorization, authorization);
});

test("authorized host Python accepts a readable workspace-relative symlink", async t => {
  const f = await fixture(t);
  await symlink(".", resolve(f.workspaceRoot, "workspace-link"));
  const result = await executePython(f.config, { ...f.request, hostAuthorization: f.consent(f.request.code, "python") },
    undefined, undefined, undefined, f.gateways);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(resolve(f.workspaceRoot, "result.txt"), "utf8"), "42");
});

test("managed host shell requires consent and returns host network audit", async t => {
  const f = await fixture(t);
  const prefixPath = resolve(f.dataDir, "prefix");
  await mkdir(resolve(prefixPath, "bin"), { recursive: true });
  await symlink("/bin/bash", resolve(prefixPath, "bin", "bash"));
  const store = { capability: { available: true }, resolveRuntime: () => ({ prefixPath, revision: { id: "revision" } }) } as unknown as EnvironmentStore;
  const code = "printf 42 > result.txt; printf done";
  const request: ShellExecutionRequest = { ...f.request, code };
  await assert.rejects(executeShell(f.config, request, undefined, undefined, f.gateways, undefined, undefined, store), /explicit host authorization/);
  const authorization = f.consent(code, "shell");
  const result = await executeShell(f.config, { ...request, hostAuthorization: authorization }, undefined, undefined, f.gateways, undefined, undefined, store);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "done");
  assert.equal(result.networkPolicy, "host");
  assert.deepEqual(result.directAuthorization, authorization);
});

test("a proxy cannot advertise sandbox network enforcement for host execution", async t => {
  const f = await fixture(t);
  for (const mode of ["none", "domain-allowlist", "open"] as const) {
    await assert.rejects(prepareSandboxEgress("unused", { mode, revision: "r", allowedDomains: [], allowPrivateNetwork: false, egressProxyPolicy: "inherit" }, f.gateways, "none"), /cannot be enforced/);
  }
});
