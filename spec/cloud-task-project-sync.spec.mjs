import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("project sync is created only by the explicit toolbar action and pins the saved revision", async () => {
  const source = await readFile(new URL("../components/band/BandMixer.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const handleSyncProjectToDrive"), source.indexOf("const handlePromoteToDrive"));
  assert.match(handler, /saveProjectLocallyNow/);
  assert.match(handler, /kind: "project_sync"/);
  assert.match(handler, /snapshotRevision: saved\.record\.project\.revisionToken/);
  assert.match(source, /ProjectManualSyncCoordinator/);
});
