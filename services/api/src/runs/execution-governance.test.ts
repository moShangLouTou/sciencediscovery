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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProfile, Project, Session } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { createApiServer, closeApiServer } from "../http/index.js";
import type { ServerConfig } from "../bootstrap/config.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";

const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });

async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
}

for (const sandbox of ["none", "bubblewrap", "probe-failure"] as const) {
  test(`API run applies actual Runner governance: ${sandbox}`, { timeout: 30_000 }, async context => {
    const root = await mkdtemp(join(tmpdir(), "run-governance-"));
    const registrations: Array<{
      systemPrompt: string;
      tools: Array<{ name: string }>;
      nativeTools?: string[];
      hiddenJiuwenSwarmTools: string[];
      bridge: { url: string; token: string };
    }> = [];
    let delegated: { isError?: boolean } | undefined;
    let probes = 0;
    const adapter = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader("content-type", "application/json");
      if (request.url === "/agent/jiuwenswarm-config") { response.end("{}"); return; }
      if (request.url === "/agent/runs") {
        const registration = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof registrations[number];
        registrations.push(registration);
        response.setHeader("content-type", "application/x-ndjson");
        if (sandbox === "none" && registrations.length === 1) {
          const args = { description: "Check nested governance", prompt: "Report delegation availability without executing code." };
          response.write(JSON.stringify({ event: { type: "tool.started", trace: {
            id: "governance-child", name: "task", args, status: "running",
          } } }) + "\n");
          const result = await fetch(registration.bridge.url, { method: "POST",
            headers: { authorization: `Bearer ${registration.bridge.token}`, "content-type": "application/json" },
            body: JSON.stringify({ name: "task", arguments: args }), signal: AbortSignal.timeout(15_000) });
          delegated = await result.json() as typeof delegated;
        }
        response.end(JSON.stringify({ done: { finalText: "Governance verified." } }) + "\n");
        return;
      }
      response.writeHead(404).end("{}");
    });
    const runner = createServer((request, response) => {
      request.resume(); response.setHeader("content-type", "application/json");
      if (request.url === "/execution-capability") {
        probes++;
        if (sandbox === "probe-failure") { response.writeHead(503).end("{}"); return; }
        response.end(JSON.stringify({ instanceId: "governance-runner", checkedAt: new Date().toISOString(), sandbox,
          dependencyAvailable: true, sandboxUsable: sandbox !== "none", ready: true, reason: "ready" }));
        return;
      }
      if (request.url === "/health") {
        response.end(JSON.stringify({ status: "ok", platform: "linux", runnerVersion: "fixture",
          sandbox: sandbox === "bubblewrap" ? sandbox : "none", executionUser: "fixture",
          executionAuth: "bearer+hmac-sha256", executionTimeoutMs: 60_000, networkPolicy: "none", noNewPrivileges: true,
          cgroupDelegated: false, cgroupMode: "none", cgroupRoot: "", seccompBaseline: "multiarch-v1-profile-aware",
          maxFileBytes: 1_000_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_000_000, workerConcurrency: null,
          npuBroker: { enabled: false, queueConcurrency: 1, workloads: [] },
          sandboxNetwork: { available: sandbox === "bubblewrap", modes: ["none"] },
          scientificEnvs: { available: false, enabled: false, languages: [], provisioner: "fixture", startersReady: false } }));
        return;
      }
      response.writeHead(404).end("{}");
    });
    const adapterUrl = await listen(adapter), runnerUrl = await listen(runner);
    const overrides = {
      SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: adapterUrl,
      SCIENCE_AGENT_JIUWENSWARM_TOOLS: "jiuwenswarm", SCIENCE_AGENT_JIUWENSWARM_SKILLS: "ours",
      SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: "jiuwenswarm",
    };
    const previous = new Map(Object.keys(overrides).map(name => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    const config: ServerConfig = {
      authToken: "governance-fixture", dataDir: root, host: "127.0.0.1", port: 0,
      modelCatalogPath: join(root, "no-catalog"), paperPythonPath: join(root, "no-python"), paperWorkerPath: join(root, "no-worker"),
      gatewayIdleTimeoutMs: 30_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0, permissionWaitTimeoutMs: 0,
      runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_000_000,
      runnerToken: "runner-fixture", runnerUrl, sshConfigPath: join(root, "no-ssh"), staticDir: join(root, "no-web"),
      workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_000_000 },
      memoryGraph: { url: "", internalToken: "" }, evolve: { url: "", internalToken: "" },
    };
    const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
    context.after(async () => {
      try { await closeApiServer(server); }
      finally {
        await close(adapter); await close(runner);
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    });
    const origin = await listen(server);
    const headers = { authorization: "Bearer governance-fixture", "content-type": "application/json" };
    async function post<T>(path: string, body: unknown): Promise<T> {
      const response = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      assert.ok(response.ok, `${path}: ${response.status} ${text}`);
      return JSON.parse(text) as T;
    }
    const model = await post<ModelProfile>("/api/models", { name: "Loopback fixture", model: "fixture", apiToken: "synthetic-fixture",
      baseUrl: `${adapterUrl}/unused-model`, apiProtocol: "openai-chat-completions", apiVariant: "openai", proxyPolicy: "none" });
    const project = await post<Project>("/api/projects", { name: "Governance" });
    const session = await post<Session>(`/api/projects/${project.id}/sessions`, { title: "Governance", modelId: model.id,
      approvalMode: "ask_for_dangerous", settingsOverrides: { enabledConnectorIds: [] } });
    const response = await fetch(`${origin}/api/sessions/${session.id}/messages`, { method: "POST", headers,
      body: JSON.stringify({ content: "Check delegation availability without executing code." }), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.equal(registrations.length, sandbox === "none" ? 2 : 1, stream);
    if (sandbox === "none") assert.equal(delegated?.isError, false, "the platform task bridge must remain available");
    assert.ok(probes > 0, "the production run must consult the actual Runner without an injected governance argument");
    const restricted = sandbox !== "bubblewrap";
    for (const registered of registrations) {
      assert.equal(registered.systemPrompt.includes("## Delegation is restricted in this execution mode"), restricted);
      assert.equal(registered.hiddenJiuwenSwarmTools.includes("subagent_spawn"), restricted);
      assert.equal(registered.nativeTools?.includes("subagent_spawn") ?? false, !restricted);
    }
    assert.equal(registrations[0]!.tools.some(tool => tool.name === "task"), restricted);
  });
}
