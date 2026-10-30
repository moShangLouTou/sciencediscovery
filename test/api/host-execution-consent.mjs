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

/**
 * E2E-META
 * Purpose: Host computation requires explicit consent and records truthful network and credential provenance.
 * Steps:
 *   1. Start isolated product API and Runner processes with a local provisioner/model fixture.
 *   2. Deny a command and verify no output or execution record exists.
 *   3. Approve the same command and retrieve its output, host audit and credential-free environment snapshot.
 *   4. Repeat the command and verify another host consent is required even with Always Allow.
 * Environment: Linux, built workspace; node services/{api,runner}/dist/server.js; Python 3 and Bash.
 * Type: mocked
 * LLM: local scripted OpenAI-compatible endpoint; no live models.
 * WebSearch: none.
 * PaperSources: none.
 * MCP: not invoked; bundled optional servers may report unavailable during startup.
 * OtherExternal: local provisioner fixture links real system Python/Bash instead of downloading Conda packages.
 * Credentials: synthetic run-owned API/Runner tokens only.
 * CostSideEffects: no cost; isolated data under .e2e-data, stopped in finally; reports retained.
 * Invocation: pnpm build && node test/api/host-execution-consent.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, chmod, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runRoot = resolve(root, ".e2e-data", `host-consent-${Date.now()}-${process.pid}`);
await mkdir(runRoot, { recursive: true });
const dataDir = join(runRoot, "data");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
const steps = [], children = [], streams = [];
let verdict = "FAIL", failure, model;
async function step(name, action) {
  try { await action(); steps.push({ name, result: "PASS" }); }
  catch (error) { steps.push({ name, result: "FAIL", detail: error.message }); throw error; }
}
async function listen(server) {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}
async function freePort() {
  const server = netServer(); const port = await listen(server);
  await new Promise(done => server.close(done)); return port;
}
async function until(operation, label, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let error;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw new Error(`${label} timed out${error ? ": " + error.message : ""}`);
}
function start(entry, env, label) {
  const stream = createWriteStream(join(runRoot, `${label}.log`)); streams.push(stream);
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false }); children.push(child);
  return child;
}
const token = "host-journey-api", runnerToken = "host-journey-runner";
let origin, command, session, project;
async function api(path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  const text = await response.text(); assert.ok(response.ok, `${path}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
async function turn(decision) {
  let streamDone = false, streamError;
  const stream = fetch(`${origin}/api/sessions/${session.id}/messages`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "Perform the host computation once." }), signal: AbortSignal.timeout(30_000),
  }).then(async response => { assert.ok(response.ok); return response.text(); }).catch(error => { streamError = error; }).finally(() => { streamDone = true; });
  const pending = await until(async () => {
    const requests = await api(`/api/permission-requests?sessionId=${session.id}`);
    const found = requests.find(item => item.state === "pending");
    if (!found && streamDone) throw streamError ?? new Error("run ended without explicit host consent");
    return found;
  }, "host consent");
  assert.equal(pending.action, "direct_code"); assert.match(pending.summary, /Network mode is host/);
  await api(`/api/permission-requests/${pending.id}/decision`, { decision });
  await stream; if (streamError) throw streamError;
  const runs = await api(`/api/sessions/${session.id}/runs`);
  assert.equal(runs.at(-1)?.status, "completed", JSON.stringify(runs));
  return pending;
}
try {
  if (process.platform !== "linux") throw new Error("BLOCKED: this local host-consent journey requires Linux; Windows installer validation is separate");
  await step("Start isolated product processes with local fixtures", async () => {
    const provisioner = join(runRoot, "provisioner.mjs");
    await writeFile(provisioner, `#!${process.execPath}\nimport {mkdirSync,symlinkSync} from 'node:fs';\nimport {join} from 'node:path';\nconst a=process.argv.slice(2), p=a[a.indexOf('--prefix')+1];\nif(a.includes('create')) { mkdirSync(join(p,'bin'),{recursive:true});symlinkSync('/usr/bin/python3',join(p,'bin','python'));symlinkSync('/bin/bash',join(p,'bin','bash')); }\nelse if(a.includes('list')) console.log(JSON.stringify([{name:'python',version:'3',build_string:'host-fixture'}]));\nelse {console.error('unsupported provisioner operation');process.exit(1); }\n`);
    await chmod(provisioner, 0o755);
    model = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frames = body.messages.at(-1)?.role === "tool"
        ? [{ choices: [{ delta: { content: "Host computation handled." }, finish_reason: "stop" }] }]
        : [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `host-${Date.now()}`, type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command, environment_id: "starter-python" }) } }] }, finish_reason: "tool_calls" }] }];
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const modelPort = await listen(model), runnerPort = await freePort(), apiPort = await freePort();
    origin = `http://127.0.0.1:${apiPort}`;
    const env = { PATH: process.env.PATH, HOME: runRoot, LANG: "C.UTF-8", SCIENCE_AGENT_DATA_DIR: dataDir,
      SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(apiPort), SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1",
      SCIENCE_AGENT_RUNNER_PORT: String(runnerPort), SCIENCE_AGENT_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
      SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: runnerToken, SCIENCE_AGENT_EXECUTOR: "native",
      SCIENCE_AGENT_SANDBOX_PROVIDER: "none", SCIENCE_AGENT_PYTHON_PATH: "/usr/bin/python3",
      SCIENCE_AGENT_GATEWAY_PYTHON_PATH: "/usr/bin/python3", SCIENCE_AGENT_PROVISIONER_PATH: provisioner,
      SCIENTIFIC_ENVS: "1", SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0",
      SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "0", SD_SYNTHETIC_API_KEY: "host-journey-secret" };
    start("services/runner/dist/server.js", env, "runner");
    const health = await until(async () => { const res = await fetch(`${env.SCIENCE_AGENT_RUNNER_URL}/health`); const value = await res.json(); return value.scientificEnvs?.available ? value : undefined; }, "Runner environment");
    assert.equal(health.sandboxNetwork.available, false);
    assert.deepEqual(health.sandboxNetwork.modes, []);
    start("services/api/dist/server.js", env, "api");
    await until(async () => (await fetch(`${origin}/health`)).ok, "API readiness");
    const profile = await api("/api/models", { name: "Host journey", model: "host-fixture", apiToken: "local-fixture",
      baseUrl: `http://127.0.0.1:${modelPort}`, apiProtocol: "openai-chat-completions", apiVariant: "openai", proxyPolicy: "none" });
    project = await api("/api/projects", { name: "Host consent journey" });
    session = await api(`/api/projects/${project.id}/sessions`, { title: "Host consent", modelId: profile.id,
      approvalMode: "always_allow", settingsOverrides: { enabledConnectorIds: [], enabledSkillIds: [], semanticReviewEnabled: false } });
    const workspace = join(dataDir, "projects", project.id, "sessions", session.id, "workspace");
    // A fixture-owned relative link reproduces the reported precondition before any user computation.
    await writeFile(join(workspace, "input.txt"), "source"); await symlink("input.txt", join(workspace, "input-link.txt"));
    const code = "import os,pathlib; assert 'SCIENCE_AGENT_RUNNER_TOKEN' not in os.environ; assert 'SD_SYNTHETIC_API_KEY' not in os.environ; assert pathlib.Path('input-link.txt').read_text()=='source'; pathlib.Path('result.txt').write_text('42'); print('HOST_RESULT=42')";
    command = "python -c '" + code.replaceAll("'", "'\\''") + "'";
  });
  await step("Deny host consent: no output and no execution was dispatched", async () => {
    await turn("deny");
    assert.deepEqual(await api(`/api/sessions/${session.id}/execution-runs`), []);
    const files = await api(`/api/sessions/${session.id}/files`);
    assert.ok(!JSON.stringify(files).includes("result.txt"));
  });
  let previous;
  await step("Approve: retrieve real output and credential-free host provenance", async () => {
    previous = await turn("allow_matching");
    const runs = await api(`/api/sessions/${session.id}/execution-runs`);
    const result = runs.find(row => row.status === "succeeded"); assert.ok(result, JSON.stringify(runs));
    assert.equal(result.networkPolicy, "host"); assert.equal(result.sandbox, "none");
    assert.equal(result.directAuthorization.authorizationId, previous.permissionAuthorizationId ?? (await api(`/api/permission-requests?sessionId=${session.id}`)).find(row => row.id === previous.id).permissionAuthorizationId);
    const content = await fetch(`${origin}/api/sessions/${session.id}/file?path=result.txt`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await content.text(), "42");
    const snapshot = await fetch(`${origin}/api/cas/${result.envSnapshot.hash}`, { headers: { authorization: `Bearer ${token}` } });
    const variables = JSON.parse(await snapshot.text());
    assert.equal(variables.SCIENCE_AGENT_RUNNER_TOKEN, undefined); assert.equal(variables.SD_SYNTHETIC_API_KEY, undefined);
  });
  await step("Repeat: Always Allow and a matching grant still require fresh host consent", async () => {
    const again = await turn("deny"); assert.notEqual(again.id, previous.id); assert.notEqual(again.resource, previous.resource);
    const runs = await api(`/api/sessions/${session.id}/execution-runs`);
    assert.equal(runs.filter(row => row.status === "succeeded").length, 1);
  });
  verdict = "PASS";
} catch (error) { failure = error.message; if (failure.startsWith("BLOCKED:")) verdict = "BLOCKED"; process.exitCode = 1; }
finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(done => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); done(); });
  })));
  if (model) { model.closeAllConnections(); await new Promise(done => model.close(done)); }
  for (const stream of streams) stream.end();
  const report = `# Host execution consent journey\n\nVerdict: ${verdict}\n\nSHA: ${sha}; dirty: ${dirty}\n\nStart: node services/runner/dist/server.js + node services/api/dist/server.js (isolated environment in driver).\n\nDriver: node test/api/host-execution-consent.mjs\n\nInterface: public HTTP API, local scripted model, local provisioner fixture, real Python/Bash.\n\n| Step | Expected / observed |\n| --- | --- |\n${steps.map((s,i) => `| ${i+1}. ${s.name} | ${s.result}${s.detail ? ": " + s.detail.replaceAll("\n", " ").replaceAll("|", "\\|") : ""} |`).join("\n")}\n\nExecuted: ${steps.length}; passed: ${steps.filter(s=>s.result==="PASS").length}; failed: ${steps.filter(s=>s.result==="FAIL").length}; skipped: 0.\n${failure ? "\nFailure: " + failure : ""}\n\nEvidence: api.log, runner.log. Test-owned processes stopped; isolated data retained for inspection.\n`;
  await writeFile(join(runRoot, "report.md"), report.replaceAll(root, "<repo>"));
  console.log(`${verdict}: ${join(runRoot, "report.md")}`); if (failure) console.error(failure);
}
