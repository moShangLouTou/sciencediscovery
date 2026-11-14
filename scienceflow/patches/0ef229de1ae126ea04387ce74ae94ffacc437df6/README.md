# ScienceFlow managed-lifecycle patch

This directory pins the engine change the Runner's research workload depends on.
It is a reproducible dependency, not a copy of the engine: the two patches apply
to the base commit and rebuild the exact tree recorded in `manifest.json`.

| item | value |
| --- | --- |
| base commit | `0ef229de1ae126ea04387ce74ae94ffacc437df6` |
| patched commit | `cda7d275f3ccaf3272096d78fe4ad9ec5e565732` |
| patched tree | `e8dff1ec922b5496606d21841f5295150f539361` |
| patches | `0001-…` (`feat(control)`), `0002-…` (`test(control)`) |

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
- **E4 — report-phase cancellation.** A stop consumed while reports are being
  generated keeps the research outcome and writes `report_status="incomplete"`
  instead of letting `CancelledError` escape unrecorded.

Two seams exist for hosts and tests only, and neither replaces the supervisor,
the registry or a state transition: `research=` (default: the engine's own
`run_manifest`, still reachable as the `worker.run_manifest` module attribute)
and the report generator, which is imported from
`scienceflow.runtime.parallel.control.reporting`.

## Verify and apply

```bash
# Prove the patches rebuild the pinned tree from a clean base commit.
node scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/verify.mjs /path/to/scienceflow

# Apply to a disposable checkout.
git clone --no-hardlinks /path/to/scienceflow /tmp/engine
git -C /tmp/engine checkout 0ef229de1ae126ea04387ce74ae94ffacc437df6
git -C /tmp/engine apply scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/0001-*.patch
git -C /tmp/engine apply scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/0002-*.patch
```

`verify.mjs` refuses a checkout that is not the base commit, a dirty checkout, a
patch whose digest differs from the manifest, and any tree other than the pinned
one. It never fetches, installs or writes to the source checkout.

## Engine tests

The patch's own tests live in `tests/test_managed_lifecycle.py` and need only the
standard library plus `psutil` (the supervisor's identity check) and the engine's
own package path:

```bash
PYTHONPATH=/tmp/engine python3 -m unittest tests.test_managed_lifecycle -v
```

They exercise the real arming half, the real supervisor and the real registry,
substituting only the expensive research step and the report generator. The
engine itself declares `requires-python = ">=3.11,<3.14"`; a 3.10 interpreter is
not engine-compatible evidence.

`prepare_run()` additionally parses a manifest through `ParallelRunner`, whose
import graph needs the engine's full dependency set (for example `omegaconf`).
That half is covered by inspection and by the shared `_prepare_launch()` arming
half, not by a dynamic test on a checkout without those dependencies.
