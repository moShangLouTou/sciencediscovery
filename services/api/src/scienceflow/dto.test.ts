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
  SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
  type ScienceFlowRunSnapshot,
  type ScienceFlowSnapshotDiagnostic,
  type ScienceFlowTaskSnapshot,
} from "@sciencediscovery/scienceflow-reader";
import { SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION } from "@sciencediscovery/schema";
import {
  projectScienceFlowDiagnostics,
  projectScienceFlowRunSnapshot,
} from "./dto.js";

const MARKER = "SYNTHETIC-SENSITIVE-MARKER-9f3b";
const SHA = "a".repeat(64);

/** Deliberately malformed trusted input, to prove the projection fails closed. */
function unsound<T>(value: unknown): T {
  return value as T;
}

function snapshot(
  overrides: Partial<ScienceFlowRunSnapshot> = {},
): ScienceFlowRunSnapshot {
  return {
    schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    runId: "run-1",
    rawStatus: "running",
    phase: "research",
    tasks: [],
    diagnostics: [],
    ...overrides,
  };
}

function task(
  overrides: Partial<ScienceFlowTaskSnapshot> = {},
): ScienceFlowTaskSnapshot {
  return {
    taskRoot: `/srv/${MARKER}/tasks/task-a`,
    reportedBestMetric: null,
    candidateArtifact: null,
    evidenceReferences: [`task_logs/${MARKER}.csv`],
    ...overrides,
  };
}

test("projects only whitelisted fields and drops every sensitive marker", () => {
  const reportedBestMetric: Readonly<Record<string, unknown>> = {
    metricName: "accuracy",
    metricValue: 0.91,
    lowerIsBetter: false,
    source: "lhr_stage_performance",
    [MARKER]: { nested: MARKER },
    path: `/srv/${MARKER}/secret.csv`,
  };
  const candidateArtifact: Readonly<Record<string, unknown>> = {
    path: `/srv/${MARKER}/artifact.bin`,
    sha256: SHA,
    recordedSha256: SHA,
    digestVerified: true,
    scoreSource: "best_stage_manifest",
    metricName: "accuracy",
    metricValue: 0.87,
    lowerIsBetter: false,
    stageId: "stage-1",
    candidateId: MARKER,
    validationOk: true,
    [MARKER]: { [MARKER]: MARKER },
  };
  const diagnostics: ScienceFlowSnapshotDiagnostic[] = [
    {
      code: "no_candidate_binding",
      message: `${MARKER} at /srv/${MARKER}`,
      taskRoot: `/srv/${MARKER}/tasks/task-a`,
    },
  ];

  const dto = projectScienceFlowRunSnapshot(
    "run-1",
    snapshot({
      tasks: [
        task({ reportedBestMetric, candidateArtifact }),
        task({ taskRoot: null }),
      ],
      diagnostics,
    }),
  );

  assert.deepEqual(dto, {
    schemaVersion: SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION,
    run: { runId: "run-1", status: "running", phase: "research" },
    tasks: [
      {
        taskIndex: 0,
        reportedMetric: {
          metricName: "accuracy",
          metricValue: 0.91,
          lowerIsBetter: false,
          source: "lhr_stage_performance",
        },
        candidate: {
          sha256: SHA,
          digestVerified: true,
          metric: {
            metricName: "accuracy",
            metricValue: 0.87,
            lowerIsBetter: false,
          },
          stageId: "stage-1",
        },
      },
      { taskIndex: 1, reportedMetric: null, candidate: null },
    ],
    diagnostics: [
      {
        code: "no_candidate_binding",
        description: "The run records no candidate for this task.",
      },
    ],
  });
  // Nothing from the open records, the reader's message, the taskRoot, the
  // evidence paths, or the artifact path reaches the response.
  const serialized = JSON.stringify(dto);
  for (const leaked of [MARKER, "taskRoot", "path", "evidenceReferences", "candidateId"]) {
    assert.ok(!serialized.includes(leaked), leaked);
  }
  assert.deepEqual(Object.keys(dto.tasks[0]!.candidate!).sort(), [
    "digestVerified",
    "metric",
    "sha256",
    "stageId",
  ]);
});

test("maps engine status and phase to closed enums and keeps unknown values", () => {
  const known: Array<[string, string]> = [
    ["starting", "research"],
    ["running", "reporting"],
    ["stopping", "finished"],
    ["completed", "research"],
    ["failed", "research"],
    ["stopped", "research"],
    ["interrupted", "research"],
  ];
  for (const [status, phase] of known) {
    const dto = projectScienceFlowRunSnapshot(
      "run-1",
      snapshot({ rawStatus: status, phase }),
    );
    assert.equal(dto.run.status, status);
    assert.equal(dto.run.phase, phase);
  }

  // Unknown, missing, or non-string values never become a research outcome.
  const unknownValues = unsound<Array<string | null>>([
    "created",
    "success",
    "",
    null,
    42,
    { status: "completed" },
  ]);
  for (const value of unknownValues) {
    const dto = projectScienceFlowRunSnapshot(
      "run-1",
      snapshot({ rawStatus: value, phase: unsound<string | null>(value) }),
    );
    assert.equal(dto.run.status, "unknown");
    assert.equal(dto.run.phase, "unknown");
  }
});

test("rejects a reported metric that does not meet its numeric contract", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    "accuracy",
    { metricName: "accuracy", metricValue: Number.NaN, lowerIsBetter: false },
    { metricName: "accuracy", metricValue: Number.POSITIVE_INFINITY },
    { metricName: "accuracy", metricValue: Number.NEGATIVE_INFINITY },
    { metricName: "accuracy", metricValue: "0.91" },
    { metricName: "", metricValue: 0.91 },
    { metricName: 42, metricValue: 0.91 },
  ];
  for (const value of invalid) {
    const dto = projectScienceFlowRunSnapshot(
      "run-1",
      snapshot({ tasks: [task({ reportedBestMetric: unsound(value) })] }),
    );
    assert.equal(dto.tasks[0]!.reportedMetric, null, JSON.stringify(value));
  }

  const direction = projectScienceFlowRunSnapshot(
    "run-1",
    snapshot({
      tasks: [
        task({
          reportedBestMetric: { metricName: "accuracy", metricValue: 0.5 },
        }),
        task({
          reportedBestMetric: {
            metricName: "loss",
            metricValue: 0.5,
            lowerIsBetter: "true",
            source: "invented_source",
          },
        }),
      ],
    }),
  );
  assert.deepEqual(direction.tasks[0]!.reportedMetric, {
    metricName: "accuracy",
    metricValue: 0.5,
    lowerIsBetter: null,
    source: "unknown",
  });
  // A malformed direction stays unknown; the recorded number is not discarded.
  assert.deepEqual(direction.tasks[1]!.reportedMetric, {
    metricName: "loss",
    metricValue: 0.5,
    lowerIsBetter: null,
    source: "unknown",
  });
});

test("accepts only a computed digest as candidate evidence", () => {
  const invalidSha: unknown[] = [
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(63)}g`,
    42,
    null,
    undefined,
  ];
  for (const sha256 of invalidSha) {
    const dto = projectScienceFlowRunSnapshot(
      "run-1",
      snapshot({ tasks: [task({ candidateArtifact: { sha256 } })] }),
    );
    assert.equal(dto.tasks[0]!.candidate, null, JSON.stringify(sha256));
  }

  const dto = projectScienceFlowRunSnapshot(
    "run-1",
    snapshot({
      tasks: [
        task({
          candidateArtifact: {
            sha256: SHA,
            digestVerified: "true",
            stageId: 42,
            metricName: "accuracy",
            metricValue: Number.POSITIVE_INFINITY,
          },
        }),
      ],
    }),
  );
  // The digest is real, so the candidate is shown; the fields that do not
  // meet their contract become null instead of a fabricated "verified" value.
  assert.deepEqual(dto.tasks[0]!.candidate, {
    sha256: SHA,
    digestVerified: null,
    metric: null,
    stageId: null,
  });
});

test("keeps the reported metric and the candidate metric independent", () => {
  const dto = projectScienceFlowRunSnapshot(
    "run-1",
    snapshot({
      tasks: [
        task({
          reportedBestMetric: {
            metricName: "accuracy",
            metricValue: 0.91,
            lowerIsBetter: false,
            source: "best_stage_manifest",
          },
          candidateArtifact: {
            sha256: SHA,
            digestVerified: true,
            metricName: "accuracy",
            metricValue: 0.87,
            lowerIsBetter: false,
            stageId: "stage-1",
          },
        }),
      ],
    }),
  );
  assert.equal(dto.tasks[0]!.reportedMetric!.metricValue, 0.91);
  assert.equal(dto.tasks[0]!.candidate!.metric!.metricValue, 0.87);
});

test("diagnostics expose known codes with fixed descriptions only", () => {
  const diagnostics = projectScienceFlowDiagnostics([
    {
      code: "run_record_invalid_json",
      message: `${MARKER} is not JSON`,
      taskRoot: `/srv/${MARKER}`,
    },
    { code: "future_code", message: MARKER },
    unsound<ScienceFlowSnapshotDiagnostic>({ message: MARKER }),
    unsound<ScienceFlowSnapshotDiagnostic>(null),
  ]);

  assert.deepEqual(diagnostics, [
    {
      code: "run_record_invalid_json",
      description: "The run record is not valid JSON.",
    },
    { code: "other", description: "The reader reported a condition this API does not classify." },
    { code: "other", description: "The reader reported a condition this API does not classify." },
    { code: "other", description: "The reader reported a condition this API does not classify." },
  ]);
  assert.ok(!JSON.stringify(diagnostics).includes(MARKER));
});

test("takes the public run identity from the validated argument, not the payload", () => {
  const dto = projectScienceFlowRunSnapshot(
    "run-from-binding",
    snapshot({ runId: "run-from-reader" }),
  );
  assert.equal(dto.run.runId, "run-from-binding");
  assert.ok(!JSON.stringify(dto).includes("run-from-reader"));
});

test("an empty payload is a valid empty snapshot, not a failure", () => {
  const dto = projectScienceFlowRunSnapshot(
    "run-1",
    snapshot({ rawStatus: null, phase: null }),
  );
  assert.deepEqual(dto, {
    schemaVersion: SCIENCE_FLOW_RUN_SNAPSHOT_DTO_VERSION,
    run: { runId: "run-1", status: "unknown", phase: "unknown" },
    tasks: [],
    diagnostics: [],
  });
});
