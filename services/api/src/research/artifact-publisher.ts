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
 * Engine-neutral publication of task outputs into a Session.
 *
 * The mechanism is shared: content is written to the existing CAS, an existing
 * artifact version with identical bytes is reused instead of duplicated, an
 * optional digest is verified before publication, and linked input versions are
 * resolved from this Session only. What a product chooses to publish (a
 * solution file, a note, a table of attempts, a proof) and how it describes the
 * result stay with the product; a non-metric result does not have to pretend to
 * be an experimental candidate.
 */
import { createHash } from "node:crypto";

import { CasStore } from "@sciencediscovery/cas";
import type {
  ArtifactOrigin,
  ArtifactOriginMeta,
  CasObjectRef,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
} from "@sciencediscovery/schema";

export class ResearchPublicationRefusal extends Error {
  readonly reason:
    | "session-not-found"
    | "invalid-option"
    | "content-mismatch"
    | "publication-failed"
    | "version-not-found"
    | "version-unreadable";
  constructor(reason: ResearchPublicationRefusal["reason"], message: string) {
    super(message);
    this.name = "ResearchPublicationRefusal";
    this.reason = reason;
  }
}

/** The store surface publication needs. `SessionStore` satisfies it. */
export interface ResearchArtifactStore {
  readonly dataDir: string;
  /** The Session's write gate; a read-only or archived Session is refused. */
  assertSessionWritable?(sessionId: string): unknown;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
  getArtifactByName(sessionId: string, logicalName: string): {
    readonly currentVersion: number;
    readonly deletedAt?: string;
    readonly id: string;
    readonly kind: string;
  } | undefined;
  listProjectArtifactVersions(projectId: string, artifactId: string): readonly {
    readonly content: CasObjectRef;
    readonly id: string;
    readonly mediaType?: string;
    readonly version: number;
  }[];
  createArtifactVersion(input: {
    readonly artifactId?: string;
    readonly baseVersionId?: string;
    readonly content: CasObjectRef;
    readonly description?: string;
    readonly forceNewArtifact?: boolean;
    readonly inputArtifactVersionIds?: string[];
    readonly kind: ScientificArtifactKind;
    readonly logicalName: string;
    readonly mediaType: string;
    readonly origin: ArtifactOrigin;
    readonly originMeta?: ArtifactOriginMeta;
    readonly sessionId: string;
    readonly title?: string;
  }): Promise<{ readonly artifact: ScientificArtifact; readonly version: ScientificArtifactVersion }>;
}

/** One published artifact version. `reused` means an identical version existed. */
export interface PublishedArtifact {
  readonly artifactId: string;
  readonly content: CasObjectRef;
  readonly kind: ScientificArtifactKind;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly status: "created" | "reused";
  readonly version: number;
  readonly versionId: string;
}

/** A fixed Session artifact version a result is linked to; never authored here. */
export interface LinkedArtifactVersion {
  readonly artifactId: string;
  readonly content: CasObjectRef;
  readonly logicalName: string;
  readonly title: string | null;
  readonly version: number;
  readonly versionId: string;
}

export interface PublishArtifactInput {
  readonly bytes: Buffer;
  readonly description: string;
  /** The digest the source must have; absent for generated text. */
  readonly digest?: string;
  readonly inputArtifactVersionIds?: string[];
  readonly kind: ScientificArtifactKind;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly origin?: ArtifactOrigin;
  readonly originMeta?: ArtifactOriginMeta;
  readonly sessionId: string;
  readonly title: string;
  readonly forceNewArtifact?: boolean;
}

/**
 * Publish one output through the canonical CAS and Artifact/version catalog.
 * An existing version of the same artifact with identical bytes is returned
 * instead of a duplicate, so repeated delivery and retries are idempotent and a
 * retry never creates the same output twice.
 */
// One SessionStore owns the catalog. Coordinate all publisher callers on that
// store, including separate task-service instances, before reading versions.
const publicationQueues = new WeakMap<ResearchArtifactStore, Map<string, Promise<void>>>();

export async function publishArtifactVersion(
  store: ResearchArtifactStore,
  input: PublishArtifactInput,
): Promise<PublishedArtifact> {
  let queues = publicationQueues.get(store);
  if (!queues) {
    queues = new Map();
    publicationQueues.set(store, queues);
  }
  const key = JSON.stringify([input.sessionId, input.logicalName]);
  const previous = queues.get(key);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, held);
  await previous;
  try {
    return await publishArtifactVersionLocked(store, input);
  } finally {
    release();
    if (queues.get(key) === held) queues.delete(key);
  }
}

async function publishArtifactVersionLocked(
  store: ResearchArtifactStore,
  input: PublishArtifactInput,
): Promise<PublishedArtifact> {
  const session = store.getSession(input.sessionId);
  if (!session) throw new ResearchPublicationRefusal("session-not-found", "The Session does not exist");
  // A late publication still respects the Session's write gate.
  store.assertSessionWritable?.(input.sessionId);
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  if (input.digest !== undefined && digest !== input.digest) {
    throw new ResearchPublicationRefusal(
      "content-mismatch",
      "The published content does not match the selected artifact digest",
    );
  }
  const content: CasObjectRef = { hash: digest, size: input.bytes.length };

  const existing = store.getArtifactByName(input.sessionId, input.logicalName);
  if (existing) {
    const versions = store.listProjectArtifactVersions(session.projectId, existing.id);
    const match = versions.find((version) =>
      version.content.hash === content.hash && version.content.size === content.size);
    if (match) {
      return {
        artifactId: existing.id,
        content: match.content,
        kind: existing.kind as ScientificArtifactKind,
        logicalName: input.logicalName,
        mediaType: match.mediaType ?? input.mediaType,
        status: "reused",
        version: match.version,
        versionId: match.id,
      };
    }
  }

  const cas = new CasStore(store.dataDir);
  const stored = await cas.put(input.bytes);
  if (stored.hash !== content.hash || stored.size !== content.size) {
    throw new ResearchPublicationRefusal(
      "publication-failed",
      "The content store did not retain the delivered bytes",
    );
  }
  const latest = existing
    ? store.listProjectArtifactVersions(session.projectId, existing.id).at(-1)
    : undefined;
  const { artifact, version } = await store.createArtifactVersion({
    ...(existing && latest ? { artifactId: existing.id, baseVersionId: latest.id } : {}),
    content: stored,
    description: input.description,
    ...(input.forceNewArtifact ? { forceNewArtifact: true } : {}),
    ...(input.inputArtifactVersionIds?.length
      ? { inputArtifactVersionIds: [...input.inputArtifactVersionIds] }
      : {}),
    kind: input.kind,
    logicalName: input.logicalName,
    mediaType: input.mediaType,
    origin: input.origin ?? "server_generated",
    ...(input.originMeta === undefined ? {} : { originMeta: { ...input.originMeta } }),
    sessionId: input.sessionId,
    title: input.title,
  });
  return {
    artifactId: artifact.id,
    content: version.content,
    kind: artifact.kind,
    logicalName: input.logicalName,
    mediaType: version.mediaType,
    status: "created",
    version: version.version,
    versionId: version.id,
  };
}

/** The store surface linked-version resolution needs. */
export interface ResearchLinkedVersionStore extends ResearchArtifactStore {
  getProjectArtifactVersion(projectId: string, versionId: string): {
    readonly artifactId: string;
    readonly content: CasObjectRef;
    readonly id: string;
    readonly sessionId?: string;
    readonly version: number;
  } | undefined;
  getProjectArtifact(projectId: string, artifactId: string): {
    readonly createdInSessionId?: string;
    readonly deletedAt?: string;
    readonly id: string;
    readonly name: string;
    readonly title?: string;
  } | undefined;
}

/**
 * Resolve a fixed version a result names (a plan, an incumbent, a proof input)
 * to the Session's own artifact record. Publication only links it: it never
 * writes, rewrites or interprets the linked content, and it refuses a version
 * from another Session or an unreadable one.
 */
export async function resolveLinkedArtifactVersion(
  store: ResearchLinkedVersionStore,
  identity: { readonly projectId: string; readonly sessionId: string },
  versionId: string,
  label: string,
): Promise<LinkedArtifactVersion> {
  if (typeof versionId !== "string" || !versionId.trim()) {
    throw new ResearchPublicationRefusal("invalid-option", `The ${label} version id is not a usable business id`);
  }
  const version = store.getProjectArtifactVersion(identity.projectId, versionId);
  const artifact = version ? store.getProjectArtifact(identity.projectId, version.artifactId) : undefined;
  if (!version || !artifact || artifact.deletedAt || artifact.createdInSessionId !== identity.sessionId) {
    throw new ResearchPublicationRefusal(
      "version-not-found",
      `The ${label} version is not a live artifact version of this Session`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await new CasStore(store.dataDir).read(version.content.hash);
  } catch {
    throw new ResearchPublicationRefusal("version-unreadable", `The ${label} version's content could not be read`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== version.content.size || digest !== version.content.hash) {
    throw new ResearchPublicationRefusal(
      "version-unreadable",
      `The ${label} version's content does not match its recorded digest`,
    );
  }
  return {
    artifactId: artifact.id,
    content: version.content,
    logicalName: artifact.name,
    title: artifact.title ?? null,
    version: version.version,
    versionId: version.id,
  };
}
