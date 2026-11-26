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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import {
  assertExperimentProposalAdvances,
  ExperimentProposalRefusal,
  parseExperimentProposal,
  resolveScienceFlowProposal,
  type ExperimentProposalInput,
} from "./local-research-proposal.js";

function proposal(overrides: Partial<ExperimentProposalInput> = {}): ExperimentProposalInput {
  return {
    evidence: [{ fact: "The previous run captured rmse 0.05.", kind: "operation-result", operationId: "operation-1" }],
    evaluationMethod: "Same frozen contract and evaluator; metric rmse on the bound CSV.",
    expectedObservation: "A lower rmse than the previous run.",
    methodChange: "Add a quadratic term and refit both coefficients.",
    researchQuestion: "Does a quadratic term reduce the residual?",
    stopCondition: "Stop after the first captured candidate that beats the previous rmse.",
    ...overrides,
  };
}

test("a complete proposal is bounded and gets a stable fingerprint", () => {
  const first = parseExperimentProposal(proposal(), { maxSubBudgetSeconds: 900, now: "2026-11-17T00:00:00.000Z" });
  const second = parseExperimentProposal(proposal(), { maxSubBudgetSeconds: 900, now: "2026-11-17T00:00:01.000Z" });
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.normalizedMethodChange, "add a quadratic term and refit both coefficients");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.subBudgetSeconds, null);
  assert.equal(first.repeat, null);
});

test("proposal bounds reject an empty evidence list, malformed evidence and an oversized sub-budget", () => {
  assert.throws(
    () => parseExperimentProposal(proposal({ evidence: [] }), { maxSubBudgetSeconds: 900, now: "x" }),
    (error: unknown) => error instanceof ExperimentProposalRefusal,
  );
  assert.throws(
    () => parseExperimentProposal(proposal({
      evidence: [{ fact: "both", kind: "artifact-version", operationId: "operation-1", versionId: "version-1" }],
    }), { maxSubBudgetSeconds: 900, now: "x" }),
    (error: unknown) => error instanceof ExperimentProposalRefusal,
  );
  assert.throws(
    () => parseExperimentProposal(proposal({ subBudgetSeconds: 1_000 }), { maxSubBudgetSeconds: 900, now: "x" }),
    (error: unknown) => error instanceof ExperimentProposalRefusal,
  );
});

test("a repeat must declare randomized purpose and at least two repetitions", () => {
  const repeated = parseExperimentProposal(proposal({
    repeat: { kind: "randomized-repeat", purpose: "Estimate seed variance.", randomness: "Seed derived from the run id.", repetitions: 3 },
  }), { maxSubBudgetSeconds: 900, now: "x" });
  assert.equal(repeated.repeat?.repetitions, 3);
  assert.throws(
    () => parseExperimentProposal(proposal({
      repeat: { kind: "randomized-repeat", purpose: "One more", randomness: "same", repetitions: 1 },
    }), { maxSubBudgetSeconds: 900, now: "x" }),
    (error: unknown) => error instanceof ExperimentProposalRefusal,
  );
});

test("the same method on the same candidate with no new evidence is refused", () => {
  const previous = parseExperimentProposal(proposal(), { maxSubBudgetSeconds: 900, now: "x" });
  const repeated = parseExperimentProposal(proposal({ methodChange: "  Add a quadratic term   and refit both coefficients. " }), {
    maxSubBudgetSeconds: 900,
    now: "y",
  });
  assert.throws(
    () => assertExperimentProposalAdvances(
      repeated,
      { incumbentVersionId: "version-1", proposal: previous },
      "version-1",
    ),
    (error: unknown) => error instanceof ExperimentProposalRefusal && error.reason === "proposal-not-new",
  );
  // A declared randomized repeat is the one supported way to repeat it.
  const explicitRepeat = parseExperimentProposal(proposal({
    repeat: { kind: "randomized-repeat", purpose: "Estimate seed variance.", randomness: "Run id seed.", repetitions: 2 },
  }), { maxSubBudgetSeconds: 900, now: "z" });
  assert.doesNotThrow(() => assertExperimentProposalAdvances(
    explicitRepeat,
    { incumbentVersionId: "version-1", proposal: previous },
    "version-1",
  ));
});

test("a new method, a new candidate or new evidence advances the round", () => {
  const previous = parseExperimentProposal(proposal(), { maxSubBudgetSeconds: 900, now: "x" });
  const newMethod = parseExperimentProposal(proposal({ methodChange: "Refit with a robust Huber loss instead." }), {
    maxSubBudgetSeconds: 900,
    now: "y",
  });
  assert.doesNotThrow(() => assertExperimentProposalAdvances(
    newMethod,
    { incumbentVersionId: "version-1", proposal: previous },
    "version-1",
  ));
  const newCandidate = parseExperimentProposal(proposal(), { maxSubBudgetSeconds: 900, now: "y" });
  assert.doesNotThrow(() => assertExperimentProposalAdvances(
    newCandidate,
    { incumbentVersionId: "version-1", proposal: previous },
    "version-2",
  ));
  const newEvidence = parseExperimentProposal(proposal({
    evidence: [
      { fact: "The previous run captured rmse 0.05.", kind: "operation-result", operationId: "operation-1" },
      { fact: "The other run showed a quadratic residual pattern.", kind: "operation-result", operationId: "operation-2" },
    ],
  }), { maxSubBudgetSeconds: 900, now: "y" });
  assert.doesNotThrow(() => assertExperimentProposalAdvances(
    newEvidence,
    { incumbentVersionId: "version-1", proposal: previous },
    "version-1",
  ));
});

test("proposal domain resolves Session-owned evidence and refuses foreign or missing continuation evidence", () => {
  const base = { identity: { projectId: "project", sessionId: "session" }, maxSubBudgetSeconds: 900,
    now: "2026-11-27T00:00:00Z", required: false, operations: [], incumbentVersionId: null,
    version: () => ({ artifactId: "artifact", sessionId: "session", content: { hash: "a".repeat(64) } }),
    artifact: () => ({ createdInSessionId: "other-session" }), operation: () => undefined };
  const input = proposal({ evidence: [{ kind: "artifact-version", versionId: "version", fact: "Observed input data" }] });
  assert.equal(resolveScienceFlowProposal({ ...base, input })?.evidence[0]?.sha256, "a".repeat(64));
  assert.throws(() => resolveScienceFlowProposal({ ...base, input, version: () => undefined }), ExperimentProposalRefusal);
  assert.throws(() => resolveScienceFlowProposal({ ...base, required: true }), ExperimentProposalRefusal);
  assert.equal(resolveScienceFlowProposal(base), undefined);
  assert.throws(() => resolveScienceFlowProposal({ ...base, input: proposal(),
    operation: () => ({ identity: { projectId: "other-project", sessionId: "session" } }) }), ExperimentProposalRefusal);
});
