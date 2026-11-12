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

import { parseScienceFlowRuntimeProbeAnswer } from "./scienceflow-runtime-probe.js";

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    python: {
      version: "3.11.9",
      prefix: "/opt/science-env",
      basePrefix: "/opt/science-env",
    },
    path: ["/opt/science-env/lib/python3.11/site-packages"],
    sitePackages: ["/opt/science-env/lib/python3.11/site-packages"],
    pth: [
      {
        path: "/opt/science-env/lib/python3.11/site-packages/scienceflow.pth",
        pathLines: ["/srv/scienceflow"],
        importLines: 0,
        unreadable: false,
      },
    ],
    distributions: [],
    packages: [{ entry: "/srv/scienceflow", regular: true, namespace: false }],
    startupHooks: { sitecustomize: false, usercustomize: false },
    ...overrides,
  };
}

test("RT-PROBE-01 a well-formed answer is read as facts", () => {
  const parsed = parseScienceFlowRuntimeProbeAnswer(JSON.stringify(facts()));
  if (parsed.status !== "ok") assert.fail(`expected ok, got ${parsed.status}`);
  assert.equal(parsed.facts.python.version, "3.11.9");
  assert.equal(parsed.facts.packages[0]?.entry, "/srv/scienceflow");
  assert.equal(parsed.facts.pth.length, 1);
  assert.equal(parsed.facts.pth[0]?.pathLines[0], "/srv/scienceflow");
});

test("RT-PROBE-02 the probe's own failure answer carries no facts", () => {
  assert.deepEqual(
    parseScienceFlowRuntimeProbeAnswer(JSON.stringify({ schemaVersion: 1, ok: false, failure: "unexpected" })),
    { status: "failed" },
  );
});

test("RT-PROBE-03 a protocol difference is refused, never interpreted", () => {
  const cases: unknown[] = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...facts(), schemaVersion: 2 }),
    JSON.stringify(facts({ python: { version: "3.11", prefix: "/opt", basePrefix: "/opt" } })),
    JSON.stringify(facts({ python: { version: "3.11.9", prefix: "relative", basePrefix: "/opt" } })),
    JSON.stringify(facts({ path: [1] })),
    JSON.stringify(facts({ path: Array.from({ length: 65 }, () => "/a") })),
    JSON.stringify(facts({ sitePackages: "none" })),
    JSON.stringify(facts({ pth: [{ path: "relative", pathLines: [], importLines: 0, unreadable: false }] })),
    JSON.stringify(facts({ pth: [{ path: "/a", pathLines: [], importLines: -1, unreadable: false }] })),
    JSON.stringify(facts({ pth: [{ path: "/a", pathLines: [], importLines: 0, unreadable: "no" }] })),
    JSON.stringify(facts({ packages: [{ entry: "relative", regular: true, namespace: false }] })),
    JSON.stringify(facts({ packages: [{ entry: "/a", regular: "yes", namespace: false }] })),
    JSON.stringify(facts({ startupHooks: { sitecustomize: false } })),
    JSON.stringify(facts({ distributions: [1] })),
  ];
  for (const raw of cases) {
    assert.deepEqual(parseScienceFlowRuntimeProbeAnswer(String(raw)), { status: "protocol-error" });
  }
});

test("RT-PROBE-04 unknown fields are ignored, not trusted", () => {
  const parsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(facts({ extra: { sourceRoot: "/etc" }, revision: "0".repeat(40) })),
  );
  assert.equal(parsed.status, "ok");
});
