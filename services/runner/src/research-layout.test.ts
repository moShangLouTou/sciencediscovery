// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSandboxLaunch } from "./executor.js";
test("engine layout preserves the trusted product mount through runtime resolution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sd-engine-layout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, ".venv"), { recursive: true });
  const base = { chdir: "/workspace", environmentBinds: [], environmentPaths: [], hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} }, language: "python" as const, pathEnv: "/usr/bin",
    workspaceBindArgs: [], workspaceRoot: join(root, "workspace") };
  for (const mountPath of [undefined, "/product-engine"]) {
    const launch = await prepareSandboxLaunch({ bwrapPath: "bwrap", dataDir: root }, { ...base,
      researchEngine: { sourceRoot, mountPath, maskVirtualEnv: true } });
    const args = launch.args;
    const target = mountPath ?? "/research-engine";
    assert.ok(args.some((value, index) => value === "--ro-bind" && args[index + 1] === sourceRoot && args[index + 2] === target));
    assert.ok(args.some((value, index) => value === "--tmpfs" && args[index + 1] === `${target}/.venv`));
  }
});
