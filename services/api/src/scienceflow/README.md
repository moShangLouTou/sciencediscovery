# ScienceFlow managed-run snapshot (read-only)

One HTTP route exposes a ScienceFlow managed run that an administrator has
explicitly bound to a ScienceDiscovery Project and Session:

```text
GET /api/projects/:projectId/sessions/:sessionId/scienceflow/runs/:runId/snapshot
```

It is mounted behind the existing `/api/` Bearer check and reuses the existing
SessionStore. It reads the engine's on-disk record through the Python reader in
`services/scienceflow-reader/`; it never starts ScienceFlow, imports its
Artifacts, executes research code, or writes anything.

Files:

| File | Role |
| --- | --- |
| `config.ts` | Loads and validates the admin JSON; exact-identity binding lookup |
| `run-snapshot.ts` | Business-identity query over trusted binding + reader config |
| `dto.ts` | Field-by-field projection onto `packages/schema/src/scienceflow.ts` |
| `http.ts` | Route handler, input rejection, HTTP status mapping |

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
  file; the remaining entries are never used.

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

## Known limits

- Single-service Bearer model: the route adds Project/Session/binding
  ownership checks but claims no multi-tenant per-user authorization.
- One trusted binding table per server; no caching, retry, polling, event
  stream, UI, download, or artifact import.
- Bindings are manual configuration. Creating runs, persisting their lifecycle,
  and real ScienceFlow execution are out of scope.
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
