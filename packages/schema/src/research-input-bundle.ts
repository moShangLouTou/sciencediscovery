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
 * Internal protocol for one Research input evidence bundle.
 *
 * The API freezes a plan from an administrator profile and then hands the
 * selected Runner the exact bytes that produced the frozen digests. This module
 * is the only description of that transfer: it is shared by the API that
 * assembles a bundle, the Runner that independently verifies and materializes
 * it, and their clients.
 *
 * Everything here is a pure function over plain values: `packages/schema` is
 * also loaded by the browser, so no Node API (crypto, Buffer, fs) is imported.
 * The digest is defined as SHA-256 over the canonical manifest string below;
 * each Node consumer hashes that same string with its own runtime.
 *
 * The protocol is deliberately small: an explicit entry list with base64
 * content, no archive/unpacker, no executable, no environment, no host path.
 * A path is a logical bundle label used for indexing, never a Runner host path.
 */

/** The only bundle version this contract accepts. */
export const RESEARCH_INPUT_BUNDLE_VERSION = 1;

/** Product-defined role labels. A file need not pretend to be an evaluator or task. */
export type ResearchInputFileRole = string;
export const RESEARCH_INPUT_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 64, maxEntryBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024,
  maxPathLength: 512, maxBodyBytes: 8 * 1024 * 1024,
});

/** One byte set in the canonical manifest: no content, only its identity. */
export interface ResearchInputBundleManifestFile {
  /** Logical bundle-relative label, never a host path. */
  readonly path: string;
  /** Every role this byte set serves, in the frozen product-defined order. */
  readonly roles: readonly ResearchInputFileRole[];
  readonly size: number;
  readonly sha256: string;
}

/** The content identity of a bundle, without any business or Runner identity. */
export interface ResearchInputBundleManifest {
  readonly schemaVersion: typeof RESEARCH_INPUT_BUNDLE_VERSION;
  readonly contractDigest: string;
  readonly files: readonly ResearchInputBundleManifestFile[];
}

/** One file on the wire: the canonical manifest plus the bytes it describes. */
export interface ResearchInputBundleEntry
  extends ResearchInputBundleManifestFile {
  /** Canonical padded base64 of exactly `size` bytes. */
  readonly content: string;
}

/**
 * What the API sends to a Runner. `bundleDigest` is the sender's claim; the
 * Runner recomputes it from the manifest and refuses a disagreement.
 */
export interface ResearchInputBundleRequest {
  readonly schemaVersion: typeof RESEARCH_INPUT_BUNDLE_VERSION;
  readonly contractDigest: string;
  readonly bundleDigest: string;
  readonly entries: readonly ResearchInputBundleEntry[];
}

/** A materialized, independently verified bundle. */
export interface ResearchInputBundlePublication {
  readonly schemaVersion: typeof RESEARCH_INPUT_BUNDLE_VERSION;
  readonly bundleDigest: string;
  readonly contractDigest: string;
  readonly status: "ready";
  readonly fileCount: number;
  readonly totalBytes: number;
}

/**
 * The read answer for one digest: a fixed state plus the manifest summary, or
 * `null` counts when nothing is stored. It never names a host path or content.
 */
export interface ResearchInputBundleStatusDto {
  readonly schemaVersion: typeof RESEARCH_INPUT_BUNDLE_VERSION;
  readonly bundleDigest: string;
  readonly status: "ready" | "missing" | "corrupt";
  readonly contractDigest: string | null;
  readonly fileCount: number | null;
  readonly totalBytes: number | null;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** True for a lowercase hex SHA-256 digest. */
export function isResearchInputBundleDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/**
 * A logical bundle path: relative, non-empty, bounded, and made of plain
 * segments. Absolute paths, drive prefixes, backslashes, NUL, `.` and `..` are
 * refused, so joining it under a Runner-owned directory cannot escape it.
 */
export function isResearchInputBundlePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > RESEARCH_INPUT_BUNDLE_LIMITS.maxPathLength
  ) {
    return false;
  }
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Bounded product role label. */
export function isResearchInputFileRole(
  value: unknown,
): value is ResearchInputFileRole {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
  );
}

/**
 * The canonical string whose UTF-8 bytes a consumer hashes to obtain
 * `bundleDigest`. Keys and entries have a fixed order and content is excluded:
 * the digest names the file set, while each entry's own `sha256` names its
 * bytes. Two bundles with the same digest therefore have the same contract,
 * paths, roles, sizes and per-file digests.
 */
export function canonicalResearchInputBundleManifest(
  manifest: ResearchInputBundleManifest,
): string {
  return JSON.stringify({
    contractDigest: manifest.contractDigest,
    files: manifest.files.map((file) => ({
      path: file.path,
      roles: file.roles,
      sha256: file.sha256,
      size: file.size,
    })),
    schemaVersion: manifest.schemaVersion,
  });
}

/**
 * Validate a stored or received manifest and return it in canonical order.
 * `invalid` is a single fixed outcome: the caller never learns which condition
 * failed, so no partial parse of untrusted input is echoed back.
 */
export function parseResearchInputBundleManifest(
  value: unknown,
):
  | { readonly status: "ok"; readonly manifest: ResearchInputBundleManifest }
  | { readonly status: "invalid" } {
  if (!isRecord(value)) return { status: "invalid" };
  if (!hasExactKeys(value, ["contractDigest", "files", "schemaVersion"])) {
    return { status: "invalid" };
  }
  if (value.schemaVersion !== RESEARCH_INPUT_BUNDLE_VERSION) {
    return { status: "invalid" };
  }
  const contractDigest = value.contractDigest;
  if (!isResearchInputBundleDigest(contractDigest)) {
    return { status: "invalid" };
  }
  const files = parseManifestFiles(value.files);
  if (files === null) return { status: "invalid" };
  return {
    status: "ok",
    manifest: {
      schemaVersion: RESEARCH_INPUT_BUNDLE_VERSION,
      contractDigest,
      files,
    },
  };
}

/**
 * Validate a bundle request end to end, including strict base64 and declared
 * sizes. The returned `manifest` is the digest input; `entries` keep their
 * content so a consumer can materialize the bytes it already validated.
 */
export function parseResearchInputBundleRequest(
  value: unknown,
):
  | {
      readonly status: "ok";
      readonly request: ResearchInputBundleRequest;
      readonly manifest: ResearchInputBundleManifest;
    }
  | { readonly status: "invalid" } {
  if (!isRecord(value)) return { status: "invalid" };
  if (
    !hasExactKeys(value, [
      "bundleDigest",
      "contractDigest",
      "entries",
      "schemaVersion",
    ])
  ) {
    return { status: "invalid" };
  }
  if (value.schemaVersion !== RESEARCH_INPUT_BUNDLE_VERSION) {
    return { status: "invalid" };
  }
  if (
    !isResearchInputBundleDigest(value.contractDigest) ||
    !isResearchInputBundleDigest(value.bundleDigest) ||
    !Array.isArray(value.entries)
  ) {
    return { status: "invalid" };
  }
  const entries = parseEntries(value.entries);
  if (entries === null) return { status: "invalid" };

  const manifestFiles: ResearchInputBundleManifestFile[] = entries.map(
    ({ content: _content, ...file }) => file,
  );
  // Re-run the manifest invariants on the reduced form so the digest input and
  // the wire form can never describe two different sets.
  const parsedManifest = parseResearchInputBundleManifest({
    schemaVersion: RESEARCH_INPUT_BUNDLE_VERSION,
    contractDigest: value.contractDigest,
    files: manifestFiles,
  });
  if (parsedManifest.status !== "ok") return { status: "invalid" };

  return {
    status: "ok",
    request: {
      schemaVersion: RESEARCH_INPUT_BUNDLE_VERSION,
      contractDigest: value.contractDigest,
      bundleDigest: value.bundleDigest,
      entries,
    },
    manifest: parsedManifest.manifest,
  };
}

/** Total bytes of the distinct byte sets in a canonical manifest. */
export function researchInputBundleTotalBytes(
  manifest: ResearchInputBundleManifest,
): number {
  return manifest.files.reduce((total, file) => total + file.size, 0);
}

// --- validation helpers ----------------------------------------------------

function parseManifestFiles(
  value: unknown,
): readonly ResearchInputBundleManifestFile[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  if (value.length > RESEARCH_INPUT_BUNDLE_LIMITS.maxFiles) return null;

  const files: ResearchInputBundleManifestFile[] = [];
  let previousPath: string | null = null;
  let totalBytes = 0;
  for (const entry of value) {
    const file = parseManifestFile(entry);
    if (file === null) return null;
    // Canonical order makes the digest independent of the wire order and makes
    // a repeated path detectable by comparison rather than a second pass.
    if (previousPath !== null && !(previousPath < file.path)) return null;
    previousPath = file.path;
    totalBytes += file.size;
    if (totalBytes > RESEARCH_INPUT_BUNDLE_LIMITS.maxTotalBytes) return null;
    files.push(file);
  }
  return Object.freeze(files);
}

function parseManifestFile(
  value: unknown,
): ResearchInputBundleManifestFile | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["path", "roles", "sha256", "size"])) return null;
  const path = value.path;
  if (!isResearchInputBundlePath(path)) return null;
  if (!isResearchInputBundleDigest(value.sha256)) return null;
  const size = value.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > RESEARCH_INPUT_BUNDLE_LIMITS.maxEntryBytes
  ) {
    return null;
  }
  const roles = parseRoles(value.roles);
  if (roles === null) return null;
  return { path, roles, size, sha256: value.sha256 };
}

function parseRoles(
  value: unknown,
): readonly ResearchInputFileRole[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > 16) return null;
  const roles: ResearchInputFileRole[] = [];
  const localRoles = new Set<string>();
  for (const role of value) {
    if (!isResearchInputFileRole(role)) return null;
    if (localRoles.has(role)) return null;
    localRoles.add(role);
    roles.push(role);
  }
  return Object.freeze(roles);
}

function parseEntries(
  value: readonly unknown[],
): readonly ResearchInputBundleEntry[] | null {
  const files = parseManifestFiles(
    value.map((entry) => {
      if (!isRecord(entry)) return null;
      return {
        path: entry.path,
        roles: entry.roles,
        sha256: entry.sha256,
        size: entry.size,
      };
    }),
  );
  if (files === null) return null;

  const entries: ResearchInputBundleEntry[] = [];
  for (const [index, file] of files.entries()) {
    const raw = value[index];
    if (!isRecord(raw)) return null;
    if (
      !hasExactKeys(raw, [
        "content",
        "path",
        "roles",
        "sha256",
        "size",
      ])
    ) {
      return null;
    }
    const content = raw.content;
    // Strict base64: `Buffer.from` would silently ignore trailing garbage and
    // accept non-canonical trailing bits, which is exactly the "validated A,
    // sent B" gap this check removes.
    if (typeof content !== "string") return null;
    if (decodedBase64Length(content) !== file.size) return null;
    entries.push({ ...file, content });
  }
  return Object.freeze(entries);
}

/**
 * Length in bytes of a canonical padded base64 string, or null when the string
 * is not canonical. Deliberately validates the encoding instead of decoding it:
 * the decoding consumer then cannot disagree with this byte count.
 */
function decodedBase64Length(content: string): number | null {
  if (content.length === 0) return 0;
  if (content.length % 4 !== 0) return null;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const dataEnd = content.length - padding;
  if (dataEnd === 0) return null;
  for (let index = 0; index < dataEnd; index += 1) {
    if (BASE64_ALPHABET.indexOf(content[index] as string) < 0) return null;
  }
  for (let index = dataEnd; index < content.length; index += 1) {
    if (content[index] !== "=") return null;
  }
  // Canonical padding leaves the unused trailing bits zero; anything else is a
  // second spelling of the same prefix and is refused.
  const last = BASE64_ALPHABET.indexOf(content[dataEnd - 1] as string);
  if (padding === 2 && last % 16 !== 0) return null;
  if (padding === 1 && last % 4 !== 0) return null;
  return (content.length / 4) * 3 - padding;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length) return false;
  const sorted = [...expected].sort();
  return keys.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Product validation runs around the shared wire/storage mechanism. */
export interface ResearchInputBundleProtocol {
  parseManifest: typeof parseResearchInputBundleManifest;
  parseRequest: typeof parseResearchInputBundleRequest;
}
export const researchInputBundleProtocol: ResearchInputBundleProtocol = {
  parseManifest: parseResearchInputBundleManifest,
  parseRequest: parseResearchInputBundleRequest,
};
