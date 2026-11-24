import test from "node:test";
import assert from "node:assert/strict";
import { canGarbageCollectShareFolder, saveProjectShareRecord } from "../lib/sharing/shareManager.ts";
import { checkShareFolderGcSafety } from "../lib/projects/projectResourceReferences.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

const base = { key: "s", schemaVersion: 1, shareId: "s", sourceProjectId: "p", ownerAccountId: "owner", visibility: "link", status: "published", operationGeneration: 1, sourceProjectRevision: 1, publishedRevisionId: "pub", recipients: [], estimatedBytes: 1, createdAt: "now", updatedAt: "now" };

test("published or unconfirmed share artifacts are protected from GC", () => {
  assert.equal(canGarbageCollectShareFolder(base, { explicitUserConfirmation: true }).allowed, false);
  assert.equal(canGarbageCollectShareFolder({ ...base, status: "revoked", visibility: "private" }).allowed, false);
  assert.equal(canGarbageCollectShareFolder({ ...base, status: "revoked", visibility: "private" }, { explicitUserConfirmation: true, referencedByOtherShare: true }).allowed, false);
  assert.equal(canGarbageCollectShareFolder({ ...base, status: "revoked", visibility: "private" }, { explicitUserConfirmation: true }).allowed, true);
});

test("GC lookup fails closed when share record is absent or still published", async () => {
  configureInMemoryIdbForTests();
  try { assert.equal((await checkShareFolderGcSafety({ shareId: "missing", explicitUserConfirmation: true })).safeToDelete, false); await saveProjectShareRecord(base); assert.equal((await checkShareFolderGcSafety({ shareId: "s", explicitUserConfirmation: true })).safeToDelete, false); }
  finally { resetInMemoryIdbForTests(); }
});
