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
 * An analysis-only SF → Evolve candidate format adapter. **It is not a trusted
 * execution path and no production caller starts a search with it.**
 *
 * The current Evolve boundary cannot preserve both the evaluation and the
 * permission contract for this adapter:
 *
 * - the candidate and the original evaluator share one Python process, so the
 *   candidate can mutate scratch state or replace the evaluator/result path;
 *   `chmod 0400` is a mistake guard, not an isolation boundary;
 * - the adapter source embeds every bound CSV row, so a candidate that reads
 *   the adapter can see the gate and test shards; it cannot be a held-out set;
 * - the sidecar has no generic sandboxed candidate re-evaluation endpoint, so
 *   the winner cannot be re-scored on the task's full data through SF's
 *   artifact_command path;
 * - Evolve execution is not linked to the research line's parent budget or
 *   stop chain.
 *
 * `check_evolve_pilot` uses only the shape checks and digests below to report
 * those limits. Keeping the format description here makes the gap precise
 * without pretending the adapter is runnable.
 *
 * The rest of this header describes the format itself for that analysis.
 * The two engines do not share a candidate representation: an SF
 * `artifact_command` evaluator receives the path of a produced artifact file,
 * while an Evolve `custom_script` evaluator imports a `candidate.py` and scores
 * it by shard. This module describes exactly one format:
 *
 * - the candidate defines `artifact()`, returning a JSON object;
 * - the task has exactly one CSV input, read as `dataset/<name>`;
 * - a row belongs to a case by `row_index % shardCount`, so the engine's own
 *   seeded shard permutation selects which rows a shard sees.
 *
 * The adapter never rewrites the scoring rule. It embeds the original
 * evaluator's bytes, materialises the task's bound CSV for the requested case
 * ids, serialises the candidate's returned object to the artifact path, runs
 * the original evaluator on it, and reads the metric from the path the task
 * contract declared. The only new arithmetic is the monotone map to the
 * `[0, 1]` score Evolve ranks by; the raw metric is reported beside it.
 *
 * Execution boundary: the candidate and the evaluator run as the same user
 * inside Evolve's sandbox. That sandbox confines writes to the scratch
 * directory and denies the network; it is not a second evaluator. A candidate
 * could in principle tamper with scratch state while it runs, which is why
 * Evolve's discrimination probe exists. This module makes no claim beyond that
 * boundary, and it is not used by the SF execution path.
 */

import { createHash } from "node:crypto";

/** The only candidate format this pilot supports. */
export const EVOLVE_PILOT_CANDIDATE_FORMAT = "json-artifact-function";
/** Shard slots this adapter's split declares: rollout 4 + gate 8 + test 4. */
export const EVOLVE_PILOT_SHARD_COUNT = 16;
/** The split the pilot proposes. Deterministic and sized for the adapter. */
export const EVOLVE_PILOT_SPLIT = Object.freeze({
  gateShards: 8,
  rolloutShards: 4,
  seed: 0,
  shardRows: 1,
  testShards: 4,
  trainRows: null,
});

export interface EvolvePilotDatasetInput {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface EvolvePilotAdapterInput {
  readonly artifactKind: string;
  readonly artifactPath: string;
  readonly dataset: EvolvePilotDatasetInput;
  readonly evaluatorBytes: Buffer;
  readonly lowerIsBetter: boolean;
  readonly metricJsonPath: string;
  readonly metricName: string;
  readonly timeoutSeconds?: number;
}

export interface EvolvePilotArtifacts {
  readonly candidateFormat: typeof EVOLVE_PILOT_CANDIDATE_FORMAT;
  readonly dataset: {
    readonly name: string;
    readonly rows: number;
    readonly sha256: string;
  };
  readonly evaluatorSource: string;
  readonly evaluatorSourceSha256: string;
  readonly seedSource: string;
  readonly seedSourceSha256: string;
  readonly shardCount: typeof EVOLVE_PILOT_SHARD_COUNT;
  readonly split: typeof EVOLVE_PILOT_SPLIT;
}

/** A shape this adapter cannot carry, stated as a concrete gap. */
export class EvolvePilotRefusal extends Error {
  readonly reason:
    | "unsupported-artifact"
    | "unsupported-dataset"
    | "unsupported-evaluator"
    | "invalid-incumbent"
    | "invalid-pilot-option";
  constructor(reason: EvolvePilotRefusal["reason"], message: string) {
    super(message);
    this.name = "EvolvePilotRefusal";
    this.reason = reason;
  }
}

const MAX_EVALUATOR_BYTES = 128 * 1024;
const MAX_DATASET_BYTES = 4 * 1024 * 1024;
const MAX_INCUMBENT_BYTES = 4 * 1024 * 1024;
const METRIC_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;

/** The parts of a prepared task binding this adapter reads. */
export interface EvolvePilotContract {
  readonly artifactKind: string;
  readonly artifactPath: string;
  readonly lowerIsBetter: boolean | null;
  readonly metricJsonPath: string | null;
  readonly metricName: string;
  readonly source: "catalog" | "prepared" | "fixed";
  readonly evaluatorKind: "task-package" | "generated-command";
}

/**
 * The concrete reasons this task cannot enter the pilot. An empty array means
 * the adapter can build a proposal; it does not mean a search was started.
 */
export function evolvePilotShapeGaps(input: {
  readonly contract: EvolvePilotContract;
  readonly dataset: { readonly bytes: Buffer; readonly name: string } | undefined;
  readonly evaluatorBytes: Buffer | undefined;
}): readonly string[] {
  const gaps: string[] = [];
  if (input.contract.source !== "prepared" || input.contract.evaluatorKind !== "generated-command") {
    gaps.push("Only a task prepared in this Session with its own generated evaluator can use this adapter; a catalog package evaluator has no artifact bytes to embed.");
  }
  if (input.contract.lowerIsBetter === null) {
    gaps.push("The task contract has no metric direction, so an oriented search score cannot be defined.");
  }
  if (!isJsonArtifact(input.contract.artifactKind, input.contract.artifactPath)) {
    gaps.push("Only a JSON object artifact is supported: the candidate returns a dict and the adapter serialises it to the contract's artifact path.");
  }
  if (input.contract.metricJsonPath === null || !METRIC_PATH.test(input.contract.metricJsonPath)) {
    gaps.push("The task contract has no usable dotted metric path.");
  }
  if (!input.dataset) {
    gaps.push("The task has no bound input data; this pilot requires exactly one CSV input.");
  } else if (!input.dataset.name.toLowerCase().endsWith(".csv")) {
    gaps.push("The bound input is not a CSV file; this pilot supports exactly one CSV input.");
  } else {
    const rows = csvRowCount(input.dataset.bytes);
    if (rows === undefined) {
      gaps.push("The bound CSV is not usable UTF-8 text with one header row.");
    } else if (rows < EVOLVE_PILOT_SHARD_COUNT) {
      gaps.push(`The bound CSV has ${rows} data rows; the 16-shard pilot needs at least ${EVOLVE_PILOT_SHARD_COUNT}.`);
    }
  }
  if (!input.evaluatorBytes) {
    gaps.push("The prepared evaluator bytes are unavailable, so the adapter cannot freeze them.");
  } else if (input.evaluatorBytes.length > MAX_EVALUATOR_BYTES) {
    gaps.push("The prepared evaluator exceeds the adapter's size bound.");
  } else if (!input.evaluatorBytes.includes(Buffer.from("dataset"))) {
    gaps.push("The prepared evaluator does not reference dataset/..., so the adapter cannot tell how it reads the bound CSV.");
  }
  return gaps;
}

/**
 * Build the Evolve evaluator and the seed program. Throws a refusal with the
 * first unmet shape; callers that need every gap should ask
 * `evolvePilotShapeGaps` first.
 */
export function buildEvolvePilotArtifacts(
  input: EvolvePilotAdapterInput,
  incumbent: Buffer,
): EvolvePilotArtifacts {
  const gaps = evolvePilotShapeGaps({
    contract: {
      artifactKind: input.artifactKind,
      artifactPath: input.artifactPath,
      evaluatorKind: "generated-command",
      lowerIsBetter: input.lowerIsBetter,
      metricJsonPath: input.metricJsonPath,
      metricName: input.metricName,
      source: "prepared",
    },
    dataset: input.dataset,
    evaluatorBytes: input.evaluatorBytes,
  });
  if (gaps.length) {
    throw new EvolvePilotRefusal(
      input.evaluatorBytes.length > MAX_EVALUATOR_BYTES ? "unsupported-evaluator" : "unsupported-dataset",
      gaps[0]!,
    );
  }
  const rows = csvRowCount(input.dataset.bytes);
  if (rows === undefined) {
    throw new EvolvePilotRefusal("unsupported-dataset", "The bound CSV is not usable text");
  }
  const evaluatorSource = renderEvaluator({
    artifactKind: input.artifactKind,
    artifactPath: input.artifactPath,
    dataset: input.dataset,
    evaluatorBytes: input.evaluatorBytes,
    lowerIsBetter: input.lowerIsBetter,
    metricJsonPath: input.metricJsonPath,
    metricName: input.metricName,
    timeoutSeconds: input.timeoutSeconds ?? 60,
  });
  return {
    candidateFormat: EVOLVE_PILOT_CANDIDATE_FORMAT,
    dataset: {
      name: input.dataset.name,
      rows,
      sha256: sha256(input.dataset.bytes),
    },
    evaluatorSource,
    evaluatorSourceSha256: sha256(Buffer.from(evaluatorSource, "utf8")),
    seedSource: buildEvolveCandidateSeed(incumbent),
    seedSourceSha256: sha256(Buffer.from(buildEvolveCandidateSeed(incumbent), "utf8")),
    shardCount: EVOLVE_PILOT_SHARD_COUNT,
    split: EVOLVE_PILOT_SPLIT,
  };
}

/**
 * Turn an SF delivered solution into the starting program the Evolve search
 * mutates. The JSON is embedded as base64 so a solution string can never break
 * the generated Python literal.
 */
export function buildEvolveCandidateSeed(solution: Buffer): string {
  if (solution.length === 0 || solution.length > MAX_INCUMBENT_BYTES) {
    throw new EvolvePilotRefusal("invalid-incumbent", "The starting solution is empty or too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(solution.toString("utf8"));
  } catch {
    throw new EvolvePilotRefusal("invalid-incumbent", "The starting solution is not valid JSON");
  }
  if (!isRecord(value)) {
    throw new EvolvePilotRefusal("invalid-incumbent", "The starting solution is not a JSON object");
  }
  const encoded = solution.toString("base64");
  return [
    '"""Starting program seeded from the delivered SF solution. Kept unchanged until a mutation replaces it."""',
    "import base64",
    "import json",
    "",
    `_SOLUTION_B64 = "${encoded}"`,
    "",
    "",
    "def artifact():",
    '    """Return the JSON object this task evaluates."""',
    '    return json.loads(base64.b64decode(_SOLUTION_B64).decode("utf-8"))',
    "",
  ].join("\n");
}

/** A candidate file name this adapter can import. */
export function isImportableCandidateName(name: string): boolean {
  const stem = name.endsWith(".py") ? name.slice(0, -3) : name;
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(stem);
}

function renderEvaluator(input: {
  readonly artifactKind: string;
  readonly artifactPath: string;
  readonly dataset: EvolvePilotDatasetInput;
  readonly evaluatorBytes: Buffer;
  readonly lowerIsBetter: boolean;
  readonly metricJsonPath: string;
  readonly metricName: string;
  readonly timeoutSeconds: number;
}): string {
  if (!isJsonArtifact(input.artifactKind, input.artifactPath)) {
    throw new EvolvePilotRefusal("unsupported-artifact", "The adapter supports a JSON artifact path only");
  }
  const replacements: Record<string, string> = {
    ARTIFACT_PATH: JSON.stringify(normalizeRelativePath(input.artifactPath)),
    DATASET_B64: input.dataset.bytes.toString("base64"),
    DATASET_NAME: JSON.stringify(input.dataset.name),
    EVALUATOR_B64: input.evaluatorBytes.toString("base64"),
    LOWER_IS_BETTER: input.lowerIsBetter ? "True" : "False",
    METRIC_JSON_PATH: JSON.stringify(input.metricJsonPath),
    METRIC_NAME: JSON.stringify(input.metricName),
    SHARD_COUNT: String(EVOLVE_PILOT_SHARD_COUNT),
    TIMEOUT_SECONDS: String(Math.max(1, Math.min(600, Math.trunc(input.timeoutSeconds)))),
  };
  let source = EVOLVE_PILOT_EVALUATOR_TEMPLATE;
  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`__${key}__`, value);
  }
  return source;
}

function isJsonArtifact(kind: string, path: string): boolean {
  return /json/iu.test(kind) && path.toLowerCase().endsWith(".json");
}

function normalizeRelativePath(path: string): string {
  const parts = path.replace(/\\/gu, "/").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new EvolvePilotRefusal("unsupported-artifact", "The artifact path must stay inside the candidate workspace");
  }
  return parts.join("/");
}

function csvRowCount(bytes: Buffer): number | undefined {
  if (bytes.length === 0 || bytes.length > MAX_DATASET_BYTES || bytes.includes(0)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return undefined;
  return lines.length - 1;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The generated evaluator. It is a fixed program, not model text: every value
 * that could differ between tasks is substituted before it reaches Evolve, and
 * the original evaluator bytes travel with it.
 */
const EVOLVE_PILOT_EVALUATOR_TEMPLATE = String.raw`"""Evolve candidate contract.

candidate.py must define artifact(), returning a JSON object for this task.
The original task evaluator is run on that object unchanged. The metric path
and the task's bound CSV are fixed below; SCIENCE_AGENT_SHARDS selects which
rows this evaluation sees, and SCIENCE_AGENT_RESULT receives one JSON object.
"""

import base64
import importlib
import json
import math
import os
import subprocess
import sys
import traceback

CANDIDATE_ENV = "SCIENCE_AGENT_CANDIDATE"
SHARDS_ENV = "SCIENCE_AGENT_SHARDS"
RESULT_ENV = "SCIENCE_AGENT_RESULT"

EVALUATOR_SOURCE_B64 = "__EVALUATOR_B64__"
DATASET_NAME = __DATASET_NAME__
DATASET_B64 = "__DATASET_B64__"
ARTIFACT_PATH = __ARTIFACT_PATH__
METRIC_NAME = __METRIC_NAME__
METRIC_JSON_PATH = __METRIC_JSON_PATH__
LOWER_IS_BETTER = __LOWER_IS_BETTER__
TIMEOUT_SECONDS = __TIMEOUT_SECONDS__
SHARD_COUNT = __SHARD_COUNT__
EVALUATOR_FILE = "_sd_original_evaluator.py"
MAX_TEXT = 2000


def _write(payload):
    path = os.environ.get(RESULT_ENV) or "result.json"
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    return payload


def _invalid(message, metrics=None):
    return _write({"valid": False, "metrics": metrics or {}, "error": str(message)[:MAX_TEXT]})


def _valid(metric, score):
    return _write({"valid": True, "metrics": {METRIC_NAME: metric, "score": score}, "error": ""})


def _extract(payload):
    value = payload
    for part in METRIC_JSON_PATH.split("."):
        if isinstance(value, list):
            value = value[int(part)]
        elif isinstance(value, dict):
            value = value[part]
        else:
            raise ValueError("the metric path does not resolve in the evaluator output")
    return value


def _oriented(metric):
    # Monotone, bounded and never touches the bound; the raw metric is reported
    # beside it so the adapter does not hide what the original evaluator said.
    shaped = metric / (1.0 + abs(metric))
    if LOWER_IS_BETTER:
        return 0.5 - 0.5 * shaped
    return 0.5 + 0.5 * shaped


def _read_shards():
    raw = os.environ.get(SHARDS_ENV) or ""
    shards = [int(part) for part in raw.split(",") if part.strip()]
    if not shards:
        raise ValueError("SCIENCE_AGENT_SHARDS is empty")
    return shards


def _materialize_dataset(shards):
    text = base64.b64decode(DATASET_B64).decode("utf-8")
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError("the bound CSV has no data rows")
    header, rows = lines[0], lines[1:]
    selected = [row for index, row in enumerate(rows) if index % SHARD_COUNT in shards]
    if not selected:
        raise ValueError("this shard selects no rows")
    directory = os.path.join(os.getcwd(), "dataset")
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, DATASET_NAME), "w", encoding="utf-8") as handle:
        handle.write(header + "\n" + "\n".join(selected) + "\n")


def _candidate_artifact():
    name = os.environ.get(CANDIDATE_ENV) or "candidate.py"
    module_name = name[:-3] if name.endswith(".py") else name
    if not module_name.isidentifier():
        raise ValueError("the candidate file name is not importable")
    sys.path.insert(0, os.getcwd())
    module = importlib.import_module(module_name)
    build = getattr(module, "artifact", None)
    if not callable(build):
        raise ValueError("candidate.py must define artifact()")
    value = build()
    if not isinstance(value, dict):
        raise ValueError("artifact() must return a JSON object")
    return value


def _run():
    # The candidate runs first. The original evaluator file is written after
    # that, so the candidate's own import/return cannot replace the bytes this
    # evaluation is about to run.
    artifact = _candidate_artifact()
    artifact_path = os.path.join(os.getcwd(), ARTIFACT_PATH)
    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
    with open(artifact_path, "w", encoding="utf-8") as handle:
        json.dump(artifact, handle, allow_nan=False)

    evaluator_path = os.path.join(os.getcwd(), EVALUATOR_FILE)
    with open(evaluator_path, "wb") as handle:
        handle.write(base64.b64decode(EVALUATOR_SOURCE_B64))
    # A mistake guard only. The candidate runs as the same user in the same
    # scratch directory and can rewrite this file; this is not a boundary.
    try:
        os.chmod(evaluator_path, 0o400)
    except OSError:
        pass

    completed = subprocess.run(
        [sys.executable, "-I", evaluator_path, artifact_path],
        cwd=os.getcwd(), capture_output=True, text=True, timeout=TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip()[-MAX_TEXT:]
        raise ValueError("the original evaluator rejected the artifact" + (": " + tail if tail else ""))
    payload = None
    for line in reversed((completed.stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if payload is None:
        raise ValueError("the original evaluator printed no JSON object")
    metric = _extract(payload)
    if isinstance(metric, bool) or not isinstance(metric, (int, float)) or not math.isfinite(float(metric)):
        raise ValueError("the original evaluator returned no finite metric")
    return _valid(float(metric), _oriented(float(metric)))


def main():
    try:
        _materialize_dataset(_read_shards())
        return _run()
    except subprocess.TimeoutExpired:
        return _invalid("the original evaluator exceeded its timeout")
    except Exception as error:
        return _invalid("".join(traceback.format_exception_only(type(error), error)).strip())


main()
`;
