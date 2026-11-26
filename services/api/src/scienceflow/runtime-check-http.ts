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
 * Runtime identity check routes for ScienceFlow execution plans.
 *
 *   POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/runtime-check
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/runtime-check
 *
 * Mounted behind the same `/api/` Bearer gate as every other route. Neither
 * method takes a body or a query: the plan freezes the declared revision and
 * the administrator's binding table freezes the Runner, environment, and
 * expected environment revision. A completed check that did not establish the
 * binding is a 200 carrying fixed codes, never raw probe output or an error.
 * A Runner that could not be reached is a 503 and persists nothing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendError, sendJson } from "../http/response.js";
import { hasRequestBody, isUsableIdentity } from "./http.js";
import type {
  ScienceFlowExecutionPlanIdentity,
} from "./execution-plan.js";
import type { ScienceFlowRuntimeCheckService } from "./runtime-check.js";

export const SCIENCE_FLOW_RUNTIME_CHECK_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/([^/]+)\/runtime-check$/;

export async function handleScienceFlowRuntimeCheckRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  checks: ScienceFlowRuntimeCheckService,
): Promise<boolean> {
  const match = SCIENCE_FLOW_RUNTIME_CHECK_PATH.exec(url.pathname);
  if (!match) return false;
  const identity = decodeIdentity(match, response);
  if (!identity) return true;
  const planId = decodeSegment(match[3]);
  if (planId === undefined) {
    invalid(response, "Invalid ScienceFlow execution plan identity");
    return true;
  }
  if (url.search.length > 0) {
    invalid(response, "Unsupported query parameter");
    return true;
  }
  if (hasRequestBody(request)) {
    invalid(response, "Request body is not supported");
    return true;
  }

  if (request.method === "GET") {
    const result = await checks.latest(identity, planId);
    switch (result.status) {
      case "ok":
        sendJson(response, 200, result.state);
        return true;
      case "not-found":
        notFound(response);
        return true;
      case "invalid":
        invalid(response, "Invalid ScienceFlow execution plan identity");
        return true;
      case "corrupt":
        corrupt(response);
        return true;
      case "internal-error":
        internal(response);
        return true;
    }
  }

  if (request.method === "POST") {
    const result = await checks.check(identity, planId);
    switch (result.status) {
      case "ok":
        sendJson(response, 200, result.check);
        return true;
      case "not-found":
        notFound(response);
        return true;
      case "disabled":
        sendError(
          response,
          503,
          "ScienceFlow runtime identity checks are not configured",
          "SCIENCEFLOW_RUNTIME_CHECK_DISABLED",
        );
        return true;
      case "runner-denied":
        sendError(
          response,
          409,
          "The Session does not allow the configured ScienceFlow Runner",
          "SCIENCEFLOW_RUNTIME_RUNNER_DENIED",
        );
        return true;
      case "invalid":
        invalid(response, "Invalid ScienceFlow execution plan identity");
        return true;
      case "unavailable":
        sendError(
          response,
          503,
          "ScienceFlow runtime identity check is unavailable",
          "SCIENCEFLOW_RUNTIME_CHECK_UNAVAILABLE",
        );
        return true;
      case "corrupt":
        corrupt(response);
        return true;
      case "internal-error":
        internal(response);
        return true;
    }
  }

  response.setHeader("allow", "GET, POST");
  sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
  return true;
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
    "Stored ScienceFlow runtime check is unreadable",
    "SCIENCEFLOW_RUNTIME_CORRUPT",
  );
}

function internal(response: ServerResponse): void {
  sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
}
