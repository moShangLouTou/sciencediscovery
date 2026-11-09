"""Targeted checks for the read-only ScienceFlow run snapshot reader.

Fixtures are trimmed from the real ScienceFlow record shapes (control.json,
lhr_stage_performance.csv, merge/best_stage_manifest.json) but contain only
synthetic values -- no real credentials, user data, or research runtime.
"""

import csv
import hashlib
import json
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from snapshot import SCHEMA_VERSION, read_run_snapshot  # noqa: E402

_CSV_COLUMNS = [
    "metric_value",
    "metric_name",
    "lower_is_better",
    "validation_ok",
    "candidate_id",
    "stage_id",
    "worker_id",
    "snapshot_path",
    "artifact_path",
    "artifact_sha",
    "submission_sha",
    "metric_validity",
    "selection_eligible",
    "candidate_ready",
    "submission_status",
    "evaluator_backend",
    "evaluator_status",
]

_SECRETS = ("SHOULD-NOT-LEAK", "TOKEN-SHOULD-NOT-LEAK", "DRAFT-SHOULD-NOT-LEAK")


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)


def _write_bytes(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(content)
    return hashlib.sha256(content).hexdigest()


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def _write_csv(task_root, rows):
    path = os.path.join(task_root, "task_logs", "lhr_stage_performance.csv")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in _CSV_COLUMNS})
    return path


def _write_control(run_dir, **record):
    base = {
        "run_id": "run-001",
        "status": "running",
        "phase": "research",
        "task_roots": [],
        "manifest_payload": {"model": "SHOULD-NOT-LEAK"},
        "launch_token": "TOKEN-SHOULD-NOT-LEAK",
        "draft": {"secret": "DRAFT-SHOULD-NOT-LEAK"},
        "pid": 4242,
        "log": "/tmp/supervisor.log",
        "resource_claims": {"cpu": [0], "gpu": []},
    }
    base.update(record)
    path = os.path.join(run_dir, "control.json")
    _write_json(path, base)
    return path


def _csv_row(task_root, metric_value, metric_name="radii_sum", lower="false",
             artifact_rel="artifacts/best_solution.json", content=b'{"solution":[1,2,3]}',
             sha_override=None, validation_ok="true", selection_eligible="true",
             candidate_ready="true", metric_validity="high", submission_status="ready",
             evaluator_backend="local", evaluator_status="ok"):
    snapshot = os.path.join(task_root, "workers", "w00", "snapshots", "s1")
    artifact = os.path.join(snapshot, artifact_rel)
    sha = _write_bytes(artifact, content)
    return {
        "metric_value": str(metric_value),
        "metric_name": metric_name,
        "lower_is_better": lower,
        "validation_ok": validation_ok,
        "candidate_id": "c1",
        "stage_id": "s1",
        "worker_id": "w00",
        "snapshot_path": snapshot,
        "artifact_path": artifact_rel,
        "artifact_sha": sha_override if sha_override is not None else sha,
        "metric_validity": metric_validity,
        "selection_eligible": selection_eligible,
        "candidate_ready": candidate_ready,
        "submission_status": submission_status,
        "evaluator_backend": evaluator_backend,
        "evaluator_status": evaluator_status,
    }


def _write_manifest_success(task_root, metric_value=42.0, metric_name="radii_sum",
                            lower=False, sha_override=None, content=b'{"solution":[1,2,3]}'):
    final_dir = os.path.join(task_root, "merge", "finals", "final_00")
    artifact_rel = os.path.join("artifacts", "best_solution.json")
    sha = _write_bytes(os.path.join(final_dir, artifact_rel), content)
    _write_json(
        os.path.join(task_root, "merge", "best_stage_manifest.json"),
        {
            "mode": "best_stage",
            "status": "success",
            "final_count": 1,
            "artifact_path": artifact_rel,
            "artifact_sha": sha_override if sha_override is not None else sha,
            "final_dir": final_dir,
            "selected_candidate": {
                "candidate_id": "c1",
                "stage_id": "s1",
                "worker_id": "w00",
                "snapshot_path": os.path.join(task_root, "workers", "w00", "snapshots", "s1"),
                "artifact_path": artifact_rel,
                "artifact_sha": sha,
                "metric_value": metric_value,
                "metric_name": metric_name,
                "lower_is_better": lower,
                "validation_ok": True,
            },
        },
    )
    return os.path.join(final_dir, artifact_rel), sha


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name
        self.run_dir = os.path.join(self.base, "runs", "run-001")
        self.task_root = os.path.join(self.base, "taskroot")
        os.makedirs(self.run_dir, exist_ok=True)
        os.makedirs(self.task_root, exist_ok=True)

    def tearDown(self):
        self._tmp.cleanup()

    # 1. Running task without a candidate returns a normal status snapshot.
    def test_running_task_without_candidate(self):
        record = _write_control(self.run_dir, task_roots=[self.task_root], task_registration=None)
        snapshot = read_run_snapshot(record, [self.task_root])

        self.assertEqual(snapshot["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(snapshot["runId"], "run-001")
        self.assertEqual(snapshot["rawStatus"], "running")
        self.assertEqual(snapshot["phase"], "research")
        self.assertEqual(len(snapshot["tasks"]), 1)

        task = snapshot["tasks"][0]
        self.assertEqual(task["taskRoot"], self.task_root)
        self.assertIsNone(task["reportedBestMetric"])
        self.assertIsNone(task["candidateArtifact"])
        self.assertEqual(task["evidenceReferences"], [])
        self.assertIn("no_candidate_binding", {d["code"] for d in snapshot["diagnostics"]})
        json.dumps(snapshot)  # must be JSON-serializable

    # 2. Complete candidate evidence yields path, digest, and binding.
    def test_manifest_candidate_confirmed(self):
        expected_path, sha = _write_manifest_success(self.task_root, metric_value=42.0)
        record = _write_control(self.run_dir, task_roots=[self.task_root])
        snapshot = read_run_snapshot(record, [self.task_root])

        task = snapshot["tasks"][0]
        artifact = task["candidateArtifact"]
        self.assertIsNotNone(artifact)
        self.assertEqual(os.path.realpath(artifact["path"]), os.path.realpath(expected_path))
        self.assertEqual(artifact["sha256"], sha)
        self.assertEqual(artifact["recordedSha256"], sha)
        self.assertTrue(artifact["digestVerified"])
        self.assertEqual(artifact["scoreSource"], "best_stage_manifest")
        self.assertEqual(artifact["stageId"], "s1")
        self.assertEqual(artifact["candidateId"], "c1")
        self.assertEqual(artifact["metricValue"], 42.0)
        self.assertFalse(artifact["lowerIsBetter"])

        metric = task["reportedBestMetric"]
        self.assertEqual(metric["metricValue"], 42.0)
        self.assertEqual(metric["source"], "best_stage_manifest")
        self.assertIn("merge/best_stage_manifest.json", task["evidenceReferences"])

    # 3. A registration score or export package alone must not pose as a candidate.
    def test_registration_score_is_not_a_candidate(self):
        record = _write_control(
            self.run_dir,
            task_roots=[self.task_root],
            task_registration={
                "status": "registered",
                "path": os.path.join(self.base, "task_library", "demo-abc123"),
                "task_id": "demo",
                "best_metric": 7.5,
            },
        )
        snapshot = read_run_snapshot(record, [self.task_root])

        task = snapshot["tasks"][0]
        self.assertEqual(task["reportedBestMetric"]["metricValue"], 7.5)
        self.assertEqual(task["reportedBestMetric"]["source"], "task_registration")
        self.assertIsNone(task["candidateArtifact"])
        self.assertIn("no_candidate_binding", {d["code"] for d in snapshot["diagnostics"]})

    # 4a. A scored row whose candidate file is absent yields a clear diagnostic.
    def test_candidate_file_missing(self):
        row = _csv_row(self.task_root, metric_value=10.0)
        os.remove(os.path.join(row["snapshot_path"], row["artifact_path"]))
        _write_csv(self.task_root, [row])
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("candidate_file_missing", {d["code"] for d in snapshot["diagnostics"]})

    # 4d. Rows the upstream validity rule rejects never produce a candidate,
    # even when every referenced file exists.
    def test_only_ineligible_candidates_yield_none(self):
        rows = [
            _csv_row(self.task_root, metric_value=50.0, validation_ok="false",
                     artifact_rel="artifacts/r1.json"),
            _csv_row(self.task_root, metric_value=60.0, selection_eligible="false",
                     artifact_rel="artifacts/r2.json"),
            _csv_row(self.task_root, metric_value=70.0, candidate_ready="false",
                     artifact_rel="artifacts/r3.json"),
            _csv_row(self.task_root, metric_value=80.0, metric_validity="low",
                     artifact_rel="artifacts/r4.json"),
        ]
        for row in rows:
            artifact = os.path.join(row["snapshot_path"], row["artifact_path"])
            self.assertTrue(os.path.isfile(artifact))
        _write_csv(self.task_root, rows)
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("no_eligible_candidate", {d["code"] for d in snapshot["diagnostics"]})

    # 4e. A missing eligible file must not be replaced by an invalid candidate.
    def test_ineligible_file_is_not_a_fallback(self):
        eligible = _csv_row(self.task_root, metric_value=10.0,
                            artifact_rel="artifacts/good.json")
        ineligible = _csv_row(self.task_root, metric_value=999.0,
                              selection_eligible="false",
                              artifact_rel="artifacts/bad.json")
        os.remove(os.path.join(eligible["snapshot_path"], eligible["artifact_path"]))
        self.assertTrue(
            os.path.isfile(os.path.join(ineligible["snapshot_path"], ineligible["artifact_path"]))
        )
        _write_csv(self.task_root, [eligible, ineligible])
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        codes = {d["code"] for d in snapshot["diagnostics"]}
        self.assertIn("candidate_file_missing", codes)
        self.assertNotIn("no_eligible_candidate", codes)

    # 4f. With several eligible rows, direction still picks the right one.
    def test_multiple_eligible_candidates_follow_metric_direction(self):
        root_max = os.path.join(self.base, "task-max")
        root_min = os.path.join(self.base, "task-min")
        for root in (root_max, root_min):
            os.makedirs(root, exist_ok=True)
        _write_csv(root_max, [
            _csv_row(root_max, metric_value=10.0, lower="false",
                     artifact_rel="artifacts/a.json"),
            _csv_row(root_max, metric_value=20.0, lower="false",
                     artifact_rel="artifacts/b.json"),
        ])
        _write_csv(root_min, [
            _csv_row(root_min, metric_value=10.0, lower="true",
                     artifact_rel="artifacts/a.json"),
            _csv_row(root_min, metric_value=20.0, lower="true",
                     artifact_rel="artifacts/b.json"),
        ])
        record = _write_control(self.run_dir, task_roots=[root_max, root_min])

        snapshot = read_run_snapshot(record, [root_max, root_min])
        by_root = {task["taskRoot"]: task for task in snapshot["tasks"]}
        self.assertEqual(by_root[root_max]["candidateArtifact"]["metricValue"], 20.0)
        self.assertEqual(by_root[root_min]["candidateArtifact"]["metricValue"], 10.0)

    # 4g. An explicitly invalid high score cannot outrank an eligible candidate.
    def test_ineligible_high_score_cannot_win(self):
        eligible = _csv_row(self.task_root, metric_value=10.0,
                            artifact_rel="artifacts/good.json")
        ineligible = _csv_row(self.task_root, metric_value=999.0,
                              metric_validity="low",
                              artifact_rel="artifacts/tempting.json")
        _write_csv(self.task_root, [eligible, ineligible])
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        artifact = snapshot["tasks"][0]["candidateArtifact"]
        self.assertIsNotNone(artifact)
        self.assertEqual(artifact["metricValue"], 10.0)
        self.assertEqual(
            os.path.realpath(artifact["path"]),
            os.path.realpath(
                os.path.join(eligible["snapshot_path"], eligible["artifact_path"])
            ),
        )

    # 4b. Broken JSON in the manifest is reported, not treated as success.
    def test_broken_manifest_json(self):
        _write_text(os.path.join(self.task_root, "merge", "best_stage_manifest.json"), "{not json")
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("metadata_invalid_json", {d["code"] for d in snapshot["diagnostics"]})

    # 4c. A digest that no longer matches the record is never treated as success.
    def test_digest_mismatch(self):
        _write_manifest_success(self.task_root, sha_override="0" * 64)
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("candidate_sha_mismatch", {d["code"] for d in snapshot["diagnostics"]})

    # 5a. A task root outside the allowed roots is refused.
    def test_task_root_out_of_bounds(self):
        allowed = os.path.join(self.base, "allowed")
        elsewhere = os.path.join(self.base, "elsewhere")
        record = _write_control(self.run_dir, task_roots=[elsewhere])

        snapshot = read_run_snapshot(record, [allowed])
        task = snapshot["tasks"][0]
        self.assertEqual(task["taskRoot"], elsewhere)
        self.assertIsNone(task["candidateArtifact"])
        self.assertEqual(task["evidenceReferences"], [])
        self.assertIn("task_root_out_of_bounds", {d["code"] for d in snapshot["diagnostics"]})

    # 5b. A traversal in the scored snapshot path is refused.
    def test_snapshot_path_traversal_rejected(self):
        row = _csv_row(self.task_root, metric_value=10.0)
        row["snapshot_path"] = os.path.join(self.task_root, "..", "outside")
        _write_row_with_paths(row)
        _write_csv(self.task_root, [row])
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("candidate_path_out_of_bounds", {d["code"] for d in snapshot["diagnostics"]})

    # 5c. A symlink that escapes the allowed roots is refused.
    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlink_escape_rejected(self):
        secret = os.path.join(self.base, "secret.txt")
        _write_text(secret, "EXTERNAL-SECRET")
        final_dir = os.path.join(self.task_root, "merge", "finals", "final_00")
        artifact_rel = os.path.join("artifacts", "best_solution.json")
        link = os.path.join(final_dir, artifact_rel)
        os.makedirs(os.path.dirname(link), exist_ok=True)
        os.symlink(secret, link)
        _write_json(
            os.path.join(self.task_root, "merge", "best_stage_manifest.json"),
            {
                "mode": "best_stage",
                "status": "success",
                "final_count": 1,
                "artifact_path": artifact_rel,
                "artifact_sha": "0" * 64,
                "final_dir": final_dir,
                "selected_candidate": {
                    "candidate_id": "c1",
                    "stage_id": "s1",
                    "artifact_path": artifact_rel,
                    "metric_value": 1.0,
                    "metric_name": "m",
                    "lower_is_better": False,
                    "validation_ok": True,
                },
            },
        )
        record = _write_control(self.run_dir, task_roots=[self.task_root])

        snapshot = read_run_snapshot(record, [self.task_root])
        self.assertIsNone(snapshot["tasks"][0]["candidateArtifact"])
        self.assertIn("candidate_path_out_of_bounds", {d["code"] for d in snapshot["diagnostics"]})

    # 6a. Multiple task roots stay separate; no cross-task winner is invented.
    def test_multi_task_not_merged(self):
        root_a = os.path.join(self.base, "task-a")
        root_b = os.path.join(self.base, "task-b")
        os.makedirs(root_a, exist_ok=True)
        os.makedirs(root_b, exist_ok=True)

        _write_csv(root_a, [_csv_row(root_a, metric_value=1.0, metric_name="metric_a")])
        _write_csv(root_b, [_csv_row(root_b, metric_value=2.0, metric_name="metric_b")])

        record = _write_control(
            self.run_dir,
            task_roots=[root_a, root_b],
            task_registration={"status": "registered", "best_metric": 999.0},
        )
        snapshot = read_run_snapshot(record, [root_a, root_b])

        self.assertEqual(len(snapshot["tasks"]), 2)
        first, second = snapshot["tasks"]
        self.assertEqual(first["reportedBestMetric"]["metricName"], "metric_a")
        self.assertEqual(first["reportedBestMetric"]["metricValue"], 1.0)
        self.assertEqual(second["reportedBestMetric"]["metricName"], "metric_b")
        self.assertEqual(second["reportedBestMetric"]["metricValue"], 2.0)
        # The run-level registration score is ambiguous for multi-task runs.
        self.assertNotEqual(first["reportedBestMetric"]["metricValue"], 999.0)
        self.assertNotEqual(second["reportedBestMetric"]["metricValue"], 999.0)
        self.assertIsNotNone(first["candidateArtifact"])
        self.assertIsNotNone(second["candidateArtifact"])

    # 6b. Sensitive run-record fields never leak into the snapshot.
    def test_sensitive_fields_not_leaked(self):
        record = _write_control(self.run_dir, task_roots=[self.task_root])
        snapshot = read_run_snapshot(record, [self.task_root])
        rendered = json.dumps(snapshot)

        for secret in _SECRETS:
            self.assertNotIn(secret, rendered)
        for key in ("manifest_payload", "launch_token", "resource_claims", "draft", "pid", "log"):
            self.assertNotIn(f'"{key}"', rendered)

    # Extra: a missing or malformed run record still yields a well-formed snapshot.
    def test_missing_and_invalid_run_record(self):
        missing = read_run_snapshot(os.path.join(self.base, "nope", "control.json"), [self.task_root])
        self.assertIsNone(missing["runId"])
        self.assertEqual(missing["tasks"], [])
        self.assertIn("run_record_missing", {d["code"] for d in missing["diagnostics"]})

        bad = os.path.join(self.run_dir, "control.json")
        _write_text(bad, "{not json")
        invalid = read_run_snapshot(bad, [self.task_root])
        self.assertEqual(invalid["tasks"], [])
        self.assertIn("run_record_invalid_json", {d["code"] for d in invalid["diagnostics"]})


def _write_row_with_paths(row):
    """Materialize the artifact for a row whose snapshot path is true-but-unsafe."""
    snapshot = row["snapshot_path"]
    artifact = os.path.join(snapshot, row["artifact_path"])
    os.makedirs(os.path.dirname(artifact), exist_ok=True)
    with open(artifact, "wb") as handle:
        handle.write(b'{"solution":[1,2,3]}')


if __name__ == "__main__":
    unittest.main()
