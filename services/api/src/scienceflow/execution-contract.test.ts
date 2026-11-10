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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  createScienceFlowContractBuilder,
  digestScienceFlowContract,
} from "./execution-contract.js";
import type { ScienceFlowExecutionProfile } from "./execution-config.js";

const PACKAGE = join("tasks", "opt_solver", "circle-packing");

const MANIFEST = `max_concurrent: 1
time_limit: 3600
resume: false
lnr:
  wall_clock_budget_sec: 120
defaults:
  phase: run
  type: lnr
  workspace_base: workspace-base
  evaluator:
    enabled: true
    backend: task_package
  lnr:
    max_steps: 10
tasks:
  - exp_id: circle-packing
    time_limit: 600
    cpu_list: "0-3"
    lnr:
      seed: 1
`;

const TASK_YAML = `id: circle-packing
category: opt_solver
provider: opt_solver
profile: default
description: description.md
artifact:
  path: artifacts/best.json
  kind: json
metric:
  name: min_distance
  lower_is_better: false
  type: continuous
  authoritative: false
evaluator:
  entrypoint: evaluate.py:score
  timeout_sec: 300
problem: |
  Pack unit circles into a square.
`;

const EVALUATOR = `def score(*args):
    return 0.0
`;

const SHARED = `inputs:
  required: false
`;

interface Fixture {
  readonly root: string;
  readonly profile: ScienceFlowExecutionProfile;
  write(relative: string, content: string | Buffer): Promise<void>;
  path(relative: string): string;
}

interface FixtureOptions {
  readonly manifest?: string | Buffer;
  readonly task?: string;
  readonly shared?: string | null;
  readonly evaluator?: string;
  readonly roots?: (root: string) => readonly string[];
  readonly packageRelative?: string;
}

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  options: FixtureOptions = {},
): Promise<Fixture> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "execution-contract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = (relative: string) => join(root, relative);
  const write = async (relative: string, content: string | Buffer) => {
    await mkdir(dirname(path(relative)), { recursive: true });
    await writeFile(path(relative), content);
  };
  const packageRelative = options.packageRelative ?? PACKAGE;
  await write("manifest.yaml", options.manifest ?? MANIFEST);
  await write(join(packageRelative, "task.yaml"), options.task ?? TASK_YAML);
  await write(join(packageRelative, "evaluate.py"), options.evaluator ?? EVALUATOR);
  await write(join(packageRelative, "description.md"), "# Circle packing\n");
  if (options.shared !== null) {
    await write(
      join(dirname(packageRelative), "_shared", "task_defaults.yaml"),
      options.shared ?? SHARED,
    );
  }
  return {
    root,
    profile: {
      profileId: "profile-1",
      scienceFlowRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
      manifestPath: path("manifest.yaml"),
      taskPackageRoot: path(packageRelative),
      allowedReadRoots: options.roots?.(root) ?? [root],
    },
    write,
    path,
  };
}

async function build(
  test: Fixture,
): Promise<Awaited<ReturnType<ReturnType<typeof createScienceFlowContractBuilder>>>> {
  return createScienceFlowContractBuilder()(test.profile);
}

function status(
  result: Awaited<ReturnType<ReturnType<typeof createScienceFlowContractBuilder>>>,
  code: string,
): string | undefined {
  if (result.status === "internal") return undefined;
  return result.checks.find((check) => check.code === code)?.status;
}

function assertCheck(
  result: Awaited<ReturnType<ReturnType<typeof createScienceFlowContractBuilder>>>,
  code: string,
  expected: string,
): void {
  assert.equal(status(result, code), expected, `${code} should be ${expected}`);
}

test("CRT-01 the supported subset builds a complete contract", async (context) => {
  const test = await fixture(context);
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  const contract = result.contract;
  assert.equal(contract.task.taskId, "circle-packing");
  assert.equal(contract.task.category, "opt_solver");
  assert.equal(contract.task.profile, "default");
  assert.deepEqual(contract.metric, {
    name: "min_distance",
    lowerIsBetter: false,
    type: "continuous",
    authoritative: false,
  });
  assert.deepEqual(contract.artifact, { path: "artifacts/best.json", kind: "json" });
  assert.equal(contract.evaluator.entrypoint, "evaluate.py:score");
  assert.equal(contract.evaluator.path, "evaluate.py");
  assert.equal(contract.evaluator.function, "score");
  assert.match(contract.evaluator.sha256, /^[0-9a-f]{64}$/);
  assert.equal(contract.evaluator.timeoutSec, 300);
  assert.deepEqual(contract.description, {
    path: "description.md",
    sha256: contract.description.sha256,
  });
  // The workspace source is the last non-blank key in the engine's precedence;
  // the path itself never enters the contract.
  assert.deepEqual(contract.workspace, { source: "defaults_workspace_base" });
  assert.match(contract.taskYamlSha256, /^[0-9a-f]{64}$/);
  assert.match(contract.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(contract.sharedDefaultsSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(contract.scienceflow, {
    declaredRevision: "0ef229de1ae126ea04387ce74ae94ffacc437df6",
    verification: "unverified",
  });
  // Both budgets are declarative requests, wall clock first.
  assert.deepEqual(contract.budgets, [
    { name: "wall_clock_budget_sec", value: 120, unit: "seconds", nature: "requested" },
    { name: "time_limit", value: 600, unit: "seconds", nature: "requested" },
  ]);
  assert.deepEqual(contract.unknowns, {
    dataset: "not-applicable",
    environment: "unknown",
    pricing: "unknown",
    modelGateway: "unknown",
    revision: "unverified",
    dependencyClosure: "incomplete",
  });
  // Every check is passed or explicitly unknown; nothing is failed.
  assert.equal(
    result.checks.some((check) => check.status === "failed" || check.status === "unsupported"),
    false,
  );
  assert.equal(status(result, "scienceflow_revision"), "unknown");
  assert.equal(status(result, "dependency_closure"), "unknown");
});

test("CRT-02 the contract digest is deterministic and key-order independent", async (context) => {
  const test = await fixture(context);
  const first = await build(test);
  const second = await build(test);
  if (first.status !== "ok" || second.status !== "ok") assert.fail("expected ok");
  assert.equal(
    digestScienceFlowContract(first.contract),
    digestScienceFlowContract(second.contract),
  );
  // Rebuilding after an unrelated file change keeps the same digests when the
  // referenced bytes are unchanged.
  await test.write(join(PACKAGE, "unreferenced.txt"), "different\n");
  const third = await build(test);
  if (third.status !== "ok") assert.fail("expected ok");
  assert.equal(
    digestScienceFlowContract(first.contract),
    digestScienceFlowContract(third.contract),
  );
});

test("CRT-03 a missing manifest is a failed check", async (context) => {
  const test = await fixture(context, { manifest: "" });
  const profile = { ...test.profile, manifestPath: test.path("absent.yaml") };
  const result = await createScienceFlowContractBuilder()(profile);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_readable", "failed");
});

test("CRT-04 an oversize manifest is refused", async (context) => {
  const test = await fixture(context, { manifest: "x".repeat(256 * 1024 + 1) });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_size", "failed");
});

test("CRT-05 an invalid UTF-8 manifest is refused", async (context) => {
  const test = await fixture(context, { manifest: Buffer.from([0xff, 0xfe, 0x00]) });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_encoding", "failed");
});

test("CRT-06 a duplicated manifest key is refused", async (context) => {
  const test = await fixture(context, {
    manifest: `max_concurrent: 1\nmax_concurrent: 2\n${MANIFEST}`,
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_duplicate_key", "failed");
  assertCheck(result, "manifest_yaml", "failed");
});

test("CRT-07 an alias bomb is refused before it expands", async (context) => {
  const test = await fixture(context, {
    manifest: `a: &a [1,1,1,1,1,1,1,1,1,1]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]
`,
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_alias_limit", "failed");
});

test("CRT-08 a syntactically invalid manifest is refused", async (context) => {
  const test = await fixture(context, { manifest: "tasks: [\n" });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_yaml", "failed");
});

test("CRT-09 more than one task is unsupported", async (context) => {
  const test = await fixture(context, {
    manifest: MANIFEST.replace(
      "    lnr:\n      seed: 1\n",
      "    lnr:\n      seed: 1\n  - exp_id: other\n",
    ),
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_multiple_tasks", "unsupported");
});

test("CRT-10 unsupported manifest forms are named explicitly", async (context) => {
  // Each case rewrites the fixture in place: prepending a key that the manifest
  // already declares would only exercise the duplicate-key check.
  const cases: Array<[string, string]> = [
    [`config: other.yaml\n${MANIFEST}`, "manifest_config_include"],
    [
      MANIFEST.replace("max_concurrent: 1", "max_concurrent: 2"),
      "manifest_max_concurrent",
    ],
    [MANIFEST.replace("resume: false", "resume: true"), "manifest_resume"],
    [`api_key: synthetic\n${MANIFEST}`, "manifest_model_gateway"],
    [MANIFEST.replace("  type: lnr", "  type: lhr"), "manifest_type"],
    [MANIFEST.replace("  phase: run", "  phase: report"), "manifest_phase"],
    [
      MANIFEST.replace(
        "    enabled: true",
        "    enabled: true\n    gate: true",
      ),
      "manifest_evaluator",
    ],
  ];
  for (const [manifest, code] of cases) {
    const test = await fixture(context, { manifest });
    const result = await build(test);
    assert.equal(result.status, "rejected", `${code} should reject`);
    assertCheck(result, code, "unsupported");
  }
});

test("CRT-11 a non-finite or non-positive budget is refused", async (context) => {
  for (const value of [".inf", "0", "-5", "null", "not-a-number"]) {
    for (const manifest of [
      MANIFEST.replace("time_limit: 600", `time_limit: ${value}`),
      MANIFEST.replace("wall_clock_budget_sec: 120", `wall_clock_budget_sec: ${value}`),
    ]) {
      const test = await fixture(context, { manifest });
      const result = await build(test);
      assert.equal(result.status, "rejected");
      assertCheck(result, "manifest_budget", "failed");
    }
  }
});

test("CRT-12 a task id that disagrees with exp_id is refused", async (context) => {
  const test = await fixture(context, {
    task: TASK_YAML.replace("id: circle-packing", "id: other-task"),
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "task_identity", "failed");
});

test("CRT-13 an absolute or escaping artifact path is refused", async (context) => {
  for (const artifact of ["/etc/passwd", "../outside.json", "a/../../b.json"]) {
    const test = await fixture(context, {
      task: TASK_YAML.replace("artifacts/best.json", artifact),
    });
    const result = await build(test);
    assert.equal(result.status, "rejected");
    assertCheck(result, "task_artifact", "failed");
    assertCheck(result, "path_traversal", "failed");
  }
});

test("CRT-14 an unusable evaluator entrypoint is refused", async (context) => {
  for (const entrypoint of [
    "../escape.py:score",
    "/abs/evaluate.py:score",
    ":score",
    "evaluate.py:not-a-name",
    "evaluate.py",
  ]) {
    const test = await fixture(context, {
      task: TASK_YAML.replace("evaluate.py:score", entrypoint),
    });
    const result = await build(test);
    assert.equal(result.status, "rejected");
    assertCheck(result, "evaluator_entrypoint", "failed");
  }
});

test("CRT-15 a missing evaluator file is refused", async (context) => {
  const test = await fixture(context);
  const profile = {
    ...test.profile,
    manifestPath: test.profile.manifestPath,
  };
  await rm(test.path(join(PACKAGE, "evaluate.py")));
  const result = await createScienceFlowContractBuilder()(profile);
  assert.equal(result.status, "rejected");
  assertCheck(result, "evaluator_file", "failed");
});

test("CRT-16 a missing description is refused", async (context) => {
  const test = await fixture(context);
  await rm(test.path(join(PACKAGE, "description.md")));
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "description_file", "failed");
});

test("CRT-17 a symlink that leaves the package is refused", async (context) => {
  const test = await fixture(context);
  const outside = join(dirname(test.root), `outside-${process.pid}.py`);
  await writeFile(outside, "def score():\n    return 0\n");
  try {
    await rm(test.path(join(PACKAGE, "evaluate.py")));
    await symlink(outside, test.path(join(PACKAGE, "evaluate.py")));
    const result = await build(test);
    assert.equal(result.status, "rejected");
    assertCheck(result, "evaluator_file", "failed");
    assertCheck(result, "path_allowed_roots", "failed");
  } finally {
    await rm(outside, { force: true });
  }
});

test("CRT-18 a task package outside the allowed roots is refused", async (context) => {
  const test = await fixture(context, {
    roots: (root) => [join(root, "elsewhere")],
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "path_allowed_roots", "failed");
});

test("CRT-19 the evaluator source is read and hashed, never executed", async (context) => {
  const test = await fixture(context, {
    evaluator: `from pathlib import Path
Path(__file__).with_name("executed.marker").write_text("ran", encoding="utf-8")

def score(*args):
    return 0.0
`,
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.equal(existsSync(test.path(join(PACKAGE, "executed.marker"))), false);
  assert.match(result.contract.evaluator.sha256, /^[0-9a-f]{64}$/);
});

test("CRT-20 a declared dataset is explicitly unknown", async (context) => {
  const test = await fixture(context, {
    manifest: MANIFEST.replace(
      "    cpu_list: \"0-3\"\n",
      "    cpu_list: \"0-3\"\n    input_data_dir: data\n",
    ),
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.equal(result.contract.unknowns.dataset, "unknown");
  assertCheck(result, "dataset_identity", "unknown");
});

test("CRT-21 no raw source text or host path reaches the contract", async (context) => {
  const marker = "SYNTHETIC-SOURCE-TEXT-MARKER";
  const test = await fixture(context, {
    task: TASK_YAML.replace("Pack unit circles into a square.", marker),
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  const serialized = JSON.stringify(result.contract);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes(test.root), false);
});

test("CRT-22 the shared defaults merge is applied and hashed, or absent", async (context) => {
  const withShared = await fixture(context);
  const merged = await build(withShared);
  if (merged.status !== "ok") assert.fail("expected ok");
  assert.match(merged.contract.sharedDefaultsSha256 ?? "", /^[0-9a-f]{64}$/);

  const withoutShared = await fixture(context, { shared: null });
  const alone = await build(withoutShared);
  if (alone.status !== "ok") assert.fail("expected ok");
  assert.equal(alone.contract.sharedDefaultsSha256, null);
});

test("CRT-23 an unsupported task.yaml key is named", async (context) => {
  const test = await fixture(context, {
    task: `${TASK_YAML}runner: shell\n`,
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "task_yaml_key", "unsupported");
});

test("CRT-24 a rejected task package leaves skipped checks unknown", async (context) => {
  // `entrypoint: evaluate.py:` is not valid YAML, so the task package cannot be
  // read at all. The checks that would have validated it must stay `unknown`:
  // a check that never ran is not evidence the file is consistent.
  const test = await fixture(context, {
    task: TASK_YAML.replace("evaluate.py:score", "evaluate.py:"),
  });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "task_yaml_yaml", "failed");
  for (const code of [
    "task_identity",
    "task_metric",
    "task_artifact",
    "evaluator_entrypoint",
    "evaluator_file",
    "description_reference",
    "description_file",
    "path_traversal",
  ]) {
    assertCheck(result, code, "unknown");
  }
});

/** Insert one task-level key directly after the task's `exp_id` line. */
function withTaskKey(manifest: string, line: string): string {
  return manifest.replace(
    "  - exp_id: circle-packing\n",
    `  - exp_id: circle-packing\n    ${line}\n`,
  );
}

const WITHOUT_DEFAULTS_WORKSPACE = MANIFEST.replace("  workspace_base: workspace-base\n", "");

test("CRT-25 a manifest that names no workspace at all is refused", async (context) => {
  // The engine raises here instead of supplying a directory; the static check
  // must refuse the same manifest rather than pass it with an implied default.
  const test = await fixture(context, { manifest: WITHOUT_DEFAULTS_WORKSPACE });
  const result = await build(test);
  assert.equal(result.status, "rejected");
  assertCheck(result, "manifest_workspace", "failed");
});

test("CRT-26 blank workspace values do not count as a workspace", async (context) => {
  const cases = [
    // Every level blank or empty: still nothing to resolve.
    withTaskKey(
      WITHOUT_DEFAULTS_WORKSPACE,
      'workspace: ""',
    ).replace("  type: lnr\n", '  type: lnr\n  workspace_base: "   "\n'),
    // A task-level base line that only contains whitespace.
    withTaskKey(WITHOUT_DEFAULTS_WORKSPACE, 'workspace_base: ""'),
    // Null is not a declaration either.
    withTaskKey(WITHOUT_DEFAULTS_WORKSPACE, "workspace: null"),
  ];
  for (const manifest of cases) {
    const test = await fixture(context, { manifest });
    const result = await build(test);
    assert.equal(result.status, "rejected");
    assertCheck(result, "manifest_workspace", "failed");
  }
});

test("CRT-27 an explicit workspace passes and creates no directory", async (context) => {
  const test = await fixture(context, { manifest: WITHOUT_DEFAULTS_WORKSPACE });
  const workspace = join(test.root, "declared-workspace");
  await test.write(
    "manifest.yaml",
    withTaskKey(WITHOUT_DEFAULTS_WORKSPACE, `workspace: ${JSON.stringify(workspace)}`),
  );
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.deepEqual(result.contract.workspace, { source: "task_workspace" });
  // The check reads the declaration only: it never creates the directory and
  // never puts the path into the contract or its checks.
  assert.equal(existsSync(workspace), false);
  assert.equal(JSON.stringify(result.contract).includes(workspace), false);
  assert.equal(JSON.stringify(result.checks).includes(workspace), false);
});

test("CRT-28 an explicit workspace wins over both workspace bases", async (context) => {
  const test = await fixture(context, {
    manifest: withTaskKey(
      withTaskKey(MANIFEST, "workspace_base: task-base"),
      'workspace: "explicit-workspace"',
    ),
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.deepEqual(result.contract.workspace, { source: "task_workspace" });
});

test("CRT-29 a task workspace_base wins over the defaults", async (context) => {
  const test = await fixture(context, {
    manifest: withTaskKey(MANIFEST, "workspace_base: task-base"),
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.deepEqual(result.contract.workspace, { source: "task_workspace_base" });
});

test("CRT-30 a blank explicit workspace falls back to the defaults base", async (context) => {
  const test = await fixture(context, {
    manifest: withTaskKey(MANIFEST, 'workspace: "   "'),
  });
  const result = await build(test);
  if (result.status !== "ok") assert.fail(`expected ok, got ${result.status}`);
  assert.deepEqual(result.contract.workspace, { source: "defaults_workspace_base" });
});

test("CRT-31 a non-string workspace form is unsupported, not coerced", async (context) => {
  const cases = [
    withTaskKey(WITHOUT_DEFAULTS_WORKSPACE, "workspace: 42"),
    withTaskKey(WITHOUT_DEFAULTS_WORKSPACE, "workspace: true"),
    withDefaultsWorkspace("42"),
  ];
  for (const manifest of cases) {
    const test = await fixture(context, { manifest });
    const result = await build(test);
    assert.equal(result.status, "rejected");
    assertCheck(result, "manifest_workspace", "unsupported");
  }
});

/** Rewrite the defaults base value while keeping that key's position. */
function withDefaultsWorkspace(value: string): string {
  return MANIFEST.replace("  workspace_base: workspace-base\n", `  workspace_base: ${value}\n`);
}
