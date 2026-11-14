// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The Runner's fixed bridge to the real ScienceFlow managed lifecycle.
 *
 * This module owns two things and nothing else:
 *
 * - the exact program text the sandbox runs. It is Runner code, like the
 *   fixture workloads before it: no request, route, configuration file or
 *   input bundle can supply or replace it;
 * - the fixed mount names and the one record the bridge reports about the
 *   engine run it created, parsed here with a whitelist so the ledger can bind
 *   one engine run to one execution.
 *
 * The program itself is deliberately thin. It sets the engine's state root
 * inside a Runner-owned directory, imports the *patched* engine from a
 * read-only mount, derives one launch manifest from the verified input copy,
 * calls the real `prepare_run()` and then the real `supervise()` in its own
 * process, and projects the engine's durable record into the Runner's fixed
 * vocabulary. It replaces no engine code: the supervisor, the registry, the
 * stop short-circuit and every state transition are the engine's.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The bridge's own record protocol; independent of the control protocol. */
export const SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION = 1;
/**
 * Version of the fixed mapping from the frozen input contract to a launch
 * manifest. It is recorded with the digest so a reader can tell which mapping
 * produced the derivative; it is not the frozen contract's own version.
 */
export const SCIENCEFLOW_LAUNCH_MAPPING_VERSION = 1;
/** Fixed mount of the revision-pinned engine checkout (read-only). */
export const SCIENCEFLOW_ENGINE_MOUNT = "/scienceflow-engine";
/** Fixed mount of the Runner-owned directory the engine writes its state in. */
export const SCIENCEFLOW_ENGINE_STATE_MOUNT = "/runner-engine";
/** Directory under the Runner data dir that backs that mount. */
export const RESEARCH_ENGINE_STATE_DIRECTORY = "runner-research-engine";

/** The maximum size of the engine link record the Runner will read. */
export const ENGINE_LINK_MAX_BYTES = 2_048;

/**
 * The engine run this execution created, as the bridge reports it.
 *
 * `engineRunId` and `attempt` are the engine's own identity; they are recorded
 * next to the execution id and never replace it. The token the engine uses to
 * claim that run is deliberately absent: it is an ownership secret, not
 * evidence, and nothing in the ledger needs it.
 */
export interface ScienceFlowEngineLink {
  readonly engineRunId: string;
  readonly attempt: number;
  readonly revision: string;
  readonly version: string;
  readonly derivedManifestDigest: string;
  readonly mappingVersion: number;
}

/**
 * Parse the bridge's engine link. A link is evidence only when it names this
 * execution, the declared revision and version, and a run id the engine could
 * have chosen; anything else is not evidence about this run.
 */
export function parseScienceFlowEngineLink(
  text: string,
  executionId: string,
  expected: { readonly revision: string; readonly version: string },
): ScienceFlowEngineLink | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = [
    "attempt", "derivedManifestDigest", "engineRevision", "engineRunId", "engineVersion",
    "execution", "mappingVersion", "version",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
  if (record.version !== SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION) return null;
  if (record.execution !== executionId) return null;
  if (typeof record.engineRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(record.engineRunId)) {
    return null;
  }
  if (!Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1) return null;
  if (record.engineRevision !== expected.revision) return null;
  if (record.engineVersion !== expected.version) return null;
  if (typeof record.derivedManifestDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(record.derivedManifestDigest)) {
    return null;
  }
  if (record.mappingVersion !== SCIENCEFLOW_LAUNCH_MAPPING_VERSION) return null;
  return {
    attempt: record.attempt as number,
    derivedManifestDigest: record.derivedManifestDigest,
    engineRunId: record.engineRunId,
    mappingVersion: record.mappingVersion,
    revision: expected.revision,
    version: expected.version,
  };
}

/**
 * Where this execution's engine state lives. Like every other research path it
 * is derived from the execution id by digest, so no id text becomes a path
 * component and two executions can never share a state root.
 */
export function researchEngineStateRoot(dataDir: string, executionId: string): string {
  const digest = createHash("sha256").update(`research-engine\n${executionId}`, "utf8").digest("hex");
  return resolve(dataDir, RESEARCH_ENGINE_STATE_DIRECTORY, digest.slice(0, 32));
}

/**
 * The fixed program. It receives, in order: the control mount, the execution
 * id, the verified input mount, the input index, the engine mount, the engine
 * state mount, the declared revision, the declared version, the phase budgets
 * and an optional research-step module (a Runner-owned test seam).
 */
export const SCIENCEFLOW_ENGINE_BRIDGE_SOURCE = `import asyncio, hashlib, json, os, sys, time
from contextlib import suppress
from pathlib import Path

CONTROL = Path(sys.argv[1])
EXECUTION = sys.argv[2]
INPUTS = Path(sys.argv[3])
INDEX = json.loads(sys.argv[4])
ENGINE = Path(sys.argv[5])
ENGINE_STATE = Path(sys.argv[6])
REVISION = sys.argv[7]
VERSION = sys.argv[8]
BUDGETS = json.loads(sys.argv[9])
RESEARCH_MODULE = sys.argv[10] if len(sys.argv) > 10 else ""

STOP = CONTROL / "stop"
CONSUMED = CONTROL / "stop.consumed"
# Must match SCIENCEFLOW_LAUNCH_MAPPING_VERSION in the Runner module.
MAPPING_VERSION = 1
POLL_SECONDS = 0.05
PROJECT_SECONDS = 0.05


def write(name, payload):
    target = CONTROL / name
    temporary = CONTROL / ("." + name + "." + str(os.getpid()))
    with open(temporary, "w") as handle:
        json.dump(payload, handle)
        handle.write("\\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def record(phase, outcome=None, report=None, stop_id=None):
    payload = {"version": 1, "execution": EXECUTION, "phase": phase}
    if outcome is not None:
        payload["outcome"] = outcome
    if report is not None:
        payload["report"] = report
    if stop_id is not None:
        payload["stopId"] = stop_id
    write("status", payload)


async def watch_stop(event, state):
    while True:
        request = read_json(STOP)
        if isinstance(request, dict) and isinstance(request.get("stopId"), str):
            stop_id = request["stopId"]
            # The rename is the acknowledgement: after it there is no stop file
            # left for a second read to find, and the watcher returns, so one
            # intent can never cancel twice.
            with suppress(OSError):
                os.replace(STOP, CONSUMED)
            write("stop.consumed", {"version": 1, "stopId": stop_id})
            state["stopId"] = stop_id
            event.set()
            return
        await asyncio.sleep(POLL_SECONDS)


def role_paths():
    mapping = {}
    for entry in INDEX.get("files", []):
        for role in entry.get("roles", []):
            mapping[str(role)] = str(entry["path"])
    return mapping


def build_launch_manifest():
    """Derive one launch manifest from the frozen inputs, never from a host path.

    The frozen bytes stay as they are. Only a fixed set of references is mapped:
    the description becomes the inline task text, the task package supplies the
    experiment id, and the workspace is the mount the Runner owns. No string
    template, shell text or free-form path is accepted.
    """
    mapping = role_paths()
    for role in ("manifest", "task_yaml", "description"):
        if role not in mapping:
            raise RuntimeError("input bundle is missing a required role")
    import yaml

    task_yaml = yaml.safe_load((INPUTS / mapping["task_yaml"]).read_text(encoding="utf-8"))
    description = (INPUTS / mapping["description"]).read_text(encoding="utf-8")
    exp_id = str(task_yaml.get("id") or "scienceflow-task")
    research_seconds = max(1, int(BUDGETS.get("researchBudgetMs", 0) // 1000))
    report_seconds = max(1.0, BUDGETS.get("reportBudgetMs", 0) / 1000.0)
    payload = {
        "defaults": {"report_budget_sec": report_seconds},
        "tasks": [
            {
                "exp_id": exp_id,
                "run_id": "sf-" + hashlib.sha256(
                    ("scienceflow-run\\n" + EXECUTION).encode("utf-8")
                ).hexdigest()[:24],
                "task": description,
                "workspace": "/workspace",
                "type": "lnr",
                "time_limit": research_seconds,
                "lnr": {"num_workers": 1},
            }
        ],
    }
    target = ENGINE_STATE / "launch.yaml"
    temporary = ENGINE_STATE / (".launch." + str(os.getpid()) + ".yaml")
    text = yaml.safe_dump(payload, sort_keys=False)
    with open(temporary, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return target, payload["tasks"][0]["run_id"], digest


def engine_version():
    import tomllib

    project = tomllib.loads((ENGINE / "pyproject.toml").read_text(encoding="utf-8"))
    return str(project.get("project", {}).get("version", ""))


def mapped_report(report_status, outcome, stop_id):
    if outcome == "not-started":
        return "none"
    if report_status == "ready":
        return "ready"
    if report_status == "incomplete":
        return "incomplete"
    if stop_id is not None:
        # The report never ran because this run was stopped; saying it failed
        # would blame the report for the stop.
        return "incomplete"
    return "failed"


def project(engine_record, state):
    """Project one engine record into the Runner's fixed vocabulary."""
    if not isinstance(engine_record, dict):
        return False
    phase = engine_record.get("phase")
    outcome = engine_record.get("research_status")
    stop_id = state.get("stopId")
    if phase == "finished":
        if outcome not in ("completed", "stopped", "failed", "not-started"):
            return False
        record("finished", outcome, mapped_report(engine_record.get("report_status"), outcome, stop_id), stop_id)
        return True
    if phase == "reporting":
        if outcome not in ("completed", "stopped", "failed"):
            return False
        record("reporting", outcome, "generating", stop_id)
        return True
    if phase == "research" and engine_record.get("status") == "running":
        # The engine's "starting" status is the arming half: the record exists
        # but research has not begun, and the Runner keeps its own phase at
        # unknown until it has.
        record("research", stop_id=stop_id)
        return True
    return False


async def project_run(directory, state):
    while True:
        project(read_json(directory / "control.json"), state)
        await asyncio.sleep(PROJECT_SECONDS)


async def main():
    os.environ["XDG_STATE_HOME"] = str(ENGINE_STATE / "state")
    (ENGINE_STATE / "state").mkdir(parents=True, exist_ok=True)
    # The interpreter runs with -I, so PYTHONPATH and user site are ignored and
    # the engine is reached only through this explicit, Runner-fixed mount.
    sys.path.insert(0, str(ENGINE))
    from scienceflow.runtime.parallel.control import worker
    from scienceflow.runtime.parallel.control.service import prepare_run

    if RESEARCH_MODULE:
        # A Runner-owned test module can replace exactly the research step.
        worker.run_manifest = __import__(RESEARCH_MODULE, fromlist=["run"]).run
    state = {"stopId": None}
    stop_event = asyncio.Event()
    watcher = asyncio.create_task(watch_stop(stop_event, state))
    projector = None
    try:
        manifest, run_id, manifest_digest = build_launch_manifest()
        prepared = await asyncio.to_thread(prepare_run, manifest)
        write(
            "engine",
            {
                "version": 1,
                "execution": EXECUTION,
                "engineRunId": prepared.run_id,
                "attempt": prepared.attempt,
                "engineRevision": REVISION,
                "engineVersion": engine_version() or VERSION,
                "derivedManifestDigest": manifest_digest,
                "mappingVersion": MAPPING_VERSION,
            },
        )
        directory = prepared.directory

        async def ready():
            write("ready", {"version": 1, "execution": EXECUTION})

        projector = asyncio.create_task(project_run(directory, state))
        try:
            await worker.supervise(
                prepared.run_id,
                prepared.launch_token,
                stop_event=stop_event,
                on_ready=ready,
            )
        finally:
            # One last projection of the durable record: the terminal record
            # the Runner reads after this process exits is written here, after
            # the engine's own storage and export steps finished.
            project(read_json(directory / "control.json"), state)
            projector.cancel()
            with suppress(asyncio.CancelledError):
                await projector
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher


asyncio.run(main())
`;
