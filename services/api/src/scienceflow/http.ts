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
 * `GET /api/projects/:projectId/sessions/:sessionId/scienceflow/runs/:runId/snapshot`
 *
 * The route is mounted behind the existing `/api/` Bearer check; this module
 * never authenticates anything itself. It accepts business identity only:
 * unsupported query or body parameters are refused instead of being ignored,
 * so a caller can never try to override the interpreter or the paths. The
 * response is always the projected DTO or a static error body; the reader's
 * raw snapshot is never attached to an error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendError, sendJson } from "../http/response.js";
import {
  projectScienceFlowDiagnostics,
  projectScienceFlowRunSnapshot,
} from "./dto.js";
import type {
  ScienceFlowRunQuery,
  ScienceFlowRunSnapshotQueryResult,
  ScienceFlowRunSnapshotService,
} from "./run-snapshot.js";

/** Path shape of the one route this module owns. */
export const SCIENCE_FLOW_SNAPSHOT_PATH =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/scienceflow\/runs\/([^/]+)\/snapshot$/;

/**
 * Handle the request when it names this route. Returns false for every other
 * path so the caller's existing dispatch continues unchanged.
 */
export async function handleScienceFlowRunSnapshotRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: ScienceFlowRunSnapshotService,
): Promise<boolean> {
  const match = SCIENCE_FLOW_SNAPSHOT_PATH.exec(url.pathname);
  if (!match) return false;

  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
    return true;
  }
  // The request may carry identity only. Rejecting a stray parameter is
  // clearer than silently ignoring an attempt to override trusted settings.
  if (url.search.length > 0) {
    return invalidRequest(response, "Unsupported query parameter");
  }
  if (hasRequestBody(request)) {
    return invalidRequest(response, "Request body is not supported");
  }

  const identities: string[] = [];
  for (const segment of match.slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalidRequest(response, "Malformed URL encoding");
    }
    if (!isUsableIdentity(decoded)) {
      return invalidRequest(response, "Invalid ScienceFlow run identity");
    }
    identities.push(decoded);
  }
  const [projectId, sessionId, runId] = identities;
  if (projectId === undefined || sessionId === undefined || runId === undefined) {
    return invalidRequest(response, "Invalid ScienceFlow run identity");
  }

  if (!service.enabled) {
    sendError(
      response,
      503,
      "ScienceFlow run snapshots are not configured",
      "SCIENCEFLOW_READER_DISABLED",
    );
    return true;
  }

  const query: ScienceFlowRunQuery = { projectId, sessionId, runId };
  sendResult(response, runId, await service.query(query));
  return true;
}

export function sendResult(
  response: ServerResponse,
  runId: string,
  result: ScienceFlowRunSnapshotQueryResult,
): void {
  switch (result.status) {
    case "ok":
      sendJson(
        response,
        200,
        projectScienceFlowRunSnapshot(runId, result.snapshot),
      );
      return;
    case "not-found":
      // A missing Project, Session, binding, and a Session belonging to
      // another Project are one answer: this run is not reachable here.
      sendError(response, 404, "ScienceFlow run not found", "SCIENCEFLOW_RUN_NOT_FOUND");
      return;
    case "invalid":
      if (result.reason === "query") {
        invalidRequest(response, "Invalid ScienceFlow run identity");
        return;
      }
      // Defence in depth: the config was validated at construction, so this
      // means the trusted wiring itself is unusable.
      sendError(
        response,
        500,
        "ScienceFlow reader configuration is unusable",
        result.reason === "binding"
          ? "SCIENCEFLOW_BINDING_ERROR"
          : "SCIENCEFLOW_CONFIGURATION_ERROR",
      );
      return;
    case "run-mismatch":
      sendError(
        response,
        502,
        "The reader returned a different ScienceFlow run",
        "SCIENCEFLOW_RUN_MISMATCH",
      );
      return;
    case "reader-failed":
      sendError(
        response,
        502,
        "ScienceFlow snapshot read failed",
        "SCIENCEFLOW_READ_FAILED",
        // A failed read may have no run identity (missing or corrupt record).
        // Only the projected code and fixed description are exposed; the
        // reader's message and taskRoot stay server-side.
        { diagnostics: projectScienceFlowDiagnostics(result.snapshot.diagnostics) },
      );
      return;
    case "timeout":
      sendError(
        response,
        504,
        "ScienceFlow snapshot read timed out",
        "SCIENCEFLOW_READ_TIMEOUT",
      );
      return;
    case "spawn-failed":
      sendError(
        response,
        503,
        "ScienceFlow reader is unavailable",
        "SCIENCEFLOW_READER_UNAVAILABLE",
      );
      return;
    case "output-limit":
      sendError(
        response,
        502,
        "ScienceFlow reader exceeded its output limit",
        "SCIENCEFLOW_OUTPUT_LIMIT",
      );
      return;
    case "protocol-error":
      sendError(
        response,
        502,
        "ScienceFlow reader protocol error",
        "SCIENCEFLOW_PROTOCOL_ERROR",
      );
      return;
    case "internal-error":
      sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
      return;
    default:
      // An unexpected union member is a server defect, never a success.
      sendError(response, 500, "Internal server error", "SCIENCEFLOW_INTERNAL_ERROR");
  }
}

function invalidRequest(response: ServerResponse, message: string): true {
  sendError(response, 400, message, "SCIENCEFLOW_INVALID_REQUEST");
  return true;
}

/**
 * A GET route has no body. `content-length: 0` is harmless; anything that
 * announces bytes or chunked transfer is refused.
 */
export function hasRequestBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const raw = request.headers["content-length"];
  if (raw === undefined) return false;
  const length = Number(raw);
  return !Number.isFinite(length) || length > 0;
}

/**
 * Business ids are opaque lookup keys. A decoded path separator means the
 * caller encoded a structure the route does not have; whitespace and NUL are
 * never valid ids.
 */
export function isUsableIdentity(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}
