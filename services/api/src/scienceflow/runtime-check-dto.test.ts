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
  SCIENCE_FLOW_RUNTIME_CHECK_CODES,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowRuntimeCheckCode,
} from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS,
  canonicalRuntimeChecks,
  describeScienceFlowRuntimeCheck,
  isScienceFlowRuntimeSourceKind,
  isVerifiedRuntimeCheck,
  runtimeCheckChecksDto,
} from "./runtime-check-dto.js";

type Check = { code: ScienceFlowRuntimeCheckCode; status: ScienceFlowPlanCheckStatus };

function passing(): Check[] {
  return SCIENCE_FLOW_RUNTIME_CHECK_CODES.map((code) => ({ code, status: "passed" }));
}

function withStatus(code: ScienceFlowRuntimeCheckCode, status: ScienceFlowPlanCheckStatus): Check[] {
  return passing().map((entry) => (entry.code === code ? { code, status } : entry));
}

test("RT-DTO-01 every fixed code gets a neutral description and a rebuilt DTO", () => {
  const dto = runtimeCheckChecksDto(passing());
  assert.deepEqual(
    dto.map((entry) => entry.code),
    [...SCIENCE_FLOW_RUNTIME_CHECK_CODES],
  );
  for (const entry of dto) {
    assert.equal(entry.description.length > 0, true);
    assert.equal(entry.description.includes("/"), false);
  }
  // A failed condition reads differently from a passing one.
  assert.notEqual(
    describeScienceFlowRuntimeCheck("source_revision", "passed"),
    describeScienceFlowRuntimeCheck("source_revision", "failed"),
  );
});

test("RT-DTO-02 the verified rule accepts only passed checks, with one unknown", () => {
  assert.equal(isVerifiedRuntimeCheck(passing()), true);
  assert.equal(
    isVerifiedRuntimeCheck(withStatus("duplicate_distribution", "unknown")),
    true,
  );
  for (const status of ["failed", "unsupported", "unknown"] as const) {
    assert.equal(isVerifiedRuntimeCheck(withStatus("source_revision", status)), false);
    assert.equal(isVerifiedRuntimeCheck(withStatus("package_resolution", status)), false);
    assert.equal(isVerifiedRuntimeCheck(withStatus("startup_hooks", status)), false);
  }
});

test("RT-DTO-03 an untrusted check list must carry every code exactly once", () => {
  assert.notEqual(canonicalRuntimeChecks(passing()), null);
  // Canonical order is restored regardless of the input order.
  const reversed = [...passing()].reverse();
  const canonical = canonicalRuntimeChecks(reversed);
  if (canonical === null) assert.fail("expected canonical checks");
  assert.deepEqual(
    canonical.map((entry) => entry.code),
    [...SCIENCE_FLOW_RUNTIME_CHECK_CODES],
  );

  const duplicate = [...passing().slice(1), passing()[1]!];
  assert.equal(canonicalRuntimeChecks(duplicate), null);
  assert.equal(canonicalRuntimeChecks(passing().slice(1)), null);
  assert.equal(
    canonicalRuntimeChecks([...passing().slice(1), { code: "extra", status: "passed" }]),
    null,
  );
  assert.equal(
    canonicalRuntimeChecks([...passing().slice(1), { code: "source_root", status: "maybe" }]),
    null,
  );
  assert.equal(canonicalRuntimeChecks([...passing(), passing()[0]!]), null);
  assert.equal(canonicalRuntimeChecks("checks"), null);
  assert.equal(canonicalRuntimeChecks([null]), null);
});

test("RT-DTO-04 the source kind guard accepts only the schema kinds", () => {
  for (const kind of ["git-checkout", "installed-distribution", "unsupported"] as const) {
    assert.equal(isScienceFlowRuntimeSourceKind(kind), true);
  }
  assert.equal(isScienceFlowRuntimeSourceKind("checkout"), false);
  assert.equal(isScienceFlowRuntimeSourceKind(1), false);
  assert.equal(isScienceFlowRuntimeSourceKind(undefined), false);
});

test("RT-DTO-05 the unanswered questions are fixed and cannot be configured", () => {
  assert.deepEqual(SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS, {
    dependencyClosure: "incomplete",
    executionStart: "not-checked",
    modelGateway: "unknown",
    evaluator: "not-checked",
    gpu: "not-checked",
  });
  assert.equal(Object.isFrozen(SCIENCE_FLOW_RUNTIME_CHECK_UNKNOWNS), true);
});
