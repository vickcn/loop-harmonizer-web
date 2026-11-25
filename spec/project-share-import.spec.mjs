import test from "node:test";
import assert from "node:assert/strict";
import { createImportedProjectFromShare, importSharedProjectMetadata } from "../lib/sharing/shareImportManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

const settings = { displayName: "Song", fileName: "song.wav", originalBpm: 100, targetBpm: 125, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0, savedRates: [], keyShiftSemitones: -2, masterVolume: .5, muted: false, loop: true, loopStartSec: 2, loopEndSec: 10, playbackSource: "stems", separationMode: "two_stem", stemChannels: [{ stemType: "vocals", volume: .4, muted: true, solo: false }] };
const artifactRef = { revisionId: "a1", sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "m", processingVersion: "p", sampleRate: 44100, channelCount: 2, totalSamples: 882000 };
const entry = { entryId: "old-entry", sourceAudioHash: "hash", source: { provider: "local" }, displayName: "Song", fileName: "song.wav", durationSec: 20, order: 0, artifactRef, settings };
const manifest = {
  schemaVersion: 1, application: "loop-harmonizer", kind: "project-share-revision", shareId: "s", sourceProjectId: "source", ownerAccountId: "owner", publishedRevisionId: "pub1", sourceProjectRevision: 3, includeOriginalAudio: false, createdAt: "now",
  project: { schemaVersion: 1, application: "loop-harmonizer", projectId: "source", name: "Source", storageProvider: "local", revision: 3, revisionToken: "r3", createdAt: "now", updatedAt: "now", masterSettings: {}, songs: [entry] },
  songs: [{ entry, manifestFileId: "song-manifest", artifactRevision: "a1", artifacts: [
    { role: "vocals", fileId: "v", fileName: "v.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "vsum" },
    { role: "instrumental", fileId: "i", fileName: "i.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "isum" },
  ] }],
};

test("import creates independent IDs and preserves controls without Demucs checkpoint", () => {
  const imported = createImportedProjectFromShare({ manifest, recipientAccountId: "recipient", projectId: "new-project", nowIso: "later" });
  assert.equal(imported.projectId, "new-project"); assert.notEqual(imported.songs[0].entryId, "old-entry");
  assert.equal(imported.songs[0].settings.targetBpm, 125); assert.equal(imported.songs[0].settings.keyShiftSemitones, -2);
  assert.equal(imported.songs[0].artifactRef.manifestFileId, "song-manifest"); assert.equal(imported.songs[0].artifactRef.localTaskId, null);
  assert.equal(imported.importedFromShare.dependsOnSourceDrive, true);
});

test("metadata-only import validates untrusted JSON before persisting a local project", async () => {
  configureInMemoryIdbForTests();
  try {
    const record = await importSharedProjectMetadata({ manifest, recipientAccountId: "recipient" });
    assert.equal(record.storageProvider, "local"); assert.equal(record.project.importedFromShare.shareId, "s");
    const invalid = structuredClone(manifest); invalid.project.songs[0].settings.masterVolume = 9;
    await assert.rejects(() => importSharedProjectMetadata({ manifest: invalid, recipientAccountId: "recipient" }), /音量|無效/);
  } finally { resetInMemoryIdbForTests(); }
});
