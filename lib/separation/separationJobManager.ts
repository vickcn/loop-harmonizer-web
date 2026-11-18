import {
  sharedSeparationCoordinator,
  type SeparationProgressEvent,
  type SeparationTaskController,
  type SeparationTaskStage,
} from "./separationTaskController.ts";
import {
  sharedSeparationLeaseManager,
  type WebLockAdapter,
} from "./separationResumeController.ts";
import { getAllCheckpoints, getCheckpoint } from "../storage/separationCheckpointStore.ts";

export type SeparationJobState = {
  taskId: string;
  songId: string;
  songName?: string;
  generation: number;
  stage: SeparationTaskStage | "interrupted";
  progress: number;
  message: string;
  completedChunks: number;
  totalChunks: number;
  committedBytes: number;
  updatedAt: number;
};

type CoordinatorLike = Pick<
  typeof sharedSeparationCoordinator,
  "startTask" | "pauseTask" | "cancelTask" | "getActiveController" | "hasRunningHeavyTask"
>;

type StartJobOptions = {
  taskId?: string;
  songId: string;
  songName?: string;
  throttleMs?: number;
  cooldownMs?: number;
  onProgress?: (event: SeparationProgressEvent) => void;
};

type JobManagerOptions = {
  coordinator?: CoordinatorLike;
  lockAdapter?: WebLockAdapter | null;
};

const EMPTY_SNAPSHOT: readonly SeparationJobState[] = Object.freeze([]);

/**
 * 應用程式層的任務投影。此類別只管理任務所有權與可訂閱狀態；Demucs 仍由既有
 * sharedSeparationCoordinator / stemSeparator 執行，因此不會產生第二套競爭中的 Worker。
 */
export class SeparationJobManager {
  private readonly coordinator: CoordinatorLike;
  private readonly lockAdapter: WebLockAdapter | null | undefined;
  private readonly jobs = new Map<string, SeparationJobState>();
  private readonly controllers = new Map<string, SeparationTaskController>();
  private readonly autoResumeHandlers = new Map<string, () => Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly SeparationJobState[] = EMPTY_SNAPSHOT;

  constructor(options: JobManagerOptions = {}) {
    this.coordinator = options.coordinator ?? sharedSeparationCoordinator;
    this.lockAdapter = options.lockAdapter;
  }

  getSnapshot = (): readonly SeparationJobState[] => this.snapshot;

  getJobs(): readonly SeparationJobState[] {
    return this.snapshot;
  }

  getJob(taskId: string): SeparationJobState | null {
    return this.jobs.get(taskId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startJob(options: StartJobOptions): SeparationTaskController {
    const existing = [...this.controllers.entries()].find(([, controller]) =>
      controller.songId === options.songId && !controller.isTerminal(),
    );
    if (existing) return existing[1];

    let taskId = options.taskId ?? "";
    const controller = this.coordinator.startTask({
      songId: options.songId,
      throttleMs: options.throttleMs,
      cooldownMs: options.cooldownMs,
      onProgress: (event) => {
        const resolvedTaskId = taskId || event.taskId;
        if (!taskId) taskId = resolvedTaskId;
        this.updateJob(resolvedTaskId, {
          generation: event.generation,
          stage: event.stage,
          progress: event.progress,
          message: event.message,
          completedChunks: event.details?.currentSegment,
          totalChunks: event.details?.totalSegments,
          committedBytes: event.details?.committedBytes,
        });
        options.onProgress?.(event);
      },
    });
    taskId ||= controller.taskId;
    this.controllers.set(taskId, controller);
    this.updateJob(taskId, {
      taskId,
      songId: options.songId,
      songName: options.songName,
      generation: controller.generation,
      stage: "preparing",
      progress: 0.02,
      message: "正在準備分離任務…",
      completedChunks: 0,
      totalChunks: 0,
      committedBytes: 0,
    });
    return controller;
  }

  updateJob(taskId: string, patch: Partial<SeparationJobState>): void {
    const current = this.jobs.get(taskId);
    if (!current && (!patch.songId || !patch.stage)) return;
    const next: SeparationJobState = {
      taskId,
      songId: patch.songId ?? current?.songId ?? "",
      songName: patch.songName ?? current?.songName,
      generation: patch.generation ?? current?.generation ?? 0,
      stage: patch.stage ?? current?.stage ?? "preparing",
      progress: patch.progress ?? current?.progress ?? 0,
      message: patch.message ?? current?.message ?? "",
      completedChunks: patch.completedChunks ?? current?.completedChunks ?? 0,
      totalChunks: patch.totalChunks ?? current?.totalChunks ?? 0,
      committedBytes: patch.committedBytes ?? current?.committedBytes ?? 0,
      updatedAt: Date.now(),
    };
    this.jobs.set(taskId, next);
    this.publish();
  }

  async runJob<T>(taskId: string, runner: () => Promise<T>): Promise<T> {
    const held = await sharedSeparationLeaseManager.withTaskLock(taskId, runner, this.lockAdapter);
    if (!held.acquired) {
      throw new Error("另一個分頁正持有此分離任務的 Web Lock，未建立第二個 Worker。");
    }
    return held.value;
  }

  async pauseJob(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job) return false;
    this.updateJob(taskId, { stage: "pausing", message: "正在等待目前 Chunk 安全提交後暫停…" });
    return this.coordinator.pauseTask(job.songId);
  }

  async resumeJob(taskId: string): Promise<SeparationTaskController | null> {
    const job = this.jobs.get(taskId);
    if (!job || job.stage === "cancelled" || job.stage === "completed") return null;
    const active = this.controllers.get(taskId);
    if (active && !active.isTerminal()) return active;
    const handler = this.autoResumeHandlers.get(taskId);
    if (!handler || this.coordinator.hasRunningHeavyTask()) return null;
    this.updateJob(taskId, { stage: "preparing", message: "正在手動驗證 Checkpoint 並續跑…" });
    try {
      await handler();
    } catch (error) {
      this.updateJob(taskId, {
        stage: "interrupted",
        message: error instanceof Error ? error.message : "無法續跑分離任務。",
      });
    }
    return this.controllers.get(taskId) ?? null;
  }

  registerAutoResume(taskId: string, handler: () => Promise<void>): () => void {
    this.autoResumeHandlers.set(taskId, handler);
    return () => {
      if (this.autoResumeHandlers.get(taskId) === handler) {
        this.autoResumeHandlers.delete(taskId);
      }
    };
  }

  async requestAutoResume(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    const handler = this.autoResumeHandlers.get(taskId);
    if (!job || job.stage !== "interrupted" || !handler || this.coordinator.hasRunningHeavyTask()) {
      return false;
    }
    this.updateJob(taskId, {
      stage: "preparing",
      message: "正在驗證 Checkpoint 與執行權，準備安全續跑…",
    });
    try {
      await handler();
      return true;
    } catch (error) {
      this.updateJob(taskId, {
        stage: "interrupted",
        message: error instanceof Error ? error.message : "自動續跑失敗，等待下一次可用執行環境。",
      });
      return false;
    }
  }

  async cancelJob(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job) return false;
    this.updateJob(taskId, { stage: "cancelling", message: "正在停止並釋放分離資源…" });
    return this.coordinator.cancelTask(job.songId);
  }

  async refreshFromCheckpoint(taskId: string): Promise<void> {
    const checkpoint = await getCheckpoint(taskId).catch(() => null);
    const job = this.jobs.get(taskId);
    if (!checkpoint || !job) return;
    const stage: SeparationJobState["stage"] = checkpoint.status === "running"
      ? (this.controllers.has(taskId) ? "processing" : "interrupted")
      : checkpoint.status === "queued"
        ? "preparing"
        : checkpoint.status;
    this.updateJob(taskId, {
      stage,
      progress: checkpoint.totalChunks > 0 ? checkpoint.nextChunkIndex / checkpoint.totalChunks : 0,
      completedChunks: checkpoint.nextChunkIndex,
      totalChunks: checkpoint.totalChunks,
      committedBytes: checkpoint.committedBytes,
    });
  }

  async refreshFromStorage(): Promise<void> {
    const checkpoints = await getAllCheckpoints().catch(() => []);
    for (const checkpoint of checkpoints) {
      if (
        checkpoint.status !== "queued" &&
        checkpoint.status !== "running" &&
        checkpoint.status !== "interrupted" &&
        checkpoint.status !== "paused"
      ) continue;
      if (!this.jobs.has(checkpoint.taskId)) {
        this.updateJob(checkpoint.taskId, {
          taskId: checkpoint.taskId,
          songId: checkpoint.songId,
          generation: checkpoint.lease?.generation ?? 0,
          stage: checkpoint.status === "running"
            ? "interrupted"
            : checkpoint.status === "queued"
              ? "preparing"
              : checkpoint.status,
          progress: checkpoint.totalChunks > 0 ? checkpoint.nextChunkIndex / checkpoint.totalChunks : 0,
          message: checkpoint.status === "running"
            ? "偵測到未結束分離任務，將驗證 Checkpoint 後安全續跑。"
            : "已從本機 Checkpoint 還原分離任務狀態。",
          completedChunks: checkpoint.nextChunkIndex,
          totalChunks: checkpoint.totalChunks,
          committedBytes: checkpoint.committedBytes,
        });
      }
      await this.refreshFromCheckpoint(checkpoint.taskId);
    }
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    this.listeners.forEach((listener) => listener());
  }
}

export const sharedSeparationJobManager = new SeparationJobManager();
