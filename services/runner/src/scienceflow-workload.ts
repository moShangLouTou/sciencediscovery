// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Trusted SF bridge registration over the shared Runner execution machinery. */
import { mkdir, lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { checkEngineRevision } from "@sciencediscovery/scienceflow-reader";
import {
  createResearchRunExecutor,
  ResearchRunError,
  type ResearchRunWiring,
  type ResearchRunExecutor,
  type ResearchWorkloadAdapter,
} from "./research-run.js";
import {
  ENGINE_CONTRACT_REFUSAL_FILE, ENGINE_REFUSAL_MAX_BYTES,
  parseScienceFlowEngineLink, parseScienceFlowEngineRefusal, researchEngineStateRoot,
  SCIENCEFLOW_ENGINE_BRIDGE_SOURCE, SCIENCEFLOW_ENGINE_MOUNT, SCIENCEFLOW_ENGINE_STATE_MOUNT,
} from "./scienceflow-engine-bridge.js";
import { verifyScienceFlowSourceBinding } from "./scienceflow-runtime-check.js";
import type { ScienceFlowRuntimeBindings } from "./scienceflow-runtime-config.js";

export interface ScienceFlowEngineBinding {
  readonly sourceRoot: string;
  readonly revision: string;
  readonly version: string;
  readonly runtimeBindingId?: string;
  /** Test-only research step; never supplied through a request or public config. */
  readonly researchStepModule?: string;
}
export interface ScienceFlowResearchRunWiring extends Omit<ResearchRunWiring, "workload" | "workloadId"> {
  readonly engine?: ScienceFlowEngineBinding;
  readonly runtimeBindings?: ScienceFlowRuntimeBindings;
}

export function createScienceFlowWorkload(
  engine: ScienceFlowEngineBinding,
  runtimeBindings?: ScienceFlowRuntimeBindings,
): ResearchWorkloadAdapter {
  if (!engine.sourceRoot.startsWith("/") || engine.sourceRoot.split("/").includes("..")
    || !/^[0-9a-f]{40}$/.test(engine.revision) || !engine.version.trim()
    || (engine.runtimeBindingId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(engine.runtimeBindingId))
    || (engine.researchStepModule !== undefined && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(engine.researchStepModule))) {
    throw new ResearchRunError("RESEARCH_ENGINE_NOT_CONFIGURED");
  }
  return {
    id: "scienceflow-fixed",
    program: SCIENCEFLOW_ENGINE_BRIDGE_SOURCE,
    requiresEngineEvidence: true,
    parseEngineLink: (text, executionId) => parseScienceFlowEngineLink(text, executionId, engine),
    async prepare({ config, request, environment, environmentStore, procRoot, diagnose }) {
      if (environment !== undefined) {
        const binding = engine.runtimeBindingId === undefined ? undefined : runtimeBindings?.bindingFor(engine.runtimeBindingId);
        if (!binding || binding.sourceRoot !== engine.sourceRoot || binding.expectedRevision !== engine.revision) {
          diagnose("research_engine_source_binding_missing");
          throw new ResearchRunError(engine.runtimeBindingId === undefined ? "RESEARCH_ENGINE_NOT_CONFIGURED" : "RESEARCH_ENGINE_UNAVAILABLE");
        }
        const verdict = await verifyScienceFlowSourceBinding({ binding, config, environment, procRoot });
        if (verdict.status !== "verified") {
          diagnose("research_engine_source_binding_refused", { reason: verdict.reason ?? verdict.status });
          if (verdict.boundary !== undefined && request.environmentId !== undefined) {
            try { environmentStore?.reserveRuntimeCheck?.(request.environmentId, verdict.boundary); }
            catch { diagnose("research_engine_binding_fence_failed"); }
          }
          throw new ResearchRunError("RESEARCH_ENGINE_UNAVAILABLE");
        }
      }
      const check = await checkEngineRevision({ path: engine.sourceRoot, expectedRevision: engine.revision }).catch(() => undefined);
      if (check?.status !== "verified-clean") throw new ResearchRunError("RESEARCH_ENGINE_UNAVAILABLE");
      const root = researchEngineStateRoot(config.dataDir, request.executionId);
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw new Error("unsafe state root");
      } catch { throw new ResearchRunError("RESEARCH_STATE_ROOT_UNSAFE"); }
      return {
        bindArgs: ["--ro-bind", engine.sourceRoot, SCIENCEFLOW_ENGINE_MOUNT, "--bind", root, SCIENCEFLOW_ENGINE_STATE_MOUNT],
        writableHostRoots: [root],
        arguments: [SCIENCEFLOW_ENGINE_MOUNT, SCIENCEFLOW_ENGINE_STATE_MOUNT, engine.revision, engine.version,
          JSON.stringify({ reportBudgetMs: request.schedule.reportBudgetMs, researchBudgetMs: request.schedule.researchBudgetMs }),
          ...(engine.researchStepModule === undefined ? [] : [engine.researchStepModule])],
        async readContractRefusal() {
          const path = resolve(root, ENGINE_CONTRACT_REFUSAL_FILE);
          const info = await stat(path).catch(() => undefined);
          if (!info?.isFile() || info.size > ENGINE_REFUSAL_MAX_BYTES) return null;
          const text = await readFile(path, "utf8").catch(() => undefined);
          return text === undefined ? null : parseScienceFlowEngineRefusal(text, request.executionId);
        },
      };
    },
  };
}

/** Compatibility constructor; all execution policy stays in the shared service. */
export function createScienceFlowResearchRunExecutor(wiring: ScienceFlowResearchRunWiring): ResearchRunExecutor {
  if (wiring.program !== undefined && wiring.engine !== undefined) throw new ResearchRunError("RESEARCH_ENGINE_NOT_CONFIGURED");
  const { engine, runtimeBindings, ...common } = wiring;
  if (engine === undefined) return createResearchRunExecutor({ ...common, workloadId: "scienceflow-fixed" });
  return createResearchRunExecutor({ ...common, workload: createScienceFlowWorkload(engine, runtimeBindings) });
}
