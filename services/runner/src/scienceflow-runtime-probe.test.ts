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

import {
  parseScienceFlowRuntimeProbeAnswer,
  SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION,
} from "./scienceflow-runtime-probe.js";

const SITE = "/opt/science-env/lib/python3.11/site-packages";

function truncation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: false,
    site: false,
    pth: false,
    lines: false,
    names: false,
    text: false,
    distributions: false,
    budget: false,
    ...overrides,
  };
}

function python(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "3.11.9",
    prefix: "/opt/science-env",
    basePrefix: "/opt/science-env",
    noSite: true,
    noUserSite: true,
    dontWriteBytecode: true,
    ...overrides,
  };
}

function resolution(
  entry: string,
  scienceflow: Record<string, unknown> | null,
): Record<string, unknown> {
  return { entry, kind: "directory", symlinked: false, scienceflow };
}

/**
 * A complete schema-2 static answer. The program is the producer, and this is
 * the shape the Runner demands back; every field here is required.
 */
function staticFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION,
    ok: true,
    mode: "static",
    python: python(),
    venvConfig: false,
    basePath: [SITE],
    sitePackages: [SITE],
    effectivePath: [SITE, "/srv/scienceflow"],
    pth: [
      {
        path: `${SITE}/scienceflow.pth`,
        pathLines: ["/srv/scienceflow"],
        pathLineMissing: [false],
        importLines: 0,
        unreadable: false,
        tooLarge: false,
        notRegular: false,
        unsupportedEncoding: false,
        lines: 1,
        lineLimitExceeded: false,
      },
    ],
    distributions: [],
    resolutions: [
      resolution("/srv/scienceflow", { kind: "regular" }),
      resolution(SITE, null),
    ],
    hooks: [
      { entry: "/srv/scienceflow", sitecustomize: false, usercustomize: false },
      { entry: SITE, sitecustomize: false, usercustomize: false },
    ],
    truncation: truncation(),
    ...overrides,
  };
}

/** The second phase's answer: what a normal start actually got. */
function runtimeFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION,
    ok: true,
    mode: "runtime",
    python: python({ noSite: false }),
    path: [SITE, "/srv/scienceflow"],
    sitePackages: [SITE],
    resolutions: [
      resolution("/srv/scienceflow", { kind: "regular" }),
      resolution(SITE, null),
    ],
    distributions: [],
    startupHooks: { sitecustomize: false, usercustomize: false },
    truncation: truncation(),
    ...overrides,
  };
}

test("RT-PROBE-01 a static answer is read as a static inventory", () => {
  const parsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(staticFacts()),
    "static",
  );
  if (parsed.status !== "ok") assert.fail(`expected ok, got ${parsed.status}`);
  assert.equal(parsed.facts.mode, "static");
  if (parsed.facts.mode !== "static") assert.fail("mode not narrowed");
  assert.equal(parsed.facts.python.version, "3.11.9");
  assert.equal(parsed.facts.python.noSite, true);
  assert.equal(parsed.facts.effectivePath[1], "/srv/scienceflow");
  assert.equal(parsed.facts.pth[0]?.pathLines[0], "/srv/scienceflow");
  assert.equal(parsed.facts.pth[0]?.pathLineMissing[0], false);
  assert.equal(parsed.facts.pth[0]?.importLines, 0);
  assert.equal(parsed.facts.resolutions[0]?.scienceflow?.kind, "regular");
  assert.equal(parsed.facts.hooks[0]?.sitecustomize, false);
});

test("RT-PROBE-02 a runtime answer is read as the normal start's path", () => {
  const parsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(runtimeFacts()),
    "runtime",
  );
  if (parsed.status !== "ok") assert.fail(`expected ok, got ${parsed.status}`);
  assert.equal(parsed.facts.mode, "runtime");
  if (parsed.facts.mode !== "runtime") assert.fail("mode not narrowed");
  assert.equal(parsed.facts.python.noSite, false);
  assert.equal(parsed.facts.path[1], "/srv/scienceflow");
  assert.equal(parsed.facts.startupHooks.sitecustomize, false);
});

test("RT-PROBE-03 the probe's own failure answer carries no facts", () => {
  const failure = JSON.stringify({
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION,
    ok: false,
    failure: "unexpected",
  });
  assert.deepEqual(parseScienceFlowRuntimeProbeAnswer(failure, "static"), {
    status: "failed",
  });
  assert.deepEqual(parseScienceFlowRuntimeProbeAnswer(failure, "runtime"), {
    status: "failed",
  });
});

test("RT-PROBE-04 a static protocol difference is refused, never interpreted", () => {
  const cases: unknown[] = [
    "not json",
    "null",
    "[]",
    JSON.stringify(staticFacts({ schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION + 1 })),
    // A runtime answer returned for a static launch is the wrong phase.
    JSON.stringify({ ...runtimeFacts(), mode: "runtime" }),
    JSON.stringify(staticFacts({ mode: "runtime" })),
    JSON.stringify(staticFacts({ venvConfig: "no" })),
    JSON.stringify(staticFacts({ python: python({ version: "3.11" }) })),
    JSON.stringify(staticFacts({ python: python({ prefix: "relative" }) })),
    JSON.stringify(staticFacts({ python: python({ noSite: undefined }) })),
    JSON.stringify(staticFacts({ basePath: [1] })),
    JSON.stringify(staticFacts({ basePath: Array.from({ length: 65 }, () => "/a") })),
    JSON.stringify(staticFacts({ sitePackages: Array.from({ length: 9 }, () => "/a") })),
    JSON.stringify(staticFacts({ effectivePath: Array.from({ length: 65 }, () => "/a") })),
    JSON.stringify(staticFacts({ pth: Array.from({ length: 33 }, () => ({
      path: "/a/b.pth",
      pathLines: [],
      pathLineMissing: [],
      importLines: 0,
      unreadable: false,
      tooLarge: false,
      notRegular: false,
      unsupportedEncoding: false,
      lines: 0,
      lineLimitExceeded: false,
    })) })),
    JSON.stringify(staticFacts({ pth: [{
      path: "/a/b.pth",
      pathLines: Array.from({ length: 17 }, () => "/a"),
      pathLineMissing: Array.from({ length: 17 }, () => false),
      importLines: 0,
      unreadable: false,
      tooLarge: false,
      notRegular: false,
      unsupportedEncoding: false,
      lines: 17,
      lineLimitExceeded: true,
    }] })),
    JSON.stringify(staticFacts({ pth: [{
      path: "relative.pth",
      pathLines: [],
      pathLineMissing: [],
      importLines: 0,
      unreadable: false,
      tooLarge: false,
      notRegular: false,
      unsupportedEncoding: false,
      lines: 0,
      lineLimitExceeded: false,
    }] })),
    // Each path line needs its matching missing flag; a short list is a
    // protocol difference, not a fact set.
    JSON.stringify(staticFacts({ pth: [{
      path: "/a/b.pth",
      pathLines: ["/a"],
      pathLineMissing: [],
      importLines: 0,
      unreadable: false,
      tooLarge: false,
      notRegular: false,
      unsupportedEncoding: false,
      lines: 1,
      lineLimitExceeded: false,
    }] })),
    JSON.stringify(staticFacts({ pth: [{
      path: "/a/b.pth",
      pathLines: [],
      pathLineMissing: [],
      importLines: -1,
      unreadable: false,
      tooLarge: false,
      notRegular: false,
      unsupportedEncoding: false,
      lines: 0,
      lineLimitExceeded: false,
    }] })),
    JSON.stringify(staticFacts({ hooks: Array.from({ length: 65 }, () => ({
      entry: "/a",
      sitecustomize: false,
      usercustomize: false,
    })) })),
    JSON.stringify(staticFacts({ hooks: [{ entry: "/a", sitecustomize: false }] })),
    JSON.stringify(staticFacts({ hooks: [{ entry: "relative", sitecustomize: false, usercustomize: false }] })),
    JSON.stringify(staticFacts({ resolutions: [{ entry: "/a", kind: "nowhere", symlinked: false, scienceflow: null }] })),
    JSON.stringify(staticFacts({ resolutions: [{ entry: "/a", kind: "directory", symlinked: "no", scienceflow: null }] })),
    JSON.stringify(staticFacts({ resolutions: [{ entry: "/a", kind: "directory", symlinked: false, scienceflow: { kind: "package" } }] })),
    JSON.stringify(staticFacts({ truncation: truncation({ lines: undefined }) })),
    JSON.stringify(staticFacts({ truncation: truncation({ budget: "no" }) })),
    JSON.stringify(staticFacts({ distributions: Array.from({ length: 17 }, () => "x") })),
    JSON.stringify(staticFacts({ distributions: [1] })),
  ];
  for (const raw of cases) {
    assert.deepEqual(parseScienceFlowRuntimeProbeAnswer(String(raw), "static"), {
      status: "protocol-error",
    });
  }
});

test("RT-PROBE-05 a runtime protocol difference is refused", () => {
  const cases: unknown[] = [
    // The static answer is not a normal-start observation.
    JSON.stringify(staticFacts()),
    JSON.stringify(runtimeFacts({ mode: "static" })),
    JSON.stringify(runtimeFacts({ path: Array.from({ length: 65 }, () => "/a") })),
    JSON.stringify(runtimeFacts({ startupHooks: { sitecustomize: false } })),
    JSON.stringify(runtimeFacts({ startupHooks: { sitecustomize: "no", usercustomize: false } })),
    JSON.stringify(runtimeFacts({ truncation: truncation({ path: undefined }) })),
  ];
  for (const raw of cases) {
    assert.deepEqual(parseScienceFlowRuntimeProbeAnswer(String(raw), "runtime"), {
      status: "protocol-error",
    });
  }
});

test("RT-PROBE-06 truncation flags are read and preserved; refusing them is the classifier's job", () => {
  const parsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(runtimeFacts({ truncation: truncation({ pth: true, lines: true }) })),
    "runtime",
  );
  if (parsed.status !== "ok") assert.fail(`expected ok, got ${parsed.status}`);
  assert.equal(parsed.facts.truncation.pth, true);
  assert.equal(parsed.facts.truncation.lines, true);
  assert.equal(parsed.facts.truncation.path, false);
});

test("RT-PROBE-07 unknown fields are ignored, not trusted", () => {
  const staticParsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(staticFacts({ extra: { sourceRoot: "/etc" }, revision: "0".repeat(40) })),
    "static",
  );
  assert.equal(staticParsed.status, "ok");
  const runtimeParsed = parseScienceFlowRuntimeProbeAnswer(
    JSON.stringify(runtimeFacts({ extra: { sourceRoot: "/etc" } })),
    "runtime",
  );
  assert.equal(runtimeParsed.status, "ok");
});
