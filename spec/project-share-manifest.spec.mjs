import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyProject } from "../lib/projects/projectModel.ts";
import { buildProjectShareManifest, buildProjectSharePointer, validateProjectShareManifest, validateProjectSharePointer } from "../lib/sharing/shareManifest.ts";

function fixture() {
  const project = createEmptyProject({ name: "Shared", storageProvider: "google_drive", ownerAccountId: "owner" });
  const entry = { entryId: "e1", sourceAudioHash: "hash", source: { provider: "google_drive", fileId: "PRIVATE_ORIGINAL", authorizedAccountId: "owner", fileName: "song.wav", mimeType: "audio/wav" }, originalBackup: { driveFileId: "PRIVATE_ORIGINAL", ownerAccountId: "owner", fileName: "song.wav", mimeType: "audio/wav", sizeBytes: 100, sourceAudioHash: "hash", backedUpAt: "now" }, displayName: "Song", fileName: "song.wav", durationSec: 10, order: 0, artifactRef: { manifestFileId: "shared-song-manifest", revisionId: "r1", sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "m", processingVersion: "p", sampleRate: 44100, channelCount: 2, totalSamples: 441000 }, settings: { displayName: "Song", fileName: "song.wav", originalBpm: 100, targetBpm: 110, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0.01, savedRates: [1], keyShiftSemitones: 2, masterVolume: .8, muted: false, loop: true, loopStartSec: 1, loopEndSec: 8, playbackSource: "stems", separationMode: "two_stem", stemChannels: [{ stemType: "vocals", volume: .7, muted: false, solo: true }] } };
  project.songs = [entry];
  const songs = [{ entry, manifestFileId: "shared-song-manifest", artifactRevision: "r1", artifacts: [{ role: "vocals", fileId: "v", fileName: "vocals.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "abc" }, { role: "instrumental", fileId: "i", fileName: "instrumental.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "def" }] }];
  return { project, songs };
}

test("share manifest strips private Drive source while preserving mix settings", () => {
  const { project, songs } = fixture();
  const manifest = buildProjectShareManifest({ shareId: "s", sourceProject: project, ownerAccountId: "owner", publishedRevisionId: "p1", songs });
  assert.equal(manifest.project.songs[0].source.provider, "local");
  assert.equal(manifest.project.songs[0].originalBackup, null);
  assert.equal(JSON.stringify(manifest).includes("PRIVATE_ORIGINAL"), false);
  assert.equal(manifest.project.songs[0].settings.keyShiftSemitones, 2);
  assert.equal(validateProjectShareManifest(manifest).shareId, "s");
  const pointer = buildProjectSharePointer({ manifest, revisionManifestFileId: "manifest-file", visibility: "link" });
  assert.equal(validateProjectSharePointer(pointer).revisionManifestFileId, "manifest-file");
});

test("manifest rejects missing checksum and revision mismatch", () => {
  const { project, songs } = fixture();
  const manifest = buildProjectShareManifest({ shareId: "s", sourceProject: project, ownerAccountId: "owner", publishedRevisionId: "p1", songs });
  manifest.songs[0].artifacts[0].checksum = "";
  assert.throws(() => validateProjectShareManifest(manifest), /無效/);
  manifest.songs[0].artifacts[0].checksum = "abc";
  assert.throws(() => validateProjectShareManifest(manifest, { publishedRevisionId: "p2" }), /不一致/);
});
