# ScienceFlow runtime identity check

Status: implemented in round 11. `services/api/src/scienceflow/README.md`
documents the shipped routes, configuration, and failure semantics; this note
keeps the design rationale and the trust boundaries.

This note answers one question and nothing broader:

> For a selected Runner environment, does the administrator's declared
> ScienceFlow revision correspond to the ScienceFlow package source that a
> supported launch would actually resolve?

It answers it with a fixed, read-only probe on the Runner, an explicit API
action bound to one immutable execution plan, and a persisted allow-listed
result. It does not start ScienceFlow, import it, run an evaluator, or authorize
execution. Every plan keeps `canStart: false` and all five existing blockers.

## 1. Where the existing pieces stop

- `services/api/src/scienceflow/engine-revision.ts` checks a Git checkout, but
  only on the machine that runs the API.
- `services/api/src/scienceflow/execution-config.ts` declares a profile
  revision; `execution-contract.ts` freezes it as a declaration.
- `services/runner/src/environment-store.ts` owns `EnvironmentRuntime`
  (`interpreterPath`, `prefixPath`, `revision`) and serializes environment
  changes through `withRuntime()`; `services/runner/src/executor.ts` chooses the
  interpreter and builds the sandbox launch.
- Round 10's `services/runner/src/execution-boundary.ts` can prove a spawned
  sandbox namespace ended, and `execution-manager.ts` owns durable
  executions.

None of them connects "the revision an administrator wrote" to "what the chosen
Runner's interpreter resolves". That connection is this round.

## 2. Who decides what

Two trusted, admin-only files; neither value can come from an HTTP body.

**API side** — new optional `SCIENCE_AGENT_SCIENCEFLOW_RUNTIME_CONFIG_PATH`
(same loader style as `SCIENCE_AGENT_SCIENCEFLOW_EXECUTION_CONFIG_PATH`):

```json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "bindingId": "sf-runner-a",
      "runnerId": "local",
      "runnerBindingId": "sf-source-a",
      "environmentId": "task-...",
      "expectedEnvironmentRevisionId": "rev-...",
      "timeoutMs": 10000
    }
  ]
}
```

Execution profiles gain one optional field, `runtimeBindingId`. A profile
without it keeps working exactly as today: `runtime-check` answers
`unconfigured`. An execution profile whose `runtimeBindingId` names no binding
fails configuration loading as a whole.

`runnerId` resolves through the existing selection used by shell recovery
(`services/api/src/bootstrap/platform.ts`: local `runnerClient`, otherwise
`remoteCompute.runnerClient(runnerId)`). The session-level runner permission
(`assertSessionAllowsRunner`) is checked before the check starts.

**Runner side** — new optional `SCIENCE_AGENT_SCIENCEFLOW_RUNTIME_BINDING_PATH`,
read once at startup. It is the only place a host path exists:

```json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "bindingId": "sf-source-a",
      "sourceRoot": "/srv/checkouts/ScienceFlow",
      "expectedRevision": "<40-hex>"
    }
  ]
}
```

The API never learns `sourceRoot`. The Runner rejects a request whose
`expectedRevision` differs from its own binding with `mismatch` before any
process starts, so a mistaken or compromised API can neither point the probe at
another checkout nor bless a revision the Runner administrator did not declare.
Both files are validated field by field; any bad entry fails startup instead of
being filtered.

## 3. The one supported source mapping

Supported: the environment resolves `scienceflow` from the trusted checkout via
a **plain path line in a `.pth` file** (the legacy editable form), with the
checkout mounted read-only at its own host path.

- The probe launch uses the same sandbox, read-only environment prefix, seccomp
  variant, and workspace rules as `executePython()`, plus exactly one extra
  `--ro-bind <sourceRoot> <sourceRoot>` for the trusted binding. This option is
  internal to the Runner; it is never a request field. Future execution must use
  the same bind set; that execution path is not implemented this round.
- A normal installation into site-packages (wheel/archive, PEP 660 editable
  finder, executable `.pth` import line), a namespace package, duplicate
  distributions, or any `sitecustomize`/`usercustomize` evidence is
  `unsupported`/`ambiguous`, never guessed and never `verified`.
- Package version strings, `direct_url.json`, a hand-written SHA, and a second
  clean checkout on the API host are all non-evidence.

### 3.1 Supported loading subset

"Supported" is a property of the loading mechanism, not of the package
contents. Only this subset may lead to `verified`:

- `sys.path` is built from the interpreter's own defaults plus site directories
  and **plain, absolute, existing path lines** of regular `.pth` files;
- every `sys.path` entry is an existing directory under the environment prefix,
  `/opt/science-env`, or the trusted `sourceRoot`;
- `scienceflow` resolves to exactly one **regular package directory**
  (`scienceflow/__init__.py`) whose parent entry is `sourceRoot`, and that entry
  appears in a `.pth` path line naming `sourceRoot`;
- `-I -S -B` (static phase) and `-I -B` (normal start) behave as declared: no
  site processing, no user site, no bytecode written from startup.

Everything outside the subset is refused, never approximated:

| Observed | Refusal code |
| --- | --- |
| `.pth` import line, `sitecustomize`/`usercustomize` (source, sourceless bytecode, native extension or package), venv `pyvenv.cfg` | `startup_hooks=failed` |
| unreadable, linked, non-regular, non-UTF-8, oversized (> 64 KiB), or line-limited `.pth` | `startup_hooks=failed` |
| relative, missing, non-directory, or out-of-root `sys.path` entry | `startup_hooks=failed` |
| truncation flag raised by any probe bound | `startup_hooks=failed` |
| single-file module (`scienceflow.py`), bytecode-only, extension module, linked package or entry, namespace-only portion | `package_resolution=failed`/`unsupported` |
| a second candidate anywhere on the path (module or package) | `package_resolution=failed` |
| a normal start that disagrees with the static reconstruction | `startup_hooks`/`package_resolution=failed` |

A `.pth` file larger than the read bound is never partially parsed: the probe
reads `limit + 1` bytes, reports `tooLarge`, and the Runner refuses. The 33rd
`.pth`, the 17th line, the 65th path entry, and the 4097th directory name are
reported as truncation rather than silently cut.

## 4. Probe execution and ownership

- Interpreter: the environment revision's own interpreter, obtained under
  `EnvironmentStore.withRuntime(environmentId, ...)`. The lease is held for the
  probe, so an environment update or deletion cannot race it. After acquiring
  the lease the Runner re-reads `runtime.revision.id` and refuses a mismatch.
- Two phases, both through `prepareSandboxLaunch()` and the supervised
  `runSandboxed()` primitive — not a bare `spawn()`:
  1. **Static inventory** (`-I -S -B -`). Site processing is off, so `.pth`
     import lines, `sitecustomize`, and `usercustomize` cannot execute before
     the refusal. The program parses `.pth` files itself (path lines only) and
     reconstructs the `sys.path` a normal start would produce.
  2. **Normal-start confirmation** (`-I -B -`). Runs only when phase 1 is clean
     and proves no unsupported startup configuration exists. Its `sys.path`,
     resolutions, and distributions must equal the reconstruction exactly; any
     difference refuses the check.
  `-S` is never treated as an equivalent launch by itself: the normal start is
  the equivalence proof, and its answer is labeled as such.
- Boundaries are captured from the spawn turn with
  `ExecutionLifecycle.spawned` semantics; on timeout/cancel the Runner calls
  `terminateExecutionBoundary()` and reports `timeout` only after the namespace
  is proven empty.
- **Unverified termination is durable.** If termination cannot be proven, the
  Runner writes a reservation row into the execution ledger
  (`runtime_check_reservations`, same database as `execution_resources`) and
  keeps an in-process fence. The environment mutation gate reads it exactly like
  an execution resource: package install/uninstall, task deletion, and starter
  repair are refused (`ENVIRONMENT_EXECUTION_UNVERIFIED`) before any provisioner
  call. The row is only deleted with the round-10 proof
  (`boundaryTerminationVerified`) under the unknown semantics — a boot change
  never signals; a corrupt row blocks every environment and is never deleted
  blindly. A probe that never started a process leaves no reservation, so a
  launch failure is not a permanent fence. If the durable write fails, the
  in-process fence still holds and a Runner diagnostic
  (`fence-persist-failed`) says the record will not survive a restart.
- No installs, no network, no writes to the environment or checkout:
  environment prefix and source root are read-only binds, bytecode writing is
  disabled, and the only writable path is a private directory under
  `<dataDir>/runtime-checks/<uuid>` removed only after the sandbox is proven
  gone.
- Bounded: fixed probe source (never a request field), 256 KiB output cap,
  discarded stderr, 10 s default / 30 s maximum timeout per phase, one in-flight
  probe per binding and per environment, including the wait for its lease.
  Different bindings cannot create multiple outstanding owners of one
  environment. The reservation is checked again after lease acquisition, before
  either probe phase starts. A malformed, wrong-mode, or wrong-version protocol answer
  is `protocol-error`; a bound hit is refused.

## 5. What the probe reads without importing ScienceFlow

The probe imports only `sys`, `os`, `json`, `site`, `stat`, and
`importlib.machinery`. The static phase reports `sys.version_info`,
`sys.prefix`/`sys.base_prefix`, the base `sys.path`, site directories, every
`.pth` file's path lines (with a missing flag), distributions, a per-entry
resolution scan, and `sitecustomize`/`usercustomize` presence. The runtime phase
reports the actual `sys.path`, the same resolution scan, distributions, and
whether a startup hook was loaded.

Resolution is computed by classification from those observed facts: a directory
entry is inspected for `scienceflow.py`, extension suffixes, bytecode suffixes,
and `scienceflow/__init__.*`, and a package or entry that is itself a link is
refused. Parent-directory links are followed because a normal start follows
them; the package itself is never followed. The probe never calls `find_spec`
on `scienceflow`, never imports it, never runs its console entry point, and
never executes the target module. A hook that executes code is refused rather
than executed to see what it does.

## 6. `verified` versus "metadata readable"

`verified` requires all of:

1. API binding and Runner binding agree on binding identity and expected
   revision; the request names the frozen plan's declared revision.
2. The leased environment revision equals `expectedEnvironmentRevisionId`, and
   the interpreter/sys.prefix belong to that environment (version line matches
   the revision's `languageVersion`).
3. The static phase is complete (no truncation flag) and every supported-subset
   condition in §3.1 holds; the normal start confirms the reconstructed
   `sys.path`, resolutions, and distributions exactly, with no startup hook
   loaded.
4. That origin is `<sourceRoot>/scienceflow`, a regular package
   (`__init__.py` present), and `<sourceRoot>` is the Git top-level.
5. Git on the Runner host: HEAD equals the declared revision, no tracked
   modification, no runnable untracked file — the round-9 rules, moved into
   `packages/scienceflow-reader` and shared rather than duplicated (the API
   module becomes a re-export; `services` does not import backwards).

Anything less is reported as `blocked` with the failing fixed code. A readable
distribution without a matching Git checkout is `unsupported`, never
"installed" or "runtime verified".

## 7. API surface, persistence, and failure semantics

```text
POST /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/runtime-check
GET  /api/projects/:projectId/sessions/:sessionId/scienceflow/plans/:planId/runtime-check
```

- No body, no query, no runner/environment override. Bounded read-only GET.
- Preflight stays static and never starts Python; the plan DTO and its frozen
  contract are unchanged. The check is a separate record.
- Flow mirrors `execution-plan.ts:preflight()`: identity + write gate + current
  profile/binding before the await, repeated after it, before saving. Session or
  project deletion during the await discards the result instead of resurrecting
  a record.
- Storage: additive `science_flow_runtime_checks` and
  `science_flow_runtime_check_generations` tables in `catalog.sqlite`. A check
  **allocates** its generation atomically (`BEGIN IMMEDIATE`, seeded by the last
  allocation and the last stored row) **before** contacting the Runner, then
  saves conditionally on it: the row is replaced only by a strictly newer
  generation. Two overlapping checks therefore get distinct integers, and a
  slower older observation can never replace a newer one. The return contract:
  saved → this request's `ok`; a strictly newer row stored meanwhile → `ok` with
  that newer row (its `generation` shows it is not this request's observation);
  row and allocation gone (Session/Project deleted during the await) →
  `not-found`; newer generation issued but no newer fact yet (that request is
  still in flight or failed) → `unavailable`. A check that fails leaves the last
  valid row as history; an older verified result is never presented as a new
  success. Save failure is a 500, distinct from a check that ran and reported
  `blocked`. `deleteSession`/`deleteProject` remove both rows and the
  allocation. Saving holds one `BEGIN IMMEDIATE` transaction from allocation
  validation through the result snapshot, so a deletion on another SQLite
  connection cannot commit between validation and insertion. Failed saves roll
  back; a late save cannot resurrect a deleted record.
- Unverified probe termination is not only an in-memory state: the reservation
  in the execution ledger (§4) blocks environment mutation across a Runner
  restart until the boundary is proven empty.
- On restart the latest record is readable and explicitly historical: it is
  evidence from `checkedAt`, never a startup authorization. A profile
  withdrawal, binding change, or environment change makes the stored binding
  digest no longer current; the GET reports it as history and a new POST
  rechecks.
- Errors: unauthorized 401, foreign/missing identity a uniform 404, no runtime
  config/profile binding 503 with a fixed code, Runner transport failure 503
  (nothing persisted), and a completed but unsatisfied check 200 with
  `outcome: "blocked"`.

## 8. Public evidence whitelist

Runner business id, environment id/revision id, source kind, actual revision
only when Git check ran, fixed check codes/statuses, checked-at, and binding
digest. Not returned or persisted: host executable, `sourceRoot`, absolute
`sys.path` entries, Git output, raw metadata, stderr, or traceback. The result
states the unverified remainder: dependency closure, dynamic imports, CUDA/ABI,
model gateway, evaluator runnability, and real research start.

## 9. Planned files

- `packages/schema/src/scienceflow.ts` — runtime-check DTOs, fixed check codes,
  runner probe request/result.
- `packages/scienceflow-reader/src/source-revision.ts` — shared Git checkout
  check moved from `services/api/src/scienceflow/engine-revision.ts` (the API
  file becomes a re-export); the Runner gains the workspace dependency.
- `services/runner/src/scienceflow-runtime-*.ts` — trusted binding config, fixed
  probe source, supervised launch, classification, in-flight guard.
- `services/api/src/scienceflow/runtime-check*.ts` — config, service, HTTP,
  repository.
- `packages/executor/src/runner-client.ts` — one signed probe method.
- Wiring: `services/runner/src/server.ts`, `services/api/src/http/index.ts`,
  `services/api/src/bootstrap/{config,platform}.ts`, `services/api/src/store.ts`.

## 10. Verification (targeted only)

New/affected unit tests for config validation, classification, generation and
delete lifecycle, DTO leaks, and the moved revision check. One isolated
`.tmp/r/round11-*` API + Runner with a synthetic package and temporary Git
fixture covers success, source mismatch, binding revocation/change,
unauthorized, timeout, and malformed protocol, including one real bubblewrap
run and an API restart to prove persistence. Fake provisioners and fixture
packages are reported as such; no ScienceFlow is installed or imported.
