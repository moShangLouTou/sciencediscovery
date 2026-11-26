# ScienceFlow task preparation adapter

A narrow, read-only/one-shot adapter between ScienceDiscovery's experimental
local research mode and the instantiated ScienceFlow engine. It is invoked with
the profile's own Python, so the engine imports with the same interpreter the
research worker uses.

```sh
python services/scienceflow-preparation/preparation.py list-tasks request.json
python services/scienceflow-preparation/preparation.py describe-task request.json
python services/scienceflow-preparation/preparation.py probe-evaluator request.json
```

The request is a JSON object written by the SD service; exactly one JSON object
is written to stdout and nothing else. It never launches research, never edits
the engine checkout, and never returns a task package's host path to the caller.

- `list-tasks` — registered package metadata (artifact path/kind, metric
  name/type/direction/authority, evaluator entrypoint, description presence).
- `describe-task` — one package's bounded task description and metadata.
- `probe-evaluator` — runs caller-supplied samples through the engine's real
  `ArtifactCommandBackend` and reports each backend result (status, finite
  metric, stdout/stderr tails). Sample artifact bytes and optional dataset files
  are copied into per-sample workspaces by the adapter; the evaluator command is
  built by SD from trusted values.

The engine checkout is placed on `sys.path` lazily. There is no second evaluator
implementation: the probe is the same `EvalContext`/`CandidateRef` path a worker
takes.

Run the pure-helper tests with:

```sh
python -m unittest discover -s services/scienceflow-preparation/tests -v
```
