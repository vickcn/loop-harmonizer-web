export type ResourceRiskLevel = "low" | "medium" | "high" | "critical";

export type DeviceResourceTier = "constrained" | "balanced" | "performance";

export type DeviceFormFactorHint = "mobile" | "tablet" | "desktop" | "unknown";

export type ResourceOperationKind =
  | "upload"
  | "decode"
  | "separate"
  | "encode-wav"
  | "soundtouch-playback";

export type DeviceCapabilitiesSnapshot = {
  deviceMemoryGb: number | null;
  hardwareConcurrency: number | null;
  storageUsageBytes: number | null;
  storageQuotaBytes: number | null;
  storageRemainingBytes: number | null;
  storagePersisted: boolean | null;
  jsHeapUsedBytes: number | null;
  jsHeapLimitBytes: number | null;
  jsHeapEstimatedAvailableBytes: number | null;
  supportsWebGpu: boolean;
  supportsWorker: boolean;
  crossOriginIsolated?: boolean;
  formFactorHint?: DeviceFormFactorHint;
  collectedAt: number;
};

export type PerformanceSignals = {
  longTaskSupported: boolean;
  longTaskCount: number;
  maxLongTaskDurationMs: number;
  lastSeparationDurationMs: number | null;
  lastDecodeDurationMs: number | null;
  audioUnderrunCount?: number;
  lastAudioUnderrunAt?: number | null;
};

export type DeviceResourceProfile = {
  tier: DeviceResourceTier;
  initialTier: DeviceResourceTier;
  formFactorHint: DeviceFormFactorHint;
  degraded: boolean;
  degradationReason: string | null;
  hardwareInfoIncomplete: boolean;
  maxWasmThreads: number;
  workingMemoryBudgetBytes: number;
  maxActiveSoundTouchTracks: number;
  demucsConcurrency: 1;
  allowMainThreadLargeInference: false;
  reasons: string[];
};

export type TaskAdmissionInput = {
  operation: ResourceOperationKind;
  profile: DeviceResourceProfile;
  capabilities: DeviceCapabilitiesSnapshot;
  estimatedTaskMemoryBytes: number;
  estimatedTaskStorageBytes?: number;
  inMemoryAudioBytes?: number;
  runningDemucsCount?: number;
  projectedActiveSoundTouchTracks?: number;
  requireWorkerForSeparation?: boolean;
};

export type TaskAdmissionDecision = {
  allowed: boolean;
  requiresWarning: boolean;
  hardRejected: boolean;
  rejectionReason:
    | "worker-unavailable"
    | "demucs-concurrency-limit"
    | "exceeds-working-memory-budget"
    | "insufficient-storage"
    | "soundtouch-track-pressure"
    | null;
  message: string;
};

export type LowLoadActionId =
  | "pause-other-songs"
  | "release-idle-buffers"
  | "limit-inference-threads"
  | "defer-other-songs";

export type LowLoadSuggestion = {
  id: LowLoadActionId;
  label: string;
  description: string;
};

export type ResourceRiskAssessmentInput = {
  operation: ResourceOperationKind;
  songName?: string;
  fileSizeBytes?: number;
  durationSec?: number;
  mimeType?: string;
  separationMode?: "two_stem" | "four_stem";
  activeSongCount?: number;
  playingSongCount?: number;
  activeSoundTouchTracks?: number;
  runningDemucsCount?: number;
  estimatedInMemoryAudioBytes?: number;
  hasOtherIdleDecodedSongs?: boolean;
  profile?: DeviceResourceProfile;
  capabilities: DeviceCapabilitiesSnapshot;
  performanceSignals?: PerformanceSignals;
};

export type ResourceRiskAssessment = {
  operation: ResourceOperationKind;
  riskLevel: ResourceRiskLevel;
  requiresConfirmation: boolean;
  blockedByDefault: boolean;
  profile: DeviceResourceProfile;
  admission: TaskAdmissionDecision;
  estimatedMemoryBytes: number;
  estimatedStorageBytes: number;
  estimatedDurationLabel: string;
  reasons: string[];
  honestModeNote: string | null;
  lowLoadSuggestions: LowLoadSuggestion[];
  capabilitiesSummary: {
    deviceMemoryLabel: string;
    cpuCoresLabel: string;
    jsHeapLabel: string;
    storageLabel: string;
  };
};

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const DEFAULT_ESTIMATED_SAMPLE_RATE = 44100;

export function formatEstimatedMiB(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "無法取得";
  return `約 ${(bytes / BYTES_PER_MB).toFixed(1)} MiB（估計）`;
}

export function formatDeviceCapabilitiesSummary(cap: DeviceCapabilitiesSnapshot): ResourceRiskAssessment["capabilitiesSummary"] {
  const deviceMemoryLabel =
    cap.deviceMemoryGb !== null && Number.isFinite(cap.deviceMemoryGb)
      ? `約 ${cap.deviceMemoryGb} GB（裝置回報概估）`
      : "無法取得";

  const cpuCoresLabel =
    cap.hardwareConcurrency !== null && Number.isFinite(cap.hardwareConcurrency)
      ? `${cap.hardwareConcurrency} 邏輯核心`
      : "無法取得";

  const jsHeapLabel =
    cap.jsHeapUsedBytes !== null && cap.jsHeapLimitBytes !== null
      ? `約 ${(cap.jsHeapUsedBytes / BYTES_PER_MB).toFixed(0)} / ${(cap.jsHeapLimitBytes / BYTES_PER_MB).toFixed(0)} MiB（JS Heap 估計）`
      : "無法取得（瀏覽器未開放）";

  const storageLabel =
    cap.storageQuotaBytes !== null && cap.storageRemainingBytes !== null
      ? `剩餘約 ${(cap.storageRemainingBytes / BYTES_PER_MB).toFixed(0)} MiB（估計，${cap.storagePersisted === true ? "已持久保護" : cap.storagePersisted === false ? "未啟用持久保護" : "持久狀態未知"}）`
      : "無法取得";

  return {
    deviceMemoryLabel,
    cpuCoresLabel,
    jsHeapLabel,
    storageLabel,
  };
}

export async function collectDeviceCapabilities(): Promise<DeviceCapabilitiesSnapshot> {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & {
    deviceMemory?: number;
    gpu?: { requestAdapter?: () => Promise<unknown | null> };
  }) : undefined;

  const deviceMemoryGb =
    typeof nav?.deviceMemory === "number" && Number.isFinite(nav.deviceMemory) && nav.deviceMemory > 0
      ? nav.deviceMemory
      : null;

  const hardwareConcurrency =
    typeof nav?.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency) && nav.hardwareConcurrency > 0
      ? nav.hardwareConcurrency
      : null;

  let storageUsageBytes: number | null = null;
  let storageQuotaBytes: number | null = null;
  let storageRemainingBytes: number | null = null;
  let storagePersisted: boolean | null = null;

  if (nav?.storage?.estimate) {
    try {
      const est = await nav.storage.estimate();
      if (typeof est.usage === "number" && Number.isFinite(est.usage)) {
        storageUsageBytes = est.usage;
      }
      if (typeof est.quota === "number" && Number.isFinite(est.quota)) {
        storageQuotaBytes = est.quota;
      }
      if (storageUsageBytes !== null && storageQuotaBytes !== null) {
        storageRemainingBytes = Math.max(0, storageQuotaBytes - storageUsageBytes);
      }
    } catch {
      // ignore unsupported storage estimate error
    }
  }

  if (nav?.storage?.persisted) {
    try {
      storagePersisted = await nav.storage.persisted();
    } catch {
      storagePersisted = null;
    }
  }

  const perf = typeof performance !== "undefined" ? (performance as Performance & {
    memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
  }) : undefined;

  const jsHeapUsedBytes =
    typeof perf?.memory?.usedJSHeapSize === "number" && Number.isFinite(perf.memory.usedJSHeapSize)
      ? perf.memory.usedJSHeapSize
      : null;
  const jsHeapLimitBytes =
    typeof perf?.memory?.jsHeapSizeLimit === "number" && Number.isFinite(perf.memory.jsHeapSizeLimit)
      ? perf.memory.jsHeapSizeLimit
      : null;
  const jsHeapEstimatedAvailableBytes =
    jsHeapUsedBytes !== null && jsHeapLimitBytes !== null
      ? Math.max(0, jsHeapLimitBytes - jsHeapUsedBytes)
      : null;

  const supportsWebGpu = Boolean(nav?.gpu && typeof nav.gpu.requestAdapter === "function");
  const supportsWorker = typeof Worker !== "undefined";
  const crossOriginIsolated =
    typeof globalThis !== "undefined"
      ? Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
      : false;

  let formFactorHint: DeviceFormFactorHint = "unknown";
  if (typeof window !== "undefined") {
    const coarse = Boolean(window.matchMedia?.("(pointer: coarse)")?.matches);
    const width = window.innerWidth || 0;
    if (coarse && width > 0 && width <= 640) {
      formFactorHint = "mobile";
    } else if (coarse && width > 640 && width <= 1180) {
      formFactorHint = "tablet";
    } else if (!coarse && width >= 1024) {
      formFactorHint = "desktop";
    }
  }

  return {
    deviceMemoryGb,
    hardwareConcurrency,
    storageUsageBytes,
    storageQuotaBytes,
    storageRemainingBytes,
    storagePersisted,
    jsHeapUsedBytes,
    jsHeapLimitBytes,
    jsHeapEstimatedAvailableBytes,
    supportsWebGpu,
    supportsWorker,
    crossOriginIsolated,
    formFactorHint,
    collectedAt: Date.now(),
  };
}

const TIER_RANK: Record<DeviceResourceTier, number> = {
  constrained: 0,
  balanced: 1,
  performance: 2,
};

function stepDownTier(tier: DeviceResourceTier, steps = 1): DeviceResourceTier {
  const targetRank = Math.max(0, TIER_RANK[tier] - steps);
  if (targetRank === 2) return "performance";
  if (targetRank === 1) return "balanced";
  return "constrained";
}

function buildProfileForTier(
  tier: DeviceResourceTier,
  initialTier: DeviceResourceTier,
  capabilities: DeviceCapabilitiesSnapshot,
  reasons: string[],
  degradationReason: string | null,
): DeviceResourceProfile {
  const formFactorHint: DeviceFormFactorHint = capabilities.formFactorHint ?? "unknown";
  const hardwareInfoIncomplete = capabilities.deviceMemoryGb === null || capabilities.hardwareConcurrency === null;
  const cores = Math.max(1, capabilities.hardwareConcurrency ?? 1);
  const isolated = Boolean(capabilities.crossOriginIsolated);

  let maxWasmThreads = 1;
  if (isolated) {
    if (tier === "performance") maxWasmThreads = Math.min(4, cores);
    else if (tier === "balanced") maxWasmThreads = Math.min(2, cores);
    else maxWasmThreads = 1;
  } else {
    maxWasmThreads = 1;
    reasons.push("瀏覽器未處於 crossOriginIsolated 環境，WASM 執行緒上限鎖定為 1。");
  }

  let workingMemoryBudgetBytes = 320 * BYTES_PER_MB;
  if (tier === "balanced") {
    workingMemoryBudgetBytes = 768 * BYTES_PER_MB;
  } else if (tier === "performance") {
    workingMemoryBudgetBytes = 1536 * BYTES_PER_MB;
  } else if (capabilities.deviceMemoryGb !== null && capabilities.deviceMemoryGb <= 2) {
    workingMemoryBudgetBytes = 240 * BYTES_PER_MB;
  }

  const maxActiveSoundTouchTracks = tier === "performance" ? 8 : tier === "balanced" ? 4 : 2;

  return {
    tier,
    initialTier,
    formFactorHint,
    degraded: TIER_RANK[tier] < TIER_RANK[initialTier] || Boolean(degradationReason),
    degradationReason,
    hardwareInfoIncomplete,
    maxWasmThreads,
    workingMemoryBudgetBytes,
    maxActiveSoundTouchTracks,
    demucsConcurrency: 1,
    allowMainThreadLargeInference: false,
    reasons,
  };
}

export function selectDeviceResourceProfile(input: {
  capabilities: DeviceCapabilitiesSnapshot;
  performanceSignals?: PerformanceSignals;
  lockedTier?: DeviceResourceTier | null;
}): DeviceResourceProfile {
  const { capabilities, performanceSignals, lockedTier } = input;
  const formFactor: DeviceFormFactorHint = capabilities.formFactorHint ?? "unknown";
  const reasons: string[] = [];

  const hardwareInfoIncomplete =
    capabilities.deviceMemoryGb === null || capabilities.hardwareConcurrency === null;

  let initialTier: DeviceResourceTier = "constrained";
  if (hardwareInfoIncomplete) {
    initialTier = "constrained";
    reasons.push("無法取得完整硬體資訊（RAM 或邏輯核心數缺失），採保守 constrained 配置，不推測剩餘實體記憶體。");
  } else {
    const memGb = capabilities.deviceMemoryGb!;
    const cores = capabilities.hardwareConcurrency!;
    if (memGb <= 4 || cores <= 4) {
      initialTier = "constrained";
      reasons.push(`硬體規格偏保守（約 ${memGb} GB / ${cores} 核心），採用 constrained 配置。`);
    } else if (formFactor === "mobile" || formFactor === "tablet") {
      initialTier = memGb >= 6 && cores >= 6 ? "balanced" : "constrained";
      reasons.push(`依裝置型態參考（${formFactor}）與實測規格（${memGb} GB / ${cores} 核心）選擇 ${initialTier} 配置。`);
    } else if (memGb >= 8 && cores >= 8) {
      initialTier = "performance";
      reasons.push(`桌面高規硬體（約 ${memGb} GB / ${cores} 核心），初始配置為 performance。`);
    } else {
      initialTier = "balanced";
      reasons.push(`一般硬體規格（約 ${memGb} GB / ${cores} 核心），初始配置為 balanced。`);
    }
  }

  let effectiveTier = initialTier;
  let degradationReason: string | null = null;

  if (capabilities.storageRemainingBytes !== null && capabilities.storageRemainingBytes < 120 * BYTES_PER_MB) {
    effectiveTier = "constrained";
    degradationReason = "瀏覽器剩餘儲存空間低於 120 MiB，調降為 constrained 配置。";
    reasons.push(degradationReason);
  }

  const underruns = performanceSignals?.audioUnderrunCount ?? 0;
  const longTasks = performanceSignals?.longTaskCount ?? 0;
  const maxLongTaskMs = performanceSignals?.maxLongTaskDurationMs ?? 0;
  const lastSepMs = performanceSignals?.lastSeparationDurationMs ?? 0;
  const lastDecMs = performanceSignals?.lastDecodeDurationMs ?? 0;

  const severeDegradation =
    underruns >= 4 || longTasks >= 6 || maxLongTaskMs >= 350 || lastSepMs >= 240_000;
  const moderateDegradation =
    underruns >= 2 || longTasks >= 3 || maxLongTaskMs >= 200 || lastSepMs >= 150_000 || lastDecMs >= 5000;

  if (severeDegradation) {
    effectiveTier = "constrained";
    degradationReason = `偵測到明顯效能壓力（Long Tasks: ${longTasks}, Audio Underruns: ${underruns}），自動降級至 constrained。`;
    reasons.push(degradationReason);
  } else if (moderateDegradation) {
    const stepped = stepDownTier(effectiveTier, 1);
    if (TIER_RANK[stepped] < TIER_RANK[effectiveTier]) {
      effectiveTier = stepped;
      degradationReason = `偵測到效能壓力訊號（Long Tasks: ${longTasks}, Audio Underruns: ${underruns}），保守降級至 ${stepped}。`;
      reasons.push(degradationReason);
    } else if (effectiveTier === "constrained") {
      degradationReason = `constrained 模式下仍偵測到效能壓力（Long Tasks: ${longTasks}, Audio Underruns: ${underruns}）。`;
      reasons.push(degradationReason);
    }
  }

  if (lockedTier && TIER_RANK[lockedTier] < TIER_RANK[effectiveTier]) {
    effectiveTier = lockedTier;
    if (!degradationReason) {
      degradationReason = `維持先前降級後之 ${lockedTier} 配置（尚未通過清理與穩定性驗證，禁止自動升級）。`;
    }
    reasons.push(degradationReason);
  }

  return buildProfileForTier(effectiveTier, initialTier, capabilities, reasons, degradationReason);
}

export class ResourceProfileStateManager {
  private lockedTier: DeviceResourceTier | null = null;
  private lastProfile: DeviceResourceProfile | null = null;

  getCurrentProfile(): DeviceResourceProfile | null {
    return this.lastProfile;
  }

  /**
   * 評估並更新資源配置：
   * - 允許效能惡化時自動降級（鎖定更低 tier）；
   * - 絕不在未驗證穩定性前自動升級。
   */
  evaluate(
    capabilities: DeviceCapabilitiesSnapshot,
    performanceSignals?: PerformanceSignals,
  ): {
    profile: DeviceResourceProfile;
    justDegraded: boolean;
    previousTier: DeviceResourceTier | null;
  } {
    const previousTier = this.lastProfile?.tier ?? null;
    const profile = selectDeviceResourceProfile({
      capabilities,
      performanceSignals,
      lockedTier: this.lockedTier,
    });

    // 若本次評級比目前更低（包含剛觸發降級或原本已處較低 tier），鎖定為不可自動升回之上限
    if (this.lockedTier === null || TIER_RANK[profile.tier] < TIER_RANK[this.lockedTier]) {
      this.lockedTier = profile.tier;
    }

    const justDegraded = previousTier !== null && TIER_RANK[profile.tier] < TIER_RANK[previousTier];
    this.lastProfile = profile;
    return { profile, justDegraded, previousTier };
  }

  /**
   * 僅在任務取消與資源釋放完成，且經穩定性驗證確認無持續阻塞/斷音訊號時，才解除降級鎖並重新評估。
   */
  reevaluateAfterCleanup(input: {
    capabilities: DeviceCapabilitiesSnapshot;
    performanceSignals: PerformanceSignals;
    cleanupCompleted: boolean;
    stabilityVerified: boolean;
  }): {
    profile: DeviceResourceProfile;
    upgraded: boolean;
    previousTier: DeviceResourceTier | null;
  } {
    const previousTier = this.lastProfile?.tier ?? this.lockedTier;
    const hasResidualStress =
      (input.performanceSignals.audioUnderrunCount ?? 0) >= 2
      || input.performanceSignals.longTaskCount >= 3;

    if (input.cleanupCompleted && input.stabilityVerified && !hasResidualStress) {
      this.lockedTier = null;
    }

    const profile = selectDeviceResourceProfile({
      capabilities: input.capabilities,
      performanceSignals: input.performanceSignals,
      lockedTier: this.lockedTier,
    });
    this.lockedTier = profile.tier;
    this.lastProfile = profile;

    const upgraded = previousTier !== null && TIER_RANK[profile.tier] > TIER_RANK[previousTier];
    return { profile, upgraded, previousTier };
  }

  reset(): void {
    this.lockedTier = null;
    this.lastProfile = null;
  }
}

export const sharedResourceProfileManager = new ResourceProfileStateManager();

export function evaluateTaskAdmission(input: TaskAdmissionInput): TaskAdmissionDecision {
  const { profile, capabilities, operation } = input;
  const projectedMem = Math.max(0, input.inMemoryAudioBytes ?? 0) + Math.max(0, input.estimatedTaskMemoryBytes);
  const estStorage = Math.max(0, input.estimatedTaskStorageBytes ?? 0);

  if (operation === "separate") {
    if ((input.runningDemucsCount ?? 0) >= profile.demucsConcurrency) {
      return {
        allowed: false,
        requiresWarning: true,
        hardRejected: true,
        rejectionReason: "demucs-concurrency-limit",
        message: "Demucs 分離任務同時執行上限固定為 1，請等待目前任務完成或先中止後再試。",
      };
    }

    if (input.requireWorkerForSeparation !== false && !capabilities.supportsWorker && !profile.allowMainThreadLargeInference) {
      return {
        allowed: false,
        requiresWarning: true,
        hardRejected: true,
        rejectionReason: "worker-unavailable",
        message: "此瀏覽器不支援背景 Web Worker，依資源保護原則預設拒絕主執行緒大型 AI 推論，以避免介面失去反應。",
      };
    }
  }

  if (capabilities.storageRemainingBytes !== null && estStorage > capabilities.storageRemainingBytes * 0.9) {
    return {
      allowed: false,
      requiresWarning: true,
      hardRejected: true,
      rejectionReason: "insufficient-storage",
      message: `預估寫入快取（${formatEstimatedMiB(estStorage)}）接近或超出剩餘儲存空間，建議先清理未使用的分離快取。`,
    };
  }

  if (operation === "soundtouch-playback") {
    const projectedTracks = input.projectedActiveSoundTouchTracks ?? 1;
    if (projectedTracks > profile.maxActiveSoundTouchTracks) {
      return {
        allowed: true,
        requiresWarning: true,
        hardRejected: false,
        rejectionReason: "soundtouch-track-pressure",
        message: `同時活躍 SoundTouch 軌道（${projectedTracks} 軌）超出目前 ${profile.tier} 配置建議上限（${profile.maxActiveSoundTouchTracks} 軌），可能發生破音或 CPU 過載；系統將先預警，不會擅自中斷播放中的歌曲。`,
      };
    }
  }

  if (projectedMem > profile.workingMemoryBudgetBytes) {
    const isConstrainedHardBlock =
      profile.tier === "constrained"
      && projectedMem > profile.workingMemoryBudgetBytes * 1.35
      && (operation === "separate" || operation === "decode");
    return {
      allowed: !isConstrainedHardBlock,
      requiresWarning: true,
      hardRejected: isConstrainedHardBlock,
      rejectionReason: "exceeds-working-memory-budget",
      message: `預估累計工作記憶體（${formatEstimatedMiB(projectedMem)}）超出目前 ${profile.tier} 配置上限（${formatEstimatedMiB(profile.workingMemoryBudgetBytes)}）；建議先釋放閒置音訊緩衝或暫停其他歌曲，絕不會擅自降低音訊品質。`,
    };
  }

  return {
    allowed: true,
    requiresWarning: false,
    hardRejected: false,
    rejectionReason: null,
    message: `符合目前 ${profile.tier} 資源配置上限。`,
  };
}

export function estimateStereoPcmBytes(durationSec: number, sampleRate = DEFAULT_ESTIMATED_SAMPLE_RATE): number {
  const safeDuration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  // 2 channels * Float32 (4 bytes/sample)
  return Math.round(safeDuration * sampleRate * 2 * 4);
}

export function estimateOperationFootprint(input: ResourceRiskAssessmentInput): {
  estimatedMemoryBytes: number;
  estimatedStorageBytes: number;
} {
  const fileSize = Math.max(0, input.fileSizeBytes ?? 0);
  const durationSec = Math.max(0, input.durationSec ?? 0);
  const isWav = Boolean(input.mimeType?.includes("wav") || input.songName?.toLowerCase().endsWith(".wav"));
  const stereoPcmBytes = durationSec > 0
    ? estimateStereoPcmBytes(durationSec)
    : fileSize > 0
      ? fileSize * (isWav ? 2 : 10)
      : 45 * BYTES_PER_MB;

  switch (input.operation) {
    case "upload": {
      // 上傳會檢查 Blob 雜湊＋預備進入解碼
      return {
        estimatedMemoryBytes: fileSize + stereoPcmBytes,
        estimatedStorageBytes: fileSize,
      };
    }
    case "decode": {
      // AudioBuffer Float32 stereo + 暫存解碼 ArrayBuffer
      return {
        estimatedMemoryBytes: fileSize + stereoPcmBytes * 1.4,
        estimatedStorageBytes: 0,
      };
    }
    case "separate": {
      // Demucs 模型與推論工作記憶體（估計 ~260 MiB 基本模型+tensor開銷 + 4 軌 stereo PCM 緩衝）
      const fourStemPcm = stereoPcmBytes * 4;
      const runtimeWorkingSet = 260 * BYTES_PER_MB;
      // 寫入 IndexedDB 時保存 PCM Float32 陣列；2-stem 保存 2 軌，4-stem 保存 4 軌
      const storedTrackCount = input.separationMode === "two_stem" ? 2 : 4;
      const estimatedStorageBytes = stereoPcmBytes * storedTrackCount;
      return {
        estimatedMemoryBytes: runtimeWorkingSet + stereoPcmBytes + fourStemPcm,
        estimatedStorageBytes,
      };
    }
    case "encode-wav": {
      // 16-bit PCM = 2 bytes * 2 ch + blob 複製約 ~1.2x
      const wavSize = durationSec > 0 ? Math.round(durationSec * DEFAULT_ESTIMATED_SAMPLE_RATE * 2 * 2) : Math.round(stereoPcmBytes * 0.5);
      return {
        estimatedMemoryBytes: wavSize * 2,
        estimatedStorageBytes: 0,
      };
    }
    case "soundtouch-playback": {
      const tracks = Math.max(1, input.activeSoundTouchTracks ?? 1);
      return {
        estimatedMemoryBytes: stereoPcmBytes + tracks * 12 * BYTES_PER_MB,
        estimatedStorageBytes: 0,
      };
    }
  }
}

export function assessResourceRisk(input: ResourceRiskAssessmentInput): ResourceRiskAssessment {
  const { estimatedMemoryBytes, estimatedStorageBytes } = estimateOperationFootprint(input);
  const cap = input.capabilities;
  const profile = input.profile ?? selectDeviceResourceProfile({
    capabilities: cap,
    performanceSignals: input.performanceSignals,
  });
  const admission = evaluateTaskAdmission({
    operation: input.operation,
    profile,
    capabilities: cap,
    estimatedTaskMemoryBytes: estimatedMemoryBytes,
    estimatedTaskStorageBytes: estimatedStorageBytes,
    inMemoryAudioBytes: input.estimatedInMemoryAudioBytes,
    runningDemucsCount: input.runningDemucsCount,
    projectedActiveSoundTouchTracks: input.activeSoundTouchTracks,
  });
  const reasons: string[] = [];
  let score = 0;

  const deviceMemBytes = cap.deviceMemoryGb !== null ? cap.deviceMemoryGb * BYTES_PER_GB : null;
  const inMemoryAudio = Math.max(0, input.estimatedInMemoryAudioBytes ?? 0);
  const totalProjectedMem = inMemoryAudio + estimatedMemoryBytes;
  const durationMin = (input.durationSec ?? 0) / 60;
  const activeSoundTouch = input.activeSoundTouchTracks ?? 0;

  if (cap.deviceMemoryGb === null) {
    reasons.push("無法讀取實際裝置 RAM，已採保守配置並依歌曲規模估算風險。");
  } else if (cap.deviceMemoryGb <= 4) {
    score += 2;
    reasons.push(`裝置回報記憶體上限較低（約 ${cap.deviceMemoryGb} GB）。`);
  }

  if (cap.hardwareConcurrency !== null && cap.hardwareConcurrency <= 4) {
    score += 1;
    reasons.push(`裝置可用處理器核心數較少（${cap.hardwareConcurrency} 核心），重型運算較易引起介面延遲。`);
  }

  if (admission.rejectionReason && !reasons.includes(admission.message)) {
    reasons.push(admission.message);
    if (admission.hardRejected) score += 5;
    else score += 3;
  }

  if (cap.jsHeapEstimatedAvailableBytes !== null && estimatedMemoryBytes > cap.jsHeapEstimatedAvailableBytes * 0.75) {
    score += 3;
    reasons.push(`預估需求記憶體接近目前 JS Heap 剩餘估算空間（${formatEstimatedMiB(cap.jsHeapEstimatedAvailableBytes)}）。`);
  } else if (deviceMemBytes !== null && totalProjectedMem > deviceMemBytes * 0.35) {
    score += 3;
    reasons.push(`累計音訊與任務工作集（${formatEstimatedMiB(totalProjectedMem)}）佔裝置記憶體比例偏高。`);
  }

  if (input.operation === "upload" && (input.fileSizeBytes ?? 0) >= 80 * BYTES_PER_MB) {
    score += 2;
    reasons.push(`檔案體積達 ${((input.fileSizeBytes ?? 0) / BYTES_PER_MB).toFixed(1)} MiB，解碼與保存需較多記憶體。`);
  }

  if (input.operation === "decode" && (durationMin >= 6 || (input.fileSizeBytes ?? 0) >= 60 * BYTES_PER_MB)) {
    score += 2;
    reasons.push("歌曲較長或為大型無損音檔，解碼為浮點 PCM 將佔用大量記憶體。");
  }

  if (input.operation === "separate") {
    if (durationMin >= 8) {
      score += 4;
      reasons.push(`歌曲長度約 ${Math.round(durationMin)} 分鐘，完整 AI 音源分離需要大量運算與長時間推論。`);
    } else if (durationMin >= 4.5) {
      score += 2;
      reasons.push(`歌曲長度約 ${durationMin.toFixed(1)} 分鐘，分段推論與 4 軌 PCM 緩衝負荷較高。`);
    }
    if (!cap.supportsWebGpu) {
      score += 2;
      reasons.push("瀏覽器不支援 WebGPU，將使用 WASM 推論，耗時會明顯增加。");
    }
  }

  if ((input.playingSongCount ?? 0) >= 1 && input.operation === "separate") {
    score += 1;
    reasons.push("目前仍有歌曲正在播放，同時執行 AI 分離可能造成聲音斷續或介面卡頓。");
  }

  if (activeSoundTouch > profile.maxActiveSoundTouchTracks) {
    score += 2;
    reasons.push(`同時啟用 ${activeSoundTouch} 軌 SoundTouch 處理（超過目前 ${profile.tier} 上限 ${profile.maxActiveSoundTouchTracks} 軌），CPU 壓力升高。`);
  }

  if (input.performanceSignals && (input.performanceSignals.longTaskCount >= 3 || (input.performanceSignals.audioUnderrunCount ?? 0) >= 2)) {
    score += 2;
    reasons.push(`偵測到近期主執行緒阻塞或音訊欠載（Long Tasks: ${input.performanceSignals.longTaskCount}, Underruns: ${input.performanceSignals.audioUnderrunCount ?? 0}）。`);
  }

  if (cap.storageRemainingBytes !== null && estimatedStorageBytes > 0) {
    if (estimatedStorageBytes > cap.storageRemainingBytes * 0.9) {
      score += 4;
      reasons.push(`預估寫入快取（${formatEstimatedMiB(estimatedStorageBytes)}）可能超出剩餘儲存空間（${formatEstimatedMiB(cap.storageRemainingBytes)}）。`);
    } else if (estimatedStorageBytes > cap.storageRemainingBytes * 0.5) {
      score += 2;
      reasons.push("剩餘瀏覽器儲存空間偏緊，寫入分離結果快取可能失敗。");
    }
  }

  let riskLevel: ResourceRiskLevel = "low";
  if (score >= 7 || admission.hardRejected) {
    riskLevel = "critical";
  } else if (score >= 4 || admission.requiresWarning) {
    riskLevel = "high";
  } else if (score >= 2) {
    riskLevel = "medium";
  }

  const lowLoadSuggestions: LowLoadSuggestion[] = [];
  if ((input.playingSongCount ?? 0) > 0) {
    lowLoadSuggestions.push({
      id: "pause-other-songs",
      label: "暫停目前播放中的歌曲",
      description: "釋放即時音訊排程與 SoundTouch 處理壓力，降低爆音與畫面卡頓（需由您主動確認，系統不會無提示中斷播放）。",
    });
  }
  if (input.hasOtherIdleDecodedSongs) {
    lowLoadSuggestions.push({
      id: "release-idle-buffers",
      label: "先釋放閒置音訊解碼緩衝",
      description: "解除未播放歌曲在記憶體中的 PCM／AudioBuffer 參照（不會刪除原始音檔與已存快取）。",
    });
  }
  if (input.operation === "separate") {
    lowLoadSuggestions.push({
      id: "limit-inference-threads",
      label: `依 ${profile.tier} 配置限制執行緒數（目前上限 ${profile.maxWasmThreads}）`,
      description: "在背景 Worker 限制併行執行緒數以減少記憶體尖峰，完整保留原音質不降採樣。",
    });
  }

  const honestModeNote =
    input.operation === "separate"
      ? "註：目前 2 Stem 模式仍以同一套 4 Stem AI 模型推論，再於完成後合併伴奏；切換 2 Stem 僅減少後續混音與快取寫入軌數，不會降低模型推論本身的記憶體與運算量。"
      : null;

  let estimatedDurationLabel = "數秒內";
  if (input.operation === "separate") {
    const mins = Math.max(0.5, durationMin || 3);
    estimatedDurationLabel = cap.supportsWebGpu
      ? `約 ${Math.max(15, Math.round(mins * 12))}–${Math.max(30, Math.round(mins * 25))} 秒（估計）`
      : `約 ${Math.max(1, Math.round(mins * 0.8))}–${Math.max(2, Math.round(mins * 2))} 分鐘（WASM 估計）`;
  } else if (input.operation === "decode") {
    estimatedDurationLabel = "約 1–10 秒（依裝置速度而異）";
  }

  return {
    operation: input.operation,
    riskLevel,
    requiresConfirmation: riskLevel === "high" || riskLevel === "critical" || admission.requiresWarning,
    blockedByDefault: riskLevel === "critical" || admission.hardRejected,
    profile,
    admission,
    estimatedMemoryBytes,
    estimatedStorageBytes,
    estimatedDurationLabel,
    reasons: reasons.length ? reasons : ["資源估計位於正常範圍內。"],
    honestModeNote,
    lowLoadSuggestions,
    capabilitiesSummary: formatDeviceCapabilitiesSummary(cap),
  };
}

export class PerformanceTelemetryTracker {
  private longTaskCount = 0;
  private maxLongTaskDurationMs = 0;
  private lastSeparationDurationMs: number | null = null;
  private lastDecodeDurationMs: number | null = null;
  private audioUnderrunCount = 0;
  private lastAudioUnderrunAt: number | null = null;
  private longTaskSupported = false;
  private observer: PerformanceObserver | null = null;

  startObservingLongTasks(): void {
    if (this.observer) return;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const supported = (PerformanceObserver as typeof PerformanceObserver & { supportedEntryTypes?: string[] }).supportedEntryTypes;
      if (Array.isArray(supported) && !supported.includes("longtask")) {
        return;
      }
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskCount += 1;
          if (entry.duration > this.maxLongTaskDurationMs) {
            this.maxLongTaskDurationMs = entry.duration;
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      this.longTaskSupported = true;
      this.observer = obs;
    } catch {
      this.longTaskSupported = false;
    }
  }

  stopObserving(): void {
    if (this.observer) {
      try { this.observer.disconnect(); } catch { /* ignore */ }
      this.observer = null;
    }
  }

  recordSeparationDuration(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) {
      this.lastSeparationDurationMs = ms;
    }
  }

  recordDecodeDuration(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) {
      this.lastDecodeDurationMs = ms;
    }
  }

  recordAudioUnderrun(): void {
    this.audioUnderrunCount += 1;
    this.lastAudioUnderrunAt = Date.now();
  }

  resetStressCountersAfterCleanup(): void {
    this.longTaskCount = 0;
    this.maxLongTaskDurationMs = 0;
    this.audioUnderrunCount = 0;
  }

  getSignals(): PerformanceSignals {
    return {
      longTaskSupported: this.longTaskSupported,
      longTaskCount: this.longTaskCount,
      maxLongTaskDurationMs: this.maxLongTaskDurationMs,
      lastSeparationDurationMs: this.lastSeparationDurationMs,
      lastDecodeDurationMs: this.lastDecodeDurationMs,
      audioUnderrunCount: this.audioUnderrunCount,
      lastAudioUnderrunAt: this.lastAudioUnderrunAt,
    };
  }
}

export const sharedPerfTelemetry = new PerformanceTelemetryTracker();
