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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  loadScienceFlowLocalResearchConfig,
  SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV,
  SCIENCE_FLOW_LOCAL_RESEARCH_TASK_TEXT_MAX_BYTES,
} from "./local-research-config.js";

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly seedDir: string;
  readonly workRoot: string;
  readonly privateRoot: string;
  readonly taskTextPath: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-local-research-config-"));
  context.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const seedDir = join(root, "seed");
  const workRoot = join(root, "work");
  const privateRoot = join(root, "private");
  const taskTextPath = join(root, "task.txt");
  await mkdir(seedDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await writeFile(taskTextPath, "Run the three bounded commands in order.\n", "utf8");
  return { configPath: join(root, "local-research.json"), privateRoot, root, seedDir, taskTextPath, workRoot };
}

function configValue(target: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    research: {
      engineCheckout: join(target.root, "engine"),
      privateRoot: target.privateRoot,
      profileId: "round23-local",
      pythonExecutable: "/usr/bin/python3",
      readerScriptPath: join(target.root, "snapshot.py"),
      seedDir: target.seedDir,
      task: "circle-packing",
      taskDescriptionPath: target.taskTextPath,
      workRoot: target.workRoot,
    },
    schemaVersion: 1,
    ...overrides,
  };
}

async function load(target: Fixture, value: unknown) {
  await writeFile(target.configPath, JSON.stringify(value), "utf8");
  return loadScienceFlowLocalResearchConfig(
    { [SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV]: target.configPath },
    target.root,
  );
}

test("an unset or explicitly disabled file exposes nothing", async (context) => {
  const target = await fixture(context);
  assert.equal(
    loadScienceFlowLocalResearchConfig({}, target.root),
    undefined,
  );
  assert.equal(
    loadScienceFlowLocalResearchConfig({ [SCIENCE_FLOW_LOCAL_RESEARCH_CONFIG_ENV]: "  " }, target.root),
    undefined,
  );
  assert.equal(await load(target, { enabled: false, schemaVersion: 1 }), undefined);
  // Anything other than an explicit true is off, including a typo.
  assert.equal(await load(target, { enabled: "yes", schemaVersion: 1 }), undefined);
});

test("a valid profile binds absolute roots and the fixed task text", async (context) => {
  const target = await fixture(context);
  const settings = await load(target, configValue(target, {
    defaults: { observeMaxWaitMs: 30_000, researchBudgetSec: 120, reportBudgetSec: 30, totalAllowanceSec: 200 },
  }));
  assert.ok(settings);
  assert.equal(settings.profileId, "round23-local");
  assert.equal(settings.task, "circle-packing");
  assert.equal(settings.seedDir, target.seedDir);
  assert.equal(settings.workRoot, target.workRoot);
  assert.equal(settings.taskDescription, "Run the three bounded commands in order.");
  assert.equal(settings.refusePackageInstall, true);
  assert.equal(settings.defaults.researchBudgetSec, 120);
  assert.equal(settings.defaults.observeMaxWaitMs, 30_000);
  // Unspecified defaults keep the standing pilot allowance.
  assert.equal(settings.defaults.maxSteps, 24);
});

test("refuses a profile whose roots overlap", async (context) => {
  const target = await fixture(context);
  const nestedPrivate = join(target.workRoot, "private");
  await assert.rejects(
    load(target, configValue(target, {
      research: { ...(configValue(target).research as Record<string, unknown>), privateRoot: nestedPrivate },
    })),
    /privateRoot must be outside/,
  );
  const nestedWork = join(target.seedDir, "work");
  await assert.rejects(
    load(target, configValue(target, {
      research: { ...(configValue(target).research as Record<string, unknown>), workRoot: nestedWork },
    })),
    /must not overlap the seed dir/,
  );
});

test("refuses unusable configuration instead of partially trusting it", async (context) => {
  const target = await fixture(context);
  await assert.rejects(load(target, { ...configValue(target), schemaVersion: 2 }), /schemaVersion/);
  await assert.rejects(load(target, { ...configValue(target), extra: true }), /unsupported key/);
  await assert.rejects(
    load(target, configValue(target, {
      research: { ...(configValue(target).research as Record<string, unknown>), seedDir: "relative/seed" },
    })),
    /must be an absolute path/,
  );
  await assert.rejects(
    load(target, configValue(target, {
      research: { ...(configValue(target).research as Record<string, unknown>), task: "../escape" },
    })),
    /not a usable engine task name/,
  );
  await assert.rejects(
    load(target, configValue(target, { defaults: { researchBudgetSec: 10 } })),
    /researchBudgetSec/,
  );
  await assert.rejects(
    load(target, configValue(target, {
      defaults: { reportBudgetSec: 60, researchBudgetSec: 840, totalAllowanceSec: 899 },
    })),
    /must cover the research and report budgets/,
  );
  await assert.rejects(
    load(target, configValue(target, {
      research: { ...(configValue(target).research as Record<string, unknown>), taskDescriptionPath: join(target.root, "missing.txt") },
    })),
    /must name a readable file/,
  );
  await writeFile(target.taskTextPath, "x".repeat(SCIENCE_FLOW_LOCAL_RESEARCH_TASK_TEXT_MAX_BYTES + 1), "utf8");
  await assert.rejects(load(target, configValue(target)), /must not exceed/);
});
