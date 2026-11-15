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
 * Process-wide access to the one experimental local research service.
 *
 * The run scheduler is a module, not a class: it already owns process-wide
 * state for active runs and cancellation. The service is created once by the
 * composition root from administrator configuration, and both the conversation
 * tool assembly and the Session cancel path read it from here. When the mode is
 * disabled the slot stays empty and no tool is exposed.
 *
 * Tests that build several compositions in one process must clear the slot (or
 * set their own service) so one fixture cannot leak into the next.
 */
import type { LocalResearchService } from "./local-research.js";

let activeService: LocalResearchService | undefined;

export function setLocalResearchService(service: LocalResearchService | undefined): void {
  activeService = service;
}

export function getLocalResearchService(): LocalResearchService | undefined {
  return activeService;
}

export function clearLocalResearchService(): void {
  activeService = undefined;
}
