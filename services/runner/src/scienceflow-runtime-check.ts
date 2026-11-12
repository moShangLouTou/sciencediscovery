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
 * The Runner-side ScienceFlow runtime identity check.
 *
 * It answers one question for one selected environment: which ScienceFlow
 * package source would the environment's interpreter resolve, and is that the
 * administrator-declared checkout at the declared revision? It does not start
 * ScienceFlow, import it, install anything, or touch the environment.
 *
 * Trust boundaries:
 *
 * - the request names a binding id and two environment identities. It cannot
 *   carry a path, an interpreter, a command, or an environment variable;
 * - `sourceRoot` exists only in the Runner's own trusted configuration, and a
 *   request revision that differs from that binding is refused before a process
 *   starts;
 * - the probe is a fixed program on stdin, launched through the ordinary
 *   supervised sandbox path with the environment prefix and checkout mounted
 *   read-only;
 * - every answer is a fixed check code and status. Host paths, `sys.path`
 *   entries, Git output, and probe stderr never leave this module.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ScienceFlowPlanCheckStatus,
  ScienceFlowRuntimeCheckCode,
  ScienceFlowRuntimeProbeRequest,
  ScienceFlowRuntimeProbeResult,
  ScienceFlowRuntimeSourceKind,
} from "@sciencediscovery/schema";
import {
  SCIENCE_FLOW_RUNTIME_CHECK_CODES,
  SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
} from "@sciencediscovery/schema";
import {
  checkEngineRevision,
  DEFAULT_REVISION_TIMEOUT_MS,
  type EngineRevisionCheckResult,
} from "@sciencediscovery/scienceflow-reader";

import type { EnvironmentStore, EnvironmentRuntime } from "./environment-store.js";
import {
  boundaryTerminationVerified,
  captureExecutionBoundaryOutcome,
  type BoundaryCaptureOutcome,
  type ExecutionBoundaryHandle,
} from "./execution-boundary.js";
import {
  environmentPrefixBindArguments,
  executorSandboxKind,
  hostInterpreterMaskArguments,
  prepareSandboxLaunch,
  ProcessTerminationUnverifiedError,
  resolveHostRuntimeSupport,
  runSandboxed,
  sandboxCommandPath,
  workspaceBindArguments,
  type ExecutorConfig,
  type SandboxLaunch,
} from "./executor.js";
import type {
  ScienceFlowRuntimeBinding,
  ScienceFlowRuntimeBindings,
} from "./scienceflow-runtime-config.js";
import {
  parseScienceFlowRuntimeProbeAnswer,
  SCIENCE_FLOW_RUNTIME_PROBE_MAX_OUTPUT_BYTES,
  SCIENCE_FLOW_RUNTIME_PROBE_SOURCE,
  SCIENCE_FLOW_RUNTIME_PROBE_TIMEOUT_MS,
  type ScienceFlowRuntimeProbeFacts,
} from "./scienceflow-runtime-probe.js";

/** The request names a binding this Runner was not configured with. */
export class ScienceFlowRuntimeBindingUnknownError extends Error {
  readonly code = "SCIENCEFLOW_RUNTIME_BINDING_UNKNOWN";

  constructor() {
    super("The ScienceFlow runtime binding is not configured on this Runner");
  }
}

/**
 * Validate one probe request. Strict on purpose: a caller that sends an extra
 * field is asking for an override this contract does not have.
 */
export function parseScienceFlowRuntimeProbeRequest(
  value: unknown,
): ScienceFlowRuntimeProbeRequest | null {
  if (!isRecord(value)) return null;
  const allowed = [
    "schemaVersion",
    "requestId",
    "bindingId",
    "environmentId",
    "expectedEnvironmentRevisionId",
    "expectedRevision",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (value.schemaVersion !== SCIENCE_FLOW_RUNTIME_PROBE_VERSION) return null;
  const fields = [
    "requestId",
    "bindingId",
    "environmentId",
    "expectedEnvironmentRevisionId",
  ] as const;
  for (const field of fields) {
    const entry = value[field];
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 160) {
      return null;
    }
    if (entry.includes("\0")) return null;
  }
  const expectedRevision = value.expectedRevision;
  if (typeof expectedRevision !== "string" || !/^[0-9a-f]{40}$/.test(expectedRevision)) {
    return null;
  }
  return {
    bindingId: value.bindingId as string,
    environmentId: value.environmentId as string,
    expectedEnvironmentRevisionId: value.expectedEnvironmentRevisionId as string,
    expectedRevision,
    requestId: value.requestId as string,
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
  };
}

/** What one probe run produced, before classification. */
type ProbeRunOutcome =
  | { readonly status: "facts"; readonly facts: ScienceFlowRuntimeProbeFacts }
  | {
      readonly status: "termination-unverified";
      readonly handle: ExecutionBoundaryHandle | "unproven";
    }
  /** The probe could not be run to completion; nothing was established. */
  | { readonly status: "unavailable" };

export interface ScienceFlowRuntimeCheckDeps {
  readonly config: ExecutorConfig;
  readonly environmentStore: Pick<EnvironmentStore, "withRuntime">;
  readonly bindings?: ScienceFlowRuntimeBindings;
  /** Test seam: a synthetic `/proc` root for boundary observations. */
  readonly procRoot?: string;
  readonly onDiagnostic?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ScienceFlowRuntimeCheckService {
  hasBinding(bindingId: string): boolean;
  check(request: ScienceFlowRuntimeProbeRequest): Promise<ScienceFlowRuntimeProbeResult>;
}

export function createScienceFlowRuntimeCheckService(
  deps: ScienceFlowRuntimeCheckDeps,
): ScienceFlowRuntimeCheckService {
  const { config, environmentStore, bindings } = deps;
  // One probe per binding at a time: two concurrent probes would both observe
  // the same environment and the slower answer would be no more true.
  const inFlight = new Set<string>();
  // An environment whose probe could not be proven to have stopped stays
  // refused until the kernel proves its boundary empty (or the Runner restarts).
  const unverified = new Map<string, ExecutionBoundaryHandle | "unproven">();

  return {
    hasBinding: (bindingId) => bindings?.bindingFor(bindingId) !== undefined,
    async check(request) {
      const binding = bindings?.bindingFor(request.bindingId);
      if (!binding) throw new ScienceFlowRuntimeBindingUnknownError();

      // The Runner's own binding is the only authority on the expected
      // revision. A mismatch is a refusal, not a check result to interpret.
      if (request.expectedRevision !== binding.expectedRevision) {
        return result(request, {
          environmentRevisionId: null,
          outcome: "blocked",
          overrides: { binding_identity: "failed" },
          revision: null,
          sourceKind: "unsupported",
        });
      }
      if (executorSandboxKind(config) !== "bubblewrap") {
        deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "sandbox-unsupported" });
        return unavailableResult(request);
      }
      if (inFlight.has(binding.bindingId)) {
        deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "concurrent-check" });
        return unavailableResult(request);
      }
      const leftover = unverified.get(request.environmentId);
      if (leftover !== undefined) {
        const gone = leftover !== "unproven"
          && boundaryTerminationVerified(leftover, deps.procRoot);
        if (!gone) {
          deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "termination-unverified" });
          return unavailableResult(request);
        }
        unverified.delete(request.environmentId);
      }

      inFlight.add(binding.bindingId);
      try {
        return await environmentStore.withRuntime(request.environmentId, async (leased) => {
          if (
            leased.revision.id !== request.expectedEnvironmentRevisionId ||
            leased.revision.language !== "python"
          ) {
            return result(request, {
              environmentRevisionId: null,
              outcome: "blocked",
              overrides: { environment_revision: "failed" },
              revision: null,
              sourceKind: "unsupported",
            });
          }
          const probe = await runProbe({
            binding,
            config,
            environment: leased,
            procRoot: deps.procRoot,
          });
          if (probe.status === "termination-unverified") {
            unverified.set(request.environmentId, probe.handle);
            deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "termination-unverified" });
            return unavailableResult(request);
          }
          if (probe.status === "unavailable") {
            deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "probe-failed" });
            return unavailableResult(request);
          }

          // Facts are in hand. The checkout revision is checked on this host,
          // only when the resolved origin is the trusted checkout; a wheel or a
          // second copy has no Git history to confirm and is never guessed.
          const origin = probe.facts.packages.length === 1 && probe.facts.packages[0]?.regular
            ? probe.facts.packages[0].entry
            : null;
          const isTrustedOrigin = origin !== null && samePath(origin, binding.sourceRoot);
          const revisionCheck = isTrustedOrigin
            ? await checkEngineRevision({
                expectedRevision: binding.expectedRevision,
                path: binding.sourceRoot,
                timeoutMs: DEFAULT_REVISION_TIMEOUT_MS,
              })
            : null;

          const classified = classifyProbeFacts({
            environmentPrefix: leased.prefixPath,
            facts: probe.facts,
            languageVersion: leased.revision.languageVersion,
            revisionCheck,
            sourceRoot: binding.sourceRoot,
          });
          return result(request, {
            environmentRevisionId: leased.revision.id,
            outcome: classified.outcome,
            overrides: {
              // Both bindings were compared before the probe started and the
              // lease matched the configured revision; the result states that
              // rather than leaving the codes unaccounted for.
              binding_identity: "passed",
              environment_revision: "passed",
              ...classified.overrides,
            },
            revision: classified.revision,
            sourceKind: classified.sourceKind,
          });
        });
      } catch (error) {
        if (error instanceof ScienceFlowRuntimeBindingUnknownError) throw error;
        deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason: "scientific-env-unavailable" });
        return unavailableResult(request);
      } finally {
        inFlight.delete(binding.bindingId);
      }
    },
  };
}

/** Run the fixed probe through the ordinary supervised sandbox path. */
async function runProbe(options: {
  binding: ScienceFlowRuntimeBinding;
  config: ExecutorConfig;
  environment: EnvironmentRuntime;
  procRoot?: string;
}): Promise<ProbeRunOutcome> {
  const { binding, config, environment } = options;
  const runRoot = resolve(config.dataDir, "runtime-checks");
  await mkdir(runRoot, { mode: 0o700, recursive: true });
  // The only writable path of the run. It holds no project data and is removed
  // once the sandbox is proven gone.
  const workspace = await mkdtemp(resolve(runRoot, "probe-"));
  let capture: BoundaryCaptureOutcome | undefined;

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
      // Exactly one extra read-only bind: the trusted checkout, at its own host
      // path, so `sys.path` resolution inside the sandbox is the same one a
      // future execution would get. Internal option; never a request field.
      readOnlyHostBinds: [binding.sourceRoot],
      workspaceBindArgs: workspaceBinds.args,
      workspaceRoot: workspace,
    });
  } catch {
    await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    return { status: "unavailable" };
  }

  const commandArguments = [
    sandboxCommandPath(launch, "/opt/science-env/bin/python", environment.interpreterPath),
    "-I",
    "-",
  ];
  try {
    const run = await runSandboxed(
      config,
      launch,
      commandArguments,
      `${SCIENCE_FLOW_RUNTIME_PROBE_SOURCE}\n`,
      SCIENCE_FLOW_RUNTIME_PROBE_TIMEOUT_MS,
      workspace,
      undefined,
      "ScienceFlow runtime check",
      0,
      SCIENCE_FLOW_RUNTIME_PROBE_MAX_OUTPUT_BYTES,
      "baseline",
      undefined,
      // Captured synchronously inside the spawn turn: the only moment the pid
      // provably still names the sandbox this check created.
      (child, sandbox) => {
        capture = captureExecutionBoundaryOutcome(
          `scienceflow-runtime-check:${randomUUID()}`,
          {
            kind: sandbox === "bubblewrap" ? "pid-namespace" : "process",
            pid: child.pid ?? 0,
            sandbox,
          },
          options.procRoot,
        );
      },
    );

    // The probe is read-only and the checkout is mounted read-only; a missing
    // proof of termination still ends the check as unavailable rather than
    // claiming a supervised run.
    const termination = await settled(capture, options.procRoot);
    if (termination !== null) return termination;
    if (run.exitCode !== 0) return { status: "unavailable" };
    const parsed = parseScienceFlowRuntimeProbeAnswer(run.stdout);
    return parsed.status === "ok" ? { facts: parsed.facts, status: "facts" } : { status: "unavailable" };
  } catch (error) {
    if (error instanceof ProcessTerminationUnverifiedError) {
      return { handle: "unproven", status: "termination-unverified" };
    }
    // A timeout is still a supervised kill; whether it was proven is exactly
    // what the captured boundary answers.
    if (capture !== undefined) {
      const termination = await settled(capture, options.procRoot);
      if (termination !== null) return termination;
    }
    return { status: "unavailable" };
  } finally {
    // Only remove the workspace when the monitor is known to have joined; a
    // failed termination keeps the directory so nothing deletes a live writer's
    // files underneath it.
    const terminationProven = capture !== undefined
      && (capture.status === "ended"
        || (capture.status === "captured" && boundaryTerminationVerified(capture.handle, options.procRoot)));
    if (terminationProven) {
      await rm(workspace, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

/**
 * Decide whether the sandbox that ran the probe provably ended.
 *
 * Returns null when it did; otherwise a result that stands in for the probe's
 * facts, with the handle kept for a later observation.
 */
async function settled(
  capture: BoundaryCaptureOutcome | undefined,
  procRoot: string | undefined,
): Promise<ProbeRunOutcome | null> {
  if (capture === undefined) return { handle: "unproven", status: "termination-unverified" };
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

interface Classification {
  readonly outcome: "verified" | "blocked";
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
  readonly revision: string | null;
  readonly overrides: Partial<Record<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>>;
}

/**
 * Turn observed facts into the fixed check vocabulary.
 *
 * Every judgment here is a rule about the facts, never a guess about intent:
 * a startup import is refused rather than executed, an unresolvable or
 * duplicate origin is ambiguous, and only a Git-verified trusted checkout can
 * be `verified`.
 */
export function classifyProbeFacts(input: {
  readonly environmentPrefix: string;
  readonly facts: ScienceFlowRuntimeProbeFacts;
  readonly languageVersion: string;
  readonly revisionCheck: EngineRevisionCheckResult | null;
  readonly sourceRoot: string;
}): Classification {
  const { environmentPrefix, facts, languageVersion, revisionCheck, sourceRoot } = input;
  const prefixRoots = uniquePaths(["/opt/science-env", environmentPrefix]);
  const allowedRoots = uniquePaths([...prefixRoots, sourceRoot]);
  const overrides: Partial<Record<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>> = {};

  const expectedVersion = /^(\d+)\.(\d+)/.exec(languageVersion);
  const observedVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(facts.python.version);
  const sameVersion = expectedVersion !== null && observedVersion !== null
    && expectedVersion[1] === observedVersion[1]
    && expectedVersion[2] === observedVersion[2];
  const prefixBelongs = prefixRoots.includes(normalized(facts.python.prefix))
    && prefixRoots.includes(normalized(facts.python.basePrefix));
  overrides.interpreter_identity = sameVersion && prefixBelongs ? "passed" : "failed";

  // Resolution is decided by sys.path order, exactly as Python would decide it.
  const packages = facts.packages;
  const regular = packages.filter((entry) => entry.regular);
  if (packages.length === 0) {
    overrides.package_resolution = "failed";
  } else if (packages.length === 1 && regular.length === 1) {
    overrides.package_resolution = "passed";
  } else if (regular.length > 1 || packages.length > 1) {
    overrides.package_resolution = "failed";
  } else {
    // Only a namespace portion exists; there is no importable package to bind.
    overrides.package_resolution = "unsupported";
  }

  const siteRoots = uniquePaths([...facts.sitePackages, ...prefixRoots]);
  const origin = packages.length === 1 ? packages[0]! : null;
  const originIsTrusted = origin !== null && origin.regular && samePath(origin.entry, sourceRoot);
  const originIsInstalled = origin !== null && siteRoots.some((root) => inside(origin.entry, root));
  const pathLineNamesSource = facts.pth.some((file) =>
    file.pathLines.some((line) => samePath(line, sourceRoot)));

  if (originIsTrusted) {
    // The supported mapping is a plain path line in a `.pth`, which is what
    // makes `sys.path` contain the checkout. Anything else is unproven.
    overrides.source_root = pathLineNamesSource ? "passed" : "unsupported";
  } else if (originIsInstalled || origin === null) {
    overrides.source_root = "unsupported";
  } else {
    overrides.source_root = "failed";
  }

  const hookExecutes = facts.startupHooks.sitecustomize || facts.startupHooks.usercustomize
    || facts.pth.some((file) => file.unreadable || file.importLines > 0);
  const hookPathOutside = facts.pth.some((file) =>
    file.pathLines.some((line) => !isAbsoluteLine(line) || !allowedRoots.some((root) => inside(line, root))));
  const sysPathOutside = facts.path.some((entry) =>
    entry === "" || !isAbsoluteLine(entry) || !allowedRoots.some((root) => inside(entry, root)));
  overrides.startup_hooks = hookExecutes || hookPathOutside || sysPathOutside ? "failed" : "passed";

  if (facts.distributions.length === 0) {
    // Absence of metadata says nothing about where the code came from.
    overrides.duplicate_distribution = "unknown";
  } else {
    overrides.duplicate_distribution = facts.distributions.length === 1 ? "passed" : "failed";
  }

  const revision = revisionCheck?.revision ?? null;
  if (revisionCheck === null) {
    overrides.source_revision = "unsupported";
    overrides.source_cleanliness = "unsupported";
  } else if (revisionCheck.status === "verified-clean") {
    overrides.source_revision = "passed";
    overrides.source_cleanliness = "passed";
  } else if (revisionCheck.status === "revision-mismatch") {
    overrides.source_revision = "failed";
    overrides.source_cleanliness = revisionCheck.dirty ? "failed" : "passed";
  } else if (revisionCheck.status === "dirty") {
    overrides.source_revision = "passed";
    overrides.source_cleanliness = "failed";
  } else if (revisionCheck.status === "unsupported") {
    overrides.source_revision = "unsupported";
    overrides.source_cleanliness = "unsupported";
  } else {
    overrides.source_revision = "unknown";
    overrides.source_cleanliness = "unknown";
  }

  const sourceKind: ScienceFlowRuntimeSourceKind = originIsTrusted
    ? (revisionCheck?.status === "unsupported" ? "unsupported" : "git-checkout")
    : originIsInstalled ? "installed-distribution" : "unsupported";

  // `unknown` metadata is not evidence against the source binding; every other
  // code must have passed. A single failing code blocks the result.
  const verified = SCIENCE_FLOW_RUNTIME_CHECK_CODES.every((code) => {
    if (code === "binding_identity" || code === "environment_revision") return true;
    const status = overrides[code] ?? "unknown";
    return status === "passed" || (code === "duplicate_distribution" && status === "unknown");
  });
  return { outcome: verified ? "verified" : "blocked", overrides, revision, sourceKind };
}

function result(
  request: ScienceFlowRuntimeProbeRequest,
  input: {
    environmentRevisionId: string | null;
    outcome: "verified" | "blocked";
    sourceKind: ScienceFlowRuntimeSourceKind;
    revision: string | null;
    overrides: Partial<Record<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>>;
  },
): ScienceFlowRuntimeProbeResult {
  return {
    bindingId: request.bindingId,
    checkedAt: new Date().toISOString(),
    checks: SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({
      code,
      status: input.overrides[code] ?? "unknown",
    })),
    environmentId: request.environmentId,
    environmentRevisionId: input.environmentRevisionId,
    outcome: input.outcome,
    requestId: request.requestId,
    revision: input.revision,
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
    sourceKind: input.sourceKind,
  };
}

/** No fact was observed; the API reports this as unavailable, never blocked. */
function unavailableResult(
  request: ScienceFlowRuntimeProbeRequest,
): ScienceFlowRuntimeProbeResult {
  return {
    bindingId: request.bindingId,
    checkedAt: new Date().toISOString(),
    checks: SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({ code, status: "unknown" })),
    environmentId: request.environmentId,
    environmentRevisionId: null,
    outcome: "unavailable",
    requestId: request.requestId,
    revision: null,
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
    sourceKind: "unsupported",
  };
}

function normalized(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function inside(path: string, root: string): boolean {
  const target = normalized(path);
  const base = normalized(root);
  return target === base || target.startsWith(`${base}/`);
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(normalized))];
}

function isAbsoluteLine(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
