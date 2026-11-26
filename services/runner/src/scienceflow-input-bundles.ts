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

/** SF validation and legacy storage layout over the shared immutable store. */
import { scienceFlowInputBundleProtocol } from "@sciencediscovery/schema";
import { RunnerResearchInputBundles } from "./research-input-bundles.js";
export { ResearchInputBundleError as ScienceFlowInputBundleError,
  researchInputBundleDigest as scienceFlowInputBundleDigest,
  verifyResearchInputCopy as verifyScienceFlowInputCopy,
  type ResearchInputSnapshot as ScienceFlowInputSnapshot,
} from "./research-input-bundles.js";
export class RunnerScienceFlowInputBundles extends RunnerResearchInputBundles {
  constructor(dataDir: string) {
    super(dataDir, { protocol: scienceFlowInputBundleProtocol, maxManifestBytes: 64 * 1024,
      bundlesDirectory: ".scienceflow-input-bundles", stagingDirectory: ".scienceflow-input-bundle-staging" });
  }
}
