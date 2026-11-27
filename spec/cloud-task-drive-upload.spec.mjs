import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCloudTaskResources } from "../lib/cloudTasks/cloudTaskResourceGuard.ts";
import { readFile } from "node:fs/promises";

test("heavy WAV work waits for Demucs while lightweight project JSON sync remains allowed", () => {
  assert.equal(evaluateCloudTaskResources({ kind: "stem_export" }, { heavyAudioTaskRunning: true, anotherHeavyTransferRunning: false }).allowed, false);
  assert.equal(evaluateCloudTaskResources({ kind: "project_sync" }, { heavyAudioTaskRunning: true, anotherHeavyTransferRunning: true, storageRemainingBytes: 1 }).allowed, true);
});

test("low storage blocks heavy export", () => {
  const result = evaluateCloudTaskResources({ kind: "stem_export" }, { heavyAudioTaskRunning: false, anotherHeavyTransferRunning: false, storageRemainingBytes: 10 * 1024 * 1024 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /儲存空間/);
});

test("confirmed multi-song share artifact completion enqueues durable tasks instead of directly running uploads", async () => {
  const source = await readFile(new URL("../components/band/BandMixer.tsx", import.meta.url), "utf8");
  const batch = source.slice(source.indexOf("onCompleteShareArtifacts={async"), source.indexOf("onClose={() => setProjectShareOpen(false)"));
  assert.match(batch, /createDriveExportTask/);
  assert.match(batch, /waitForTerminal/);
  assert.doesNotMatch(batch, /await startDriveExport/);
});
