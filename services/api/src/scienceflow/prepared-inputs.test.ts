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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ScienceFlowInputBundlePublication,
  ScienceFlowInputBundleRequest,
  ScienceFlowPreparedInputFileDto,
  ScienceFlowPreparedInputsDto,
} from "@sciencediscovery/schema";
import {
  canonicalScienceFlowInputBundleManifest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  SCIENCE_FLOW_INPUT_FILE_ROLES,
} from "@sciencediscovery/schema";
import {
  RunnerScienceFlowInputBundles,
  ScienceFlowInputBundleError,
} from "@sciencediscovery/runner";

import {
  createScienceFlowContractBuilder,
  digestScienceFlowContract,
  type ScienceFlowContractBuilder,
} from "./execution-contract.js";
import type {
  ScienceFlowExecutionProfile,
  ScienceFlowExecutionSettings,
} from "./execution-config.js";
import { ScienceFlowExecutionPlanRepository } from "./execution-plan-repository.js";
import { assembleScienceFlowInputBundle } from "./input-bundle.js";
import {
  createScienceFlowPrepareInputsService,
  type ScienceFlowInputBundleRunner,
} from "./prepared-inputs.js";
import { ScienceFlowPreparedInputsRepository } from "./prepared-inputs-repository.js";
import type {
  ScienceFlowRuntimeBinding,
  ScienceFlowRuntimeSettings,
} from "./runtime-config.js";

const IDENTITY = { projectId: "project-1", sessionId: "session-1" };
const REVISION = "0ef229de1ae126ea04387ce74ae94ffacc437df6";
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

const DESCRIPTION = "# Circle packing\n";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const ROLE_INDEX = new Map(
  SCIENCE_FLOW_INPUT_FILE_ROLES.map((role, index) => [role, index]),
);

/** The digest of the canonical manifest a role summary describes. */
function bundleDigestFor(
  contractDigest: string,
  list: readonly ScienceFlowPreparedInputFileDto[],
): string {
  const merged = new Map<
    string,
    { roles: ScienceFlowPreparedInputFileDto["role"][]; size: number; sha256: string }
  >();
  for (const file of list) {
    const existing = merged.get(file.path);
    if (existing === undefined) {
      merged.set(file.path, {
        roles: [file.role],
        size: file.size,
        sha256: file.sha256,
      });
      continue;
    }
    existing.roles.push(file.role);
  }
  const manifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest,
    files: [...merged.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([path, file]) => ({
        path,
        roles: [...file.roles].sort(
          (left, right) =>
            (ROLE_INDEX.get(left) as number) - (ROLE_INDEX.get(right) as number),
        ),
        size: file.size,
        sha256: file.sha256,
      })),
  };
  return sha256(Buffer.from(canonicalScienceFlowInputBundleManifest(manifest), "utf8"));
}

const BINDING: ScienceFlowRuntimeBinding = Object.freeze({
  bindingId: "binding-1",
  runnerId: "runner-1",
  runnerBindingId: "runner-binding-1",
  environmentId: "environment-1",
  expectedEnvironmentRevisionId: "revision-1",
  timeoutMs: 60_000,
});

interface Fixture {
  readonly root: string;
  readonly profile: ScienceFlowExecutionProfile;
  readonly planRepository: ScienceFlowExecutionPlanRepository;
  readonly preparedRepository: ScienceFlowPreparedInputsRepository;
  readonly runnerStore: RunnerScienceFlowInputBundles;
  readonly received: ScienceFlowInputBundleRequest[];
  readonly session: { writable: boolean; allowed: boolean; missing: boolean };
}

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  options: { readonly shared?: boolean } = {},
): Promise<Fixture> {
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  const root = await mkdtemp(
    resolve(process.cwd(), ".tmp", "scienceflow-prepare-inputs-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = (relative: string) => join(root, relative);
  await writeFile(path("manifest.yaml"), MANIFEST);
  await mkdir(path(PACKAGE), { recursive: true });
  await writeFile(path(join(PACKAGE, "task.yaml")), TASK_YAML);
  await writeFile(path(join(PACKAGE, "evaluate.py")), EVALUATOR);
  await writeFile(path(join(PACKAGE, "description.md")), DESCRIPTION);
  if (options.shared !== false) {
    await mkdir(path(join("tasks", "opt_solver", "_shared")), {
      recursive: true,
    });
    await writeFile(
      path(join("tasks", "opt_solver", "_shared", "task_defaults.yaml")),
      SHARED,
    );
  }

  const profile: ScienceFlowExecutionProfile = Object.freeze({
    profileId: "profile-1",
    scienceFlowRevision: REVISION,
    manifestPath: path("manifest.yaml"),
    taskPackageRoot: path(PACKAGE),
    allowedReadRoots: Object.freeze([root]),
    runtimeBindingId: "binding-1",
  });

  const built = await createScienceFlowContractBuilder()(profile);
  if (built.status !== "ok") assert.fail(`fixture contract ${built.status}`);

  const database = new DatabaseSync(":memory:");
  const planRepository = new ScienceFlowExecutionPlanRepository(database);
  const preparedRepository = new ScienceFlowPreparedInputsRepository(database);
  planRepository.create({
    planId: "plan-1",
    projectId: IDENTITY.projectId,
    sessionId: IDENTITY.sessionId,
    profileId: profile.profileId,
    requestId: "request-1",
    createdAt: "2026-11-13T00:00:00.000Z",
    contractDigest: digestScienceFlowContract(built.contract),
    contract: built.contract,
  });

  return {
    root,
    profile,
    planRepository,
    preparedRepository,
    runnerStore: new RunnerScienceFlowInputBundles(root),
    received: [],
    session: { writable: true, allowed: true, missing: false },
  };
}

function profiles(profile: ScienceFlowExecutionProfile): ScienceFlowExecutionSettings {
  return {
    profileFor: (profileId) =>
      profileId === profile.profileId ? profile : undefined,
    profiles: [profile],
  };
}

function runtime(
  bindings: () => readonly ScienceFlowRuntimeBinding[],
): ScienceFlowRuntimeSettings {
  return {
    bindingFor: (bindingId) =>
      bindings().find((binding) => binding.bindingId === bindingId),
    has: (bindingId) =>
      bindings().some((binding) => binding.bindingId === bindingId),
  };
}

interface HarnessOptions {
  readonly shared?: boolean;
  readonly bindings?: () => readonly ScienceFlowRuntimeBinding[];
  readonly runner?: (request: ScienceFlowInputBundleRequest) => Promise<unknown>;
  readonly build?: (body: Fixture) => ScienceFlowContractBuilder;
  readonly saveError?: unknown;
}

interface Harness {
  readonly service: ReturnType<typeof createScienceFlowPrepareInputsService>;
  readonly body: Fixture;
}

async function harness(
  context: { after(callback: () => Promise<void>): void },
  options: HarnessOptions = {},
): Promise<Harness> {
  const body = await fixture(context, { shared: options.shared });
  const runner: ScienceFlowInputBundleRunner = {
    async prepareScienceFlowInputBundle(
      request: ScienceFlowInputBundleRequest,
    ): Promise<ScienceFlowInputBundlePublication> {
      body.received.push(request);
      const answer =
        options.runner === undefined
          ? await body.runnerStore.put(request)
          : await options.runner(request);
      return answer as ScienceFlowInputBundlePublication;
    },
  };
  const store =
    options.saveError === undefined
      ? body.preparedRepository
      : {
          latest: body.preparedRepository.latest.bind(body.preparedRepository),
          allocate: body.preparedRepository.allocate.bind(body.preparedRepository),
          save: () => {
            throw options.saveError;
          },
          deleteSession: body.preparedRepository.deleteSession.bind(
            body.preparedRepository,
          ),
          deleteProject: body.preparedRepository.deleteProject.bind(
            body.preparedRepository,
          ),
        };
  const service = createScienceFlowPrepareInputsService({
    identities: {
      getProject: (projectId) =>
        body.session.missing || projectId !== IDENTITY.projectId
          ? undefined
          : { id: projectId },
      getSession: (sessionId) =>
        body.session.missing || sessionId !== IDENTITY.sessionId
          ? undefined
          : { projectId: IDENTITY.projectId },
    },
    requireWritable: () => {
      if (!body.session.writable) {
        throw Object.assign(new Error("read only"), { status: 409 });
      }
    },
    runnerAllowed: () => body.session.allowed,
    profiles: profiles(body.profile),
    runtime: runtime(options.bindings ?? (() => [BINDING])),
    plans: () => body.planRepository,
    store: () => store,
    buildContract: options.build === undefined ? createScienceFlowContractBuilder() : options.build(body),
    runnerFor: () => runner,
    now: () => "2026-11-13T00:00:10.000Z",
  });
  return { service, body };
}

function storedReceipt(body: Fixture) {
  return body.preparedRepository.latest(
    IDENTITY.projectId,
    IDENTITY.sessionId,
    "plan-1",
  );
}

test("PREP-01 the enumerated files are verified and materialized, with shared defaults", async (context) => {
  const { service, body } = await harness(context);
  const result = await service.prepare(IDENTITY, "plan-1");
  if (result.status !== "ok") assert.fail(`unexpected ${result.status}`);

  const receipt: ScienceFlowPreparedInputsDto = result.prepared;
  assert.equal(receipt.planId, "plan-1");
  assert.equal(receipt.outcome, "prepared");
  assert.equal(receipt.canStart, false);
  assert.equal(receipt.runnerId, "runner-1");
  assert.equal(receipt.generation, 1);
  assert.equal(receipt.preparedAt, "2026-11-13T00:00:10.000Z");

  const plan = body.planRepository.get(
    IDENTITY.projectId,
    IDENTITY.sessionId,
    "plan-1",
  );
  if (!plan) assert.fail("expected the plan to remain");
  assert.equal(receipt.contractDigest, plan.plan.contractDigest);
  assert.equal(plan.plan.execution.canStart, false);
  assert.equal(plan.plan.latestPreflight, null);

  assert.deepEqual(
    receipt.files.map((file) => file.role),
    ["manifest", "task_yaml", "shared_task_defaults", "description", "evaluator"],
  );
  const byRole = new Map(receipt.files.map((file) => [file.role, file]));
  assert.equal(byRole.get("manifest")?.sha256, plan.plan.contract.manifestSha256);
  assert.equal(byRole.get("task_yaml")?.sha256, plan.plan.contract.taskYamlSha256);
  assert.equal(
    byRole.get("shared_task_defaults")?.sha256,
    plan.plan.contract.sharedDefaultsSha256,
  );
  assert.equal(
    byRole.get("description")?.sha256,
    plan.plan.contract.description.sha256,
  );
  assert.equal(
    byRole.get("evaluator")?.sha256,
    plan.plan.contract.evaluator.sha256,
  );
  assert.equal(receipt.fileCount, 5);

  const sent = body.received[0];
  if (!sent) assert.fail("expected one Runner request");
  assert.equal(sent.bundleDigest, receipt.bundleDigest);
  assert.equal(sent.contractDigest, plan.plan.contractDigest);
  assert.equal(
    receipt.totalBytes,
    sent.entries.reduce((total, file) => total + file.size, 0),
  );
  for (const entry of sent.entries) {
    // The delivered bytes are the ones the digest names.
    assert.equal(
      sha256(Buffer.from(entry.content, "base64")),
      entry.sha256,
      entry.path,
    );
  }

  const status = await body.runnerStore.status(receipt.bundleDigest);
  assert.equal(status.status, "ready");
  assert.equal(status.contractDigest, plan.plan.contractDigest);

  const latest = await service.latest(IDENTITY, "plan-1");
  if (latest.status !== "ok") assert.fail(`unexpected ${latest.status}`);
  assert.deepEqual(latest.state.prepared, receipt);
});

test("PREP-02 a source file changed after the plan is frozen blocks preparation", async (context) => {
  const { service, body } = await harness(context);
  await writeFile(join(body.root, PACKAGE, "evaluate.py"), "def score(*args):\n  return 1.0\n");
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "contract-changed");
  assert.equal(body.received.length, 0);
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-03 a file that moves after the check is never the one sent", async (context) => {
  // The wrapped builder mutates the source *after* the contract was computed.
  // The service must ship the verified buffers, not re-read the path.
  const { service, body } = await harness(context, {
    build: (fixture) => async (profile) => {
      const built = await createScienceFlowContractBuilder()(profile);
      await writeFile(
        join(fixture.root, PACKAGE, "description.md"),
        "# changed after the check\n",
      );
      return built;
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  if (result.status !== "ok") assert.fail(`unexpected ${result.status}`);
  const plan = body.planRepository.get(
    IDENTITY.projectId,
    IDENTITY.sessionId,
    "plan-1",
  );
  if (!plan) assert.fail("expected the plan to remain");
  const description = result.prepared.files.find(
    (file) => file.role === "description",
  );
  assert.equal(description?.sha256, plan.plan.contract.description.sha256);
  const sent = body.received[0]?.entries.find(
    (entry) => entry.path === "package/description.md",
  );
  assert.equal(sent?.sha256, plan.plan.contract.description.sha256);
  assert.equal(
    Buffer.from(sent?.content ?? "", "base64").toString("utf8"),
    DESCRIPTION,
  );
});

test("PREP-04 a prepared bundle does not follow later source changes", async (context) => {
  const { service, body } = await harness(context);
  const prepared = await service.prepare(IDENTITY, "plan-1");
  if (prepared.status !== "ok") assert.fail(`unexpected ${prepared.status}`);
  const before = await body.runnerStore.status(prepared.prepared.bundleDigest);
  assert.equal(before.status, "ready");

  await writeFile(join(body.root, PACKAGE, "description.md"), "# new\n");
  await rm(join(body.root, PACKAGE, "evaluate.py"));

  const latest = await service.latest(IDENTITY, "plan-1");
  if (latest.status !== "ok") assert.fail(`unexpected ${latest.status}`);
  assert.deepEqual(latest.state.prepared, prepared.prepared);

  // A new preparation re-reads the sources: the build can no longer complete,
  // so it is blocked rather than a fabricated match.
  const again = await service.prepare(IDENTITY, "plan-1");
  assert.equal(again.status, "blocked");
  if (again.status === "blocked") {
    assert.deepEqual(
      again.checks.filter((check) => check.status === "failed").map((check) => check.code),
      ["evaluator_file"],
    );
  }
  assert.equal(body.received.length, 1, "the blocked attempt never reached the Runner");
  assert.equal((await body.runnerStore.status(prepared.prepared.bundleDigest)).status, "ready");
});

test("PREP-05 a Runner that cannot confirm persists nothing", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => {
      await body.runnerStore.put(request);
      throw new Error("connection reset");
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "unavailable");
  assert.equal(storedReceipt(body), undefined);
  const digest = body.received[0]?.bundleDigest;
  if (digest === undefined) assert.fail("expected one Runner request");
  assert.equal((await body.runnerStore.status(digest)).status, "ready");
});

test("PREP-06 a Runner answer for another bundle is not accepted", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => ({
      schemaVersion: 1,
      status: "ready",
      bundleDigest: "b".repeat(64),
      contractDigest: request.contractDigest,
      fileCount: request.entries.length,
      totalBytes: request.entries.reduce((total, file) => total + file.size, 0),
    }),
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "unavailable");
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-07 a Runner refusal after the await is never recorded", async (context) => {
  const { service, body } = await harness(context, {
    runner: async () => {
      body.session.allowed = false;
      throw new ScienceFlowInputBundleError("corrupt");
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "unavailable");
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-08 a withdrawn binding after the await is not recorded as current", async (context) => {
  let withdrawn = false;
  const { service, body } = await harness(context, {
    bindings: () => (withdrawn ? [] : [BINDING]),
    runner: async (request) => {
      withdrawn = true;
      return await body.runnerStore.put(request);
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "disabled");
  assert.equal(storedReceipt(body), undefined);
  // The Runner keeps the content as an unassociated cache; this round never
  // deletes shared content.
  const digest = body.received[0]?.bundleDigest;
  if (digest === undefined) assert.fail("expected one Runner request");
  assert.equal((await body.runnerStore.status(digest)).status, "ready");
});

test("PREP-09 a Session gate revoked during the await is rechecked", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => {
      body.session.allowed = false;
      return await body.runnerStore.put(request);
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "runner-denied");
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-10 a write revocation during the await throws and records nothing", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => {
      body.session.writable = false;
      return await body.runnerStore.put(request);
    },
  });
  await assert.rejects(
    service.prepare(IDENTITY, "plan-1"),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-11 a deleted Session during the await revives nothing", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => {
      body.session.missing = true;
      return await body.runnerStore.put(request);
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.deepEqual(result, { status: "not-found", resource: "project" });
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-12 an API save failure is a failure, not a registered preparation", async (context) => {
  const { service, body } = await harness(context, {
    saveError: new Error("disk full"),
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "internal-error");
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-13 a newer preparation is never overwritten by a slower one", async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { service, body } = await harness(context, {
    runner: async (request) => {
      calls += 1;
      if (calls === 1) await gate;
      return await body.runnerStore.put(request);
    },
  });
  const first = service.prepare(IDENTITY, "plan-1");
  const second = await service.prepare(IDENTITY, "plan-1");
  if (second.status !== "ok") assert.fail(`unexpected ${second.status}`);
  release();
  const late = await first;
  if (late.status !== "ok") assert.fail(`unexpected ${late.status}`);
  // The later receipt is reported, not this request's discarded observation.
  assert.equal(late.prepared.generation, second.prepared.generation);
  assert.equal(
    storedReceipt(body)?.prepared.generation,
    second.prepared.generation,
  );
});

test("PREP-14 a preparation that loses its plan mid-flight records nothing", async (context) => {
  const { service, body } = await harness(context, {
    runner: async (request) => {
      body.planRepository.deleteSession(IDENTITY.sessionId);
      return await body.runnerStore.put(request);
    },
  });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "not-found");
  assert.equal(storedReceipt(body), undefined);
});

test("PREP-15 a missing Session or plan is a uniform not-found", async (context) => {
  const { service, body } = await harness(context);
  const missing = await service.prepare(
    { projectId: "project-1", sessionId: "session-2" },
    "plan-1",
  );
  assert.deepEqual(missing, { status: "not-found", resource: "session" });
  const unknown = await service.prepare(IDENTITY, "plan-2");
  assert.deepEqual(unknown, { status: "not-found", resource: "plan" });
  body.planRepository.deleteSession(IDENTITY.sessionId);
  const read = await service.latest(IDENTITY, "plan-1");
  assert.deepEqual(read, { status: "not-found", resource: "plan" });
});

test("PREP-16 without a binding the action is disabled, with no fallback Runner", async (context) => {
  const { service, body } = await harness(context, { bindings: () => [] });
  const result = await service.prepare(IDENTITY, "plan-1");
  assert.equal(result.status, "disabled");
  assert.equal(body.received.length, 0);
  // History stays readable even when the binding is gone.
  const latest = await service.latest(IDENTITY, "plan-1");
  if (latest.status !== "ok") assert.fail(`unexpected ${latest.status}`);
  assert.equal(latest.state.prepared, null);
});

test("PREP-17 one file serving two roles is one byte set with both roles kept", () => {
  const evaluatorBytes = Buffer.from("def score(*args):\n  return 0.0\n", "utf8");
  const evaluatorSha = sha256(evaluatorBytes);
  const taskBytes = Buffer.from(TASK_YAML, "utf8");
  const manifestBytes = Buffer.from(MANIFEST, "utf8");
  const contract = {
    scienceflow: { declaredRevision: REVISION, verification: "unverified" as const },
    task: { taskId: "circle-packing", category: "opt_solver", profile: "default" },
    metric: { name: "min_distance", lowerIsBetter: false, type: "continuous", authoritative: false },
    artifact: { path: "artifacts/best.json", kind: "json" },
    evaluator: {
      entrypoint: "evaluate.py:score",
      path: "evaluate.py",
      function: "score",
      sha256: evaluatorSha,
      timeoutSec: 300,
    },
    // The description points at the evaluator file: a legal package reference.
    description: { path: "evaluate.py", sha256: evaluatorSha },
    workspace: { source: "defaults_workspace_base" as const },
    taskYamlSha256: sha256(taskBytes),
    manifestSha256: sha256(manifestBytes),
    sharedDefaultsSha256: null,
    budgets: [],
    unknowns: {
      dataset: "not-applicable" as const,
      environment: "unknown" as const,
      pricing: "unknown" as const,
      modelGateway: "unknown" as const,
      revision: "unverified" as const,
      dependencyClosure: "incomplete" as const,
    },
  };
  const files = [
    { role: "manifest" as const, path: "manifest.yaml", bytes: manifestBytes, sha256: sha256(manifestBytes) },
    { role: "task_yaml" as const, path: "package/task.yaml", bytes: taskBytes, sha256: sha256(taskBytes) },
    { role: "evaluator" as const, path: "package/evaluate.py", bytes: evaluatorBytes, sha256: evaluatorSha },
    { role: "description" as const, path: "package/evaluate.py", bytes: evaluatorBytes, sha256: evaluatorSha },
  ];

  const merged = assembleScienceFlowInputBundle(contract, files);
  if (merged.status !== "ok") assert.fail(`unexpected ${merged.status}`);
  assert.equal(merged.manifest.files.length, 3);
  const shared = merged.manifest.files.find(
    (file) => file.path === "package/evaluate.py",
  );
  assert.deepEqual(shared?.roles, ["description", "evaluator"]);
  assert.equal(
    merged.request.entries.filter((file) => file.path === "package/evaluate.py").length,
    1,
  );

  // Two different byte sets claiming one logical path is not a bundle.
  const inconsistent = assembleScienceFlowInputBundle(contract, [
    ...files.slice(0, 3),
    { ...files[3]!, sha256: "e".repeat(64) },
  ]);
  assert.equal(inconsistent.status, "contract-changed");
});

test("PREP-18 a receipt from another contract is not this plan's history", async (context) => {
  const { service, body } = await harness(context);
  const preparedResult = await service.prepare(IDENTITY, "plan-1");
  if (preparedResult.status !== "ok") {
    assert.fail(`unexpected ${preparedResult.status}`);
  }
  const database = body.preparedRepository.database;
  const row = database
    .prepare(
      "SELECT record_json FROM science_flow_prepared_inputs WHERE plan_id = ?",
    )
    .get("plan-1") as { record_json: string };
  const stored = JSON.parse(row.record_json) as {
    contractDigest: string;
    bundleDigest: string;
    files: readonly ScienceFlowPreparedInputFileDto[];
  };
  // Rewrite only the contract binding, keeping the record self-consistent so
  // the repository accepts it: the service must still refuse it for this plan.
  stored.contractDigest = "b".repeat(64);
  stored.bundleDigest = bundleDigestFor(stored.contractDigest, stored.files);
  database
    .prepare(
      "UPDATE science_flow_prepared_inputs SET record_json = ? WHERE plan_id = ?",
    )
    .run(JSON.stringify(stored), "plan-1");

  const asRepository = body.preparedRepository.latest(
    IDENTITY.projectId,
    IDENTITY.sessionId,
    "plan-1",
  );
  assert.ok(asRepository, "the repository sees a self-consistent record");
  const latest = await service.latest(IDENTITY, "plan-1");
  assert.equal(latest.status, "corrupt");
});
