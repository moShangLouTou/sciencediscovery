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
 * Stage B of the round-18 feasibility harness: the `research-gateway` seccomp
 * variant, its generated rules for both architectures, and what a real sandbox
 * can and cannot reach under it.
 *
 * The generated-rule cases run a small interpreter over the bytecode, so a
 * wrong jump distance, a missing argument load or an accidentally skipped deny
 * entry fails on both architectures without depending on the host kernel. The
 * native cases run real `bwrap` against **live host IPC services** in the
 * mounted workspace: a stream listener on a filesystem path, a datagram
 * listener on a filesystem path and a stream listener on an abstract name, each
 * of which answers a host-side probe afterwards. A sandbox that cannot see them
 * is the evidence; a missing service would prove nothing.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { after, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutorConfig } from "./executor.js";
import { prepareSandboxLaunch, runSandboxed } from "./executor.js";
import { baselineSeccompFilter } from "./seccomp.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-gateway-filter-"));
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

// ---------------------------------------------------------------------------
// Generated rules: decode the bytecode and interpret it the way the kernel does.
// ---------------------------------------------------------------------------

const BPF_LD_W_ABS = 0x20;
const BPF_ALU_AND_K = 0x54;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const AUDIT_ARCH = { arm64: 0xc00000b7, x64: 0xc000003e } as const;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_EPERM = 0x00050001;

interface Instruction {
  code: number;
  jumpTrue: number;
  jumpFalse: number;
  value: number;
}

function decode(filter: Buffer): Instruction[] {
  const program: Instruction[] = [];
  for (let offset = 0; offset + 8 <= filter.length; offset += 8) {
    program.push({
      code: filter.readUInt16LE(offset),
      jumpFalse: filter.readUInt8(offset + 3),
      jumpTrue: filter.readUInt8(offset + 2),
      value: filter.readUInt32LE(offset + 4),
    });
  }
  return program;
}

type Verdict = "allow" | "eperm" | "kill-process";

/**
 * Interpret one syscall through the filter. `args` are the syscall's scalar
 * arguments, i.e. the words at `struct seccomp_data` offsets 16, 24 and 32.
 */
function evaluate(architecture: keyof typeof AUDIT_ARCH, filter: Buffer, syscall: number, args: number[]): Verdict {
  const program = decode(filter);
  const word = (offset: number): number => {
    if (offset === 0) return syscall;
    if (offset === 4) return AUDIT_ARCH[architecture];
    const index = (offset - 16) / 8;
    assert.ok(Number.isInteger(index) && index >= 0 && index < args.length,
      `the filter loaded an argument the test did not supply: offset ${offset}`);
    return args[index]!;
  };
  let accumulator = 0;
  let counter = 0;
  for (let steps = 0; steps < 10_000; steps += 1) {
    assert.ok(counter < program.length, "the filter fell off the end of the program");
    const instruction = program[counter]!;
    if (instruction.code === BPF_LD_W_ABS) {
      accumulator = word(instruction.value);
      counter += 1;
      continue;
    }
    if (instruction.code === BPF_ALU_AND_K) {
      accumulator &= instruction.value;
      counter += 1;
      continue;
    }
    if (instruction.code === BPF_JMP_JEQ_K) {
      counter += 1 + (accumulator === instruction.value ? instruction.jumpTrue : instruction.jumpFalse);
      continue;
    }
    if (instruction.code === BPF_RET_K) {
      if (instruction.value === SECCOMP_RET_ALLOW) return "allow";
      if (instruction.value === SECCOMP_RET_EPERM) return "eperm";
      assert.fail(`the filter returned an unexpected action 0x${instruction.value.toString(16)}`);
    }
    assert.fail(`the filter used an instruction this test does not model: 0x${instruction.code.toString(16)}`);
  }
  assert.fail("the filter did not terminate");
}

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const AF_PACKET = 17;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_RAW = 3;
const SOCK_CLOEXEC = 0o2000000;
const SOCK_NONBLOCK = 0o4000;

const SOCKET_SYSCALL = { arm64: 198, x64: 41 } as const;
const SOCKETPAIR_SYSCALL = { arm64: 199, x64: 53 } as const;
// One representative for each family the baseline denies and this variant must
// keep denying: ptrace, mount, bpf, io_uring, setns.
const DENIED_SAMPLE = { arm64: [117, 40, 280, 425, 268], x64: [101, 165, 321, 425, 308] } as const;
const ALLOWED_UNCHECKED = { arm64: [200, 201, 202, 203, 242], x64: [42, 43, 49, 50, 288] } as const;

for (const architecture of ["x64", "arm64"] as const) {
  test(`the ${architecture} research-gateway filter allows exactly the loopback socket calls`, () => {
    const filter = baselineSeccompFilter(architecture, "research-gateway");
    const socket = SOCKET_SYSCALL[architecture];
    const socketpair = SOCKETPAIR_SYSCALL[architecture];

    // socket(): AF_INET + SOCK_STREAM, with and without the inherited flags.
    assert.equal(evaluate(architecture, filter, socket, [AF_INET, SOCK_STREAM, 0]), "allow");
    assert.equal(evaluate(architecture, filter, socket, [AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0]), "allow");
    for (const [domain, type] of [
      [AF_INET, SOCK_DGRAM], [AF_INET, SOCK_RAW], [AF_INET6, SOCK_STREAM],
      [AF_UNIX, SOCK_STREAM], [AF_UNIX, SOCK_DGRAM], [AF_NETLINK, SOCK_STREAM],
      [AF_PACKET, SOCK_STREAM], [AF_INET, SOCK_DGRAM | SOCK_CLOEXEC],
    ] as const) {
      assert.equal(evaluate(architecture, filter, socket, [domain, type, 0]), "eperm",
        `socket(${domain}, ${type}) must be refused`);
    }

    // socketpair(): AF_UNIX + SOCK_STREAM + protocol 0 only.
    assert.equal(evaluate(architecture, filter, socketpair, [AF_UNIX, SOCK_STREAM, 0]), "allow");
    assert.equal(evaluate(architecture, filter, socketpair, [AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0]), "allow");
    for (const [domain, type, protocol] of [
      [AF_UNIX, SOCK_DGRAM, 0], [AF_UNIX, SOCK_RAW, 0], [AF_INET, SOCK_STREAM, 0],
      [AF_UNIX, SOCK_STREAM, 6],
    ] as const) {
      assert.equal(evaluate(architecture, filter, socketpair, [domain, type, protocol]), "eperm",
        `socketpair(${domain}, ${type}, ${protocol}) must be refused`);
    }

    // The pointer-argument calls are allowed unchecked, and the other families
    // keep the baseline's denial even for a syscall number the blocks mention.
    for (const syscall of ALLOWED_UNCHECKED[architecture]) {
      assert.equal(evaluate(architecture, filter, syscall, [0, 0, 0]), "allow", `syscall ${syscall} must stay allowed`);
    }
    for (const syscall of DENIED_SAMPLE[architecture]) {
      assert.equal(evaluate(architecture, filter, syscall, [0, 0, 0]), "eperm", `syscall ${syscall} must stay denied`);
    }
    assert.equal(evaluate(architecture, filter, 1, [0, 0, 0]), "allow",
      "an ordinary syscall the filter never mentions must still pass");
    assert.equal(evaluate(architecture, filter, 0x7fffffff, [0, 0, 0]), "allow",
      "an unknown syscall number must reach the final allow, not a deny");
  });

  test(`the ${architecture} research and research-gateway variants stay distinct`, () => {
    const research = baselineSeccompFilter(architecture, "research");
    // The existing research variant still refuses every socket() call,
    // including the loopback one the gateway variant needs: it is not widened.
    assert.equal(evaluate(architecture, research, SOCKET_SYSCALL[architecture], [AF_INET, SOCK_STREAM, 0]), "eperm");
    assert.equal(evaluate(architecture, research, SOCKETPAIR_SYSCALL[architecture], [AF_UNIX, SOCK_STREAM, 0]), "allow");
    // The gateway variant is the stricter one for pairs, which is the whole
    // point of the new type/protocol check.
    const gateway = baselineSeccompFilter(architecture, "research-gateway");
    assert.equal(evaluate(architecture, gateway, SOCKETPAIR_SYSCALL[architecture], [AF_UNIX, SOCK_DGRAM, 0]), "eperm");
    assert.equal(evaluate(architecture, research, SOCKETPAIR_SYSCALL[architecture], [AF_UNIX, SOCK_DGRAM, 0]), "allow",
      "recorded on purpose: the pre-existing research variant admits a datagram pair");
  });
}

// ---------------------------------------------------------------------------
// Native behaviour inside a real sandbox.
// ---------------------------------------------------------------------------

const HOST_SERVICES = String.raw`
"""Live host IPC services, in one process, for the sandbox reachability cases."""
import json
import socket
import sys
import threading

stream_path, dgram_path, abstract_name = sys.argv[1], sys.argv[2], sys.argv[3]


def log(**fields):
    print(json.dumps(fields), flush=True)


stream_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
stream_server.bind(stream_path)
stream_server.listen(8)
dgram_server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
dgram_server.bind(dgram_path)
abstract_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
abstract_server.bind("\0" + abstract_name)
abstract_server.listen(8)


def serve(name, server):
    while True:
        try:
            client, _ = server.accept()
        except OSError:
            return
        log(event="accept", service=name)
        try:
            data = client.recv(4096)
        except OSError:
            data = b""
        log(event="data", service=name, payload=data.decode(errors="replace"))
        try:
            client.sendall(b"pong")
        except OSError:
            pass
        client.close()


threading.Thread(target=serve, args=("stream", stream_server), daemon=True).start()
threading.Thread(target=serve, args=("abstract", abstract_server), daemon=True).start()
log(event="ready")
# An unbound AF_UNIX datagram client has no address to reply to on this kernel,
# so the datagram service only records what it receives. Its liveness is proven
# by recording a host-side probe before and after the sandboxed run.
while True:
    try:
        data, address = dgram_server.recvfrom(4096)
    except OSError:
        break
    log(event="datagram", payload=data.decode(errors="replace"))
`;

interface HostLog {
  readonly events: Array<Record<string, unknown>>;
  waitFor(predicate: () => boolean): Promise<void>;
}

/** Collect the host helper's JSON lines and let a case wait for one. */
function hostLog(child: ChildProcess): HostLog {
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr?.resume();
  return {
    events,
    async waitFor(predicate) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail("the host service helper did not answer in time");
        await new Promise((done) => setTimeout(done, 20));
      }
    },
  };
}

/** A host-side probe of the filesystem stream service. */
async function probeStream(path: string): Promise<string> {
  return await new Promise<string>((done, fail) => {
    const socket = net.connect(path);
    let reply = "";
    socket.once("error", fail);
    socket.once("connect", () => socket.write("host-probe"));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString();
      socket.destroy();
      done(reply);
    });
  });
}

/** A host-side probe of the filesystem datagram service (Node cannot send them). */
async function probeDatagram(path: string, python: string): Promise<void> {
  const probe = String.raw`
import socket, sys
client = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
client.sendto(b"host-probe", sys.argv[1])
client.close()
`;
  await execFileAsync(python, ["-c", probe, path]);
}

async function hostPython(): Promise<string> {
  const found = await execFileAsync("sh", ["-c", "command -v python3"]);
  const path = found.stdout.trim();
  assert.ok(path, "the host services need a Python 3 interpreter");
  return path;
}

interface HostServices {
  readonly log: HostLog;
  readonly streamPath: string;
  readonly dgramPath: string;
  readonly abstractName: string;
  readonly process: ChildProcess;
}

async function startHostServices(dataDir: string, workspace: string): Promise<HostServices> {
  const streamPath = join(workspace, "host-stream.sock");
  const dgramPath = join(workspace, "host-dgram.sock");
  const abstractName = `scidiscovery-probe-${randomBytes(4).toString("hex")}`;
  const script = join(dataDir, "host-services.py");
  await writeFile(script, HOST_SERVICES);
  const process = execFile(await hostPython(), [script, streamPath, dgramPath, abstractName]);
  children.push(process);
  const log = hostLog(process);
  await log.waitFor(() => log.events.some((event) => event.event === "ready"));
  return { abstractName, dgramPath, log, process, streamPath };
}

/** The workload program: every permitted and refused route, reported as JSON. */
function workloadSource(options: {
  hostLoopbackPort: number;
  lanAddress: string;
  latePath: string;
}): string {
  return String.raw`
import array, asyncio, json, os, socket, struct, sys, time

workspace = "/workspace"
stream_path = os.path.join(workspace, "host-stream.sock")
dgram_path = os.path.join(workspace, "host-dgram.sock")
late_path = ${JSON.stringify(options.latePath)}
results = {}

def attempt(name, call):
    try:
        results[name] = call()
    except OSError as error:
        results[name] = {"errno": error.errno}

def make_socket(domain, kind, protocol=0):
    def create():
        s = socket.socket(domain, kind, protocol)
        s.close()
        return "allowed"
    return create

for name, domain, kind in [
    ("unix_stream", socket.AF_UNIX, socket.SOCK_STREAM),
    ("unix_dgram", socket.AF_UNIX, socket.SOCK_DGRAM),
    ("inet6_stream", socket.AF_INET6, socket.SOCK_STREAM),
    ("netlink", socket.AF_NETLINK, socket.SOCK_RAW),
    ("packet", getattr(socket, "AF_PACKET", 17), socket.SOCK_RAW),
    ("inet_dgram", socket.AF_INET, socket.SOCK_DGRAM),
    ("inet_raw", socket.AF_INET, socket.SOCK_RAW),
]:
    attempt("socket_" + name, make_socket(domain, kind))

def pair_dgram():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    a.close(); b.close()
    return "allowed"
attempt("socketpair_dgram", pair_dgram)

def pair_inet():
    a, b = socket.socketpair(socket.AF_INET, socket.SOCK_STREAM)
    a.close(); b.close()
    return "allowed"
attempt("socketpair_inet", pair_inet)

def loopback():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.connect(server.getsockname())
    accepted, _ = server.accept()
    client.sendall(b"loopback")
    received = accepted.recv(16)
    accepted.close(); client.close(); server.close()
    return received.decode()
attempt("loopback", loopback)

def pair_roundtrip():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)
    a.sendall(b"self-ipc")
    received = b.recv(16)
    a.close(); b.close()
    return received.decode()
attempt("pair_roundtrip", pair_roundtrip)

def pair_route(name, operation):
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)
    try:
        return attempt(name, lambda: operation(a, b))
    finally:
        a.close(); b.close()

def connected_target(a, b):
    a.connect(stream_path)
    return "connected"
pair_route("pair_connect_path", connected_target)

def bound_target(a, b):
    a.bind(stream_path)
    return "bound"
pair_route("pair_bind_path", bound_target)

def listened(a, b):
    a.listen(1)
    return "listening"
pair_route("pair_listen", listened)

def sent_to_stream(a, b):
    a.sendto(b"pair-payload", stream_path)
    return "sent"
pair_route("pair_sendto_stream", sent_to_stream)

def sent_to_dgram(a, b):
    a.sendto(b"pair-payload", dgram_path)
    return "sent"
pair_route("pair_sendto_dgram", sent_to_dgram)

def sentmsg_to_stream(a, b):
    a.sendmsg([b"pair-payload"], [], 0, stream_path)
    return "sent"
pair_route("pair_sendmsg_stream", sentmsg_to_stream)

def descriptor_passing():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)
    a.sendmsg([b"fd"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                         array.array("i", [a.fileno()]))])
    message, ancillary, flags, address = b.recvmsg(64, socket.CMSG_LEN(struct.calcsize("i")))
    received_fd = None
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            received_fd = struct.unpack("i", data[:struct.calcsize("i")])[0]
    if received_fd is not None:
        os.close(received_fd)
    a.close(); b.close()
    return {"message": message.decode(), "descriptor": received_fd is not None}
attempt("pair_descriptor_passing", descriptor_passing)

def host_loopback():
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(3)
    client.connect(("127.0.0.1", ${options.hostLoopbackPort}))
    return "connected"
attempt("host_loopback_tcp", host_loopback)

def external():
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(3)
    client.connect((${JSON.stringify(options.lanAddress)}, 80))
    return "connected"
attempt("external_tcp", external)

# A socket that only appears in the workspace while the run is in progress.
sys.stdout.write("LATE-WAIT\n")
sys.stdout.flush()
waited = 0
while not os.path.exists(late_path) and waited < 10000:
    time.sleep(0.05)
    waited += 50
results["late"] = "appeared" if os.path.exists(late_path) else "never"
attempt("late_socket", make_socket(socket.AF_UNIX, socket.SOCK_STREAM))

async def loop():
    task = asyncio.create_task(asyncio.sleep(5))
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return "cancelled"
results["asyncio"] = asyncio.run(loop())

sys.stdout.write(json.dumps(results) + "\n")
`;
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

function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

async function launchFor(dataDir: string, workspace: string) {
  return await prepareSandboxLaunch(executorConfig(dataDir), {
    chdir: "/workspace",
    environmentBinds: [],
    environmentPaths: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} },
    language: "python",
    pathEnv: "/usr/bin",
    workspaceBindArgs: ["--bind", workspace, "/workspace"],
    workspaceRoot: workspace,
  });
}

test("a real sandbox under the research-gateway filter reaches no live host IPC service", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const address = lanAddress();
  if (!address) assert.fail("this host has no non-loopback IPv4 address for the external route case");
  const dataDir = await scratchDirectory();
  const workspace = await mkdtemp(join(dataDir, "workspace-"));
  const services = await startHostServices(dataDir, workspace);
  const log = services.log;

  // A host TCP service the sandbox must not reach even at the same port number.
  const hostTcp = net.createServer((socket) => {
    socket.on("data", () => log.events.push({ event: "tcp", service: "host" }));
  });
  await new Promise<void>((ready) => hostTcp.listen(0, "127.0.0.1", () => ready()));
  const hostPort = (hostTcp.address() as net.AddressInfo).port;

  let lateServer: net.Server | undefined;
  let lateAccepted = 0;
  try {
    // Host controls before the run: both services answer, so anything that is
    // silent afterwards is a denial rather than an absent service.
    assert.equal(await probeStream(services.streamPath), "pong");
    await probeDatagram(services.dgramPath, await hostPython());

    const launch = await launchFor(dataDir, workspace);
    const run = await runSandboxed(
      executorConfig(dataDir),
      launch,
      ["/usr/bin/python3", "-"],
      workloadSource({ hostLoopbackPort: hostPort, lanAddress: address, latePath: "/workspace/late.sock" }),
      60_000,
      workspace,
      undefined,
      "Research gateway filter harness",
      0,
      256 * 1024,
      "research-gateway",
      (_stream, chunk) => {
        // Create the "appears during the run" listener as soon as the workload
        // is waiting for it, then let it continue.
        if (lateServer === undefined && chunk.toString().includes("LATE-WAIT")) {
          lateServer = net.createServer((socket) => {
            lateAccepted += 1;
            socket.destroy();
          });
          lateServer.listen(join(workspace, "late.sock"));
        }
      },
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

    // M4: the permitted primitives work, including asyncio's self-pipe.
    assert.equal(results.asyncio, "cancelled");
    assert.equal(results.loopback, "loopback");
    assert.equal(results.pair_roundtrip, "self-ipc");
    assert.deepEqual(results.pair_descriptor_passing, { descriptor: true, message: "fd" });

    // M6: refused families and types, all EPERM.
    for (const name of [
      "socket_unix_stream", "socket_unix_dgram", "socket_inet6_stream", "socket_netlink",
      "socket_packet", "socket_inet_dgram", "socket_inet_raw", "socketpair_dgram", "socketpair_inet",
    ]) {
      assert.deepEqual(results[name], { errno: 1 }, `${name} must be refused with EPERM`);
    }

    // M6: no route off-host, and the host's loopback port is a different host.
    assert.notEqual(results.external_tcp, "connected");
    assert.notEqual(results.host_loopback_tcp, "connected");

    // M5: every route from a permitted stream pair fails or stays on the pair.
    for (const name of [
      "pair_connect_path", "pair_bind_path", "pair_listen",
      "pair_sendto_stream", "pair_sendto_dgram", "pair_sendmsg_stream",
    ]) {
      const value = results[name] as { errno?: number } | string;
      assert.ok(typeof value === "string" || typeof value.errno === "number", `${name} must report an outcome`);
      if (typeof value === "string") {
        assert.equal(value, "sent", `${name} may only report a peer-local send, never ${value}`);
      }
    }

    // M5: the socket created mid-run is refused exactly like the others.
    assert.equal(results.late, "appeared", "the mid-run listener must really have existed");
    assert.deepEqual(results.late_socket, { errno: 1 });
    assert.equal(lateAccepted, 0, "the mid-run listener must receive no connection");

    // M5: live host controls — probe every service once more after the run.
    assert.equal(await probeStream(services.streamPath), "pong");
    await probeDatagram(services.dgramPath, await hostPython());

    // The stream and datagram services answered before and after the run, and
    // they saw nothing from the sandbox in between.
    const streamAccepts = log.events.filter((event) => event.event === "accept" && event.service === "stream");
    assert.equal(streamAccepts.length, 2, "only the two host-side probes may connect to the stream service");
    assert.equal(log.events.filter((event) => event.event === "accept" && event.service === "abstract").length, 0,
      "the abstract listener lives in the host network namespace, which the sandbox does not share");
    assert.equal(log.events.filter((event) => event.event === "datagram").length, 2,
      "only the two host-side probes may send to the datagram service");
    const payloads = log.events.filter((event) => event.event === "data").map((event) => event.payload);
    assert.deepEqual(payloads, ["host-probe", "host-probe"], "no sandbox data may reach a host service");
    assert.equal(log.events.filter((event) => event.event === "tcp").length, 0,
      "the sandbox must not reach the host's loopback TCP service");
  } finally {
    lateServer?.close();
    await new Promise<void>((done) => hostTcp.close(() => done()));
    services.process.kill("SIGKILL");
  }
});

test("an abstract name is namespace-scoped while a filesystem socket is only filter-scoped", async () => {
  if (!await bwrapAvailable()) assert.fail("bubblewrap is not installed");
  const dataDir = await scratchDirectory();
  const workspace = await mkdtemp(join(dataDir, "workspace-"));
  const services = await startHostServices(dataDir, workspace);
  try {
    const launch = await launchFor(dataDir, workspace);
    // The `network` variant admits AF_UNIX socket creation, so this run asks the
    // namespace question separately from the filter question. It is a labelled
    // control, not evidence for the research-gateway profile.
    const program = String.raw`
import json, socket, sys
abstract_name = ${JSON.stringify(services.abstractName)}
facts = {}
def attempt(name, target):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(target)
        s.sendall(b"sandbox")
        reply = s.recv(16)
        s.close()
        facts[name] = reply.decode()
    except OSError as error:
        facts[name] = {"errno": error.errno}
attempt("filesystem", "/workspace/host-stream.sock")
attempt("abstract", "\0" + abstract_name)
sys.stdout.write(json.dumps(facts) + "\n")
`;
    const run = await runSandboxed(
      executorConfig(dataDir),
      launch,
      ["/usr/bin/python3", "-"],
      program,
      30_000,
      workspace,
      undefined,
      "Abstract namespace harness",
      0,
      64 * 1024,
      "network",
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const facts = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    // The mount makes the filesystem socket reachable when the filter permits
    // AF_UNIX, which is exactly why the gateway profile must deny it.
    assert.equal(facts.filesystem, "pong");
    // The abstract name is not: it is scoped to the host's own network
    // namespace, so even an AF_UNIX socket cannot see it from the sandbox.
    assert.equal((facts.abstract as { errno?: number }).errno, 111);
    assert.equal(services.log.events.filter((event) => event.event === "accept" && event.service === "abstract").length, 0);
  } finally {
    services.process.kill("SIGKILL");
  }
});
