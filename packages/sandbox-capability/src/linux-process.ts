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
 * Kernel process identity, read from `/proc`, shared by every server-side
 * component that must observe or terminate a process it did not spawn in this
 * process image.
 *
 * The rules here are the ones two independent implementations already learned
 * the hard way:
 *
 * - "gone" (ENOENT/ESRCH) is a proven absence; every other read failure is
 *   "unobservable" and must never be treated as absence.
 * - Identity is pid + kernel start time, never a command line or name. A pid
 *   alone is a number the kernel reuses.
 * - A session id is not a process tree: a descendant that calls setsid() leaves
 *   it. Only a PID namespace is closed under setsid(), so a sandbox boundary is
 *   verified by namespace inode, and by session only as a weaker fallback.
 *
 * `/proc` is a parameter so tests can point at a fixture kernel view. It is
 * never a request field: production callers do not accept it from input.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";

export const DEFAULT_PROC_ROOT = "/proc";

export interface ProcessStat {
  readonly state: string;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTimeTicks: string;
}

/**
 * One `/proc/[pid]/stat` read. "gone" is a proven absence; "unobservable" only
 * means the kernel view could not be read, and must never be treated as one.
 */
export type ProcessStatRead =
  | { readonly status: "ok"; readonly stat: ProcessStat }
  | { readonly status: "gone" }
  | { readonly status: "unobservable" };

/** errno values that prove the process does not exist at this moment. */
const PROCESS_GONE_CODES = new Set(["ENOENT", "ESRCH"]);

function isProcessGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && PROCESS_GONE_CODES.has(code);
}

/**
 * Parse `/proc/[pid]/stat`. The command name is parenthesised and may itself
 * contain parentheses and spaces, so only the last ')' delimits the numeric
 * fields.
 */
export function parseProcessStat(text: string): ProcessStat | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTimeTicks = fields[19];
  if (typeof state !== "string" || state.length === 0) return null;
  // Kernel threads have no group or session (both 0); that is a real value, not
  // a malformed line. Callers that require an instance's own session check it
  // separately.
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0) return null;
  if (!Number.isSafeInteger(sessionId) || sessionId < 0) return null;
  if (typeof startTimeTicks !== "string" || !/^\d+$/.test(startTimeTicks)) return null;
  return { state, processGroupId, sessionId, startTimeTicks };
}

export async function readProcessStat(procRoot: string, pid: number): Promise<ProcessStatRead> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unobservable" };
  let text: string;
  try {
    text = await readFile(`${procRoot}/${pid}/stat`, "utf8");
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  const stat = parseProcessStat(text);
  return stat === null ? { status: "unobservable" } : { status: "ok", stat };
}

export function readProcessStatSync(procRoot: string, pid: number): ProcessStatRead {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unobservable" };
  let text: string;
  try {
    text = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  const stat = parseProcessStat(text);
  return stat === null ? { status: "unobservable" } : { status: "ok", stat };
}

export function normalizeBootId(text: string): string | null {
  const value = text.trim();
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export async function readBootId(procRoot: string): Promise<string | null> {
  try {
    return normalizeBootId(await readFile(`${procRoot}/sys/kernel/random/boot_id`, "utf8"));
  } catch {
    return null;
  }
}

/** Boot id never changes while the host is up; cached per kernel root. */
const bootIdCache = new Map<string, string | null>();

export function readBootIdSync(procRoot: string): string | null {
  const cached = bootIdCache.get(procRoot);
  if (cached !== undefined) return cached;
  let value: string | null;
  try {
    value = normalizeBootId(readFileSync(`${procRoot}/sys/kernel/random/boot_id`, "utf8"));
  } catch {
    value = null;
  }
  bootIdCache.set(procRoot, value);
  return value;
}

/** Effective uid from `/proc/[pid]/status`; identity metadata, never a check. */
export function parseUid(text: string): number | null {
  const line = text.split("\n").find((entry) => entry.startsWith("Uid:"));
  if (!line) return null;
  const fields = line.slice(4).trim().split(/\s+/);
  const effective = Number(fields[1]);
  return Number.isSafeInteger(effective) ? effective : null;
}

type UidRead =
  | { readonly status: "ok"; readonly uid: number; readonly nestedPidNamespace: boolean }
  | { readonly status: "gone" }
  | { readonly status: "unobservable" };

/**
 * Ownership plus whether the process is in a nested PID namespace.
 *
 * `NSpid` lists the pid in every namespace from the reader's down to the
 * process's own. A single value means the process is in the reader's PID
 * namespace, so it cannot be inside a sandbox namespace created below it. This
 * matters because `ns/pid` needs PTRACE_MODE_READ: a same-uid process in a
 * different *user* namespace (systemd's `(sd-pam)`, for example) is EACCES even
 * though the process is provably outside the boundary.
 */
function parseStatusIdentity(text: string): { uid: number; nestedPidNamespace: boolean } | null {
  const uid = parseUid(text);
  if (uid === null) return null;
  const line = text.split("\n").find((entry) => entry.startsWith("NSpid:"));
  if (!line) return { uid, nestedPidNamespace: true }; // older kernel: cannot exclude
  const depth = line.slice(6).trim().split(/\s+/).filter((entry) => /^\d+$/.test(entry)).length;
  return { uid, nestedPidNamespace: depth > 1 };
}

/** `/proc/[pid]/status` is world-readable, so this works where `ns/pid` does not. */
async function readStatusIdentity(procRoot: string, pid: number): Promise<UidRead> {
  let text: string;
  try {
    text = await readFile(`${procRoot}/${pid}/status`, "utf8");
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  const identity = parseStatusIdentity(text);
  return identity === null ? { status: "unobservable" } : { status: "ok", ...identity };
}

function readStatusIdentitySync(procRoot: string, pid: number): UidRead {
  let text: string;
  try {
    text = readFileSync(`${procRoot}/${pid}/status`, "utf8");
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  const identity = parseStatusIdentity(text);
  return identity === null ? { status: "unobservable" } : { status: "ok", ...identity };
}

export interface SessionMember {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
}

/** A kernel session scan that also says whether absence was proven. */
export interface SessionScan {
  readonly members: readonly SessionMember[];
  /** False when the kernel view could not be read completely. */
  readonly complete: boolean;
}

/**
 * Options for a namespace scan.
 *
 * `uid` names the owner of the boundary. `/proc/[pid]/ns/pid` needs
 * PTRACE_MODE_READ, so a process owned by another user is unreadable — EACCES —
 * on a normal multi-user host. Such a process cannot be a member of a boundary
 * created by `uid`, so it is skipped instead of making every scan incomplete
 * (which would make cancellation never verifiable). A same-owner process whose
 * namespace is still unreadable keeps the scan incomplete.
 */
export interface NamespaceScanOptions {
  readonly uid?: number;
}

/**
 * Every live process whose kernel session is the given one.
 *
 * `complete: false` means some part of the kernel view could not be read, so an
 * empty member list is not proof that nothing is left. Callers must keep the
 * instance unverified in that case rather than settle it as gone.
 *
 * A descendant that calls setsid() has another session and is invisible here;
 * only the PID namespace functions below cover that case.
 */
export async function scanSessionMembers(procRoot: string, sessionId: number): Promise<SessionScan> {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return { members: [], complete: false };
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return { members: [], complete: false };
  }
  const members: SessionMember[] = [];
  let complete = true;
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    const read = await readProcessStat(procRoot, pid);
    if (read.status === "unobservable") {
      // Whether this process belongs to the session is unknowable, so absence
      // of the whole session is unproven.
      complete = false;
      continue;
    }
    // It exited between readdir() and the read: genuinely absent.
    if (read.status === "gone") continue;
    if (read.stat.sessionId !== sessionId) continue;
    // A zombie still holds the session id but is already dead; it must neither
    // count as alive nor receive a signal.
    if (read.stat.state === "Z") continue;
    members.push({ pid, processGroupId: read.stat.processGroupId, startTimeTicks: read.stat.startTimeTicks });
  }
  return { members, complete };
}

/** One row of a whole-process-table scan. */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTimeTicks: string;
  readonly state: string;
  /** `pid:[inode]`, or null when the namespace link could not be read. */
  readonly namespace: string | null;
}

export interface ProcessTableScan {
  readonly entries: readonly ProcessTableEntry[];
  /** False when any part of the kernel view could not be read. */
  readonly complete: boolean;
}

export type NamespaceRead =
  | { readonly status: "ok"; readonly namespace: string }
  | { readonly status: "gone" }
  | { readonly status: "unobservable" };

const NAMESPACE_PATTERN = /^pid:\[[0-9]+\]$/;

function parseProcessStatWithParent(text: string): Omit<ProcessTableEntry, "pid" | "namespace"> | null {
  const stat = parseProcessStat(text);
  if (stat === null) return null;
  const close = text.lastIndexOf(")");
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) return null;
  return { ...stat, parentPid };
}

export function readPidNamespaceSync(procRoot: string, pid: number): NamespaceRead {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unobservable" };
  let value: string;
  try {
    value = readlinkSync(`${procRoot}/${pid}/ns/pid`);
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  return NAMESPACE_PATTERN.test(value) ? { status: "ok", namespace: value } : { status: "unobservable" };
}

export async function readPidNamespace(procRoot: string, pid: number): Promise<NamespaceRead> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unobservable" };
  let value: string;
  try {
    value = await readlink(`${procRoot}/${pid}/ns/pid`);
  } catch (error) {
    return isProcessGoneError(error) ? { status: "gone" } : { status: "unobservable" };
  }
  return NAMESPACE_PATTERN.test(value) ? { status: "ok", namespace: value } : { status: "unobservable" };
}

export function scanProcessTableSync(procRoot: string, options: NamespaceScanOptions = {}): ProcessTableScan {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return { entries: [], complete: false };
  }
  const entries: ProcessTableEntry[] = [];
  let complete = true;
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    let text: string;
    try {
      text = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    } catch (error) {
      if (isProcessGoneError(error)) continue;
      complete = false;
      continue;
    }
    const stat = parseProcessStatWithParent(text);
    if (stat === null) {
      complete = false;
      continue;
    }
    // A zombie has already ended; it must never count as a live member.
    const nameSpace = readPidNamespaceSync(procRoot, pid);
    if (nameSpace.status === "gone") continue;
    if (nameSpace.status === "unobservable" && !provablyOutsideBoundarySync(procRoot, pid, options.uid)) {
      complete = false;
    }
    entries.push({ pid, ...stat, namespace: nameSpace.status === "ok" ? nameSpace.namespace : null });
  }
  return { entries, complete };
}

/**
 * True when a pid provably belongs to another user, or is provably in the
 * reader's own PID namespace — neither can be a member of a boundary owned by
 * `uid`. Unreadable ownership is not proof, so the caller keeps the scan
 * incomplete in that case.
 */
function provablyOutsideBoundarySync(procRoot: string, pid: number, uid: number | undefined): boolean {
  if (uid === undefined) return false;
  const identity = readStatusIdentitySync(procRoot, pid);
  return identity.status === "ok" && (identity.uid !== uid || !identity.nestedPidNamespace);
}

async function provablyOutsideBoundary(procRoot: string, pid: number, uid: number | undefined): Promise<boolean> {
  if (uid === undefined) return false;
  const identity = await readStatusIdentity(procRoot, pid);
  return identity.status === "ok" && (identity.uid !== uid || !identity.nestedPidNamespace);
}

export interface ProcessIdentity {
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTimeTicks: string;
  readonly bootId: string;
}

/** Bound on capturing a just-spawned child's kernel identity. */
const IDENTITY_CAPTURE_TIMEOUT_MS = 250;
/** Bound on observing the sandbox's PID namespace after its init appears. */
const NAMESPACE_CAPTURE_TIMEOUT_MS = 100;

export interface CapturedProcessIdentity extends ProcessIdentity {
  readonly uid: number;
}

function readUidSync(procRoot: string, pid: number): number | null {
  try {
    return parseUid(readFileSync(`${procRoot}/${pid}/status`, "utf8"));
  } catch {
    return null;
  }
}

function readCommandNameSync(procRoot: string, pid: number): string {
  try {
    const value = readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim();
    return value.length > 0 ? value.slice(0, 64) : "unknown";
  } catch {
    return "unknown";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Capture the kernel identity of a just-spawned process.
 *
 * Synchronous on purpose: a process may exit within a millisecond, and an
 * `await` between spawn() and the first /proc read loses that race. The loop
 * also waits until `detached: true` has taken effect, proven by the child's own
 * session id equalling its pid; a pre-setsid read would record the *parent's*
 * session, which must never become a cancellation target.
 */
export function captureProcessIdentitySync(
  procRoot: string,
  pid: number,
  options: { timeoutMs?: number; commandName?: boolean } = {},
): (CapturedProcessIdentity & { commandName?: string }) | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const bootId = readBootIdSync(procRoot);
  if (bootId === null) return null;
  const deadline = Date.now() + (options.timeoutMs ?? IDENTITY_CAPTURE_TIMEOUT_MS);
  for (;;) {
    const read = readProcessStatSync(procRoot, pid);
    if (read.status === "ok" && read.stat.state !== "Z"
      && read.stat.sessionId === pid && read.stat.processGroupId === pid) {
      const uid = readUidSync(procRoot, pid);
      if (uid !== null) {
        return {
          processGroupId: read.stat.processGroupId,
          sessionId: read.stat.sessionId,
          startTimeTicks: read.stat.startTimeTicks,
          bootId,
          uid,
          ...(options.commandName ? { commandName: readCommandNameSync(procRoot, pid) } : {}),
        };
      }
    }
    if (Date.now() >= deadline) return null;
    sleepSync(1);
  }
}

/**
 * PID namespaces created by a sandbox on behalf of `rootPid`.
 *
 * Bubblewrap unshares the PID namespace, so its workload lives in a namespace
 * whose init is a descendant of the boundary process. A process that calls
 * setsid() stays inside that namespace even though it leaves the session, which
 * is why this — not a session scan — is the complete boundary.
 *
 * Returns every namespace inode seen among the boundary's descendants (and
 * among processes still sharing its session) that differs from the caller's own
 * namespace. An empty list with a live process means the sandbox namespace was
 * not observable yet; callers must not treat it as "no namespace exists".
 */
export function discoverSandboxNamespacesSync(
  procRoot: string,
  rootPid: number,
  ownNamespace: string,
): string[] {
  const scan = scanProcessTableSync(procRoot);
  return sandboxNamespacesFrom(scan, rootPid, ownNamespace);
}

function sandboxNamespacesFrom(scan: ProcessTableScan, rootPid: number, ownNamespace: string): string[] {
  const children = new Map<number, { pid: number; namespace: string }[]>();
  for (const entry of scan.entries) {
    const namespace = entry.namespace;
    if (namespace === null || namespace === ownNamespace) continue;
    const child = { pid: entry.pid, namespace };
    const siblings = children.get(entry.parentPid);
    if (siblings) siblings.push(child);
    else children.set(entry.parentPid, [child]);
  }
  const found = new Set<string>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) {
      if (found.has(child.namespace)) continue;
      found.add(child.namespace);
      queue.push(child.pid);
    }
  }
  // A daemonized descendant can be reparented before it is seen; its session
  // still points at the boundary until it calls setsid(), and after that the
  // namespace scan itself finds it. Include both evidence sources.
  for (const entry of scan.entries) {
    if (entry.namespace === null || entry.namespace === ownNamespace) continue;
    if (entry.sessionId !== rootPid) continue;
    found.add(entry.namespace);
  }
  return [...found].sort();
}

/**
 * Capture a sandbox boundary: the kernel identity of the sandbox monitor plus
 * the PID namespaces its workload lives in.
 *
 * The namespace poll is bounded and runs only when the monitor is still alive;
 * a process that already exited needs no boundary. `namespaces` may be empty
 * when the sandbox never built one (or built it after the deadline), and
 * callers must then keep termination unconfirmed rather than claim the whole
 * tree is gone.
 */
export function captureSandboxBoundarySync(
  procRoot: string,
  pid: number,
  options: { ownNamespace?: string; namespaceTimeoutMs?: number } = {},
): { identity: CapturedProcessIdentity; namespaces: string[] } | null {
  const identity = captureProcessIdentitySync(procRoot, pid);
  if (identity === null) return null;
  let own = options.ownNamespace;
  if (own === undefined) {
    const self = readPidNamespaceSync(procRoot, process.pid);
    if (self.status !== "ok") return { identity, namespaces: [] };
    own = self.namespace;
  }
  const deadline = Date.now() + (options.namespaceTimeoutMs ?? NAMESPACE_CAPTURE_TIMEOUT_MS);
  for (;;) {
    const namespaces = discoverSandboxNamespacesSync(procRoot, pid, own);
    if (namespaces.length > 0) return { identity, namespaces };
    const current = readProcessStatSync(procRoot, pid);
    if (current.status !== "ok" || current.stat.startTimeTicks !== identity.startTimeTicks) {
      // The monitor ended before a namespace was observed; nothing is left to
      // govern, and the caller sees the absence separately.
      return { identity, namespaces: [] };
    }
    if (Date.now() >= deadline) return { identity, namespaces: [] };
    sleepSync(1);
  }
}

export interface NamespaceMembers {
  readonly members: readonly { readonly pid: number; readonly startTimeTicks: string }[];
  /** False when the kernel view could not be read completely. */
  readonly complete: boolean;
}

/**
 * Every live process whose PID namespace is one of `namespaces`.
 *
 * This is the closure a session scan cannot provide: a setsid() descendant has
 * its own session but stays in the same PID namespace.
 */
export async function scanNamespaceMembers(
  procRoot: string,
  namespaces: readonly string[],
  options: NamespaceScanOptions = {},
): Promise<NamespaceMembers> {
  if (namespaces.length === 0) return { members: [], complete: false };
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return { members: [], complete: false };
  }
  const wanted = new Set(namespaces);
  const members: { pid: number; startTimeTicks: string }[] = [];
  let complete = true;
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    const stat = await readProcessStat(procRoot, pid);
    if (stat.status === "gone") continue;
    if (stat.status === "unobservable") {
      complete = false;
      continue;
    }
    if (stat.stat.state === "Z") continue;
    const namespace = await readPidNamespace(procRoot, pid);
    if (namespace.status === "gone") continue;
    if (namespace.status === "unobservable") {
      if (!(await provablyOutsideBoundary(procRoot, pid, options.uid))) complete = false;
      continue;
    }
    if (!wanted.has(namespace.namespace)) continue;
    members.push({ pid, startTimeTicks: stat.stat.startTimeTicks });
  }
  return { members, complete };
}

/**
 * Synchronous form of {@link scanNamespaceMembers}, for observers that must
 * answer in the same turn as a state read (the Runner's observation endpoint)
 * rather than hold an HTTP response open across a whole-process scan.
 */
export function scanNamespaceMembersSync(
  procRoot: string,
  namespaces: readonly string[],
  options: NamespaceScanOptions = {},
): NamespaceMembers {
  if (namespaces.length === 0) return { members: [], complete: false };
  const wanted = new Set(namespaces);
  const scan = scanProcessTableSync(procRoot, options);
  const members: { pid: number; startTimeTicks: string }[] = [];
  for (const entry of scan.entries) {
    if (entry.state === "Z") continue;
    // A null namespace is already reflected in scan.complete; another user's
    // process is unreadable but excluded by construction.
    if (entry.namespace === null) continue;
    if (!wanted.has(entry.namespace)) continue;
    members.push({ pid: entry.pid, startTimeTicks: entry.startTimeTicks });
  }
  return { members, complete: scan.complete };
}

export type SignalOutcome =
  | "sent"
  | "gone"
  /** The signal was not delivered (EPERM or an unexpected error). */
  | "denied";

/** What one process.kill() call established. */
export function sendSignal(target: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    process.kill(target, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "denied";
  }
}
