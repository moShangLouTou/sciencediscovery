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
 * Proof R: the research-layout probe.
 *
 * The existing runtime check (proof S) runs a static inventory and a normal
 * start against the environment's own site configuration, at the checkout's
 * host path. It says nothing about the layout a managed research run uses: the
 * checkout mounted read-only at `/scienceflow-engine`, `PYTHONPATH` naming that
 * mount, the engine's own `-P` child flags, and a `.venv` masked by an empty
 * tmpfs.
 *
 * This module answers only that second question, with one supervised sandbox
 * launch in the same environment lease S just vetted. It is not wired into the
 * public check path in this round: its caller is the feasibility harness, and
 * the start path still refuses before a research launch exists.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { SeccompVariant } from "./seccomp.js";
import {
  boundaryTerminationVerified,
  captureExecutionBoundaryOutcome,
  type BoundaryCaptureOutcome,
  type ExecutionBoundaryHandle,
} from "./execution-boundary.js";
import {
  environmentPrefixBindArguments,
  ProcessTerminationUnverifiedError,
  hostInterpreterMaskArguments,
  prepareSandboxLaunch,
  resolveHostRuntimeSupport,
  runSandboxed,
  sandboxCommandPath,
  workspaceBindArguments,
  type ExecutorConfig,
} from "./executor.js";

import { SCIENCEFLOW_ENGINE_MOUNT as RESEARCH_ENGINE_MOUNT } from "./scienceflow-engine-bridge.js";

/** Bound on one research-layout probe run. */
export const RESEARCH_LAYOUT_PROBE_TIMEOUT_MS = 60_000;
/** A facts answer larger than this is a protocol error, not a fact set. */
export const RESEARCH_LAYOUT_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The probe program, passed on the interpreter's stdin.
 *
 * It reports only what it observed. Nothing it prints is a host filesystem
 * inventory: the paths it names are the fixed mount, the leased interpreter and
 * `sys.path`, and the caller decides what may be published.
 */
export const RESEARCH_LAYOUT_PROBE_SOURCE = String.raw`
import json, os, sys

facts = {
    "executable": sys.executable,
    "prefix": sys.prefix,
    "safe_path": bool(getattr(sys.flags, "safe_path", False)),
    "no_user_site": bool(getattr(sys.flags, "no_user_site", False)),
    "cwd": os.getcwd(),
    "path_head": list(sys.path)[:8],
}

def spec(name):
    try:
        import importlib.util
        found = importlib.util.find_spec(name)
    except Exception as error:
        return {"state": "error", "detail": type(error).__name__}
    if found is None:
        return {"state": "missing"}
    return {"state": "found", "origin": found.origin or None}

for key, name in (
    ("scienceflow", "scienceflow"),
    ("prep", "scienceflow.interfaces.cli"),
    ("task", "scienceflow.runtime.parallel.execution.task_worker"),
    ("report", "scienceflow.runtime.parallel.control.reporting"),
):
    facts[key] = spec(name)

try:
    from scienceflow.runtime.environment import resolve_project_python
    executable, bin_directory = resolve_project_python()
    facts["project_python"] = executable
    facts["project_python_bin"] = bin_directory
except Exception as error:
    facts["project_python"] = None
    facts["project_python_error"] = type(error).__name__

print(json.dumps(facts))
`;

export interface ResearchLayoutModuleFact {
  readonly state: "found" | "missing" | "error";
  readonly origin?: string | null;
  readonly detail?: string;
}

export interface ResearchLayoutFacts {
  readonly executable: string;
  readonly prefix: string;
  readonly safePath: boolean;
  readonly noUserSite: boolean;
  readonly cwd: string;
  readonly pathHead: readonly string[];
  readonly scienceflow: ResearchLayoutModuleFact;
  readonly prep: ResearchLayoutModuleFact;
  readonly task: ResearchLayoutModuleFact;
  readonly report: ResearchLayoutModuleFact;
  readonly projectPython: string | null;
  readonly projectPythonError?: string;
}

function moduleFact(value: unknown): ResearchLayoutModuleFact | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "found" && record.state !== "missing" && record.state !== "error") return null;
  if (record.origin !== undefined && record.origin !== null && typeof record.origin !== "string") return null;
  if (record.detail !== undefined && typeof record.detail !== "string") return null;
  return {
    detail: typeof record.detail === "string" ? record.detail : undefined,
    origin: typeof record.origin === "string" ? record.origin : null,
    state: record.state,
  };
}

/** Parse the probe's one answer. Anything outside the fixed shape is refused. */
export function parseResearchLayoutFacts(raw: string): ResearchLayoutFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const strings = ["executable", "prefix", "cwd"] as const;
  for (const key of strings) {
    if (typeof record[key] !== "string" || record[key].length === 0 || record[key].length > 512) return null;
  }
  if (typeof record.safe_path !== "boolean" || typeof record.no_user_site !== "boolean") return null;
  if (!Array.isArray(record.path_head) || record.path_head.length > 8) return null;
  if (!record.path_head.every((entry) => typeof entry === "string" && entry.length <= 512)) return null;
  const modules = {} as Record<string, ResearchLayoutModuleFact>;
  for (const key of ["scienceflow", "prep", "task", "report"] as const) {
    const parsed = moduleFact(record[key]);
    if (parsed === null) return null;
    modules[key] = parsed;
  }
  if (record.project_python !== null && typeof record.project_python !== "string") return null;
  if (record.project_python_error !== undefined && typeof record.project_python_error !== "string") return null;
  return {
    cwd: record.cwd as string,
    executable: record.executable as string,
    noUserSite: record.no_user_site,
    pathHead: record.path_head as readonly string[],
    prefix: record.prefix as string,
    prep: modules.prep!,
    projectPython: record.project_python as string | null,
    projectPythonError: record.project_python_error as string | undefined,
    report: modules.report!,
    safePath: record.safe_path,
    scienceflow: modules.scienceflow!,
    task: modules.task!,
  };
}

export type ResearchLayoutProbeReason =
  | "launch-failed"
  | "probe-timeout"
  | "probe-failed"
  | "protocol-error";

export type ResearchLayoutProbeOutcome =
  | { readonly status: "facts"; readonly facts: ResearchLayoutFacts }
  | { readonly status: "termination-unverified"; readonly handle: ExecutionBoundaryHandle | "unproven" }
  | { readonly status: "unavailable"; readonly reason: ResearchLayoutProbeReason };

export interface ResearchLayoutProbeOptions {
  readonly config: ExecutorConfig;
  /** The lease S just vetted; the same one the run would use. */
  readonly environment: {
    readonly interpreterPath: string;
    readonly prefixPath: string;
  };
  /** The trusted checkout: it must be the run's `engine.sourceRoot`. */
  readonly sourceRoot: string;
  /** Which interpreter flags to launch with; defaults to the run's `-P -B`. */
  readonly interpreterFlags?: readonly string[];
  /** Mask the checkout's `.venv` with an empty tmpfs. */
  readonly maskVirtualEnv?: boolean;
  /** A prepared workspace, e.g. one that already holds a decoy package. */
  readonly workspaceRoot?: string;
  /** Seccomp profile for the probe; the run's own profile by default. */
  readonly seccompVariant?: SeccompVariant;
  /** Test seam: a synthetic `/proc` root for boundary observations. */
  readonly procRoot?: string;
  /**
   * Runner diagnostics only. They never become an outcome, and the caller must
   * not publish them as evidence.
   */
  readonly onDiagnostic?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Run the research-layout probe once, through the ordinary supervised sandbox
 * path with the run's own mounts, environment and child flags.
 *
 * A probe that ran had a process: a failure means research did not start, never
 * that nothing was spawned. A missing termination proof returns the handle so
 * the caller keeps the environment fenced through the existing reservation
 * path instead of releasing it.
 */
export async function runResearchLayoutProbe(
  options: ResearchLayoutProbeOptions,
): Promise<ResearchLayoutProbeOutcome> {
  const { config, environment, sourceRoot } = options;
  const runRoot = resolve(config.dataDir, "research-layout-checks");
  const workspace = options.workspaceRoot
    ?? await mkdtemp(`${runRoot}/probe-`).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(runRoot, { mode: 0o700, recursive: true });
      return await mkdtemp(`${runRoot}/probe-`);
    });
  const owned = options.workspaceRoot === undefined;
  let capture: BoundaryCaptureOutcome | undefined;
  let started = false;

  let launch;
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
      // The child's search path, fixed by the Runner: the mount, never a host
      // directory. `-P` keeps `cwd` out, so the workspace cannot shadow it.
      pythonPathEnv: RESEARCH_ENGINE_MOUNT,
      researchEngine: { mountPath: RESEARCH_ENGINE_MOUNT, maskVirtualEnv: options.maskVirtualEnv, sourceRoot },
      workspaceBindArgs: workspaceBinds.args,
      workspaceRoot: workspace,
    });
  } catch {
    if (owned) await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    return { reason: "launch-failed", status: "unavailable" };
  }

  const commandArguments = [
    sandboxCommandPath(launch, "/opt/science-env/bin/python", environment.interpreterPath),
    ...(options.interpreterFlags ?? ["-P", "-B"]),
    "-",
  ];
  try {
    const run = await runSandboxed(
      config,
      launch,
      commandArguments,
      `${RESEARCH_LAYOUT_PROBE_SOURCE}\n`,
      RESEARCH_LAYOUT_PROBE_TIMEOUT_MS,
      workspace,
      undefined,
      "ScienceFlow research layout check",
      0,
      RESEARCH_LAYOUT_PROBE_MAX_OUTPUT_BYTES,
      options.seccompVariant ?? "baseline",
      undefined,
      (child, sandbox) => {
        started = true;
        capture = captureExecutionBoundaryOutcome(
          `scienceflow-research-layout:${randomUUID()}`,
          {
            kind: sandbox === "bubblewrap" ? "pid-namespace" : "process",
            pid: child.pid ?? 0,
            sandbox,
          },
          options.procRoot,
        );
      },
    );
    const termination = await settled(capture, options.procRoot, started);
    if (termination !== null) return termination;
    if (run.exitCode !== 0) {
      options.onDiagnostic?.("probe-failed", {
        exitCode: run.exitCode,
        stderr: run.stderr.trim().split("\n").at(-1)?.slice(0, 200),
      });
      return { reason: "probe-failed", status: "unavailable" };
    }
    const facts = parseResearchLayoutFacts(run.stdout);
    return facts === null
      ? { reason: "protocol-error", status: "unavailable" }
      : { facts, status: "facts" };
  } catch (error) {
    if (error instanceof ProcessTerminationUnverifiedError) {
      return { handle: capture?.status === "captured" ? capture.handle : "unproven", status: "termination-unverified" };
    }
    const termination = await settled(capture, options.procRoot, started);
    if (termination !== null) return termination;
    const timedOut = error instanceof Error && /timed out|aborted/iu.test(error.message);
    return { reason: timedOut ? "probe-timeout" : "probe-failed", status: "unavailable" };
  } finally {
    const terminationProven = capture !== undefined
      && (capture.status === "ended"
        || (capture.status === "captured" && boundaryTerminationVerified(capture.handle, options.procRoot)));
    if (owned && terminationProven) {
      await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function settled(
  capture: BoundaryCaptureOutcome | undefined,
  procRoot: string | undefined,
  started: boolean,
): Promise<ResearchLayoutProbeOutcome | null> {
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
  return { handle: "unproven", status: "termination-unverified" };
}
