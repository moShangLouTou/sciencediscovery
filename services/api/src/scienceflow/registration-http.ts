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
 * Registration routes for existing ScienceFlow managed runs.
 *
 *   POST /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId
 *   GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId/snapshot
 *
 * Mounted behind the same `/api/` Bearer gate as every other route. The module
 * accepts business identity only; a registration snapshot reuses the existing
 * run-snapshot query and projector, and `registrationId` is never treated as an
 * engine run id. Every failure is a static body with `cache-control: no-store`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { readJson } from "../http/body.js";
import { sendError, sendJson } from "../http/response.js";
import { hasRequestBody, isUsableIdentity, sendResult } from "./http.js";
import type { ScienceFlowRegistrationService } from "./registration.js";
import type { ScienceFlowRunSnapshotService } from "./run-snapshot.js";

export const SCIENCE_FLOW_REGISTRATION_LIST_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/registrations\/?$/;
export const SCIENCE_FLOW_REGISTRATION_DETAIL_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/registrations\/([^/]+)$/;
export const SCIENCE_FLOW_REGISTRATION_SNAPSHOT_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/registrations\/([^/]+)\/snapshot$/;

export async function handleScienceFlowRegistrationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  registrations: ScienceFlowRegistrationService,
  runSnapshots: ScienceFlowRunSnapshotService,
): Promise<boolean> {
  const snapshot = SCIENCE_FLOW_REGISTRATION_SNAPSHOT_PATH.exec(url.pathname);
  if (snapshot) {
    await handleSnapshot(request, response, url, snapshot, registrations, runSnapshots);
    return true;
  }
  const detail = SCIENCE_FLOW_REGISTRATION_DETAIL_PATH.exec(url.pathname);
  if (detail) {
    await handleDetail(request, response, url, detail, registrations);
    return true;
  }
  const list = SCIENCE_FLOW_REGISTRATION_LIST_PATH.exec(url.pathname);
  if (list) {
    await handleListOrCreate(request, response, url, list, registrations);
    return true;
  }
  return false;
}

async function handleListOrCreate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  registrations: ScienceFlowRegistrationService,
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
    const result = await registrations.list(identity, pagination);
    switch (result.status) {
      case "ok":
        sendJson(response, 200, result.registrations);
        return;
      case "not-found":
        notFound(response);
        return;
      case "invalid":
        invalid(response, "Invalid ScienceFlow registration identity");
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
    // turns them into 400 / 413 rather than a registration success.
    const input = parseCreateBody(await readJson<unknown>(request));
    if (!input) {
      invalid(response, "Invalid ScienceFlow run registration body");
      return;
    }
    const result = await registrations.create(identity, input.runId);
    switch (result.status) {
      case "created":
        sendJson(response, 201, result.registration);
        return;
      case "existing":
        sendJson(response, 200, result.registration);
        return;
      case "not-found":
        notFound(response);
        return;
      case "disabled":
        disabled(response);
        return;
      case "invalid":
        if (result.reason === "binding") {
          sendError(response, 500, "ScienceFlow binding configuration is unusable", "SCIENCEFLOW_BINDING_ERROR");
        } else {
          invalid(response, "Invalid ScienceFlow registration identity");
        }
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
  registrations: ScienceFlowRegistrationService,
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
  const registrationId = decodeSegment(match[3]);
  if (registrationId === undefined) {
    invalid(response, "Invalid ScienceFlow registration identity");
    return;
  }
  const result = await registrations.get(identity, registrationId);
  switch (result.status) {
    case "ok":
      sendJson(response, 200, result.registration);
      return;
    case "not-found":
      notFound(response);
      return;
    case "invalid":
      invalid(response, "Invalid ScienceFlow registration identity");
      return;
    case "corrupt":
      corrupt(response);
      return;
    case "internal-error":
      internal(response);
      return;
  }
}

async function handleSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  match: RegExpExecArray,
  registrations: ScienceFlowRegistrationService,
  runSnapshots: ScienceFlowRunSnapshotService,
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
  const registrationId = decodeSegment(match[3]);
  if (registrationId === undefined) {
    invalid(response, "Invalid ScienceFlow registration identity");
    return;
  }
  const found = await registrations.get(identity, registrationId);
  switch (found.status) {
    case "not-found":
      // A missing registration and one belonging to another Session are one
      // answer. A registration that exists but cannot be read is a different
      // answer below (503), never this 404.
      notFound(response);
      return;
    case "invalid":
      invalid(response, "Invalid ScienceFlow registration identity");
      return;
    case "corrupt":
      corrupt(response);
      return;
    case "internal-error":
      internal(response);
      return;
    case "ok":
      break;
  }

  if (!runSnapshots.enabled) {
    disabled(response);
    return;
  }
  const registration = found.registration;
  const result = await runSnapshots.query({
    projectId: identity.projectId,
    sessionId: identity.sessionId,
    // The registration's persisted run id, never the registrationId itself.
    runId: registration.runId,
  });
  if (result.status === "not-found" && result.resource === "binding") {
    // The registration exists but the admin's current binding for this run was
    // withdrawn. Metadata stays; the snapshot is explicitly unavailable.
    sendError(
      response,
      503,
      "ScienceFlow run registration snapshot is unavailable",
      "SCIENCEFLOW_REGISTRATION_SNAPSHOT_UNAVAILABLE",
    );
    return;
  }
  sendResult(response, registration.runId, result);
}

function decodeIdentity(
  match: RegExpExecArray,
  response: ServerResponse,
): { projectId: string; sessionId: string } | undefined {
  const projectId = decodeSegment(match[1]);
  const sessionId = decodeSegment(match[2]);
  if (projectId === undefined || sessionId === undefined) {
    invalid(response, "Invalid ScienceFlow registration identity");
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

/** The body is exactly `{ runId }`; every covering field is refused. */
function parseCreateBody(value: unknown): { runId: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "runId") return undefined;
  const runId = record.runId;
  if (typeof runId !== "string" || !isUsableIdentity(runId)) return undefined;
  return { runId };
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
      invalid(response, "Invalid ScienceFlow registration pagination");
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      invalid(response, "Invalid ScienceFlow registration pagination");
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
    "ScienceFlow run registration not found",
    "SCIENCEFLOW_REGISTRATION_NOT_FOUND",
  );
}

function disabled(response: ServerResponse): void {
  sendError(
    response,
    503,
    "ScienceFlow run registrations are not configured",
    "SCIENCEFLOW_READER_DISABLED",
  );
}

function corrupt(response: ServerResponse): void {
  sendError(
    response,
    500,
    "Stored ScienceFlow run registration is unreadable",
    "SCIENCEFLOW_REGISTRATION_CORRUPT",
  );
}

function internal(response: ServerResponse): void {
  sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
}
