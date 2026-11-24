import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyProject, createInitialPersistedProjectRecord } from "../lib/projects/projectModel.ts";
import { runProjectSharePreflight } from "../lib/sharing/shareArtifactManager.ts";
import { buildProjectShareUrl, listProjectSharesBySourceProject, saveProjectShareRecord } from "../lib/sharing/shareManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

test("new projects are private until an independent share record is created", async () => {
  configureInMemoryIdbForTests();
  try {
    const project = createEmptyProject({ name: "Private", storageProvider: "google_drive", ownerAccountId: "owner" });
    assert.equal("shareId" in project, false);
    assert.deepEqual(await listProjectSharesBySourceProject(project.projectId), []);
    const record = await saveProjectShareRecord({ key: "s1", schemaVersion: 1, shareId: "s1", sourceProjectId: project.projectId, ownerAccountId: "owner", visibility: "restricted", status: "published", operationGeneration: 1, sourceProjectRevision: 1, publishedRevisionId: "p1", shareManifestFileId: "file1", recipients: [], estimatedBytes: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    assert.match(buildProjectShareUrl(record), /\/share\/s1\?file=file1$/);
    assert.equal((await listProjectSharesBySourceProject(project.projectId)).length, 1);
  } finally { resetInMemoryIdbForTests(); }
});

test("preflight refuses incomplete separation instead of publishing", async () => {
  const project = createEmptyProject({ name: "Incomplete", storageProvider: "google_drive", ownerAccountId: "owner" });
  project.songs.push({ entryId: "e1", sourceAudioHash: "hash", source: { provider: "local" }, displayName: "Song", fileName: "song.wav", durationSec: 10, order: 0, artifactRef: null, settings: { displayName: "Song", fileName: "song.wav", originalBpm: 120, targetBpm: 120, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0, savedRates: [], keyShiftSemitones: 0, masterVolume: 1, muted: false, loop: false, playbackSource: "original", separationMode: null, stemChannels: [] } });
  const result = await runProjectSharePreflight({ record: createInitialPersistedProjectRecord(project), accountId: "owner", accessToken: "token", fetchImpl: async () => new Response("unused", { status: 500 }) });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "separation_incomplete");
});

test("preflight validates actual Drive WAV metadata and header without downloading full stems", async () => {
  const totalSamples = 100;
  const wavSize = 44 + totalSamples * 4;
  const wavHeader = new ArrayBuffer(44);
  const bytes = new Uint8Array(wavHeader);
  const view = new DataView(wavHeader);
  const write = (offset, value) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  write(0, "RIFF"); view.setUint32(4, wavSize - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, 44_100, true); view.setUint32(28, 176_400, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, totalSamples * 4, true);

  const manifest = {
    schemaVersion: 1, application: "loop-harmonizer", songId: "song", songName: "Song", stableSongKey: "stable",
    revisionId: "rev1", ownerAccountId: "owner", source: { provider: "local", fileName: "source.wav", sourceAudioHash: "hash" },
    separation: { mode: "two_stem", modelVersion: "model", processingVersion: "process", sampleRate: 44_100, channelCount: 2, totalSamples, format: "wav-pcm16" },
    artifacts: {
      vocals: { fileId: "vocals", fileName: "vocals.wav", sizeBytes: wavSize, checksum: "sha-v", md5Checksum: "md5-v", mimeType: "audio/wav" },
      instrumental: { fileId: "instrumental", fileName: "instrumental.wav", sizeBytes: wavSize, checksum: "sha-i", md5Checksum: "md5-i", mimeType: "audio/wav" },
    },
    status: "completed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const project = createEmptyProject({ name: "Ready", storageProvider: "google_drive", ownerAccountId: "owner" });
  project.songs.push({
    entryId: "e1", sourceAudioHash: "hash", source: { provider: "local" }, displayName: "Song", fileName: "song.wav", durationSec: 10, order: 0,
    artifactRef: { manifestFileId: "manifest", revisionId: "rev1", sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "model", processingVersion: "process", sampleRate: 44_100, channelCount: 2, totalSamples },
    settings: { displayName: "Song", fileName: "song.wav", originalBpm: 120, targetBpm: 120, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0, savedRates: [], keyShiftSemitones: 0, masterVolume: 1, muted: false, loop: false, playbackSource: "stems", separationMode: "two_stem", stemChannels: [] },
  });
  const ranges = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    if (text.includes("/files/manifest?") && text.includes("alt=media")) return Response.json(manifest);
    const id = text.includes("/files/vocals?") ? "v" : "i";
    if (text.includes("alt=media")) {
      ranges.push(init.headers.Range);
      return new Response(wavHeader, { status: 206 });
    }
    return Response.json({ id, name: `${id}.wav`, mimeType: "audio/wav", size: String(wavSize), md5Checksum: id === "v" ? "md5-v" : "md5-i", capabilities: { canDownload: true, canCopy: true } });
  };
  const result = await runProjectSharePreflight({ record: createInitialPersistedProjectRecord(project), accountId: "owner", accessToken: "token", fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(ranges, ["bytes=0-43", "bytes=0-43"]);
  assert.equal(result.estimatedBytes, wavSize * 2);
});
