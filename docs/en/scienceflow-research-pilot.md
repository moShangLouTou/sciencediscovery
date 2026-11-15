# ScienceFlow research pilot: one evaluated circle-packing loop

Status: operator-run research pilot (rounds 19–22). Round 19 executed five
bounded managed runs on the engine's own `circle-packing` task. Runs 1–3
established the task, evaluator and process evidence; runs 4–5 closed the loop:
a model-produced candidate was captured and evaluated by the engine, the engine's
score was delivered back to the model, and the model then produced a second
candidate that the engine captured, evaluated and compared.

Round 20 replaces round 19's manual joins — a separately maintained engine model
registry, an ad hoc launcher and an in-memory Project/Session identity adapter —
with one reusable internal operator command that resolves the Session's effective
ScienceDiscovery model and reads the run back for that same persisted Session.
Section 8 describes the command and the round-20 runs; sections 1–7 remain the
round-19 record and their results are not rewritten. Round 21 adds `deliver`,
which publishes an existing run's selected result as normal Session artifacts for
the Session's Agent (section 9); it starts no run and re-evaluates nothing. Round
22 makes an Agent-authored plan the input of a real managed run and brings its
evaluated attempts back with an Agent interpretation (section 10).

## 1. What this pilot is

An operator started ScienceFlow managed research runs on the engine's own
built-in `circle-packing` task and then read the same run records back through
ScienceDiscovery's existing run reader, registration and snapshot services.

The engine ran them; ScienceDiscovery did not start them. Nothing here turns on
`canStart`, clears any of the five blockers, or claims the Runner
gateway/sandbox path. The public research-start feature is still blocked, and
this pilot is the existing *external run observation* path: a run produced by the
engine's documented managed entry, then registered and read by SD.

Task: place exactly 26 circles in the unit square `[0, 1] x [0, 1]`, maximize the
sum of radii (`radii_sum`), benchmark 2.635. No dataset and no GPU. The task
package, evaluator and validation controls are the engine's own and were not
modified.

## 2. Identities

| Object | Identity |
| --- | --- |
| Task package | `tasks/opt_solver/circle-packing` |
| `task.yaml` | sha256 `be71779b8ed3092751d88a352b3cf4540395f0244e6e6cbce879bbf6813b8e36` |
| Evaluator | `evaluator.py:evaluate`, sha256 `bbd5063b6ec22040aa6ebd9ca2ac0f7dfc340a4ba12042229ca9fc9176dd21f0` |
| Task description | `description_lite.md`, sha256 `abc5514a57719fbf49b1df64f5ac49534e43f0fc9a8ade159a851f33bc3c4966` |
| Package tree | `tree_sha256 17721fbad2fc429ea20ccf8623d964faeb8f88234b80ca88aa699ac8182bc33d` |
| Evaluator timeout | 300 s (declared in `task.yaml`) |
| Engine | pinned checkout, commit `e1347021eaa497d2dc138d9e66ce36e09260568a` |
| Model (round 19) | alias `round19-qwen-flash`, provider model `Qwen3.8-Flash` |
| Model (round 20) | the Session's effective SD profile, provider model `Qwen3.8-Flash`, resolved at launch |

The evaluator contract is established independently of any model output, both by
direct execution and through the engine's real `entrypoint_runner`:

| Control | Artifact | Observed |
| --- | --- | --- |
| valid | 26 circles, r = 0.01 | `valid: true`, `radii_sum = 0.26`, `benchmark_ratio = 0.0987`, exit 0 |
| invalid | 2 circles only | `expected exactly 26 circles, got 2`, exit 2 |

## 3. The invocation

The engine was used as a pinned source checkout, not an installed package, and
each run was started through its managed-run control API:

```sh
cd .tmp/r/round19/pilot
XDG_STATE_HOME=$PWD/state \
PYTHONPATH=<pinned-sf-checkout> \
ROUND19_NOINSTALL_SHIMS=1 \
<python-3.12.12-venv>/bin/python launch_pilot.py <manifest>.yaml <run-id>
```

`launch_pilot.py` only wraps the allowance around the engine's own entry: it
calls `scienceflow.runtime.parallel.control.start_run(manifest)`, polls
`get_run`, samples the engine processes it spawned, and would call `stop_run` if
the run were still alive at its wall-clock limit. Research and reporting
themselves run inside the engine's detached supervisor; the launcher makes no
model call.

Runs 4–5 used a new run identity per attempt and an input directory that carries
the incumbent candidate as a traced seed:

```yaml
defaults:
  config: <pilot>/engine-config-b.yaml
  workspace_base: <pilot>/runs
  input_data_dir: <pilot>/seed-round19d
  gpu_list: cpu
  scienceflow_interaction_log_full: true
  scienceflow_bash_timeout_sec: 60
tasks:
  - exp_id: circle-packing
    run_id: round19-circle-packing-e
lnr:
  num_workers: 1
  merge_enabled: false
  wall_clock_budget_sec: 840
  max_steps: 24
  stage_capture_max_count: 2
report_budget_sec: 60
```

The seed directory contains the incumbent artifact, the engine evaluator's result
for that exact file, and the model-written solver that produced it. It is
labelled as carried-over work with its source run, so nothing in the new run is
presented as if the old run had resumed or as if the seed were a new model
result.

## 4. The five runs

All corrections were configuration-only; no engine or SD source was changed.

| Run | Change | Outcome |
| --- | --- | --- |
| 1 | initial manifest | 244 s, no candidate. With `input_data_dir` unset the engine defaulted to `.` and linked every entry of the operator's pilot directory into `workspace/dataset/`; the LLM merge reserve also cut the single worker's budget from 540 s to 240 s. |
| 2 | isolated empty input dir; `merge_enabled: false` | 542 s, no candidate. The worker had the full 540 s, but the model spent it on five package-install attempts (`pip`/`uv`, one backgrounded with `nohup`), then wrote a numpy-based solver that could never import. |
| 3 | plus `evaluator.command.python_executable`, install-refusing PATH shims, 60 s bash timeout | 543 s, one valid candidate at `radii_sum = 2.6166`, but its producing command was cut off by the deadline, so the engine archived it with `tool_error: true` and captured no stage. |
| 4 | seeded incumbent; 840 s research / 24 steps (user's continuation allowance) | 846 s. S01 captured the seeded incumbent and the engine evaluated it; the model received the engine's S01 row in stage S02 and rebuilt a solver, but the research budget ended before it wrote a changed artifact. |
| 5 | same seed with the prior solver resuming from the incumbent artifact | 846 s. Three candidates evaluated: S01 (seeded incumbent) and S02 (model's own solver) captured as stages; a third candidate (S03) was evaluated and gate-accepted but not admitted because the run's two-stage cap was reached. |

Run 5 is the loop this pilot was for.

## 5. How a returned command becomes model feedback

The mechanism is the engine's own, and it is why the earlier runs missed:

1. After each bash tool call the post-commit adapter archives the candidate and
   then considers stage capture (`scienceflow/agent/core/ports/session_callbacks.py:68,109`).
2. Capture requires the tool result to be non-error, and the per-command timeout
   is `min(configured, remaining)` (`coordinator/shared.py:239`). A command that
   runs into the research deadline therefore always returns an error, and its
   artifact never becomes a stage — exactly what happened in run 3.
3. When capture does fire, the engine evaluates the artifact
   (`_record_evaluator_stage_events` → `TaskPackageBackend`) and commits the
   stage (`evaluation/commit.py:199`). The commit turn then shows the model the
   evaluated facts, including `metric: <value>`
   (`lifecycle/stage/prompt.py:112,140`), and the committed ledger row
   (`### S01 | metric: ... | metric_note: authoritative_evaluator_ok`) stays in
   the model's context for the following stage.

So the feedback channel is real and engine-owned; the only requirement is that a
bounded command returns after writing the artifact.

## 6. Run 5: the loop

| Candidate | Stage | `radii_sum` | Artifact sha256 (16) | Engine status | Produced by |
| --- | --- | --- | --- | --- | --- |
| A (incumbent, carried seed) | S01 | 2.61661905326 | `1401d3987588f19e` | captured, `task_package` ok, validity high | model copied the traced seed into `artifacts/best_solution.json` at t+1 s |
| B | S02 | 2.621352304043 | `f5c5579c4e5e06da` | captured, `task_package` ok, validity high | model's own `solver/pack.py`, written after S01's engine row |
| C | S03 (not captured) | 2.635799459773 | `ab9b077bb45bdf1b` | evaluator `ok`, gate `accept eligible`, no stage | model's own C solver `solver/cp_v1.c` |

- B vs A: `+0.004733` (`+0.18%`), `0.9930 → 0.9948` of the benchmark 2.635.
- C vs B: `+0.014447` (`+0.55%`); C reaches `1.0003x` the declared benchmark.
- C is not a stage: `lnr.stage_capture_max_count` was 2 for this run. The engine
  still ran its evaluator and gate for the artifact (`evaluator_metric_event`,
  `gate: accept eligible`, `validation_ok`, `candidate_ready`,
  `selection_eligible`, `metric_validity: high`) and archived it; a later
  operator re-evaluation through the same `TaskPackageBackend` reproduced
  `2.635799459773` (`benchmark_ratio = 1.0003034`, 26 circles, valid). It is
  reported here as an engine-evaluated, gate-accepted candidate that was **not**
  admitted as a stage, not as a third stage.

Stage lifecycle in the engine's own journal:

| Stage | captured (detect) | committed | note |
| --- | --- | --- | --- |
| S01 | 11:35:57 | 11:38:10 | seeded incumbent |
| S02 | 11:41:58 | 11:42:50 | model's `pack.py` |
| S03 | 11:46:14 | — | cap reached; assess ran, no commit |

The model's S02 request already carried the engine's S01 row
(`### S01 | metric: 2.61661905326 | ... authoritative_evaluator_ok`), and the
same row is present in every later request of the run. The run ended
`completed` with `stage_count = 2`.

Both captured candidates are preserved: the engine's `artifact_snapshots/`
keeps `iter_0001..._1401d3987588` and `iter_0002..._f5c5579c4e5e`, and the
operator-side immutable records are `candidate-a/`, `candidate-b/`,
`candidate-c/` (artifact, evaluator result, provenance, model code, 0444).

## 7. Reading the run back through ScienceDiscovery

The run records were read at service level, without the product stack or a
browser: `services/scienceflow-reader/snapshot.py` (real reader, spawned as a
child process), `services/api/src/scienceflow/run-snapshot.ts`
(`createScienceFlowRunSnapshotQuery`), `services/api/src/scienceflow/dto.ts`
(`projectScienceFlowRunSnapshot`), and
`services/api/src/scienceflow/registration.ts` +
`registration-repository.ts` (a registration row in a real
`science_flow_run_registrations` table on an isolated `node:sqlite` file).

| Run | Readback |
| --- | --- |
| 3 | `status failed`, `candidate: null`, `no_candidate_binding` — a valid artifact on disk that was never captured as a stage is not expressible |
| 4 | `status completed`, `reportedMetric radii_sum 2.61661905326` (source `lhr_stage_performance`), `candidate` sha `1401d398…`, `digestVerified: true`, `stageId S01` |
| 5 | `status completed`, `reportedMetric radii_sum 2.621352304043`, `candidate` sha `f5c5579c…`, `digestVerified: true`, `stageId S02` |

Two limits remain visible in the readback: the DTO binds the best *captured*
stage, so run 5's S03 candidate (evaluated, gate-accepted, not a stage) is not
expressible; and the DTO has no per-candidate list or feedback reference, so the
A→B comparison is readable from the run record and the stage CSV but not from
the DTO.

Only the identity lookup is an in-memory adapter: importing the full
`SessionStore` graph in this worktree needs package installs that are out of
scope here. The API server, HTTP routes and browser journeys were not started.
No SD source was changed.

## 8. Round 20: one reusable operator invocation over the Session's model

Round 19 closed the loop, but with three manual joins: a separately maintained
engine model registry, an ad hoc launcher, and an in-memory Project/Session
identity adapter. Round 20 removes those joins for this pilot and nothing else.
The checked-in command is `services/api/src/scienceflow/research-pilot-cli.ts`
over `research-pilot.ts`; it is an internal operator entry, not an HTTP route.

### 8.1 What one invocation does

```sh
node --import tsx services/api/src/scienceflow/research-pilot-cli.ts launch \
  --data-dir <isolated store> --project <id> --session <id> \
  --run-id <engine run id> --work-dir <pilot dir> \
  --private-root <0700 dir outside the work dir> \
  --engine <pinned checkout> --python <interpreter> \
  --reader-script services/scienceflow-reader/snapshot.py \
  --seed <traced seed dir> [--refuse-package-install] [--receipt <path>] \
  [--task-description <text file>]
```

The same command with `attach` takes the same options, skips the launch, and
re-registers/re-reads the run its receipt already records. Nothing in the options
selects a provider, credential or model name; those come only from the Session.

`--task-description` is the one option that changes what the researcher is asked
to do: the file's text (at most 32 KiB, no NUL bytes) becomes the engine
manifest's inline `task`, which the engine pins as the researcher's first user
message instead of the task package's default description. It is execution
input, not a research decision: the operator passes it unchanged, the receipt
records it as part of the frozen grant, and `deliver` rejects the option. A run
that omits it is unchanged. Round 22's run F uses it to state the Agent's
already-authored command sequence and to forbid solver rewrites; the plan
artifact remains the research decision and is linked separately.

1. Opens a real `SessionStore` at the isolated data directory the operator names
   and resolves the Project and Session there — no in-memory identity adapter.
2. Resolves the Session's *effective* model through the normal settings layers
   (`resolveRuntimeSettings(sessionId).effective.modelId` and
   `.sources.modelId`), reads the profile with `getModel`, and reads the
   credential with `getModelApiToken`, which already applies the profile's own
   token or its provider's shared token. Legacy secret tables and the engine's
   own registry are not consulted.
3. Resolves the profile's proxy policy for that endpoint with the same helper
   SD's model calls use (`resolveProxy` + `resolveProxyForUrl`), so an
   `environment` policy is a real route decision rather than an assumption.
4. Freezes that selection for the run. Validation finishes before any process
   starts, and a profile the pilot cannot carry is refused with a stable reason:
   another API protocol, a variant other than `openai`/`qwen`, an explicit
   thinking mode on the `qwen` variant, an unusable credential, endpoint or
   proxy, a Project and Session that do not own each other, or options that would
   put the private root inside the work dir or the seed.
5. Generates the engine's model input from that frozen selection into a private
   run-scoped directory (0700; files 0600): `models.json` (one alias, the
   provider model name, its endpoint and credential), `pilot-settings.json`
   (both agent roles bound to that alias) and `engine-config.yaml` (the pinned
   engine's `default.yaml`, plus the settings and the task interpreter). This is
   generated execution input, not a second user-maintained catalog. The private
   root must be outside the work dir and the seed, and the file holding the
   credential never enters the workspace, the dataset or the receipt.
6. Derives one launch manifest from the explicit pilot options: the run id, the
   bounded research and report budgets, one worker with merge disabled, the
   stage-capture allowance, the isolated input directory (the seed) and the
   run-scoped engine config.
7. Starts the run through the engine's own control entry
   (`scienceflow.runtime.parallel.control.start_run`) from a fixed program text
   inside the module, polls the engine's own record, and stops the run through
   the engine's own `stop_run` if the operator allowance is reached. The
   launcher makes no model call; research and reporting run inside the engine.
8. Registers the resulting run for the original persisted Session through
   `createScienceFlowRegistrationService` (real identity and write gates, the
   store's own registration table), then reads it back through
   `createScienceFlowRunSnapshotQuery` (the real reader subprocess) and
   `projectScienceFlowRunSnapshot` (the public DTO allow-list).
9. Writes a credential-free receipt: Project and Session, the frozen model
   selection and the layer it came from, the engine run and its outcome, the
   registration row, the public snapshot, the engine's own stage rows (score,
   artifact digest, parent stage) and the provider usage the engine recorded.
   Those call and token figures are the engine's logs, not a monetary or hard
   provider-token cap.

An engine run id names one run. Both the engine and this command refuse a second
`launch` for an existing run id. That refusal is returned and never written: the
receipt at the path may be the only record of the model and grant the run was
actually started with. Before the paid launch the command writes a minimal
frozen receipt (identity, selection, grant and generated-input paths). If the
launcher itself throws, the receipt is replaced by `launch-unknown`, which keeps
the run id but does not assert that the engine started or did not. If
registration or readback then fails, that receipt is replaced by one that keeps
those facts and records the failed step and run id, and a later `attach`
completes registration and readback from it without another launch. A Session
that is already read-only is refused before any credential file or process
exists; the write gate is checked again after the launch, so a Session that
becomes read-only mid-run leaves the same recoverable receipt rather than
nothing. `attach` re-registers and re-reads an existing run from its receipt and
keeps the launch-time model selection even if the Session's model changed
afterwards.

### 8.2 What the round-20 runs showed

Three authorized attempts were made, one per run id. The third closed the
research loop end to end through the checked-in command:

| Run | Seed | Outcome | Engine stages | Provider usage |
| --- | --- | --- | --- | --- |
| `round20-circle-packing-a` | round-19 incumbent and solver | engine `completed`, 854.5 s; the chain registered and read back S01 | S01 (seeded) `2.61661905326`; no new candidate was written | 23 calls, 351,940 in / 37,536 out |
| `round20-circle-packing-b` | same seed plus sequencing guidance | engine `failed` after 142.3 s: the provider returned reasoning without an answer or tool call, and the engine does not retry that (`UnusableResponseError`) | none | 6 calls, 68,112 in / 6,700 out |
| `round20-circle-packing-c` | same seed plus the engine's per-turn tool-call requirement | engine `stopped` at the operator's 900 s allowance with its report ready; 910.2 s | S01 seeded `2.61661905326`; S02 `2.623651703004654` (parent S01); S03 `2.6239750175348147` (parent S02); all valid and gate-accepted | 36 calls, 959,102 in / 42,601 out |

Attempt c is the loop:

- The model materialized the incumbent in one short command (S01), then wrote its
  own solver (`solver/pack_lib.py`, `local.py`, `search.py`, `evolve.py`,
  `driver.py`) and ran bounded experiments that wrote the artifact. The seeded
  `prior_solver` and `submit.py` were available and read; the model chose its own
  solver.
- 30 model requests carried an engine stage block: 21 carried S01, 7 carried
  S01 and S02, and 2 carried S01, S02 and S03. The first S01-, S02- and
  S03-carrying requests follow their committed stage rows by 11 ms, 19 ms and
  20 ms.
- The public DTO for the same persisted Session reads `status stopped`,
  `phase finished`, `reportedMetric radii_sum 2.6239750175348147`, candidate
  sha `ec060f2f…`, `digestVerified: true`, `stageId S03`; the registration row
  was created.
- Against the seed: S03 − S01 = +0.007355964 (+0.28%), `0.9952 → 0.9958` of the
  declared benchmark 2.635. Improvement is reported here, not required by the
  loop.
- Artifact digests: S01 `1401d398…`, S02 `07f4b73a…`, S03 `ec060f2f…` (full
  values in the receipts).

The engine ended attempt c `stopped` because the operator's 900 s process
allowance fired while research was still running: its research phase had run
908 s, past the configured 840 s research budget. This document does not claim
why the engine's own budget did not end it first. The report had already been
produced (`reportStatus ready`) and every captured stage was committed. The supervisor was
not alive after the launcher returned and no task process was left running.

The earlier attempts are kept as they ran: attempt a shows the chain working with
only the seeded stage (the research half missing), and attempt b is the engine's
handling of an unusable provider response. Neither is presented as a closed loop.

The invocation used `--private-root` outside the repository,
`--refuse-package-install`, one CPU worker, and the proxy environment unset so
the authorized gateway was reached directly (the resolved route was `direct`;
with a proxy configured, the same code carries it through the engine's
`use_proxy` path).

### 8.3 What remains experimental

- The entry is local and internal: no HTTP route, no Runner gateway, no sandbox
  path. `canStart` stays `false` and the five blockers stay in place.
- The engine's workspace path guard is the tool boundary. Generated code runs in
  the task workspace through the engine's normal tools; this is not
  hostile-code isolation.
- The generated registry carries one model with one endpoint and
  `reasoning_replay: preserve`. Multi-endpoint routing, per-role models, budget
  tables and a general protocol adapter are not implemented; unsupported
  profiles are refused, never silently reduced.
- No monetary budget, provider-token ledger or general resume/recovery platform
  is claimed. The allowances are scheduling limits enforced by the operator and
  by the engine's own budget. A run can end `stopped` at the operator allowance,
  as attempt c did, rather than by finishing its own budget.
- The engine does not retry a provider response that carries reasoning but no
  answer or tool call; it fails the worker, as attempt b showed. Recovering from
  that means a new attempt, not a silent retry inside this command.

## 9. Round 21: delivering the result into the Session

Rounds 19–20 left the result in an operator receipt and the engine's directories.
Round 21 adds one operation that publishes an existing run's selected result as
ordinary Session artifacts, so the Session's own Agent can read it.

### 9.1 The `deliver` operation

```sh
node --import tsx services/api/src/scienceflow/research-pilot-cli.ts deliver \
  --data-dir <isolated store> --project <id> --session <id> \
  --run-id <engine run id> --work-dir <pilot dir> \
  --python <interpreter> --reader-script services/scienceflow-reader/snapshot.py \
  [--task circle-packing] [--launch-receipt <pilot receipt>] [--record <path>]
```

It accepts no score and no digest, and it never starts a run:

1. Resolves the Project/Session in the named `SessionStore`, refuses a Session
   that is read-only (`assertSessionWritable`), and re-registers the run through
   `createScienceFlowRegistrationService` (the same row, so a second delivery
   reports `existing`).
2. Reads the run through `createScienceFlowRunSnapshotQuery` with the same
   trusted binding the pilot uses, and projects it through the DTO allow-list.
3. Takes the selected captured stage from that snapshot. The reader has already
   resolved the artifact inside the allowed task root and hashed it; delivery
   re-checks the path, reads the bytes once and requires them to match the
   recorded digest. A missing file, a path outside the root, a digest mismatch
   or no captured candidate is a returned failure — never an empty artifact or
   a substituted score. The operator receipt is read only for the model identity
   and the launch lifecycle it recorded, and only when it names this Project,
   Session and run; it is never the artifact locator.
4. Publishes two artifacts through `store.createArtifactVersion` with
   `origin: "server_generated"`: the selected file unchanged (json) and a
   factual result-note.md built from the DTO, the engine's stage ledger and the
   receipt facts. The note depends on the solution version
   (`inputArtifactVersionIds`), and carries no host paths, endpoints,
   credentials or model interpretation.
5. Reuses an existing version of the same artifact whose bytes are identical, so
   repeating a delivery adds no version, and a retry after a partial publication
   finishes only the missing output.

The record it writes (`--record`, default `<work-dir>/delivery.json`) holds the
registration, the public snapshot, the selected stage and the artifact/version
references. The run's own files are never modified.

### 9.2 What the Session Agent did with it

The artifacts are ordinary catalog entries, so the existing `list_artifacts`,
`read_artifact` and `materialize_artifact` tools expose them with no new wiring.
In round 21 the persisted round-20 Session was driven through the product's own
service composition (`createQueuedRun` + `scheduleSessionRuns`, no HTTP listener
and no browser) with its frozen Qwen3.8-Flash profile. Asked "what did this
experiment establish, what is the selected solution, and what experiment should
we try next?", the Agent called `list_artifacts`, read both delivered versions by
artifact id and version, materialized the solution into its workspace, and
answered from them: it named S03 = 2.6239750175348147, labelled S01 as the
carried-in seed, reported the `stopped` lifecycle and the operator allowance,
cited both artifact versions, and proposed a seeded follow-up with an explicit
acceptance margin while stating that it had not been run. Its shell verification
attempts were declined by the Session's approval mode, and it said so instead of
inventing the numbers. A model-client compatibility fix was needed first: this
gateway streams Chat Completions tool calls without ids, so the parser now mints
a correlation id and records it in the turn's stream diagnostics
(`docs/en/model-api-compatibility.md`); Responses and Messages keep the strict
check.

### 9.3 What delivery does not claim

- It is still an operator entry: no HTTP route, no Runner gateway, no sandbox
  path. `canStart` stays `false` and the five blockers are unchanged.
- The score is the engine's; delivery re-reads the bytes and digest but does not
  re-evaluate the solution, and the note says so.
- Selection is the best *captured* stage in the engine's ledger. Evaluated
  candidates that never became a stage are not representable and are not
  delivered.
- The note is a deterministic factual record. Any interpretation the Agent adds
  on top of it is separate from the delivered artifact, and this document does
  not claim a UI journey was run.

## 10. Round 22: the Agent's plan becomes an evaluated experiment

Rounds 19–21 left the loop at "the Session Agent can read a delivered result".
Round 22 closes the research decision: a real Session Agent authors one
hypothesis and experiment as an ordinary Session artifact; that fixed plan and
the fixed incumbent are carried into a new managed run; every captured stage is
delivered back with its digest; and a second real Agent conversation compares
intended versus executed method and states whether the evidence supports,
contradicts or leaves the hypothesis unresolved.

### 10.1 The planning conversation

The Session's own service composition (`createQueuedRun` +
`scheduleSessionRuns`, no HTTP listener and no browser) ran one conversation in
the isolated store with the Session's frozen Qwen3.8-Flash profile. The prompt
gave only the task contract, the bounded environment, and two corrections to the
earlier analysis (the interval from S03 to the stop was about 17 s, not 2–3
minutes; the note's "twice the largest step" margin was a template suggestion, not
a requirement). It supplied no hypothesis. The artifact versions the answer cites
(`7e04c23b…` / version `6dbe930a…`, `158312ff…` / version `fd6f08fd…`) had been
read through `list_artifacts` / `read_artifact` by an earlier Agent turn in the
same Session (run `5dd41e1b…`, finished 2026-11-15T09:12:42Z); that turn's tool
results are part of the planning run's model input. The planning run itself called
only `check_runner` (Runner unreachable) and `run_shell`, which the Session's
approval mode declined, and it answered in 177.7 s (run
`b3aba5c1-4504-4fc9-af19-fe6ca8864b6e`, `completed`). Its answer therefore reused
context already in the conversation; it did not re-read the artifacts with tools
in that turn, and the answer does not claim it did.

The answer is preserved unchanged as `scienceflow/round22/experiment-plan.md`,
version `c031031b-53bb-437e-8c07-89cd34adf0b7` (4,400 bytes, sha256
`7159960e…`). Its provenance records that it is Agent-authored
(`agentAuthored`, the Agent run and message ids, the model), and its input
versions are the two artifact versions it cites. It proposes one change — an
`evict → re-jam → regrow` operator added to a rattle/inflate polish kernel — and
one controlled comparison: Arm A polish-only, then Arm B the same polish plus one
distinct evictee per command, at the same allowance, with validity checked first
and support only when Arm B's best exceeds Arm A's and the incumbent by a stated
margin.

After the review and the offline precheck, a second planning conversation
(run `3d9b8663-085e-4944-becf-d7944821cd81`, `completed`, 254.6 s) revised the
plan. The prompt gave the four runs' outcomes, the precheck's finding that the
frozen kernel has no polish-only arm, and the executable envelope (one worker, at
most eight searches, one fixed start, an arm runner). The Agent chose to narrow
the experiment explicitly to an **operator-routing ablation** inside the mixed
kernel: the eviction draw routed to `evict → re-jam → regrow` (ARM=B) versus the
same draw falling through to the kernel's next operator (ARM=A); it stated that
this does not test the polish-only hypothesis. The revision specifies four
searches per arm at 45 s with paired seeds 101–104, the same fixed start, one
submit per arm, a reset between arms, validity first, and support only if
`B_best − A_best ≥ 0.0005` and `B_i ≥ A_i` on at least three of the four pairs.
Both of its `read_artifact` calls failed because it passed the version id where a
numeric version is required; the answer says so, and the plan rests on the
operator's summary. It is recorded unchanged as version 2 of
`scienceflow/round22/experiment-plan.md` (`34ccf482…`, 2,439 bytes, sha256
`a6e3d3e4…`), with the version-1 plan and the prior interpretation as inputs.

### 10.2 The bounded runs

The seed was materialized from the store's CAS by digest, not retyped: the
incumbent bytes (`ec060f2f…`, 1655 bytes), the plan bytes (`7159960e…`, 4400
bytes), the engine's own evaluation of those incumbent bytes from the previous
run, the model-written solver from that run, and the operator submission helper.
A manifest records every seed file's digest. The corrected run's seed also
carries the kernel the first round-22 run wrote, with its source run named, and
the third run's seed fixes the arm order and forbids nested multiprocessing. The
revised package `seed-e` carries plan version 2 (`a6e3d3e4…`), the same frozen
kernel with the one-line gate, a runner with `search` and `submit` modes, the
same incumbent bytes as `start_solution.json`, and the eight paired commands
from the revised plan.

| Run | Allowance outcome | Captured stages | Selected best |
| --- | --- | --- | --- |
| `round22-circle-packing-a` | `completed`, 880.8 s, research finished | S01 2.631640653898, S02 2.6325585398458324, S03 2.6329437164770155, S04 2.633134264465223 | S04 (`178312f7…`), +0.009159 over the seed |
| `round22-circle-packing-b` | `completed`, 844.7 s, research finished | S01 2.6239750175348147 (the seed reproduced) | S01 = the seed, no new candidate |
| `round22-circle-packing-c` | `failed` after 60.3 s: the provider returned reasoning without an answer or tool call (`UnusableResponseError`) | none committed (S01 was evaluated but the run failed before the ledger row) | none |
| `round22-circle-packing-d` | `completed`, 875.0 s, research finished | S01 2.6239750175348147 (the seed reproduced) | S01 = the seed, no new candidate |
| `round22-circle-packing-e` | `stopped` at the operator's 900 s allowance, 910.3 s; research stopped, report ready | S01 2.6239750175348147 (the seed reproduced) | S01 = the seed, no arm candidate |
| `round22-circle-packing-f` | `failed` after 198.3 s: the provider returned reasoning without an answer or tool call (`UnusableResponseError`) at iteration 9 | none committed; the workspace held only the seed copy | none |
| `round22-circle-packing-g` | `stopped` at the operator's 900 s allowance, 909.7 s; research stopped | S01 2.6239750175348147 (the seed reproduced) | S01 = the seed; no trial log |
| `round22-circle-packing-h` | `failed` after 432.3 s: the provider failed at iteration 22, after the B submit | S01 seed 2.6239750175348147; S02 Arm A best 2.624072517069772 | S02 (`df01c4a8…`); Arm B best submitted but not captured |

Run A's researcher read the plan at t+5 s and wrote its own solver family; its
solvers include the eviction operator, but mixed with multistart, global passes
and other escape moves, and its first captured stage was already a new candidate,
so the plan's Arm A baseline was never captured. Run B reproduced the seed as
S01, then wrote its own solver files; its first long search command was cut with
about 20 s left in the research budget, and no changed artifact was scored. Run C
followed the fixed sequence at first — it copied the seed and the engine evaluated
it as S01 — but the eighth provider turn ended the worker before any arm command
committed a stage. Run D reproduced the seed, then rewrote its own solver and
never ran an arm command. Run E, after the revised plan, did the reconnaissance
and copied the seed (S01), but then copied `solver3.py` into the workspace root
and started it in the background at 600 s with 15 workers, wrote a new
`solver4.py`, and started that in the background too. It never called
`run_arm.py`, wrote no trial log, and submitted no arm result; the engine stopped
it at the operator allowance with only S01 captured. The workspace artifact
changed after that stage but was never evaluated, so it is not counted.

Run F pinned the Agent's command sequence as the task description and copied the
seed, but the provider returned reasoning without an answer or tool call at
iteration 9, so no search ran and no stage was committed. Run G reused the same
package without the pinned text and deviated again: it wrote its own
`packing_solver.py`, produced no trial log, and reached the allowance with only
S01. Run H used the same package with the pinned task text actually carried
through the launcher (the CLI had dropped it on the first attempt), and the
researcher then executed the plan: eight labeled searches at 45 s, two submits,
a reset between arms, and no solver authoring. The engine captured S01 (seed)
and S02 (Arm A best `2.624072517069772`) before the provider failed at iteration
22, immediately after the Arm B submit; the Arm B best (`2.624146247766`, from
candidate `B_1`) exists in the workspace and is delivered as
`submitted_not_captured`, with its score from the unchanged task evaluator run
offline.

Later runs are recorded with their deviations rather than smoothed: runs A, B,
D, E and G used nested `multiprocessing` pools, background processes or their own
solver code, which exceeds the operator's single-engine-worker allowance in
spirit though not the engine's evaluation; runs A–D were not stopped by the
900 s allowance, runs E and G were, and runs F and H died on an unusable provider
response. The revised ablation itself was carried out only in run H.

### 10.3 Delivery with the plan, the incumbent and every attempt

`deliver` gained three optional inputs; its existing behaviour is unchanged when
they are absent:

- `--plan-version <version-id>` and `--incumbent-version <version-id>` must be
  live artifact versions of the same Session. Delivery reads and re-hashes them,
  links them to the note through `inputArtifactVersionIds`, and never authors or
  rewrites their content.
- `--attempts` publishes every captured stage as its own artifact
  (`scienceflow/<run>/attempts/<stage>/solution.json`), re-checking the engine's
  recorded digest. A stage is called the carried seed only when its digest equals
  the linked incumbent; a first stage with a different digest is `first_captured`;
  later stages are `evaluated_attempt`; a stage whose bytes cannot be read or
  verified is recorded `unresolved` with a stable reason instead of being dropped
  or replaced.

The note gains a `## Linked experiment plan` section naming both fixed versions
and, when a plan is linked, stops substituting the old template's "proposed next
experiment" paragraph for the Agent's own plan. The section states what the link
is — a fixed artifact version, not restated or rewritten — and what it is not:
linking does not establish that the researcher read or followed the plan, so
method compliance has to be read from the engine's interaction logs and the
evaluated stages. Run A delivered its solution
(version `9b53b2e8…`), a note (version `25bddde3…`), and attempts `d49bc970…`
(S01 `first_captured`), `b35803f0…` (S02), `2f6f1fa3…` (S03). Run B delivered the
seed bytes as its selected solution (version `e181e53c…`), a note (`b34869ef…`)
and S01 as the selected carried seed. Run E delivered the seed bytes as the
selected solution (`dc0b30ed…` / version `5c79b5ab…`), a note (`15c88be2…` /
version `21d88195…`) linking plan version 2, and S01 as the selected carried
seed; there was no arm stage to publish. Run H delivered S02 (`1b4274bd…`) as
the selected solution, a note (`c61957bf…`) linking plan version 2, and attempts
S01 (`carried_seed`) and S02 (`evaluated_attempt`, selected). Its Arm B best is
not an engine stage: the operator published the submitted bytes as
`scienceflow/round22-circle-packing-h/attempts/B_best/solution.json`
(`f9254504…`, role `submitted_not_captured`) and the eight candidates' evaluator
results as
`scienceflow/round22-circle-packing-h/candidate-evaluations.md` (`3884178d…`),
both labelled operator-extracted. One correction is in the record:
delivery v1 labelled run A's S01 as the carried seed from the old parent-only
rule; that attempt artifact was marked deleted and the stage republished with
the corrected role, and the correction file keeps the reason.

An operator-extracted execution summary (from the engine's per-stage tool logs,
the worker's main log and the workspace files) is published per run as an
ordinary artifact, so the interpretation can see what actually ran without
exposing host paths. Two incomplete summary versions were corrected; the final
versions are `89e818af…` (run A), `bbd2394d…` (run B) and `9387b8da…` (run E),
whose summary quotes the backgrounded `solver3.py 600 15 5000` and the new
`solver4.py`.

### 10.4 The interpretation and its verdict

A second real Agent conversation (run `5a4d98c2-68a9-4db2-904c-51993adf7f38`,
50.1 s, six tool calls) read the plan, both notes and both execution summaries
through the normal tools; when run D's evidence arrived, an authorized follow-up
conversation (run `aa10a55f-d5f2-4a68-b6d7-7e15aee79c2c`, 231.6 s, three artifact
reads) read the plan, the three notes and the two run summaries and kept the same
verdict. Its verdict is **unresolved**: run A's selected best is
+0.009159 over the incumbent (about 18× the plan's margin), but no run carried out
the Arm A / Arm B control, and run A's gain is confounded with solver rewrites and
other operators, so it is not evidence for the specific hypothesis. It proposes
one next action: run the same plan with the arm separation enforced.

The answer is preserved as `scienceflow/round22/experiment-interpretation.md`,
labelled Agent-authored, with a separate labelled operator correction per
version; the current version is `a928052e…` (version 2, 231.6 s conversation).
The correction records that the Agent first read summary versions that omitted
post-stage commands, that run B did attempt optimization, the exact run
lifecycles (880.8 s, 844.7 s and 875.0 s, all research-completed), run C's provider
failure, and the nested-pool deviation. Artifact-level `originMeta` is fixed when
the artifact is first published, so it names the first interpretation run; the
version 2 text names the run that produced it. Two conversations that reached the authorized five-minute limit
(`dc090802…`, `613404f6…`) are recorded as `interrupted` with the reason; no
answer is attributed to them.

After run E, one more authorized conversation (run
`e99478d9-4949-45b1-bb7f-c719aacd2f3e`, 152.3 s, three successful artifact reads)
compared plan version 2, run E's note and run E's execution summary. Its verdict
is again **unresolved**: `run_arm.py` was never called, there were zero searches,
zero submits and no trial log; the only plan step performed was copying the seed;
the selected best is the unchanged seed; and the backgrounded solver runs were
never scored. It proposes one next action — have the harness pre-execute the
reset, the eight searches and the two submits as one bounded script before the
first model turn — and explicitly says that this requires the researcher to
execute the plan, not merely to receive it. The answer is version 3 of
`scienceflow/round22/experiment-interpretation.md` (`f3eaebfd…`, 2,284 bytes),
with plan version 2, the run E note and the run E summary as inputs.

After run H, one more conversation (run
`c54241e7-7d1b-41d5-bb7b-1ab492d68170`, 255.4 s, four successful artifact reads)
compared plan version 2, run H's note, run H's execution summary and the operator
candidate evaluations. Its verdict is **contradicted under the plan's rule**: the
eight searches and both submits ran at the same fixed start with paired seeds
and equal 45 s budgets, Arm A's best is the engine-captured S02
`2.624072517070`, Arm B's best is the offline-scored `2.624146247766`, and
`B_best − A_best = 7.37307e-5 < 5.0e-4`; `B_i ≥ A_i` on three of four pairs
passes, so the conjunction fails. The missing engine capture of the Arm B best
does not change the verdict; the delta fails either way. The answer is version 4
of `scienceflow/round22/experiment-interpretation.md` (`6d0d4b20…`, 2,009
bytes), with plan version 2, the run H note, the run H summary, the candidate
evaluations and the Arm B bytes as inputs.

### 10.5 What round 22 establishes, and what it does not

Established in this isolated operator scope: a real Agent authored plan is a
fixed Session artifact, and after the review it authored a revised, narrower plan
as version 2; the same persisted Session's SD-selected model drove eight managed
runs from the exact incumbent and plan bytes; the plan reached the researcher's
context and tool use; four new candidates were engine-evaluated in run A; every
captured stage is separately delivered with its digest and role; run B's, run E's
and run G's selected best is the seed and their null results are published rather
than hidden; run H executed the revised paired ablation and produced an
engine-captured new candidate (S02); and real follow-up Agents read the evidence
and gave verdicts, the last one a negative result under the plan's rule.

Not established: the original polish-only hypothesis. No run implemented or
executed a polish-only Arm A, so that hypothesis remains untested. The revised
routing ablation was executed only in run H: eight paired searches at one fixed
start and equal budgets, with Arm A's best engine-captured and Arm B's best
submitted but not captured because the provider failed after the submit. Its
result does not meet the plan's support rule (`7.373e-5 < 5.0e-4`), so it is a
negative result, not support. The earlier runs' failures are recorded above: an
unusable provider response ended run C before any arm command committed; runs D,
E and G rewrote or bypassed the runner; run F died on the same provider failure
before searching. This document does not claim statistical significance, a
benchmark campaign, a public research start, a HTTP/browser/Runner journey, or
isolation of hostile code.

### 10.6 Offline mechanical precheck (no engine run)

After the review, the operator ran the planned arm sequence offline against a
frozen task package, without an engine, model or network call, to establish that
the command sequence is mechanically executable before spending another run.
The package `seed-d` carries the same incumbent and plan bytes, the model-written
`solver3.py` with one gated operator —
`elif u < 0.62 and os.environ.get("ARM") == "B":`, recorded as a one-hunk diff —
and `run_arm.py`, which refuses a kernel whose sha256 is not the frozen value,
runs it with `nw=1`, checks the artifact with the carried strict checker, and
appends one row (arm, index, seed, elapsed, `radii_sum`, status, exit code) to
`artifacts/trial_log.tsv`. It decides nothing about the search.

With a 12 s command budget (the run's 55 s budget is not exercised here), all
eight commands exited 0 after about 9 s each, wrote a strictly valid artifact,
appended exactly one valid trial row, and kept at most one descendant process
(the kernel with `nw=1`). An in-process counter recorded zero `evict_rejam`
calls under `ARM=A` and three under `ARM=B` in a two-second search, so the gate
selects the operator as intended. Each command started from the artifact the
previous command left, exactly as the seed specifies.

This validates mechanics only. It does not evaluate a stage, does not compare
arms at equal allowance, and its short-budget numbers are not evidence about the
plan's hypothesis. It also surfaced one limitation to carry into any
interpretation: gating the evict draw does not make Arm A "polish only" — the
kernel keeps its other operators, and in Arm A the gated draw falls through to
the next operator in the same kernel. A future run with this package compares
"the kernel without the evict draw" against "the kernel with it", which is
narrower than the plan's wording. The operator did not rewrite the kernel to
close that gap; that decision belongs to the Agent.

A formal comparison also needs more than this package as it stands. Each
command started from the artifact the previous one left, so a later arm's higher
score cannot be attributed to the operator; an arm comparison needs both arms to
start from the same fixed artifact, with equal per-command budget, equal command
counts and one logging rule. And the Agent has to decide whether the hypothesis
is still the planned polish-only comparison or is explicitly narrowed to an
ablation of the evict draw inside the existing mixed kernel. Until that decision
and those controls exist, `seed-d`'s gate and runner are reusable infrastructure,
not a completed controlled experiment.

After the Agent narrowed the plan to the routing ablation (10.1), a second
offline precheck (`seed-e`) exercised the paired sequence: four searches per arm
at a 5 s budget from the same fixed start, one submit per arm and a reset. All
15 checks passed: eight searches exited 0 with valid candidates, each appended
exactly one trial row, each used at most one descendant process, the eight
candidates were computed independently, each submit chose its arm's best, and
the reset restored the first stage's digest. This is still mechanics only: the
short-budget scores are not evidence, and the paired comparison has never been
executed in an engine run. Run E received this package and did not call the
runner at all (10.2).

The run-F/H package adds one more control: it pins the Agent's already-authored
command sequence as the engine task text with `--task-description` (8.1),
forbids solver authoring and background processes in that text, and uses the
same frozen kernel and runner. Run H is the first run that followed the sequence
end to end; the option is execution input, not a research decision, and the plan
artifact remains the Agent's.

## 11. What this pilot does not claim

- No Runner gateway, sandbox or `canStart` change. `canStart` stays `false` and
  the five blockers stay in place.
- Generated code ran in the task workspace through the engine's normal tools.
  The agent's tool boundary is the engine's workspace path guard, not an OS
  sandbox: this is an operator pilot, with no claim of hostile-code isolation,
  enforced monetary budget or provider-token hard cap.
- One worker, CPU only, one task package. No benchmark campaign, no dataset, no
  general resume, no multi-tenant credentials, no budget tables.
- No user-visible HTTP or browser journey is claimed.
- Package installation was disabled for these runs by operator control; the
  shims are part of the pilot's environment, not of the engine.
- Candidate C is an engine-evaluated, gate-accepted, archived candidate, not a
  captured stage. The stage cap that excluded it is a run setting, not an engine
  result.
- The seeded incumbent A was produced by the model in run 3; run 5's model
  re-materialized it, and B and C are the model's own work in run 5.

## 12. Where the evidence lives

Ignored local artifacts under `.tmp/r/round19/` (never committed):

- `pilot/state/scienceflow/managed_runs/<run-id>/control.json` — the run record.
- `pilot/runs/<run-id>/circle-packing/` — task state: `task_logs/`
  (`lhr_stage_performance.csv`, `lhr_state.json`), `workers/w00/logs/`
  (`lhr_stage_lifecycle_events.jsonl`, `checkpoints/artifact_archive.jsonl`,
  `artifact_snapshots/`, `agent_provider_calls.jsonl`,
  `agent_runtime_audit/agent_runtime_operations/`, interaction logs),
  `workers/w00/workspace/` (model-authored code and `artifacts/`),
  `workers/w00/snapshots/W00-L01-S*/`, `merge/`, `report.md`.
- `pilot/launcher-evidence*.json` — allowance, process samples, termination.
- `pilot/evidence-<run-id>.json` — stage rows, lifecycle, call timeline, artifacts.
- `pilot/candidate-a/`, `pilot/candidate-b/`, `pilot/candidate-c/` — immutable
  candidate records (artifact, evaluator result, provenance, model code).
- `pilot/seed-round19d/` — the seed carried into runs 4–5.
- `pilot/engine-evaluation-<run-id>.json` — the engine backend's evaluation of
  the workspace artifact.
- `pilot/sd-readback/<run-id>/readback.json` — registration + reader + DTO.
- `compare_stages.py`, `verify_stage_feedback.py`, `extract_evidence.py` —
  read-only analysis scripts used for the tables above.

Round 20 evidence also lives under the ignored `.tmp/r/round20/` directory of the
development worktree: `pilot/receipt-<run>.json` are the operator receipts,
`pilot/evidence-<run>.json` holds the stage rows, the model requests that
carried an engine stage block, and the recorded provider usage,
`pilot/runs/<run>/circle-packing/` is the engine's own task state, and
`seed-round20b/` is the second attempt's seed with its sequencing guidance. The
generated private inputs — the engine model registry, the pilot settings, the
engine config and the credential — live outside the repository in a 0700
directory and are never copied into evidence.

Round 21 evidence lives under the ignored `.tmp/r/round21/` directory: `store/`
is an isolated copy of the round-20 store (same Project, Session and registration
identity), `evidence/delivery-*.json` are delivery records taken from the final
code, `evidence/agent-run-*.json` hold the Agent's tool calls, permission
decisions and answer, and `agent-harness.mts` is the local service-level harness
that drove the conversation.

Round 22 evidence lives under the ignored `.tmp/r/round22/` directory: `store/`
is a consistent isolated copy of the round-21 store (same Project, Session,
model and prior artifact identities), `evidence/agent-run-*.json` hold the
planning and interpretation conversations, including the revised-plan run
(`agent-run-7.json`) and the capped attempt (`agent-run-6.json`, marked
`interrupted`), `evidence/planning-context-provenance.json` records the planning
run's own tool calls and the predecessor turn's artifact reads,
`evidence/delivery-*.json` are the delivery records, `seed/`, `seed-b/`,
`seed-c/`, `seed-d/`, `seed-e/` and `seed-f/` are the seeds with their manifests,
`evidence/execution-summary-*.json` and `evidence/interpretation-artifact*.json`
are the published supporting artifacts' metadata,
`evidence/run-a-attempt-correction.json` records the role correction,
`evidence/plan-v2-artifact.json`, `evidence/interpretation-artifact-v3.json` and
`evidence/interpretation-artifact-v4.json` identify the revised plan and the run
E/H interpretations, `evidence/run-f-failure.json` and
`evidence/run-g-deviation.json` record those runs, and
`evidence/run-h-candidate-evaluations.json` plus
`evidence/run-h-evidence-artifacts.json` record the offline evaluator results and
the published Arm B bytes. `evidence/verification.json` re-derives the chain's 57
invariants from the store, CAS and records. The prechecks add `seed-d`/`seed-e`
manifests, `evidence/precheck-results.json`, `evidence/precheck-e-results.json`
and the ignored `precheck/` and `precheck-e/` workspaces. The engine's own task
state is under `pilot/runs/<run>/circle-packing/`, and the private generated
model inputs stay outside the repository in a 0700 directory.
