import assert from "node:assert/strict";
import test from "node:test";

import {
  createBandSong,
  detectSongRevisionConflict,
  findUnreferencedAudioKeys,
  findUnusedSeparationRecordKeys,
  isStorageQuotaLow,
  restoreBandSongFromRecord,
  serializePersistedSong,
  sortPersistedSongsByOrder,
} from "../lib/band/songModel.ts";

test("serializePersistedSong and restoreBandSongFromRecord round-trip settings without auto-playing or auto-running Demucs", () => {
  const song = createBandSong({
    id: "song_p1",
    name: "PraiseSong",
    fileName: "PraiseSong.mp3",
    sourceAudioId: "song_p1_original",
    settingsKey: "PraiseSong.mp3:1048576:1700000000",
    originalBpm: 120,
    durationSec: 210,
    sourceAudioHash: "sha256-praise",
    fileSizeBytes: 1048576,
    mimeType: "audio/mpeg",
    fileLastModified: 1700000000,
  });

  song.targetBpm = 132;
  song.keyShiftSemitones = -2;
  song.tempoMode = "manual-rate";
  song.manualRate = 1.15;
  song.fineRateOffset = -0.02;
  song.savedRates = [1, 1.15, 1.25];
  song.masterVolume = 0.72;
  song.muted = true;
  song.loop = true;
  song.status = "playing";
  song.playheadSec = 65.4;
  song.playbackSource = "stems";
  song.separationMode = "four_stem";
  song.cacheKey = "sha256-praise:browser-demucs-v1:four_stem:loop-harmonizer-stems-v2";
  song.stemChannels = [
    { id: "song_p1_stem_vocals", songId: "song_p1", stemType: "vocals", volume: 0.9, muted: false, solo: true },
    { id: "song_p1_stem_drums", songId: "song_p1", stemType: "drums", volume: 0.65, muted: true, solo: false },
  ];

  const record = serializePersistedSong(song, {
    audioKey: "sha256-praise",
    sourceAudioHash: "sha256-praise",
    modelVersion: "browser-demucs-v1",
    processingVersion: "loop-harmonizer-stems-v2",
    revision: 4,
    updatedAt: 1700000123,
    updatedByTabId: "tab-a",
  });

  assert.equal(record.fileName, "PraiseSong.mp3");
  assert.equal(record.mimeType, "audio/mpeg");
  assert.equal(record.sizeBytes, 1048576);
  assert.equal(record.lastModified, 1700000000);
  assert.equal(record.modelVersion, "browser-demucs-v1");
  assert.equal(record.processingVersion, "loop-harmonizer-stems-v2");
  assert.equal(record.revision, 4);

  const restored = restoreBandSongFromRecord(record, { durationSec: 210 });
  assert.equal(restored.targetBpm, 132);
  assert.equal(restored.keyShiftSemitones, -2);
  assert.equal(restored.tempoMode, "manual-rate");
  assert.equal(restored.manualRate, 1.15);
  assert.equal(restored.fineRateOffset, -0.02);
  assert.deepEqual(restored.savedRates, [1, 1.15, 1.25]);
  assert.equal(restored.masterVolume, 0.72);
  assert.equal(restored.muted, true);
  assert.equal(restored.loop, true);
  assert.equal(restored.playheadSec, 65.4);
  assert.equal(restored.separationMode, "four_stem");
  assert.equal(restored.cacheKey, record.cacheKey);
  assert.equal(restored.stemChannels.length, 2);
  assert.equal(restored.stemChannels[0].solo, true);
  assert.equal(restored.stemChannels[1].muted, true);
  // 恢復時絕不自動播放或自動執行 Demucs
  assert.equal(restored.status, "paused");
  assert.equal(restored.separationStatus, "not_started");
});

test("sortPersistedSongsByOrder restores saved multi-song order and keeps trailing records", () => {
  const mkRecord = (songId, updatedAt) => serializePersistedSong(
    createBandSong({
      id: songId,
      name: songId,
      sourceAudioId: `${songId}_orig`,
      originalBpm: 120,
    }),
    {
      audioKey: `hash_${songId}`,
      sourceAudioHash: `hash_${songId}`,
      modelVersion: "v1",
      processingVersion: "v2",
      revision: 1,
      updatedAt,
      updatedByTabId: "tab-a",
    },
  );

  const sorted = sortPersistedSongsByOrder(
    [mkRecord("s1", 10), mkRecord("s2", 20), mkRecord("s3", 30)],
    ["s3", "s1"],
  );
  assert.deepEqual(sorted.map((item) => item.songId), ["s3", "s1", "s2"]);
});

test("reference-count cleanup never deletes shared audio or in-use separation caches", () => {
  const remainingSongs = [
    {
      audioKey: "hash-shared",
      sourceAudioHash: "hash-shared",
      cacheKey: "hash-shared:browser-demucs-v1:four_stem:loop-harmonizer-stems-v2",
    },
  ];

  // hash-shared 仍被另一首歌引用，僅 hash-orphan 可刪除
  assert.deepEqual(
    findUnreferencedAudioKeys(["hash-shared", "hash-orphan"], remainingSongs),
    ["hash-orphan"],
  );

  const separationRecords = [
    { key: "hash-shared:browser-demucs-v1:four_stem:loop-harmonizer-stems-v2", sourceAudioHash: "hash-shared" },
    { key: "hash-shared:old-model:four_stem:v1", sourceAudioHash: "hash-shared" },
    { key: "hash-unused:browser-demucs-v1:four_stem:loop-harmonizer-stems-v2", sourceAudioHash: "hash-unused" },
  ];

  assert.deepEqual(
    findUnusedSeparationRecordKeys(separationRecords, remainingSongs),
    ["hash-unused:browser-demucs-v1:four_stem:loop-harmonizer-stems-v2"],
  );
});

test("detectSongRevisionConflict prevents silent cross-tab overwrites while permitting same-tab and forced saves", () => {
  assert.equal(
    detectSongRevisionConflict({
      existingRevision: 3,
      existingUpdatedByTabId: "tab-b",
      expectedRevision: 2,
      currentTabId: "tab-a",
    }),
    true,
  );

  assert.equal(
    detectSongRevisionConflict({
      existingRevision: 3,
      existingUpdatedByTabId: "tab-a",
      expectedRevision: 2,
      currentTabId: "tab-a",
    }),
    false,
  );

  assert.equal(
    detectSongRevisionConflict({
      existingRevision: 3,
      existingUpdatedByTabId: "tab-b",
      expectedRevision: 2,
      currentTabId: "tab-a",
      force: true,
    }),
    false,
  );
});

test("isStorageQuotaLow flags near-full storage or low remaining headroom", () => {
  const gb = 1024 * 1024 * 1024;
  assert.equal(isStorageQuotaLow(null, null), false);
  assert.equal(isStorageQuotaLow(0.2 * gb, 1 * gb), false);
  assert.equal(isStorageQuotaLow(0.86 * gb, 1 * gb), true);
  assert.equal(isStorageQuotaLow(0.96 * gb, 1 * gb), true);
  assert.equal(isStorageQuotaLow(180 * 1024 * 1024, 200 * 1024 * 1024), true);
});
