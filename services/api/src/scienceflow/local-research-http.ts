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
 * The Web conversation's read-only status and stop surface for the experimental
 * local research mode.
 *
 * These routes sit behind the normal `/api/` Bearer gate. They expose only the
 * operation's public view (no paths, interpreter, endpoint or credential), and
 * every lookup is scoped by the Session in the path: an operation id guessed
 * from another Session is simply not found. Starting research is still the
 * Agent's tool path; this module never starts a run.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendError, sendJson } from "../http/response.js";
import { hasRequestBody, isUsableIdentity } from "./http.js";
import {
  LocalResearchRefusal,
  type LocalResearchService,
  type ScienceFlowLocalResearchView,
} from "./local-research.js";

export const SCIENCE_FLOW_LOCAL_RESEARCH_PATH =
  /^\/api\/sessions\/([^/]+)\/research-operations(?:\/([^/]+)(?:\/(stop|delivery-retry))?)?$/;

/** The store surface these routes need. `SessionStore` satisfies it. */
export interface LocalResearchHttpStore {
  readonly getSession: (sessionId: string) => { readonly projectId: string } | undefined;
  readonly assertSessionWritable: (sessionId: string) => unknown;
}

/** The list response; `enabled: false` means this deployment has no mode. */
export interface LocalResearchOperationsResponse {
  readonly enabled: boolean;
  readonly profileId?: string;
  readonly inputMode?: "fixed" | "dynamic";
  readonly operations: readonly ScienceFlowLocalResearchView[];
}

/** Newest operations a list response carries; older records stay readable by id. */
const LIST_LIMIT = 20;

export async function handleScienceFlowLocalResearchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: LocalResearchService | undefined,
  store: LocalResearchHttpStore,
): Promise<boolean> {
  const match = SCIENCE_FLOW_LOCAL_RESEARCH_PATH.exec(url.pathname);
  if (!match) return false;

  if (url.search.length > 0) return invalidRequest(response, "Unsupported query parameter");
  const sessionId = decodeIdentity(match[1]);
  if (sessionId === undefined) return invalidRequest(response, "Invalid Session identity");
  const operationId = match[2] === undefined ? undefined : decodeIdentity(match[2]);
  if (operationId === undefined && match[2] !== undefined) {
    return invalidRequest(response, "Invalid research operation identity");
  }
  const action = match[3];
  const session = store.getSession(sessionId);
  if (!session) {
    sendError(response, 404, "Session not found", "LOCAL_RESEARCH_SESSION_NOT_FOUND");
    return true;
  }

  if (!service) {
    if (request.method === "GET" && operationId === undefined) {
      sendJson(response, 200, { enabled: false, operations: [] } satisfies LocalResearchOperationsResponse);
      return true;
    }
    sendError(response, 404, "Experimental local research is not enabled", "LOCAL_RESEARCH_DISABLED");
    return true;
  }

  try {
    if (request.method === "GET") {
      if (hasRequestBody(request)) return invalidRequest(response, "Request body is not supported");
      if (operationId === undefined) {
        const operations = service.list(session.projectId, sessionId);
        sendJson(response, 200, {
          enabled: true,
          inputMode: service.inputMode,
          operations: operations.slice(-LIST_LIMIT),
          profileId: service.profileId,
        } satisfies LocalResearchOperationsResponse);
        return true;
      }
      const operation = await service.get({ operationId, projectId: session.projectId, sessionId }, { waitMs: 0 });
      sendJson(response, 200, operation);
      return true;
    }

    if (request.method === "POST" && operationId !== undefined && action !== undefined) {
      if (hasRequestBody(request)) return invalidRequest(response, "Request body is not supported");
      // The scoped write guard in the main dispatcher sits after this handler,
      // so this route re-checks writability before it can stop an owned run or
      // republish its artifacts.
      try {
        store.assertSessionWritable(sessionId);
      } catch {
        sendError(response, 409, "This Session is read-only", "LOCAL_RESEARCH_READONLY");
        return true;
      }
      if (action === "stop") {
        const outcome = await service.stop({ operationId, projectId: session.projectId, sessionId });
        sendJson(response, 200, outcome);
        return true;
      }
      const operation = await service.retryDelivery({ operationId, projectId: session.projectId, sessionId });
      sendJson(response, 200, operation);
      return true;
    }

    response.setHeader("allow", operationId === undefined ? "GET" : "GET, POST");
    sendError(response, 405, "Method not allowed", "SCIENCEFLOW_METHOD_NOT_ALLOWED");
    return true;
  } catch (error) {
    if (error instanceof LocalResearchRefusal) {
      const { code, status } = refusalResponse(error.reason);
      sendError(response, status, error.message, code);
      return true;
    }
    sendError(response, 500, "Internal server error", "LOCAL_RESEARCH_INTERNAL_ERROR");
    return true;
  }
}

function refusalResponse(reason: LocalResearchRefusal["reason"]): { readonly code: string; readonly status: number } {
  switch (reason) {
    case "operation-not-found":
    case "operation-identity-mismatch":
      return { code: "LOCAL_RESEARCH_OPERATION_NOT_FOUND", status: 404 };
    case "project-not-found":
    case "session-not-found":
      return { code: "LOCAL_RESEARCH_SESSION_NOT_FOUND", status: 404 };
    case "session-not-writable":
      return { code: "LOCAL_RESEARCH_READONLY", status: 409 };
    case "mode-disabled":
      return { code: "LOCAL_RESEARCH_DISABLED", status: 404 };
    default:
      // An observation or delivery retry can still refuse because the run is
      // not in a state that supports it; the reason is a stable public code.
      return { code: "LOCAL_RESEARCH_REFUSED", status: 409 };
  }
}

function decodeIdentity(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return isUsableIdentity(decoded) ? decoded : undefined;
}

function invalidRequest(response: ServerResponse, message: string): true {
  sendError(response, 400, message, "SCIENCEFLOW_INVALID_REQUEST");
  return true;
}
