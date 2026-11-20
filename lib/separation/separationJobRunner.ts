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
  createIsolatedRecomputeTaskId,
  findCompletedCheckpointBySourceAudioHash,
  findLatestCheckpointBySourceAudioHash,
  getCheckpoint,
  isCheckpointLeaseActive,
  releaseCheckpointReferenceAndMaybeGc,
} from "../storage/separationCheckpointStore.ts";
import {
  type SeparationCommitResult,
  commitPersistedSongSeparationFinalization,
  getPersistedAudioBlobByKey,
  getPersistedSongRecord,
  isQuotaExceededError,
  patchPersistedSongSeparationFields,
} from "../storage/songSessionStore.ts";
import {
  commitProjectEntrySeparationArtifact,
  getProjectRecord,
  isProjectDeleted,
} from "../storage/projectStore.ts";
import { idbRequestPromise, withIdbTransaction } from "../storage/indexedDb.ts";
import { DEMUCS_SAMPLE_RATE, getTaskChunkKeysInStore } from "../storage/separationChunkStore.ts";
import {
  DEFAULT_JOB_LEASE_TTL_MS,
  type ResumeValidationResult,
  type SeparationJobLeaseManager,
  type WebLockAdapter,
  createJobToken,
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
  projectId?: string | null;
  entryId?: string | null;
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
    projectId: checkpoint?.projectId ?? null,
    entryId: checkpoint?.entryId ?? resolvedSongId,
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
  projectId?: string | null;
  entryId?: string | null;
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
  onlyFinalize?: boolean;
  forceRecompute?: boolean;
  preferredExecutionFence?: {
    generation: number;
    ownerJobToken: string;
    ownerTabId: string;
  } | null;
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

export type SeparationJobFailureCode =
  | "quota_exceeded"
  | "transient_storage_error"
  | "song_missing"
  | "stale_generation"
  | "source_mismatch"
  | "transition_rejected"
  | "inference_error"
  | "missing_audio";

export type SeparationJobRunOutcome =
  | {
      status: "completed";
      taskId: string;
      songId: string;
      generation: number;
      ownerJobToken?: string;
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
      retryPhase?: "inference" | "finalization";
      failureCode?: SeparationJobFailureCode;
      completedChunks: number;
      totalChunks: number;
      committedBytes: number;
      message: string;
    };

export interface SeparationJobSinkPort {
  startJobController: (options: {
    taskId: string;
    songId: string;
    projectId?: string | null;
    entryId?: string | null;
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
      projectId?: string | null;
      entryId?: string | null;
      songName?: string;
      requestedMode?: StemSeparationMode;
      generation?: number;
      ownerJobToken?: string;
      ownerTabId?: string;
      isForeignActive?: boolean;
      retryPhase?: "inference" | "finalization";
      retryWaitReason?:
        | "backoff"
        | "document_hidden"
        | "local_task_running"
        | "foreign_lock"
        | "foreign_lease"
        | "resource_unavailable"
        | "storage_unavailable"
        | "manual_action_required";
      isActivelyFinalizing?: boolean;
      requiresManualAction?: boolean;
      autoResumeExhausted?: boolean;
      stage?:
        | "idle"
        | "preparing"
        | "downloading"
        | "processing"
        | "finalizing"
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
      isAuthoritativeCheckpointRepair?: boolean;
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
  const onlyFinalize = Boolean(request.onlyFinalize);
  const reconstructed = await reconstructJobDescriptor({
    taskId: request.taskId,
    songId: request.songId,
  });

  const effectiveProjectId =
    request.projectId !== undefined
      ? request.projectId
      : (reconstructed?.descriptor.projectId ?? null);
  const effectiveEntryId =
    request.entryId !== undefined
      ? request.entryId
      : (reconstructed?.descriptor.entryId ?? request.songId);

  const transient = getTransientSongAudio(request.songId);
  const audioBlob = request.file ?? transient?.blob ?? reconstructed?.audioBlob ?? null;
  const effectiveSongName =
    request.songName ?? transient?.name ?? reconstructed?.descriptor.songName ?? request.songId;
  const initialTaskId = request.taskId ?? reconstructed?.descriptor.taskId ?? `sep:${request.songId}`;

  let sourceAudioHash =
    request.sourceAudioHash ??
    reconstructed?.descriptor.sourceAudioHash ??
    transient?.sourceAudioHash ??
    "";
  if (!sourceAudioHash) {
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
        failureCode: "inference_error",
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

  const baseCheckpointTaskId =
    request.taskId ||
    reconstructed?.checkpoint?.taskId ||
    reconstructed?.songRecord?.separationTaskId ||
    createCheckpointTaskId(
      request.songId,
      sourceAudioHash,
      DEMUCS_MODEL_VERSION,
      SEPARATION_PROCESSING_VERSION,
    );

  const effectivePreviousCompletedTaskId =
    request.previousCompletedTaskId ??
    (reconstructed?.songRecord?.separationStatus === "completed"
      ? (reconstructed.songRecord.separationTaskId ?? null)
      : null);

  let checkpointTaskId = baseCheckpointTaskId;
  if (request.forceRecompute && !onlyFinalize) {
    const reqCp = request.taskId ? await getCheckpoint(request.taskId).catch(() => null) : null;
    const isResumingIncompleteIsolatedTask = Boolean(
      request.taskId &&
        request.taskId.includes(":r") &&
        reqCp &&
        reqCp.status !== "completed" &&
        reqCp.taskId === request.taskId,
    );
    if (!isResumingIncompleteIsolatedTask) {
      const existingBaseCp = await getCheckpoint(baseCheckpointTaskId).catch(() => null);
      if (
        existingBaseCp?.status === "completed" ||
        reconstructed?.songRecord?.separationStatus === "completed"
      ) {
        checkpointTaskId = createIsolatedRecomputeTaskId(request.songId, sourceAudioHash);
      }
    }
  }

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

  const effectiveDurationSec =
    request.durationSec ?? reconstructed?.descriptor.durationSec ?? 0;

  // 整個排他臨界區全程由任務級 Web Lock 保護（無巢狀 Lock），避免其他分頁建立第二個 Worker。
  const lockOutcome = await leaseManager.withTaskLock<SeparationJobRunOutcome>(
    checkpointTaskId,
    async () => {
      const tabId = getOrCreateTabId();

      const updateActiveCacheKey = (mode: StemSeparationMode) => {
        activeCacheKey = createSeparationCacheKey({
          sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: mode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
        return activeCacheKey;
      };

      // 統一最終提交協定：所有完成路徑（正常推論、既有完成 Checkpoint、4->2 軌、快取、強制重算、catch 恢復、自動/手動重試保存）一律經過此函式
      const performAuthoritativeFinalization = async (params: {
        finalTaskId: string;
        mode: StemSeparationMode;
        totalChunks: number;
        committedBytes: number;
        chunkedSummary?: ChunkedSeparationSummary;
        stems?: SeparatedStemSet | null;
        finalMessage: string;
        backend: "webgpu" | "wasm";
        usedWorker: boolean;
        controller: SeparationTaskController | null;
        executionFence?: {
          generation: number;
          ownerJobToken: string;
          ownerTabId: string;
        } | null;
        allowReplaceCompleted: boolean;
        sourceTag: string;
      }): Promise<SeparationJobRunOutcome> => {
        const {
          finalTaskId,
          mode,
          totalChunks,
          committedBytes,
          chunkedSummary,
          stems,
          finalMessage,
          backend,
          usedWorker,
          controller,
          allowReplaceCompleted,
          sourceTag,
        } = params;
        const cacheKey = updateActiveCacheKey(mode);

        // 1) 尊重使用者取消／暫停意圖：最終提交尚未成功前不得繞過取消／暫停
        if (controller?.isCancellingOrCancelled()) {
          const cancelMsg = "已中止音軌分離，已恢復操作前穩定狀態。";
          await controller.cancel(cancelMsg);
          jobSink.updateJob(
            finalTaskId,
            {
              taskId: finalTaskId,
              songId: request.songId,
              songName: effectiveSongName,
              generation: controller.generation,
              stage: "cancelled",
              isActivelyFinalizing: false,
              progress: 0,
              message: cancelMsg,
            },
            { generation: controller.generation, source: `${sourceTag}.cancelled` },
          );
          return {
            status: "cancelled",
            taskId: finalTaskId,
            songId: request.songId,
            generation: controller.generation,
            message: cancelMsg,
          };
        }

        if (controller?.isPausingOrPaused()) {
          const pauseMsg = "已於安全 Chunk 邊界暫停分離，已完成進度已保留。";
          controller.markPaused(pauseMsg);
          jobSink.updateJob(
            finalTaskId,
            {
              taskId: finalTaskId,
              songId: request.songId,
              songName: effectiveSongName,
              generation: controller.generation,
              stage: "paused",
              isActivelyFinalizing: false,
              progress: totalChunks > 0 ? Math.min(0.99, totalChunks / totalChunks) : 0,
              completedChunks: totalChunks,
              totalChunks,
              committedBytes,
              message: pauseMsg,
            },
            { generation: controller.generation, source: `${sourceTag}.paused` },
          );
          return {
            status: "paused",
            taskId: finalTaskId,
            songId: request.songId,
            generation: controller.generation,
            message: pauseMsg,
          };
        }

        const freshSongBefore = await getPersistedSongRecord(request.songId).catch(() => null);
        const freshProjectEntryBefore =
          !freshSongBefore && effectiveProjectId && effectiveEntryId
            ? await (async () => {
                if (await isProjectDeleted(effectiveProjectId)) return null;
                const projRec = await getProjectRecord(effectiveProjectId).catch(() => null);
                return (
                  projRec?.project.songs.find(
                    (item) =>
                      item.entryId === effectiveEntryId &&
                      item.sourceAudioHash === sourceAudioHash,
                  ) ?? null
                );
              })()
            : null;
        if (!freshSongBefore && !freshProjectEntryBefore) {
          controller?.settleForFinalizationPending();
          jobSink.updateJob(
            finalTaskId,
            {
              taskId: finalTaskId,
              songId: request.songId,
              projectId: effectiveProjectId,
              entryId: effectiveEntryId,
              songName: effectiveSongName,
              requestedMode: mode,
              stage: "failed",
              retryPhase: "finalization",
              retryWaitReason: "manual_action_required",
              isActivelyFinalizing: false,
              requiresManualAction: true,
              autoResumeExhausted: true,
              completedChunks: totalChunks,
              totalChunks,
              committedBytes,
              message: "歌曲或所屬專案已被移除，已停止最終保存。",
            },
            {
              allowRepairOrReset: true,
              source: `${sourceTag}.songMissing`,
            },
          );
          recordSeparationDiagnostic({
            source: sourceTag,
            taskId: finalTaskId,
            songId: request.songId,
            generation: params.executionFence?.generation ?? controller?.generation ?? null,
            finalizationOutcome: "song_missing",
            controllerSettled: true,
            note: "aborted finalization because song/project entry no longer exists",
          });
          return {
            status: "failed",
            taskId: finalTaskId,
            songId: request.songId,
            generation: params.executionFence?.generation ?? controller?.generation ?? 0,
            retryable: false,
            retryPhase: "finalization",
            failureCode: "song_missing",
            completedChunks: totalChunks,
            totalChunks,
            committedBytes,
            message: "歌曲或所屬專案已被移除，已停止最終保存。",
          };
        }

        // 2) 取得或驗證持久化 FinalizationFence（Generation + ownerJobToken + ownerTabId）
        let fence: { generation: number; ownerJobToken: string; ownerTabId: string };
        if (totalChunks > 0) {
          const freshCp = await getCheckpoint(finalTaskId).catch(() => null);
          if (!freshCp) {
            controller?.settleForFinalizationPending();
            await jobSink.syncFromCheckpoint(finalTaskId).catch(() => undefined);
            return {
              status: "failed",
              taskId: finalTaskId,
              songId: request.songId,
              generation: params.executionFence?.generation ?? 0,
              retryable: false,
              retryPhase: "finalization",
              failureCode: "stale_generation",
              completedChunks: 0,
              totalChunks,
              committedBytes: 0,
              message: "分離 Checkpoint 已不存在，停止過期提交。",
            };
          }
          if (freshCp.status === "cancelled" && !request.forceRecompute && !request.userAuthorized) {
            controller?.settleForFinalizationPending();
            jobSink.updateJob(
              finalTaskId,
              {
                taskId: finalTaskId,
                songId: request.songId,
                songName: effectiveSongName,
                stage: "cancelled",
                isActivelyFinalizing: false,
                progress: 0,
                message: "已中止音軌分離（保留已提交分段）。",
              },
              { allowRepairOrReset: true, source: `${sourceTag}.cpCancelled` },
            );
            return {
              status: "cancelled",
              taskId: finalTaskId,
              songId: request.songId,
              generation: freshCp.lastExecutionGeneration ?? 0,
              message: "任務已取消，禁止提交完成。",
            };
          }

          const explicitFence = params.executionFence ?? request.preferredExecutionFence ?? null;
          const ownership = await leaseManager.acquireFinalizationOwnership(finalTaskId, tabId, {
            preferredGeneration: explicitFence?.generation,
            preferredJobToken: explicitFence?.ownerJobToken,
            strictExpectedOwnership: Boolean(explicitFence),
          });
          if (!ownership.acquired) {
            controller?.settleForFinalizationPending();
            if (ownership.code === "cancelled") {
              jobSink.updateJob(
                finalTaskId,
                {
                  taskId: finalTaskId,
                  songId: request.songId,
                  songName: effectiveSongName,
                  stage: "cancelled",
                  isActivelyFinalizing: false,
                  progress: 0,
                  message: ownership.reason,
                },
                { allowRepairOrReset: true, source: `${sourceTag}.ownershipCancelled` },
              );
              return {
                status: "cancelled",
                taskId: finalTaskId,
                songId: request.songId,
                generation: explicitFence?.generation ?? 0,
                message: ownership.reason,
              };
            }
            if (ownership.code === "foreign_lease") {
              await jobSink.syncFromCheckpoint(finalTaskId).catch(() => undefined);
              return {
                status: "blocked",
                code: "foreign_lease",
                taskId: finalTaskId,
                songId: request.songId,
                retryable: true,
                message: ownership.reason,
              };
            }
            if (ownership.code === "stale_generation") {
              await jobSink.syncFromCheckpoint(finalTaskId).catch(() => undefined);
              recordSeparationDiagnostic({
                event: "stale-worker-update-rejected",
                source: sourceTag,
                taskId: finalTaskId,
                songId: request.songId,
                generation: explicitFence?.generation ?? null,
                ownerJobToken: explicitFence?.ownerJobToken ?? null,
                finalizationOutcome: "stale_generation",
                controllerSettled: true,
                outcome: "rejected",
                note: ownership.reason,
              });
              return {
                status: "failed",
                taskId: finalTaskId,
                songId: request.songId,
                generation: explicitFence?.generation ?? 0,
                retryable: false,
                retryPhase: "finalization",
                failureCode: "stale_generation",
                completedChunks: totalChunks,
                totalChunks,
                committedBytes,
                message: ownership.reason,
              };
            }
            return {
              status: "failed",
              taskId: finalTaskId,
              songId: request.songId,
              generation: explicitFence?.generation ?? 0,
              retryable: false,
              retryPhase: "finalization",
              failureCode: "stale_generation",
              completedChunks: totalChunks,
              totalChunks,
              committedBytes,
              message: ownership.reason,
            };
          }
          fence = ownership.fence;
        } else {
          const explicitFence = params.executionFence ?? request.preferredExecutionFence ?? null;
          if (explicitFence) {
            fence = explicitFence;
          } else {
            const nextGen = Math.max(1, (freshSongBefore?.separationGeneration ?? 0) + 1);
            fence = {
              generation: nextGen,
              ownerJobToken: createJobToken(),
              ownerTabId: tabId,
            };
          }
        }

        const uiGeneration = controller?.generation ?? fence.generation;

        jobSink.updateJob(
          finalTaskId,
          {
            taskId: finalTaskId,
            songId: request.songId,
            projectId: effectiveProjectId,
            entryId: effectiveEntryId,
            songName: effectiveSongName,
            requestedMode: mode,
            generation: uiGeneration,
            ownerJobToken: fence.ownerJobToken,
            ownerTabId: fence.ownerTabId,
            isForeignActive: false,
            stage: "finalizing",
            retryPhase: "finalization",
            retryWaitReason: undefined,
            isActivelyFinalizing: true,
            requiresManualAction: false,
            progress: 0.99,
            completedChunks: totalChunks,
            totalChunks,
            committedBytes,
            message: "正在保存結果",
          },
          {
            generation: uiGeneration,
            ownerJobToken: fence.ownerJobToken,
            allowRepairOrReset: Boolean(request.forceRecompute || totalChunks === 0),
            source: `${sourceTag}.finalizing`,
          },
        );

        let commitResult: SeparationCommitResult;
        let projectFinalizedSampleRate = chunkedSummary?.sampleRate ?? DEMUCS_SAMPLE_RATE;
        let projectFinalizedTotalSamples = chunkedSummary?.totalSamples ?? 0;

        try {
          if (totalChunks > 0) {
            await addCheckpointReference({
              taskId: finalTaskId,
              songId: request.songId,
              mode,
              source: `${sourceTag}.addReference`,
            }).catch(() => undefined);
          }

          if (freshSongBefore) {
            commitResult = await commitPersistedSongSeparationFinalization({
              songId: request.songId,
              taskId: finalTaskId,
              sourceAudioHash,
              modelVersion: DEMUCS_MODEL_VERSION,
              processingVersion: SEPARATION_PROCESSING_VERSION,
              generation: fence.generation,
              ownerJobToken: fence.ownerJobToken,
              ownerTabId: fence.ownerTabId,
              mode,
              totalChunks,
              committedBytes,
              cacheKey,
              stemRoles: stemRolesForMode(mode),
              allowReplaceCompleted,
              expectedPreviousTaskId: effectivePreviousCompletedTaskId,
            });
          } else {
            // 專案歌曲路徑：驗證 Checkpoint 完成狀態並標記 finalized，不寫入舊版 default songs store
            commitResult = await withIdbTransaction(
              ["separationCheckpoints", "separationChunks"],
              "readwrite",
              async (tx) => {
                const cpStore = tx.objectStore("separationCheckpoints");
                const chunkStore = tx.objectStore("separationChunks");
                if (totalChunks > 0) {
                  const targetCp = (await idbRequestPromise(
                    cpStore.get(finalTaskId),
                  )) as SeparationCheckpoint | undefined;
                  if (!targetCp || targetCp.status === "cancelled") {
                    return { status: "transition_rejected" } as SeparationCommitResult;
                  }
                  const keys = await getTaskChunkKeysInStore(chunkStore, finalTaskId);
                  if (targetCp.status !== "completed" || keys.length < targetCp.totalChunks) {
                    return { status: "transition_rejected" } as SeparationCommitResult;
                  }
                  projectFinalizedSampleRate = targetCp.sampleRate;
                  projectFinalizedTotalSamples = targetCp.totalSamples;
                  const nowTs = Date.now();
                  const prevRefs = targetCp.referencedBySongIds ?? [targetCp.songId];
                  await idbRequestPromise(
                    cpStore.put({
                      ...targetCp,
                      referencedBySongIds: Array.from(
                        new Set([...prevRefs, effectiveEntryId || request.songId]),
                      ),
                      lease: null,
                      finalizedAt: targetCp.finalizedAt ?? nowTs,
                      finalizedGeneration: Math.max(
                        targetCp.finalizedGeneration ?? 0,
                        fence.generation,
                      ),
                      finalizedOwnerJobToken: fence.ownerJobToken,
                      retryState: null,
                      updatedAt: nowTs,
                    } satisfies SeparationCheckpoint),
                  );
                }
                return {
                  status: "committed",
                  record: undefined as unknown as PersistedSongRecord,
                } as SeparationCommitResult;
              },
            );
          }

          if (
            (commitResult.status === "committed" || commitResult.status === "already_committed") &&
            effectiveProjectId &&
            effectiveEntryId
          ) {
            const projCommit = await commitProjectEntrySeparationArtifact({
              projectId: effectiveProjectId,
              entryId: effectiveEntryId,
              sourceAudioHash,
              artifactRef: {
                revisionId: `local-${finalTaskId}`,
                sourceAudioHash,
                separationMode: mode,
                modelVersion: DEMUCS_MODEL_VERSION,
                processingVersion: SEPARATION_PROCESSING_VERSION,
                sampleRate: projectFinalizedSampleRate,
                channelCount: 2,
                totalSamples:
                  projectFinalizedTotalSamples ||
                  Math.max(1, Math.round(effectiveDurationSec * projectFinalizedSampleRate)),
                localTaskId: totalChunks > 0 ? finalTaskId : null,
                localSourceType: totalChunks > 0 ? "demucs_checkpoint" : null,
              },
            });
            if (!projCommit.updated && !freshSongBefore) {
              commitResult = { status: "song_missing" };
            }
          }
        } catch (error) {
          controller?.settleForFinalizationPending();
          const quotaErr = isQuotaExceededError(error);
          const failureCode: SeparationJobFailureCode = quotaErr
            ? "quota_exceeded"
            : "transient_storage_error";
          const waitReason = quotaErr ? "storage_unavailable" : "backoff";
          const pendingMsg = quotaErr
            ? "請釋放空間後重試保存"
            : "分軌已完成，等待保存";
          const detailMsg = error instanceof Error && error.message ? error.message : pendingMsg;

          jobSink.updateJob(
            finalTaskId,
            {
              taskId: finalTaskId,
              songId: request.songId,
              songName: effectiveSongName,
              requestedMode: mode,
              generation: uiGeneration,
              ownerJobToken: fence.ownerJobToken,
              ownerTabId: fence.ownerTabId,
              isForeignActive: false,
              stage: "finalizing",
              retryPhase: "finalization",
              retryWaitReason: waitReason,
              isActivelyFinalizing: false,
              progress: 0.99,
              completedChunks: totalChunks,
              totalChunks,
              committedBytes,
              message: pendingMsg,
            },
            {
              generation: uiGeneration,
              ownerJobToken: fence.ownerJobToken,
              source: `${sourceTag}.finalizationPending`,
            },
          );

          recordSeparationDiagnostic({
            source: sourceTag,
            taskId: finalTaskId,
            songId: request.songId,
            generation: fence.generation,
            ownerJobToken: fence.ownerJobToken,
            jobStage: "finalizing",
            retryPhase: "finalization",
            retryWaitReason: waitReason,
            finalizationOutcome: failureCode,
            controllerSettled: true,
            validChunkCount: totalChunks,
            totalChunks,
            note: detailMsg,
          });

          return {
            status: "failed",
            taskId: finalTaskId,
            songId: request.songId,
            generation: fence.generation,
            retryable: true,
            retryPhase: "finalization",
            failureCode,
            completedChunks: totalChunks,
            totalChunks,
            committedBytes,
            message: detailMsg,
          };
        }

        if (commitResult.status !== "committed" && commitResult.status !== "already_committed") {
          controller?.settleForFinalizationPending();
          const rejectionStatus = commitResult.status;
          const rejectionMessage =
            rejectionStatus === "song_missing"
              ? "找不到歌曲紀錄，已停止最終提交。"
              : rejectionStatus === "stale_generation"
                ? "此任務執行權世代已過期，已被較新的分軌任務取代。"
                : rejectionStatus === "source_mismatch"
                  ? "來源音訊與分離任務不相符，已阻止寫入。"
                  : "歌曲目前狀態不允許直接完成提交，已停止。";

          if (rejectionStatus === "stale_generation") {
            await jobSink.syncFromCheckpoint(finalTaskId).catch(() => undefined);
          } else {
            jobSink.updateJob(
              finalTaskId,
              {
                taskId: finalTaskId,
                songId: request.songId,
                songName: effectiveSongName,
                requestedMode: mode,
                generation: uiGeneration,
                ownerJobToken: fence.ownerJobToken,
                stage: "failed",
                retryPhase: "finalization",
                retryWaitReason: "manual_action_required",
                isActivelyFinalizing: false,
                requiresManualAction: true,
                autoResumeExhausted: true,
                completedChunks: totalChunks,
                totalChunks,
                committedBytes,
                message: rejectionMessage,
              },
              {
                generation: uiGeneration,
                ownerJobToken: fence.ownerJobToken,
                allowRepairOrReset: true,
                source: `${sourceTag}.commitRejected`,
              },
            );
          }

          recordSeparationDiagnostic({
            event: rejectionStatus === "stale_generation" ? "stale-worker-update-rejected" : null,
            source: sourceTag,
            taskId: finalTaskId,
            songId: request.songId,
            generation: fence.generation,
            ownerJobToken: fence.ownerJobToken,
            jobStage: rejectionStatus === "stale_generation" ? "finalizing" : "failed",
            retryPhase: "finalization",
            finalizationOutcome: rejectionStatus,
            controllerSettled: true,
            outcome: "rejected",
            note: rejectionMessage,
          });

          return {
            status: "failed",
            taskId: finalTaskId,
            songId: request.songId,
            generation: fence.generation,
            retryable: false,
            retryPhase: "finalization",
            failureCode: rejectionStatus,
            completedChunks: totalChunks,
            totalChunks,
            committedBytes,
            message: rejectionMessage,
          };
        }

        // 3) 嚴格最終提交成功！若為強制重新分軌，此時才釋放舊任務引用並 GC
        if (
          effectivePreviousCompletedTaskId &&
          finalTaskId !== effectivePreviousCompletedTaskId
        ) {
          void releaseCheckpointReferenceAndMaybeGc({
            taskId: effectivePreviousCompletedTaskId,
            sourceAudioHash,
            songId: request.songId,
            cacheKeyToRelease:
              request.previousCacheKey && request.previousCacheKey !== cacheKey
                ? request.previousCacheKey
                : null,
            knownInMemorySongs: request.knownInMemorySongs,
            knownRemovedSongIds: request.knownRemovedSongIds,
            source: "separationJobRunner.recomputeSwitchCleanup",
          }).catch(() => undefined);
        }

        controller?.markCompleted(finalMessage);
        jobSink.updateJob(
          finalTaskId,
          {
            taskId: finalTaskId,
            songId: request.songId,
            songName: effectiveSongName,
            requestedMode: mode,
            generation: uiGeneration,
            ownerJobToken: fence.ownerJobToken,
            ownerTabId: fence.ownerTabId,
            isForeignActive: false,
            stage: "completed",
            retryPhase: undefined,
            retryWaitReason: undefined,
            isActivelyFinalizing: false,
            autoResumeExhausted: false,
            requiresManualAction: false,
            progress: 1,
            completedChunks: totalChunks,
            totalChunks,
            committedBytes,
            message: finalMessage,
          },
          {
            generation: uiGeneration,
            ownerJobToken: fence.ownerJobToken,
            allowRepairOrReset: Boolean(request.forceRecompute || totalChunks === 0),
            source: `${sourceTag}.completed`,
          },
        );
        leaseManager.notifyTaskCompleted(finalTaskId, tabId, fence.generation);

        recordSeparationDiagnostic({
          source: sourceTag,
          taskId: finalTaskId,
          songId: request.songId,
          generation: fence.generation,
          ownerJobToken: fence.ownerJobToken,
          jobStage: "completed",
          finalizationOutcome: commitResult.status,
          controllerSettled: true,
          validChunkCount: totalChunks,
          totalChunks,
          fromState: "finalizing",
          toState: "completed",
        });

        return {
          status: "completed",
          taskId: finalTaskId,
          songId: request.songId,
          generation: fence.generation,
          ownerJobToken: fence.ownerJobToken,
          mode,
          cacheKey,
          message: finalMessage,
          backend,
          usedWorker,
          chunkedTask: chunkedSummary,
          stems: stems ?? undefined,
          durationMs: 0,
        };
      };

      // 驗證目標 Checkpoint（強制重新分軌時僅驗證本次指定的隔離重算任務自身，不誤撈舊完成任務）
      const existingValidation = request.forceRecompute
        ? checkpointTaskId !== baseCheckpointTaskId || checkpointTaskId.includes(":r")
          ? await validateAndPrepareResume(checkpointTaskId, {
              sourceAudioAvailable: true,
              sourceAudioHash,
              viewerTabId: tabId,
            }).catch(() => null)
          : null
        : await verifyAuthoritativeCheckpoint(
            {
              id: request.songId,
              sourceAudioHash,
              separationTaskId: checkpointTaskId,
            },
            true,
          );

      // 1) 若本機已有驗證完整的 Chunk Checkpoint，零重算直接進入嚴格最終提交（不解碼、不建 Worker、不下模型）
      if (isValidationCompleted(existingValidation) && existingValidation?.checkpoint) {
        const resolvedCp = existingValidation.checkpoint;
        const msg =
          effectiveMode === "two_stem"
            ? "已從既有 4 軌分段 Checkpoint 即時合成 2 Stem（零 AI 重算與網路下載）。"
            : `已從本機分段 Checkpoint 驗證並載入完整分軌（共 ${existingValidation.totalChunks} 段按需播放）。`;
        const currentSongBefore = await getPersistedSongRecord(request.songId).catch(() => null);
        const isSwitchingModeOnCompleted = Boolean(
          currentSongBefore?.separationStatus === "completed" &&
            currentSongBefore.separationTaskId === resolvedCp.taskId &&
            currentSongBefore.separationMode !== effectiveMode,
        );
        const isVerifiedIsolatedRecompute = Boolean(
          currentSongBefore?.separationStatus === "completed" &&
            resolvedCp.taskId.includes(":r") &&
            resolvedCp.songId === request.songId &&
            resolvedCp.userAuthorized &&
            !resolvedCp.finalizedAt,
        );
        return performAuthoritativeFinalization({
          finalTaskId: resolvedCp.taskId,
          mode: effectiveMode,
          totalChunks: resolvedCp.totalChunks,
          committedBytes: resolvedCp.committedBytes,
          chunkedSummary: {
            taskId: resolvedCp.taskId,
            mode: effectiveMode,
            sampleRate: resolvedCp.sampleRate,
            totalSamples: resolvedCp.totalSamples,
            totalChunks: resolvedCp.totalChunks,
            committedBytes: resolvedCp.committedBytes,
            durationSeconds:
              resolvedCp.sampleRate > 0 ? resolvedCp.totalSamples / resolvedCp.sampleRate : 0,
          },
          finalMessage: msg,
          backend: "wasm",
          usedWorker: false,
          controller: null,
          executionFence: request.preferredExecutionFence ?? null,
          allowReplaceCompleted: Boolean(
            request.forceRecompute || isSwitchingModeOnCompleted || isVerifiedIsolatedRecompute,
          ),
          sourceTag: "runner.alreadyCompleted",
        });
      }

      // 2) 若已有非分段快速快取（含 4-Stem 衍生 2-Stem），優先復用並遵守同一最終提交協議
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

      if (preCached) {
        const currentSongBefore = await getPersistedSongRecord(request.songId).catch(() => null);
        const isSwitchingModeOnCompleted = Boolean(
          currentSongBefore?.separationStatus === "completed" &&
            currentSongBefore.separationMode !== effectiveMode,
        );
        return performAuthoritativeFinalization({
          finalTaskId: checkpointTaskId,
          mode: effectiveMode,
          totalChunks: 0,
          committedBytes: 0,
          stems: preCached,
          finalMessage: preCachedMessage,
          backend: "wasm",
          usedWorker: false,
          controller: null,
          executionFence: request.preferredExecutionFence ?? null,
          allowReplaceCompleted: Boolean(request.forceRecompute || isSwitchingModeOnCompleted),
          sourceTag: "runner.fastCache",
        });
      }

      if (onlyFinalize) {
        return {
          status: "failed",
          taskId: checkpointTaskId,
          songId: request.songId,
          generation: request.preferredExecutionFence?.generation ?? 0,
          retryable: false,
          retryPhase: "finalization",
          failureCode: "transition_rejected",
          completedChunks: existingValidation?.validChunkCount ?? 0,
          totalChunks: existingValidation?.totalChunks ?? 0,
          committedBytes: existingValidation?.checkpoint?.committedBytes ?? 0,
          message: "找不到已完成的分離分段或快取產物，無法直接重試保存。",
        };
      }

      if (!audioBlob) {
        return {
          status: "blocked",
          code: "missing_audio",
          taskId: checkpointTaskId,
          songId: request.songId,
          retryable: false,
          message: "找不到原始音訊檔案，請返回混音器重新匯入或選取原始音檔。",
        };
      }

      const audioFile = toAudioFileLike(
        audioBlob,
        request.fileName ?? reconstructed?.descriptor.fileName ?? `${effectiveSongName}.wav`,
        request.mimeType ?? reconstructed?.descriptor.mimeType ?? "audio/wav",
      );

      // 3) 檢查裝置資源與網路預算 Guard（不繞過資源限制）
      const cap = await collectCapabilitiesFn();
      const perfSignals = sharedPerfTelemetry.getSignals();
      const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
      let maxThreads = request.maxThreads ?? profileEval.profile.maxWasmThreads;

      const backgroundInMemoryBytes = Math.max(
        0,
        (request.inMemoryAudioBytes ?? 0) - estimateStereoPcmBytesLocal(effectiveDurationSec),
      );

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
        targetCp?.taskId === checkpointTaskId &&
        targetCp.lease &&
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

      // 4) 建立全域 Task Controller，確保整個生命週期可在任何路由完成
      if (request.forceRecompute) {
        jobSink.updateJob(
          checkpointTaskId,
          {
            taskId: checkpointTaskId,
            songId: request.songId,
            songName: effectiveSongName,
            stage: "preparing",
            retryPhase: "inference",
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
          projectId: effectiveProjectId,
          entryId: effectiveEntryId,
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
          failureCode: "inference_error",
          completedChunks: 0,
          totalChunks: 0,
          committedBytes: 0,
          message: msg,
        };
      }

      const focusDecision = shouldEnterSeparationFocusMode({
        profile: profileEval.profile,
        performanceSignals: perfSignals,
        estimatedSeparationMemoryBytes: 0,
        inMemoryAudioBytes: backgroundInMemoryBytes,
        activeSoundTouchTracks: request.activeSoundTouchTracks ?? 0,
        userSelectedPausePlayback: request.userSelectedPausePlayback,
      });
      jobSink.setGlobalFocusActive(true, request.songId);

      let lastPersistedChunkCount = -1;
      let latestCommittedTaskId = checkpointTaskId;
      let latestExecutionFence: {
        generation: number;
        ownerJobToken: string;
        ownerTabId: string;
      } | null = request.preferredExecutionFence ?? null;
      let persistChain: Promise<unknown> = Promise.resolve();
      const preserveExistingCompletedSongDuringRecompute = Boolean(
        request.forceRecompute &&
          effectivePreviousCompletedTaskId &&
          effectivePreviousCompletedTaskId !== checkpointTaskId,
      );

      const enqueueSongSeparationPatch = (
        patch: Parameters<typeof patchPersistedSongSeparationFields>[1],
      ) => {
        if (preserveExistingCompletedSongDuringRecompute) {
          return Promise.resolve(null);
        }
        const next = persistChain
          .then(() => patchPersistedSongSeparationFields(request.songId, patch))
          .catch(() => null);
        persistChain = next;
        return next;
      };

      try {
        let stems: SeparatedStemSet | null = null;
        let chunkedSummary: ChunkedSeparationSummary | undefined;
        let resultBackend: "webgpu" | "wasm" = "wasm";
        let usedWorker = false;
        let finalMessage = "音軌分離完成。";

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
          projectId: effectiveProjectId,
          entryId: effectiveEntryId,
          sourceAudioHash,
          checkpointTaskId,
          userAuthorized: true,
          forceRecompute: request.forceRecompute,
          knownInMemorySongs: request.knownInMemorySongs,
          maxThreads,
          onChunkCommitted: ({ checkpoint: committedCp, chunkIndex, totalChunks }) => {
            latestCommittedTaskId = committedCp.taskId;
            if (committedCp.finalizationFence) {
              latestExecutionFence = {
                generation: committedCp.finalizationFence.generation,
                ownerJobToken: committedCp.finalizationFence.ownerJobToken,
                ownerTabId: committedCp.finalizationFence.ownerTabId,
              };
            } else if (committedCp.lease) {
              latestExecutionFence = {
                generation: committedCp.lease.generation,
                ownerJobToken: committedCp.lease.ownerJobToken,
                ownerTabId: committedCp.lease.ownerTabId,
              };
            }
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
                ownerJobToken: latestExecutionFence?.ownerJobToken,
                stage: "processing",
                progress: progressPct,
                completedChunks: committedCp.nextChunkIndex,
                totalChunks,
                committedBytes: committedCp.committedBytes,
                message: chunkMessage,
              },
              {
                generation: controller.generation,
                ownerJobToken: latestExecutionFence?.ownerJobToken,
                allowRepairOrReset: Boolean(request.forceRecompute && chunkIndex === 0),
                source: "runner.onChunkCommitted",
              },
            );

            leaseManager.notifyTaskProgress({
              taskId: committedCp.taskId,
              ownerTabId: tabId,
              generation: committedCp.lease?.generation ?? latestExecutionFence?.generation ?? controller.generation,
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
        if (sepResult.executionFence) {
          latestExecutionFence = sepResult.executionFence;
        } else if (sepResult.checkpoint?.finalizationFence) {
          latestExecutionFence = {
            generation: sepResult.checkpoint.finalizationFence.generation,
            ownerJobToken: sepResult.checkpoint.finalizationFence.ownerJobToken,
            ownerTabId: sepResult.checkpoint.finalizationFence.ownerTabId,
          };
        }

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

        controller.throwIfAborted();
        await persistChain;

        const committedTotalChunks = chunkedSummary?.totalChunks ?? 0;
        const committedBytes = chunkedSummary?.committedBytes ?? 0;
        const finalTaskId = chunkedSummary?.taskId ?? latestCommittedTaskId;
        return await performAuthoritativeFinalization({
          finalTaskId,
          mode: effectiveMode,
          totalChunks: committedTotalChunks,
          committedBytes,
          chunkedSummary,
          stems,
          finalMessage,
          backend: resultBackend,
          usedWorker,
          controller,
          executionFence: latestExecutionFence,
          allowReplaceCompleted: Boolean(request.forceRecompute),
          sourceTag: "runner",
        });
      } catch (error) {
        await persistChain.catch(() => undefined);

        // 1) 優先尊重使用者取消與暫停意圖：最終提交前若已取消或暫停，不可因所有 Chunk 剛好完成就提交 completed
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
              isActivelyFinalizing: false,
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

        const currentCpForGuard = await getCheckpoint(latestCommittedTaskId).catch(() => null);
        if (currentCpForGuard?.status === "cancelled" && !request.userAuthorized) {
          const cancelMsg = "已中止音軌分離，已恢復操作前穩定狀態。";
          await controller.cancel(cancelMsg);
          jobSink.updateJob(
            checkpointTaskId,
            {
              generation: controller.generation,
              stage: "cancelled",
              isActivelyFinalizing: false,
              progress: 0,
              message: cancelMsg,
            },
            { generation: controller.generation, source: "runner.checkpointCancelled" },
          );
          return {
            status: "cancelled",
            taskId: checkpointTaskId,
            songId: request.songId,
            generation: controller.generation,
            message: cancelMsg,
          };
        }

        const idbValidation = await validateAndPrepareResume(latestCommittedTaskId, {
          sourceAudioAvailable: true,
          sourceAudioHash,
          viewerTabId: tabId,
        }).catch(() => null);

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
              isActivelyFinalizing: false,
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

        // 2) 若本次任務（包含強制重新分軌隔離任務）的所有有效 Chunk 均已通過驗證，直接走統一最終提交而不重算！
        if (isValidationCompleted(idbValidation) && idbValidation?.checkpoint) {
          const doneCp = idbValidation.checkpoint;
          const recoveredMsg = `分段分離完成（共 ${doneCp.totalChunks} 段按需播放）。`;
          recordSeparationDiagnostic({
            source: "separationJobRunner.catch",
            songId: request.songId,
            taskId: doneCp.taskId,
            generation: controller.generation,
            ownerJobToken: latestExecutionFence?.ownerJobToken ?? null,
            checkpointStatus: doneCp.status,
            validChunkCount: idbValidation.validChunkCount,
            totalChunks: idbValidation.totalChunks,
            fromState: "running",
            toState: "finalizing",
            note: "recovered completed chunks in runner catch from authoritative IDB",
          });
          return await performAuthoritativeFinalization({
            finalTaskId: doneCp.taskId,
            mode: effectiveMode,
            totalChunks: doneCp.totalChunks,
            committedBytes: doneCp.committedBytes,
            chunkedSummary: {
              taskId: doneCp.taskId,
              mode: effectiveMode,
              sampleRate: doneCp.sampleRate,
              totalSamples: doneCp.totalSamples,
              totalChunks: doneCp.totalChunks,
              committedBytes: doneCp.committedBytes,
              durationSeconds:
                doneCp.sampleRate > 0 ? doneCp.totalSamples / doneCp.sampleRate : 0,
            },
            finalMessage: recoveredMsg,
            backend: "wasm",
            usedWorker: false,
            controller,
            executionFence: latestExecutionFence ?? doneCp.finalizationFence ?? null,
            allowReplaceCompleted: Boolean(request.forceRecompute),
            sourceTag: "runner.catchRecovery",
          });
        }

        // 3) 若為強制重算失敗且部分完成，不污染原有已完成歌曲狀態；對本任務回報 failed/interrupted
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
            retryPhase: "inference",
            isActivelyFinalizing: false,
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
          retryPhase: "inference",
          failureCode: "inference_error",
          completedChunks: validChunks,
          totalChunks,
          committedBytes,
          message: errMsg,
        };
      } finally {
        await persistChain.catch(() => undefined);
        // 確保任何出口皆解除 Controller 與 Coordinator 佔用，絕不阻塞後續重試
        if (!controller.isTerminal()) {
          controller.settleForFinalizationPending();
        }
        jobSink.markControllerSettled(checkpointTaskId, controller);
        jobSink.setGlobalFocusActive(false, request.songId);
        recordSeparationDiagnostic({
          source: "separationJobRunner.finally",
          taskId: latestCommittedTaskId,
          songId: request.songId,
          generation: controller.generation,
          ownerJobToken: latestExecutionFence?.ownerJobToken ?? null,
          controllerSettled: true,
        });
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
