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

import type { ResearchOperation } from "../api/research-operations.js";

/** The lifecycle label a card shows for one operation. */
export type ResearchStatusKind =
  | "preparing"
  | "running"
  | "stop-requested"
  | "stopped"
  | "completed"
  | "failed"
  | "unknown";

export type ResearchTone = "active" | "waiting" | "done" | "failed" | "unknown";

export function isActiveResearch(operation: ResearchOperation): boolean {
  return operation.state === "accepted" || operation.state === "running" || operation.state === "stopping";
}

export function researchStatus(operation: ResearchOperation): { kind: ResearchStatusKind; tone: ResearchTone } {
  switch (operation.state) {
    case "accepted": return { kind: "preparing", tone: "waiting" };
    case "running": return { kind: "running", tone: "active" };
    case "stopping":
      // A request recorded without an engine confirmation is a different fact
      // from a stop the engine already reported.
      return operation.stop.confirmedAt
        ? { kind: "stopped", tone: "done" }
        : { kind: "stop-requested", tone: "waiting" };
    case "completed": return { kind: "completed", tone: "done" };
    case "failed": return { kind: "failed", tone: "failed" };
    case "stopped": return { kind: "stopped", tone: "done" };
    default: return { kind: "unknown", tone: "unknown" };
  }
}

/** A short human title from the recorded intent; the full text stays in details. */
export function researchTitle(operation: ResearchOperation, limit = 96): string {
  const text = operation.intent.replace(/\s+/g, " ").trim();
  if (!text) return operation.task;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function shortOperationId(operationId: string): string {
  return operationId.length > 8 ? operationId.slice(0, 8) : operationId;
}

export interface ResearchStageSummary {
  count: number;
  latest?: { name: string; value: number; stageId: string };
}

/** Captured engine stages only; a delivered independently evaluated attempt is not one. */
export function researchStages(operation: ResearchOperation): ResearchStageSummary {
  const latest = operation.stages.at(-1);
  return {
    count: operation.stages.length,
    ...(latest ? { latest: { name: latest.metricName, value: latest.metricValue, stageId: latest.stageId } } : {}),
  };
}

/**
 * The exact delivered result identities, so the card links to the same bytes a
 * continuation would use rather than an internal version number the user typed.
 */
export function deliveredResults(operation: ResearchOperation): {
  note?: { label: string; version: number; versionId: string };
  solution?: { label: string; version: number; versionId: string };
} {
  const { note, solution } = operation.delivery;
  return {
    ...(note ? { note: { label: note.logicalName, version: note.version, versionId: note.versionId } } : {}),
    ...(solution ? { solution: { label: solution.logicalName, version: solution.version, versionId: solution.versionId } } : {}),
  };
}

/**
 * Prefill for "Continue from this result". It names the delivered solution's
 * exact Artifact version and requires the ordinary composer send; clicking a
 * result never starts a run. No-op without a delivered solution.
 */
export function researchContinuationText(operation: ResearchOperation): string | undefined {
  const solution = operation.delivery.solution;
  if (operation.delivery.state !== "delivered" || !solution) return undefined;
  const note = operation.delivery.note;
  const noteText = note
    ? ` Read the delivered result note (${note.logicalName}, version ${note.versionId}) and the researcher's records.`
    : " Read the delivered result note and the researcher's records.";
  return [
    `Continue from research operation ${operation.operationId} (engine run ${operation.engineRunId}).`,
    `Use the delivered solution artifact version ${solution.versionId} (${solution.logicalName}, version ${solution.version}) as the exact starting solution.`,
    noteText,
    "Interpret what that run actually established, then publish a revised plan and start the next bounded experiment. State honestly which conclusions the evidence does and does not support.",
  ].join(" ");
}

/** Fixed delivery facts are shown beside the lifecycle, never as its success. */
export function deliveryLabelKey(operation: ResearchOperation):
  "pending" | "delivered" | "failed" | "noCandidate" {
  switch (operation.delivery.state) {
    case "delivered": return "delivered";
    case "failed": return "failed";
    case "no-candidate": return "noCandidate";
    default: return "pending";
  }
}

export function deliveryDetail(operation: ResearchOperation): string | undefined {
  const { delivery } = operation;
  if (delivery.state === "failed") return delivery.message ?? delivery.reason;
  if (delivery.state === "delivered" && delivery.metricName !== undefined && delivery.metricValue !== undefined) {
    const metric = `${delivery.metricName} ${formatMetric(delivery.metricValue)}`;
    return delivery.selectedStageId ? `${metric} · ${delivery.selectedStageId}` : metric;
  }
  return undefined;
}

export function formatMetric(value: number): string {
  // `String` gives the shortest round-trip form; do not round an engine score
  // for display.
  return String(value);
}
