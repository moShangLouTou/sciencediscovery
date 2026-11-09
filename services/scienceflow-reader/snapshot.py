"""Read-only snapshot reader for ScienceFlow managed-run records.

Given an explicit managed-run record (``control.json``) and the task-root
directories the caller allows access to, return a JSON-serializable snapshot of
the run state and any best candidate artifact that can be confirmed from on-disk
evidence.

Design rules (see ``README.md``):

* Never derive or read the default ScienceFlow registry directory. Only the
  explicitly passed run record and files inside ``allowed_task_roots`` are read.
* Resolve every derived path and reject traversal / symlink escape.
* Compute candidate digests by streaming.
* Distinguish "the file exists", "the digest matches the recorded sha", and
  "there is an evaluation binding". None of these means the candidate was
  re-evaluated and passed.
* Missing evidence yields ``None`` plus a structured diagnostic; never a guess.

Standard library only.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os

__all__ = ["read_run_snapshot", "SCHEMA_VERSION"]

SCHEMA_VERSION = 1

#: Upper bound for structured metadata (control.json, manifest, lhr_state.json).
_JSON_LIMIT = 1 * 1024 * 1024
#: Upper bound for the stage-performance ledger.
_CSV_LIMIT = 16 * 1024 * 1024
#: Streaming chunk size for candidate digests.
_CHUNK = 1024 * 1024

_STAGE_CSV_REL = "task_logs/lhr_stage_performance.csv"
_MANIFEST_REL = "merge/best_stage_manifest.json"
_AGG_LHR_STATE_REL = "task_logs/lhr_state.json"

_MISSING = object()


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def read_run_snapshot(run_record_path, allowed_task_roots):
    """Read a ScienceFlow managed-run record and its task directories.

    ``run_record_path`` is the path to ``control.json`` (a directory that
    contains it is also accepted). ``allowed_task_roots`` is a single path or
    an iterable of paths; only files that resolve inside these roots are read.

    Returns a JSON-serializable ``dict``. See ``README.md`` for the schema.
    """

    diagnostics = []
    roots_real = _normalized_roots(allowed_task_roots)
    record = _load_run_record(run_record_path, diagnostics)

    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": None,
        "rawStatus": None,
        "phase": None,
        "tasks": [],
        "diagnostics": diagnostics,
    }
    if record is None:
        return snapshot

    run_id = record.get("run_id")
    if isinstance(run_id, str) and run_id:
        snapshot["runId"] = run_id
    else:
        diagnostics.append(_diag("run_record_missing_run_id", "Run record has no run_id."))

    status = record.get("status")
    snapshot["rawStatus"] = status if isinstance(status, str) else None
    phase = record.get("phase")
    snapshot["phase"] = phase if isinstance(phase, str) else None

    registration = record.get("task_registration")
    registration_metric = None
    if isinstance(registration, dict):
        registration_metric = _to_float(registration.get("best_metric"))

    task_roots = _normalize_task_roots(record.get("task_roots"))
    # The run-level registration score names a single exported package; it is
    # only unambiguous when the run has exactly one task root.
    ambiguous_registration = len(task_roots) != 1
    for raw_root in task_roots:
        snapshot["tasks"].append(
            _read_task(
                raw_root,
                roots_real,
                None if ambiguous_registration else registration_metric,
                diagnostics,
            )
        )
    return snapshot


# ---------------------------------------------------------------------------
# Run record
# ---------------------------------------------------------------------------


def _normalize_task_roots(value):
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def _load_run_record(run_record_path, diagnostics):
    if run_record_path is None:
        diagnostics.append(_diag("run_record_missing", "No run record path was provided."))
        return None
    path = os.path.abspath(os.fspath(run_record_path))
    if os.path.isdir(path):
        path = os.path.join(path, "control.json")

    data, error = _load_json(path, _JSON_LIMIT)
    if error == "metadata_too_large":
        diagnostics.append(
            _diag("run_record_too_large", f"Run record exceeds {_JSON_LIMIT} bytes.")
        )
        return None
    if error == "metadata_invalid_json":
        diagnostics.append(_diag("run_record_invalid_json", "Run record is not valid JSON."))
        return None
    if data is _MISSING:
        diagnostics.append(_diag("run_record_missing", f"Run record not found: {path}"))
        return None
    if not isinstance(data, dict):
        diagnostics.append(_diag("run_record_invalid_json", "Run record is not a JSON object."))
        return None
    return data


# ---------------------------------------------------------------------------
# Per-task reading
# ---------------------------------------------------------------------------


def _read_task(raw_root, roots_real, registration_metric, diagnostics):
    evidence = []
    task = {
        "taskRoot": raw_root if isinstance(raw_root, str) else None,
        "reportedBestMetric": None,
        "candidateArtifact": None,
        "evidenceReferences": evidence,
    }
    if not isinstance(raw_root, str) or not raw_root.strip():
        diagnostics.append(_diag("task_root_missing", "task_roots entry is not a non-empty string."))
        return task

    task_root_real = os.path.realpath(os.path.abspath(raw_root))
    if not any(_within(root, task_root_real) for root in roots_real):
        diagnostics.append(
            _diag(
                "task_root_out_of_bounds",
                "Task root resolves outside the allowed roots.",
                raw_root,
            )
        )
        return task
    if not os.path.isdir(task_root_real):
        diagnostics.append(
            _diag(
                "task_root_missing",
                "Task root does not exist or is not a directory.",
                raw_root,
            )
        )
        return task

    manifest = _read_task_json(task_root_real, _MANIFEST_REL, evidence, diagnostics, raw_root)
    csv_rows = _read_stage_performance(task_root_real, evidence, diagnostics, raw_root)
    lhr_best = _read_lhr_state_best(task_root_real, evidence, diagnostics, raw_root)

    task["reportedBestMetric"] = _reported_best_metric(
        manifest, csv_rows, lhr_best, registration_metric
    )
    task["candidateArtifact"] = _candidate_artifact(
        manifest, csv_rows, task_root_real, roots_real, diagnostics, raw_root
    )
    return task


def _read_task_json(task_root_real, rel, evidence, diagnostics, task_root):
    path = os.path.join(task_root_real, rel)
    resolved = os.path.realpath(path)
    if not _within(task_root_real, resolved):
        diagnostics.append(
            _diag("candidate_path_out_of_bounds", f"{rel} resolves outside the task root.", task_root)
        )
        return None

    data, error = _load_json(resolved, _JSON_LIMIT)
    if error == "metadata_too_large":
        diagnostics.append(
            _diag("metadata_too_large", f"{rel} exceeds {_JSON_LIMIT} bytes.", task_root)
        )
        return None
    if error == "metadata_invalid_json":
        diagnostics.append(_diag("metadata_invalid_json", f"{rel} is not valid JSON.", task_root))
        return None
    if data is _MISSING:
        return None
    if not isinstance(data, dict):
        diagnostics.append(
            _diag("metadata_invalid_json", f"{rel} is not a JSON object.", task_root)
        )
        return None
    evidence.append(rel)
    return data


def _read_stage_performance(task_root_real, evidence, diagnostics, task_root):
    path = os.path.join(task_root_real, _STAGE_CSV_REL)
    resolved = os.path.realpath(path)
    if not _within(task_root_real, resolved):
        diagnostics.append(
            _diag(
                "candidate_path_out_of_bounds",
                f"{_STAGE_CSV_REL} resolves outside the task root.",
                task_root,
            )
        )
        return []
    try:
        if not os.path.isfile(resolved):
            return []
        if os.path.getsize(resolved) > _CSV_LIMIT:
            diagnostics.append(
                _diag(
                    "metadata_too_large",
                    f"{_STAGE_CSV_REL} exceeds {_CSV_LIMIT} bytes.",
                    task_root,
                )
            )
            return []
    except OSError:
        return []

    rows = []
    try:
        with open(resolved, "r", encoding="utf-8-sig", newline="") as handle:
            for raw in csv.DictReader(handle):
                parsed = _parse_stage_row(raw)
                if parsed is not None:
                    rows.append(parsed)
    except (OSError, csv.Error, UnicodeError):
        diagnostics.append(
            _diag(
                "metadata_invalid_csv",
                f"{_STAGE_CSV_REL} could not be parsed as CSV.",
                task_root,
            )
        )
        return []
    evidence.append(_STAGE_CSV_REL)
    return rows


def _parse_stage_row(raw):
    metric_value = _to_float(raw.get("metric_value"))
    if metric_value is None:
        return None
    lower = _to_bool(raw.get("lower_is_better"))
    if lower is None:
        lower = True  # score_summary.py default
    return {
        "metricValue": metric_value,
        "metricName": _clean(raw.get("metric_name")),
        "lowerIsBetter": lower,
        "validationOk": _to_bool(raw.get("validation_ok")),
        "selectionEligible": _to_bool(raw.get("selection_eligible")),
        "candidateReady": _to_bool(raw.get("candidate_ready")),
        "candidateId": _clean(raw.get("candidate_id")),
        "stageId": _clean(raw.get("stage_id")),
        "workerId": _clean(raw.get("worker_id")),
        "snapshotPath": _clean(raw.get("snapshot_path")),
        "artifactPath": _clean(raw.get("artifact_path")),
        "artifactSha": _clean_lower(raw.get("artifact_sha")),
        "submissionSha": _clean_lower(raw.get("submission_sha")),
        "metricValidity": _clean(raw.get("metric_validity")),
    }


def _read_lhr_state_best(task_root_real, evidence, diagnostics, task_root):
    aggregate = _read_task_json(
        task_root_real, _AGG_LHR_STATE_REL, evidence, diagnostics, task_root
    )
    if isinstance(aggregate, dict):
        best = _global_best_from(aggregate)
        if best is not None:
            return best

    workers_dir = os.path.join(task_root_real, "workers")
    if not _within(task_root_real, os.path.realpath(workers_dir)):
        return None
    try:
        names = sorted(os.listdir(workers_dir))
    except OSError:
        return None

    for name in names:
        rel = f"workers/{name}/logs/lhr_state.json"
        state = _read_task_json(task_root_real, rel, evidence, diagnostics, task_root)
        if isinstance(state, dict):
            best = _global_best_from(state)
            if best is not None:
                return best
    return None


def _global_best_from(state):
    best = state.get("global_best")
    if not isinstance(best, dict):
        return None
    value = _to_float(best.get("metric_value"))
    if value is None:
        return None
    return {
        "metricName": _clean(best.get("metric_name")),
        "metricValue": value,
        "lowerIsBetter": _to_bool(best.get("lower_is_better")),
        "source": "lhr_state.global_best",
    }


# ---------------------------------------------------------------------------
# Best metric and candidate artifact
# ---------------------------------------------------------------------------


def _reported_best_metric(manifest, csv_rows, lhr_best, registration_metric):
    if isinstance(manifest, dict) and manifest.get("status") == "success":
        selected = manifest.get("selected_candidate")
        if isinstance(selected, dict):
            value = _to_float(selected.get("metric_value"))
            if value is not None:
                return {
                    "metricName": _clean(selected.get("metric_name")),
                    "metricValue": value,
                    "lowerIsBetter": _to_bool(selected.get("lower_is_better")),
                    "source": "best_stage_manifest",
                }

    ranked = _ranked_rows(csv_rows)
    if ranked:
        row = ranked[0]
        return {
            "metricName": row["metricName"],
            "metricValue": row["metricValue"],
            "lowerIsBetter": row["lowerIsBetter"],
            "source": "lhr_stage_performance",
        }

    if lhr_best is not None:
        return {
            "metricName": lhr_best["metricName"],
            "metricValue": lhr_best["metricValue"],
            "lowerIsBetter": lhr_best["lowerIsBetter"],
            "source": "lhr_state.global_best",
        }

    if registration_metric is not None:
        return {
            "metricName": None,
            "metricValue": registration_metric,
            "lowerIsBetter": None,
            "source": "task_registration",
        }
    return None


def _candidate_artifact(manifest, csv_rows, task_root_real, roots_real, diagnostics, task_root):
    manifest_present = isinstance(manifest, dict)

    if manifest_present and manifest.get("status") == "success":
        candidate, diagnostic = _candidate_from_manifest(
            manifest, roots_real, task_root
        )
        if candidate is not None:
            return candidate
        if diagnostic is not None:
            diagnostics.append(diagnostic)
    elif manifest_present:
        diagnostic = _manifest_status_diagnostic(manifest, task_root)
        if diagnostic is not None:
            diagnostics.append(diagnostic)

    first_diagnostic = None
    for row in _ranked_rows(csv_rows):
        candidate, diagnostic = _candidate_from_row(
            row, task_root_real, roots_real, task_root
        )
        if candidate is not None:
            return candidate
        if first_diagnostic is None:
            first_diagnostic = diagnostic

    if first_diagnostic is not None:
        diagnostics.append(first_diagnostic)
    elif not manifest_present:
        diagnostics.append(
            _diag(
                "no_candidate_binding",
                "No best-stage manifest or stage-performance CSV found.",
                task_root,
            )
        )
    return None


def _candidate_from_manifest(manifest, roots_real, task_root):
    selected = manifest.get("selected_candidate")
    if not isinstance(selected, dict):
        return None, _diag("no_candidate_binding", "Manifest has no selected_candidate.", task_root)

    final_dir = manifest.get("final_dir")
    rel = manifest.get("artifact_path") or selected.get("artifact_path")
    if not final_dir or not rel:
        return None, _diag(
            "no_candidate_binding", "Manifest lacks final_dir/artifact_path.", task_root
        )

    resolved, error = _resolve_artifact(final_dir, rel, roots_real)
    if error is not None or resolved is None:
        return None, _diag(
            error or "candidate_path_out_of_bounds",
            f"Manifest artifact escapes allowed roots: {final_dir}/{rel}",
            task_root,
        )
    if not os.path.isfile(resolved):
        return None, _diag("candidate_file_missing", f"Materialized artifact not found: {resolved}", task_root)

    sha = _sha256_file(resolved)
    recorded = _clean_lower(manifest.get("artifact_sha")) or _clean_lower(selected.get("artifact_sha"))
    if recorded is not None and sha != recorded:
        return None, _diag(
            "candidate_sha_mismatch",
            f"Computed sha256 {sha} != recorded {recorded}.",
            task_root,
        )

    return {
        "path": resolved,
        "sha256": sha,
        "recordedSha256": recorded,
        "digestVerified": True if recorded is not None else None,
        "scoreSource": "best_stage_manifest",
        "metricName": _clean(selected.get("metric_name")),
        "metricValue": _to_float(selected.get("metric_value")),
        "lowerIsBetter": _to_bool(selected.get("lower_is_better")),
        "stageId": _clean(selected.get("stage_id")),
        "candidateId": _clean(selected.get("candidate_id")),
        "validationOk": _to_bool(selected.get("validation_ok")),
    }, None


def _candidate_from_row(row, task_root_real, roots_real, task_root):
    rel = row["artifactPath"]
    if not rel:
        return None, _diag(
            "no_candidate_binding", "Stage-performance row has no artifact_path.", task_root
        )

    snapshot = row["snapshotPath"]
    if snapshot is None:
        base = task_root_real
    elif os.path.isabs(snapshot):
        base = snapshot
    else:
        base = os.path.join(task_root_real, snapshot)

    resolved, error = _resolve_artifact(base, rel, roots_real)
    if error is not None or resolved is None:
        return None, _diag(
            error or "candidate_path_out_of_bounds",
            f"Scored artifact escapes allowed roots: {base}/{rel}",
            task_root,
        )
    if not os.path.isfile(resolved):
        return None, _diag("candidate_file_missing", f"Scored artifact not found: {resolved}", task_root)

    sha = _sha256_file(resolved)
    recorded = row["artifactSha"] or row["submissionSha"]
    if recorded is not None and sha != recorded:
        return None, _diag(
            "candidate_sha_mismatch",
            f"Computed sha256 {sha} != recorded {recorded}.",
            task_root,
        )

    return {
        "path": resolved,
        "sha256": sha,
        "recordedSha256": recorded,
        "digestVerified": True if recorded is not None else None,
        "scoreSource": "lhr_stage_performance",
        "metricName": row["metricName"],
        "metricValue": row["metricValue"],
        "lowerIsBetter": row["lowerIsBetter"],
        "stageId": row["stageId"],
        "candidateId": row["candidateId"],
        "validationOk": row["validationOk"],
    }, None


def _manifest_status_diagnostic(manifest, task_root):
    status = manifest.get("status")
    if status == "no_valid_candidate":
        return _diag("no_valid_candidate", "Best-stage manifest reports no valid candidate.", task_root)
    if status == "missing_artifact":
        return _diag("candidate_file_missing", "Best-stage manifest reports a missing artifact.", task_root)
    if status == "artifact_sha_mismatch":
        return _diag(
            "candidate_sha_mismatch",
            "Best-stage manifest reports an artifact digest mismatch.",
            task_root,
        )
    return _diag(
        "unsupported_schema_version",
        f"Unrecognized best-stage manifest status: {status!r}.",
        task_root,
    )


def _ranked_rows(rows):
    if not rows:
        return []
    lower = bool(rows[0]["lowerIsBetter"])

    def key(row):
        eligible = (
            row["validationOk"] is True
            and row["selectionEligible"] is not False
            and row["candidateReady"] is not False
        )
        rank = 0 if eligible else 1
        metric = row["metricValue"]
        return (rank, metric if lower else -metric)

    return sorted(rows, key=key)


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------


def _normalized_roots(allowed):
    if allowed is None:
        return []
    if isinstance(allowed, (str, os.PathLike)):
        allowed = [allowed]
    roots = []
    for entry in allowed:
        resolved = os.path.realpath(os.path.abspath(os.fspath(entry)))
        if resolved not in roots:
            roots.append(resolved)
    return roots


def _load_json(path, limit):
    """Return ``(data, error)``; ``data`` is ``_MISSING`` on absence or failure."""
    try:
        if not os.path.isfile(path):
            return _MISSING, None
        if os.path.getsize(path) > limit:
            return _MISSING, "metadata_too_large"
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle), None
    except (OSError, ValueError):
        return _MISSING, "metadata_invalid_json"


def _resolve_artifact(base, rel, roots_real):
    rel = os.fspath(rel)
    if os.path.isabs(rel):
        joined = rel
    else:
        joined = os.path.join(os.fspath(base), rel)
    resolved = os.path.realpath(joined)
    if not any(_within(root, resolved) for root in roots_real):
        return None, "candidate_path_out_of_bounds"
    return resolved, None


def _within(root_real, path_real):
    try:
        return os.path.commonpath([root_real, path_real]) == root_real
    except ValueError:
        return False


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _to_float(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _to_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "1", "yes"):
            return True
        if text in ("false", "0", "no"):
            return False
    return None


def _clean(value):
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def _clean_lower(value):
    text = _clean(value)
    return text.lower() if text is not None else None


def _diag(code, message, task_root=None):
    diagnostic = {"code": code, "message": message}
    if task_root is not None:
        diagnostic["taskRoot"] = task_root if isinstance(task_root, str) else str(task_root)
    return diagnostic


if __name__ == "__main__":  # pragma: no cover - convenience only
    import sys

    if len(sys.argv) < 3:
        print(
            "usage: python snapshot.py <run-record-or-dir> <allowed-task-root> [more roots...]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    result = read_run_snapshot(sys.argv[1], sys.argv[2:])
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
