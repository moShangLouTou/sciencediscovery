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
 * The SF → Evolve adapter is exercised with a real Python interpreter.
 *
 * The fixture evaluator is a real evaluator, not a mock of one: it reads the
 * serialized artifact and the sharded CSV, computes a metric, prints one JSON
 * object and rejects a domain violation. The test therefore proves the
 * protocol, the shard selection, the metric path and the oriented score rather
 * than mirroring the generator's strings.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  buildEvolveCandidateSeed,
  buildEvolvePilotArtifacts,
  EvolvePilotRefusal,
  evolvePilotShapeGaps,
  EVOLVE_PILOT_SHARD_COUNT,
} from "./evolve-pilot-adapter.js";

const EVALUATOR = `import csv, json, sys
from pathlib import Path

artifact = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
a = float(artifact["a"])
b = float(artifact["b"])
if abs(a) > 10 or abs(b) > 10:
    sys.stderr.write("a or b violates |value| <= 10\\n")
    raise SystemExit(3)
with open("dataset/fit.csv", encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))
if not rows:
    raise SystemExit(4)
errors = [(a * float(row["x"]) + b - float(row["y"])) ** 2 for row in rows]
metric = (sum(errors) / len(errors)) ** 0.5
print(json.dumps({"metric": metric}))
`;

function dataset(): { bytes: Buffer; expected: (shards: number[]) => number } {
  const rows = Array.from({ length: EVOLVE_PILOT_SHARD_COUNT }, (_, index) => {
    const x = index + 1;
    const noise = (index + 1) / 10;
    return { x, y: 2 * x + 1 + noise };
  });
  const text = `x,y\n${rows.map((row) => `${row.x},${row.y}`).join("\n")}\n`;
  return {
    bytes: Buffer.from(text, "utf8"),
    expected: (shards) => {
      const selected = rows.filter((_, index) => shards.includes(index % EVOLVE_PILOT_SHARD_COUNT));
      const errors = selected.map((row) => ((2 * row.x + 1 - row.y) ** 2));
      return Math.sqrt(errors.reduce((total, value) => total + value, 0) / errors.length);
    },
  };
}

function lowerScore(metric: number): number {
  return 0.5 - 0.5 * (metric / (1 + Math.abs(metric)));
}

function higherScore(metric: number): number {
  return 0.5 + 0.5 * (metric / (1 + Math.abs(metric)));
}

function python(): string | undefined {
  for (const candidate of [process.env.PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() === "3") return candidate;
  }
  return undefined;
}

interface RunResult {
  readonly valid?: boolean;
  readonly metrics?: Record<string, number>;
  readonly error?: string;
}

function runAdapter(
  context: TestContext,
  input: {
    readonly candidate: string;
    readonly evaluatorSource: string;
    readonly shards: string;
  },
): Promise<RunResult> {
  const interpreter = python();
  assert.ok(interpreter, "this test needs a Python 3 interpreter");
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "sd-evolve-adapter-"));
    context.after(async () => {
      await rm(directory, { force: true, recursive: true });
    });
    await writeFile(join(directory, "evaluate.py"), input.evaluatorSource, "utf8");
    await writeFile(join(directory, "candidate.py"), input.candidate, "utf8");
    const resultPath = join(directory, "result.json");
    const completed = spawnSync(interpreter, [join(directory, "evaluate.py")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        SCIENCE_AGENT_CANDIDATE: "candidate.py",
        SCIENCE_AGENT_RESULT: resultPath,
        SCIENCE_AGENT_SHARDS: input.shards,
      },
      timeout: 30_000,
    });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    return JSON.parse(await readFile(resultPath, "utf8")) as RunResult;
  })();
}

function adapterFor(lowerIsBetter = true, metricJsonPath = "metric") {
  const data = dataset();
  return buildEvolvePilotArtifacts({
    artifactKind: "json_solution",
    artifactPath: "artifacts/solution.json",
    dataset: { bytes: data.bytes, name: "fit.csv" },
    evaluatorBytes: Buffer.from(EVALUATOR, "utf8"),
    lowerIsBetter,
    metricJsonPath,
    metricName: lowerIsBetter ? "rmse" : "accuracy",
    timeoutSeconds: 20,
  }, Buffer.from(JSON.stringify({ a: 2, b: 1 }), "utf8"));
}

test("the adapter runs the original evaluator on exactly the requested CSV shard", async (context) => {
  const artifacts = adapterFor();
  assert.match(artifacts.evaluatorSource, /SCIENCE_AGENT_SHARDS/);
  assert.match(artifacts.evaluatorSource, /SCIENCE_AGENT_RESULT/);
  assert.equal(artifacts.shardCount, 16);
  const data = dataset();
  for (const shards of [[0, 1, 2, 3], [4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15]]) {
    const result = await runAdapter(context, {
      candidate: "def artifact():\n    return {\"a\": 2, \"b\": 1}\n",
      evaluatorSource: artifacts.evaluatorSource,
      shards: shards.join(","),
    });
    assert.equal(result.valid, true, result.error ?? "");
    const metric = result.metrics?.rmse;
    assert.ok(typeof metric === "number" && Number.isFinite(metric));
    assert.ok(Math.abs(metric - data.expected(shards)) < 1e-12, `${metric} != ${data.expected(shards)}`);
    assert.ok(Math.abs((result.metrics?.score ?? 0) - lowerScore(metric)) < 1e-12);
  }
});

test("a higher-is-better metric maps the other way and the raw value stays visible", async (context) => {
  const artifacts = adapterFor(false);
  const result = await runAdapter(context, {
    candidate: "def artifact():\n    return {\"a\": 2, \"b\": 1}\n",
    evaluatorSource: artifacts.evaluatorSource,
    shards: "0,1,2,3",
  });
  assert.equal(result.valid, true, result.error ?? "");
  const metric = result.metrics?.accuracy;
  assert.ok(typeof metric === "number");
  assert.ok(Math.abs((result.metrics?.score ?? 0) - higherScore(metric)) < 1e-12);
  assert.ok((result.metrics?.score ?? 0) >= 0.5);
});

test("a domain-violating candidate is reported invalid with the original evaluator's reason", async (context) => {
  const artifacts = adapterFor();
  const result = await runAdapter(context, {
    candidate: "def artifact():\n    return {\"a\": 1000, \"b\": 0}\n",
    evaluatorSource: artifacts.evaluatorSource,
    shards: "0,1,2,3",
  });
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /violates/);
});

test("a candidate without artifact() is refused before the evaluator runs", async (context) => {
  const artifacts = adapterFor();
  const result = await runAdapter(context, {
    candidate: "def solve():\n    return {\"a\": 2}\n",
    evaluatorSource: artifacts.evaluatorSource,
    shards: "0,1,2,3",
  });
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /artifact\(\)/);
});

test("the seed program reproduces the delivered JSON object", async (context) => {
  const artifacts = adapterFor();
  const seed = buildEvolveCandidateSeed(Buffer.from(JSON.stringify({ a: 2, b: 1 }), "utf8"));
  assert.match(seed, /def artifact\(\)/);
  const result = await runAdapter(context, {
    candidate: seed,
    evaluatorSource: artifacts.evaluatorSource,
    shards: "0,1,2,3",
  });
  assert.equal(result.valid, true, result.error ?? "");
  assert.ok((result.metrics?.rmse ?? -1) >= 0);
});

test("unsupported task shapes are reported as concrete gaps, not silently adapted", () => {
  const data = dataset();
  const gaps = evolvePilotShapeGaps({
    contract: {
      artifactKind: "binary",
      artifactPath: "artifacts/solution.bin",
      evaluatorKind: "task-package",
      lowerIsBetter: null,
      metricJsonPath: null,
      metricName: "score",
      source: "catalog",
    },
    dataset: { bytes: data.bytes, name: "fit.parquet" },
    evaluatorBytes: undefined,
  });
  assert.ok(gaps.some((gap) => /generated evaluator/.test(gap)));
  assert.ok(gaps.some((gap) => /JSON object artifact/.test(gap)));
  assert.ok(gaps.some((gap) => /metric direction/.test(gap)));
  assert.ok(gaps.some((gap) => /exactly one CSV/.test(gap)));
  assert.ok(gaps.some((gap) => /evaluator bytes are unavailable/.test(gap)));
  assert.throws(
    () => buildEvolvePilotArtifacts({
      artifactKind: "binary",
      artifactPath: "artifacts/solution.bin",
      dataset: { bytes: data.bytes, name: "fit.csv" },
      evaluatorBytes: Buffer.from(EVALUATOR, "utf8"),
      lowerIsBetter: true,
      metricJsonPath: "metric",
      metricName: "score",
    }, Buffer.from("{}", "utf8")),
    (error: unknown) => error instanceof EvolvePilotRefusal,
  );
});
