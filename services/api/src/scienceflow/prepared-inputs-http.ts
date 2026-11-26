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
 * Input preparation routes for ScienceFlow execution plans.
 *
 *   POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/prepare-inputs
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/prepared-inputs
 *
 * Mounted behind the same `/api/` Bearer gate as every other route. Neither
 * method takes a body or a query: the plan freezes the contract, the profile
 * names the files, and the administrator's binding table names the Runner. A
 * completed preparation is a 200 carrying fixed digests and role summaries; a
 * changed contract is a 409 and an unreachable Runner a 503, each persisting
 * nothing. No raw file, host path, Runner layout, or remote error text leaves
 * the server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendError, sendJson } from "../http/response.js";
import { hasRequestBody, isUsableIdentity } from "./http.js";
import type { ScienceFlowExecutionPlanIdentity } from "./execution-plan.js";
import type { ScienceFlowPrepareInputsService } from "./prepared-inputs.js";

export const SCIENCE_FLOW_PREPARE_INPUTS_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/([^/]+)\/prepare-inputs$/;
export const SCIENCE_FLOW_PREPARED_INPUTS_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/([^/]+)\/prepared-inputs$/;

export async function handleScienceFlowPreparedInputsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  prepared: ScienceFlowPrepareInputsService,
): Promise<boolean> {
  const prepare = SCIENCE_FLOW_PREPARE_INPUTS_PATH.exec(url.pathname);
  if (prepare) {
    await handlePrepare(request, response, url, prepare, prepared);
    return true;
  }
  const latest = SCIENCE_FLOW_PREPARED_INPUTS_PATH.exec(url.pathname);
  if (latest) {
    await handleLatest(request, response, url, latest, prepared);
    return true;
  }
  return false;
}

async function handlePrepare(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  prepared: ScienceFlowPrepareInputsService,
): Promise<void> {
  const identity = decodeIdentity(match, response);
  if (!identity) return;
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
    return;
  }
  if (url.search.length > 0) {
    invalid(response, "Unsupported query parameter");
    return;
  }
  // A preparation takes no body: every input is already frozen or configured.
  if (hasRequestBody(request)) {
    invalid(response, "Request body is not supported");
    return;
  }
  const planId = decodeSegment(match[3]);
  if (planId === undefined) {
    invalid(response, "Invalid ScienceFlow execution plan identity");
    return;
  }
  const result = await prepared.prepare(identity, planId);
  switch (result.status) {
    case "ok":
      sendJson(response, 200, result.prepared);
      return;
    case "not-found":
      notFound(response);
      return;
    case "disabled":
      sendError(
        response,
        503,
        "ScienceFlow input preparation is not configured",
        "SCIENCEFLOW_INPUT_PREPARATION_DISABLED",
      );
      return;
    case "runner-denied":
      sendError(
        response,
        409,
        "The Session does not allow the configured ScienceFlow Runner",
        "SCIENCEFLOW_INPUT_PREPARATION_RUNNER_DENIED",
      );
      return;
    case "contract-changed":
      sendError(
        response,
        409,
        "The current ScienceFlow sources no longer match the frozen plan",
        "SCIENCEFLOW_PLAN_CONTRACT_CHANGED",
      );
      return;
    case "blocked":
      sendError(
        response,
        422,
        "ScienceFlow input preparation is blocked",
        "SCIENCEFLOW_INPUT_PREPARATION_BLOCKED",
        { checks: result.checks },
      );
      return;
    case "unavailable":
      sendError(
        response,
        503,
        "ScienceFlow input preparation is unavailable",
        "SCIENCEFLOW_INPUT_PREPARATION_UNAVAILABLE",
      );
      return;
    case "invalid":
      invalid(response, "Invalid ScienceFlow execution plan identity");
      return;
    case "corrupt":
      corrupt(response);
      return;
    case "internal-error":
      internal(response);
      return;
  }
}

async function handleLatest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  prepared: ScienceFlowPrepareInputsService,
): Promise<void> {
  const identity = decodeIdentity(match, response);
  if (!identity) return;
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
    return;
  }
  if (url.search.length > 0) {
    invalid(response, "Unsupported query parameter");
    return;
  }
  if (hasRequestBody(request)) {
    invalid(response, "Request body is not supported");
    return;
  }
  const planId = decodeSegment(match[3]);
  if (planId === undefined) {
    invalid(response, "Invalid ScienceFlow execution plan identity");
    return;
  }
  const result = await prepared.latest(identity, planId);
  switch (result.status) {
    case "ok":
      sendJson(response, 200, result.state);
      return;
    case "not-found":
      notFound(response);
      return;
    case "invalid":
      invalid(response, "Invalid ScienceFlow execution plan identity");
      return;
    case "corrupt":
      corrupt(response);
      return;
    case "internal-error":
      internal(response);
      return;
  }
}

function decodeIdentity(
  match: RegExpExecArray,
  response: ServerResponse,
): ScienceFlowExecutionPlanIdentity | undefined {
  const projectId = decodeSegment(match[1]);
  const sessionId = decodeSegment(match[2]);
  if (projectId === undefined || sessionId === undefined) {
    invalid(response, "Invalid ScienceFlow execution plan identity");
    return undefined;
  }
  return { projectId, sessionId };
}

function decodeSegment(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(raw);
    return isUsableIdentity(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function invalid(response: ServerResponse, message: string): void {
  sendError(response, 400, message, "SCIENCEFLOW_INVALID_REQUEST");
}

function notFound(response: ServerResponse): void {
  sendError(
    response,
    404,
    "ScienceFlow execution plan not found",
    "SCIENCEFLOW_PLAN_NOT_FOUND",
  );
}

function corrupt(response: ServerResponse): void {
  sendError(
    response,
    500,
    "Stored ScienceFlow prepared inputs are unreadable",
    "SCIENCEFLOW_PREPARED_INPUTS_CORRUPT",
  );
}

function internal(response: ServerResponse): void {
  sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
}
