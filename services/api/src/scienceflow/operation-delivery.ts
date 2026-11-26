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

import { writeDeliveryRecord, type ScienceFlowResultDeliveryRecord, type ScienceFlowResultDeliveryRequest } from "./result-delivery.js";
import type { LocalResearchServiceStore } from "./local-research.js";
import type { ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery, ScienceFlowLocalResearchArtifactRef } from "./local-research-record.js";
export type ScienceFlowResultDelivery = (store: LocalResearchServiceStore, request: ScienceFlowResultDeliveryRequest,
  dependencies: { readonly now?: () => string }) => Promise<ScienceFlowResultDeliveryRecord>;
export function scienceFlowOperationDelivery(input: { readonly store: LocalResearchServiceStore; readonly now: () => string; readonly deliver: ScienceFlowResultDelivery }) {
  const { store, now, deliver } = input;
  const deliveryState = (
    record: ScienceFlowLocalResearchOperation,
    delivered: ScienceFlowResultDeliveryRecord,
  ): ScienceFlowLocalResearchDelivery => {
    const previous = record.delivery;
    const attempts = previous.attempts + 1;
    if (delivered.outcome.status === "delivered" && delivered.selected) {
      const solution = delivered.artifacts.solution
        ? artifactRef(delivered.artifacts.solution, "solution")
        : undefined;
      const note = delivered.artifacts.note ? artifactRef(delivered.artifacts.note, "note") : undefined;
      const staged = delivered.attempts.flatMap((attempt) => attempt.artifact
        ? [{
            ...artifactRef(attempt.artifact, attempt.role),
            metricName: attempt.metricName,
            metricValue: attempt.metricValue,
          }]
        : []);
      const researcher = delivered.researcherRecords.flatMap((entry) => entry.artifact
        ? [artifactRef(entry.artifact, "researcher_record")]
        : []);
      return {
        state: "delivered",
        attempts,
        updatedAt: now(),
        selectedStageId: delivered.selected.stageId,
        metricName: delivered.selected.metricName,
        metricValue: delivered.selected.metricValue,
        lowerIsBetter: delivered.selected.lowerIsBetter,
        ...(solution ? { solution } : {}),
        ...(note ? { note } : {}),
        ...(staged.length ? { staged } : {}),
        ...(researcher.length ? { researcher } : {}),
      };
    }
    const failure = delivered.outcome;
    if (failure.status === "failed" && failure.failedStep === "resolve" && failure.reason === "no-candidate") {
      return { state: "no-candidate", attempts, updatedAt: now(), reason: failure.reason, message: failure.message };
    }
    const failed: ScienceFlowLocalResearchDelivery = failure.status === "failed"
      ? {
          state: "failed",
          attempts,
          updatedAt: now(),
          reason: failure.reason,
          failedStep: failure.failedStep,
          message: failure.message,
        }
      : { state: "failed", attempts, updatedAt: now(), message: "Delivery returned no outcome" };
    // A retry that fails after a successful publication keeps the delivered
    // versions visible; the new failure is recorded beside them, not on top.
    if (previous.state === "delivered") {
      return { ...previous, attempts, updatedAt: now(), lastError: failed.reason ?? failed.message };
    }
    return failed;
  };

  return {
    async deliver(
      record: ScienceFlowLocalResearchOperation,
      _options: { readonly force: boolean },
    ): Promise<ScienceFlowLocalResearchDelivery> {
      const delivered = await deliver(store, {
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
        runId: record.engineRunId,
        workDir: record.workDir,
        pythonExecutable: record.launch.pythonExecutable,
        readerScriptPath: record.launch.readerScriptPath,
        task: record.task,
        ...(record.taskBinding
          ? {
              evaluatorAuthority: record.taskBinding.source === "prepared" ? "generated-command" as const : "task-package" as const,
              taskSummary: record.taskBinding.summary,
              ...(record.taskBinding.source === "prepared" && record.taskBinding.evaluator.kind === "generated-command"
                ? { evaluatorSha256: record.taskBinding.evaluator.sha256 }
                : {}),
            }
          : {}),
        ...(record.planVersionId ? { planVersionId: record.planVersionId } : {}),
        ...(record.incumbentVersionId ? { incumbentVersionId: record.incumbentVersionId } : {}),
        includeAttempts: true,
        includeResearcherRecords: true,
        recordPath: record.deliveryRecordPath,
        launchReceiptPath: record.receiptPath,
        // This deployment started the run; the note must not claim otherwise.
        runOrigin: "experimental-local",
      }, { now });
      // The operation record is authoritative; this file is the same delivery
      // record the operator command writes, kept for local evidence.
      await writeDeliveryRecord(record.deliveryRecordPath, delivered).catch(() => undefined);
      return deliveryState(record, delivered);
    },
  }.deliver;
}

function artifactRef(
  artifact: {
    readonly artifactId: string;
    readonly logicalName: string;
    readonly version: number;
    readonly versionId: string;
  },
  role: ScienceFlowLocalResearchArtifactRef["role"],
): ScienceFlowLocalResearchArtifactRef {
  return {
    artifactId: artifact.artifactId,
    logicalName: artifact.logicalName,
    role,
    version: artifact.version,
    versionId: artifact.versionId,
  };
}
