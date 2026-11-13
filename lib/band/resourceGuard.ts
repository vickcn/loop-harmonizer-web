export type ResourceRiskLevel = "low" | "medium" | "high" | "critical";

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
  collectedAt: number;
};

export type PerformanceSignals = {
  longTaskSupported: boolean;
  longTaskCount: number;
  maxLongTaskDurationMs: number;
  lastSeparationDurationMs: number | null;
  lastDecodeDurationMs: number | null;
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
  estimatedInMemoryAudioBytes?: number;
  hasOtherIdleDecodedSongs?: boolean;
  capabilities: DeviceCapabilitiesSnapshot;
  performanceSignals?: PerformanceSignals;
};

export type ResourceRiskAssessment = {
  operation: ResourceOperationKind;
  riskLevel: ResourceRiskLevel;
  requiresConfirmation: boolean;
  blockedByDefault: boolean;
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
    collectedAt: Date.now(),
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
  const reasons: string[] = [];
  let score = 0;

  const deviceMemBytes = cap.deviceMemoryGb !== null ? cap.deviceMemoryGb * BYTES_PER_GB : null;
  const inMemoryAudio = Math.max(0, input.estimatedInMemoryAudioBytes ?? 0);
  const totalProjectedMem = inMemoryAudio + estimatedMemoryBytes;
  const durationMin = (input.durationSec ?? 0) / 60;
  const activeSoundTouch = input.activeSoundTouchTracks ?? 0;

  if (cap.deviceMemoryGb === null) {
    reasons.push("無法讀取實際裝置 RAM，風險為依歌曲規模與工作負載所做的估計。");
  } else if (cap.deviceMemoryGb <= 4) {
    score += 2;
    reasons.push(`裝置回報記憶體上限較低（約 ${cap.deviceMemoryGb} GB）。`);
  }

  if (cap.hardwareConcurrency !== null && cap.hardwareConcurrency <= 4) {
    score += 1;
    reasons.push(`裝置可用處理器核心數較少（${cap.hardwareConcurrency} 核心），重型運算較易引起介面延遲。`);
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

  if (activeSoundTouch >= 4) {
    score += 2;
    reasons.push(`同時啟用 ${activeSoundTouch} 軌 SoundTouch 變速變調處理，對行動裝置 CPU 負擔較高。`);
  }

  if (input.performanceSignals && input.performanceSignals.longTaskCount >= 3) {
    score += 2;
    reasons.push(`偵測到近期主執行緒多次長任務阻塞（最長約 ${Math.round(input.performanceSignals.maxLongTaskDurationMs)} ms）。`);
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
  if (score >= 7) {
    riskLevel = "critical";
  } else if (score >= 4) {
    riskLevel = "high";
  } else if (score >= 2) {
    riskLevel = "medium";
  }

  const lowLoadSuggestions: LowLoadSuggestion[] = [];
  if ((input.playingSongCount ?? 0) > 0) {
    lowLoadSuggestions.push({
      id: "pause-other-songs",
      label: "暫停目前播放中的歌曲",
      description: "釋放即時音訊排程與 SoundTouch 處理壓力，降低爆音與畫面卡頓。",
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
      label: "改用較低併行度（安全降載）",
      description: "在背景 Worker 限制併行執行緒數以減少記憶體尖峰，保留原音質不降採樣。",
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
    requiresConfirmation: riskLevel === "high" || riskLevel === "critical",
    blockedByDefault: riskLevel === "critical",
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

  getSignals(): PerformanceSignals {
    return {
      longTaskSupported: this.longTaskSupported,
      longTaskCount: this.longTaskCount,
      maxLongTaskDurationMs: this.maxLongTaskDurationMs,
      lastSeparationDurationMs: this.lastSeparationDurationMs,
      lastDecodeDurationMs: this.lastDecodeDurationMs,
    };
  }
}

export const sharedPerfTelemetry = new PerformanceTelemetryTracker();
