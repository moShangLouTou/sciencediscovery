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

import type { SessionRunEvent, SubagentStep } from "../src/api/types.js";
import { followSubagent } from "../src/app/follow-subagent.js";
import { StubClient } from "./api-stub.js";

/** One record of a child's own stream. */
const record = (id: string, sequence: number, over: Partial<SubagentStep> = {}): SessionRunEvent => ({
  createdAt: "2026-10-23T00:00:00Z",
  event: {
    step: { content: "", createdAt: "2026-10-23T00:00:00Z", id, kind: "tool", ...over },
    subagentId: "child-1",
    type: "subagent.step",
  },
  runId: "run-1",
  sequence,
  sessionId: "session-1",
});

/** Let the timer the follower schedules run a few times. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** The URL the client was asked for on its `index`th read. */
function requested(client: StubClient, index: number): URL {
  const call = client.calls[index];
  assert.ok(call !== undefined, `read ${index} must have been made`);
  return new URL(call.path, "http://test.invalid");
}

function follow(client: StubClient, seen: string[][]) {
  return followSubagent({
    client: client.asClient(),
    intervalMs: 1,
    onSteps: (steps) => seen.push(steps.map((step) => step.id)),
    runId: "run-1",
    sessionId: "session-1",
    subagentId: "child-1",
  });
}

test("a running child's steps are followed from its own stream", async () => {
  // The child's record starts empty and fills while it works. Both reads go to
  // the child's own stream, and the second asks only for what the first did
  // not carry.
  const client = new StubClient();
  client.reply([record("s1", 1, { status: "running" })]);
  client.reply([record("s2", 2)]);
  const seen: string[][] = [];
  const stop = follow(client, seen);
  await settle();
  stop();
  assert.deepEqual(seen[0], ["s1"]);
  assert.deepEqual(seen.at(-1), ["s1", "s2"]);
  const first = requested(client, 0);
  assert.equal(first.pathname, "/api/sessions/session-1/runs/run-1/streams/subagent-child-1/events");
  assert.equal(first.searchParams.get("after"), "0");
  assert.equal(requested(client, 1).searchParams.get("after"), "1");
});

test("following stops when the panel closes", async () => {
  const client = new StubClient();
  const seen: string[][] = [];
  const stop = follow(client, seen);
  await settle();
  stop();
  const reads = client.calls.length;
  await settle();
  assert.equal(client.calls.length, reads);
});

test("a read that failed does not end the following", async () => {
  // A single failed read says nothing about the child, and dropping the record
  // on its account would leave the reader with an empty panel and no reason.
  const client = new StubClient();
  client.fail(new Error("temporarily unavailable"));
  client.reply([record("s1", 3)]);
  const seen: string[][] = [];
  const stop = follow(client, seen);
  await settle();
  stop();
  assert.deepEqual(seen.at(-1), ["s1"]);
  assert.equal(requested(client, 1).searchParams.get("after"), "0");
});
