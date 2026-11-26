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
 * The narrow plan-publication path: bounded Markdown becomes an ordinary Session
 * Artifact version through the canonical catalog/content-store path, so a later
 * `start_research` stages exactly those bytes.
 */
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { CasStore } from "@sciencediscovery/cas";

import { SessionStore } from "../store.js";
import {
  publishResearchPlan,
  ResearchPlanRefusal,
  RESEARCH_PLAN_MAX_BYTES,
} from "./plan-publication.js";

const PLAN_TEXT = "# Plan\n\nCheck a fixed arithmetic statement and report the verified facts.\n";
const PLAN_TEXT_V2 = "# Plan v2\n\nCheck the revised statement using its exact input versions.\n";

interface Fixture {
  readonly projectId: string;
  readonly root: string;
  readonly sessionId: string;
  readonly store: SessionStore;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sd-research-plan-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => {
    store.close();
    await rm(root, { force: true, recursive: true });
  });
  const project = await store.createProject("Plan publication");
  const model = await store.createModel({
    apiToken: randomUUID(),
    baseUrl: "https://models.example.test/v1",
    model: "fixture-model",
    name: "Fixture model",
  });
  const session = await store.createSession(project.id, "Plan session", { modelId: model.id });
  return { projectId: project.id, root, sessionId: session.id, store };
}

function publish(target: Fixture, overrides: Record<string, unknown> = {}) {
  return publishResearchPlan(target.store, {
    content: PLAN_TEXT,
    projectId: target.projectId,
    runId: "conversation-run-1",
    sessionId: target.sessionId,
    ...overrides,
  } as Parameters<typeof publishResearchPlan>[1]);
}

async function storedText(target: Fixture, versionId: string): Promise<string> {
  const version = target.store.getProjectArtifactVersion(target.projectId, versionId);
  assert.ok(version);
  return (await new CasStore(target.store.dataDir).read(version.content.hash)).toString("utf8");
}

test("publishes the plan as a Session artifact version with Agent provenance", async (context) => {
  const target = await fixture(context);
  const published = await publish(target);
  assert.equal(published.logicalName, "research-plan.md");
  assert.equal(published.version, 1);
  assert.equal(published.reused, false);
  assert.equal(published.contentHash, createHash("sha256").update(PLAN_TEXT).digest("hex"));
  assert.equal(published.size, Buffer.byteLength(PLAN_TEXT));

  const artifact = target.store.getProjectArtifact(target.projectId, published.artifactId);
  assert.ok(artifact);
  assert.equal(artifact.createdInSessionId, target.sessionId);
  assert.equal(artifact.kind, "markdown");
  assert.equal(artifact.origin, "llm_declared");
  assert.equal(artifact.originMeta?.publishedBy, "research-plan-tool");
  assert.equal(artifact.originMeta?.agentRunId, "conversation-run-1");
  // The content is readable through the same version reference a start uses.
  assert.equal(await storedText(target, published.versionId), PLAN_TEXT);
});

test("re-publishing identical bytes returns the version that already holds them", async (context) => {
  const target = await fixture(context);
  const first = await publish(target);
  const replay = await publish(target, { publicationId: "run-1:call-1" });
  assert.equal(replay.reused, true);
  assert.equal(replay.versionId, first.versionId);
  assert.equal(
    target.store.listProjectArtifactVersions(target.projectId, first.artifactId).length,
    1,
    "a replay must not write an empty revision",
  );
});

test("a revision is chained to its base and a stale base is refused", async (context) => {
  const target = await fixture(context);
  const first = await publish(target);
  const second = await publish(target, {
    artifactId: first.artifactId,
    baseVersionId: first.versionId,
    content: PLAN_TEXT_V2,
  });
  assert.equal(second.version, 2);
  assert.notEqual(second.versionId, first.versionId);
  const version = target.store.listProjectArtifactVersions(target.projectId, first.artifactId)
    .find((candidate) => candidate.id === second.versionId);
  assert.equal(version?.baseVersionId, first.versionId);
  assert.equal(await storedText(target, second.versionId), PLAN_TEXT_V2);

  // A revision written against the old head must not overwrite the new one.
  await assert.rejects(
    publish(target, {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
      content: "# Plan v3\n\nA third plan.\n",
    }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "plan-version-mismatch",
  );
  // Revising needs both identities.
  await assert.rejects(
    publish(target, { artifactId: first.artifactId }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "invalid-option",
  );
});

test("a plan version from another Session is not revised", async (context) => {
  const target = await fixture(context);
  const other = await target.store.createSession(target.projectId, "Other session", {
    modelId: target.store.resolveRuntimeSettings(target.sessionId).effective.modelId,
  });
  const foreign = await publishResearchPlan(target.store, {
    content: PLAN_TEXT,
    name: "other/plan.md",
    projectId: target.projectId,
    runId: "run-other",
    sessionId: other.id,
  });
  await assert.rejects(
    publish(target, { artifactId: foreign.artifactId, baseVersionId: foreign.versionId }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "plan-not-found",
  );
});

test("a same-named plan in another Session becomes its own artifact", async (context) => {
  const target = await fixture(context);
  const modelId = target.store.resolveRuntimeSettings(target.sessionId).effective.modelId;
  const other = await target.store.createSession(target.projectId, "Second copy", { modelId });
  await publish(target);
  const second = await publishResearchPlan(target.store, {
    content: PLAN_TEXT_V2,
    projectId: target.projectId,
    runId: "run-other",
    sessionId: other.id,
  });
  assert.equal(
    target.store.getProjectArtifact(target.projectId, second.artifactId)?.createdInSessionId,
    other.id,
    "another research copy must not receive a version of this Session's plan",
  );
});

test("the plan name and text stay bounded and Markdown", async (context) => {
  const target = await fixture(context);
  await assert.rejects(
    publish(target, { name: "plan.txt" }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "invalid-option",
  );
  await assert.rejects(
    publish(target, { name: "../escape.md" }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "invalid-option",
  );
  await assert.rejects(
    publish(target, { content: "   \n" }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "invalid-option",
  );
  await assert.rejects(
    publish(target, { content: "x".repeat(RESEARCH_PLAN_MAX_BYTES + 1) }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "invalid-option",
  );
  await assert.rejects(
    publish(target, { projectId: "another-project" }),
    (error: unknown) => error instanceof ResearchPlanRefusal && error.reason === "session-not-found",
  );
});
