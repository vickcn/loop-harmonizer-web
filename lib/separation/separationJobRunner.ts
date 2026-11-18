import {
  collectDeviceCapabilities,
  evaluateTaskAdmission,
  assessResourceRisk,
  sharedPerfTelemetry,
  sharedResourceProfileManager,
  shouldEnterSeparationFocusMode,
  type DeviceCapabilitiesSnapshot,
  type ResourceRiskAssessment,
} from "../band/resourceGuard.ts";
import type { NetworkBatchEvaluation } from "../band/networkBudgetGuard.ts";
import type { BandSong, SeparationStatus } from "../band/bandTypes.ts";
import type { PersistedSongRecord } from "../band/songModel.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION, createSeparationCacheKey } from "../storage/cacheKeys.ts";
import {
  createStemCacheRecord,
  getCachedStemSet,
  hashSourceAudio,
  putCachedStemSet,
} from "../storage/separationCache.ts";
import {
  type CheckpointSongReferenceCandidate,
  type SeparationCheckpoint,
  addCheckpointReference,
  createCheckpointTaskId,
  findCompletedCheckpointBySourceAudioHash,
  findLatestCheckpointBySourceAudioHash,
  getCheckpoint,
  isCheckpointLeaseActive,
  releaseCheckpointReferenceAndMaybeGc,
} from "../storage/separationCheckpointStore.ts";
import {
  getPersistedAudioBlobByKey,
  getPersistedSongRecord,
  patchPersistedSongSeparationFields,
} from "../storage/songSessionStore.ts";
import {
  DEFAULT_JOB_LEASE_TTL_MS,
  type ResumeValidationResult,
  type SeparationJobLeaseManager,
  type WebLockAdapter,
  evaluateAutoResumeEligibility,
  getOrCreateTabId,
  sharedSeparationLeaseManager,
  validateAndPrepareResume,
} from "./separationResumeController.ts";
import { isValidationCompleted, recordSeparationDiagnostic } from "./separationStateRecovery.ts";
import {
  SeparationTaskController,
  isAbortError,
  isPauseError,
  type SeparationProgressEvent,
} from "./separationTaskController.ts";
import {
  disposeStemSeparator,
  isSeparatorWorkerActive,
  preflightSeparationNetworkBudget,
  separateAudio,
  type ChunkedSeparationSummary,
  type StemSeparationOptions,
  type StemSeparationResult,
} from "./stemSeparator.ts";
import {
  deriveTwoStemFromFourStemSet,
  type SeparatedStemSet,
  type StemSeparationMode,
} from "./stemTypes.ts";

export interface SeparationJobDescriptor {
  taskId: string;
  songId: string;
  songName?: string;
  sourceAudioId: string;
  sourceAudioHash: string;
  requestedMode: StemSeparationMode;
  modelVersion: string;
  processingVersion: string;
  userAuthorized: boolean;
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  durationSec?: number;
}

export interface TransientSongAudioEntry {
  blob: Blob;
  name?: string;
  fileName?: string;
  mimeType?: string;
  durationSec?: number;
  sourceAudioHash?: string | null;
}

const transientSongAudioRegistry = new Map<string, TransientSongAudioEntry>();

/** 暫存記憶體剛載入但尚未完成 IndexedDB 寫入的原始音訊供背景 Runner 讀取；歌曲移除時清除。 */
export function registerTransientSongAudio(songId: string, entry: TransientSongAudioEntry): void {
  if (!songId) return;
  transientSongAudioRegistry.set(songId, entry);
}

export function unregisterTransientSongAudio(songId: string): void {
  transientSongAudioRegistry.delete(songId);
}

export function getTransientSongAudio(songId: string): TransientSongAudioEntry | undefined {
  return transientSongAudioRegistry.get(songId);
}

export function clearTransientSongAudioRegistry(): void {
  transientSongAudioRegistry.clear();
}

export function isNonRetryableSeparationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /請選擇音訊檔案|找不到來源音訊|找不到原始音訊|未取得使用者明確授權|網路傳輸預算不足|超出網路|不支援 AudioContext|不支援背景 Web Worker|已移除|已取消/i.test(
    message,
  );
}

function toAudioFileLike(blob: Blob, fileName: string, mimeType: string): File {
  const safeType = mimeType && mimeType.startsWith("audio/") ? mimeType : (blob.type && blob.type.startsWith("audio/") ? blob.type : "audio/wav");
  const safeName = fileName || "audio.wav";
  if (typeof File !== "undefined" && blob instanceof File && blob.type.startsWith("audio/")) {
    return blob;
  }
  if (typeof File !== "undefined") {
    return new File([blob], safeName, { type: safeType });
  }
  const cloned = blob.slice(0, blob.size, safeType) as Blob & { name: string; lastModified: number };
  Object.defineProperty(cloned, "name", { value: safeName, configurable: true });
  Object.defineProperty(cloned, "lastModified", { value: Date.now(), configurable: true });
  return cloned as File;
}

function estimateStereoPcmBytesLocal(durationSec: number, sampleRate = 44100): number {
  const safeSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.ceil(safeSec * sampleRate) * 2 * 4;
}

function stemRolesForMode(mode: StemSeparationMode): readonly string[] {
  return mode === "two_stem" ? ["vocals", "instrumental"] : ["vocals", "drums", "bass", "other"];
}

/** 嚴格以 IndexedDB 權威 Checkpoint 與 Chunk 驗證歌曲分離狀態（不依賴 BandMixer 掛載）。 */
export async function verifyAuthoritativeCheckpoint(
  song: { id: string; sourceAudioHash?: string | null; separationTaskId?: string | null },
  sourceAudioAvailable: boolean,
): Promise<ResumeValidationResult | null> {
  if (!song.sourceAudioHash) return null;
  const tabId = getOrCreateTabId();
  const primaryTaskId =
    song.separationTaskId ||
    createCheckpointTaskId(
      song.id,
      song.sourceAudioHash,
      DEMUCS_MODEL_VERSION,
      SEPARATION_PROCESSING_VERSION,
    );

  const primaryCp = await getCheckpoint(primaryTaskId).catch(() => null);
  let primaryValidation: ResumeValidationResult | null = null;
  if (primaryCp && primaryCp.sourceAudioHash === song.sourceAudioHash) {
    primaryValidation = await validateAndPrepareResume(primaryCp.taskId, {
      sourceAudioAvailable,
      sourceAudioHash: song.sourceAudioHash,
      totalSamples: primaryCp.totalSamples,
      sampleRate: primaryCp.sampleRate,
      viewerTabId: tabId,
    }).catch(() => null);
    if (isValidationCompleted(primaryValidation)) {
      return primaryValidation;
    }
  }

  const completedByHash = await findCompletedCheckpointBySourceAudioHash(
    song.sourceAudioHash,
  ).catch(() => null);
  if (completedByHash && completedByHash.taskId !== primaryTaskId) {
    const hashValidation = await validateAndPrepareResume(completedByHash.taskId, {
      sourceAudioAvailable,
      sourceAudioHash: song.sourceAudioHash,
      totalSamples: completedByHash.totalSamples,
      sampleRate: completedByHash.sampleRate,
      viewerTabId: tabId,
    }).catch(() => null);
    if (isValidationCompleted(hashValidation)) {
      return hashValidation;
    }
  }

  if (primaryValidation) return primaryValidation;

  const latestByHash = await findLatestCheckpointBySourceAudioHash(
    song.sourceAudioHash,
  ).catch(() => null);
  if (latestByHash && latestByHash.taskId !== primaryTaskId) {
    return validateAndPrepareResume(latestByHash.taskId, {
      sourceAudioAvailable,
      sourceAudioHash: song.sourceAudioHash,
      totalSamples: latestByHash.totalSamples,
      sampleRate: latestByHash.sampleRate,
      viewerTabId: tabId,
    }).catch(() => null);
  }
  return null;
}

/**
 * 直接從既有 IndexedDB Stores（separationCheckpoints、songs、audioFiles）重建 Job Descriptor，
 * 無需額外建立 Store，亦不保留 UI Closure。
 */
export async function reconstructJobDescriptor(params: {
  taskId?: string;
  songId?: string;
}): Promise<{
  descriptor: SeparationJobDescriptor;
  songRecord: PersistedSongRecord | null;
  checkpoint: SeparationCheckpoint | null;
  audioBlob: Blob | null;
} | null> {
  let checkpoint: SeparationCheckpoint | null = params.taskId
    ? await getCheckpoint(params.taskId).catch(() => null)
    : null;

  const resolvedSongId = params.songId || checkpoint?.songId || "";
  const songRecord = resolvedSongId
    ? await getPersistedSongRecord(resolvedSongId).catch(() => null)
    : null;

  if (!checkpoint && resolvedSongId) {
    checkpoint = await getLatestCheckpointForSongFallback(
      resolvedSongId,
      songRecord?.separationTaskId,
      songRecord?.sourceAudioHash,
    );
  }

  const transient = resolvedSongId ? transientSongAudioRegistry.get(resolvedSongId) : undefined;
  if (!checkpoint && !songRecord && !transient) {
    return null;
  }

  const sourceAudioHash =
    checkpoint?.sourceAudioHash ||
    songRecord?.sourceAudioHash ||
    transient?.sourceAudioHash ||
    "";

  let audioBlob: Blob | null = transient?.blob ?? null;
  if (!audioBlob) {
    const audioKey = songRecord?.audioKey || sourceAudioHash;
    if (audioKey) {
      const persistedAudio = await getPersistedAudioBlobByKey(audioKey).catch(() => null);
      audioBlob = persistedAudio?.blob ?? null;
    }
  }

  const modelVersion = checkpoint?.modelVersion || songRecord?.modelVersion || DEMUCS_MODEL_VERSION;
  const processingVersion =
    checkpoint?.processingVersion || songRecord?.processingVersion || SEPARATION_PROCESSING_VERSION;
  const requestedMode: StemSeparationMode =
    checkpoint?.requestedMode || songRecord?.separationMode || "four_stem";

  const taskId =
    params.taskId ||
    checkpoint?.taskId ||
    songRecord?.separationTaskId ||
    (resolvedSongId && sourceAudioHash
      ? createCheckpointTaskId(resolvedSongId, sourceAudioHash, modelVersion, processingVersion)
      : "");

  if (!taskId || !resolvedSongId) return null;

  const descriptor: SeparationJobDescriptor = {
    taskId,
    songId: resolvedSongId,
    songName: transient?.name || songRecord?.name || resolvedSongId,
    sourceAudioId: `${resolvedSongId}_original`,
    sourceAudioHash,
    requestedMode,
    modelVersion,
    processingVersion,
    userAuthorized: Boolean(checkpoint?.userAuthorized ?? songRecord?.separationUserAuthorized),
    fileName: transient?.fileName || songRecord?.fileName || `${songRecord?.name ?? resolvedSongId}.wav`,
    mimeType: transient?.mimeType || songRecord?.mimeType || "audio/wav",
    fileSizeBytes: songRecord?.sizeBytes ?? audioBlob?.size ?? 0,
    durationSec:
      transient?.durationSec ??
      songRecord?.durationSec ??
      (checkpoint && checkpoint.sampleRate > 0
        ? checkpoint.totalSamples / checkpoint.sampleRate
        : 0),
  };

  return { descriptor, songRecord, checkpoint, audioBlob };
}

async function getLatestCheckpointForSongFallback(
  songId: string,
  taskId?: string | null,
  sourceAudioHash?: string | null,
): Promise<SeparationCheckpoint | null> {
  if (taskId) {
    const direct = await getCheckpoint(taskId).catch(() => null);
    if (direct) return direct;
  }
  if (sourceAudioHash) {
    const createdId = createCheckpointTaskId(
      songId,
      sourceAudioHash,
      DEMUCS_MODEL_VERSION,
      SEPARATION_PROCESSING_VERSION,
    );
    const byCreated = await getCheckpoint(createdId).catch(() => null);
    if (byCreated) return byCreated;
    return findLatestCheckpointBySourceAudioHash(sourceAudioHash).catch(() => null);
  }
  return null;
}

export interface StartSeparationJobRequest {
  songId: string;
  taskId?: string;
  songName?: string;
  mode?: StemSeparationMode;
  file?: Blob;
  sourceAudioHash?: string;
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  durationSec?: number;
  maxThreads?: number;
  userAuthorized?: boolean;
  isAutoResume?: boolean;
  forceRecompute?: boolean;
  guardAlreadyConfirmed?: boolean;
  userSelectedPausePlayback?: boolean;
  inMemoryAudioBytes?: number;
  activeSoundTouchTracks?: number;
  activeSongCount?: number;
  playingSongCount?: number;
  hasOtherIdleDecodedSongs?: boolean;
  playbackSourceBefore?: "original" | "stems";
  hadStemsBefore?: boolean;
  previousCompletedTaskId?: string | null;
  previousCacheKey?: string | null;
  inMemoryStems?: SeparatedStemSet | null;
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  knownRemovedSongIds?: Iterable<string>;
}

export type SeparationJobRunOutcome =
  | {
      status: "completed";
      taskId: string;
      songId: string;
      generation: number;
      mode: StemSeparationMode;
      cacheKey: string;
      message: string;
      backend: "webgpu" | "wasm";
      usedWorker: boolean;
      chunkedTask?: ChunkedSeparationSummary;
      stems?: SeparatedStemSet;
      durationMs: number;
    }
  | {
      status: "paused";
      taskId: string;
      songId: string;
      generation: number;
      checkpoint?: SeparationCheckpoint;
      message: string;
    }
  | {
      status: "cancelled";
      taskId: string;
      songId: string;
      generation: number;
      message: string;
    }
  | {
      status: "blocked";
      code:
        | "missing_audio"
        | "unauthorized"
        | "lock_unavailable"
        | "foreign_lease"
        | "already_running"
        | "resource_blocked"
        | "network_blocked"
        | "cancelled"
        | "paused"
        | "invalid_checkpoint"
        | "hidden";
      taskId: string;
      songId: string;
      retryable: boolean;
      message: string;
      assessment?: ResourceRiskAssessment;
      networkEvaluation?: NetworkBatchEvaluation;
    }
  | {
      status: "failed";
      taskId: string;
      songId: string;
      generation: number;
      retryable: boolean;
      completedChunks: number;
      totalChunks: number;
      committedBytes: number;
      message: string;
    };

export interface SeparationJobSinkPort {
  startJobController: (options: {
    taskId: string;
    songId: string;
    songName?: string;
    throttleMs?: number;
    cooldownMs?: number;
    onProgress?: (event: SeparationProgressEvent) => void;
  }) => SeparationTaskController;
  updateJob: (
    taskId: string,
    patch: {
      taskId?: string;
      songId?: string;
      songName?: string;
      generation?: number;
      ownerJobToken?: string;
      stage?:
        | "idle"
        | "preparing"
        | "downloading"
        | "processing"
        | "pausing"
        | "paused"
        | "cancelling"
        | "cancelled"
        | "completed"
        | "failed"
        | "interrupted";
      progress?: number;
      message?: string;
      completedChunks?: number;
      totalChunks?: number;
      committedBytes?: number;
    },
    options?: {
      generation?: number;
      ownerJobToken?: string;
      allowRepairOrReset?: boolean;
      source?: string;
    },
  ) => void;
  markControllerSettled: (taskId: string, controller: SeparationTaskController) => void;
  setGlobalFocusActive: (active: boolean, ownerSongId?: string | null) => void;
  syncFromCheckpoint: (taskId: string) => Promise<void>;
  hasRunningHeavyTask: (excludeSongId?: string) => boolean;
}

export interface SeparationJobRunnerDeps {
  leaseManager?: SeparationJobLeaseManager;
  lockAdapter?: WebLockAdapter | null;
  separateAudioFn?: (file: File, options: StemSeparationOptions) => Promise<StemSeparationResult>;
  preflightNetworkFn?: () => Promise<NetworkBatchEvaluation>;
  collectCapabilitiesFn?: () => Promise<DeviceCapabilitiesSnapshot>;
  hashSourceAudioFn?: (blob: Blob) => Promise<string>;
}

/**
 * 獨立的分軌任務執行器（不依賴 BandMixer 元件或任何 React State Closure）。
 * 負責完整生命週期：重建/讀取音訊與 Descriptor -> 取得 Web Lock -> Checkpoint/快取驗證 ->
 * Guard 評估 -> Controller + Worker/Inference -> Chunk 提交 -> 最終歌曲紀錄提交 -> 釋放資源。
 */
export async function runSeparationJob(
  request: StartSeparationJobRequest,
  jobSink: SeparationJobSinkPort,
  deps: SeparationJobRunnerDeps = {},
): Promise<SeparationJobRunOutcome> {
  const leaseManager = deps.leaseManager ?? sharedSeparationLeaseManager;
  const separateAudioFn = deps.separateAudioFn ?? separateAudio;
  const preflightNetworkFn = deps.preflightNetworkFn ?? (() => preflightSeparationNetworkBudget());
  const collectCapabilitiesFn = deps.collectCapabilitiesFn ?? collectDeviceCapabilities;
  const hashSourceAudioFn = deps.hashSourceAudioFn ?? hashSourceAudio;

  const isAutoResume = Boolean(request.isAutoResume);
  const reconstructed = await reconstructJobDescriptor({
    taskId: request.taskId,
    songId: request.songId,
  });

  const transient = getTransientSongAudio(request.songId);
  const audioBlob = request.file ?? transient?.blob ?? reconstructed?.audioBlob ?? null;
  const effectiveSongName =
    request.songName ?? transient?.name ?? reconstructed?.descriptor.songName ?? request.songId;
  const initialTaskId = request.taskId ?? reconstructed?.descriptor.taskId ?? `sep:${request.songId}`;

  if (!audioBlob) {
    return {
      status: "blocked",
      code: "missing_audio",
      taskId: initialTaskId,
      songId: request.songId,
      retryable: false,
      message: "找不到原始音訊檔案，請返回混音器重新匯入或選取原始音檔。",
    };
  }

  let sourceAudioHash =
    request.sourceAudioHash ??
    reconstructed?.descriptor.sourceAudioHash ??
    transient?.sourceAudioHash ??
    "";
  if (!sourceAudioHash) {
    try {
      sourceAudioHash = await hashSourceAudioFn(audioBlob);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "無法計算原始音訊雜湊。";
      return {
        status: "failed",
        taskId: initialTaskId,
        songId: request.songId,
        generation: 0,
        retryable: false,
        completedChunks: 0,
        totalChunks: 0,
        committedBytes: 0,
        message: msg,
      };
    }
  }

  let effectiveMode: StemSeparationMode =
    request.mode ?? reconstructed?.descriptor.requestedMode ?? "four_stem";
  let activeCacheKey = createSeparationCacheKey({
    sourceAudioHash,
    modelVersion: DEMUCS_MODEL_VERSION,
    separationMode: effectiveMode,
    processingVersion: SEPARATION_PROCESSING_VERSION,
  });

  const checkpointTaskId =
    request.taskId ||
    reconstructed?.checkpoint?.taskId ||
    reconstructed?.songRecord?.separationTaskId ||
    createCheckpointTaskId(
      request.songId,
      sourceAudioHash,
      DEMUCS_MODEL_VERSION,
      SEPARATION_PROCESSING_VERSION,
    );

  if (isAutoResume) {
    const authorized = Boolean(
      request.userAuthorized ??
        reconstructed?.checkpoint?.userAuthorized ??
        reconstructed?.songRecord?.separationUserAuthorized,
    );
    if (!authorized) {
      return {
        status: "blocked",
        code: "unauthorized",
        taskId: checkpointTaskId,
        songId: request.songId,
        retryable: false,
        message: "此分離任務尚未取得使用者明確授權，需手動點擊繼續。",
      };
    }
  }

  const audioFile = toAudioFileLike(
    audioBlob,
    request.fileName ?? reconstructed?.descriptor.fileName ?? `${effectiveSongName}.wav`,
    request.mimeType ?? reconstructed?.descriptor.mimeType ?? "audio/wav",
  );
  const effectiveDurationSec =
    request.durationSec ?? reconstructed?.descriptor.durationSec ?? 0;

  // 整個排他臨界區全程由任務級 Web Lock 保護（無巢狀 Lock），避免其他分頁建立第二個 Worker。
  const lockOutcome = await leaseManager.withTaskLock<SeparationJobRunOutcome>(
    checkpointTaskId,
    async () => {
      const tabId = getOrCreateTabId();

      const existingValidation = request.forceRecompute
        ? null
        : await verifyAuthoritativeCheckpoint(
            {
              id: request.songId,
              sourceAudioHash,
              separationTaskId: checkpointTaskId,
            },
            true,
          );

      // 1) 若本機已有驗證完整的 Chunk Checkpoint，零重算提交完成
      if (isValidationCompleted(existingValidation) && existingValidation?.checkpoint) {
        const resolvedCp = existingValidation.checkpoint;
        await addCheckpointReference({
          taskId: resolvedCp.taskId,
          songId: request.songId,
          mode: effectiveMode,
          source: "separationJobRunner.alreadyCompleted",
        }).catch(() => undefined);
        const msg =
          effectiveMode === "two_stem"
            ? "已從既有 4 軌分段 Checkpoint 即時合成 2 Stem（零 AI 重算與網路下載）。"
            : `已從本機分段 Checkpoint 驗證並載入完整分軌（共 ${existingValidation.totalChunks} 段按需播放）。`;
        await patchPersistedSongSeparationFields(request.songId, {
          separationMode: effectiveMode,
          separationStatus: "completed",
          separationTaskId: resolvedCp.taskId,
          separationCompletedChunks: resolvedCp.totalChunks,
          separationTotalChunks: resolvedCp.totalChunks,
          separationCommittedBytes: resolvedCp.committedBytes,
          separationUserAuthorized: true,
          cacheKey: activeCacheKey,
          playbackSource: "stems",
          ensureStemRoles: stemRolesForMode(effectiveMode),
        }).catch(() => undefined);
        jobSink.updateJob(
          resolvedCp.taskId,
          {
            taskId: resolvedCp.taskId,
            songId: request.songId,
            songName: effectiveSongName,
            stage: "completed",
            progress: 1,
            completedChunks: resolvedCp.totalChunks,
            totalChunks: resolvedCp.totalChunks,
            committedBytes: resolvedCp.committedBytes,
            message: msg,
          },
          { allowRepairOrReset: true, source: "runner.alreadyCompleted" },
        );
        leaseManager.notifyTaskCompleted(resolvedCp.taskId, tabId, resolvedCp.lease?.generation);
        return {
          status: "completed",
          taskId: resolvedCp.taskId,
          songId: request.songId,
          generation: resolvedCp.lease?.generation ?? 1,
          mode: effectiveMode,
          cacheKey: activeCacheKey,
          message: msg,
          backend: "wasm",
          usedWorker: false,
          chunkedTask: {
            taskId: resolvedCp.taskId,
            mode: effectiveMode,
            sampleRate: resolvedCp.sampleRate,
            totalSamples: resolvedCp.totalSamples,
            totalChunks: resolvedCp.totalChunks,
            committedBytes: resolvedCp.committedBytes,
            durationSeconds:
              resolvedCp.sampleRate > 0 ? resolvedCp.totalSamples / resolvedCp.sampleRate : 0,
          },
          durationMs: 0,
        };
      }

      // 2) 若已有非分段快速快取，優先復用或衍生 2-Stem
      let preCached: SeparatedStemSet | null = null;
      let preCachedMessage = "已從本機快取載入分離結果。";
      if (!request.forceRecompute) {
        if (request.inMemoryStems?.mode === effectiveMode) {
          preCached = request.inMemoryStems;
        } else {
          preCached = await getCachedStemSet(activeCacheKey).catch(() => null);
        }
        if (!preCached && effectiveMode === "two_stem") {
          const fourStemCacheKey = createSeparationCacheKey({
            sourceAudioHash,
            modelVersion: DEMUCS_MODEL_VERSION,
            separationMode: "four_stem",
            processingVersion: SEPARATION_PROCESSING_VERSION,
          });
          const existingFourStem =
            request.inMemoryStems?.mode === "four_stem"
              ? request.inMemoryStems
              : await getCachedStemSet(fourStemCacheKey).catch(() => null);
          const derivedTwoStem = existingFourStem
            ? deriveTwoStemFromFourStemSet(existingFourStem)
            : null;
          if (derivedTwoStem) {
            preCached = derivedTwoStem;
            preCachedMessage = "已直接從既有 4 Stem 本機結果合成 2 Stem（零 AI 重算與網路下載）。";
            await putCachedStemSet(
              createStemCacheRecord({
                key: activeCacheKey,
                sourceAudioHash,
                modelVersion: DEMUCS_MODEL_VERSION,
                processingVersion: SEPARATION_PROCESSING_VERSION,
                stems: derivedTwoStem,
              }),
            ).catch(() => undefined);
          }
        }
      }

      // 3) 檢查裝置資源與網路預算 Guard（不繞過資源限制）
      const cap = await collectCapabilitiesFn();
      const perfSignals = sharedPerfTelemetry.getSignals();
      const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
      let maxThreads = request.maxThreads ?? profileEval.profile.maxWasmThreads;

      const backgroundInMemoryBytes = Math.max(
        0,
        (request.inMemoryAudioBytes ?? 0) - estimateStereoPcmBytesLocal(effectiveDurationSec),
      );
      const footprint = preCached
        ? { estimatedMemoryBytes: 0, estimatedStorageBytes: 0 }
        : sharedResourceProfileManager
          ? undefined
          : undefined;
      void footprint;

      if (!preCached) {
        const networkEval = await preflightNetworkFn();
        const assessment = assessResourceRisk({
          operation: "separate",
          songName: effectiveSongName,
          fileSizeBytes: request.fileSizeBytes ?? audioFile.size,
          durationSec: effectiveDurationSec,
          mimeType: audioFile.type,
          separationMode: effectiveMode,
          activeSongCount: request.activeSongCount ?? 1,
          playingSongCount: request.playingSongCount ?? 0,
          activeSoundTouchTracks: request.activeSoundTouchTracks ?? 0,
          runningDemucsCount: jobSink.hasRunningHeavyTask(request.songId) ? 1 : 0,
          estimatedInMemoryAudioBytes: backgroundInMemoryBytes,
          hasOtherIdleDecodedSongs: Boolean(request.hasOtherIdleDecodedSongs),
          profile: profileEval.profile,
          capabilities: cap,
          performanceSignals: perfSignals,
        });

        const networkBlocked = !networkEval.allowed || networkEval.requiresExternalDownloadConfirmation;
        if (isAutoResume) {
          const eligibility = evaluateAutoResumeEligibility({
            checkpoint: existingValidation?.checkpoint ?? reconstructed?.checkpoint ?? null,
            validation:
              existingValidation ?? {
                valid: false,
                action: "blocked",
                resumeFromChunkIndex: 0,
                totalChunks: 0,
                validChunkCount: 0,
                repairedChunksDeleted: 0,
                needsOverlapWarmup: false,
                checkpoint: null,
              },
            tabId,
            isDocumentHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
            hasActiveLocalDemucsTask: jobSink.hasRunningHeavyTask(request.songId),
            taskAdmission: assessment.admission,
            networkBudgetAllowed: networkEval.allowed && !networkEval.requiresExternalDownloadConfirmation,
            networkBudgetReason: networkEval.message,
          });
          if (!eligibility.allowed) {
            const retryable =
              eligibility.code === "resource_blocked" ||
              eligibility.code === "hidden" ||
              eligibility.code === "foreign_lease" ||
              eligibility.code === "already_running";
            return {
              status: "blocked",
              code:
                eligibility.code === "foreign_lease"
                  ? "foreign_lease"
                  : eligibility.code === "resource_blocked"
                    ? "resource_blocked"
                    : eligibility.code === "network_blocked"
                      ? "network_blocked"
                      : eligibility.code === "unauthorized"
                        ? "unauthorized"
                        : eligibility.code === "cancelled"
                          ? "cancelled"
                          : eligibility.code === "paused"
                            ? "paused"
                            : eligibility.code === "hidden"
                              ? "hidden"
                              : "invalid_checkpoint",
              taskId: checkpointTaskId,
              songId: request.songId,
              retryable,
              message: eligibility.reason ?? "目前環境尚未符合自動續跑條件。",
              assessment,
              networkEvaluation: networkEval,
            };
          }
        } else if (!request.guardAlreadyConfirmed) {
          if (assessment.admission.hardRejected || networkBlocked) {
            return {
              status: "blocked",
              code: networkBlocked ? "network_blocked" : "resource_blocked",
              taskId: checkpointTaskId,
              songId: request.songId,
              retryable: false,
              message: networkBlocked
                ? networkEval.message
                : (assessment.admission.message || "裝置資源不足，無法安全啟動音軌分離。"),
              assessment,
              networkEvaluation: networkEval,
            };
          }
        } else if (assessment.admission.hardRejected || !networkEval.allowed) {
          return {
            status: "blocked",
            code: !networkEval.allowed ? "network_blocked" : "resource_blocked",
            taskId: checkpointTaskId,
            songId: request.songId,
            retryable: false,
            message: !networkEval.allowed ? networkEval.message : assessment.admission.message,
          };
        }

        // 若目標 Checkpoint 目前正被其他分頁持有有效 Lease，阻擋啟動第二個 Worker
        const targetCp = existingValidation?.checkpoint ?? reconstructed?.checkpoint;
        if (
          targetCp?.lease &&
          targetCp.lease.ownerTabId !== tabId &&
          isCheckpointLeaseActive(targetCp)
        ) {
          await jobSink.syncFromCheckpoint(checkpointTaskId);
          return {
            status: "blocked",
            code: "foreign_lease",
            taskId: checkpointTaskId,
            songId: request.songId,
            retryable: true,
            message: `另一個分頁（${targetCp.lease.ownerTabId.slice(0, 8)}）正持有有效執行鎖，略過重複分離。`,
          };
        }
      }

      // 4) 建立全域 Task Controller，確保整個生命週期可在任何路由完成
      if (request.forceRecompute) {
        jobSink.updateJob(
          checkpointTaskId,
          {
            taskId: checkpointTaskId,
            songId: request.songId,
            songName: effectiveSongName,
            stage: "preparing",
            progress: 0.01,
            completedChunks: 0,
            totalChunks: 0,
            committedBytes: 0,
            message: "準備重新分離音軌…",
          },
          { allowRepairOrReset: true, source: "runner.forceRecomputeReset" },
        );
      }
      let controller: SeparationTaskController;
      try {
        controller = jobSink.startJobController({
          taskId: checkpointTaskId,
          songId: request.songId,
          songName: effectiveSongName,
          throttleMs: 180,
          cooldownMs: 80,
          onProgress: (event) => {
            // 注意：completed 事件只能於資料最終提交後明確觸發，不可由進度回呼直接轉入 completed
            if (event.stage === "completed") return;
            jobSink.updateJob(
              checkpointTaskId,
              {
                generation: event.generation,
                stage: event.stage,
                progress: Math.min(0.99, event.progress),
                message: event.message,
                completedChunks: event.details?.currentSegment,
                totalChunks: event.details?.totalSegments,
                committedBytes: event.details?.committedBytes,
              },
              { generation: event.generation, source: "runner.controllerProgress" },
            );
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "目前無法啟動分離任務。";
        return {
          status: "failed",
          taskId: checkpointTaskId,
          songId: request.songId,
          generation: 0,
          retryable: false,
          completedChunks: 0,
          totalChunks: 0,
          committedBytes: 0,
          message: msg,
        };
      }

      const focusDecision = preCached
        ? { enabled: false, reasons: [] as string[] }
        : shouldEnterSeparationFocusMode({
            profile: profileEval.profile,
            performanceSignals: perfSignals,
            estimatedSeparationMemoryBytes: 0,
            inMemoryAudioBytes: backgroundInMemoryBytes,
            activeSoundTouchTracks: request.activeSoundTouchTracks ?? 0,
            userSelectedPausePlayback: request.userSelectedPausePlayback,
          });
      if (focusDecision.enabled || !preCached) {
        jobSink.setGlobalFocusActive(true, request.songId);
      }

      let lastPersistedChunkCount = -1;
      let latestCommittedTaskId = checkpointTaskId;
      let persistChain: Promise<unknown> = Promise.resolve();

      const enqueueSongSeparationPatch = (
        patch: Parameters<typeof patchPersistedSongSeparationFields>[1],
      ) => {
        const next = persistChain
          .then(() => patchPersistedSongSeparationFields(request.songId, patch))
          .catch(() => null);
        persistChain = next;
        return next;
      };

      try {
        let stems: SeparatedStemSet | null = preCached;
        let chunkedSummary: ChunkedSeparationSummary | undefined;
        let resultBackend: "webgpu" | "wasm" = "wasm";
        let usedWorker = false;
        let finalMessage = preCachedMessage;

        if (!stems) {
          void enqueueSongSeparationPatch({
            separationMode: effectiveMode,
            separationStatus: "processing",
            separationTaskId: checkpointTaskId,
            separationUserAuthorized: true,
          });

          const sepResult = await separateAudioFn(audioFile, {
            mode: effectiveMode,
            controller,
            songId: request.songId,
            sourceAudioHash,
            checkpointTaskId,
            userAuthorized: true,
            forceRecompute: request.forceRecompute,
            knownInMemorySongs: request.knownInMemorySongs,
            maxThreads,
            onChunkCommitted: ({ checkpoint: committedCp, chunkIndex, totalChunks }) => {
              latestCommittedTaskId = committedCp.taskId;
              const allChunksCommittedNow = totalChunks > 0 && committedCp.nextChunkIndex >= totalChunks;
              // 嚴格區分「所有 Chunk 已寫入」與「最終歌曲紀錄/快取提交完成」：
              // 提交尚未收尾前，stage 維持 processing，進度上限 0.99，絕不提前發出 completed！
              const progressPct = totalChunks > 0
                ? Math.min(0.99, (chunkIndex + 1) / totalChunks)
                : 0;
              const chunkMessage = allChunksCommittedNow
                ? `已完成第 ${committedCp.nextChunkIndex} / ${totalChunks} 段推論，正在進行最終資料提交…`
                : `正在分離並提交第 ${chunkIndex + 1} / ${totalChunks} 段…`;

              jobSink.updateJob(
                checkpointTaskId,
                {
                  taskId: checkpointTaskId,
                  songId: request.songId,
                  songName: effectiveSongName,
                  generation: controller.generation,
                  stage: "processing",
                  progress: progressPct,
                  completedChunks: committedCp.nextChunkIndex,
                  totalChunks,
                  committedBytes: committedCp.committedBytes,
                  message: chunkMessage,
                },
                {
                  generation: controller.generation,
                  allowRepairOrReset: Boolean(request.forceRecompute && chunkIndex === 0),
                  source: "runner.onChunkCommitted",
                },
              );

              leaseManager.notifyTaskProgress({
                taskId: committedCp.taskId,
                ownerTabId: tabId,
                generation: committedCp.lease?.generation ?? controller.generation,
                completedChunks: committedCp.nextChunkIndex,
                totalChunks,
                committedBytes: committedCp.committedBytes,
                message: chunkMessage,
              });

              if (committedCp.nextChunkIndex > lastPersistedChunkCount) {
                lastPersistedChunkCount = committedCp.nextChunkIndex;
                void enqueueSongSeparationPatch({
                  separationTaskId: committedCp.taskId,
                  separationMode: effectiveMode,
                  separationStatus: "processing",
                  separationCompletedChunks: committedCp.nextChunkIndex,
                  separationTotalChunks: totalChunks,
                  separationCommittedBytes: committedCp.committedBytes,
                  separationUserAuthorized: true,
                });
              }
            },
          });

          sharedPerfTelemetry.recordSeparationDuration(sepResult.durationMs);
          resultBackend = sepResult.backend;
          usedWorker = sepResult.usedWorker;

          if (sepResult.paused) {
            const cp = sepResult.checkpoint;
            const completedChunks = cp?.nextChunkIndex ?? 0;
            const totalChunks = cp?.totalChunks ?? 0;
            const pausedMsg =
              completedChunks > 0
                ? `已於第 ${completedChunks}/${totalChunks} 段安全暫停，隨時可接續。`
                : "已暫停分離，尚未完成第 1 段，可重新開始分離。";
            await enqueueSongSeparationPatch({
              separationStatus: "paused",
              separationMode: effectiveMode,
              separationTaskId: cp?.taskId ?? checkpointTaskId,
              separationCompletedChunks: completedChunks,
              separationTotalChunks: totalChunks,
              separationCommittedBytes: completedChunks > 0 ? (cp?.committedBytes ?? 0) : 0,
              separationUserAuthorized: true,
            });
            controller.markPaused(pausedMsg);
            jobSink.updateJob(
              cp?.taskId ?? checkpointTaskId,
              {
                generation: controller.generation,
                stage: "paused",
                progress: totalChunks > 0 ? completedChunks / totalChunks : 0,
                completedChunks,
                totalChunks,
                committedBytes: completedChunks > 0 ? (cp?.committedBytes ?? 0) : 0,
                message: pausedMsg,
              },
              { generation: controller.generation, source: "runner.paused" },
            );
            return {
              status: "paused",
              taskId: cp?.taskId ?? checkpointTaskId,
              songId: request.songId,
              generation: controller.generation,
              checkpoint: cp,
              message: pausedMsg,
            };
          }

          controller.throwIfAborted();
          if (sepResult.chunkedTask) {
            chunkedSummary = sepResult.chunkedTask;
            latestCommittedTaskId = chunkedSummary.taskId;
            finalMessage = `分段分離完成（${sepResult.backend === "webgpu" ? "WebGPU" : "WASM"}${sepResult.usedWorker ? " · Worker" : ""}，共 ${sepResult.chunkedTask.totalChunks} 段按需播放）。`;
          } else if (sepResult.stems) {
            stems = sepResult.stems;
            finalMessage = `分離完成（${sepResult.backend === "webgpu" ? "WebGPU" : "WASM"}${sepResult.usedWorker ? " · Worker" : ""}）。`;
            try {
              controller.throwIfAborted();
              await putCachedStemSet(
                createStemCacheRecord({
                  key: activeCacheKey,
                  sourceAudioHash,
                  modelVersion: DEMUCS_MODEL_VERSION,
                  processingVersion: SEPARATION_PROCESSING_VERSION,
                  stems,
                }),
              );
            } catch (cacheError) {
              if (isAbortError(cacheError)) throw cacheError;
              finalMessage += ` ${cacheError instanceof Error ? cacheError.message : "結果無法持久快取。"}`;
            }
          }
        }

        controller.throwIfAborted();

        // 5) 最終結果提交：僅更新歌曲分離欄位，完整保留使用者編輯中的 BPM/Key/Volume/Loop 設定
        const committedTotalChunks = chunkedSummary?.totalChunks ?? 0;
        const committedBytes = chunkedSummary?.committedBytes ?? 0;
        await enqueueSongSeparationPatch({
          separationMode: effectiveMode,
          separationStatus: "completed",
          separationTaskId: chunkedSummary?.taskId ?? latestCommittedTaskId,
          separationCompletedChunks: committedTotalChunks,
          separationTotalChunks: committedTotalChunks,
          separationCommittedBytes: committedBytes,
          separationUserAuthorized: true,
          cacheKey: activeCacheKey,
          playbackSource: "stems",
          ensureStemRoles: stemRolesForMode(effectiveMode),
        });

        if (
          request.forceRecompute &&
          request.previousCompletedTaskId &&
          (chunkedSummary?.taskId ?? latestCommittedTaskId) !== request.previousCompletedTaskId
        ) {
          void releaseCheckpointReferenceAndMaybeGc({
            taskId: request.previousCompletedTaskId,
            sourceAudioHash,
            songId: request.songId,
            cacheKeyToRelease:
              request.previousCacheKey && request.previousCacheKey !== activeCacheKey
                ? request.previousCacheKey
                : null,
            knownInMemorySongs: request.knownInMemorySongs,
            knownRemovedSongIds: request.knownRemovedSongIds,
            source: "separationJobRunner.recomputeSwitchCleanup",
          }).catch(() => undefined);
        }

        // 6) 最終提交完成後才宣布 completed（先停 controller 再更新 job）
        controller.markCompleted(finalMessage);
        jobSink.updateJob(
          checkpointTaskId,
          {
            taskId: checkpointTaskId,
            songId: request.songId,
            songName: effectiveSongName,
            generation: controller.generation,
            stage: "completed",
            progress: 1,
            completedChunks: committedTotalChunks,
            totalChunks: committedTotalChunks,
            committedBytes,
            message: finalMessage,
          },
          { generation: controller.generation, source: "runner.completed" },
        );
        leaseManager.notifyTaskCompleted(
          chunkedSummary?.taskId ?? latestCommittedTaskId,
          tabId,
          controller.generation,
        );

        return {
          status: "completed",
          taskId: chunkedSummary?.taskId ?? latestCommittedTaskId,
          songId: request.songId,
          generation: controller.generation,
          mode: effectiveMode,
          cacheKey: activeCacheKey,
          message: finalMessage,
          backend: resultBackend,
          usedWorker,
          chunkedTask: chunkedSummary,
          stems: stems ?? undefined,
          durationMs: 0,
        };
      } catch (error) {
        // 任何異常或競態前先確認權威 IndexedDB Checkpoint 是否已全部寫完
        const idbValidation = request.forceRecompute
          ? null
          : await verifyAuthoritativeCheckpoint(
              {
                id: request.songId,
                sourceAudioHash,
                separationTaskId: latestCommittedTaskId,
              },
              true,
            ).catch(() => null);

        if (isValidationCompleted(idbValidation) && idbValidation?.checkpoint) {
          const doneCp = idbValidation.checkpoint;
          const recoveredMsg = `分段分離完成（共 ${doneCp.totalChunks} 段按需播放）。`;
          recordSeparationDiagnostic({
            source: "separationJobRunner.catch",
            songId: request.songId,
            taskId: doneCp.taskId,
            generation: controller.generation,
            checkpointStatus: doneCp.status,
            validChunkCount: idbValidation.validChunkCount,
            totalChunks: idbValidation.totalChunks,
            fromState: "completed",
            toState: "completed",
            note: "recovered completed state in runner catch from authoritative IDB",
          });
          await enqueueSongSeparationPatch({
            separationMode: effectiveMode,
            separationStatus: "completed",
            separationTaskId: doneCp.taskId,
            separationCompletedChunks: doneCp.totalChunks,
            separationTotalChunks: doneCp.totalChunks,
            separationCommittedBytes: doneCp.committedBytes,
            separationUserAuthorized: true,
            cacheKey: activeCacheKey,
            playbackSource: "stems",
            ensureStemRoles: stemRolesForMode(effectiveMode),
          });
          controller.markCompleted(recoveredMsg);
          jobSink.updateJob(
            checkpointTaskId,
            {
              taskId: checkpointTaskId,
              songId: request.songId,
              songName: effectiveSongName,
              generation: controller.generation,
              stage: "completed",
              progress: 1,
              completedChunks: doneCp.totalChunks,
              totalChunks: doneCp.totalChunks,
              committedBytes: doneCp.committedBytes,
              message: recoveredMsg,
            },
            { generation: controller.generation, source: "runner.catchCompletedRecovery" },
          );
          return {
            status: "completed",
            taskId: doneCp.taskId,
            songId: request.songId,
            generation: controller.generation,
            mode: effectiveMode,
            cacheKey: activeCacheKey,
            message: recoveredMsg,
            backend: "wasm",
            usedWorker: false,
            chunkedTask: {
              taskId: doneCp.taskId,
              mode: effectiveMode,
              sampleRate: doneCp.sampleRate,
              totalSamples: doneCp.totalSamples,
              totalChunks: doneCp.totalChunks,
              committedBytes: doneCp.committedBytes,
              durationSeconds:
                doneCp.sampleRate > 0 ? doneCp.totalSamples / doneCp.sampleRate : 0,
            },
            durationMs: 0,
          };
        }

        if (isAbortError(error) || controller.isCancellingOrCancelled()) {
          const cancelMsg = "已中止音軌分離，已恢復操作前穩定狀態。";
          await controller.cancel(cancelMsg);
          await enqueueSongSeparationPatch({
            separationStatus: "cancelled",
            separationUserAuthorized: false,
          });
          jobSink.updateJob(
            checkpointTaskId,
            {
              generation: controller.generation,
              stage: "cancelled",
              progress: 0,
              message: cancelMsg,
            },
            { generation: controller.generation, source: "runner.cancelled" },
          );
          return {
            status: "cancelled",
            taskId: checkpointTaskId,
            songId: request.songId,
            generation: controller.generation,
            message: cancelMsg,
          };
        }

        if (isPauseError(error) || controller.isPausingOrPaused()) {
          const validChunks = idbValidation?.validChunkCount ?? 0;
          const totalChunks = idbValidation?.totalChunks ?? 0;
          const pauseMsg = "已於安全 Chunk 邊界暫停分離，已完成進度已保留。";
          await enqueueSongSeparationPatch({
            separationStatus: "paused",
            separationTaskId: idbValidation?.checkpoint?.taskId ?? checkpointTaskId,
            separationCompletedChunks: validChunks,
            separationTotalChunks: totalChunks,
            separationCommittedBytes: idbValidation?.checkpoint?.committedBytes ?? 0,
            separationUserAuthorized: true,
          });
          controller.markPaused(pauseMsg);
          jobSink.updateJob(
            checkpointTaskId,
            {
              generation: controller.generation,
              stage: "paused",
              progress: totalChunks > 0 ? validChunks / totalChunks : 0,
              completedChunks: validChunks,
              totalChunks,
              committedBytes: idbValidation?.checkpoint?.committedBytes ?? 0,
              message: pauseMsg,
            },
            { generation: controller.generation, source: "runner.paused" },
          );
          return {
            status: "paused",
            taskId: idbValidation?.checkpoint?.taskId ?? checkpointTaskId,
            songId: request.songId,
            generation: controller.generation,
            checkpoint: idbValidation?.checkpoint ?? undefined,
            message: pauseMsg,
          };
        }

        const errMsg = error instanceof Error ? error.message : "音軌分離失敗。";
        const validChunks = idbValidation?.validChunkCount ?? 0;
        const totalChunks = idbValidation?.totalChunks ?? 0;
        const committedBytes = validChunks > 0 ? (idbValidation?.checkpoint?.committedBytes ?? 0) : 0;
        const nextPersistedStatus: SeparationStatus =
          isAutoResume && validChunks > 0 && !isNonRetryableSeparationError(error)
            ? "interrupted"
            : "failed";
        const nextJobStage = nextPersistedStatus === "interrupted" ? "interrupted" : "failed";

        controller.markFailed(errMsg);
        await enqueueSongSeparationPatch({
          separationStatus: nextPersistedStatus,
          separationTaskId: idbValidation?.checkpoint?.taskId ?? checkpointTaskId,
          separationCompletedChunks: validChunks,
          separationTotalChunks: totalChunks,
          separationCommittedBytes: committedBytes,
        });
        jobSink.updateJob(
          checkpointTaskId,
          {
            generation: controller.generation,
            stage: nextJobStage,
            progress: totalChunks > 0 ? validChunks / totalChunks : 0,
            completedChunks: validChunks,
            totalChunks,
            committedBytes,
            message: errMsg,
          },
          { generation: controller.generation, source: "runner.failed" },
        );
        leaseManager.notifyTaskFailed(
          checkpointTaskId,
          tabId,
          controller.generation,
          errMsg,
        );

        return {
          status: "failed",
          taskId: checkpointTaskId,
          songId: request.songId,
          generation: controller.generation,
          retryable: !isNonRetryableSeparationError(error),
          completedChunks: validChunks,
          totalChunks,
          committedBytes,
          message: errMsg,
        };
      } finally {
        await persistChain.catch(() => undefined);
        jobSink.markControllerSettled(checkpointTaskId, controller);
        jobSink.setGlobalFocusActive(false, request.songId);
        // 僅在沒有活躍任務時釋放模型/Worker；絕不依賴特定 React 元件卸載才釋放資源
        if (!isSeparatorWorkerActive() && !jobSink.hasRunningHeavyTask()) {
          await disposeStemSeparator({ revokeModelUrl: false }).catch(() => undefined);
        }
      }
    },
    deps.lockAdapter,
  );

  if (!lockOutcome.acquired) {
    // 取得 Web Lock 失敗代表其他分頁正執行此任務；不得將歌曲標記為 failed！
    await jobSink.syncFromCheckpoint(checkpointTaskId).catch(() => undefined);
    return {
      status: "blocked",
      code: "lock_unavailable",
      taskId: checkpointTaskId,
      songId: request.songId,
      retryable: true,
      message: "另一個分頁正持有此分離任務的 Web Lock，未建立第二個 Worker。",
    };
  }

  return lockOutcome.value;
}
