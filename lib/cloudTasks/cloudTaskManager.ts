import { sharedGoogleAccountManager } from "../google/googleAccountManager.ts";
import { sharedSeparationJobManager } from "../separation/separationJobManager.ts";
import { createCloudTaskIdempotently, getCloudTask, listCloudTasks, reserveCloudTaskLease, updateCloudTaskAtomic } from "./cloudTaskStore.ts";
import { CloudTaskExecutorRegistry } from "./cloudTaskExecutors.ts";
import { normalizeInterruptedCloudTask } from "./cloudTaskRecovery.ts";
import { evaluateCloudTaskResources } from "./cloudTaskResourceGuard.ts";
import { computeCloudTaskRetryAt, MAX_CLOUD_TASK_RETRIES } from "./cloudTaskScheduler.ts";
import { HEAVY_CLOUD_TASK_KINDS, TERMINAL_CLOUD_TASK_STATUSES, type CloudTaskDescriptor, type CloudTaskExecutor, type CloudTaskKind, type CloudTaskRecord, type CloudTaskStatus } from "./cloudTaskTypes.ts";

const LEASE_TTL_MS = 90_000;
const CHANNEL_NAME = "loop-cloud-tasks-v1";
const EMPTY_CLOUD_TASK_SNAPSHOT: readonly CloudTaskRecord[] = Object.freeze([]);

type EnqueueInput<K extends CloudTaskKind> = {
  kind: K; ownerAccountId: string; intentId: string; descriptor: CloudTaskDescriptor[K];
  projectId?: string; projectName?: string; songId?: string; songName?: string; shareId?: string;
  snapshotRevision?: string; totalBytes?: number; totalFiles?: number;
};

function taskId(): string {
  return `cloud_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function ownerId(): string {
  return `tab_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

export class CloudTaskManager {
  private readonly ownerId = ownerId();
  private readonly registry = new CloudTaskExecutorRegistry();
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private snapshot: readonly CloudTaskRecord[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private initialized = false;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(now = () => Date.now(), random = Math.random) {
    this.now = now;
    this.random = random;
    if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = () => void this.refreshFromStorage();
    }
  }

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): readonly CloudTaskRecord[] => this.snapshot;
  getServerSnapshot = (): readonly CloudTaskRecord[] => EMPTY_CLOUD_TASK_SNAPSHOT;

  private emit(): void { for (const listener of this.listeners) listener(); }
  private broadcast(): void { this.channel?.postMessage({ type: "cloud-task-updated", at: this.now() }); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.recover("mount");
  }

  registerExecutor<K extends CloudTaskKind>(kind: K, executor: CloudTaskExecutor<K>): () => void {
    const dispose = this.registry.register(kind, executor);
    void this.schedule();
    return dispose;
  }

  async enqueue<K extends CloudTaskKind>(input: EnqueueInput<K>): Promise<CloudTaskRecord<K>> {
    if (!input.ownerAccountId || !input.intentId) throw new Error("背景雲端任務缺少帳戶或操作意圖。");
    const now = this.now();
    const record: CloudTaskRecord<K> = {
      key: taskId(), taskId: "", kind: input.kind, status: "queued", ownerAccountId: input.ownerAccountId,
      projectId: input.projectId, projectName: input.projectName, songId: input.songId, songName: input.songName,
      shareId: input.shareId, intentId: input.intentId, snapshotRevision: input.snapshotRevision,
      descriptor: input.descriptor, stage: "等待執行", completedBytes: 0, totalBytes: input.totalBytes,
      completedFiles: 0, totalFiles: input.totalFiles, retryCount: 0, operationGeneration: 1,
      createdAt: now, updatedAt: now,
    };
    record.taskId = record.key;
    const result = await createCloudTaskIdempotently(record);
    await this.refreshFromStorage();
    if (result.created) void this.schedule();
    return result.task;
  }

  async refreshFromStorage(): Promise<void> {
    this.snapshot = await listCloudTasks();
    this.emit();
    this.armRetryTimer();
  }

  async recover(_reason: string): Promise<void> {
    const now = this.now();
    const tasks = await listCloudTasks();
    await Promise.all(tasks.map(async (task) => {
      const normalized = normalizeInterruptedCloudTask(task, now);
      if (normalized !== task) await updateCloudTaskAtomic(task.taskId, () => normalized);
    }));
    await this.refreshFromStorage();
    void this.schedule();
  }

  async pause(taskIdValue: string): Promise<void> {
    this.controllers.get(taskIdValue)?.abort();
    await updateCloudTaskAtomic(taskIdValue, (current) => TERMINAL_CLOUD_TASK_STATUSES.has(current.status) ? current : ({ ...current, status: "paused", stage: "已由使用者暫停", pausedAt: this.now(), operationGeneration: current.operationGeneration + 1, leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() }));
    await this.refreshFromStorage(); this.broadcast();
  }

  async resume(taskIdValue: string): Promise<void> {
    await updateCloudTaskAtomic(taskIdValue, (current) => {
      if (current.status !== "paused" && current.status !== "failed" && current.status !== "waiting_auth" && current.status !== "waiting_network" && current.status !== "waiting_resources") return current;
      return { ...current, status: "queued", stage: "等待恢復", pausedAt: undefined, nextRetryAt: undefined, errorCode: undefined, errorMessage: undefined, operationGeneration: current.operationGeneration + 1, updatedAt: this.now() };
    });
    await this.refreshFromStorage(); this.broadcast(); void this.schedule();
  }

  async cancel(taskIdValue: string): Promise<void> {
    this.controllers.get(taskIdValue)?.abort();
    await updateCloudTaskAtomic(taskIdValue, (current) => TERMINAL_CLOUD_TASK_STATUSES.has(current.status) ? current : ({ ...current, status: "cancelled", stage: "已由使用者取消", cancelledAt: this.now(), operationGeneration: current.operationGeneration + 1, leaseOwnerId: undefined, leaseExpiresAt: undefined, nextRetryAt: undefined, updatedAt: this.now() }));
    await this.refreshFromStorage(); this.broadcast();
  }

  async retry(taskIdValue: string): Promise<void> { await this.resume(taskIdValue); }

  async waitForTerminal(taskIdValue: string, signal?: AbortSignal, onUpdate?: (task: CloudTaskRecord) => void): Promise<CloudTaskRecord> {
    return new Promise<CloudTaskRecord>((resolve, reject) => {
      let settled = false;
      const finish = (task?: CloudTaskRecord, error?: Error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else if (task) resolve(task);
      };
      const inspect = () => {
        const task = this.snapshot.find((candidate) => candidate.taskId === taskIdValue);
        if (!task) return;
        onUpdate?.(task);
        if (TERMINAL_CLOUD_TASK_STATUSES.has(task.status)) finish(task);
      };
      const onAbort = () => finish(undefined, new DOMException("已取消等待背景任務。", "AbortError"));
      const unsubscribe = this.subscribe(inspect);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort(); else inspect();
    });
  }

  private activeHeavy(): boolean {
    return this.snapshot.some((task) => HEAVY_CLOUD_TASK_KINDS.has(task.kind) && ["preparing", "running", "recovering"].includes(task.status));
  }

  async schedule(): Promise<void> {
    await this.refreshFromStorage();
    const now = this.now();
    const candidates = this.snapshot.filter((task) => ["queued", "recovering", "waiting_network", "waiting_auth", "waiting_resources"].includes(task.status) && (!task.nextRetryAt || task.nextRetryAt <= now));
    for (const task of candidates) {
      if (this.controllers.has(task.taskId)) continue;
      if (HEAVY_CLOUD_TASK_KINDS.has(task.kind) && typeof document !== "undefined" && document.visibilityState === "hidden") continue;
      if (HEAVY_CLOUD_TASK_KINDS.has(task.kind) && this.activeHeavy()) continue;
      void this.runWithLock(task);
      if (HEAVY_CLOUD_TASK_KINDS.has(task.kind)) break;
    }
  }

  private async runWithLock(task: CloudTaskRecord): Promise<void> {
    const execute = async (): Promise<void> => {
      const reserved = await reserveCloudTaskLease({ taskId: task.taskId, ownerId: this.ownerId, now: this.now(), ttlMs: LEASE_TTL_MS, expectedGeneration: task.operationGeneration });
      if (!reserved) return;
      await this.execute(reserved);
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      await locks.request(`loop-cloud-task:${task.taskId}`, { mode: "exclusive", ifAvailable: true }, async (lock) => { if (lock) await execute(); });
    } else await execute();
  }

  private async execute(task: CloudTaskRecord): Promise<void> {
    const executor = this.registry.get(task.kind);
    if (!executor) {
      await this.setWaiting(task, "waiting_resources", "等待對應功能載入後恢復"); return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await this.setWaiting(task, "waiting_network", "網路離線，等待恢復"); return;
    }
    const auth = sharedGoogleAccountManager.getSnapshot();
    const token = auth.account?.accountId === task.ownerAccountId ? sharedGoogleAccountManager.getValidAccessToken(task.ownerAccountId) : null;
    if (!auth.account || !token || auth.account.accountId !== task.ownerAccountId) {
      await this.setWaiting(task, "waiting_auth", "等待原 Google 帳戶重新授權"); return;
    }
    const resources = evaluateCloudTaskResources(task, {
      heavyAudioTaskRunning: sharedSeparationJobManager.hasRunningHeavyTask(),
      anotherHeavyTransferRunning: HEAVY_CLOUD_TASK_KINDS.has(task.kind) && this.snapshot.some(
        (candidate) => candidate.taskId !== task.taskId &&
          HEAVY_CLOUD_TASK_KINDS.has(candidate.kind) &&
          this.controllers.has(candidate.taskId),
      ),
      storageRemainingBytes: await this.getStorageRemainingBytes(),
    });
    if (!resources.allowed) { await this.setWaiting(task, "waiting_resources", resources.reason ?? "等待裝置資源"); return; }

    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    const generation = task.operationGeneration;
    const heartbeat = setInterval(() => {
      void updateCloudTaskAtomic(task.taskId, (current) => {
        if (current.operationGeneration !== generation || current.leaseOwnerId !== this.ownerId || current.status !== "running") return current;
        return { ...current, leaseExpiresAt: this.now() + LEASE_TTL_MS, updatedAt: this.now() };
      }).catch(() => undefined);
    }, LEASE_TTL_MS / 3);
    try {
      await updateCloudTaskAtomic(task.taskId, (current) => current.operationGeneration === generation ? { ...current, status: "running", stage: "執行中", updatedAt: this.now() } : current);
      await this.refreshFromStorage();
      const result = await executor(task, {
        signal: controller.signal,
        accessToken: token,
        accountGeneration: auth.generation,
        isAccountGenerationValid: () => sharedGoogleAccountManager.isGenerationValid(auth.generation, task.ownerAccountId),
        updateProgress: async (patch) => {
          await updateCloudTaskAtomic(task.taskId, (current) => {
            if (current.operationGeneration !== generation || TERMINAL_CLOUD_TASK_STATUSES.has(current.status) || current.status === "paused") {
              throw new Error("雲端任務執行權已失效。");
            }
            return { ...current, ...patch, leaseOwnerId: this.ownerId, leaseExpiresAt: this.now() + LEASE_TTL_MS, updatedAt: this.now() };
          });
          await this.refreshFromStorage();
        },
      });
      await updateCloudTaskAtomic(task.taskId, (current) => {
        if (current.operationGeneration !== generation || current.status === "cancelled" || current.status === "paused") return current;
        if (result.status === "completed") return { ...current, status: "completed", stage: result.stage ?? "已完成並驗證", completedBytes: current.totalBytes ?? current.completedBytes, completedFiles: current.totalFiles ?? current.completedFiles, completedAt: this.now(), nextRetryAt: undefined, leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() };
        if (result.status === "failed") {
          const nextRetryAt = result.retryable ? computeCloudTaskRetryAt({ retryCount: current.retryCount, now: this.now(), retryAfterMs: result.retryAfterMs, random: this.random }) : null;
          return { ...current, status: nextRetryAt ? "queued" : "failed", stage: result.stage, retryCount: result.retryable ? current.retryCount + 1 : current.retryCount, nextRetryAt: nextRetryAt ?? undefined, errorCode: result.errorCode, errorMessage: result.errorMessage, leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() };
        }
        return { ...current, status: result.status, stage: result.stage, errorMessage: result.errorMessage, leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() };
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        await updateCloudTaskAtomic(task.taskId, (current) => {
          if (current.operationGeneration !== generation || TERMINAL_CLOUD_TASK_STATUSES.has(current.status)) return current;
          const nextRetryAt = computeCloudTaskRetryAt({ retryCount: current.retryCount, now: this.now(), random: this.random });
          return { ...current, status: nextRetryAt ? "queued" : "failed", stage: nextRetryAt ? "等待重試" : "重試次數已用盡", retryCount: current.retryCount + 1, nextRetryAt: nextRetryAt ?? undefined, errorMessage: error instanceof Error ? error.message : "背景雲端任務失敗。", leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() };
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(task.taskId);
      await this.refreshFromStorage(); this.broadcast(); void this.schedule();
    }
  }

  private async setWaiting(task: CloudTaskRecord, status: Extract<CloudTaskStatus, "waiting_auth" | "waiting_network" | "waiting_resources">, stage: string): Promise<void> {
    await updateCloudTaskAtomic(task.taskId, (current) => current.operationGeneration === task.operationGeneration ? { ...current, status, stage, leaseOwnerId: undefined, leaseExpiresAt: undefined, updatedAt: this.now() } : current);
    await this.refreshFromStorage(); this.broadcast();
  }

  private async getStorageRemainingBytes(): Promise<number | undefined> {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined;
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.quota !== "number" || typeof estimate.usage !== "number") return undefined;
      return Math.max(0, estimate.quota - estimate.usage);
    } catch {
      return undefined;
    }
  }

  private armRetryTimer(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const times = this.snapshot.map((task) => task.nextRetryAt).filter((value): value is number => typeof value === "number");
    if (!times.length) return;
    const delay = Math.max(0, Math.min(...times) - this.now());
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.schedule(); }, delay);
  }

  getMaxRetryCount(): number { return MAX_CLOUD_TASK_RETRIES; }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}

export const sharedCloudTaskManager = new CloudTaskManager();
