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
 * One program, two modes, both launched through the ordinary sandbox:
 *
 * - **static** (`-I -S -B -`): site processing is disabled, so no `.pth`
 *   import line, `sitecustomize`, or `usercustomize` can run. The program reads
 *   the interpreter's own site directories, parses every `.pth` file itself
 *   (plain path lines only), reconstructs the `sys.path` a normal start would
 *   produce, and scans every entry without importing anything from it.
 * - **runtime** (`-I -B -`): a normal start. It only runs after the static
 *   answer proved that no executable startup configuration exists; it exists to
 *   confirm that the reconstructed path and resolution are what a normal start
 *   actually gets.
 *
 * The probe imports only `sys`, `os`, `json`, `site`, `stat`, and
 * `importlib.machinery`. It never imports ScienceFlow or any package it
 * inspects, never calls `find_spec`, and never runs a console entry point. The
 * Runner — not the probe — decides what those facts mean.
 *
 * Every list, string, file, and byte count is bounded, and a bound that is hit
 * is reported as a truncation flag. A truncated answer is refused by the
 * Runner; it is never treated as a complete scan.
 */

/** Version of the probe protocol understood by this Runner. */
export const SCIENCE_FLOW_RUNTIME_PROBE_SCHEMA_VERSION = 2;
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
 * it, so the program's behavior cannot be steered by what it reads. The mode is
 * chosen by the interpreter flag the Runner launched with, never by input.
 */
export const SCIENCE_FLOW_RUNTIME_PROBE_SOURCE = String.raw`
import sys
sys.dont_write_bytecode = True
import json, os, site, stat
import importlib.machinery as _machinery
_EXT = tuple(_machinery.EXTENSION_SUFFIXES)
_BYTECODE = tuple(_machinery.BYTECODE_SUFFIXES)

SCHEMA = 2
MAX_PATH = 64
MAX_SITE = 8
MAX_PTH = 32
MAX_LINES = 16
MAX_TEXT = 512
MAX_DISTS = 16
MAX_PTH_FILE_BYTES = 65536
MAX_NAMES = 4096
TEXT_BUDGET = 98304

truncation = {"path": False, "site": False, "pth": False,
              "lines": False, "names": False, "text": False,
              "distributions": False, "budget": False}
_budget = [TEXT_BUDGET]

def text(value):
    raw = str(value)
    if len(raw) > MAX_TEXT:
        truncation["text"] = True
        raw = raw[:MAX_TEXT]
    if _budget[0] < len(raw):
        truncation["budget"] = True
        return raw[:max(0, _budget[0])]
    _budget[0] -= len(raw)
    return raw

def lstat(path):
    try:
        return os.lstat(path)
    except (OSError, ValueError):
        return None

def stat_follow(path):
    try:
        return os.stat(path)
    except (OSError, ValueError):
        return None

def is_directory(path):
    st = stat_follow(path)
    return st is not None and stat.S_ISDIR(st.st_mode)

def read_regular(path, limit):
    # Never follow a link and never block on a device or FIFO: the identity is
    # checked with lstat, then again with fstat on the descriptor actually read.
    st = lstat(path)
    if st is None:
        return None, "missing"
    if stat.S_ISLNK(st.st_mode):
        return None, "link"
    if not stat.S_ISREG(st.st_mode):
        return None, "not-regular"
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
    except OSError:
        return None, "unreadable"
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            return None, "not-regular"
        if opened.st_size > limit:
            return None, "too-large"
        chunks = []
        remaining = limit + 1
        while remaining > 0:
            piece = os.read(fd, min(remaining, 65536))
            if not piece:
                break
            chunks.append(piece)
            remaining -= len(piece)
        data = b"".join(chunks)
        if len(data) > limit:
            return None, "too-large"
        return data, None
    except OSError:
        return None, "unreadable"
    finally:
        os.close(fd)

def scan_pth(sitedir):
    files = []
    try:
        names = sorted(os.listdir(sitedir))
    except OSError:
        return files
    if len(names) > MAX_NAMES:
        truncation["names"] = True
        names = names[:MAX_NAMES]
    count = 0
    for name in names:
        if not name.endswith(".pth"):
            continue
        if count >= MAX_PTH:
            truncation["pth"] = True
            break
        count += 1
        full = os.path.join(sitedir, name)
        entry = {"path": text(full), "pathLines": [], "pathLineMissing": [],
                 "importLines": 0, "unreadable": False, "tooLarge": False,
                 "notRegular": False, "unsupportedEncoding": False,
                 "lines": 0, "lineLimitExceeded": False}
        data, reason = read_regular(full, MAX_PTH_FILE_BYTES)
        if reason == "too-large":
            entry["tooLarge"] = True
        elif reason in ("link", "not-regular"):
            entry["notRegular"] = True
        elif reason is not None:
            entry["unreadable"] = True
        else:
            try:
                decoded = data.decode("utf-8")
            except UnicodeDecodeError:
                decoded = None
                entry["unsupportedEncoding"] = True
            if decoded is not None:
                for line in decoded.splitlines():
                    if line.startswith("#"):
                        continue
                    if line.strip() == "":
                        continue
                    entry["lines"] += 1
                    if entry["lines"] > MAX_LINES:
                        truncation["lines"] = True
                        entry["lineLimitExceeded"] = True
                        break
                    if line.startswith("import ") or line.startswith("import\t"):
                        entry["importLines"] += 1
                        continue
                    if not line.isascii():
                        entry["unsupportedEncoding"] = True
                        continue
                    stripped = line.rstrip()
                    if not stripped:
                        continue
                    if os.path.isabs(stripped):
                        target = os.path.abspath(stripped)
                    else:
                        target = os.path.abspath(os.path.join(sitedir, stripped))
                    entry["pathLines"].append(text(target))
                    entry["pathLineMissing"].append(not os.path.exists(target))
        files.append(entry)
    return files

def candidate_kind(entry):
    # Classify one sys.path entry without importing anything from it. Parent
    # directory links are followed (a normal start follows them); a linked
    # package, module file, or __init__ is reported as a link and refused.
    if not entry:
        return {"entry": text(entry), "kind": "relative", "symlinked": False, "scienceflow": None}
    if not os.path.isabs(entry):
        return {"entry": text(entry), "kind": "relative", "symlinked": False, "scienceflow": None}
    link = os.path.islink(entry)
    st = stat_follow(entry)
    if st is None:
        return {"entry": text(entry), "kind": "missing", "symlinked": False, "scienceflow": None}
    if stat.S_ISREG(st.st_mode):
        return {"entry": text(entry), "kind": "file", "symlinked": link, "scienceflow": None}
    if not stat.S_ISDIR(st.st_mode):
        return {"entry": text(entry), "kind": "other", "symlinked": link, "scienceflow": None}
    scienceflow = None
    for suffix in _EXT:
        candidate = os.path.join(entry, "scienceflow" + suffix)
        if os.path.lexists(candidate):
            scienceflow = {"kind": "extension" if not os.path.islink(candidate) else "link"}
            break
    if scienceflow is None:
        candidate = os.path.join(entry, "scienceflow.py")
        if os.path.lexists(candidate):
            cst = lstat(candidate)
            scienceflow = {"kind": "module" if cst is not None and stat.S_ISREG(cst.st_mode) and not os.path.islink(candidate) else "link"}
    if scienceflow is None:
        for suffix in _BYTECODE:
            candidate = os.path.join(entry, "scienceflow" + suffix)
            if os.path.lexists(candidate):
                scienceflow = {"kind": "module" if not os.path.islink(candidate) else "link"}
                break
    if scienceflow is None:
        package = os.path.join(entry, "scienceflow")
        pst = lstat(package)
        if pst is not None:
            if stat.S_ISLNK(pst.st_mode) or not stat.S_ISDIR(pst.st_mode):
                scienceflow = {"kind": "link"}
            else:
                package_kind = "namespace"
                found = False
                for suffix in _EXT:
                    candidate = os.path.join(package, "__init__" + suffix)
                    if os.path.lexists(candidate):
                        package_kind = "link" if os.path.islink(candidate) else "extension"
                        found = True
                        break
                if not found:
                    candidate = os.path.join(package, "__init__.py")
                    if os.path.lexists(candidate):
                        ist = lstat(candidate)
                        package_kind = "regular" if ist is not None and stat.S_ISREG(ist.st_mode) and not os.path.islink(candidate) else "link"
                        found = True
                if not found:
                    for suffix in _BYTECODE:
                        candidate = os.path.join(package, "__init__" + suffix)
                        if os.path.lexists(candidate):
                            package_kind = "link" if os.path.islink(candidate) else "extension"
                            break
                scienceflow = {"kind": package_kind}
    return {"entry": text(entry), "kind": "directory", "symlinked": link, "scienceflow": scienceflow}

def hooks_for(entry):
    # A normal start imports sitecustomize/usercustomize from sys.path. Their
    # mere presence is enough to refuse; neither is imported here.
    result = {"entry": text(entry), "sitecustomize": False, "usercustomize": False}
    if not entry or not os.path.isabs(entry):
        return result
    st = stat_follow(entry)
    if st is None or not stat.S_ISDIR(st.st_mode):
        return result
    for name in ("sitecustomize", "usercustomize"):
        # -B forbids writing bytecode, not loading an existing sourceless .pyc.
        # Ordinary imports also load ABI-specific extensions and packages. Any
        # candidate is unsupported here, including links and namespace portions.
        candidates = [os.path.join(entry, name)]
        candidates.extend(os.path.join(entry, name + suffix)
                          for suffix in (".py",) + _EXT + _BYTECODE)
        result[name] = any(os.path.lexists(candidate) for candidate in candidates)
    return result

def distributions(site_dirs):
    found = []
    for sitedir in site_dirs:
        try:
            names = sorted(os.listdir(sitedir))
        except OSError:
            continue
        if len(names) > MAX_NAMES:
            truncation["names"] = True
            names = names[:MAX_NAMES]
        for name in names:
            lower = name.lower()
            if lower.startswith("scienceflow") and (
                    lower.endswith(".dist-info") or lower.endswith(".egg-info")
                    or lower.endswith(".egg-link")):
                if len(found) >= MAX_DISTS:
                    truncation["distributions"] = True
                    break
                found.append(text(name))
    return found

def python_facts():
    return {
        "version": text("%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2])),
        "prefix": text(sys.prefix),
        "basePrefix": text(sys.base_prefix),
        "noSite": bool(sys.flags.no_site),
        "noUserSite": bool(sys.flags.no_user_site),
        "dontWriteBytecode": bool(sys.flags.dont_write_bytecode),
    }

def static_facts():
    base_path = list(sys.path)
    if len(base_path) > MAX_PATH:
        truncation["path"] = True
        base_path = base_path[:MAX_PATH]
    try:
        site_dirs = list(site.getsitepackages())
    except Exception:
        return {"schemaVersion": SCHEMA, "ok": False, "failure": "site-unavailable"}
    if len(site_dirs) > MAX_SITE:
        truncation["site"] = True
        site_dirs = site_dirs[:MAX_SITE]
    effective = list(base_path)
    seen = set(effective)
    pth = []
    for sitedir in site_dirs:
        if not is_directory(sitedir):
            continue
        absolute = os.path.abspath(sitedir)
        if absolute not in seen:
            effective.append(absolute)
            seen.add(absolute)
        entries = scan_pth(sitedir)
        pth.extend(entries)
        for item in entries:
            for index, line in enumerate(item["pathLines"]):
                missing = item["pathLineMissing"][index] if index < len(item["pathLineMissing"]) else True
                if not missing and line not in seen:
                    effective.append(line)
                    seen.add(line)
    if len(effective) > MAX_PATH:
        truncation["path"] = True
        effective = effective[:MAX_PATH]
    venv_config = os.path.exists(os.path.join(sys.prefix, "pyvenv.cfg")) or os.path.exists(
        os.path.join(sys.prefix, "bin", "pyvenv.cfg"))
    return {
        "schemaVersion": SCHEMA,
        "ok": True,
        "mode": "static",
        "python": python_facts(),
        "venvConfig": venv_config,
        "basePath": [text(entry) for entry in base_path],
        "sitePackages": [text(entry) for entry in site_dirs],
        "effectivePath": [text(entry) for entry in effective],
        "pth": pth,
        "distributions": distributions(site_dirs),
        "resolutions": [candidate_kind(entry) for entry in effective],
        "hooks": [hooks_for(entry) for entry in effective],
        "truncation": truncation,
    }

def runtime_facts():
    path = list(sys.path)
    if len(path) > MAX_PATH:
        truncation["path"] = True
        path = path[:MAX_PATH]
    site_dirs = [entry for entry in path
                 if entry and (entry.endswith("/site-packages") or entry.endswith("/dist-packages"))]
    if len(site_dirs) > MAX_SITE:
        truncation["site"] = True
        site_dirs = site_dirs[:MAX_SITE]
    return {
        "schemaVersion": SCHEMA,
        "ok": True,
        "mode": "runtime",
        "python": python_facts(),
        "path": [text(entry) for entry in path],
        "sitePackages": [text(entry) for entry in site_dirs],
        "resolutions": [candidate_kind(entry) for entry in path],
        "distributions": distributions(site_dirs),
        "startupHooks": {"sitecustomize": "sitecustomize" in sys.modules,
                         "usercustomize": "usercustomize" in sys.modules},
        "truncation": truncation,
    }

try:
    result = static_facts() if sys.flags.no_site else runtime_facts()
except BaseException:
    result = {"schemaVersion": SCHEMA, "ok": False, "failure": "unexpected"}
sys.stdout.write(json.dumps(result, sort_keys=True))
sys.stdout.flush()
`;

export type ScienceFlowRuntimeProbeMode = "static" | "runtime";

export interface ScienceFlowRuntimeProbePython {
  readonly version: string;
  readonly prefix: string;
  readonly basePrefix: string;
  /** Must be true: the static phase has to run with `-S`. */
  readonly noSite: boolean;
  /** Must be true: the Runner always passes `-I`, which implies `-s`. */
  readonly noUserSite: boolean;
  /** Must be true: bytecode writing is disabled from interpreter startup. */
  readonly dontWriteBytecode: boolean;
}

export interface ScienceFlowRuntimeProbePthFile {
  /** Host path of the `.pth` file; used locally for containment, never returned. */
  readonly path: string;
  readonly pathLines: readonly string[];
  readonly pathLineMissing: readonly boolean[];
  readonly importLines: number;
  readonly unreadable: boolean;
  readonly tooLarge: boolean;
  readonly notRegular: boolean;
  readonly unsupportedEncoding: boolean;
  readonly lines: number;
  readonly lineLimitExceeded: boolean;
}

export type ScienceFlowRuntimeProbeEntryKind =
  | "directory"
  | "missing"
  | "file"
  | "link"
  | "other"
  | "relative";

export type ScienceFlowRuntimeProbeScienceFlowKind =
  | "regular"
  | "namespace"
  | "module"
  | "extension"
  | "link";

export interface ScienceFlowRuntimeProbeResolution {
  /** The `sys.path` entry (not the package directory). */
  readonly entry: string;
  readonly kind: ScienceFlowRuntimeProbeEntryKind;
  /** The entry itself is a link; parent links are followed, packages are not. */
  readonly symlinked: boolean;
  /** What `import scienceflow` would find in this entry, if anything. */
  readonly scienceflow: {
    readonly kind: ScienceFlowRuntimeProbeScienceFlowKind;
  } | null;
}

export interface ScienceFlowRuntimeProbeHookScan {
  readonly entry: string;
  readonly sitecustomize: boolean;
  readonly usercustomize: boolean;
}

/** Every bound the program applied; a true flag refuses the whole answer. */
export interface ScienceFlowRuntimeProbeTruncation {
  readonly path: boolean;
  readonly site: boolean;
  readonly pth: boolean;
  readonly lines: boolean;
  readonly names: boolean;
  readonly text: boolean;
  readonly distributions: boolean;
  readonly budget: boolean;
}

export interface ScienceFlowRuntimeProbeStaticFacts {
  readonly mode: "static";
  readonly python: ScienceFlowRuntimeProbePython;
  readonly venvConfig: boolean;
  readonly basePath: readonly string[];
  readonly sitePackages: readonly string[];
  /** The `sys.path` a normal start would have, reconstructed statically. */
  readonly effectivePath: readonly string[];
  readonly pth: readonly ScienceFlowRuntimeProbePthFile[];
  readonly distributions: readonly string[];
  readonly resolutions: readonly ScienceFlowRuntimeProbeResolution[];
  readonly hooks: readonly ScienceFlowRuntimeProbeHookScan[];
  readonly truncation: ScienceFlowRuntimeProbeTruncation;
}

export interface ScienceFlowRuntimeProbeRuntimeFacts {
  readonly mode: "runtime";
  readonly python: ScienceFlowRuntimeProbePython;
  /** The `sys.path` the normal start actually had. */
  readonly path: readonly string[];
  readonly sitePackages: readonly string[];
  readonly resolutions: readonly ScienceFlowRuntimeProbeResolution[];
  readonly distributions: readonly string[];
  readonly startupHooks: {
    readonly sitecustomize: boolean;
    readonly usercustomize: boolean;
  };
  readonly truncation: ScienceFlowRuntimeProbeTruncation;
}

export type ParsedProbeAnswer<Mode extends ScienceFlowRuntimeProbeMode> =
  | {
      readonly status: "ok";
      readonly facts: Mode extends "static"
        ? ScienceFlowRuntimeProbeStaticFacts
        : ScienceFlowRuntimeProbeRuntimeFacts;
    }
  /** The probe itself could not collect facts (its fixed failure answer). */
  | { readonly status: "failed" }
  /** The answer was not the fixed protocol: wrong shape, mode, version, or bounds. */
  | { readonly status: "protocol-error" };

/**
 * Parse one answer for the mode the Runner launched. Nothing in it is trusted
 * beyond the fixed shape; unknown fields are ignored deliberately, because the
 * Runner only reads what it validates and the probe version is pinned by the
 * request it answered.
 */
export function parseScienceFlowRuntimeProbeAnswer(
  raw: string,
  mode: "static",
): ParsedProbeAnswer<"static">;
export function parseScienceFlowRuntimeProbeAnswer(
  raw: string,
  mode: "runtime",
): ParsedProbeAnswer<"runtime">;
export function parseScienceFlowRuntimeProbeAnswer(
  raw: string,
  mode: ScienceFlowRuntimeProbeMode,
): ParsedProbeAnswer<ScienceFlowRuntimeProbeMode> {
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
  if (value.mode !== mode) return { status: "protocol-error" };

  const python = parsePython(value.python);
  if (python === null) return { status: "protocol-error" };
  const truncation = parseTruncation(value.truncation);
  if (truncation === null) return { status: "protocol-error" };
  const sitePackages = stringArray(value.sitePackages, 8);
  if (sitePackages === null) return { status: "protocol-error" };
  const distributions = stringArray(value.distributions, 16);
  if (distributions === null) return { status: "protocol-error" };
  const resolutions = parseResolutions(value.resolutions);
  if (resolutions === null) return { status: "protocol-error" };

  if (mode === "static") {
    if (typeof value.venvConfig !== "boolean") return { status: "protocol-error" };
    const basePath = stringArray(value.basePath, 64);
    if (basePath === null) return { status: "protocol-error" };
    const effectivePath = stringArray(value.effectivePath, 64);
    if (effectivePath === null) return { status: "protocol-error" };
    const pth = parsePth(value.pth);
    if (pth === null) return { status: "protocol-error" };
    const hooks = parseHooks(value.hooks);
    if (hooks === null) return { status: "protocol-error" };
    return {
      status: "ok",
      facts: {
        mode,
        python,
        venvConfig: value.venvConfig,
        basePath,
        sitePackages,
        effectivePath,
        pth,
        distributions,
        resolutions,
        hooks,
        truncation,
      },
    };
  }

  const path = stringArray(value.path, 64);
  if (path === null) return { status: "protocol-error" };
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
      mode,
      python,
      path,
      sitePackages,
      resolutions,
      distributions,
      startupHooks: {
        sitecustomize: hooks.sitecustomize,
        usercustomize: hooks.usercustomize,
      },
      truncation,
    },
  };
}

function parsePython(value: unknown): ScienceFlowRuntimeProbePython | null {
  if (!isRecord(value)) return null;
  const version = value.version;
  const prefix = value.prefix;
  const basePrefix = value.basePrefix;
  if (
    typeof version !== "string" ||
    typeof prefix !== "string" ||
    typeof basePrefix !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !isAbsoluteString(prefix) ||
    !isAbsoluteString(basePrefix) ||
    typeof value.noSite !== "boolean" ||
    typeof value.noUserSite !== "boolean" ||
    typeof value.dontWriteBytecode !== "boolean"
  ) {
    return null;
  }
  return {
    version,
    prefix,
    basePrefix,
    noSite: value.noSite,
    noUserSite: value.noUserSite,
    dontWriteBytecode: value.dontWriteBytecode,
  };
}

function parseTruncation(value: unknown): ScienceFlowRuntimeProbeTruncation | null {
  if (!isRecord(value)) return null;
  const fields = [
    "path",
    "site",
    "pth",
    "lines",
    "names",
    "text",
    "distributions",
    "budget",
  ] as const;
  for (const field of fields) {
    if (typeof value[field] !== "boolean") return null;
  }
  return {
    path: value.path as boolean,
    site: value.site as boolean,
    pth: value.pth as boolean,
    lines: value.lines as boolean,
    names: value.names as boolean,
    text: value.text as boolean,
    distributions: value.distributions as boolean,
    budget: value.budget as boolean,
  };
}

function parsePth(value: unknown): readonly ScienceFlowRuntimeProbePthFile[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const files: ScienceFlowRuntimeProbePthFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const pathLines = stringArray(entry.pathLines, 16);
    const pathLineMissing = booleanArray(entry.pathLineMissing, 16);
    if (pathLines === null || pathLineMissing === null) return null;
    if (pathLines.length !== pathLineMissing.length) return null;
    const numbers = [
      "importLines",
      "lines",
    ] as const;
    for (const field of numbers) {
      const count = entry[field];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 999
      ) {
        return null;
      }
    }
    for (const field of [
      "unreadable",
      "tooLarge",
      "notRegular",
      "unsupportedEncoding",
      "lineLimitExceeded",
    ] as const) {
      if (typeof entry[field] !== "boolean") return null;
    }
    if (typeof entry.path !== "string" || !isAbsoluteString(entry.path)) {
      return null;
    }
    files.push({
      path: entry.path,
      pathLines,
      pathLineMissing,
      importLines: entry.importLines as number,
      unreadable: entry.unreadable as boolean,
      tooLarge: entry.tooLarge as boolean,
      notRegular: entry.notRegular as boolean,
      unsupportedEncoding: entry.unsupportedEncoding as boolean,
      lines: entry.lines as number,
      lineLimitExceeded: entry.lineLimitExceeded as boolean,
    });
  }
  return files;
}

function parseHooks(value: unknown): readonly ScienceFlowRuntimeProbeHookScan[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const hooks: ScienceFlowRuntimeProbeHookScan[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (
      typeof entry.entry !== "string" ||
      !isAbsoluteString(entry.entry) ||
      typeof entry.sitecustomize !== "boolean" ||
      typeof entry.usercustomize !== "boolean"
    ) {
      return null;
    }
    hooks.push({
      entry: entry.entry,
      sitecustomize: entry.sitecustomize,
      usercustomize: entry.usercustomize,
    });
  }
  return hooks;
}

function parseResolutions(value: unknown): readonly ScienceFlowRuntimeProbeResolution[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const resolutions: ScienceFlowRuntimeProbeResolution[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const kind = entry.kind;
    if (
      typeof entry.entry !== "string" ||
      !isAbsoluteString(entry.entry) ||
      typeof entry.symlinked !== "boolean" ||
      !isEntryKind(kind)
    ) {
      return null;
    }
    const scienceflow = entry.scienceflow;
    if (scienceflow === null) {
      resolutions.push({
        entry: entry.entry,
        kind,
        symlinked: entry.symlinked,
        scienceflow: null,
      });
      continue;
    }
    if (!isRecord(scienceflow)) return null;
    const scienceflowKind = scienceflow.kind;
    if (!isScienceFlowKind(scienceflowKind)) return null;
    resolutions.push({
      entry: entry.entry,
      kind,
      symlinked: entry.symlinked,
      scienceflow: { kind: scienceflowKind },
    });
  }
  return resolutions;
}

function isEntryKind(value: unknown): value is ScienceFlowRuntimeProbeEntryKind {
  return (
    value === "directory" ||
    value === "missing" ||
    value === "file" ||
    value === "link" ||
    value === "other" ||
    value === "relative"
  );
}

function isScienceFlowKind(
  value: unknown,
): value is ScienceFlowRuntimeProbeScienceFlowKind {
  return (
    value === "regular" ||
    value === "namespace" ||
    value === "module" ||
    value === "extension" ||
    value === "link"
  );
}

function stringArray(value: unknown, max: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((entry) => typeof entry === "string" && entry.length <= 512)) {
    return null;
  }
  return value as readonly string[];
}

function booleanArray(value: unknown, max: number): readonly boolean[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((entry) => typeof entry === "boolean")) return null;
  return value as readonly boolean[];
}

function isAbsoluteString(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
