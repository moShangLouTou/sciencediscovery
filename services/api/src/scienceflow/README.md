# ScienceFlow run snapshot query (internal, read-only)

`run-snapshot.ts` exposes one ScienceFlow managed run to the backend. It is an
internal module: it is **not** wired into the HTTP entry point, and it performs
no authentication or authorization of its own. A future route must call it
after the existing shared authentication and must map the result through a
field allow-list before it leaves the server.

## Call

```ts
import { createScienceFlowRunSnapshotQuery } from "./run-snapshot.js";

const query = createScienceFlowRunSnapshotQuery({
  identities: store, // SessionStore satisfies the minimal read-only interface
  resolveBinding: bindings, // trusted resolver: identity -> record + task roots
  readerConfig: {
    pythonExecutable: "/opt/scienceflow/bin/python3",
    readerScriptPath: "/srv/scienceflow/services/scienceflow-reader/snapshot.py",
    timeoutMs: 15_000,
  },
});

const result = await query({ projectId, sessionId, runId });
if (result.status === "ok") {
  // result.snapshot is the reader's snapshot for exactly this run.
}
```

## Boundary

- Input is business identity only (`projectId`, `sessionId`, `runId`). Paths,
  interpreter, reader script, and deadline come from trusted dependencies; a
  request can never select a host directory.
- The binding resolver must return paths derived from server state. A binding
  whose `projectId`, `sessionId`, or `runId` differs from the query, that has
  an empty record path, or that has no allowed task roots is rejected before
  the reader runs. Nothing falls back to a user directory or a global root.
- The identity store is only consulted for existence and
  `session.projectId === projectId`. A Session in another Project is reported
  as `not-found`/`session`, the same as a missing one.
- This module never writes: no store mutation, no engine record change, no
  Artifact copy, no cache, and no retry. Every query re-reads.

## Result

Callers branch on `status` (and `reason`/`resource`), never on message text.

| `status` | Meaning |
| --- | --- |
| `ok` | Exit 0, valid snapshot, `snapshot.runId === binding.runId` |
| `not-found` | Project, Session, or binding does not exist |
| `invalid` | Unusable query, reader configuration, or binding; reader not called |
| `run-mismatch` | The reader returned a snapshot for a different run |
| `reader-failed` | Non-zero exit with a valid snapshot for the same run; stays a failure |
| `spawn-failed` | The interpreter could not start |
| `timeout` | The read exceeded `timeoutMs` and was killed |
| `output-limit` | The reader exceeded a protocol stream cap and was killed |
| `protocol-error` | Exit status/stdout violated the reader protocol |
| `internal-error` | A trusted dependency threw; details are not returned |

A successful snapshot may still carry diagnostics and `candidateArtifact:
null` (for example while the run is still working). `reportedBestMetric` is
what the engine recorded, not a finally valid result, and this module does not
infer delivery completion from the raw engine status.

## Not a public DTO

The snapshot contains absolute paths, and diagnostic messages can mention
paths. Any HTTP layer must define an explicit field allow-list and project the
diagnostics instead of returning the snapshot as-is. No download endpoint,
Artifact registration, or event stream is provided here.
