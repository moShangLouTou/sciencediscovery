"""Narrow adapter from ScienceDiscovery task preparation to the ScienceFlow engine.

The deployment profile names this script and the engine checkout. The script is
invoked with the profile's own Python, so importing the engine uses the same
interpreter the run will use. It exposes exactly three read/prepare actions:

``list-tasks``
    Describe the engine's registered task packages with their metric and
    artifact metadata. No task package is modified.

``describe-task``
    Return one registered package's bounded task description.

``probe-evaluator``
    Run a prepared evaluator through the engine's own ``artifact_command``
    backend against caller-supplied sample artifacts, and report the backend's
    own status for each sample. This is the same code path the research worker
    uses, so a probe is not a second evaluator implementation.

The script never launches research, never edits the engine checkout and never
returns a host path from a task package to the caller: it returns metadata and
backend results only. Standard library at import time; the engine is imported
lazily after the checkout is placed on ``sys.path``.

CLI: ``python preparation.py <action> <request-json-path>``. Exactly one JSON
object is written to stdout. Exit code 0 means the action ran; a refused or
failed action is reported in the JSON body.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

__all__ = [
    "ACTIONS",
    "describe_task",
    "list_tasks",
    "missing_evaluator_modules",
    "probe_evaluator",
    "run",
]

ACTIONS = ("list-tasks", "describe-task", "probe-evaluator")

#: One task description is bounded like the pilot's task text.
DESCRIPTION_MAX_BYTES = 64 * 1024
#: An evaluator source is read for its imports only within this bound.
EVALUATOR_IMPORT_MAX_BYTES = 1024 * 1024
#: A probe writes at most this much of each stream tail.
_TAIL_CHARS = 2_000


class AdapterRefusal(Exception):
    """A refusal with a stable code; the message never carries a credential."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _engine(engine_checkout: str):
    root = Path(engine_checkout).expanduser()
    if not root.is_absolute() or not (root / "scienceflow").is_dir():
        raise AdapterRefusal("engine_unavailable", "The engine checkout is not usable.")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from scienceflow.runtime.task_package import (  # noqa: PLC0415 - lazy by design
        iter_task_packages,
    )

    return iter_task_packages()


def list_tasks(request: dict) -> dict:
    specs = _engine(str(request.get("engineCheckout") or ""))
    tasks = []
    for spec in specs:
        description_path = spec.source_dir / spec.description_relpath
        inputs = spec.config.get("inputs")
        inputs_required = None
        if isinstance(inputs, dict) and "required" in inputs:
            inputs_required = bool(inputs.get("required"))
        tasks.append(
            {
                "id": spec.task_id,
                "category": spec.category,
                "profile": spec.profile,
                "provider": spec.provider,
                "artifactPath": spec.artifact_path,
                "artifactKind": spec.artifact_kind,
                "metricName": spec.metric_name,
                "metricType": spec.metric_type,
                "lowerIsBetter": spec.lower_is_better,
                "authoritative": spec.metric_authoritative,
                "evaluatorEntrypoint": spec.evaluator_entrypoint,
                "descriptionAvailable": description_path.is_file(),
                "inputsRequired": inputs_required,
            }
        )
    tasks.sort(key=lambda item: (item["category"], item["id"]))
    return {"status": "ok", "tasks": tasks}


def describe_task(request: dict) -> dict:
    task_id = str(request.get("taskId") or "").strip()
    specs = _engine(str(request.get("engineCheckout") or ""))
    match = next((spec for spec in specs if spec.task_id == task_id), None)
    if match is None:
        raise AdapterRefusal("task_not_found", "No registered task package has that id.")
    path = match.source_dir / match.description_relpath
    if not path.is_file():
        raise AdapterRefusal("description_missing", "The task package has no readable description.")
    if path.stat().st_size > DESCRIPTION_MAX_BYTES:
        raise AdapterRefusal("description_too_large", "The task description exceeds the bound.")
    text = path.read_text(encoding="utf-8").strip()
    if not text or "\u0000" in text:
        raise AdapterRefusal("description_invalid", "The task description is not usable text.")
    entrypoint_path = _entrypoint_path(match.source_dir, match.evaluator_entrypoint)
    return {
        "status": "ok",
        "taskId": match.task_id,
        "artifactPath": match.artifact_path,
        "artifactKind": match.artifact_kind,
        "metricName": match.metric_name,
        "metricType": match.metric_type,
        "lowerIsBetter": match.lower_is_better,
        "authoritative": match.metric_authoritative,
        "evaluatorEntrypoint": match.evaluator_entrypoint,
        "missingModules": missing_evaluator_modules(entrypoint_path, match.source_dir),
        "description": text,
    }


def _entrypoint_path(source_dir: Path, entrypoint: str) -> Path | None:
    """Resolve a package's ``relative.py:function`` entrypoint, refusing escapes."""
    relative = entrypoint.split(":", 1)[0].strip()
    if not relative or relative.startswith("/") or "\u0000" in relative:
        return None
    parts = [part for part in relative.replace("\\", "/").split("/") if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        return None
    return source_dir.joinpath(*parts)


def _imported_roots(source: Path) -> list[str]:
    """Top-level third-party module names an evaluator imports."""
    if not source.is_file() or source.stat().st_size > EVALUATOR_IMPORT_MAX_BYTES:
        return []
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".", 1)[0])
    return sorted(roots)


def missing_evaluator_modules(source: Path | None, task_dir: Path) -> list[str]:
    """Modules the evaluator imports that this interpreter cannot resolve.

    The adapter runs under the same interpreter the evaluator command uses, so a
    missing spec here is the dependency gap a run would hit. Modules importable
    from the task package itself are not gaps.
    """
    if source is None:
        return []
    missing = []
    for name in _imported_roots(source):
        if name in sys.stdlib_module_names:
            continue
        if (task_dir / name).is_dir() or (task_dir / f"{name}.py").is_file():
            continue
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ModuleNotFoundError, ValueError):
            spec = None
        if spec is None:
            missing.append(name)
    return missing


def _sample_workspace(root: Path, label: str) -> Path:
    # The label comes from the caller and names a directory below the request's
    # own workspace root; reject anything that is not one simple segment.
    if not label or "/" in label or "\\" in label or label in {".", ".."}:
        raise AdapterRefusal("invalid_request", "A sample label is not a simple name.")
    workspace = root / label
    if workspace.exists():
        raise AdapterRefusal("invalid_request", "A sample workspace already exists.")
    workspace.mkdir(parents=True)
    return workspace


def _clean_relative(value: str) -> str:
    if not value or value.startswith("/") or "\u0000" in value:
        raise AdapterRefusal("invalid_request", "The candidate artifact path is not relative.")
    parts = [part for part in value.replace("\\", "/").split("/") if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        raise AdapterRefusal("invalid_request", "The candidate artifact path escapes its workspace.")
    return "/".join(parts)


def probe_evaluator(request: dict) -> dict:
    """Evaluate each sample through the engine's artifact_command backend."""

    _engine(str(request.get("engineCheckout") or ""))
    from scienceflow.foundation.contracts import CandidateRef, EvalContext  # noqa: PLC0415
    from scienceflow.research.quality.evaluator.backends.artifact_command import (  # noqa: PLC0415
        ArtifactCommandBackend,
    )

    workspace_root = Path(str(request.get("workspaceRoot") or ""))
    task_root = Path(str(request.get("taskRoot") or ""))
    if not workspace_root.is_absolute() or not task_root.is_absolute():
        raise AdapterRefusal("invalid_request", "The probe roots must be absolute.")
    workspace_root.mkdir(parents=True, exist_ok=True)
    task_root.mkdir(parents=True, exist_ok=True)

    artifact_path = _clean_relative(str(request.get("artifactPath") or ""))
    artifact_kind = str(request.get("artifactKind") or "artifact")
    raw_metric = request.get("metric")
    metric = raw_metric if isinstance(raw_metric, dict) else {}
    metric_name = str(metric.get("name") or "metric")
    lower_is_better = metric.get("lowerIsBetter")
    if not isinstance(lower_is_better, bool):
        raise AdapterRefusal("invalid_request", "The probe metric needs a boolean direction.")
    json_path = str(metric.get("jsonPath") or "metric")
    timeout_sec = float(metric.get("timeoutSec") or 60)

    python_executable = str(request.get("pythonExecutable") or "")
    command = str(request.get("evaluatorCommand") or "")
    if "{artifact_abs_path}" not in command:
        raise AdapterRefusal("invalid_request", "The evaluator command must name {artifact_abs_path}.")
    if not python_executable:
        raise AdapterRefusal("invalid_request", "The probe needs the task interpreter.")

    cfg = {
        "evaluator": {
            "backend": "artifact_command",
            "task_profile": "artifact_command",
            "candidate": {"artifact": artifact_path, "artifact_kind": artifact_kind},
            "metric": {
                "name": metric_name,
                "lower_is_better": lower_is_better,
                "type": "exploratory",
                "json_path": json_path,
            },
            "command": {
                "evaluator_command": command,
                "python_executable": python_executable,
                "timeout_sec": timeout_sec,
                "cwd": "workspace",
            },
        }
    }

    samples = request.get("samples")
    if not isinstance(samples, list) or not samples:
        raise AdapterRefusal("invalid_request", "The probe needs at least one sample.")

    backend = ArtifactCommandBackend()
    results = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise AdapterRefusal("invalid_request", "A probe sample is not an object.")
        label = str(sample.get("label") or f"sample-{index + 1}")
        source = Path(str(sample.get("artifactPath") or ""))
        expect = str(sample.get("expect") or "accepted")
        if expect not in {"accepted", "rejected"}:
            raise AdapterRefusal("invalid_request", "A probe expectation is not accepted/rejected.")
        if not source.is_absolute() or not source.is_file():
            raise AdapterRefusal("invalid_request", "A probe sample artifact is missing.")
        workspace = _sample_workspace(workspace_root, label)
        target = workspace / artifact_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())

        dataset = sample.get("datasetFiles")
        if dataset is not None:
            if not isinstance(dataset, list):
                raise AdapterRefusal("invalid_request", "Probe dataset files must be a list.")
            dataset_dir = workspace / "dataset"
            dataset_dir.mkdir(parents=True, exist_ok=True)
            for entry in dataset:
                if not isinstance(entry, dict):
                    raise AdapterRefusal("invalid_request", "A probe dataset entry is not an object.")
                name = str(entry.get("name") or "")
                if not name or "/" in name or "\\" in name or name in {".", ".."}:
                    raise AdapterRefusal("invalid_request", "A probe dataset name is not a file name.")
                copy_source = Path(str(entry.get("source") or ""))
                if not copy_source.is_absolute() or not copy_source.is_file():
                    raise AdapterRefusal("invalid_request", "A probe dataset file is missing.")
                (dataset_dir / name).write_bytes(copy_source.read_bytes())

        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        context = EvalContext(
            task_profile="artifact_command",
            task_id=str(request.get("taskId") or "prepared-task"),
            task_root=task_root,
            workspace=workspace,
            worker_id="probe",
            cfg=cfg,
        )
        candidate = CandidateRef(
            backend="artifact_command",
            candidate_id=f"probe:{label}",
            workspace=workspace,
            artifact_path=artifact_path,
            artifact_sha=digest,
            artifact_kind=artifact_kind,
        )
        result = backend.evaluate(context, candidate)
        results.append(
            {
                "label": label,
                "expect": expect,
                "status": result.status,
                "ok": bool(result.ok),
                "metricName": result.metric_name,
                "metricValue": result.metric_value,
                "lowerIsBetter": result.lower_is_better,
                "validationOk": bool(result.validation_ok),
                "selectionEligible": bool(result.selection_eligible),
                "metricValidity": result.metric_validity,
                "message": result.message[:_TAIL_CHARS],
                "stdoutTail": (result.stdout_tail or "")[-_TAIL_CHARS:],
                "stderrTail": (result.stderr_tail or "")[-_TAIL_CHARS:],
                "artifactSha256": digest,
            }
        )
    return {"status": "ok", "results": results}


def run(action: str, request: dict) -> dict:
    if action == "list-tasks":
        return list_tasks(request)
    if action == "describe-task":
        return describe_task(request)
    if action == "probe-evaluator":
        return probe_evaluator(request)
    raise AdapterRefusal("invalid_arguments", "Unknown preparation action.")


def _write(payload: dict) -> None:
    # stdout carries exactly one JSON object: no logs, prompts or tracebacks.
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        _write({"status": "invalid_arguments", "message": "usage: preparation.py <action> <request.json>"})
        return 2
    action, request_path = argv
    try:
        request = json.loads(Path(request_path).read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise AdapterRefusal("invalid_arguments", "The request must be a JSON object.")
        payload = run(action, request)
    except AdapterRefusal as exc:
        _write({"status": "refused", "code": exc.code, "message": exc.message})
        return 1
    except Exception as exc:  # noqa: BLE001 - the CLI must never emit a traceback
        _write({"status": "failed", "message": f"{type(exc).__name__}: {exc}"[:_TAIL_CHARS]})
        return 1
    _write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
