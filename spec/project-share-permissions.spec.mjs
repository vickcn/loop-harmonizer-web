import test from "node:test";
import assert from "node:assert/strict";
import { createDriveReaderPermission, deleteDrivePermission, isInheritedPermission, listDrivePermissions } from "../lib/sharing/sharePermissions.ts";

test("restricted and link sharing create reader-only Drive permissions", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init = {}) => {
    if ((init.method ?? "GET") === "POST") { const body = JSON.parse(init.body); bodies.push(body); return Response.json({ id: `p${bodies.length}`, ...body }); }
    return Response.json({ permissions: [{ id: "owner", type: "user", role: "owner" }] });
  };
  const user = await createDriveReaderPermission({ fileId: "folder", accessToken: "token", type: "user", emailAddress: "reader@example.com", fetchImpl });
  const link = await createDriveReaderPermission({ fileId: "folder", accessToken: "token", type: "anyone", fetchImpl });
  assert.equal(user.role, "reader"); assert.equal(user.emailAddress, "reader@example.com");
  assert.equal(link.role, "reader"); assert.equal(link.allowFileDiscovery, false);
  assert.equal(bodies.some((b) => b.role === "writer"), false);
});

test("permission API propagates 403 and detects inherited ACL", async () => {
  await assert.rejects(() => listDrivePermissions({ fileId: "folder", accessToken: "token", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "policy" } }), { status: 403 }) }), /policy|權限|403/);
  assert.equal(isInheritedPermission({ id: "x", type: "user", role: "reader", permissionDetails: [{ inherited: true, inheritedFrom: "parent" }] }), true);
  await deleteDrivePermission({ fileId: "folder", permissionId: "gone", accessToken: "token", fetchImpl: async () => new Response(null, { status: 404 }) });
});
