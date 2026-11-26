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
 * End-to-end proof of the read-only path without ScienceFlow itself: the real
 * Node adapter spawns the real Python CLI over synthetic run records in a
 * temporary directory, and the result is projected exactly as the HTTP route
 * projects it. No network, no engine, no research code.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createScienceFlowRunSnapshotQuery,
  type ScienceFlowRunBinding,
  type ScienceFlowRunQuery,
  type ScienceFlowRunSnapshotQueryResult,
} from "./run-snapshot.js";
import {
  projectScienceFlowDiagnostics,
  projectScienceFlowRunSnapshot,
} from "./dto.js";

const QUERY: ScienceFlowRunQuery = {
  projectId: "project-1",
  sessionId: "session-1",
  runId: "run-1",
};
const PYTHONS = ["/usr/bin/python3", "/usr/local/bin/python3"];
const READER_SCRIPT = fileURLToPath(
  new URL("../../../../services/scienceflow-reader/snapshot.py", import.meta.url),
);
const MARKER = "SYNTHETIC-SENSITIVE-MARKER-9f3b";

type ScienceFlowQuery = (
  query: ScienceFlowRunQuery,
) => Promise<ScienceFlowRunSnapshotQueryResult>;

function pythonExecutable(): string | undefined {
  return PYTHONS.find((candidate) => existsSync(candidate));
}

interface Fixture {
  readonly root: string;
  readonly taskRoot: string;
  readonly recordPath: string;
}

/**
 * A synthetic run directory. When `record` is omitted, control.json is not
 * written, so the real reader sees the same missing-record condition a
 * stopped or cleaned-up run produces. A function receives the fixture so the
 * record can name the fixture's own task root.
 */
async function withRun(
  python: string,
  record: string | ((fixture: Fixture) => string) | undefined,
  run: (fixture: Fixture, query: ScienceFlowQuery) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sfreader-integration-"));
  try {
    const taskRoot = join(root, "tasks", "task-a");
    mkdirSync(taskRoot, { recursive: true });
    const recordPath = join(root, "control.json");
    const fixture: Fixture = { root, taskRoot, recordPath };
    if (record !== undefined) {
      writeFileSync(
        recordPath,
        typeof record === "string" ? record : record(fixture),
      );
    }

    const binding: ScienceFlowRunBinding = {
      ...QUERY,
      runRecordPath: recordPath,
      allowedTaskRoots: [taskRoot],
    };
    const query = createScienceFlowRunSnapshotQuery({
      identities: {
        getProject: () => ({ id: QUERY.projectId }),
        getSession: () => ({ projectId: QUERY.projectId }),
      },
      resolveBinding: () => binding,
      readerConfig: {
        pythonExecutable: python,
        readerScriptPath: READER_SCRIPT,
        timeoutMs: 30_000,
      },
    });
    await run(fixture, query);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("reads a synthetic run through the real Node to Python CLI", async (t) => {
  const python = pythonExecutable();
  if (!python) {
    t.skip("python3 is not available on this host");
    return;
  }
  const record = (fixture: Fixture): string =>
    JSON.stringify({
      run_id: "run-1",
      status: "running",
      phase: "research",
      task_roots: [fixture.taskRoot],
    });

  await withRun(python, record, async (fixture, query) => {
    const before = readFileSync(fixture.recordPath, "utf8");
    const result = await query(QUERY);

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.snapshot.runId, "run-1");
    assert.equal(result.snapshot.rawStatus, "running");
    assert.equal(result.snapshot.phase, "research");
    assert.deepEqual(
      result.snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ["no_candidate_binding"],
    );

    const dto = projectScienceFlowRunSnapshot("run-1", result.snapshot);
    assert.deepEqual(dto, {
      schemaVersion: 1,
      run: { runId: "run-1", status: "running", phase: "research" },
      tasks: [{ taskIndex: 0, reportedMetric: null, candidate: null }],
      diagnostics: [
        {
          code: "no_candidate_binding",
          description: "The run records no candidate for this task.",
        },
      ],
    });
    assert.ok(!JSON.stringify(dto).includes(fixture.taskRoot));

    // Two reads of one run are identical, and neither the run record nor the
    // run directory was touched: no registration, import, or write.
    const again = await query(QUERY);
    assert.deepEqual(again, result);
    assert.equal(readFileSync(fixture.recordPath, "utf8"), before);
    assert.deepEqual(readdirSync(fixture.root).sort(), ["control.json", "tasks"]);
  });
});

test("a missing run record is a read failure with safe diagnostics", async (t) => {
  const python = pythonExecutable();
  if (!python) {
    t.skip("python3 is not available on this host");
    return;
  }
  await withRun(python, undefined, async (fixture, query) => {
    const result = await query(QUERY);

    // The binding exists, so this is never a business 404.
    assert.equal(result.status, "reader-failed");
    if (result.status !== "reader-failed") return;
    assert.equal(result.exitCode, 2);
    assert.equal(result.snapshot.runId, null);
    assert.deepEqual(
      result.snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ["run_record_missing"],
    );

    const diagnostics = projectScienceFlowDiagnostics(result.snapshot.diagnostics);
    assert.deepEqual(diagnostics, [
      { code: "run_record_missing", description: "The run record was not found." },
    ]);
    // The reader's message names the host path; the public note does not.
    assert.ok(!JSON.stringify(diagnostics).includes(fixture.root));
  });
});

test("a corrupt run record is a read failure, not a success", async (t) => {
  const python = pythonExecutable();
  if (!python) {
    t.skip("python3 is not available on this host");
    return;
  }
  await withRun(python, `{"run_id": "${MARKER}"`, async (_fixture, query) => {
    const result = await query(QUERY);

    assert.equal(result.status, "reader-failed");
    if (result.status !== "reader-failed") return;
    assert.equal(result.exitCode, 2);
    assert.equal(result.snapshot.runId, null);
    assert.deepEqual(
      result.snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ["run_record_invalid_json"],
    );

    const diagnostics = projectScienceFlowDiagnostics(result.snapshot.diagnostics);
    assert.deepEqual(diagnostics, [
      {
        code: "run_record_invalid_json",
        description: "The run record is not valid JSON.",
      },
    ]);
    assert.ok(!JSON.stringify(diagnostics).includes(MARKER));
  });
});

test("a real run record naming another run is rejected, not projected", async (t) => {
  const python = pythonExecutable();
  if (!python) {
    t.skip("python3 is not available on this host");
    return;
  }
  await withRun(
    python,
    (fixture) =>
      JSON.stringify({
        run_id: "run-other",
        status: "completed",
        phase: "finished",
        task_roots: [fixture.taskRoot],
      }),
    async (_fixture, query) => {
      assert.deepEqual(await query(QUERY), { status: "run-mismatch" });
    },
  );
});
