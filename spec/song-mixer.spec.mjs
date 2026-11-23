import assert from "node:assert/strict";
import test from "node:test";

import {
  createBandSong,
  getEffectivePlaybackRate,
  getSongLoopRange,
  getSongPlaybackTrackIds,
  getStemAudibility,
  normalizeSongLoopRange,
  reorderSongList,
  serializeSongSettings,
} from "../lib/band/songModel.ts";
import {
  SEPARATION_PROCESSING_VERSION,
  createSeparationCacheKey,
} from "../lib/storage/cacheKeys.ts";
import {
  createStemCacheRecord,
  restoreStemSet,
} from "../lib/storage/separationCacheRecord.ts";

test("songs keep independent BPM, Key and playback rates", () => {
  const songA = createBandSong({
    id: "song_a",
    name: "A",
    sourceAudioId: "source_a",
    originalBpm: 120,
  });
  const songB = createBandSong({
    id: "song_b",
    name: "B",
    sourceAudioId: "source_b",
    originalBpm: 95,
  });

  songA.targetBpm = 132;
  songA.keyShiftSemitones = 2;
  songB.targetBpm = 90;
  songB.keyShiftSemitones = -3;

  assert.equal(getEffectivePlaybackRate(songA), 1.1);
  assert.ok(Math.abs(getEffectivePlaybackRate(songB) - 90 / 95) < 0.000001);
  assert.equal(songA.keyShiftSemitones, 2);
  assert.equal(songB.keyShiftSemitones, -3);
});

test("manual rate overrides target BPM while fine tuning remains additive", () => {
  const song = createBandSong({
    id: "song_a",
    name: "A",
    sourceAudioId: "source_a",
    originalBpm: 120,
  });
  song.targetBpm = 180;
  song.tempoMode = "manual-rate";
  song.manualRate = 0.8;
  song.fineRateOffset = 0.025;

  assert.ok(Math.abs(getEffectivePlaybackRate(song) - 0.825) < 0.000001);
});

test("A/B loop range is clamped to the real duration and leaves invalid ranges as full-song loop", () => {
  const song = createBandSong({
    id: "loop-range",
    name: "Loop range",
    sourceAudioId: "loop-range-original",
    originalBpm: 120,
    durationSec: 120,
  });

  Object.assign(song, normalizeSongLoopRange(song, 18.25, 42.75));
  assert.deepEqual(getSongLoopRange(song), { startSec: 18.25, endSec: 42.75 });

  Object.assign(song, normalizeSongLoopRange(song, 118, 200));
  assert.deepEqual(getSongLoopRange(song), { startSec: 118, endSec: 120 });

  Object.assign(song, normalizeSongLoopRange(song, 80, 80.1));
  assert.equal(getSongLoopRange(song), null);
  assert.equal(song.loopEndSec, null);
});

test("song playback selects either original audio or stems, never both", () => {
  const song = createBandSong({
    id: "song_a",
    name: "A",
    sourceAudioId: "source_a",
    originalBpm: 120,
  });
  song.stemIds = ["vocals", "drums", "bass", "other"];

  song.playbackSource = "original";
  assert.deepEqual(getSongPlaybackTrackIds(song), ["source_a"]);
  song.playbackSource = "stems";
  assert.deepEqual(getSongPlaybackTrackIds(song), ["vocals", "drums", "bass", "other"]);
});

test("solo makes non-solo stems inaudible without changing their mute setting", () => {
  const channels = [
    { id: "vocals", muted: false, solo: true },
    { id: "drums", muted: false, solo: false },
    { id: "bass", muted: true, solo: false },
  ];

  assert.deepEqual(getStemAudibility(channels), {
    vocals: true,
    drums: false,
    bass: false,
  });
  assert.equal(channels[1].muted, false);
});

test("separation cache key invalidates on model, mode or processing version changes", () => {
  const base = createSeparationCacheKey({
    sourceAudioHash: "sha256-a",
    modelVersion: "htdemucs-1",
    separationMode: "four_stem",
    processingVersion: SEPARATION_PROCESSING_VERSION,
  });

  assert.notEqual(base, createSeparationCacheKey({
    sourceAudioHash: "sha256-a",
    modelVersion: "htdemucs-2",
    separationMode: "four_stem",
    processingVersion: SEPARATION_PROCESSING_VERSION,
  }));
  assert.notEqual(base, createSeparationCacheKey({
    sourceAudioHash: "sha256-a",
    modelVersion: "htdemucs-1",
    separationMode: "two_stem",
    processingVersion: SEPARATION_PROCESSING_VERSION,
  }));
});

test("persisted song settings contain JSON controls but no source audio", () => {
  const song = createBandSong({
    id: "song_a",
    name: "A",
    sourceAudioId: "source_a",
    originalBpm: 120,
  });
  song.targetBpm = 132;
  song.keyShiftSemitones = 2;
  song.masterVolume = 0.85;
  song.stemChannels = [
    { id: "vocals", songId: song.id, stemType: "vocals", volume: 0.9, muted: false, solo: false },
  ];

  assert.deepEqual(serializeSongSettings(song), {
    songId: "song_a",
    targetBpm: 132,
    keyShiftSemitones: 2,
    masterVolume: 0.85,
    tempoMode: "target-bpm",
    manualRate: 1,
    fineRateOffset: 0,
    savedRates: [1],
    loop: false,
    loopStartSec: 0,
    loopEndSec: null,
    separationMode: null,
    stemVolumes: { vocals: 0.9 },
    stemMuted: { vocals: false },
    stemSolo: { vocals: false },
  });
});

test("separation cache record round-trips PCM without sharing mutable arrays", () => {
  const stems = {
    mode: "two_stem",
    sampleRate: 44100,
    tracks: [
      {
        stemType: "vocals",
        left: new Float32Array([0.1, 0.2]),
        right: new Float32Array([0.3, 0.4]),
      },
    ],
  };
  const record = createStemCacheRecord({
    key: "hash:model:two_stem:v1",
    sourceAudioHash: "hash",
    modelVersion: "model",
    stems,
    createdAt: 123,
  });
  const restored = restoreStemSet(record);

  assert.equal(record.sizeBytes, 16);
  assert.ok(Math.abs(restored.tracks[0].left[0] - 0.1) < 0.000001);
  assert.ok(Math.abs(restored.tracks[0].left[1] - 0.2) < 0.000001);
  assert.notEqual(restored.tracks[0].left.buffer, stems.tracks[0].left.buffer);
});

test("reorderSongList moves targeted song to expected position safely", () => {
  const songs = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];
  // 從第 0 位移動到第 2 位
  assert.deepEqual(
    reorderSongList(songs, "s1", "s3").map((s) => s.id),
    ["s2", "s3", "s1", "s4"],
  );
  // 從第 3 位移動到第 1 位
  assert.deepEqual(
    reorderSongList(songs, "s4", "s2").map((s) => s.id),
    ["s1", "s4", "s2", "s3"],
  );
  // 相同 ID 不變
  assert.deepEqual(reorderSongList(songs, "s2", "s2"), songs);
  // 不存在的 ID 不變
  assert.deepEqual(reorderSongList(songs, "not_exist", "s2"), songs);
});
