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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchOperationWriter } from "../research/engine-adapter.js";
import type { ResearchPreparationStep } from "../research/engine-service.js";
import type { ScienceFlowLocalResearchOperation } from "./local-research-record.js";
import type { ScienceFlowLocalResearchSettings } from "./local-research-config.js";
import type { LocalResearchServiceStore } from "./local-research.js";
import { materializePreparedTaskAssets } from "./local-research-task-service.js";
import { InputPreparationRefusal, sha256, stageResearchOperationInputs, type StagedDataSelection, type StagedInputSelection } from "./local-research-inputs.js";
import { resolveResearchPilotModel, ResearchPilotRefusal } from "./research-pilot.js";
export function scienceFlowPreparationSteps(input: {
  readonly settings: ScienceFlowLocalResearchSettings;
  readonly store: LocalResearchServiceStore;
  readonly readArtifactBytes: (hash: string) => Promise<Buffer>;
  readonly now: () => string;
}): readonly ResearchPreparationStep<ScienceFlowLocalResearchOperation>[] {
  const { settings, store, readArtifactBytes, now } = input;
  /**
   * Stage this operation's own input directory, if the profile uses dynamic
   * inputs. The staged bytes are proven equal to the digests frozen at start.
   */
  const stageInputs = async (
    record: ScienceFlowLocalResearchOperation,
    signal: AbortSignal,
    writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
  ): Promise<ScienceFlowLocalResearchOperation> => {
    const roles: StagedInputSelection[] = (record.inputs ?? []).flatMap((stagedInput) =>
      stagedInput.stagedName !== undefined && stagedInput.versionId !== null
        ? [{
            role: stagedInput.role,
            sha256: stagedInput.sha256,
            size: stagedInput.size,
            stagedName: stagedInput.stagedName,
            versionId: stagedInput.versionId,
          }]
        : []);
    // A selected or prepared task may bind ordinary Session data files; they are
    // staged beside the plan and incumbent so the engine's dataset holds exactly
    // the bytes this operation froze.
    const data: StagedDataSelection[] = (record.taskBinding?.inputs ?? []).map((binding) => ({
      logicalName: binding.logicalName,
      sha256: binding.sha256,
      size: binding.size,
      versionId: binding.versionId,
    }));
    const destination = join(record.workDir, "input");
    const manifestPath = join(record.workDir, "input-manifest.json");
      if (roles.length === 0 && data.length === 0) {
        throw new InputPreparationRefusal("staging-failed", "This operation has no accepted input to stage");
      }
      // The operation's own work dir may not exist yet; the input directory
      // itself is created non-recursively so a second staging attempt (or
      // another operation's leftovers) is a conflict, not a silent overwrite.
      await mkdir(record.workDir, { recursive: true, mode: 0o755 });
      const staged = await stageResearchOperationInputs({
        assetsDir: settings.seedDir,
        destination,
        readBytes: readArtifactBytes,
        roles,
        ...(data.length ? { data } : {}),
        signal,
      }, now);
      await writeFile(manifestPath, staged.manifestJson, "utf8");
      // Re-read the manifest so the recorded digest is the digest on disk.
      const written = await readFile(manifestPath);
      if (sha256(written) !== staged.manifestSha256) {
        throw new InputPreparationRefusal("staging-failed", "The input manifest did not retain its bytes");
      }
      return writer.mutate(record.operationId, (current) => ({
        ...current,
        stagedInputs: {
          dataDir: destination,
          entries: staged.manifest.assets.entries,
          manifestPath,
          manifestSha256: staged.manifestSha256,
          stagedAt: staged.manifest.stagedAt,
          totalBytes: staged.manifest.assets.totalBytes,
        },
      }));

  };

  /**
   * Freeze a prepared task's evaluator and contract into this operation's own
   * directory. The contract body is re-read and its digest must equal the one
   * frozen at start, so a task version edited after acceptance cannot change
   * what this run executes.
   */
  const stageTaskAssets = async (
    record: ScienceFlowLocalResearchOperation,
    writer: ResearchOperationWriter<ScienceFlowLocalResearchOperation>,
  ): Promise<ScienceFlowLocalResearchOperation> => {
    const binding = record.taskBinding;
    if (!binding || binding.source !== "prepared") return record;
    if (binding.assetDir !== undefined) return record;
    if (binding.taskVersionId === undefined || binding.contractHash === undefined) {
      throw new Error("The prepared task version is incomplete");
    }
      const assets = await materializePreparedTaskAssets(store, { readBytes: readArtifactBytes }, {
        contractHash: binding.contractHash,
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
        targetDir: join(record.workDir, "task"),
        taskVersionId: binding.taskVersionId,
      });
      return writer.mutate(record.operationId, (current) => ({
        ...current,
        taskBinding: {
          ...binding,
          assetDir: join(record.workDir, "task"),
          assetManifestSha256: assets.manifestSha256,
        },
      }));

  };

  /** The model the Session resolves to must still be the one this start froze. */
  const frozenModelRefusal = (record: ScienceFlowLocalResearchOperation): string | undefined => {
    const frozen = record.launch.model;
    if (!frozen) return undefined;
    let resolved;
    try {
      resolved = resolveResearchPilotModel(store, {
        projectId: record.identity.projectId,
        sessionId: record.identity.sessionId,
      });
    } catch (error) {
      return error instanceof ResearchPilotRefusal ? error.message : errorMessage(error);
    }
    const mismatch = resolved.selection.providerModel !== frozen.providerModel
      || resolved.selection.selectionSource !== frozen.selectionSource
      || resolved.selection.profileName !== frozen.profileName;
    return mismatch
      ? "The Session's effective model changed after this operation was accepted; it was not launched"
      : undefined;
  };

  if (settings.inputMode !== "dynamic") return [];
  return [
    { name: "staging", run: stageInputs, message: (error) => error instanceof InputPreparationRefusal
      ? `${error.reason}: ${error.message}` : errorMessage(error) },
    { name: "model-selection", async run(record) {
      const refusal = frozenModelRefusal(record);
      if (refusal !== undefined) throw new Error(refusal);
      return record;
    }, message: (error) => error instanceof Error ? error.message : errorMessage(error) },
    { name: "task", run: (record, _signal, writer) => stageTaskAssets(record, writer) },
  ];
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
}
