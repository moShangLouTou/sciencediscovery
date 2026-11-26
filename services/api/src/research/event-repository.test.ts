// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ResearchEventRepository, ResearchEventCorruptError, type ResearchEventCodec } from "./event-repository.js";
interface Event { id: string; sessionId: string; seconds: number | null; }
const codec: ResearchEventCodec<Event> = {
  decode(value) {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
      || !("sessionId" in value) || typeof value.sessionId !== "string" || !("seconds" in value)
      || (value.seconds !== null && typeof value.seconds !== "number")) throw new ResearchEventCorruptError();
    return { id: value.id, sessionId: value.sessionId, seconds: value.seconds };
  },
  identity: (value) => ({ eventId: value.id, sessionId: value.sessionId, projectId: "project",
    ownerRunId: "run", inputVersionId: null, finishedAt: "2026-01-01T00:00:00Z" }),
};
test("preparation usage survives repository reopening and cannot be overwritten", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const repo = new ResearchEventRepository(db, { table: "usage_events", codec });
    const event = { id: "event", sessionId: "session", seconds: null };
    repo.record(event); repo.record(event);
    const reopened = new ResearchEventRepository(db, { table: "usage_events", codec });
    assert.deepEqual(reopened.listForSession("project", "session"), [event]);
    assert.throws(() => reopened.record({ ...event, seconds: 0 }), ResearchEventCorruptError);
    assert.throws(() => reopened.record({ ...event, sessionId: "another" }), ResearchEventCorruptError);
    db.prepare("UPDATE usage_events SET run_id = 'wrong'").run();
    assert.throws(() => reopened.listForSession("project", "session"), ResearchEventCorruptError);
    repo.deleteSession("session");
    assert.deepEqual(repo.listForSession("project", "session"), []);
  } finally { db.close(); }
});
