// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const modules = ["research-run", "research-input-bundles", "research-input-bundles-http", "research-tunnel",
  "execution-manager", "execution-boundary", "execution-resource-fences", "termination-resources", "runtime-probe"];
test("shared Runner execution modules have no product imports or fixed product workload", async () => {
  for (const name of modules) {
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["'][^"']*scienceflow/i, name);
    assert.doesNotMatch(source, /scienceflow-fixed/, name);
  }
});
