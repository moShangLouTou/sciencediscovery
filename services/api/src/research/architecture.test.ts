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
 * The shared research modules must stay usable by a product that has no
 * ScienceFlow code, configuration or data layout. This guard fails if any
 * non-test module under `src/research/` imports ScienceFlow or its reader.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESEARCH_DIR = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [
  /from\s+["'][^"']*scienceflow/u,
  /from\s+["']@sciencediscovery\/scienceflow-reader["']/u,
  /import\s*\(\s*["'][^"']*scienceflow/u,
];

test("shared research modules never import ScienceFlow", async () => {
  const entries = await readdir(RESEARCH_DIR, { withFileTypes: true });
  const sources = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name);
  assert.ok(sources.length > 0);
  const offenders: string[] = [];
  for (const name of sources) {
    const source = await readFile(join(RESEARCH_DIR, name), "utf8");
    for (const pattern of FORBIDDEN) {
      if (pattern.test(source)) offenders.push(`${name}: ${pattern.source}`);
    }
  }
  assert.deepEqual(offenders, []);
});
