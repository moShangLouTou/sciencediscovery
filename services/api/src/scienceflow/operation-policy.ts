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

import type { ResearchLifecycleTransitions, ResearchEngineAdapter } from "../research/engine-adapter.js";
import type { ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery } from "./local-research-record.js";
export function scienceFlowOperationTransitions(now: () => string): ResearchLifecycleTransitions<ScienceFlowLocalResearchOperation> {
  return {
    deliveryFailed(record, message) {
      return {
        ...record,
        delivery: {
          attempts: record.delivery.attempts + 1,
          message,
          reason: "publication-failed",
          state: "failed",
          updatedAt: now(),
        },
      };
    },
    failed(record, step, message) {
      return { ...record, state: "failed", error: { message, step } };
    },
    stopped(record) {
      return { ...record, state: "stopped" };
    },
    stoppedByConversation(record, at) {
      return {
        ...record,
        state: "stopped",
        stop: record.stop.requestedAt
          ? record.stop
          : { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" },
      };
    },
    stopping(record, at, requestedBy) {
      return {
        ...record,
        state: record.state === "completed" || record.state === "failed" ? record.state : "stopping",
        stop: { ...record.stop, requestedAt: at, requestedBy },
      };
    },
    stopRequestedByConversation(record, at) {
      return {
        ...record,
        stop: { ...record.stop, requestedAt: at, requestedBy: "conversation-cancel" },
      };
    },
    stopResult(record, at, result) {
      return {
        ...record,
        state: result.confirmed ? "stopped" : record.state,
        engine: { ...record.engine, ...(result.confirmed ? { status: "stopped" } : {}) },
        stop: {
          ...record.stop,
          ...(result.confirmed ? { confirmedAt: at, engineStatus: "stopped" } : {}),
          ...(result.error ? { lastError: result.error } : {}),
        },
      };
    },
    unknown(record) {
      return { ...record, state: "unknown" };
    },
  };

}

export const applyScienceFlowLaunchGrant: ResearchEngineAdapter<ScienceFlowLocalResearchOperation, ScienceFlowLocalResearchDelivery>["beforeLaunch"] = (record, writer, budget) => {
      const grant = record.launch.grant;
      const totalAllowanceSec = budget?.allowanceSec ?? grant.totalAllowanceSec;
      if (totalAllowanceSec >= grant.totalAllowanceSec) {
        return { record, appliedAllowanceSec: grant.totalAllowanceSec };
      }
      // Only the engine-specific minimums and research/report split belong here.
      // The shared service computes the line's deadline and remaining allowance.
      if (totalAllowanceSec < 60) return { record, refusal: { step: "budget",
        message: `The research line has ${totalAllowanceSec}s before its deadline; a launch needs at least 60s` } };
      const reportBudgetSec = Math.min(grant.reportBudgetSec, Math.max(10, totalAllowanceSec - 30));
      const researchBudgetSec = Math.min(grant.researchBudgetSec, totalAllowanceSec - reportBudgetSec);
      if (researchBudgetSec < 30) return { record, refusal: { step: "budget",
        message: `The research line has ${totalAllowanceSec}s before its deadline; the engine's research/report minimums do not fit` } };
      const tightened = writer.mutate(record.operationId, (current) => ({ ...current,
        launch: { ...current.launch, grant: { ...grant, reportBudgetSec, researchBudgetSec, totalAllowanceSec } },
      }));
      return { record: tightened, appliedAllowanceSec: totalAllowanceSec };
    };
