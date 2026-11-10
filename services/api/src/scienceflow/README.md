# ScienceFlow control plane: snapshots, registrations, execution plans

Three control-plane capabilities expose ScienceFlow managed runs that an
administrator has explicitly bound to a ScienceDiscovery Project and Session,
and freeze one static description of a task package. None of them starts
ScienceFlow, imports its Artifacts, executes research code, or claims a
lifecycle the engine did not report. An execution plan in particular is a
**static, immutable contract**: it records what the selected files say, never
that an execution can start.

```text
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/runs/:runId/snapshot
POST /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId/snapshot
POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId
POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/preflight
```

All routes are mounted behind the existing `/api/` Bearer check and reuse the
existing SessionStore. The snapshot route reads the engine's on-disk record
through the Python reader in `services/scienceflow-reader/`. A registration is a
Session-scoped control-plane record that the run was registered here; it can be
listed, read, and re-projected through the same snapshot route. Registrations
persist in `catalog.sqlite`, so they survive an API rebuild.

Files:

| File | Role |
| --- | --- |
| `config.ts` | Loads and validates the admin JSON; exact-identity binding lookup |
| `run-snapshot.ts` | Business-identity query over trusted binding + reader config |
| `dto.ts` | Field-by-field projection onto `packages/schema/src/scienceflow.ts` |
| `http.ts` | Snapshot route handler, input rejection, HTTP status mapping |
| `registration-repository.ts` | Additive SQLite table, typed reads, corruption detection |
| `registration.ts` | Registration create/list/get over identity, write gate, binding |
| `registration-http.ts` | The four registration routes and their status mapping |
| `execution-config.ts` | Optional admin execution profiles; static load-time validation |
| `execution-contract.ts` | Static contract extraction, checks, canonical digest, blockers |
| `execution-plan-repository.ts` | Additive SQLite table, conditional preflight write, corruption detection |
| `execution-plan.ts` | Plan create/list/get/preflight over identity, write gate, profile table |
| `execution-plan-http.ts` | The four plan routes and their status mapping |

## Enable and disable

The feature is **off by default**. Set one environment variable and restart the
API; the file is read once at construction and is not hot-reloaded.

```bash
export SCIENCE_AGENT_SCIENCEFLOW_READER_CONFIG_PATH=/etc/sciencediscovery/scienceflow-reader.json
```

- Unset or blank: off. No file is read, no directory is scanned, and no
  ScienceFlow process is started. The route answers `503 SCIENCEFLOW_READER_DISABLED`.
- Relative values resolve against the repository root (like the other config
  paths), never the process working directory.
- An invalid file stops the API at startup with a static error. No partial
  binding table is served.

## Configuration file (version 1)

```json
{
  "schemaVersion": 1,
  "reader": {
    "pythonExecutable": "/opt/scienceflow/bin/python3",
    "readerScriptPath": "/srv/scienceflow/services/scienceflow-reader/snapshot.py",
    "timeoutMs": 15000
  },
  "bindings": [
    {
      "projectId": "project-1",
      "sessionId": "session-1",
      "runId": "run-1",
      "runRecordPath": "/srv/scienceflow/runs/run-1/control.json",
      "allowedTaskRoots": ["/srv/scienceflow/runs/run-1/tasks/task-a"]
    }
  ]
}
```

Rules enforced at load time:

- File `≤ 1 MiB`; valid JSON object; `schemaVersion` must be `1`.
- `pythonExecutable`, `readerScriptPath`, `runRecordPath`, and every allowed
  task root must be **absolute** paths with no NUL byte. Nothing is discovered
  through `PATH`, the current directory, or a default user directory.
- `timeoutMs` is an integer in `1 .. 2147483647` (Node's timer limit).
- `bindings` is a non-empty array; ids are non-empty strings; every identity
  `(projectId, sessionId, runId)` appears at most once.
- Unknown keys are rejected at every level. One bad entry refuses the whole
  file; the remaining entries are never used. The static error names only the
  level (the file, `reader`, `bindings[i]`), never the key or any value.

The file is admin-trusted configuration. It must live outside the research
workspace; requests, uploads, and engine records cannot supply or override any
of these values, and a request never carries a path, interpreter, root, or
timeout. There is no HTTP or CLI interface for managing bindings in this
round.

## Request

Business identity only. Unsupported query parameters (`?path=`, `?timeoutMs=`,
…) and request bodies are rejected with `400` rather than ignored. Only `GET`
is served.

```bash
curl -sS \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN:?export the token first}" \
  "http://127.0.0.1:4310/api/projects/PROJECT/sessions/SESSION/scienceflow/runs/RUN/snapshot"
```

The response is always `Cache-Control: no-store`.

## Response (contract version 1)

```json
{
  "schemaVersion": 1,
  "run": {
    "runId": "run-1",
    "status": "running",
    "phase": "research"
  },
  "tasks": [
    {
      "taskIndex": 0,
      "reportedMetric": {
        "metricName": "accuracy",
        "metricValue": 0.91,
        "lowerIsBetter": false,
        "source": "lhr_stage_performance"
      },
      "candidate": null
    }
  ],
  "diagnostics": [
    {
      "code": "no_candidate_binding",
      "description": "The run records no candidate for this task."
    }
  ]
}
```

- `run.runId` is the validated request/binding identity, not reader output.
  `status` and `phase` are closed enums (`starting`, `running`, `stopping`,
  `completed`, `failed`, `stopped`, `interrupted`, `unknown`; `research`,
  `reporting`, `finished`, `unknown`). Anything else reads as `unknown`; the
  API never infers research success from an engine status.
- `tasks[].taskIndex` relates tasks within one response only. It is not a
  stable task id, and `taskRoot` is never exposed.
- `reportedMetric` is what the engine recorded, not a final valid score. It
  may exist without a candidate. `source` is `best_stage_manifest`,
  `lhr_stage_performance`, `lhr_state.global_best`, `task_registration`, or
  `unknown`.
- `candidate` is present only when the reader found the file and computed its
  digest: `sha256`, `digestVerified` (`true`/`null`, never fabricated),
  an optional candidate `metric`, and `stageId`. A readable file with a
  matching digest was **not** re-evaluated; no artifact path, evidence
  reference, or download is exposed.
- `diagnostics` carry only known codes and fixed server-side descriptions. An
  unlisted reader code becomes `other`; reader message text and `taskRoot`
  never leave the server.

## HTTP statuses

| Status | `code` | Meaning |
| --- | --- | --- |
| `200` | — | Snapshot projected from a successful read |
| `400` | `SCIENCEFLOW_INVALID_REQUEST` | Malformed/blank identity, encoded separator, query parameter, or body |
| `401` | — | Existing shared Bearer check failed |
| `404` | `SCIENCEFLOW_RUN_NOT_FOUND` | Project, Session, binding missing, or Session belongs to another Project |
| `405` | `SCIENCEFLOW_METHOD_NOT_ALLOWED` | Method other than `GET` |
| `500` | `SCIENCEFLOW_CONFIGURATION_ERROR` | Trusted reader configuration unusable |
| `500` | `SCIENCEFLOW_BINDING_ERROR` | Trusted binding unusable |
| `500` | `SCIENCEFLOW_INTERNAL_ERROR` | Unexpected server failure |
| `502` | `SCIENCEFLOW_READ_FAILED` | Reader exited non-zero (e.g. missing/corrupt run record) |
| `502` | `SCIENCEFLOW_RUN_MISMATCH` | Reader returned a different run; never forwarded |
| `502` | `SCIENCEFLOW_PROTOCOL_ERROR` | Reader stdout/exit violated the protocol |
| `502` | `SCIENCEFLOW_OUTPUT_LIMIT` | Reader exceeded a stream cap |
| `503` | `SCIENCEFLOW_READER_DISABLED` | No config file was supplied |
| `503` | `SCIENCEFLOW_READER_UNAVAILABLE` | Interpreter could not be started |
| `504` | `SCIENCEFLOW_READ_TIMEOUT` | Read exceeded `timeoutMs` and was killed |

Failure bodies use the existing error shape (`{ "code", "error", "details"? }`).
A failed read (including a missing `control.json`) is a read failure, never a
business `404`: the binding exists. The reader's failed snapshot is never
attached; only `details.diagnostics` with whitelisted codes and fixed
descriptions may appear. A failure is never returned as `200`.

## Existing-run registrations

A **registration** records that an administrator-bound run belongs to a
Session. It is not a binding and not a research task:

- The administrator's JSON file still decides which runs may be read
  (`bindings`). A registration never grants access to a run the file does not
  bind; it can only exist while a matching binding does.
- `registrationId` is server-generated and identifies the control-plane record.
  `runId` stays the ScienceFlow managed-run id. They are never interchangeable,
  and `registrationId` is never passed to the engine.
- The record carries six fields and nothing else: `schemaVersion`,
  `registrationId`, `projectId`, `sessionId`, `runId`, `createdAt`. No host path,
  interpreter, task root, binding content, or raw snapshot is stored.
- Registration state is separate from engine state. A successful create means
  the control-plane record exists; it does **not** mean the run is running,
  that research succeeded, or that anything was started, stopped, or resumed.

### Create

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN:?export the token first}" \
  -H "content-type: application/json" \
  --data '{"runId":"run-1"}' \
  "http://127.0.0.1:4310/api/projects/PROJECT/sessions/SESSION/scienceflow/registrations"
```

The body is exactly `{ "runId": "<managed-run-id>" }`. Every other field is
refused with `400`, so a caller cannot supply an identity, timestamp, path, or
status. A create also requires all of the following, in order:

1. The Project exists and the Session exists inside it. A missing Project,
   missing Session, or a Session owned by another Project answers `404`.
2. The Session is writable. A locked or archived Session keeps its established
   `409`; a vanished one keeps its `404`.
3. The reader is configured. If the administrator never supplied the config
   file, create answers `503 SCIENCEFLOW_READER_DISABLED` and nothing is written.
4. The current binding table names this exact `(projectId, sessionId, runId)`.
   An unbound run answers `404 SCIENCEFLOW_REGISTRATION_NOT_FOUND`.

The write is idempotent per business triple. The first success answers `201`
and returns the record; a retry answers `200` with the same stored record and
the original `registrationId`/`createdAt`. A retry re-runs every check above
first, so a revoked write permission or withdrawn binding is never bypassed by
an already-existing row. Because the binding lookup may wait, the Project,
Session, and writability checks run again immediately before the insert: a
Session deleted or made read-only while that lookup was in flight is never
registered. A storage failure surfaces as `500`, never as a success.

### List and detail

```text
GET .../scienceflow/registrations[?limit=N&offset=M]
GET .../scienceflow/registrations/:registrationId
```

- The list is a plain JSON array (no envelope) of that Session's registrations,
  ordered `createdAt` then `registrationId` ascending. `limit` defaults to `100`
  and is clamped to `1..250`; `offset` defaults to `0` and is clamped at `0`.
  Only `limit`/`offset` are accepted; any other parameter answers `400`.
- List and detail read persisted metadata only. They never look up a binding,
  check writability, start Python, or read the run record, so a Session that has
  become read-only still lists what it already registered.
- Detail answers `404` for a registration that is missing, belongs to another
  Session, or names an unreadable id. Query parameters and bodies answer `400`.

```json
{
  "schemaVersion": 1,
  "registrationId": "0e0f3f4a-2c3b-4f4a-9d4c-5e6f7a8b9c0d",
  "projectId": "project-1",
  "sessionId": "session-1",
  "runId": "run-1",
  "createdAt": "2026-11-10T10:15:00.000Z"
}
```

### Registration snapshot

```text
GET .../scienceflow/registrations/:registrationId/snapshot
```

The handler resolves the registration first, then queries the existing run
snapshot path with the registration's **persisted `runId`** and projects it
through the same field allow-list as
`/scienceflow/runs/:runId/snapshot`. The response body is identical to that
route's.

The distinction from a direct snapshot:

| Situation | Answer |
| --- | --- |
| Registration missing or owned by another Session | `404 SCIENCEFLOW_REGISTRATION_NOT_FOUND` |
| Reader not configured | `503 SCIENCEFLOW_READER_DISABLED` |
| Registration exists, but the admin's current binding for its run was withdrawn | `503 SCIENCEFLOW_REGISTRATION_SNAPSHOT_UNAVAILABLE` |
| Otherwise | The run-snapshot status, unchanged (`200`, `502`, `504`, …) |

Withdrawing or re-pointing a binding never edits or deletes metadata. The
registration remains listable and readable; only its snapshot becomes
unavailable until an administrator binds that exact run again. Disabling the
feature by unsetting the config path likewise keeps existing rows: they remain
listable and readable, while create and snapshot answer `503`.

### Registration statuses

| Status | `code` | Meaning |
| --- | --- | --- |
| `200` | — | List, detail, retry (existing), or a projected snapshot |
| `201` | — | A new registration was written |
| `400` | `SCIENCEFLOW_INVALID_REQUEST` | Malformed identity, unsupported query/body, unknown field, or invalid pagination |
| `404` | `SCIENCEFLOW_REGISTRATION_NOT_FOUND` | Missing/other-Session registration, or create for an unbound run |
| `405` | `SCIENCEFLOW_METHOD_NOT_ALLOWED` | Method not served by this route (`Allow` names the accepted ones) |
| `409` | existing Session code | Session locked or archived on create |
| `500` | `SCIENCEFLOW_REGISTRATION_CORRUPT` | A stored row violates the record contract |
| `500` | `SCIENCEFLOW_BINDING_ERROR` | Trusted binding wiring is unusable |
| `500` | `SCIENCEFLOW_INTERNAL_ERROR` | Unexpected server failure |
| `503` | `SCIENCEFLOW_READER_DISABLED` | No config file was supplied |
| `503` | `SCIENCEFLOW_REGISTRATION_SNAPSHOT_UNAVAILABLE` | Registration exists but its run is no longer bound |

### Storage and lifecycle

- The table `science_flow_run_registrations` lives in the API's existing
  `catalog.sqlite` and is created with `CREATE TABLE IF NOT EXISTS`. An older
  data directory upgrades in place on the next start; there is no migration
  step and existing tables are untouched. Registrations survive an API rebuild.
- Deleting a Session removes its registrations; deleting a Project removes every
  registration below it.
- A row that fails validation (invalid JSON, unknown `schemaVersion`, missing
  field, blank `createdAt`, or a payload that disagrees with its columns) is
  reported as `500 SCIENCEFLOW_REGISTRATION_CORRUPT`. It is never skipped,
  repaired, or deleted to satisfy a read.

## ScienceFlow execution plans (static contract)

A **plan** freezes a whitelisted description of one administrator-selected task
package for one Session: task identity, metric, artifact path, evaluator
reference and digest, description digest, file digests, declared budgets, and
the still-unknown capabilities. The frozen contract is immutable; later edits to
the selected files never rewrite it. A **preflight** re-reads the same files and
reports whether they still produce the frozen contract.

Neither capability is an execution authorization. A valid contract means the
files are internally consistent and use a supported form. It does **not** mean
the run can start: `canStart` is always `false` and the same five blockers are
always reported (no connected backend, no model gateway, no enforced budget, no
descendant-process cancellation, unverified engine revision). Do not describe a
static-valid plan as "startable".

### Enable and disable

The capability is **off by default**, independently of the reader
configuration, and is read once at server construction:

```bash
export SCIENCE_AGENT_SCIENCEFLOW_EXECUTION_CONFIG_PATH=/etc/sciencediscovery/scienceflow-execution.json
```

- Unset or blank: off. Create and preflight answer `503
  SCIENCEFLOW_EXECUTION_DISABLED`; list and detail keep reading persisted plans.
- Relative values resolve against the repository root, never the process
  working directory.
- An invalid file stops the API at startup with a static error; no partial
  profile table is served. Changing the file requires a restart.

### Configuration file (version 1)

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "profileId": "circle-packing-default",
      "scienceFlowRevision": "0ef229de1ae126ea04387ce74ae94ffacc437df6",
      "manifestPath": "/srv/scienceflow/manifests/circle-packing.yaml",
      "taskPackageRoot": "/srv/scienceflow/tasks/opt_solver/circle-packing",
      "allowedReadRoots": ["/srv/scienceflow"]
    }
  ]
}
```

- File `≤ 1 MiB`; valid JSON object; `schemaVersion` must be `1`; unknown keys
  are rejected at every level. A static error names only the level
  (`profiles[0]`), never a configured key, value, or path.
- `profileId` is an opaque non-empty key and must be unique; a repeated id
  refuses the whole file rather than letting file order decide.
- `scienceFlowRevision` is a 40-character lowercase hex commit id. It is
  **declared**, not verified: this round never inspects an installation.
- `manifestPath`, `taskPackageRoot`, and every `allowedReadRoots` entry must be
  absolute with no NUL byte. Nothing is discovered through `PATH`, the current
  directory, or a default directory.
- The file is admin-trusted. A request carries only `profileId`; it can never
  supply or widen a path, root, revision, evaluator, or budget.

### Supported manifest subset

The check reads exactly: the profile's manifest, the package's `task.yaml`, the
sibling `_shared/task_defaults.yaml` when present (merged recursively, task leaf
wins, digest recorded), the referenced artifact path, the description file, and
the evaluator entrypoint file's bytes (hashed, never imported or executed).
Nothing else is read.

Supported form: a single task, `phase: run`, `type: lnr`, evaluator backend
`task_package`, budgets as positive finite seconds. Everything outside it is
reported as `unsupported` — never silently ignored:

- multiple tasks, `max_concurrent > 1`;
- `phase` other than `run` (including gate/wait phases), `type` other than
  `lnr`;
- an external `config` include, inline `task` text, resume settings;
- any model-gateway or API-key setting;
- an evaluator backend other than `task_package`;
- a non-positive or non-finite budget.

YAML is parsed with the `core` schema, duplicate mapping keys are refused, and
alias expansion is capped at 100 so one document cannot multiply itself.
Structured files are capped at 256 KiB and the evaluator source at 2 MiB.

### Create

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN:?export the token first}" \
  -H "content-type: application/json" \
  --data '{"profileId":"circle-packing-default","requestId":"plan-request-1"}' \
  "http://127.0.0.1:4310/api/projects/PROJECT/sessions/SESSION/scienceflow/plans"
```

The body is exactly `{ "profileId", "requestId" }`; every other field is
refused with `400`, so a caller cannot supply a path, manifest text, budget,
credential, task override, or plan id. A create requires, in order:

1. The Project exists and the Session exists inside it (`404` otherwise).
2. The Session is writable (`409`/`404` from the existing gate).
3. The current profile table names this exact `profileId` (`404` otherwise).
4. No plan already holds this `(projectId, sessionId, requestId)`.
5. The selected files produce a complete, supported contract (`422
   SCIENCEFLOW_PLAN_CONTRACT_INVALID` with `details.checks`, nothing written).

`(projectId, sessionId, requestId)` is the idempotency identity and the only
one: a retry returns the stored plan without re-reading a single file and keeps
its original `planId`, `createdAt`, and `contractDigest` (`200`); a first
success is `201`. Reusing the identity with a **different** `profileId` is `409
SCIENCEFLOW_PLAN_CONFLICT` — two profiles never merge into one plan. Because the
file reads may await, Project/Session ownership, writability, and the profile are
checked again immediately before the insert.

There is no update or delete route. A plan is frozen: source files changing
later never rewrite it, and only Session/Project deletion removes it.

### List, detail, preflight

```text
GET  .../scienceflow/plans[?limit=N&offset=M]
GET  .../scienceflow/plans/:planId
POST .../scienceflow/plans/:planId/preflight
```

- List is a plain JSON array (no envelope) of that Session's plans, ordered
  `createdAt` then `planId` ascending. `limit` defaults to `100` and is clamped
  to `1..250`; `offset` defaults to `0` and is clamped at `0`. Only
  `limit`/`offset` are accepted; any other parameter is `400`.
- List and detail read persisted metadata only: they never check writability or
  read source files, so a read-only Session still lists what it froze.
- Preflight takes no body and is a write (it persists a result), so it requires
  the Session to be writable. It re-reads the plan's **stored** `profileId` from
  the current configuration; if that profile was withdrawn it answers `503
  SCIENCEFLOW_EXECUTION_DISABLED` and persists nothing — there is no fallback to
  another profile or an old path.
- A preflight is conditional on the revision it read. If a concurrent check
  persisted first, the losing writer returns the persisted winner rather than a
  discarded result. `latestPreflight` on the plan is always that winner.

```json
{
  "schemaVersion": 1,
  "planId": "9f0c…",
  "projectId": "project-1",
  "sessionId": "session-1",
  "profileId": "circle-packing-default",
  "requestId": "plan-request-1",
  "createdAt": "2026-11-10T10:15:00.000Z",
  "contractDigest": "3d1a…",
  "contract": {
    "scienceflow": { "declaredRevision": "0ef229…", "verification": "unverified" },
    "task": { "taskId": "circle-packing", "category": "opt_solver", "profile": null },
    "metric": { "name": "min_distance", "lowerIsBetter": false, "type": "continuous", "authoritative": null },
    "artifact": { "path": "artifacts/best.json", "kind": "json" },
    "evaluator": { "entrypoint": "evaluate.py:score", "path": "evaluate.py", "function": "score", "sha256": "…", "timeoutSec": 300 },
    "description": { "path": "description.md", "sha256": "…" },
    "taskYamlSha256": "…",
    "manifestSha256": "…",
    "sharedDefaultsSha256": null,
    "budgets": [{ "name": "time_limit", "value": 600, "unit": "seconds", "nature": "requested" }],
    "unknowns": {
      "dataset": "not-applicable",
      "environment": "unknown",
      "pricing": "unknown",
      "modelGateway": "unknown",
      "revision": "unverified",
      "dependencyClosure": "incomplete"
    }
  },
  "execution": { "canStart": false, "blockers": [] },
  "latestPreflight": null
}
```

`contractDigest` is SHA-256 over a canonical (recursively key-sorted) encoding of
`contract`, recomputed on every read; a row whose payload disagrees with its
digest is `500 SCIENCEFLOW_PLAN_CORRUPT`, never repaired. Paths are
package-relative; no host path is stored or returned. `unknowns` and
`blockers` are the server's fixed statements about what this round did not
verify. `budgets` are what the files requested — `nature: "requested"` says they
are not enforced.

### Check semantics

Each check carries a closed `code`, one of `passed | failed | unknown |
unsupported`, and a fixed server-side `description`. No check, description, or
error body ever carries raw YAML, a host path, a stack trace, or free-form
engine text.

- `failed`: the file is missing, unreadable, malformed, or contradicts its own
  identity (e.g. artifact path traversal, task id mismatch). The contract is
  rejected.
- `unsupported`: the form is outside the subset above. Rejected for the same
  reason: an unsupported form is not silently approximated.
- `unknown`: a capability neither supported nor contradicted; it appears only in
  the contract's `unknowns`, never as a start permission.
- `passed`: checked and consistent.

Six codes are diagnostics that appear only when their condition is detected:
`manifest_shape`, `manifest_duplicate_key`, `manifest_alias_limit`, and the
`task_yaml_*` equivalents. Their absence means that defect was not found, not
that the file was left unchecked; every other code is reported with a status.
A supported task package therefore answers with 37 of the 43 registered codes.

A preflight adds `contract_changed`: `passed` when the re-read files produce a
digest equal to the frozen one, `failed` otherwise — including when a file is
now unreadable (`observedContractDigest: null`). Its `outcome` is `blocked` if
any check failed or is unsupported, else `passed`. `canStart` stays `false`
either way. An I/O or storage failure is `500`, never a blocked check.

### Plan statuses

| Status | `code` | Meaning |
| --- | --- | --- |
| `200` | — | List, detail, retry (existing plan), or a completed preflight |
| `201` | — | A new plan was frozen |
| `400` | `SCIENCEFLOW_INVALID_REQUEST` | Malformed identity, unsupported query/body, excess field, or invalid pagination |
| `404` | `SCIENCEFLOW_PLAN_NOT_FOUND` | Missing Project/Session/plan, Session in another Project, or unknown profile on create |
| `405` | `SCIENCEFLOW_METHOD_NOT_ALLOWED` | Method not served by this route (`Allow` names the accepted ones) |
| `409` | `SCIENCEFLOW_PLAN_CONFLICT` | Same request id, different profile |
| `409` | existing Session code | Session locked or archived on create/preflight |
| `422` | `SCIENCEFLOW_PLAN_CONTRACT_INVALID` | Selected files are missing, malformed, or unsupported; `details.checks` |
| `500` | `SCIENCEFLOW_PLAN_CORRUPT` | A stored row violates the plan contract |
| `500` | `SCIENCEFLOW_INTERNAL_ERROR` | Unexpected server failure |
| `503` | `SCIENCEFLOW_EXECUTION_DISABLED` | No config file, or the plan's profile was withdrawn |

### Storage and lifecycle

- The table `science_flow_execution_plans` lives in the existing
  `catalog.sqlite` and is created with `CREATE TABLE IF NOT EXISTS`; an older
  data directory upgrades in place. Plans and their latest preflight survive an
  API restart.
- Only `{code, status}` pairs are stored for preflight checks; descriptions are
  rebuilt from the fixed table on read, so no free text is persisted. A stored
  payload that fails validation (bad JSON, digest mismatch, unknown
  code/status, plan or contract mismatch, `outcome` contradicting its checks) is
  `500 SCIENCEFLOW_PLAN_CORRUPT`.
- Deleting a Session removes its plans; deleting a Project removes every plan
  below it.
- Disabling the feature keeps existing rows listable and readable. Withdrawing a
  profile keeps its plans readable but makes their preflight `503`.

### Known plan limits

- No execution, start/stop/resume, event import, artifact import, scheduling,
  budget enforcement, cancellation, or engine-state mirroring.
- One contract per plan; no update route, no re-freeze, no comparison UI.
- Environment, pricing, model gateway, dependency closure, and the installed
  revision stay explicitly unknown; dataset identity is `not-applicable`
  unless a supported dataset reference exists.
- Evaluator bytes are hashed only; the code is never imported, executed, or
  syntax-checked.

### Plan verification checklist (liyuan)

1. Default off: unset the variable, start the API, create/preflight → `503
   SCIENCEFLOW_EXECUTION_DISABLED`; list/detail still `200`.
2. `POST` with `{"profileId","requestId"}` against a supported package → `201`;
   repeat → `200` with the same `planId`; the list still has one entry.
3. Same `requestId`, other `profileId` → `409 SCIENCEFLOW_PLAN_CONFLICT`.
4. Extra field (path, manifest, budget, credential) → `400`; another Session's
   identity → `404`.
5. `POST .../preflight` → `200` with `outcome: "passed"`, `canStart: false`, and
   the five blockers; edit a selected file, preflight again → `outcome:
   "blocked"` with `contract_changed: "failed"`, and the stored contract,
   `planId`, and `contractDigest` unchanged.
6. Unsupported form (config include, model gateway, multiple tasks, resume,
   non-`lnr`) → `422` with the matching fixed codes and nothing written.
7. Remove the profile from the admin file and restart → list/detail `200`,
   preflight `503`; unset the variable and restart → plans retained. Delete the
   Session (or its Project) → its plans are gone.

## Known limits

- Single-service Bearer model: the routes add Project/Session/binding ownership
  checks but claim no multi-tenant per-user authorization.
- One trusted binding table per server; no caching, retry, polling, event
  stream, UI, download, or artifact import.
- Bindings are manual configuration. Creating runs, persisting their lifecycle,
  and real ScienceFlow execution are out of scope.
- Registrations are control-plane metadata only. There is no research-task
  contract, start/stop/resume, event import, scheduling, or engine-state
  mirroring; a registration cannot outlive the administrator's binding for a
  snapshot.
- `digestVerified`/`candidate` describe on-disk evidence only.

## Manual verification checklist (liyuan)

1. Default off: unset the variable, start the API, request the route → `503
   SCIENCEFLOW_READER_DISABLED`, and no ScienceFlow process starts.
2. Correct Bearer → the configured binding answers; wrong/missing Bearer →
   `401` before any read.
3. Bound identity → `200`; another Session, another Project, or an unbound
   `runId` → `404`.
4. Running run without a candidate → `200`, `candidate: null`, diagnostic
   `no_candidate_binding`.
5. Missing `control.json` → `502 SCIENCEFLOW_READ_FAILED` with
   `run_record_missing`.
6. Corrupt `control.json` → `502 SCIENCEFLOW_READ_FAILED` with
   `run_record_invalid_json`.
7. `POST` → `405`; `?path=/etc/passwd` → `400`.

Registration additions (same request setup):

8. `POST .../registrations` with `{"runId":"<bound run>"}` → `201`; repeat →
   `200` with the same `registrationId`, and the list still has one entry.
9. `POST` with any extra field (e.g. `registrationId`, `createdAt`,
   `runRecordPath`) → `400`; an unbound `runId` → `404
   SCIENCEFLOW_REGISTRATION_NOT_FOUND`.
10. Restart the API against the same data directory → the registration is still
    listed (additive table, no migration).
11. `GET .../registrations/:registrationId/snapshot` after removing that binding
    from the admin file and restarting → metadata still readable, snapshot `503
    SCIENCEFLOW_REGISTRATION_SNAPSHOT_UNAVAILABLE`.
12. Unset the config path, restart → list/detail still `200`; create and
    snapshot `503 SCIENCEFLOW_READER_DISABLED`; rows are retained.
13. Delete the Session (or its Project) → its registrations are gone.
