// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isPlainRecord } from "./task-record.js";
import { ResearchVersionRepository, ResearchVersionCorruptError, type ResearchVersionIdentity } from "./version-repository.js";
interface Proof extends ResearchVersionIdentity { readonly digest: string }
function repository(database: DatabaseSync) {
  return new ResearchVersionRepository<Proof>(database, { table: "product_proofs", keyColumn: "contract_version_id",
    identity: (value) => value,
    decode(value, identity) {
      if (!isPlainRecord(value) || value.versionId !== identity.versionId || value.projectId !== identity.projectId
        || value.sessionId !== identity.sessionId || value.recordedAt !== identity.recordedAt || typeof value.digest !== "string") throw new ResearchVersionCorruptError();
      return { ...identity, digest: value.digest };
    },
  });
}
test("version evidence stays immutable and scoped across repository reconstruction", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = repository(database);
    const value = { versionId: "contract-version", projectId: "project", sessionId: "session", recordedAt: "time", digest: "digest" };
    store.record(value); store.record(value);
    assert.deepEqual(repository(database).get("project", value.versionId), value);
    assert.equal(store.get("other-project", value.versionId), undefined);
    assert.throws(() => store.record({ ...value, digest: "changed" }), ResearchVersionCorruptError);
    assert.throws(() => store.record({ ...value, projectId: "other-project" }), ResearchVersionCorruptError);
    database.prepare("UPDATE product_proofs SET session_id = 'foreign'").run();
    assert.throws(() => store.get("project", value.versionId), ResearchVersionCorruptError);
    store.deleteSession("foreign");
    assert.equal(store.get("project", value.versionId), undefined);
  } finally { database.close(); }
});
