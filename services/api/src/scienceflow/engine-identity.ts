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

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { parsePorcelain } from "@sciencediscovery/scienceflow-reader";
import type { EngineSourceIdentity, ExecutionEnvironmentIdentity } from "./domain/experiment-comparison.js";
/**
 * The engine checkout's own git identity, read without modifying it.
 *
 * `HEAD` alone is not enough: the reference deployment applies a patch series
 * or may carry local changes, and two runs that report the same `HEAD` can
 * import different evaluator bytes. The identity therefore also carries a
 * dirty flag, and the catalog binding separately carries the actual evaluator
 * and package digests. A failure is reported as unknown, never guessed.
 */
export async function readEngineSourceIdentity(
  engineCheckout: string,
  timeoutMs = 3_000,
): Promise<EngineSourceIdentity | undefined> {
  const root = await runGitBounded(engineCheckout, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (root === undefined || root.trim() !== engineCheckout) return undefined;
  const revision = await runGitBounded(engineCheckout, ["rev-parse", "--verify", "HEAD"], timeoutMs);
  if (revision === undefined || !/^[a-f0-9]{40}$/u.test(revision.trim())) return undefined;
  const status = await runGitBounded(
    engineCheckout,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    timeoutMs,
  );
  if (status === undefined) return undefined;
  const summary = parsePorcelain(status);
  return {
    dirty: summary.trackedModified || summary.untrackedRunnable,
    revision: revision.trim(),
    statusDigest: createHash("sha256").update(status).digest("hex"),
  };
}

/**
 * The actual execution environment of the engine's interpreter: host platform,
 * architecture, CPU class, Python version and interpreter/prefix identity.
 * The fingerprint hashes paths and the hostname rather than exposing them; the
 * public fields are only platform/arch/python. Two source-identical checkouts
 * on different machines, CPUs or interpreters therefore never share a group,
 * so speed-like metrics cannot be ranked across them.
 */
export async function readExecutionEnvironment(
  pythonExecutable: string,
  timeoutMs = 3_000,
): Promise<ExecutionEnvironmentIdentity | undefined> {
  const raw = await runProcessBounded(pythonExecutable, ["-I", "-c", EXECUTION_ENVIRONMENT_PROGRAM], timeoutMs);
  if (raw === undefined) return undefined;
  let payload: unknown;
  for (const line of raw.split("\n").map((value) => value.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      payload = JSON.parse(line);
      break;
    } catch {
      continue;
    }
  }
  if (!isRecord(payload)) return undefined;
  const platform = typeof payload.platform === "string" ? payload.platform : "";
  const arch = typeof payload.arch === "string" ? payload.arch : "";
  const python = typeof payload.python === "string" ? payload.python : "";
  if (!platform || !arch || !python) return undefined;
  const fingerprint = createHash("sha256").update(canonicalJson({
    arch,
    cpu: typeof payload.cpu === "string" ? payload.cpu : "",
    cpuCount: typeof payload.cpuCount === "number" ? payload.cpuCount : 0,
    executableHash: sha256Text(typeof payload.executable === "string" ? payload.executable : ""),
    nodeHash: sha256Text(typeof payload.node === "string" ? payload.node : ""),
    platform,
    prefixHash: sha256Text(typeof payload.prefix === "string" ? payload.prefix : ""),
    python,
  })).digest("hex");
  return { arch, fingerprint, platform, python };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EXECUTION_ENVIRONMENT_PROGRAM = String.raw`import json, os, platform, sys
def cpu_model():
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as handle:
            for line in handle:
                if line.strip().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor()
print(json.dumps({
    "arch": platform.machine(),
    "cpu": cpu_model(),
    "cpuCount": os.cpu_count(),
    "executable": sys.executable,
    "node": platform.node(),
    "platform": sys.platform,
    "prefix": sys.prefix,
    "python": "%d.%d.%d" % sys.version_info[:3],
}))
`;

/** One bounded Git invocation; stdout only, never a shell. */
function runProcessBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolvePromise) => {
    let settled = false;
    let output = "";
    let child: ChildProcess | undefined;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(value);
    };
    const timer: NodeJS.Timeout | undefined = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
      finish(undefined);
    }, timeoutMs);
    timer.unref();
    try {
      child = spawn(command, [...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(undefined);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < 262_144) output += chunk;
    });
    child.once("error", () => finish(undefined));
    // `close` fires after stdout is drained; `exit` can fire before the last
    // chunk arrives, which would parse an empty environment report.
    child.once("close", (code) => finish(code === 0 ? output : undefined));
  });
}

function runGitBounded(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return runProcessBounded("git", ["-C", cwd, ...args], timeoutMs);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

