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
 * Presentation rules for a runtime identity check.
 *
 * The Runner reports code/status pairs; the API supplies the prose. Stored rows
 * keep only code and status, so every read rebuilds these descriptions instead
 * of trusting stored text. Nothing here reads probe output.
 */
import {
  SCIENCE_FLOW_RUNTIME_CHECK_CODES,
  SCIENCE_FLOW_RUNTIME_SOURCE_KINDS,
  SCIENCE_FLOW_PLAN_CHECK_STATUSES,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowRuntimeCheckCode,
  type ScienceFlowRuntimeCheckDtoCheck,
  type ScienceFlowRuntimeSourceKind,
  type ScienceFlowRuntimeUnknownsDto,
} from "@sciencediscovery/schema";

/**
 * What a source binding does not establish. Fixed, never configured: the check
 * answers one question and says plainly which ones it did not answer.
 */
export const SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS: ScienceFlowRuntimeUnknownsDto =
  Object.freeze({
    dependencyClosure: "incomplete" as const,
    executionStart: "not-checked" as const,
    modelGateway: "unknown" as const,
    evaluator: "not-checked" as const,
    gpu: "not-checked" as const,
  });

/** Neutral condition descriptions; a `failed` status means it did not hold. */
const RUNTIME_CHECK_DESCRIPTIONS = {
  binding_identity:
    "The declared revision matches the Runner-side binding.",
  environment_revision:
    "The selected environment revision matches the configured revision.",
  interpreter_identity:
    "The environment interpreter belongs to the selected environment.",
  package_resolution: "Exactly one regular ScienceFlow package is resolved.",
  source_root: "The resolved package origin is the trusted checkout.",
  source_revision: "The checkout HEAD equals the declared revision.",
  source_cleanliness:
    "The checkout has no tracked or runnable untracked changes.",
  startup_hooks:
    "No startup hook, editable finder, or outside path influences resolution.",
  duplicate_distribution:
    "At most one ScienceFlow distribution is installed.",
} satisfies Record<ScienceFlowRuntimeCheckCode, string>;

/** Status-specific notes for the conditions whose wording really changes. */
const RUNTIME_CHECK_STATUS_DESCRIPTIONS: Partial<
  Record<
    ScienceFlowRuntimeCheckCode,
    Partial<Record<ScienceFlowPlanCheckStatus, string>>
  >
> = {
  binding_identity: {
    failed: "The declared revision differs from the Runner-side binding.",
  },
  environment_revision: {
    failed: "The selected environment revision is not the configured revision.",
  },
  interpreter_identity: {
    failed:
      "The environment interpreter does not belong to the selected environment.",
  },
  package_resolution: {
    failed:
      "The package origin is missing, duplicated, or not a regular package.",
    unsupported: "Only a namespace portion named scienceflow exists.",
  },
  source_root: {
    failed: "The package origin is outside the trusted checkout and environment.",
    unsupported:
      "The package origin is an installed distribution or has no trusted path line.",
  },
  source_revision: {
    failed: "The checkout HEAD differs from the declared revision.",
    unsupported: "The Git checkout check does not apply to this source.",
    unknown: "The Git checkout check could not read a revision.",
  },
  source_cleanliness: {
    failed: "The checkout has tracked or runnable untracked changes.",
    unsupported: "The Git checkout check does not apply to this source.",
    unknown: "The Git checkout check could not inspect the worktree.",
  },
  startup_hooks: {
    failed:
      "A startup hook, editable finder, or outside path influences resolution.",
  },
  duplicate_distribution: {
    unknown: "No ScienceFlow distribution metadata was found.",
  },
};

/** True only for a source kind the schema defines. */
export function isScienceFlowRuntimeSourceKind(
  value: unknown,
): value is ScienceFlowRuntimeSourceKind {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_RUNTIME_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** The fixed description for one check; stored rows rebuild it on read. */
export function describeScienceFlowRuntimeCheck(
  code: ScienceFlowRuntimeCheckCode,
  status: ScienceFlowPlanCheckStatus,
): string {
  return (
    RUNTIME_CHECK_STATUS_DESCRIPTIONS[code]?.[status] ??
    RUNTIME_CHECK_DESCRIPTIONS[code]
  );
}

/**
 * The persisted-verified rule, identical to the Runner's classification: every
 * code passed, except `duplicate_distribution`, whose absence of metadata is
 * unknown rather than evidence against the source binding.
 */
export function isVerifiedRuntimeCheck(
  checks: readonly {
    readonly code: ScienceFlowRuntimeCheckCode;
    readonly status: ScienceFlowPlanCheckStatus;
  }[],
): boolean {
  return SCIENCE_FLOW_RUNTIME_CHECK_CODES.every((code) => {
    const status = checks.find((check) => check.code === code)?.status;
    return (
      status === "passed" ||
      (code === "duplicate_distribution" && status === "unknown")
    );
  });
}

/**
 * Validate an untrusted code/status list and return it in canonical order.
 *
 * Returns null unless every fixed code appears exactly once. A short list, a
 * repeated code, or an unknown code is a protocol difference, not a fact set,
 * so the caller reports it as unavailable rather than guessing the remainder.
 */
export function canonicalRuntimeChecks(
  value: unknown,
): readonly {
  readonly code: ScienceFlowRuntimeCheckCode;
  readonly status: ScienceFlowPlanCheckStatus;
}[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== SCIENCE_FLOW_RUNTIME_CHECK_CODES.length
  ) {
    return null;
  }
  const byCode = new Map<ScienceFlowRuntimeCheckCode, ScienceFlowPlanCheckStatus>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const code = record.code;
    const status = record.status;
    if (
      typeof code !== "string" ||
      !(SCIENCE_FLOW_RUNTIME_CHECK_CODES as readonly string[]).includes(code) ||
      typeof status !== "string" ||
      !(SCIENCE_FLOW_PLAN_CHECK_STATUSES as readonly string[]).includes(
        status,
      ) ||
      byCode.has(code as ScienceFlowRuntimeCheckCode)
    ) {
      return null;
    }
    byCode.set(
      code as ScienceFlowRuntimeCheckCode,
      status as ScienceFlowPlanCheckStatus,
    );
  }
  return Object.freeze(
    SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) =>
      Object.freeze({ code, status: byCode.get(code) as ScienceFlowPlanCheckStatus }),
    ),
  );
}

/** DTO checks in canonical order, with the fixed description rebuilt. */
export function runtimeCheckChecksDto(
  checks: readonly {
    readonly code: ScienceFlowRuntimeCheckCode;
    readonly status: ScienceFlowPlanCheckStatus;
  }[],
): readonly ScienceFlowRuntimeCheckDtoCheck[] {
  const byCode = new Map(
    checks.map((check) => [check.code, check.status] as const),
  );
  return Object.freeze(
    SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => {
      // Canonical input carries every code; `unknown` only keeps the type total.
      const status = byCode.get(code) ?? "unknown";
      return Object.freeze({
        code,
        status,
        description: describeScienceFlowRuntimeCheck(code, status),
      });
    }),
  );
}
