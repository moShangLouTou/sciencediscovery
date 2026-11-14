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
 * each entry's size and SHA-256 are recomputed from the decoded bytes — for
 * every submission, even when a tree for that digest already exists — and a
 * published tree is verified again before it is reported ready.
 *
 * The store lives under the Runner's own data directory, outside every
 * workspace and every workload-writable bind, so a prepared bundle is never
 * reachable by an execution. Snapshots are content addressed and immutable:
 * staging is a private sibling directory, the commit is one rename, a
 * concurrent publisher of the same bytes is reused, and an existing but
 * damaged snapshot is reported rather than overwritten or re-blessed.
 * Verification walks a directory descriptor held for the read, opening each
 * parent with `O_NOFOLLOW`, checking type, link count and size through the
 * opened descriptor, reading a bounded amount and recomputing the digest.
 * `status` and `snapshot` share one check: the tree must be exactly the file
 * set the manifest names — nothing extra, nothing linked, every entry present —
 * and `snapshot` returns the buffers read during that same check. The public
 * query and the consuming door cannot disagree about what is corrupt.
 * `snapshot()` returns those exact buffers to the fixed research workload,
 * which materializes a per-execution copy; the cache is never mounted.
 *
 * This round deliberately has no GC, TTL, reference counting, or mount step:
 * an unreferenced bundle is a cache object, not a resurrected business record.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  canonicalScienceFlowInputBundleManifest,
  isScienceFlowInputBundlePath,
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

/** Published content-addressed roots, beside — never inside — a workspace. */
const BUNDLES_DIRECTORY = ".scienceflow-input-bundles";

/** Staging for a publish, outside the published namespace until it is whole. */
const STAGING_DIRECTORY = ".scienceflow-input-bundle-staging";

/**
 * The largest stored manifest this Runner will read. A real one describes at
 * most five paths of 512 characters, so this is far above any legitimate
 * manifest and only bounds a corrupted or tampered file.
 */
const MAX_MANIFEST_BYTES = 64 * 1024;

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

/**
 * One verified snapshot, read through a held directory descriptor.
 *
 * The contents are the exact buffers this Runner checked against the manifest;
 * a consumer materializes these bytes instead of re-opening the shared path
 * later. This value stays inside the Runner: it names no host path.
 */
export interface ScienceFlowInputSnapshot {
  readonly manifest: ScienceFlowInputBundleManifest;
  readonly contents: ReadonlyMap<string, Buffer>;
}

/** One file a verified tree must contain, with the facts recorded for it. */
interface SnapshotFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** A stored manifest plus the exact bytes it was parsed from. */
interface StoredManifest {
  readonly manifest: ScienceFlowInputBundleManifest;
  readonly bytes: Buffer;
}

export class RunnerScienceFlowInputBundles {
  constructor(private readonly dataDir: string) {}

  /** Content-addressed roots, beside — never inside — the workspace tree. */
  private async parent(): Promise<string> {
    await directory(this.dataDir);
    return await directory(resolve(this.dataDir, BUNDLES_DIRECTORY));
  }

  /** Staging sits outside the published namespace until its contents are whole. */
  private async stagingParent(): Promise<string> {
    await directory(this.dataDir);
    return await directory(
      resolve(this.dataDir, STAGING_DIRECTORY),
    );
  }

  /**
   * The host roots this store owns, for a launcher that must prove none of its
   * writable binds covers them. Runner-internal: no route exposes these, and
   * the copy a workload mounts is a separate per-execution tree.
   */
  hostRoots(): readonly string[] {
    return [
      resolve(this.dataDir, BUNDLES_DIRECTORY),
      resolve(this.dataDir, STAGING_DIRECTORY),
    ];
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
    let reader: SnapshotDirectory;
    try {
      reader = await SnapshotDirectory.open(root);
    } catch {
      return corrupt(bundleDigest);
    }
    try {
      const stored = await this.readManifest(reader, bundleDigest);
      await reader.verify(stored.manifest.files, { collect: false, manifestBytes: stored.bytes });
      return {
        schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
        bundleDigest,
        status: "ready",
        contractDigest: stored.manifest.contractDigest,
        fileCount: stored.manifest.files.length,
        totalBytes: scienceFlowInputBundleTotalBytes(stored.manifest),
      };
    } catch {
      // Verification failures are all one fixed answer: the tree is not the
      // exact file set its digest names. No message escapes this method.
      return corrupt(bundleDigest);
    } finally {
      await reader.close();
    }
  }

  /**
   * Verify one published bundle and return the bytes that were checked.
   *
   * This is the Runner-internal door a consuming execution uses instead of
   * `status` plus a later re-read by path: every entry is read through the
   * directory descriptor held here, its type, link count, size and digest are
   * checked, and the returned buffer is the one those checks describe. The
   * shared cache is never mounted; the caller writes these bytes into a private
   * per-execution copy.
   */
  async snapshot(bundleDigest: string): Promise<ScienceFlowInputSnapshot> {
    if (!/^[a-f0-9]{64}$/.test(bundleDigest)) {
      throw new ScienceFlowInputBundleError("invalid");
    }
    const root = resolve(await this.parent(), bundleDigest);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(root);
    } catch {
      // A consuming execution needs one answer for "this identity is not
      // materialized here" whether the tree is absent or unreadable: the
      // caller refuses before spawn. The public `status` keeps its own
      // `missing` state for observation.
      throw new ScienceFlowInputBundleError("unavailable");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    let reader: SnapshotDirectory;
    try {
      reader = await SnapshotDirectory.open(root);
    } catch {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    try {
      const stored = await this.readManifest(reader, bundleDigest);
      const contents = await reader.verify(stored.manifest.files, {
        collect: true,
        manifestBytes: stored.bytes,
      });
      return { manifest: stored.manifest, contents };
    } catch (error) {
      if (error instanceof ScienceFlowInputBundleError) throw error;
      throw new ScienceFlowInputBundleError("corrupt");
    } finally {
      await reader.close();
    }
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

    // Verify the bytes this request actually carries before anything can
    // answer ready. An already materialized bundle must not turn a malformed
    // upload into a success: the protocol promises that every submission is
    // checked on its own, and the client's GET shortcut (which carries no
    // bytes) is a separate path.
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

    const existing = await this.status(digest);
    if (existing.status === "ready") {
      return publication(manifest, digest);
    }
    if (existing.status === "corrupt") {
      throw new ScienceFlowInputBundleError("corrupt");
    }

    // The bytes are verified; only now may they reach the staging tree.
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
    reader: SnapshotDirectory,
    bundleDigest: string,
  ): Promise<StoredManifest> {
    // The manifest is read through the same held-descriptor path as content:
    // bounded, no symlink or hardlink alias, and no unbounded parse.
    const bytes = await reader.read(MANIFEST, { maxBytes: MAX_MANIFEST_BYTES });
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    const parsed = parseStoredManifest(value);
    if (parsed === null) throw new ScienceFlowInputBundleError("corrupt");
    // The directory name must still be the digest of the manifest inside it.
    if (scienceFlowInputBundleDigest(parsed) !== bundleDigest) {
      throw new ScienceFlowInputBundleError("corrupt");
    }
    return { manifest: parsed, bytes };
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
 * Re-check a materialized copy against the manifest it was written from.
 *
 * The copy is Runner-owned and private, but it is verified anyway before it is
 * published: a partially written or externally damaged staging tree must never
 * become the directory a workload mounts. The expected set is the whole tree —
 * an entry the manifest does not name is as damaged as a missing one.
 */
export async function verifyScienceFlowInputCopy(
  root: string,
  files: readonly SnapshotFile[],
): Promise<void> {
  const reader = await SnapshotDirectory.open(root);
  try {
    await reader.verify(files, { collect: false });
  } finally {
    await reader.close();
  }
}

// --- bounded, alias-free reads ---------------------------------------------

type ReadBound = { readonly exact: number } | { readonly maxBytes: number };

function corruptFile(): ScienceFlowInputBundleError {
  return new ScienceFlowInputBundleError("corrupt");
}

/**
 * A directory descriptor held for the length of one verification.
 *
 * Every name is resolved under the descriptor with `O_NOFOLLOW`: a parent
 * component replaced by a link is refused instead of followed, the final file
 * is opened with `O_NONBLOCK` so a FIFO cannot park the read, and the opened
 * descriptor — not an earlier `lstat` — decides the type, link count and size.
 * A link count above one means the bytes can also be written through an alias
 * outside this tree, which is not a controlled snapshot.
 */
class SnapshotDirectory {
  private constructor(private readonly directory: FileHandle) {}

  static async open(root: string): Promise<SnapshotDirectory> {
    let directory: FileHandle;
    try {
      directory = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      throw corruptFile();
    }
    try {
      if (!(await directory.stat()).isDirectory()) throw corruptFile();
      return new SnapshotDirectory(directory);
    } catch (error) {
      await directory.close().catch(() => undefined);
      throw error instanceof ScienceFlowInputBundleError ? error : corruptFile();
    }
  }

  /**
   * Read one file below the root through descriptors held for the whole walk.
   * Parent components are opened one at a time as directories and stay open
   * until the file is read, so no component can be re-resolved mid-path.
   */
  async read(relativePath: string, bound: ReadBound): Promise<Buffer> {
    if (!isScienceFlowInputBundlePath(relativePath)) throw corruptFile();
    const segments = relativePath.split("/");
    const parents: FileHandle[] = [];
    try {
      let directory = this.directory;
      for (const segment of segments.slice(0, -1)) {
        directory = await this.openChildDirectory(directory, segment);
        parents.push(directory);
      }
      const name = segments[segments.length - 1];
      if (name === undefined) throw corruptFile();
      return await this.readEntry(directory, name, bound);
    } finally {
      for (const parent of parents.reverse()) {
        await parent.close().catch(() => undefined);
      }
    }
  }

  /**
   * Check that the tree below the held descriptor is exactly the file set
   * `files` names: no links, no non-files, nothing extra, every entry present
   * with the size and digest recorded for it.
   *
   * Names are listed and opened relative to descriptors held for this walk, so
   * a swapped root or a replaced parent cannot make the set check describe a
   * different tree than the reads. `manifestBytes`, when given, is the manifest
   * this set was parsed from; the root entry of that name must still hold those
   * bytes, so the parsed set and the walked tree are one object. With
   * `collect`, the verified bytes are returned to the caller that materializes
   * them — the buffers the checks describe, not a later read by path.
   */
  async verify(
    files: readonly SnapshotFile[],
    options: { readonly collect: boolean; readonly manifestBytes?: Buffer },
  ): Promise<Map<string, Buffer>> {
    const expected = new Map<string, SnapshotFile>();
    const directories = new Set<string>();
    for (const file of files) {
      expected.set(file.path, file);
      const segments = file.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    }
    const contents = new Map<string, Buffer>();
    const present = new Set<string>();
    let manifestSeen = false;
    const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
      for (const name of await readdir(`/proc/self/fd/${directory.fd}`)) {
        const relativePath = prefix === "" ? name : `${prefix}/${name}`;
        // Only the root manifest is a known file. The same name deeper in the
        // tree is an unexpected entry, not something to skip.
        if (prefix === "" && name === MANIFEST && options.manifestBytes !== undefined) {
          const bytes = await this.readEntry(directory, name, { maxBytes: MAX_MANIFEST_BYTES });
          if (!bytes.equals(options.manifestBytes)) throw corruptFile();
          manifestSeen = true;
          continue;
        }
        if (directories.has(relativePath)) {
          const child = await this.openChildDirectory(directory, name);
          try {
            await walk(child, relativePath);
          } finally {
            await child.close().catch(() => undefined);
          }
          continue;
        }
        const file = expected.get(relativePath);
        // Anything the manifest does not name — an extra file, a link, a FIFO,
        // a device — is refused at its name.
        if (file === undefined) throw corruptFile();
        const bytes = await this.readEntry(directory, name, { exact: file.size });
        if (digestBytes(bytes) !== file.sha256) throw corruptFile();
        present.add(relativePath);
        if (options.collect) contents.set(relativePath, bytes);
      }
    };
    try {
      await walk(this.directory, "");
    } catch (error) {
      if (error instanceof ScienceFlowInputBundleError) throw error;
      throw corruptFile();
    }
    if (options.manifestBytes !== undefined && !manifestSeen) throw corruptFile();
    for (const path of expected.keys()) {
      if (!present.has(path)) throw corruptFile();
    }
    return contents;
  }

  /** Open one child directory of a held descriptor, refusing links. */
  private async openChildDirectory(directory: FileHandle, name: string): Promise<FileHandle> {
    let child: FileHandle;
    try {
      child = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      throw corruptFile();
    }
    try {
      if (!(await child.stat()).isDirectory()) throw corruptFile();
      return child;
    } catch (error) {
      await child.close().catch(() => undefined);
      throw error instanceof ScienceFlowInputBundleError ? error : corruptFile();
    }
  }

  /** Read one named entry of a held descriptor under its bound. */
  private async readEntry(directory: FileHandle, name: string, bound: ReadBound): Promise<Buffer> {
    let handle: FileHandle;
    try {
      handle = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      throw corruptFile();
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw corruptFile();
      const limit = "exact" in bound ? bound.exact : bound.maxBytes;
      if (info.size > limit) throw corruptFile();
      if ("exact" in bound && info.size !== bound.exact) throw corruptFile();
      const bytes = await readHandleBounded(handle, limit);
      if ("exact" in bound && bytes.length !== bound.exact) throw corruptFile();
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.directory.close().catch(() => undefined);
  }
}

/**
 * Read at most `limit` bytes through one descriptor. One byte past the bound
 * is requested on purpose, so a file that grew since its stat is detected
 * instead of silently truncated.
 */
async function readHandleBounded(
  handle: FileHandle,
  limit: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > limit) throw corruptFile();
  return buffer.subarray(0, total);
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
