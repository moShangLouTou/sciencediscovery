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
 * The research pilot operator command.
 *
 * This is an internal, local entry — not an HTTP route and not the public
 * research-start feature. It opens a real `SessionStore` at an isolated data
 * directory, resolves the Session's effective model from it, and either runs
 * the whole chain (`launch`), only re-registers and re-reads a run an earlier
 * invocation already started (`attach`), or delivers an existing run's selected
 * result into the Session as normal artifacts (`deliver`).
 *
 *   node --import tsx services/api/src/scienceflow/research-pilot-cli.ts launch \
 *     --data-dir <isolated store> --project <id> --session <id> \
 *     --run-id <engine run id> --work-dir <pilot dir> \
 *     --private-root <0700 dir outside the work dir> \
 *     --engine <pinned checkout> --python <interpreter> \
 *     --reader-script <services/scienceflow-reader/snapshot.py> \
 *     --seed <seed dir> [--refuse-package-install] ...
 *
 * Nothing here accepts a provider endpoint, credential or model name: those come
 * only from the resolved SD Session. `deliver` accepts neither a score nor an
 * artifact digest: the reader resolves the selected stage and its bytes.
 */
import { resolve } from "node:path";

import { SessionStore } from "../store.js";
import {
  deliverScienceFlowResult,
  writeDeliveryRecord,
  type ScienceFlowResultDeliveryRecord,
} from "./result-delivery.js";
import {
  attachResearchPilotRun,
  runResearchPilot,
  type ResearchPilotOptions,
  type ResearchPilotReceipt,
} from "./research-pilot.js";

const USAGE = `usage: research-pilot-cli.ts <launch|attach|deliver> [options]

required:
  --data-dir <path>          isolated SessionStore data directory
  --project <id>             persisted Project id
  --session <id>             persisted Session id (must belong to the Project)
  --run-id <id>              ScienceFlow managed run id for this attempt
  --work-dir <path>          operator working directory for this run
  --python <path>            interpreter for the engine and the task evaluator
  --reader-script <path>     services/scienceflow-reader/snapshot.py

launch and attach also require:
  --private-root <path>      0700 directory outside the work dir for generated inputs
  --engine <path>            pinned ScienceFlow checkout
  --seed <path>              traced seed directory linked into the run's dataset

pilot limits (defaults are the round-20 standing allowance):
  --task <name>              engine task id (default circle-packing)
  --research-budget-sec <n>  default 840
  --report-budget-sec <n>    default 60
  --total-allowance-sec <n>  default 900
  --max-steps <n>            default 24
  --stage-capture-max <n>    default 3
  --bash-timeout-sec <n>     default 60
  --code-max-tokens <n>      default 8192
  --feedback-max-tokens <n>  default 4096
  --http-timeout-sec <n>     default 60
  --refuse-package-install   put pip/pip3/uv refusal shims on the run's PATH
  --receipt <path>           launch/attach receipt; default <work-dir>/receipt.json

deliver only:
  --record <path>            delivery record output; default <work-dir>/delivery.json
  --launch-receipt <path>    pilot receipt read for model/lifecycle facts;
                             default <work-dir>/receipt.json
  --plan-version <id>        the Session's Agent-authored plan artifact version
                             this run tested; linked to the note, never authored
  --incumbent-version <id>   the fixed incumbent artifact version the run was
                             seeded with; a stage is called the seed only when
                             its digest matches this version
  --attempts                 publish every captured stage separately, so a worse
                             new candidate stays visible beside the selected best

deliver publishes the existing run's selected stage as normal Session artifacts.
It starts no run, re-evaluates nothing and accepts no score or digest.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

type Command = "launch" | "attach" | "deliver";

function parseArgs(argv: readonly string[]): {
  readonly command: Command;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
} {
  const command = argv[0];
  if (command !== "launch" && command !== "attach" && command !== "deliver") {
    fail(USAGE);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) fail(`Unexpected argument: ${item}\n\n${USAGE}`);
    const name = item.slice(2);
    if (name === "refuse-package-install" || name === "attempts" || name === "help") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for --${name}`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("help")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const common = ["data-dir", "project", "session", "run-id", "work-dir", "python", "reader-script"];
  const required = command === "deliver"
    ? common
    : [...common, "private-root", "engine", "seed"];
  for (const name of required) {
    if (!values.get(name)) fail(`Missing required option --${name}\n\n${USAGE}`);
  }
  return { command, flags, values };
}

function pilotRequest(
  values: ReadonlyMap<string, string>,
  flags: ReadonlySet<string>,
): ResearchPilotOptions {
  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) fail(`--${name} must be a number`);
    return parsed;
  };
  return {
    runId: values.get("run-id")!,
    workDir: resolve(values.get("work-dir")!),
    privateRoot: resolve(values.get("private-root")!),
    engineCheckout: resolve(values.get("engine")!),
    pythonExecutable: resolve(values.get("python")!),
    readerScriptPath: resolve(values.get("reader-script")!),
    seedDir: resolve(values.get("seed")!),
    ...(values.get("task") ? { task: values.get("task")! } : {}),
    ...(number("research-budget-sec") !== undefined
      ? { researchBudgetSec: number("research-budget-sec")! }
      : {}),
    ...(number("report-budget-sec") !== undefined
      ? { reportBudgetSec: number("report-budget-sec")! }
      : {}),
    ...(number("total-allowance-sec") !== undefined
      ? { totalAllowanceSec: number("total-allowance-sec")! }
      : {}),
    ...(number("max-steps") !== undefined ? { maxSteps: number("max-steps")! } : {}),
    ...(number("stage-capture-max") !== undefined
      ? { stageCaptureMax: number("stage-capture-max")! }
      : {}),
    ...(number("bash-timeout-sec") !== undefined
      ? { bashTimeoutSec: number("bash-timeout-sec")! }
      : {}),
    ...(number("code-max-tokens") !== undefined
      ? { codeMaxTokens: number("code-max-tokens")! }
      : {}),
    ...(number("feedback-max-tokens") !== undefined
      ? { feedbackMaxTokens: number("feedback-max-tokens")! }
      : {}),
    ...(number("http-timeout-sec") !== undefined
      ? { httpTimeoutSec: number("http-timeout-sec")! }
      : {}),
    ...(flags.has("refuse-package-install") ? { refusePackageInstall: true } : {}),
    ...(values.get("receipt") ? { receiptPath: resolve(values.get("receipt")!) } : {}),
  };
}

/** A short, credential-free summary; the receipt file holds the full record. */
function summarize(receipt: ResearchPilotReceipt, receiptPath: string): Record<string, unknown> {
  return {
    receipt: receiptPath,
    outcome: receipt.outcome,
    identity: receipt.identity,
    model: receipt.model,
    engineRunId: receipt.engine.runId,
    engineStatus: receipt.launch?.status ?? null,
    registration: receipt.registration?.status ?? null,
    selected: receipt.result
      ? {
          stageId: receipt.result.selectedStageId,
          metric: receipt.result.selectedMetric,
          artifactSha256: receipt.result.selectedArtifactSha256,
          digestVerified: receipt.result.digestVerified,
          conclusion: receipt.result.conclusion,
          stages: receipt.result.stages.map((stage) => ({
            stageId: stage.stageId,
            parentStageId: stage.parentStageId,
            metricName: stage.metricName,
            metricValue: stage.metricValue,
            artifactSha256: stage.artifactSha256,
          })),
        }
      : null,
    usage: receipt.usage,
  };
}

/** A short delivery summary; the record file holds the full result. */
function summarizeDelivery(
  record: ScienceFlowResultDeliveryRecord,
  recordPath: string,
): Record<string, unknown> {
  return {
    record: recordPath,
    outcome: record.outcome,
    identity: record.identity,
    run: record.run,
    registration: record.registration,
    runState: record.runState,
    selected: record.selected
      ? {
          stageId: record.selected.stageId,
          metricName: record.selected.metricName,
          metricValue: record.selected.metricValue,
          artifactSha256: record.selected.artifactSha256,
          digestVerified: record.selected.digestVerified,
          bytes: record.selected.bytes,
        }
      : null,
    plan: record.plan
      ? {
          artifactId: record.plan.artifactId,
          versionId: record.plan.versionId,
          version: record.plan.version,
          title: record.plan.title,
          contentSha256: record.plan.content.hash,
        }
      : null,
    incumbent: record.incumbent
      ? {
          artifactId: record.incumbent.artifactId,
          versionId: record.incumbent.versionId,
          version: record.incumbent.version,
          contentSha256: record.incumbent.content.hash,
        }
      : null,
    attempts: record.attempts.map((attempt) => ({
      stageId: attempt.stageId,
      role: attempt.role,
      metricName: attempt.metricName,
      metricValue: attempt.metricValue,
      status: attempt.status,
      ...(attempt.reason ? { reason: attempt.reason } : {}),
      ...(attempt.artifact ? { artifactId: attempt.artifact.artifactId, versionId: attempt.artifact.versionId } : {}),
    })),
    artifacts: record.artifacts,
  };
}

async function main(): Promise<number> {
  const { command, flags, values } = parseArgs(process.argv.slice(2));
  // A retargeted flag that this command does not read must fail loudly, not
  // silently write (or read) the default path.
  if (command === "deliver") {
    for (const name of ["private-root", "engine", "seed", "receipt"]) {
      if (values.has(name)) {
        fail(`--${name} applies to launch and attach; deliver publishes an existing run`);
      }
    }
  } else if (values.has("record") || values.has("launch-receipt")
    || values.has("plan-version") || values.has("incumbent-version")) {
    fail("--record, --launch-receipt, --plan-version and --incumbent-version apply to deliver only");
  }
  if (command !== "deliver" && flags.has("attempts")) {
    fail("--attempts applies to deliver only");
  }
  const dataDir = resolve(values.get("data-dir")!);
  const store = new SessionStore(dataDir);
  await store.load();
  const identity = {
    projectId: values.get("project")!,
    sessionId: values.get("session")!,
  };
  if (command === "deliver") {
    const record = await deliverScienceFlowResult(store, {
      ...identity,
      runId: values.get("run-id")!,
      workDir: resolve(values.get("work-dir")!),
      pythonExecutable: resolve(values.get("python")!),
      readerScriptPath: resolve(values.get("reader-script")!),
      ...(values.get("task") ? { task: values.get("task")! } : {}),
      ...(values.get("plan-version") ? { planVersionId: values.get("plan-version")! } : {}),
      ...(values.get("incumbent-version") ? { incumbentVersionId: values.get("incumbent-version")! } : {}),
      ...(flags.has("attempts") ? { includeAttempts: true } : {}),
      ...(values.get("record") ? { recordPath: resolve(values.get("record")!) } : {}),
      ...(values.get("launch-receipt")
        ? { launchReceiptPath: resolve(values.get("launch-receipt")!) }
        : {}),
    });
    const recordPath = values.get("record")
      ? resolve(values.get("record")!)
      : resolve(values.get("work-dir")!, "delivery.json");
    await writeDeliveryRecord(recordPath, record);
    process.stdout.write(`${JSON.stringify(summarizeDelivery(record, recordPath), null, 2)}\n`);
    return record.outcome.status === "delivered" ? 0 : 1;
  }
  const options = pilotRequest(values, flags);
  const request = {
    ...identity,
    runId: options.runId,
    workDir: options.workDir,
    privateRoot: options.privateRoot,
    engineCheckout: options.engineCheckout,
    pythonExecutable: options.pythonExecutable,
    readerScriptPath: options.readerScriptPath,
    seedDir: options.seedDir,
    ...(options.task ? { task: options.task } : {}),
    ...(options.researchBudgetSec !== undefined ? { researchBudgetSec: options.researchBudgetSec } : {}),
    ...(options.reportBudgetSec !== undefined ? { reportBudgetSec: options.reportBudgetSec } : {}),
    ...(options.totalAllowanceSec !== undefined ? { totalAllowanceSec: options.totalAllowanceSec } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.stageCaptureMax !== undefined ? { stageCaptureMax: options.stageCaptureMax } : {}),
    ...(options.bashTimeoutSec !== undefined ? { bashTimeoutSec: options.bashTimeoutSec } : {}),
    ...(options.codeMaxTokens !== undefined ? { codeMaxTokens: options.codeMaxTokens } : {}),
    ...(options.feedbackMaxTokens !== undefined ? { feedbackMaxTokens: options.feedbackMaxTokens } : {}),
    ...(options.httpTimeoutSec !== undefined ? { httpTimeoutSec: options.httpTimeoutSec } : {}),
    ...(options.refusePackageInstall ? { refusePackageInstall: true } : {}),
    ...(options.receiptPath ? { receiptPath: options.receiptPath } : {}),
  };
  const receipt =
    command === "launch"
      ? await runResearchPilot(store, request)
      : await attachResearchPilotRun(store, request);
  const receiptPath = options.receiptPath ?? resolve(options.workDir, "receipt.json");
  process.stdout.write(`${JSON.stringify(summarize(receipt, receiptPath), null, 2)}\n`);
  return receipt.outcome.status === "completed" ? 0 : 1;
}

process.exitCode = await main();
