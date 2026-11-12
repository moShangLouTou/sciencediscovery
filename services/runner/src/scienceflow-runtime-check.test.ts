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
  SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
  type ScienceFlowRuntimeCheckCode,
} from "@sciencediscovery/schema";
import type { EngineRevisionCheckResult } from "@sciencediscovery/scienceflow-reader";

import {
  classifyProbeFacts,
  parseScienceFlowRuntimeProbeRequest,
} from "./scienceflow-runtime-check.js";
import type { ScienceFlowRuntimeProbeFacts as ProbeFacts } from "./scienceflow-runtime-probe.js";

const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";
const SOURCE_ROOT = "/srv/scienceflow";
const PREFIX = "/opt/science-env";
const SITE_PACKAGES = `${PREFIX}/lib/python3.11/site-packages`;

function facts(overrides: Partial<ProbeFacts> = {}): ProbeFacts {
  return {
    python: { version: "3.11.9", prefix: PREFIX, basePrefix: PREFIX },
    path: [SITE_PACKAGES, SOURCE_ROOT],
    sitePackages: [SITE_PACKAGES],
    pth: [
      {
        path: `${SITE_PACKAGES}/scienceflow.pth`,
        pathLines: [SOURCE_ROOT],
        importLines: 0,
        unreadable: false,
      },
    ],
    distributions: [],
    packages: [{ entry: SOURCE_ROOT, regular: true, namespace: false }],
    startupHooks: { sitecustomize: false, usercustomize: false },
    ...overrides,
  };
}

function clean(): EngineRevisionCheckResult {
  return {
    status: "verified-clean",
    revision: REVISION,
    dirty: false,
    reason: null,
    trackedModified: false,
    untrackedRunnable: false,
  };
}

function revision(
  status: EngineRevisionCheckResult["status"],
  overrides: Partial<EngineRevisionCheckResult> = {},
): EngineRevisionCheckResult | null {
  return {
    status,
    revision: REVISION,
    dirty: false,
    reason: null,
    trackedModified: false,
    untrackedRunnable: false,
    ...overrides,
  };
}

function classify(
  overrides: {
    readonly facts?: ProbeFacts;
    readonly revisionCheck?: EngineRevisionCheckResult | null;
    readonly languageVersion?: string;
  } = {},
): ReturnType<typeof classifyProbeFacts> {
  return classifyProbeFacts({
    environmentPrefix: PREFIX,
    facts: overrides.facts ?? facts(),
    languageVersion: overrides.languageVersion ?? "3.11",
    revisionCheck: "revisionCheck" in overrides ? overrides.revisionCheck ?? null : clean(),
    sourceRoot: SOURCE_ROOT,
  });
}

function status(overrides: ReturnType<typeof classify>, code: ScienceFlowRuntimeCheckCode) {
  return overrides.overrides[code];
}

test("RT-CLASS-01 a trusted clean checkout at the declared revision is verified", () => {
  const classified = classify();
  assert.equal(classified.outcome, "verified");
  assert.equal(classified.sourceKind, "git-checkout");
  assert.equal(classified.revision, REVISION);
  assert.equal(status(classified, "source_root"), "passed");
  assert.equal(status(classified, "source_revision"), "passed");
  assert.equal(status(classified, "source_cleanliness"), "passed");
  assert.equal(status(classified, "package_resolution"), "passed");
  assert.equal(status(classified, "startup_hooks"), "passed");
  assert.equal(status(classified, "duplicate_distribution"), "unknown");
});

test("RT-CLASS-02 a revision mismatch or a dirty checkout blocks", () => {
  const mismatch = classify({
    revisionCheck: revision("revision-mismatch", { revision: "1".repeat(40) }),
  });
  assert.equal(mismatch.outcome, "blocked");
  assert.equal(status(mismatch, "source_revision"), "failed");
  assert.equal(status(mismatch, "source_cleanliness"), "passed");
  assert.equal(mismatch.revision, "1".repeat(40));

  const dirty = classify({
    revisionCheck: revision("dirty", { dirty: true, trackedModified: true }),
  });
  assert.equal(dirty.outcome, "blocked");
  assert.equal(status(dirty, "source_revision"), "passed");
  assert.equal(status(dirty, "source_cleanliness"), "failed");

  const both = classify({
    revisionCheck: revision("revision-mismatch", {
      revision: "1".repeat(40),
      dirty: true,
      untrackedRunnable: true,
    }),
  });
  assert.equal(both.outcome, "blocked");
  assert.equal(status(both, "source_revision"), "failed");
  assert.equal(status(both, "source_cleanliness"), "failed");
});

test("RT-CLASS-03 an unreadable revision is unknown, never guessed", () => {
  const classified = classify({ revisionCheck: revision("unavailable", { revision: null }) });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "source_revision"), "unknown");
  assert.equal(status(classified, "source_cleanliness"), "unknown");
  assert.equal(classified.revision, null);

  const unsupported = classify({ revisionCheck: revision("unsupported", { revision: null }) });
  assert.equal(unsupported.outcome, "blocked");
  assert.equal(unsupported.sourceKind, "unsupported");
  assert.equal(status(unsupported, "source_revision"), "unsupported");
});

test("RT-CLASS-04 an installed distribution is never the trusted checkout", () => {
  const classified = classify({
    facts: facts({
      path: [SITE_PACKAGES],
      pth: [],
      packages: [{ entry: SITE_PACKAGES, regular: true, namespace: false }],
      distributions: ["scienceflow-0.1.0.dist-info"],
    }),
    revisionCheck: null,
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(classified.sourceKind, "installed-distribution");
  assert.equal(status(classified, "source_root"), "unsupported");
  assert.equal(status(classified, "source_revision"), "unsupported");
  assert.equal(status(classified, "source_cleanliness"), "unsupported");
  assert.equal(status(classified, "duplicate_distribution"), "passed");
});

test("RT-CLASS-05 two resolvable origins are ambiguous, not a preference", () => {
  const classified = classify({
    facts: facts({
      packages: [
        { entry: SOURCE_ROOT, regular: true, namespace: false },
        { entry: "/srv/other", regular: true, namespace: false },
      ],
    }),
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "package_resolution"), "failed");
  assert.equal(classified.sourceKind, "unsupported");
});

test("RT-CLASS-06 a namespace portion with no regular package is unsupported", () => {
  const classified = classify({
    facts: facts({
      path: [SITE_PACKAGES, "/srv/ns"],
      pth: [],
      packages: [{ entry: "/srv/ns", regular: false, namespace: true }],
    }),
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "package_resolution"), "unsupported");
  assert.equal(classified.sourceKind, "unsupported");
});

test("RT-CLASS-07 a path line that does not name the checkout is unsupported", () => {
  const classified = classify({
    facts: facts({
      pth: [
        {
          path: `${SITE_PACKAGES}/scienceflow.pth`,
          pathLines: [`${SITE_PACKAGES}/scienceflow`],
          importLines: 0,
          unreadable: false,
        },
      ],
      packages: [{ entry: `${SITE_PACKAGES}/scienceflow`, regular: true, namespace: false }],
    }),
    revisionCheck: null,
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "source_root"), "unsupported");
});

test("RT-CLASS-08 startup hooks, import lines, and outside paths block", () => {
  const sitecustomize = classify({
    facts: facts({ startupHooks: { sitecustomize: true, usercustomize: false } }),
  });
  assert.equal(sitecustomize.outcome, "blocked");
  assert.equal(status(sitecustomize, "startup_hooks"), "failed");

  const importLine = classify({
    facts: facts({
      pth: [
        {
          path: `${SITE_PACKAGES}/scienceflow.pth`,
          pathLines: [SOURCE_ROOT],
          importLines: 1,
          unreadable: false,
        },
      ],
    }),
  });
  assert.equal(importLine.outcome, "blocked");
  assert.equal(status(importLine, "startup_hooks"), "failed");

  const outsideLine = classify({
    facts: facts({
      pth: [
        {
          path: `${SITE_PACKAGES}/scienceflow.pth`,
          pathLines: [SOURCE_ROOT, "/etc"],
          importLines: 0,
          unreadable: false,
        },
      ],
    }),
  });
  assert.equal(outsideLine.outcome, "blocked");
  assert.equal(status(outsideLine, "startup_hooks"), "failed");

  const outsideSysPath = classify({
    facts: facts({ path: [SITE_PACKAGES, SOURCE_ROOT, "/tmp"] }),
  });
  assert.equal(outsideSysPath.outcome, "blocked");
  assert.equal(status(outsideSysPath, "startup_hooks"), "failed");

  const relativeSysPath = classify({
    facts: facts({ path: ["", SITE_PACKAGES, SOURCE_ROOT] }),
  });
  assert.equal(relativeSysPath.outcome, "blocked");
  assert.equal(status(relativeSysPath, "startup_hooks"), "failed");
});

test("RT-CLASS-09 the interpreter must be the leased one", () => {
  const version = classify({
    facts: facts({ python: { version: "3.10.12", prefix: PREFIX, basePrefix: PREFIX } }),
  });
  assert.equal(version.outcome, "blocked");
  assert.equal(status(version, "interpreter_identity"), "failed");

  const prefix = classify({
    facts: facts({ python: { version: "3.11.9", prefix: "/usr", basePrefix: "/usr" } }),
  });
  assert.equal(prefix.outcome, "blocked");
  assert.equal(status(prefix, "interpreter_identity"), "failed");
});

test("RT-CLASS-10 duplicate distribution metadata is evidence when present", () => {
  const one = classify({ facts: facts({ distributions: ["scienceflow-0.1.0.dist-info"] }) });
  assert.equal(one.outcome, "verified");
  assert.equal(status(one, "duplicate_distribution"), "passed");

  const two = classify({
    facts: facts({
      distributions: ["scienceflow-0.1.0.dist-info", "scienceflow-0.2.0.dist-info"],
    }),
  });
  assert.equal(two.outcome, "blocked");
  assert.equal(status(two, "duplicate_distribution"), "failed");
});

test("RT-CLASS-11 a request carries identities and the declared revision only", () => {
  const request = {
    schemaVersion: SCIENCE_FLOW_RUNTIME_PROBE_VERSION,
    requestId: "request-1",
    bindingId: "runner-binding-1",
    environmentId: "environment-1",
    expectedEnvironmentRevisionId: "revision-1",
    expectedRevision: REVISION,
  };
  assert.deepEqual(parseScienceFlowRuntimeProbeRequest(request), request);

  const rejected: unknown[] = [
    null,
    [],
    { ...request, schemaVersion: 2 },
    { ...request, command: "python" },
    { ...request, sourceRoot: SOURCE_ROOT },
    { ...request, requestId: "" },
    { ...request, bindingId: "   " },
    { ...request, bindingId: "b".repeat(161) },
    { ...request, environmentId: "environment\0-1" },
    { ...request, expectedEnvironmentRevisionId: 1 },
    { ...request, expectedRevision: REVISION.toUpperCase() },
    { ...request, expectedRevision: "abc" },
  ];
  for (const value of rejected) {
    assert.equal(parseScienceFlowRuntimeProbeRequest(value), null);
  }
});
