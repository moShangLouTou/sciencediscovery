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
 * The lead Agent's surface for the experimental local research mode.
 *
 * These are ordinary tools in the production assembly: they appear when an
 * administrator enabled the mode, and they call the same service the rest of the
 * server uses. They carry business identities only — a research intent and the
 * fixed Artifact version ids this experiment tests. Paths, interpreter, model,
 * endpoint, credential and the pinned task text never come from the model.
 *
 * `get_research` may wait for a bounded time; the wait is announced as an
 * external wait so a long experiment does not trip the Agent's idle handling.
 * The start call returns an operation identity at once and never holds a request
 * open for the whole run.
 */
import { Type } from "typebox";
import type { AgentTool } from "@sciencediscovery/tools";

import {
  LocalResearchRefusal,
  type LocalResearchService,
  type ScienceFlowLocalResearchView,
} from "./local-research.js";
import { TaskPreparationRefusal } from "./local-research-task.js";
import { RESEARCH_PLAN_MAX_BYTES } from "./research-plan-publication.js";

export const START_RESEARCH_TOOL = "start_research";
export const GET_RESEARCH_TOOL = "get_research";
export const STOP_RESEARCH_TOOL = "stop_research";
export const PUBLISH_RESEARCH_PLAN_TOOL = "publish_research_plan";
export const LIST_RESEARCH_TASKS_TOOL = "list_research_tasks";
export const PREPARE_RESEARCH_TASK_TOOL = "prepare_research_task";
export const GET_RESEARCH_RESULTS_TOOL = "get_research_results";
export const SELECT_RESEARCH_RESULT_TOOL = "select_research_result";
export const CHECK_EVOLVE_PILOT_TOOL = "check_evolve_pilot";

export const LOCAL_RESEARCH_TOOL_NAMES = [START_RESEARCH_TOOL, GET_RESEARCH_TOOL, STOP_RESEARCH_TOOL] as const;

/** A short intent label; the text is recorded, never executed. */
const INTENT_MAX_CHARACTERS = 2_000;
/** One bounded observation wait; the service caps it again. */
const WAIT_SECONDS_MAX = 300;
/** One prepared evaluator script is code, bounded like other bounded text. */
const EVALUATOR_SOURCE_MAX_BYTES = 128 * 1024;
/** A probe sample is a small artifact, not a dataset. */
const SAMPLE_MAX_BYTES = 1024 * 1024;

const startParameters = Type.Object({
  intent: Type.String({
    description: "One or two sentences naming the bounded experiment to run and what its result should answer. In dynamic mode this text is also carried into the researcher's instruction.",
    maxLength: INTENT_MAX_CHARACTERS,
    minLength: 1,
  }),
  plan_version_id: Type.Optional(Type.String({
    description: "Dynamic mode: required. The Session Artifact version holding the plan the researcher must carry out; its exact bytes are staged for this run. A version from another Session or with unreadable content is refused before launch. Business id only.",
    maxLength: 200,
    minLength: 1,
  })),
  incumbent_version_id: Type.Optional(Type.String({
    description: "Dynamic mode: the current-Session candidate version to continue from. Omit on a first run when the profile allows starting from scratch; required for profiles with a mandatory incumbent. Its exact bytes become the researcher's fixed start. Business id only.",
    maxLength: 200,
    minLength: 1,
  })),
  task_package_id: Type.Optional(Type.String({
    description: "Task-dynamic mode: the engine task package to run, exactly as list_research_tasks returned it. Pass either this or task_version_id, never both.",
    maxLength: 64,
    minLength: 1,
  })),
  task_version_id: Type.Optional(Type.String({
    description: "Task-dynamic mode: the task contract version prepare_research_task published. It carries the objective, evaluator, bound inputs and metric. Pass either this or task_package_id, never both.",
    maxLength: 200,
    minLength: 1,
  })),
  input_version_ids: Type.Optional(Type.Array(Type.String({
    description: "Task-dynamic catalog runs only: this Session's data artifact versions bound as the task's read-only input. A prepared task already carries its own bound inputs.",
    maxLength: 200,
    minLength: 1,
  }), { maxItems: 16 })),
  proposal: Type.Optional(Type.Object({
    research_question: Type.String({ maxLength: 2_000, minLength: 1 }),
    evidence: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("artifact-version"), Type.Literal("operation-result")]),
      fact: Type.String({ maxLength: 1_000, minLength: 1 }),
      operation_id: Type.Optional(Type.String({ maxLength: 200, minLength: 1 })),
      version_id: Type.Optional(Type.String({ maxLength: 200, minLength: 1 })),
    }, { additionalProperties: false }), { maxItems: 16, minItems: 1 }),
    method_change: Type.String({ maxLength: 2_000, minLength: 1 }),
    expected_observation: Type.String({ maxLength: 2_000, minLength: 1 }),
    evaluation_method: Type.String({ maxLength: 1_000, minLength: 1 }),
    stop_condition: Type.String({ maxLength: 1_000, minLength: 1 }),
    sub_budget_seconds: Type.Optional(Type.Integer({ maximum: 1_800, minimum: 60 })),
    repeat: Type.Optional(Type.Object({
      kind: Type.Literal("randomized-repeat"),
      purpose: Type.String({ maxLength: 500, minLength: 1 }),
      randomness: Type.String({ maxLength: 500, minLength: 1 }),
      repetitions: Type.Integer({ maximum: 10, minimum: 2 }),
    }, { additionalProperties: false })),
  }, {
    additionalProperties: false,
    description: "The structured experiment proposal. Required for every continuation round: research question, real evidence references, concrete method change, expected observation, fixed evaluation method, stop condition and sub-budget. A repeat of the same method on the same candidate needs a declared randomized repeat.",
  })),
}, { additionalProperties: false });

const listTasksParameters = Type.Object({}, { additionalProperties: false });

const prepareTaskParameters = Type.Object({
  objective: Type.String({
    description: "The complete, self-contained scientific objective and computational task specification the researcher must carry out. State the problem, the decision variables, every validity/domain constraint, the required artifact format and any bound input files. Do not restate operational knobs.",
    maxLength: 16_384,
    minLength: 1,
  }),
  title: Type.String({
    description: "A short task title (one line).",
    maxLength: 200,
    minLength: 1,
  }),
  slug: Type.Optional(Type.String({
    description: "Optional short kebab-case stem for the task id; a stable digest is always appended.",
    maxLength: 40,
    minLength: 1,
  })),
  metric_name: Type.String({
    description: "The exact metric name the evaluator reports, e.g. rmse or radii_sum.",
    maxLength: 100,
    minLength: 1,
  }),
  metric_direction: Type.Union([Type.Literal("minimize"), Type.Literal("maximize")], {
    description: "Whether the engine must select a smaller or larger metric.",
  }),
  artifact_path: Type.String({
    description: 'The candidate artifact path relative to the worker workspace, e.g. "artifacts/solution.json". It must match what your evaluator expects and what the objective asks the researcher to write.',
    maxLength: 200,
    minLength: 1,
  }),
  artifact_kind: Type.Optional(Type.String({
    description: 'A short artifact kind label, e.g. "json_solution".',
    maxLength: 60,
    minLength: 1,
  })),
  metric_json_path: Type.Optional(Type.String({
    description: 'JSON path into the evaluator\'s stdout object that holds the finite metric. Defaults to "metric" (stdout {"metric": <number>}). Dotted paths and numeric list indices are supported, and the same path is used by the probe and by the execution manifest.',
    maxLength: 100,
    minLength: 1,
  })),
  evaluator_source: Type.String({
    description: "A complete Python evaluator script. It receives the candidate artifact's absolute path as argv[1], reads any bound inputs from dataset/<file> relative to its working directory, prints exactly one JSON object on stdout such as {\"metric\": 0.42}, and exits nonzero for a missing, malformed or domain-violating artifact. It must be deterministic and must not download, train or install anything.",
    maxLength: EVALUATOR_SOURCE_MAX_BYTES,
    minLength: 1,
  }),
  valid_sample: Type.Object({
    content: Type.String({ maxLength: SAMPLE_MAX_BYTES, minLength: 1 }),
    name: Type.String({ maxLength: 120, minLength: 1 }),
  }, { additionalProperties: false, description: "A small valid artifact for the evaluator probe. It must satisfy the task's domain constraints, not merely have valid JSON syntax." }),
  invalid_sample: Type.Object({
    content: Type.String({ maxLength: SAMPLE_MAX_BYTES, minLength: 1 }),
    name: Type.String({ maxLength: 120, minLength: 1 }),
  }, { additionalProperties: false, description: "A small artifact the evaluator must reject because it violates a domain constraint." }),
  input_version_ids: Type.Optional(Type.Array(Type.Object({
    file_name: Type.Optional(Type.String({ maxLength: 120, minLength: 1 })),
    version_id: Type.String({ maxLength: 200, minLength: 1 }),
  }, { additionalProperties: false }), {
    description: "Ordinary Session artifact versions (for example an attached CSV/JSON) the task reads from dataset/<file>. Bound into the contract; later versions do not change this task.",
    maxItems: 16,
  })),
}, { additionalProperties: false });

const publishPlanParameters = Type.Object({
  content: Type.String({
    description: "The plan text itself, in Markdown. State the question, the concrete method change this run makes, the starting solution, the budget and the acceptance rule, using the evidence actually read.",
    maxLength: RESEARCH_PLAN_MAX_BYTES,
    minLength: 1,
  }),
  name: Type.Optional(Type.String({
    description: 'Logical artifact name ending in ".md". Defaults to "research-plan.md".',
    maxLength: 200,
    minLength: 1,
  })),
  title: Type.Optional(Type.String({ maxLength: 200, minLength: 1 })),
  description: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
  artifact_id: Type.Optional(Type.String({
    description: "Revise an existing plan: its artifact id. Requires base_version_id.",
    maxLength: 200,
    minLength: 1,
  })),
  base_version_id: Type.Optional(Type.String({
    description: "The plan version this revision is written against. A stale base is refused; read the plan again before revising.",
    maxLength: 200,
    minLength: 1,
  })),
}, { additionalProperties: false });

const getParameters = Type.Object({
  operation_id: Type.Optional(Type.String({
    description: "The operation id start_research returned. Omitted means the latest operation of this Session.",
    maxLength: 200,
    minLength: 1,
  })),
  wait_seconds: Type.Optional(Type.Integer({
    description: "Wait this many seconds for the run to end before returning its current state. 0 returns at once.",
    maximum: WAIT_SECONDS_MAX,
    minimum: 0,
  })),
  action: Type.Optional(Type.Union([
    Type.Literal("status"),
    Type.Literal("retry_delivery"),
  ], { description: "status observes the run; retry_delivery republishes an ended run's artifacts without rerunning research." })),
}, { additionalProperties: false });

const stopParameters = Type.Object({
  operation_id: Type.Optional(Type.String({
    description: "The operation id to stop. Omitted means the latest operation of this Session.",
    maxLength: 200,
    minLength: 1,
  })),
}, { additionalProperties: false });

const resultsParameters = Type.Object({}, { additionalProperties: false });

const selectParameters = Type.Object({
  operation_id: Type.String({
    description: "The delivered result this Session will use as the next run's starting point. It may deliberately be a non-optimal result, but it must be valid.",
    maxLength: 200,
    minLength: 1,
  }),
  reason: Type.String({
    description: "Why this exact result is the right starting point. A non-optimal choice must say what evidence motivates it.",
    maxLength: 1_000,
    minLength: 1,
  }),
}, { additionalProperties: false });

const checkEvolveParameters = Type.Object({
  operation_id: Type.String({
    description: "The delivered SF operation whose task and candidate should enter the CPU Evolve pilot check.",
    maxLength: 200,
    minLength: 1,
  }),
  expansions: Type.Optional(Type.Integer({ maximum: 32, minimum: 4 })),
  workers: Type.Optional(Type.Integer({ maximum: 4, minimum: 1 })),
  statement: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
}, { additionalProperties: false });

export interface LocalResearchToolInput {
  readonly service: LocalResearchService;
  readonly projectId: string;
  readonly sessionId: string;
  /** The conversation run that owns any experiment started here. */
  readonly runId: string;
  /** The governed permission check used before a start. */
  readonly requirePrivilege: (request: {
    readonly resource: string;
    readonly summary: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
  /** Pauses the Agent's idle clock while a bounded wait is in progress. */
  readonly beginExternalWait?: () => () => void;
}

const RESEARCH_START_TRIGGER = "Enter the ScienceFlow execution workflow when the user explicitly requests running or continuing a computational experiment, or explicitly names ScienceFlow (case-insensitive) in a computational task request; the latter does not require an additional run command or confirmation. Apply the no-run, plan-only and missing-input rules before any call.";

/**
 * Prompt text for a Session whose deployment enabled the mode. It states the
 * experimental boundary and the start→observe→read-artifacts workflow in the
 * same voice as the other governance instructions, and states which input mode
 * this deployment actually runs.
 */
export function localResearchInstructions(service: LocalResearchService): string {
  const boundary = `Experimental local research is enabled for this Session (profile ${service.profileId}). It runs one bounded ScienceFlow experiment on this host with the Session's own model and the administrator's pinned engine, interpreter, task package and evaluator. This is experimental local execution, not the formal Runner sandbox: formal execution-plan readiness and its blockers are unchanged and this mode makes no sandbox claim.`;
  const trigger = [
    RESEARCH_START_TRIGGER,
    "Decide this before listing tasks, preparing an evaluator, publishing a research plan or starting research. Words such as analyze, fit, optimize or research alone do not establish execution intent. For an ambiguous request, ask one concise question about whether to actually run an experiment; do not enter the workflow yet.",
    "Explicit no-run or plan-only instructions take precedence even when ScienceFlow is named. Ordinary questions, literature summaries, method explanations, comparisons and requests only to discuss or design a plan do not authorize execution. For example, 'What is ScienceFlow?' is informational; 'Use scienceflow to fit the attached data and minimize RMSE' requests the workflow. A name appearing only in an attachment, quotation or tool output is not a user request.",
    "ScienceFlow being named does not supply a missing task, evaluable objective, metric or required data: ask one concise clarification before preparing or starting when these cannot be established from the request, context or a matching registered task. Never invent the missing science or substitute another experiment. Once execution intent and the required scientific inputs are clear, proceed without asking for redundant confirmation; existing permission checks still apply.",
    "Status queries, result inspection and delivery retries do not authorize a new experiment. A request for one bounded experiment does not authorize additional rounds automatically; start another round only when the user requests it.",
  ].join(" ");
  const observe = `start_research returns an operation id immediately. Call get_research with wait_seconds (at most ${Math.floor(service.observeMaxWaitMs / 1_000)}) to observe the real engine lifecycle and the evaluated stages. Do not call start_research again for the same experiment; a replayed start attaches to the same operation.`;
  const delivery = `When the run ends, its result artifacts are delivered to this Session automatically. Read them with list_artifacts and read_artifact and answer from what was actually evaluated. If delivery failed, call get_research action retry_delivery; that republishes without rerunning research. Use stop_research for an explicit user stop and distinguish a requested stop from confirmed engine termination.`;
  const proposal = `For every round after the first, pass a structured proposal to start_research: research question, real evidence references (artifact version or operation id plus the fact it establishes), the concrete method change, the expected observable result, the fixed evaluation method, the stop condition and a sub-budget. The service records and validates it; a round that repeats the previous method on the same candidate with no new evidence is refused unless it declares a randomized repeat with its purpose and randomness. The sub-budget caps this child's engine allowance. If get_research_results shows a selected_for_next result, omit incumbent_version_id to follow it (the exact selected version becomes the incumbent) or pass exactly that version; a different candidate is refused until the selection is changed. The main Agent may continue, change method, ask one clarification or end within the user's existing research request. This reuses the Session's existing governed code-execution grant and adds no per-round authorization step.`;
  const comparison = `After a run ends, call ${GET_RESEARCH_RESULTS_TOOL} before deciding what to do next. It groups results by the exact frozen scientific contract and reports latest, best_valid and selected_for_next separately. Only results in the same group are comparable: a different task version, task package, evaluator, engine revision, metric direction or bound data is a different experiment and must not be ranked against this one. Continue from best_valid unless you deliberately call ${SELECT_RESEARCH_RESULT_TOOL} for another valid result and state the evidence-based reason; the best valid result remains retrievable either way. The recorded value is the engine's captured-stage validation metric, not an independent final evaluation; do not call a small difference a significant improvement.`;
  const line = service.parentBudget === null
    ? `This deployment runs one child at a time per frozen contract. It records each run's wall clock and token use, but no total token hard cap is enforced or promised.`
    : `This deployment runs one child at a time per frozen contract, and the line has an enforceable budget of ${service.parentBudget.maxChildRuns} child runs and ${service.parentBudget.totalAllowanceSec}s total wall clock. start_research refuses before creating a run when the run count, deadline or reserved allowance would be exceeded. A launched run whose wall clock cannot be observed is charged its reservation and reported unknown; token use is recorded but no total token hard cap is promised. A stop recorded in this conversation prevents a further start in the same conversation run.`;
  const honesty = `Do not claim success, a score or a scientific conclusion that the delivered evidence does not support.`;
  if (service.taskMode === "task-dynamic") {
    const incumbent = service.incumbentMode === "optional"
      ? "This profile allows starting from scratch: omit incumbent_version_id if no candidate exists. Do not ask the user to upload or create a seed. Once an evaluated candidate is delivered, pass its incumbent_version_id to continue from its exact bytes."
      : service.incumbentMode === "none"
        ? "This profile stages only a plan: omit incumbent_version_id. The researcher creates the first candidate from scratch."
        : "This profile requires incumbent_version_id naming the current Session's starting candidate.";
    return [
      `<local_research_mode>`,
      boundary,
      trigger,
      `This deployment allows the research task to be chosen from the conversation. The administrator still owns the engine, interpreter, private roots and operational defaults; you own only the scientific contract. Do not supply host paths, an interpreter, model, endpoint, credential or launch commands.`,
      `Task intake: first call list_research_tasks. If a registered package matches the user's objective, pass its id as task_package_id to start_research and use that package's evaluator and metric unchanged; never silently replace an official scoring contract. If no package matches a sufficiently specified CPU computational task, call prepare_research_task with the complete objective, the artifact path, the metric name and direction, a Python evaluator that prints one JSON object with the finite metric and exits nonzero for invalid artifacts, a valid sample and a domain-violating invalid sample. If the metric is not the top-level "metric" field, pass metric_json_path matching the evaluator's output; the same path drives both the probe and the run. The probe runs through the engine's real evaluator backend, and only an accepted probe publishes a task version; then pass its task version id as task_version_id. A generated evaluator is exploratory, not an authoritative benchmark.`,
      `If the request lacks a scientific fact, the evaluable objective, the metric or usable data, ask one concise clarification and do not prepare a task or start a run. Do not invent a metric, do not substitute another task and never fall back to a different experiment.`,
      `A probe sample is a small artifact that satisfies or violates the task's domain constraints; it does not need to be optimal or computed from the data. Do not call shell, subagents or other tools to derive sample values. If workspace code execution is denied or unavailable, that does not block task preparation: the prepare tool runs the evaluator probe itself.`,
      `Input data: ordinary attached data is already a Session artifact. Pass its artifact version id in input_version_ids for a registered task, or bind it with input_version_ids in prepare_research_task so the contract carries it. Get version ids with list_artifacts and read_artifact. If a named file is missing or unusable, say which input is missing instead of fabricating one.`,
      `This deployment runs dynamic inputs: you author the plan as ordinary research text. Call publish_research_plan with the plan body to publish it as a Session Artifact version, then call start_research with that exact plan_version_id. ${incumbent} The selected versions' exact bytes are staged for the run, and no later version or edit changes what a started run reads.`,
      `The research intent you pass to start_research becomes part of the researcher's instruction together with the frozen task contract, the staged plan path and this run's version identities. Write the intent as the concrete research direction of this run.`,
      observe,
      delivery,
      comparison,
      line,
      proposal,
      `A CPU Evolve candidate analysis is available for a prepared task with a JSON object artifact and exactly one CSV input, but its execution is unsupported: the current sandbox and sidecar cannot preserve the candidate/evaluator permission boundary or re-score a winner on the full task data. Call ${CHECK_EVOLVE_PILOT_TOOL} to get the exact shape and architecture gaps. It never starts a search. Do not present an Evolve score as comparable to SF results.`,
      service.incumbentMode === "none"
        ? `To run again, read the delivered feedback and publish a revised plan. This profile does not stage a prior candidate; do not claim candidate continuation.`
        : `To continue research, read the delivered result note, the evaluated attempt artifacts and the researcher's records, interpret what the run actually did, then publish a revised plan and start a second run whose incumbent_version_id is a real evaluated candidate version delivered by the earlier run and whose task is the same frozen contract. A candidate delivered under a different or re-prepared task contract is refused. Do not relabel a run as a continuation or reuse the seed while claiming a new candidate. A scientific-contract change is a new task version and a new experiment, not a continuation.`,
      honesty,
      `</local_research_mode>`,
    ].join(" ");
  }
  if (service.inputMode === "dynamic") {
    const incumbent = service.incumbentMode === "optional"
      ? "This profile allows starting from scratch: omit incumbent_version_id if no candidate exists. Do not ask the user to upload or create a seed. Once an evaluated candidate is delivered, pass its incumbent_version_id to continue from its exact bytes."
      : service.incumbentMode === "none"
        ? "This profile stages only a plan: omit incumbent_version_id. The researcher creates the first candidate from scratch."
        : "This profile requires incumbent_version_id naming the current Session's starting candidate.";
    return [
      `<local_research_mode>`,
      boundary,
      trigger,
      `This deployment runs dynamic inputs: you author the plan as ordinary research text. Call publish_research_plan with the plan body to publish it as a Session Artifact version, then call start_research with that exact plan_version_id. ${incumbent} The selected versions' exact bytes are staged for the run, and no later version or edit changes what a started run reads. Get version ids with list_artifacts and read_artifact (read_artifact returns the version record, including its id) or from the delivery references get_research returns.`,
      `The research intent you pass to start_research becomes part of the researcher's instruction, together with the staged plan path and this run's version identities. Write the intent as the concrete research direction of this run. This deployment supports one task package only: if the user asks for a different task family, say that it is unsupported instead of running this task under a misleading label. Never supply host paths, an interpreter, a model, an endpoint, a credential, commands or a task description.`,
      observe,
      delivery,
      comparison,
      line,
      service.incumbentMode === "none"
        ? `To run again, read the delivered feedback and publish a revised plan. This profile does not stage a prior candidate; do not claim candidate continuation.`
        : `To continue research, read the delivered result note, the evaluated attempt artifacts and the researcher's records, interpret what the run actually did, then publish a revised plan and start a second run whose incumbent_version_id is a real evaluated candidate version delivered by the earlier run. Do not relabel a run as a continuation or reuse the seed while claiming a new candidate.`,
      honesty,
      `</local_research_mode>`,
    ].join(" ");
  }
  return [
    `<local_research_mode>`,
    boundary,
    trigger,
    `When the user asks to run the configured experiment, call start_research with a short intent. This profile runs one administrator-configured bounded experiment: its pinned task text is the instruction the researcher executes, and the intent is recorded only as this run's label and as the purpose you report. If you name plan_version_id or incumbent_version_id, they must be this Session's versions whose content is byte-identical to the profile's configured plan/incumbent inputs; a different version is refused before anything runs. Omit them to run the configured fixed inputs. Never supply host paths, an interpreter, a model, an endpoint, a credential, commands or a task description: those are administrator and Session configuration.`,
    observe,
    delivery,
    comparison,
    line,
    honesty,
    `</local_research_mode>`,
  ].join(" ");
}

/** The three tools, plus the plan-authoring tool in dynamic mode. */
export function createLocalResearchTools(input: LocalResearchToolInput): AgentTool[] {
  const { service, projectId, sessionId, runId, requirePrivilege, beginExternalWait } = input;

  const result = (value: Record<string, unknown>) => {
    const view = publicView(value);
    return { content: [{ type: "text" as const, text: JSON.stringify(view) }], details: view };
  };

  const refused = (error: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => {
    if (error instanceof LocalResearchRefusal || error instanceof TaskPreparationRefusal) {
      return result({ error: error.reason, message: error.message });
    }
    throw error;
  };

  const start: AgentTool<typeof startParameters> = {
    name: START_RESEARCH_TOOL,
    label: "Start local research",
    description: service.taskMode === "task-dynamic"
      ? [
          "Start one bounded experimental ScienceFlow research run for this Session on the task you selected or prepared.",
          RESEARCH_START_TRIGGER,
          "Pass exactly one of task_package_id (a registered package from list_research_tasks) or task_version_id (a task contract version from prepare_research_task). The task's evaluator, metric direction, metric JSON path, artifact path and bound inputs are frozen for the run.",
          `Pass plan_version_id (required). Incumbent policy: ${service.incumbentMode}. Omit incumbent_version_id for a first run when optional, and provide a real delivered candidate to continue. A candidate delivered under a different or re-prepared task contract is refused.`,
          "input_version_ids binds this Session's data artifact versions for a registered task; a prepared task already carries its own bound inputs. Selected exact bytes are staged; versions outside this Session are refused before launch.",
          "For a continuation round, pass proposal with the question, evidence, concrete method change, expected observation, evaluation method, stop condition and sub-budget. The same method on the same candidate with no new evidence is refused unless a randomized repeat is declared. If a result was selected_for_next, omit incumbent_version_id to follow it, or pass exactly that version; a different candidate is refused.",
          "The intent becomes part of the researcher's instruction together with the frozen task contract and the staged plan. Business identities only: never paths, interpreter, model, endpoint, credential or commands.",
          "This is experimental local execution on this host, not the formal Runner sandbox. It returns an operation id at once; observe it with get_research. Do not start the same experiment twice.",
        ].join(" ")
      : service.inputMode === "dynamic"
      ? [
          "Start one bounded experimental ScienceFlow research run for this Session, using a plan and, when supplied, a starting solution selected from this Session's artifacts.",
          RESEARCH_START_TRIGGER,
          `Pass plan_version_id (required). Incumbent policy: ${service.incumbentMode}. Omit incumbent_version_id for a first run when optional, always omit when none, and provide it when required or continuing from a candidate. Selected exact bytes are staged; versions outside this Session are refused before launch.`,
          "The intent becomes part of the researcher's instruction together with the staged plan; write it as this run's concrete research direction. Business identities only: never paths, interpreter, model, endpoint, credential or commands.",
          "This is experimental local execution on this host, not the formal Runner sandbox. It returns an operation id at once; observe it with get_research. Do not start the same experiment twice.",
        ].join(" ")
      : [
          "Start this deployment's one configured bounded experimental ScienceFlow research run for this Session.",
          RESEARCH_START_TRIGGER,
          "The administrator's pinned task text is the instruction the researcher executes; intent is recorded as this run's label and the purpose you report.",
          "Supply business identities only: intent and, optionally, this Session's plan_version_id and incumbent_version_id, which must exactly match the profile's configured fixed inputs. A different version is refused before launch.",
          "This is experimental local execution on this host, not the formal Runner sandbox. It returns an operation id at once; observe it with get_research. Do not start the same experiment twice.",
        ].join(" "),
    parameters: startParameters,
    async execute(toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        // The mode's enablement is deployment configuration; the Session's own
        // governed permission still has to allow starting the execution.
        await requirePrivilege({
          resource: service.permissionResource,
          summary: `Start an experimental local research run (${service.profileId})`,
          toolCallId,
          ...(signal ? { signal } : {}),
        });
        // The permission wait can outlive the conversation. Re-check before
        // creating the operation: at this point the cancel path may already
        // have found nothing to stop, and a late start would be unowned.
        signal?.throwIfAborted();
        const outcome = await service.start({
          projectId,
          sessionId,
          ownerRunId: runId,
          intent: parameters.intent,
          ...(parameters.plan_version_id ? { planVersionId: parameters.plan_version_id } : {}),
          ...(parameters.incumbent_version_id ? { incumbentVersionId: parameters.incumbent_version_id } : {}),
          ...(parameters.task_package_id ? { taskPackageId: parameters.task_package_id } : {}),
          ...(parameters.task_version_id ? { taskVersionId: parameters.task_version_id } : {}),
          ...(parameters.input_version_ids?.length ? { inputVersionIds: parameters.input_version_ids } : {}),
          ...(parameters.proposal === undefined ? {} : {
            proposal: {
              evidence: parameters.proposal.evidence.map((entry) => ({
                fact: entry.fact,
                kind: entry.kind,
                ...(entry.operation_id === undefined ? {} : { operationId: entry.operation_id }),
                ...(entry.version_id === undefined ? {} : { versionId: entry.version_id }),
              })),
              evaluationMethod: parameters.proposal.evaluation_method,
              expectedObservation: parameters.proposal.expected_observation,
              methodChange: parameters.proposal.method_change,
              researchQuestion: parameters.proposal.research_question,
              ...(parameters.proposal.repeat === undefined ? {} : {
                repeat: {
                  kind: "randomized-repeat" as const,
                  purpose: parameters.proposal.repeat.purpose,
                  randomness: parameters.proposal.repeat.randomness,
                  repetitions: parameters.proposal.repeat.repetitions,
                },
              }),
              stopCondition: parameters.proposal.stop_condition,
              ...(parameters.proposal.sub_budget_seconds === undefined
                ? {}
                : { subBudgetSeconds: parameters.proposal.sub_budget_seconds }),
            },
          }),
          ...(signal ? { signal } : {}),
        });
        return result({
          operation: outcome.operation,
          attached: outcome.attached,
          ...(outcome.attachedReason ? { attachedReason: outcome.attachedReason } : {}),
          instruction: outcome.attached
            ? "This start request matches an existing research operation; no second run was launched. Observe it with get_research."
            : "The research run was accepted and is starting in the background. Observe it with get_research; do not call start_research again for this experiment.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const get: AgentTool<typeof getParameters> = {
    name: GET_RESEARCH_TOOL,
    label: "Observe local research",
    description: [
      "Observe an experimental local research operation: real engine lifecycle, evaluated stages, delivery state and artifact version references.",
      "wait_seconds bounds how long this call waits; the Engine idle clock is paused for that wait. action retry_delivery republishes an ended run's artifacts without rerunning research.",
      "When the run has ended, read the delivered artifacts with read_artifact and answer from them.",
    ].join(" "),
    parameters: getParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      const operation = {
        projectId,
        sessionId,
        ...(parameters.operation_id ? { operationId: parameters.operation_id } : {}),
      };
      try {
        if (parameters.action === "retry_delivery") {
          return result(serviceView(await service.retryDelivery(operation)));
        }
        const waitMs = Math.min(
          service.observeMaxWaitMs,
          Math.max(0, (parameters.wait_seconds ?? 0) * 1_000),
        );
        const release = waitMs > 0 ? beginExternalWait?.() : undefined;
        try {
          return result(serviceView(await service.get(operation, {
            waitMs,
            ...(signal ? { signal } : {}),
          })));
        } finally {
          release?.();
        }
      } catch (error) {
        return refused(error);
      }
    },
  };

  const stop: AgentTool<typeof stopParameters> = {
    name: STOP_RESEARCH_TOOL,
    label: "Stop local research",
    description: [
      "Request this Session's experimental research run to stop through the engine's own stop path.",
      "It reports whether termination was requested and whether the engine confirmed it; repeating it is safe. It never stops another run.",
    ].join(" "),
    parameters: stopParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        const outcome = await service.stop({
          projectId,
          sessionId,
          ...(parameters.operation_id ? { operationId: parameters.operation_id } : {}),
        });
        return result({
          operation: outcome.operation,
          requested: outcome.requested,
          confirmed: outcome.confirmed,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          instruction: !outcome.requested
            ? "The run already reached a terminal state, so no engine stop was sent. The research line is marked stopped for this conversation, so a further start in this conversation run is refused; report the run's actual outcome."
            : outcome.confirmed
              ? "The engine confirmed termination. Report what ran and that the run was stopped by this request. A further start in this conversation run is refused."
              : "The stop was requested but termination is not confirmed yet. Call get_research to observe the final state before reporting.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const results: AgentTool<typeof resultsParameters> = {
    name: GET_RESEARCH_RESULTS_TOOL,
    label: "Compare research results",
    description: [
      "Read every result of this Session grouped by its exact frozen scientific contract.",
      "Each group reports `latest`, `best_valid` and the explicit `selected_for_next`, with each run's validity, metric direction and delivered solution version.",
      "Only results in the same group are comparable; a different task version, task package, evaluator, engine revision, metric direction or bound input data is a different experiment and must never be ranked against this one.",
      "The recorded value is the engine's captured-stage validation metric, not an independent final evaluation. Do not call a small difference a significant improvement.",
      "Continue from `best_valid` unless you deliberately call select_research_result for another valid result and state why.",
      "`overhead` reports preparation/probe wall clock that no contract group owns and states that Idea Tree and Evolve were not executed; token totals are not a complete provider-total claim and no hard token cap is enforced.",
    ].join(" "),
    parameters: resultsParameters,
    async execute(_toolCallId, _parameters, signal) {
      signal?.throwIfAborted();
      try {
        return result({
          groups: service.results({ projectId, sessionId }),
          overhead: service.overhead({ projectId, sessionId }),
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const select: AgentTool<typeof selectParameters> = {
    name: SELECT_RESEARCH_RESULT_TOOL,
    label: "Select research starting point",
    description: [
      "Record the explicit `selected_for_next` starting point for one scientific contract group.",
      "The result must be a valid, delivered candidate from this Session and the same frozen contract. A deliberately non-optimal result is allowed: record the evidence-based reason instead of pretending it is the best score.",
      "The best valid result remains available regardless of this choice; selecting never deletes or overwrites prior evidence.",
    ].join(" "),
    parameters: selectParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        return result({
          group: service.selectForNext({
            operationId: parameters.operation_id,
            projectId,
            reason: parameters.reason,
            selectedBy: "tool",
            sessionId,
          }),
          instruction: "This explicit choice is now selected_for_next. The best valid result remains reported separately; start_research still requires that candidate's exact version id.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const checkEvolve: AgentTool<typeof checkEvolveParameters> = {
    name: CHECK_EVOLVE_PILOT_TOOL,
    label: "Check Evolve pilot feasibility",
    description: [
      "Analyze whether one delivered SF result fits the single supported CPU Evolve candidate format.",
      "This never starts an Evolve search, spends model tokens or creates a result record. It reads the task contract, original evaluator bytes and bound CSV, then reports the exact shape gaps and the architecture limits that make execution unsupported.",
      "Execution is explicitly unsupported: the candidate and evaluator share one process, the adapter embeds every CSV row so it cannot provide a held-out boundary, the sidecar has no sandboxed candidate re-evaluation endpoint, and Evolve is not linked to the parent budget or stop chain.",
      "Do not describe this report as a runnable pilot or an Evolve score.",
    ].join(" "),
    parameters: checkEvolveParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        return result({ ...await service.checkEvolvePilot({
          operationId: parameters.operation_id,
          projectId,
          sessionId,
          ...(parameters.expansions === undefined ? {} : { expansions: parameters.expansions }),
          ...(parameters.workers === undefined ? {} : { workers: parameters.workers }),
          ...(parameters.statement === undefined ? {} : { statement: parameters.statement }),
        }) });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const listTasks: AgentTool<typeof listTasksParameters> = {
    name: LIST_RESEARCH_TASKS_TOOL,
    label: "List research tasks",
    description: [
      "List the engine's registered task packages with their artifact path and kind, metric name and direction, evaluator entrypoint and benchmark authority.",
      "Use it to decide whether the user's objective matches an existing package. A matching package's evaluator and scoring contract must be used unchanged; do not create a replacement for it.",
    ].join(" "),
    parameters: listTasksParameters,
    async execute(_toolCallId, _parameters, signal) {
      signal?.throwIfAborted();
      try {
        return result({ tasks: await service.listTasks({ projectId, sessionId }) });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const prepareTask: AgentTool<typeof prepareTaskParameters> = {
    name: PREPARE_RESEARCH_TASK_TOOL,
    label: "Prepare research task",
    description: [
      "Prepare a new computational research task from a scientific objective and publish it as an immutable Session task version.",
      RESEARCH_START_TRIGGER,
      "You supply the complete objective, the candidate artifact contract, the metric and its direction, a Python evaluator script, and one valid plus one domain-violating invalid sample artifact. The deployment runs both samples through the engine's real evaluator backend; nothing is published when a sample does not behave as specified.",
      "Bind ordinary attached data with input_version_ids so the task contract carries those exact bytes. A generated evaluator is exploratory: say so, and never present its score as an authoritative benchmark.",
      "Samples only need to satisfy or violate the domain contract; they do not need to be optimal or computed from the data. This tool runs the probe itself, so denied workspace shell execution does not block preparation.",
      "If a scientific fact, the metric or usable data is missing, ask the user instead of inventing it. Returns a task version id for start_research.",
    ].join(" "),
    parameters: prepareTaskParameters,
    async execute(toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        // Preparing a task runs evaluator code, so it uses the same governed
        // code-execution permission as starting one. Preparation is not a bypass.
        await requirePrivilege({
          resource: service.permissionResource,
          summary: "Prepare and probe a research task evaluator",
          toolCallId,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        const published = await service.prepareTask({
          artifactKind: parameters.artifact_kind,
          artifactPath: parameters.artifact_path,
          evaluatorSource: parameters.evaluator_source,
          invalidSample: parameters.invalid_sample,
          ...(parameters.input_version_ids === undefined
            ? {}
            : { inputs: parameters.input_version_ids.map((input) => ({
                ...(input.file_name ? { fileName: input.file_name } : {}),
                versionId: input.version_id,
              })) }),
          metricDirection: parameters.metric_direction,
          metricJsonPath: parameters.metric_json_path,
          metricName: parameters.metric_name,
          objective: parameters.objective,
          projectId,
          runId,
          sessionId,
          ...(parameters.slug ? { slug: parameters.slug } : {}),
          title: parameters.title,
          validSample: parameters.valid_sample,
          ...(signal ? { signal } : {}),
        });
        return result({
          task: published,
          instruction: "The task contract is frozen and its evaluator passed the probe. Publish or reuse a research plan, then call start_research with this contract's taskVersionId as task_version_id.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  const publishPlan: AgentTool<typeof publishPlanParameters> = {
    name: PUBLISH_RESEARCH_PLAN_TOOL,
    label: "Publish research plan",
    description: [
      RESEARCH_START_TRIGGER,
      "Publish the plan text you authored as an ordinary Session Artifact version, and return its stable version id for start_research.",
      "The content is the plan itself (Markdown): the question, the concrete method change, the starting solution, the budget and the acceptance rule. It is stored through the same Artifact, version and content-store path as any other declared artifact, with this Agent run recorded as its origin.",
      "To revise a plan, pass artifact_id and base_version_id together; a stale base is refused instead of overwriting a newer plan. Re-publishing identical bytes returns the version that already holds them. At most 64 KiB.",
    ].join(" "),
    parameters: publishPlanParameters,
    async execute(toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      try {
        const published = await service.publishPlan({
          projectId,
          sessionId,
          runId,
          content: parameters.content,
          ...(parameters.name ? { name: parameters.name } : {}),
          ...(parameters.title ? { title: parameters.title } : {}),
          ...(parameters.description ? { description: parameters.description } : {}),
          ...(parameters.artifact_id ? { artifactId: parameters.artifact_id } : {}),
          ...(parameters.base_version_id ? { baseVersionId: parameters.base_version_id } : {}),
          publicationId: `${runId}:${toolCallId}`,
          ...(signal ? { signal } : {}),
        });
        return result({
          plan: published,
          instruction: published.reused
            ? "This exact plan content already is the artifact's current version; no new version was written. Use plan_version_id from this result."
            : "The plan is published. Pass this versionId as plan_version_id to start_research; that run stages exactly these bytes.",
        });
      } catch (error) {
        return refused(error);
      }
    },
  };

  return service.taskMode === "task-dynamic"
    ? [listTasks, prepareTask, publishPlan, start, get, results, select, checkEvolve, stop]
    : service.inputMode === "dynamic" ? [publishPlan, start, get, results, select, stop] : [start, get, results, select, stop];
}

/** The service view is already public; keep one explicit mapping point. */
function serviceView(view: ScienceFlowLocalResearchView): Record<string, unknown> {
  return { ...view };
}

/**
 * Drop any accidental host-path-shaped field from a tool result. The service
 * view carries none by construction; this is the last guard before the model
 * and the event stream see a value.
 */
function publicView(value: Record<string, unknown>): Record<string, unknown> {
  const forbidden = new Set([
    "workDir",
    "receiptPath",
    "deliveryRecordPath",
    "seedDir",
    "privateRoot",
    "engineCheckout",
    "pythonExecutable",
    "readerScriptPath",
    "endpointUrl",
    "apiToken",
  ]);
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([key]) => !forbidden.has(key))
          .map(([key, item]) => [key, clean(item)]),
      );
    }
    return input;
  };
  return clean(value) as Record<string, unknown>;
}
