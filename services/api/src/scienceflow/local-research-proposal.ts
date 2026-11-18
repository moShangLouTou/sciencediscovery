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
 * The structured experiment proposal one research round records.
 *
 * The proposal is the thin, checkable seam between "the Agent decided to run
 * again" and "the engine received a launch". It records the research question,
 * the evidence actually read, the concrete method change, the starting
 * candidate, the expected observation, the fixed evaluation method, the stop
 * condition and a sub-budget. Validation rejects a round that only rewords the
 * previous one or repeats the same method on the same candidate; a deliberate
 * repeat must declare its randomness and purpose.
 *
 * This module is pure: resolving the evidence references against the Session's
 * artifacts and operations belongs to the service. The record it returns is
 * path-free and safe to show to the Agent.
 *
 * The no-progress check is deliberately syntactic. It refuses the same
 * normalized method text on the same candidate with no new evidence reference;
 * it does not claim to detect a semantic paraphrase that leaves the experiment
 * unchanged. A declared randomized repeat is the explicit escape hatch.
 */
import { createHash } from "node:crypto";

export const EXPERIMENT_PROPOSAL_VERSION = 1;
export const EXPERIMENT_PROPOSAL_LIMITS = Object.freeze({
  evidenceItems: 16,
  factCharacters: 1_000,
  questionCharacters: 2_000,
  methodChangeCharacters: 2_000,
  expectedObservationCharacters: 2_000,
  evaluationMethodCharacters: 1_000,
  stopConditionCharacters: 1_000,
  repeatCharacters: 500,
  maxRepetitions: 10,
});

export interface ExperimentEvidenceInput {
  readonly kind: "artifact-version" | "operation-result";
  /** Required for `artifact-version`. */
  readonly versionId?: string;
  /** Required for `operation-result`. */
  readonly operationId?: string;
  /** What fact this reference establishes for the round. */
  readonly fact: string;
}

export interface ExperimentRepeatInput {
  readonly kind: "randomized-repeat";
  readonly purpose: string;
  readonly randomness: string;
  readonly repetitions: number;
}

export interface ExperimentProposalInput {
  readonly researchQuestion: string;
  readonly evidence: readonly ExperimentEvidenceInput[];
  readonly methodChange: string;
  readonly expectedObservation: string;
  readonly evaluationMethod: string;
  readonly stopCondition: string;
  readonly subBudgetSeconds?: number;
  readonly repeat?: ExperimentRepeatInput;
}

export interface ExperimentEvidenceRecord {
  readonly kind: "artifact-version" | "operation-result";
  readonly versionId?: string;
  readonly operationId?: string;
  /** Content digest for an artifact version, when the service resolved it. */
  readonly sha256?: string;
  readonly fact: string;
}

export interface ExperimentProposal {
  readonly schemaVersion: typeof EXPERIMENT_PROPOSAL_VERSION;
  readonly researchQuestion: string;
  readonly evidence: readonly ExperimentEvidenceRecord[];
  readonly methodChange: string;
  readonly normalizedMethodChange: string;
  readonly expectedObservation: string;
  readonly evaluationMethod: string;
  readonly stopCondition: string;
  readonly subBudgetSeconds: number | null;
  readonly repeat: ExperimentRepeatInput | null;
  /** Stable digest of the experiment this round proposes. */
  readonly fingerprint: string;
  readonly recordedAt: string;
}

export class ExperimentProposalRefusal extends Error {
  readonly reason: "invalid-proposal" | "proposal-not-new";
  constructor(reason: ExperimentProposalRefusal["reason"], message: string) {
    super(message);
    this.name = "ExperimentProposalRefusal";
    this.reason = reason;
  }
}

/** Parse and bound one proposal; evidence existence is checked by the service. */
export function parseExperimentProposal(
  input: ExperimentProposalInput,
  options: { readonly maxSubBudgetSeconds: number; readonly now: string },
): ExperimentProposal {
  const researchQuestion = requireText(input.researchQuestion, EXPERIMENT_PROPOSAL_LIMITS.questionCharacters, "The research question");
  const methodChange = requireText(input.methodChange, EXPERIMENT_PROPOSAL_LIMITS.methodChangeCharacters, "The method change");
  const expectedObservation = requireText(input.expectedObservation, EXPERIMENT_PROPOSAL_LIMITS.expectedObservationCharacters, "The expected observation");
  const evaluationMethod = requireText(input.evaluationMethod, EXPERIMENT_PROPOSAL_LIMITS.evaluationMethodCharacters, "The evaluation method");
  const stopCondition = requireText(input.stopCondition, EXPERIMENT_PROPOSAL_LIMITS.stopConditionCharacters, "The stop condition");
  if (!Array.isArray(input.evidence) || input.evidence.length === 0
    || input.evidence.length > EXPERIMENT_PROPOSAL_LIMITS.evidenceItems) {
    throw new ExperimentProposalRefusal("invalid-proposal", "A proposal needs 1-16 evidence references");
  }
  const evidence: ExperimentEvidenceRecord[] = input.evidence.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ExperimentProposalRefusal("invalid-proposal", `Evidence ${index + 1} is not an object`);
    }
    if (entry.kind !== "artifact-version" && entry.kind !== "operation-result") {
      throw new ExperimentProposalRefusal("invalid-proposal", `Evidence ${index + 1} has no supported kind`);
    }
    const fact = requireText(entry.fact, EXPERIMENT_PROPOSAL_LIMITS.factCharacters, `Evidence ${index + 1}'s fact`);
    if (entry.kind === "artifact-version") {
      if (!isUsableId(entry.versionId) || entry.operationId !== undefined) {
        throw new ExperimentProposalRefusal("invalid-proposal", `Evidence ${index + 1} must name exactly one artifact version`);
      }
      return { fact, kind: "artifact-version", versionId: entry.versionId };
    }
    if (!isUsableId(entry.operationId) || entry.versionId !== undefined) {
      throw new ExperimentProposalRefusal("invalid-proposal", `Evidence ${index + 1} must name exactly one research operation`);
    }
    return { fact, kind: "operation-result", operationId: entry.operationId };
  });
  if (new Set(evidence.map(evidenceKey)).size !== evidence.length) {
    throw new ExperimentProposalRefusal("invalid-proposal", "A proposal cites the same evidence twice");
  }
  let subBudgetSeconds: number | null = null;
  if (input.subBudgetSeconds !== undefined) {
    if (!Number.isSafeInteger(input.subBudgetSeconds)
      || input.subBudgetSeconds < 60 || input.subBudgetSeconds > options.maxSubBudgetSeconds) {
      throw new ExperimentProposalRefusal(
        "invalid-proposal",
        `The sub-budget must be an integer from 60 to ${options.maxSubBudgetSeconds} seconds`,
      );
    }
    subBudgetSeconds = input.subBudgetSeconds;
  }
  let repeat: ExperimentRepeatInput | null = null;
  if (input.repeat !== undefined) {
    if (!isRecord(input.repeat) || input.repeat.kind !== "randomized-repeat") {
      throw new ExperimentProposalRefusal("invalid-proposal", "A repeat must declare kind randomized-repeat");
    }
    if (!Number.isSafeInteger(input.repeat.repetitions)
      || input.repeat.repetitions < 2 || input.repeat.repetitions > EXPERIMENT_PROPOSAL_LIMITS.maxRepetitions) {
      throw new ExperimentProposalRefusal("invalid-proposal", "A repeat needs 2-10 declared repetitions");
    }
    repeat = {
      kind: "randomized-repeat",
      purpose: requireText(input.repeat.purpose, EXPERIMENT_PROPOSAL_LIMITS.repeatCharacters, "The repeat purpose"),
      randomness: requireText(input.repeat.randomness, EXPERIMENT_PROPOSAL_LIMITS.repeatCharacters, "The repeat randomness"),
      repetitions: input.repeat.repetitions,
    };
  }
  const normalizedMethodChange = normalizeText(methodChange);
  const fingerprint = createHash("sha256").update(canonicalJson({
    evaluationMethod: normalizeText(evaluationMethod),
    evidence: evidence.map((entry) => ({ ...evidenceKeyParts(entry), fact: normalizeText(entry.fact) })),
    expectedObservation: normalizeText(expectedObservation),
    methodChange: normalizedMethodChange,
    researchQuestion: normalizeText(researchQuestion),
    stopCondition: normalizeText(stopCondition),
  })).digest("hex");
  return {
    evidence,
    evaluationMethod,
    expectedObservation,
    fingerprint,
    methodChange,
    normalizedMethodChange,
    recordedAt: options.now,
    repeat,
    researchQuestion,
    schemaVersion: EXPERIMENT_PROPOSAL_VERSION,
    stopCondition,
    subBudgetSeconds,
  };
}

/**
 * Refuse a round that makes no scientific advance: the same method on the same
 * candidate with no new evidence, and no declared randomized repeat, is the
 * automatic repetition this seam exists to stop.
 */
export function assertExperimentProposalAdvances(
  proposal: ExperimentProposal,
  previous: { readonly proposal: ExperimentProposal; readonly incumbentVersionId: string | null } | undefined,
  incumbentVersionId: string | null,
): void {
  if (previous === undefined) return;
  if (proposal.repeat !== null) return;
  const previousEvidence = new Set(previous.proposal.evidence.map(evidenceKey));
  const hasNewEvidence = proposal.evidence.some((entry) => !previousEvidence.has(evidenceKey(entry)));
  const sameMethod = proposal.normalizedMethodChange === previous.proposal.normalizedMethodChange;
  const sameCandidate = (incumbentVersionId ?? null) === (previous.incumbentVersionId ?? null);
  if (sameMethod && sameCandidate && !hasNewEvidence) {
    throw new ExperimentProposalRefusal(
      "proposal-not-new",
      "This round repeats the previous method on the same starting candidate without new evidence. "
        + "Make a concrete method change, cite new evidence, or declare a randomized repeat with its purpose and randomness.",
    );
  }
}

export function evidenceKey(entry: ExperimentEvidenceRecord | ExperimentEvidenceInput): string {
  return entry.kind === "artifact-version" ? `artifact:${entry.versionId}` : `operation:${entry.operationId}`;
}

function evidenceKeyParts(entry: ExperimentEvidenceRecord): Record<string, unknown> {
  return entry.kind === "artifact-version" ? { versionId: entry.versionId } : { operationId: entry.operationId };
}

function requireText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") {
    throw new ExperimentProposalRefusal("invalid-proposal", `${label} must be text`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || trimmed.includes("\u0000")) {
    throw new ExperimentProposalRefusal("invalid-proposal", `${label} must be 1-${maximum} characters without NUL bytes`);
  }
  return trimmed;
}

function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\u0000");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\s.!?;:,，。！？；：、]+$/u, "")
    .trim();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
