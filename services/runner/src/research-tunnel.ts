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
 * The inherited-descriptor tunnel for the research workload, and the fixed
 * relay that turns it into a loopback endpoint inside the sandbox.
 *
 * This is the transport primitive the model-gateway design depends on, not the
 * gateway: it opens one connected duplex channel, delivers one end to the
 * bubblewrap payload as descriptor 4, and runs a fixed stdlib relay that
 * forwards **one** loopback TCP connection onto that descriptor. There is no
 * framing, no multiplexer, no authorization and no upstream leg here — those
 * belong to the gateway slice, which this round deliberately does not build.
 *
 * Why an inherited descriptor instead of a bind-mounted socket: a filesystem
 * socket in a mounted directory is reachable by any host process that can write
 * there, and `seccomp` cannot filter `connect()` by destination because its
 * argument is a pointer. The sandbox therefore denies `socket(AF_UNIX)`
 * outright (see the `research-gateway` variant) and the only way out is a
 * descriptor the Runner already holds.
 *
 * Nothing about this module is selected by a request, an environment profile or
 * a production route. It is inert for every existing caller: the descriptor is
 * an optional argument to `spawnSandboxProcess`, absent everywhere today.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { connect as connectSocket, createServer, type Socket } from "node:net";
import { basename, join, resolve } from "node:path";

import { resolveEgressInterpreter, type EgressBridgeInterpreter } from "./egress-bridge.js";

/** Descriptor the sandbox payload receives the tunnel on. `3` is `--seccomp 3`. */
export const RESEARCH_TUNNEL_DESCRIPTOR_INDEX = 4;
/** Sandbox loopback port the relay listens on (the egress bridge owns 18118). */
export const RESEARCH_RELAY_PORT = 18_119;
/** Sandbox-internal mount prefix for the relay interpreter, stdlib and script. */
export const RESEARCH_RELAY_PREFIX = "/opt/sciencediscovery-gateway";
export const RESEARCH_RELAY_INTERPRETER_PATH = `${RESEARCH_RELAY_PREFIX}/bin/python3`;
export const RESEARCH_RELAY_SCRIPT_PATH = `${RESEARCH_RELAY_PREFIX}/model-tunnel-relay.py`;

/**
 * Exit codes of the fixed relay. They are the only diagnostic it emits for a
 * failure that happens before the workload starts; the workload's own status is
 * passed through unchanged.
 *
 * - `70` the tunnel descriptor is missing or is not a connected stream, so no
 *   workload was started;
 * - `71` the loopback listener could not be established, so no workload was
 *   started.
 */
export const RESEARCH_RELAY_EXIT_DESCRIPTOR_UNUSABLE = 70;
export const RESEARCH_RELAY_EXIT_LISTENER_UNAVAILABLE = 71;

/** A host interpreter that can run the relay, its stdlib, and the staged script. */
export interface ResearchRelay extends EgressBridgeInterpreter {
  scriptPath: string;
}

export class ResearchRelayUnavailableError extends Error {
  constructor(reason: string) {
    super(`The research model tunnel relay is unavailable: ${reason}`);
    this.name = "ResearchRelayUnavailableError";
  }
}

/**
 * The relay program, run by the host interpreter inside the sandbox.
 *
 * It is fixed: no path, port or command comes from the Runner's configuration,
 * and the only variable input is the argv the Runner composes (`--port` and the
 * workload after `--`). It never reads the tunnel's contents into its own
 * decisions, and it never writes to stdout: the workload owns that stream.
 *
 * The single-connection shape is deliberate for this round. A multiplexing
 * relay needs the framing protocol the design describes, and shipping it before
 * the transport primitive itself is proven would be the wrong order.
 */
const RELAY_SCRIPT = String.raw`
"""Fixed model-tunnel relay: inherited descriptor 4 -> sandbox loopback TCP.

Started as the sandbox entrypoint. Fork/execs the workload as its child, keeps
serving one forwarded connection, and exits with the child's status.
"""
import os
import socket
import sys
import threading

DESCRIPTOR = __TUNNEL_DESCRIPTOR__


def diagnostic(message):
    sys.stderr.write("model tunnel relay: %s\n" % message)
    sys.stderr.flush()


def pump(source, target):
    try:
        while True:
            chunk = source.recv(65536)
            if not chunk:
                break
            target.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def serve(listener, tunnel):
    try:
        client, _ = listener.accept()
    except OSError:
        return
    threading.Thread(target=pump, args=(client, tunnel), daemon=True).start()
    pump(tunnel, client)
    client.close()


def main(argv):
    port = int(argv[argv.index("--port") + 1])
    command = argv[argv.index("--") + 1:]
    try:
        # Adopt the descriptor the Runner passed. This must not create a socket:
        # socket(AF_UNIX) is refused by the filter the workload runs under.
        tunnel = socket.socket(fileno=DESCRIPTOR)
        if tunnel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM:
            raise OSError("descriptor is not a stream socket")
        tunnel.getpeername()
        # Node hands its sockets to a child non-blocking, and this descriptor is
        # the only one the relay reads. Put it in blocking mode before serving,
        # or every recv() would raise EAGAIN. The Runner never reads or writes
        # its own copy of this end, so the change cannot stall it.
        tunnel.setblocking(True)
    except (OSError, ValueError) as error:
        diagnostic("descriptor %d is unusable: %s" % (DESCRIPTOR, error))
        return __DESCRIPTOR_UNUSABLE__
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(8)
    except OSError as error:
        diagnostic("loopback listener unavailable: %s" % error)
        return __LISTENER_UNAVAILABLE__
    child = os.fork()
    if child == 0:
        # The workload must not inherit either alias: close the listener and the
        # tunnel, and clear the close-on-exec flag discipline for both. Anything
        # the workload opens afterwards is its own descriptor, not ours.
        try:
            listener.close()
        except OSError:
            pass
        try:
            tunnel.close()
        except OSError:
            pass
        os.execv(command[0], command)
    threading.Thread(target=serve, args=(listener, tunnel), daemon=True).start()
    _, status = os.waitpid(child, 0)
    listener.close()
    tunnel.close()
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`
  .replace("__TUNNEL_DESCRIPTOR__", String(RESEARCH_TUNNEL_DESCRIPTOR_INDEX))
  .replace("__DESCRIPTOR_UNUSABLE__", String(RESEARCH_RELAY_EXIT_DESCRIPTOR_UNUSABLE))
  .replace("__LISTENER_UNAVAILABLE__", String(RESEARCH_RELAY_EXIT_LISTENER_UNAVAILABLE));

/** The fixed relay program, for the staging step and its tests. */
export function researchRelaySource(): string {
  return RELAY_SCRIPT;
}

const relays = new Map<string, Promise<ResearchRelay>>();

/**
 * The host interpreter plus the relay staged under this data directory,
 * resolved once per directory. Failure is terminal for anything that needs the
 * tunnel; there is no fallback transport, because a bind-mounted socket would
 * restore exactly the hole the descriptor closes.
 */
export function resolveResearchRelay(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResearchRelay> {
  const cached = relays.get(dataDir);
  if (cached) return cached;
  const resolved = (async () => {
    let interpreter: EgressBridgeInterpreter;
    try {
      interpreter = await resolveEgressInterpreter(env);
    } catch (error) {
      throw new ResearchRelayUnavailableError(
        `no usable host Python 3 interpreter (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const runtimeDirectory = resolve(dataDir, "runner-runtime");
    const scriptPath = resolve(runtimeDirectory, "model-tunnel-relay.py");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(scriptPath, RELAY_SCRIPT, { mode: 0o600 });
    return { ...interpreter, scriptPath };
  })();
  relays.set(dataDir, resolved);
  void resolved.catch(() => relays.delete(dataDir));
  return resolved;
}

/** bwrap binds that expose the relay interpreter, its stdlib and the script. */
export function researchRelayBindArguments(relay: ResearchRelay): string[] {
  return [
    "--ro-bind", relay.interpreterPath, RESEARCH_RELAY_INTERPRETER_PATH,
    "--ro-bind", relay.stdlibPath, `${RESEARCH_RELAY_PREFIX}/lib/${basename(relay.stdlibPath)}`,
    "--ro-bind", relay.scriptPath, RESEARCH_RELAY_SCRIPT_PATH,
  ];
}

/** Argv prefix that starts the relay and then runs the real argv after `--`. */
export function researchRelayCommandPrefix(): string[] {
  return [
    RESEARCH_RELAY_INTERPRETER_PATH,
    RESEARCH_RELAY_SCRIPT_PATH,
    "--port", String(RESEARCH_RELAY_PORT),
    "--",
  ];
}

/** The two ends of one connected duplex channel. */
export interface ResearchTunnel {
  /**
   * The Runner's end. It is never mounted, never passed to the sandbox and
   * never named on the filesystem; it holds the only host-side view of the
   * channel.
   */
  readonly host: Socket;
  /**
   * The sandbox's end, handed to `spawnSandboxProcess` as stdio entry
   * `RESEARCH_TUNNEL_DESCRIPTOR_INDEX`. The Runner must not read from or write
   * to it: the relay owns both directions.
   */
  readonly payload: Socket;
  /**
   * Drop the Runner's copy of the sandbox end once the spawn has duplicated it
   * into the child.
   *
   * This is not optional housekeeping: both descriptors share one open file
   * description, so as long as the Runner keeps this copy the host end never
   * observes the sandbox closing, and a terminated run looks like a live peer.
   * The child's descriptor is independent of this close.
   */
  releaseSandboxEnd(): void;
  /** Close both ends. Idempotent; never throws. */
  close(): Promise<void>;
}

/** A filesystem Unix socket name cannot exceed the platform's `sun_path` (108). */
const MAX_TUNNEL_PATH_BYTES = 100;

/**
 * Open one connected `AF_UNIX` stream pair, with no native addon and no host
 * path left behind.
 *
 * Node has no `socketpair()` binding, so the pair is made the only way the
 * standard library allows: listen on a name inside a Runner-owned directory,
 * connect to it, accept, then stop listening and unlink the name. After the
 * unlink no filesystem socket exists — only the connected inode the two
 * descriptors hold — so the sandbox cannot reach it even if it could see the
 * directory, and nothing has to be cleaned up on disk.
 *
 * Both sockets are unref'd: until `close()` they are input/output streams, and
 * the caller owns their lifetime.
 */
export async function openResearchTunnel(directory: string): Promise<ResearchTunnel> {
  const tunnels = resolve(directory, "tunnels");
  await mkdir(tunnels, { mode: 0o700, recursive: true });
  const name = join(tunnels, `${randomUUID()}.sock`);
  if (Buffer.byteLength(name) > MAX_TUNNEL_PATH_BYTES) {
    throw new Error("The research tunnel socket name is too long for a Unix address");
  }
  const server = createServer();
  try {
    await new Promise<void>((ready, fail) => {
      server.once("error", fail);
      server.listen(name, () => ready());
    });
    const accepted = new Promise<Socket>((accept, fail) => {
      server.once("connection", accept);
      server.once("error", fail);
    });
    const payload = connectSocket(name);
    await new Promise<void>((connected, fail) => {
      payload.once("connect", () => connected());
      payload.once("error", fail);
    });
    const host = await accepted;
    server.close();
    await rm(name, { force: true });
    // Neither end should coalesce: the relay forwards bytes, and a delayed
    // flush would turn a transport measurement into a timing accident.
    host.setNoDelay(true);
    payload.setNoDelay(true);
    let closed: Promise<void> | undefined;
    let released = false;
    return {
      host,
      payload,
      releaseSandboxEnd: () => {
        if (released) return;
        released = true;
        payload.destroy();
      },
      close: () => closed ??= Promise.resolve().then(() => {
        released = true;
        host.destroy();
        payload.destroy();
      }),
    };
  } catch (error) {
    server.close();
    await rm(name, { force: true }).catch(() => undefined);
    throw error;
  }
}
