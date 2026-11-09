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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_SNAPSHOT_STDOUT_BYTES,
  readScienceFlowRunSnapshot,
  SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
  type ScienceFlowRunSnapshot,
} from "./index.js";

const READER_SCRIPT = fileURLToPath(
  new URL("../../../services/scienceflow-reader/snapshot.py", import.meta.url),
);

function sampleSnapshot(
  overrides: Partial<ScienceFlowRunSnapshot> = {},
): ScienceFlowRunSnapshot {
  return {
    schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    runId: "run-001",
    rawStatus: "running",
    phase: "research",
    tasks: [],
    diagnostics: [
      {
        code: "no_candidate_binding",
        message: "No best-stage manifest or stage-performance CSV found.",
        taskRoot: "/synthetic/task-001",
      },
    ],
    ...overrides,
  };
}

/** Write a Node script that stands in for the Python reader. */
async function writeStub(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, body, "utf8");
  return path;
}

function emitSnapshot(
  payload: unknown,
  exitCode: number,
  stderr = "",
): string {
  return [
    ...(stderr ? [`process.stderr.write(${JSON.stringify(stderr)});`] : []),
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});`,
    `process.exit(${exitCode});`,
  ].join("\n");
}

async function withTempDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scienceflow-reader-"));
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  return directory;
}

test("returns the snapshot when the reader exits 0 with valid JSON", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "ok.mjs",
    emitSnapshot(sampleSnapshot(), 0),
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.snapshot.runId, "run-001");
  assert.equal(result.snapshot.schemaVersion, SUPPORTED_SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(result.snapshot.diagnostics, sampleSnapshot().diagnostics);
});

test("keeps a structured failure as reader-failed with exit code 2", async (context) => {
  const directory = await withTempDirectory(context);
  const snapshot = sampleSnapshot({
    diagnostics: [
      {
        code: "run_record_invalid_json",
        message: "Run record is not valid JSON.",
      },
    ],
  });
  const stub = await writeStub(
    directory,
    "failed.mjs",
    emitSnapshot(snapshot, 2, "SUPER-SECRET-STDERR\n"),
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "reader-failed");
  if (result.status !== "reader-failed") return;
  assert.equal(result.exitCode, 2);
  assert.equal(result.signal, null);
  assert.deepEqual(result.snapshot.diagnostics, snapshot.diagnostics);
  assert.ok(!JSON.stringify(result).includes("SUPER-SECRET-STDERR"));
});

test("exit 0 with invalid JSON is a protocol error, not success", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "garbage.mjs",
    'process.stdout.write("not json\\n"); process.exit(0);',
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "protocol-error");
  if (result.status !== "protocol-error") return;
  assert.equal(result.reason, "invalid-json");
  assert.equal(result.exitCode, 0);
});

test("an unsupported schema version is a protocol error", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "future.mjs",
    emitSnapshot({ ...sampleSnapshot(), schemaVersion: 2 }, 0),
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "protocol-error");
  if (result.status !== "protocol-error") return;
  assert.equal(result.reason, "unsupported-schema-version");
});

test("a structurally invalid payload is a protocol error", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "shape.mjs",
    'process.stdout.write(JSON.stringify({ schemaVersion: 1, runId: "x", rawStatus: "running", phase: "research", tasks: "nope", diagnostics: [] })); process.exit(0);',
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "protocol-error");
  if (result.status !== "protocol-error") return;
  assert.equal(result.reason, "invalid-shape");
});

test("a missing interpreter is a spawn failure", async (context) => {
  const directory = await withTempDirectory(context);

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: join(directory, "missing-python"),
    readerScriptPath: join(directory, "reader.py"),
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "spawn-failed");
  if (result.status !== "spawn-failed") return;
  assert.equal(result.code, "ENOENT");
});

test("a reader that overruns its deadline is killed and reported as timeout", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "hang.mjs",
    "setInterval(() => {}, 1000);",
  );
  const startedAt = Date.now();

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 300,
  });

  assert.equal(result.status, "timeout");
  if (result.status !== "timeout") return;
  assert.equal(result.timeoutMs, 300);
  assert.ok(
    Date.now() - startedAt < 5_000,
    "the timed-out reader should be reaped promptly",
  );
});

test("an oversized stdout is killed and reported as an output limit", async (context) => {
  const directory = await withTempDirectory(context);
  const stub = await writeStub(
    directory,
    "flood.mjs",
    `process.stdout.write("x".repeat(${MAX_SNAPSHOT_STDOUT_BYTES + 1}), () => process.exit(0));`,
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: process.execPath,
    readerScriptPath: stub,
    runRecordPath: join(directory, "control.json"),
    allowedTaskRoots: [directory],
    timeoutMs: 20_000,
  });

  assert.equal(result.status, "output-limit");
  if (result.status !== "output-limit") return;
  assert.equal(result.stream, "stdout");
  assert.equal(result.limitBytes, MAX_SNAPSHOT_STDOUT_BYTES);
});

test("the real snapshot CLI satisfies the same contract", async (context) => {
  const directory = await withTempDirectory(context);
  const taskRoot = join(directory, "task-001");
  await mkdir(taskRoot, { recursive: true });
  const record = join(directory, "control.json");
  await writeFile(
    record,
    JSON.stringify({
      run_id: "run-real",
      status: "running",
      phase: "research",
      task_roots: [taskRoot],
    }),
    "utf8",
  );

  const result = await readScienceFlowRunSnapshot({
    pythonExecutable: "python3",
    readerScriptPath: READER_SCRIPT,
    runRecordPath: record,
    allowedTaskRoots: [taskRoot],
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.snapshot.schemaVersion, SUPPORTED_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(result.snapshot.runId, "run-real");
  assert.equal(result.snapshot.rawStatus, "running");
  assert.equal(result.snapshot.tasks.length, 1);
  assert.ok(
    result.snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === "no_candidate_binding",
    ),
  );
});
