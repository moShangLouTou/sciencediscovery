// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** Supervised read-only Python probes. Product modules supply trusted programs
 * and classify their output; this module owns leases, exclusion and termination.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EnvironmentStore, EnvironmentRuntime } from "./environment-store.js";
import { boundaryTerminationVerified, captureExecutionBoundaryOutcome,
  type BoundaryCaptureOutcome, type ExecutionBoundaryHandle } from "./execution-boundary.js";
import { environmentPrefixBindArguments, executorSandboxKind, hostInterpreterMaskArguments,
  prepareSandboxLaunch, ProcessTerminationUnverifiedError, resolveHostRuntimeSupport,
  runSandboxed, sandboxCommandPath, workspaceBindArguments,
  type ExecutorConfig, type SandboxLaunch } from "./executor.js";

export type RuntimeProbeEnvironmentStore = Pick<EnvironmentStore, "withRuntime">
  & Partial<Pick<EnvironmentStore, "releaseRuntimeCheckReservation" | "reserveRuntimeCheck" | "runtimeCheckBoundary">>;
export interface RuntimeProbeProgram {
  readonly program: string;
  readonly interpreterFlags: readonly string[];
  readonly readOnlyHostBinds: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
export type RuntimeProbeRunOutcome =
  | { readonly status: "output"; readonly stdout: string }
  | { readonly status: "termination-unverified"; readonly handle: ExecutionBoundaryHandle | "unproven" }
  | { readonly status: "unavailable"; readonly reason: "launch-failed" | "probe-timeout" | "probe-failed" };
export interface RuntimeProbeContext {
  readonly environment: EnvironmentRuntime;
  run(program: RuntimeProbeProgram): Promise<RuntimeProbeRunOutcome>;
}
export type RuntimeProbeLeaseOutcome<T> =
  | { readonly status: "result"; readonly value: T }
  | { readonly status: "unavailable" };
export interface RuntimeProbeServiceDeps {
  readonly config: ExecutorConfig;
  readonly environmentStore: RuntimeProbeEnvironmentStore;
  readonly procRoot?: string;
  readonly onDiagnostic?: (reason: string, detail?: Record<string, unknown>) => void;
}

export function createRuntimeProbeService(deps: RuntimeProbeServiceDeps) {
  const { config, environmentStore } = deps;
  const inFlight = new Set<string>();
  const inFlightEnvironments = new Set<string>();
  // Optional storage ports support isolated adapters; the real store persists fences.
  const unverified = new Map<string, ExecutionBoundaryHandle | "unproven">();
  const diagnose = (reason: string) => deps.onDiagnostic?.(reason);
  const unavailable = () => ({ status: "unavailable" as const });

  const clearProvenReservation = (environmentId: string): "clear" | "fenced" | "corrupt" => {
    const local = unverified.get(environmentId);
    if (local !== undefined) {
      if (local === "unproven" || !boundaryTerminationVerified(local, deps.procRoot)) return "fenced";
      unverified.delete(environmentId);
    }
    const read = environmentStore.runtimeCheckBoundary?.bind(environmentStore);
    if (!read) return "clear";
    const boundary = read(environmentId);
    if (boundary === undefined) return "clear";
    if (boundary === "corrupt") return "corrupt";
    if (boundary === "unproven" || !boundaryTerminationVerified(boundary, deps.procRoot)) return "fenced";
    try { environmentStore.releaseRuntimeCheckReservation?.(environmentId); }
    catch { diagnose("fence-release-failed"); return "fenced"; }
    return read(environmentId) === undefined ? "clear" : "fenced";
  };
  const fenceEnvironment = (environmentId: string, handle: ExecutionBoundaryHandle | "unproven") => {
    unverified.set(environmentId, handle);
    try { environmentStore.reserveRuntimeCheck?.(environmentId, handle); }
    catch { diagnose("fence-persist-failed"); }
  };

  return {
    async withEnvironment<T>(identity: { readonly scopeKey: string; readonly environmentId: string },
      operation: (probe: RuntimeProbeContext) => Promise<T>): Promise<RuntimeProbeLeaseOutcome<T>> {
      const { scopeKey, environmentId } = identity;
      if (executorSandboxKind(config) !== "bubblewrap") {
        diagnose("sandbox-unsupported"); return unavailable();
      }
      if (inFlight.has(scopeKey) || inFlightEnvironments.has(environmentId)) {
        diagnose("concurrent-check"); return unavailable();
      }
      const reservation = clearProvenReservation(environmentId);
      if (reservation !== "clear") {
        diagnose(reservation === "corrupt" ? "reservation-corrupt" : "termination-unverified");
        return unavailable();
      }
      inFlight.add(scopeKey);
      inFlightEnvironments.add(environmentId);
      try {
        return await environmentStore.withRuntime(environmentId, async (environment) => {
          const afterLease = clearProvenReservation(environmentId);
          if (afterLease !== "clear") {
            diagnose(afterLease === "corrupt" ? "reservation-corrupt" : "termination-unverified");
            return unavailable();
          }
          let active = true;
          let running: Promise<RuntimeProbeRunOutcome> | undefined;
          const probe: RuntimeProbeContext = { environment, run(program) {
            if (!active || running) return Promise.resolve({ status: "unavailable", reason: "launch-failed" });
            const gate = clearProvenReservation(environmentId);
            if (gate !== "clear") return Promise.resolve({ status: "unavailable", reason: "launch-failed" });
            running = (async () => {
              try {
                const outcome = await runRuntimeProbe({ ...program, config, environment, procRoot: deps.procRoot });
                if (outcome.status === "termination-unverified") fenceEnvironment(environmentId, outcome.handle);
                return outcome;
              } finally { running = undefined; }
            })();
            return running;
          } };
          try {
            const value = await operation(probe);
            return { status: "result" as const, value };
          } finally {
            active = false;
            // A product cannot release the environment while its launched phase
            // is still being supervised, even if it forgot to await the answer.
            await running;
          }
        });
      } catch {
        diagnose("scientific-env-unavailable"); return unavailable();
      } finally {
        inFlight.delete(scopeKey);
        inFlightEnvironments.delete(environmentId);
      }
    },
  };
}

/** Run one probe phase through the ordinary supervised sandbox path. */
async function runRuntimeProbe(options: RuntimeProbeProgram & {
  readonly config: ExecutorConfig;
  readonly environment: EnvironmentRuntime;
  readonly procRoot?: string;
}): Promise<RuntimeProbeRunOutcome> {
  const { config, environment } = options;
  const runRoot = resolve(config.dataDir, "runtime-checks");
  await mkdir(runRoot, { mode: 0o700, recursive: true });
  // The only writable path of the run. It holds no project data and is removed
  // once the sandbox is proven gone.
  const workspace = await mkdtemp(resolve(runRoot, "probe-"));
  let capture: BoundaryCaptureOutcome | undefined;
  let started = false;

  let launch: SandboxLaunch;
  try {
    const workspaceBinds = workspaceBindArguments(workspace, undefined);
    launch = await prepareSandboxLaunch(config, {
      chdir: workspaceBinds.chdir,
      environmentBinds: environmentPrefixBindArguments(environment.prefixPath),
      environmentPaths: [environment.prefixPath],
      hostInterpreterMasks: await hostInterpreterMaskArguments(),
      hostRuntimeSupport: await resolveHostRuntimeSupport(config.dataDir),
      language: "python",
      pathEnv: "/opt/science-env/bin:/usr/bin",
      // Administrator-selected read-only inputs. This internal program specification
      // must never be populated directly from an untrusted HTTP request.
      readOnlyHostBinds: [...options.readOnlyHostBinds],
      workspaceBindArgs: workspaceBinds.args,
      workspaceRoot: workspace,
    });
  } catch {
    await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    return { reason: "launch-failed", status: "unavailable" };
  }

  const commandArguments = [
    sandboxCommandPath(launch, "/opt/science-env/bin/python", environment.interpreterPath),
    ...options.interpreterFlags,
    "-",
  ];
  try {
    const run = await runSandboxed(
      config,
      launch,
      commandArguments,
      `${options.program}\n`,
      options.timeoutMs,
      workspace,
      undefined,
      "Runtime probe",
      0,
      options.maxOutputBytes,
      "baseline",
      undefined,
      // Captured synchronously inside the spawn turn: the only moment the pid
      // provably still names the sandbox this check created.
      (child, sandbox) => {
        started = true;
        capture = captureExecutionBoundaryOutcome(
          `runtime-probe:${randomUUID()}`,
          {
            kind: sandbox === "bubblewrap" ? "pid-namespace" : "process",
            pid: child.pid ?? 0,
            sandbox,
          },
          options.procRoot,
        );
      },
    );

    // A probe that ran had a process; a missing proof of termination still
    // ends the check as unavailable rather than claiming a supervised run.
    const termination = await settled(capture, options.procRoot, started);
    if (termination !== null) return termination;
    if (run.exitCode !== 0) return { reason: "probe-failed", status: "unavailable" };
    return { status: "output", stdout: run.stdout };
  } catch (error) {
    if (error instanceof ProcessTerminationUnverifiedError) {
      return { handle: capture?.status === "captured" ? capture.handle : "unproven", status: "termination-unverified" };
    }
    // A timeout or abort is still a supervised kill; whether it was proven is
    // exactly what the captured boundary answers.
    const termination = await settled(capture, options.procRoot, started);
    if (termination !== null) return termination;
    const timedOut = error instanceof Error && /timed out|aborted/iu.test(error.message);
    return { reason: timedOut ? "probe-timeout" : "probe-failed", status: "unavailable" };
  } finally {
    // Only remove the workspace when the monitor is known to have joined; a
    // failed termination keeps the directory so nothing deletes a live writer's
    // files underneath it.
    const terminationProven = !started || (capture !== undefined
      && (capture.status === "ended"
        || (capture.status === "captured" && boundaryTerminationVerified(capture.handle, options.procRoot))));
    if (terminationProven) {
      await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

/**
 * Decide whether the sandbox that ran one probe phase provably ended.
 *
 * Returns null when it did; otherwise a result that stands in for the probe's
 * output, with the handle kept for a later observation. A run that never
 * started a process reports launch failure without fencing the environment.
 */
async function settled(
  capture: BoundaryCaptureOutcome | undefined,
  procRoot: string | undefined,
  started: boolean,
): Promise<RuntimeProbeRunOutcome | null> {
  if (capture === undefined) {
    return started
      ? { handle: "unproven", status: "termination-unverified" }
      : { reason: "launch-failed", status: "unavailable" };
  }
  if (capture.status === "ended") return null;
  if (capture.status === "captured") {
    return boundaryTerminationVerified(capture.handle, procRoot)
      ? null
      : { handle: capture.handle, status: "termination-unverified" };
  }
  // `not-applicable` cannot happen for a bubblewrap launch, and `unavailable`
  // means the kernel never named the boundary: neither is a proof.
  return { handle: "unproven", status: "termination-unverified" };
}

