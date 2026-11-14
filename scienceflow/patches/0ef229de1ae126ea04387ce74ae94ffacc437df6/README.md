# ScienceFlow managed-lifecycle patch

This directory pins the engine change the Runner's research workload depends on.
It is a reproducible dependency, not a copy of the engine: the four patches
apply to the base commit and rebuild the exact tree recorded in `manifest.json`.

| item | value |
| --- | --- |
| base commit | `0ef229de1ae126ea04387ce74ae94ffacc437df6` |
| patched commit | `e1347021eaa497d2dc138d9e66ce36e09260568a` |
| patched tree | `f1f1567e17946e7d3d1c5fefe66ef811e24b7078` |
| patches | `0001-…` (`feat(control)`), `0002-…` (`test(control)`), `0003-…` (`fix(control)`), `0004-…` (`feat(execution)`) |

`manifest.json` also pins each patch's SHA-256.

## What the patch changes

- **E1 — `prepare_run()`.** The record-creating half of `start_run()` (manifest
  validation, run id, `attempt + 1`, launch token, stale-fact clearing, the
  per-attempt `manifest-{attempt}.yaml`, the resource reservation) moves into
  `prepare_run()`, which returns a `PreparedRun` and starts nothing. `start_run()`
  is prepare plus the detached spawn, and both halves still run inside the same
  registry lock, so the CLI's start/stop/resume behaviour is unchanged.
- **E2 — supervisor adoption.** `worker.supervise()` claims an unset
  `pid`/`process_created` itself, under the directory lock. An identity that is
  already another process's is never overwritten and the supervisor returns.
- **E3 — stop event, readiness, control task, short-circuit.**
  `supervise(run_id, token, *, stop_event=None, on_ready=None, research=None)`:
  a stop event that is already set writes the positive pre-research record
  `{status="stopped", research_status="not-started", phase="finished"}` and
  returns; otherwise the supervisor reports readiness through `on_ready` and arms
  exactly one control task that cancels the bound supervisor once. The control
  task is cancelled and awaited in `finally` on the natural, cancelled and failed
  paths. With no `stop_event` the function behaves exactly as the detached CLI
  worker did.
- **E4 — report-phase cancellation.** `finalize_reports()` always reaps the
  report process group first. It re-raises a cancellation only when the caller
  asks for it (`raise_on_cancel=True`, which `worker.supervise()` does), so a
  stop consumed while reports are being generated keeps the research outcome and
  writes `report_status="incomplete"`. A direct caller that owns no supervisor
  state keeps the historical result contract (`timed_out=True`). A report that
  spends its own budget is still a timeout (`generation_failed`) and a report
  process that exits non-zero is still its own failure; the three facts are no
  longer collapsed.

- **EC6 — `-P` on the engine's own `-m` children.** The prep worker, the
  research task worker (`child_cli_argv`) and the report child
  (`finalize_reports`) start with `-P` before `-m`, so `cwd` is never prepended
  to `sys.path`. With the engine mounted read-only and named on `PYTHONPATH`, a
  `scienceflow` package left in the attempt's writable workspace cannot become
  the entry of an engine process. Arbitrary research shell subprocesses are not
  changed: they remain untrusted research code and keep their sibling imports.

Three seams exist for hosts and tests only, and none replaces the supervisor, the
registry or a state transition: `research=` (default: the engine's own
`run_manifest`, still reachable as the `worker.run_manifest` module attribute),
the report generator process (`reporting.spawn_report_process`) and the report
content read (`read_report_manifest`, imported lazily from
`scienceflow.research.reporting`).

## Verify and apply

```bash
# Prove the patches rebuild the pinned tree from a clean base commit.
node scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/verify.mjs /path/to/scienceflow

# Apply to a disposable checkout.
git clone --no-hardlinks /path/to/scienceflow /tmp/engine
git -C /tmp/engine checkout 0ef229de1ae126ea04387ce74ae94ffacc437df6
for patch in scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/0*.patch; do
  git -C /tmp/engine apply "$patch"
done
```

`verify.mjs` refuses a checkout that is not the base commit, a dirty checkout, a
patch whose digest differs from the manifest, and any tree other than the pinned
one. It never fetches, installs or writes to the source checkout.

## Engine tests

The patch's own tests live in `tests/test_managed_lifecycle.py` (stdlib plus
`psutil`, the supervisor's identity check) and in
`tests/test_parallel_runner_prep.py` (pytest, for the argv builders). Both need
the engine's own package path:

```bash
PYTHONPATH=/tmp/engine python3 -m unittest tests.test_managed_lifecycle -v
PYTHONPATH=/tmp/engine python3 -m pytest tests/test_parallel_runner_prep.py -q
```

They exercise the real arming half, the real supervisor, the real registry and —
for the reporting-stop cases — the real `finalize_reports` wait, deadline,
cancellation and process-group cleanup, substituting only the report child
process and the report content read. The engine itself declares
`requires-python = ">=3.11,<3.14"`; a 3.10 interpreter is not engine-compatible
evidence.

`prepare_run()` additionally parses a manifest through `ParallelRunner`, whose
import graph needs the engine's full dependency set (for example `omegaconf`).
That half is covered by inspection and by the shared `_prepare_launch()` arming
half, not by a dynamic test on a checkout without those dependencies.
