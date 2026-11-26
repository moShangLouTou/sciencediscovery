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
 * - **no startup code may run before it is refused.** The first probe phase
 *   runs with `-I -S -B`, so `.pth` import lines, `sitecustomize`,
 *   `usercustomize`, and bytecode writing are all disabled from interpreter
 *   startup. It reconstructs the normal `sys.path` statically and refuses any
 *   executable or unmodelled startup configuration. Only when that static
 *   answer is clean does a second phase run a normal start (`-I -B`) to confirm
 *   the reconstruction; a mismatch is refused, never explained away.
 * - the probe is a fixed program on stdin, launched through the ordinary
 *   supervised sandbox path with the environment prefix and checkout mounted
 *   read-only;
 * - every answer is a fixed check code and status. Host paths, `sys.path`
 *   entries, Git output, and probe stderr never leave this module.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

import type { EnvironmentRuntime } from "./environment-store.js";
import type { ExecutorConfig } from "./executor.js";
import type { ExecutionBoundaryHandle } from "./execution-boundary.js";
import { createRuntimeProbeService, runRuntimeProbe, type RuntimeProbeContext, type RuntimeProbeEnvironmentStore } from "./runtime-probe.js";
import type {
  ScienceFlowRuntimeBinding,
  ScienceFlowRuntimeBindings,
} from "./scienceflow-runtime-config.js";
import {
  parseScienceFlowRuntimeProbeAnswer,
  SCIENCE_FLOW_RUNTIME_PROBE_MAX_OUTPUT_BYTES,
  SCIENCE_FLOW_RUNTIME_PROBE_SOURCE,
  SCIENCE_FLOW_RUNTIME_PROBE_TIMEOUT_MS,
  type ScienceFlowRuntimeProbeResolution,
  type ScienceFlowRuntimeProbeRuntimeFacts,
  type ScienceFlowRuntimeProbeStaticFacts,
  type ScienceFlowRuntimeProbeTruncation,
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

/** Probe phases: a static inventory first, a normal-start confirmation second. */
type ProbeMode = "static" | "runtime";

/**
 * Why a probe run produced no facts. The public result vocabulary has no code
 * for these; they are Runner diagnostics only, and the check stays `unavailable`
 * rather than pretending a fact was observed.
 */
type ProbeUnavailableReason =
  | "launch-failed"
  | "probe-timeout"
  | "probe-failed"
  | "protocol-error";

/** What one probe run produced, before classification. */
type ProbeRunOutcome =
  | {
      readonly status: "facts";
      readonly facts: ScienceFlowRuntimeProbeStaticFacts | ScienceFlowRuntimeProbeRuntimeFacts;
    }
  | {
      readonly status: "termination-unverified";
      readonly handle: ExecutionBoundaryHandle | "unproven";
    }
  /** The probe could not be run to completion; nothing was established. */
  | { readonly status: "unavailable"; readonly reason: ProbeUnavailableReason };

export interface ScienceFlowRuntimeCheckDeps {
  readonly config: ExecutorConfig;
  /**
   * The real store leases the environment and keeps its mutation gate. The
   * reservation methods are optional so a test double can still lease without
   * a ledger; without them only this process's in-memory fence applies.
   */
  readonly environmentStore: RuntimeProbeEnvironmentStore;
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
  const { bindings } = deps;
  const diagnose = (reason: string, detail?: Record<string, unknown>) => {
    deps.onDiagnostic?.("scienceflow_runtime_check_unavailable", { reason, ...detail });
  };
  const probes = createRuntimeProbeService({ ...deps, onDiagnostic: diagnose });

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
      const outcome = await probes.withEnvironment({ scopeKey: binding.bindingId, environmentId: request.environmentId }, async (probe) => {
        const leased = probe.environment;
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

        // Phase A: no site processing. If it shows any executable startup
        // configuration, the answer is refused here, before a normal start
        // could run that configuration.
        const staticProbe = await runProbe({
          binding,
          probe,
          mode: "static",
        });
        if (staticProbe.status === "termination-unverified") {
          diagnose("termination-unverified");
          return unavailableResult(request);
        }
        if (staticProbe.status === "unavailable") {
          diagnose(staticProbe.reason);
          return unavailableResult(request);
        }
        if (staticProbe.facts.mode !== "static") {
          diagnose("protocol-error", { phase: "static" });
          return unavailableResult(request);
        }
        const facts = staticProbe.facts;

        const assessment = assessStaticProbeFacts({
          environmentPrefix: leased.prefixPath,
          facts,
          languageVersion: leased.revision.languageVersion,
          sourceRoot: binding.sourceRoot,
        });
        if (!assessment.ready) {
          return result(request, {
            environmentRevisionId: leased.revision.id,
            outcome: "blocked",
            overrides: {
              binding_identity: "passed",
              environment_revision: "passed",
              ...assessment.overrides,
            },
            revision: null,
            sourceKind: assessment.sourceKind,
          });
        }

        // The checkout revision is checked on this host only after the static
        // answer proved the origin is exactly the trusted checkout. A wheel or
        // a second copy has no Git history to confirm and is never guessed.
        const revisionCheck = await checkEngineRevision({
          expectedRevision: binding.expectedRevision,
          path: binding.sourceRoot,
          timeoutMs: DEFAULT_REVISION_TIMEOUT_MS,
        });
        const revisionOverrides = revisionStatusOverrides(revisionCheck);
        const revisionSettled = revisionOverrides.source_revision === "passed"
          && revisionOverrides.source_cleanliness === "passed";
        if (!revisionSettled) {
          return result(request, {
            environmentRevisionId: leased.revision.id,
            outcome: "blocked",
            overrides: {
              binding_identity: "passed",
              environment_revision: "passed",
              ...assessment.overrides,
              ...revisionOverrides,
            },
            revision: revisionCheck.revision,
            sourceKind: assessment.sourceKind,
          });
        }

        // Phase B: the static answer was clean, so a normal start cannot run
        // an import line or sitecustomize. It confirms the reconstruction.
        const runtimeProbe = await runProbe({
          binding,
          probe,
          mode: "runtime",
        });
        if (runtimeProbe.status === "termination-unverified") {
          diagnose("termination-unverified");
          return unavailableResult(request);
        }
        if (runtimeProbe.status === "unavailable") {
          diagnose(runtimeProbe.reason);
          return unavailableResult(request);
        }
        if (runtimeProbe.facts.mode !== "runtime") {
          diagnose("protocol-error", { phase: "runtime" });
          return unavailableResult(request);
        }

        const classified = classifyProbeFacts({
          environmentPrefix: leased.prefixPath,
          facts,
          languageVersion: leased.revision.languageVersion,
          revisionCheck,
          runtime: runtimeProbe.facts,
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
      return outcome.status === "result" ? outcome.value : unavailableResult(request);
    },
  };
}

/** Supply the fixed SF program and interpret its protocol; execution is shared. */
async function runProbe(options: {
  binding: ScienceFlowRuntimeBinding;
  probe: Pick<RuntimeProbeContext, "run">;
  mode: ProbeMode;
}): Promise<ProbeRunOutcome> {
  const run = await options.probe.run({
    program: SCIENCE_FLOW_RUNTIME_PROBE_SOURCE,
    interpreterFlags: options.mode === "static" ? ["-I", "-S", "-B"] : ["-I", "-B"],
    readOnlyHostBinds: [options.binding.sourceRoot],
    timeoutMs: SCIENCE_FLOW_RUNTIME_PROBE_TIMEOUT_MS,
    maxOutputBytes: SCIENCE_FLOW_RUNTIME_PROBE_MAX_OUTPUT_BYTES,
  });
  if (run.status !== "output") return run;
  const parsed = options.mode === "static"
    ? parseScienceFlowRuntimeProbeAnswer(run.stdout, "static")
    : parseScienceFlowRuntimeProbeAnswer(run.stdout, "runtime");
  return parsed.status === "ok"
    ? { facts: parsed.facts, status: "facts" }
    : { reason: parsed.status === "failed" ? "probe-failed" : "protocol-error", status: "unavailable" };
}

export interface StaticProbeAssessment {
  readonly overrides: Partial<Record<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>>;
  /** True only when the static facts could lead to `verified`; anything unsafe
   *  or unproven is refused before a normal start is attempted. */
  readonly ready: boolean;
  readonly sourceKind: ScienceFlowRuntimeSourceKind;
}

/**
 * Judge the static inventory without executing any site configuration.
 *
 * Refusal conditions are explicit and bounded:
 *
 * - any truncation flag (the scan did not see everything);
 * - interpreter flags that do not prove `-S`/`-B`/`-I` semantics;
 * - a virtual-environment configuration file (its startup semantics are not
 *   reconstructed here);
 * - any non-directory, relative, missing-absolute, or out-of-root `sys.path`
 *   entry;
 * - a `.pth` import line, an unreadable or oversized `.pth`, an unsupported
 *   encoding, or a line-limit overflow;
 * - `sitecustomize`/`usercustomize` anywhere on the effective path;
 * - any `scienceflow` candidate that is not one regular package directory, or
 *   any additional candidate (module, extension, link, namespace) that would
 *   take part in resolution.
 */
export function assessStaticProbeFacts(input: {
  readonly environmentPrefix: string;
  readonly facts: ScienceFlowRuntimeProbeStaticFacts;
  readonly languageVersion: string;
  readonly sourceRoot: string;
}): StaticProbeAssessment {
  const { environmentPrefix, facts, languageVersion, sourceRoot } = input;
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

  const candidates = facts.resolutions.filter((entry) => entry.scienceflow !== null);
  const regular = candidates.filter((entry) => entry.scienceflow?.kind === "regular");
  if (candidates.length === 0) {
    overrides.package_resolution = "failed";
  } else if (candidates.length > 1 || regular.length > 1) {
    overrides.package_resolution = "failed";
  } else if (candidates[0]?.scienceflow?.kind === "regular") {
    overrides.package_resolution = "passed";
  } else if (candidates[0]?.scienceflow?.kind === "namespace") {
    // Only a namespace portion exists; there is no importable package to bind.
    overrides.package_resolution = "unsupported";
  } else {
    // A single-file module, an extension module, or a linked package would win
    // in Python but is not a source this check can verify.
    overrides.package_resolution = "failed";
  }

  const siteRoots = uniquePaths([...facts.sitePackages, ...prefixRoots]);
  const origin = candidates.length === 1 ? candidates[0]! : null;
  const originIsTrusted = origin !== null
    && origin.scienceflow?.kind === "regular"
    && samePath(origin.entry, sourceRoot);
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

  const truncation = anyTruncation(facts.truncation);
  const flagsProveSafety = facts.python.noSite
    && facts.python.noUserSite
    && facts.python.dontWriteBytecode;
  const unsafeEntry = facts.resolutions.some((entry) =>
    entry.kind === "file" || entry.kind === "link" || entry.kind === "other"
    || entry.kind === "relative");
  const pathOutside = [...facts.basePath, ...facts.effectivePath].some((entry) =>
    entry === "" || !isAbsoluteLine(entry) || !allowedRoots.some((root) => inside(entry, root)));
  const pthIssue = facts.pth.some((file) =>
    file.importLines > 0
    || file.unreadable
    || file.tooLarge
    || file.notRegular
    || file.unsupportedEncoding
    || file.lineLimitExceeded
    || !isAbsoluteLine(file.path)
    || !allowedRoots.some((root) => inside(file.path, root)));
  const hookPresent = facts.hooks.some((hook) => hook.sitecustomize || hook.usercustomize);
  const hookPathOutside = facts.pth.some((file) =>
    file.pathLines.some((line) => !isAbsoluteLine(line) || !allowedRoots.some((root) => inside(line, root))));
  overrides.startup_hooks = truncation || !flagsProveSafety || facts.venvConfig
    || unsafeEntry || pathOutside || pthIssue || hookPresent || hookPathOutside
    ? "failed"
    : "passed";

  if (facts.distributions.length === 0) {
    // Absence of metadata says nothing about where the code came from.
    overrides.duplicate_distribution = "unknown";
  } else {
    overrides.duplicate_distribution = facts.distributions.length === 1 ? "passed" : "failed";
  }

  const ready = overrides.interpreter_identity === "passed"
    && overrides.package_resolution === "passed"
    && overrides.source_root === "passed"
    && overrides.startup_hooks === "passed"
    && (overrides.duplicate_distribution === "passed"
      || overrides.duplicate_distribution === "unknown");
  const sourceKind: ScienceFlowRuntimeSourceKind = originIsTrusted
    ? "git-checkout"
    : originIsInstalled ? "installed-distribution" : "unsupported";
  return { overrides, ready, sourceKind };
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
 * duplicate origin is ambiguous, and only a Git-verified trusted checkout that
 * a normal start also resolves can be `verified`.
 */
export function classifyProbeFacts(input: {
  readonly environmentPrefix: string;
  readonly facts: ScienceFlowRuntimeProbeStaticFacts;
  readonly languageVersion: string;
  readonly revisionCheck: EngineRevisionCheckResult | null;
  readonly runtime: ScienceFlowRuntimeProbeRuntimeFacts | null;
  readonly sourceRoot: string;
}): Classification {
  const { environmentPrefix, facts, languageVersion, revisionCheck, runtime, sourceRoot } = input;
  const assessment = assessStaticProbeFacts({ environmentPrefix, facts, languageVersion, sourceRoot });
  const overrides: Partial<Record<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>> = {
    ...assessment.overrides,
  };

  const revision = revisionCheck?.revision ?? null;
  if (revisionCheck === null) {
    overrides.source_revision = "unsupported";
    overrides.source_cleanliness = "unsupported";
  } else {
    Object.assign(overrides, revisionStatusOverrides(revisionCheck));
  }

  // The normal start must confirm the reconstruction exactly. Anything else
  // means the static model missed an effect on startup; that is refused, never
  // treated as a harmless difference.
  let runtimeConfirmed = false;
  if (runtime !== null) {
    const flagsProveNormalStart = runtime.python.noSite === false
      && runtime.python.noUserSite
      && runtime.python.dontWriteBytecode;
    const sameInterpreter = runtime.python.version === facts.python.version
      && runtime.python.prefix === facts.python.prefix
      && runtime.python.basePrefix === facts.python.basePrefix;
    const samePath = equalStrings(runtime.path, facts.effectivePath);
    const sameResolutions = equalResolutions(runtime.resolutions, facts.resolutions);
    const sameDistributions = equalStrings(runtime.distributions, facts.distributions);
    const startupHookLoaded = runtime.startupHooks.sitecustomize || runtime.startupHooks.usercustomize;
    const complete = !anyTruncation(runtime.truncation) && !anyTruncation(facts.truncation);
    const startupMatches = flagsProveNormalStart && sameInterpreter && complete && !startupHookLoaded;
    if (!startupMatches || !samePath) overrides.startup_hooks = "failed";
    if (!sameResolutions || !sameDistributions) {
      overrides.package_resolution = "failed";
      if (overrides.source_root === "passed") overrides.source_root = "unsupported";
    }
    runtimeConfirmed = startupMatches && samePath && sameResolutions && sameDistributions;
  }

  const sourceKind: ScienceFlowRuntimeSourceKind = assessment.sourceKind === "git-checkout"
    && revisionCheck?.status === "unsupported"
    ? "unsupported"
    : assessment.sourceKind;

  // `unknown` metadata is not evidence against the source binding; every other
  // code must have passed. A single failing code blocks the result.
  const verified = runtimeConfirmed && SCIENCE_FLOW_RUNTIME_CHECK_CODES.every((code) => {
    if (code === "binding_identity" || code === "environment_revision") return true;
    const status = overrides[code] ?? "unknown";
    return status === "passed" || (code === "duplicate_distribution" && status === "unknown");
  });
  return { outcome: verified ? "verified" : "blocked", overrides, revision, sourceKind };
}

function revisionStatusOverrides(
  revisionCheck: EngineRevisionCheckResult,
): Pick<Classification["overrides"], "source_revision" | "source_cleanliness"> {
  if (revisionCheck.status === "verified-clean") {
    return { source_cleanliness: "passed", source_revision: "passed" };
  }
  if (revisionCheck.status === "revision-mismatch") {
    return { source_cleanliness: revisionCheck.dirty ? "failed" : "passed", source_revision: "failed" };
  }
  if (revisionCheck.status === "dirty") {
    return { source_cleanliness: "failed", source_revision: "passed" };
  }
  if (revisionCheck.status === "unsupported") {
    return { source_cleanliness: "unsupported", source_revision: "unsupported" };
  }
  return { source_cleanliness: "unknown", source_revision: "unknown" };
}

/** The fixed answer of one source-binding proof; reasons are diagnostics only. */
export interface ScienceFlowSourceBindingVerdict {
  readonly status: "verified" | "refused" | "unavailable";
  readonly reason?: string;
  /** Present when the probe's own termination could not be proven. */
  readonly boundary?: ExecutionBoundaryHandle | "unproven";
}

/** Bound on the engine's own `pyproject.toml`; only one line is read. */
const ENGINE_PYPROJECT_MAX_BYTES = 256 * 1024;

/**
 * The `requires-python` value declared by the engine's `[project]` table.
 *
 * The file is the pinned checkout's own declaration, not a Runner constant: a
 * revision that changes its supported range changes this answer. Only a single
 * plain `requires-python = "..."` line inside `[project]` is understood;
 * anything else is `null`, which the caller refuses rather than guesses.
 */
export function readRequiresPython(text: string): string | null {
  let inProject = false;
  let found = 0;
  let value: string | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inProject = line === "[project]";
      continue;
    }
    if (!inProject) continue;
    const match = /^requires-python\s*=\s*(["'])([^"'\n]{1,128})\1$/u.exec(line);
    if (match === null) continue;
    found += 1;
    value = match[2] ?? null;
  }
  return found === 1 ? value : null;
}

type VersionTuple = readonly [number, number, number];

function parseVersionTuple(text: string): VersionTuple | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left: VersionTuple, right: VersionTuple): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Whether an observed interpreter version satisfies the supported range subset.
 *
 * Only ordered comparisons (`>=`, `>`, `<=`, `<`) are evaluated. Other
 * specifiers return `null`, so the caller refuses instead of guessing at
 * unsupported matching rules.
 */
export function pythonRequirementAllows(requirement: string, version: string): boolean | null {
  const observed = parseVersionTuple(version);
  if (observed === null) return null;
  const clauses = requirement
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return null;
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<)\s*(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(clause);
    if (match === null) return null;
    const operator = match[1]!;
    const numbers: VersionTuple = [
      Number(match[2]),
      Number(match[3]),
      match[4] === undefined ? 0 : Number(match[4]),
    ];
    const order = compareVersions(observed, numbers);
    let satisfied: boolean;
    if (operator === ">=") satisfied = order >= 0;
    else if (operator === ">") satisfied = order > 0;
    else if (operator === "<=") satisfied = order <= 0;
    else satisfied = order < 0;
    if (!satisfied) return false;
  }
  return true;
}

/** Read the pinned checkout's own Python requirement, bounded and unfollowed. */
async function enginePythonRequirement(sourceRoot: string): Promise<string | null> {
  const path = resolve(sourceRoot, "pyproject.toml");
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > ENGINE_PYPROJECT_MAX_BYTES) return null;
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? null : readRequiresPython(text);
}

/**
 * Prove, inside the lease that will run the research workload, that this
 * environment's interpreter resolves `scienceflow` from the pinned checkout.
 *
 * This is the R11 static half reused as it is: the same fixed probe launched
 * through the same supervised sandbox path, the same `assessStaticProbeFacts`
 * judgement, and the same Git revision check. The second, normal-start phase is
 * deliberately not repeated: the research launch itself is that normal start,
 * and its own record is judged separately, so a run cannot be authorized by a
 * probe it then contradicts.
 *
 * Nothing here is a cached or historical answer: the probe runs under this
 * environment lease, against this checkout, immediately before the spawn.
 */
export async function verifyScienceFlowSourceBinding(options: {
  readonly binding: ScienceFlowRuntimeBinding;
  readonly config: ExecutorConfig;
  readonly environment: EnvironmentRuntime;
  readonly procRoot?: string;
}): Promise<ScienceFlowSourceBindingVerdict> {
  const { binding, config, environment } = options;
  if (environment.revision.language !== "python") {
    return { reason: "environment-language", status: "refused" };
  }
  const probe = await runProbe({
    binding,
    probe: { run: program => runRuntimeProbe({ ...program, config, environment, procRoot: options.procRoot }) },
    mode: "static",
  });
  if (probe.status === "termination-unverified") {
    return { boundary: probe.handle, reason: "termination-unverified", status: "unavailable" };
  }
  if (probe.status === "unavailable") return { reason: probe.reason, status: "unavailable" };
  if (probe.facts.mode !== "static") return { reason: "protocol-error", status: "unavailable" };
  const assessment = assessStaticProbeFacts({
    environmentPrefix: environment.prefixPath,
    facts: probe.facts,
    languageVersion: environment.revision.languageVersion,
    sourceRoot: binding.sourceRoot,
  });
  if (!assessment.ready) return { reason: "static-binding", status: "refused" };
  let revision: EngineRevisionCheckResult;
  try {
    revision = await checkEngineRevision({
      expectedRevision: binding.expectedRevision,
      path: binding.sourceRoot,
      timeoutMs: DEFAULT_REVISION_TIMEOUT_MS,
    });
  } catch {
    return { reason: "revision-unavailable", status: "unavailable" };
  }
  const overrides = revisionStatusOverrides(revision);
  if (overrides.source_revision !== "passed" || overrides.source_cleanliness !== "passed") {
    return { reason: "revision", status: "refused" };
  }
  // The checkout's own Python contract is part of the engine, not a Runner
  // preference. Comparing the environment's declared version with the
  // interpreter's observed version only proves the two agree; it says nothing
  // about whether the engine supports either. The range is read from the pinned
  // checkout at the revision just verified, and checked against this lease's
  // real interpreter before any research process may start.
  const requirement = await enginePythonRequirement(binding.sourceRoot);
  if (requirement === null) return { reason: "python-requirement-missing", status: "refused" };
  if (pythonRequirementAllows(requirement, probe.facts.python.version) !== true) {
    return { reason: "python-requirement", status: "refused" };
  }
  return { status: "verified" };
}

function anyTruncation(truncation: ScienceFlowRuntimeProbeTruncation): boolean {
  return truncation.path || truncation.site || truncation.pth || truncation.lines
    || truncation.names || truncation.text || truncation.distributions || truncation.budget;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalResolutions(
  left: readonly ScienceFlowRuntimeProbeResolution[],
  right: readonly ScienceFlowRuntimeProbeResolution[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index]!;
    return value.entry === other.entry
      && value.kind === other.kind
      && value.symlinked === other.symlinked
      && value.scienceflow?.kind === other.scienceflow?.kind;
  });
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
