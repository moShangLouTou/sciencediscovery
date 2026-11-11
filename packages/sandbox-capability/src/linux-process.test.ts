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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureProcessIdentitySync,
  captureSandboxBoundarySync,
  discoverSandboxNamespacesSync,
  normalizeBootId,
  parseProcessStat,
  parseUid,
  readBootIdSync,
  readPidNamespaceSync,
  readProcessStat,
  scanNamespaceMembersSync,
  scanProcessTableSync,
  scanSessionMembers,
  sendSignal,
} from "./linux-process.js";

const BOOT = "5f0c2c62-1d1e-4f18-9a8e-1f2b3c4d5e6f";

interface ProcFixture {
  state?: string;
  parentPid?: number;
  processGroupId?: number;
  sessionId?: number;
  startTimeTicks?: string;
  namespace?: number;
  uid?: number;
  command?: string;
  /** Raw `NSpid` values; one value means "same PID namespace as the reader". */
  nspid?: string;
}

/**
 * Write a fake kernel view for one pid. `/proc` is a parameter in this layer so
 * every rule below is checked against deterministic bytes instead of whatever
 * the test host happens to be running.
 */
async function writeProcess(root: string, pid: number, fixture: ProcFixture = {}): Promise<void> {
  const directory = join(root, String(pid));
  await mkdir(join(directory, "ns"), { recursive: true });
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = fixture.state ?? "S";
  fields[1] = String(fixture.parentPid ?? 1);
  fields[2] = String(fixture.processGroupId ?? pid);
  fields[3] = String(fixture.sessionId ?? pid);
  fields[19] = fixture.startTimeTicks ?? "1000";
  await writeFile(join(directory, "stat"), `${pid} (${fixture.command ?? "proc"}) ${fields.join(" ")}\n`);
  await symlink(`pid:[${fixture.namespace ?? 100}]`, join(directory, "ns", "pid"));
  const uid = fixture.uid ?? 1000;
  await writeFile(join(directory, "status"),
    `Name:\tproc\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nNSpid:\t${fixture.nspid ?? String(pid)}\n`);
  await writeFile(join(directory, "comm"), `${fixture.command ?? "proc"}\n`);
}

/** Make `/proc/[pid]/ns/pid` unreadable the way a user-namespace boundary does. */
async function breakNamespace(root: string, pid: number): Promise<void> {
  await rm(join(root, String(pid), "ns", "pid"));
  await mkdir(join(root, String(pid), "ns", "pid"), { recursive: true });
}

async function procFixture(context: { after(fn: () => unknown): void }, bootId = BOOT): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "linux-process-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sys", "kernel", "random"), { recursive: true });
  await writeFile(join(root, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  return root;
}

test("parseProcessStat uses the last parenthesis and rejects unreadable fields", () => {
  // A command name may contain spaces and parentheses; only the final ')' ends it.
  assert.deepEqual(parseProcessStat("42 (web (x)) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 7700 0"), {
    state: "S", processGroupId: 42, sessionId: 42, startTimeTicks: "7700",
  });
  // Kernel threads legitimately have group/session 0; that is a value, not a defect.
  assert.deepEqual(parseProcessStat("1 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 9 0"), {
    state: "S", processGroupId: 0, sessionId: 0, startTimeTicks: "9",
  });
  assert.equal(parseProcessStat("no parentheses here"), null);
  assert.equal(parseProcessStat("42 (x) S 1 42 42"), null, "truncated stat has no start time");
  assert.equal(parseProcessStat("42 (x) S 1 not-a-number 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"), null);
});

test("parseUid reads the effective uid and reports malformed status as null", () => {
  assert.equal(parseUid("Name:\tproc\nUid:\t1000\t1001\t1000\t1001\n"), 1001);
  assert.equal(parseUid("Name:\tproc\n"), null);
  assert.equal(parseUid("Uid:\t0\tnope\n"), null);
});

test("normalizeBootId accepts only a kernel-shaped id", () => {
  assert.equal(normalizeBootId(` ${BOOT}\n`), BOOT);
  assert.equal(normalizeBootId("not-a-boot-id"), null);
  assert.equal(normalizeBootId(""), null);
});

test("readProcessStat separates proven absence from an unreadable kernel view", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 10, { startTimeTicks: "555" });
  const ok = await readProcessStat(root, 10);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.status === "ok" ? ok.stat : null,
    { state: "S", processGroupId: 10, sessionId: 10, startTimeTicks: "555" });
  assert.equal((await readProcessStat(root, 11)).status, "gone", "ENOENT is a proven absence");
  // A directory where stat should be makes the read fail with something other
  // than ENOENT/ESRCH. That must never be reported as absence.
  await mkdir(join(root, "12", "stat"), { recursive: true });
  assert.equal((await readProcessStat(root, 12)).status, "unobservable");
  assert.equal((await readProcessStat(root, 0)).status, "unobservable");
});

test("readBootIdSync is cached per kernel root and never invents an id", async context => {
  const root = await procFixture(context);
  assert.equal(readBootIdSync(root), BOOT);
  // Once cached, a later broken file must not change the answer within a boot.
  await writeFile(join(root, "sys", "kernel", "random", "boot_id"), "garbage\n");
  assert.equal(readBootIdSync(root), BOOT);
  const missing = await procFixture(context);
  await rm(join(missing, "sys", "kernel", "random", "boot_id"));
  assert.equal(readBootIdSync(missing), null);
});

test("scanSessionMembers counts live members, excludes zombies and reports incompleteness", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 20, { startTimeTicks: "100" });
  await writeProcess(root, 21, { startTimeTicks: "101", processGroupId: 20, sessionId: 20 });
  await writeProcess(root, 22, { startTimeTicks: "102", state: "Z" });
  await writeProcess(root, 23, { startTimeTicks: "103", sessionId: 999 });
  await mkdir(join(root, "24", "stat"), { recursive: true }); // unobservable
  await mkdir(join(root, "25", "ns"), { recursive: true });
  await writeFile(join(root, "25", "stat"), "25 (x) S 1 25 25 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 104 0\n");
  await symlink("pid:[100]", join(root, "25", "ns", "pid"));
  await writeFile(join(root, "25", "status"), "Uid:\t1000\t1000\t1000\t1000\n");

  const scan = await scanSessionMembers(root, 20);
  assert.deepEqual(scan.members.map(member => member.pid), [20, 21], "zombies and other sessions are not members");
  assert.equal(scan.complete, false, "an unreadable pid leaves absence unproven");
  assert.deepEqual((await scanSessionMembers(root, 0)).members, []);
  assert.equal((await scanSessionMembers(root, 0)).complete, false);
});

test("scanProcessTableSync records namespace inodes and flags unreadable ones", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 30, { parentPid: 1, namespace: 200, startTimeTicks: "7" });
  await writeProcess(root, 31, { parentPid: 30, namespace: 201, startTimeTicks: "8" });
  await mkdir(join(root, "32"), { recursive: true });
  await writeFile(join(root, "32", "stat"), "32 (x) S 30 32 32 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 9 0\n");
  // readlink on a directory is not ENOENT, so the namespace is unreadable
  // rather than the process being absent.
  await mkdir(join(root, "32", "ns", "pid"), { recursive: true });
  const scan = scanProcessTableSync(root);
  const byPid = new Map(scan.entries.map(entry => [entry.pid, entry]));
  assert.equal(byPid.get(30)?.parentPid, 1);
  assert.equal(byPid.get(30)?.namespace, "pid:[200]");
  assert.equal(byPid.get(31)?.namespace, "pid:[201]");
  assert.equal(byPid.get(32)?.namespace, null);
  assert.equal(scan.complete, false);

  const missingRoot = join(root, "does-not-exist");
  assert.deepEqual(scanProcessTableSync(missingRoot), { entries: [], complete: false });
});

test("captureProcessIdentitySync requires boot id and the process's own session", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 40, { startTimeTicks: "400", uid: 1001, command: "bwrap" });
  // Session is the parent's: the detached spawn has not taken effect yet, so
  // recording this identity would name a process group the Runner does not own.
  await writeProcess(root, 41, { startTimeTicks: "401", sessionId: 1, processGroupId: 1 });
  await writeProcess(root, 42, { startTimeTicks: "402", state: "Z" });

  const captured = captureProcessIdentitySync(root, 40, { commandName: true });
  assert.deepEqual(captured, {
    processGroupId: 40, sessionId: 40, startTimeTicks: "400", bootId: BOOT, uid: 1001, commandName: "bwrap",
  });
  assert.equal(captureProcessIdentitySync(root, 41, { timeoutMs: 0 }), null);
  assert.equal(captureProcessIdentitySync(root, 42, { timeoutMs: 0 }), null);
  assert.equal(captureProcessIdentitySync(root, 43, { timeoutMs: 0 }), null);

  const noBoot = await procFixture(context);
  await rm(join(noBoot, "sys", "kernel", "random", "boot_id"));
  await writeProcess(noBoot, 44, { startTimeTicks: "404" });
  assert.equal(captureProcessIdentitySync(noBoot, 44, { timeoutMs: 0 }), null,
    "no boot id means no identity that survives a reboot");
});

test("discoverSandboxNamespacesSync excludes the runner's namespace and follows descendants", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 50, { parentPid: 1, namespace: 1, startTimeTicks: "1" }); // runner itself
  await writeProcess(root, 51, { parentPid: 50, namespace: 1, startTimeTicks: "2" }); // outer monitor
  await writeProcess(root, 52, { parentPid: 51, namespace: 2, startTimeTicks: "3" }); // sandbox init
  await writeProcess(root, 53, { parentPid: 52, namespace: 2, startTimeTicks: "4" });
  await writeProcess(root, 54, { parentPid: 52, namespace: 3, startTimeTicks: "5" }); // nested sandbox
  // Reparented before the scan saw the chain, but its session still names the boundary.
  await writeProcess(root, 55, { parentPid: 1, namespace: 4, sessionId: 51, startTimeTicks: "6" });
  await writeProcess(root, 56, { parentPid: 1, namespace: 5, sessionId: 77, startTimeTicks: "7" });

  assert.deepEqual(discoverSandboxNamespacesSync(root, 51, "pid:[1]"), ["pid:[2]", "pid:[3]", "pid:[4]"]);
  assert.deepEqual(readPidNamespaceSync(root, 52), { status: "ok", namespace: "pid:[2]" });
  assert.deepEqual(readPidNamespaceSync(root, 57), { status: "gone" });
});

test("captureSandboxBoundarySync pairs the monitor identity with its namespaces", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 60, { parentPid: 1, namespace: 9, startTimeTicks: "60" });
  await writeProcess(root, 61, { parentPid: 60, namespace: 10, startTimeTicks: "61" });
  const captured = captureSandboxBoundarySync(root, 60, { ownNamespace: "pid:[9]" });
  assert.equal(captured?.identity.startTimeTicks, "60");
  assert.deepEqual(captured?.namespaces, ["pid:[10]"]);

  // No child namespace ever appeared: the caller must see the absence, not a
  // fabricated boundary.
  const bare = await procFixture(context);
  await writeProcess(bare, 62, { parentPid: 1, namespace: 9, startTimeTicks: "62" });
  const empty = captureSandboxBoundarySync(bare, 62, { ownNamespace: "pid:[9]", namespaceTimeoutMs: 0 });
  assert.deepEqual(empty?.namespaces, []);
});

test("scanNamespaceMembersSync is closed under setsid and never confirms a partial scan", async context => {
  const root = await procFixture(context);
  await writeProcess(root, 70, { parentPid: 1, namespace: 20, startTimeTicks: "70" });
  // A setsid() descendant has its own session but the same namespace.
  await writeProcess(root, 71, { parentPid: 1, namespace: 20, sessionId: 71, processGroupId: 71, startTimeTicks: "71" });
  await writeProcess(root, 72, { parentPid: 1, namespace: 21, startTimeTicks: "72" });
  await writeProcess(root, 73, { parentPid: 1, namespace: 20, state: "Z", startTimeTicks: "73" });
  assert.deepEqual(scanNamespaceMembersSync(root, ["pid:[20]"]).members.map(member => member.pid), [70, 71]);
  assert.equal(scanNamespaceMembersSync(root, ["pid:[20]"]).complete, true);
  assert.equal(scanNamespaceMembersSync(root, []).complete, false, "no namespace proves nothing");

  // An unreadable namespace link on any pid makes an empty result unproven.
  // (Two NSpid values: the process may live in a namespace nested below ours.)
  await writeProcess(root, 74, { parentPid: 1, startTimeTicks: "74", nspid: "74 1" });
  await breakNamespace(root, 74);
  const partial = scanNamespaceMembersSync(root, ["pid:[21]"]);
  assert.deepEqual(partial.members.map(member => member.pid), [72]);
  assert.equal(partial.complete, false);
});

test("a scan skips only processes provably outside the boundary owner", async context => {
  const root = await procFixture(context);
  // Another user's process: EACCES on its namespace link is expected on a
  // multi-user host, and it can never be a member of a boundary we own.
  await writeProcess(root, 80, { parentPid: 1, uid: 0 });
  await breakNamespace(root, 80);
  // Same user, but a single NSpid value proves it shares our own PID namespace.
  await writeProcess(root, 81, { parentPid: 1, uid: 1000 });
  await breakNamespace(root, 81);
  assert.deepEqual(scanNamespaceMembersSync(root, ["pid:[50]"], { uid: 1000 }), { members: [], complete: true });

  // Same user, possibly nested below us, namespace unreadable: absence of a
  // member is not proven, so the scan must stay incomplete.
  await writeProcess(root, 82, { parentPid: 1, uid: 1000, nspid: "82 1" });
  await breakNamespace(root, 82);
  assert.equal(scanNamespaceMembersSync(root, ["pid:[50]"], { uid: 1000 }).complete, false);
  // Without an owner, nothing may be excluded.
  assert.equal(scanNamespaceMembersSync(root, ["pid:[50]"]).complete, false);
});

test("sendSignal distinguishes an absent process from a refused signal", () => {
  // A pid far beyond the kernel's pid_max: ESRCH, i.e. proven absent.
  assert.equal(sendSignal(2_147_483_646, "SIGTERM"), "gone");
});
