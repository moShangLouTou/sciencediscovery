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
import { join, resolve } from "node:path";

import {
  SCIENCE_FLOW_RUNTIME_BINDING_ENV,
  SCIENCE_FLOW_RUNTIME_BINDING_MAX_BYTES,
  loadScienceFlowRuntimeBindings,
} from "./scienceflow-runtime-config.js";

const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  content: (root: string) => string,
): Promise<{ root: string; path: string }> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "runtime-binding-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const path = join(root, "binding.json");
  await writeFile(path, content(checkout), "utf8");
  return { root, path };
}

function binding(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindingId: "runner-binding-1",
    sourceRoot: root,
    expectedRevision: REVISION,
    ...overrides,
  };
}

function config(entry: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, bindings: [entry] });
}

function load(
  path: string,
  root = "/",
): ReturnType<typeof loadScienceFlowRuntimeBindings> {
  return loadScienceFlowRuntimeBindings(
    { [SCIENCE_FLOW_RUNTIME_BINDING_ENV]: path },
    root,
  );
}

function loadBindings(
  path: string,
  root = "/",
): NonNullable<ReturnType<typeof loadScienceFlowRuntimeBindings>> {
  const settings = load(path, root);
  if (settings === undefined) throw new Error("expected loaded bindings");
  return settings;
}

test("RT-BIND-01 an unset or blank variable disables the capability", () => {
  assert.equal(loadScienceFlowRuntimeBindings({}, "/"), undefined);
  assert.equal(
    loadScienceFlowRuntimeBindings(
      { [SCIENCE_FLOW_RUNTIME_BINDING_ENV]: "   " },
      "/",
    ),
    undefined,
  );
});

test("RT-BIND-02 a relative path resolves against the repository root", async (context) => {
  const { root, path } = await fixture(context, (checkout) => config(binding(checkout)));
  const settings = loadBindings(path, root);
  const loaded = settings.bindingFor("runner-binding-1");
  if (loaded === undefined) assert.fail("expected the configured binding");
  assert.equal(loaded.sourceRoot, join(root, "checkout"));
  assert.equal(loaded.expectedRevision, REVISION);
  // Exact lookup only.
  assert.equal(settings.bindingFor("runner-binding"), undefined);
  assert.equal(settings.bindingFor("runner-binding-1 "), undefined);
});

test("RT-BIND-03 an invalid file fails startup", async (context) => {
  const cases: Array<[(root: string) => string, RegExp]> = [
    [() => "{", /not valid JSON/],
    [() => '{"schemaVersion":2,"bindings":[]}', /schemaVersion must be 1/],
    [() => '{"schemaVersion":1,"bindings":[]}', /bindings must be a non-empty array/],
    [(root) => JSON.stringify({ schemaVersion: 1, bindings: [binding(root)], extra: 1 }), /unsupported key/],
    [(root) => config(binding(root, { unexpected: true })), /bindings\[0\] has an unsupported key/],
    [(root) => config(binding(root, { bindingId: "" })), /bindingId must be a non-empty string/],
    [(root) => config(binding(root, { bindingId: "b".repeat(129) })), /bindingId must not exceed 128 characters/],
    [(root) => config(binding(root, { bindingId: "b\0d" })), /bindingId must not contain NUL/],
    [(root) => config(binding(root, { sourceRoot: "relative/checkout" })), /sourceRoot must be an absolute path/],
    [(root) => config(binding(root, { sourceRoot: `${root}/absent` })), /sourceRoot must name an existing directory/],
    [(root) => config(binding(root, { expectedRevision: REVISION.toUpperCase() })), /40-character lowercase hex commit id/],
    [(root) => config(binding(root, { expectedRevision: "abc" })), /40-character lowercase hex commit id/],
  ];
  for (const [content, pattern] of cases) {
    const { path } = await fixture(context, content);
    assert.throws(() => load(path), pattern);
  }
});

test("RT-BIND-04 a repeated binding id is refused", async (context) => {
  const { path } = await fixture(context, (checkout) =>
    JSON.stringify({
      schemaVersion: 1,
      bindings: [binding(checkout), binding(checkout)],
    }),
  );
  assert.throws(() => load(path), /bindings\[1\] repeats a binding id/);
});

test("RT-BIND-05 the error never echoes a configured path or value", async (context) => {
  const marker = "SYNTHETIC-BINDING-MARKER";
  const { path } = await fixture(context, (checkout) =>
    config(binding(checkout, { sourceRoot: `${checkout}-${marker}`, [marker]: true })),
  );
  try {
    load(path);
    assert.fail("expected a startup failure");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /bindings\[0\] has an unsupported key/);
    assert.equal(message.includes(marker), false);
    assert.equal(message.includes(path), false);
  }
});

test("RT-BIND-06 the file size is bounded before parsing", async (context) => {
  const { path } = await fixture(context, () =>
    `{"schemaVersion":1,"bindings":[],"pad":"${"x".repeat(SCIENCE_FLOW_RUNTIME_BINDING_MAX_BYTES)}"}`,
  );
  assert.throws(() => load(path), /must not exceed/);
});

test("RT-BIND-07 a missing file or directory is a startup failure", async (context) => {
  const { root } = await fixture(context, (checkout) => config(binding(checkout)));
  assert.throws(() => load(join(root, "absent.json")), /must name a readable file/);
  assert.throws(() => load(root), /must name a regular file/);
});
