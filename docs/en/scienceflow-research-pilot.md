# ScienceFlow research pilot: one evaluated circle-packing loop

Status: operator-run research pilot (round 19). This note records what was
actually executed, what the engine and the model did, and what the result does
and does not support. It is evidence of bounded internal runs, not a product
capability.

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
<python-3.12.12-venv>/bin/python launch_pilot.py <manifest>.yaml <run-id>
```

`launch_pilot.py` only wraps the allowance around the engine's own entry: it
calls `scienceflow.runtime.parallel.control.start_run(manifest)`, polls
`get_run`, samples the engine processes it spawned, and would call `stop_run` if
the run were still alive at 600 s. Research and reporting themselves run inside
the engine's detached supervisor; the launcher makes no model call.

The manifest fixes one worker, CPU only, the research budget, a hard report
budget and an empty task-owned input directory, and points `config` at a wrapper
that includes the pinned engine `default.yaml` followed by the private pilot
settings (model alias, token limits, HTTP timeout). The wrapper exists so the
engine's own profile defaults (context window, tool limits, sandbox, `lnr`
defaults) stay in effect while the approved model configuration overrides only
the model roles and limits.

Redacted manifest of the run that produced the reported candidate:

```yaml
defaults:
  config: <pilot>/engine-config-b.yaml
  workspace_base: <pilot>/runs
  input_data_dir: <pilot>/inputs-empty
  gpu_list: cpu
  scienceflow_interaction_log_full: true
  scienceflow_bash_timeout_sec: 60
tasks:
  - exp_id: circle-packing
    run_id: round19-circle-packing-c
lnr:
  num_workers: 1
  merge_enabled: false
  wall_clock_budget_sec: 540
  max_steps: 12
  stage_capture_max_count: 2
report_budget_sec: 60
```

## 4. Three attempts, and what each one taught

All corrections were configuration-only; no engine or SD source was changed.

| Run | Change | Outcome |
| --- | --- | --- |
| 1 | initial manifest | 244 s, no candidate. With `input_data_dir` unset the engine defaulted to `.` and `prepare_workspace_dataset_flat` symlinked every entry of the operator's pilot directory into `workspace/dataset/`; the LLM merge reserve also cut the single worker's budget from 540 s to 240 s. |
| 2 | isolated empty input dir; `merge_enabled: false` | 542 s, no candidate. The worker now had the full 540 s, but the model spent it on five package-install attempts (`pip`/`uv`, one backgrounded with `nohup`), then wrote a numpy-based solver that could never import. |
| 3 | plus `evaluator.command.python_executable`, install-refusing PATH shims, 60 s bash timeout | 543 s, one valid candidate at `radii_sum = 2.6166` (`benchmark_ratio = 0.993`). |

Run 3's two additions exist because of what run 2 showed. With
`evaluator.command.python_executable` unset, `task_python_executable()` resolves
to `None`, so the worker's "Task runtime contract" prompt drops both the
interpreter line and the engine's own "do not install task dependencies into the
controller `.venv` or a new ad-hoc workspace environment" guidance; the model
then had no supported interpreter to use or reason about. The shims make `uv`,
`pip` and `pip3` exit non-zero with a one-line notice, which enforces the pilot's
own rule that nothing may be installed, instead of leaving an installation that
cannot complete to absorb the budget.

## 5. What the engine actually spawned

Sampled from `/proc` while the runs were live (not reconstructed afterwards):

- supervisor: `<venv>/bin/python -m scienceflow.runtime.parallel.control.worker <run-id> <token>`
- research worker: `<venv>/bin/python -P -m scienceflow.runtime.parallel.execution.task_worker <task text> --workspace <task root> --type lnr --config <pilot>/engine-config-b.yaml`
- report entry: `<venv>/bin/python -P -m scienceflow.runtime.parallel.control.reporting <run-id> <token> <supervisor-pid> 60.0`

Every process resolved to the same interpreter
(`.../uv/python/cpython-3.12.12-linux-x86_64-gnu/bin/python3.12`, reached through
the venv symlink) with `PYTHONPATH` pinned to the engine checkout and
`XDG_STATE_HOME` inside the pilot directory. The `-P` flag — the round-18 EC6
change that keeps the writable workspace off `sys.path` — is observable on the
real worker and report entries of real runs, not only in `argv` assertions.

Run state stayed inside the pilot: run records under
`<pilot>/state/scienceflow/managed_runs/`, task state under
`<pilot>/runs/<run-id>/circle-packing/`. Nothing was written to the daily SDK
state, to either worktree, or to the isolated interpreter.

## 6. The result

Run 3 produced a real, valid candidate:

- model-authored code: `workers/w00/workspace/packing_core.py` and `solve.py`,
  pure Python (`math`, `json`, `random`) — no third-party dependency;
- artifact: `workers/w00/workspace/artifacts/best_solution.json`, 1510 bytes,
  sha256 `1401d3987588f19e61f72164440bbfe506aa3a6eb1076e9acd223718a414b0a7`;
- authoritative evaluation through the engine's own `TaskPackageBackend`:
  `radii_sum = 2.61661905326`, `benchmark_ratio = 0.993`, `validation_ok`,
  `candidate_ready`, `selection_eligible`, `metric_validity = high`,
  `evaluator_status = ok`, 0.10 s.

That is 99.3% of the declared benchmark 2.635, from a solver the model wrote and
ran inside its own workspace.

The engine did not record it as a research stage, and the reason is specific. The
model's last command was `timeout 90 python3 solve.py search 45`, launched with
about three seconds of research budget left; the artifact had already been
flushed at 10:39:00.87, and the command was killed at 10:39:03 with the tool
result `Error: Command timed out after 3s`. Stage capture requires a non-error
tool result, so no stage was captured. The engine nevertheless archived the
candidate and recorded why:

```json
{"trigger": "bash", "artifact_path": "artifacts/best_solution.json",
 "snapshot_path": "../logs/artifact_snapshots/iter_0001_20261115T023903Z_best_solution_sha_1401d3987588.json",
 "size_bytes": 1510, "tool_error": true}
```

So the loop reached "model writes code → code runs → valid artifact exists →
authoritative score available", and missed the engine-captured stage by one tool
result. The evaluation above was invoked by the operator through the engine's
real evaluator backend; it is not a stage the engine recorded itself.

Only one candidate was produced. There was no second candidate and therefore no
evaluator-feedback iteration: the A → feedback → B half of the target loop is not
demonstrated by this pilot.

## 7. Reading the run back through ScienceDiscovery

The run records were read at service level, without the product stack or a
browser:

- `services/scienceflow-reader/snapshot.py` — the real reader, spawned as a
  child process by the real wrapper.
- `services/api/src/scienceflow/run-snapshot.ts` — `createScienceFlowRunSnapshotQuery`
  with the administrator-style binding (`runId` → run record + allowed task
  roots), the real identity checks, and the real reader invocation.
- `services/api/src/scienceflow/dto.ts` — `projectScienceFlowRunSnapshot`, the
  public allow-listed DTO.
- `services/api/src/scienceflow/registration.ts` and
  `registration-repository.ts` — a registration row persisted to a real
  `science_flow_run_registrations` table in an isolated `node:sqlite` file.

Run identity and the recorded outcome read back correctly: every run reports its
own `runId`, `status` and `phase`, and registration persists and lists as
specified. Two limits are visible in that readback:

1. The snapshot binds a candidate only through `merge/best_stage_manifest.json`
   or `task_logs/lhr_stage_performance.csv`. Neither exists for run 3, because
   the engine captured no stage — so the reader reports
   `no_candidate_binding` and the DTO carries `candidate: null` even though a
   valid, digest-verified artifact is on disk. The snapshot cannot express "an
   artifact exists but was never captured as a stage".
2. The DTO has no per-candidate or feedback field, so an A/B comparison is not
   expressible today whatever the run records.

The two-candidate comparison would therefore need a small additive projection,
not a redesign: an optional per-task candidate summary sourced from the engine's
artifact archive, and an optional feedback reference. Neither was implemented —
this pilot changed no SD source.

Only the identity lookup is an in-memory adapter: importing the full
`SessionStore` graph in this worktree needs package installs that are out of
scope here. The API server, HTTP routes and browser journeys were not started.

## 8. What this pilot does not claim

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

## 9. Where the evidence lives

Ignored local artifacts under `.tmp/r/round19/` (never committed):

- `pilot/state/scienceflow/managed_runs/<run-id>/control.json` — the run record.
- `pilot/runs/<run-id>/circle-packing/` — task state: `task_logs/`,
  `workers/w00/logs/` (stage events, candidate archive ledger,
  `agent_provider_calls.jsonl`, interaction log), `workers/w00/workspace/`
  (model-authored code and `artifacts/`), `workers/w00/snapshots/`, `merge/`,
  `report.md`.
- `pilot/launcher-evidence*.json` — allowance, process samples, termination.
- `pilot/evidence-<run-id>.json` — stage rows, model-call timeline, artifacts.
- `pilot/evaluator-controls/controls.json` — evaluator control results.
- `pilot/engine-evaluation-<run-id>.json` — the engine backend's evaluation of
  the model-produced artifact.
- `pilot/sd-readback/<run-id>/readback.json` — registration + reader + DTO.
