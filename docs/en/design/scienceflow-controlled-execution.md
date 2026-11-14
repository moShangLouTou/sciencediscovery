# ScienceFlow controlled execution: the start contract

Status: **Proposed — not implemented.** Round 12 design, revision 4 (2026-11-13),
revised after reviews F12-01–F12-07, R2-01–R2-05 and R3-01–R3-03. No production
code, schema, test, endpoint, table, or installer was added. Every plan keeps
`canStart: false` and all five blockers.

This note answers exactly one question:

> Given a frozen plan and one explicitly selected Runner, how does the system
> start **at most one** research attempt after verifying at execution time, keep
> a verifiable execution identity for its whole lifetime, and neither misreport
> a result nor release resources early on failure, loss of contact, or stop?

It is a contract, not a scheduler. It does not add a readiness probe: the round-9
standalone adapter, the round-10 Runner boundary, and the round-11 runtime check
are inputs, and the note only says how a start consumes them.

## 0. Scope, sources, and evidence labels

Three code sources, never mixed:

| Label | Source | SHA |
| --- | --- | --- |
| `SD` | ScienceDiscovery worktree `/home/liyuan/sd-fork/sciencediscovery-wt-sfreader`, branch `feat/scienceflow-run-reader` | `c455f6b05853a7ef5abab612ea9c3467666af029` |
| `SF` | ScienceFlow checkout, `/home/liyuan/sd-fork/sciencediscovery/ScienceFlow` | `0ef229de1ae126ea04387ce74ae94ffacc437df6` |
| `R11` | round-11 report `round11-runtime-identity-followup-report.md` | historical evidence only |

`SF` is a read-only reference. It is **not** proof that a patched ScienceFlow is
installed on any Runner; nothing in this note assumes that. Line numbers refer
to the SHAs above.

Every claim below carries one of these labels:

- **[code]** — a fact read out of the source at the SHA above.
- **[report]** — historical evidence from a prior round's report (not re-run).
- **[inference]** — a conclusion drawn from code facts, not directly executed.
- **[todo]** — to be implemented; not present today.
- **[dyn]** — requires dynamic verification that this round did not perform.

### 0.1 Trust model, stated once

**Trusted:** the Runner host, its administrator, and the trusted configuration
files that both sides read at startup. **Untrusted:** every API request body, the
sandboxed workload, other Runner executions, and unprivileged users on the host.

A host administrator can therefore modify any backing file a read-only bind
points at. That is **outside** this design's prevention scope. It is handled by
detection-and-attribution (§4.6), never by claiming an immutability that
`--ro-bind` does not provide.

One consequence is stated once and applies everywhere: a **before/after check
proves only that the two endpoints are equal**. A file changed during the run and
restored afterwards passes both a start-time and a post-run digest or Git check.
Endpoint checks are therefore **diagnostics**, and a matching endpoint is never
promoted into "the content did not change during the run". The only thing this
design treats as an integrity guarantee for consumed bytes is a Runner-owned,
write-once copy whose digest is verified where it is read (§4.6).

## 1. The facts that decide the design

1. **[code]** The managed engine path owns the run. `start_run()` creates the
   record, then `_launch()` increments `attempt`, mints `launch_token`, writes
   `manifest-{attempt}.yaml` and a `status="starting"` record, spawns
   `python -m scienceflow.runtime.parallel.control.worker <runId> <token>` with
   `start_new_session=True`, then writes `pid`/`process_created`
   (`SF` `scienceflow/runtime/parallel/control/service.py:30`, `:118`,
   `:135-176`).
2. **[code]** The supervisor is what gives a run its life: it installs
   SIGINT/SIGTERM → `current.cancel()`, validates `launch_token` **and**
   `record["pid"] == os.getpid()`, sets `running`, awaits `run_manifest()`, then
   runs a separate reporting phase with its own budget
   (`SF` `.../control/worker.py:55-118`) and only afterwards writes the terminal
   record (`:129-141`), then `_record_terminal_storage` and `export_success`
   (`:142-160`).
3. **[code]** The foreground entry has none of that. `run_manifest()` builds a
   `ParallelRunner`, awaits `run_all()` and returns a summary
   (`SF` `scienceflow/runtime/parallel/service.py:25`); there is no record, no
   `attempt`, no token, no reporting phase, no `export_success` registration.
4. **[code]** `_public()` strips `manifest_payload` and `launch_token` and maps a
   dead `starting|running|stopping` record to `interrupted` (`SF`
   `.../control/service.py:179-187`). `alive()` compares `pid` and psutil
   `create_time` with no boot-id (`SF` `.../control/registry.py:80-88`), so it is
   meaningful only **inside** the PID namespace that owns those pids.
5. **[code]** The registry root is `$XDG_STATE_HOME|~/.local/state` +
   `scienceflow/managed_runs` (`SF` `.../registry.py:17-23`). Inside the Runner
   sandbox `HOME=/tmp` and the environment is cleared (`SD`
   `services/runner/src/executor.ts:938-960`), so without an explicit
   `XDG_STATE_HOME` the record would land on the sandbox's tmpfs and vanish with
   it.
6. **[code]** The process the Runner spawns is the **bubblewrap monitor**, not
   the Python workload. `spawnSandboxProcess()` calls `spawn()` on
   `config.bwrapPath` with `detached: true`, deliberately drops `--new-session`
   so the namespace init stays inside the killable group, and only then runs the
   `onSpawned` callback (`SD` `services/runner/src/executor.ts:1390-1465`,
   `:1448-1449`). The callback runs in the spawn turn, with no `await` before it
   (`:1463-1465`). R10's handle names the monitor's host pid, its start time, and
   the PID-namespace inodes (`SD` `services/runner/src/execution-boundary.ts:66-83`;
   the field is documented as "host pid of the sandbox monitor (the Runner's
   direct child)", `:73-74`). A signal sent to the monitor is **not** a proven
   delivery path to Python.
7. **[code]** The sandbox is bounded by its direct child: `--die-with-parent`
   and `--unshare-all` (which includes a PID namespace) at
   `SD` `executor.ts:963-998`; `runSandboxed()` settles when the monitor exits
   (`:626-680`); the termination path is `process.kill(-pid, "SIGKILL")`
   (`:1282-1292`); and the boundary module states that bubblewrap does not
   outlive its namespace init (`SD` `execution-boundary.ts:14-24`). **`setsid()`
   changes a session, not a PID namespace**, so a detached worker cannot escape
   the namespace's lifetime; the kernel tears the namespace down with its init,
   but that is a termination mechanism — actual emptiness is established only by
   the boundary scan, never inferred from the mechanism (§3.5).
8. **[code]** `ExecutionManager.submit()` already owns admission, request-digest
   idempotency, the durable ledger, workspace admission/lease/CAS, resource
   rows, boundary capture, termination proof and the publication journal
   (`SD` `services/runner/src/execution-manager.ts:222-256`, `:286-340`,
   `:350-470`, `:607-651`, `:689-755`). It takes `ShellExecutionRequest` today,
   whose payload is a shell program string
   (`SD` `packages/schema/src/environment.ts:243-287`).
9. **[code]** Admission happens **inside** `submit()`: the durable row is
   committed first, then the queued work enters
   `withWorkspaceAdmission(...withWorkspaceLease(...))`, and only then runs the
   operation (`SD` `execution-manager.ts:245-256`, `:286-340`).
10. **[code]** The environment read gate is held for the **whole operation**:
    `server.ts` passes `environmentStore.withRuntime(environmentId, (runtime) =>
    executeShell(...))` as the operation, and `withRuntime` releases only when
    the operation's promise settles (`SD`
    `services/runner/src/server.ts:1132-1136`, `:1177-1181`,
    `services/runner/src/environment-store.ts:607-612`). It is an in-process
    readers/writer gate: a writer (install/delete) waits. It is not a checkout
    lock and it does not survive a Runner restart; the durable
    `execution_resources` fence covers the restart case instead
    (`SD` execution-manager.ts:337).
11. **[code]** The Runner sandbox environment is a Runner-owned allow-list built
    with `--clearenv` plus one `--setenv` per entry (`SD`
    `services/runner/src/executor.ts:938-960`, `:995-996`). No API-supplied model
    credential reaches a sandbox.
12. **[code]** No resource limiter exists: `RESOURCE_LIMIT_MODE = "none"`
    (`SD` `services/runner/src/executor.ts:123`). The Runner enforces the
    workspace quota, NPU selection, output budget and sandbox lifetime, not CPU,
    memory or tokens.
13. **[code]** The reader is a Python program spawned by the API on the API host
    with an admin-declared `runRecordPath` and `allowedTaskRoots` (`SD`
    `services/api/src/scienceflow/run-snapshot.ts:41-52`, `:191-194`); it reads
    `control.json` and files under those roots
    (`SD` `services/scienceflow-reader/snapshot.py:64-126`). It is not a
    Runner-side component.
14. **[code]** A sandbox operation that throws after admission is **not**
    classified as "not started". `changed = true` is set before the operation is
    awaited (`SD` execution-manager.ts:347-351), so the evidence records
    `terminationReason: "operation_rejected_after_join"`; only `changed ===
    false` yields `"not_started"` (`:402-403`). That same literal also writes
    `processTerminated: true` in every branch, including `not_started`, so the
    research kind cannot inherit this field as its process evidence: it must
    write its own, driven by a spawn flag (§5.2).

Facts 1–5 decide the path; 6–7 decide the hosting shape; 8–9 decide the
admission order; 10–12 decide which blockers stay; 14 decides the failure
vocabulary.

## 2. A. Blocker evidence matrix

The five codes are fixed (`SD` `packages/schema/src/scienceflow.ts:258-262`) and
`canStart` is the literal `false` in every plan DTO (`:489`, `:520`, `:539`).
Nothing below clears a blocker or changes those types.

Each row separates three things that are routinely conflated:

- **Code capability** — the subsystem can do it at all.
- **Selected Runner capability** — the chosen Runner offers it today.
- **Attempt capability** — the condition to be proven at the moment a specific
  attempt starts.

| # | Blocker | Code capability today | Selected Runner today | Missing for an attempt | Execution-time proof condition | Invalidation condition | Owner | Acceptance method |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | `execution_backend_not_connected` | Engine managed path exists (`SF` service.py:30); Runner ledger exists (`SD` execution-manager.ts:222-256) | A Runner can run a sandbox; it has no research-run kind; the monitor is not the supervisor (§1.6) | A Runner-owned research-run kind, input delivery, and an API start action ([todo], §3) | **Accept**: one ledger row committed with `executionId` + `requestDigest`. **Running**: the monitor's boundary handle captured in the spawn turn and one engine record in the per-execution state root. Accept and running are separate evidence; neither is a precondition for spawning | Runner restart, boot change, namespace unreadable, or a second record for the same attempt | Runner (`services/runner/src/research-run.ts` [todo]) + API start service [todo] | Slice-E E1–E4; real local Runner; duplicate/restart rows |
| B2 | `model_gateway_not_configured` | Model config resolves from `~/.config/scienceflow/models.json` (`SF` `scienceflow/foundation/config/llm/model_registry.py:22`) or `CODE_API_KEYS`/`CODE_BASE_URLS`/`CODE_MODELS` (`SF` `.../state/subprocess_runtime.py:177-194`); a per-run loopback gateway exists for the **agent** (`SD` `services/api/src/agent-run/jiuwenswarm-model-gateway.ts`) | The sandbox env is cleared (§1.11), so **no** model config is reachable inside it | A Runner-side trusted model config, a per-run enforcing gateway, and a no-bypass egress contract (§2.1) | The gateway is bound to this `executionId`, holds the upstream key, and the sandbox has no other egress | Gateway unavailable, credential revoked, egress policy denies the host, a request cannot be attributed | Runner (config + egress) + gateway owner | Targeted: attribution and denial; product: one real model call under a real credential (liyuan) |
| B3 | `budget_enforcement_not_implemented` | Per-task `time_limit` is a hard `asyncio.wait_for` + `terminate_tree` (`SF` `.../state/subprocess_runtime.py:270-279`); the report phase has its own budget (`SF` `.../control/worker.py:89`, `:108-118`); LNR wall clock is a **soft** deadline `max(60, int(wall_clock_budget_sec))` (`SF` `.../construction.py:162`); token counters exist, no spend cap | Nothing caps tokens, requests or spend; no cgroup (§1.12); sandbox lifetime is a SIGKILL timeout | A time contract with an absolute deadline (§5.6) and a metering gateway that reserves before the upstream call (§2.1) | The schedule is persisted at start and termination is **initiated** by `forceKillAt`; the namespace is proven empty by `hardDeadline` — or the run is `unknown` + `deadlineViolated`. Initiation and proof are separate promises | Deadline changed, no schedule, proof not obtained by `hardDeadline`, or tokens requested through a path the gateway does not meter | Runner (time) + gateway (tokens/spend); engine (per-task) | Slice-E E17a/E17b; product: a real run that hits the ceiling |
| B4 | `process_cancellation_not_implemented` | Engine SIGTERM → `current.cancel()` → `CancelledError` → `status="stopped"` → reporting (`SF` worker.py:59-60, `:83-84`); cancel kills live process groups (`SF` scheduler.py:31-33); Runner can prove a namespace empty (`SD` execution-boundary.ts:206-376) | Runner cancel is SIGKILL to the monitor's group (`SD` executor.ts:1282); the monitor is not Python (§1.6) | A control channel the supervisor actually observes, a persisted stop intent, and a proof-or-unknown exit (§3.5) | The supervisor's own handler ran (a protocol event exists), or the state is `unknown`; the namespace is proven empty before release | Channel unavailable, no ack within the grace, repeated stop, or a descendant survives | Runner (`research-run.ts` stop [todo]) | Slice-E E8–E14 (E11a/E11b), E19–E24 |
| B5 | `scienceflow_revision_unverified` | R11 verifies, per Runner environment, that the interpreter resolves `scienceflow` from the trusted checkout (`SD` `docs/en/design/scienceflow-runtime-identity.md`; `services/api/src/scienceflow/runtime-check.ts`) | A stored check is point-in-time evidence and never a start authorization | A start-time repetition bound to this attempt, plus consumption from a Runner-owned source snapshot (§4.6) | Under the environment lease, immediately before spawn: environment revision matches, the R11 subset probe is `verified`, and the source is served from a verified tree snapshot | Environment revision changed, the probe is not `verified`, the snapshot digest mismatches, or the checkout cannot be snapshotted | Runner runtime-check + API start service | Slice-E E15 (diagnostics only); product: real environment |

Notes the matrix must not blur:

- **A stored `verified` check never authorizes a later start.** It is evidence
  from `checkedAt`; the start repeats the check under the lease.
- **B3's "the plan declares a budget" is not enforcement** (`SD`
  `services/api/src/scienceflow/execution-contract.ts:214-215`).
- **B5's Git check is not a dependency-closure proof**; dynamic imports,
  CUDA/ABI and evaluator runnability stay unverified.
- **A start/post-run endpoint check never clears B5**: it only compares two
  instants, so a change-then-restore passes it (§0.1, §4.6). Only a verified
  snapshot plus a re-verified probe does.

### 2.1 Model gateway and metering: what an enforceable contract would require

| Requirement | Why the current pieces do not satisfy it |
| --- | --- |
| Upstream key held only by the gateway | The plan contract refuses `api_keys`/`base_url(s)` (`SD` execution-contract.ts:468-471, 559-571); nothing else holds a key for the engine |
| A per-run gateway credential — never the upstream key — inside the sandbox | The sandbox env is a cleared allow-list (§1.11) |
| **No direct egress from the workload** | The Runner has an egress mechanism, but a "no direct egress" contract for a research workload is **not designed** here; without it, derived engine calls (task workers, agents, the report subprocess) can bypass metering entirely |
| Attribution | Only a per-run gateway can attribute; a shared proxy cannot |
| Concurrency reservation before the upstream call, settlement after | Nothing today; the engine only counts tokens |
| Streaming, disconnect and retry accounting | Undesigned; a disconnect can bill without a settle |
| Unknown pricing | Conservative policy would be "reserve the maximum, settle down, refuse when the reservation is not covered" |

Consequences to accept explicitly:

- A per-run credential proves **attribution**, not enforcement.
- Enforcement requires the no-bypass egress contract, which is undesigned. Until
  it exists, **B2 and B3 stay blocked**, and the next implementation slice does
  not build the gateway.

Round 17 update (2026-11-14, design only; revised after both round-17
reviews): the transport, the egress contract, the identity tuple and the
reservation ledger are now specified in
[`scienceflow-model-gateway-budget.md`](./scienceflow-model-gateway-budget.md).
That note selects an inherited socketpair descriptor behind the existing sandbox
forwarder — so `socket(AF_UNIX)` stays denied and `socketpair` is reduced to
self-connected `SOCK_STREAM` pairs, leaving a host socket in a mounted
directory unreachable — adds one seccomp variant that permits only
`socket(AF_INET, SOCK_STREAM)` and `socketpair(AF_UNIX, SOCK_STREAM, 0)`,
narrows the promise to requests, bytes, concurrency, time and transport bounds
(reported tokens are accounting, spend is not enforceable), reads the request
body outside the ledger transaction, and requires two child-side proofs before
any run: the existing R11 source gate plus a research-layout probe, with `-P`
on the engine's own `-m` children so the workspace cannot replace the engine
entry (engine change EC6 below). A restart revokes the previous boot's authority
and reconciles reservations without resuming. It is **not implemented**, it
clears no blocker, and the paragraph above remains the state of the code: B2
and B3 stay blocked until the real-provider evidence named there exists.

### 2.2 Budget: who enforces what

| Dimension | Enforcer today | Covers engine-derived calls | Covers the report phase | Enforceable for a first attempt |
| --- | --- | --- | --- | --- |
| Per-task wall clock (`time_limit`) | engine `wait_for` + `terminate_tree` | yes, per task tree | no | yes (engine-observed) |
| LNR `wall_clock_budget_sec` | engine soft deadline | partially | no | **no** (soft only) |
| Report budget | engine `finalize_reports`, separate `wait_for`/killpg | n/a | yes | yes |
| Whole-run hard deadline | none | n/a | n/a | **[todo]** §5.6 |
| Request count / tokens | none | only through the gateway | only through the gateway | **no** |
| Spend | none (no pricing) | only through the gateway | only through the gateway | **no** |
| CPU / memory | none (§1.12) | yes | yes | **no** |
| Workspace bytes | Runner `maxWorkspaceBytes` | yes | yes | yes |
| NPU devices | Runner inventory + claim | yes | yes | yes |

An engine-reported token count is accounting, not enforcement.

## 3. B. One execution path

### 3.1 The two candidates

| Contract point | Managed `start_run()` + worker | Foreground `run_manifest()` |
| --- | --- | --- |
| Durable run record | `control.json` per attempt (`SF` service.py:118-176) | none |
| Attempt / launch token | `attempt`, `launch_token`, `pid`, `process_created` | none |
| Graceful stop | SIGTERM → cancel → interrupted tasks → `stopped` + reporting (`SF` worker.py:55-118) | process cancellation only; no record |
| Reporting / storage / export | `finalize_reports`, `report_budget`, `_record_terminal_storage`, `export_success` (`SF` worker.py:89-160) | none |
| Reader contract | `control.json` is what the reader reads (`SD` snapshot.py:64-126) | nothing to read |
| Liveness authority | `alive()` — meaningful only inside the namespace (§1.4) | the caller's own process |
| Runner supervision | none today; fits as a workload | none |

**Recommendation: the managed path, and only the managed path.** The foreground
entry is rejected for one concrete contract reason: it produces no run record,
no attempt identity, no stop semantics and no reporting, so the Reader, stop and
"never misreport" requirements cannot be met by it.

### 3.2 Why the existing shell-execution route cannot host it

1. **Lifetime.** The sandbox dies with the monitor (§1.7). Running
   `scienceflow ... start` as the workload returns after spawning a detached
   worker; the CLI's exit 0 would be read as success while the worker has already
   been killed by namespace teardown.
2. **Payload shape.** The only shell route carries a shell program string
   (`SD` `environment.ts:243-287`); a research start built by concatenation is
   forbidden and would leak paths into logs.
3. **Stop.** Runner cancel is SIGKILL to the monitor's group (§1.6, §1.7); it
   cannot express "ask the engine to stop, let it write `stopped` and finalize
   reports, then prove the namespace empty".

### 3.3 The chosen shape and the process graph

A new **research-run execution kind** owned by the Runner's `ExecutionManager`,
plus a fixed Runner-owned bootstrap, plus a control channel. The graph:

```
Runner process
└─ bwrap monitor                         <- the ChildProcess the Runner owns;
   │  (detached group leader;              R10 handle = pid + start time +
   │   --new-session dropped)              PID-namespace inodes
   └─ namespace init                     <- numeric pid is [dyn]; see the assertion below
      └─ bootstrap (Python, fixed)       <- prepare_run(), then supervise()
         ├─ engine supervisor state      <- SIGTERM/SIGINT → cancel → reporting
         ├─ task workers / agents        <- children and grandchildren
         └─ report subprocess            <- own session, same namespace
```

Rules that follow from the graph:

- **"The bootstrap is PID 1" is a runtime condition, not an assumption.** Before
  doing anything else the bootstrap reads `os.getpid()`; if it is not 1 it writes
  `not-namespace-init` to its protocol events and exits with a fixed code. The
  Runner treats that exit as `failed` + `research: not-started` with process
  evidence `spawned-then-terminated`, and records the condition as unverified. Only when the assertion holds is the bootstrap
  responsible for reaping and for not exiting before its descendants are gone.
  If the assertion ever fails on a supported platform, the hosting shape is
  wrong and the slice must be revised — the design does not fall back to
  signalling a guessed pid.
- The Runner never sends a signal to the workload directly. It cannot prove
  delivery through the monitor, and it cannot name the namespace pid from the
  host.
- Boundary capture happens in the spawn turn, synchronously, before any `await`
  (`SD` executor.ts:1463-1465, `execution-manager.ts:552-576`). Reading the run
  record later never substitutes for it.
- Given the assertion above holds, the bootstrap must not exit before its
  descendants are gone: it reaps and waits; the engine's scheduler kills live
  process groups on cancel (`SF` scheduler.py:31-33), and the Runner's namespace
  proof is the backstop that catches anything left.
- Termination is proven by namespace emptiness only. The monitor's exit, the
  group's disappearance and the engine record are never termination proofs on
  their own.

### 3.4 Minimal Runner interface ([todo])

Owning modules: `services/runner/src/research-run.ts` (new), plus wiring in
`execution-manager.ts`, `executor.ts`, `server.ts`, `packages/schema`, and
`packages/executor/src/runner-client.ts`.

```ts
// packages/schema — a discriminated request, never a shell string
export interface ResearchRunRequest {
  kind: "research-run";
  executionId: string;                 // deterministic, from the API run row
  agentId: string;
  permissionEpoch: PermissionEpoch;
  workspaceRoot: string;               // trusted internal composition, as today
  runnerWorkspaceKey?: string;
  environmentId: string;
  expectedEnvironmentRevisionId: string;
  runtimeBindingId: string;            // the R11 binding, re-checked at start
  run: {
    attempt: 1;                        // v1: exactly one attempt
    manifestRelativePath: string;      // workspace-relative, never a host path
    manifestSha256: string;            // frozen plan bytes
    inputRefIds: string[];             // trusted, admin-declared input refs
    sourceRevision: string;            // 40-hex, must equal the checkout HEAD
    time: ResearchTimeSchedule;        // §5.6
  };
}

export interface ResearchTimeSchedule {
  researchBudgetMs: number;      // engine soft deadline for research
  reportBudgetMs: number;        // engine report budget
  drainGraceMs: number;          // bounded wait for a stopped engine to finish
  verificationWindowMs: number;  // proof budget before the hard deadline
  hardDeadlineMs: number;        // absolute from spawn; no extension
  // Required: hardDeadlineMs >= researchBudgetMs + reportBudgetMs
  //           + drainGraceMs + verificationWindowMs; refused otherwise (§5.6)
}
```

What the Runner accepts and what it refuses:

- **Accepted** (as today): `workspaceRoot` / `runnerWorkspaceKey`, composed by
  the trusted API binding and authenticated by the execution signature.
- **Never accepted from a request**: an **override** of Runner-owned paths — the
  state root, the source checkout root, input host paths, the bootstrap module,
  model credentials, the launch token. Those exist only in Runner code or in the
  Runner's trusted configuration.

Runner-side trusted config (one new admin file, mirroring the R11 binding file):

```json
{
  "schemaVersion": 1,
  "stateRootBase": "/srv/sciencediscovery/scienceflow-state",
  "inputStoreBase": "/srv/sciencediscovery/scienceflow-inputs",
  "inputRefs": [
    { "inputRefId": "dataset-a", "hostPath": "/srv/datasets/a", "sha256": "<64-hex>" }
  ]
}
```

The bootstrap is a **constant in Runner code**, not a configuration field, so a
fixture module can be injected only through a test-side dependency — never
through configuration or a request.

### 3.5 Stop protocol

No signal is sent to the monitor, and no host pid is guessed. The stop travels
through a control directory the workload reads, and the engine's own control
task is what cancels the run:

```
Runner: create <stateRoot>/.control/ (0700, Runner-owned) before spawn,
        keep an open dirfd for it
Runner: on a stop intent, atomically write .control/stop
        { stopId, executionId, requestedAt }   stopId is stable per intent
Bootstrap: install no signal handler of its own; start a watcher task on the
        same loop that polls .control/stop every 200 ms; the first stopId seen
        sets the in-process stop event and writes .control/consumed { stopId };
        later reads of the same stopId do nothing
Bootstrap: assert getpid()==1 (§3.3), call prepare_run(), then
        supervise(runId, token, stop_event=<same event>)
Engine (E3), inside supervise(), all on the existing loop:
  1. stop_event already set (pending stop): write
        { status="stopped", research_status="not-started", phase="finished" }
        and return — no research, no reporting
  2. install SIGINT/SIGTERM → current.cancel() as today; write .control/ready
  3. supervisor_task = asyncio.current_task()
     control_task = create_task(wait_once(stop_event, supervisor_task.cancel))
  4. research → transition to reporting → reporting phase
  5. finally: control_task.cancel(); await it, suppressing CancelledError
Engine: CancelledError → status="stopped" → reporting phase → terminal record
Runner: waits until forceKillAt (≤ hardDeadline) for the monitor to exit,
        then killSandboxProcess(group SIGKILL)
Runner: verifies the namespace empty by hardDeadline; publishes and releases
        only then
Runner: if the namespace cannot be proven empty: state unknown, keep the
        workspace / environment / device fences, mark deadlineViolated
```

`wait_once` is one `await stop_event.wait()` followed by one
`supervisor_task.cancel()`. It is a single asyncio task on the loop the engine
already runs — not a scheduler, a second process manager, or a second loop. The
cancel target is the bound supervisor task itself, so the existing
`CancelledError → stopped → reporting` path is unchanged.

Why not self-SIGTERM: the SIGTERM handler is installed **inside** `supervise()`
(`SF` worker.py:59-60), so a stop arriving before that point would hit the
default disposition and kill the process with no record. The handshake is
explicit instead: the watcher only sets an event; `supervise()` arms the
control task once its handler exists, and writes `.control/ready` at the same
point. This is engine change **E3** (§3.6), not a behaviour of the current
revision.

**One intent, one cancel, both phases.** The control task is armed once at
`ready` and stays armed through research *and* reporting. The first consumption
cancels the bound supervisor task exactly once: a stop consumed in research is
**not** delivered again during reporting, and a first stop consumed while
reporting is delivered there — the case the reporting caveat below covers. The
`finally` block cancels and awaits the control task on every exit path (natural
end, cancel, exception), so no waiter survives into reporting completion or
past the attempt.

**Pending stop short-circuits research.** Step 1 is the whole rule: if the
event is set before `supervise()` enters its research, the supervisor writes the
pre-research terminal record and returns. The record therefore never carries
`status=running` for such a stop — it goes from `starting` to
`{status="stopped", research_status="not-started", phase="finished"}`. That
record is what entitles the public `research: not-started`; a missing `running`
write or a missing `ready` file is **not** evidence on its own. Without the
record (an engine without the short-circuit, or a bootstrap killed before it
could write), the Runner states only the process fact and `research: unknown`
(§5.1).

Stop stages, decided from evidence only:

| Stop arrives … | Record evidence | Public result |
| --- | --- | --- |
| before the supervisor ran, intent already durable | E3 pre-research terminal record `{status=stopped, research_status=not-started, phase=finished}` | `execution: cancelled`, `research: not-started`, `stopStage: "before-supervisor"` |
| the bootstrap was killed before it could write that record | no terminal record | `execution` per process proof (`cancelled` if termination is proven); `research: not-started` only with the `not-namespace-init` event, else `unknown` |
| after `ready`, before any reporting write | `status=running`, no `phase`/`report_started_at` | `execution: cancelled`, `research: stopped`, `stopStage: "research"` |
| during reporting (first consumption there) | `phase=reporting` | `execution: cancelled`, `research` from `research_status`, `report: incomplete`/`unknown` |
| runner restarts mid-run | row already `unknown`; a rebuilt Runner may scan the recorded boundary | `unknown` stays; the scan can add `terminationConfirmed`, never change the state or release a fence |

Reporting-phase caveat: `await finalize_reports(...)` is guarded by
`except Exception` only (`SF` worker.py:117-124), so a cancel that lands there
raises `CancelledError` past the handler and **no terminal record is written**.
The contract therefore does **not** promise a `stopped` record:
`research_status` (written at `:104`, before the report phase) stays
authoritative, `execution` follows the process proof, and `report` is
`incomplete` or `unknown`. Engine change **E4** (catch `CancelledError` around
the report await and write `report_status="incomplete"`) is an optional extra
version dependency that would make the record complete; without it the mapping
above is the contract.

Channel authority and hygiene:

- **Writer authority is the Runner.** `stop` is written by the Runner and never
  by the workload; its shape and `stopId` are Runner-generated.
- **Workload files are self-reports.** `ready`, `consumed`, `stop-ack`, `hello`
  and the protocol events are written by the workload. They are hints for
  attribution, never proof of termination, never proof of an outcome, and never
  evidence for evaluation. A positive protocol event may explain *why* research
  did not start, but it never replaces the namespace termination proof.
- The state root is writable by the workload, so `.control` is not a trusted
  channel. The Runner keeps the dirfd opened before spawn and opens every file
  relative to it with `O_NOFOLLOW`, rejects symlinked components, non-directory
  paths, wrong uid or mode, and caps each file (4 KiB) with a strict JSON schema
  and a version field. A malformed or forged `stop-ack` is ignored, and a
  `.control` whose inode no longer matches the dirfd is treated as a compromised
  channel: the Runner escalates to group kill and, if the namespace cannot be
  proven empty, records `unknown`.
- **One consumption per intent.** The watcher dedupes on `stopId`; repeated
  Runner requests reuse the durable intent and rewrite the same file. Neither
  the Runner nor the watcher re-signals on a repeat.

Other properties:

- **First start:** the control directory exists before spawn; the watcher starts
  before `prepare_run()`, and a stop it consumes first is short-circuited by
  `supervise()` before any research runs.
- **After a Runner restart:** the state root and its `.control` directory
  persist; the sandbox is *designed* to die with the Runner (`--die-with-parent`,
  §1.7), but that is a termination mechanism, not an observation. The rebuilt
  Runner keeps the persisted owner, boundary handle and fences, never resumes,
  replays or recomputes a deadline, and signals nothing automatically in v1.
  Whether the old namespace is actually gone is decided by re-reading the
  recorded boundary and scanning it; residue or an unscannable boundary keeps
  the row `unknown` and releases nothing (§5.2). An explicit stop or cleanup
  follows R10's verified-handle rules; a boot change never signals. If the state
  root is missing or unreadable, the stop is `unknown`
  (`stop-channel-unavailable`) — the Runner does not signal pids.
- **Positive evidence:** `.control/ready` proves the control task is armed and
  `.control/consumed` proves the watcher saw the intent. Neither proves the
  engine reached `stopped`; the terminal record or the process proof does.
- **The engine's own `stop_run()` is never called from the host** in this
  hosting: it signals `record["pid"]`, a namespace pid (`SF`
  `.../control/service.py:204-227`). Host-side managed runs of the engine are
  unaffected.

### 3.6 Engine changes and version dependency

The managed path needs four small additive engine changes, all preserving every
existing behaviour of `start_run()`; one further change is optional:

- **E1 `prepare_run()`** — extract the record-creating half of `start_run()` +
  `_launch()` (validation, run id, `attempt+1`, `launch_token`, stale-key
  clearing, `manifest-{attempt}.yaml`, resource reservation) into a function
  that does not spawn.
- **E2 supervisor adoption** — `supervise()` accepts a record whose `pid` is
  unset and writes `pid = os.getpid()` / `process_created` itself under the
  directory lock; when a pid is present it still requires equality
  (`SF` worker.py:63-64).
- **E3 stop event, readiness, control task, and short-circuit** —
  `supervise(run_id, token, *, stop_event=None)`: (a) if `stop_event` is set on
  entry, write `{status:"stopped", research_status:"not-started",
  phase:"finished"}` and return without research or reporting; (b) otherwise
  install its handlers, write `.control/ready`, and arm exactly one control task
  that awaits the event and cancels the bound supervisor task once; (c) cancel
  and await that control task in `finally` on every exit path. With no event
  passed the function behaves as today.
- **E4 (optional) report-phase cancellation** — wrap `await
  finalize_reports(...)` so a `CancelledError` writes `report_status=
  "incomplete"` instead of propagating. Without E4 the contract of §3.5 applies
  (no terminal record; `research_status` authoritative).
- **EC6 `-P` on the engine's own `-m` children** — add `-P` before `-m` in
  `child_cli_argv` (prep and task worker) and in the report child's argv, so
  `cwd` is not prepended and a `scienceflow/` package in the writable workspace
  cannot replace the mounted engine entry. This is required by the round-17
  gateway design (§3.6 of that note); the checkout requires Python `>=3.11`,
  where the flag exists, and the engine's command classifier already parses it.

E1 and E2 are required by §1.7; E3 follows from §3.5; EC6 follows from the
source-identity requirement of the gateway design (§3.6 there); E4 only
improves the record's completeness.

Delivery constraint: a patched engine must be a **tracked, pinned revision**, not
an edit in the untracked reference checkout. If the project refuses an engine
patch, no path satisfies both the managed record and the sandbox lifetime, and
the honest conclusion is that a real start stays blocked (§8).

### 3.7 Not built, deliberately

- No second execution backend, no API-side `spawn`, no shell string.
- No parallel process manager: the bootstrap/supervisor is a workload of the
  existing manager.
- No readiness aggregation endpoint; the start contract is the start path.
- No resume in v1 (§5.4).

## 4. C. From frozen inputs to results

### 4.1 Sequence

```
user action
  → API: identity, write gate, session runner permission
       (assertSessionAllowsRunner); resolve runnerFor(runnerId);
       re-check profile, plan digest, bindings
  → API: persist the run row (requested, attempt=1, deterministic executionId,
       submissionDigest) BEFORE any dispatch
  → API → Runner: deliver frozen inputs (§4.3)
  → Runner: POST /research-runs → submit(): durable idempotent accept
            (ledger row committed; preflight does only lease-free checks)
  → Runner: queued work enters withWorkspaceAdmission + withWorkspaceLease,
            then withRuntime(environmentId) for the whole operation
  → Runner: in-gate execution-time verification (§4.7):
            environment revision, source revision, interpreter resolution,
            manifest + input digests, startup hooks
  → Runner: spawn the fixed bootstrap as the sandbox workload;
            boundary handle captured synchronously in the spawn turn
  → Runner: state=running; the operation waits for the monitor to exit
  → Engine: research → reporting → terminal record (storage/export may follow)
  → Runner: reconcile engine record + boundary proof, then publish/release
  → API: observe; derive the public fields from (execution, research, report),
         never from the OS exit code
```

The Runner takes **no admission before `submit()`**. `submit()` already owns
the ordering (§1.9); a pre-submit admission would queue twice and a lease taken
outside it could invalidate the post-queue verification.

### 4.2 Field and ownership

| Field | Owner / generator | Persisted where | Public |
| --- | --- | --- | --- |
| `planId` | API (existing) | catalog | yes |
| `planDigest` | API, canonical contract digest (`SD` execution-contract.ts:103-106) | catalog | yes |
| `registrationId` | API (existing) | catalog | yes (never a run) |
| `executionId` | API, deterministic from `(planId, attempt)`; charset `^[A-Za-z0-9_:.-]{1,160}$` (`SD` execution-manager.ts:225) | API row + Runner ledger | yes |
| `runId` | Engine, at `prepare_run` | engine `control.json`; Runner ledger after spawn | yes |
| `attempt` | Engine record; API mirrors `1` in v1 | both | yes |
| `launch_token` | Engine | engine `control.json` (0700 dir) and the sandbox argv | **never** |
| `launchTokenDigest` | Runner, `sha256(token)` read back from the record after spawn | Runner ledger | no (used only to verify a record after restart) |
| boundary handle | Runner, at spawn (`SD` execution-boundary.ts:129-206) | Runner ledger | capability only, not a path |
| `submissionDigest` | API (`SD` shell-executions.ts) and Runner request digest (`SD` execution-manager.ts:235) | both | no |
| host paths | Runner trusted config only | Runner ledger (as host/sandbox pairs) | **never** |
| input-ref host paths | Runner trusted config | Runner config | **never** |
| source checkout root | Runner trusted config (R11 rule) | Runner config | **never** |
| model credential | Runner trusted config / gateway | Runner config | **never** |

Invariants:

- `executionId ↔ (planId, attempt)` is unique and immutable; a new attempt needs
  a new `executionId`, and v1 allows only `attempt = 1`.
- One `executionId` carries at most one `(runId, attempt, launch_token)`; the
  state root is derived from `executionId` + attempt, so the association is
  recoverable from the filesystem after a crash — **as a candidate only**
  (§5.2).
- A registration is never promoted to a run; a started run is never re-labelled
  as a registration.
- The engine's `runId` must satisfy `[A-Za-z0-9][A-Za-z0-9_.-]{0,199}`
  (`SF` registry.py:45-48); a `prepare_run` collision is a refusal, not a retry.

### 4.3 Frozen input delivery across hosts

| Input | Delivery | Integrity |
| --- | --- | --- |
| Parallel manifest, per-task `task.yaml`, task description files, evaluator entry, plan contract JSON | Content-addressed **materialization** into `inputStoreBase/<sha256>/…` (Runner-owned, outside the workspace and outside every writable bind), with a manifest of `{relativePath, sha256, size}`; written temp-then-rename and verified on read | Re-hashed at start; the sandbox gets a read-only bind at `/inputs/<planDigest>` |
| Datasets and other large inputs | An `inputRefId` resolves through the Runner's trusted config to a host path, which the Runner turns into its **own snapshot** (reflink where the filesystem supports it, otherwise a copy). If neither is possible, the start is refused (`INPUT_NOT_IMMUTABLE`). The snapshot, not the original, is bound at `/inputs/<inputRefId>` | Snapshot digest verified at start; the declared `sha256` is a diagnostic, not the guarantee (§4.6) |
| Source checkout | A Runner materialized **tree snapshot** of the trusted checkout, mounted read-only at the original source path (§4.6) | Tree digest verified at start; Git HEAD and resolution checks are diagnostics |
| Outputs | The writable workspace only; publication is the existing CAS snapshot with fences | Workspace version evidence, not an artifact import (§5.5) |

Delivery rules:

- Inputs are **never** read from the writable workspace. An input whose host
  path lies inside the workspace, or inside any writable bind, is refused at
  config load and again at start, so no second writable alias can reach the
  bytes.
- **Mount order is part of the contract.** Today the argument order is
  `environmentBinds` → `readOnlyHostBinds` → egress → `workspaceBindArgs`
  (`SD` `executor.ts:983-989`), and bubblewrap lets a later mount on the same
  path shadow an earlier one. Input binds therefore go into a new
  `inputBindArgs` appended **after** `workspaceBindArgs` — not beside
  `readOnlyHostBinds`, where a workspace bind would re-expose them writable. A
  configuration in which any later bind would re-expose an input path
  read-write is refused.
- The frozen bytes are bound read-only. Any copy the engine makes into the
  workspace is an **output**, not the contract input.
- The Runner's workspace upload channel carries the **API-materialized bytes**
  to the Runner; the Runner then materializes them into the input store and
  binds that. The upload channel is never the execution input itself.
- The API never sends a Runner host path. `workspaceRoot` and
  `manifestRelativePath` are the existing trusted, signature-authenticated
  internal composition; what the Runner refuses is an **override** of
  Runner-owned paths.

### 4.4 Path rewriting and provenance

Path rewriting is a **Runner-owned, persisted, one-way map**, recorded before
spawn:

```
workspaceRoot          → /workspace
stateRoot (per exec)   → /scienceflow-state
input store entry      → /inputs/<planDigest> or /inputs/<inputRefId>
sourceRoot             → its own host path, backing the tree snapshot (§4.6)
```

The map also records, per bound path, the **snapshot digest** the mount is backed
by (`snapshot: {sha256, kind: "file" | "tree"}`), so a later observer can tell
which bytes a run was meant to read without trusting the endpoint checks.

Rules:

- The engine record contains sandbox paths. The Runner translates them for its
  own diagnostics and never returns them to the API.
- The public DTO exposes no host path and no sandbox path; only run/plan
  identities, statuses, timestamps and fixed diagnostics.
- Because the map is persisted before spawn, a record observed after a restart
  can be attributed to exactly one execution — as a candidate, jointly verified
  (§5.2).
- The map is per execution; workspace reuse cannot inherit a stale map.
- R11's plain `.pth` mapping is part of the same map: the mapping recorded at
  check time must equal the mapping used at start (same source root, same
  interpreter, same supported subset). A mismatch refuses the start; it is never
  "re-mapped silently".

### 4.5 TOCTOU before spawn

- Verification runs inside the workspace admission/lease that `submit()`
  already holds when it calls the operation (`SD` execution-manager.ts:286-340),
  immediately before spawn, so no other Runner execution can mutate the
  workspace in between.
- The input store is content-addressed and write-once per digest; a mismatch is
  `INPUT_CHANGED` and refuses before anything spawns.
- Symlinks, non-regular files, over-size entries and path escapes are refused at
  materialization and re-checked at start; a missing digest is `unknown`, never
  "trusted by existence".
- A plan digest plus an existing file is not an executable snapshot: the start
  re-hashes the manifest and every delivered input.

### 4.6 Runtime integrity after spawn

`--ro-bind` prevents writes **through that mount**. It does not prevent the host
administrator from writing the same backing file, and it says nothing about
another mount, bind, or block device that reaches the same inode or the same
overlay upper directory. A read-only filesystem mount is therefore **not** a
source-of-truth proof either: whoever controls the host can mount the same
storage elsewhere.

**The single contract for a real start:** every byte the workload *consumes* is
served from a **Runner-owned, write-once, content-addressed snapshot**, and any
input that cannot be served that way **refuses the start**. There is no weaker
mode for real execution.

| Class | Served from | Guarantee | Diagnostics only |
| --- | --- | --- | --- |
| Frozen small inputs (manifest, `task.yaml`, descriptions, evaluator, plan JSON) | `inputStoreBase/<sha256>/…`, materialized by the Runner, never written again, re-hashed when read | The bytes the sandbox opens are the frozen bytes, independent of the API-side original | — |
| Source checkout | A Runner materialized **tree snapshot** (full copy or a copy-on-write reflink), digest-named, mounted read-only **at the original source path** so the R11 `sys.path` mapping stays byte-identical | The interpreter imports exactly the snapshot tree; a write to the original checkout afterwards cannot reach it | Git HEAD and the package resolution at start and after the run (`endpoint-check`) |
| Datasets and other large inputs | A Runner materialized snapshot when the filesystem can make one cheaply (reflink) or the dataset fits the input store; **otherwise the start is refused** (`INPUT_NOT_IMMUTABLE`) | Same as above | Declared `sha256` at start and after the run |
| Environment prefix | The Runner's managed environment, held by the `withRuntime` read gate for the whole run and by the durable `execution_resources` fence across restarts (§1.10) | No Runner-mediated install/delete while the run lives; the gate is released only after a proven termination | An environment revision change observed while the run lives |

What each guarantee covers, stated exactly:

- A snapshot is immutable **within the Runner's trust boundary**: it is created
  once, named by its digest, and verified on every read. A host administrator
  can still write it (§0.1); the digest check detects that and the run becomes
  `provenance: mismatch`.
- A snapshot makes the *original* irrelevant. Whether the original checkout, API
  upload or dataset changes, is restored, or is renamed over during the run does
  not affect what the workload reads. This is a property of the copy, not of a
  check.
- The runtime check's `verified` result is about the *interpreter and package
  mapping*, not about the bytes staying put; §4.3 and this section are what make
  the bytes stay put.

**Endpoint checks are diagnostics, never a guarantee.** A start-time and a
post-run check are recorded as `endpoint-check: match | mismatch | unavailable`:

- `mismatch` is real evidence that something changed; the run is
  `provenance: mismatch` and its result is inadmissible under the frozen
  contract.
- `match` means only that both endpoints looked the same. A file modified during
  the run and restored afterwards, a rename-over that restores the old content,
  or a write through a different mount all pass it. `match` never becomes
  "content unchanged during the run" and never clears a blocker.
- `unavailable` (checkout unreadable) is `provenance: unverified`, never
  silently accepted.

Consequences that must not be softened:

- Python's lazy imports, the evaluator and later data reads can observe a
  changed backing file **only if that file is not served from a snapshot**. Real
  starts therefore do not read from a live, externally writable tree or dataset.
- **B5 is cleared only by**: (a) the R11 probe re-verified at start under the
  environment lease, and (b) the source served from a verified snapshot. A
  deployment statement that "accepts attribution after the fact" does **not**
  clear B5, because attribution cannot prove what a lazy import actually read.
- If the snapshot cannot be created (no space, unsupported filesystem, an input
  class with no snapshot strategy), the answer is a refusal, not a best-effort
  start.

### 4.7 Interpreter, binds, startup hooks — aligned with R11

- The environment's own interpreter, resolved under `withRuntime()` and re-read
  after the gate is acquired.
- `prepareSandboxLaunch()` plus the supervised `runSandboxed()` primitive, not a
  bare spawn.
- The source **snapshot** (§4.6) mounted read-only at the original checkout path
  through the Runner-internal `readOnlyHostBinds` option (`SD` executor.ts:929,
  987) — never a request field. Mounting the snapshot at the same path keeps the
  R11 `sys.path` and plain `.pth` mapping byte-identical, so the check and the
  run resolve the same package path.
- The R11 supported subset (`-I -S -B` static, `-I -B` normal) is re-evaluated
  at start; a check that is not `verified`, or whose binding digest no longer
  matches the plan, refuses with a fixed code before spawn.
- Bytecode writing stays disabled and the environment prefix stays read-only;
  the only writable paths are the workspace and the per-execution state root.

### 4.8 Trust, owner, permission epoch

- The API checks identity, write permission and `assertSessionAllowsRunner`
  before composing the request (`SD`
  `services/api/src/agent-run/workspace-bindings.ts`,
  `services/api/src/bootstrap/platform.ts`).
- `permissionEpoch` is snapshotted into the request and frozen in the Runner
  ledger; the Runner re-validates mounts and NPU selection.
- Owner is `{sessionId, agentId}`; a foreign owner gets the same uniform refusal
  as an unknown execution.
- The Runner's environment mutation gate reads `execution_resources`
  (`SD` execution-manager.ts:337); a research run is such a row, so an unproven
  termination blocks install/delete without new code.
- The runtime check's reservations (R11) keep their own meaning and are not
  replaced by the run's lease.

## 5. D. State machine and failure contract

### 5.1 One execution, four orthogonal facts

Do not collapse these into one status. The engine itself keeps them separate:
while reporting, the record is `status="running", phase="reporting"`; the final
write sets `phase="finished"` and `status = "failed"` when research completed
but the report did not (`SF` worker.py:101-113, `:129-141`).

| Field | Values | Authoritative evidence |
| --- | --- | --- |
| `execution` | `queued`, `running`, `completed`, `failed`, `cancelled`, `unknown` | Runner ledger + boundary proof |
| `research` | `not-started`, `running`, `completed`, `failed`, `stopped`, `unknown` | engine record `research_status` and terminal `status` |
| `report` | `none`, `generating`, `ready`, `generation-failed`, `incomplete`, `unknown` | engine record `report_status`, `report_timed_out` |
| `evaluation` | `not-run`, `unknown` | v1 never derives this from the report (§5.5) |

`phase` is **optional** in the DTO with exactly three legal values —
`research`, `reporting`, `finished`. When the record is unreadable, absent, or
carries a value outside that set, the field is **omitted** and the observation is
`unavailable`; the DTO never carries `phase: "unknown"` or any other value
outside its own enum. `research`, `report` and `evaluation` keep explicit
`unknown` members because they are public enums; they are never filled with the
nearest known value. `evaluation: "not-run"` means the control plane's own
independent re-evaluation has not run for this execution — it says nothing about
whether the engine invoked its internal evaluator.

Engine record shapes (exact, from `SF` worker.py:101-141), and the public
mapping (no invented combinations):

| Engine record | `execution` | `research` | `report` | Public summary |
| --- | --- | --- | --- | --- |
| `starting`, process alive, no terminal write | running | `unknown` until a positive research record exists; `running` only after the supervisor's own `status=running` write | `none` | `running` |
| `status=running, phase=reporting, report_status=generating` | running | from `research_status` (`completed` / `failed` / `stopped`) | `generating` | `running` (phase `reporting`) |
| `status=completed, phase=finished, research_status=completed, report_status=ready` | completed | `completed` | `ready` | `completed` |
| `status=failed, phase=finished, research_status=completed, report_status=generation_failed` | failed | `completed` | `generation-failed` | **`failed`, with research completed** — never "success" |
| `status=failed, phase=finished, research_status=failed, report_status=*` | failed | `failed` | from the record | `failed` |
| `status=stopped, phase=finished, research_status=stopped, report_status=*` | cancelled | `stopped` | from the record | `cancelled` |
| engine record `status=stopped, research_status=not-started, phase=finished` (E3 short-circuit) | cancelled | `not-started` | `none` | `cancelled`, `stopStage: "before-supervisor"` |
| no record, termination proven, **durable stop intent exists** | cancelled | `unknown` | `unknown` | `unknown` + `stopConfirmed: true` — a process fact, **never** "research cancelled" |
| no record, termination proven, **no stop intent** (crash) | failed | `unknown` | `unknown` | `failed` — the process ended and nothing was recorded |
| no record, termination unproven | unknown | `unknown` | `unknown` | `unknown` |
| record still `starting`, termination proven, consumed stop, **no** pre-research terminal record | cancelled | `unknown` — a missing `running` write is not evidence | `none` | `cancelled` + `stopConfirmed`; `not-started` is claimed only from the E3 record or the `not-namespace-init` event |
| record non-terminal, termination **proven**, durable stop intent | cancelled | from `research_status` when present, else `unknown` | `incomplete` / `unknown` | `cancelled`; never `completed`, report never `ready` |
| record non-terminal, termination **proven**, **no** stop intent | failed | from `research_status` when present, else `unknown` | `incomplete` / `unknown` | `failed`; never `completed` |
| record non-terminal, termination **unproven** | unknown | `unknown` | `unknown` | `unknown`; fences retained, nothing published |
| unreadable or self-contradictory record, process outcome unknown | unknown | `unknown` | `unknown` | `unknown` |

The rows the first revision got wrong are now explicit: a
research-completed/report-failed run is `execution=failed` with `research=completed`
(not "completed + generation_failed" as a single status); a missing record after
a confirmed stop may state only the **stop**, never a research outcome; and a
non-terminal record is `unknown` whenever **termination is unproven** — once
termination is proven, the row splits by stop intent (`cancelled` vs `failed`).
Process evidence (`terminationReason`) and the `research` field are different
vocabularies: after a spawn the process evidence is `spawned-then-terminated`,
while `research: not-started` is claimed only from a positive pre-research
protocol record or event (§5.2).

### 5.2 Failure windows and the three-way process classification

The Runner distinguishes exactly three points, and no others:

| Point | Evidence rule | Allowed states |
| --- | --- | --- |
| **Never spawned** — a typed pre-spawn error before any process existed: refusal before durable accept (no Runner row at all), or in-gate verification failure **after** accept (the row exists) | No spawn flag; the error names why | `failed` + `research: not-started`; process evidence `not_started`. If the row was already accepted it stays queryable in that state — the acceptance is never retracted (§7.2 V7–V9, V13) |
| **Spawned, termination confirmed** | The boundary handle was captured and the namespace was proven empty | `failed`, `completed` or `cancelled`, process evidence `spawned-then-terminated`; `research` from the record if present, else `unknown` — `not-started` only from the E3 pre-research record or the `not-namespace-init` event (§3.5) |
| **Spawned, termination unproven** | No handle, unreadable `/proc`, or a live leftover | `unknown`; workspace/environment/device fences retained; no publication |

Rules:

- `changed` alone is not the classification (§1.14). The research kind carries a
  **spawn flag** set inside the boundary callback, and two vocabularies stay
  apart:
  - **Process evidence** (`processTerminated`, `terminationReason`):
    `not_started` means no process was created. It requires no spawn flag plus a
    typed pre-spawn error. After a spawn it is never written; the evidence is
    `spawned-then-terminated` (boundary proven) or unverified.
  - **`research: not-started`** is a research outcome, not process evidence. After
    a spawn it is stated only from a positive, correlated pre-research signal —
    the E3 pre-research terminal record, or the bootstrap's `not-namespace-init`
    event — together with a proven-empty namespace. A missing `status=running`
    write or a missing `ready` file is not evidence on its own.

  Everything else is "spawned and failed/unknown", never "did not run". This is a
  small additive change at the evidence construction
  (`SD` execution-manager.ts:402-403): for the research kind,
  `processTerminated` / `terminationReason` derive from the spawn flag and the
  boundary proof, not from `changed`.
- A record that never appears after a spawn means **unknown research**, not
  "nothing ran". The Runner stops via the control channel, proves the namespace,
  and still reports `research: unknown`.
- Enumeration of the state root supplies a **candidate** association only. It
  must be jointly verified against the ledger row (`executionId`, `attempt`,
  `requestDigest`), the persisted boundary handle, the path-derived state root,
  and the record's `run_id` / `attempt` / `launch_token` digest before the
  execution is adopted. No automatic adoption, replay, or re-dispatch.

| Window | Contract |
| --- | --- |
| Duplicate request, same `executionId` + digest | Existing row returned (`accepted: false`); no new attempt (`SD` execution-manager.ts:245-256) |
| Same `executionId`, different digest | 409 `EXECUTION_ID_CONFLICT`; no dispatch |
| Concurrent start, same plan/workspace | API row uniqueness on `(planId, attempt)`; Runner `withWorkspaceAdmission` serializes; the engine's cross-run registry lock is not the guard (per-execution state roots) |
| Failure before durable accept | The API persists `requested` before dispatch; a Runner refusal before admission records `not_started` |
| Accepted response lost | Retry with the same `executionId`/digest returns the existing execution; no replay |
| Spawn callback fails (identity unreadable, ledger refuses the row) | The executor terminates the child; confirmed → `failed` + `research: unknown`; unconfirmed → `unknown` + fences (`SD` executor.ts:1400-1418) |
| Spawned, `runId`/association save fails | The run keeps running under its boundary handle; the state root derives from `executionId`; reconciliation uses the joint verification above; no kill on the basis of a missing file alone |
| Spawned, no record within the prepare bound | Stop via the control channel, prove, then `failed` + `research: unknown`; unproven → `unknown` |
| Engine started, API timeout | The Runner row is authoritative; the API retries observation; no second dispatch |
| Runner restart | Non-terminal rows stay `unknown` (R10) and keep their persisted owner, handle and fences; the rebuilt Runner re-reads the recorded boundary and scans it — a clean scan records `terminationConfirmed`, residue or an unscannable boundary leaves it unproven. Nothing is replayed, resumed or auto-published; a boot change never signals (§3.5) |
| Stop vs natural finish | The stop intent is durable before any channel write; whichever terminal record the engine writes decides `research`; the Runner never rewrites a terminal record |
| Descendants / report phase alive after the monitor exits | Wait within the grace, then kill and prove; unproven → `unknown` + fences |
| Cancel/storage failure | A failed intent write means no signal (R10 rule); a failed final save keeps the intent on disk and retries within the existing bounded policy |
| Engine record missing or conflicting | `unknown`; a stop-confirmed process fact may be stated, a research outcome may not |
| Deleted session/project | A start under a deleted session is refused; an active execution keeps its owner and is stopped or tombstoned, never resurrected; the public row is tombstoned and never listed |
| Runner/session selection withdrawn | No new start; an active run is observed and stopped normally; ownership never silently changes |
| Resume request | **Unsupported in v1**: 409 `RESUME_UNSUPPORTED`; a restart is never called a resume |

### 5.3 Unknown is terminal for the control plane, not for the world

`unknown` means "the control plane cannot prove an outcome". It is never
translated into `completed` or `cancelled`, it never releases the workspace,
environment or device fences, and it is never auto-retried.

What the existing Runner actually does, stated without upgrade:

- `reconcileRecordedBoundaries()` replaces a stale **observation** with the
  current kernel truth and explicitly "never changes a state, never releases a
  fence, and never re-runs anything" (`SD` execution-manager.ts:646-677).
- Cancelling an execution that is already `unknown` records the intent, may
  signal a verified boundary, and **still leaves the state `unknown`** even when
  termination is confirmed (`:719-754`); the quarantine is not released there.

So no current mechanism turns `unknown` into a terminal state. A future
conversion is `[todo]`, is not designed here, and would have to name its
evidence — at minimum a confirmed termination plus a terminal record whose
`launch_token` digest matches the ledger. Until such a mechanism exists, the
public DTO may carry `stopConfirmed` / `terminationConfirmed` as separate facts
while `execution` stays `unknown`. No timer, no boot change and no restart
converts it.

### 5.4 Recovery distinctions

| Operation | Meaning | v1 |
| --- | --- | --- |
| Reconnect and observe | Ask the Runner for the current state | supported |
| Engine `resume_run()` | New attempt on an existing record (`SF` `.../control/service.py:229`) | **not supported** |
| New attempt | New `executionId`, `attempt+1`, new plan revision | **not supported** (v1: one attempt) |
| Restart from scratch | Re-run with a fresh budget | out of scope |

### 5.5 Exit ≠ completion ≠ evaluation ≠ artifact

- **Process exit** — a boundary fact; proves only that the namespace is empty.
- **Engine completion** — the record's terminal `status`; proves the engine's
  lifecycle ended. It does **not** prove the research produced a valid result.
- **Report readiness** — `report_status="ready"` proves the report was
  generated. It does **not** prove the fixed evaluation contract passed; v1
  reports `evaluation: "not-run"` for every run and never derives validity from
  the report.
- **Artifact import** — not in v1. The only publication is the workspace CAS
  snapshot, which is versioned evidence.
- **Post-terminal window** — after writing the terminal record, the engine still
  runs `_record_terminal_storage` and, on success, `export_success`, and writes
  `task_registration` afterwards (`SF` worker.py:142-160). The Runner must not
  mark `completed` or release anything until the process has exited **and** the
  namespace is proven empty. A missing `task_registration` is a truncated
  export, not a research failure, and it never turns a failed run into a success.

### 5.6 Time contract

All intervals are counted from `t0`, the spawn instant, on a monotonic clock. The
hard deadline is absolute and nothing extends it.

```
t0                 spawn; boundary captured (process.hrtime.bigint())
researchBudget     min(plan wall clock, Runner policy)     engine soft deadline
reportBudget       plan-derived report budget              engine subprocess budget
drainGrace         bounded wait for a stopped engine to finish writing/reporting
verificationWindow bounded budget to prove the namespace empty (R10's grace)
hardDeadline       t0 + hardDeadlineMs                     absolute
forceKillAt        hardDeadline - verificationWindow
stopAt             min(t0 + researchBudget, forceKillAt - (reportBudget + drainGrace))
```

Required relation, checked at admission and refused (never clamped) if violated:

```
hardDeadlineMs >= researchBudget + reportBudget + drainGrace + verificationWindow
```

The timeline:

1. If the engine finishes research before `stopAt`, it reports immediately and
   the only remaining bound is `hardDeadline`.
2. At `stopAt` the Runner persists the stop intent and writes the control file
   (§3.5). The engine then has `reportBudget + drainGrace` to cancel, report and
   exit — that window is **inside** the hard deadline, not after it.
3. At `forceKillAt` the Runner sends the group SIGKILL. This is the last moment
   termination can be *initiated* and still leave the configured verification
   window.
4. From `forceKillAt` to `hardDeadline` the Runner polls the boundary proof.
   Proof of emptiness by `hardDeadline` yields a terminal state.
5. If proof does not complete by `hardDeadline`, the outcome is `unknown` with
   `deadlineViolated: true` and every fence retained. The public budget outcome
   is `termination-initiated-unverified`, **never** "the budget was honoured".

Two different promises, kept apart:

- **Action guarantee (executable):** if the Runner process is alive at
  `forceKillAt`, a termination is initiated no later than that instant.
- **Outcome guarantee (conditional):** the namespace is proven empty by
  `hardDeadline`. SIGKILL cannot compel an uninterruptible (`D`-state) process to
  leave, so this can fail; R10's unverified branch already exists for exactly
  that reason and is not deleted to make the hard cap look absolute.

Clock and restart rules:

- In-process durations use `process.hrtime.bigint()`; persisted timestamps are
  wall clock plus the monotonic value and the boot id, so an observer can tell
  whether two stamps are comparable.
- The sandbox is *designed* to die with the Runner (`--die-with-parent`, §1.7),
  but that is a termination mechanism, not an observation: a forced kill that
  cannot confirm the exit (the `D`-state branch above) is not undone by a
  restart. A restart therefore never recomputes, extends or restarts a deadline,
  never resumes or replays anything, and keeps the persisted owner, boundary
  handle and fences. The row stays `unknown`; a rebuilt Runner re-reads the
  recorded boundary and scans it, and only that scan can report
  `terminationConfirmed` — a residue or an unscannable boundary leaves the
  outcome unproven and releases nothing (§3.5, §5.2).
- A truncated report is `report: incomplete`, the terminal research result is
  preserved, and the public summary is never "success".

### 5.7 Deterministic tie-breaks

| Contention | Winner |
| --- | --- |
| Natural finish and stop intent in the same instant | The record is authoritative: `research_status` when present, otherwise the terminal `status`. A `completed` record stands and the stop is recorded as `stop-not-needed` |
| `status` and `research_status` disagree (e.g. `status=failed, research_status=completed`) | `research_status` wins for `research`; `status` only feeds `execution`/`report`. "Research completed, report failed" is never rendered as research failed |
| Terminal record written, then finish detected | The record is authoritative; the Runner never overwrites it |
| Two stop requests | The first durable intent; later ones are idempotent |
| Reconciliation finds two candidate state roots | Neither is adopted; `unknown` |

## 6. E. Next implementation slice

### 6.1 Goal and boundary

Land the **Runner research-run execution kind with the start/stop/identity
protocol**, exercised against an injected fixture bootstrap, with **no API start
action** (only route stubs that refuse unconditionally), **no table, no input
delivery, and no real research start**. It removes
the process-lifetime half of B1 and the mechanism half of B4; B2, B3 and B5 stay
untouched.

The slice does not claim the full-vision rows in §7.2; each of them names the
later slice it depends on.

### 6.2 Files and interface

| File | Change |
| --- | --- |
| `packages/schema/src/research-run.ts` (new) | `ResearchRunRequest`, `ResearchRunObservation` (four fields + `phase`), `ResearchTimeSchedule`, fixed codes |
| `services/runner/src/research-run.ts` (new) | request validation, trusted config, state-root layout, control channel, observation parsing, stop protocol, time-schedule validation |
| `services/runner/src/executor.ts` | a research launch that reuses `prepareSandboxLaunch()`/`runSandboxed()`, a graceful stop that writes the control file before any kill, and the spawn flag |
| `services/runner/src/execution-manager.ts` | accept the discriminated request; keep the spawn flag; split process evidence `not_started` from `spawned-then-terminated`; stop hook |
| `services/runner/src/server.ts` | three routes, registered in this slice with a handler that refuses unconditionally |
| `packages/executor/src/runner-client.ts` | three methods |
| tests | config, state mapping, failure classification, stop channel, restart, one real bwrap fixture |

Injection and production-safety rules:

- The bootstrap is a constant in `research-run.ts`. Tests pass a fixture module
  through a **test-side dependency** (a constructor option on the manager), which
  the server assembly never supplies. The public route and the config file cannot
  set it; an attempt through either is refused.
- The fixture writes engine-shaped records, reacts to the control file by
  writing `consumed`/`ready`/`stop-ack` and protocol events, and can be told to
  leak a grandchild, to report a non-1 pid, or to forge an ack. A missing marker
  is never used as proof; tests assert the positive event.
- **The production assembly refuses unconditionally in this slice.** `server.ts`
  registers the three routes with a handler that returns the fixed
  `RESEARCH_RUN_DISABLED` (503) before parsing the body. There is no config key,
  environment variable or request field that enables them, and the server
  assembly never wires the test operation. The research operation is reachable
  only by constructing the manager with the harness's injected wiring.
- `RESEARCH_RUN_NOT_CONFIGURED` stays the fixed code for the **later** slice, in
  which routes are enabled and the trusted config is absent.
- The API has no start route at all, and all five blockers remain. The Runner
  entry point's own refusal — not the API's missing route — is what keeps this
  slice non-startable.

### 6.3 Commit split

1. Schema types + client methods (no behavior change).
2. Research-run module + launch + control channel.
3. Execution-manager integration, classification, stop.
4. Server routes + targeted tests.

Each commit is independently reviewable; none touches the API.

### 6.4 Prerequisites and non-goals

Prerequisites: the state-root layout decision; whether a pinned engine patch
(E1/E2/E3, optionally E4) is acceptable; the Runner's trusted config format; the
time-schedule validation rules; the snapshot strategy for a later slice (§4.6).

Non-goals: API start action, tables, input delivery, model gateway, token
metering, remote run-snapshot, resume, artifact import, and any change to
`canStart` or the five blockers.

### 6.5 The input-delivery seam that now exists (round 14)

Section 4.3 described frozen input delivery across hosts as a later slice. One
narrow piece of it is now built, and only that piece:

- The contract builder returns the private bytes that produced each frozen
  digest, and the API assembles them into an explicit entry list
  (`packages/schema/src/scienceflow-input-bundle.ts`).
- The selected Runner independently re-derives the bundle digest, verifies every
  entry, and materializes the tree under its own data directory
  (`services/runner/src/scienceflow-input-bundles.ts`).
- The API records a preparation receipt per plan and serves it as local history
  (`POST/GET .../plans/:planId/prepare-inputs|prepared-inputs`).

What this deliberately does **not** do: mount or bind the bundle into an
execution, rewrite the engine launch manifest, snapshot datasets or the engine
source, or change the runner start path. The five blockers and `canStart:
false` are untouched, and a ready bundle is not evidence that the evaluator,
dependencies, or a research run can execute.

## 7. Acceptance matrices

Two tables, because the slice and the full vision must be separable. Every row is
**design-time**; none was executed this round.

### 7.1 Slice E (Runner primitive, fixture bootstrap, no API)

| # | Precondition | Action / fault | Public result | Persisted result | Process / resource result | Evidence source | Executor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Trusted config present; fixture bootstrap | Valid start | `running` after spawn | Ledger row with digest; boundary handle; state-root record | One namespace; identity captured in the spawn turn | §3.3, §5.1 | targeted, real bwrap, local Runner (implementer) |
| E2 | Same `executionId` + digest | Repeat start | `accepted: false` | Unchanged | One process | `SD` execution-manager.ts:245-256 | targeted |
| E3 | Same `executionId`, other digest | Start | 409 `EXECUTION_ID_CONFLICT` | No change | Nothing spawned | `:53`, `:251` | targeted |
| E4 | Two starts, same workspace | Concurrent | Second waits in admission | Two rows, one running | One namespace at a time | `:286-340` | targeted |
| E5 | In-gate **stub** verification refuses (manifest digest / environment revision) | Start | `failed`, fixed code | `not_started` evidence, no boundary | Nothing spawned | §5.2, §4.5 | targeted |
| E6 | Spawned, record never appears | Start + fixture silence | `failed`, `research: unknown` | Boundary + `.control/consumed` | Stopped via the control channel, namespace proven | §5.2, §3.5 | targeted, real bwrap |
| E7 | Spawned, association save fails | Inject save failure | Stays `running` | Handle + derived state root | Process untouched | §5.2 | targeted |
| E8 | Running, stop after `ready` | Stop | `cancelled`, `research: stopped` | Stop intent, `consumed`, terminal record | `.control/ready` existed, `consumed` carries the `stopId`, the control task cancelled the bound supervisor task once, record reached `status=stopped`, namespace empty | §3.5, E3 | targeted, real bwrap |
| E9a | Reporting, stop, engine with E4 | Stop | `cancelled`, `report: incomplete` | `report_status="incomplete"` | Report subprocess gone, namespace empty | §3.5, E4 | targeted |
| E9b | Reporting, stop, engine **without** E4 | Stop | `cancelled`, `report: unknown` | No terminal record | Namespace empty, record still `phase=reporting` | §3.5, `SF` worker.py:117-124 | targeted |
| E10a | Grandchild leaks, force kill complete and proven | Stop | `cancelled`/`failed` (confirmed) | Fences released only after proof | Namespace empty | §5.2, R10 | targeted |
| E10b | Grandchild survives proof (`D`-state) | Stop | `unknown` | Fences retained; `deadlineViolated` if past the deadline | Workspace/env/device not released | §5.2, §5.6 | targeted |
| E11a | Runner restart mid-run, kernel teardown observable | Kill the Runner | `unknown` | Row, owner and fences retained; rebuilt Runner scans the recorded boundary and records `terminationConfirmed: true` | No auto-publish, no auto-release (restart is not proof) | §1.7, §5.2, §5.6, R10 | targeted — future controllable simulation |
| E11b | Runner restart, boundary unreadable or residue observed | Kill the Runner with a simulated leftover | `unknown` | `terminationConfirmed` unproven | Fences retained; nothing released | §1.7, §5.2, §5.6, R10 | targeted — future controllable simulation; no `D`-state injected this round |
| E12 | Boot change | Restart the host | No signal | Row stays unknown | Fences retained | R10 | targeted |
| E13 | Repeated stop, same intent | Two stop requests | Idempotent | One intent, one `stopId` | One cancel path | §3.5 | targeted |
| E14 | Monitor identity lost (no handle) | Start with capture failure | `failed` / `unknown` per proof | No handle | Child terminated or fenced | `SD` executor.ts:1400-1418 | targeted |
| E15 | Fixture reads a Runner-owned copy; the **original** is modified after spawn | Mutate the original | Workload read the frozen bytes | Recorded digest of what was read equals the frozen digest | Copy unaffected | §4.6 (diagnostics contract) | targeted, real bwrap |
| E15b | Same, but only the endpoint check is available (no copy) | Mutate then restore the original during the run | `endpoint-check: match` while the file *did* change | Diagnostic marked `match` | — | §0.1, §4.6 | targeted — **negative capability test: proves `match` is not integrity** |
| E16a | Environment install/delete while a run holds the read gate | Writer request | Waits | Request queued | No provisioner call until the run ends | `SD` environment-access.ts:13-19, `:34-51` | targeted, real EnvironmentStore |
| E16b | Writer after a normal end | Install / delete | Proceeds | Revision bumped | Fence released | same | targeted, real EnvironmentStore |
| E16c | Writer after an **unproven** termination | Install / delete | Refused by the fence | Nothing written | Fence retained | `SD` environment-access.ts:16, `:375` | targeted, real EnvironmentStore |
| E17a | Ceiling with a slow fixture | Let the clock run | Terminal or `unknown` | Schedule persisted | SIGKILL **initiated** at `forceKillAt`, not later | §5.6 | targeted |
| E17b | Proof cannot complete by `hardDeadline` | Occupied namespace | `unknown`, `deadlineViolated: true` | Fences retained | Not reported as budget honoured | §5.6 | targeted |
| E18 | Fixture module via config or request | Attempt the override | Refused | No row | Nothing spawned | §6.2 | targeted |
| E19 | Stop file present before the supervisor runs | Start with a pre-existing intent | `cancelled`, `research: not-started`, `stopStage: "before-supervisor"` | `consumed` written; E3 pre-research terminal record `{status=stopped, research_status=not-started, phase=finished}`; no `status=running` write | Namespace empty | §3.5, E3 | targeted, real bwrap |
| E20 | Stop intent left in place across many polls | Slow fixture | One cancellation | `consumed` written once for the `stopId` | Control task cancels once; no repeated signal | §3.5, E3 | targeted |
| E21 | Research completed, then stop during reporting | Stop in reporting (first consumption) | `cancelled`, `research: completed`, `report: incomplete`/`unknown` | `research_status` preserved | One delivery of the intent; namespace empty | §3.5, §5.1 | targeted |
| E22 | Forged `/` malformed `/` symlinked `.control` content | Write a bad ack, a symlink, an oversized file | Ignored; no state change on a bad ack | `.control` ownership/mode/inode checks reject it | If the channel is compromised: escalate, `unknown` unless proven | §3.5 | targeted |
| E23 | Bootstrap reports `getpid() != 1` | Start with a fixture asserting 1 | `failed`, `research: not-started` | `not-namespace-init` event; process evidence = spawned then terminated | The bootstrap ran and exited; research never started; namespace empty | §3.3 | targeted, real bwrap |
| E24 | Natural completion, no stop ever arrives | Let the fixture finish | `completed` per the record | Terminal record; no protocol stop event | The control task is cancelled and awaited in `finally`; no waiter survives the phase or the attempt | §3.5, E3 | targeted, real bwrap |

Every expected outcome above is a design expectation. E15/E15b separate the
**positive** integrity property (a copy the workload reads, tested by digesting
what it read) from the **negative** diagnostic property (`match` is not proof).
The stub verification of E5 covers the interface and the refusal path only: real
source, hook and input verification belongs to later slices (V7–V9).
E19's `research: not-started` depends on the E3 pre-research record; without it
the same run may state only `stopConfirmed` with `research: unknown` (§3.5).
E11a/E11b are the two restart evidence strengths: an observable kernel teardown
and an unbounded/unscannable boundary. Neither publishes or releases anything.

### 7.2 Full vision (each row depends on a later slice)

| # | Precondition | Action / fault | Public result | Persisted result | Process / resource result | Depends on | Executor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | Verified plan, blockers present | Start | Refused; blocker list; `canStart: false` | No run row | Nothing spawned | API start slice (not slice E) | design review |
| V2 | Running, API response lost | Retry | Same execution observed | No second dispatch | One process | API slice | targeted |
| V3 | Engine started, API timeout | Retry | Same execution observed | No second dispatch | One process | API slice | targeted |
| V4 | Attempt 2 | Start | Refused in v1 | No row | Nothing spawned | attempt slice | targeted |
| V5 | Session deleted while running | Delete | Start refused; run stopped / tombstoned | Row tombstoned | Owner retained until proof | API slice | targeted |
| V6 | Runner selection revoked | Revoke | No new start; run observed / stopped | Row retained | Fences until proof | API slice | targeted |
| V7 | Input bytes differ from the snapshot manifest | Start | **Accepted (durable row), then `failed` + `research: not-started`** at in-gate verification | Row retained with process evidence `not_started` | Nothing spawned | input-delivery slice | targeted |
| V8 | Environment revision changed after the check | Start | Accepted, then `failed` + `research: not-started` | Same, process evidence `not_started` | Nothing spawned | start-time verification | targeted |
| V9 | Source snapshot digest mismatches, or the checkout cannot be snapshotted | Start | Accepted, then `failed` + `research: not-started`; `INPUT_NOT_IMMUTABLE` / `SOURCE_SNAPSHOT_MISMATCH` | Same, process evidence `not_started` | Nothing spawned | R11 + §4.6/§4.7 | targeted, real Git fixture |
| V10 | Report generated | Observe | `report: ready`, `evaluation: not-run` | Separate fields | — | evaluation slice (not designed) | targeted |
| V11 | Real ScienceFlow, model, dataset | Full start | Out of scope this round; B1–B5 remain | — | — | all of the above | liyuan product scenario (not run) |
| V12 | Native Windows / remote Runner | Same scenarios | — | — | — | — | not run; Node 22 + native host (liyuan) |
| V13 | Dataset cannot be snapshotted | Start | Accepted, then `failed` + `research: not-started` (`INPUT_NOT_IMMUTABLE`) | Row retained with process evidence `not_started` | Nothing spawned | §4.6 | targeted |

No row mixes synthetic fixtures with a real Runner, sandbox with direct mode, or
local with remote. Historical test counts are not this round's results.

## 8. Decisions and remaining blockers

Resolved in this revision (no longer open questions):

1. **Runtime integrity is a copy, not a mount.** For a real start every consumed
   byte comes from a Runner-owned, write-once snapshot — frozen inputs,
   datasets, and the source tree — mounted read-only at the agreed paths;
   anything that cannot be snapshotted refuses the start. The environment is
   protected by the held read gate for the run plus the durable fence across
   restarts. Start-time and post-run checks are **diagnostics**: `match` never
   means "unchanged", because a change-then-restore passes it (§0.1, §4.6).
2. **Stop is a control file plus an event, not a signal to a guessed process.**
   The bootstrap's watcher consumes a `stopId` once and sets an event; `supervise()`
   short-circuits research if the event is already set, otherwise arms exactly one
   control task after its handlers exist that cancels the bound supervisor task
   once across both phases and is cancelled and awaited on every exit path (E3);
   the workload's `ready`/`consumed`/`ack` files are self-reports, and the channel
   is validated through a held dirfd with `O_NOFOLLOW`, owner/mode and size checks
   (§3.5).
3. **Process evidence and the research field are different vocabularies.** The
   three-way spawn classification stands, and process evidence `not_started`
   remains reserved for "no spawn + typed pre-spawn error"; after a spawn the
   process evidence is `spawned-then-terminated` or unverified, while
   `research: not-started` is claimed only from a positive pre-research protocol
   record or event (§5.2).
4. **Execution, research, report and evaluation are separate fields**, with
   `phase` optional and limited to `research|reporting|finished`; `unknown` is
   never written into `phase` (§5.1, §5.5).
5. **The deadline has an action guarantee and a conditional outcome.** Termination
   is initiated by `forceKillAt`; proof by `hardDeadline` is conditional, and a
   failure there is `unknown` + `deadlineViolated`, never "budget honoured"
   (§5.6). No restart extends a deadline.
6. **The gateway is not enforceable yet.** Attribution is not enforcement, and
   the no-bypass egress contract is undesigned (§2.1). B2 and B3 stay blocked.
   Round 17 designs that contract
   ([`scienceflow-model-gateway-budget.md`](./scienceflow-model-gateway-budget.md))
   without implementing it; the decisions above are unaffected.
7. **The slice is separable from the vision, and its production assembly refuses
   unconditionally.** There is no config switch that enables the routes; only the
   test harness wires the operation (§6.2, §7).
8. **A restart is neither a resume nor a proof.** It never auto-resumes, replays,
   recomputes a deadline, or releases a fence; `--die-with-parent` is a
   termination mechanism, not evidence. A rebuilt Runner re-reads the recorded
   boundary and scans it, and residue or an unscannable boundary keeps the row
   `unknown` (§3.5, §5.2, §5.6).

Remaining design blockers (not resolvable by this document alone):

- A tracked, pinned engine revision with E1/E2/E3 is required; without it, no
  path satisfies both the managed record and the sandbox lifetime (§3.6).
- A no-bypass egress contract and a metering gateway are required before B2/B3
  can be cleared (§2.1).
- A snapshot strategy for every consumed input class (and the storage it needs)
  is required before B5 can be cleared for real starts. A deployment statement
  accepting after-the-fact attribution does **not** clear it (§4.6).

None of these decisions authorizes a start: the five blockers and
`canStart: false` remain until each has execution-time evidence.

## Round 13 correction: the namespace init is `bwrap`, not the bootstrap

The Round 12 revision 4 text (§3.3) treats "the bootstrap is PID 1" as a runtime
condition to be asserted, and makes the bootstrap responsible for reaping. The
implementation checkpoint for Round 13 measured the shape on the real sandbox
before accepting that premise, and it does not hold:

```
$ bwrap --unshare-all --unshare-user --die-with-parent --cap-drop ALL \
    --clearenv ... python3 -I -B - <<'PY'
  print(json.loads(open('/proc/self/status'...)))  # reads /proc/self/stat + /proc/1/cmdline
PY
{"self": 2, "ppid": 1, "sid": 0, "pid1": "bwrap"}
```

`bwrap` is PID 1 in the new PID namespace and the fixed Python workload is its
ordinary child. This is bubblewrap's designed shape: the monitor it runs is the
namespace init that reaps orphans, and the payload is a supervised child. The
measurement reproduced twice (a direct launch, and a full `ExecutionManager`
run through the real executor) on Linux 6.18.58.1-microsoft-standard-WSL2,
x86_64, bubblewrap 0.13.1, Python 3.10.12.

Revised shape, unchanged in every other respect:

- The existing `bwrap` init is kept. No argument was added to force the payload
  to PID 1, and there is no second init process.
- The fixed Python code is an **ordinary supervised workload**, not a namespace
  init. It no longer asserts `os.getpid() == 1`, writes no `not-namespace-init`
  event, and is not responsible for reaping: the `bwrap` init reaps the
  namespace, and the Runner's namespace-emptiness proof (§3.5) remains the only
  termination proof.
- Everything else in §3.3 stands: the monitor is the Runner's direct child, the
  boundary is captured in the spawn turn, no signal is sent to a guessed pid, and
  E23's premise (a payload that asserts it is PID 1) is void. What E23 can still
  prove is the weaker, still useful statement that a payload which refuses to
  start produces `failed` + `research: not-started` with
  `spawned-then-terminated` process evidence.
- This is a correction to a premise, not a relaxation of a guarantee. The
  namespace proof, the fence retention on an unproven boundary, and the
  no-fallback-to-direct-spawn rule are unchanged.
