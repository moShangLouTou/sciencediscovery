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

import type { ScienceFlowTaskBinding } from "../local-research-task.js";
import type { ScienceFlowLocalResearchOperation } from "../local-research-record.js";
/** A delivered candidate continues only a scientifically equivalent contract. */
export function compatibleTaskContracts(source: ScienceFlowTaskBinding, target: ScienceFlowTaskBinding): boolean {
  if (source.source !== target.source || source.taskId !== target.taskId) return false;
  if (source.artifactPath !== target.artifactPath || source.artifactKind !== target.artifactKind) return false;
  if (source.metricName !== target.metricName || source.lowerIsBetter !== target.lowerIsBetter) return false;
  if (source.source === "prepared" && source.contractHash !== target.contractHash) return false;
  const left = source.evaluator;
  const right = target.evaluator;
  if (left.kind !== right.kind) return false;
  if (left.kind === "generated-command" && right.kind === "generated-command" && left.sha256 !== right.sha256) {
    return false;
  }
  if (left.kind === "task-package" && right.kind === "task-package") {
    if (left.entrypoint !== right.entrypoint) return false;
    // When both sides carry the actual package identity, it must agree. An
    // older record without hashes is left readable but never treated as proof
    // that the evaluated bytes were the same.
    if (left.entrypointSha256 !== undefined && right.entrypointSha256 !== undefined
      && left.entrypointSha256 !== right.entrypointSha256) return false;
    if (left.packageSha256 !== undefined && right.packageSha256 !== undefined
      && left.packageSha256 !== right.packageSha256) return false;
  }
  return source.inputs.length === target.inputs.length && source.inputs.every((binding, index) => {
    const other = target.inputs[index];
    return other !== undefined && binding.logicalName === other.logicalName && binding.sha256 === other.sha256;
  });
}


export function assertScienceFlowContinuation(input: {
  readonly binding: ScienceFlowTaskBinding;
  readonly versionId: string;
  readonly sourceRunId?: string;
  readonly hasDeliveryProvenance: boolean;
  readonly operations: readonly ScienceFlowLocalResearchOperation[];
}): "continuation-provenance-unknown" | "continuation-task-mismatch" | undefined {
  let source = input.operations.find((operation) => [operation.delivery.solution, ...(operation.delivery.staged ?? [])]
    .some((ref) => ref?.versionId === input.versionId));
  if (!source) {
    if (!input.hasDeliveryProvenance) return undefined;
    source = input.operations.find((operation) => operation.engineRunId === input.sourceRunId);
    if (!source) return "continuation-provenance-unknown";
  }
  const compatible = source.taskBinding === undefined ? source.task === input.binding.taskId
    : compatibleTaskContracts(source.taskBinding, input.binding);
  return compatible ? undefined : "continuation-task-mismatch";
}
