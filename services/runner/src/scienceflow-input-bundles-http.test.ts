// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "node:http";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ScienceFlowInputBundleEntry,
  type ScienceFlowInputBundleRequest,
} from "@sciencediscovery/schema";

import {
  EXECUTION_SIGNATURE_HEADER,
  EXECUTION_TIMESTAMP_HEADER,
  createExecutionSignature,
} from "./request-auth.js";
import { createRunnerServer, loadRunnerConfig } from "./server.js";

const TOKEN = "test-token";
const CONTRACT = "a".repeat(64);
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function request(
  server: Server,
  method: string,
  path: string,
  options: { readonly body?: string; readonly token?: string; readonly sign?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const timestamp = String(Date.now());
  const body = options.body ?? "";
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? TOKEN}`,
  };
  if (body) {
    headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
    headers["content-type"] = "application/json";
    if (options.sign !== false) {
      headers[EXECUTION_SIGNATURE_HEADER] = createExecutionSignature(TOKEN, timestamp, body);
      headers[EXECUTION_TIMESTAMP_HEADER] = timestamp;
    }
  }
  return new Promise((resolvePromise) => {
    const incoming = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(body, "utf8");
      },
    };
    let status = 0;
    const response = {
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      setHeader() {
        /* the test reads the status and body only */
      },
      writeHead(code: number) {
        status = code;
      },
      end(text: string) {
        resolvePromise({ status, body: JSON.parse(text) as Record<string, unknown> });
      },
      once() {
        /* no disconnect signal in this harness */
      },
      on() {
        /* no disconnect signal in this harness */
      },
      removeListener() {
        /* no disconnect signal in this harness */
      },
    };
    server.emit("request", incoming, response);
  });
}

function entry(
  path: string,
  roles: ScienceFlowInputBundleEntry["roles"],
  content: string,
): ScienceFlowInputBundleEntry {
  return {
    path,
    roles,
    size: Buffer.byteLength(content),
    sha256: digest(Buffer.from(content, "utf8")),
    content: Buffer.from(content, "utf8").toString("base64"),
  };
}

function bundle(): ScienceFlowInputBundleRequest {
  const entries = [
    entry("manifest.yaml", ["manifest"], "manifest\n"),
    entry("package/description.md", ["description"], "description\n"),
    entry("package/evaluate.py", ["evaluator"], "def score():\n  return 0\n"),
    entry("package/task.yaml", ["task_yaml"], "id: t\n"),
  ];
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT,
    files: entries.map(({ content: _content, ...file }) => file),
  };
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: CONTRACT,
    bundleDigest: digest(
      Buffer.from(canonicalScienceFlowInputBundleManifest(manifest), "utf8"),
    ),
    entries,
  };
}

async function harness(context: {
  after(callback: () => Promise<void>): void;
}): Promise<{ server: Server; root: string }> {
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(process.cwd(), ".tmp", "runner-input-bundle-http-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const server = createRunnerServer({
    ...loadRunnerConfig(),
    authToken: TOKEN,
    bwrapPath: resolve(root, "missing"),
    dataDir: root,
    npuBrokerEnabled: false,
    sandboxProvider: "bubblewrap",
    scientificEnvsEnabled: false,
  });
  return { server, root };
}

test("BUNDLE-H01 a signed publication is stored and readable by digest", async (context) => {
  const { server } = await harness(context);
  const payload = bundle();
  const prepared = await request(server, "POST", "/scienceflow/input-bundles", {
    body: JSON.stringify(payload),
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.status, "ready");
  assert.equal(prepared.body.bundleDigest, payload.bundleDigest);
  assert.equal(prepared.body.contractDigest, CONTRACT);
  assert.equal(prepared.body.fileCount, 4);

  const status = await request(server, "GET", `/scienceflow/input-bundles/${payload.bundleDigest}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "ready");
  assert.equal(status.body.fileCount, 4);

  const absent = await request(server, "GET", `/scienceflow/input-bundles/${"b".repeat(64)}`);
  assert.equal(absent.status, 200);
  assert.equal(absent.body.status, "missing");
});

test("BUNDLE-H02 the route requires the Bearer token and a valid signature", async (context) => {
  const { server } = await harness(context);
  const payload = JSON.stringify(bundle());

  const unauthorized = await request(server, "POST", "/scienceflow/input-bundles", {
    body: payload,
    token: "wrong",
  });
  assert.equal(unauthorized.status, 401);

  const unsigned = await request(server, "POST", "/scienceflow/input-bundles", {
    body: payload,
    sign: false,
  });
  assert.equal(unsigned.status, 401);

  const readUnauthorized = await request(server, "GET", `/scienceflow/input-bundles/${"c".repeat(64)}`, {
    token: "wrong",
  });
  assert.equal(readUnauthorized.status, 401);
});

test("BUNDLE-H03 an invalid bundle is refused with a fixed code", async (context) => {
  const { server } = await harness(context);
  const payload = { ...bundle(), bundleDigest: "d".repeat(64) };
  const refused = await request(server, "POST", "/scienceflow/input-bundles", {
    body: JSON.stringify(payload),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "SCIENCEFLOW_INPUT_BUNDLE_INVALID");
  assert.equal("path" in refused.body, false);

  const notJson = await request(server, "POST", "/scienceflow/input-bundles", {
    body: "not json",
  });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.code, "SCIENCEFLOW_INPUT_BUNDLE_INVALID");
});
