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
  assessStaticProbeFacts,
  classifyProbeFacts,
  parseScienceFlowRuntimeProbeRequest,
} from "./scienceflow-runtime-check.js";
import type {
  ScienceFlowRuntimeProbeHookScan,
  ScienceFlowRuntimeProbePthFile,
  ScienceFlowRuntimeProbeResolution,
  ScienceFlowRuntimeProbeRuntimeFacts,
  ScienceFlowRuntimeProbeStaticFacts,
  ScienceFlowRuntimeProbeTruncation,
} from "./scienceflow-runtime-probe.js";

const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";
const SOURCE_ROOT = "/srv/scienceflow";
const PREFIX = "/opt/science-env";
const SITE_PACKAGES = `${PREFIX}/lib/python3.11/site-packages`;

function truncation(
  overrides: Partial<ScienceFlowRuntimeProbeTruncation> = {},
): ScienceFlowRuntimeProbeTruncation {
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

function pthFile(
  overrides: Partial<ScienceFlowRuntimeProbePthFile> = {},
): ScienceFlowRuntimeProbePthFile {
  return {
    path: `${SITE_PACKAGES}/scienceflow.pth`,
    pathLines: [SOURCE_ROOT],
    pathLineMissing: [false],
    importLines: 0,
    unreadable: false,
    tooLarge: false,
    notRegular: false,
    unsupportedEncoding: false,
    lines: 1,
    lineLimitExceeded: false,
    ...overrides,
  };
}

function resolution(
  entry: string,
  scienceflow: ScienceFlowRuntimeProbeResolution["scienceflow"],
): ScienceFlowRuntimeProbeResolution {
  return { entry, kind: "directory", symlinked: false, scienceflow };
}

function hook(
  entry: string,
  overrides: Partial<ScienceFlowRuntimeProbeHookScan> = {},
): ScienceFlowRuntimeProbeHookScan {
  return { entry, sitecustomize: false, usercustomize: false, ...overrides };
}

/** A clean static inventory: one `.pth` path line names the trusted checkout. */
function facts(
  overrides: Partial<ScienceFlowRuntimeProbeStaticFacts> = {},
): ScienceFlowRuntimeProbeStaticFacts {
  return {
    mode: "static",
    python: {
      version: "3.11.9",
      prefix: PREFIX,
      basePrefix: PREFIX,
      noSite: true,
      noUserSite: true,
      dontWriteBytecode: true,
    },
    venvConfig: false,
    basePath: [SITE_PACKAGES],
    sitePackages: [SITE_PACKAGES],
    effectivePath: [SITE_PACKAGES, SOURCE_ROOT],
    pth: [pthFile()],
    distributions: [],
    resolutions: [resolution(SITE_PACKAGES, null), resolution(SOURCE_ROOT, { kind: "regular" })],
    hooks: [hook(SITE_PACKAGES), hook(SOURCE_ROOT)],
    truncation: truncation(),
    ...overrides,
  };
}

/** The normal start that confirms a static inventory, unless overridden. */
function confirming(
  staticFacts: ScienceFlowRuntimeProbeStaticFacts,
  overrides: Partial<ScienceFlowRuntimeProbeRuntimeFacts> = {},
): ScienceFlowRuntimeProbeRuntimeFacts {
  return {
    mode: "runtime",
    python: { ...staticFacts.python, noSite: false },
    path: [...staticFacts.effectivePath],
    sitePackages: [...staticFacts.sitePackages],
    resolutions: staticFacts.resolutions,
    distributions: staticFacts.distributions,
    startupHooks: { sitecustomize: false, usercustomize: false },
    truncation: truncation(),
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
    readonly facts?: ScienceFlowRuntimeProbeStaticFacts;
    readonly revisionCheck?: EngineRevisionCheckResult | null;
    readonly languageVersion?: string;
    readonly runtime?: ScienceFlowRuntimeProbeRuntimeFacts | null;
  } = {},
): ReturnType<typeof classifyProbeFacts> {
  const staticFacts = overrides.facts ?? facts();
  return classifyProbeFacts({
    environmentPrefix: PREFIX,
    facts: staticFacts,
    languageVersion: overrides.languageVersion ?? "3.11",
    revisionCheck: "revisionCheck" in overrides ? overrides.revisionCheck ?? null : clean(),
    runtime: "runtime" in overrides ? overrides.runtime ?? null : confirming(staticFacts),
    sourceRoot: SOURCE_ROOT,
  });
}

function assess(
  staticFacts: ScienceFlowRuntimeProbeStaticFacts,
): ReturnType<typeof assessStaticProbeFacts> {
  return assessStaticProbeFacts({
    environmentPrefix: PREFIX,
    facts: staticFacts,
    languageVersion: "3.11",
    sourceRoot: SOURCE_ROOT,
  });
}

function status(overrides: ReturnType<typeof classify>, code: ScienceFlowRuntimeCheckCode) {
  return overrides.overrides[code];
}

test("RT-CLASS-01 only the static inventory and a confirming normal start verify", () => {
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

  // A clean static answer alone is not a verification: the normal start has
  // not yet shown that the reconstruction holds.
  const unconfirmed = classify({ runtime: null });
  assert.equal(unconfirmed.outcome, "blocked");
  assert.equal(status(unconfirmed, "startup_hooks"), "passed");
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
      basePath: [SITE_PACKAGES],
      effectivePath: [SITE_PACKAGES],
      pth: [],
      resolutions: [resolution(SITE_PACKAGES, { kind: "regular" })],
      hooks: [hook(SITE_PACKAGES)],
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
      effectivePath: [SITE_PACKAGES, SOURCE_ROOT, "/srv/other"],
      resolutions: [
        resolution(SITE_PACKAGES, null),
        resolution(SOURCE_ROOT, { kind: "regular" }),
        resolution("/srv/other", { kind: "regular" }),
      ],
      hooks: [hook(SITE_PACKAGES), hook(SOURCE_ROOT), hook("/srv/other")],
    }),
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "package_resolution"), "failed");
  assert.equal(classified.sourceKind, "unsupported");
});

test("RT-CLASS-06 a namespace portion with no regular package is unsupported", () => {
  const classified = classify({
    facts: facts({
      effectivePath: [SITE_PACKAGES, "/srv/ns"],
      pth: [],
      resolutions: [resolution(SITE_PACKAGES, null), resolution("/srv/ns", { kind: "namespace" })],
      hooks: [hook(SITE_PACKAGES), hook("/srv/ns")],
    }),
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "package_resolution"), "unsupported");
  assert.equal(classified.sourceKind, "unsupported");
});

test("RT-CLASS-07 a path line that does not name the checkout is unsupported", () => {
  const copy = `${SITE_PACKAGES}/scienceflow`;
  const classified = classify({
    facts: facts({
      effectivePath: [SITE_PACKAGES, copy],
      pth: [pthFile({ pathLines: [copy], pathLineMissing: [false] })],
      resolutions: [resolution(SITE_PACKAGES, null), resolution(copy, { kind: "regular" })],
      hooks: [hook(SITE_PACKAGES), hook(copy)],
    }),
    revisionCheck: null,
  });
  assert.equal(classified.outcome, "blocked");
  assert.equal(status(classified, "source_root"), "unsupported");
  assert.equal(classified.sourceKind, "installed-distribution");
});

test("RT-CLASS-08 startup hooks, import lines, and outside paths block", () => {
  const sitecustomize = classify({
    facts: facts({
      hooks: [hook(SITE_PACKAGES, { sitecustomize: true }), hook(SOURCE_ROOT)],
    }),
  });
  assert.equal(sitecustomize.outcome, "blocked");
  assert.equal(status(sitecustomize, "startup_hooks"), "failed");

  const importLine = classify({
    facts: facts({ pth: [pthFile({ importLines: 1 })] }),
  });
  assert.equal(importLine.outcome, "blocked");
  assert.equal(status(importLine, "startup_hooks"), "failed");

  const outsideLine = classify({
    facts: facts({
      pth: [pthFile({ pathLines: [SOURCE_ROOT, "/etc"], pathLineMissing: [false, false] })],
    }),
  });
  assert.equal(outsideLine.outcome, "blocked");
  assert.equal(status(outsideLine, "startup_hooks"), "failed");

  const outsideSysPath = classify({
    facts: facts({ effectivePath: [SITE_PACKAGES, SOURCE_ROOT, "/tmp"] }),
  });
  assert.equal(outsideSysPath.outcome, "blocked");
  assert.equal(status(outsideSysPath, "startup_hooks"), "failed");

  const relativeSysPath = classify({
    facts: facts({ effectivePath: ["", SITE_PACKAGES, SOURCE_ROOT] }),
  });
  assert.equal(relativeSysPath.outcome, "blocked");
  assert.equal(status(relativeSysPath, "startup_hooks"), "failed");
});

test("RT-CLASS-09 the interpreter must be the leased one with the expected flags", () => {
  const version = classify({
    facts: facts({
      python: { ...facts().python, version: "3.10.12" },
    }),
  });
  assert.equal(version.outcome, "blocked");
  assert.equal(status(version, "interpreter_identity"), "failed");

  const prefix = classify({
    facts: facts({ python: { ...facts().python, prefix: "/usr", basePrefix: "/usr" } }),
  });
  assert.equal(prefix.outcome, "blocked");
  assert.equal(status(prefix, "interpreter_identity"), "failed");

  // A "static" answer that did not actually run with site disabled proves
  // nothing about what could have executed before it.
  const siteEnabled = classify({ facts: facts({ python: { ...facts().python, noSite: false } }) });
  assert.equal(siteEnabled.outcome, "blocked");
  assert.equal(status(siteEnabled, "startup_hooks"), "failed");
  assert.equal(assess(facts({ python: { ...facts().python, noSite: false } })).ready, false);
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

test("RT-CLASS-12 a module, extension, or linked origin is a shadow, never a verified source", () => {
  const shadowed = (kind: "module" | "extension" | "link") =>
    classify({
      facts: facts({
        resolutions: [
          resolution(SITE_PACKAGES, null),
          resolution(SOURCE_ROOT, { kind }),
        ],
      }),
    });

  for (const kind of ["module", "extension", "link"] as const) {
    const classified = shadowed(kind);
    assert.equal(classified.outcome, "blocked", kind);
    assert.equal(status(classified, "package_resolution"), "failed", kind);
    assert.notEqual(classified.sourceKind, "git-checkout", kind);
  }

  // A module elsewhere on the path next to the regular package is ambiguous:
  // Python would import the earlier entry, so the regular one is not the origin.
  const ambiguity = classify({
    facts: facts({
      effectivePath: [SITE_PACKAGES, "/srv/shadow", SOURCE_ROOT],
      resolutions: [
        resolution(SITE_PACKAGES, null),
        resolution("/srv/shadow", { kind: "module" }),
        resolution(SOURCE_ROOT, { kind: "regular" }),
      ],
      hooks: [hook(SITE_PACKAGES), hook("/srv/shadow"), hook(SOURCE_ROOT)],
    }),
  });
  assert.equal(ambiguity.outcome, "blocked");
  assert.equal(status(ambiguity, "package_resolution"), "failed");
});

test("RT-CLASS-13 the normal start must confirm the reconstruction exactly", () => {
  const staticFacts = facts();

  const differentPath = classify({
    facts: staticFacts,
    runtime: confirming(staticFacts, { path: [SITE_PACKAGES] }),
  });
  assert.equal(differentPath.outcome, "blocked");
  assert.equal(status(differentPath, "startup_hooks"), "failed");

  const differentResolution = classify({
    facts: staticFacts,
    runtime: confirming(staticFacts, {
      resolutions: [resolution(SITE_PACKAGES, { kind: "regular" })],
    }),
  });
  assert.equal(differentResolution.outcome, "blocked");
  assert.equal(status(differentResolution, "package_resolution"), "failed");
  assert.equal(status(differentResolution, "source_root"), "unsupported");

  const loadedHook = classify({
    facts: staticFacts,
    runtime: confirming(staticFacts, {
      startupHooks: { sitecustomize: true, usercustomize: false },
    }),
  });
  assert.equal(loadedHook.outcome, "blocked");
  assert.equal(status(loadedHook, "startup_hooks"), "failed");

  // A runtime answer that ran with site disabled is not a normal start.
  const siteDisabled = classify({
    facts: staticFacts,
    runtime: confirming(staticFacts, { python: { ...staticFacts.python, noSite: true } }),
  });
  assert.equal(siteDisabled.outcome, "blocked");
  assert.equal(status(siteDisabled, "startup_hooks"), "failed");

  const truncated = classify({
    facts: staticFacts,
    runtime: confirming(staticFacts, { truncation: truncation({ path: true }) }),
  });
  assert.equal(truncated.outcome, "blocked");
  assert.equal(status(truncated, "startup_hooks"), "failed");
});

test("RT-CLASS-14 any bound, unreadable file, or unsupported form refuses before a normal start", () => {
  const refused: Array<[string, ScienceFlowRuntimeProbeStaticFacts]> = [
    ["truncated path", facts({ truncation: truncation({ path: true }) })],
    ["truncated pth", facts({ truncation: truncation({ pth: true }) })],
    ["venv config", facts({ venvConfig: true })],
    ["import line", facts({ pth: [pthFile({ importLines: 1 })] })],
    ["unreadable pth", facts({ pth: [pthFile({ unreadable: true })] })],
    // A `.pth` larger than the 64 KiB read bound is never partially parsed.
    ["oversized pth", facts({ pth: [pthFile({ tooLarge: true })] })],
    ["linked pth", facts({ pth: [pthFile({ notRegular: true })] })],
    ["undecodable pth", facts({ pth: [pthFile({ unsupportedEncoding: true })] })],
    ["line limit", facts({ pth: [pthFile({ lineLimitExceeded: true })] })],
    ["outside pth file", facts({ pth: [pthFile({ path: "/etc/scienceflow.pth" })] })],
  ];
  assert.equal(assess(facts()).ready, true, "the success control must be ready");
  for (const [label, staticFacts] of refused) {
    const staticAssessment = assess(staticFacts);
    assert.equal(staticAssessment.ready, false, label);
    assert.equal(staticAssessment.overrides.startup_hooks, "failed", label);
  }
});
