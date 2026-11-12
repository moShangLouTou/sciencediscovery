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
 * The fixed, read-only ScienceFlow resolution probe.
 *
 * The program is a constant in this file, reads no caller text, and only
 * imports `sys`, `json`, and `os`. It never imports ScienceFlow, never calls
 * `find_spec` on it, and never runs any of its code. Everything it reports is a
 * fact about the interpreter that would run a future execution: version and
 * prefix, `sys.path`, site-packages entries, bounded `.pth` lines, installed
 * distribution names, and whether a startup customization module was loaded.
 *
 * The Runner — not the probe — decides which package source those facts mean.
 * Keeping the decision here is what stops a hook from answering its own
 * question: a `.pth` that executes an import is refused before its finder is
 * trusted.
 */

/** Version of the probe protocol understood by this Runner. */
export const SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION = 1;
/** A facts answer larger than this is a protocol error, not a fact set. */
export const SCIENCE_FLOW_RUNTIME_PROBE_MAX_OUTPUT_BYTES = 256 * 1024;
/** Bound on one probe run. */
export const SCIENCE_FLOW_RUNTIME_PROBE_TIMEOUT_MS = 10_000;
export const SCIENCE_FLOW_RUNTIME_PROBE_MAX_TIMEOUT_MS = 30_000;

/**
 * The probe program, passed on the interpreter's stdin.
 *
 * Sizes are bounded inside the program as well as outside: the Runner's output
 * cap must never be the only thing standing between a hostile site-packages and
 * a large answer. Nothing here branches on environment content beyond counting
 * it, so the program's behavior cannot be steered by what it reads.
 */
export const SCIENCE_FLOW_RUNTIME_PROBE_SOURCE = String.raw`
import sys
sys.dont_write_bytecode = True
import json, os

SCHEMA = 1
MAX_PATH = 64
MAX_SITE = 8
MAX_PTH = 32
MAX_LINES = 16
MAX_TEXT = 512
MAX_DISTS = 16
MAX_PTH_FILE_BYTES = 65536

def text(value):
    return str(value)[:MAX_TEXT]

def main():
    path = [text(entry) for entry in sys.path[:MAX_PATH]]
    sites = [entry for entry in path
             if entry and (entry.endswith("/site-packages") or entry.endswith("/dist-packages"))][:MAX_SITE]
    pth = []
    dists = []
    for site in sites:
        try:
            names = sorted(os.listdir(site))
        except OSError:
            continue
        for name in names:
            lower = name.lower()
            if lower.startswith("scienceflow") and (
                    lower.endswith(".dist-info") or lower.endswith(".egg-info")
                    or lower.endswith(".egg-link")) and len(dists) < MAX_DISTS:
                dists.append(text(name))
            if name.endswith(".pth") and len(pth) < MAX_PTH:
                full = os.path.join(site, name)
                entry = {"path": text(full), "pathLines": [], "importLines": 0, "unreadable": False}
                try:
                    with open(full, "rb") as handle:
                        raw = handle.read(MAX_PTH_FILE_BYTES)
                except OSError:
                    entry["unreadable"] = True
                    pth.append(entry)
                    continue
                for line in raw.decode("utf-8", "replace").splitlines():
                    stripped = line.strip()
                    if not stripped or stripped.startswith("#"):
                        continue
                    if stripped == "import" or stripped.startswith("import ") or stripped.startswith("import\t"):
                        entry["importLines"] = entry["importLines"] + 1
                    elif len(entry["pathLines"]) < MAX_LINES:
                        entry["pathLines"].append(text(stripped))
                pth.append(entry)
    packages = []
    for entry in path:
        if not entry or not os.path.isabs(entry) or not os.path.isdir(entry):
            continue
        candidate = os.path.join(entry, "scienceflow")
        if not os.path.isdir(candidate):
            continue
        regular = os.path.isfile(os.path.join(candidate, "__init__.py"))
        packages.append({"entry": entry, "regular": regular, "namespace": not regular})
    result = {
        "schemaVersion": SCHEMA,
        "ok": True,
        "python": {
            "version": text("%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2])),
            "prefix": text(sys.prefix),
            "basePrefix": text(sys.base_prefix),
        },
        "path": path,
        "sitePackages": sites,
        "pth": pth,
        "distributions": dists,
        "packages": packages,
        "startupHooks": {
            "sitecustomize": "sitecustomize" in sys.modules,
            "usercustomize": "usercustomize" in sys.modules,
        },
    }
    sys.stdout.write(json.dumps(result, sort_keys=True))
    sys.stdout.flush()

try:
    main()
except BaseException:
    sys.stdout.write(json.dumps({"schemaVersion": 1, "ok": False, "failure": "unexpected"}))
    sys.exit(2)
`;

export interface ScienceFlowRuntimeProbePython {
  readonly version: string;
  readonly prefix: string;
  readonly basePrefix: string;
}

export interface ScienceFlowRuntimeProbePthFile {
  /** Host path of the `.pth` file; used locally for containment, never returned. */
  readonly path: string;
  readonly pathLines: readonly string[];
  readonly importLines: number;
  readonly unreadable: boolean;
}

export interface ScienceFlowRuntimeProbePackage {
  /** The `sys.path` entry that contains `scienceflow` (not the package dir). */
  readonly entry: string;
  readonly regular: boolean;
  readonly namespace: boolean;
}

/** Facts the probe reports; every field was observed, none was inferred. */
export interface ScienceFlowRuntimeProbeFacts {
  readonly python: ScienceFlowRuntimeProbePython;
  readonly path: readonly string[];
  readonly sitePackages: readonly string[];
  readonly pth: readonly ScienceFlowRuntimeProbePthFile[];
  readonly distributions: readonly string[];
  readonly packages: readonly ScienceFlowRuntimeProbePackage[];
  readonly startupHooks: {
    readonly sitecustomize: boolean;
    readonly usercustomize: boolean;
  };
}

export type ParsedProbeAnswer =
  | { readonly status: "ok"; readonly facts: ScienceFlowRuntimeProbeFacts }
  /** The probe itself could not collect facts (its fixed failure answer). */
  | { readonly status: "failed" }
  /** The answer was not the fixed protocol: wrong shape, version, or bounds. */
  | { readonly status: "protocol-error" };

/**
 * Parse one answer. Nothing in it is trusted beyond the fixed shape; unknown
 * fields are ignored deliberately, because the Runer only reads what it
 * validates and the probe version is pinned by the request it answered.
 */
export function parseScienceFlowRuntimeProbeAnswer(
  raw: string,
): ParsedProbeAnswer {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "protocol-error" };
  }
  if (!isRecord(value)) return { status: "protocol-error" };
  if (value.schemaVersion !== SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION) {
    return { status: "protocol-error" };
  }
  if (value.ok !== true) return { status: "failed" };

  const python = value.python;
  if (!isRecord(python)) return { status: "protocol-error" };
  const version = python.version;
  const prefix = python.prefix;
  const basePrefix = python.basePrefix;
  if (
    typeof version !== "string" ||
    typeof prefix !== "string" ||
    typeof basePrefix !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !isAbsoluteString(prefix) ||
    !isAbsoluteString(basePrefix)
  ) {
    return { status: "protocol-error" };
  }

  const path = stringArray(value.path, 64);
  if (path === null) return { status: "protocol-error" };
  const sitePackages = stringArray(value.sitePackages, 8);
  if (sitePackages === null) return { status: "protocol-error" };
  const distributions = stringArray(value.distributions, 16);
  if (distributions === null) return { status: "protocol-error" };

  const pthValue = value.pth;
  if (!Array.isArray(pthValue) || pthValue.length > 32) {
    return { status: "protocol-error" };
  }
  const pth: ScienceFlowRuntimeProbePthFile[] = [];
  for (const entry of pthValue) {
    if (!isRecord(entry)) return { status: "protocol-error" };
    const pathLines = stringArray(entry.pathLines, 16);
    if (pathLines === null) return { status: "protocol-error" };
    const importLines = entry.importLines;
    if (
      typeof entry.path !== "string" ||
      !isAbsoluteString(entry.path) ||
      typeof entry.unreadable !== "boolean" ||
      !Number.isSafeInteger(importLines) ||
      (importLines as number) < 0 ||
      (importLines as number) > 999
    ) {
      return { status: "protocol-error" };
    }
    pth.push({
      path: entry.path,
      pathLines,
      importLines: importLines as number,
      unreadable: entry.unreadable,
    });
  }

  const packagesValue = value.packages;
  if (!Array.isArray(packagesValue) || packagesValue.length > 64) {
    return { status: "protocol-error" };
  }
  const packages: ScienceFlowRuntimeProbePackage[] = [];
  for (const entry of packagesValue) {
    if (!isRecord(entry)) return { status: "protocol-error" };
    if (
      typeof entry.entry !== "string" ||
      !isAbsoluteString(entry.entry) ||
      typeof entry.regular !== "boolean" ||
      typeof entry.namespace !== "boolean"
    ) {
      return { status: "protocol-error" };
    }
    packages.push({
      entry: entry.entry,
      regular: entry.regular,
      namespace: entry.namespace,
    });
  }

  const hooks = value.startupHooks;
  if (
    !isRecord(hooks) ||
    typeof hooks.sitecustomize !== "boolean" ||
    typeof hooks.usercustomize !== "boolean"
  ) {
    return { status: "protocol-error" };
  }

  return {
    status: "ok",
    facts: {
      python: { version, prefix, basePrefix },
      path,
      sitePackages,
      pth,
      distributions,
      packages,
      startupHooks: {
        sitecustomize: hooks.sitecustomize,
        usercustomize: hooks.usercustomize,
      },
    },
  };
}

function stringArray(value: unknown, max: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((entry) => typeof entry === "string" && entry.length <= 512)) {
    return null;
  }
  return value as readonly string[];
}

function isAbsoluteString(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
