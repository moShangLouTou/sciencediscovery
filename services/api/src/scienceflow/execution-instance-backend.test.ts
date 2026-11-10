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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64"],
});
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ExecutionInstanceBackend,
  parseProcessStat,
  type ExecutionLaunchSpec,
} from "./execution-instance-backend.js";
import {
  EXECUTION_INSTANCE_SCHEMA_VERSION,
  ExecutionInstanceStore,
  launchSpecDigest,
  type ExecutionInstanceProcess,
  type ExecutionInstanceRecord,
} from "./execution-instance-store.js";

const TMP_PARENT =
  process.env.SCIENCE_FLOW_ROUND9_TMP ?? resolve(process.cwd(), ".tmp");
const SETSID = ["/usr/bin/setsid", "/bin/setsid"].find((path) => existsSync(path));

interface Scratch {
  readonly root: string;
  readonly stateRoot: string;
  readonly backends: ExecutionInstanceBackend[];
  readonly bystanders: ChildProcess[];
  script(name: string, body: string): Promise<string>;
  spec(executable: string, overrides?: Partial<ExecutionLaunchSpec>): ExecutionLaunchSpec;
  cleanup(): Promise<void>;
}

async function scratch(prefix: string): Promise<Scratch> {
  await mkdir(TMP_PARENT, { recursive: true });
  const root = await mkdtemp(join(TMP_PARENT, `${prefix}-`));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const backends: ExecutionInstanceBackend[] = [];
  const bystanders: ChildProcess[] = [];
  const pidfile = join(root, "pids");
  await writeFile(pidfile, "", "utf8");
  return {
    root,
    stateRoot,
    backends,
    bystanders,
    async script(name, body) {
      const path = join(root, name);
      await writeFile(path, body, "utf8");
      await chmod(path, 0o755);
      return path;
    },
    spec(executable, overrides = {}) {
      return {
        executionId: `exec-${randomUUID()}`,
        attemptId: `attempt-${randomUUID()}`,
        owner: "owner-round9",
        requestId: `request-${randomUUID()}`,
        executable,
        arguments: [],
        cwd: root,
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PIDFILE: pidfile,
        },
        ...overrides,
      };
    },
    async cleanup() {
      for (const backend of backends) backend.dispose();
      for (const child of bystanders) {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      // Every synthetic process recorded its own pid; nothing is left behind.
      const text = await readFile(pidfile, "utf8").catch(() => "");
      for (const value of text.split(/\s+/)) {
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function backend(
  context: Scratch,
  options: { termGraceMs?: number; killGraceMs?: number } = {},
): ExecutionInstanceBackend {
  const created = new ExecutionInstanceBackend({
    stateRoot: context.stateRoot,
    termGraceMs: options.termGraceMs ?? 400,
    killGraceMs: options.killGraceMs ?? 400,
    pollIntervalMs: 25,
  });
  context.backends.push(created);
  return created;
}

async function waitFor<T>(
  action: () => Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await action();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("condition was not met in time");
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function identityOf(pid: number): Promise<ExecutionInstanceProcess> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").then(parseProcessStat);
  const bootId = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  assert.ok(stat, "the process must exist");
  return {
    pid,
    processGroupId: stat.processGroupId,
    sessionId: stat.sessionId,
    startTimeTicks: stat.startTimeTicks,
    bootId,
    uid: process.getuid?.() ?? 0,
    commandName: "synthetic",
  };
}

/** A record that a rebuilt backend would find after losing the launcher. */
function record(
  overrides: Partial<ExecutionInstanceRecord> & {
    executionId: string;
  },
): ExecutionInstanceRecord {
  const { executionId, ...rest } = overrides;
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: EXECUTION_INSTANCE_SCHEMA_VERSION,
    executionId,
    attemptId: "attempt-record",
    owner: "owner-round9",
    createdAt,
    updatedAt: createdAt,
    launch: {
      requestId: "request-record",
      specDigest: launchSpecDigest({ synthetic: true }),
      deadlineAt: null,
    },
    state: "running",
    process: null,
    stop: {
      requestId: null,
      requestedAt: null,
      requestedBy: null,
      termSignalSentAt: null,
      killSignalSentAt: null,
    },
    exit: null,
    logs: { stdout: "stdout.log", stderr: "stderr.log", truncated: false },
    unknownReason: null,
    ...rest,
  };
}

test("start records kernel identity and reports a running instance", async (t) => {
  const context = await scratch("round9-start");
  t.after(() => context.cleanup());
  const hello = await context.script(
    "hello.sh",
    '#!/bin/sh\necho "started" >> "$PIDFILE"\nsleep 30\n',
  );
  const result = await backend(context).start(context.spec(hello));
  assert.equal(result.status, "started");
  if (result.status !== "started") return;
  assert.equal(result.instance.state, "running");
  assert.equal(result.instance.outcome, "running");
  assert.ok(result.instance.processId && result.instance.processId > 1);
  assert.equal(result.instance.exit, null);
  const observation = await backend(context).observe(result.instance.executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.identity, "verified");
  assert.equal(observation.processAlive, true);
  assert.equal(observation.groupAlive, true);
  assert.ok(observation.members >= 1);
});

test("start is idempotent for the same request and specification", async (t) => {
  const context = await scratch("round9-idempotent");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const specification = context.spec(hold);
  const first = await client.start(specification);
  assert.equal(first.status, "started");
  const second = await client.start(specification);
  assert.equal(second.status, "existing");
  if (first.status !== "started" || second.status !== "existing") return;
  assert.equal(second.instance.processId, first.instance.processId);
  const observation = await client.observe(specification.executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  // One launched shell plus the sleep it is running, all in one session.
  assert.ok(observation.members >= 1);
});

test("start refuses a different specification under the same request", async (t) => {
  const context = await scratch("round9-conflict");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const specification = context.spec(hold);
  const first = await client.start(specification);
  assert.equal(first.status, "started");
  const conflicting = await client.start({
    ...specification,
    arguments: ["--different"],
  });
  assert.deepEqual(conflicting, { status: "conflict", reason: "request" });
  const otherAttempt = await client.start({
    ...specification,
    attemptId: "attempt-other",
  });
  assert.deepEqual(otherAttempt, { status: "conflict", reason: "attempt" });
});

test("observe reports a normal exit without inventing a code", async (t) => {
  const context = await scratch("round9-exit-zero");
  t.after(() => context.cleanup());
  // A brief lifetime keeps the kernel identity capturable: a process that ends
  // before it can be identified is reported as unknown on purpose.
  const quick = await context.script("quick.sh", "#!/bin/sh\nsleep 0.2\nexit 0\n");
  const client = backend(context);
  const started = await client.start(context.spec(quick));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const observation = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    return value.status === "observed" && value.instance.state === "exited"
      ? value
      : undefined;
  });
  assert.equal(observation.instance.outcome, "completed");
  assert.equal(observation.instance.exit?.code, 0);
  assert.equal(observation.instance.exit?.signal, null);
  const confirmation = await client.confirmExit(started.instance.executionId);
  assert.equal(confirmation.confirmed, true);
});

test("observe reports a non-zero exit as failed", async (t) => {
  const context = await scratch("round9-exit-seven");
  t.after(() => context.cleanup());
  const failing = await context.script("failing.sh", "#!/bin/sh\nsleep 0.2\nexit 7\n");
  const client = backend(context);
  const started = await client.start(context.spec(failing));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const observation = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    return value.status === "observed" && value.instance.state === "exited"
      ? value
      : undefined;
  });
  assert.equal(observation.instance.outcome, "failed");
  assert.equal(observation.instance.exit?.code, 7);
});

test("an exit the launcher saw is never reported as lost", async (t) => {
  const context = await scratch("round9-exit-vs-observe");
  t.after(() => context.cleanup());
  // The exit event and a poll can interleave: the poll must not settle the
  // record as lost while the launcher still owes an exit report.
  const quick = await context.script("quick-exit.sh", "#!/bin/sh\nsleep 0.05\nexit 0\n");
  const client = backend(context);
  const started = await client.start(context.spec(quick));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const observation = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    if (value.status !== "observed") return undefined;
    return value.instance.state === "exited" || value.instance.state === "lost"
      ? value
      : undefined;
  });
  assert.equal(observation.instance.state, "exited");
  assert.equal(observation.instance.exit?.code, 0);
  assert.equal(observation.instance.outcome, "completed");
});

test("retained output is capped and the truncation is durable", async (t) => {
  const context = await scratch("round9-output");
  t.after(() => context.cleanup());
  const noisy = await context.script(
    "noisy.sh",
    '#!/bin/sh\ni=0\nwhile [ "$i" -lt 400 ]; do printf "0123456789"; i=$((i+1)); done\nexit 0\n',
  );
  const client = backend(context);
  const started = await client.start(
    context.spec(noisy, { maxOutputBytes: 100 }),
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const observation = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    return value.status === "observed" && value.instance.state === "exited"
      ? value
      : undefined;
  });
  assert.equal(observation.instance.logTruncated, true);
  const log = await readFile(
    join(context.stateRoot, started.instance.executionId, "stdout.log"),
    "utf8",
  );
  assert.equal(log.length, 100);
});

test("a deadline stops the instance while the launcher lives", async (t) => {
  const context = await scratch("round9-deadline");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const started = await client.start(
    context.spec(hold, { deadlineMs: 200 }),
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const observation = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    return value.status === "observed" && value.instance.state === "stopped"
      ? value
      : undefined;
  });
  assert.equal(observation.instance.stopRequestedBy, "deadline");
  assert.equal(observation.instance.outcome, "stopped");
  assert.equal(observation.processAlive, false);
});

test("stop escalates from TERM to KILL and confirms the process is gone", async (t) => {
  const context = await scratch("round9-escalate");
  t.after(() => context.cleanup());
  const stubborn = await context.script(
    "stubborn.sh",
    '#!/bin/sh\necho "$$" >> "$PIDFILE"\ntrap \'\' TERM\nwhile :; do sleep 0.2; done\n',
  );
  const client = backend(context);
  const started = await client.start(context.spec(stubborn));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const result = await client.requestStop(started.instance.executionId, {
    requestId: "stop-1",
    owner: "owner-round9",
    termGraceMs: 200,
    killGraceMs: 1_000,
  });
  assert.equal(result.status, "stopped");
  if (result.status !== "stopped") return;
  assert.equal(result.instance.state, "stopped");
  assert.equal(result.instance.outcome, "stopped");
  assert.ok(result.instance.stopRequestedAt);
  const confirmation = await client.confirmExit(started.instance.executionId);
  assert.equal(confirmation.confirmed, true);
});

test("a repeated stop request is idempotent", async (t) => {
  const context = await scratch("round9-repeat-stop");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const started = await client.start(context.spec(hold));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const first = await client.requestStop(started.instance.executionId, {
    requestId: "stop-1",
    owner: "owner-round9",
  });
  assert.equal(first.status, "stopped");
  const second = await client.requestStop(started.instance.executionId, {
    requestId: "stop-2",
    owner: "owner-round9",
  });
  assert.equal(second.status, "already-terminal");
  const observation = await client.observe(started.instance.executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.instance.state, "stopped");
});

test("stop is refused for a non-owner and the process keeps running", async (t) => {
  const context = await scratch("round9-owner");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const started = await client.start(context.spec(hold));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const refused = await client.requestStop(started.instance.executionId, {
    requestId: "stop-intruder",
    owner: "owner-elsewhere",
  });
  assert.deepEqual(refused, { status: "refused", reason: "owner-mismatch" });
  const observation = await client.observe(started.instance.executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.processAlive, true);
  assert.equal(observation.instance.stopRequestedAt, null);
});

test("a surviving descendant keeps the instance alive and is then stopped", async (t) => {
  const context = await scratch("round9-descendant");
  t.after(() => context.cleanup());
  const leavesChild = await context.script(
    "leaves-child.sh",
    '#!/bin/sh\nsh -c \'trap "" TERM; while :; do sleep 0.2; done\' &\necho "$!" >> "$PIDFILE"\nsleep 0.3\nexit 0\n',
  );
  const client = backend(context);
  const started = await client.start(context.spec(leavesChild));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const leaderGone = await waitFor(async () => {
    const value = await client.observe(started.instance.executionId);
    if (value.status !== "observed") return undefined;
    return value.processAlive === false && value.groupAlive === true
      ? value
      : undefined;
  });
  assert.equal(leaderGone.instance.state, "running");
  const result = await client.requestStop(started.instance.executionId, {
    requestId: "stop-descendant",
    owner: "owner-round9",
    termGraceMs: 200,
    killGraceMs: 1_000,
  });
  assert.equal(result.status, "stopped");
  const after = await client.observe(started.instance.executionId);
  assert.equal(after.status, "observed");
  if (after.status !== "observed") return;
  assert.equal(after.groupAlive, false);
});

test("a setsid-escaped descendant is reported as out of reach", async (t) => {
  const context = await scratch("round9-escape");
  t.after(() => context.cleanup());
  if (!SETSID) {
    t.skip("setsid is not available on this host");
    return;
  }
  const escapes = await context.script(
    "escape.sh",
    `#!/bin/sh\n${SETSID} sh -c 'trap "" TERM; exec sleep 60' &\necho "$!" >> "$PIDFILE"\nwhile :; do sleep 0.2; done\n`,
  );
  const client = backend(context);
  const capabilities = client.capabilities();
  assert.equal(capabilities.cancellation.escapedDescendant, "unsupported");
  assert.equal(capabilities.cancellation.guaranteesCompleteDescendantStop, false);
  const started = await client.start(context.spec(escapes));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const escapedPid = await waitFor(async () => {
    const text = await readFile(join(context.root, "pids"), "utf8");
    const value = Number(text.trim().split(/\s+/).at(-1));
    return Number.isSafeInteger(value) && value > 1 ? value : undefined;
  });
  const result = await client.requestStop(started.instance.executionId, {
    requestId: "stop-escape",
    owner: "owner-round9",
    termGraceMs: 300,
    killGraceMs: 1_000,
  });
  // The session is empty, so the backend reports a completed stop...
  assert.equal(result.status, "stopped");
  // ...but the escaped process is still alive: this is the documented limit.
  assert.equal(isAlive(escapedPid), true);
  process.kill(escapedPid, "SIGKILL");
});

test("stop refuses a rebuilt identity that points at another process", async (t) => {
  const context = await scratch("round9-forged");
  t.after(() => context.cleanup());
  const bystander = spawn(
    "/bin/sh",
    ["-c", "trap '' TERM; while :; do sleep 0.2; done"],
    { detached: true, stdio: "ignore" },
  );
  context.bystanders.push(bystander);
  const pid = bystander.pid;
  assert.ok(pid && pid > 1);
  if (pid === undefined) return;
  const identity = await identityOf(pid);
  const store = new ExecutionInstanceStore(context.stateRoot);
  const executionId = `exec-${randomUUID()}`;
  await store.createDirectory(executionId);
  await store.write(
    record({
      executionId,
      process: {
        ...identity,
        // A recorded start time that no longer matches this PID.
        startTimeTicks: `${Number(identity.startTimeTicks) + 1}`,
      },
    }),
  );
  const client = backend(context);
  const refused = await client.requestStop(executionId, {
    requestId: "stop-forged",
    owner: "owner-round9",
  });
  assert.deepEqual(refused, { status: "refused", reason: "identity-mismatch" });
  assert.equal(isAlive(pid), true);
  const observation = await client.observe(executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.identity, "mismatched");
  assert.equal(observation.instance.stopRequestedAt, null);
});

test("stop and observe refuse a corrupt record without signaling", async (t) => {
  const context = await scratch("round9-corrupt");
  t.after(() => context.cleanup());
  const executionId = "exec-corrupt";
  await mkdir(join(context.stateRoot, executionId), { mode: 0o700 });
  await writeFile(
    join(context.stateRoot, executionId, "instance.json"),
    "{not json",
    "utf8",
  );
  const client = backend(context);
  const observation = await client.observe(executionId);
  assert.deepEqual(observation, {
    status: "record-invalid",
    reason: "not-json",
  });
  const refused = await client.requestStop(executionId, {
    requestId: "stop-corrupt",
    owner: "owner-round9",
  });
  assert.deepEqual(refused, { status: "refused", reason: "record-invalid" });
  const missing = await client.requestStop("exec-never-existed", {
    requestId: "stop-missing",
    owner: "owner-round9",
  });
  assert.deepEqual(missing, { status: "refused", reason: "not-found" });
});

test("an unknown record version is reported, not repaired", async (t) => {
  const context = await scratch("round9-version");
  t.after(() => context.cleanup());
  const executionId = "exec-future";
  await mkdir(join(context.stateRoot, executionId), { mode: 0o700 });
  const payload = {
    ...record({ executionId }),
    schemaVersion: EXECUTION_INSTANCE_SCHEMA_VERSION + 1,
  };
  await writeFile(
    join(context.stateRoot, executionId, "instance.json"),
    JSON.stringify(payload),
    "utf8",
  );
  const client = backend(context);
  const observation = await client.observe(executionId);
  assert.deepEqual(observation, {
    status: "record-invalid",
    reason: "schema-version",
  });
  const unchanged = await readFile(
    join(context.stateRoot, executionId, "instance.json"),
    "utf8",
  );
  assert.equal(unchanged, JSON.stringify(payload));
});

test("a rebuilt backend observes and stops the same instance", async (t) => {
  const context = await scratch("round9-rebuild");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const first = backend(context);
  const started = await first.start(context.spec(hold));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  // Client rebuild: a new backend object over the same durable state, with no
  // access to the ChildProcess the launcher held.
  first.dispose();
  const second = backend(context);
  const observation = await second.observe(started.instance.executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.instance.state, "running");
  assert.equal(observation.processAlive, true);
  const result = await second.requestStop(started.instance.executionId, {
    requestId: "stop-rebuilt",
    owner: "owner-round9",
  });
  assert.equal(result.status, "stopped");
  const confirmation = await second.confirmExit(started.instance.executionId);
  assert.equal(confirmation.confirmed, true);
});

test("a lost instance reports no exit code and is never resumed", async (t) => {
  const context = await scratch("round9-lost");
  t.after(() => context.cleanup());
  const executionId = `exec-${randomUUID()}`;
  const store = new ExecutionInstanceStore(context.stateRoot);
  await store.createDirectory(executionId);
  await store.write(
    record({
      executionId,
      // A process and session that never existed on this boot.
      process: {
        pid: 4_000_000,
        processGroupId: 4_000_000,
        sessionId: 4_000_000,
        startTimeTicks: "1",
        bootId: (
          await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        ).trim(),
        uid: process.getuid?.() ?? 0,
        commandName: "gone",
      },
    }),
  );
  const client = backend(context);
  const observation = await client.observe(executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.instance.state, "lost");
  assert.equal(observation.instance.outcome, "lost");
  assert.equal(observation.instance.exit, null);
  assert.equal(observation.groupAlive, false);
  const confirmation = await client.confirmExit(executionId);
  assert.equal(confirmation.confirmed, true);
  const repeated = await client.observe(executionId);
  assert.equal(repeated.status, "observed");
  if (repeated.status !== "observed") return;
  assert.equal(repeated.instance.state, "lost");
});

test("a recorded deadline is not enforced by a rebuilt backend", async (t) => {
  const context = await scratch("round9-no-scheduler");
  t.after(() => context.cleanup());
  const bystander = spawn("/bin/sh", ["-c", "sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  context.bystanders.push(bystander);
  const pid = bystander.pid;
  assert.ok(pid && pid > 1);
  if (pid === undefined) return;
  const identity = await identityOf(pid);
  const executionId = `exec-${randomUUID()}`;
  const store = new ExecutionInstanceStore(context.stateRoot);
  await store.createDirectory(executionId);
  await store.write(
    record({
      executionId,
      process: identity,
      launch: {
        requestId: "request-record",
        specDigest: launchSpecDigest({ synthetic: true }),
        deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      },
    }),
  );
  const client = backend(context);
  const observation = await client.observe(executionId);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  // The deadline has passed, but nobody is entitled to enforce it here: the
  // instance keeps running and no signal was sent.
  assert.equal(observation.instance.overdue, true);
  assert.equal(observation.instance.state, "running");
  assert.equal(isAlive(pid), true);
  assert.equal(observation.instance.stopRequestedAt, null);
});

test("the snapshot carries no host paths, environment, or command line", async (t) => {
  const context = await scratch("round9-snapshot");
  t.after(() => context.cleanup());
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const client = backend(context);
  const started = await client.start(context.spec(hold));
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const serialized = JSON.stringify(started.instance);
  assert.equal(serialized.includes(context.root), false);
  assert.equal(serialized.includes("hold.sh"), false);
  assert.equal(serialized.includes("PIDFILE"), false);
  assert.equal(serialized.includes("PATH"), false);
});

test("start rejects untrusted or malformed launch specifications", async (t) => {
  const context = await scratch("round9-validate");
  t.after(() => context.cleanup());
  const client = backend(context);
  const hold = await context.script("hold.sh", "#!/bin/sh\nsleep 30\n");
  const base = context.spec(hold);
  await assert.rejects(
    async () => client.start({ ...base, executable: "relative/path" }),
    TypeError,
  );
  await assert.rejects(
    async () => client.start({ ...base, executable: "/bin/sh\0evil" }),
    TypeError,
  );
  await assert.rejects(
    async () =>
      client.start({
        ...base,
        environment: { "BAD-NAME": "value" },
      }),
    TypeError,
  );
  await assert.rejects(
    async () => client.start({ ...base, executionId: "../escape" }),
    TypeError,
  );
  await assert.rejects(
    async () => client.start({ ...base, deadlineMs: 0 }),
    TypeError,
  );
  const missing = await client.start({
    ...base,
    executable: join(context.root, "does-not-exist.sh"),
  });
  assert.deepEqual(missing, { status: "failed", reason: "launch" });
});
