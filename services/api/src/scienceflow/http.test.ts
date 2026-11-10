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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ScienceFlowRunSnapshot } from "@sciencediscovery/scienceflow-reader";
import { handleScienceFlowRunSnapshotRequest } from "./http.js";
import type {
  ScienceFlowRunQuery,
  ScienceFlowRunSnapshotQueryResult,
  ScienceFlowRunSnapshotService,
} from "./run-snapshot.js";

const MARKER = "SYNTHETIC-SENSITIVE-MARKER-9f3b";
const SHA = "a".repeat(64);
const BASE = "http://localhost";
const PATH =
  "/api/projects/project-1/sessions/session-1/scienceflow/runs/run-1/snapshot";

function snapshot(
  overrides: Partial<ScienceFlowRunSnapshot> = {},
): ScienceFlowRunSnapshot {
  return {
    schemaVersion: 1,
    runId: "run-1",
    rawStatus: "running",
    phase: "research",
    tasks: [],
    diagnostics: [],
    ...overrides,
  };
}

interface Captured {
  statusCode: number;
  headers: Map<string, string>;
  body: string;
}

function fakeResponse(): { captured: Captured; response: ServerResponse } {
  const captured: Captured = { statusCode: 0, headers: new Map(), body: "" };
  const response = {
    setHeader(name: string, value: string | number) {
      captured.headers.set(name.toLowerCase(), String(value));
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      captured.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) {
        captured.headers.set(name.toLowerCase(), String(value));
      }
      return response;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) captured.body += body.toString();
    },
  };
  return { captured, response: response as unknown as ServerResponse };
}

function fakeRequest(
  method = "GET",
  headers: Record<string, string> = {},
): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function enabledService(
  result: ScienceFlowRunSnapshotQueryResult,
  calls: ScienceFlowRunQuery[],
): ScienceFlowRunSnapshotService {
  return {
    enabled: true,
    query: async (query) => {
      calls.push(query);
      return result;
    },
  };
}

async function call(
  service: ScienceFlowRunSnapshotService,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<{ handled: boolean; captured: Captured; body: Record<string, unknown> }> {
  const { captured, response } = fakeResponse();
  const handled = await handleScienceFlowRunSnapshotRequest(
    fakeRequest(options.method ?? "GET", options.headers ?? {}),
    response,
    new URL(`${BASE}${options.path ?? PATH}`),
    service,
  );
  return {
    handled,
    captured,
    body: captured.body ? JSON.parse(captured.body) : {},
  };
}

test("leaves every other path to the existing dispatcher", async () => {
  for (const path of [
    "/api/projects",
    "/api/projects/project-1/sessions/session-1/scienceflow/runs/run-1",
    // An empty segment is not this route; the caller still answers 404.
    "/api/projects//sessions/session-1/scienceflow/runs/run-1/snapshot",
  ]) {
    const calls: ScienceFlowRunQuery[] = [];
    const { handled, captured } = await call(
      enabledService({ status: "ok", snapshot: snapshot() }, calls),
      { path },
    );
    assert.equal(handled, false, path);
    assert.equal(captured.statusCode, 0, path);
    assert.equal(captured.body, "", path);
    assert.equal(calls.length, 0, path);
  }
});

test("rejects every method other than GET before reading", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const calls: ScienceFlowRunQuery[] = [];
    const { handled, captured, body } = await call(
      enabledService({ status: "ok", snapshot: snapshot() }, calls),
      { method },
    );
    assert.equal(handled, true, method);
    assert.equal(captured.statusCode, 405, method);
    assert.equal(captured.headers.get("allow"), "GET", method);
    assert.equal(body.code, "SCIENCEFLOW_METHOD_NOT_ALLOWED", method);
    assert.equal(calls.length, 0, method);
  }
});

test("refuses unsupported query and body parameters without reading", async () => {
  const cases: Array<{ readonly path?: string; readonly headers?: Record<string, string> }> = [
    { path: `${PATH}?path=%2Fetc%2Fpasswd` },
    { path: `${PATH}?pythonExecutable=%2Fbin%2Fsh` },
    { path: `${PATH}?timeoutMs=1` },
    { path: `${PATH}?allowedTaskRoots=%2F` },
    { headers: { "content-length": "12" } },
    { headers: { "transfer-encoding": "chunked" } },
  ];
  for (const options of cases) {
    const calls: ScienceFlowRunQuery[] = [];
    const { handled, captured, body } = await call(
      enabledService({ status: "ok", snapshot: snapshot() }, calls),
      options,
    );
    assert.equal(handled, true);
    assert.equal(captured.statusCode, 400, JSON.stringify(options));
    assert.equal(body.code, "SCIENCEFLOW_INVALID_REQUEST");
    assert.equal(calls.length, 0, JSON.stringify(options));
  }

  // `content-length: 0` announces nothing and is not a body.
  const calls: ScienceFlowRunQuery[] = [];
  const result = await call(
    enabledService({ status: "ok", snapshot: snapshot() }, calls),
    { headers: { "content-length": "0" } },
  );
  assert.equal(result.captured.statusCode, 200);
  assert.equal(calls.length, 1);
});

test("rejects malformed, structural, or blank identities with 400", async () => {
  const paths = [
    "/api/projects/%E0%A4%A/sessions/session-1/scienceflow/runs/run-1/snapshot",
    "/api/projects/project%2F1/sessions/session-1/scienceflow/runs/run-1/snapshot",
    "/api/projects/project-1/sessions/session%5C1/scienceflow/runs/run-1/snapshot",
    "/api/projects/%20/sessions/session-1/scienceflow/runs/run-1/snapshot",
    "/api/projects/project-1/sessions/session-1/scienceflow/runs/run%001/snapshot",
  ];
  for (const path of paths) {
    const calls: ScienceFlowRunQuery[] = [];
    const { handled, captured, body } = await call(
      enabledService({ status: "ok", snapshot: snapshot() }, calls),
      { path },
    );
    assert.equal(handled, true, path);
    assert.equal(captured.statusCode, 400, path);
    assert.equal(body.code, "SCIENCEFLOW_INVALID_REQUEST", path);
    assert.equal(calls.length, 0, path);
  }
});

test("answers 503 without reading when the feature is not configured", async () => {
  const { handled, captured, body } = await call({ enabled: false });
  assert.equal(handled, true);
  assert.equal(captured.statusCode, 503);
  assert.equal(body.code, "SCIENCEFLOW_READER_DISABLED");
  assert.equal(body.run, undefined);
});

test("projects a successful snapshot and marks the response non-cacheable", async () => {
  const calls: ScienceFlowRunQuery[] = [];
  const read = snapshot({
    tasks: [
      {
        taskRoot: `/srv/${MARKER}/tasks/task-a`,
        reportedBestMetric: {
          metricName: "accuracy",
          metricValue: 0.91,
          lowerIsBetter: false,
          source: "lhr_stage_performance",
          [MARKER]: { [MARKER]: MARKER },
        },
        candidateArtifact: {
          path: `/srv/${MARKER}/artifact.bin`,
          sha256: SHA,
          digestVerified: true,
          metricName: "accuracy",
          metricValue: 0.87,
          lowerIsBetter: false,
          stageId: "stage-1",
        },
        evidenceReferences: [`${MARKER}.csv`],
      },
    ],
    diagnostics: [
      { code: "no_eligible_candidate", message: MARKER, taskRoot: `/srv/${MARKER}` },
    ],
  });
  const { captured, body } = await call(
    enabledService({ status: "ok", snapshot: read }, calls),
  );

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers.get("cache-control"), "no-store");
  assert.equal(captured.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(captured.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(calls, [
    { projectId: "project-1", sessionId: "session-1", runId: "run-1" },
  ]);
  assert.deepEqual(body, {
    schemaVersion: 1,
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
          metric: { metricName: "accuracy", metricValue: 0.87, lowerIsBetter: false },
          stageId: "stage-1",
        },
      },
    ],
    diagnostics: [
      {
        code: "no_eligible_candidate",
        description: "The run records no eligible candidate.",
      },
    ],
  });
  assert.ok(!JSON.stringify(body).includes(MARKER));
});

test("maps every failure to its documented status, code, and static body", async () => {
  const cases: Array<{
    readonly label: string;
    readonly result: ScienceFlowRunSnapshotQueryResult;
    readonly status: number;
    readonly code: string;
  }> = [
    {
      label: "missing identity or binding",
      result: { status: "not-found", resource: "binding" },
      status: 404,
      code: "SCIENCEFLOW_RUN_NOT_FOUND",
    },
    {
      label: "invalid query",
      result: { status: "invalid", reason: "query" },
      status: 400,
      code: "SCIENCEFLOW_INVALID_REQUEST",
    },
    {
      label: "invalid configuration",
      result: { status: "invalid", reason: "configuration" },
      status: 500,
      code: "SCIENCEFLOW_CONFIGURATION_ERROR",
    },
    {
      label: "invalid binding",
      result: { status: "invalid", reason: "binding" },
      status: 500,
      code: "SCIENCEFLOW_BINDING_ERROR",
    },
    { label: "run mismatch", result: { status: "run-mismatch" }, status: 502, code: "SCIENCEFLOW_RUN_MISMATCH" },
    { label: "timeout", result: { status: "timeout", timeoutMs: 5_000 }, status: 504, code: "SCIENCEFLOW_READ_TIMEOUT" },
    { label: "spawn failed", result: { status: "spawn-failed", code: "ENOENT" }, status: 503, code: "SCIENCEFLOW_READER_UNAVAILABLE" },
    {
      label: "output limit",
      result: { status: "output-limit", limitBytes: 4, stream: "stdout" },
      status: 502,
      code: "SCIENCEFLOW_OUTPUT_LIMIT",
    },
    {
      label: "protocol error",
      result: { status: "protocol-error", reason: "invalid-json", exitCode: 0 },
      status: 502,
      code: "SCIENCEFLOW_PROTOCOL_ERROR",
    },
    { label: "internal error", result: { status: "internal-error" }, status: 500, code: "SCIENCEFLOW_INTERNAL_ERROR" },
  ];

  for (const item of cases) {
    const calls: ScienceFlowRunQuery[] = [];
    const { captured, body } = await call(enabledService(item.result, calls));
    assert.equal(captured.statusCode, item.status, item.label);
    assert.equal(body.code, item.code, item.label);
    assert.equal(typeof body.error, "string", item.label);
    assert.equal(body.run, undefined, item.label);
    assert.equal(body.tasks, undefined, item.label);
  }
});

test("keeps a failed read's diagnostics safe when it has no run identity", async () => {
  const calls: ScienceFlowRunQuery[] = [];
  const { captured, body } = await call(
    enabledService(
      {
        status: "reader-failed",
        exitCode: 2,
        signal: null,
        snapshot: snapshot({
          runId: null,
          diagnostics: [
            {
              code: "run_record_invalid_json",
              message: `${MARKER} at /srv/${MARKER}/control.json`,
              taskRoot: `/srv/${MARKER}/tasks/task-a`,
            },
            { code: "future_code", message: MARKER },
          ],
        }),
      },
      calls,
    ),
  );

  // The record is a read failure, not a business 404: the binding exists.
  assert.equal(captured.statusCode, 502);
  assert.equal(body.code, "SCIENCEFLOW_READ_FAILED");
  assert.deepEqual(body.details, {
    diagnostics: [
      { code: "run_record_invalid_json", description: "The run record is not valid JSON." },
      {
        code: "other",
        description: "The reader reported a condition this API does not classify.",
      },
    ],
  });
  assert.ok(!JSON.stringify(body).includes(MARKER));
});

test("passes the decoded business identity and re-queries every request", async () => {
  const calls: ScienceFlowRunQuery[] = [];
  const service = enabledService({ status: "ok", snapshot: snapshot() }, calls);

  const first = await call(service, {
    path: "/api/projects/%70roject-1/sessions/session%2D1/scienceflow/runs/run%2D1/snapshot",
  });
  const second = await call(service);

  assert.equal(first.captured.statusCode, 200);
  assert.deepEqual(calls, [
    { projectId: "project-1", sessionId: "session-1", runId: "run-1" },
    { projectId: "project-1", sessionId: "session-1", runId: "run-1" },
  ]);
  assert.deepEqual(first.body, second.body);
});
