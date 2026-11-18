import type { SeparationStatus } from "../band/bandTypes.ts";
import type { SeparationCheckpoint } from "../storage/separationCheckpointStore.ts";
import { getAllCheckpoints, getCheckpoint, isCheckpointLeaseActive } from "../storage/separationCheckpointStore.ts";
import { getPersistedSongRecord } from "../storage/songSessionStore.ts";
import {
  runSeparationJob,
  type SeparationJobRunnerDeps,
  type SeparationJobSinkPort,
  type SeparationJobRunOutcome,
  type StartSeparationJobRequest,
} from "./separationJobRunner.ts";
import {
  getOrCreateTabId,
  sharedSeparationLeaseManager,
  type LeaseBroadcastMessage,
  type SeparationJobLeaseManager,
  type WebLockAdapter,
} from "./separationResumeController.ts";
import { recordSeparationDiagnostic } from "./separationStateRecovery.ts";
import {
  sharedSeparationCoordinator,
  type SeparationProgressEvent,
  type SeparationTaskController,
  type SeparationTaskStage,
} from "./separationTaskController.ts";

export type SeparationJobStage = SeparationTaskStage | "interrupted";

export const MAX_AUTO_RESUME_ATTEMPTS = 3;
export const AUTO_RESUME_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
export const AUTO_RESUME_RETRY_STORAGE_KEY = "loop-harmonizer:auto-resume-retry:v1";

export type SeparationJobState = {
  taskId: string;
  songId: string;
  songName?: string;
  generation: number;
  ownerJobToken?: string;
  ownerTabId?: string;
  isForeignActive?: boolean;
  stage: SeparationJobStage;
  progress: number;
  message: string;
  completedChunks: number;
  totalChunks: number;
  committedBytes: number;
  autoResumeAttempts?: number;
  autoResumeExhausted?: boolean;
  requiresManualAction?: boolean;
  updatedAt: number;
};

export interface AutoResumeRetryEntry {
  taskId: string;
  attempts: number;
  nextEligibleAt: number;
  lastError?: string;
  permanentlyBlockedReason?: string;
  baselineCompletedChunks: number;
}

export interface RetryStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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
  allowRepairOrReset?: boolean;
  onProgress?: (event: SeparationProgressEvent) => void;
};

type UpdateJobOptions = {
  generation?: number;
  ownerJobToken?: string;
  allowRepairOrReset?: boolean;
  source?: string;
};

type JobManagerOptions = {
  coordinator?: CoordinatorLike;
  lockAdapter?: WebLockAdapter | null;
  leaseManager?: SeparationJobLeaseManager;
  runnerDeps?: SeparationJobRunnerDeps;
  retryStorage?: RetryStorageAdapter | null;
  now?: () => number;
  enableBroadcastSync?: boolean;
};

const EMPTY_SNAPSHOT: readonly SeparationJobState[] = Object.freeze([]);
const MAX_RETAINED_TERMINAL_JOBS = 24;

const DEFAULT_RETRY_STORAGE: RetryStorageAdapter = {
  getItem(key) {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // 忽略瀏覽器儲存空間錯誤
    }
  },
};

/** 明確且窮盡地將任務階段映射至歌曲分離狀態，絕不將 completed 或未識別狀態預設為 processing。 */
export function mapJobStageToSongSeparationStatus(stage: SeparationJobStage): SeparationStatus {
  switch (stage) {
    case "idle":
      return "not_started";
    case "preparing":
    case "downloading":
    case "processing":
    case "pausing":
      return "processing";
    case "cancelling":
      return "cancelling";
    case "paused":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default: {
      const exhaustiveCheck: never = stage;
      return exhaustiveCheck;
    }
  }
}

/** 依權威 Checkpoint 與實際執行者存在狀態映射 Job 階段。 */
export function mapCheckpointStatusToJobStage(
  checkpoint: Pick<SeparationCheckpoint, "status">,
  context: {
    hasActiveLocalController: boolean;
    hasActiveForeignOwner: boolean;
  },
): SeparationJobStage {
  switch (checkpoint.status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "interrupted":
      return "interrupted";
    case "queued":
      return "preparing";
    case "running":
      return context.hasActiveLocalController || context.hasActiveForeignOwner
        ? "processing"
        : "interrupted";
    default: {
      const exhaustiveCheck: never = checkpoint.status;
      return exhaustiveCheck;
    }
  }
}

/** 檢查任務狀態轉移與 generation fencing 是否合法，阻擋過期 callback 造成狀態降級。 */
export function canTransitionJobStage(
  current: SeparationJobStage,
  next: SeparationJobStage,
  options?: {
    incomingGeneration?: number;
    currentGeneration?: number;
    allowRepairOrReset?: boolean;
  },
): boolean {
  if (options?.allowRepairOrReset) return true;

  const currentGen = options?.currentGeneration;
  const incomingGen = options?.incomingGeneration;
  if (
    typeof incomingGen === "number" &&
    typeof currentGen === "number" &&
    incomingGen < currentGen
  ) {
    return false;
  }

  if (current === next) return true;

  // completed 為不可逆終態（除非使用者明確要求重新分離／權威修復）
  if (current === "completed") {
    return false;
  }

  // cancelled 同世代或較舊世代不可回退為進行中／中斷／失敗
  if (
    current === "cancelled" &&
    (next === "preparing" ||
      next === "downloading" ||
      next === "processing" ||
      next === "pausing" ||
      next === "cancelling" ||
      next === "interrupted" ||
      next === "failed")
  ) {
    return typeof incomingGen === "number" && typeof currentGen === "number" && incomingGen > currentGen;
  }

  // paused 僅允許明確啟動新 generation、完成、取消、或授權修復時轉移
  if (
    current === "paused" &&
    (next === "downloading" || next === "processing")
  ) {
    return typeof incomingGen === "number" && typeof currentGen === "number" && incomingGen > currentGen;
  }

  return true;
}

function isTerminalJobStage(stage: SeparationJobStage): boolean {
  return (
    stage === "completed" ||
    stage === "cancelled" ||
    stage === "failed" ||
    stage === "paused"
  );
}

/**
 * 應用程式層的全域背景分軌任務管理器與狀態投影。
 * 真正透過獨立 `SeparationJobRunner` 接管執行、恢復、提交與資源釋放，不依賴任何 React 元件掛載。
 */
export class SeparationJobManager implements SeparationJobSinkPort {
  private readonly coordinator: CoordinatorLike;
  private readonly lockAdapter: WebLockAdapter | null | undefined;
  private readonly leaseManager: SeparationJobLeaseManager;
  private readonly runnerDeps: SeparationJobRunnerDeps;
  private readonly retryStorage: RetryStorageAdapter | null;
  private readonly now: () => number;
  private readonly managerCreatedAt: number;

  private readonly jobs = new Map<string, SeparationJobState>();
  private readonly controllers = new Map<string, SeparationTaskController>();
  private readonly autoResumeHandlers = new Map<string, () => Promise<void>>();
  private readonly inFlightAutoResume = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly memoryRetryEntries = new Map<string, AutoResumeRetryEntry>();

  private snapshot: readonly SeparationJobState[] = EMPTY_SNAPSHOT;
  private globalFocusActive = false;
  private globalFocusOwnerSongId: string | null = null;
  private lifecycleRecoveryInFlight: Promise<void> | null = null;
  private lifecycleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeBroadcast: (() => void) | null = null;

  constructor(options: JobManagerOptions = {}) {
    this.coordinator = options.coordinator ?? sharedSeparationCoordinator;
    this.lockAdapter = options.lockAdapter;
    this.leaseManager = options.leaseManager ?? sharedSeparationLeaseManager;
    this.runnerDeps = {
      ...options.runnerDeps,
      leaseManager: options.runnerDeps?.leaseManager ?? this.leaseManager,
      lockAdapter:
        options.runnerDeps?.lockAdapter !== undefined
          ? options.runnerDeps.lockAdapter
          : this.lockAdapter,
    };
    this.retryStorage =
      options.retryStorage !== undefined ? options.retryStorage : DEFAULT_RETRY_STORAGE;
    this.now = options.now ?? (() => Date.now());
    this.managerCreatedAt = this.now();

    if (options.enableBroadcastSync !== false) {
      this.unsubscribeBroadcast = this.leaseManager.onBroadcast((msg) => {
        this.handleBroadcastMessage(msg);
      });
    }
  }

  dispose(): void {
    if (this.lifecycleDebounceTimer !== null) {
      clearTimeout(this.lifecycleDebounceTimer);
      this.lifecycleDebounceTimer = null;
    }
    this.unsubscribeBroadcast?.();
    this.unsubscribeBroadcast = null;
    this.controllers.clear();
    this.autoResumeHandlers.clear();
    this.inFlightAutoResume.clear();
    this.listeners.clear();
    this.globalFocusActive = false;
    this.globalFocusOwnerSongId = null;
  }

  getSnapshot = (): readonly SeparationJobState[] => this.snapshot;

  getJobs(): readonly SeparationJobState[] {
    return this.snapshot;
  }

  getJob(taskId: string): SeparationJobState | null {
    return this.jobs.get(taskId) ?? null;
  }

  isGlobalFocusActive(): boolean {
    return this.globalFocusActive || this.coordinator.hasRunningHeavyTask();
  }

  getGlobalFocusOwnerSongId(): string | null {
    return this.globalFocusOwnerSongId;
  }

  setGlobalFocusActive(active: boolean, ownerSongId: string | null = null): void {
    this.globalFocusActive = active;
    this.globalFocusOwnerSongId = active ? ownerSongId : null;
  }

  hasRunningHeavyTask(excludeSongId?: string): boolean {
    if (this.coordinator.hasRunningHeavyTask(excludeSongId)) return true;
    for (const controller of this.controllers.values()) {
      if (excludeSongId && controller.songId === excludeSongId) continue;
      if (!controller.isTerminal()) return true;
    }
    return false;
  }

  getActiveControllerCount(): number {
    this.pruneTerminatedControllers();
    return this.controllers.size;
  }

  getAutoResumeHandlerCount(): number {
    return this.autoResumeHandlers.size;
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startJob(options: StartJobOptions): SeparationTaskController {
    return this.startJobController(options);
  }

  startJobController(options: StartJobOptions): SeparationTaskController {
    this.pruneTerminatedControllers();
    const existing = [...this.controllers.entries()].find(
      ([, controller]) => controller.songId === options.songId && !controller.isTerminal(),
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
        this.updateJob(
          resolvedTaskId,
          {
            generation: event.generation,
            stage: event.stage,
            progress: event.progress,
            message: event.message,
            completedChunks: event.details?.currentSegment,
            totalChunks: event.details?.totalSegments,
            committedBytes: event.details?.committedBytes,
          },
          { generation: event.generation, source: "coordinator.onProgress" },
        );
        options.onProgress?.(event);
      },
    });
    taskId ||= controller.taskId;
    this.controllers.set(taskId, controller);

    const prevJob = this.jobs.get(taskId);
    const shouldAllowReset =
      Boolean(options.allowRepairOrReset) ||
      Boolean(prevJob && controller.generation > prevJob.generation);

    this.updateJob(
      taskId,
      {
        taskId,
        songId: options.songId,
        songName: options.songName ?? prevJob?.songName,
        generation: controller.generation,
        ownerTabId: getOrCreateTabId(),
        isForeignActive: false,
        stage: "preparing",
        progress: 0.02,
        message: "正在準備分離任務…",
        completedChunks: prevJob?.completedChunks ?? 0,
        totalChunks: prevJob?.totalChunks ?? 0,
        committedBytes: prevJob?.committedBytes ?? 0,
        autoResumeExhausted: false,
        requiresManualAction: false,
      },
      {
        generation: controller.generation,
        allowRepairOrReset: shouldAllowReset,
        source: "startJobController",
      },
    );
    return controller;
  }

  markControllerSettled(taskId: string, controller: SeparationTaskController): void {
    if (this.controllers.get(taskId) === controller) {
      this.controllers.delete(taskId);
    }
    this.pruneTerminatedControllers();
  }

  updateJob(
    taskId: string,
    patch: Partial<SeparationJobState>,
    options?: UpdateJobOptions,
  ): void {
    if (!taskId) return;
    const current = this.jobs.get(taskId);
    if (!current && (!patch.songId || !patch.stage)) return;

    const incomingGen = options?.generation ?? patch.generation;
    const incomingToken = options?.ownerJobToken ?? patch.ownerJobToken;
    const nextStage = patch.stage ?? current?.stage ?? "preparing";

    if (current) {
      if (
        !canTransitionJobStage(current.stage, nextStage, {
          incomingGeneration: incomingGen,
          currentGeneration: current.generation,
          allowRepairOrReset: options?.allowRepairOrReset,
        })
      ) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: options?.source ?? "SeparationJobManager.updateJob",
          taskId,
          songId: current.songId,
          generation: incomingGen ?? null,
          validChunkCount: patch.completedChunks ?? current.completedChunks,
          totalChunks: patch.totalChunks ?? current.totalChunks,
          fromState: current.stage,
          toState: nextStage,
          outcome: "rejected",
          note: `blocked invalid job stage/generation transition (currentGen=${current.generation}, incomingGen=${incomingGen ?? "none"})`,
          timestamp: this.now(),
        });
        return;
      }

      if (
        !options?.allowRepairOrReset &&
        incomingToken &&
        current.ownerJobToken &&
        (incomingGen === undefined || incomingGen === current.generation) &&
        incomingToken !== current.ownerJobToken
      ) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: options?.source ?? "SeparationJobManager.updateJob",
          taskId,
          songId: current.songId,
          generation: incomingGen ?? current.generation,
          fromState: current.stage,
          toState: nextStage,
          outcome: "rejected",
          note: "blocked mismatched ownerJobToken within same generation",
          timestamp: this.now(),
        });
        return;
      }
    }

    const sameOrNewerGen =
      !current ||
      incomingGen === undefined ||
      incomingGen === current.generation;

    let safeCompletedChunks = patch.completedChunks ?? current?.completedChunks ?? 0;
    let safeCommittedBytes = patch.committedBytes ?? current?.committedBytes ?? 0;
    let safeProgress = patch.progress ?? current?.progress ?? 0;

    if (
      current &&
      !options?.allowRepairOrReset &&
      sameOrNewerGen &&
      (nextStage === "preparing" ||
        nextStage === "downloading" ||
        nextStage === "processing" ||
        nextStage === "pausing" ||
        nextStage === "completed")
    ) {
      if (safeCompletedChunks < current.completedChunks && current.totalChunks > 0) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: options?.source ?? "SeparationJobManager.updateJob",
          taskId,
          songId: current.songId,
          generation: incomingGen ?? current.generation,
          validChunkCount: safeCompletedChunks,
          totalChunks: current.totalChunks,
          fromState: current.stage,
          toState: nextStage,
          outcome: "rejected",
          note: `blocked chunk progress regression (${safeCompletedChunks} < ${current.completedChunks})`,
          timestamp: this.now(),
        });
        safeCompletedChunks = current.completedChunks;
        safeCommittedBytes = Math.max(current.committedBytes, safeCommittedBytes);
        safeProgress = Math.max(current.progress, safeProgress);
      }
    }

    // 收到實質 Chunk 進展時，重置該任務的自動續跑連續失敗計數
    if (safeCompletedChunks > (current?.completedChunks ?? 0)) {
      this.onSubstantialChunkProgress(taskId, safeCompletedChunks);
    }

    const resolvedGeneration =
      typeof incomingGen === "number"
        ? Math.max(options?.allowRepairOrReset ? incomingGen : (current?.generation ?? 0), incomingGen)
        : (current?.generation ?? 0);

    const next: SeparationJobState = {
      taskId,
      songId: patch.songId ?? current?.songId ?? "",
      songName: patch.songName ?? current?.songName,
      generation: resolvedGeneration,
      ownerJobToken: incomingToken ?? current?.ownerJobToken,
      ownerTabId: patch.ownerTabId ?? current?.ownerTabId,
      isForeignActive:
        patch.isForeignActive !== undefined ? patch.isForeignActive : current?.isForeignActive,
      stage: nextStage,
      progress: safeProgress,
      message: patch.message ?? current?.message ?? "",
      completedChunks: safeCompletedChunks,
      totalChunks: patch.totalChunks ?? current?.totalChunks ?? 0,
      committedBytes: safeCommittedBytes,
      autoResumeAttempts:
        patch.autoResumeAttempts !== undefined
          ? patch.autoResumeAttempts
          : current?.autoResumeAttempts,
      autoResumeExhausted:
        patch.autoResumeExhausted !== undefined
          ? patch.autoResumeExhausted
          : current?.autoResumeExhausted,
      requiresManualAction:
        patch.requiresManualAction !== undefined
          ? patch.requiresManualAction
          : current?.requiresManualAction,
      updatedAt: this.now(),
    };

    this.jobs.set(taskId, next);

    if (isTerminalJobStage(nextStage)) {
      const ctrl = this.controllers.get(taskId);
      if (ctrl && ctrl.isTerminal()) {
        this.controllers.delete(taskId);
      }
      if (nextStage === "completed" || nextStage === "cancelled") {
        this.autoResumeHandlers.delete(taskId);
        this.clearRetryEntry(taskId);
      }
    }

    this.pruneTerminalHistory();
    this.publish();
  }

  /**
   * 權威 Checkpoint 修復專用入口：僅於 validateAndPrepareResume 確認分段損毀或無效時呼叫，
   * 並強制寫入診斷日誌，與一般進度回呼隔離。
   */
  repairJobFromAuthoritativeCheckpoint(
    taskId: string,
    checkpoint: SeparationCheckpoint,
    validChunkCount: number,
    reason: string,
  ): void {
    const existing = this.jobs.get(taskId);
    const totalChunks = checkpoint.totalChunks;
    const repairedStage = mapCheckpointStatusToJobStage(checkpoint, {
      hasActiveLocalController: this.hasActiveLocalController(taskId),
      hasActiveForeignOwner: false,
    });
    recordSeparationDiagnostic({
      source: "SeparationJobManager.repairJobFromAuthoritativeCheckpoint",
      taskId,
      songId: checkpoint.songId,
      generation: checkpoint.lease?.generation ?? existing?.generation ?? null,
      checkpointStatus: checkpoint.status,
      validChunkCount,
      totalChunks,
      fromState: existing?.stage ?? null,
      toState: repairedStage,
      outcome: "repaired",
      note: reason,
      timestamp: this.now(),
    });
    this.updateJob(
      taskId,
      {
        taskId,
        songId: checkpoint.songId,
        songName: existing?.songName,
        generation: checkpoint.lease?.generation ?? existing?.generation ?? 0,
        stage: repairedStage,
        progress: totalChunks > 0 ? validChunkCount / totalChunks : 0,
        completedChunks: validChunkCount,
        totalChunks,
        committedBytes: validChunkCount > 0 ? checkpoint.committedBytes : 0,
        message: reason,
      },
      {
        generation: checkpoint.lease?.generation ?? existing?.generation ?? 0,
        allowRepairOrReset: true,
        source: "authoritative-repair",
      },
    );
  }

  /**
   * 透過獨立 `SeparationJobRunner` 執行完整分軌（包含音訊載入、Web Lock、Worker、持久化）。
   * 即使 BandMixer 卸載或使用者切換路由至 /studio，仍能完整完成並提交歌曲資料。
   */
  async runSongSeparation(request: StartSeparationJobRequest): Promise<SeparationJobRunOutcome> {
    return runSeparationJob(request, this, this.runnerDeps);
  }

  async runJob<T>(taskId: string, runner: () => Promise<T>): Promise<T> {
    const held = await this.leaseManager.withTaskLock(taskId, runner, this.lockAdapter);
    if (!held.acquired) {
      throw new Error("另一個分頁正持有此分離任務的 Web Lock，未建立第二個 Worker。");
    }
    return held.value;
  }

  async pauseJob(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job || job.isForeignActive) return false;
    const localController = this.controllers.get(taskId);
    const activeBySong = this.coordinator.getActiveController(job.songId);
    if (!localController && (!activeBySong || activeBySong.isTerminal())) {
      return false;
    }
    this.updateJob(taskId, {
      stage: "pausing",
      message: "正在等待目前 Chunk 安全提交後暫停…",
    });
    return this.coordinator.pauseTask(job.songId);
  }

  async cancelJob(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job || job.isForeignActive) return false;
    const localController = this.controllers.get(taskId);
    const activeBySong = this.coordinator.getActiveController(job.songId);
    if (!localController && (!activeBySong || activeBySong.isTerminal())) {
      return false;
    }
    this.updateJob(taskId, {
      stage: "cancelling",
      message: "正在停止並釋放分離資源…",
    });
    return this.coordinator.cancelTask(job.songId);
  }

  async resumeJob(
    taskId: string,
    overrides?: Partial<StartSeparationJobRequest>,
  ): Promise<SeparationJobRunOutcome | null> {
    const job = this.jobs.get(taskId);
    if (!job || job.stage === "cancelled" || job.stage === "completed") return null;
    if (job.isForeignActive) return null;

    const active = this.controllers.get(taskId);
    if (active && !active.isTerminal()) return null;

    const handler = this.autoResumeHandlers.get(taskId);
    if (handler) {
      if (this.hasRunningHeavyTask()) return null;
      this.clearRetryEntry(taskId);
      this.updateJob(taskId, { stage: "preparing", message: "正在手動驗證 Checkpoint 並續跑…" });
      try {
        await handler();
      } catch (error) {
        this.updateJob(taskId, {
          stage: "interrupted",
          message: error instanceof Error ? error.message : "無法續跑分離任務。",
        });
      }
      return null;
    }

    if (this.hasRunningHeavyTask(job.songId)) return null;
    this.clearRetryEntry(taskId);
    return this.runSongSeparation({
      taskId,
      songId: job.songId,
      songName: job.songName,
      isAutoResume: false,
      ...overrides,
    });
  }

  registerAutoResume(taskId: string, handler: () => Promise<void>): () => void {
    this.autoResumeHandlers.set(taskId, handler);
    return () => {
      if (this.autoResumeHandlers.get(taskId) === handler) {
        this.autoResumeHandlers.delete(taskId);
      }
    };
  }

  getAutoResumeRetryState(taskId: string): AutoResumeRetryEntry | null {
    const entries = this.readRetryMap();
    const entry = entries[taskId];
    return entry ? { ...entry } : null;
  }

  clearRetryEntry(taskId: string): void {
    const entries = this.readRetryMap();
    if (entries[taskId]) {
      delete entries[taskId];
      this.writeRetryMap(entries);
    }
    this.memoryRetryEntries.delete(taskId);
  }

  async requestAutoResume(taskId: string): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job || job.stage !== "interrupted" || job.isForeignActive) {
      return false;
    }
    if (this.inFlightAutoResume.has(taskId) || this.hasRunningHeavyTask()) {
      return false;
    }

    const currentNow = this.now();
    const retryMap = this.readRetryMap();
    let entry: AutoResumeRetryEntry = retryMap[taskId] ?? {
      taskId,
      attempts: 0,
      nextEligibleAt: 0,
      baselineCompletedChunks: job.completedChunks,
    };

    // 已有實質 Chunk 進展後，重置連續失敗計數
    if (job.completedChunks > entry.baselineCompletedChunks) {
      entry = {
        taskId,
        attempts: 0,
        nextEligibleAt: 0,
        baselineCompletedChunks: job.completedChunks,
      };
      this.saveRetryEntry(entry);
    }

    if (entry.permanentlyBlockedReason) {
      this.updateJob(taskId, {
        stage: "interrupted",
        autoResumeAttempts: entry.attempts,
        autoResumeExhausted: true,
        requiresManualAction: true,
        message: entry.permanentlyBlockedReason,
      });
      return false;
    }

    if (entry.attempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      this.updateJob(taskId, {
        stage: "interrupted",
        autoResumeAttempts: entry.attempts,
        autoResumeExhausted: true,
        requiresManualAction: true,
        message: `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`,
      });
      return false;
    }

    if (entry.nextEligibleAt > currentNow) {
      return false;
    }

    this.inFlightAutoResume.add(taskId);
    const registeredHandler = this.autoResumeHandlers.get(taskId);

    try {
      if (registeredHandler) {
        this.updateJob(taskId, {
          stage: "preparing",
          message: "正在驗證 Checkpoint 與執行權，準備安全續跑…",
        });
        await registeredHandler();
        return true;
      }

      const outcome = await this.runSongSeparation({
        taskId,
        songId: job.songId,
        songName: job.songName,
        isAutoResume: true,
      });

      if (outcome.status === "completed" || outcome.status === "paused" || outcome.status === "cancelled") {
        if (outcome.status === "completed" || outcome.status === "cancelled") {
          this.clearRetryEntry(taskId);
        }
        return outcome.status === "completed";
      }

      if (outcome.status === "blocked") {
        // 其他分頁持有 Web Lock / Lease 或頁面在背景：不計入推論失敗次數
        if (
          outcome.code === "lock_unavailable" ||
          outcome.code === "foreign_lease" ||
          outcome.code === "already_running" ||
          outcome.code === "hidden"
        ) {
          await this.refreshFromCheckpoint(taskId);
          return false;
        }
        if (!outcome.retryable) {
          const updatedEntry: AutoResumeRetryEntry = {
            ...entry,
            lastError: outcome.message,
            permanentlyBlockedReason: outcome.message,
          };
          this.saveRetryEntry(updatedEntry);
          this.updateJob(taskId, {
            stage: "interrupted",
            autoResumeAttempts: updatedEntry.attempts,
            autoResumeExhausted: true,
            requiresManualAction: true,
            message: outcome.message,
          });
          return false;
        }
        const nextAttempts = entry.attempts + 1;
        const backoff =
          AUTO_RESUME_BACKOFF_MS[Math.min(nextAttempts - 1, AUTO_RESUME_BACKOFF_MS.length - 1)];
        const exhausted = nextAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
        const updatedEntry: AutoResumeRetryEntry = {
          ...entry,
          attempts: nextAttempts,
          nextEligibleAt: this.now() + backoff,
          lastError: outcome.message,
        };
        this.saveRetryEntry(updatedEntry);
        this.updateJob(taskId, {
          stage: "interrupted",
          autoResumeAttempts: nextAttempts,
          autoResumeExhausted: exhausted,
          requiresManualAction: exhausted,
          message: exhausted
            ? `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次）：${outcome.message}`
            : `${outcome.message}（將於稍後自動重試 ${nextAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}）`,
        });
        return false;
      }

      // outcome.status === "failed"
      if (outcome.completedChunks > entry.baselineCompletedChunks) {
        entry = {
          taskId,
          attempts: 0,
          nextEligibleAt: 0,
          baselineCompletedChunks: outcome.completedChunks,
        };
      }
      if (!outcome.retryable) {
        const updatedEntry: AutoResumeRetryEntry = {
          ...entry,
          lastError: outcome.message,
          permanentlyBlockedReason: outcome.message,
        };
        this.saveRetryEntry(updatedEntry);
        this.updateJob(taskId, {
          stage: "failed",
          completedChunks: outcome.completedChunks,
          totalChunks: outcome.totalChunks,
          committedBytes: outcome.committedBytes,
          autoResumeAttempts: updatedEntry.attempts,
          autoResumeExhausted: true,
          requiresManualAction: true,
          message: outcome.message,
        });
        return false;
      }

      const nextAttempts = entry.attempts + 1;
      const backoff =
        AUTO_RESUME_BACKOFF_MS[Math.min(nextAttempts - 1, AUTO_RESUME_BACKOFF_MS.length - 1)];
      const exhausted = nextAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
      const updatedEntry: AutoResumeRetryEntry = {
        ...entry,
        attempts: nextAttempts,
        nextEligibleAt: this.now() + backoff,
        lastError: outcome.message,
        baselineCompletedChunks: Math.max(entry.baselineCompletedChunks, outcome.completedChunks),
      };
      this.saveRetryEntry(updatedEntry);
      this.updateJob(taskId, {
        stage: "interrupted",
        completedChunks: outcome.completedChunks,
        totalChunks: outcome.totalChunks,
        committedBytes: outcome.committedBytes,
        autoResumeAttempts: nextAttempts,
        autoResumeExhausted: exhausted,
        requiresManualAction: exhausted,
        message: exhausted
          ? `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`
          : `${outcome.message}（將於稍後自動重試 ${nextAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}）`,
      });
      return false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "自動續跑失敗，等待下一次可用執行環境。";
      const nextAttempts = entry.attempts + 1;
      const backoff =
        AUTO_RESUME_BACKOFF_MS[Math.min(nextAttempts - 1, AUTO_RESUME_BACKOFF_MS.length - 1)];
      const exhausted = nextAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
      this.saveRetryEntry({
        ...entry,
        attempts: nextAttempts,
        nextEligibleAt: this.now() + backoff,
        lastError: msg,
      });
      this.updateJob(taskId, {
        stage: "interrupted",
        autoResumeAttempts: nextAttempts,
        autoResumeExhausted: exhausted,
        requiresManualAction: exhausted,
        message: exhausted
          ? `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`
          : msg,
      });
      return false;
    } finally {
      this.inFlightAutoResume.delete(taskId);
    }
  }

  async syncFromCheckpoint(taskId: string): Promise<void> {
    await this.refreshFromCheckpoint(taskId);
  }

  async refreshFromCheckpoint(
    taskId: string,
    options?: { allowRemoveMissing?: boolean; preloadedCheckpoint?: SeparationCheckpoint | null },
  ): Promise<void> {
    const checkpoint =
      options?.preloadedCheckpoint !== undefined
        ? options.preloadedCheckpoint
        : await getCheckpoint(taskId).catch(() => null);
    const existing = this.jobs.get(taskId);
    const localController = this.controllers.get(taskId);
    const hasActiveLocal = Boolean(localController && !localController.isTerminal());

    if (!checkpoint) {
      if (options?.allowRemoveMissing && existing && !hasActiveLocal) {
        this.jobs.delete(taskId);
        this.publish();
      }
      return;
    }

    const currentTabId = getOrCreateTabId();
    const nowTs = this.now();
    const hasForeignLease = Boolean(
      checkpoint.lease &&
        checkpoint.lease.ownerTabId !== currentTabId &&
        isCheckpointLeaseActive(checkpoint, nowTs),
    );
    const lockHeldByOther =
      !hasActiveLocal &&
      !hasForeignLease &&
      checkpoint.status === "running" &&
      (await this.leaseManager.isTaskLockHeld(taskId, this.lockAdapter));

    const hasActiveForeignOwner = hasForeignLease || lockHeldByOther;
    const stage = mapCheckpointStatusToJobStage(checkpoint, {
      hasActiveLocalController: hasActiveLocal,
      hasActiveForeignOwner,
    });

    const resolvedSongName =
      existing?.songName ??
      (await getPersistedSongRecord(checkpoint.songId).catch(() => null))?.name;
    const cpGeneration = checkpoint.lease?.generation ?? existing?.generation ?? 0;

    const progress =
      stage === "completed"
        ? 1
        : checkpoint.totalChunks > 0
          ? Math.min(0.99, checkpoint.nextChunkIndex / checkpoint.totalChunks)
          : 0;

    let message = existing?.message ?? "已從本機 Checkpoint 同步分離狀態。";
    if (stage === "completed") {
      message = `分段分離完成（共 ${checkpoint.totalChunks} 段按需播放）。`;
    } else if (stage === "cancelled") {
      message = "已中止音軌分離（保留已提交分段）。";
    } else if (stage === "failed") {
      message = checkpoint.lastError || "音軌分離未完成。";
    } else if (stage === "paused") {
      message = `已暫停分離（已保存第 ${checkpoint.nextChunkIndex}/${checkpoint.totalChunks} 段）。`;
    } else if (stage === "processing" && hasActiveForeignOwner) {
      message = `另一分頁正在執行背景分軌（第 ${checkpoint.nextChunkIndex}/${checkpoint.totalChunks} 段）…`;
    } else if (stage === "interrupted") {
      message = "偵測到未結束分離任務，準備驗證 Checkpoint 後接續。";
    }

    // 若權威 IDB 已顯示終態（例如跨分頁完成、取消、失敗或由背景回復為 interrupted），同步至 Job 狀態
    const allowAuthoritativeSync =
      stage === "completed" ||
      stage === "cancelled" ||
      stage === "paused" ||
      (hasActiveForeignOwner && stage === "processing");

    this.updateJob(
      taskId,
      {
        taskId,
        songId: checkpoint.songId,
        songName: resolvedSongName,
        generation: cpGeneration,
        ownerTabId: checkpoint.lease?.ownerTabId ?? existing?.ownerTabId,
        isForeignActive: hasActiveForeignOwner && !hasActiveLocal,
        stage,
        progress,
        message,
        completedChunks: checkpoint.nextChunkIndex,
        totalChunks: checkpoint.totalChunks,
        committedBytes: checkpoint.committedBytes,
      },
      {
        generation: cpGeneration,
        allowRepairOrReset: allowAuthoritativeSync,
        source: "refreshFromCheckpoint",
      },
    );
  }

  async refreshFromStorage(): Promise<void> {
    const checkpoints = await getAllCheckpoints().catch(() => []);
    const byTaskId = new Map(checkpoints.map((cp) => [cp.taskId, cp]));

    for (const cp of checkpoints) {
      await this.refreshFromCheckpoint(cp.taskId, { preloadedCheckpoint: cp });
    }

    // 清除 IndexedDB 已刪除且無本地活躍執行者的過期投影
    let removedAny = false;
    for (const [taskId] of this.jobs.entries()) {
      if (byTaskId.has(taskId)) continue;
      if (this.hasActiveLocalController(taskId)) continue;
      this.jobs.delete(taskId);
      removedAny = true;
    }
    if (removedAny) {
      this.publish();
    }
  }

  /**
   * 統一生命週期恢復入口（visibilitychange / pageshow / resume / online）：
   * 進行去重與序列化，不會因事件連發而建立重複 Worker。
   */
  triggerLifecycleRecovery(_reason: string, debounceMs = 0): Promise<void> {
    if (this.lifecycleRecoveryInFlight) {
      return this.lifecycleRecoveryInFlight;
    }
    const executeRecovery = async () => {
      try {
        await this.refreshFromStorage();
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        if (this.hasRunningHeavyTask() || this.isGlobalFocusActive()) return;
        const interrupted = this.getJobs().filter(
          (job) => job.stage === "interrupted" && !job.isForeignActive,
        );
        for (const job of interrupted) {
          if (await this.requestAutoResume(job.taskId)) break;
        }
      } finally {
        this.lifecycleRecoveryInFlight = null;
      }
    };

    if (debounceMs > 0) {
      if (this.lifecycleDebounceTimer !== null) {
        clearTimeout(this.lifecycleDebounceTimer);
      }
      this.lifecycleRecoveryInFlight = new Promise<void>((resolve) => {
        this.lifecycleDebounceTimer = setTimeout(() => {
          this.lifecycleDebounceTimer = null;
          void executeRecovery().then(resolve, resolve);
        }, debounceMs);
      });
      return this.lifecycleRecoveryInFlight;
    }

    this.lifecycleRecoveryInFlight = executeRecovery();
    return this.lifecycleRecoveryInFlight;
  }

  private handleBroadcastMessage(msg: LeaseBroadcastMessage): void {
    const currentTabId = getOrCreateTabId();
    if (msg.ownerTabId === currentTabId) return;

    if (msg.type === "task-progress") {
      const existing = this.jobs.get(msg.taskId);
      if (existing) {
        this.updateJob(
          msg.taskId,
          {
            generation: msg.generation ?? existing.generation,
            ownerTabId: msg.ownerTabId,
            isForeignActive: true,
            stage: "processing",
            progress:
              msg.totalChunks && msg.totalChunks > 0
                ? Math.min(0.99, (msg.completedChunks ?? 0) / msg.totalChunks)
                : existing.progress,
            completedChunks: msg.completedChunks ?? existing.completedChunks,
            totalChunks: msg.totalChunks ?? existing.totalChunks,
            committedBytes: msg.committedBytes ?? existing.committedBytes,
            message:
              msg.message ??
              `另一分頁正在背景分軌（第 ${msg.completedChunks ?? 0}/${msg.totalChunks ?? 0} 段）…`,
          },
          {
            generation: msg.generation ?? existing.generation,
            source: "broadcast.task-progress",
          },
        );
        return;
      }
    }

    void this.refreshFromCheckpoint(msg.taskId).catch(() => undefined);
  }

  private hasActiveLocalController(taskId: string): boolean {
    const ctrl = this.controllers.get(taskId);
    return Boolean(ctrl && !ctrl.isTerminal());
  }

  private pruneTerminatedControllers(): void {
    for (const [taskId, ctrl] of this.controllers.entries()) {
      if (ctrl.isTerminal()) {
        this.controllers.delete(taskId);
      }
    }
  }

  private pruneTerminalHistory(): void {
    if (this.jobs.size <= MAX_RETAINED_TERMINAL_JOBS) return;
    const entries = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of entries) {
      if (this.jobs.size <= MAX_RETAINED_TERMINAL_JOBS) break;
      if (isTerminalJobStage(entry.stage) && !this.hasActiveLocalController(entry.taskId)) {
        this.jobs.delete(entry.taskId);
      }
    }
  }

  private onSubstantialChunkProgress(taskId: string, completedChunks: number): void {
    const entries = this.readRetryMap();
    const existing = entries[taskId];
    if (!existing) return;
    if (completedChunks > existing.baselineCompletedChunks) {
      entries[taskId] = {
        taskId,
        attempts: 0,
        nextEligibleAt: 0,
        baselineCompletedChunks: completedChunks,
      };
      this.writeRetryMap(entries);
    }
  }

  private saveRetryEntry(entry: AutoResumeRetryEntry): void {
    const entries = this.readRetryMap();
    entries[entry.taskId] = entry;
    this.writeRetryMap(entries);
  }

  private readRetryMap(): Record<string, AutoResumeRetryEntry> {
    if (!this.retryStorage) {
      return Object.fromEntries(this.memoryRetryEntries.entries());
    }
    const raw = this.retryStorage.getItem(AUTO_RESUME_RETRY_STORAGE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, AutoResumeRetryEntry>) : {};
    } catch {
      return {};
    }
  }

  private writeRetryMap(entries: Record<string, AutoResumeRetryEntry>): void {
    if (!this.retryStorage) {
      this.memoryRetryEntries.clear();
      for (const [k, v] of Object.entries(entries)) {
        this.memoryRetryEntries.set(k, v);
      }
      return;
    }
    this.retryStorage.setItem(AUTO_RESUME_RETRY_STORAGE_KEY, JSON.stringify(entries));
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    this.listeners.forEach((listener) => listener());
  }
}

export const sharedSeparationJobManager = new SeparationJobManager();
