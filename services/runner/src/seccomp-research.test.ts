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
 * The research-only seccomp boundary.
 *
 * The variant exists for one reason: a real `asyncio` event loop creates its
 * self-pipe with `socket.socketpair(AF_UNIX, ...)`, which the baseline refuses
 * like every socket-family syscall. The filter therefore restores exactly that
 * call for `AF_UNIX` and checks the domain argument in the program itself, so
 * `AF_INET`/`AF_INET6` and every other socket entry point stay refused.
 *
 * Two kinds of evidence are kept apart:
 *
 * - rule generation, checked for every supported architecture by running the
 *   emitted BPF program through a small interpreter (no kernel involved);
 * - a real bubblewrap launch under the real filter, where a loop must run, a
 *   cancelled task must be awaited, and creating an `AF_INET` socket must fail.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { baselineSeccompFilter, ensureSeccompFilter, type SeccompVariant } from "./seccomp.js";
import {
  prepareSandboxLaunch,
  resolveHostRuntimeSupport,
  runSandboxed,
  workspaceBindArguments,
  type ExecutorConfig,
} from "./executor.js";

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const ALLOW = "allow";
const EPERM = "eperm";
const KILL = "kill";

/** Enough of a cBPF machine to decide one syscall with its first argument. */
function decide(filter: Buffer, architecture: number, syscall: number, arg0 = 0): string {
  let accumulator = 0;
  for (let pc = 0; pc < filter.length / 8; pc += 1) {
    const offset = pc * 8;
    const code = filter.readUInt16LE(offset);
    const jumpTrue = filter.readUInt8(offset + 2);
    const jumpFalse = filter.readUInt8(offset + 3);
    const value = filter.readUInt32LE(offset + 4);
    if (code === BPF_LD_W_ABS) {
      if (value === 0) accumulator = syscall;
      else if (value === 4) accumulator = architecture;
      else if (value === 16) accumulator = arg0;
      else throw new Error(`unsupported load offset ${value}`);
      continue;
    }
    if (code === BPF_JMP_JEQ_K) {
      pc += accumulator === value ? jumpTrue : jumpFalse;
      continue;
    }
    if (code === BPF_RET_K) {
      if (value === 0x7fff0000) return ALLOW;
      if (value === 0x00050001) return EPERM;
      if (value === 0x80000000) return KILL;
      throw new Error(`unsupported return ${value.toString(16)}`);
    }
    throw new Error(`unsupported instruction ${code}`);
  }
  throw new Error("filter fell through without a return");
}

const ARCHITECTURES = [
  { name: "x64", audit: AUDIT_ARCH_X86_64, socketpair: 53, socket: 41, connect: 42, read: 0 },
  { name: "arm64", audit: AUDIT_ARCH_AARCH64, socketpair: 199, socket: 198, connect: 203, read: 63 },
] as const;
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;

test("the research variant allows exactly AF_UNIX socketpair", () => {
  for (const architecture of ARCHITECTURES) {
    const filter = baselineSeccompFilter(architecture.name, "research");
    // The one restored call, for the one local domain.
    assert.equal(
      decide(filter, architecture.audit, architecture.socketpair, AF_UNIX), ALLOW,
      `${architecture.name}: AF_UNIX socketpair was refused`,
    );
    for (const domain of [AF_INET, AF_INET6]) {
      assert.equal(
        decide(filter, architecture.audit, architecture.socketpair, domain), EPERM,
        `${architecture.name}: domain ${domain} socketpair was allowed`,
      );
    }
    // Every other socket entry point stays refused, exactly as in the baseline.
    for (const syscall of [architecture.socket, architecture.connect]) {
      assert.equal(
        decide(filter, architecture.audit, syscall, AF_UNIX), EPERM,
        `${architecture.name}: syscall ${syscall} was allowed`,
      );
    }
    // The filter is still a filter: unrelated syscalls pass, foreign
    // architectures are killed.
    assert.equal(decide(filter, architecture.audit, architecture.read), ALLOW);
    assert.equal(decide(filter, 0xdeadbeef, architecture.read), KILL);
    // The baseline is unchanged: it still refuses the self-pipe's socketpair.
    const baseline = baselineSeccompFilter(architecture.name, "baseline");
    assert.equal(decide(baseline, architecture.audit, architecture.socketpair, AF_UNIX), EPERM);
  }
});

test("the network variant is not what the research variant changed", () => {
  // `network` opens the whole socket family; `research` must not inherit that
  // by accident, and `research` must not be reachable through it.
  const network = baselineSeccompFilter("x64", "network");
  assert.equal(decide(network, AUDIT_ARCH_X86_64, 41, AF_INET), ALLOW);
  const research = baselineSeccompFilter("x64", "research");
  assert.equal(decide(research, AUDIT_ARCH_X86_64, 41, AF_INET), EPERM);
  assert.equal(decide(research, AUDIT_ARCH_X86_64, 42, AF_INET), EPERM);
  assert.equal(decide(research, AUDIT_ARCH_X86_64, 49, AF_UNIX), EPERM);
  assert.equal(decide(research, AUDIT_ARCH_X86_64, 50, AF_UNIX), EPERM);
  assert.equal(decide(research, AUDIT_ARCH_X86_64, 288, AF_UNIX), EPERM);
});

test("the research variant publishes its own filter file", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sciencediscovery-research-seccomp-"));
  try {
    const path = await ensureSeccompFilter(root, "research", "x64");
    assert.match(path, /seccomp-research-x86_64\.bpf$/);
    const baseline = await ensureSeccompFilter(root, "baseline", "x64");
    assert.match(baseline, /seccomp-x86_64\.bpf$/);
    assert.notEqual(path, baseline);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const LOOP_SCRIPT = `
import asyncio, socket

async def work(done):
    await asyncio.sleep(0.01)
    done.append("work")

async def cancelling():
    task = asyncio.create_task(asyncio.sleep(30))
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        return "cancelled"
    return "not-cancelled"

async def main():
    done = []
    await asyncio.create_task(work(done))
    outcome = await cancelling()
    return done, outcome

done, outcome = asyncio.run(main())
print("loop", done, outcome)
try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except OSError as error:
    print("inet-denied", error.errno)
else:
    print("inet-allowed")
try:
    socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
except OSError as error:
    print("unix-pair-denied", error.errno)
else:
    print("unix-pair-ok")
`;

function config(dataDir: string): ExecutorConfig {
  return {
    bwrapPath: "bwrap",
    dataDir,
    execTimeoutMs: 30_000,
    maxOutputBytes: 65_536,
    maxWorkspaceBytes: 0,
    terminationGraceMs: 2_000,
  };
}

async function runLoop(root: string, variant: SeccompVariant) {
  const cfg = config(root);
  const workspace = workspaceBindArguments(root, undefined);
  const launch = await prepareSandboxLaunch(cfg, {
    chdir: workspace.chdir,
    environmentBinds: [],
    environmentPaths: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: await resolveHostRuntimeSupport(cfg.dataDir),
    language: "python",
    pathEnv: "/usr/bin",
    workspaceBindArgs: workspace.args,
    workspaceRoot: root,
  });
  return runSandboxed(
    cfg, launch,
    ["/usr/bin/python3", "-I", "-B", "-c", LOOP_SCRIPT],
    "", 20_000, root, undefined, "research seccomp loop", 0, 65_536, variant,
  );
}

test("a real loop and a cancelled task work under the research variant", {
  tags: ["os:linux"],
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "research-seccomp-loop-"));
  try {
    const result = await runLoop(root, "research");
    assert.match(result.stdout, /loop \['work'\] cancelled/,
      `asyncio did not run under the research filter: ${result.stderr}`);
    // The local socketpair the loop uses is still available to the workload.
    assert.match(result.stdout, /unix-pair-ok/);
    // A real network socket is refused by the kernel, not by the loop.
    assert.match(result.stdout, /inet-denied 1/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the baseline still refuses the loop's socketpair", {
  tags: ["os:linux"],
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "research-seccomp-baseline-"));
  try {
    const result = await runLoop(root, "baseline");
    assert.doesNotMatch(result.stdout, /loop/, "the baseline ran an asyncio loop");
    assert.match(`${result.stderr}${result.stdout}`, /PermissionError|Operation not permitted/,
      `expected a refused socketpair, got stdout=${result.stdout} stderr=${result.stderr}`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
