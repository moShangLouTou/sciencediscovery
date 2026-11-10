# ScienceFlow existing runs: snapshot and registration (read-only)

Two control-plane capabilities expose ScienceFlow managed runs that an
administrator has explicitly bound to a ScienceDiscovery Project and Session.
Neither one starts ScienceFlow, imports its Artifacts, executes research code,
or claims a lifecycle the engine did not report.

```text
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/runs/:runId/snapshot
POST /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/registrations/:registrationId/snapshot
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
