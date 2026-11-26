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
 * Publish research-plan text authored in a conversation as an ordinary Session
 * Artifact version.
 *
 * This exists because the existing Artifact tools publish a *workspace file*
 * (`declare_artifact`), which needs a writable run workspace. A conversation whose
 * Agent only reasons (no shell, no Runner) can still author a plan, so this narrow
 * path takes the bounded text itself and writes it through the canonical
 * Artifact/version/content-store path: the same catalog row, content hash,
 * revision chain and provenance as any other declared artifact.
 *
 * It is not a document editor and not a plan registry: bounded markdown text, an
 * optional existing plan to revise, and the version reference back. The bytes it
 * publishes are exactly the bytes a later `start_research` may stage.
 */
import { createHash } from "node:crypto";

import { CasStore } from "@sciencediscovery/cas";
import type { ArtifactOriginMeta, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";

/** The logical name a first plan gets when the Agent does not name one. */
export const RESEARCH_PLAN_DEFAULT_NAME = "research-plan.md";
/** One plan is bounded research text; anything larger is not a plan. */
export const RESEARCH_PLAN_MAX_BYTES = 64 * 1024;
/** A logical name stays a short relative path. */
export const RESEARCH_PLAN_NAME_MAX_LENGTH = 200;

export type ResearchPlanRefusalReason =
  | "invalid-option"
  | "session-not-found"
  | "session-not-writable"
  | "plan-not-found"
  | "plan-version-mismatch"
  | "plan-publication-failed";

export class ResearchPlanRefusal extends Error {
  readonly reason: ResearchPlanRefusalReason;
  constructor(reason: ResearchPlanRefusalReason, message: string) {
    super(message);
    this.name = "ResearchPlanRefusal";
    this.reason = reason;
  }
}

/** The store surface this module uses. `SessionStore` satisfies it. */
export interface ResearchPlanStore {
  readonly dataDir: string;
  assertSessionWritable(sessionId: string): void;
  getSession(sessionId: string): { readonly projectId: string } | undefined;
  getProjectArtifact(projectId: string, artifactId: string): {
    readonly createdInSessionId?: string;
    readonly currentVersion: number;
    readonly deletedAt?: string;
    readonly id: string;
    readonly kind: string;
    readonly origin?: string;
  } | undefined;
  getProjectArtifactVersion(projectId: string, versionId: string): {
    readonly artifactId: string;
    readonly content: { readonly hash: string; readonly size: number };
    readonly id: string;
  } | undefined;
  getArtifactByName(sessionId: string, name: string): {
    readonly createdInSessionId?: string;
    readonly currentVersion: number;
    readonly deletedAt?: string;
    readonly id: string;
    readonly kind: string;
    readonly origin?: string;
  } | undefined;
  listProjectArtifactVersions(projectId: string, artifactId: string): readonly {
    readonly content: { readonly hash: string; readonly size: number };
    readonly id: string;
    readonly version: number;
  }[];
  createArtifactVersion(input: {
    artifactId?: string;
    baseVersionId?: string;
    content: { readonly hash: string; readonly size: number };
    description?: string;
    /** Keeps a same-named artifact from another research copy independent. */
    forceNewArtifact?: boolean;
    kind: "markdown";
    logicalName: string;
    mediaType: string;
    origin?: "llm_declared";
    originMeta?: ArtifactOriginMeta;
    sessionId: string;
    title?: string;
  }): Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion }>;
}

export interface ResearchPlanPublication {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly logicalName: string;
  readonly mediaType: string;
  /** True when this exact content was already the version this call would write. */
  readonly reused: boolean;
  readonly size: number;
  readonly version: number;
  readonly versionId: string;
}

export interface PublishResearchPlanInput {
  readonly projectId: string;
  readonly sessionId: string;
  /** The conversation run whose Agent authored this text, kept as provenance. */
  readonly runId: string;
  readonly content: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  /** Revise an existing plan: both identities are required together. */
  readonly artifactId?: string;
  readonly baseVersionId?: string;
  /** Makes a retried tool call resolve to the version it already published. */
  readonly publicationId?: string;
}

/**
 * Publish plan text as a Session Artifact version.
 *
 * A revision must name both an existing plan and the version it was written
 * against, so a concurrent edit cannot be overwritten silently. Publication is
 * idempotent by content: asking again with the bytes already at the head returns
 * that version instead of writing an empty revision.
 */
export async function publishResearchPlan(
  store: ResearchPlanStore,
  input: PublishResearchPlanInput,
): Promise<ResearchPlanPublication> {
  const session = store.getSession(input.sessionId);
  if (!session || session.projectId !== input.projectId) {
    throw new ResearchPlanRefusal("session-not-found", "The Session does not exist in this Project");
  }
  store.assertSessionWritable(input.sessionId);

  const logicalName = input.name === undefined
    ? RESEARCH_PLAN_DEFAULT_NAME
    : requirePlanName(input.name);
  const text = input.content;
  if (text.trim().length === 0 || text.includes("\u0000")) {
    throw new ResearchPlanRefusal("invalid-option", "The plan text must be non-empty text without NUL bytes");
  }
  if (Buffer.byteLength(text, "utf8") > RESEARCH_PLAN_MAX_BYTES) {
    throw new ResearchPlanRefusal("invalid-option", `The plan text must be at most ${RESEARCH_PLAN_MAX_BYTES} bytes`);
  }
  if (!!input.artifactId !== !!input.baseVersionId) {
    throw new ResearchPlanRefusal(
      "invalid-option",
      "Revising a plan needs both artifact_id and base_version_id",
    );
  }

  let target: NonNullable<ReturnType<ResearchPlanStore["getProjectArtifact"]>> | undefined;
  // A same-named artifact that was created in another Session is a different
  // research copy: this Session's plan gets its own artifact instead of a
  // version that no start could ever accept.
  let forceNewArtifact = false;
  if (input.artifactId) {
    target = store.getProjectArtifact(input.projectId, input.artifactId);
    if (!target || target.deletedAt || target.createdInSessionId !== input.sessionId) {
      throw new ResearchPlanRefusal("plan-not-found", "The plan to revise is not a live artifact of this Session");
    }
    const base = store.getProjectArtifactVersion(input.projectId, input.baseVersionId!);
    if (!base || base.artifactId !== target.id) {
      throw new ResearchPlanRefusal("plan-version-mismatch", "The base version does not belong to that plan");
    }
  } else {
    const existing = store.getArtifactByName(input.sessionId, logicalName);
    if (existing && !existing.deletedAt) {
      if (existing.createdInSessionId === input.sessionId) {
        target = existing;
      } else {
        forceNewArtifact = true;
      }
    }
  }

  const bytes = Buffer.from(text, "utf8");
  const content = { hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  if (target) {
    // Only an unchanged head is a replay. A newer plan the Session already holds
    // must not be replaced by an older body just because the tool was retried.
    const head = store.listProjectArtifactVersions(input.projectId, target.id).at(-1);
    if (head && head.content.hash === content.hash && head.content.size === content.size
      && (input.baseVersionId === undefined || head.id === input.baseVersionId)) {
      return {
        artifactId: target.id,
        contentHash: content.hash,
        logicalName,
        mediaType: "text/markdown",
        reused: true,
        size: content.size,
        version: head.version,
        versionId: head.id,
      };
    }
  }

  let stored;
  try {
    stored = await new CasStore(store.dataDir).put(bytes);
  } catch {
    throw new ResearchPlanRefusal("plan-publication-failed", "The plan text could not be retained");
  }
  if (stored.hash !== content.hash || stored.size !== content.size) {
    throw new ResearchPlanRefusal("plan-publication-failed", "The content store did not retain the plan text");
  }

  const originMeta: ArtifactOriginMeta = {
    agentRunId: input.runId,
    publishedBy: "research-plan-tool",
  };
  let created;
  try {
    created = await store.createArtifactVersion({
      ...(target ? { artifactId: target.id, baseVersionId: input.baseVersionId! } : {}),
      content: stored,
      ...(input.description ? { description: input.description } : {}),
      ...(forceNewArtifact ? { forceNewArtifact: true } : {}),
      kind: "markdown",
      logicalName,
      mediaType: "text/markdown",
      origin: "llm_declared",
      originMeta,
      sessionId: input.sessionId,
      ...(input.title ? { title: input.title } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ARTIFACT_VERSION_CONFLICT") || message.includes("ARTIFACT_PUBLICATION_CONFLICT")) {
      throw new ResearchPlanRefusal(
        "plan-version-mismatch",
        "The plan changed since the base version; read it again before revising",
      );
    }
    throw new ResearchPlanRefusal("plan-publication-failed", message.slice(0, 300));
  }
  return {
    artifactId: created.artifact.id,
    contentHash: created.version.content.hash,
    logicalName: created.artifact.logicalName,
    mediaType: created.version.mediaType,
    reused: false,
    size: created.version.content.size,
    version: created.version.version,
    versionId: created.version.id,
  };
}

/**
 * A plan keeps the existing artifact-name contract (a safe relative path) and is
 * always markdown, so it is readable with the ordinary artifact tools.
 */
function requirePlanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > RESEARCH_PLAN_NAME_MAX_LENGTH || name.startsWith("/")
    || name.includes("\0") || name.includes("\n")
    || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ResearchPlanRefusal("invalid-option", "The plan name must be a safe relative path");
  }
  if (!name.toLowerCase().endsWith(".md")) {
    throw new ResearchPlanRefusal("invalid-option", "The plan name must end with .md");
  }
  return name;
}
