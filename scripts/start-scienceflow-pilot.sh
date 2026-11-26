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

# Start the local stack for one prepared ScienceFlow pilot.
#
# The script rebuilds the pilot environment from its root on every start, so a
# new shell needs no exports. It refuses a .env that would redirect the data,
# research config, executor or JiuwenSwarm state, then delegates to the normal
# local stack launcher without inventing a second service orchestrator.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
default_pilot_root="$repository_root/.tmp/scienceflow-pilot"
pilot_instance="scienceflow-pilot"

usage() {
  cat <<'EOF'
Usage: scripts/start-scienceflow-pilot.sh [PILOT_ROOT]

Start the local ScienceDiscovery stack with the isolated ScienceFlow pilot at
PILOT_ROOT, prepared by scripts/setup-scienceflow-pilot.sh. PILOT_ROOT defaults
to .tmp/scienceflow-pilot under this repository. A relative path is resolved
from the current directory; spaces are allowed.

  -h, --help   show this help and exit
EOF
}

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
  echo "start-scienceflow-pilot: $*" >&2
  exit 1
}

if [[ ! -d "$pilot_root" ]]; then
  fail "the pilot root does not exist: $pilot_root (run scripts/setup-scienceflow-pilot.sh first)"
fi
if [[ -L "$pilot_root" ]]; then
  fail "the pilot root must not be a symlink: $pilot_root"
fi
pilot_root="$(cd -- "$pilot_root" && pwd -P)" \
  || fail "cannot resolve the pilot root: $pilot_root"

data_dir="$pilot_root/data"
config_path="$pilot_root/research.json"
receipt_path="$pilot_root/session-bootstrap.json"
engine_python="$pilot_root/engine/.venv/bin/python"
jiuwen_start="$pilot_root/jiuwenswarm/src/.venv/bin/jiuwenswarm-start"

for path in "$config_path" "$receipt_path"; do
  [[ -f "$path" ]] || fail "missing $path (run scripts/setup-scienceflow-pilot.sh first)"
done
[[ -d "$data_dir" ]] || fail "missing $data_dir (run scripts/setup-scienceflow-pilot.sh first)"
[[ -f "$data_dir/catalog.sqlite" ]] \
  || fail "the pilot Session store is missing; setup was interrupted. Move $pilot_root aside or choose a fresh root."
[[ -x "$engine_python" ]] \
  || fail "the ScienceFlow Python environment is missing: $engine_python (rerun setup)"
[[ -x "$jiuwen_start" ]] \
  || fail "the isolated JiuwenSwarm installation is missing: $jiuwen_start (rerun setup)"

if ! node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let config;
  try { config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
  if (config.schemaVersion !== 1 || config.enabled !== true || !config.research) process.exit(1);
  const research = config.research;
  if (research.taskMode !== "task-dynamic" || research.task !== undefined) process.exit(1);
  const keys = ["engineCheckout", "pythonExecutable", "readerScriptPath", "preparationScriptPath",
    "seedDir", "workRoot", "privateRoot"];
  for (const key of keys) {
    if (typeof research[key] !== "string" || !path.isAbsolute(research[key])) process.exit(1);
    if (!fs.existsSync(research[key])) process.exit(1);
  }
' "$config_path"; then
  fail "the pilot research configuration is invalid or points at missing paths: $config_path"
fi

if ! node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
  if (receipt.schemaVersion !== 1
      || typeof receipt.projectId !== "string"
      || typeof receipt.sessionId !== "string"
      || !(typeof receipt.initialVersionId === "string"
        || (receipt.initialVersionId === null && config.research?.dynamicInputs?.incumbentOptional === true))) process.exit(1);
' "$receipt_path" "$config_path"; then
  fail "the pilot bootstrap receipt is invalid: $receipt_path"
fi

# start-stack.sh sources .env after this script starts. Refuse any assignment
# there that would replace this pilot's roots, state or executor before the
# stack can silently launch the wrong instance. No value other than these
# pilot-critical paths is inspected or printed.
read_env_assignment() {
  local file="$1" name="$2" line key raw found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      [[ "$key" == "$name" ]] || continue
      raw="${BASH_REMATCH[3]}"
      raw="${raw#"${raw%%[![:space:]]*}"}"
      if [[ "$raw" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then
        raw="${BASH_REMATCH[1]}"
      elif [[ "$raw" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
        raw="${BASH_REMATCH[1]}"
      else
        raw="${raw%%[[:space:]]#*}"
        raw="${raw%"${raw##*[![:space:]]}"}"
      fi
      found=1
    fi
  done < "$file"
  [[ "$found" -eq 1 ]] && printf '%s' "$raw"
}

check_env_conflicts() {
  local env_file="$repository_root/.env"
  [[ -e "$env_file" ]] || return 0
  [[ -f "$env_file" ]] || fail "$env_file is not a regular file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(source|\.)[[:space:]] ]] \
        || [[ "$line" =~ ^[[:space:]]*eval[[:space:]] ]]; then
      fail "$env_file contains a shell include or eval command; start-stack.sh would execute it, so pilot isolation cannot be verified"
    fi
  done < "$env_file"
  local -A expected=(
    [SCIENCE_DISCOVERY_DATA_DIR]="$data_dir"
    [SCIENCE_AGENT_DATA_DIR]="$data_dir"
    [SCIENCE_AGENT_SCIENCEFLOW_LOCAL_RESEARCH_CONFIG_PATH]="$config_path"
    [SCIENCE_AGENT_EXECUTOR]="jiuwenswarm"
    [SCIENCE_AGENT_ADAPTER]="1"
    [SCIENCE_AGENT_JIUWENSWARM_OVERRIDES]="1"
    [JIUWENSWARM_ROOT]="$pilot_root/jiuwenswarm"
    [JIUWENSWARM_SRC]="$pilot_root/jiuwenswarm/src"
    [JIUWENSWARM_HOME]="$pilot_root/jiuwenswarm-home"
    [JIUWENSWARM_INSTANCE]="$pilot_instance"
  )
  local name found line
  for name in "${!expected[@]}"; do
    if found="$(read_env_assignment "$env_file" "$name")"; then
      [[ "$found" == "${expected[$name]}" ]] \
        || fail "$env_file overrides $name; remove the conflicting assignment before starting this pilot"
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*unset[[:space:]] ]] && [[ " $line " == *" $name "* ]]; then
        fail "$env_file unsets $name, which this pilot requires; edit .env or use a dedicated pilot root"
      fi
    done < "$env_file"
  done
}
check_env_conflicts

export SCIENCE_DISCOVERY_DATA_DIR="$data_dir"
export SCIENCE_AGENT_DATA_DIR="$data_dir"
export SCIENCE_AGENT_SCIENCEFLOW_LOCAL_RESEARCH_CONFIG_PATH="$config_path"
export SCIENCE_AGENT_EXECUTOR=jiuwenswarm
export SCIENCE_AGENT_ADAPTER=1
export SCIENCE_AGENT_JIUWENSWARM_OVERRIDES=1
export JIUWENSWARM_ROOT="$pilot_root/jiuwenswarm"
export JIUWENSWARM_SRC="$pilot_root/jiuwenswarm/src"
export JIUWENSWARM_HOME="$pilot_root/jiuwenswarm-home"
export JIUWENSWARM_INSTANCE="$pilot_instance"
export SCIENCE_DISCOVERY_PRINT_AUTH_TOKEN=1

echo "Starting the ScienceFlow pilot from $pilot_root" >&2
echo "Open http://127.0.0.1:4310 and choose a model in the ScienceFlow research pilot Session." >&2
# No --no-build/--no-node-build here: setup prepares the pinned engine, but the
# first start still provisions the SD service environments. Skipping the
# launcher's checks could also run stale artifacts after a repository update.
exec "$repository_root/scripts/start-stack.sh" --mode local
