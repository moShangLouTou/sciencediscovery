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
 * Stage A of the round-18 feasibility harness: one inherited duplex channel
 * through real bubblewrap, a fixed relay and a real child process.
 *
 * What these cases establish, and what they do not:
 *
 * - the real Runner path runs (`prepareSandboxLaunch`, `spawnSandboxProcess`,
 *   `runSandboxed`), real `bwrap`, the real `research-gateway` filter, and a
 *   real `exec` into a Python child;
 * - the workload is a synthetic payload, independent of any product engine, and the
 *   host responder is a socket reader in this process, never a model service;
 * - nothing here is a gateway, a budget, a credential or a product route.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { after, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Stream } from "node:stream";
import { promisify } from "node:util";

import type { ExecutorConfig, SandboxLaunch } from "./executor.js";
import {
  killSandboxProcess,
  prepareSandboxLaunch,
  runSandboxed,
  spawnSandboxProcess,
} from "./executor.js";
import {
  boundaryTerminationVerified,
  captureExecutionBoundaryOutcome,
  type ExecutionBoundaryHandle,
} from "./execution-boundary.js";
import {
  RESEARCH_RELAY_EXIT_DESCRIPTOR_UNUSABLE,
  RESEARCH_RELAY_PORT,
  RESEARCH_TUNNEL_DESCRIPTOR_INDEX,
  openResearchTunnel,
  researchRelayBindArguments,
  researchRelayCommandPrefix,
  resolveResearchRelay,
  type ResearchTunnel,
} from "./research-tunnel.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-research-tunnel-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function bwrapAvailable(): Promise<boolean> {
  try {
    await execFileAsync(process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function executorConfig(dataDir: string): ExecutorConfig {
  return {
    bwrapPath: process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap",
    dataDir,
    execTimeoutMs: 0,
    maxOutputBytes: 0,
    maxWorkspaceBytes: 0,
  };
}

/** A launch that enters through the fixed relay and runs the real argv after it. */
async function relayLaunch(dataDir: string, workspace: string): Promise<SandboxLaunch> {
  const relay = await resolveResearchRelay(dataDir);
  return await prepareSandboxLaunch(executorConfig(dataDir), {
    chdir: "/workspace",
    environmentBinds: [],
    environmentPaths: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} },
    language: "python",
    pathEnv: "/usr/bin",
    tunnel: {
      bindArgs: researchRelayBindArguments(relay),
      commandPrefix: researchRelayCommandPrefix(),
    },
    workspaceBindArgs: ["--bind", workspace, "/workspace"],
    workspaceRoot: workspace,
  });
}

/** The payload program, delivered on the sandbox's stdin exactly as a run does. */
function payloadSource(nonce: string): string {
  return `
import asyncio, json, os, socket, sys

# First statements: what the child entry inherited. Nothing here has opened a
# descriptor yet, so anything beyond 0/1/2 would be an inherited channel alias.
facts = {}
try:
    os.fstat(${RESEARCH_TUNNEL_DESCRIPTOR_INDEX})
    facts["tunnel_fd"] = "open"
except OSError as error:
    facts["tunnel_fd"] = error.errno
facts["entry_fds"] = sorted(os.listdir("/proc/self/fd"))

def attempt(name, call):
    try:
        call()
        facts[name] = "allowed"
    except OSError as error:
        facts[name] = error.errno

attempt("socket_af_unix", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close())
attempt("socketpair_dgram", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM))

client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
client.settimeout(10)
client.connect(("127.0.0.1", ${RESEARCH_RELAY_PORT}))
client.sendall(("first:${nonce}\\n").encode())
client.sendall(("second:${nonce}\\n").encode())
reply = b""
while b"host:" not in reply:
    chunk = client.recv(4096)
    if not chunk:
        break
    reply += chunk
client.close()
facts["reply"] = reply.decode()

async def loop():
    task = asyncio.create_task(asyncio.sleep(5))
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return "cancelled"

facts["asyncio"] = asyncio.run(loop())

sys.stderr.write("payload-stderr-marker\\n")
sys.stdout.write(json.dumps(facts) + "\\n")
`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  handle?: ExecutionBoundaryHandle;
}

/**
 * Run the relay chain. `descriptor` overrides what the payload receives:
 * `null` passes no descriptor at all, a `Stream` passes that stream, and
 * `undefined` passes the tunnel's sandbox end.
 */
async function runRelay(options: {
  dataDir: string;
  payload: string;
  tunnel?: ResearchTunnel;
  descriptor?: Stream | null;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  timeoutMs?: number;
}): Promise<RunResult> {
  const workspace = await mkdtemp(join(options.dataDir, "workspace-"));
  const launch = await relayLaunch(options.dataDir, workspace);
  const config = executorConfig(options.dataDir);
  const stream = options.descriptor === undefined ? options.tunnel?.payload : options.descriptor ?? undefined;
  const descriptor = stream ? { index: RESEARCH_TUNNEL_DESCRIPTOR_INDEX, stream } : undefined;
  let handle: ExecutionBoundaryHandle | undefined;
  const onSpawned = (child: ChildProcessWithoutNullStreams) => {
    const outcome = captureExecutionBoundaryOutcome(`research-tunnel:${child.pid}`, {
      kind: "pid-namespace",
      pid: child.pid ?? 0,
      sandbox: "bubblewrap",
    });
    if (outcome.status === "captured") handle = outcome.handle;
  };
  const run = await runSandboxed(
    config,
    launch,
    ["/usr/bin/python3", "-"],
    options.payload,
    options.timeoutMs ?? 30_000,
    workspace,
    options.signal,
    "Research tunnel harness",
    0,
    256 * 1024,
    "research-gateway",
    options.onOutput,
    onSpawned,
    async () => {
      const spawned = await spawnSandboxProcess(
        config,
        launch,
        ["/usr/bin/python3", "-"],
        "research-gateway",
        undefined,
        onSpawned,
        descriptor,
      );
      // The Runner keeps no copy of the sandbox end: from here the host end
      // observes the sandbox's own close and nothing else.
      options.tunnel?.releaseSandboxEnd();
      return spawned;
    },
  );
  return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr, handle };
}

/**
 * Answer on the host end of the tunnel: collect the payload's reads and send
 * one reply carrying the host's own nonce over the same channel.
 */
function answerOnTunnel(host: Socket, hostNonce: string): { received: string[] } {
  const received: string[] = [];
  host.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    received.push(text);
    if (text.includes("second:")) host.write(`host:${hostNonce}\n`);
  });
  return { received };
}

test("a real bwrap payload adopts the inherited descriptor and exchanges nonces both ways", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  const tunnel = await openResearchTunnel(dataDir);
  const payloadNonce = randomBytes(8).toString("hex");
  const hostNonce = randomBytes(8).toString("hex");
  const seen = answerOnTunnel(tunnel.host, hostNonce);
  try {
    const run = await runRelay({ dataDir, payload: payloadSource(payloadNonce), tunnel });
    assert.equal(run.code, 0, run.stderr);
    const facts = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

    // M1: the relay adopted the descriptor without creating a socket (it would
    // have died with EPERM) and both directions carried real bytes; M2: the
    // workload is its child and was not given the channel at all.
    assert.equal(facts.tunnel_fd, 9, "the workload must see EBADF on the tunnel descriptor");
    assert.equal(facts.socket_af_unix, 1, "socket(AF_UNIX) must be refused with EPERM");
    assert.equal(facts.socketpair_dgram, 1, "socketpair(AF_UNIX, SOCK_DGRAM) must be refused");

    // Both directions over the real channel, more than one buffer each way.
    const payloadWrote = seen.received.join("");
    assert.ok(payloadWrote.includes(`first:${payloadNonce}`), payloadWrote);
    assert.ok(payloadWrote.includes(`second:${payloadNonce}`), payloadWrote);
    assert.match(String(facts.reply), new RegExp(`host:${hostNonce}`));

    // M2: the workload owns its stdio and inherits no alias of the channel.
    // Its only inherited descriptors are the three stdio streams plus bwrap's
    // own seccomp program at 3 — the launch has always left that one open — and
    // nothing of the tunnel or the listener.
    assert.match(run.stderr, /payload-stderr-marker/);
    assert.deepEqual(facts.entry_fds, ["0", "1", "2", "3"],
      "the workload must inherit only its own stdio and bwrap's seccomp handle");
    assert.equal(facts.asyncio, "cancelled");
  } finally {
    await tunnel.close();
  }
  assert.equal(tunnel.host.destroyed, true);
  assert.equal(tunnel.payload.destroyed, true);
  assert.deepEqual(await readdir(join(dataDir, "tunnels")), [], "no filesystem socket may survive the pair");
});

test("a missing descriptor is a fixed failure and the workload never starts", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  const run = await runRelay({ dataDir, payload: payloadSource("missing"), descriptor: null });
  assert.equal(run.code, RESEARCH_RELAY_EXIT_DESCRIPTOR_UNUSABLE);
  assert.equal(run.stdout.trim(), "", "the payload must not have run");
  assert.match(run.stderr, /descriptor 4 is unusable/);
});

test("a descriptor that is not a connected stream is refused the same way", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  // A regular file is a Stream with an fd, so it reaches the payload as fd 4 and
  // must fail at adoption rather than be mistaken for the tunnel.
  const file = createWriteStream(join(dataDir, "not-a-socket"));
  await new Promise<void>((ready) => file.once("open", () => ready()));
  try {
    const run = await runRelay({ dataDir, payload: payloadSource("unusable"), descriptor: file });
    assert.equal(run.code, RESEARCH_RELAY_EXIT_DESCRIPTOR_UNUSABLE);
    assert.equal(run.stdout.trim(), "");
    assert.match(run.stderr, /descriptor 4 is unusable/);
  } finally {
    file.destroy();
  }
});

test("the child's exit status is the relay's", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  const tunnel = await openResearchTunnel(dataDir);
  try {
    const failed = await runRelay({
      dataDir,
      payload: "import sys\nsys.stderr.write('child-failed\\n')\nsys.exit(17)\n",
      tunnel,
    });
    assert.equal(failed.code, 17, "a child exit status is passed through unchanged");
    assert.match(failed.stderr, /child-failed/);
  } finally {
    await tunnel.close();
  }
});

test("cancelling a running relay reclaims the process tree and the channel", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  const tunnel = await openResearchTunnel(dataDir);
  const workspace = await mkdtemp(join(dataDir, "workspace-"));
  const launch = await relayLaunch(dataDir, workspace);
  let handle: ExecutionBoundaryHandle | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = await spawnSandboxProcess(
      executorConfig(dataDir),
      launch,
      ["/usr/bin/python3", "-"],
      "research-gateway",
      undefined,
      (spawned) => {
        child = spawned;
        const outcome = captureExecutionBoundaryOutcome(`research-tunnel:${spawned.pid}`, {
          kind: "pid-namespace",
          pid: spawned.pid ?? 0,
          sandbox: "bubblewrap",
        });
        if (outcome.status === "captured") handle = outcome.handle;
      },
      { index: RESEARCH_TUNNEL_DESCRIPTOR_INDEX, stream: tunnel.payload },
    );
    tunnel.releaseSandboxEnd();
    const closed = new Promise<void>((done) => child?.once("close", () => done()));
    const ready = new Promise<void>((done) => {
      child?.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) done();
      });
    });
    child.stdin.end("import sys, time\nsys.stdout.write('READY\\n')\nsys.stdout.flush()\ntime.sleep(60)\n");
    await ready;
    // Observe the channel from here on: the sandbox end must close with the
    // process tree rather than linger as a half-open peer.
    const ended = new Promise<boolean>((done) => {
      tunnel.host.once("end", () => done(true));
      tunnel.host.once("close", () => done(true));
      tunnel.host.resume();
    });
    // Explicit cancellation of the running sandbox, not a timeout: the same
    // group kill a stop uses.
    assert.equal(killSandboxProcess(child), true);
    await closed;
    assert.notEqual(child.signalCode, null);
    assert.ok(handle, "the sandbox identity must be captured in the spawn turn");
    assert.equal(boundaryTerminationVerified(handle), true,
      "a cancelled sandbox must prove its namespace empty before the run reports ended");
    assert.equal(await Promise.race([ended, new Promise<boolean>((done) => setTimeout(() => done(false), 5_000))]),
      true, "the tunnel host end must observe the peer closing");
  } finally {
    child?.kill("SIGKILL");
    await tunnel.close();
  }
});

test("the relay refuses a launch that also carries the egress bridge", async () => {
  const dataDir = await scratchDirectory();
  const relay = await resolveResearchRelay(dataDir);
  await assert.rejects(prepareSandboxLaunch(executorConfig(dataDir), {
    chdir: "/workspace",
    egress: { bindArgs: [], commandPrefix: ["/bin/true"], env: {} },
    environmentBinds: [],
    environmentPaths: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} },
    language: "python",
    pathEnv: "/usr/bin",
    tunnel: {
      bindArgs: researchRelayBindArguments(relay),
      commandPrefix: researchRelayCommandPrefix(),
    },
    workspaceBindArgs: ["--bind", dataDir, "/workspace"],
    workspaceRoot: dataDir,
  }), /cannot run both the egress bridge and the model tunnel relay/);
});

test("an inherited descriptor without bubblewrap is refused before spawning", async () => {
  const dataDir = await scratchDirectory();
  await assert.rejects(spawnSandboxProcess(
    { bwrapPath: "unused", dataDir },
    { args: [], commandPrefix: [], chdir: dataDir, env: {}, sandbox: "none", executable: resolve(dataDir, "missing") },
    [], "baseline", undefined, undefined,
    { index: RESEARCH_TUNNEL_DESCRIPTOR_INDEX, stream: process.stdin },
  ), /Inherited descriptors are supported only by the bubblewrap sandbox/);
  await assert.rejects(spawnSandboxProcess(
    { bwrapPath: "unused", dataDir },
    { args: [], commandPrefix: [], chdir: dataDir, env: {}, sandbox: "bubblewrap" },
    [], "baseline", undefined, undefined,
    { index: 3, stream: process.stdin },
  ), /inherited descriptor index must be an integer of at least 4/);
});
