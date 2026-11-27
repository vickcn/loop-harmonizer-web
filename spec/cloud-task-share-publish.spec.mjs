import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("share task persists fixed snapshot and ACL intent and reuses the existing publisher", async () => {
  const dialog = await readFile(new URL("../components/band/ProjectShareDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /registerExecutor\("share_publish"/);
  assert.match(dialog, /publishProjectShare/);
  assert.match(dialog, /snapshotRevision/);
  assert.match(dialog, /recipientEmails/);
  assert.match(dialog, /requestedShareId/);
  assert.match(dialog, /status === "revoked"/);
});
