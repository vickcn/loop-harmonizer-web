import type { TaskAdmissionDecision } from "../band/resourceGuard.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../storage/cacheKeys.ts";
import { idbRequestPromise, withIdbTransaction } from "../storage/indexedDb.ts";
import {
  type FinalizationFence,
  type PersistedCheckpointRetryState,
  type SeparationCheckpoint,
  type SeparationCheckpointStatus,
  type SeparationLeaseInfo,
  getCheckpoint,
  saveCheckpoint,
  validateOverlapCarryBuffer,
} from "../storage/separationCheckpointStore.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_SEGMENT_OVERLAP,
  DEMUCS_STRIDE_SAMPLES,
  DEMUCS_TRAINING_SAMPLES,
  type SeparationChunkRecord,
  getChunkSampleBounds,
  getTaskChunkRecordsInStore,
  validateChunkRecordIntegrity,
} from "../storage/separationChunkStore.ts";
import { recordSeparationDiagnostic } from "./separationStateRecovery.ts";

/** 背景分頁 timer 會節流，TTL 必須大於單次 heartbeat 間隔的數倍。 */
export const DEFAULT_BACKGROUND_JOB_LEASE_TTL_MS = 90_000;
export const DEFAULT_JOB_LEASE_TTL_MS = DEFAULT_BACKGROUND_JOB_LEASE_TTL_MS;
export const DEFAULT_JOB_HEARTBEAT_MS = 20_000;
export const SEPARATION_LEASE_CHANNEL_NAME = "loop-harmonizer-separation-lease";

export interface ResumeValidationContext {
  sourceAudioAvailable: boolean;
  sourceAudioHash: string;
  totalSamples?: number;
  sampleRate?: number;
  modelVersion?: string;
  processingVersion?: string;
  viewerTabId?: string;
  now?: number;
}

export interface ResumeValidationResult {
  valid: boolean;
  action: "already_completed" | "resume" | "recompute_from_scratch" | "blocked";
  reason?: string;
  resumeFromChunkIndex: number;
  totalChunks: number;
  validChunkCount: number;
  repairedChunksDeleted: number;
  needsOverlapWarmup: boolean;
  checkpoint: SeparationCheckpoint | null;
}

export interface AutoResumeEligibilityParams {
  checkpoint: SeparationCheckpoint | null;
  validation: ResumeValidationResult;
  tabId: string;
  isDocumentHidden: boolean;
  hasActiveLocalDemucsTask: boolean;
  taskAdmission: { allowed: boolean; reason?: string; reasons?: string[] };
  networkBudgetAllowed: boolean;
  networkBudgetReason?: string;
  now?: number;
}

export interface AutoResumeEligibilityResult {
  allowed: boolean;
  code:
    | "ok"
    | "hidden"
    | "unauthorized"
    | "cancelled"
    | "paused"
    | "completed"
    | "already_running"
    | "foreign_lease"
    | "resource_blocked"
    | "network_blocked"
    | "invalid_checkpoint";
  reason?: string;
}

let volatileTabId: string | null = null;

export function getOrCreateTabId(): string {
  if (typeof window !== "undefined") {
    try {
      const existing = window.sessionStorage?.getItem("loop-harmonizer-tab-id");
      if (existing) return existing;
      const generated =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage?.setItem("loop-harmonizer-tab-id", generated);
      return generated;
    } catch {
      // sessionStorage 不可用時使用分頁記憶體內 ID
    }
  }
  if (!volatileTabId) {
    volatileTabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return volatileTabId;
}

export function createJobToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 恢復 Checkpoint 前的嚴格完整性驗證與自動修復：
 * - 核對來源音訊存在、sourceAudioHash、模型/處理版本、取樣率、segmentSize / stride / overlap；
 * - 逐一校驗已持久化 Chunk 索引連續性、樣本範圍與 Checksum（發現損毀/缺洞則僅從該段起截斷重算）；
 * - 保留通過驗證的 0 .. k-1 段，絕不重複推論。
 */
export async function validateAndPrepareResume(
  taskId: string,
  context: ResumeValidationContext,
): Promise<ResumeValidationResult> {
  if (!context.sourceAudioAvailable) {
    return {
      valid: false,
      action: "blocked",
      reason: "找不到來源音訊檔案，無法驗證與接續分離任務。",
      resumeFromChunkIndex: 0,
      totalChunks: 0,
      validChunkCount: 0,
      repairedChunksDeleted: 0,
      needsOverlapWarmup: false,
      checkpoint: null,
    };
  }

  const { checkpoint, records } = await withIdbTransaction(
    ["separationCheckpoints", "separationChunks"],
    "readonly",
    async (tx) => {
      const cpStore = tx.objectStore("separationCheckpoints");
      const chunkStore = tx.objectStore("separationChunks");
      const cp = ((await idbRequestPromise(cpStore.get(taskId))) ?? null) as
        | SeparationCheckpoint
        | null;
      const taskRecords = await getTaskChunkRecordsInStore(chunkStore, taskId);
      return { checkpoint: cp, records: taskRecords };
    },
  );
  if (!checkpoint) {
    return {
      valid: true,
      action: "recompute_from_scratch",
      reason: "尚未建立 Checkpoint，需從第 0 段開始分離。",
      resumeFromChunkIndex: 0,
      totalChunks: 0,
      validChunkCount: 0,
      repairedChunksDeleted: 0,
      needsOverlapWarmup: false,
      checkpoint: null,
    };
  }

  const expectedModelVersion = context.modelVersion ?? DEMUCS_MODEL_VERSION;
  const expectedProcessingVersion =
    context.processingVersion ?? SEPARATION_PROCESSING_VERSION;
  const expectedSampleRate = context.sampleRate ?? DEMUCS_SAMPLE_RATE;

  if (checkpoint.sourceAudioHash !== context.sourceAudioHash) {
    return {
      valid: false,
      action: "recompute_from_scratch",
      reason: "來源音訊雜湊（sourceAudioHash）已變更，Checkpoint 失效。",
      resumeFromChunkIndex: 0,
      totalChunks: checkpoint.totalChunks,
      validChunkCount: 0,
      repairedChunksDeleted: 0,
      needsOverlapWarmup: false,
      checkpoint,
    };
  }
  if (
    checkpoint.modelVersion !== expectedModelVersion ||
    checkpoint.processingVersion !== expectedProcessingVersion
  ) {
    return {
      valid: false,
      action: "recompute_from_scratch",
      reason: "Demucs 模型或處理版本已更新，需重新分離以確保音軌一致性。",
      resumeFromChunkIndex: 0,
      totalChunks: checkpoint.totalChunks,
      validChunkCount: 0,
      repairedChunksDeleted: 0,
      needsOverlapWarmup: false,
      checkpoint,
    };
  }
  if (
    checkpoint.sampleRate !== expectedSampleRate ||
    checkpoint.trainingSamples !== DEMUCS_TRAINING_SAMPLES ||
    checkpoint.strideSamples !== DEMUCS_STRIDE_SAMPLES ||
    Math.abs(checkpoint.overlapRatio - DEMUCS_SEGMENT_OVERLAP) > 1e-6 ||
    (typeof context.totalSamples === "number" && context.totalSamples !== checkpoint.totalSamples)
  ) {
    return {
      valid: false,
      action: "recompute_from_scratch",
      reason: "取樣率、重疊參數或音訊樣本總長度與 Checkpoint 不一致。",
      resumeFromChunkIndex: 0,
      totalChunks: checkpoint.totalChunks,
      validChunkCount: 0,
      repairedChunksDeleted: 0,
      needsOverlapWarmup: false,
      checkpoint,
    };
  }

  const byIndex = new Map<number, SeparationChunkRecord>();
  const duplicateKeys: string[] = [];

  for (const rec of records) {
    if (
      rec.modelVersion !== checkpoint.modelVersion ||
      rec.processingVersion !== checkpoint.processingVersion ||
      rec.sampleRate !== checkpoint.sampleRate
    ) {
      duplicateKeys.push(rec.key);
      continue;
    }
    if (byIndex.has(rec.chunkIndex)) {
      duplicateKeys.push(rec.key);
    } else {
      byIndex.set(rec.chunkIndex, rec);
    }
  }

  // 逐段驗證 0 .. totalChunks - 1 的連續性、樣本範圍與 Checksum
  let validPrefixCount = 0;
  let committedBytes = 0;
  let committedEndSample = 0;

  for (let i = 0; i < checkpoint.totalChunks; i++) {
    const rec = byIndex.get(i);
    if (!rec) break;
    const expectedBounds = getChunkSampleBounds(
      i,
      checkpoint.totalSamples,
      checkpoint.strideSamples,
    );
    if (
      rec.startSample !== expectedBounds.startSample ||
      rec.endSample !== expectedBounds.endSample
    ) {
      break;
    }
    const integrity = validateChunkRecordIntegrity(rec);
    if (!integrity.valid) {
      break;
    }
    validPrefixCount++;
    committedBytes += rec.sizeBytes;
    committedEndSample = rec.endSample;
  }

  // 找出應清理的毀損、孤兒或不連續尾端 Chunks
  const keysToDelete: string[] = [...duplicateKeys];
  for (const rec of records) {
    if (rec.chunkIndex >= validPrefixCount) {
      keysToDelete.push(rec.key);
    }
  }

  const nowTs = context.now ?? Date.now();
  const hasForeignActiveLease = Boolean(
    context.viewerTabId &&
      checkpoint.lease &&
      checkpoint.lease.ownerTabId !== context.viewerTabId &&
      checkpoint.lease.leaseExpiresAt > nowTs,
  );

  const needsCheckpointRepair =
    keysToDelete.length > 0 ||
    checkpoint.nextChunkIndex !== validPrefixCount ||
    checkpoint.committedEndSample !== committedEndSample ||
    checkpoint.committedBytes !== committedBytes ||
    (checkpoint.status === "completed" &&
      (validPrefixCount < checkpoint.totalChunks ||
        committedEndSample < checkpoint.totalSamples));

  let effectiveCheckpoint = checkpoint;
  if (needsCheckpointRepair) {
    const carryValid =
      validPrefixCount > 0 &&
      validPrefixCount === checkpoint.nextChunkIndex &&
      validateOverlapCarryBuffer(checkpoint.overlapCarryBuffer);

    const isCompletedNow =
      validPrefixCount >= checkpoint.totalChunks &&
      committedEndSample >= checkpoint.totalSamples;
    const preservedGen = Math.max(
      checkpoint.lastExecutionGeneration ?? 0,
      checkpoint.finalizationFence?.generation ?? 0,
      checkpoint.lease?.generation ?? 0,
    );
    const preservedFence: FinalizationFence | null =
      checkpoint.finalizationFence ??
      (checkpoint.lease
        ? {
            taskId: checkpoint.taskId,
            generation: checkpoint.lease.generation,
            ownerJobToken: checkpoint.lease.ownerJobToken,
            ownerTabId: checkpoint.lease.ownerTabId,
            updatedAt: nowTs,
          }
        : null);
    effectiveCheckpoint = {
      ...checkpoint,
      nextChunkIndex: validPrefixCount,
      committedEndSample,
      committedBytes,
      overlapCarryBuffer: carryValid ? checkpoint.overlapCarryBuffer : null,
      status: isCompletedNow
        ? "completed"
        : checkpoint.status === "completed"
          ? "interrupted"
          : checkpoint.status,
      lease: isCompletedNow ? null : checkpoint.lease,
      lastExecutionGeneration: preservedGen > 0 ? preservedGen : checkpoint.lastExecutionGeneration,
      finalizationFence: preservedFence,
      updatedAt: nowTs,
    };

    recordSeparationDiagnostic({
      source: "validateAndPrepareResume",
      taskId: checkpoint.taskId,
      songId: checkpoint.songId,
      generation: checkpoint.lease?.generation ?? null,
      checkpointStatus: effectiveCheckpoint.status,
      validChunkCount: validPrefixCount,
      totalChunks: checkpoint.totalChunks,
      leaseOwner: checkpoint.lease?.ownerTabId ?? null,
      fromState: checkpoint.status,
      toState: effectiveCheckpoint.status,
      note: hasForeignActiveLease
        ? `skipped IDB repair due to active foreign lease (${keysToDelete.length} stale chunks ignored)`
        : `repaired checkpoint (deleted=${keysToDelete.length})`,
      timestamp: nowTs,
    });

    if (!hasForeignActiveLease) {
      await withIdbTransaction(["separationChunks", "separationCheckpoints"], "readwrite", async (tx) => {
        const chunkStore = tx.objectStore("separationChunks");
        const cpStore = tx.objectStore("separationCheckpoints");
        for (const key of keysToDelete) {
          await idbRequestPromise(chunkStore.delete(key));
        }
        await idbRequestPromise(cpStore.put(effectiveCheckpoint));
      });
    }
  }

  if (
    validPrefixCount >= effectiveCheckpoint.totalChunks &&
    effectiveCheckpoint.committedEndSample >= effectiveCheckpoint.totalSamples
  ) {
    if (effectiveCheckpoint.status !== "completed") {
      const prevStatus = effectiveCheckpoint.status;
      const upgradedGen = Math.max(
        effectiveCheckpoint.lastExecutionGeneration ?? 0,
        effectiveCheckpoint.finalizationFence?.generation ?? 0,
        effectiveCheckpoint.lease?.generation ?? 0,
      );
      const upgradedFence: FinalizationFence | null =
        effectiveCheckpoint.finalizationFence ??
        (effectiveCheckpoint.lease
          ? {
              taskId: effectiveCheckpoint.taskId,
              generation: effectiveCheckpoint.lease.generation,
              ownerJobToken: effectiveCheckpoint.lease.ownerJobToken,
              ownerTabId: effectiveCheckpoint.lease.ownerTabId,
              updatedAt: nowTs,
            }
          : null);
      effectiveCheckpoint = {
        ...effectiveCheckpoint,
        status: "completed",
        overlapCarryBuffer: null,
        lease: null,
        lastExecutionGeneration: upgradedGen > 0 ? upgradedGen : effectiveCheckpoint.lastExecutionGeneration,
        finalizationFence: upgradedFence,
        updatedAt: nowTs,
      };
      recordSeparationDiagnostic({
        source: "validateAndPrepareResume",
        taskId: effectiveCheckpoint.taskId,
        songId: effectiveCheckpoint.songId,
        generation: effectiveCheckpoint.lease?.generation ?? null,
        checkpointStatus: "completed",
        validChunkCount: validPrefixCount,
        totalChunks: effectiveCheckpoint.totalChunks,
        fromState: prevStatus,
        toState: "completed",
        note: "upgraded checkpoint status to completed from verified chunks",
        timestamp: nowTs,
      });
      if (!hasForeignActiveLease) {
        await saveCheckpoint(effectiveCheckpoint);
      }
    }
    return {
      valid: true,
      action: "already_completed",
      resumeFromChunkIndex: effectiveCheckpoint.totalChunks,
      totalChunks: effectiveCheckpoint.totalChunks,
      validChunkCount: validPrefixCount,
      repairedChunksDeleted: keysToDelete.length,
      needsOverlapWarmup: false,
      checkpoint: effectiveCheckpoint,
    };
  }

  const hasValidCarry =
    validPrefixCount === 0 ||
    (effectiveCheckpoint.overlapCarryBuffer !== null &&
      validateOverlapCarryBuffer(effectiveCheckpoint.overlapCarryBuffer));

  return {
    valid: true,
    action: "resume",
    resumeFromChunkIndex: validPrefixCount,
    totalChunks: effectiveCheckpoint.totalChunks,
    validChunkCount: validPrefixCount,
    repairedChunksDeleted: keysToDelete.length,
    needsOverlapWarmup: validPrefixCount > 0 && !hasValidCarry,
    checkpoint: effectiveCheckpoint,
  };
}

export function evaluateAutoResumeEligibility(
  params: AutoResumeEligibilityParams,
): AutoResumeEligibilityResult {
  const { checkpoint, validation } = params;
  const now = params.now ?? Date.now();

  if (!checkpoint || validation.action === "blocked") {
    return {
      allowed: false,
      code: "invalid_checkpoint",
      reason: validation.reason ?? "找不到可恢復的 Checkpoint。",
    };
  }
  if (validation.action === "already_completed" || checkpoint.status === "completed") {
    return {
      allowed: false,
      code: "completed",
      reason: "此分離任務已完成全部 Chunk。",
    };
  }
  if (checkpoint.status === "cancelled") {
    return {
      allowed: false,
      code: "cancelled",
      reason: "使用者已手動取消分離，禁止自動續跑（保留已完成 Chunk）。",
    };
  }
  if (checkpoint.status === "paused") {
    return {
      allowed: false,
      code: "paused",
      reason: "分離任務已由使用者暫停，等待明確點擊「繼續分離」。",
    };
  }
  if (!checkpoint.userAuthorized) {
    return {
      allowed: false,
      code: "unauthorized",
      reason: "此分離任務尚未取得使用者明確授權。",
    };
  }
  if (params.isDocumentHidden) {
    return {
      allowed: false,
      code: "hidden",
      reason: "頁面位於背景或已隱藏，等待回到前景後再評估續跑。",
    };
  }
  if (params.hasActiveLocalDemucsTask) {
    return {
      allowed: false,
      code: "already_running",
      reason: "目前分頁已有執行中的 Demucs 任務，略過重複啟動。",
    };
  }
  if (
    checkpoint.lease &&
    checkpoint.lease.ownerTabId !== params.tabId &&
    checkpoint.lease.leaseExpiresAt > now
  ) {
    return {
      allowed: false,
      code: "foreign_lease",
      reason: `任務正由另一分頁（${checkpoint.lease.ownerTabId.slice(0, 8)}）持有執行權。`,
    };
  }
  if (!params.taskAdmission.allowed) {
    return {
      allowed: false,
      code: "resource_blocked",
      reason: params.taskAdmission.reason ?? params.taskAdmission.reasons?.[0] ?? "目前裝置資源預算不足以安全續跑 Demucs。",
    };
  }
  if (!params.networkBudgetAllowed) {
    return {
      allowed: false,
      code: "network_blocked",
      reason: params.networkBudgetReason ?? "網路傳輸預算不足（禁止未經核准之大型靜態下載）。",
    };
  }
  return { allowed: true, code: "ok" };
}

export interface LeaseBroadcastMessage {
  type:
    | "lease-acquired"
    | "lease-released"
    | "task-progress"
    | "task-cancelled"
    | "task-paused"
    | "task-completed"
    | "task-failed";
  taskId: string;
  ownerTabId: string;
  generation?: number;
  completedChunks?: number;
  totalChunks?: number;
  committedBytes?: number;
  message?: string;
  timestamp: number;
}

export type WebLockAdapter = {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T>;
};

/**
 * 跨分頁單一執行鎖（Lease + Heartbeat + Generation Token + Web Locks 輔助）。
 * 防止多個分頁同時啟動重複 Demucs Worker 或覆寫 IndexedDB Chunk。
 */
export class SeparationJobLeaseManager {
  private channel: BroadcastChannel | null = null;
  private closed = false;
  private readonly lockAdapter?: WebLockAdapter | null;

  constructor(options?: { lockAdapter?: WebLockAdapter | null }) {
    this.lockAdapter = options?.lockAdapter;
  }

  /**
   * Web Lock 必須覆蓋整個推論生命週期，而不是只包住 acquireLease。
   * IDB Lease / generation 仍是 commit 的權威防線，讓不支援 Web Locks 的瀏覽器安全降級。
   */
  async withTaskLock<T>(
    taskId: string,
    runner: () => Promise<T>,
    adapter?: WebLockAdapter | null,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const locks: WebLockAdapter | null | undefined = adapter === undefined
      ? (this.lockAdapter === undefined
          ? (typeof navigator !== "undefined" ? navigator.locks as unknown as WebLockAdapter : undefined)
          : this.lockAdapter)
      : adapter;
    if (!locks?.request) return { acquired: true, value: await runner() };
    return locks.request(`loop-harmonizer:separation:${taskId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false };
      return { acquired: true, value: await runner() };
    });
  }

  /**
   * 非阻塞偵測任務級 Web Lock 是否仍被某個分頁／Worker 持有。
   * 即使背景分頁的 timer 被瀏覽器節流而導致 IndexedDB Lease 暫時超時，
   * 只要 Web Lock 仍被持有，其他分頁就不得搶奪接管或將任務誤判為 interrupted。
   */
  async isTaskLockHeld(taskId: string, adapter?: WebLockAdapter | null): Promise<boolean> {
    const locks: WebLockAdapter | null | undefined = adapter === undefined
      ? (this.lockAdapter === undefined
          ? (typeof navigator !== "undefined" ? navigator.locks as unknown as WebLockAdapter : undefined)
          : this.lockAdapter)
      : adapter;
    if (!locks?.request) return false;
    try {
      return await locks.request(`loop-harmonizer:separation:${taskId}`, { ifAvailable: true }, async (lock) => {
        return !lock;
      });
    } catch {
      return false;
    }
  }

  private ensureChannel(): BroadcastChannel | null {
    if (this.closed || typeof BroadcastChannel === "undefined") return null;
    if (!this.channel) {
      this.channel = new BroadcastChannel(SEPARATION_LEASE_CHANNEL_NAME);
      (this.channel as unknown as { unref?: () => void }).unref?.();
    }
    return this.channel;
  }

  onBroadcast(listener: (msg: LeaseBroadcastMessage) => void): () => void {
    const channel = this.ensureChannel();
    if (!channel) return () => undefined;
    const handler = (event: MessageEvent<LeaseBroadcastMessage>) => {
      if (event?.data && typeof event.data.taskId === "string") {
        listener(event.data);
      }
    };
    channel.addEventListener("message", handler);
    return () => channel.removeEventListener("message", handler);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.channel = null;
  }

  private post(msg: LeaseBroadcastMessage): void {
    try {
      this.ensureChannel()?.postMessage(msg);
    } catch {
      // BroadcastChannel 可能已關閉
    }
  }

  async acquireLease(
    taskId: string,
    ownerTabId: string,
    ttlMs = DEFAULT_JOB_LEASE_TTL_MS,
    now = Date.now(),
  ): Promise<{ acquired: true; lease: SeparationLeaseInfo; checkpoint: SeparationCheckpoint } | { acquired: false; reason: string; existingLease: SeparationLeaseInfo | null }> {
    const ownerJobToken = createJobToken();

    const doAcquire = async () =>
      withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
        const store = tx.objectStore("separationCheckpoints");
        const existing = (await idbRequestPromise(store.get(taskId))) as
          | SeparationCheckpoint
          | undefined;
        if (!existing) {
          return {
            acquired: false as const,
            reason: `找不到分離任務 Checkpoint：${taskId}`,
            existingLease: null,
          };
        }
        if (existing.status === "cancelled") {
          return {
            acquired: false as const,
            reason: "任務已被取消，禁止重新取得執行權。",
            existingLease: existing.lease,
          };
        }
        const isActuallyCompleted =
          existing.status === "completed" &&
          existing.totalChunks > 0 &&
          existing.nextChunkIndex >= existing.totalChunks &&
          existing.committedEndSample >= existing.totalSamples;
        if (isActuallyCompleted) {
          return {
            acquired: false as const,
            reason: "任務已完成，無須取得執行權。",
            existingLease: existing.lease,
          };
        }
        const currentLease = existing.lease;
        if (
          currentLease &&
          currentLease.ownerTabId !== ownerTabId &&
          currentLease.leaseExpiresAt > now
        ) {
          return {
            acquired: false as const,
            reason: `其他分頁正持有有效執行鎖（剩餘 ${Math.max(1, Math.ceil((currentLease.leaseExpiresAt - now) / 1000))} 秒）`,
            existingLease: currentLease,
          };
        }

        const nextGeneration =
          Math.max(
            existing.lastExecutionGeneration ?? 0,
            currentLease?.generation ?? 0,
            existing.finalizationFence?.generation ?? 0,
          ) + 1;
        const lease: SeparationLeaseInfo = {
          ownerTabId,
          ownerJobToken,
          generation: nextGeneration,
          acquiredAt: now,
          leaseExpiresAt: now + ttlMs,
        };
        const fence: FinalizationFence = {
          taskId,
          generation: nextGeneration,
          ownerJobToken,
          ownerTabId,
          updatedAt: now,
        };
        const updated: SeparationCheckpoint = {
          ...existing,
          status: "running",
          lease,
          lastExecutionGeneration: nextGeneration,
          finalizationFence: fence,
          updatedAt: now,
        };
        await idbRequestPromise(store.put(updated));
        return {
          acquired: true as const,
          lease,
          checkpoint: updated,
        };
      });

    const result = await doAcquire();
    if (result.acquired) {
      this.post({
        type: "lease-acquired",
        taskId,
        ownerTabId,
        generation: result.lease.generation,
        timestamp: now,
      });
    }
    return result;
  }

  async renewLease(
    taskId: string,
    lease: Pick<SeparationLeaseInfo, "ownerTabId" | "ownerJobToken" | "generation">,
    ttlMs = DEFAULT_JOB_LEASE_TTL_MS,
    now = Date.now(),
  ): Promise<boolean> {
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing || !existing.lease) return false;
      if (
        existing.status === "cancelled" ||
        existing.status === "completed" ||
        existing.status === "paused"
      ) {
        return false;
      }
      if (
        existing.lease.ownerTabId !== lease.ownerTabId ||
        existing.lease.ownerJobToken !== lease.ownerJobToken ||
        existing.lease.generation !== lease.generation
      ) {
        return false;
      }
      const next: SeparationCheckpoint = {
        ...existing,
        lease: {
          ...existing.lease,
          leaseExpiresAt: now + ttlMs,
        },
        updatedAt: now,
      };
      await idbRequestPromise(store.put(next));
      return true;
    });
  }

  notifyTaskCompleted(
    taskId: string,
    ownerTabId: string,
    generation?: number,
    now = Date.now(),
  ): void {
    this.post({
      type: "task-completed",
      taskId,
      ownerTabId,
      generation,
      timestamp: now,
    });
  }

  notifyTaskProgress(params: {
    taskId: string;
    ownerTabId: string;
    generation?: number;
    completedChunks: number;
    totalChunks: number;
    committedBytes: number;
    message?: string;
    now?: number;
  }): void {
    this.post({
      type: "task-progress",
      taskId: params.taskId,
      ownerTabId: params.ownerTabId,
      generation: params.generation,
      completedChunks: params.completedChunks,
      totalChunks: params.totalChunks,
      committedBytes: params.committedBytes,
      message: params.message,
      timestamp: params.now ?? Date.now(),
    });
  }

  notifyTaskFailed(
    taskId: string,
    ownerTabId: string,
    generation?: number,
    message?: string,
    now = Date.now(),
  ): void {
    this.post({
      type: "task-failed",
      taskId,
      ownerTabId,
      generation,
      message,
      timestamp: now,
    });
  }

  async releaseLease(
    taskId: string,
    lease: Pick<SeparationLeaseInfo, "ownerTabId" | "ownerJobToken" | "generation">,
    nextStatus?: SeparationCheckpointStatus,
    now = Date.now(),
    options?: { suppressCompletedBroadcast?: boolean },
  ): Promise<boolean> {
    let resolvedStatus: SeparationCheckpointStatus | undefined = nextStatus;
    let alreadyCompletedWithoutLease = false;

    const released = await withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing) return false;

      if (existing.status === "completed") {
        resolvedStatus = "completed";
        if (nextStatus && nextStatus !== "completed") {
          recordSeparationDiagnostic({
            event: "stale-worker-update-rejected",
            source: "SeparationJobLeaseManager.releaseLease",
            taskId,
            songId: existing.songId,
            generation: lease.generation,
            checkpointStatus: existing.status,
            validChunkCount: existing.nextChunkIndex,
            totalChunks: existing.totalChunks,
            leaseOwner: lease.ownerTabId,
            leaseState: existing.lease ? "held" : "none",
            fromState: "completed",
            toState: nextStatus,
            outcome: "rejected",
            note: "blocked downgrade of completed checkpoint on releaseLease",
            timestamp: now,
          });
        }
        if (!existing.lease) {
          alreadyCompletedWithoutLease = true;
          return false;
        }
      }

      if (!existing.lease) return false;
      if (
        existing.lease.ownerTabId !== lease.ownerTabId ||
        existing.lease.ownerJobToken !== lease.ownerJobToken ||
        existing.lease.generation !== lease.generation
      ) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: "SeparationJobLeaseManager.releaseLease",
          taskId,
          songId: existing.songId,
          generation: lease.generation,
          checkpointStatus: existing.status,
          validChunkCount: existing.nextChunkIndex,
          totalChunks: existing.totalChunks,
          leaseOwner: existing.lease.ownerTabId,
          leaseState: existing.lease.leaseExpiresAt > now ? "foreign_active" : "expired",
          outcome: "rejected",
          note: `rejected stale releaseLease (expectedGen=${existing.lease.generation}, gotGen=${lease.generation})`,
          timestamp: now,
        });
        return false;
      }

      const finalStatus =
        existing.status === "completed"
          ? "completed"
          : (nextStatus ?? existing.status);
      resolvedStatus = finalStatus;
      const preservedGen = Math.max(
        existing.lastExecutionGeneration ?? 0,
        existing.finalizationFence?.generation ?? 0,
        existing.lease.generation,
        lease.generation,
      );
      const preservedFence: FinalizationFence =
        existing.finalizationFence && existing.finalizationFence.generation >= lease.generation
          ? existing.finalizationFence
          : {
              taskId,
              generation: preservedGen,
              ownerJobToken: lease.ownerJobToken,
              ownerTabId: lease.ownerTabId,
              updatedAt: now,
            };
      const next: SeparationCheckpoint = {
        ...existing,
        status: finalStatus,
        lease: null,
        lastExecutionGeneration: preservedGen,
        finalizationFence: preservedFence,
        updatedAt: now,
      };
      await idbRequestPromise(store.put(next));
      return true;
    });

    if (released || (alreadyCompletedWithoutLease && resolvedStatus === "completed")) {
      const broadcastType =
        resolvedStatus === "completed"
          ? options?.suppressCompletedBroadcast
            ? "lease-released"
            : "task-completed"
          : resolvedStatus === "cancelled"
            ? "task-cancelled"
            : resolvedStatus === "paused"
              ? "task-paused"
              : resolvedStatus === "failed"
                ? "task-failed"
                : "lease-released";
      this.post({
        type: broadcastType,
        taskId,
        ownerTabId: lease.ownerTabId,
        generation: lease.generation,
        timestamp: now,
      });
    }
    return released;
  }

  /**
   * 取得或驗證最終提交（Finalization）的持久化執行柵欄（FinalizationFence）。
   * 即使最後一段 Chunk 提交時已釋放進行中 Lease，仍可在單一 IndexedDB 交易內保證世代單調遞增與 Token 唯一性。
   */
  async acquireFinalizationOwnership(
    taskId: string,
    ownerTabId: string,
    options?: {
      preferredGeneration?: number;
      preferredJobToken?: string;
      strictExpectedOwnership?: boolean;
      now?: number;
    },
  ): Promise<
    | { acquired: true; fence: FinalizationFence; checkpoint: SeparationCheckpoint }
    | {
        acquired: false;
        code: "missing" | "cancelled" | "foreign_lease" | "stale_generation";
        reason: string;
      }
  > {
    const now = options?.now ?? Date.now();
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing) {
        return {
          acquired: false as const,
          code: "missing" as const,
          reason: `找不到分離任務 Checkpoint：${taskId}`,
        };
      }
      if (existing.status === "cancelled") {
        return {
          acquired: false as const,
          code: "cancelled" as const,
          reason: "任務已取消，禁止最終提交。",
        };
      }
      if (
        existing.lease &&
        existing.lease.ownerTabId !== ownerTabId &&
        existing.lease.leaseExpiresAt > now
      ) {
        return {
          acquired: false as const,
          code: "foreign_lease" as const,
          reason: `其他分頁（${existing.lease.ownerTabId.slice(0, 8)}）正持有有效執行鎖。`,
        };
      }

      const currentMaxGen = Math.max(
        existing.lastExecutionGeneration ?? 0,
        existing.finalizationFence?.generation ?? 0,
        existing.lease?.generation ?? 0,
      );
      const existingFence = existing.finalizationFence;
      const hasPreferred =
        typeof options?.preferredGeneration === "number" &&
        options.preferredGeneration > 0 &&
        Boolean(options.preferredJobToken);

      if (hasPreferred) {
        const prefGen = options!.preferredGeneration!;
        const prefToken = options!.preferredJobToken!;
        const matchesFence =
          Boolean(
            existingFence &&
              existingFence.generation === prefGen &&
              existingFence.ownerJobToken === prefToken &&
              prefGen >= currentMaxGen,
          );
        const matchesLease =
          Boolean(
            existing.lease &&
              existing.lease.generation === prefGen &&
              existing.lease.ownerJobToken === prefToken &&
              prefGen >= currentMaxGen,
          );
        if (matchesFence || matchesLease) {
          const verifiedFence: FinalizationFence = {
            taskId,
            generation: prefGen,
            ownerJobToken: prefToken,
            ownerTabId,
            updatedAt: now,
          };
          if (
            !existingFence ||
            existingFence.generation !== verifiedFence.generation ||
            existingFence.ownerJobToken !== verifiedFence.ownerJobToken
          ) {
            const updated: SeparationCheckpoint = {
              ...existing,
              lastExecutionGeneration: Math.max(currentMaxGen, verifiedFence.generation),
              finalizationFence: verifiedFence,
              updatedAt: now,
            };
            await idbRequestPromise(store.put(updated));
            return { acquired: true as const, fence: verifiedFence, checkpoint: updated };
          }
          return { acquired: true as const, fence: existingFence, checkpoint: existing };
        }
        // 若 Checkpoint 已由更新世代或不同 ownerJobToken 接管，禁止舊執行者假借接管升級世代
        if (options?.strictExpectedOwnership !== false && currentMaxGen > 0) {
          return {
            acquired: false as const,
            code: "stale_generation" as const,
            reason: `執行權世代或識別已過期（預期世代 ${currentMaxGen}，收到 ${prefGen}）。`,
          };
        }
      }

      const nextGeneration = currentMaxGen + 1;
      const nextToken = createJobToken();
      const fence: FinalizationFence = {
        taskId,
        generation: nextGeneration,
        ownerJobToken: nextToken,
        ownerTabId,
        updatedAt: now,
      };
      const updated: SeparationCheckpoint = {
        ...existing,
        lastExecutionGeneration: nextGeneration,
        finalizationFence: fence,
        updatedAt: now,
      };
      await idbRequestPromise(store.put(updated));
      return {
        acquired: true as const,
        fence,
        checkpoint: updated,
      };
    });
  }

  /**
   * 跨分頁原子同步 Checkpoint 上的初始重試資格狀態（例如初次失敗設定 attempts=0 與 5 秒退避）。
   */
  async upsertCheckpointRetryState(
    taskId: string,
    state: PersistedCheckpointRetryState,
  ): Promise<PersistedCheckpointRetryState | null> {
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing) return null;
      const updated: SeparationCheckpoint = {
        ...existing,
        retryState: state,
        updatedAt: Math.max(existing.updatedAt, state.updatedAt),
      };
      await idbRequestPromise(store.put(updated));
      return state;
    });
  }

  async clearCheckpointRetryState(taskId: string, now = Date.now()): Promise<void> {
    await withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing || !existing.retryState) return;
      await idbRequestPromise(
        store.put({
          ...existing,
          retryState: null,
          updatedAt: now,
        } satisfies SeparationCheckpoint),
      );
    }).catch(() => undefined);
  }

  /**
   * 在單一 IndexedDB 交易內檢查並預留一次自動續跑／保存重試名額。
   * - 防止多分頁在無 Web Locks 環境下同時讀取相同的 attempts 並各自消耗重試次數。
   * - 在實際執行前即寫入 reservation（含預扣 attempts），避免頁面中途崩潰／重整後無限取回同一名額。
   */
  async reserveAutoResumeAttempt(
    taskId: string,
    ownerTabId: string,
    options: {
      maxAttempts: number;
      fallbackEntry?: PersistedCheckpointRetryState | null;
      now?: number;
      reservationTtlMs?: number;
    },
  ): Promise<
    | {
        reserved: true;
        reservationToken: string;
        previousAttempts: number;
        reservedAttempts: number;
        state: PersistedCheckpointRetryState;
        checkpoint: SeparationCheckpoint;
      }
    | {
        reserved: false;
        reason:
          | "no_checkpoint"
          | "cancelled"
          | "foreign_lease"
          | "foreign_reservation"
          | "exhausted"
          | "permanently_blocked"
          | "not_eligible_yet";
        state?: PersistedCheckpointRetryState;
        checkpoint?: SeparationCheckpoint;
      }
  > {
    const now = options.now ?? Date.now();
    const reservationTtlMs = options.reservationTtlMs ?? 60_000;
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing) {
        return { reserved: false as const, reason: "no_checkpoint" as const };
      }
      if (existing.status === "cancelled") {
        return {
          reserved: false as const,
          reason: "cancelled" as const,
          checkpoint: existing,
        };
      }
      if (
        existing.lease &&
        existing.lease.ownerTabId !== ownerTabId &&
        existing.lease.leaseExpiresAt > now
      ) {
        return {
          reserved: false as const,
          reason: "foreign_lease" as const,
          checkpoint: existing,
        };
      }

      const defaultPhase: "inference" | "finalization" =
        existing.status === "completed" ||
        (existing.totalChunks > 0 && existing.nextChunkIndex >= existing.totalChunks)
          ? "finalization"
          : "inference";

      let state: PersistedCheckpointRetryState = existing.retryState ??
        options.fallbackEntry ?? {
          attempts: 0,
          nextEligibleAt: 0,
          baselineCompletedChunks: existing.nextChunkIndex,
          retryPhase: defaultPhase,
          backoffCursor: 0,
          updatedAt: now,
        };

      // 若為推論階段且有實質 Chunk 進展，才重置連續失敗計數；finalization 不得重複重置
      if (
        state.retryPhase === "inference" &&
        defaultPhase === "inference" &&
        existing.nextChunkIndex > state.baselineCompletedChunks
      ) {
        state = {
          attempts: 0,
          nextEligibleAt: 0,
          baselineCompletedChunks: existing.nextChunkIndex,
          retryPhase: "inference",
          backoffCursor: 0,
          updatedAt: now,
        };
      }

      if (state.permanentlyBlockedReason) {
        return {
          reserved: false as const,
          reason: "permanently_blocked" as const,
          state,
          checkpoint: existing,
        };
      }
      if (state.attempts >= options.maxAttempts) {
        return {
          reserved: false as const,
          reason: "exhausted" as const,
          state,
          checkpoint: existing,
        };
      }
      if (
        state.reservationToken &&
        state.reservationTabId &&
        state.reservationTabId !== ownerTabId &&
        (state.reservationExpiresAt ?? 0) > now
      ) {
        return {
          reserved: false as const,
          reason: "foreign_reservation" as const,
          state,
          checkpoint: existing,
        };
      }
      const effectiveEligible = Math.max(state.nextEligibleAt, state.blockedUntilAt ?? 0);
      if (effectiveEligible > now) {
        return {
          reserved: false as const,
          reason: "not_eligible_yet" as const,
          state,
          checkpoint: existing,
        };
      }

      const reservationToken = createJobToken();
      const previousAttempts = state.attempts;
      const reservedAttempts = previousAttempts + 1;
      const nextState: PersistedCheckpointRetryState = {
        ...state,
        attempts: reservedAttempts,
        retryPhase: defaultPhase,
        reservationToken,
        reservationTabId: ownerTabId,
        reservationExpiresAt: now + reservationTtlMs,
        updatedAt: now,
      };
      const updatedCp: SeparationCheckpoint = {
        ...existing,
        retryState: nextState,
        updatedAt: now,
      };
      await idbRequestPromise(store.put(updatedCp));
      return {
        reserved: true as const,
        reservationToken,
        previousAttempts,
        reservedAttempts,
        state: nextState,
        checkpoint: updatedCp,
      };
    });
  }

  /**
   * 僅在等待資源／執行鎖／頁面隱藏等未真正開始推論或保存的情況下，原子返還預留的額度，不消耗重試次數。
   */
  async releaseAutoResumeReservation(
    taskId: string,
    reservationToken: string,
    options: {
      previousAttempts: number;
      waitReason: string;
      blockedUntilAt?: number;
      now?: number;
    },
  ): Promise<PersistedCheckpointRetryState | null> {
    const now = options.now ?? Date.now();
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing || !existing.retryState) return null;
      if (existing.retryState.reservationToken !== reservationToken) {
        return existing.retryState;
      }
      const nextState: PersistedCheckpointRetryState = {
        ...existing.retryState,
        attempts: options.previousAttempts,
        waitReason: options.waitReason,
        blockedUntilAt: options.blockedUntilAt,
        reservationToken: null,
        reservationTabId: null,
        reservationExpiresAt: null,
        updatedAt: now,
      };
      await idbRequestPromise(
        store.put({
          ...existing,
          retryState: nextState,
          updatedAt: now,
        } satisfies SeparationCheckpoint),
      );
      return nextState;
    });
  }

  /**
   * 提交重試執行結果（成功清除、永久阻擋、或寫入下一次退避時間）。
   */
  async finalizeAutoResumeAttemptOutcome(
    taskId: string,
    reservationToken: string,
    nextState: PersistedCheckpointRetryState | null,
    now = Date.now(),
  ): Promise<PersistedCheckpointRetryState | null> {
    return withIdbTransaction("separationCheckpoints", "readwrite", async (tx) => {
      const store = tx.objectStore("separationCheckpoints");
      const existing = (await idbRequestPromise(store.get(taskId))) as
        | SeparationCheckpoint
        | undefined;
      if (!existing) return nextState;
      if (
        existing.retryState?.reservationToken &&
        existing.retryState.reservationToken !== reservationToken
      ) {
        return existing.retryState;
      }
      const cleaned = nextState
        ? {
            ...nextState,
            reservationToken: null,
            reservationTabId: null,
            reservationExpiresAt: null,
            updatedAt: now,
          }
        : null;
      await idbRequestPromise(
        store.put({
          ...existing,
          retryState: cleaned,
          updatedAt: now,
        } satisfies SeparationCheckpoint),
      );
      return cleaned;
    });
  }
}

export const sharedSeparationLeaseManager = new SeparationJobLeaseManager();
