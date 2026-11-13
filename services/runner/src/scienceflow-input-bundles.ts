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
 * Materialized ScienceFlow input evidence bundles on the Runner.
 *
 * The API freezes a plan and sends the exact file bytes that produced its
 * digests. This store re-derives the bundle identity from the received
 * manifest, re-checks every byte, and only then publishes a directory named by
 * the digest. Nothing here trusts the sender's claim: the digest is recomputed,
 * each entry's size and SHA-256 are recomputed from the decoded bytes, and a
 * published tree is verified again before it is reported ready.
 *
 * The store lives under the Runner's own data directory, outside every
 * workspace and every workload-writable bind, so a prepared bundle is never
 * reachable by an execution. Snapshots are content addressed and immutable:
 * staging is a private sibling directory, the commit is one rename, a
 * concurrent publisher of the same bytes is reused, and an existing but
 * damaged snapshot is reported rather than overwritten or re-blessed.
 *
 * This round deliberately has no GC, TTL, reference counting, or mount step:
 * an unreferenced bundle is a cache object, not a resurrected business record.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  parseScienceFlowInputBundleManifest,
  parseScienceFlowInputBundleRequest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  scienceFlowInputBundleTotalBytes,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowInputBundlePublication,
  type ScienceFlowInputBundleStatusDto,
} from "@sciencediscovery/schema";

/** The stored manifest: the canonical digest input, copied verbatim. */
const MANIFEST = ".input-bundle.json";

type FailureKind = "invalid" | "corrupt" | "unavailable";

/**
 * A refused or failed bundle operation. The message is fixed per kind so a
 * route can answer with a code without echoing a path, a digest, or a
 * filesystem error.
 */
export class ScienceFlowInputBundleError extends Error {
  constructor(readonly kind: FailureKind) {
    super(`ScienceFlow input bundle ${kind}`);
    this.name = "ScienceFlowInputBundleError";
  }
}

/** The digest of a canonical manifest, as this runtime computes it. */
export function scienceFlowInputBundleDigest(
  manifest: ScienceFlowInputBundleManifest,
): string {
  return createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
}

export class RunnerScienceFlowInputBundles {
  constructor(private readonly dataDir: string) {}

  /** Content-addressed roots, beside — never inside — the workspace tree. */
  private async parent(): Promise<string> {
    await directory(this.dataDir);
    return await directory(resolve(this.dataDir, ".scienceflow-input-bundles"));
  }

  /** Staging sits outside the published namespace until its contents are whole. */
  private async stagingParent(): Promise<string> {
    await directory(this.dataDir);
    return await directory(
      resolve(this.dataDir, ".scienceflow-input-bundle-staging"),
    );
  }

  /**
   * Read one bundle's state without publishing anything. A damaged tree is
   * reported as `corrupt`; its details stay on the Runner.
   */
  async status(bundleDigest: string): Promise<ScienceFlowInputBundleStatusDto> {
    if (!/^[a-f0-9]{64}$/.test(bundleDigest)) {
      throw new ScienceFlowInputBundleError("invalid");
    }
    const root = resolve(await this.parent(), bundleDigest);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return missing(bundleDigest);
      }
      throw new ScienceFlowInputBundleError("unavailable");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return corrupt(bundleDigest);
    }
    let manifest: ScienceFlowInputBundleManifest;
    try {
      manifest = await this.readManifest(root, bundleDigest);
      await verifySnapshot(root, manifest);
    } catch {
      // Verification failures are all one fixed answer: the tree is not the
      // exact file set its digest names. No message escapes this method.
      return corrupt(bundleDigest);
    }
    return {
      schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
      bundleDigest,
      status: "ready",
      contractDigest: manifest.contractDigest,
      fileCount: manifest.files.length,
      totalBytes: scienceFlowInputBundleTotalBytes(manifest),
    };
  }

  /**
   * Verify and publish a bundle, or report the snapshot that already holds
   * those exact bytes. An existing but damaged snapshot is refused: repairing
   * it would either overwrite content this Runner did not write or hide the
   * damage behind a fresh receipt.
   */
  async put(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ScienceFlowInputBundlePublication> {
    const parsed = parseScienceFlowInputBundleRequest(value);
    if (parsed.status !== "ok") {
      throw new ScienceFlowInputBundleError("invalid");
    }
    const { manifest } = parsed;
    const digest = scienceFlowInputBundleDigest(manifest);
    if (digest !== parsed.request.bundleDigest) {
      throw new ScienceFlowInputBundleError("invalid");
    }

    const existing = await this.status(digest);
    if (existing.status === "ready") {
      return publication(manifest, digest);
    }
    if (existing.status === "corrupt") {
      throw new ScienceFlowInputBundleError("corrupt");
    }

    // Decode and verify before touching the staging tree, so a bundle whose
    // content disagrees with its manifest never reaches the filesystem.
    const files = parsed.request.entries.map((entry) => {
      const bytes = Buffer.from(entry.content, "base64");
      if (
        bytes.length !== entry.size ||
        digestBytes(bytes) !== entry.sha256 ||
        // `Buffer.from` returns the same bytes for a canonical and a
        // non-canonical spelling; the length check above plus the schema's
        // canonical-form check already rejected the second spelling.
        bytes.toString("base64") !== entry.content
      ) {
        throw new ScienceFlowInputBundleError("invalid");
      }
      return { path: entry.path, bytes };
    });

    const staging = resolve(await this.stagingParent(), randomUUID());
    const root = resolve(await this.parent(), digest);
    try {
      await mkdir(staging);
      for (const file of files) {
        signal?.throwIfAborted();
        const target = resolve(staging, file.path);
        if (!target.startsWith(`${staging}${sep}`)) {
          throw new ScienceFlowInputBundleError("invalid");
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx", mode: 0o444 });
      }
      // The stored manifest is the canonical input itself, so a later read
      // recomputes the same digest and a tampered manifest cannot rename the
      // bundle it describes.
      await writeFile(resolve(staging, MANIFEST), JSON.stringify(manifest), {
        flag: "wx",
        mode: 0o444,
      });
      signal?.throwIfAborted();
      try {
        await rename(staging, root);
      } catch (error) {
        // Another connection publishing the same bytes wins the rename; both
        // end up pointing at one content-addressed tree.
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ScienceFlowInputBundleError) throw error;
      throw new ScienceFlowInputBundleError("unavailable");
    } finally {
      await rm(staging, { force: true, recursive: true });
    }

    const checked = await this.status(digest);
    if (checked.status === "corrupt") {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    if (checked.status !== "ready") {
      throw new ScienceFlowInputBundleError("unavailable");
    }
    return publication(manifest, digest);
  }

  private async readManifest(
    root: string,
    bundleDigest: string,
  ): Promise<ScienceFlowInputBundleManifest> {
    const path = resolve(root, MANIFEST);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = parseStoredManifest(value);
    if (parsed === null) throw new ScienceFlowInputBundleError("corrupt");
    // The directory name must still be the digest of the manifest inside it.
    if (scienceFlowInputBundleDigest(parsed) !== bundleDigest) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    return parsed;
  }
}

// --- stored-manifest parsing ----------------------------------------------

function parseStoredManifest(
  value: unknown,
): ScienceFlowInputBundleManifest | null {
  // The shared parser validates the same invariants a received manifest must
  // satisfy; the stored form is the canonical digest input.
  const parsed = parseScienceFlowInputBundleManifest(value);
  return parsed.status === "ok" ? parsed.manifest : null;
}

// --- snapshot verification -------------------------------------------------

/**
 * Check that a published snapshot is exactly the file set its manifest
 * describes: no symlinks, no non-files, nothing extra, and every expected file
 * present with the size and SHA-256 claimed for it.
 */
async function verifySnapshot(
  root: string,
  manifest: ScienceFlowInputBundleManifest,
): Promise<void> {
  const expected = new Set(manifest.files.map((file) => file.path));
  const present = new Set<string>();
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) {
        throw new ScienceFlowInputBundleError("corrupt");
      }
      if (entry.isDirectory()) {
        if (![...expected].some((path) => path.startsWith(`${name}/`))) {
          throw new ScienceFlowInputBundleError("corrupt");
        }
        await walk(resolve(dir, entry.name), `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new ScienceFlowInputBundleError("corrupt");
      if (name === MANIFEST) {
        // Only the root manifest is a known file; the same name deeper in the
        // tree is an unexpected entry, not something to skip.
        if (prefix !== "") {
          throw new ScienceFlowInputBundleError("corrupt");
        }
        continue;
      }
      if (!expected.has(name)) {
        throw new ScienceFlowInputBundleError("corrupt");
      }
      present.add(name);
    }
  };
  await walk(root);
  for (const path of expected) {
    if (!present.has(path)) throw new ScienceFlowInputBundleError("corrupt");
  }

  for (const file of manifest.files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(`${root}${sep}`)) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    const info = await lstat(target);
    // A link planted after publication would make this read another file; the
    // walk above already rejected links, and this check closes the gap between
    // the walk and the read.
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    const hash = createHash("sha256");
    let size = 0;
    const handle = await open(target, "r");
    try {
      for await (const chunk of handle.createReadStream()) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
      }
    } finally {
      await handle.close();
    }
    if (size !== file.size || hash.digest("hex") !== file.sha256) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
  }
}

// --- small helpers ---------------------------------------------------------

function publication(
  manifest: ScienceFlowInputBundleManifest,
  bundleDigest: string,
): ScienceFlowInputBundlePublication {
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    bundleDigest,
    contractDigest: manifest.contractDigest,
    status: "ready",
    fileCount: manifest.files.length,
    totalBytes: scienceFlowInputBundleTotalBytes(manifest),
  };
}

function missing(bundleDigest: string): ScienceFlowInputBundleStatusDto {
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    bundleDigest,
    status: "missing",
    contractDigest: null,
    fileCount: null,
    totalBytes: null,
  };
}

function corrupt(bundleDigest: string): ScienceFlowInputBundleStatusDto {
  return {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    bundleDigest,
    status: "corrupt",
    contractDigest: null,
    fileCount: null,
    totalBytes: null,
  };
}

async function directory(path: string): Promise<string> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ScienceFlowInputBundleError("unavailable");
    }
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    throw new ScienceFlowInputBundleError("unavailable");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ScienceFlowInputBundleError("unavailable");
  }
  return path;
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
