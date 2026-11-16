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
 * E2E-META
 * Purpose: Verify the experimental local research workflow through the real Web conversation: start, live status, refresh recovery, delivery, download, continuation and stop.
 * Steps:
 *   1. Open the operator-prepared isolated Session with the dynamic research profile enabled.
 *   2. Send a natural-language request through the composer and observe the research card reach an active state.
 *   3. Refresh while active and verify the same operation persists without a duplicate launch.
 *   4. Wait for delivery, open the note and solution, download the solution and compare its sha256 with the delivered version.
 *   5. Use Continue from this result, edit the prefilled request, send it, verify the second operation starts from the first solution version, then stop it from the card.
 *   6. Inspect the desktop and narrow viewport and write the evidence record.
 * Environment: Operator-prepared isolated API/store (ROUND25_RESEARCH_*), pinned ScienceFlow engine and Python, synthetic local access token.
 * Type: real
 * LLM: Real company-gateway Qwen model stored in the isolated Session; no stub or judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Configured model gateway, local ScienceFlow process and local browser only.
 * Credentials: E2E_API_TOKEN; ROUND25_RESEARCH_* identities. No model token is read by the test.
 * CostSideEffects: Real model and CPU engine calls; one experiment and a stopped second run. Records stay in the isolated store.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { openProjectSession, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * Wait for a research state while answering an unexpected permission card the
 * way a user would: deny it. The one narrow research grant is already installed;
 * anything else (for example a workspace shell) is outside this journey.
 */
async function waitForResearchStatus(
  page: import("@playwright/test").Page,
  status: import("@playwright/test").Locator,
  pattern: RegExp,
  timeout: number,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const deny = page.getByRole("button", { name: "Deny", exact: true }).first();
    if (await deny.isVisible().catch(() => false)) await deny.click({ timeout: 2_000 }).catch(() => undefined);
    const text = await status.innerText().catch(() => "");
    if (pattern.test(text)) return text;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`research status did not match ${pattern} within ${timeout} ms`);
}

interface ResearchArtifactRef {
  artifactId: string;
  logicalName: string;
  role: string;
  version: number;
  versionId: string;
}

interface ResearchOperation {
  delivery: {
    message?: string;
    note?: ResearchArtifactRef;
    selectedStageId?: string;
    solution?: ResearchArtifactRef;
    state: "pending" | "delivered" | "failed" | "no-candidate";
  };
  engineRunId: string;
  incumbentVersionId: string | null;
  operationId: string;
  planVersionId: string | null;
  stages: Array<{ artifactSha256: string | null; stageId: string }>;
  state: string;
  stop: { confirmedAt?: string; requestedAt?: string };
}

const evidenceDir = resolve(process.env.ROUND25_EVIDENCE_DIR ?? ".tmp/r/round25/evidence");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the isolated round-25 journey`);
  return value;
}

test("L3-round25: run, observe, stop and continue research from the Web conversation", {
  tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l3", "@sandbox:none"],
}, async ({ page, journey }) => {
  test.setTimeout(1_800_000);
  const sessionId = required("ROUND25_RESEARCH_SESSION_ID");
  const projectName = required("ROUND25_RESEARCH_PROJECT_NAME");
  const projectId = required("ROUND25_RESEARCH_PROJECT_ID");
  const sessionTitle = required("ROUND25_RESEARCH_SESSION_TITLE");
  await mkdir(evidenceDir, { recursive: true });

  const api = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
    expect(response.ok(), `GET ${path}: HTTP ${response.status()}`).toBe(true);
    return response.json() as Promise<T>;
  };
  const operations = async (): Promise<ResearchOperation[]> => (await api<{ operations: ResearchOperation[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/research-operations`,
  )).operations;
  const runs = async (): Promise<Array<{ id: string; status: string }>> => api(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs`,
  );
  const panel = page.locator(".research-operation-panel");
  const firstRow = panel.locator(".research-operation").first();
  const status = (row = firstRow) => row.locator(".research-operation-status");
  const evidence: Record<string, unknown> = { sessionId, projectId };
  const artifactFold = page.locator('summary:has(strong:text-is("Artifacts"))').first();
  const artifactCount = async (): Promise<number> => {
    const text = await artifactFold.innerText().catch(() => "0");
    return Number(text.trim().split("\n").at(-1) ?? 0) || 0;
  };
  let baselineCount = 0;
  let artifactCountBefore = 0;

  journey.scenario({
    goal: "A person can run, observe, stop, inspect/download and continue research from the real Web conversation",
    preconditions: ["Isolated store with the round-24 history", "Dynamic research profile and pinned SF engine", "One narrow permission grant", "Real company-gateway model"],
  });

  await journey.step("Open the normal Session", "The research card is present in its empty state", async () => {
    await openProjectSession(page, {
      project: { id: projectId, name: projectName },
      session: { id: sessionId, projectId, title: sessionTitle },
    });
    await expect(panel).toBeVisible();
    baselineCount = (await operations()).length;
    artifactCountBefore = await artifactCount();
    evidence.baselineOperations = baselineCount;
    evidence.artifactsBefore = artifactCountBefore;
    if (baselineCount === 0) await expect(panel).toContainText("No research run yet");
    evidence.initialPanel = (await panel.innerText()).slice(0, 800);
    await page.screenshot({ path: resolve(evidenceDir, "ui-initial.png") });
  });

  const prompt = [
    "Please run one real, bounded circle-packing experiment in this Session, and write the plan yourself.",
    "Use only the research and artifact tools: do not survey prior artifacts, run shell commands, or probe Runner readiness for this request.",
    "Write a short plan (200-400 words) for one bounded 26-circle run that starts from the prepared solution version",
    `${required("ROUND25_RESEARCH_INCUMBENT_VERSION_ID")} (${process.env.ROUND25_RESEARCH_INCUMBENT_NAME ?? "the prepared starting solution"}).`,
    "The plan must state one concrete method change, the starting solution, the expected time budget and a falsifiable acceptance rule.",
    "It must be executable with the provided helpers in under six minutes; do not require a new solver implementation, package install, or hidden workspace path.",
    "The concrete change may be a small bounded perturbation or local search from the starting solution; do not write a new solver from scratch.",
    "Make it deliverable first: the very first action must produce and submit a minimally perturbed feasible copy of the incumbent (one small coordinate change is enough), so this run has a delivered result before any longer search.",
    "Then, only if time remains, run the planned bounded local search and submit a better candidate.",
    "Use the task's provided helper scripts under dataset/ (including dataset/submit.py) and keep every script and artifact in the ordinary workspace paths the task description names.",
    "Publish it with publish_research_plan, then immediately call start_research with that exact plan version and the incumbent version above.",
    "The starting solution is already prepared and verified; do not materialize, copy, inspect or execute it.",
    "Pass the version id directly as incumbent_version_id to start_research.",
    "Keep it executable as one bounded run: no dataset downloads, no package installs, no background processes.",
    "When it ends, read what it actually delivered and tell me what the researcher ran, the evaluated scores and whether they were valid,",
    "whether your acceptance rule was met, and every place the run deviated from your plan. Do not claim more than the delivered evidence shows.",
  ].join(" ");

  let firstView: ResearchOperation | undefined;
  let firstRunId: string | undefined;

  await journey.step("Send the request from the ordinary composer", "A real operation becomes active and the card shows it", async () => {
    const run = await sendUserMessage(page, sessionId, prompt);
    firstRunId = run.id;
    evidence.firstRunId = run.id;
    await waitForResearchStatus(page, status(), /Preparing|Running/, 900_000);
    await expect.poll(async () => (await operations()).length, { timeout: 120_000 }).toBe(baselineCount + 1);
    firstView = (await operations()).at(-1)!;
    evidence.firstOperation = {
      engineRunId: firstView!.engineRunId,
      operationId: firstView!.operationId,
      planVersionId: firstView!.planVersionId,
    };
    await expect(panel).toContainText(firstView!.engineRunId);
    await page.screenshot({ path: resolve(evidenceDir, "ui-active.png") });
  });

  await journey.step("Refresh while the run is active", "The same operation returns and no second run is launched", async () => {
    await page.reload();
    await openProjectSession(page, {
      project: { id: projectId, name: projectName },
      session: { id: sessionId, projectId, title: sessionTitle },
    });
    await expect(panel).toContainText(firstView!.engineRunId, { timeout: 60_000 });
    const afterRefresh = await operations();
    expect(afterRefresh).toHaveLength(baselineCount + 1);
    expect(afterRefresh.at(-1)!.operationId).toBe(firstView!.operationId);
    expect(afterRefresh.at(-1)!.engineRunId).toBe(firstView!.engineRunId);
    evidence.refresh = { operationId: afterRefresh.at(-1)!.operationId, operations: afterRefresh.length };
  });

  await journey.step("Let the experiment finish and deliver", "Artifacts appear without a manual reload and delivery is separate from lifecycle", async () => {
    const terminal = await waitForRunTerminal(page, sessionId, firstRunId!, 1_200_000);
    expect(terminal.status, terminal.error).toBe("completed");
    await expect(status()).toHaveText("Completed", { timeout: 180_000 });
    await expect(firstRow.locator(".research-operation-delivery")).toHaveClass(/delivered/, { timeout: 180_000 });
    await expect.poll(
      artifactCount,
      { message: "the delivered artifacts should appear in the Session catalog without a reload", timeout: 60_000 },
    ).toBeGreaterThan(artifactCountBefore);
    await expect.poll(async () => (await operations()).at(-1)!.delivery.state, { timeout: 60_000 }).toBe("delivered");
    firstView = (await operations()).at(-1);
    evidence.firstDelivered = {
      delivery: firstView!.delivery,
      stages: firstView!.stages,
      state: firstView!.state,
    };
    expect(firstView!.delivery.solution).toBeTruthy();
    expect(firstView!.delivery.note).toBeTruthy();
    expect(firstView!.delivery.selectedStageId).toBeTruthy();
    await page.screenshot({ path: resolve(evidenceDir, "ui-delivered.png") });
  });

  await journey.step("Open the result and download the exact delivered version", "The selected solution opens and its downloads match the immutable version", async () => {
    await firstRow.getByRole("button", { name: /Open selected solution/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const solution = firstView!.delivery.solution!;
    const canonical = await page.request.get(
      `${apiBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(solution.versionId)}/content`,
      { headers: authorizationHeader() },
    );
    expect(canonical.ok(), `read delivered version: HTTP ${canonical.status()}`).toBe(true);
    const canonicalBytes = await canonical.body();
    const canonicalSha = createHash("sha256").update(canonicalBytes).digest("hex");
    const selectedStage = firstView!.stages.find((stage) => stage.stageId === firstView!.delivery.selectedStageId);
    expect(selectedStage?.artifactSha256).toBe(canonicalSha);

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download current version" }).click();
    const download = await downloadPromise;
    const downloadedPath = resolve(evidenceDir, "downloaded-best-solution.json");
    await download.saveAs(downloadedPath);
    const downloadedBytes = await readFile(downloadedPath);
    const downloadedSha = createHash("sha256").update(downloadedBytes).digest("hex");
    expect(downloadedSha).toBe(canonicalSha);
    evidence.solutionDownload = {
      bytes: downloadedBytes.length,
      canonicalSha256: canonicalSha,
      downloadSha256: downloadedSha,
      logicalName: solution.logicalName,
      versionId: solution.versionId,
      stage: firstView!.delivery.selectedStageId,
      stageSha256: selectedStage?.artifactSha256,
    };
    await page.screenshot({ path: resolve(evidenceDir, "ui-solution-viewer.png") });
    await dialog.getByRole("button", { name: "Close artifact viewer" }).click();

    await firstRow.getByRole("button", { name: /Open result note/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("/result-note.md");
    await page.screenshot({ path: resolve(evidenceDir, "ui-note-viewer.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Close artifact viewer" }).click();
  });

  let secondView: ResearchOperation | undefined;
  let secondRunId: string | undefined;

  await journey.step("Continue from the delivered result", "Only a prefilled request is produced; the user sends it and the second operation starts from the exact version", async () => {
    const solution = firstView!.delivery.solution!;
    const runsBefore = new Set((await runs()).map((run) => run.id));
    await firstRow.getByRole("button", { name: "Continue from this result" }).click();
    const textarea = page.locator("form.composer textarea");
    await expect(textarea).toBeFocused();
    const prefilled = await textarea.inputValue();
    expect(prefilled).toContain(solution.versionId);
    expect(prefilled).toContain(firstView!.operationId);
    expect((await runs()).filter((run) => !runsBefore.has(run.id))).toHaveLength(0);
    const continuationEvidence: Record<string, unknown> = { prefilled, unmodified: prefilled };
    evidence.continuation = continuationEvidence;

    const edited = `${prefilled}\n\nKeep this run bounded, and report honestly what the evidence does and does not show.`;
    await textarea.fill(edited);
    continuationEvidence.edited = edited;
    const created = page.waitForRequest((candidate) => candidate.method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(candidate.url()));
    await page.getByRole("button", { name: /^(Run analysis|Add to queue)$/ }).click();
    await created;
    const run = await expect.poll(async () => {
      const fresh = (await runs()).find((candidate) => !runsBefore.has(candidate.id));
      return fresh?.id;
    }, { message: "the continued request should create a new conversation run", timeout: 60_000 }).toBeTruthy();
    void run;
    secondRunId = (await runs()).find((candidate) => !runsBefore.has(candidate.id))!.id;
    evidence.secondRunId = secondRunId;

    await expect.poll(async () => (await operations()).length, { timeout: 180_000 }).toBe(baselineCount + 2);
    secondView = (await operations()).at(-1);
    expect(secondView!.operationId).not.toBe(firstView!.operationId);
    expect(secondView!.incumbentVersionId).toBe(solution.versionId);
    expect(secondView!.planVersionId).not.toBe(firstView!.planVersionId);
    evidence.secondOperation = {
      engineRunId: secondView!.engineRunId,
      incumbentVersionId: secondView!.incumbentVersionId,
      operationId: secondView!.operationId,
      planVersionId: secondView!.planVersionId,
    };
    await expect(status(panel.locator(".research-operation").first())).toHaveText(/Preparing|Running|Stop requested|Stopped|Completed/, { timeout: 120_000 });
  });

  await journey.step("Stop the owned second run from the card", "Requested and confirmed states are truthful and the Session stays usable", async () => {
    const stop = panel.locator(".research-operation").first().getByRole("button", { name: "Stop research" });
    const stopVisible = await stop.isVisible().catch(() => false);
    const stopEvidence: Record<string, unknown> = {};
    if (stopVisible) {
      await stop.click();
      await expect(panel.locator(".research-operation-notice")).toHaveText(/Stop requested|confirmed|already ended/, { timeout: 60_000 });
      stopEvidence.notice = await panel.locator(".research-operation-notice").first().innerText();
      await expect(panel.locator(".research-operation").first().locator(".research-operation-status"))
        .toHaveText(/Stop requested|Stopped|Completed/, { timeout: 180_000 });
      await expect(panel.locator(".research-operation").first().locator(".research-operation-status"))
        .toHaveText("Stopped", { timeout: 180_000 });
      await page.screenshot({ path: resolve(evidenceDir, "ui-stopped.png") });
    } else {
      // The run ended before the click: exercise the stop path with a bounded
      // follow-up so C3 is still demonstrated on a real owned run.
      const fresh = await sendUserMessage(page, sessionId, "Start one more bounded circle-packing run from the same delivered solution, using the plan you just published. Keep it short.");
      await expect.poll(async () => (await operations()).length, { timeout: 180_000 }).toBe(3);
      await expect(status(panel.locator(".research-operation").first())).toHaveText(/Preparing|Running/, { timeout: 120_000 });
      await panel.locator(".research-operation").first().getByRole("button", { name: "Stop research" }).click();
      await expect(panel.locator(".research-operation-notice")).toHaveText(/Stop requested|confirmed|already ended/, { timeout: 60_000 });
      stopEvidence.followUpRunId = fresh.id;
      stopEvidence.notice = await panel.locator(".research-operation-notice").first().innerText();
      await expect(panel.locator(".research-operation").first().locator(".research-operation-status")).toHaveText("Stopped", { timeout: 180_000 });
    }
    const latest = (await operations()).at(-1)!;
    evidence.stop = { ...stopEvidence, state: latest.state, stop: latest.stop };
    expect(latest.stop.requestedAt).toBeTruthy();
    expect(latest.state).toBe("stopped");
    const runTerminal = await waitForRunTerminal(page, sessionId, secondRunId ?? firstRunId!, 600_000);
    evidence.secondRunTerminal = runTerminal.status;
    expect(["completed", "cancelled", "interrupted"]).toContain(runTerminal.status);
  });

  await journey.step("Inspect desktop and narrow rendering", "The card and its actions fit and remain reachable", async () => {
    await page.screenshot({ path: resolve(evidenceDir, "ui-desktop-final.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const box = await panel.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
    const stopOrContinue = panel.getByRole("button").first();
    await stopOrContinue.focus();
    await expect(stopOrContinue).toBeFocused();
    await page.screenshot({ path: resolve(evidenceDir, "ui-narrow.png") });
    evidence.narrow = { overflow, panelWidth: box?.width };
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(evidenceDir, "journey.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
});
