import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "./cacheKeys.ts";
import {
  DEMUCS_OVERLAP_CARRY_BYTES,
  DEMUCS_SAMPLE_RATE,
  DEMUCS_SEGMENT_OVERLAP,
  DEMUCS_STRIDE_SAMPLES,
  DEMUCS_TRAINING_SAMPLES,
  type SeparationChunkRecord,
  computeBufferChecksum,
  computeTotalChunks,
  createChunkKey,
  getChunkSampleBounds,
  validateChunkPayloadInPlace,
} from "./separationChunkStore.ts";
import {
  idbGet,
  idbGetAll,
  idbPut,
  idbRequestPromise,
  withIdbTransaction,
} from "./indexedDb.ts";

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
  createdAt: number;
  updatedAt: number;
}

export function createCheckpointTaskId(
  songId: string,
  sourceAudioHash: string,
  modelVersion = DEMUCS_MODEL_VERSION,
  processingVersion = SEPARATION_PROCESSING_VERSION,
): string {
  return `sep:${songId}:${sourceAudioHash}:${modelVersion}:${processingVersion}`;
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
      if (patch.clearLeaseIfTerminal && existing.lease !== null) {
        const preserved: SeparationCheckpoint = {
          ...existing,
          lease: null,
          updatedAt: now,
        };
        await idbRequestPromise(store.put(preserved));
        return preserved;
      }
      return existing;
    }
    const next: SeparationCheckpoint = {
      ...existing,
      status: patch.status,
      lastError: patch.lastError,
      userAuthorized: patch.userAuthorized ?? existing.userAuthorized,
      requestedMode: patch.requestedMode ?? existing.requestedMode,
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
      throw new Error(`找不到分離任務 Checkpoint：${params.taskId}`);
    }
    if (existing.status === "cancelled") {
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

    const updatedCheckpoint: SeparationCheckpoint = {
      ...existing,
      nextChunkIndex,
      committedEndSample: params.endSample,
      committedBytes: existing.committedBytes + params.payload.byteLength,
      overlapCarryBuffer: isFinalChunk ? null : params.overlapCarryBuffer,
      status: isFinalChunk ? "completed" : existing.status === "paused" ? "paused" : "running",
      lease: isFinalChunk ? null : existing.lease,
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
    const allChunks = (await idbRequestPromise(chunkStore.getAll())) as SeparationChunkRecord[];
    let deletedChunks = 0;
    for (const rec of allChunks) {
      if (rec.taskId === taskId) {
        await idbRequestPromise(chunkStore.delete(rec.key));
        deletedChunks++;
      }
    }
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
  const all = await getAllCheckpoints();
  const candidates = all.filter(
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

export async function deleteIncompleteCheckpointsForSong(params: {
  songId?: string;
  sourceAudioHash?: string;
  excludeTaskId?: string;
}): Promise<{
  deletedCheckpoints: number;
  deletedChunks: number;
  preservedCompletedTaskIds: string[];
}> {
  return withIdbTransaction(["separationChunks", "separationCheckpoints"], "readwrite", async (tx) => {
    const chunkStore = tx.objectStore("separationChunks");
    const cpStore = tx.objectStore("separationCheckpoints");
    const allCps = (await idbRequestPromise(cpStore.getAll())) as SeparationCheckpoint[];
    const allChunks = (await idbRequestPromise(chunkStore.getAll())) as SeparationChunkRecord[];

    const targetTaskIds = new Set<string>();
    const preservedCompletedTaskIds: string[] = [];

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
      targetTaskIds.add(cp.taskId);
    }

    let deletedCheckpoints = 0;
    for (const taskId of targetTaskIds) {
      await idbRequestPromise(cpStore.delete(taskId));
      deletedCheckpoints++;
    }

    let deletedChunks = 0;
    for (const rec of allChunks) {
      if (targetTaskIds.has(rec.taskId)) {
        await idbRequestPromise(chunkStore.delete(rec.key));
        deletedChunks++;
      }
    }

    return {
      deletedCheckpoints,
      deletedChunks,
      preservedCompletedTaskIds,
    };
  });
}

export async function deleteAllIncompleteCheckpoints(): Promise<{
  deletedCheckpoints: number;
  deletedChunks: number;
  preservedCompletedCount: number;
}> {
  return withIdbTransaction(["separationChunks", "separationCheckpoints"], "readwrite", async (tx) => {
    const chunkStore = tx.objectStore("separationChunks");
    const cpStore = tx.objectStore("separationCheckpoints");
    const allCps = (await idbRequestPromise(cpStore.getAll())) as SeparationCheckpoint[];
    const allChunks = (await idbRequestPromise(chunkStore.getAll())) as SeparationChunkRecord[];

    const completedTaskIds = new Set<string>();
    const incompleteTaskIds = new Set<string>();

    for (const cp of allCps) {
      if (cp.status === "completed") {
        completedTaskIds.add(cp.taskId);
      } else {
        incompleteTaskIds.add(cp.taskId);
      }
    }

    let deletedCheckpoints = 0;
    for (const taskId of incompleteTaskIds) {
      await idbRequestPromise(cpStore.delete(taskId));
      deletedCheckpoints++;
    }

    let deletedChunks = 0;
    for (const rec of allChunks) {
      if (!completedTaskIds.has(rec.taskId)) {
        await idbRequestPromise(chunkStore.delete(rec.key));
        deletedChunks++;
      }
    }

    return {
      deletedCheckpoints,
      deletedChunks,
      preservedCompletedCount: completedTaskIds.size,
    };
  });
}
