# ScienceFlow run snapshot reader

A standalone, read-only Python function that turns a ScienceFlow managed-run
record plus its task directories into a JSON-serializable snapshot of the run
state and any **evidence-backed** best candidate.

It is a library, not a service: no HTTP, no NDJSON, no background process, no
service discovery. Standard library only.

```python
from snapshot import read_run_snapshot

snapshot = read_run_snapshot(
    "/path/to/managed_runs/<run_id>/control.json",  # or the run directory
    ["/path/to/workspace/task-001"],                # allowed task roots
)
```

Optional convenience CLI (direct invocation, still no server):

```sh
python3 services/scienceflow-reader/snapshot.py <control.json> <task-root> [more roots...]
```

## Where the evidence actually comes from

All citations are in the nested `ScienceFlow/` checkout and were verified
read-only before writing this reader.

| Question | Answer |
| --- | --- |
| What does `control.json.task_registration.path` point to? | The portable task-package directory `task_library/<slug>-<fingerprint[:12]>/` (`scienceflow/research/onboarding/library/export.py:108-141`). It is **not** the candidate file. |
| Which record points at the actually-scored candidate file? | `<task_root>/task_logs/lhr_stage_performance.csv`. Each row carries `metric_value` + `snapshot_path` + `artifact_path` + `stage_id` (`.../coordinator/shared.py:319-410`, `.../evaluation/adapter.py`). The scored file is `snapshot_path / artifact_path`. |
| Is there a reliable score/file/stage binding? | Yes, in that CSV. `merge/best_stage_manifest.json` also binds them, but inside `selected_candidate` (`.../finalization/artifacts/materialize.py:294-375`); its top level only holds the materialized path and digest. `lhr_state.json` `global_best` has no artifact path. |

Therefore the reader uses, in order:

1. `merge/best_stage_manifest.json` when `status == "success"` (the engine's
   materialized best; digest recorded by `_sha256_file`). The binding comes from
   `selected_candidate`.
2. `task_logs/lhr_stage_performance.csv` best eligible row as a fallback.
3. `lhr_state.json` / `global_best` and `control.json.task_registration.best_metric`
   only feed `reportedBestMetric` — they never produce a `candidateArtifact`.

`provenance.json` (inside the portable package) is deliberately not read: its
`best_metric` is a run-level summary, not a confirmed artifact.

## Snapshot schema

```jsonc
{
  "schemaVersion": 1,
  "runId": "<string | null>",
  "rawStatus": "<control.json.status as-is | null>",
  "phase": "<control.json.phase as-is | null>",
  "tasks": [
    {
      "taskRoot": "<raw task_roots entry>",
      "reportedBestMetric": {          // engine-recorded score only
        "metricName": "<string|null>", "metricValue": 0.0,
        "lowerIsBetter": "<bool|null>",
        "source": "best_stage_manifest | lhr_stage_performance | lhr_state.global_best | task_registration"
      },
      "candidateArtifact": {           // only when evidence is sufficient
        "path": "<absolute, verified inside an allowed root>",
        "sha256": "<computed this call>",
        "recordedSha256": "<string|null>",
        "digestVerified": "<true|null>",   // true = matches the recorded sha; null = no recorded sha
        "scoreSource": "best_stage_manifest | lhr_stage_performance",
        "metricName": "<string|null>", "metricValue": 0.0,
        "lowerIsBetter": "<bool|null>",
        "stageId": "<string|null>", "candidateId": "<string|null>",
        "validationOk": "<bool|null>"
      },
      "evidenceReferences": ["merge/best_stage_manifest.json", "..."]  // relative to taskRoot
    }
  ],
  "diagnostics": [{"code": "...", "message": "...", "taskRoot": "<optional>"}]
}
```

The three states are kept distinct: **file exists** (path verified), **digest
checked** (`digestVerified`), and **evaluation binding present**
(`scoreSource`/`stageId`/`metricValue`). None of them means "re-evaluated and
passed".

## Safety

- Reads only the explicitly passed run record and files resolving inside
  `allowed_task_roots`. It never derives the default ScienceFlow registry
  directory (`~/.local/state/scienceflow`) or any other user directory.
- Every derived path (`task_roots`, `snapshot_path`, `artifact_path`,
  `final_dir`) is `realpath`-resolved and must stay inside an allowed root;
  traversal and symlink escape are rejected.
- Structured metadata is size-capped (JSON 1 MiB, CSV 16 MiB); candidate digests
  are streamed in 1 MiB chunks.
- Source records are never modified, copied, imported, or executed.

## What still cannot be confirmed

`candidateArtifact` is `null` (with a diagnostic) when:

1. there is no `merge/best_stage_manifest.json` and no
   `lhr_stage_performance.csv` row that upstream classifies as
   `valid_comparable` (validation failed, `selection_eligible`/`candidate_ready`
   not true, `metric_validity=low`, or `submission_status=invalid_submission`
   rows are never eligible);
2. the manifest status is `no_valid_candidate`, `missing_artifact`, or
   `artifact_sha_mismatch` and the CSV has no valid candidate;
3. the candidate file is missing, escapes the allowed roots, or its digest no
   longer matches the record;
4. only a portable package / `global_best` / final-report number exists — that
   becomes `reportedBestMetric` with a weak source, never a candidate.

## Targeted checks

```sh
python3 -m unittest discover -s services/scienceflow-reader/tests -v
```

Fixtures are synthetic and trimmed from the real record shapes; no credentials
or research runtime are used.
