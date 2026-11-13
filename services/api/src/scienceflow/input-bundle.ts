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
 * Assembles the frozen plan's enumerated input files into one evidence bundle.
 *
 * The bytes come from the same bounded reads that produced the contract
 * digests; nothing is re-read here. Every role is matched against the frozen
 * contract first — exact path and SHA-256 — so a bundle can never carry a file
 * set the plan did not describe. When two roles legitimately name the same
 * file (a description and an evaluator entrypoint that are one path), the byte
 * set is stored once and both role associations are kept.
 *
 * `contract-changed` means the current profile or source files no longer match
 * the frozen plan. It is a fixed answer: this module never guesses an older
 * version, updates the contract, or silently creates a new plan.
 */
import { createHash } from "node:crypto";

import {
  canonicalScienceFlowInputBundleManifest,
  parseScienceFlowInputBundleRequest,
  SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
  SCIENCE_FLOW_INPUT_FILE_ROLES,
  scienceFlowInputBundleTotalBytes,
  type ScienceFlowExecutionPlanContractDto,
  type ScienceFlowInputBundleManifest,
  type ScienceFlowInputBundleManifestFile,
  type ScienceFlowInputBundleRequest,
  type ScienceFlowInputFileRole,
} from "@sciencediscovery/schema";

import type { ScienceFlowContractFile } from "./execution-contract.js";
import { digestScienceFlowContract } from "./execution-contract.js";

export type ScienceFlowInputBundleAssembly =
  | {
      readonly status: "ok";
      readonly request: ScienceFlowInputBundleRequest;
      readonly manifest: ScienceFlowInputBundleManifest;
    }
  /** The current files do not match the frozen plan. */
  | { readonly status: "contract-changed" }
  /** The builder produced an internally inconsistent file set. */
  | { readonly status: "internal" };

/** SHA-256 over the canonical manifest; the bundle's content identity. */
export function scienceFlowInputBundleDigest(
  manifest: ScienceFlowInputBundleManifest,
): string {
  return createHash("sha256")
    .update(canonicalScienceFlowInputBundleManifest(manifest), "utf8")
    .digest("hex");
}

const ROLE_ORDER = new Map<ScienceFlowInputFileRole, number>(
  SCIENCE_FLOW_INPUT_FILE_ROLES.map((role, index) => [role, index]),
);

export function assembleScienceFlowInputBundle(
  contract: ScienceFlowExecutionPlanContractDto,
  files: readonly ScienceFlowContractFile[],
): ScienceFlowInputBundleAssembly {
  const byRole = new Map<ScienceFlowInputFileRole, ScienceFlowContractFile>();
  for (const file of files) {
    if (byRole.has(file.role)) return { status: "internal" };
    byRole.set(file.role, file);
  }

  // The contract enumerates exactly which files exist. A missing or extra role
  // is not a shape the contract supports, so it is never silently dropped.
  const expected = requiredRoleDigests(contract);
  if (byRole.size !== expected.size) return { status: "contract-changed" };
  for (const [role, expectedFile] of expected) {
    const actual = byRole.get(role);
    if (actual === undefined) return { status: "contract-changed" };
    if (
      actual.sha256 !== expectedFile.sha256 ||
      (expectedFile.path !== null && actual.path !== expectedFile.path)
    ) {
      return { status: "contract-changed" };
    }
  }

  // Group by logical path. The same path may serve several roles, but only if
  // every read saw the same bytes — otherwise the sources moved underneath the
  // contract and no single bundle can represent it.
  const merged = new Map<
    string,
    { size: number; sha256: string; roles: ScienceFlowInputFileRole[] }
  >();
  for (const file of byRole.values()) {
    const current = merged.get(file.path);
    if (current === undefined) {
      merged.set(file.path, {
        size: file.bytes.length,
        sha256: file.sha256,
        roles: [file.role],
      });
      continue;
    }
    if (
      current.sha256 !== file.sha256 ||
      current.size !== file.bytes.length
    ) {
      return { status: "contract-changed" };
    }
    current.roles.push(file.role);
  }

  const manifestFiles: ScienceFlowInputBundleManifestFile[] = [
    ...merged.entries(),
  ]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, file]) => ({
      path,
      roles: file.roles.sort(
        (left, right) => (ROLE_ORDER.get(left) as number) - (ROLE_ORDER.get(right) as number),
      ),
      size: file.size,
      sha256: file.sha256,
    }));

  const manifest: ScienceFlowInputBundleManifest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: digestScienceFlowContract(contract),
    files: manifestFiles,
  };
  const bundleDigest = scienceFlowInputBundleDigest(manifest);

  const request: ScienceFlowInputBundleRequest = {
    schemaVersion: SCIENCE_FLOW_INPUT_BUNDLE_VERSION,
    contractDigest: manifest.contractDigest,
    bundleDigest,
    entries: manifestFiles.map((file) => {
      const source = [...byRole.values()].find(
        (candidate) => candidate.path === file.path,
      );
      if (source === undefined) throw new Error("ScienceFlow input bundle lost a byte set");
      return {
        ...file,
        content: source.bytes.toString("base64"),
      };
    }),
  };

  // Self-validate with the same protocol the Runner applies: an assembly bug
  // must fail here rather than become a transfer the Runner refuses.
  const parsed = parseScienceFlowInputBundleRequest(request);
  if (parsed.status !== "ok") return { status: "internal" };
  return { status: "ok", request, manifest };
}

/** Total bytes of a canonical manifest. */
export function scienceFlowInputBundleSize(
  manifest: ScienceFlowInputBundleManifest,
): number {
  return scienceFlowInputBundleTotalBytes(manifest);
}

/** The exact role set the frozen contract describes, with the frozen digests. */
function requiredRoleDigests(
  contract: ScienceFlowExecutionPlanContractDto,
): Map<
  ScienceFlowInputFileRole,
  { readonly sha256: string; readonly path: string | null }
> {
  const expected = new Map<
    ScienceFlowInputFileRole,
    { readonly sha256: string; readonly path: string | null }
  >();
  expected.set("manifest", { sha256: contract.manifestSha256, path: null });
  expected.set("task_yaml", { sha256: contract.taskYamlSha256, path: null });
  expected.set("description", {
    sha256: contract.description.sha256,
    path: `package/${contract.description.path}`,
  });
  expected.set("evaluator", {
    sha256: contract.evaluator.sha256,
    path: `package/${contract.evaluator.path}`,
  });
  if (contract.sharedDefaultsSha256 !== null) {
    expected.set("shared_task_defaults", {
      sha256: contract.sharedDefaultsSha256,
      path: null,
    });
  }
  return expected;
}
