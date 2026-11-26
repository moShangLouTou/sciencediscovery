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
 * Execution-plan routes for ScienceFlow.
 *
 *   POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId
 *   POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/preflight
 *
 * Mounted behind the same `/api/` Bearer gate as every other route. The module
 * accepts business identity only; the create body is exactly `{profileId,
 * requestId}`. A blocked static check is a successful 200/422 answer carrying
 * fixed codes, never raw YAML, a host path, or an exception message. Internal
 * I/O and storage failures are 500s, kept apart from a blocked check.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { readJson } from "../http/body.js";
import { sendError, sendJson } from "../http/response.js";
import { hasRequestBody, isUsableIdentity } from "./http.js";
import type {
  ScienceFlowExecutionPlanIdentity,
  ScienceFlowExecutionPlanInput,
  ScienceFlowExecutionPlanService,
} from "./execution-plan.js";

export const SCIENCE_FLOW_EXECUTION_PLAN_LIST_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/?$/;
export const SCIENCE_FLOW_EXECUTION_PLAN_DETAIL_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/([^/]+)$/;
export const SCIENCE_FLOW_EXECUTION_PLAN_PREFLIGHT_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/plans\/([^/]+)\/preflight$/;

export async function handleScienceFlowExecutionPlanRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  plans: ScienceFlowExecutionPlanService,
): Promise<boolean> {
  const preflight = SCIENCE_FLOW_EXECUTION_PLAN_PREFLIGHT_PATH.exec(url.pathname);
  if (preflight) {
    await handlePreflight(request, response, url, preflight, plans);
    return true;
  }
  const detail = SCIENCE_FLOW_EXECUTION_PLAN_DETAIL_PATH.exec(url.pathname);
  if (detail) {
    await handleDetail(request, response, url, detail, plans);
    return true;
  }
  const list = SCIENCE_FLOW_EXECUTION_PLAN_LIST_PATH.exec(url.pathname);
  if (list) {
    await handleListOrCreate(request, response, url, list, plans);
    return true;
  }
  return false;
}

async function handleListOrCreate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  plans: ScienceFlowExecutionPlanService,
): Promise<void> {
  const identity = decodeIdentity(match, response);
  if (!identity) return;

  if (request.method === "GET") {
    if (hasRequestBody(request)) {
      invalid(response, "Request body is not supported");
      return;
    }
    const pagination = parsePagination(url, response);
    if (!pagination) return;
    const result = await plans.list(identity, pagination);
    switch (result.status) {
      case "ok":
        sendJson(response, 200, result.plans);
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

  if (request.method === "POST") {
    if (url.search.length > 0) {
      invalid(response, "Unsupported query parameter");
      return;
    }
    // Invalid JSON and an oversize body throw here; the API's central mapping
    // turns them into 400 / 413 rather than a plan.
    const input = parseCreateBody(await readJson<unknown>(request));
    if (!input) {
      invalid(response, "Invalid ScienceFlow execution plan body");
      return;
    }
    const result = await plans.create(identity, input);
    switch (result.status) {
      case "created":
        sendJson(response, 201, result.plan);
        return;
      case "existing":
        sendJson(response, 200, result.plan);
        return;
      case "conflict":
        // The request id belongs to a plan frozen from another profile. Two
        // profiles never merge into one plan.
        sendError(
          response,
          409,
          "ScienceFlow execution plan request conflicts with an existing plan",
          "SCIENCEFLOW_PLAN_CONFLICT",
        );
        return;
      case "not-found":
        notFound(response);
        return;
      case "disabled":
        disabled(response);
        return;
      case "invalid":
        invalid(response, "Invalid ScienceFlow execution plan identity");
        return;
      case "contract-invalid":
        sendError(
          response,
          422,
          "ScienceFlow execution plan contract is not supported",
          "SCIENCEFLOW_PLAN_CONTRACT_INVALID",
          { checks: result.checks },
        );
        return;
      case "corrupt":
        corrupt(response);
        return;
      case "internal-error":
        internal(response);
        return;
    }
  }

  response.setHeader("allow", "GET, POST");
  sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
}

async function handleDetail(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  plans: ScienceFlowExecutionPlanService,
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
  const result = await plans.get(identity, planId);
  switch (result.status) {
    case "ok":
      sendJson(response, 200, result.plan);
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

async function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  plans: ScienceFlowExecutionPlanService,
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
  // A preflight takes no body: the plan and its profile are already frozen.
  if (hasRequestBody(request)) {
    invalid(response, "Request body is not supported");
    return;
  }
  const planId = decodeSegment(match[3]);
  if (planId === undefined) {
    invalid(response, "Invalid ScienceFlow execution plan identity");
    return;
  }
  const result = await plans.preflight(identity, planId);
  switch (result.status) {
    case "ok":
      sendJson(response, 200, result.preflight);
      return;
    case "not-found":
      notFound(response);
      return;
    case "disabled":
      disabled(response);
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

/** The body is exactly `{ profileId, requestId }`; every other field is refused. */
function parseCreateBody(value: unknown): ScienceFlowExecutionPlanInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "profileId" || keys[1] !== "requestId") {
    return undefined;
  }
  const profileId = record.profileId;
  const requestId = record.requestId;
  if (typeof profileId !== "string" || !isUsableIdentity(profileId)) {
    return undefined;
  }
  if (typeof requestId !== "string" || !isUsableIdentity(requestId)) {
    return undefined;
  }
  return { profileId, requestId };
}

/** limit/offset only, each a non-negative safe integer; clamped by the service. */
function parsePagination(
  url: URL,
  response: ServerResponse,
): { limit?: number; offset?: number } | undefined {
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "offset") {
      invalid(response, "Unsupported query parameter");
      return undefined;
    }
  }
  const pagination: { limit?: number; offset?: number } = {};
  for (const key of ["limit", "offset"] as const) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    if (!/^\d+$/.test(raw)) {
      invalid(response, "Invalid ScienceFlow execution plan pagination");
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      invalid(response, "Invalid ScienceFlow execution plan pagination");
      return undefined;
    }
    pagination[key] = value;
  }
  return pagination;
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

function disabled(response: ServerResponse): void {
  sendError(
    response,
    503,
    "ScienceFlow execution plans are not configured",
    "SCIENCEFLOW_EXECUTION_DISABLED",
  );
}

function corrupt(response: ServerResponse): void {
  sendError(
    response,
    500,
    "Stored ScienceFlow execution plan is unreadable",
    "SCIENCEFLOW_PLAN_CORRUPT",
  );
}

function internal(response: ServerResponse): void {
  sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
}
