#!/usr/bin/env bash
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Prepare one isolated, repository-owned local ScienceFlow pilot.
#
# The script owns a single root directory and everything below it: the pinned
# engine checkout, the private research configuration, run state, an isolated
# JiuwenSwarm installation and the initial Session. Re-running it validates and
# reuses what is already there; it never resets a checkout, overwrites a
# user-edited config or template, or bootstraps over a non-empty data directory.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
default_pilot_root="$repository_root/.tmp/scienceflow-pilot"

# The engine and its patches are a reproducible dependency of this repository.
# The manifest, not this script, carries the exact revisions and patch digests.
scienceflow_git_url="https://github.com/science-learner/ScienceFlow.git"
scienceflow_patch_base="0ef229de1ae126ea04387ce74ae94ffacc437df6"
pilot_instance="scienceflow-pilot"
pilot_project_name="ScienceFlow pilot"
pilot_session_title="ScienceFlow research pilot"

usage() {
  cat <<'EOF'
Usage: scripts/setup-scienceflow-pilot.sh [--with-initial-candidate] [PILOT_ROOT]

Prepare an isolated local ScienceFlow pilot. PILOT_ROOT defaults to
.tmp/scienceflow-pilot under this repository. A relative path is resolved from
the current directory; spaces are allowed. The same path must be passed to
scripts/start-scienceflow-pilot.sh.

The first run clones and verifies the pinned ScienceFlow checkout, applies the
bundled patches, installs Python and Node dependencies, prepares an isolated
JiuwenSwarm installation under PILOT_ROOT, and creates the initial Session.
Re-running validates and reuses the prepared root.

  --with-initial-candidate  also import the circle-packing validation fixture as a
                            Session candidate (default: no candidate; default root
                            gains -seeded)
  -h, --help                show this help and exit
EOF
}

with_initial_candidate=0
if [[ "${1:-}" == "--with-initial-candidate" ]]; then
  with_initial_candidate=1
  default_pilot_root="${default_pilot_root}-seeded"
  shift
fi
pilot_root_arg=""
case "${1:-}" in
  -h|--help)
    [[ "$#" -eq 1 ]] || { echo "--help does not take other arguments." >&2; exit 2; }
    usage
    exit 0
    ;;
  -*)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac
if [[ "$#" -gt 1 ]]; then
  echo "Only one pilot root may be given." >&2
  usage >&2
  exit 2
fi
if [[ "$#" -eq 1 && -z "$1" ]]; then
  echo "PILOT_ROOT must not be empty." >&2
  usage >&2
  exit 2
fi
pilot_root_arg="${1:-$default_pilot_root}"
if [[ "$pilot_root_arg" != /* ]]; then
  pilot_root_arg="$PWD/$pilot_root_arg"
fi
while [[ "$pilot_root_arg" == */ && "$pilot_root_arg" != "/" ]]; do
  pilot_root_arg="${pilot_root_arg%/}"
done
pilot_root="$pilot_root_arg"

fail() {
  echo "setup-scienceflow-pilot: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}
require_command git "git is required to clone the pinned ScienceFlow checkout."
require_command node "Node.js 22.19+ is required for setup and the local stack."
require_command pnpm "pnpm 11.1.2 is required for the local stack build."
require_command uv "uv 0.9+ is required for the Python environments."
require_command python3 "Python 3 is required by the bundled JiuwenSwarm patch step."
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  fail "Node.js 22.19+ is required; found $(node --version)."
fi

[[ -L "$pilot_root" ]] && fail "the pilot root must not be a symlink: $pilot_root"
# Resolve dot segments and existing parent symlinks before any filesystem writes.
pilot_root="$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let existing = path.resolve(process.argv[1]);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  process.stdout.write(path.join(fs.realpathSync(existing), ...suffix));
' "$pilot_root")"
if [[ "$pilot_root" == "/" ]]; then
  fail "refusing to use / as the pilot root"
fi
if [[ "$pilot_root" == "$repository_root" ]]; then
  fail "the pilot root must not be the repository root; choose a dedicated directory"
fi

patch_dir="$repository_root/scienceflow/patches/$scienceflow_patch_base"
manifest_path="$patch_dir/manifest.json"
[[ -d "$patch_dir" ]] || fail "the pinned ScienceFlow patch directory is missing: $patch_dir"
[[ -f "$manifest_path" ]] || fail "the ScienceFlow patch manifest is missing: $manifest_path"

# Read and validate the manifest before creating anything, so a broken pin
# fails before a clone or install.
manifest_value() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.engine !== "scienceflow") process.exit(1);
    const value = manifest[process.argv[2]];
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) process.exit(1);
    process.stdout.write(value);
  ' "$manifest_path" "$1"
}
if ! scienceflow_base="$(manifest_value baseRevision)"; then
  fail "the ScienceFlow manifest is invalid."
fi
if ! scienceflow_tree="$(manifest_value patchedTree)"; then
  fail "the ScienceFlow manifest is invalid."
fi
if [[ "$scienceflow_base" != "$scienceflow_patch_base" ]]; then
  fail "the manifest base revision $scienceflow_base does not match the pinned patch directory."
fi
if ! node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const path = require("node:path");
  const dir = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest.patches) || manifest.patches.length === 0) process.exit(1);
  for (const patch of manifest.patches) {
    if (typeof patch.path !== "string" || typeof patch.sha256 !== "string") process.exit(1);
    const digest = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(dir, patch.path)))
      .digest("hex");
    if (digest !== patch.sha256) process.exit(1);
  }
' "$patch_dir"; then
  fail "one or more bundled ScienceFlow patches do not match the manifest digest."
fi
mapfile -t patch_names < <(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const patch of manifest.patches) process.stdout.write(patch.path + "\n");
' "$manifest_path")
[[ "${#patch_names[@]}" -gt 0 ]] || fail "the ScienceFlow manifest lists no patches."

if [[ -L "$pilot_root" ]]; then
  fail "the pilot root must not be a symlink: $pilot_root"
fi
if [[ -e "$pilot_root" && ! -d "$pilot_root" ]]; then
  fail "the pilot root exists but is not a directory: $pilot_root"
fi
mkdir -p "$pilot_root" 2>/dev/null || fail "cannot create the pilot root: $pilot_root"

# Refuse an unrelated directory instead of mixing pilot state into it. The
# allowed names are exactly the paths this script and the stack own. The
# permission change waits until this check passes, so a mistaken path is not
# modified.
shopt -s nullglob dotglob
for entry in "$pilot_root"/*; do
  case "$(basename -- "$entry")" in
    engine|data|assets|runs|private|jiuwenswarm|jiuwenswarm-home|\
research.json|task-template.md|session-bootstrap.json|bootstrap.mts) ;;
    session-bootstrap.json.tmp-*)
      fail "the pilot root contains an incomplete bootstrap receipt; setup was interrupted. Move $pilot_root aside or choose a fresh root." ;;
    *) fail "the pilot root contains an unexpected entry: $(basename -- "$entry")" ;;
  esac
done
shopt -u nullglob dotglob
chmod 700 "$pilot_root" 2>/dev/null || fail "cannot restrict the pilot root: $pilot_root"

engine_dir="$pilot_root/engine"
data_dir="$pilot_root/data"
assets_dir="$pilot_root/assets"
runs_dir="$pilot_root/runs"
private_dir="$pilot_root/private"
config_path="$pilot_root/research.json"
receipt_path="$pilot_root/session-bootstrap.json"
bootstrap_helper="$pilot_root/bootstrap.mts"
jiuwen_root="$pilot_root/jiuwenswarm"
jiuwen_src="$jiuwen_root/src"
jiuwen_home="$pilot_root/jiuwenswarm-home"

if [[ -e "$config_path" ]]; then
  [[ -f "$config_path" ]] || fail "existing $config_path is not a regular file"
  if ! EXPECTED_ENGINE="$engine_dir" OPTIONAL_INCUMBENT="$((1 - with_initial_candidate))" node -e '
    const fs = require("node:fs");
    let config;
    try { config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (config.schemaVersion !== 1 || config.enabled !== true || !config.research
        || config.research.engineCheckout !== process.env.EXPECTED_ENGINE
        || config.research.taskMode !== "task-dynamic"
        || config.research.task !== undefined
        || config.research.taskDescriptionPath !== undefined
        || (config.research.dynamicInputs?.incumbentOptional === true) !== (process.env.OPTIONAL_INCUMBENT === "1")) process.exit(1);
  ' "$config_path"; then
    fail "existing $config_path does not match the generic task-intake pilot mode; use the original --with-initial-candidate option or choose a fresh root"
  fi
  echo "Keeping the existing research configuration: $config_path" >&2
fi

for path in "$engine_dir" "$data_dir" "$assets_dir" "$runs_dir" "$private_dir" \
            "$jiuwen_root" "$jiuwen_home"; do
  [[ -L "$path" ]] && fail "pilot state must not be a symlink: $path"
done
mkdir -p "$assets_dir" "$runs_dir" "$private_dir"
chmod 700 "$private_dir" 2>/dev/null || fail "cannot restrict the private root: $private_dir"

engine_error() {
  fail "ScienceFlow engine checkout $engine_dir $*; it was not modified."
}

# The checkout is adopted only when it is exactly the pinned base plus the
# manifest's patches. Anything else is left in place for inspection.
check_engine() {
  local real_engine toplevel head index_tree base_tree untracked path
  [[ -L "$engine_dir/.venv" ]] && engine_error "has a symlinked .venv"
  real_engine="$(cd -- "$engine_dir" && pwd -P)" || engine_error "is unreadable"
  if ! toplevel="$(git -C "$engine_dir" rev-parse --show-toplevel 2>/dev/null)"; then
    engine_error "is not a git checkout"
  fi
  [[ "$(cd -- "$toplevel" && pwd -P)" == "$real_engine" ]] || engine_error "is not the root of its git checkout"
  if ! head="$(git -C "$engine_dir" rev-parse HEAD 2>/dev/null)"; then
    engine_error "has no readable HEAD"
  fi
  [[ "$head" == "$scienceflow_base" ]] || engine_error "is at $head, expected $scienceflow_base"
  if ! base_tree="$(git -C "$engine_dir" rev-parse "$scienceflow_base^{tree}" 2>/dev/null)"; then
    engine_error "cannot read the pinned base tree"
  fi
  if ! index_tree="$(git -C "$engine_dir" write-tree 2>/dev/null)"; then
    engine_error "has no readable index"
  fi
  git -C "$engine_dir" diff --quiet --ignore-submodules -- \
    || engine_error "has unstaged working-tree changes"
  untracked="$(git -C "$engine_dir" ls-files --others --exclude-standard)"
  if [[ -n "$untracked" ]]; then
    while IFS= read -r path; do
      case "$path" in
        .venv|.venv/*|__pycache__/*|*/__pycache__/*|*.pyc|*.pyo) ;;
        *) engine_error "has an untracked file: $path" ;;
      esac
    done <<< "$untracked"
  fi
  if [[ "$index_tree" == "$scienceflow_tree" ]]; then
    printf 'verified\n'
  elif [[ "$index_tree" == "$base_tree" ]]; then
    printf 'base\n'
  else
    engine_error "has an index tree that is neither the pinned base nor the patched tree; it may be partially patched"
  fi
}

if [[ ! -e "$engine_dir" ]]; then
  GIT_TERMINAL_PROMPT=0 git clone --quiet "$scienceflow_git_url" "$engine_dir" \
    || fail "could not clone ScienceFlow from $scienceflow_git_url"
  git -C "$engine_dir" -c advice.detachedHead=false checkout --quiet --detach "$scienceflow_base" \
    || fail "could not check out the pinned ScienceFlow base $scienceflow_base"
elif [[ ! -d "$engine_dir" ]]; then
  engine_error "is not a directory"
fi

if ! engine_state="$(check_engine)"; then
  exit 1
fi
if [[ "$engine_state" == "base" ]]; then
  for patch_name in "${patch_names[@]}"; do
    git -C "$engine_dir" apply --index --whitespace=nowarn "$patch_dir/$patch_name" \
      || engine_error "could not apply $patch_name"
  done
  if ! engine_state="$(check_engine)"; then
    exit 1
  fi
fi
[[ "$engine_state" == "verified" ]] \
  || engine_error "did not reach the pinned patched tree"

# SF only needs its runtime dependencies for the circle-packing task; the full
# and GPU extras are intentionally absent.
if [[ -n "${SCIENCE_AGENT_PYPI_INDEX:-}" ]]; then
  export UV_DEFAULT_INDEX="$SCIENCE_AGENT_PYPI_INDEX"
fi
(
  cd "$engine_dir"
  UV_PROJECT_ENVIRONMENT="$engine_dir/.venv" uv sync --frozen --no-dev --python 3.12
) || fail "uv sync failed in the ScienceFlow checkout"

# The default lock closure is the CPU control plane only. Some registered task
# evaluators need a small scientific CPU stack: ratio-minimization imports NumPy
# and SciPy, which the lock carries for the optional extras but does not install
# by default. Install exactly the versions pinned in that uv.lock, after the
# exact sync (which removes them on a repeat run), so setup is repeatable and
# neither the full ML profile nor GPU extras are pulled in.
scienceflow_task_python_deps=(numpy==2.4.3 scipy==1.17.1)
(
  cd "$engine_dir"
  uv pip install --python "$engine_dir/.venv/bin/python" "${scienceflow_task_python_deps[@]}"
) || fail "could not install the registered tasks' CPU evaluator dependencies"
"$engine_dir/.venv/bin/python" -c 'import numpy, scipy; print(f"task evaluator deps: numpy {numpy.__version__}, scipy {scipy.__version__}")' \
  || fail "the engine interpreter cannot import the registered tasks' CPU evaluator dependencies"

pnpm_install_args=(install --frozen-lockfile --ignore-scripts)
if [[ -n "${SCIENCE_AGENT_NPM_REGISTRY:-}" ]]; then
  pnpm_install_args+=(--registry "$SCIENCE_AGENT_NPM_REGISTRY")
fi
(
  cd "$repository_root"
  pnpm "${pnpm_install_args[@]}"
) || fail "pnpm install failed"
(
  cd "$repository_root"
  pnpm build
) || fail "pnpm build failed"

# JiuwenSwarm owns a separate install, home and instance name under the pilot
# root. The explicit overrides keep inherited user settings from redirecting it
# into the default ~/.sciencediscovery state.
(
  export SCIENCE_AGENT_JIUWENSWARM_OVERRIDES=1
  export JIUWENSWARM_ROOT="$jiuwen_root"
  export JIUWENSWARM_SRC="$jiuwen_src"
  export JIUWENSWARM_HOME="$jiuwen_home"
  export JIUWENSWARM_INSTANCE="$pilot_instance"
  export UV_PROJECT_ENVIRONMENT="$jiuwen_src/.venv"
  "$repository_root/scripts/jiuwenswarm.sh" setup
) || fail "JiuwenSwarm setup failed"

if [[ ! -e "$config_path" ]]; then
  PILOT_ROOT="$pilot_root" REPO_ROOT="$repository_root" CONFIG_PATH="$config_path" OPTIONAL_INCUMBENT="$((1 - with_initial_candidate))" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PILOT_ROOT;
    const repo = process.env.REPO_ROOT;
    const config = {
      schemaVersion: 1,
      enabled: true,
      research: {
        profileId: "scienceflow-pilot-task-dynamic",
        // The conversation chooses a registered task package or prepares its
        // own contract; the profile deliberately names no fixed task.
        taskMode: "task-dynamic",
        engineCheckout: path.join(root, "engine"),
        pythonExecutable: path.join(root, "engine", ".venv", "bin", "python"),
        readerScriptPath: path.join(repo, "services", "scienceflow-reader", "snapshot.py"),
        preparationScriptPath: path.join(repo, "services", "scienceflow-preparation", "preparation.py"),
        evaluatorProbeTimeoutSec: 60,
        seedDir: path.join(root, "assets"),
        inputMode: "dynamic",
        dynamicInputs: {
          plan: "experiment_plan.md", incumbent: "start_solution.json",
          ...(process.env.OPTIONAL_INCUMBENT === "1" ? { incumbentOptional: true } : {}),
        },
        workRoot: path.join(root, "runs"),
        privateRoot: path.join(root, "private"),
        refusePackageInstall: true,
      },
      defaults: {
        researchBudgetSec: 840,
        reportBudgetSec: 60,
        totalAllowanceSec: 900,
        maxSteps: 40,
        stageCaptureMax: 6,
        bashTimeoutSec: 60,
        codeMaxTokens: 8192,
        feedbackMaxTokens: 4096,
        httpTimeoutSec: 60,
        observeMaxWaitMs: 120000,
      },
    };
    fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(config, null, 2) + "\n",
      { encoding: "utf8", mode: 0o644, flag: "wx" });
  ' || fail "could not write the research configuration: $config_path"
  echo "Wrote the research configuration: $config_path" >&2
fi

# Older pilot roots may still contain task-template.md; it is no longer read by
# task-dynamic mode, and a fresh setup does not create one.
# This helper is generated, not user configuration. It deliberately imports the
# repository sources by absolute file URL because the pilot root may live
# outside the repository, and it is run with `node --import tsx` from the
# repository root so bare package resolution still works.
cat > "$bootstrap_helper" <<'TS'
/**
 * One-time local-pilot store bootstrap.
 *
 * Creates a Project and a Session without a model. Optionally imports the
 * engine validation fixture when PILOT_INITIAL_CANDIDATE=1. The
 * data directory must be empty and the receipt must not exist. On any failure
 * the partial directory is left for inspection; it must not be reused.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, pilotRoot] = process.argv.slice(2);
if (!repoRoot || !pilotRoot) {
  throw new Error("usage: bootstrap.mts <repository-root> <pilot-root>");
}

const dataDir = join(pilotRoot, "data");
const receiptPath = join(pilotRoot, "session-bootstrap.json");
const validationPath = join(
  pilotRoot, "engine", "tasks", "opt_solver", "circle-packing",
  "validation", "valid_solution.json",
);

let receiptExists = true;
try {
  await readFile(receiptPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  receiptExists = false;
}
if (receiptExists) throw new Error(`refusing to overwrite existing receipt ${receiptPath}`);

let entries: string[] = [];
try {
  entries = await readdir(dataDir);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (entries.length > 0) {
  throw new Error(`refusing to bootstrap non-empty data directory ${dataDir}`);
}
await mkdir(dataDir, { recursive: true });

const moduleUrl = (relativePath: string): string =>
  pathToFileURL(join(repoRoot, relativePath)).href;
const { SessionStore } = await import(moduleUrl("services/api/src/store.ts"));
const { CasStore } = await import(moduleUrl("packages/cas/src/index.ts"));

const withInitialCandidate = process.env.PILOT_INITIAL_CANDIDATE === "1";
const bytes = withInitialCandidate ? await readFile(validationPath) : undefined;
const store = new SessionStore(dataDir);
try {
  await store.load();
  const project = await store.createProject("ScienceFlow pilot");
  const session = await store.createSession(
    project.id,
    "Circle-packing pilot",
    {},
    {},
    { allowUnconfiguredModel: true },
  );
  const result = bytes === undefined ? undefined : await store.createArtifactVersion({
    sessionId: session.id,
    logicalName: "scienceflow/initial-solution.json",
    kind: "json",
    mediaType: "application/json",
    origin: "server_generated",
    title: "Initial validation fixture (not a model result)",
    content: await new CasStore(store.dataDir).put(bytes),
  });
  const receipt = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    pilotRoot,
    dataDir,
    projectId: project.id,
    sessionId: session.id,
    artifactId: result?.artifact.id ?? null,
    initialVersionId: result?.version.id ?? null,
    contentSha256: result?.version.content.hash ?? null,
    contentBytes: result?.version.content.size ?? null,
    sourceFile: result ? "engine/tasks/opt_solver/circle-packing/validation/valid_solution.json" : null,
  };
  const temporary = `${receiptPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, receiptPath);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  store.close();
}
TS
chmod 600 "$bootstrap_helper"

directory_has_entries() {
  [[ -d "$1" ]] && [[ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

if [[ -e "$receipt_path" ]]; then
  [[ -f "$receipt_path" ]] || fail "the bootstrap receipt is not a regular file: $receipt_path"
  [[ -d "$data_dir" ]] || fail "the bootstrap receipt exists but the data directory is missing; setup was interrupted. Move $pilot_root aside or choose a fresh root."
  directory_has_entries "$data_dir" \
    || fail "the bootstrap receipt exists but the data directory is empty; setup was interrupted. Move $pilot_root aside or choose a fresh root."
  [[ -f "$data_dir/catalog.sqlite" ]] \
    || fail "the bootstrap receipt exists but the Session store is missing; setup was interrupted. Move $pilot_root aside or choose a fresh root."
  if ! OPTIONAL_INCUMBENT="$((1 - with_initial_candidate))" node -e '
    const fs = require("node:fs");
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (receipt.schemaVersion !== 1
        || typeof receipt.projectId !== "string"
        || typeof receipt.sessionId !== "string"
        || !(typeof receipt.initialVersionId === "string"
          || (receipt.initialVersionId === null && process.env.OPTIONAL_INCUMBENT === "1"))) process.exit(1);
  ' "$receipt_path"; then
    fail "the existing bootstrap receipt is invalid: $receipt_path"
  fi
  echo "Reusing the existing pilot Session; the live store was not opened." >&2
  node -e '
    const fs = require("node:fs");
    const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`  Project: ${receipt.projectId}`);
    console.log(`  Session: ${receipt.sessionId}`);
  ' "$receipt_path"
else
  if [[ -e "$data_dir" ]]; then
    [[ -d "$data_dir" ]] || fail "the pilot data path is not a directory: $data_dir"
    directory_has_entries "$data_dir" \
      && fail "the pilot data directory is not empty but has no bootstrap receipt; an earlier setup may have been interrupted or another instance owns it. Move $pilot_root aside or choose a fresh root."
  fi
  (
    cd "$repository_root"
    PILOT_INITIAL_CANDIDATE="$with_initial_candidate" node --import tsx "$bootstrap_helper" "$repository_root" "$pilot_root"
  ) || fail "the pilot store bootstrap failed; $data_dir may now contain partial state and still has no receipt. Move $pilot_root aside or choose a fresh root, then rerun setup."
fi

echo
echo "ScienceFlow pilot is ready."
echo "  Root:      $pilot_root"
echo "  Session:   $pilot_session_title (Project: $pilot_project_name)"
echo "  Start:     $repository_root/scripts/start-scienceflow-pilot.sh \"$pilot_root\""
echo "  Then open: http://127.0.0.1:4310 and choose a model in that Session or a new Session."
