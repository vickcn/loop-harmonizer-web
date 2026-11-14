import assert from "node:assert/strict";
import test from "node:test";

import {
  assessResourceRisk,
  estimateSeparationStagePeaks,
  evaluateTaskAdmission,
  formatDeviceCapabilitiesSummary,
  formatEstimatedMiB,
  PerformanceTelemetryTracker,
  ResourceProfileStateManager,
  selectDeviceResourceProfile,
  shouldEnterSeparationFocusMode,
} from "../lib/band/resourceGuard.ts";
import {
  createBandSong,
  createSeparationFocusSessionSnapshot,
  restoreBandSongFromRecord,
  restoreSongsAfterSeparationFocus,
  serializePersistedSong,
} from "../lib/band/songModel.ts";

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
  tracker.recordAudioUnderrun();
  const signals = tracker.getSignals();
  assert.equal(signals.lastDecodeDurationMs, 420);
  assert.equal(signals.lastSeparationDurationMs, 18500);
  assert.equal(signals.longTaskCount, 0);
  assert.equal(signals.audioUnderrunCount, 1);
  tracker.resetStressCountersAfterCleanup();
  assert.equal(tracker.getSignals().audioUnderrunCount, 0);
});

test("selects constrained, balanced, and performance profiles across low-end Android, laptop, and desktop", () => {
  const lowEndAndroid = selectDeviceResourceProfile({
    capabilities: makeCap({
      deviceMemoryGb: 3,
      hardwareConcurrency: 4,
      crossOriginIsolated: true,
      formFactorHint: "mobile",
    }),
  });
  assert.equal(lowEndAndroid.tier, "constrained");
  assert.equal(lowEndAndroid.demucsConcurrency, 1);
  assert.equal(lowEndAndroid.allowMainThreadLargeInference, false);
  assert.ok(lowEndAndroid.maxWasmThreads <= 2);

  const avgLaptop = selectDeviceResourceProfile({
    capabilities: makeCap({
      deviceMemoryGb: 8,
      hardwareConcurrency: 6,
      crossOriginIsolated: true,
      formFactorHint: "desktop",
    }),
  });
  assert.equal(avgLaptop.tier, "balanced");
  assert.equal(avgLaptop.demucsConcurrency, 1);

  const highEndDesktop = selectDeviceResourceProfile({
    capabilities: makeCap({
      deviceMemoryGb: 16,
      hardwareConcurrency: 12,
      crossOriginIsolated: true,
      formFactorHint: "desktop",
    }),
  });
  assert.equal(highEndDesktop.tier, "performance");
  assert.equal(highEndDesktop.demucsConcurrency, 1);
  assert.ok(highEndDesktop.maxWasmThreads > lowEndAndroid.maxWasmThreads);
  assert.ok(highEndDesktop.workingMemoryBudgetBytes > avgLaptop.workingMemoryBudgetBytes);
});

test("missing hardware metrics force conservative constrained tier and non-isolated WASM clamps threads to 1", () => {
  const unknownDesktop = selectDeviceResourceProfile({
    capabilities: makeCap({
      deviceMemoryGb: null,
      hardwareConcurrency: null,
      crossOriginIsolated: true,
      formFactorHint: "desktop",
    }),
  });
  assert.equal(unknownDesktop.tier, "constrained");
  assert.equal(unknownDesktop.hardwareInfoIncomplete, true);

  const nonIsolatedDesktop = selectDeviceResourceProfile({
    capabilities: makeCap({
      deviceMemoryGb: 16,
      hardwareConcurrency: 12,
      crossOriginIsolated: false,
      formFactorHint: "desktop",
    }),
  });
  assert.equal(nonIsolatedDesktop.tier, "performance");
  assert.equal(nonIsolatedDesktop.maxWasmThreads, 1);
});

test("enforces worker availability, global Demucs concurrency = 1, memory budget, and SoundTouch pressure", () => {
  const perfCap = makeCap({
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    crossOriginIsolated: true,
    formFactorHint: "desktop",
  });
  const desktopProfile = selectDeviceResourceProfile({ capabilities: perfCap });

  const noWorker = evaluateTaskAdmission({
    operation: "separate",
    profile: desktopProfile,
    capabilities: makeCap({ supportsWorker: false }),
    estimatedTaskMemoryBytes: 120 * 1024 * 1024,
  });
  assert.equal(noWorker.allowed, false);
  assert.equal(noWorker.hardRejected, true);
  assert.equal(noWorker.rejectionReason, "worker-unavailable");

  const secondDemucs = evaluateTaskAdmission({
    operation: "separate",
    profile: desktopProfile,
    capabilities: perfCap,
    estimatedTaskMemoryBytes: 120 * 1024 * 1024,
    runningDemucsCount: 1,
  });
  assert.equal(secondDemucs.allowed, false);
  assert.equal(secondDemucs.hardRejected, true);
  assert.equal(secondDemucs.rejectionReason, "demucs-concurrency-limit");

  const overMemDesktop = evaluateTaskAdmission({
    operation: "separate",
    profile: desktopProfile,
    capabilities: perfCap,
    inMemoryAudioBytes: desktopProfile.workingMemoryBudgetBytes,
    estimatedTaskMemoryBytes: 128 * 1024 * 1024,
  });
  assert.equal(overMemDesktop.requiresWarning, true);
  assert.equal(overMemDesktop.rejectionReason, "exceeds-working-memory-budget");

  const constrainedProfile = selectDeviceResourceProfile({
    capabilities: makeCap({ deviceMemoryGb: 3, hardwareConcurrency: 4, formFactorHint: "mobile" }),
  });
  const severeOverMemConstrained = evaluateTaskAdmission({
    operation: "separate",
    profile: constrainedProfile,
    capabilities: makeCap({ deviceMemoryGb: 3, hardwareConcurrency: 4, formFactorHint: "mobile" }),
    inMemoryAudioBytes: constrainedProfile.workingMemoryBudgetBytes,
    estimatedTaskMemoryBytes: constrainedProfile.workingMemoryBudgetBytes * 0.6,
  });
  assert.equal(severeOverMemConstrained.allowed, false);
  assert.equal(severeOverMemConstrained.hardRejected, true);
  assert.equal(severeOverMemConstrained.rejectionReason, "exceeds-working-memory-budget");

  const soundtouchOverload = evaluateTaskAdmission({
    operation: "soundtouch-playback",
    profile: constrainedProfile,
    capabilities: makeCap({ deviceMemoryGb: 3, hardwareConcurrency: 4 }),
    estimatedTaskMemoryBytes: 0,
    projectedActiveSoundTouchTracks: constrainedProfile.maxActiveSoundTouchTracks + 2,
  });
  assert.equal(soundtouchOverload.allowed, false);
  assert.equal(soundtouchOverload.requiresWarning, true);
  assert.equal(soundtouchOverload.hardRejected, false);
  assert.equal(soundtouchOverload.rejectionReason, "soundtouch-track-pressure");

  const soundtouchFocusLocked = evaluateTaskAdmission({
    operation: "soundtouch-playback",
    profile: desktopProfile,
    capabilities: perfCap,
    estimatedTaskMemoryBytes: 0,
    projectedActiveSoundTouchTracks: 1,
    separationFocusActive: true,
  });
  assert.equal(soundtouchFocusLocked.allowed, false);
  assert.equal(soundtouchFocusLocked.hardRejected, true);
  assert.equal(soundtouchFocusLocked.rejectionReason, "separation-focus-locked");

  const soundtouchStressBlocked = evaluateTaskAdmission({
    operation: "soundtouch-playback",
    profile: desktopProfile,
    capabilities: perfCap,
    estimatedTaskMemoryBytes: 0,
    projectedActiveSoundTouchTracks: 2,
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 4,
      maxLongTaskDurationMs: 180,
      lastSeparationDurationMs: null,
      lastDecodeDurationMs: null,
      audioUnderrunCount: 2,
    },
  });
  assert.equal(soundtouchStressBlocked.allowed, false);
  assert.equal(soundtouchStressBlocked.rejectionReason, "soundtouch-track-pressure");
});

test("profile state manager degrades on stress, blocks unverified auto-upgrade, and reevaluates after cleanup", () => {
  const manager = new ResourceProfileStateManager();
  const desktopCap = makeCap({
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    crossOriginIsolated: true,
    formFactorHint: "desktop",
  });

  const initial = manager.evaluate(desktopCap, {
    longTaskSupported: true,
    longTaskCount: 0,
    maxLongTaskDurationMs: 0,
    lastSeparationDurationMs: null,
    lastDecodeDurationMs: null,
    audioUnderrunCount: 0,
  });
  assert.equal(initial.profile.tier, "performance");
  assert.equal(initial.justDegraded, false);

  const degraded = manager.evaluate(desktopCap, {
    longTaskSupported: true,
    longTaskCount: 6,
    maxLongTaskDurationMs: 420,
    lastSeparationDurationMs: 250000,
    lastDecodeDurationMs: 400,
    audioUnderrunCount: 4,
  });
  assert.equal(degraded.profile.tier, "constrained");
  assert.equal(degraded.justDegraded, true);

  // Even when counters momentarily clear, evaluate() must NOT auto-upgrade without verified cleanup
  const noAutoUpgrade = manager.evaluate(desktopCap, {
    longTaskSupported: true,
    longTaskCount: 0,
    maxLongTaskDurationMs: 0,
    lastSeparationDurationMs: null,
    lastDecodeDurationMs: null,
    audioUnderrunCount: 0,
  });
  assert.equal(noAutoUpgrade.profile.tier, "constrained");

  const unverifiedCleanup = manager.reevaluateAfterCleanup({
    capabilities: desktopCap,
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 0,
      maxLongTaskDurationMs: 0,
      lastSeparationDurationMs: null,
      lastDecodeDurationMs: null,
      audioUnderrunCount: 0,
    },
    cleanupCompleted: true,
    stabilityVerified: false,
  });
  assert.equal(unverifiedCleanup.upgraded, false);
  assert.equal(unverifiedCleanup.profile.tier, "constrained");

  const verifiedCleanup = manager.reevaluateAfterCleanup({
    capabilities: desktopCap,
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 0,
      maxLongTaskDurationMs: 0,
      lastSeparationDurationMs: null,
      lastDecodeDurationMs: null,
      audioUnderrunCount: 0,
    },
    cleanupCompleted: true,
    stabilityVerified: true,
  });
  assert.equal(verifiedCleanup.upgraded, true);
  assert.equal(verifiedCleanup.profile.tier, "performance");
});

test("separation focus mode triggers on constrained devices, stress, budget overflow, or user opt-in without forcing high-end desktop pause", () => {
  const androidConstrained = selectDeviceResourceProfile({
    capabilities: makeCap({ deviceMemoryGb: 3, hardwareConcurrency: 4, formFactorHint: "mobile", supportsWebGpu: false }),
  });
  const desktopPerf = selectDeviceResourceProfile({
    capabilities: makeCap({ deviceMemoryGb: 16, hardwareConcurrency: 12, formFactorHint: "desktop", supportsWebGpu: true }),
  });

  const onAndroid = shouldEnterSeparationFocusMode({
    profile: androidConstrained,
    estimatedSeparationMemoryBytes: 320 * 1024 * 1024,
    activeSoundTouchTracks: 0,
  });
  assert.equal(onAndroid.enabled, true);

  const onHealthyDesktop = shouldEnterSeparationFocusMode({
    profile: desktopPerf,
    estimatedSeparationMemoryBytes: 360 * 1024 * 1024,
    inMemoryAudioBytes: 80 * 1024 * 1024,
    activeSoundTouchTracks: 1,
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 0,
      maxLongTaskDurationMs: 0,
      lastSeparationDurationMs: null,
      lastDecodeDurationMs: null,
      audioUnderrunCount: 0,
    },
  });
  assert.equal(onHealthyDesktop.enabled, false);

  const onDesktopStress = shouldEnterSeparationFocusMode({
    profile: desktopPerf,
    estimatedSeparationMemoryBytes: 300 * 1024 * 1024,
    performanceSignals: {
      longTaskSupported: true,
      longTaskCount: 3,
      maxLongTaskDurationMs: 220,
      lastSeparationDurationMs: null,
      lastDecodeDurationMs: null,
      audioUnderrunCount: 1,
    },
  });
  assert.equal(onDesktopStress.enabled, true);

  const onDesktopBudgetExceeded = shouldEnterSeparationFocusMode({
    profile: desktopPerf,
    estimatedSeparationMemoryBytes: desktopPerf.workingMemoryBudgetBytes + 32 * 1024 * 1024,
    inMemoryAudioBytes: 0,
    activeSoundTouchTracks: 1,
  });
  assert.equal(onDesktopBudgetExceeded.enabled, true);

  const onDesktopUserOptIn = shouldEnterSeparationFocusMode({
    profile: desktopPerf,
    estimatedSeparationMemoryBytes: 280 * 1024 * 1024,
    userSelectedPausePlayback: true,
  });
  assert.equal(onDesktopUserOptIn.enabled, true);
});

test("telemetry tracker records main-thread stages, long tasks, and abort latency diagnostics", async () => {
  const tracker = new PerformanceTelemetryTracker();
  tracker.beginMainThreadStage("compute-input-rms");
  tracker.recordLongTaskEntry(245, "self");
  await new Promise((resolve) => setTimeout(resolve, 10));
  tracker.endMainThreadStage("compute-input-rms");
  tracker.markAbortRequested();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const latency = tracker.markAbortSettled();
  assert.ok(latency !== null && latency >= 0);

  const report = tracker.getDiagnosticsReport();
  assert.equal(report.longTaskCount, 1);
  assert.equal(report.maxLongTaskDurationMs, 245);
  assert.equal(report.recentLongTasks[0].stage, "compute-input-rms");
  assert.equal(report.recentStages[0].stage, "compute-input-rms");
  assert.equal(report.lastAbortLatencyMs, latency);
  assert.ok(report.summary.includes("245 ms"));
  assert.ok(report.summary.includes("最近中止回應延遲"));
});

test("stage-peak estimation and rolling weights allow up to 6-min songs on constrained mobile while protecting extreme overloads", () => {
  const androidConstrainedCap = makeCap({
    deviceMemoryGb: 3,
    hardwareConcurrency: 4,
    supportsWebGpu: false,
    crossOriginIsolated: false,
    formFactorHint: "mobile",
  });
  const laptopBalancedCap = makeCap({
    deviceMemoryGb: 8,
    hardwareConcurrency: 6,
    supportsWebGpu: false,
    crossOriginIsolated: true,
    formFactorHint: "desktop",
  });
  const desktopPerfCap = makeCap({
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    supportsWebGpu: true,
    crossOriginIsolated: true,
    formFactorHint: "desktop",
  });

  // 1) Constrained (480 MiB budget, 744 MiB hard block):
  // - 30s, 2m, 4m, 6m, 10m both 2-stem & 4-stem fit within 480 MiB working budget via chunk streaming + window playback!
  for (const dur of [30, 120, 240, 360, 600]) {
    for (const separationMode of ["two_stem", "four_stem"]) {
      const mobileDecision = assessResourceRisk({
        operation: "separate",
        durationSec: dur,
        separationMode,
        capabilities: androidConstrainedCap,
      });
      assert.equal(
        mobileDecision.admission.allowed,
        true,
        `constrained ${dur}s ${separationMode} must be allowed under chunk streaming`,
      );
      assert.equal(mobileDecision.admission.hardRejected, false);
    }
  }

  // - Extreme 30m concert track still fails safely on 3GB constrained mobile (> 744 MiB decode/input PCM)
  const constrained30mFourStem = assessResourceRisk({
    operation: "separate",
    durationSec: 1800,
    separationMode: "four_stem",
    capabilities: androidConstrainedCap,
  });
  assert.equal(constrained30mFourStem.admission.allowed, false);
  assert.equal(constrained30mFourStem.admission.hardRejected, true);

  // 2) Balanced (768 MiB budget): 6m and 10m (4-stem) fit comfortably within budget!
  const balanced6mFourStem = assessResourceRisk({
    operation: "separate",
    durationSec: 360,
    separationMode: "four_stem",
    capabilities: laptopBalancedCap,
  });
  assert.equal(balanced6mFourStem.admission.allowed, true);
  assert.equal(balanced6mFourStem.admission.rejectionReason, null);

  // 3) Performance (1536 MiB budget): 6m and 10m 4-stem allowed comfortably
  const desktop6mFourStem = assessResourceRisk({
    operation: "separate",
    durationSec: 360,
    separationMode: "four_stem",
    capabilities: desktopPerfCap,
  });
  assert.equal(desktop6mFourStem.admission.allowed, true);

  // Stage peak calculation sanity check (10m 4-stem constrained stays under 480 MiB budget, 4-stem >= 2-stem)
  const p2 = estimateSeparationStagePeaks(600, "two_stem");
  const p4 = estimateSeparationStagePeaks(600, "four_stem");
  assert.ok(p4.peakWorkingMemoryBytes > p2.peakWorkingMemoryBytes);
  assert.ok(p4.peakWorkingMemoryBytes <= 480 * 1024 * 1024);
});
