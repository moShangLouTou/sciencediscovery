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
  SCIENCE_FLOW_EXECUTION_CONFIG_ENV,
  SCIENCE_FLOW_EXECUTION_CONFIG_MAX_BYTES,
  loadScienceFlowExecutionConfig,
} from "./execution-config.js";

const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  content: string,
): Promise<{ root: string; path: string }> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "execution-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "execution.json");
  await writeFile(path, content, "utf8");
  return { root, path };
}

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    profiles: [
      {
        profileId: "profile-1",
        scienceFlowRevision: REVISION,
        manifestPath: "/srv/task/manifest.yaml",
        taskPackageRoot: "/srv/task/opt_solver/circle-packing",
        allowedReadRoots: ["/srv/task"],
        ...overrides,
      },
    ],
  });
}

function load(path: string, root = "/"): ReturnType<typeof loadScienceFlowExecutionConfig> {
  return loadScienceFlowExecutionConfig(
    { [SCIENCE_FLOW_EXECUTION_CONFIG_ENV]: path },
    root,
  );
}

test("CFG-01 an unset or blank variable disables the feature", () => {
  assert.equal(loadScienceFlowExecutionConfig({}, "/"), undefined);
  assert.equal(
    loadScienceFlowExecutionConfig(
      { [SCIENCE_FLOW_EXECUTION_CONFIG_ENV]: "   " },
      "/",
    ),
    undefined,
  );
});

test("CFG-02 a relative path resolves against the repository root", async (context) => {
  const { root, path } = await fixture(context, config());
  const settings = load(path, root);
  if (settings === undefined) assert.fail("expected loaded settings");
  assert.equal(settings.profileFor("profile-1")?.manifestPath, "/srv/task/manifest.yaml");
  // The lookup is exact: no prefix, case, or path matching.
  assert.equal(settings.profileFor("profile"), undefined);
  assert.equal(settings.profileFor("profile-1 "), undefined);
});

test("CFG-03 an invalid file fails construction with a static message", async (context) => {
  const cases: Array<[string, RegExp]> = [
    ["{", /not valid JSON/],
    ['{"schemaVersion":2,"profiles":[]}', /schemaVersion must be 1/],
    ['{"schemaVersion":1,"profiles":[]}', /non-empty array/],
    [JSON.stringify({ schemaVersion: 1, profiles: [], extra: 1 }), /unsupported key/],
  ];
  for (const [content, pattern] of cases) {
    const { path } = await fixture(context, content);
    assert.throws(() => load(path), pattern);
  }
});

test("CFG-04 the error never echoes a key, value, or path", async (context) => {
  const marker = "SYNTHETIC-CONFIG-MARKER";
  const { path } = await fixture(
    context,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          profileId: "profile-1",
          scienceFlowRevision: REVISION,
          manifestPath: "/srv/task/manifest.yaml",
          taskPackageRoot: `/srv/${marker}`,
          allowedReadRoots: ["/srv/task"],
          [marker]: true,
        },
      ],
    }),
  );
  try {
    load(path);
    assert.fail("expected a construction failure");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /profiles\[0\] has an unsupported key/);
    assert.equal(message.includes(marker), false);
    assert.equal(message.includes("/srv"), false);
  }
});

test("CFG-05 a repeated profile id is refused", async (context) => {
  const entry = {
    profileId: "profile-1",
    scienceFlowRevision: REVISION,
    manifestPath: "/srv/a/manifest.yaml",
    taskPackageRoot: "/srv/a/task",
    allowedReadRoots: ["/srv/a"],
  };
  const { path } = await fixture(
    context,
    JSON.stringify({ schemaVersion: 1, profiles: [entry, entry] }),
  );
  assert.throws(() => load(path), /repeats a profile id/);
});

test("CFG-06 every profile field is validated narrowly", async (context) => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ profileId: "" }, /profileId must be a non-empty string/],
    [{ scienceFlowRevision: REVISION.toUpperCase() }, /40-character lowercase hex/],
    [{ scienceFlowRevision: "abc" }, /40-character lowercase hex/],
    [{ manifestPath: "manifest.yaml" }, /manifestPath must be an absolute path/],
    [{ taskPackageRoot: "task" }, /taskPackageRoot must be an absolute path/],
    [{ allowedReadRoots: [] }, /allowedReadRoots must be a non-empty array/],
    [{ allowedReadRoots: ["relative"] }, /allowedReadRoots\[0\] must be an absolute path/],
    [{ manifestPath: "/srv/a\0b" }, /manifestPath must be an absolute path/],
    [{ unexpected: true }, /has an unsupported key/],
  ];
  for (const [overrides, pattern] of cases) {
    const { path } = await fixture(context, config(overrides));
    assert.throws(() => load(path), pattern);
  }
});

test("CFG-07 file-level limits are enforced before parsing", async (context) => {
  const padding = "x".repeat(SCIENCE_FLOW_EXECUTION_CONFIG_MAX_BYTES);
  const { path } = await fixture(context, `{"schemaVersion":1,"profiles":[],"pad":"${padding}"}`);
  assert.throws(() => load(path), /must not exceed/);
});

test("CFG-08 a missing file or directory is a construction failure", async (context) => {
  const { root } = await fixture(context, config());
  assert.throws(() => load(join(root, "absent.json")), /must name a readable file/);
  assert.throws(() => load(root), /must name a regular file/);
});
