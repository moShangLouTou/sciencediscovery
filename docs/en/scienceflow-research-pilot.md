# ScienceFlow research pilot: one evaluated circle-packing loop

Status: operator-run research pilot (rounds 19–20). Round 19 executed five
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
round-19 record and their results are not rewritten.

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
  --seed <traced seed dir> [--refuse-package-install] [--receipt <path>]
```

The same command with `attach` takes the same options, skips the launch, and
re-registers/re-reads the run its receipt already records. Nothing in the options
selects a provider, credential or model name; those come only from the Session.

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
`launch` for an existing run id. `attach` re-registers and re-reads an existing
run from its receipt without another paid launch, and keeps the launch-time
model selection even if the Session's model changed afterwards.

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

## 9. What this pilot does not claim

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

## 10. Where the evidence lives

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
