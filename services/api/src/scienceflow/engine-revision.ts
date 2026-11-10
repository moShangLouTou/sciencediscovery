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
 * Trusted engine source revision check.
 *
 * It answers one question without running the engine: is the checkout this
 * deployment would load still the commit an administrator expects, unmodified?
 * A commit id alone cannot answer that, so the check reads the actual HEAD, the
 * working-tree status, and the checkout root.
 *
 * Boundaries that make it trustworthy:
 *
 * - the path is supplied by a trusted caller (never an HTTP client), and the
 *   default is no path at all: the untracked reference checkout in the main
 *   worktree is never used implicitly;
 * - Git runs with an argv array, `shell: false`, a minimal environment, a
 *   timeout, and bounded output; it never fetches, checks out, installs, or
 *   imports anything;
 * - failures are static reasons. No command output, path, or repository content
 *   is ever returned or logged, so a fixture marker cannot leak through an
 *   error path.
 *
 * A source-checkout result is not a verification of an installed Python
 * environment: a wheel or source archive has no Git history, is reported as
 * unsupported, and its version is never guessed.
 */
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** Bound on any single Git invocation. */
export const DEFAULT_REVISION_TIMEOUT_MS = 5_000;
/** Bound on any single Git invocation's output. */
export const DEFAULT_REVISION_MAX_OUTPUT_BYTES = 256 * 1024;

const REVISION_PATTERN = /^[0-9a-f]{40}$/;

/**
 * File kinds that can change what a source checkout runs. Untracked files of
 * other kinds (documents, images) do not make a checkout dirty for this check;
 * a modification to any *tracked* file always does.
 */
const RUNNABLE_EXTENSIONS = [
  ".py",
  ".pyi",
  ".sh",
  ".bash",
  ".toml",
  ".cfg",
  ".ini",
  ".json",
  ".yaml",
  ".yml",
  ".pth",
  ".txt",
];
const RUNNABLE_FILENAMES = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "MANIFEST.in",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
];

export interface EngineRevisionCheckOptions {
  /** Absolute path of the checkout root, from a trusted caller only. */
  readonly path: string;
  /** The commit the deployment is supposed to run; full 40-hex. */
  readonly expectedRevision: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /**
   * Absolute path of the Git binary. Not a request field: only a trusted caller
   * or test may set it, so the checked history cannot be swapped by input.
   */
  readonly gitExecutable?: string;
}

export type EngineRevisionStatus =
  /** HEAD is the expected commit and the working tree has no relevant change. */
  | "verified-clean"
  /** HEAD is a different commit than expected. */
  | "revision-mismatch"
  /** HEAD matches but tracked or runnable-untracked changes exist. */
  | "dirty"
  /** No Git history to check (wheel, archive, plain directory). */
  | "unsupported"
  /** The check could not be completed. */
  | "unavailable";

export type EngineRevisionReason =
  | "not-a-git-checkout"
  | "path-not-checkout-root"
  | "git-unavailable"
  | "timeout"
  | "output-limit"
  | "unreadable";

export interface EngineRevisionCheckResult {
  readonly status: EngineRevisionStatus;
  /** The actual HEAD when it could be read; null otherwise. */
  readonly revision: string | null;
  readonly dirty: boolean;
  /** Static reason; never command output, a path, or repository content. */
  readonly reason: EngineRevisionReason | null;
  /** Whether any tracked file was modified (subset of `dirty`). */
  readonly trackedModified: boolean;
  /** Whether a runnable but untracked source file exists (subset of `dirty`). */
  readonly untrackedRunnable: boolean;
}

/**
 * Check one checkout. Never throws for a bad input path: the result carries a
 * static reason instead. Throws only when the caller passes malformed options.
 */
export async function checkEngineRevision(
  options: EngineRevisionCheckOptions,
): Promise<EngineRevisionCheckResult> {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  if (
    typeof options.path !== "string" ||
    !isAbsolute(options.path) ||
    options.path.includes("\0")
  ) {
    throw new TypeError("path must be an absolute path");
  }
  if (
    typeof options.expectedRevision !== "string" ||
    !REVISION_PATTERN.test(options.expectedRevision)
  ) {
    throw new TypeError("expectedRevision must be a full 40-hex commit id");
  }
  const timeoutMs = positive(options.timeoutMs, DEFAULT_REVISION_TIMEOUT_MS);
  const maxOutputBytes = positive(
    options.maxOutputBytes,
    DEFAULT_REVISION_MAX_OUTPUT_BYTES,
  );
  const root = resolve(options.path);
  const gitExecutable = resolveGitExecutable(options.gitExecutable);
  // `-C root` makes every command read the same checkout; core.fsmonitor is
  // disabled by runGit so a watcher cannot influence the status output.
  const run = (args: readonly string[]) =>
    runGit(gitExecutable, ["-C", root, ...args], timeoutMs, maxOutputBytes);

  const toplevel = await run(["rev-parse", "--show-toplevel"]);
  if (toplevel.kind !== "ok") return unavailableFrom(toplevel);
  if (toplevel.code !== 0) return unsupported("not-a-git-checkout");
  if (resolve(toplevel.stdout.trim()) !== root) {
    return unsupported("path-not-checkout-root");
  }

  const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.kind !== "ok") return unavailableFrom(head);
  const revision = head.stdout.trim();
  if (head.code !== 0 || !REVISION_PATTERN.test(revision)) {
    return unavailable("unreadable");
  }

  const status = await run([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.kind !== "ok") return unavailableFrom(status);
  if (status.code !== 0) return unavailable("unreadable");
  const changes = parsePorcelain(status.stdout);
  const trackedModified = changes.trackedModified;
  const untrackedRunnable = changes.untrackedRunnable;

  const base = {
    revision,
    dirty: trackedModified || untrackedRunnable,
    trackedModified,
    untrackedRunnable,
    reason: null,
  } as const;
  if (revision !== options.expectedRevision) {
    return { ...base, status: "revision-mismatch" };
  }
  return { ...base, status: base.dirty ? "dirty" : "verified-clean" };
}

interface PorcelainSummary {
  readonly trackedModified: boolean;
  readonly untrackedRunnable: boolean;
}

export function parsePorcelain(text: string): PorcelainSummary {
  let trackedModified = false;
  let untrackedRunnable = false;
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    // XY<space>PATH; a rename prints "XY ORIG -> NEW".
    const index = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.length === 0) continue;
    if (index === "??") {
      if (isRunnablePath(path)) untrackedRunnable = true;
      continue;
    }
    trackedModified = true;
  }
  return { trackedModified, untrackedRunnable };
}

function isRunnablePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (RUNNABLE_FILENAMES.includes(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return RUNNABLE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

type GitOutcome =
  | { readonly kind: "ok"; readonly code: number; readonly stdout: string }
  | { readonly kind: "failed"; readonly reason: EngineRevisionReason }
  | { readonly kind: "timeout" }
  | { readonly kind: "output-limit" };

/**
 * One bounded Git invocation. Only stdout is kept; stderr is drained and
 * discarded so no repository content can escape through it.
 */
function runGit(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<GitOutcome> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ["-c", "core.fsmonitor=false", ...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
    } catch {
      resolvePromise({ kind: "failed", reason: "git-unavailable" });
      return;
    }
    let settled = false;
    let stdout = Buffer.alloc(0);
    let captured = 0;
    const finish = (outcome: GitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      captured += chunk.length;
      if (captured > maxOutputBytes) {
        child.kill("SIGKILL");
        finish({ kind: "output-limit" });
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    // Discarded on purpose: stderr carries repository text and paths.
    child.stderr?.on("data", () => undefined);
    child.once("error", () => {
      finish({ kind: "failed", reason: "git-unavailable" });
    });
    child.once("close", (code) => {
      finish({ kind: "ok", code: code ?? -1, stdout: stdout.toString("utf8") });
    });
  });
}

function unavailableFrom(
  outcome: Exclude<GitOutcome, { kind: "ok" }>,
): EngineRevisionCheckResult {
  return unavailable(outcome.kind === "failed" ? outcome.reason : outcome.kind);
}

function unavailable(reason: EngineRevisionReason): EngineRevisionCheckResult {
  return {
    status: "unavailable",
    revision: null,
    dirty: false,
    reason,
    trackedModified: false,
    untrackedRunnable: false,
  };
}

function unsupported(reason: EngineRevisionReason): EngineRevisionCheckResult {
  return {
    status: "unsupported",
    revision: null,
    dirty: false,
    reason,
    trackedModified: false,
    untrackedRunnable: false,
  };
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("timeout and output limits must be positive integers");
  }
  return value;
}

function resolveGitExecutable(value: string | undefined): string {
  if (value === undefined) return "git";
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("gitExecutable must be an absolute path");
  }
  return value;
}
