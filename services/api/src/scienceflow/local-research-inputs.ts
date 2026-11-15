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
 * Operation-owned execution input for the experimental local research mode.
 *
 * In dynamic mode the Session supplies the plan and the incumbent, and the
 * administrator supplies everything else. This module copies the administrator's
 * supporting assets and the exact selected bytes into one directory owned by the
 * operation, then proves the copies are the accepted bytes. The engine's manifest
 * points at that directory, so a newer Artifact version, an edited seed file, a
 * profile change or a rebuilt service cannot alter what an accepted operation
 * runs.
 *
 * It is not a general input framework: one flat directory, one small role map and
 * one manifest file. Nothing here executes, parses or interprets the plan text;
 * a plan is bounded research text the researcher reads, never host configuration.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Bounds for one staged input directory. */
export const STAGED_INPUT_LIMITS = Object.freeze({
  /** Files copied from the administrator's supporting assets. */
  maxAssetsEntries: 512,
  /** One supporting asset. */
  maxAssetBytes: 16 * 1024 * 1024,
  /** Everything staged for one operation, assets and selected roles together. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Directory nesting copied from the assets root. */
  maxDepth: 8,
  /** The composed researcher instruction, matching the pilot's own bound. */
  maxTaskTextBytes: 32_768,
});

/** The two roles a dynamic profile can stage from the Session. */
export type StagedInputRole = "plan" | "incumbent";

/** One Session-selected role, already verified against its CAS bytes. */
export interface StagedInputSelection {
  readonly role: StagedInputRole;
  readonly stagedName: string;
  readonly sha256: string;
  readonly size: number;
  readonly versionId: string;
}

/** A preparation failure with a stable reason; messages carry no host path. */
export class InputPreparationRefusal extends Error {
  readonly reason:
    | "staging-conflict"
    | "staging-failed"
    | "staging-unsafe"
    | "staging-too-large"
    | "staging-bytes-mismatch"
    | "task-text-invalid";
  constructor(reason: InputPreparationRefusal["reason"], message: string) {
    super(message);
    this.name = "InputPreparationRefusal";
    this.reason = reason;
  }
}

export interface StagedInputManifest {
  readonly schemaVersion: 1;
  readonly stagedAt: string;
  readonly assets: {
    readonly entries: number;
    readonly sha256: string;
    readonly totalBytes: number;
  };
  readonly roles: readonly {
    readonly role: StagedInputRole;
    readonly sha256: string;
    readonly size: number;
    readonly stagedName: string;
    readonly versionId: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
}

/**
 * Build the operation's input directory: the administrator's supporting assets
 * plus the exact bytes the Session selected for each role.
 *
 * The destination must not already exist, so a fresh operation can never inherit
 * another operation's staged input. Every role byte is re-hashed after the write;
 * a digest or size difference aborts the operation instead of launching it with
 * bytes nobody accepted.
 */
export async function stageResearchOperationInputs(
  input: {
    readonly assetsDir: string;
    readonly destination: string;
    readonly readBytes: (hash: string) => Promise<Buffer>;
    readonly roles: readonly StagedInputSelection[];
    readonly signal?: AbortSignal;
  },
  now: () => string,
): Promise<{ readonly manifest: StagedInputManifest; readonly manifestSha256: string; readonly manifestJson: string }> {
  // A staged role must not share a name with an administrator asset: the two
  // origins would be indistinguishable in the engine's dataset. This is checked
  // before anything is created, so a refused staging leaves no partial directory.
  for (const role of input.roles) {
    if (await exists(join(input.assetsDir, ...role.stagedName.split("/")))) {
      throw new InputPreparationRefusal(
        "staging-conflict",
        `The ${role.role} input name is also a supporting asset name`,
      );
    }
  }
  try {
    await mkdir(input.destination, { recursive: false, mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new InputPreparationRefusal("staging-conflict", "This operation already has a staged input directory");
    }
    throw new InputPreparationRefusal("staging-failed", "The operation's input directory could not be created");
  }
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  let totalBytes = 0;
  const assets = await copyAssets(input.assetsDir, input.destination, input.signal, (copied) => {
    totalBytes += copied.size;
    if (totalBytes > STAGED_INPUT_LIMITS.maxTotalBytes) {
      throw new InputPreparationRefusal("staging-too-large", "The staged input exceeds the size bound");
    }
    files.push(copied);
  });
  for (const role of input.roles) {
    input.signal?.throwIfAborted();
    const target = join(input.destination, ...role.stagedName.split("/"));
    if (files.some((file) => file.path === role.stagedName)) {
      // A staged role must not silently replace an administrator asset of the
      // same name: the two origins would be indistinguishable in the dataset.
      throw new InputPreparationRefusal(
        "staging-conflict",
        `The ${role.role} input name is also a supporting asset name`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await input.readBytes(role.sha256);
    } catch {
      throw new InputPreparationRefusal("staging-failed", `The ${role.role} input could not be read from the content store`);
    }
    input.signal?.throwIfAborted();
    const digest = sha256(bytes);
    if (digest !== role.sha256 || bytes.length !== role.size) {
      throw new InputPreparationRefusal(
        "staging-bytes-mismatch",
        `The ${role.role} input's content no longer matches the accepted digest`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > STAGED_INPUT_LIMITS.maxTotalBytes) {
      throw new InputPreparationRefusal("staging-too-large", "The staged input exceeds the size bound");
    }
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    } catch {
      throw new InputPreparationRefusal("staging-failed", `The ${role.role} input could not be staged`);
    }
    // Read the copy back: the researcher must receive exactly the accepted bytes,
    // not what a partial write or a full disk left behind.
    let staged: Buffer;
    try {
      staged = await readFile(target);
    } catch {
      throw new InputPreparationRefusal("staging-failed", `The ${role.role} input could not be read back`);
    }
    if (sha256(staged) !== role.sha256 || staged.length !== role.size) {
      throw new InputPreparationRefusal(
        "staging-bytes-mismatch",
        `The staged ${role.role} copy does not match the accepted bytes`,
      );
    }
    files.push({ path: role.stagedName, sha256: role.sha256, size: role.size });
  }
  const manifest: StagedInputManifest = {
    schemaVersion: 1,
    stagedAt: now(),
    assets,
    roles: input.roles.map((role) => ({
      role: role.role,
      sha256: role.sha256,
      size: role.size,
      stagedName: role.stagedName,
      versionId: role.versionId,
    })),
    files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return { manifest, manifestJson, manifestSha256: sha256(Buffer.from(manifestJson, "utf8")) };
}

/**
 * Copy the administrator's supporting assets. Only regular files and real
 * directories are accepted: a symlink or a device node could point the engine at
 * something outside the asset root, so it is refused instead of followed.
 */
async function copyAssets(
  assetsDir: string,
  destination: string,
  signal: AbortSignal | undefined,
  onCopied: (copied: { path: string; sha256: string; size: number }) => void,
): Promise<{ entries: number; sha256: string; totalBytes: number }> {
  const root = resolve(assetsDir);
  let entries = 0;
  let totalBytes = 0;
  const digests: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > STAGED_INPUT_LIMITS.maxDepth) {
      throw new InputPreparationRefusal("staging-unsafe", "The supporting assets are nested too deeply");
    }
    const handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();
    for (const name of names) {
      signal?.throwIfAborted();
      const source = join(directory, name);
      const targetRelative = relative(root, source);
      // `lstat` refuses a link instead of copying through whatever it points at.
      const info = await lstat(source).catch(() => undefined);
      if (!info) {
        throw new InputPreparationRefusal("staging-unsafe", "A supporting asset could not be inspected");
      }
      if (info.isSymbolicLink()) {
        throw new InputPreparationRefusal("staging-unsafe", "A supporting asset is a symbolic link");
      }
      if (info.isDirectory()) {
        await mkdir(join(destination, targetRelative), { recursive: true, mode: 0o755 });
        await walk(source, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        throw new InputPreparationRefusal("staging-unsafe", "A supporting asset is not a regular file");
      }
      if (info.size > STAGED_INPUT_LIMITS.maxAssetBytes) {
        throw new InputPreparationRefusal("staging-too-large", "A supporting asset exceeds the size bound");
      }
      entries += 1;
      if (entries > STAGED_INPUT_LIMITS.maxAssetsEntries) {
        throw new InputPreparationRefusal("staging-too-large", "The supporting assets exceed the entry bound");
      }
      totalBytes += info.size;
      if (totalBytes > STAGED_INPUT_LIMITS.maxTotalBytes) {
        throw new InputPreparationRefusal("staging-too-large", "The supporting assets exceed the size bound");
      }
      const target = join(destination, targetRelative);
      try {
        await copyFile(source, target);
      } catch {
        throw new InputPreparationRefusal("staging-failed", "A supporting asset could not be copied");
      }
      const copied = await readFile(target).catch(() => undefined);
      if (!copied || copied.length !== info.size) {
        throw new InputPreparationRefusal("staging-failed", "A copied supporting asset is unreadable");
      }
      const digest = sha256(copied);
      digests.push(`${targetRelative}\0${digest}`);
      onCopied({ path: targetRelative.split("\\").join("/"), sha256: digest, size: copied.length });
    }
  };
  await walk(root, 0).catch((error: unknown) => {
    if (error instanceof InputPreparationRefusal) throw error;
    throw new InputPreparationRefusal("staging-failed", "The supporting assets could not be copied");
  });
  const assetsSha256 = sha256(Buffer.from(digests.join("\n"), "utf8"));
  return { entries, sha256: assetsSha256, totalBytes };
}

/** Placeholders a dynamic task template may carry, all filled from frozen facts. */
const TASK_PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/gu;

/**
 * Compose the researcher's instruction for one operation from the administrator's
 * template. Every substituted value is a frozen fact of this operation: the
 * staged file names, the research intent and the version identities. The result
 * is bounded like any other pinned task text.
 */
export function composeDynamicTaskText(
  template: string,
  input: {
    readonly intent: string;
    readonly operationId: string;
    readonly roles: readonly StagedInputSelection[];
  },
): string {
  const byRole = new Map(input.roles.map((role) => [role.role, role]));
  const plan = byRole.get("plan");
  if (!plan) throw new InputPreparationRefusal("task-text-invalid", "No plan input was staged for this operation");
  const incumbent = byRole.get("incumbent");
  const text = template.replace(TASK_PLACEHOLDER_PATTERN, (_match, name: string) => {
    switch (name) {
      case "plan_file":
        // The engine exposes the input directory's top-level entries as
        // `dataset/` in the researcher's workspace.
        return `dataset/${plan.stagedName}`;
      case "incumbent_file":
        return incumbent ? `dataset/${incumbent.stagedName}` : "";
      case "research_intent":
        return input.intent;
      case "plan_version_id":
        return plan.versionId;
      case "incumbent_version_id":
        return incumbent ? incumbent.versionId : "";
      case "operation_id":
        return input.operationId;
      default:
        // The loader rejects unknown placeholders, so reaching this branch means
        // the two lists drifted; refuse rather than leave the token in the text.
        throw new InputPreparationRefusal("task-text-invalid", "The task template uses an unsupported placeholder");
    }
  });
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\u0000")) {
    throw new InputPreparationRefusal("task-text-invalid", "The composed task text is not usable");
  }
  if (Buffer.byteLength(trimmed, "utf8") > STAGED_INPUT_LIMITS.maxTaskTextBytes) {
    throw new InputPreparationRefusal("task-text-invalid", "The composed task text exceeds the size bound");
  }
  return trimmed;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when the path exists, whatever it is; used to refuse a name collision. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
