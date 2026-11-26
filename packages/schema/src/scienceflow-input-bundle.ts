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

/** ScienceFlow domain roles over the shared input-bundle protocol. */
import {
  parseResearchInputBundleManifest,
  parseResearchInputBundleRequest,
  isResearchInputBundleDigest,
  isResearchInputBundlePath,
  canonicalResearchInputBundleManifest,
  researchInputBundleTotalBytes,
  type ResearchInputBundleManifest,
  type ResearchInputBundleProtocol,
} from "./research-input-bundle.js";

/** The only bundle version this contract accepts. */
export const SCIENCE_FLOW_INPUT_BUNDLE_VERSION = 1;

/**
 * Fixed file roles the frozen contract enumerates. A bundle must carry every
 * role except `shared_task_defaults`, which is present only when the plan
 * applied a shared task-defaults file.
 */
export const SCIENCE_FLOW_INPUT_FILE_ROLES = [
  "manifest",
  "task_yaml",
  "shared_task_defaults",
  "description",
  "evaluator",
] as const;
export type ScienceFlowInputFileRole =
  (typeof SCIENCE_FLOW_INPUT_FILE_ROLES)[number];

/** Roles that are always required, whatever the frozen contract contains. */
export const SCIENCE_FLOW_INPUT_REQUIRED_ROLES = [
  "manifest",
  "task_yaml",
  "description",
  "evaluator",
] as const satisfies readonly ScienceFlowInputFileRole[];

/**
 * Hard bounds, applied identically by both sides.
 *
 * The per-entry bound matches the largest source file the contract builder
 * will read; the total covers the four structured files plus one evaluator at
 * their individual maxima. The body bound leaves room for base64 expansion.
 */
export const SCIENCE_FLOW_INPUT_BUNDLE_LIMITS = Object.freeze({
  maxFiles: SCIENCE_FLOW_INPUT_FILE_ROLES.length,
  maxEntryBytes: 2 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxPathLength: 512,
  maxBodyBytes: 8 * 1024 * 1024,
});

/** One byte set in the canonical manifest: no content, only its identity. */
export interface ScienceFlowInputBundleManifestFile {
  /** Logical bundle-relative label, never a host path. */
  readonly path: string;
  /** Every role this byte set serves, in `SCIENCE_FLOW_INPUT_FILE_ROLES` order. */
  readonly roles: readonly ScienceFlowInputFileRole[];
  readonly size: number;
  readonly sha256: string;
}

/** The content identity of a bundle, without any business or Runner identity. */
export interface ScienceFlowInputBundleManifest {
  readonly schemaVersion: typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION;
  readonly contractDigest: string;
  readonly files: readonly ScienceFlowInputBundleManifestFile[];
}

/** One file on the wire: the canonical manifest plus the bytes it describes. */
export interface ScienceFlowInputBundleEntry
  extends ScienceFlowInputBundleManifestFile {
  /** Canonical padded base64 of exactly `size` bytes. */
  readonly content: string;
}

/**
 * What the API sends to a Runner. `bundleDigest` is the sender's claim; the
 * Runner recomputes it from the manifest and refuses a disagreement.
 */
export interface ScienceFlowInputBundleRequest {
  readonly schemaVersion: typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION;
  readonly contractDigest: string;
  readonly bundleDigest: string;
  readonly entries: readonly ScienceFlowInputBundleEntry[];
}

/** A materialized, independently verified bundle. */
export interface ScienceFlowInputBundlePublication {
  readonly schemaVersion: typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION;
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
export interface ScienceFlowInputBundleStatusDto {
  readonly schemaVersion: typeof SCIENCE_FLOW_INPUT_BUNDLE_VERSION;
  readonly bundleDigest: string;
  readonly status: "ready" | "missing" | "corrupt";
  readonly contractDigest: string | null;
  readonly fileCount: number | null;
  readonly totalBytes: number | null;
}


export const isScienceFlowInputBundleDigest = isResearchInputBundleDigest;
export const isScienceFlowInputBundlePath = isResearchInputBundlePath;
export const canonicalScienceFlowInputBundleManifest = canonicalResearchInputBundleManifest;
export const scienceFlowInputBundleTotalBytes = researchInputBundleTotalBytes;

export function isScienceFlowInputFileRole(value: unknown): value is ScienceFlowInputFileRole {
  return SCIENCE_FLOW_INPUT_FILE_ROLES.some((role) => role === value);
}

function domainManifest(manifest: ResearchInputBundleManifest): ScienceFlowInputBundleManifest | undefined {
  if (manifest.files.length > SCIENCE_FLOW_INPUT_BUNDLE_LIMITS.maxFiles) return undefined;
  const served = new Set<ScienceFlowInputFileRole>();
  const files: ScienceFlowInputBundleManifestFile[] = [];
  for (const file of manifest.files) {
    const roles: ScienceFlowInputFileRole[] = [];
    let previous = -1;
    for (const label of file.roles) {
      const role = SCIENCE_FLOW_INPUT_FILE_ROLES.find((entry) => entry === label);
      if (role === undefined || served.has(role)) return undefined;
      const index = SCIENCE_FLOW_INPUT_FILE_ROLES.indexOf(role);
      if (index <= previous) return undefined;
      previous = index;
      served.add(role);
      roles.push(role);
    }
    files.push({ ...file, roles });
  }
  if (SCIENCE_FLOW_INPUT_REQUIRED_ROLES.some((role) => !served.has(role))) return undefined;
  return { ...manifest, files };
}

export function parseScienceFlowInputBundleManifest(value: unknown):
  | { readonly status: "ok"; readonly manifest: ScienceFlowInputBundleManifest }
  | { readonly status: "invalid" } {
  const parsed = parseResearchInputBundleManifest(value);
  if (parsed.status !== "ok") return parsed;
  const manifest = domainManifest(parsed.manifest);
  return manifest ? { status: "ok", manifest } : { status: "invalid" };
}

export function parseScienceFlowInputBundleRequest(value: unknown):
  | { readonly status: "ok"; readonly manifest: ScienceFlowInputBundleManifest; readonly request: ScienceFlowInputBundleRequest }
  | { readonly status: "invalid" } {
  const parsed = parseResearchInputBundleRequest(value);
  if (parsed.status !== "ok") return parsed;
  const manifest = domainManifest(parsed.manifest);
  if (!manifest) return { status: "invalid" };
  const entries = manifest.files.map((file, index) => ({ ...file, content: parsed.request.entries[index]!.content }));
  return { status: "ok", manifest, request: { ...parsed.request, entries } };
}
export const scienceFlowInputBundleProtocol: ResearchInputBundleProtocol = {
  parseManifest: parseScienceFlowInputBundleManifest,
  parseRequest: parseScienceFlowInputBundleRequest,
};
