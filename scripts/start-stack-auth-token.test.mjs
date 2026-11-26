// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const source = readFileSync(new URL("./start-stack.sh", import.meta.url), "utf8");
function shellFunction(name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end + 3);
}

function run({ enabled = true, ready = true, envToken = "" } = {}) {
  const runtimeRoot = resolve(".tmp/r");
  mkdirSync(runtimeRoot, { recursive: true });
  const root = mkdtempSync(join(runtimeRoot, "auth-banner-"));
  const token = randomBytes(32).toString("base64url");
  try {
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets/auth-token"), `${token}\n`, { mode: 0o600 });
    const result = spawnSync("bash", ["-c", `
set -euo pipefail
data_dir="$TEST_DATA_DIR"
runner_url="http://unused.invalid"
mode=local
adapter_python=""
memory_graph_python=""
evolve_python=""
api_foreground=1
pids=()
runner_command=(sleep 10)
api_command=("$TEST_NODE" -e 'console.log("API fixture started"); setTimeout(() => process.exit(0), 300)')
configure_endpoints() { :; }
wait_healthy() {
  if [[ "$1" == "runner" ]]; then return 0; fi
  [[ "$TEST_READY" == "1" ]] || return 1
  printf 'API readiness confirmed\\n'
}
${shellFunction("cleanup")}
${shellFunction("start_stack")}
start_stack
`], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        TEST_DATA_DIR: root,
        TEST_NODE: process.execPath,
        TEST_READY: ready ? "1" : "0",
        SCIENCE_DISCOVERY_PRINT_AUTH_TOKEN: enabled ? "1" : "0",
        SCIENCE_AGENT_AUTH_TOKEN: envToken,
        SCIENCE_AGENT_API_ENTRYPOINT: "",
        SCIENCE_AGENT_EXECUTOR: "native",
      },
    });
    assert.ifError(result.error);
    return { ...result, token };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pilot prints the stored token after API readiness", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf("API readiness confirmed") < result.stdout.indexOf("Login auth token:"));
  assert.ok(result.stdout.includes(`Login auth token:\n${result.token}\n`));
});

test("environment token takes precedence over the stored file", () => {
  const token = randomBytes(32).toString("base64url");
  const result = run({ envToken: `  ${token}  ` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Login auth token:\n${token}\n`));
  assert.ok(!result.stdout.includes(result.token));
});

test("blank environment override falls back to the stored token", () => {
  const result = run({ envToken: " \t " });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Login auth token:\n${result.token}\n`));
});

test("failed readiness prints no success banner or token", () => {
  const result = run({ ready: false });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(!result.stdout.includes("Login auth token:"));
  assert.ok(!result.stdout.includes(result.token));
});

test("ordinary startup keeps its existing foreground behavior", () => {
  const result = run({ enabled: false });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("API fixture started"));
  assert.ok(!result.stdout.includes("Login auth token:"));
  assert.ok(!result.stdout.includes(result.token));
});
