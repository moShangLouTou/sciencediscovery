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

import type { ApiClient } from "../api/client.js";
import { readSubagentSteps } from "../api/stream.js";
import type { SubagentStep } from "../api/types.js";
import { mergeSubagentSteps } from "../run-stream/subagent.js";

/** How often an open, running child's own stream is read while it works.
 *
 * Fast enough that the record reads as live, slow enough that one open record
 * costs one small read: a step is written when it starts and again when it
 * ends, so a second of work lands in one read of a few hundred bytes. */
export const SUBAGENT_FOLLOW_MS = 1500;

export interface FollowSubagentOptions {
  client: ApiClient;
  /** How often to ask. Tests pass a shorter one. */
  intervalMs?: number;
  /** Called with everything folded in so far, each time something new lands. */
  onSteps: (steps: SubagentStep[]) => void;
  /** The run the child was delegated from. */
  runId: string;
  sessionId: string;
  subagentId: string;
}

/**
 * Follow a running child's steps until the returned function is called.
 *
 * 执行详情 had two ways to fill and both miss a child that is still working:
 * the live `subagent.step` events on the run stream only reach a window that
 * was attached when they were broadcast, and the catalog is a projection the
 * panel reads once, again only when the child settles. The child's own stream
 * has every step from the start, so it is read on a timer — from the cursor
 * the previous read returned, so each read carries only what is new.
 */
export function followSubagent(options: FollowSubagentOptions): () => void {
  const { client, intervalMs = SUBAGENT_FOLLOW_MS, onSteps, runId, sessionId, subagentId } = options;
  let stopped = false;
  let cursor = 0;
  let held: SubagentStep[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const page = await readSubagentSteps(client, sessionId, runId, subagentId, cursor);
      if (stopped) return;
      cursor = page.cursor;
      if (page.steps.length > 0) {
        held = mergeSubagentSteps(held, page.steps);
        onSteps(held);
      }
    } catch {
      // A read that failed says nothing about the child: the next tick asks
      // again, and the record still names the task and shows its status.
    }
    if (!stopped) timer = setTimeout(() => void read(), intervalMs);
  };
  void read();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
