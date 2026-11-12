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
 * The trusted checkout revision check, re-exported from the shared package.
 *
 * The implementation lives in `@sciencediscovery/scienceflow-reader` because
 * two hosts need the same rules: the API checks a checkout it can see, and a
 * Runner checks the checkout its interpreter resolves. Keeping one copy is what
 * stops the two answers from drifting; this module only preserves the import
 * path the API already used.
 */
export {
  checkEngineRevision,
  DEFAULT_REVISION_MAX_OUTPUT_BYTES,
  DEFAULT_REVISION_TIMEOUT_MS,
  parsePorcelain,
  type EngineRevisionCheckOptions,
  type EngineRevisionCheckResult,
  type EngineRevisionReason,
  type EngineRevisionStatus,
} from "@sciencediscovery/scienceflow-reader";
