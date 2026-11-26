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

/** Product assembly: platform preparation/publication policy over a communication-only transport. */
import { createResearchEngineService } from "../research/engine-service.js";
import { createScienceFlowExecutionTransport, type ScienceFlowExecutionTransportInput } from "./engine-adapter.js";
import { scienceFlowPreparationSteps } from "./operation-preparation.js";
import { scienceFlowOperationTransitions, applyScienceFlowLaunchGrant } from "./operation-policy.js";
import { scienceFlowOperationDelivery, type ScienceFlowResultDelivery } from "./operation-delivery.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import type { ResearchPilotDependencies } from "./research-pilot.js";
import type { LocalResearchServiceStore } from "./local-research.js";
export interface ScienceFlowEngineAdapterInput extends ScienceFlowExecutionTransportInput, Pick<ResearchPilotDependencies, "readSnapshot"> {
  readonly store: LocalResearchServiceStore;
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly readArtifactBytes: (hash: string) => Promise<Buffer>;
  readonly deliver: ScienceFlowResultDelivery;
  readonly ownerStopped: (sessionId: string, runId: string) => Promise<boolean>;
}
export function createScienceFlowEngineAdapter(input: ScienceFlowEngineAdapterInput) {
  return createResearchEngineService({
    transport: createScienceFlowExecutionTransport(input),
    transitions: scienceFlowOperationTransitions(input.now),
    preparation: scienceFlowPreparationSteps(input),
    beforeLaunch: applyScienceFlowLaunchGrant,
    deliver: scienceFlowOperationDelivery(input),
    now: input.now,
    ownerStopped: input.ownerStopped,
  });
}
