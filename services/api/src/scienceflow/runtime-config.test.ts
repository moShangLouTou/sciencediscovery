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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS,
  SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS,
  SCIENCE_FLOW_RUNTIME_CHECK_MIN_TIMEOUT_MS,
  SCIENCE_FLOW_RUNTIME_CONFIG_ENV,
  SCIENCE_FLOW_RUNTIME_CONFIG_MAX_BYTES,
  loadScienceFlowRuntimeConfig,
} from "./runtime-config.js";

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  content: string,
): Promise<{ root: string; path: string }> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "runtime-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "runtime.json");
  await writeFile(path, content, "utf8");
  return { root, path };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindingId: "binding-1",
    runnerId: "runner-1",
    runnerBindingId: "runner-binding-1",
    environmentId: "environment-1",
    expectedEnvironmentRevisionId: "revision-1",
    ...overrides,
  };
}

function config(...bindings: Record<string, unknown>[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    bindings: bindings.length === 0 ? [binding()] : bindings,
  });
}

function load(
  path: string,
  root = "/",
): ReturnType<typeof loadScienceFlowRuntimeConfig> {
  return loadScienceFlowRuntimeConfig(
    { [SCIENCE_FLOW_RUNTIME_CONFIG_ENV]: path },
    root,
  );
}

function loadSettings(
  path: string,
  root = "/",
): NonNullable<ReturnType<typeof loadScienceFlowRuntimeConfig>> {
  const settings = load(path, root);
  if (settings === undefined) throw new Error("expected loaded settings");
  return settings;
}

test("RT-CFG-01 an unset or blank variable disables the feature", () => {
  assert.equal(loadScienceFlowRuntimeConfig({}, "/"), undefined);
  assert.equal(
    loadScienceFlowRuntimeConfig(
      { [SCIENCE_FLOW_RUNTIME_CONFIG_ENV]: "   " },
      "/",
    ),
    undefined,
  );
});

test("RT-CFG-02 a relative path resolves against the repository root", async (context) => {
  const { root, path } = await fixture(context, config());
  const settings = loadSettings(path, root);
  const loaded = settings.bindingFor("binding-1");
  if (loaded === undefined) assert.fail("expected the configured binding");
  assert.equal(loaded.environmentId, "environment-1");
  assert.equal(loaded.timeoutMs, SCIENCE_FLOW_RUNTIME_CHECK_DEFAULT_TIMEOUT_MS);
  // The lookup is exact: no prefix, case, or trimming.
  assert.equal(settings.bindingFor("binding"), undefined);
  assert.equal(settings.bindingFor("binding-1 "), undefined);
  assert.equal(settings.has("binding-1"), true);
  assert.equal(settings.has("binding-2"), false);
});

test("RT-CFG-03 the optional transport timeout is bounded", async (context) => {
  const accepted = await fixture(
    context,
    config(binding({ timeoutMs: SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS })),
  );
  assert.equal(
    loadSettings(accepted.path).bindingFor("binding-1")?.timeoutMs,
    SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS,
  );
  const rejected: Array<[unknown, RegExp]> = [
    [SCIENCE_FLOW_RUNTIME_CHECK_MIN_TIMEOUT_MS - 1, /timeoutMs must be an integer/],
    [SCIENCE_FLOW_RUNTIME_CHECK_MAX_TIMEOUT_MS + 1, /timeoutMs must be an integer/],
    [1.5, /timeoutMs must be an integer/],
    ["2000", /timeoutMs must be an integer/],
  ];
  for (const [timeoutMs, pattern] of rejected) {
    const { path } = await fixture(context, config(binding({ timeoutMs })));
    assert.throws(() => load(path), pattern);
  }
});

test("RT-CFG-04 an invalid file fails the whole load", async (context) => {
  const cases: Array<[string, RegExp]> = [
    ["{", /not valid JSON/],
    ['{"schemaVersion":2,"bindings":[]}', /schemaVersion must be 1/],
    ['{"schemaVersion":1,"bindings":[]}', /bindings must be a non-empty array/],
    ['{"schemaVersion":1}', /bindings must be a non-empty array/],
    [JSON.stringify({ schemaVersion: 1, bindings: [binding()], extra: 1 }), /unsupported key/],
    [JSON.stringify({ schemaVersion: 1, bindings: [binding({ unexpected: true })] }), /bindings\[0\] has an unsupported key/],
    [JSON.stringify("bindings"), /must be a JSON object/],
  ];
  for (const [content, pattern] of cases) {
    const { path } = await fixture(context, content);
    assert.throws(() => load(path), pattern);
  }
});

test("RT-CFG-05 every binding field is validated narrowly", async (context) => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ bindingId: "" }, /bindingId must be a non-empty string/],
    [{ bindingId: "   " }, /bindingId must be a non-empty string/],
    [{ runnerId: 1 }, /runnerId must be a non-empty string/],
    [{ runnerBindingId: `${"r".repeat(161)}` }, /runnerBindingId must not exceed 160 characters/],
    [{ environmentId: `${"e".repeat(161)}` }, /environmentId must not exceed 160 characters/],
    [
      { expectedEnvironmentRevisionId: `${"e".repeat(161)}` },
      /expectedEnvironmentRevisionId must not exceed 160 characters/,
    ],
    [{ bindingId: `${"b".repeat(201)}` }, /bindingId must not exceed 200 characters/],
    [{ environmentId: "environment\0-1" }, /must not contain NUL/],
    [{ runnerBindingId: "" }, /runnerBindingId must be a non-empty string/],
    [{ expectedEnvironmentRevisionId: "" }, /expectedEnvironmentRevisionId must be a non-empty string/],
  ];
  for (const [overrides, pattern] of cases) {
    const { path } = await fixture(context, config(binding(overrides)));
    assert.throws(() => load(path), pattern);
  }
});

test("RT-CFG-06 a repeated binding id is refused", async (context) => {
  const { path } = await fixture(context, config(binding(), binding()));
  assert.throws(() => load(path), /bindings\[1\] repeats a binding id/);
});

test("RT-CFG-07 the error never echoes a configured value or path", async (context) => {
  const marker = "SYNTHETIC-RUNTIME-MARKER";
  const { path } = await fixture(
    context,
    config(binding({ environmentId: `/srv/${marker}`, [marker]: true })),
  );
  try {
    load(path);
    assert.fail("expected a construction failure");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /bindings\[0\] has an unsupported key/);
    assert.equal(message.includes(marker), false);
    assert.equal(message.includes("/srv"), false);
    assert.equal(message.includes(path), false);
  }
});

test("RT-CFG-08 file-level limits are enforced before parsing", async (context) => {
  const padding = "x".repeat(SCIENCE_FLOW_RUNTIME_CONFIG_MAX_BYTES);
  const { path } = await fixture(context, `{"schemaVersion":1,"bindings":[],"pad":"${padding}"}`);
  assert.throws(() => load(path), /must not exceed/);
});

test("RT-CFG-09 a missing file or directory is a construction failure", async (context) => {
  const { root } = await fixture(context, config());
  assert.throws(() => load(join(root, "absent.json")), /must name a readable file/);
  assert.throws(() => load(root), /must name a regular file/);
});
