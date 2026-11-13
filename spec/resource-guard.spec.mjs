import assert from "node:assert/strict";
import test from "node:test";

import {
  assessResourceRisk,
  formatDeviceCapabilitiesSummary,
  formatEstimatedMiB,
  PerformanceTelemetryTracker,
} from "../lib/band/resourceGuard.ts";
import { restoreBandSongFromRecord, serializePersistedSong, createBandSong } from "../lib/band/songModel.ts";

function makeCap(overrides = {}) {
  return {
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    storageUsageBytes: 100 * 1024 * 1024,
    storageQuotaBytes: 2048 * 1024 * 1024,
    storageRemainingBytes: 1948 * 1024 * 1024,
    storagePersisted: true,
    jsHeapUsedBytes: 80 * 1024 * 1024,
    jsHeapLimitBytes: 2048 * 1024 * 1024,
    jsHeapEstimatedAvailableBytes: 1968 * 1024 * 1024,
    supportsWebGpu: true,
    supportsWorker: true,
    collectedAt: 1700000000000,
    ...overrides,
  };
}

test("capabilities summary reports '無法取得' for missing browser metrics and labels estimates honestly", () => {
  const missingCap = makeCap({
    deviceMemoryGb: null,
    hardwareConcurrency: null,
    storageUsageBytes: null,
    storageQuotaBytes: null,
    storageRemainingBytes: null,
    storagePersisted: null,
    jsHeapUsedBytes: null,
    jsHeapLimitBytes: null,
    jsHeapEstimatedAvailableBytes: null,
  });

  const summary = formatDeviceCapabilitiesSummary(missingCap);
  assert.equal(summary.deviceMemoryLabel, "無法取得");
  assert.equal(summary.cpuCoresLabel, "無法取得");
  assert.ok(summary.jsHeapLabel.includes("無法取得"));
  assert.equal(summary.storageLabel, "無法取得");
  assert.equal(formatEstimatedMiB(null), "無法取得");
  assert.ok(formatEstimatedMiB(50 * 1024 * 1024).includes("估計"));
});

test("assesses low/high/critical risk accurately without UA heuristics and stays honest about 2-stem memory", () => {
  const lowResult = assessResourceRisk({
    operation: "separate",
    songName: "Short Loop",
    durationSec: 60,
    fileSizeBytes: 2 * 1024 * 1024,
    separationMode: "four_stem",
    capabilities: makeCap({ supportsWebGpu: true }),
  });
  assert.equal(lowResult.riskLevel, "low");
  assert.equal(lowResult.requiresConfirmation, false);
  assert.ok(lowResult.honestModeNote?.includes("不會降低模型推論"));

  const highOrCriticalResult = assessResourceRisk({
    operation: "separate",
    songName: "Long 8-min Concert",
    durationSec: 500,
    fileSizeBytes: 85 * 1024 * 1024,
    separationMode: "two_stem",
    playingSongCount: 1,
    activeSoundTouchTracks: 4,
    hasOtherIdleDecodedSongs: true,
    capabilities: makeCap({
      deviceMemoryGb: 2,
      hardwareConcurrency: 4,
      supportsWebGpu: false,
      jsHeapEstimatedAvailableBytes: 220 * 1024 * 1024,
    }),
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 5,
      maxLongTaskDurationMs: 380,
      lastSeparationDurationMs: 145000,
      lastDecodeDurationMs: 3200,
    },
  });

  assert.equal(highOrCriticalResult.riskLevel, "critical");
  assert.equal(highOrCriticalResult.requiresConfirmation, true);
  assert.equal(highOrCriticalResult.blockedByDefault, true);
  assert.ok(highOrCriticalResult.lowLoadSuggestions.some((s) => s.id === "pause-other-songs"));
  assert.ok(highOrCriticalResult.lowLoadSuggestions.some((s) => s.id === "release-idle-buffers"));
  assert.ok(highOrCriticalResult.lowLoadSuggestions.some((s) => s.id === "limit-inference-threads"));
  assert.ok(highOrCriticalResult.honestModeNote?.includes("2 Stem"));
});

test("storage quota exhaustion escalates risk level before write fails", () => {
  const tightStorage = assessResourceRisk({
    operation: "separate",
    durationSec: 360,
    separationMode: "four_stem",
    capabilities: makeCap({
      storageQuotaBytes: 500 * 1024 * 1024,
      storageUsageBytes: 420 * 1024 * 1024,
      storageRemainingBytes: 80 * 1024 * 1024,
      supportsWebGpu: false,
    }),
  });
  assert.ok(tightStorage.riskLevel === "high" || tightStorage.riskLevel === "critical");
  assert.equal(tightStorage.requiresConfirmation, true);
  assert.ok(tightStorage.reasons.some((r) => r.includes("剩餘儲存空間") || r.includes("超出剩餘儲存空間")));
});

test("lazy-decode restore preserves song metadata and unloaded flag without auto-playing", () => {
  const song = createBandSong({
    id: "song_lazy",
    name: "DeferredTrack",
    sourceAudioId: "song_lazy_original",
    originalBpm: 98,
    durationSec: 320,
    sourceAudioHash: "sha256-lazy",
  });
  song.playbackSource = "stems";
  song.targetBpm = 104;
  song.keyShiftSemitones = -1;

  const record = serializePersistedSong(song, {
    audioKey: "sha256-lazy",
    sourceAudioHash: "sha256-lazy",
    modelVersion: "browser-demucs-v1",
    processingVersion: "loop-harmonizer-stems-v2",
    revision: 3,
    updatedAt: 1700000000,
    updatedByTabId: "tab_a",
  });

  const restoredLazy = restoreBandSongFromRecord(record, {
    audioLoadState: "unloaded",
    persistenceStatus: "saved",
    persistenceMessage: "待按需解碼",
  });

  assert.equal(restoredLazy.audioLoadState, "unloaded");
  assert.equal(restoredLazy.status, "stopped");
  assert.equal(restoredLazy.playbackSource, "original");
  assert.equal(restoredLazy.targetBpm, 104);
  assert.equal(restoredLazy.keyShiftSemitones, -1);
});

test("telemetry tracker safely records timing durations when PerformanceObserver is unavailable", () => {
  const tracker = new PerformanceTelemetryTracker();
  tracker.recordDecodeDuration(420);
  tracker.recordSeparationDuration(18500);
  const signals = tracker.getSignals();
  assert.equal(signals.lastDecodeDurationMs, 420);
  assert.equal(signals.lastSeparationDurationMs, 18500);
  assert.equal(signals.longTaskCount, 0);
});
