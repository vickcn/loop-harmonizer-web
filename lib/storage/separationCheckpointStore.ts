import {
  DEMUCS_MODEL_VERSION,
  SEPARATION_PROCESSING_VERSION,
  createSeparationCacheKey,
} from "./cacheKeys.ts";
import {
  DEMUCS_OVERLAP_CARRY_BYTES,
  DEMUCS_SAMPLE_RATE,
  DEMUCS_SEGMENT_OVERLAP,
  DEMUCS_STRIDE_SAMPLES,
  DEMUCS_TRAINING_SAMPLES,
  type SeparationChunkRecord,
  collectChunkPrimaryKeysGroupedByTaskIdInStore,
  computeBufferChecksum,
  computeTotalChunks,
  createChunkKey,
  deleteChunksByTaskIdInStore,
  getChunkSampleBounds,
  validateChunkPayloadInPlace,
} from "./separationChunkStore.ts";
import {
  SEPARATION_CHECKPOINT_HASH_INDEX,
  idbGet,
  idbGetAll,
  idbPut,
  idbRequestPromise,
  withIdbTransaction,
} from "./indexedDb.ts";
import { recordSeparationDiagnostic } from "../separation/separationStateRecovery.ts";

export type SeparationCheckpointStatus =
  | "queued"
  | "running"
  | "paused"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

export interface SeparationLeaseInfo {
  ownerTabId: string;
  ownerJobToken: string;
  generation: number;
  acquiredAt: number;
  leaseExpiresAt: number;
}

export interface FinalizationFence {
  taskId: string;
  generation: number;
  ownerJobToken: string;
  ownerTabId: string;
  updatedAt: number;
}

export interface PersistedCheckpointRetryState {
  attempts: number;
  nextEligibleAt: number;
  blockedUntilAt?: number;
  lastError?: string;
  permanentlyBlockedReason?: string;
  baselineCompletedChunks: number;
  retryPhase: "inference" | "finalization";
  waitReason?: string;
  backoffCursor?: 0 | 1;
  reservationToken?: string | null;
  reservationTabId?: string | null;
  reservationExpiresAt?: number | null;
  updatedAt: number;
}

export interface SeparationCheckpoint {
  /** IndexedDB keyPath，與 taskId 相同 */
  key: string;
  taskId: string;
  songId: string;
  sourceAudioHash: string;
  modelVersion: string;
  processingVersion: string;
  requestedMode: "two_stem" | "four_stem";
  sampleRate: number;
  totalSamples: number;
  trainingSamples: number;
  strideSamples: number;
  overlapRatio: number;
  totalChunks: number;
  nextChunkIndex: number;
  committedEndSample: number;
  committedBytes: number;
  /** 供無縫接續 nextChunkIndex 的尾端重疊視窗（9 通道 × 85995 floats） */
  overlapCarryBuffer: ArrayBuffer | null;
  userAuthorized: boolean;
  status: SeparationCheckpointStatus;
  lastError?: string;
  lease: SeparationLeaseInfo | null;
  /** 跨 Lease 單調遞增的執行世代與最後有效最終提交執行權柵欄 */
  lastExecutionGeneration?: number;
  finalizationFence?: FinalizationFence | null;
  finalizedAt?: number | null;
  finalizedGeneration?: number | null;
  finalizedOwnerJobToken?: string | null;
  retryState?: PersistedCheckpointRetryState | null;
  /** 明確引用此 Checkpoint 的歌曲 ID 清單（向後相容：舊資料可能為 undefined） */
  referencedBySongIds?: string[];
  /** 各引用歌曲目前使用的分離播放模式（two_stem / four_stem） */
  referencedModesBySongId?: Record<string, "two_stem" | "four_stem">;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointSongReferenceCandidate {
  id?: string;
  songId?: string;
  key?: string;
  separationTaskId?: string | null;
  sourceAudioHash?: string | null;
  separationMode?: "two_stem" | "four_stem" | null;
  separationStatus?: string | null;
  cacheKey?: string | null;
}

function resolveCandidateSongId(candidate: CheckpointSongReferenceCandidate | null | undefined): string {
  if (!candidate) return "";
  return String(candidate.id ?? candidate.songId ?? candidate.key ?? "");
}

export function isCheckpointLeaseActive(
  checkpoint: Pick<SeparationCheckpoint, "lease"> | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(checkpoint?.lease && checkpoint.lease.leaseExpiresAt > now);
}

export function createCheckpointTaskId(
  songId: string,
  sourceAudioHash: string,
  modelVersion = DEMUCS_MODEL_VERSION,
  processingVersion = SEPARATION_PROCESSING_VERSION,
): string {
  return `sep:${songId}:${sourceAudioHash}:${modelVersion}:${processingVersion}`;
}

export function createIsolatedRecomputeTaskId(
  songId: string,
  sourceAudioHash: string,
  uniqueSuffix: string | number = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  modelVersion = DEMUCS_MODEL_VERSION,
  processingVersion = SEPARATION_PROCESSING_VERSION,
): string {
  return `${createCheckpointTaskId(songId, sourceAudioHash, modelVersion, processingVersion)}:r${uniqueSuffix}`;
}

export function validateOverlapCarryBuffer(buffer: ArrayBuffer | null | undefined): boolean {
  if (!buffer) return true;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== DEMUCS_OVERLAP_CARRY_BYTES) {
    return false;
  }
  const view = new Float32Array(buffer);
  for (let i = 0; i < view.length; i++) {
    if (!Number.isFinite(view[i])) return false;
  }
  return true;
}

export function buildInitialCheckpoint(params: {
  taskId?: string;
  songId: string;
  sourceAudioHash: string;
  requestedMode: "two_stem" | "four_stem";
  totalSamples: number;
  sampleRate?: number;
  modelVersion?: string;
  processingVersion?: string;
  userAuthorized?: boolean;
  status?: SeparationCheckpointStatus;
  lease?: SeparationLeaseInfo | null;
  now?: number;
}): SeparationCheckpoint {
  const modelVersion = params.modelVersion ?? DEMUCS_MODEL_VERSION;
  const processingVersion = params.processingVersion ?? SEPARATION_PROCESSING_VERSION;
  const sampleRate = params.sampleRate ?? DEMUCS_SAMPLE_RATE;
  const taskId =
    params.taskId ??
    createCheckpointTaskId(params.songId, params.sourceAudioHash, modelVersion, processingVersion);
  const now = params.now ?? Date.now();
  return {
    key: taskId,
    taskId,
    songId: params.songId,
    sourceAudioHash: params.sourceAudioHash,
    modelVersion,
    processingVersion,
    requestedMode: params.requestedMode,
    sampleRate,
    totalSamples: params.totalSamples,
    trainingSamples: DEMUCS_TRAINING_SAMPLES,
    strideSamples: DEMUCS_STRIDE_SAMPLES,
    overlapRatio: DEMUCS_SEGMENT_OVERLAP,
    totalChunks: computeTotalChunks(params.totalSamples, DEMUCS_STRIDE_SAMPLES),
    nextChunkIndex: 0,
    committedEndSample: 0,
    committedBytes: 0,
    overlapCarryBuffer: null,
    userAuthorized: params.userAuthorized ?? true,
    status: params.status ?? "queued",
    lease: params.lease ?? null,
    referencedBySongIds: [params.songId],
    referencedModesBySongId: { [params.songId]: params.requestedMode },
    createdAt: now,
    updatedAt: now,
  };
}

export async function getCheckpoint(taskId: string): Promise<SeparationCheckpoint | null> {
  return idbGet<SeparationCheckpoint>("separationCheckpoints", taskId);
}

export async function getAllCheckpoints(): Promise<SeparationCheckpoint[]> {
  return idbGetAll<SeparationCheckpoint>("separationCheckpoints");
}

export async function getLatestCheckpointForSong(
  songId: string,
  sourceAudioHash?: string,
  modelVersion = DEMUCS_MODEL_VERSION,
  processingVersion = SEPARATION_PROCESSING_VERSION,
): Promise<SeparationCheckpoint | null> {
  const all = await getAllCheckpoints();
  const candidates = all.filter((cp) => {
    if (cp.songId !== songId) return false;
    if (sourceAudioHash && cp.sourceAudioHash !== sourceAudioHash) return false;
    if (cp.modelVersion !== modelVersion || cp.processingVersion !== processingVersion) {
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] ?? null;
}

export async function saveCheckpoint(checkpoint: SeparationCheckpoint): Promise<void> {
  await idbPut("separationCheckpoints", {
    ...checkpoint,
    key: checkpoint.taskId,
    updatedAt: checkpoint.updatedAt || Date.now(),
  });
}

export async function updateCheckpointStatus(
  taskId: string,
  patch: {
    status: SeparationCheckpointStatus;
    lastError?: string;
    userAuthorized?: boolean;
    requestedMode?: "two_stem" | "four_stem";
    clearLeaseIfTerminal?: boolean;
    allowDowngradeCompleted?: boolean;
  },
  now = Date.now(),
): Promise<SeparationCheckpoint | null> {
  return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
    const store = tx.objectStore("separationCheckpoints");
    const existing = (await idbRequestPromise(store.get(taskId))) as
      | SeparationCheckpoint
      | undefined;
    if (!existing) return null;
    if (
      existing.status === "completed" &&
      patch.status !== "completed" &&
      !patch.allowDowngradeCompleted
    ) {
      recordSeparationDiagnostic({
        event: "stale-worker-update-rejected",
        source: "updateCheckpointStatus",
        taskId,
        songId: existing.songId,
        generation: existing.lease?.generation ?? null,
        checkpointStatus: existing.status,
        validChunkCount: existing.nextChunkIndex,
        totalChunks: existing.totalChunks,
        leaseOwner: existing.lease?.ownerTabId ?? null,
        leaseState: existing.lease ? "held" : "none",
        fromState: "completed",
        toState: patch.status,
        outcome: "rejected",
        note: "blocked downgrade of completed checkpoint",
        timestamp: now,
      });
      if (patch.clearLeaseIfTerminal && existing.lease !== null) {
        const preservedGen = Math.max(
          existing.lastExecutionGeneration ?? 0,
          existing.lease.generation,
          existing.finalizationFence?.generation ?? 0,
        );
        const preservedFence: FinalizationFence = existing.finalizationFence ?? {
          taskId: existing.taskId,
          generation: existing.lease.generation,
          ownerJobToken: existing.lease.ownerJobToken,
          ownerTabId: existing.lease.ownerTabId,
          updatedAt: now,
        };
        const preserved: SeparationCheckpoint = {
          ...existing,
          lease: null,
          lastExecutionGeneration: preservedGen,
          finalizationFence: preservedFence,
          updatedAt: now,
        };
        await idbRequestPromise(store.put(preserved));
        return preserved;
      }
      return existing;
    }
    const maxKnownGen = Math.max(
      existing.lastExecutionGeneration ?? 0,
      existing.lease?.generation ?? 0,
      existing.finalizationFence?.generation ?? 0,
    );
    const next: SeparationCheckpoint = {
      ...existing,
      status: patch.status,
      lastError: patch.lastError,
      userAuthorized: patch.userAuthorized ?? existing.userAuthorized,
      requestedMode: patch.requestedMode ?? existing.requestedMode,
      lastExecutionGeneration: maxKnownGen > 0 ? maxKnownGen : existing.lastExecutionGeneration,
      finalizationFence:
        existing.finalizationFence ??
        (existing.lease
          ? {
              taskId: existing.taskId,
              generation: existing.lease.generation,
              ownerJobToken: existing.lease.ownerJobToken,
              ownerTabId: existing.lease.ownerTabId,
              updatedAt: now,
            }
          : existing.finalizationFence),
      lease:
        patch.clearLeaseIfTerminal &&
        (patch.status === "completed" ||
          patch.status === "cancelled" ||
          patch.status === "failed" ||
          patch.status === "paused")
          ? null
          : existing.lease,
      updatedAt: now,
    };
    await idbRequestPromise(store.put(next));
    return next;
  });
}

export interface CommitChunkParams {
  taskId: string;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  payload: ArrayBuffer;
  overlapCarryBuffer: ArrayBuffer | null;
  expectedLease?: Pick<SeparationLeaseInfo, "ownerTabId" | "ownerJobToken" | "generation">;
  now?: number;
}

/**
 * 單一 IndexedDB readwrite 交易原子提交：
 * 1) 檢查 Chunk PCM（無 NaN/Infinity/超限振幅）與 overlapCarryBuffer；
 * 2) 檢查 Checkpoint 未被取消、Lease 未失效、chunkIndex / startSample 嚴格接續；
 * 3) 同交易寫入 separationChunks 與更新後 separationCheckpoints（失敗全數回滾）。
 */
export async function commitChunkAndCheckpointAtomically(
  params: CommitChunkParams,
): Promise<{
  chunkRecord: SeparationChunkRecord;
  checkpoint: SeparationCheckpoint;
}> {
  const frameCount = params.endSample - params.startSample;
  const payloadValidation = validateChunkPayloadInPlace(params.payload, frameCount, 4);
  if (!payloadValidation.valid) {
    throw new Error(payloadValidation.reason ?? "Chunk PCM 驗證失敗");
  }
  if (params.overlapCarryBuffer && !validateOverlapCarryBuffer(params.overlapCarryBuffer)) {
    throw new Error("Chunk 重疊接續緩衝區驗證失敗");
  }

  const checksum = computeBufferChecksum(params.payload);
  const now = params.now ?? Date.now();

  return withIdbTransaction(["separationChunks", "separationCheckpoints"], "readwrite", async (tx) => {
    const chunkStore = tx.objectStore("separationChunks");
    const cpStore = tx.objectStore("separationCheckpoints");
    const existing = (await idbRequestPromise(cpStore.get(params.taskId))) as
      | SeparationCheckpoint
      | undefined;

    if (!existing) {
      recordSeparationDiagnostic({
        event: "stale-worker-update-rejected",
        source: "commitChunkAndCheckpointAtomically",
        taskId: params.taskId,
        generation: params.expectedLease?.generation ?? null,
        validChunkCount: params.chunkIndex,
        leaseOwner: params.expectedLease?.ownerTabId ?? null,
        leaseState: "missing_checkpoint",
        outcome: "rejected",
        note: "checkpoint missing or deleted before chunk commit",
        timestamp: now,
      });
      throw new Error(`找不到分離任務 Checkpoint：${params.taskId}`);
    }
    if (existing.status === "completed") {
      recordSeparationDiagnostic({
        event: "stale-worker-update-rejected",
        source: "commitChunkAndCheckpointAtomically",
        taskId: params.taskId,
        songId: existing.songId,
        generation: params.expectedLease?.generation ?? null,
        checkpointStatus: existing.status,
        validChunkCount: existing.nextChunkIndex,
        totalChunks: existing.totalChunks,
        leaseOwner: params.expectedLease?.ownerTabId ?? null,
        leaseState: isCheckpointLeaseActive(existing, now) ? "active" : "none",
        fromState: "completed",
        toState: "running",
        outcome: "rejected",
        note: `rejected chunk commit (index=${params.chunkIndex}) on already completed checkpoint`,
        timestamp: now,
      });
      throw new Error("分離任務已完成，拒絕舊 Worker 再次寫入 Chunk。");
    }
    if (existing.status === "cancelled") {
      recordSeparationDiagnostic({
        event: "stale-worker-update-rejected",
        source: "commitChunkAndCheckpointAtomically",
        taskId: params.taskId,
        songId: existing.songId,
        generation: params.expectedLease?.generation ?? null,
        checkpointStatus: existing.status,
        validChunkCount: existing.nextChunkIndex,
        totalChunks: existing.totalChunks,
        leaseOwner: params.expectedLease?.ownerTabId ?? null,
        leaseState: isCheckpointLeaseActive(existing, now) ? "active" : "none",
        outcome: "rejected",
        note: "rejected chunk commit on cancelled checkpoint",
        timestamp: now,
      });
      throw new Error("分離任務已中止，拒絕提交後續 Chunk。");
    }
    if (params.expectedLease) {
      const lease = existing.lease;
      if (
        !lease ||
        lease.ownerTabId !== params.expectedLease.ownerTabId ||
        lease.ownerJobToken !== params.expectedLease.ownerJobToken ||
        lease.generation !== params.expectedLease.generation
      ) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: "commitChunkAndCheckpointAtomically",
          taskId: params.taskId,
          songId: existing.songId,
          generation: params.expectedLease.generation,
          checkpointStatus: existing.status,
          validChunkCount: existing.nextChunkIndex,
          totalChunks: existing.totalChunks,
          leaseOwner: lease?.ownerTabId ?? null,
          leaseState: lease ? (lease.leaseExpiresAt > now ? "foreign_active" : "expired") : "none",
          outcome: "rejected",
          note: `rejected stale worker lease/generation commit (expectedGen=${lease?.generation ?? "none"}, gotGen=${params.expectedLease.generation})`,
          timestamp: now,
        });
        throw new Error("分離任務執行權（Lease / Generation）已失效，拒絕舊 Worker 寫入。");
      }
    }
    if (params.chunkIndex !== existing.nextChunkIndex) {
      throw new Error(
        `Chunk 索引不連續（預期 ${existing.nextChunkIndex}，收到 ${params.chunkIndex}）。`,
      );
    }
    const expectedBounds = getChunkSampleBounds(
      params.chunkIndex,
      existing.totalSamples,
      existing.strideSamples,
    );
    if (
      params.startSample !== existing.committedEndSample ||
      params.startSample !== expectedBounds.startSample ||
      params.endSample !== expectedBounds.endSample
    ) {
      throw new Error(
        `Chunk 樣本範圍不一致（預期 [${expectedBounds.startSample}, ${expectedBounds.endSample})，收到 [${params.startSample}, ${params.endSample})）。`,
      );
    }

    const chunkRecord: SeparationChunkRecord = {
      key: createChunkKey(params.taskId, params.chunkIndex),
      taskId: params.taskId,
      chunkIndex: params.chunkIndex,
      startSample: params.startSample,
      endSample: params.endSample,
      modelVersion: existing.modelVersion,
      processingVersion: existing.processingVersion,
      separationMode: "four_stem",
      sampleRate: existing.sampleRate,
      stemCount: 4,
      payload: params.payload,
      checksum,
      sizeBytes: params.payload.byteLength,
      createdAt: now,
    };

    const nextChunkIndex = params.chunkIndex + 1;
    const isFinalChunk =
      nextChunkIndex >= existing.totalChunks || params.endSample >= existing.totalSamples;

    const activeExec = params.expectedLease ?? existing.lease;
    const nextExecutionGen = Math.max(
      existing.lastExecutionGeneration ?? 0,
      existing.finalizationFence?.generation ?? 0,
      activeExec?.generation ?? 0,
    );
    const nextFence: FinalizationFence | null = activeExec
      ? {
          taskId: existing.taskId,
          generation: activeExec.generation,
          ownerJobToken: activeExec.ownerJobToken,
          ownerTabId: activeExec.ownerTabId,
          updatedAt: now,
        }
      : (existing.finalizationFence ?? null);

    const updatedCheckpoint: SeparationCheckpoint = {
      ...existing,
      nextChunkIndex,
      committedEndSample: params.endSample,
      committedBytes: existing.committedBytes + params.payload.byteLength,
      overlapCarryBuffer: isFinalChunk ? null : params.overlapCarryBuffer,
      status: isFinalChunk ? "completed" : existing.status === "paused" ? "paused" : "running",
      lease: isFinalChunk ? null : existing.lease,
      lastExecutionGeneration: nextExecutionGen > 0 ? nextExecutionGen : existing.lastExecutionGeneration,
      finalizationFence: nextFence,
      lastError: undefined,
      updatedAt: now,
    };

    await idbRequestPromise(chunkStore.put(chunkRecord));
    await idbRequestPromise(cpStore.put(updatedCheckpoint));

    return {
      chunkRecord,
      checkpoint: updatedCheckpoint,
    };
  });
}

export async function deleteCheckpointAndChunks(taskId: string): Promise<{
  deletedChunks: number;
  deletedCheckpoint: boolean;
}> {
  return withIdbTransaction(["separationChunks", "separationCheckpoints"], "readwrite", async (tx) => {
    const chunkStore = tx.objectStore("separationChunks");
    const cpStore = tx.objectStore("separationCheckpoints");
    const deletedChunks = await deleteChunksByTaskIdInStore(chunkStore, taskId);
    const existingCp = (await idbRequestPromise(cpStore.get(taskId))) as
      | SeparationCheckpoint
      | undefined;
    if (existingCp) {
      await idbRequestPromise(cpStore.delete(taskId));
    }
    return {
      deletedChunks,
      deletedCheckpoint: Boolean(existingCp),
    };
  });
}

async function getCheckpointsBySourceAudioHashInStore(
  cpStore: IDBObjectStore,
  sourceAudioHash: string,
): Promise<SeparationCheckpoint[]> {
  if (
    typeof cpStore.index === "function" &&
    (!cpStore.indexNames || cpStore.indexNames.contains(SEPARATION_CHECKPOINT_HASH_INDEX))
  ) {
    return (await idbRequestPromise(
      cpStore.index(SEPARATION_CHECKPOINT_HASH_INDEX).getAll(sourceAudioHash),
    )) as SeparationCheckpoint[];
  }
  const all = (await idbRequestPromise(cpStore.getAll())) as SeparationCheckpoint[];
  return all.filter((cp) => cp.sourceAudioHash === sourceAudioHash);
}

export async function findLatestCheckpointBySourceAudioHash(
  sourceAudioHash: string,
  options?: {
    modelVersion?: string;
    processingVersion?: string;
    preferredStatus?: SeparationCheckpointStatus;
  },
): Promise<SeparationCheckpoint | null> {
  if (!sourceAudioHash) return null;
  const modelVersion = options?.modelVersion ?? DEMUCS_MODEL_VERSION;
  const processingVersion = options?.processingVersion ?? SEPARATION_PROCESSING_VERSION;
  const byHash = await withIdbTransaction("separationCheckpoints", "readonly", async (tx) => {
    return getCheckpointsBySourceAudioHashInStore(
      tx.objectStore("separationCheckpoints"),
      sourceAudioHash,
    );
  });
  const candidates = byHash.filter(
    (cp) =>
      cp.sourceAudioHash === sourceAudioHash &&
      cp.modelVersion === modelVersion &&
      cp.processingVersion === processingVersion &&
      (!options?.preferredStatus || cp.status === options.preferredStatus),
  );
  candidates.sort((a, b) => {
    if (a.status === "completed" && b.status !== "completed") return -1;
    if (b.status === "completed" && a.status !== "completed") return 1;
    return b.updatedAt - a.updatedAt;
  });
  return candidates[0] ?? null;
}

export async function findCompletedCheckpointBySourceAudioHash(
  sourceAudioHash: string,
  options?: {
    modelVersion?: string;
    processingVersion?: string;
  },
): Promise<SeparationCheckpoint | null> {
  return findLatestCheckpointBySourceAudioHash(sourceAudioHash, {
    ...options,
    preferredStatus: "completed",
  });
}

function buildEffectiveSongsMap(params: {
  persistedSongs: CheckpointSongReferenceCandidate[];
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  detachedSongId?: string;
  removedIds?: ReadonlySet<string>;
}): Map<string, CheckpointSongReferenceCandidate> {
  const map = new Map<string, CheckpointSongReferenceCandidate>();
  const skip = (id: string) =>
    !id || id === params.detachedSongId || Boolean(params.removedIds?.has(id));

  for (const s of params.persistedSongs) {
    const resolvedId = resolveCandidateSongId(s);
    if (skip(resolvedId)) continue;
    map.set(resolvedId, { ...s, id: resolvedId });
  }
  for (const s of params.knownInMemorySongs ?? []) {
    const resolvedId = resolveCandidateSongId(s);
    if (skip(resolvedId)) continue;
    map.set(resolvedId, { ...s, id: resolvedId });
  }
  return map;
}

function collectActiveReferencesForCheckpoint(params: {
  checkpoint: SeparationCheckpoint;
  effectiveSongsById: Map<string, CheckpointSongReferenceCandidate>;
  completedCheckpointTaskIds: ReadonlySet<string>;
  detachedSongId?: string;
  removedIds?: ReadonlySet<string>;
}): {
  refSongIds: string[];
  refModesBySongId: Record<string, "two_stem" | "four_stem">;
} {
  const { checkpoint, effectiveSongsById, completedCheckpointTaskIds } = params;
  const refs = new Set<string>();
  const modes: Record<string, "two_stem" | "four_stem"> = {
    ...(checkpoint.referencedModesBySongId ?? {}),
  };

  if (params.detachedSongId) {
    delete modes[params.detachedSongId];
  }
  for (const removedId of params.removedIds ?? []) {
    delete modes[removedId];
  }

  const isExcluded = (id: string) =>
    id === params.detachedSongId || Boolean(params.removedIds?.has(id));

  for (const refId of checkpoint.referencedBySongIds ?? []) {
    if (!refId || isExcluded(refId)) continue;
    const songState = effectiveSongsById.get(refId);
    if (
      songState &&
      songState.separationStatus === "not_started" &&
      !songState.separationTaskId
    ) {
      delete modes[refId];
      continue;
    }
    refs.add(refId);
    if (songState?.separationMode) {
      modes[refId] = songState.separationMode;
    }
  }

  // 向後相容：尚未寫入 referencedBySongIds 的舊 Checkpoint，若原建立歌曲仍存在且非 not_started，保留其引用
  if (
    checkpoint.referencedBySongIds === undefined &&
    checkpoint.songId &&
    !isExcluded(checkpoint.songId)
  ) {
    const ownerSong = effectiveSongsById.get(checkpoint.songId);
    if (ownerSong && ownerSong.separationStatus !== "not_started") {
      refs.add(checkpoint.songId);
      if (ownerSong.separationMode) {
        modes[checkpoint.songId] = ownerSong.separationMode;
      }
    }
  }

  for (const [songId, song] of effectiveSongsById.entries()) {
    if (isExcluded(songId)) continue;
    const directTaskRef =
      song.separationTaskId === checkpoint.taskId &&
      song.separationStatus !== "not_started";
    const sharedHashCompletedRef =
      checkpoint.status === "completed" &&
      Boolean(checkpoint.sourceAudioHash) &&
      song.sourceAudioHash === checkpoint.sourceAudioHash &&
      (song.separationStatus === "completed" ||
        song.separationStatus === "processing" ||
        Boolean(song.cacheKey)) &&
      !(
        song.separationTaskId &&
        song.separationTaskId !== checkpoint.taskId &&
        completedCheckpointTaskIds.has(song.separationTaskId)
      );

    if (directTaskRef || sharedHashCompletedRef) {
      refs.add(songId);
      if (song.separationMode) {
        modes[songId] = song.separationMode;
      }
    }
  }

  return {
    refSongIds: Array.from(refs),
    refModesBySongId: modes,
  };
}

export async function addCheckpointReference(params: {
  taskId: string;
  songId: string;
  mode?: "two_stem" | "four_stem";
  now?: number;
  source?: string;
}): Promise<SeparationCheckpoint | null> {
  const now = params.now ?? Date.now();
  const updated = await withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
    const store = tx.objectStore("separationCheckpoints");
    const existing = (await idbRequestPromise(store.get(params.taskId))) as
      | SeparationCheckpoint
      | undefined;
    if (!existing) return null;

    const existingRefs =
      existing.referencedBySongIds ??
      (existing.songId ? [existing.songId] : []);
    const nextRefs = Array.from(new Set([...existingRefs, params.songId]));
    const nextModes: Record<string, "two_stem" | "four_stem"> = {
      ...(existing.referencedModesBySongId ??
        (existing.songId ? { [existing.songId]: existing.requestedMode } : {})),
    };
    if (params.mode) {
      nextModes[params.songId] = params.mode;
    }

    const next: SeparationCheckpoint = {
      ...existing,
      referencedBySongIds: nextRefs,
      referencedModesBySongId: nextModes,
      updatedAt: now,
    };
    await idbRequestPromise(store.put(next));
    return next;
  });

  if (updated) {
    recordSeparationDiagnostic({
      event: "shared-checkpoint-reference-added",
      source: params.source ?? "addCheckpointReference",
      taskId: params.taskId,
      songId: params.songId,
      checkpointStatus: updated.status,
      validChunkCount: updated.nextChunkIndex,
      totalChunks: updated.totalChunks,
      referenceCount: updated.referencedBySongIds?.length ?? 1,
      leaseOwner: updated.lease?.ownerTabId ?? null,
      leaseState: isCheckpointLeaseActive(updated, now) ? "active" : "none",
      outcome: "added",
      note: params.mode ? `mode=${params.mode}` : undefined,
      timestamp: now,
    });
  }
  return updated;
}

export async function isCheckpointSharedOrLeased(params: {
  taskId: string;
  actingSongId: string;
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  knownRemovedSongIds?: Iterable<string>;
  now?: number;
}): Promise<{
  exists: boolean;
  sharedWithOtherSongs: boolean;
  activeLease: boolean;
  otherReferenceSongIds: string[];
}> {
  const now = params.now ?? Date.now();
  return withIdbTransaction(["songs", "separationCheckpoints"], "readonly", async (tx) => {
    const songStore = tx.objectStore("songs");
    const cpStore = tx.objectStore("separationCheckpoints");
    const persistedSongs = (await idbRequestPromise(
      songStore.getAll(),
    )) as CheckpointSongReferenceCandidate[];
    const allCps = (await idbRequestPromise(
      cpStore.getAll(),
    )) as SeparationCheckpoint[];
    const targetCp = allCps.find((cp) => cp.taskId === params.taskId);
    if (!targetCp) {
      return {
        exists: false,
        sharedWithOtherSongs: false,
        activeLease: false,
        otherReferenceSongIds: [],
      };
    }

    const completedIds = new Set(
      allCps.filter((c) => c.status === "completed").map((c) => c.taskId),
    );
    const removedIds = new Set(params.knownRemovedSongIds ?? []);
    const effectiveSongsById = buildEffectiveSongsMap({
      persistedSongs,
      knownInMemorySongs: params.knownInMemorySongs,
      detachedSongId: params.actingSongId,
      removedIds,
    });
    const { refSongIds } = collectActiveReferencesForCheckpoint({
      checkpoint: targetCp,
      effectiveSongsById,
      completedCheckpointTaskIds: completedIds,
      detachedSongId: params.actingSongId,
      removedIds,
    });
    const activeLease = isCheckpointLeaseActive(targetCp, now);
    return {
      exists: true,
      sharedWithOtherSongs: refSongIds.length > 0,
      activeLease,
      otherReferenceSongIds: refSongIds,
    };
  });
}

export interface ReleaseCheckpointReferenceParams {
  taskId?: string | null;
  sourceAudioHash?: string | null;
  songId: string;
  cacheKeyToRelease?: string | null;
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  knownRemovedSongIds?: Iterable<string>;
  now?: number;
  source?: string;
}

export interface ReleaseCheckpointReferenceResult {
  deletedTaskIds: string[];
  preservedTaskIds: string[];
  blockedByLeaseTaskIds: string[];
  deletedChunks: number;
  remainingReferences: number;
  deletedFastCache: boolean;
}

/**
 * 解除單首歌曲對共用 Checkpoint / Fast Cache 的引用，並在僅剩 0 引用且無有效 Lease 時安全回收底層 Chunk。
 * 全程在單一 IndexedDB readwrite 交易內完成，且只透過 by_taskId 刪除鍵，不載入二進位 PCM payload。
 */
export async function releaseCheckpointReferenceAndMaybeGc(
  params: ReleaseCheckpointReferenceParams,
): Promise<ReleaseCheckpointReferenceResult> {
  const now = params.now ?? Date.now();
  const source = params.source ?? "releaseCheckpointReferenceAndMaybeGc";
  const pendingDiagnostics: Array<Parameters<typeof recordSeparationDiagnostic>[0]> = [];

  const result = await withIdbTransaction(
    ["songs", "separationCheckpoints", "separationChunks", "separations"],
    "readwrite",
    async (tx) => {
      const songStore = tx.objectStore("songs");
      const cpStore = tx.objectStore("separationCheckpoints");
      const chunkStore = tx.objectStore("separationChunks");
      const sepStore = tx.objectStore("separations");

      const persistedSongs = (await idbRequestPromise(
        songStore.getAll(),
      )) as CheckpointSongReferenceCandidate[];
      const allCps = (await idbRequestPromise(
        cpStore.getAll(),
      )) as SeparationCheckpoint[];

      const completedCheckpointTaskIds = new Set(
        allCps.filter((c) => c.status === "completed").map((c) => c.taskId),
      );
      const removedIds = new Set(params.knownRemovedSongIds ?? []);
      const effectiveSongsById = buildEffectiveSongsMap({
        persistedSongs,
        knownInMemorySongs: params.knownInMemorySongs,
        detachedSongId: params.songId,
        removedIds,
      });

      const targetCheckpoints = allCps.filter((cp) => {
        if (params.taskId && cp.taskId === params.taskId) return true;
        if (
          params.sourceAudioHash &&
          cp.sourceAudioHash === params.sourceAudioHash &&
          (cp.songId === params.songId || cp.referencedBySongIds?.includes(params.songId))
        ) {
          return true;
        }
        return false;
      });

      const deletedTaskIds: string[] = [];
      const preservedTaskIds: string[] = [];
      const blockedByLeaseTaskIds: string[] = [];
      const survivingCheckpoints = new Map<string, SeparationCheckpoint>(
        allCps.map((c) => [c.taskId, c]),
      );
      let deletedChunks = 0;
      let maxRemainingReferences = 0;

      for (const cp of targetCheckpoints) {
        const { refSongIds, refModesBySongId } = collectActiveReferencesForCheckpoint({
          checkpoint: cp,
          effectiveSongsById,
          completedCheckpointTaskIds,
          detachedSongId: params.songId,
          removedIds,
        });
        const leaseActive = isCheckpointLeaseActive(cp, now);
        maxRemainingReferences = Math.max(maxRemainingReferences, refSongIds.length);

        pendingDiagnostics.push({
          event: "shared-checkpoint-reference-removed",
          source,
          taskId: cp.taskId,
          songId: params.songId,
          generation: cp.lease?.generation ?? null,
          checkpointStatus: cp.status,
          validChunkCount: cp.nextChunkIndex,
          totalChunks: cp.totalChunks,
          referenceCount: refSongIds.length,
          leaseOwner: cp.lease?.ownerTabId ?? null,
          leaseState: leaseActive ? "active" : "none",
          outcome: "detached",
          timestamp: now,
        });

        if (refSongIds.length > 0 || leaseActive) {
          const updatedCp: SeparationCheckpoint = {
            ...cp,
            referencedBySongIds: refSongIds,
            referencedModesBySongId: refModesBySongId,
            updatedAt: now,
          };
          await idbRequestPromise(cpStore.put(updatedCp));
          survivingCheckpoints.set(cp.taskId, updatedCp);
          preservedTaskIds.push(cp.taskId);
          if (leaseActive) blockedByLeaseTaskIds.push(cp.taskId);

          pendingDiagnostics.push({
            event: "checkpoint-delete-blocked",
            source,
            taskId: cp.taskId,
            songId: params.songId,
            generation: cp.lease?.generation ?? null,
            checkpointStatus: cp.status,
            validChunkCount: cp.nextChunkIndex,
            totalChunks: cp.totalChunks,
            referenceCount: refSongIds.length,
            leaseOwner: cp.lease?.ownerTabId ?? null,
            leaseState: leaseActive ? "active" : "none",
            outcome: "blocked",
            note: leaseActive
              ? `blocked checkpoint delete: active lease held by ${cp.lease?.ownerTabId ?? "unknown"}, refs=${refSongIds.length}`
              : `blocked checkpoint delete: still referenced by ${refSongIds.length} song(s)`,
            timestamp: now,
          });
          continue;
        }

        pendingDiagnostics.push({
          event: "checkpoint-gc-started",
          source,
          taskId: cp.taskId,
          songId: params.songId,
          checkpointStatus: cp.status,
          validChunkCount: cp.nextChunkIndex,
          totalChunks: cp.totalChunks,
          referenceCount: 0,
          leaseState: "none",
          outcome: "gc_started",
          timestamp: now,
        });

        const removedChunks = await deleteChunksByTaskIdInStore(chunkStore, cp.taskId);
        await idbRequestPromise(cpStore.delete(cp.taskId));
        survivingCheckpoints.delete(cp.taskId);
        deletedChunks += removedChunks;
        deletedTaskIds.push(cp.taskId);

        pendingDiagnostics.push({
          event: "checkpoint-gc-completed",
          source,
          taskId: cp.taskId,
          songId: params.songId,
          checkpointStatus: cp.status,
          validChunkCount: removedChunks,
          totalChunks: cp.totalChunks,
          referenceCount: 0,
          leaseState: "none",
          outcome: "deleted",
          note: `reclaimed unreferenced checkpoint and ${removedChunks} chunks`,
          timestamp: now,
        });
      }

      let deletedFastCache = false;
      if (params.cacheKeyToRelease) {
        const stillUsedBySong = Array.from(effectiveSongsById.values()).some(
          (s) => s.cacheKey === params.cacheKeyToRelease,
        );
        let stillUsedByCheckpointMode = false;
        for (const cp of survivingCheckpoints.values()) {
          const modes = cp.referencedModesBySongId ?? {};
          const activeIds = cp.referencedBySongIds ?? [];
          for (const refId of activeIds) {
            const mode = modes[refId] ?? cp.requestedMode;
            const key = createSeparationCacheKey({
              sourceAudioHash: cp.sourceAudioHash,
              modelVersion: cp.modelVersion,
              separationMode: mode,
              processingVersion: cp.processingVersion,
            });
            if (key === params.cacheKeyToRelease) {
              stillUsedByCheckpointMode = true;
              break;
            }
          }
          if (stillUsedByCheckpointMode) break;
        }
        if (!stillUsedBySong && !stillUsedByCheckpointMode) {
          const existingFast = await idbRequestPromise(sepStore.get(params.cacheKeyToRelease));
          if (existingFast) {
            await idbRequestPromise(sepStore.delete(params.cacheKeyToRelease));
            deletedFastCache = true;
          }
        }
      }

      return {
        deletedTaskIds,
        preservedTaskIds,
        blockedByLeaseTaskIds,
        deletedChunks,
        remainingReferences: maxRemainingReferences,
        deletedFastCache,
      };
    },
  );

  for (const diag of pendingDiagnostics) {
    recordSeparationDiagnostic(diag);
  }
  return result;
}

/**
 * 安全垃圾回收：清除已無任何歌曲引用且無有效 Lease 的 Checkpoint，以及無主孤兒 Chunk。
 * 全程透過 by_taskId.openKeyCursor() 與刪除鍵執行，絕不讀取大量音訊二進位 payload。
 */
export async function runCheckpointGarbageCollection(params?: {
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  knownRemovedSongIds?: Iterable<string>;
  now?: number;
  source?: string;
}): Promise<{
  deletedCheckpoints: number;
  deletedChunks: number;
  deletedOrphanChunkTasks: number;
  blockedByLeaseTaskIds: string[];
}> {
  const now = params?.now ?? Date.now();
  const source = params?.source ?? "runCheckpointGarbageCollection";
  const pendingDiagnostics: Array<Parameters<typeof recordSeparationDiagnostic>[0]> = [];

  const result = await withIdbTransaction(
    ["songs", "separationCheckpoints", "separationChunks"],
    "readwrite",
    async (tx) => {
      const songStore = tx.objectStore("songs");
      const cpStore = tx.objectStore("separationCheckpoints");
      const chunkStore = tx.objectStore("separationChunks");

      const persistedSongs = (await idbRequestPromise(
        songStore.getAll(),
      )) as CheckpointSongReferenceCandidate[];
      const allCps = (await idbRequestPromise(
        cpStore.getAll(),
      )) as SeparationCheckpoint[];
      const chunkKeysByTaskId = await collectChunkPrimaryKeysGroupedByTaskIdInStore(chunkStore);

      const completedCheckpointTaskIds = new Set(
        allCps.filter((c) => c.status === "completed").map((c) => c.taskId),
      );
      const removedIds = new Set(params?.knownRemovedSongIds ?? []);
      const effectiveSongsById = buildEffectiveSongsMap({
        persistedSongs,
        knownInMemorySongs: params?.knownInMemorySongs,
        removedIds,
      });

      const knownCheckpointIds = new Set(allCps.map((c) => c.taskId));
      const blockedByLeaseTaskIds: string[] = [];
      let deletedCheckpoints = 0;
      let deletedChunks = 0;
      let deletedOrphanChunkTasks = 0;

      for (const cp of allCps) {
        const { refSongIds } = collectActiveReferencesForCheckpoint({
          checkpoint: cp,
          effectiveSongsById,
          completedCheckpointTaskIds,
          removedIds,
        });
        const leaseActive = isCheckpointLeaseActive(cp, now);
        if (refSongIds.length > 0) continue;
        if (leaseActive) {
          blockedByLeaseTaskIds.push(cp.taskId);
          pendingDiagnostics.push({
            event: "checkpoint-delete-blocked",
            source,
            taskId: cp.taskId,
            songId: cp.songId,
            generation: cp.lease?.generation ?? null,
            checkpointStatus: cp.status,
            validChunkCount: cp.nextChunkIndex,
            totalChunks: cp.totalChunks,
            referenceCount: 0,
            leaseOwner: cp.lease?.ownerTabId ?? null,
            leaseState: "active",
            outcome: "blocked",
            timestamp: now,
          });
          continue;
        }

        pendingDiagnostics.push({
          event: "checkpoint-gc-started",
          source,
          taskId: cp.taskId,
          songId: cp.songId,
          checkpointStatus: cp.status,
          validChunkCount: cp.nextChunkIndex,
          totalChunks: cp.totalChunks,
          referenceCount: 0,
          leaseState: "none",
          outcome: "gc_started",
          timestamp: now,
        });

        const keys = chunkKeysByTaskId.get(cp.taskId) ?? [];
        for (const key of keys) {
          await idbRequestPromise(chunkStore.delete(key));
          deletedChunks++;
        }
        await idbRequestPromise(cpStore.delete(cp.taskId));
        deletedCheckpoints++;

        pendingDiagnostics.push({
          event: "checkpoint-gc-completed",
          source,
          taskId: cp.taskId,
          songId: cp.songId,
          checkpointStatus: cp.status,
          validChunkCount: keys.length,
          totalChunks: cp.totalChunks,
          referenceCount: 0,
          leaseState: "none",
          outcome: "deleted",
          timestamp: now,
        });
      }

      for (const [taskId, keys] of chunkKeysByTaskId.entries()) {
        if (knownCheckpointIds.has(taskId)) continue;
        pendingDiagnostics.push({
          event: "checkpoint-gc-started",
          source,
          taskId,
          referenceCount: 0,
          leaseState: "none",
          outcome: "orphan_chunk_gc_started",
          timestamp: now,
        });
        for (const key of keys) {
          await idbRequestPromise(chunkStore.delete(key));
          deletedChunks++;
        }
        deletedOrphanChunkTasks++;
        pendingDiagnostics.push({
          event: "checkpoint-gc-completed",
          source,
          taskId,
          validChunkCount: keys.length,
          referenceCount: 0,
          leaseState: "none",
          outcome: "orphan_chunks_deleted",
          timestamp: now,
        });
      }

      return {
        deletedCheckpoints,
        deletedChunks,
        deletedOrphanChunkTasks,
        blockedByLeaseTaskIds,
      };
    },
  );

  for (const diag of pendingDiagnostics) {
    recordSeparationDiagnostic(diag);
  }
  return result;
}

export async function deleteIncompleteCheckpointsForSong(params: {
  songId?: string;
  sourceAudioHash?: string;
  excludeTaskId?: string;
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  now?: number;
}): Promise<{
  deletedCheckpoints: number;
  deletedChunks: number;
  preservedCompletedTaskIds: string[];
  blockedByLeaseTaskIds: string[];
}> {
  const now = params.now ?? Date.now();
  const pendingDiagnostics: Array<Parameters<typeof recordSeparationDiagnostic>[0]> = [];

  const result = await withIdbTransaction(
    ["songs", "separationChunks", "separationCheckpoints"],
    "readwrite",
    async (tx) => {
      const songStore = tx.objectStore("songs");
      const chunkStore = tx.objectStore("separationChunks");
      const cpStore = tx.objectStore("separationCheckpoints");
      const persistedSongs = (await idbRequestPromise(
        songStore.getAll(),
      )) as CheckpointSongReferenceCandidate[];
      const allCps = (await idbRequestPromise(cpStore.getAll())) as SeparationCheckpoint[];

      const effectiveSongsById = buildEffectiveSongsMap({
        persistedSongs,
        knownInMemorySongs: params.knownInMemorySongs,
        detachedSongId: params.songId,
      });
      const completedCheckpointTaskIds = new Set(
        allCps.filter((c) => c.status === "completed").map((c) => c.taskId),
      );

      const targetTaskIds = new Set<string>();
      const preservedCompletedTaskIds: string[] = [];
      const blockedByLeaseTaskIds: string[] = [];

      for (const cp of allCps) {
        const matchesSong =
          (params.songId && cp.songId === params.songId) ||
          (params.sourceAudioHash && cp.sourceAudioHash === params.sourceAudioHash);
        if (!matchesSong) continue;
        if (params.excludeTaskId && cp.taskId === params.excludeTaskId) continue;
        if (cp.status === "completed") {
          preservedCompletedTaskIds.push(cp.taskId);
          continue;
        }
        if (isCheckpointLeaseActive(cp, now)) {
          blockedByLeaseTaskIds.push(cp.taskId);
          pendingDiagnostics.push({
            event: "checkpoint-delete-blocked",
            source: "deleteIncompleteCheckpointsForSong",
            taskId: cp.taskId,
            songId: params.songId ?? cp.songId,
            checkpointStatus: cp.status,
            leaseOwner: cp.lease?.ownerTabId ?? null,
            leaseState: "active",
            outcome: "blocked",
            note: "skipped active lease during temp cleanup",
            timestamp: now,
          });
          continue;
        }
        const { refSongIds } = collectActiveReferencesForCheckpoint({
          checkpoint: cp,
          effectiveSongsById,
          completedCheckpointTaskIds,
          detachedSongId: params.songId,
        });
        if (refSongIds.length > 0 && params.songId && cp.songId !== params.songId) {
          pendingDiagnostics.push({
            event: "checkpoint-delete-blocked",
            source: "deleteIncompleteCheckpointsForSong",
            taskId: cp.taskId,
            songId: params.songId,
            checkpointStatus: cp.status,
            referenceCount: refSongIds.length,
            leaseState: "none",
            outcome: "blocked",
            note: "skipped incomplete checkpoint still used by another song",
            timestamp: now,
          });
          continue;
        }
        targetTaskIds.add(cp.taskId);
      }

      let deletedCheckpoints = 0;
      let deletedChunks = 0;
      for (const taskId of targetTaskIds) {
        deletedChunks += await deleteChunksByTaskIdInStore(chunkStore, taskId);
        await idbRequestPromise(cpStore.delete(taskId));
        deletedCheckpoints++;
      }

      return {
        deletedCheckpoints,
        deletedChunks,
        preservedCompletedTaskIds,
        blockedByLeaseTaskIds,
      };
    },
  );

  for (const diag of pendingDiagnostics) {
    recordSeparationDiagnostic(diag);
  }
  return result;
}

export async function deleteAllIncompleteCheckpoints(options?: {
  now?: number;
}): Promise<{
  deletedCheckpoints: number;
  deletedChunks: number;
  preservedCompletedCount: number;
  blockedByLeaseTaskIds: string[];
}> {
  const now = options?.now ?? Date.now();
  const pendingDiagnostics: Array<Parameters<typeof recordSeparationDiagnostic>[0]> = [];

  const result = await withIdbTransaction(
    ["separationChunks", "separationCheckpoints"],
    "readwrite",
    async (tx) => {
      const chunkStore = tx.objectStore("separationChunks");
      const cpStore = tx.objectStore("separationCheckpoints");
      const allCps = (await idbRequestPromise(cpStore.getAll())) as SeparationCheckpoint[];
      const chunkKeysByTaskId = await collectChunkPrimaryKeysGroupedByTaskIdInStore(chunkStore);

      const protectedTaskIds = new Set<string>();
      const incompleteTaskIds = new Set<string>();
      const blockedByLeaseTaskIds: string[] = [];
      let completedCount = 0;

      for (const cp of allCps) {
        if (cp.status === "completed") {
          protectedTaskIds.add(cp.taskId);
          completedCount++;
        } else if (isCheckpointLeaseActive(cp, now)) {
          protectedTaskIds.add(cp.taskId);
          blockedByLeaseTaskIds.push(cp.taskId);
          pendingDiagnostics.push({
            event: "checkpoint-delete-blocked",
            source: "deleteAllIncompleteCheckpoints",
            taskId: cp.taskId,
            songId: cp.songId,
            checkpointStatus: cp.status,
            leaseOwner: cp.lease?.ownerTabId ?? null,
            leaseState: "active",
            outcome: "blocked",
            note: "skipped active lease during global temp cleanup",
            timestamp: now,
          });
        } else {
          incompleteTaskIds.add(cp.taskId);
        }
      }

      let deletedCheckpoints = 0;
      let deletedChunks = 0;
      for (const taskId of incompleteTaskIds) {
        await idbRequestPromise(cpStore.delete(taskId));
        deletedCheckpoints++;
      }

      for (const [taskId, keys] of chunkKeysByTaskId.entries()) {
        if (!protectedTaskIds.has(taskId)) {
          for (const key of keys) {
            await idbRequestPromise(chunkStore.delete(key));
            deletedChunks++;
          }
        }
      }

      return {
        deletedCheckpoints,
        deletedChunks,
        preservedCompletedCount: completedCount,
        blockedByLeaseTaskIds,
      };
    },
  );

  for (const diag of pendingDiagnostics) {
    recordSeparationDiagnostic(diag);
  }
  return result;
}
