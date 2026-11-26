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

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BPF_LD_W_ABS = 0x20;
const BPF_ALU_AND_K = 0x54;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_BASELINE_VERSION = "multiarch-v1-profile-aware";
/** Variant used when the Permission Epoch grants `domain-allowlist` network access. */
export const SECCOMP_NETWORK_VERSION = "multiarch-v1-egress-gateway";
/**
 * Variant for the research workload: the baseline filter plus one syscall,
 * `socketpair`, and only for `AF_UNIX`.
 *
 * A real `asyncio` event loop creates its self-pipe with `socket.socketpair()`,
 * which the baseline refuses like every other socket-family call. The research
 * workload needs that local primitive and nothing more, so the filter allows
 * exactly that syscall, checked against its first argument: `AF_INET` and
 * `AF_INET6` socketpairs, `socket()`, `connect()`, `bind()`, `listen()` and
 * `accept4()` stay refused. The network variant is not used, the network
 * namespace is still unshared, and no egress bridge is bound.
 */
export const SECCOMP_RESEARCH_VERSION = "multiarch-v1-research-local";

/**
 * Variant for the research workload that also needs a local TCP client and the
 * one loopback listener of the model-gateway relay.
 *
 * It is the baseline profile minus the socket-family calls a loopback client
 * needs, with the two calls that can name a *peer* checked by their scalar
 * arguments before they are allowed:
 *
 * - `socket()` only for `AF_INET` + `SOCK_STREAM` (the type is masked, so
 *   `SOCK_CLOEXEC`/`SOCK_NONBLOCK` are still accepted while datagram, raw,
 *   `AF_UNIX`, `AF_INET6`, `AF_NETLINK` and `AF_PACKET` are refused);
 * - `socketpair()` only for `AF_UNIX` + `SOCK_STREAM` + protocol 0.
 *
 * `connect`, `bind`, `listen`, `accept` and `accept4` stay allowed but
 * unchecked: their arguments are pointers, so a filter cannot see the address.
 * That is why the namespace is still unshared and no other interface exists —
 * see the design note for the argument this variant depends on.
 */
export const SECCOMP_RESEARCH_GATEWAY_VERSION = "multiarch-v1-research-gateway";

/**
 * Socket-family syscalls. The baseline denies them outright (`networkPolicy`
 * `none` is enforced by the kernel, not only by the empty network namespace);
 * the network variant allows them so the egress bridge and ordinary HTTP
 * clients can open sockets. Raw and packet sockets stay unreachable without
 * per-argument filtering because the sandbox runs with `--cap-drop ALL`, and
 * `AF_PACKET`/raw sockets require `CAP_NET_RAW`.
 */
const NETWORK_SYSCALLS = {
  arm64: [198, 199, 200, 201, 202, 203, 242],
  x64: [41, 42, 43, 49, 50, 53, 288],
} as const;

// These calls are not needed by the Python science slice and expand the kernel attack surface.
const DENIED_X86_64_SYSCALLS = [
  41, 42, 43, 49, 50, 53, 101, 155, 165, 166, 167, 168, 169, 175, 176,
  246, 248, 249, 250, 272, 288, 298, 304, 308, 310, 311, 313, 321, 323,
  425, 426, 427,
] as const;

// AArch64 uses the asm-generic syscall table. Deny the same syscall intent as
// the x86_64 profile: network sockets, privilege/namespace escape surfaces,
// kernel module/keyring/kexec interfaces, cross-process memory, BPF, userfaultfd,
// and io_uring.
const DENIED_AARCH64_SYSCALLS = [
  39, 40, 41, 97, 104, 105, 106, 117, 142, 198, 199, 200, 201, 202, 203,
  217, 218, 219, 224, 225, 242, 265, 268, 270, 271, 272, 273, 280, 282,
  425, 426, 427,
] as const;

const SECCOMP_PROFILES = {
  arm64: {
    auditArchitecture: AUDIT_ARCH_AARCH64,
    deniedSyscalls: DENIED_AARCH64_SYSCALLS,
    filename: "seccomp-aarch64.bpf",
  },
  x64: {
    auditArchitecture: AUDIT_ARCH_X86_64,
    deniedSyscalls: DENIED_X86_64_SYSCALLS,
    filename: "seccomp-x86_64.bpf",
  },
} as const;

function instruction(code: number, jumpTrue: number, jumpFalse: number, value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeUInt16LE(code, 0);
  result.writeUInt8(jumpTrue, 2);
  result.writeUInt8(jumpFalse, 3);
  result.writeUInt32LE(value >>> 0, 4);
  return result;
}

type SupportedSeccompArchitecture = keyof typeof SECCOMP_PROFILES;

/**
 * The instructions after a `JEQ <syscall>` that already matched: every
 * argument test falls through to `EPERM` when it fails, and the block ends with
 * `ALLOW` only when all of them passed. `mask` is applied to the loaded word so
 * a single compare can ignore `SOCK_CLOEXEC`/`SOCK_NONBLOCK`.
 */
function argumentCheckBlock(
  checks: readonly { offset: number; mask?: number; value: number }[],
): Buffer[] {
  const block: Buffer[] = [];
  for (const check of checks) {
    block.push(instruction(BPF_LD_W_ABS, 0, 0, check.offset));
    if (check.mask !== undefined) block.push(instruction(BPF_ALU_AND_K, 0, 0, check.mask));
    // Equal → jump over the `EPERM` and test the next argument; different →
    // fall through into it.
    block.push(instruction(BPF_JMP_JEQ_K, 1, 0, check.value));
    block.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM));
  }
  block.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return block;
}

function seccompProfile(architecture: string) {
  const profile = SECCOMP_PROFILES[architecture as SupportedSeccompArchitecture];
  if (!profile) {
    throw new Error(`Runner seccomp baseline is unavailable for architecture ${architecture}`);
  }
  return profile;
}

/**
 * `network` allows socket-family syscalls for the audited egress bridge.
 * `npu` allows the same calls for CANN/TE Python-module initialization, but the
 * sandbox keeps its private network namespace and receives no egress bridge.
 * `research` allows `socketpair` for `AF_UNIX` only; see `SECCOMP_RESEARCH_VERSION`.
 * `research-gateway` additionally allows an `AF_INET`/`SOCK_STREAM` `socket()`
 * and `connect`/`bind`/`listen`/`accept`; see `SECCOMP_RESEARCH_GATEWAY_VERSION`.
 */
export type SeccompVariant = "baseline" | "network" | "npu" | "research" | "research-gateway";

/**
 * The one syscall the research variant restores, per architecture, and the
 * only domain it may be used with. The argument is `args[0]`, i.e. the word at
 * offset 16 of `struct seccomp_data`.
 */
const RESEARCH_LOCAL_SOCKETPAIR = { arm64: 199, x64: 53 } as const;
const AUDIT_AF_UNIX = 1;
const AUDIT_AF_INET = 2;
const SOCK_STREAM = 1;
/** Low nibble of `socket(domain, type, …)`; the high bits are `SOCK_CLOEXEC`/`SOCK_NONBLOCK`. */
const SOCK_TYPE_MASK = 0x0f;
const SEE_DATA_ARG0 = 16;
const SEE_DATA_ARG1 = 24;
const SEE_DATA_ARG2 = 32;

/**
 * The two calls the research-gateway variant allows only for the pairs of
 * arguments a loopback client and a self-connected stream pair need. Each entry
 * states, per argument, the word offset in `struct seccomp_data` and the value
 * the argument must equal (`mask` selects the bits compared).
 *
 * The order matters only in that a non-matching syscall has to reach the deny
 * list below: every check either jumps over the whole block for a different
 * syscall number, or falls through to `EPERM` for a matching number with a
 * wrong argument, never to the block that follows.
 */
const RESEARCH_GATEWAY_ARGUMENT_CHECKS: Record<SupportedSeccompArchitecture, readonly {
  syscall: number;
  checks: readonly { offset: number; mask?: number; value: number }[];
}[]> = {
  arm64: [
    { syscall: 198, checks: [{ offset: SEE_DATA_ARG0, value: AUDIT_AF_INET }, { offset: SEE_DATA_ARG1, mask: SOCK_TYPE_MASK, value: SOCK_STREAM }] },
    {
      syscall: 199,
      checks: [
        { offset: SEE_DATA_ARG0, value: AUDIT_AF_UNIX },
        { offset: SEE_DATA_ARG1, mask: SOCK_TYPE_MASK, value: SOCK_STREAM },
        { offset: SEE_DATA_ARG2, value: 0 },
      ],
    },
  ],
  x64: [
    { syscall: 41, checks: [{ offset: SEE_DATA_ARG0, value: AUDIT_AF_INET }, { offset: SEE_DATA_ARG1, mask: SOCK_TYPE_MASK, value: SOCK_STREAM }] },
    {
      syscall: 53,
      checks: [
        { offset: SEE_DATA_ARG0, value: AUDIT_AF_UNIX },
        { offset: SEE_DATA_ARG1, mask: SOCK_TYPE_MASK, value: SOCK_STREAM },
        { offset: SEE_DATA_ARG2, value: 0 },
      ],
    },
  ],
};

/**
 * Calls whose arguments are pointers, so the filter cannot see where they
 * point. They are allowed so a loopback client works, and the no-bypass argument
 * rests on the namespace having no route and on no socket being able to name a
 * host Unix peer (see `seccomp.ts` header and the gateway design).
 */
const RESEARCH_GATEWAY_ALLOWED_UNCHECKED = {
  arm64: [200, 201, 202, 203, 242],
  x64: [42, 43, 49, 50, 288],
} as const;

function deniedSyscalls(architecture: string, variant: SeccompVariant): readonly number[] {
  const profile = seccompProfile(architecture);
  if (variant === "baseline") return profile.deniedSyscalls;
  if (variant === "research") {
    // The research filter is the baseline minus exactly one syscall. It must
    // never take the network list: that would open the whole socket family.
    const local = RESEARCH_LOCAL_SOCKETPAIR[architecture as SupportedSeccompArchitecture];
    return profile.deniedSyscalls.filter((syscall) => syscall !== local);
  }
  if (variant === "research-gateway") {
    // Every call this variant re-admits is either argument-checked in its own
    // block or is one of the unchecked loopback calls above.
    const architectureKey = architecture as SupportedSeccompArchitecture;
    const readmitted = new Set<number>([
      ...RESEARCH_GATEWAY_ARGUMENT_CHECKS[architectureKey].map((entry) => entry.syscall),
      ...RESEARCH_GATEWAY_ALLOWED_UNCHECKED[architectureKey],
    ]);
    return profile.deniedSyscalls.filter((syscall) => !readmitted.has(syscall));
  }
  const allowed = new Set<number>(NETWORK_SYSCALLS[architecture as SupportedSeccompArchitecture]);
  return profile.deniedSyscalls.filter((syscall) => !allowed.has(syscall));
}

export function baselineSeccompFilter(
  architecture: string = process.arch,
  variant: SeccompVariant = "baseline",
): Buffer {
  const profile = seccompProfile(architecture);
  const instructions = [
    instruction(BPF_LD_W_ABS, 0, 0, 4),
    instruction(BPF_JMP_JEQ_K, 1, 0, profile.auditArchitecture),
    instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, 0, 0, 0),
  ];
  if (variant === "research") {
    // Allow `socketpair` and nothing else in the socket family, and only when
    // its domain argument is `AF_UNIX`. The four-instruction block is skipped
    // wholesale for every other syscall, so the argument load only runs for
    // the one syscall it describes. A non-`AF_UNIX` domain falls through to
    // the same `EPERM` the baseline always returned.
    instructions.push(
      instruction(BPF_JMP_JEQ_K, 0, 4, RESEARCH_LOCAL_SOCKETPAIR[architecture as SupportedSeccompArchitecture]),
      instruction(BPF_LD_W_ABS, 0, 0, SEE_DATA_ARG0),
      instruction(BPF_JMP_JEQ_K, 0, 1, AUDIT_AF_UNIX),
      instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
      instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM),
    );
  }
  if (variant === "research-gateway") {
    // `socket()` and the argument-checked `socketpair()`. Both blocks come
    // before the deny list, and each one's first instruction jumps over the
    // whole block for any other syscall number, so a syscall that does not
    // match falls through to the same denials (or the final `ALLOW`) as before.
    for (const entry of RESEARCH_GATEWAY_ARGUMENT_CHECKS[architecture as SupportedSeccompArchitecture]) {
      const block = argumentCheckBlock(entry.checks);
      instructions.push(instruction(BPF_JMP_JEQ_K, 0, block.length, entry.syscall), ...block);
    }
  }
  for (const syscall of deniedSyscalls(architecture, variant)) {
    instructions.push(
      instruction(BPF_JMP_JEQ_K, 0, 1, syscall),
      instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM),
    );
  }
  instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return Buffer.concat(instructions);
}

export async function ensureSeccompFilter(
  dataDir: string,
  variant: SeccompVariant = "baseline",
  architecture: string = process.arch,
): Promise<string> {
  const profile = seccompProfile(architecture);
  const runtimeDirectory = resolve(dataDir, "runner-runtime");
  const path = resolve(
    runtimeDirectory,
    variant === "baseline"
      ? profile.filename
      : profile.filename.replace("seccomp-", `seccomp-${variant}-`),
  );
  await mkdir(runtimeDirectory, { recursive: true });
  // Every execution of the same variant publishes to this one path, and each
  // one then hands the file to bwrap to read. Writing in place would truncate
  // the inode a concurrent launch is already holding open, and bwrap would load
  // a program cut short mid-instruction: the kernel rejects that with
  // `prctl(PR_SET_SECCOMP) reported EINVAL` and the whole execution fails.
  // Renaming only swaps the directory entry, so a reader keeps the complete
  // file it opened.
  const staging = `${path}.${randomUUID()}`;
  await writeFile(staging, baselineSeccompFilter(architecture, variant), { mode: 0o600 });
  try {
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return path;
}

export function ensureBaselineSeccompFilter(
  dataDir: string,
  architecture: string = process.arch,
): Promise<string> {
  return ensureSeccompFilter(dataDir, "baseline", architecture);
}
