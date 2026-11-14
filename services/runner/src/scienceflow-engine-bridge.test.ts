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
 * The Runner's fixed bridge to the real ScienceFlow managed lifecycle.
 *
 * What is checked here is the part that does not need the engine's dependency
 * closure: the engine identity record, the wiring refusals that must happen
 * before any process exists, and the real pre-spawn revision check against a
 * real Git checkout. One case also launches the bridge through the ordinary
 * sandbox with a checkout that is not an engine: the bridge must run, fail to
 * import, and leave no record, which is `unknown` — never a completion.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  type ResearchRunRequest,
  type ResearchRunStatus,
  type ResearchTimeSchedule,
} from "@sciencediscovery/schema";

import {
  parseScienceFlowEngineLink,
  researchEngineStateRoot,
  SCIENCEFLOW_ENGINE_BRIDGE_SOURCE,
  SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION,
  SCIENCEFLOW_LAUNCH_MAPPING_VERSION,
} from "./scienceflow-engine-bridge.js";
import {
  createResearchRunExecutor,
  type ResearchEngineBinding,
  type ResearchRunWiring,
} from "./research-run.js";
import type { ExecutorConfig } from "./executor.js";

const SCHEDULE: ResearchTimeSchedule = {
  drainGraceMs: 200,
  reportBudgetMs: 2_000,
  researchBudgetMs: 8_000,
  stopGraceMs: 600,
  verificationWindowMs: 2_000,
};

const REVISION = "b".repeat(40);
const VERSION = "0.2.0";
const MANIFEST_DIGEST = "d".repeat(64);

function link(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION,
    execution: "run-engine",
    engineRunId: "sf-0123456789abcdef01234567",
    attempt: 1,
    engineRevision: REVISION,
    engineVersion: VERSION,
    derivedManifestDigest: MANIFEST_DIGEST,
    mappingVersion: SCIENCEFLOW_LAUNCH_MAPPING_VERSION,
    ...overrides,
  });
}

test("an engine link is evidence only for this execution at the pinned identity", () => {
  const expected = { revision: REVISION, version: VERSION };
  assert.deepEqual(parseScienceFlowEngineLink(link(), "run-engine", expected), {
    attempt: 1,
    derivedManifestDigest: MANIFEST_DIGEST,
    engineRunId: "sf-0123456789abcdef01234567",
    mappingVersion: SCIENCEFLOW_LAUNCH_MAPPING_VERSION,
    revision: REVISION,
    version: VERSION,
  });
  for (const rejected of [
    link({ execution: "other-run" }),
    link({ engineRevision: "c".repeat(40) }),
    link({ engineVersion: "9.9.9" }),
    link({ attempt: 0 }),
    link({ attempt: "1" }),
    link({ engineRunId: "../escape" }),
    link({ version: 2 }),
    link({ pid: 42 }),
    link({ derivedManifestDigest: "short" }),
    link({ mappingVersion: 1 }),
    link({ mappingVersion: "1" }),
    "{not json",
    "[]",
    "",
  ]) {
    assert.equal(parseScienceFlowEngineLink(rejected, "run-engine", expected), null, rejected);
  }
});

test("the engine state root is derived from the execution id, never spelled by it", () => {
  const root = researchEngineStateRoot("/data", "../../etc/passwd");
  assert.match(root, /^\/data\/runner-research-engine\/[0-9a-f]{32}$/);
  assert.notEqual(researchEngineStateRoot("/data", "a"), researchEngineStateRoot("/data", "b"));
});

test("a wiring must name exactly one program source", () => {
  const config: ExecutorConfig = {
    bwrapPath: "bwrap", dataDir: "/tmp/data", execTimeoutMs: 1_000, maxOutputBytes: 4_096,
    maxWorkspaceBytes: 0, terminationGraceMs: 400,
  };
  const engine: ResearchEngineBinding = { revision: REVISION, sourceRoot: "/checkout", version: VERSION };
  assert.throws(() => createResearchRunExecutor({ config }), /no trusted research workload/);
  assert.throws(
    () => createResearchRunExecutor({ config, engine, program: "print(1)" }),
    /no revision-pinned ScienceFlow engine/,
  );
  assert.throws(
    () => createResearchRunExecutor({ config, program: "   " }),
    /no trusted research workload/,
  );
  // The engine binding is validated as Runner configuration, before a request
  // is ever parsed: a short revision, a relative root or an empty version is
  // not a binding.
  for (const bad of [
    { ...engine, revision: "beef" },
    { ...engine, sourceRoot: "relative/checkout" },
    { ...engine, sourceRoot: "/checkout/../elsewhere" },
    { ...engine, version: "" },
    { ...engine, researchStepModule: "../evil" },
  ]) {
    assert.throws(
      () => createResearchRunExecutor({ config, engine: bad }),
      /no revision-pinned ScienceFlow engine/,
      JSON.stringify(bad),
    );
  }
  assert.doesNotThrow(() => createResearchRunExecutor({ config, engine }));
});

function inputFixture() {
  const contractDigest = "a".repeat(64);
  const entries = [
    { content: "contract\n", path: "manifest.yaml", roles: ["manifest"] as const },
    { content: "id: probe\n", path: "package/task.yaml", roles: ["task_yaml"] as const },
    { content: "description\n", path: "package/description.md", roles: ["description"] as const },
    { content: "def evaluate():\n    return 1\n", path: "package/evaluate.py", roles: ["evaluator"] as const },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = entries.map((entry) => ({
    path: entry.path,
    roles: [...entry.roles],
    size: Buffer.byteLength(entry.content),
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  }));
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION as typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files,
  };
  const bundleDigest = createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
  return {
    identity: { contractDigest, bundleDigest },
    manifest,
    contents: new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content)])),
  };
}

const INPUT = inputFixture();

function wiring(
  dataDir: string,
  engine: ResearchEngineBinding,
): ResearchRunWiring {
  return {
    config: {
      bwrapPath: "bwrap", dataDir, execTimeoutMs: 30_000, maxOutputBytes: 65_536,
      maxWorkspaceBytes: 0, terminationGraceMs: 2_000,
    },
    engine,
    fixtureRuntime: { identity: "fixture-runtime", interpreterPath: "/usr/bin/python3" },
    inputBundles: {
      hostRoots: () => [],
      snapshot: async () => ({ manifest: INPUT.manifest, contents: INPUT.contents }),
    },
  };
}

function request(id: string, workspaceRoot: string): ResearchRunRequest {
  return {
    agentId: "agent",
    executionId: id,
    inputs: { ...INPUT.identity },
    kind: "research",
    permissionEpoch: { sessionId: "session" } as ResearchRunRequest["permissionEpoch"],
    schedule: { ...SCHEDULE },
    schemaVersion: 1,
    workload: "scienceflow-fixed",
    workspaceRoot,
  };
}

async function scratch(label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `research-engine-${label}-`));
  const dataDir = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { dataDir, root, workspace };
}

function git(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error) return undefined;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A real, clean checkout: the shape the revision check accepts. */
async function checkout(root: string): Promise<string | undefined> {
  const repo = resolve(root, "checkout");
  await mkdir(repo, { recursive: true });
  if (git(repo, ["init", "--quiet"]) === undefined) return undefined;
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "fixture"]);
  await mkdir(resolve(repo, "scienceflow"), { recursive: true });
  await writeFile(resolve(repo, "scienceflow", "__init__.py"), '"""not an engine fixture."""\n');
  await writeFile(resolve(repo, "pyproject.toml"), '[project]\nname = "scienceflow"\nversion = "0.2.0"\n');
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

test("a checkout that is not the pinned revision is refused before spawn", async () => {
  const { dataDir, root, workspace } = await scratch("revision");
  try {
    const revision = await checkout(root);
    if (revision === undefined) {
      // A host without Git cannot answer the question, and the wiring refuses
      // to guess: the refusal below is the same one an unavailable checkout gets.
      assert.ok(true, "git unavailable; the refusal path still holds");
    }
    const executor = createResearchRunExecutor(wiring(dataDir, {
      revision: REVISION, // never the real HEAD of this fixture
      sourceRoot: resolve(root, "checkout"),
      version: VERSION,
    }));
    const outcome = await executor.run(request("mismatch", workspace), { signal: new AbortController().signal });
    assert.equal(outcome.research.process, "not_started");
    assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
    assert.equal(outcome.research.engine, undefined);
    // Nothing was created for the engine state: the refusal happens first.
    await assert.rejects(stat(researchEngineStateRoot(dataDir, "mismatch")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a source root that is not a checkout is refused, never treated as one", async () => {
  const { dataDir, root, workspace } = await scratch("plain");
  try {
    const plain = resolve(root, "plain");
    await mkdir(plain, { recursive: true });
    const executor = createResearchRunExecutor(wiring(dataDir, {
      revision: REVISION, sourceRoot: plain, version: VERSION,
    }));
    const outcome = await executor.run(request("plain", workspace), { signal: new AbortController().signal });
    assert.equal(outcome.research.process, "not_started");
    assert.equal(outcome.research.refusal, "RESEARCH_ENGINE_UNAVAILABLE");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the bridge runs under the real sandbox and leaves no record when the engine is absent", {
  tags: ["os:linux"],
}, async () => {
  const { dataDir, root, workspace } = await scratch("bridge");
  try {
    const revision = await checkout(root);
    if (revision === undefined) return; // no Git on this host; covered above.
    // The pinned checkout really is a clean checkout, so the revision check
    // passes and the bridge is the program that runs. It cannot import an
    // engine from a package that does not exist, so it writes no record: the
    // Runner must call that unknown, not "nothing ran".
    const executor = createResearchRunExecutor(wiring(dataDir, {
      revision, sourceRoot: resolve(root, "checkout"), version: VERSION,
    }));
    const outcome = await executor.run(request("bridge", workspace), { signal: new AbortController().signal });
    const status: ResearchRunStatus = outcome.research;
    // Without a manager there is no captured boundary, so the process fact is
    // `unverified` rather than a proven termination; the business fact is what
    // matters here and it is `unknown` with the missing record named.
    assert.equal(status.process, "unverified");
    assert.equal(status.outcome, "unknown");
    assert.equal(status.refusal, "RESEARCH_RECORD_MISSING");
    assert.equal(status.engine, undefined);
    // The spawn turn really happened: the bridge was launched through bwrap,
    // and the Runner-owned engine state directory was established for it.
    assert.equal(typeof status.spawnedAt, "string");
    assert.equal((await stat(researchEngineStateRoot(dataDir, "bridge"))).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the bridge source is Runner code with no request-supplied interpolation", () => {
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /sys\.path\.insert\(0, str\(ENGINE\)\)/);
  // The program reads only its argv and the fixed mounts; it must not consult
  // an environment variable for a mount, a path or a program.
  assert.doesNotMatch(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /os\.environ\.get\(/);
  assert.doesNotMatch(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /os\.environ\["(?!XDG_STATE_HOME)/);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /worker\.supervise\(/);
  assert.match(SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, /prepare_run/);
});
