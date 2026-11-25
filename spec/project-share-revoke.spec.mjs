import test from "node:test";
import assert from "node:assert/strict";
import { getProjectShareRecord, revokeProjectShare, saveProjectShareRecord } from "../lib/sharing/shareManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

const share = { key: "s", schemaVersion: 1, shareId: "s", sourceProjectId: "p", ownerAccountId: "owner", visibility: "restricted", status: "published", operationGeneration: 1, sourceProjectRevision: 1, publishedRevisionId: "pub", shareFolderId: "folder", shareManifestFileId: "pointer", recipients: [{ email: "reader@example.com", permissionId: "reader", role: "reader", type: "user", createdAt: "now" }], estimatedBytes: 1, createdAt: "now", updatedAt: "now" };
const pointer = { schemaVersion: 1, application: "loop-harmonizer", kind: "project-share-pointer", shareId: "s", sourceProjectId: "p", ownerAccountId: "owner", visibility: "restricted", lifecycle: "published", publishedRevisionId: "pub", revisionManifestFileId: "manifest", projectName: "P", songCount: 0, updatedAt: "now" };

test("revoke deletes direct readers, verifies ACL, and preserves record history", async () => {
  configureInMemoryIdbForTests();
  let deleted = false;
  let remotePointer = structuredClone(pointer);
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (String(url).includes("alt=media")) return Response.json(remotePointer);
    if (String(url).includes("upload/drive")) { remotePointer = { ...remotePointer, lifecycle: String(init.body).includes('"revoked"') ? "revoked" : "revoking", operationId: String(init.body).match(/"operationId"\s*:\s*"([^"]+)/)?.[1], revocationGeneration: Number(String(init.body).match(/"revocationGeneration"\s*:\s*(\d+)/)?.[1]) }; return Response.json({ id: "pointer", version: "2" }); }
    if (method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (String(url).includes("/files?") || String(url).includes("/drive/v3/files?")) return Response.json({ files: [] });
    return Response.json({ permissions: deleted ? [{ id: "owner", type: "user", role: "owner" }] : [{ id: "owner", type: "user", role: "owner" }, { id: "reader", type: "user", role: "reader", emailAddress: "reader@example.com", permissionDetails: [{ inherited: false }] }] });
  };
  try { await saveProjectShareRecord(share); const result = await revokeProjectShare({ share, accountId: "owner", accessToken: "token", fetchImpl }); assert.equal(result.revoked, true); const saved = await getProjectShareRecord("s"); assert.equal(saved.status, "revoked"); assert.equal(saved.visibility, "private"); }
  finally { resetInMemoryIdbForTests(); }
});

test("inherited permission prevents false revoked claim", async () => {
  configureInMemoryIdbForTests();
  let remotePointer = structuredClone(pointer);
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("alt=media")) return Response.json(remotePointer);
    if (String(url).includes("upload/drive")) { remotePointer = { ...remotePointer, lifecycle: "revoking", operationId: String(init.body).match(/"operationId"\s*:\s*"([^"]+)/)?.[1], revocationGeneration: Number(String(init.body).match(/"revocationGeneration"\s*:\s*(\d+)/)?.[1]) }; return Response.json({ id: "pointer", version: "2" }); }
    if (String(url).includes("/files?") || String(url).includes("/drive/v3/files?")) return Response.json({ files: [] });
    return Response.json({ permissions: [{ id: "owner", type: "user", role: "owner" }, { id: "inherited", type: "domain", role: "reader", permissionDetails: [{ inherited: true, inheritedFrom: "parent" }] }] });
  };
  try { await saveProjectShareRecord(share); const result = await revokeProjectShare({ share, accountId: "owner", accessToken: "token", fetchImpl }); assert.equal(result.revoked, false); assert.equal((await getProjectShareRecord("s")).requiresPermissionRepair, true); }
  finally { resetInMemoryIdbForTests(); }
});
