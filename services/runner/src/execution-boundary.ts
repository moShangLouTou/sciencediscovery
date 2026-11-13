// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Durable process identity for one managed execution, owned by the Runner.
 *
 * The handle is Runner-private: it is written to the execution ledger next to
 * the record and never leaves the process except as the additive, host-free
 * `boundary` status. It exists so that after the Runner is killed mid-execution
 * a restarted Runner can answer two questions without the original
 * AbortController and without guessing:
 *
 * 1. Is the process tree this execution started still alive?
 * 2. May a stop signal be sent to it, and did the whole tree actually end?
 *
 * The second answer is the reason the handle names a PID namespace instead of a
 * process group. Bubblewrap unshares PID, so a descendant that calls setsid()
 * leaves the group and the session but stays in the namespace; when the
 * namespace has no members left, nothing of that execution can still write to
 * its workspace. A handle that cannot be verified is never repaired by
 * inference: absence of the monitor process alone does not prove the namespace
 * is empty, and an unreadable /proc never becomes "gone".
 */
import {
  DEFAULT_PROC_ROOT,
  captureSandboxBoundarySync,
  readBootIdSync,
  readPidNamespaceSync,
  readProcessStat,
  readProcessStatSync,
  scanNamespaceMembers,
  scanNamespaceMembersSync,
  sendSignal,
} from "@sciencediscovery/sandbox-capability";
import type { ExecutionBoundaryStatus } from "@sciencediscovery/schema";

export const EXECUTION_BOUNDARY_SCHEMA_VERSION = 1;
/** Bounded wait for a TERM to empty the namespace before escalating to KILL. */
export const DEFAULT_BOUNDARY_TERM_GRACE_MS = 2_000;
/** Bounded wait for KILL to empty the namespace before reporting unverified. */
export const DEFAULT_BOUNDARY_KILL_GRACE_MS = 2_000;
/** Poll interval while a stop waits for the kernel, not for an ACK. */
export const DEFAULT_BOUNDARY_POLL_MS = 50;

/** Which mechanism actually bounds the processes a spawn created. */
export type ExecutionBoundaryKind = "pid-namespace" | "process-group" | "process";

export interface SpawnedExecution {
  pid: number;
  kind: ExecutionBoundaryKind;
  sandbox: "bubblewrap" | "seatbelt" | "none";
}

/**
 * What the ledger already established about a just-spawned sandbox. A caller
 * that needs to escalate or prove the same process tree reads it back here
 * instead of capturing a second, competing identity.
 */
export type SpawnBoundaryReport =
  | { readonly state: "captured"; readonly handle: ExecutionBoundaryHandle }
  /** The sandbox already ended inside its own spawn turn. */
  | { readonly state: "ended" }
  /** No durable identity exists; nothing may be signaled or proven from here. */
  | { readonly state: "unavailable" };

/**
 * What the executor hands to the ledger while it still runs synchronously
 * after spawn(). Nothing here may await: a short-lived sandbox can exit before
 * the first /proc read of the next microtask.
 */
export interface ExecutionLifecycle {
  spawned(execution: SpawnedExecution): void;
  /** Transfer cleanup to the manager before spawn; release only after proof. */
  retainResource?(cleanup: () => Promise<void>, label: string): void;
  /**
   * Register the graceful stop for a running execution. The manager persists
   * the stop intent first and then calls this instead of aborting the
   * controller, so a workload that can stop itself is asked before it is
   * killed. The handler must be bounded by its own deadline.
   */
  requestStop?(handler: () => Promise<void>): void;
  /** Read back the identity the ledger captured in the spawn turn. */
  boundary?(): SpawnBoundaryReport;
}

/** Exactly what the Runner persists; unknown fields are rejected on load. */
export interface ExecutionBoundaryHandle {
  schemaVersion: typeof EXECUTION_BOUNDARY_SCHEMA_VERSION;
  kind: "pid-namespace";
  executionId: string;
  sandbox: "bubblewrap";
  /** Boot the handle was captured in; a different boot proves it cannot live now. */
  bootId: string;
  /** Host pid of the sandbox monitor (the Runner's direct child). */
  pid: number;
  /** Field 22 of /proc/[pid]/stat: pid plus this is the whole identity. */
  startTimeTicks: string;
  processGroupId: number;
  sessionId: number;
  uid: number;
  /** PID namespace inodes (`pid:[n]`) the sandbox workload lives in. */
  namespaces: string[];
  capturedAt: string;
}

/** A handle that cannot be trusted is not a handle; never signal from one. */
export function isValidExecutionBoundaryHandle(value: unknown): value is ExecutionBoundaryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Record<string, unknown>;
  return handle.schemaVersion === EXECUTION_BOUNDARY_SCHEMA_VERSION
    && handle.kind === "pid-namespace"
    && handle.sandbox === "bubblewrap"
    && typeof handle.executionId === "string" && handle.executionId.length > 0 && handle.executionId.length <= 160
    && typeof handle.bootId === "string" && /^[0-9a-f-]{36}$/i.test(handle.bootId)
    && Number.isSafeInteger(handle.pid) && (handle.pid as number) > 0
    && typeof handle.startTimeTicks === "string" && /^\d+$/.test(handle.startTimeTicks)
    && Number.isSafeInteger(handle.processGroupId) && (handle.processGroupId as number) > 0
    && Number.isSafeInteger(handle.sessionId) && (handle.sessionId as number) > 0
    && Number.isSafeInteger(handle.uid) && (handle.uid as number) >= 0
    && Array.isArray(handle.namespaces)
    && handle.namespaces.every((entry) => typeof entry === "string" && /^pid:\[[0-9]+\]$/.test(entry))
    && typeof handle.capturedAt === "string";
}

/**
 * What the kernel said about a just-spawned sandbox in the spawn turn.
 *
 * The distinction that matters: a sandbox which should have a durable boundary
 * but produced none is not the same thing as a platform that never had one. The
 * former is an unowned process tree and must fail closed; the latter keeps the
 * execution's existing (non-boundary) semantics.
 */
export type BoundaryCaptureOutcome =
  | { status: "captured"; handle: ExecutionBoundaryHandle }
  | { status: "not-applicable" }
  | { status: "ended" }
  | { status: "unavailable"; reason: "identity-unreadable" | "namespace-unobserved" };

/**
 * Capture the boundary of a process the executor just spawned, keeping the
 * reason when no handle can be produced.
 *
 * `ended` means the monitor itself was already gone (or its pid already named
 * another process), so nothing it started can still be inside its namespace:
 * bubblewrap does not outlive its namespace init, and the kernel tears the
 * namespace down with that init. `unavailable` means the process may still be
 * alive but the kernel view could not prove its identity or namespace; callers
 * must not treat that as a boundary.
 */
export function captureExecutionBoundaryOutcome(
  executionId: string,
  spawned: SpawnedExecution,
  procRoot: string = DEFAULT_PROC_ROOT,
): BoundaryCaptureOutcome {
  if (spawned.kind !== "pid-namespace" || spawned.sandbox !== "bubblewrap") {
    return { status: "not-applicable" };
  }
  const captured = captureSandboxBoundarySync(procRoot, spawned.pid);
  if (captured === null) {
    const current = readProcessStatSync(procRoot, spawned.pid);
    return current.status === "gone" || (current.status === "ok" && current.stat.state === "Z")
      ? { status: "ended" }
      : { status: "unavailable", reason: "identity-unreadable" };
  }
  if (captured.namespaces.length === 0) {
    const current = readProcessStatSync(procRoot, spawned.pid);
    if (current.status === "gone" || (current.status === "ok" && (current.stat.state === "Z"
      || current.stat.startTimeTicks !== captured.identity.startTimeTicks))) {
      return { status: "ended" };
    }
    // The monitor is still this process but no sandbox namespace was observed
    // within the capture budget: the bound of its tree is unknown.
    return { status: "unavailable", reason: "namespace-unobserved" };
  }
  return {
    status: "captured",
    handle: {
      schemaVersion: EXECUTION_BOUNDARY_SCHEMA_VERSION,
      kind: "pid-namespace",
      executionId,
      sandbox: "bubblewrap",
      bootId: captured.identity.bootId,
      pid: spawned.pid,
      startTimeTicks: captured.identity.startTimeTicks,
      processGroupId: captured.identity.processGroupId,
      sessionId: captured.identity.sessionId,
      uid: captured.identity.uid,
      namespaces: captured.namespaces,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * Capture the boundary of a process the executor just spawned.
 *
 * Returns null when the kernel view cannot name the identity or the boot
 * (unsupported platform, unreadable /proc, or a process that exited before its
 * own session existed). Null is recorded as "no handle"; it is never replaced
 * by a guess, and callers must keep the execution unverifiable rather than
 * promise cancellation.
 */
export function captureExecutionBoundary(
  executionId: string,
  spawned: SpawnedExecution,
  procRoot: string = DEFAULT_PROC_ROOT,
): ExecutionBoundaryHandle | null {
  const outcome = captureExecutionBoundaryOutcome(executionId, spawned, procRoot);
  return outcome.status === "captured" ? outcome.handle : null;
}

/** The namespace this Runner itself lives in, or null when it cannot be read. */
function runnerNamespace(procRoot: string): string | null {
  const own = readPidNamespaceSync(procRoot, process.pid);
  return own.status === "ok" ? own.namespace : null;
}

/**
 * Observe the recorded boundary without touching it.
 *
 * Deliberately synchronous: an observation request must not flip anything, and
 * a caller reading a record expects the answer to describe the moment it asked.
 * `terminationConfirmed` is true only when the whole namespace is proven empty
 * in the boot that created it; a different boot proves the same thing because
 * no process survives a reboot, and the state says so explicitly.
 */
export function observeExecutionBoundary(
  handle: ExecutionBoundaryHandle | undefined,
  options: { procRoot?: string; stopRequestedAt?: string } = {},
): ExecutionBoundaryStatus {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const observedAt = new Date().toISOString();
  const base = options.stopRequestedAt ? { observedAt, stopRequestedAt: options.stopRequestedAt } : { observedAt };
  if (handle === undefined) {
    return { ...base, state: "not-recorded", terminationConfirmed: false, reason: "no-handle" };
  }
  const boot = readBootIdSync(procRoot);
  if (boot === null) {
    return { ...base, state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" };
  }
  if (boot !== handle.bootId) {
    // The handle belongs to another boot, so nothing it names can be verified
    // now: the pid number may already belong to an unrelated process. This is
    // not proof about *this* boot, so it never confirms termination.
    return { ...base, state: "boot-changed", terminationConfirmed: false, reason: "boot-mismatch" };
  }
  if (handle.namespaces.length === 0) {
    // The sandbox never exposed a namespace to observe, so the bound of the
    // tree is unknown. The monitor may be gone while an escaped descendant is
    // not; claiming termination here would be a guess.
    return { ...base, state: "unverifiable", terminationConfirmed: false, reason: "namespace-unverified" };
  }
  const own = runnerNamespace(procRoot);
  if (own !== null && handle.namespaces.includes(own)) {
    // A recorded boundary that contains the Runner is not a sandbox; it can
    // only come from a corrupted or edited ledger. Never treat it as one.
    return { ...base, state: "unverifiable", terminationConfirmed: false, reason: "namespace-own" };
  }
  const members = scanNamespaceMembersSync(procRoot, handle.namespaces, { uid: handle.uid });
  if (!members.complete) {
    return { ...base, state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" };
  }
  return members.members.length > 0
    ? { ...base, state: "alive", terminationConfirmed: false }
    : { ...base, state: "gone", terminationConfirmed: true };
}

export interface BoundaryTerminationResult {
  /** At least one signal was delivered to a verified member of this boundary. */
  signaled: boolean;
  confirmed: boolean;
  status: ExecutionBoundaryStatus;
}

export interface BoundaryTerminationOptions {
  procRoot?: string;
  stopRequestedAt?: string;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop the recorded execution boundary and prove it ended.
 *
 * Order matters and is the contract:
 *
 * 1. Refuse on any identity doubt — a different boot, an unreadable kernel, an
 *    empty namespace list, a corrupt handle — before any signal exists.
 * 2. TERM only a member whose kernel identity still matches the record.
 * 3. KILL anything still alive inside the recorded namespace, verifying each
 *    member's own start time first so a recycled pid is never hit.
 * 4. Report `confirmed` only when a complete scan shows the namespace empty.
 *
 * A delivered signal is never treated as a completed stop, and a bystander is
 * unreachable by construction: only pids inside the recorded namespace inodes
 * are candidates, and their start times are re-read before signaling.
 */
export async function terminateExecutionBoundary(
  handle: ExecutionBoundaryHandle | undefined,
  options: BoundaryTerminationOptions = {},
): Promise<BoundaryTerminationResult> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const termGraceMs = options.termGraceMs ?? DEFAULT_BOUNDARY_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_BOUNDARY_KILL_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_BOUNDARY_POLL_MS;
  const statusFor = (value: Omit<ExecutionBoundaryStatus, "observedAt">): ExecutionBoundaryStatus =>
    ({ observedAt: new Date().toISOString(), ...(options.stopRequestedAt ? { stopRequestedAt: options.stopRequestedAt } : {}), ...value });

  if (handle === undefined) {
    return { signaled: false, confirmed: false, status: statusFor({ state: "not-recorded", terminationConfirmed: false, reason: "no-handle" }) };
  }
  const boot = readBootIdSync(procRoot);
  if (boot === null) {
    return { signaled: false, confirmed: false, status: statusFor({ state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" }) };
  }
  if (boot !== handle.bootId) {
    // Never signal a pid from a previous boot: the number now names anything.
    return { signaled: false, confirmed: false, status: statusFor({ state: "boot-changed", terminationConfirmed: false, reason: "boot-mismatch" }) };
  }
  if (handle.namespaces.length === 0) {
    return { signaled: false, confirmed: false, status: statusFor({ state: "unverifiable", terminationConfirmed: false, reason: "namespace-unverified" }) };
  }
  const own = runnerNamespace(procRoot);
  if (own !== null && handle.namespaces.includes(own)) {
    // A boundary naming the Runner's own namespace would make every signal in
    // the escalation a host-wide kill. Refuse before the first one exists.
    return { signaled: false, confirmed: false, status: statusFor({ state: "unverifiable", terminationConfirmed: false, reason: "namespace-own" }) };
  }

  let signaled = false;
  // TERM the monitor only while pid + start time still identify the recorded
  // process. A mismatch means the number was recycled; the namespace scan below
  // — not the number — decides whether anything of ours is still alive.
  const monitor = await readProcessStat(procRoot, handle.pid);
  if (monitor.status === "ok" && monitor.stat.startTimeTicks === handle.startTimeTicks
    && sendSignal(handle.pid, "SIGTERM") === "sent") signaled = true;
  if (monitor.status === "unobservable") {
    return { signaled, confirmed: false, status: statusFor({ state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" }) };
  }

  const deadline = Date.now() + termGraceMs;
  for (;;) {
    const scan = await scanNamespaceMembers(procRoot, handle.namespaces, { uid: handle.uid });
    if (scan.complete && scan.members.length === 0) {
      return { signaled, confirmed: true, status: statusFor({ state: "gone", terminationConfirmed: true }) };
    }
    if (!scan.complete) break;
    if (Date.now() >= deadline) break;
    await delay(pollMs);
  }

  // Escalate to KILL: the monitor again (same identity check), then every
  // remaining member of the namespace. Each member's start time is read afresh
  // so a pid that has already been recycled is skipped, not killed.
  if (monitor.status === "ok") {
    const current = await readProcessStat(procRoot, handle.pid);
    if (current.status === "ok" && current.stat.startTimeTicks === handle.startTimeTicks
      && sendSignal(handle.pid, "SIGKILL") === "sent") signaled = true;
  }
  const members = await scanNamespaceMembers(procRoot, handle.namespaces, { uid: handle.uid });
  for (const member of members.members) {
    const current = await readProcessStat(procRoot, member.pid);
    if (current.status !== "ok" || current.stat.startTimeTicks !== member.startTimeTicks) continue;
    if (sendSignal(member.pid, "SIGKILL") === "sent") signaled = true;
  }

  const killDeadline = Date.now() + killGraceMs;
  for (;;) {
    const scan = await scanNamespaceMembers(procRoot, handle.namespaces, { uid: handle.uid });
    if (scan.complete && scan.members.length === 0) {
      return { signaled, confirmed: true, status: statusFor({ state: "gone", terminationConfirmed: true }) };
    }
    if (!scan.complete) {
      return { signaled, confirmed: false, status: statusFor({ state: "unverifiable", terminationConfirmed: false, reason: "kernel-unreadable" }) };
    }
    if (Date.now() >= killDeadline) {
      return { signaled, confirmed: false, status: statusFor({ state: "alive", terminationConfirmed: false }) };
    }
    await delay(pollMs);
  }
}

/**
 * Verify, after the executor reported the command joined, that the recorded
 * boundary is really empty.
 *
 * A joined `close` event proves the monitor exited; it does not by itself prove
 * that a setsid() descendant already left. This returns false when the kernel
 * cannot prove the namespace empty, so the caller can quarantine instead of
 * publishing a snapshot over a possible live writer.
 */
export function boundaryTerminationVerified(
  handle: ExecutionBoundaryHandle | undefined,
  procRoot: string = DEFAULT_PROC_ROOT,
): boolean {
  if (handle === undefined) return false;
  const status = observeExecutionBoundary(handle, { procRoot });
  return status.terminationConfirmed;
}
