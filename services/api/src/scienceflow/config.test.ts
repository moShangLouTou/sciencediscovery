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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScienceFlowReaderConfig,
  SCIENCE_FLOW_READER_CONFIG_ENV,
  SCIENCE_FLOW_READER_CONFIG_MAX_BYTES,
  SCIENCE_FLOW_READER_TIMEOUT_MAX_MS,
  type ScienceFlowReaderSettings,
} from "./config.js";

const MARKER = "SYNTHETIC-SENSITIVE-MARKER-9f3b";

function binding(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    runRecordPath: "/srv/scienceflow/runs/run-1/control.json",
    allowedTaskRoots: ["/srv/scienceflow/runs/run-1/tasks/task-a"],
    ...overrides,
  };
}

function config(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reader: {
      pythonExecutable: "/opt/scienceflow/bin/python3",
      readerScriptPath: "/srv/scienceflow/reader/snapshot.py",
      timeoutMs: 5_000,
    },
    bindings: [binding()],
    ...overrides,
  };
}

/** Each test gets a private "repository root" holding the config file. */
function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sfreader-config-"));
  try {
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeConfig(root: string, value: unknown, name = "reader.json"): string {
  const path = join(root, name);
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

function load(root: string, name = "reader.json"): ScienceFlowReaderSettings | undefined {
  return loadScienceFlowReaderConfig(
    { [SCIENCE_FLOW_READER_CONFIG_ENV]: name } satisfies NodeJS.ProcessEnv,
    root,
  );
}

function assertConfigError(run: () => unknown, expectedFragment: string): Error {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error)) {
    assert.fail(`expected an error containing ${expectedFragment}`);
  }
  assert.ok(
    thrown.message.startsWith(`${SCIENCE_FLOW_READER_CONFIG_ENV}:`),
    thrown.message,
  );
  assert.ok(thrown.message.includes(expectedFragment), thrown.message);
  return thrown;
}

test("stays off when the environment variable is unset or blank", () => {
  assert.equal(loadScienceFlowReaderConfig({}, "/nonexistent"), undefined);
  assert.equal(
    loadScienceFlowReaderConfig(
      { [SCIENCE_FLOW_READER_CONFIG_ENV]: "" } satisfies NodeJS.ProcessEnv,
      "/nonexistent",
    ),
    undefined,
  );
  assert.equal(
    loadScienceFlowReaderConfig(
      { [SCIENCE_FLOW_READER_CONFIG_ENV]: "   " } satisfies NodeJS.ProcessEnv,
      "/nonexistent",
    ),
    undefined,
  );
});

test("loads a version 1 table and resolves only exact business identities", () => {
  withRoot((root) => {
    writeConfig(
      root,
      config({
        bindings: [
          binding(),
          binding({ sessionId: "session-2", runId: "run-2" }),
        ],
      }),
    );
    const settings = load(root);
    assert.ok(settings);
    assert.deepEqual(settings.reader, {
      pythonExecutable: "/opt/scienceflow/bin/python3",
      readerScriptPath: "/srv/scienceflow/reader/snapshot.py",
      timeoutMs: 5_000,
    });

    assert.deepEqual(
      settings.bindingFor({
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
      }),
      {
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
        runRecordPath: "/srv/scienceflow/runs/run-1/control.json",
        allowedTaskRoots: ["/srv/scienceflow/runs/run-1/tasks/task-a"],
      },
    );
    // A lookup is exact in all three parts: no prefix match, no reuse of a
    // Session's other run, no fallback across Projects.
    for (const query of [
      { projectId: "project-1", sessionId: "session-1", runId: "run-2" },
      { projectId: "project-1", sessionId: "project-1", runId: "run-1" },
      { projectId: "project", sessionId: "session-1", runId: "run-1" },
      { projectId: "project-1", sessionId: "session-1", runId: "run-1 " },
    ]) {
      assert.equal(settings.bindingFor(query), undefined, JSON.stringify(query));
    }
  });
});

test("resolves the config path against the repository root, not the cwd", () => {
  withRoot((root) => {
    mkdirSync(join(root, "conf"));
    writeConfig(root, config(), join("conf", "reader.json"));
    assert.ok(load(root, "conf/reader.json"));
  });
});

test("fails closed on a missing file, a directory, and an oversized file", () => {
  withRoot((root) => {
    assertConfigError(() => load(root, "absent.json"), "must name a readable file");
    mkdirSync(join(root, "dir.json"));
    assertConfigError(() => load(root, "dir.json"), "must name a regular file");

    writeFileSync(
      join(root, "big.json"),
      " ".repeat(SCIENCE_FLOW_READER_CONFIG_MAX_BYTES + 1),
    );
    assertConfigError(
      () => load(root, "big.json"),
      "must not exceed",
    );
  });
});

test("rejects unparsable JSON without echoing its content or the path", () => {
  withRoot((root) => {
    writeConfig(root, `{"schemaVersion": 1, "reader": "${MARKER}"`);
    const error = assertConfigError(() => load(root), "is not valid JSON");
    assert.ok(!error.message.includes(MARKER));
    assert.ok(!error.message.includes(root));
  });
});

test("rejects an unsupported schema version", () => {
  withRoot((root) => {
    writeConfig(root, config({ schemaVersion: 2 }));
    assertConfigError(() => load(root), "schemaVersion must be 1");
    writeConfig(root, config({ schemaVersion: undefined }));
    assertConfigError(() => load(root), "schemaVersion must be 1");
  });
});

test("rejects every invalid entry instead of using the remaining bindings", () => {
  const cases: Array<{ readonly label: string; readonly value: unknown; readonly fragment: string }> = [
    { label: "top-level array", value: [], fragment: "must be a JSON object" },
    { label: "unknown top-level key", value: config({ extra: true }), fragment: "the file has an unsupported key" },
    { label: "missing reader", value: config({ reader: undefined }), fragment: "reader must be an object" },
    {
      label: "unknown reader key",
      value: config({ reader: { ...(config().reader as object), cwd: "/tmp" } }),
      fragment: "reader has an unsupported key",
    },
    {
      label: "relative interpreter",
      value: config({ reader: { ...(config().reader as object), pythonExecutable: "python3" } }),
      fragment: "reader.pythonExecutable must be an absolute path",
    },
    {
      label: "relative script",
      value: config({ reader: { ...(config().reader as object), readerScriptPath: "./snapshot.py" } }),
      fragment: "reader.readerScriptPath must be an absolute path",
    },
    {
      label: "zero timeout",
      value: config({ reader: { ...(config().reader as object), timeoutMs: 0 } }),
      fragment: "reader.timeoutMs",
    },
    {
      label: "timer overflow",
      value: config({
        reader: { ...(config().reader as object), timeoutMs: SCIENCE_FLOW_READER_TIMEOUT_MAX_MS + 1 },
      }),
      fragment: "reader.timeoutMs",
    },
    {
      label: "fractional timeout",
      value: config({ reader: { ...(config().reader as object), timeoutMs: 1.5 } }),
      fragment: "reader.timeoutMs",
    },
    { label: "empty bindings", value: config({ bindings: [] }), fragment: "bindings must be a non-empty array" },
    { label: "non-array bindings", value: config({ bindings: {} }), fragment: "bindings must be a non-empty array" },
    { label: "empty project id", value: config({ bindings: [binding({ projectId: "  " })] }), fragment: "bindings[0].projectId" },
    { label: "missing run id", value: config({ bindings: [binding({ runId: undefined })] }), fragment: "bindings[0].runId" },
    {
      label: "relative record path",
      value: config({ bindings: [binding({ runRecordPath: "runs/run-1/control.json" })] }),
      fragment: "bindings[0].runRecordPath must be an absolute path",
    },
    {
      label: "NUL in record path",
      value: config({ bindings: [binding({ runRecordPath: "/srv/run\0/control.json" })] }),
      fragment: "bindings[0].runRecordPath must be an absolute path",
    },
    {
      label: "empty roots",
      value: config({ bindings: [binding({ allowedTaskRoots: [] })] }),
      fragment: "bindings[0].allowedTaskRoots must be a non-empty array",
    },
    {
      label: "blank root",
      value: config({ bindings: [binding({ allowedTaskRoots: [" "] })] }),
      fragment: "bindings[0].allowedTaskRoots[0] must be a non-empty absolute path",
    },
    {
      label: "relative root",
      value: config({ bindings: [binding({ allowedTaskRoots: ["tasks/task-a"] })] }),
      fragment: "bindings[0].allowedTaskRoots[0] must be an absolute path",
    },
    {
      label: "unknown binding key",
      value: config({ bindings: [binding({ timeoutMs: 10 })] }),
      fragment: "bindings[0] has an unsupported key",
    },
    {
      label: "duplicate identity",
      value: config({ bindings: [binding(), binding({ runRecordPath: "/srv/other/control.json" })] }),
      fragment: "bindings[1] repeats a bound business identity",
    },
  ];

  withRoot((root) => {
    for (const item of cases) {
      writeConfig(root, item.value);
      // The whole file is refused: one bad entry never leaves a partial table.
      assertConfigError(() => load(root), item.fragment);
    }
  });
});

test("names only the level of an unknown key, never the key itself", () => {
  withRoot((root) => {
    const cases: Array<{ readonly value: unknown; readonly fragment: string }> = [
      { value: config({ [MARKER]: true }), fragment: "the file has an unsupported key" },
      {
        value: config({ reader: { ...(config().reader as object), [MARKER]: "/tmp" } }),
        fragment: "reader has an unsupported key",
      },
      {
        value: config({ bindings: [binding({ [MARKER]: true })] }),
        fragment: "bindings[0] has an unsupported key",
      },
    ];
    for (const item of cases) {
      writeConfig(root, item.value);
      const error = assertConfigError(() => load(root), item.fragment);
      // A key name is file content like any other: it must not be echoed.
      assert.ok(!error.message.includes(MARKER), error.message);
      assert.ok(!error.message.includes(root));
    }
  });
});

test("never echoes a configured value in an error", () => {
  withRoot((root) => {
    writeConfig(root, config({ bindings: [binding({ runRecordPath: MARKER })] }));
    const error = assertConfigError(() => load(root), "must be an absolute path");
    assert.ok(!error.message.includes(MARKER));
    assert.ok(!error.message.includes(root));
  });
});
