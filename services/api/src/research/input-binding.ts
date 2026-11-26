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
 * Engine-neutral binding of exact Session artifact versions as task inputs.
 *
 * The mechanism is shared: a named version must be a live version of the
 * authorized Session, its CAS bytes must match the recorded digest and size,
 * and an optional configured-file comparison proves that the version being
 * linked is byte-identical to the bytes the product will actually stage. What
 * roles exist (a plan, a seed, a dataset) and what the product does with their
 * bytes stay with the product.
 */
import { createHash } from "node:crypto";

export class ResearchInputRefusal extends Error {
  readonly reason:
    | "link-version-not-found"
    | "link-version-unreadable"
    | "link-version-mismatch"
    | "configured-input-unavailable"
    | "invalid-option";
  constructor(reason: ResearchInputRefusal["reason"], message: string) {
    super(message);
    this.name = "ResearchInputRefusal";
    this.reason = reason;
  }
}

/** The store surface input binding needs. */
export interface ResearchInputStore {
  readonly dataDir: string;
  getProject(projectId: string): unknown;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
  getProjectArtifactVersion(projectId: string, versionId: string): {
    readonly artifactId: string;
    readonly content: { readonly hash: string; readonly size: number };
    readonly id: string;
    readonly sessionId?: string;
    readonly version: number;
  } | undefined;
  getProjectArtifact(projectId: string, artifactId: string): {
    readonly createdInSessionId?: string;
    readonly currentVersion: number;
    readonly deletedAt?: string;
    readonly id: string;
    readonly kind: string;
    readonly logicalName?: string;
    readonly name?: string;
    readonly origin?: string;
  } | undefined;
}

export type ResearchArtifactVersionRecord = NonNullable<ReturnType<ResearchInputStore["getProjectArtifactVersion"]>>;

/** Bytes and their verified identity. */
export interface ResearchVerifiedBytes {
  readonly sha256: string;
  readonly size: number;
}

/** CAS reader; tests substitute one. */
export type ResearchBytesReader = (hash: string) => Promise<Buffer>;

/** The store's artifact version types, named for callers. */
export interface ResearchArtifactVersionBytes extends ResearchVerifiedBytes {
  readonly version: ResearchArtifactVersionRecord;
}

/**
 * Resolve a version the caller named and prove it is a live artifact version of
 * this Session. It never links a version from another Session or a deleted one.
 */
export function resolveSessionArtifactVersion(
  store: ResearchInputStore,
  identity: { readonly projectId: string; readonly sessionId: string },
  versionId: string,
  label: string,
): ResearchArtifactVersionRecord {
  const version = store.getProjectArtifactVersion(identity.projectId, versionId);
  const artifact = version ? store.getProjectArtifact(identity.projectId, version.artifactId) : undefined;
  if (!version || !artifact || artifact.deletedAt || artifact.createdInSessionId !== identity.sessionId) {
    throw new ResearchInputRefusal(
      "link-version-not-found",
      `The ${label} version is not a live artifact version of this Session`,
    );
  }
  return version;
}

/** Read one linked version's CAS bytes and verify they match the recorded digest. */
export async function readVerifiedVersionBytes(
  store: ResearchInputStore,
  version: ResearchArtifactVersionRecord,
  label: string,
  readBytes?: ResearchBytesReader,
): Promise<ResearchVerifiedBytes> {
  let bytes: Buffer;
  try {
    bytes = await (readBytes ?? defaultReadBytes(store))(version.content.hash);
  } catch {
    throw new ResearchInputRefusal(
      "link-version-unreadable",
      `The ${label} version's content could not be read`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== version.content.hash || bytes.length !== version.content.size) {
    throw new ResearchInputRefusal(
      "link-version-unreadable",
      `The ${label} version's content does not match its recorded digest`,
    );
  }
  return { sha256: digest, size: bytes.length };
}

/**
 * Bind one named version as an exact input. The returned digest/size are the
 * verified bytes; `expected` is the product's configured file digest, which the
 * version must equal when the product fixed that input.
 */
export async function bindExactVersionInput(input: {
  readonly store: ResearchInputStore;
  readonly identity: { readonly projectId: string; readonly sessionId: string };
  readonly versionId: string;
  readonly label: string;
  readonly expected?: ResearchVerifiedBytes;
  readonly readBytes?: ResearchBytesReader;
}): Promise<ResearchArtifactVersionBytes> {
  const version = resolveSessionArtifactVersion(
    input.store,
    input.identity,
    input.versionId,
    input.label,
  );
  const actual = await readVerifiedVersionBytes(
    input.store,
    version,
    input.label,
    input.readBytes,
  );
  if (input.expected && (input.expected.sha256 !== actual.sha256 || input.expected.size !== actual.size)) {
    throw new ResearchInputRefusal(
      "link-version-mismatch",
      `The ${input.label} version's bytes are not the input this run will stage`,
    );
  }
  return { ...actual, version };
}

/** The digest and size of one configured input file, read with a size cap. */
export async function digestInputFile(
  read: () => Promise<Buffer>,
  maxBytes: number,
  label: string,
): Promise<ResearchVerifiedBytes> {
  let bytes: Buffer;
  try {
    bytes = await read();
  } catch {
    throw new ResearchInputRefusal(
      "configured-input-unavailable",
      `This research profile's configured ${label} input could not be read`,
    );
  }
  if (bytes.length > maxBytes) {
    throw new ResearchInputRefusal(
      "configured-input-unavailable",
      `This research profile's configured ${label} input is too large`,
    );
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function defaultReadBytes(store: ResearchInputStore): ResearchBytesReader {
  // Imported lazily so the shared module does not bake a package dependency
  // into its surface; a caller may always supply its own reader.
  return async (hash: string) => {
    const { CasStore } = await import("@sciencediscovery/cas");
    return new CasStore(store.dataDir).read(hash);
  };
}

/** True when `candidate` resolves inside `root`; both must be absolute. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate === root || candidate.startsWith(prefix);
}
