# Conversation-defined research tasks: intake, contract, and execution binding

Status: round 26 implementation note. It describes the generic task-intake path
added to the experimental local research mode; it does not change the formal
Runner execution plan, its `canStart` blockers, or any sandbox claim.

## What the path does

A normal Session message can describe a computational research experiment in
natural language, optionally attach ordinary data files, and obtain a real
ScienceFlow managed run of that task. The Agent chooses one of two task sources:

1. **A registered engine task package.** `list_research_tasks` reports the
   packages the pinned engine checkout registers (id, category, profile,
   artifact path/kind, metric name/type/direction, evaluator entrypoint and
   whether the metric is authoritative). A start names the package by id. The
   package's evaluator, metric direction, constraints and benchmark authority
   are used unchanged; the profile no longer names a task, so a start cannot
   silently fall back to a different one.

2. **A task prepared in the Session.** `prepare_research_task` takes the
   scientific objective, artifact contract, metric, a Python evaluator and one
   valid plus one invalid sample artifact. The deployment runs both samples
   through the engine's own `artifact_command` backend. Only a passing probe
   publishes a task version; the Agent then starts the run with its
   `task_version_id`.

The administrator still owns engine checkout, interpreter, reader/preparation
adapters, private roots, supporting assets and operational defaults. The
conversation supplies only scientific content and business identities: task id
or prepared contract version, plan version, optional incumbent, optional data
artifact versions, and an intent. Host paths, credentials, endpoints, model
selection and launch commands cannot be supplied through these tools.

Execution intent is checked before task intake: an explicit request to run or
continue an experiment, or an explicit ScienceFlow mention in a computational
task request, selects this workflow. Plan-only, no-run and informational requests
do not. Ambiguous intent or missing scientific inputs require clarification.
See [When ScienceFlow is used](scienceflow-research-ui.md#when-scienceflow-is-used)
for examples and the scope of these Agent instruction rules.

## The prepared contract

A prepared contract is one immutable `json` artifact version
(`research-tasks/<task-id>/contract.json`) plus the evaluator script it names
(`research-tasks/<task-id>/evaluator.py`, an `other` artifact version). The
contract records:

- objective and title; candidate artifact path and kind;
- metric name, direction and the stdout JSON path the evaluator uses;
- the evaluator's version id, sha256 and size;
- the probe evidence (status, metric and artifact digest per sample);
- the ordinary Session data versions bound as task inputs, with their digests
  and staged file names;
- provenance (Session, Agent run, preparation time) and the
  `exploratory-generated` authority label.

A later `prepare_research_task` call either reuses identical bytes at the
artifact head or appends a new version. Inputs are frozen at preparation; a new
attachment or a revised objective is a new task version. There is no separate
task catalog database: the existing artifact/version/content-store path is the
store.

## Evaluator authority and probes

A registered package's evaluator stays authoritative according to the package.
A generated evaluator is always exploratory: its probe proves only that the
valid sample yields one finite metric through the engine's backend and the
invalid sample is rejected. Malformed scripts, non-finite values, exceptions and
timeouts remain probe failures, and a failed probe publishes nothing.

Preparation runs under the same governed code-execution permission as starting a
run. It is not an ungoverned bypass, and it does not create a second evaluator
implementation: the adapter constructs the same `EvalContext`/`CandidateRef` and
calls `ArtifactCommandBackend.evaluate`.

## Preflight is bound to the exact version

The contract's `probes` array is ordinary artifact content, so it is evidence a
caller can copy into an edited contract; it is not by itself proof that the
evaluator bytes in that version were probed. Preparation therefore also writes a
server-side validation row keyed by the contract version id the store assigned,
covering the contract digest, task id, evaluator version/digest/size, metric
(name, direction and stdout JSON path), artifact path/kind, bound inputs and the
probe results. A start re-reads that row and requires an exact match; a contract
version produced by a normal artifact edit — even one that copies an older probe
array — has no row and is refused. Re-preparing the task is the supported way to
change an evaluator: it probes again, produces a new contract version and a new
validation row. A task version published before this validation existed has no
row and must be re-prepared before it can start. Malformed probe or input entries
are refused at parse time rather than dropped, and a contract without exactly one
accepted and one rejected probe is invalid.

The metric JSON path is carried unchanged from the contract through the frozen
binding into the production manifest's `metric.json_path`, so the field the probe
read is the field the run scores. An unsupported path is refused at preparation.

## Continuation identity

A delivered candidate carries the engine run that produced it. When a start
names an incumbent, the service resolves that provenance through the source
operation (or the artifact's delivery metadata) and compares the scientific
contract: task id, artifact contract, metric, evaluator identity, prepared
contract digest and bound input bytes. A candidate delivered under a different or
re-prepared contract is refused with `continuation-task-mismatch`; the supported
paths are same-contract continuation and an explicitly uploaded candidate, which
is a new baseline rather than an inherited score. A candidate whose delivery
metadata names no operation in this Session is refused.

## Execution binding

At start time the selected task is resolved before the input binding and frozen
into the operation record:

- catalog: engine task id, package metadata and evaluator entrypoint, plus any
  bound data versions;
- prepared: the contract version and its body hash, the evaluator version and
  sha256, the metric contract and bound inputs.

The background worker stages the plan/incumbent and data files into the
operation's own input directory, then copies the prepared evaluator and contract
into the operation's own task directory and writes a task manifest with their
digests. The re-read contract must equal the hash frozen at start. The engine
manifest therefore names either the registered `exp_id` (engine-resolved
evaluator) or, for a prepared task, an `artifact_command` evaluator block whose
command is built from the profile interpreter and the operation's own script
path. Because each operation has its own copy, another operation, a later task
version, a profile edit or a rebuild cannot change what an accepted run
executes.

The composed researcher instruction contains the task description/objective, the
plan and intent, the artifact and metric contract, the evaluator authority, the
bound input names and the operation id. It contains no host path.

Delivery carries the task identity, metric direction and evaluator authority
into the result note and registration; a note for a prepared evaluator states
that it is exploratory rather than an authoritative benchmark. Selection of the
best captured stage is the engine's own direction-aware selection and is read
back unchanged, including for minimizing metrics.

## Evaluator dependencies

The pinned engine's default lock closure is the CPU control plane only. The
registered `ratio-minimization` evaluator imports NumPy and SciPy, which the lock
carries for the optional extras but does not install by default; the setup script
therefore installs exactly the locked versions (`numpy==2.4.3`,
`scipy==1.17.1`) after every exact sync and verifies that the engine interpreter
can import them. It does not install the ML or GPU profiles. For any other
package, `describe-task` parses the evaluator entrypoint's imports and reports
modules this interpreter cannot resolve; the start is refused before the paid
research run, naming the gap.

## Supported scope and honest limits

Supported: self-contained CPU computational tasks with an evaluable artifact, a
finite metric, and inputs that fit the existing Session attachment/artifact APIs.
Both a first run with no candidate and a continuation from a delivered candidate
are supported; a scientific-contract change is a new task version, not a
continuation.

Not claimed: arbitrary laboratory workflows, GPU training, external
data-access brokerage, scientifically ambiguous requests, universal scientific
validity of generated evaluators, formal Runner sandbox isolation, native
Windows or multi-worker coverage, or any benchmark record.
