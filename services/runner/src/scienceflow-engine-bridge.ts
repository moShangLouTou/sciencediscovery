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
 * The program is deliberately thin. It sets the engine's state root inside a
 * Runner-owned directory, imports the *patched* engine from a read-only mount,
 * derives one launch manifest from the verified input copy, calls the real
 * `prepare_run()` and then the real `supervise()` in its own process, and
 * projects the engine's durable record into the Runner's fixed vocabulary. It
 * replaces no engine code: the supervisor, the registry, the stop
 * short-circuit and every state transition are the engine's.
 *
 * The derivation is a bounded projection of the frozen contract, not a
 * re-invention of the task. Only a single-task, dataset-free contract is
 * accepted, and every key of the frozen manifest and task package is checked
 * against the subset this round carries: a construct whose behavior would be
 * lost (a dataset alias, an include, another worker or draft count, a model
 * gateway, an inline task text) is refused, never reduced. The task package is
 * relocated byte-for-byte into the Runner-owned engine state directory and
 * named explicitly (`package_source`), so the engine reads the frozen
 * task.yaml, description and evaluator rather than any same-named task in its
 * own checkout.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The bridge's own record protocol; independent of the control protocol. */
export const SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION = 1;
/**
 * Version of the fixed mapping from the frozen input contract to a launch
 * manifest. It is recorded with the digest so a reader can tell which mapping
 * produced the derivative; it is not the frozen contract's own version.
 *
 * Version 2: the frozen task package is relocated and named explicitly, the
 * report budget is a top-level manifest key, and the launch task identity is
 * derived so the engine cannot resolve a same-named task of its own.
 *
 * Version 3: the derivation follows the engine's own field sources and refuses
 * every key outside the supported manifest subset instead of reducing it.
 */
export const SCIENCEFLOW_LAUNCH_MAPPING_VERSION = 3;
/** Fixed mount of the revision-pinned engine checkout (read-only). */
export const SCIENCEFLOW_ENGINE_MOUNT = "/scienceflow-engine";
/** Fixed mount of the Runner-owned directory the engine writes its state in. */
export const SCIENCEFLOW_ENGINE_STATE_MOUNT = "/runner-engine";
/** Directory under the Runner data dir that backs that mount. */
export const RESEARCH_ENGINE_STATE_DIRECTORY = "runner-research-engine";
/** Name of the file the bridge writes when it refuses the frozen contract. */
export const ENGINE_CONTRACT_REFUSAL_FILE = "contract.refused";

/** The maximum size of the engine link record the Runner will read. */
export const ENGINE_LINK_MAX_BYTES = 2_048;
/** The maximum size of the bridge's contract-refusal record. */
export const ENGINE_REFUSAL_MAX_BYTES = 4_096;

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
 * Whether the bridge positively refused the frozen contract.
 *
 * The refusal is a fixed, small record the Runner itself reads: an unsupported
 * contract is a deterministic answer about this execution, not a missing
 * result, and it must not be reported as an unexplained failure or an unknown.
 */
export function parseScienceFlowEngineRefusal(
  text: string,
  executionId: string,
): { readonly reason: string } | null {
  if (text.length > ENGINE_REFUSAL_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = ["code", "execution", "reason", "version"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
  if (record.version !== SCIENCEFLOW_BRIDGE_PROTOCOL_VERSION) return null;
  if (record.execution !== executionId) return null;
  if (record.code !== "unsupported") return null;
  if (typeof record.reason !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(record.reason)) return null;
  return { reason: record.reason };
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
 *
 * The trailing `__main__` guard keeps the module importable: the Runner's own
 * tests load it to exercise the derivation and the callbacks against the real
 * engine, and only an executed program starts the lifecycle.
 */
export const SCIENCEFLOW_ENGINE_BRIDGE_SOURCE = `import asyncio, hashlib, json, os, re, shutil, stat, sys
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
REFUSED = ENGINE_STATE / "contract.refused"
# Must match SCIENCEFLOW_LAUNCH_MAPPING_VERSION in the Runner module.
MAPPING_VERSION = 3
POLL_SECONDS = 0.05
PROJECT_SECONDS = 0.05
# The only task.yaml keys this bridge forwards; anything else is a construct
# (a dataset binding, an include, a gate override this round does not model)
# that would otherwise be silently dropped.
SUPPORTED_TASK_KEYS = frozenset({
    "id", "category", "provider", "profile", "description", "artifact",
    "metric", "problem", "evaluator", "validation", "inputs",
})
# The frozen manifest subset, mirroring the API's execution contract. A key
# outside these sets is refused, never dropped: the engine gives the same key
# different meaning at the root, in defaults and in a task, and a value this
# bridge cannot carry would otherwise disappear.
MANIFEST_ROOT_KEYS = frozenset({
    "defaults", "lnr", "max_concurrent", "resume", "resume_budget_policy",
    "tasks", "time_limit",
})
MANIFEST_DEFAULT_KEYS = frozenset({
    "data_dir", "draft_parallel", "evaluator", "input_data_dir", "lnr",
    "num_drafts", "phase", "type", "workspace_base",
})
MANIFEST_TASK_KEYS = frozenset({
    "cpu_list", "data_dir", "draft_parallel", "exp_id", "gpu_list",
    "input_data_dir", "lnr", "num_drafts", "phase", "run_id", "time_limit",
    "type", "workspace", "workspace_base",
})
MANIFEST_LNR_KEYS = frozenset({
    "max_steps", "num_workers", "omp_threads_cap", "resource_control_mode",
    "resource_gpu_pool", "seed", "wall_clock_budget_sec",
})
# The lnr keys this bridge carries. The rest change the engine's resource
# behavior and are refused instead of being replaced by one fixed worker.
UNSUPPORTED_LNR_KEYS = frozenset({
    "max_steps", "omp_threads_cap", "resource_control_mode", "resource_gpu_pool",
    "seed",
})
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


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


def refuse(reason):
    """Refuse the frozen contract positively, then stop before any research.

    The record is terminal so the Runner never has to infer a result from a
    missing one, and the fixed reason is written where the Runner itself reads
    it. Refusal happens before prepare_run(), so no managed run exists.
    """
    target = REFUSED
    temporary = ENGINE_STATE / (".contract.refused." + str(os.getpid()))
    with open(temporary, "w") as handle:
        json.dump({"version": 1, "execution": EXECUTION,
                   "code": "unsupported", "reason": reason}, handle)
        handle.write("\\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    record("finished", "failed", "failed")
    raise SystemExit(2)


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


def index_entry(relative):
    for entry in INDEX.get("files", []):
        if entry.get("path") == relative:
            return entry
    return None


def read_verified(relative):
    """Read exactly the bytes the Runner verified and carried under this role."""
    entry = index_entry(relative)
    if entry is None:
        refuse("input-unknown")
    try:
        data = (INPUTS / relative).read_bytes()
    except OSError:
        refuse("input-missing")
    if len(data) != int(entry["size"]) or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        refuse("input-changed")
    return data


def load_yaml(relative):
    import yaml
    try:
        value = yaml.safe_load(read_verified(relative).decode("utf-8"))
    except SystemExit:
        raise
    except Exception:
        refuse("yaml")
    if not isinstance(value, dict):
        refuse("yaml")
    return value


def text_of(relative):
    try:
        return read_verified(relative).decode("utf-8")
    except SystemExit:
        raise
    except UnicodeDecodeError:
        refuse("encoding")


def merge_defaults(base, override):
    """Mirror the engine's own category/_shared/task_defaults.yaml merge."""
    merged = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = merge_defaults(current, value)
        else:
            merged[key] = value
    return merged


def package_reference(value):
    """One package-relative path, never an absolute path or a parent escape."""
    text = str(value or "").strip()
    if not text or text.startswith("/") or "\\\\" in text:
        refuse("path")
    parts = text.split("/")
    if any(part in ("", ".", "..") for part in parts):
        refuse("path")
    return text


def positive_seconds(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (number > 0) or number == float("inf"):
        return None
    return number


def relocate_package(package_prefix, target_dir, shared_role):
    """Copy the frozen package into Runner-owned state, byte for byte.

    Every file must be an entry of the verified index, so the tree the engine
    reads is exactly the tree the Runner verified: no extra file, no link and
    no re-encoded byte can join it. Shared defaults are placed where the
    engine's own loader looks for them, as the sibling of the task directory.
    """
    package_root = INPUTS / package_prefix
    root_state = ENGINE_STATE.resolve()
    target = target_dir.resolve()
    if not target.is_relative_to(root_state):
        refuse("relocate-root")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    shared_target = target.parent / "_shared"
    for current, directories, files in os.walk(package_root, followlinks=False):
        current_path = Path(current)
        relative_current = current_path.relative_to(package_root)
        if relative_current == Path(".") and "_shared" in directories:
            directories.remove("_shared")
        for name in list(directories) + list(files):
            info = (current_path / name).lstat()
            if stat.S_ISLNK(info.st_mode):
                refuse("relocate-link")
        for name in files:
            source = current_path / name
            relative = (current_path / name).relative_to(INPUTS).as_posix()
            data = read_verified(relative)
            destination = target / relative_current / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with open(destination, "xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(destination, 0o444)
        for name in directories:
            (target / relative_current / name).mkdir(parents=True, exist_ok=True)
    if shared_role is not None:
        relative = str(shared_role)
        if not relative.startswith(package_prefix + "_shared/"):
            refuse("shared-path")
        data = read_verified(relative)
        shared_target.mkdir(parents=True, exist_ok=True)
        destination = shared_target / "task_defaults.yaml"
        if destination.exists():
            refuse("shared-path")
        with open(destination, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(destination, 0o444)
    return target


def check_block(block, allowed):
    for key in block:
        if key not in allowed:
            refuse("manifest-key")


def positive_int(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != int(value) or value < 1:
        return None
    return int(value)


def dataset_bound(block):
    """Any read-only data root, under either the current or the legacy key."""
    for key in ("input_data_dir", "data_dir"):
        value = block.get(key)
        if value is not None and str(value).strip():
            return True
    return False


def merge_lnr(*blocks):
    """The engine's own precedence: manifest root < defaults < task."""
    merged = {}
    for block in blocks:
        value = block.get("lnr")
        if value is None:
            continue
        if not isinstance(value, dict):
            refuse("manifest-lnr")
        for key, item in value.items():
            if key not in MANIFEST_LNR_KEYS:
                refuse("manifest-lnr")
            merged[key] = item
    return merged


def declared_workspace(task, defaults):
    """The engine's workspace precedence, kept as a declaration.

    The Runner owns the sandbox workspace and mounts it at /workspace, so the
    frozen host path itself is never carried. What must not vanish is the fact
    that the contract declares a workspace; the engine refuses a manifest
    without one and so does this bridge.
    """
    values = (
        task.get("workspace"),
        task.get("workspace_base"),
        defaults.get("workspace_base"),
    )
    for value in values:
        if value is not None and not isinstance(value, str):
            refuse("manifest-workspace")
    for value in values:
        if str(value or "").strip():
            return
    refuse("manifest-workspace")


def build_launch_manifest():
    """Derive one launch manifest from the frozen contract, never from a host path.

    The frozen bytes stay as they are. Only a fixed set of references is mapped:
    the description becomes the inline task text, the package is relocated to a
    Runner-owned directory and named explicitly, and the workspace is the mount
    the Runner owns. This is a bounded projection, not a general task system:
    every key of the frozen manifest and of the task package is checked against
    the subset below, and a construct this round cannot carry is refused rather
    than reduced. The engine's own field sources are followed: lnr merges root <
    defaults < task, time_limit is the task's then the root's (defaults never
    supplies it), and the dataset aliases are read with the same precedence.
    """
    roles = role_paths()
    for role in ("manifest", "task_yaml", "description", "evaluator"):
        if role not in roles:
            refuse("role-missing")
    task_yaml_path = roles["task_yaml"]
    package_prefix = task_yaml_path.rsplit("/", 1)[0] + "/"
    # The task package: shared defaults first, the task file on top.
    shared = load_yaml(roles["shared_task_defaults"]) if "shared_task_defaults" in roles else {}
    config = merge_defaults(shared, load_yaml(task_yaml_path))
    if "gate" in config:
        # A gate policy is engine-side evaluation configuration this round does
        # not model; the bridge must not pretend the default policy is the
        # frozen one.
        refuse("task-evaluator")
    if set(config) - SUPPORTED_TASK_KEYS:
        refuse("task-key")
    description_path = package_reference(config.get("description"))
    if roles["description"] != package_prefix + description_path:
        refuse("input-role")
    frozen = load_yaml(roles["manifest"])

    # The frozen manifest, checked key by key before any value is interpreted.
    if "config" in frozen:
        refuse("manifest-include")
    check_block(frozen, MANIFEST_ROOT_KEYS)
    defaults = frozen.get("defaults")
    if defaults is None:
        defaults = {}
    if not isinstance(defaults, dict):
        refuse("manifest-defaults")
    if "config" in defaults:
        refuse("manifest-include")
    if "task" in defaults:
        refuse("manifest-task-text")
    if "gate" in defaults:
        refuse("manifest-evaluator")
    check_block(defaults, MANIFEST_DEFAULT_KEYS)
    tasks = frozen.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1:
        refuse("manifest-task-count")
    task = tasks[0]
    if not isinstance(task, dict):
        refuse("manifest-task")
    if "config" in task:
        refuse("manifest-include")
    if "task" in task:
        # An inline task text would replace the frozen description role; the
        # bridge never accepts two descriptions for one task.
        refuse("manifest-task-text")
    if "gate" in task:
        refuse("manifest-evaluator")
    check_block(task, MANIFEST_TASK_KEYS)

    for block in (defaults, task):
        if str(block.get("type") or "").strip().lower() not in ("", "lnr"):
            refuse("manifest-type")
        if str(block.get("phase") or "").strip().lower() not in ("", "run"):
            refuse("manifest-phase")
    # Values whose form implies behavior this round does not run.
    if "resume" in frozen and frozen.get("resume") is not False:
        refuse("manifest-resume")
    if "resume_budget_policy" in frozen:
        refuse("manifest-resume")
    concurrent = frozen.get("max_concurrent")
    if concurrent is not None and positive_int(concurrent) != 1:
        refuse("manifest-concurrency")
    for block in (frozen, defaults, task):
        if "time_limit" in block and positive_seconds(block.get("time_limit")) is None:
            refuse("manifest-budget")
    # A dataset binding under any alias at either level: the contract would be
    # run without the data it names.
    if dataset_bound(defaults) or dataset_bound(task):
        refuse("manifest-dataset")
    if str(task.get("run_id") or "").strip():
        # The launch run id is derived from the execution so the engine cannot
        # resolve its own task; a frozen run id would be silently replaced.
        refuse("manifest-run-id")
    for key in ("cpu_list", "gpu_list"):
        if str(task.get(key) or "").strip():
            refuse("manifest-devices")
    for block in (defaults, task):
        for key in ("num_drafts", "draft_parallel"):
            if key in block and positive_int(block.get(key)) != 1:
                refuse("manifest-drafts")
    declared_workspace(task, defaults)
    evaluator_defaults = defaults.get("evaluator")
    if evaluator_defaults is not None:
        if not isinstance(evaluator_defaults, dict):
            refuse("manifest-evaluator")
        for key in evaluator_defaults:
            if key not in ("enabled", "backend"):
                refuse("manifest-evaluator")
        if evaluator_defaults.get("enabled") is not None and evaluator_defaults.get("enabled") is not True:
            refuse("manifest-evaluator")
        if str(evaluator_defaults.get("backend") or "task_package") != "task_package":
            refuse("manifest-evaluator")
    lnr = merge_lnr(frozen, defaults, task)
    for key in UNSUPPORTED_LNR_KEYS:
        if key in lnr:
            refuse("manifest-lnr")
    if "num_workers" in lnr and positive_int(lnr.get("num_workers")) != 1:
        refuse("manifest-workers")
    wall_clock = None
    if "wall_clock_budget_sec" in lnr:
        wall_clock = positive_seconds(lnr.get("wall_clock_budget_sec"))
        if wall_clock is None:
            refuse("manifest-budget")

    exp_id = str(task.get("exp_id") or "").strip()
    if not SAFE_NAME.fullmatch(exp_id):
        refuse("manifest-task-id")

    # The task package the engine will load is the frozen one, relocated.
    if str(config.get("id") or "").strip() != exp_id:
        refuse("task-identity")
    inputs_block = config.get("inputs")
    if inputs_block is not None and not isinstance(inputs_block, dict):
        refuse("task-dataset")
    if isinstance(inputs_block, dict):
        if inputs_block.get("required") is not False:
            refuse("task-dataset")
        if str(inputs_block.get("path") or "").strip():
            refuse("task-dataset")
    metric = config.get("metric")
    if not isinstance(metric, dict):
        refuse("task-metric")
    metric_name = str(metric.get("name") or "").strip()
    lower_is_better = metric.get("lower_is_better")
    if not metric_name or not isinstance(lower_is_better, bool):
        refuse("task-metric")
    metric_type = str(metric.get("type") or "benchmark").strip()
    artifact = config.get("artifact")
    artifact_path = package_reference(artifact.get("path")) if isinstance(artifact, dict) else ""
    if not artifact_path:
        refuse("task-artifact")
    artifact_kind = str(artifact.get("kind") or "artifact").strip()
    evaluator = config.get("evaluator")
    if not isinstance(evaluator, dict):
        refuse("task-evaluator")
    if "command" in evaluator:
        # A command evaluator selects another backend; the frozen package's
        # entrypoint would then be ignored.
        refuse("task-evaluator")
    entrypoint = str(evaluator.get("entrypoint") or "").strip()
    separator = entrypoint.rfind(":")
    if separator <= 0 or separator == len(entrypoint) - 1:
        refuse("task-evaluator")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", entrypoint[separator + 1:].strip()):
        refuse("task-evaluator")
    entrypoint_path = package_reference(entrypoint[:separator])
    # The engine will read exactly these two files from the relocated package;
    # they must be the bytes the Runner carried under the matching roles.
    if roles["evaluator"] != package_prefix + entrypoint_path:
        refuse("input-role")
    if roles["description"] != package_prefix + description_path:
        refuse("input-role")
    read_verified(roles["evaluator"])
    description = text_of(roles["description"])

    package_dir = relocate_package(
        package_prefix,
        ENGINE_STATE / "task-package" / exp_id,
        roles.get("shared_task_defaults"),
    )

    # The launch identity is derived, so the engine's own tasks/<id> directory
    # can never be resolved in place of the frozen package. The frozen id stays
    # the package's identity and is carried by the relocated task.yaml.
    digest = hashlib.sha256(("scienceflow-task\\n" + EXECUTION).encode("utf-8")).hexdigest()
    launch_exp_id = "sf-" + digest[:16]
    launch_run_id = "sf-run-" + digest[16:40]
    # The engine reads the task's time_limit first and the manifest root's
    # second; defaults.time_limit is never consulted.
    research_seconds = (
        positive_seconds(task.get("time_limit"))
        or positive_seconds(frozen.get("time_limit"))
        or wall_clock
        or max(1.0, float(BUDGETS.get("researchBudgetMs", 0)) / 1000.0)
    )
    report_seconds = max(0.001, float(BUDGETS.get("reportBudgetMs", 0)) / 1000.0)
    profile = str(
        config.get("profile") or config.get("provider") or config.get("category") or "local"
    ).strip()
    launch_task = {
        "exp_id": launch_exp_id,
        "run_id": launch_run_id,
        "task": description,
        # The Runner owns the execution workspace; the frozen declaration was
        # checked above and its host path cannot exist inside the sandbox.
        "workspace": "/workspace",
        "type": "lnr",
        "time_limit": research_seconds,
        "evaluator": {
            "enabled": True,
            "backend": "task_package",
            "task_profile": profile,
            "package_source": str(package_dir),
            "candidate": {"artifact": artifact_path, "artifact_kind": artifact_kind},
            "metric": {
                "name": metric_name,
                "type": metric_type,
                "lower_is_better": lower_is_better,
            },
        },
        "lnr": {
            "num_workers": 1,
            "wall_clock_budget_sec": wall_clock if wall_clock is not None else research_seconds,
        },
    }
    payload = {
        # The engine's report budget is read from the manifest top level only;
        # a nested value would silently fall back to 300 s.
        "report_budget_sec": report_seconds,
        "max_concurrent": 1,
        "time_limit": research_seconds,
        "resume": False,
        "defaults": {"phase": "run", "type": "lnr"},
        "tasks": [launch_task],
    }
    import yaml

    target = ENGINE_STATE / "launch.yaml"
    temporary = ENGINE_STATE / (".launch." + str(os.getpid()) + ".yaml")
    text = yaml.safe_dump(payload, sort_keys=False)
    with open(temporary, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return target, launch_run_id, digest


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


def ready():
    """Say this supervisor can act on a stop now; called once, synchronously.

    It is a module-level function because the engine's supervisor calls the
    hook directly: handing it a coroutine would never await and would never
    write anything. Readiness is not a completion or a termination proof.
    """
    write("ready", {"version": 1, "execution": EXECUTION})


async def main():
    os.environ["XDG_STATE_HOME"] = str(ENGINE_STATE / "state")
    (ENGINE_STATE / "state").mkdir(parents=True, exist_ok=True)
    state = {"stopId": None}
    stop_event = asyncio.Event()
    watcher = asyncio.create_task(watch_stop(stop_event, state))
    projector = None
    try:
        # The frozen contract is judged before the engine is imported: a
        # contract this round cannot carry is refused without touching the
        # checkout, so the refusal never depends on the engine's dependencies.
        manifest, run_id, manifest_digest = build_launch_manifest()
        # The interpreter runs with -I, so PYTHONPATH and user site are ignored
        # and the engine is reached only through this explicit, Runner-fixed
        # mount.
        sys.path.insert(0, str(ENGINE))
        from scienceflow.runtime.parallel.control import worker
        from scienceflow.runtime.parallel.control.service import prepare_run

        if RESEARCH_MODULE:
            # A Runner-owned test module can replace exactly the research step.
            worker.run_manifest = __import__(RESEARCH_MODULE, fromlist=["run"]).run
        try:
            prepared = await asyncio.to_thread(prepare_run, manifest)
        except SystemExit:
            raise
        except Exception as exc:
            # A manifest the engine itself refused is still a definite answer
            # about this execution: it never ran and it failed. Name it rather
            # than leaving a missing record.
            write("refused", {"version": 1, "execution": EXECUTION,
                              "code": "prepare-failed", "reason": type(exc).__name__})
            record("finished", "failed", "failed")
            return
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


if __name__ == "__main__":
    asyncio.run(main())
`;
