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

import type { ScienceFlowPreparedInputsDto } from "@sciencediscovery/schema";

import {
  handleScienceFlowPreparedInputsRequest,
} from "./prepared-inputs-http.js";
import type {
  ScienceFlowPrepareInputsResult,
  ScienceFlowPreparedInputsReadResult,
  ScienceFlowPrepareInputsService,
} from "./prepared-inputs.js";

const MARKER = "SYNTHETIC-INPUT-SECRET-MARKER-9c1e";
const BASE = "/api/projects/project-1/sessions/session-1/scienceflow/plans/plan-1";
const PREPARE_PATH = `${BASE}/prepare-inputs`;
const LATEST_PATH = `${BASE}/prepared-inputs`;

function receipt(): ScienceFlowPreparedInputsDto {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    contractDigest: "a".repeat(64),
    bundleDigest: "b".repeat(64),
    runnerId: "runner-1",
    preparedAt: "2026-11-13T00:00:00.000Z",
    outcome: "prepared",
    canStart: false,
    fileCount: 1,
    totalBytes: 9,
    files: [
      { role: "manifest", path: "manifest.yaml", size: 9, sha256: "c".repeat(64) },
    ],
    generation: 1,
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

function fakeRequest(options: {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
} = {}): IncomingMessage {
  const headers = { ...options.headers };
  if (options.body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body, "utf8"));
  }
  return {
    method: options.method ?? "GET",
    headers,
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body, "utf8");
    },
  } as unknown as IncomingMessage;
}

function fakeService(results: {
  readonly prepare?: ScienceFlowPrepareInputsResult;
  readonly latest?: ScienceFlowPreparedInputsReadResult;
}): ScienceFlowPrepareInputsService {
  return {
    async prepare() {
      return results.prepare ?? { status: "ok", prepared: receipt() };
    },
    async latest() {
      return (
        results.latest ?? { status: "ok", state: { planId: "plan-1", prepared: null } }
      );
    },
  };
}

async function dispatch(
  service: ScienceFlowPrepareInputsService,
  path: string,
  request: IncomingMessage,
): Promise<Captured> {
  const { captured, response } = fakeResponse();
  const handled = await handleScienceFlowPreparedInputsRequest(
    request,
    response,
    new URL(path, "http://localhost"),
    service,
  );
  assert.equal(handled, true);
  return captured;
}

test("PREP-H01 a completed preparation returns the whitelisted receipt", async () => {
  const captured = await dispatch(fakeService({}), PREPARE_PATH, fakeRequest({ method: "POST" }));
  assert.equal(captured.statusCode, 200);
  const body = JSON.parse(captured.body) as ScienceFlowPreparedInputsDto;
  assert.equal(body.planId, "plan-1");
  assert.equal(body.canStart, false);
  assert.equal(body.outcome, "prepared");
  assert.equal(captured.body.includes(MARKER), false);
  assert.equal(captured.body.includes("/srv/"), false);
});

test("PREP-H02 the read route serves local history, including none", async () => {
  const captured = await dispatch(fakeService({}), LATEST_PATH, fakeRequest());
  assert.equal(captured.statusCode, 200);
  assert.deepEqual(JSON.parse(captured.body), { planId: "plan-1", prepared: null });
});

test("PREP-H03 a blocked preparation is a 422 with fixed checks", async () => {
  const captured = await dispatch(
    fakeService({
      prepare: {
        status: "blocked",
        checks: [
          {
            code: "evaluator_file",
            status: "failed",
            description: "The evaluator entrypoint file exists inside the task package.",
          },
        ],
      },
    }),
    PREPARE_PATH,
    fakeRequest({ method: "POST" }),
  );
  assert.equal(captured.statusCode, 422);
  const body = JSON.parse(captured.body) as {
    error: string;
    code: string;
    details: { checks: Array<{ code: string }> };
  };
  assert.equal(body.code, "SCIENCEFLOW_INPUT_PREPARATION_BLOCKED");
  assert.deepEqual(
    body.details.checks.map((check) => check.code),
    ["evaluator_file"],
  );
});

test("PREP-H04 contract and Runner outcomes map to fixed statuses", async () => {
  const cases: Array<[ScienceFlowPrepareInputsResult, number, string | undefined]> = [
    [{ status: "contract-changed" }, 409, "SCIENCEFLOW_PLAN_CONTRACT_CHANGED"],
    [{ status: "disabled" }, 503, "SCIENCEFLOW_INPUT_PREPARATION_DISABLED"],
    [{ status: "runner-denied" }, 409, "SCIENCEFLOW_INPUT_PREPARATION_RUNNER_DENIED"],
    [{ status: "unavailable" }, 503, "SCIENCEFLOW_INPUT_PREPARATION_UNAVAILABLE"],
    [{ status: "not-found", resource: "plan" }, 404, "SCIENCEFLOW_PLAN_NOT_FOUND"],
    [{ status: "corrupt" }, 500, "SCIENCEFLOW_PREPARED_INPUTS_CORRUPT"],
    [{ status: "internal-error" }, 500, "SCIENCEFLOW_INTERNAL_ERROR"],
    [{ status: "invalid", reason: "query" }, 400, "SCIENCEFLOW_INVALID_REQUEST"],
  ];
  for (const [result, status, code] of cases) {
    const captured = await dispatch(
      fakeService({ prepare: result }),
      PREPARE_PATH,
      fakeRequest({ method: "POST" }),
    );
    assert.equal(captured.statusCode, status, JSON.stringify(result));
    const body = JSON.parse(captured.body) as { code?: string };
    assert.equal(body.code, code, JSON.stringify(result));
  }
});

test("PREP-H05 a preparation accepts no body, query, or other method", async () => {
  const withBody = await dispatch(
    fakeService({}),
    PREPARE_PATH,
    fakeRequest({ method: "POST", body: JSON.stringify({ runner: "local" }) }),
  );
  assert.equal(withBody.statusCode, 400);

  const query = await dispatch(
    fakeService({}),
    `${PREPARE_PATH}?runnerId=local`,
    fakeRequest({ method: "POST" }),
  );
  assert.equal(query.statusCode, 400);

  const wrongMethod = await dispatch(fakeService({}), PREPARE_PATH, fakeRequest());
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const writeAttempt = await dispatch(
    fakeService({}),
    LATEST_PATH,
    fakeRequest({ method: "POST" }),
  );
  assert.equal(writeAttempt.statusCode, 405);
  assert.equal(writeAttempt.headers.get("allow"), "GET");
});

test("PREP-H06 an undecodable identity is refused before the service", async () => {
  let calls = 0;
  const service: ScienceFlowPrepareInputsService = {
    async prepare() {
      calls += 1;
      return { status: "ok", prepared: receipt() };
    },
    async latest() {
      calls += 1;
      return { status: "ok", state: { planId: "plan-1", prepared: null } };
    },
  };
  const { captured, response } = fakeResponse();
  const handled = await handleScienceFlowPreparedInputsRequest(
    fakeRequest({ method: "POST" }),
    response,
    new URL("http://localhost/api/projects/%2F/sessions/session-1/scienceflow/plans/plan-1/prepare-inputs"),
    service,
  );
  assert.equal(handled, true);
  assert.equal(captured.statusCode, 400);
  assert.equal(calls, 0);
});
