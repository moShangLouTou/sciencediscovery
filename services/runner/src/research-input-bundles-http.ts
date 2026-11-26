// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { IncomingMessage, ServerResponse } from "node:http";
import { RESEARCH_INPUT_BUNDLE_LIMITS, type ApiError } from "@sciencediscovery/schema";
import { EXECUTION_TIMESTAMP_HEADER, EXECUTION_SIGNATURE_HEADER, verifyExecutionSignature } from "./request-auth.js";
import { ResearchInputBundleError, type RunnerResearchInputBundles } from "./research-input-bundles.js";

export interface ResearchBundleHttpOptions {
  readonly authToken: string;
  readonly store: RunnerResearchInputBundles;
  readonly prefix?: string;
  readonly label?: string;
  readonly codePrefix?: string;
  readonly maxBodyBytes?: number;
  readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer>;
  sendJson(response: ServerResponse, status: number, value: unknown): void;
  abortOnDisconnect<T>(response: ServerResponse, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
/** Shared transport; the enclosing Runner authenticates the request's bearer token. */
export async function handleResearchInputBundles(request: IncomingMessage, response: ServerResponse, url: URL,
  options: ResearchBundleHttpOptions): Promise<boolean> {
  const { store: inputBundles, readBytes, sendJson, abortOnDisconnect } = options;
  const prefix = options.prefix ?? "/research/input-bundles";
  const label = options.label ?? "Research";
  const codePrefix = options.codePrefix ?? "RESEARCH";
  const inputBundleMatch = url.pathname.startsWith(`${prefix}/`) ? /^([a-f0-9]{64})$/.exec(url.pathname.slice(prefix.length + 1)) : null;
      if (request.method === "GET" && inputBundleMatch) {
        // A read verifies the stored tree again and answers one fixed state:
        // ready, missing, or corrupt. It publishes nothing and names no path.
        try {
          sendJson(response, 200, await inputBundles.status(inputBundleMatch[1]!));
        } catch {
          sendJson(response, 500, {
            error: `${label} input bundle storage is unavailable`,
            code: `${codePrefix}_INPUT_BUNDLE_UNAVAILABLE`,
          } satisfies ApiError);
        }
        return true;
      }
      if (request.method === "POST" && url.pathname === prefix) {
        const bytes = await readBytes(request, options.maxBodyBytes ?? RESEARCH_INPUT_BUNDLE_LIMITS.maxBodyBytes);
        const body = bytes.toString("utf8");
        if (!verifyExecutionSignature(options.authToken, request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined,
          body, request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined)) {
          sendJson(response, 401, { error: "Invalid or expired execution signature" } satisfies ApiError);
          return true;
        }
        let bundle: unknown;
        try {
          bundle = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: `${label} input bundle body is not valid JSON`,
            code: `${codePrefix}_INPUT_BUNDLE_INVALID`,
          } satisfies ApiError);
          return true;
        }
        // The store re-derives the digest and every entry's bytes; the sender's
        // claim is never taken as verification.
        try {
          sendJson(response, 200, await abortOnDisconnect(response, (signal) => inputBundles.put(bundle, signal)));
        } catch (error) {
          if (!(error instanceof ResearchInputBundleError)) throw error;
          const answer = {
            invalid: [400, `${label} input bundle is invalid`, `${codePrefix}_INPUT_BUNDLE_INVALID`],
            corrupt: [409, `Stored ${label} input bundle is corrupt`, `${codePrefix}_INPUT_BUNDLE_CORRUPT`],
            unavailable: [500, `${label} input bundle storage is unavailable`, `${codePrefix}_INPUT_BUNDLE_UNAVAILABLE`],
          } as const;
          const [status, message, code] = answer[error.kind];
          sendJson(response, status, { error: message, code } satisfies ApiError);
        }
        return true;
      }
  return false;
}
