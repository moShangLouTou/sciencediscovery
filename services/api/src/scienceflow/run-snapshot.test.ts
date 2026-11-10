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
  type ReadScienceFlowRunSnapshotOptions,
  type ScienceFlowRunSnapshot,
  type ScienceFlowSnapshotReadResult,
} from "@sciencediscovery/scienceflow-reader";
import {
  createScienceFlowRunSnapshotQuery,
  type ScienceFlowIdentityStore,
  type ScienceFlowReaderConfig,
  type ScienceFlowRunBinding,
  type ScienceFlowRunQuery,
  type ScienceFlowRunSnapshotQueryDependencies,
  type ScienceFlowRunSnapshotQueryResult,
  type ScienceFlowSnapshotReader,
} from "./run-snapshot.js";

const QUERY: ScienceFlowRunQuery = {
  projectId: "project-1",
  sessionId: "session-1",
  runId: "run-1",
};

const CONFIG: ScienceFlowReaderConfig = {
  pythonExecutable: "/opt/scienceflow/bin/python3",
  readerScriptPath: "/srv/scienceflow/services/scienceflow-reader/snapshot.py",
  timeoutMs: 5_000,
};

const TASK_ROOT = "/srv/scienceflow/runs/run-1/tasks/task-a";

const BINDING: ScienceFlowRunBinding = {
  projectId: "project-1",
  sessionId: "session-1",
  runId: "run-1",
  runRecordPath: "/srv/scienceflow/runs/run-1/control.json",
  allowedTaskRoots: [TASK_ROOT],
};

/** Deliberately malformed trusted input, to prove the runtime guards fail closed. */
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

function recordingReader(
  outcome: ScienceFlowSnapshotReadResult,
  calls: ReadScienceFlowRunSnapshotOptions[],
): ScienceFlowSnapshotReader {
  return async (options) => {
    calls.push(options);
    return outcome;
  };
}

function throwingReader(
  message: string,
  calls: ReadScienceFlowRunSnapshotOptions[],
): ScienceFlowSnapshotReader {
  return async (options) => {
    calls.push(options);
    throw new Error(message);
  };
}

function identityStore(
  project: { readonly id: string } | undefined,
  session: { readonly projectId: string } | undefined,
): ScienceFlowIdentityStore {
  return {
    getProject: () => project,
    getSession: () => session,
  };
}

function queryWith(
  overrides: Partial<ScienceFlowRunSnapshotQueryDependencies>,
): (query: ScienceFlowRunQuery) => Promise<ScienceFlowRunSnapshotQueryResult> {
  return createScienceFlowRunSnapshotQuery({
    identities: identityStore(
      { id: QUERY.projectId },
      { projectId: QUERY.projectId },
    ),
    resolveBinding: () => BINDING,
    readerConfig: CONFIG,
    ...overrides,
  });
}

test("calls the reader with the trusted config and the resolved binding", async () => {
  const calls: ReadScienceFlowRunSnapshotOptions[] = [];
  let received: ScienceFlowRunQuery | undefined;
  const binding: ScienceFlowRunBinding = Object.freeze({
    ...BINDING,
    allowedTaskRoots: Object.freeze([...BINDING.allowedTaskRoots]),
  });
  const query = createScienceFlowRunSnapshotQuery({
    identities: identityStore(
      { id: QUERY.projectId },
      { projectId: QUERY.projectId },
    ),
    resolveBinding: (requested) => {
      // The resolver sees business identity only, never request-supplied paths.
      received = requested;
      return binding;
    },
    readerConfig: Object.freeze({ ...CONFIG }),
    readSnapshot: recordingReader(
      { status: "ok", snapshot: snapshot() },
      calls,
    ),
  });

  const result = await query(QUERY);

  assert.equal(result.status, "ok");
  assert.deepEqual(received, QUERY);
  const [call] = calls;
  assert.ok(call);
  assert.deepEqual(call, {
    pythonExecutable: CONFIG.pythonExecutable,
    readerScriptPath: CONFIG.readerScriptPath,
    runRecordPath: BINDING.runRecordPath,
    allowedTaskRoots: BINDING.allowedTaskRoots,
    timeoutMs: CONFIG.timeoutMs,
  });
});

test("does not call the reader when the identity or binding is unusable", async () => {
  const cases: Array<{
    readonly label: string;
    readonly dependencies: Partial<ScienceFlowRunSnapshotQueryDependencies>;
    readonly expected: ScienceFlowRunSnapshotQueryResult;
  }> = [
    {
      label: "missing Project",
      dependencies: {
        identities: identityStore(undefined, { projectId: QUERY.projectId }),
      },
      expected: { status: "not-found", resource: "project" },
    },
    {
      label: "missing Session",
      dependencies: {
        identities: identityStore({ id: QUERY.projectId }, undefined),
      },
      expected: { status: "not-found", resource: "session" },
    },
    {
      label: "Session in another Project",
      dependencies: {
        identities: identityStore(
          { id: QUERY.projectId },
          { projectId: "project-2" },
        ),
      },
      expected: { status: "not-found", resource: "session" },
    },
    {
      label: "missing binding",
      dependencies: { resolveBinding: () => undefined },
      expected: { status: "not-found", resource: "binding" },
    },
    {
      label: "binding for another Session",
      dependencies: {
        resolveBinding: () => ({ ...BINDING, sessionId: "session-2" }),
      },
      expected: { status: "invalid", reason: "binding" },
    },
    {
      label: "binding for another run",
      dependencies: {
        resolveBinding: () => ({ ...BINDING, runId: "run-2" }),
      },
      expected: { status: "invalid", reason: "binding" },
    },
  ];

  for (const item of cases) {
    const calls: ReadScienceFlowRunSnapshotOptions[] = [];
    const result = await queryWith({
      ...item.dependencies,
      readSnapshot: recordingReader(
        { status: "ok", snapshot: snapshot() },
        calls,
      ),
    })(QUERY);
    assert.deepEqual(result, item.expected, item.label);
    assert.equal(calls.length, 0, item.label);
  }
});

test("fails closed on an unusable reader configuration without resolving a binding", async () => {
  const unusable: Array<ScienceFlowReaderConfig> = [
    { ...CONFIG, pythonExecutable: "" },
    { ...CONFIG, readerScriptPath: "   " },
    { ...CONFIG, timeoutMs: 0 },
    { ...CONFIG, timeoutMs: Number.NaN },
    { ...CONFIG, timeoutMs: Number.POSITIVE_INFINITY },
    unsound<ScienceFlowReaderConfig>({
      readerScriptPath: CONFIG.readerScriptPath,
      timeoutMs: CONFIG.timeoutMs,
    }),
  ];

  for (const readerConfig of unusable) {
    const calls: ReadScienceFlowRunSnapshotOptions[] = [];
    let resolved = 0;
    const result = await queryWith({
      readerConfig,
      resolveBinding: () => {
        resolved += 1;
        return BINDING;
      },
      readSnapshot: recordingReader(
        { status: "ok", snapshot: snapshot() },
        calls,
      ),
    })(QUERY);
    // The exact result proves no default interpreter, script, timeout, or
    // user directory was substituted for the missing configuration.
    assert.deepEqual(result, { status: "invalid", reason: "configuration" });
    assert.equal(resolved, 0);
    assert.equal(calls.length, 0);
  }
});

test("fails closed on a binding without allowed task roots", async () => {
  const bindings: ScienceFlowRunBinding[] = [
    { ...BINDING, allowedTaskRoots: [] },
    { ...BINDING, allowedTaskRoots: ["  "] },
    { ...BINDING, runRecordPath: "" },
  ];

  for (const binding of bindings) {
    const calls: ReadScienceFlowRunSnapshotOptions[] = [];
    const result = await queryWith({
      resolveBinding: () => binding,
      readSnapshot: recordingReader(
        { status: "ok", snapshot: snapshot() },
        calls,
      ),
    })(QUERY);
    assert.deepEqual(result, { status: "invalid", reason: "binding" });
    assert.equal(calls.length, 0);
  }
});

test("rejects a successful reading of a different run", async () => {
  const calls: ReadScienceFlowRunSnapshotOptions[] = [];
  const result = await queryWith({
    readSnapshot: recordingReader(
      { status: "ok", snapshot: snapshot({ runId: "run-other" }) },
      calls,
    ),
  })(QUERY);

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { status: "run-mismatch" });
});

test("keeps a reader failure a failure even when its JSON is valid", async () => {
  const matching = await queryWith({
    readSnapshot: recordingReader(
      {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot({
          diagnostics: [
            { code: "run_record_invalid_json", message: "Run record is not valid JSON." },
          ],
        }),
      },
      [],
    ),
  })(QUERY);
  assert.equal(matching.status, "reader-failed");
  if (matching.status !== "reader-failed") return;
  assert.equal(matching.exitCode, 2);
  assert.deepEqual(matching.snapshot.diagnostics, [
    { code: "run_record_invalid_json", message: "Run record is not valid JSON." },
  ]);

  const mismatched = await queryWith({
    readSnapshot: recordingReader(
      {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot({ runId: "run-other" }),
      },
      [],
    ),
  })(QUERY);
  assert.deepEqual(mismatched, { status: "run-mismatch" });
});

test("keeps a failure without a run identity a failure with its diagnostics", async () => {
  const diagnostics = [
    { code: "run_record_invalid_json", message: "Run record is not valid JSON." },
  ];
  const result = await queryWith({
    readSnapshot: recordingReader(
      {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot({ runId: null, diagnostics }),
      },
      [],
    ),
  })(QUERY);

  assert.equal(result.status, "reader-failed");
  if (result.status !== "reader-failed") return;
  assert.equal(result.exitCode, 2);
  assert.equal(result.snapshot.runId, null);
  assert.deepEqual(result.snapshot.diagnostics, diagnostics);
});

test("maps every reader outcome one-to-one and keeps protocol errors distinct", async () => {
  const mappings: Array<{
    readonly label: string;
    readonly outcome: ScienceFlowSnapshotReadResult;
    readonly expected: ScienceFlowRunSnapshotQueryResult;
  }> = [
    {
      label: "ok",
      outcome: { status: "ok", snapshot: snapshot() },
      expected: { status: "ok", snapshot: snapshot() },
    },
    {
      label: "reader-failed",
      outcome: {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot(),
      },
      expected: {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot(),
      },
    },
    {
      label: "spawn-failed",
      outcome: { status: "spawn-failed", code: "ENOENT" },
      expected: { status: "spawn-failed", code: "ENOENT" },
    },
    {
      label: "timeout",
      outcome: { status: "timeout", timeoutMs: CONFIG.timeoutMs },
      expected: { status: "timeout", timeoutMs: CONFIG.timeoutMs },
    },
    {
      label: "output-limit",
      outcome: { status: "output-limit", limitBytes: 1_024, stream: "stderr" },
      expected: { status: "output-limit", limitBytes: 1_024, stream: "stderr" },
    },
    {
      label: "protocol-error",
      outcome: {
        status: "protocol-error",
        reason: "unsupported-schema-version",
        exitCode: 0,
      },
      expected: {
        status: "protocol-error",
        reason: "unsupported-schema-version",
        exitCode: 0,
      },
    },
  ];

  for (const mapping of mappings) {
    const result = await queryWith({
      readSnapshot: recordingReader(mapping.outcome, []),
    })(QUERY);
    assert.deepEqual(result, mapping.expected, mapping.label);
    if (mapping.label === "protocol-error") {
      assert.equal(result.status, "protocol-error");
    }
    if (mapping.label === "reader-failed") {
      assert.equal(result.status, "reader-failed");
    }
  }
});

test("classifies a throwing dependency without leaking its message", async () => {
  const marker = "SYNTHETIC-SENSITIVE-MARKER-9f3b";

  const dependencies: Array<Partial<ScienceFlowRunSnapshotQueryDependencies>> = [
    {
      identities: {
        getProject: () => {
          throw new Error(marker);
        },
        getSession: () => ({ projectId: QUERY.projectId }),
      },
    },
    {
      resolveBinding: () => {
        throw new Error(marker);
      },
    },
    {
      readSnapshot: throwingReader(marker, []),
    },
  ];

  for (const overrides of dependencies) {
    const result = await queryWith(overrides)(QUERY);
    assert.deepEqual(result, { status: "internal-error" });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test("a running run without a candidate stays a successful snapshot", async () => {
  const taskRoot = TASK_ROOT;
  const reportedBestMetric = {
    metricName: "accuracy",
    metricValue: 0.91,
    lowerIsBetter: false,
    source: "lhr_stage_performance",
  };
  const read = snapshot({
    rawStatus: "running",
    tasks: [
      {
        taskRoot,
        reportedBestMetric,
        candidateArtifact: null,
        evidenceReferences: [],
      },
    ],
    diagnostics: [
      {
        code: "no_candidate_binding",
        message: "No best-stage manifest or stage-performance CSV found.",
        taskRoot,
      },
    ],
  });

  const result = await queryWith({
    readSnapshot: recordingReader({ status: "ok", snapshot: read }, []),
  })(QUERY);

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  // The engine-reported number is passed through under its own name; no
  // candidate is invented and no diagnostic is dropped.
  assert.deepEqual(result.snapshot, read);
  const [task] = result.snapshot.tasks;
  assert.ok(task);
  assert.equal(task.candidateArtifact, null);
  assert.deepEqual(task.reportedBestMetric, reportedBestMetric);
  assert.deepEqual(result.snapshot.diagnostics, read.diagnostics);
});

test("re-reads on every query without writing or mutating trusted input", async () => {
  let projectReads = 0;
  let sessionReads = 0;
  let bindingReads = 0;
  const calls: ReadScienceFlowRunSnapshotOptions[] = [];
  const binding: ScienceFlowRunBinding = Object.freeze({
    ...BINDING,
    allowedTaskRoots: Object.freeze([...BINDING.allowedTaskRoots]),
  });
  const readerConfig: ScienceFlowReaderConfig = Object.freeze({ ...CONFIG });
  const query = createScienceFlowRunSnapshotQuery({
    // The injected store surface is read-only: there is no writer to call.
    identities: {
      getProject: () => {
        projectReads += 1;
        return { id: QUERY.projectId };
      },
      getSession: () => {
        sessionReads += 1;
        return { projectId: QUERY.projectId };
      },
    },
    resolveBinding: () => {
      bindingReads += 1;
      return binding;
    },
    readerConfig,
    readSnapshot: recordingReader({ status: "ok", snapshot: snapshot() }, calls),
  });

  const first = await query(QUERY);
  const second = await query(QUERY);

  assert.deepEqual(first, second);
  assert.deepEqual(
    { projectReads, sessionReads, bindingReads, reads: calls.length },
    { projectReads: 2, sessionReads: 2, bindingReads: 2, reads: 2 },
  );
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(binding, {
    ...BINDING,
    allowedTaskRoots: [...BINDING.allowedTaskRoots],
  });
  assert.deepEqual(readerConfig, CONFIG);
});

test("rejects a query without a usable business identity", async () => {
  const calls: ReadScienceFlowRunSnapshotOptions[] = [];
  const invalid: ScienceFlowRunQuery[] = [
    { ...QUERY, projectId: "" },
    { ...QUERY, sessionId: "  " },
    unsound<ScienceFlowRunQuery>({ projectId: "project-1", sessionId: "session-1" }),
  ];

  for (const query of invalid) {
    const result = await queryWith({
      readSnapshot: recordingReader(
        { status: "ok", snapshot: snapshot() },
        calls,
      ),
    })(query);
    assert.deepEqual(result, { status: "invalid", reason: "query" });
  }
  assert.equal(calls.length, 0);
});
