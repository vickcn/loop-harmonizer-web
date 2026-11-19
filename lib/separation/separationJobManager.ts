import type { SeparationStatus } from "../band/bandTypes.ts";
import type { PersistedSongRecord } from "../band/songModel.ts";
import { createSeparationCacheKey } from "../storage/cacheKeys.ts";
import type {
  PersistedCheckpointRetryState,
  SeparationCheckpoint,
} from "../storage/separationCheckpointStore.ts";
import {
  getAllCheckpoints,
  getCheckpoint,
  isCheckpointLeaseActive,
  updateCheckpointStatus,
} from "../storage/separationCheckpointStore.ts";
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
export type SeparationRetryPhase = "inference" | "finalization";
export type RetryWaitReason =
  | "backoff"
  | "document_hidden"
  | "local_task_running"
  | "foreign_lock"
  | "foreign_lease"
  | "resource_unavailable"
  | "storage_unavailable"
  | "manual_action_required";

export const MAX_AUTO_RESUME_ATTEMPTS = 3;
export const AUTO_RESUME_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
export const MIN_RETRY_WAKEUP_DELAY_MS = 1_000;
export const BLOCKED_RECHECK_DELAY_MS = 10_000;
export const AUTO_RESUME_RETRY_STORAGE_KEY = "loop-harmonizer:auto-resume-retry:v1";

export type SeparationJobState = {
  taskId: string;
  songId: string;
  songName?: string;
  requestedMode?: "two_stem" | "four_stem";
  generation: number;
  ownerJobToken?: string;
  ownerTabId?: string;
  isForeignActive?: boolean;
  stage: SeparationJobStage;
  retryPhase?: SeparationRetryPhase;
  retryWaitReason?: RetryWaitReason;
  isActivelyFinalizing?: boolean;
  nextRetryAt?: number;
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
  blockedUntilAt?: number;
  lastError?: string;
  permanentlyBlockedReason?: string;
  baselineCompletedChunks: number;
  retryPhase?: SeparationRetryPhase;
  waitReason?: RetryWaitReason;
  backoffCursor?: 0 | 1;
}

export interface RetryStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RetryTimerAdapter {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
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
  isAuthoritativeCheckpointRepair?: boolean;
  source?: string;
};

type JobManagerOptions = {
  coordinator?: CoordinatorLike;
  lockAdapter?: WebLockAdapter | null;
  leaseManager?: SeparationJobLeaseManager;
  runnerDeps?: SeparationJobRunnerDeps;
  retryStorage?: RetryStorageAdapter | null;
  now?: () => number;
  retryTimer?: RetryTimerAdapter;
  isDocumentHidden?: () => boolean;
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

/** 嚴格比對持久化歌曲紀錄是否已完成最終提交（涵蓋 generation、模式、快取鍵與分段數）。 */
export function isPersistedSongAuthoritativelyFinalized(
  persistedSong: PersistedSongRecord | null | undefined,
  checkpoint: Pick<
    SeparationCheckpoint,
    | "taskId"
    | "songId"
    | "sourceAudioHash"
    | "modelVersion"
    | "processingVersion"
    | "requestedMode"
    | "totalChunks"
    | "nextChunkIndex"
    | "status"
    | "finalizedAt"
    | "finalizedGeneration"
    | "lastExecutionGeneration"
    | "referencedModesBySongId"
  >,
): boolean {
  if (!persistedSong || persistedSong.separationStatus !== "completed") {
    return false;
  }
  if (persistedSong.separationTaskId !== checkpoint.taskId) {
    return false;
  }
  if (persistedSong.sourceAudioHash !== checkpoint.sourceAudioHash) {
    return false;
  }
  if (
    persistedSong.modelVersion !== checkpoint.modelVersion ||
    persistedSong.processingVersion !== checkpoint.processingVersion
  ) {
    return false;
  }
  const expectedMode =
    persistedSong.separationMode ??
    checkpoint.referencedModesBySongId?.[persistedSong.songId] ??
    checkpoint.requestedMode;
  if (expectedMode !== "two_stem" && expectedMode !== "four_stem") {
    return false;
  }
  const expectedCacheKey = createSeparationCacheKey({
    sourceAudioHash: checkpoint.sourceAudioHash,
    modelVersion: checkpoint.modelVersion,
    separationMode: expectedMode,
    processingVersion: checkpoint.processingVersion,
  });
  if (persistedSong.cacheKey !== expectedCacheKey) {
    return false;
  }
  if (checkpoint.totalChunks > 0) {
    if (
      (persistedSong.separationTotalChunks ?? 0) !== checkpoint.totalChunks ||
      (persistedSong.separationCompletedChunks ?? 0) < checkpoint.totalChunks ||
      checkpoint.nextChunkIndex < checkpoint.totalChunks
    ) {
      return false;
    }
  }
  if (
    checkpoint.songId === persistedSong.songId &&
    typeof checkpoint.finalizedGeneration === "number" &&
    typeof persistedSong.separationGeneration === "number" &&
    persistedSong.separationGeneration < checkpoint.finalizedGeneration
  ) {
    return false;
  }
  if (
    checkpoint.songId === persistedSong.songId &&
    typeof checkpoint.lastExecutionGeneration === "number" &&
    typeof checkpoint.finalizedGeneration === "number" &&
    checkpoint.lastExecutionGeneration > checkpoint.finalizedGeneration &&
    !checkpoint.finalizedAt
  ) {
    return false;
  }
  return true;
}

/** 明確且窮盡地將任務階段映射至歌曲分離狀態，絕不將 completed 或未識別狀態預設為 processing。 */
export function mapJobStageToSongSeparationStatus(stage: SeparationJobStage): SeparationStatus {
  switch (stage) {
    case "idle":
      return "not_started";
    case "preparing":
    case "downloading":
    case "processing":
    case "finalizing":
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
    isFinalized?: boolean;
  },
): SeparationJobStage {
  switch (checkpoint.status) {
    case "completed":
      return context.isFinalized ? "completed" : "finalizing";
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

/** 檢查任務狀態轉移與 generation fencing 是否合法，阻擋過期 callback 與非法狀態逆轉。 */
export function canTransitionJobStage(
  current: SeparationJobStage,
  next: SeparationJobStage,
  options?: {
    incomingGeneration?: number;
    currentGeneration?: number;
    allowRepairOrReset?: boolean;
    isAuthoritativeCheckpointRepair?: boolean;
  },
): boolean {
  const currentGen = options?.currentGeneration;
  const incomingGen = options?.incomingGeneration;

  // 新版 generation 不得被舊版 generation 覆寫；一般 allowRepairOrReset 亦不可繞過（唯有權威損毀修復入口例外）
  if (
    !options?.isAuthoritativeCheckpointRepair &&
    typeof incomingGen === "number" &&
    typeof currentGen === "number" &&
    incomingGen < currentGen
  ) {
    return false;
  }

  if (options?.allowRepairOrReset) {
    if (
      current === "completed" &&
      next === "finalizing" &&
      !options?.isAuthoritativeCheckpointRepair
    ) {
      return false;
    }
    if (
      current === "cancelled" &&
      next === "finalizing" &&
      !(typeof incomingGen === "number" && typeof currentGen === "number" && incomingGen > currentGen)
    ) {
      return false;
    }
    return true;
  }

  if (current === next) return true;

  // completed 為不可逆終態（包含禁止 completed -> finalizing 過期事件）
  if (current === "completed") {
    return false;
  }

  // cancelled 同世代或較舊世代不可回退為進行中／finalizing／中斷／失敗
  if (
    current === "cancelled" &&
    (next === "preparing" ||
      next === "downloading" ||
      next === "processing" ||
      next === "finalizing" ||
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
    (next === "downloading" || next === "processing" || next === "finalizing")
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
  private readonly retryTimer: RetryTimerAdapter;
  private readonly isDocumentHiddenFn: () => boolean;
  private readonly managerCreatedAt: number;

  private readonly jobs = new Map<string, SeparationJobState>();
  private readonly controllers = new Map<string, SeparationTaskController>();
  private readonly autoResumeHandlers = new Map<string, () => Promise<void>>();
  private readonly inFlightAutoResume = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly memoryRetryEntries = new Map<string, AutoResumeRetryEntry>();
  private readonly wakeupAttemptedMarkerByTask = new Map<string, number>();

  private snapshot: readonly SeparationJobState[] = EMPTY_SNAPSHOT;
  private globalFocusActive = false;
  private globalFocusOwnerSongId: string | null = null;
  private lifecycleRecoveryInFlight: Promise<void> | null = null;
  private lifecycleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryWakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeBroadcast: (() => void) | null = null;
  private disposed = false;

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
    this.retryTimer = options.retryTimer ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    this.isDocumentHiddenFn =
      options.isDocumentHidden ??
      (() => typeof document !== "undefined" && document.visibilityState === "hidden");
    this.managerCreatedAt = this.now();

    if (options.enableBroadcastSync !== false) {
      this.unsubscribeBroadcast = this.leaseManager.onBroadcast((msg) => {
        this.handleBroadcastMessage(msg);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.lifecycleDebounceTimer !== null) {
      clearTimeout(this.lifecycleDebounceTimer);
      this.lifecycleDebounceTimer = null;
    }
    this.clearRetryWakeup();
    this.unsubscribeBroadcast?.();
    this.unsubscribeBroadcast = null;
    this.controllers.clear();
    this.autoResumeHandlers.clear();
    this.inFlightAutoResume.clear();
    this.listeners.clear();
    this.wakeupAttemptedMarkerByTask.clear();
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
        retryPhase: "inference",
        retryWaitReason: undefined,
        isActivelyFinalizing: false,
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
    const removed = this.controllers.get(taskId) === controller;
    if (removed) {
      this.controllers.delete(taskId);
    }
    this.pruneTerminatedControllers();
    if (!this.disposed && !this.hasRunningHeavyTask()) {
      const hasWaitingLocalBusy = Object.values(this.readRetryMap()).some(
        (entry) => entry.waitReason === "local_task_running" || entry.blockedUntilAt,
      );
      if (hasWaitingLocalBusy) {
        const entries = this.readRetryMap();
        let updated = false;
        for (const [id, entry] of Object.entries(entries)) {
          if (entry.waitReason === "local_task_running") {
            entries[id] = {
              ...entry,
              waitReason: "backoff",
              blockedUntilAt: undefined,
            };
            updated = true;
          }
        }
        if (updated) {
          this.writeRetryMap(entries);
        }
        if (!this.isDocumentHiddenFn()) {
          void this.triggerLifecycleRecovery("local-task-settled").catch(() => undefined);
          return;
        }
      }
      this.scheduleRetryWakeup();
    }
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
          isAuthoritativeCheckpointRepair: options?.isAuthoritativeCheckpointRepair,
        })
      ) {
        recordSeparationDiagnostic({
          event: "stale-worker-update-rejected",
          source: options?.source ?? "SeparationJobManager.updateJob",
          taskId,
          songId: current.songId,
          generation: incomingGen ?? null,
          ownerJobToken: incomingToken ?? null,
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
        !options?.isAuthoritativeCheckpointRepair &&
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
          ownerJobToken: incomingToken,
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
      !options?.isAuthoritativeCheckpointRepair &&
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

    // 僅在推論階段收到實質新增 Chunk 進展時重置失敗次數；finalizing 讀取完成段落不得重置
    if (
      nextStage !== "finalizing" &&
      current?.stage !== "finalizing" &&
      safeCompletedChunks > (current?.completedChunks ?? 0)
    ) {
      this.onSubstantialChunkProgress(taskId, safeCompletedChunks);
    }

    const resolvedGeneration =
      typeof incomingGen === "number"
        ? Math.max(
            options?.isAuthoritativeCheckpointRepair ? incomingGen : (current?.generation ?? 0),
            incomingGen,
          )
        : (current?.generation ?? 0);

    const nextRetryPhase: SeparationRetryPhase | undefined =
      patch.retryPhase !== undefined
        ? patch.retryPhase
        : nextStage === "finalizing"
          ? "finalization"
          : nextStage === "completed" || nextStage === "cancelled"
            ? undefined
            : current?.retryPhase;

    const nextActivelyFinalizing: boolean | undefined =
      patch.isActivelyFinalizing !== undefined
        ? patch.isActivelyFinalizing
        : nextStage === "finalizing"
          ? current?.isActivelyFinalizing
          : false;

    const nextWaitReason: RetryWaitReason | undefined =
      "retryWaitReason" in patch
        ? patch.retryWaitReason
        : nextStage === "completed" || nextStage === "cancelled"
          ? undefined
          : current?.retryWaitReason;

    const next: SeparationJobState = {
      taskId,
      songId: patch.songId ?? current?.songId ?? "",
      songName: patch.songName ?? current?.songName,
      requestedMode: patch.requestedMode ?? current?.requestedMode,
      generation: resolvedGeneration,
      ownerJobToken: incomingToken ?? current?.ownerJobToken,
      ownerTabId: patch.ownerTabId ?? current?.ownerTabId,
      isForeignActive:
        patch.isForeignActive !== undefined ? patch.isForeignActive : current?.isForeignActive,
      stage: nextStage,
      retryPhase: nextRetryPhase,
      retryWaitReason: nextWaitReason,
      isActivelyFinalizing: nextActivelyFinalizing,
      nextRetryAt:
        "nextRetryAt" in patch
          ? patch.nextRetryAt
          : nextStage === "completed" || nextStage === "cancelled"
            ? undefined
            : current?.nextRetryAt,
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
        this.wakeupAttemptedMarkerByTask.delete(taskId);
        this.clearRetryEntry(taskId);
      }
    }

    this.scheduleRetryWakeup();

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
    const repairedGen =
      checkpoint.lease?.generation ??
      checkpoint.lastExecutionGeneration ??
      checkpoint.finalizationFence?.generation ??
      existing?.generation ??
      0;
    recordSeparationDiagnostic({
      source: "SeparationJobManager.repairJobFromAuthoritativeCheckpoint",
      taskId,
      songId: checkpoint.songId,
      generation: repairedGen,
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
        generation: repairedGen,
        stage: repairedStage,
        retryPhase: repairedStage === "finalizing" ? "finalization" : "inference",
        isActivelyFinalizing: false,
        progress: totalChunks > 0 ? validChunkCount / totalChunks : 0,
        completedChunks: validChunkCount,
        totalChunks,
        committedBytes: validChunkCount > 0 ? checkpoint.committedBytes : 0,
        message: reason,
      },
      {
        generation: repairedGen,
        allowRepairOrReset: true,
        isAuthoritativeCheckpointRepair: true,
        source: "authoritative-repair",
      },
    );
  }

  /**
   * 透過獨立 `SeparationJobRunner` 執行完整分軌（包含音訊載入、Web Lock、Worker、持久化）。
   * 即使 BandMixer 卸載或使用者切換路由至 /studio，仍能完整完成並提交歌曲資料。
   */
  async runSongSeparation(request: StartSeparationJobRequest): Promise<SeparationJobRunOutcome> {
    const outcome = await runSeparationJob(request, this, this.runnerDeps);
    if (outcome.status === "completed" || outcome.status === "cancelled") {
      this.clearRetryEntry(outcome.taskId);
      await this.leaseManager.clearCheckpointRetryState(outcome.taskId, this.now()).catch(() => undefined);
      return outcome;
    }

    // 初次／手動執行於 finalizing（或可恢復階段）遭遇暫時性失敗時：
    // 建立初始 retry 資格：attempts = 0, nextEligibleAt = now + BACKOFF[0] (5 秒)，並標示 backoffCursor=1
    if (!request.isAutoResume && outcome.status === "failed" && outcome.retryable) {
      const job = this.jobs.get(outcome.taskId);
      const isFinalizingPhase =
        outcome.retryPhase === "finalization" || job?.stage === "finalizing";
      if (isFinalizingPhase) {
        const now = this.now();
        const nextEligibleAt = now + AUTO_RESUME_BACKOFF_MS[0];
        const waitReason: RetryWaitReason =
          outcome.failureCode === "quota_exceeded" ? "storage_unavailable" : "backoff";
        const persistedState: PersistedCheckpointRetryState = {
          attempts: 0,
          nextEligibleAt,
          lastError: outcome.message,
          baselineCompletedChunks: outcome.completedChunks,
          retryPhase: "finalization",
          waitReason,
          backoffCursor: 1,
          updatedAt: now,
        };
        await this.leaseManager
          .upsertCheckpointRetryState(outcome.taskId, persistedState)
          .catch(() => null);
        this.saveRetryEntry({
          taskId: outcome.taskId,
          attempts: 0,
          nextEligibleAt,
          lastError: outcome.message,
          baselineCompletedChunks: outcome.completedChunks,
          retryPhase: "finalization",
          waitReason,
          backoffCursor: 1,
        });
        this.updateJob(
          outcome.taskId,
          {
            stage: "finalizing",
            retryPhase: "finalization",
            retryWaitReason: waitReason,
            isActivelyFinalizing: false,
            nextRetryAt: nextEligibleAt,
            autoResumeAttempts: 0,
            autoResumeExhausted: false,
            requiresManualAction: false,
            message:
              waitReason === "storage_unavailable"
                ? "請釋放空間後重試保存"
                : "分軌已完成，等待保存",
          },
          { source: "runner.finalizationRetryScheduled" },
        );
      }
    }
    return outcome;
  }

  /**
   * 手動「重試保存」專用入口：僅執行零重算最終提交，絕不重建 Worker、不下載模型、不重新跑推論。
   * 並嚴格防止重複點擊與競態覆寫。
   */
  async retryFinalization(taskId: string): Promise<SeparationJobRunOutcome | null> {
    let job = this.jobs.get(taskId);
    if (!job) {
      await this.refreshFromCheckpoint(taskId).catch(() => undefined);
      job = this.jobs.get(taskId);
    }
    if (!job || job.stage === "completed" || job.stage === "cancelled") {
      return null;
    }
    if (job.isForeignActive || job.isActivelyFinalizing || this.inFlightAutoResume.has(taskId)) {
      return null;
    }

    const prevEntry = this.getAutoResumeRetryState(taskId);
    const prevAttempts = job.autoResumeAttempts ?? prevEntry?.attempts ?? 0;

    this.inFlightAutoResume.add(taskId);
    this.updateJob(
      taskId,
      {
        stage: "finalizing",
        retryPhase: "finalization",
        retryWaitReason: undefined,
        isActivelyFinalizing: true,
        autoResumeExhausted: false,
        requiresManualAction: false,
        message: "正在保存結果",
      },
      { source: "retryFinalization.start" },
    );

    try {
      const outcome = await this.runSongSeparation({
        taskId,
        songId: job.songId,
        songName: job.songName,
        mode: job.requestedMode,
        isAutoResume: true,
        onlyFinalize: true,
        userAuthorized: true,
      });

      if (outcome.status === "completed") {
        this.clearRetryEntry(taskId);
        await this.leaseManager.clearCheckpointRetryState(taskId, this.now()).catch(() => undefined);
        return outcome;
      }

      if (outcome.status === "blocked") {
        const waitReason: RetryWaitReason =
          outcome.code === "foreign_lease"
            ? "foreign_lease"
            : outcome.code === "lock_unavailable"
              ? "foreign_lock"
              : outcome.code === "hidden"
                ? "document_hidden"
                : "manual_action_required";
        this.updateJob(
          taskId,
          {
            stage: "finalizing",
            retryPhase: "finalization",
            retryWaitReason: waitReason,
            isActivelyFinalizing: false,
            requiresManualAction: !outcome.retryable,
            autoResumeExhausted: !outcome.retryable,
            message:
              waitReason === "foreign_lease" || waitReason === "foreign_lock"
                ? "其他分頁正在處理"
                : outcome.message,
          },
          { source: "retryFinalization.blocked" },
        );
        return outcome;
      }

      if (outcome.status === "failed") {
        if (!outcome.retryable) {
          this.updateJob(
            taskId,
            {
              stage: "failed",
              retryPhase: "finalization",
              retryWaitReason: "manual_action_required",
              isActivelyFinalizing: false,
              autoResumeExhausted: true,
              requiresManualAction: true,
              message: outcome.message,
            },
            { source: "retryFinalization.rejected" },
          );
          return outcome;
        }
        const isQuota = outcome.failureCode === "quota_exceeded";
        const exhaustedBefore = prevAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
        this.updateJob(
          taskId,
          {
            stage: "finalizing",
            retryPhase: "finalization",
            retryWaitReason: isQuota
              ? "storage_unavailable"
              : exhaustedBefore
                ? "manual_action_required"
                : "backoff",
            isActivelyFinalizing: false,
            autoResumeAttempts: prevAttempts,
            autoResumeExhausted: exhaustedBefore,
            requiresManualAction: exhaustedBefore || isQuota,
            message: isQuota
              ? "請釋放空間後重試保存"
              : exhaustedBefore
                ? "保存未完成，請手動重試"
                : "分軌已完成，等待保存",
          },
          { source: "retryFinalization.failedRetryable" },
        );
        return outcome;
      }

      return outcome;
    } finally {
      this.inFlightAutoResume.delete(taskId);
      this.scheduleRetryWakeup();
    }
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
    this.clearRetryEntry(taskId);
    await this.leaseManager.clearCheckpointRetryState(taskId, this.now()).catch(() => undefined);
    const localController = this.controllers.get(taskId);
    const activeBySong = this.coordinator.getActiveController(job.songId);
    if (!localController && (!activeBySong || activeBySong.isTerminal())) {
      if (job.stage === "finalizing" || job.stage === "interrupted" || job.stage === "failed") {
        const cp = await getCheckpoint(taskId).catch(() => null);
        if (cp?.finalizedAt) {
          return false;
        }
        await updateCheckpointStatus(
          taskId,
          {
            status: "cancelled",
            lastError: "使用者已中止分軌任務",
            clearLeaseIfTerminal: true,
            allowDowngradeCompleted: !cp?.finalizedAt,
          },
          this.now(),
        ).catch(() => null);
        this.updateJob(
          taskId,
          {
            stage: "cancelled",
            retryPhase: undefined,
            retryWaitReason: undefined,
            isActivelyFinalizing: false,
            requiresManualAction: false,
            autoResumeExhausted: false,
            nextRetryAt: undefined,
            message: "已中止音軌分離（保留已提交分段）。",
          },
          { allowRepairOrReset: true, source: "cancelJob.waiting" },
        );
        return true;
      }
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

    if (job.stage === "finalizing" || job.retryPhase === "finalization") {
      return this.retryFinalization(taskId);
    }

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
    await this.leaseManager.clearCheckpointRetryState(taskId, this.now()).catch(() => undefined);
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
    this.wakeupAttemptedMarkerByTask.delete(taskId);
    this.scheduleRetryWakeup();
  }

  async requestAutoResume(taskId: string): Promise<boolean> {
    if (this.disposed) return false;
    const job = this.jobs.get(taskId);
    if (!job || (job.stage !== "interrupted" && job.stage !== "finalizing") || job.isForeignActive) {
      return false;
    }
    if (this.inFlightAutoResume.has(taskId)) {
      return false;
    }

    const currentNow = this.now();
    const isFinalizationJob =
      job.stage === "finalizing" || job.retryPhase === "finalization";

    // 若頁面目前位於背景，只記錄等待理由，不得建立 0ms Timer 或消耗 retry 次數
    if (this.isDocumentHiddenFn()) {
      const existingEntry = this.getAutoResumeRetryState(taskId);
      if (existingEntry) {
        this.saveRetryEntry({
          ...existingEntry,
          waitReason: "document_hidden",
        });
      }
      this.updateJob(
        taskId,
        {
          stage: job.stage,
          retryPhase: isFinalizationJob ? "finalization" : "inference",
          retryWaitReason: "document_hidden",
          isActivelyFinalizing: false,
        },
        { source: "requestAutoResume.hidden" },
      );
      return false;
    }

    // 非純保存任務才受限於本地 Demucs 重型執行佔用；若本地重型任務忙碌則等待結束事件
    if (!isFinalizationJob && this.hasRunningHeavyTask()) {
      const existingEntry = this.getAutoResumeRetryState(taskId);
      if (existingEntry) {
        this.saveRetryEntry({
          ...existingEntry,
          waitReason: "local_task_running",
        });
      }
      this.updateJob(
        taskId,
        {
          stage: job.stage,
          retryPhase: "inference",
          retryWaitReason: "local_task_running",
          isActivelyFinalizing: false,
        },
        { source: "requestAutoResume.localBusy" },
      );
      return false;
    }

    const tabId = getOrCreateTabId();
    const retryMap = this.readRetryMap();
    let localEntry: AutoResumeRetryEntry = retryMap[taskId] ?? {
      taskId,
      attempts: 0,
      nextEligibleAt: 0,
      baselineCompletedChunks: job.completedChunks,
      retryPhase: isFinalizationJob ? "finalization" : "inference",
      waitReason: "backoff",
      backoffCursor: 0,
    };

    // 僅推論任務在獲得新 Chunk 進展時重置失敗次數；finalization 重試禁止因讀取同一完成 Chunk 而重置
    if (
      !isFinalizationJob &&
      localEntry.retryPhase !== "finalization" &&
      job.completedChunks > localEntry.baselineCompletedChunks
    ) {
      localEntry = {
        taskId,
        attempts: 0,
        nextEligibleAt: 0,
        baselineCompletedChunks: job.completedChunks,
        retryPhase: "inference",
        waitReason: "backoff",
        backoffCursor: 0,
      };
      this.saveRetryEntry(localEntry);
    }

    const idbFallback: PersistedCheckpointRetryState = {
      attempts: localEntry.attempts,
      nextEligibleAt: localEntry.nextEligibleAt,
      blockedUntilAt: localEntry.blockedUntilAt,
      lastError: localEntry.lastError,
      permanentlyBlockedReason: localEntry.permanentlyBlockedReason,
      baselineCompletedChunks: localEntry.baselineCompletedChunks,
      retryPhase: localEntry.retryPhase ?? (isFinalizationJob ? "finalization" : "inference"),
      waitReason: localEntry.waitReason,
      backoffCursor: localEntry.backoffCursor ?? 0,
      updatedAt: currentNow,
    };

    const idbReservation = await this.leaseManager
      .reserveAutoResumeAttempt(taskId, tabId, {
        maxAttempts: MAX_AUTO_RESUME_ATTEMPTS,
        fallbackEntry: idbFallback,
        now: currentNow,
      })
      .catch(() => ({ reserved: false as const, reason: "no_checkpoint" as const }));

    let activeEntry: AutoResumeRetryEntry = localEntry;
    let reservationToken: string | null = null;
    let previousAttemptsBeforeReservation = localEntry.attempts;

    if (idbReservation.reserved) {
      reservationToken = idbReservation.reservationToken;
      previousAttemptsBeforeReservation = idbReservation.previousAttempts;
      activeEntry = {
        taskId,
        attempts: idbReservation.previousAttempts,
        nextEligibleAt: idbReservation.state.nextEligibleAt,
        blockedUntilAt: idbReservation.state.blockedUntilAt,
        lastError: idbReservation.state.lastError,
        permanentlyBlockedReason: idbReservation.state.permanentlyBlockedReason,
        baselineCompletedChunks: idbReservation.state.baselineCompletedChunks,
        retryPhase: idbReservation.state.retryPhase,
        waitReason: (idbReservation.state.waitReason as RetryWaitReason | undefined) ?? "backoff",
        backoffCursor: idbReservation.state.backoffCursor ?? 0,
      };
      // 同步儲存預扣後的狀態至 mirror retryStorage，避免跨執行環境讀取落差
      this.saveRetryEntry(
        {
          ...activeEntry,
          attempts: idbReservation.reservedAttempts,
        },
        { skipSchedule: true },
      );
    } else if (idbReservation.reason !== "no_checkpoint") {
      if (idbReservation.reason === "cancelled") {
        await this.refreshFromCheckpoint(taskId).catch(() => undefined);
        return false;
      }
      if (idbReservation.reason === "foreign_lease" || idbReservation.reason === "foreign_reservation") {
        const blockedUntil = currentNow + BLOCKED_RECHECK_DELAY_MS;
        this.saveRetryEntry(
          {
            ...localEntry,
            waitReason: "foreign_lease",
            blockedUntilAt: blockedUntil,
          },
          { skipSchedule: true },
        );
        this.updateJob(
          taskId,
          {
            stage: isFinalizationJob ? "finalizing" : job.stage,
            retryPhase: isFinalizationJob ? "finalization" : "inference",
            retryWaitReason: "foreign_lease",
            isForeignActive: true,
            isActivelyFinalizing: false,
            message: isFinalizationJob ? "其他分頁正在處理" : job.message,
          },
          { source: "requestAutoResume.foreignReservation" },
        );
        return false;
      }
      if (idbReservation.reason === "not_eligible_yet" && idbReservation.state) {
        this.saveRetryEntry(
          {
            taskId,
            attempts: idbReservation.state.attempts,
            nextEligibleAt: idbReservation.state.nextEligibleAt,
            blockedUntilAt: idbReservation.state.blockedUntilAt,
            lastError: idbReservation.state.lastError,
            permanentlyBlockedReason: idbReservation.state.permanentlyBlockedReason,
            baselineCompletedChunks: idbReservation.state.baselineCompletedChunks,
            retryPhase: idbReservation.state.retryPhase,
            waitReason: idbReservation.state.waitReason as RetryWaitReason | undefined,
            backoffCursor: idbReservation.state.backoffCursor,
          },
          { skipSchedule: true },
        );
        return false;
      }
      if (idbReservation.reason === "permanently_blocked" && idbReservation.state) {
        this.updateJob(
          taskId,
          {
            stage: isFinalizationJob ? "finalizing" : "interrupted",
            retryPhase: isFinalizationJob ? "finalization" : "inference",
            retryWaitReason: "manual_action_required",
            isActivelyFinalizing: false,
            autoResumeAttempts: idbReservation.state.attempts,
            autoResumeExhausted: true,
            requiresManualAction: true,
            message:
              idbReservation.state.permanentlyBlockedReason ||
              "此任務需手動確認後再執行。",
          },
          { source: "requestAutoResume.permanentlyBlocked" },
        );
        return false;
      }
      if (idbReservation.reason === "exhausted" && idbReservation.state) {
        const exhaustedStage =
          idbReservation.state.retryPhase === "finalization" || isFinalizationJob
            ? "finalizing"
            : "interrupted";
        this.saveRetryEntry(
          {
            taskId,
            attempts: idbReservation.state.attempts,
            nextEligibleAt: idbReservation.state.nextEligibleAt,
            lastError: idbReservation.state.lastError,
            baselineCompletedChunks: idbReservation.state.baselineCompletedChunks,
            retryPhase: idbReservation.state.retryPhase,
            waitReason: "manual_action_required",
            backoffCursor: idbReservation.state.backoffCursor,
          },
          { skipSchedule: true },
        );
        this.updateJob(
          taskId,
          {
            stage: exhaustedStage,
            retryPhase: idbReservation.state.retryPhase,
            retryWaitReason: "manual_action_required",
            isActivelyFinalizing: false,
            autoResumeAttempts: idbReservation.state.attempts,
            autoResumeExhausted: true,
            requiresManualAction: true,
            message:
              exhaustedStage === "finalizing"
                ? "保存未完成，請手動重試"
                : `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`,
          },
          { source: "requestAutoResume.exhausted" },
        );
        return false;
      }
    } else {
      // 無 IndexedDB Checkpoint 時的本地原子防線
      if (activeEntry.permanentlyBlockedReason) {
        this.updateJob(taskId, {
          stage: isFinalizationJob ? "finalizing" : "interrupted",
          retryWaitReason: "manual_action_required",
          isActivelyFinalizing: false,
          autoResumeAttempts: activeEntry.attempts,
          autoResumeExhausted: true,
          requiresManualAction: true,
          message: activeEntry.permanentlyBlockedReason,
        });
        return false;
      }
      if (activeEntry.attempts >= MAX_AUTO_RESUME_ATTEMPTS) {
        this.updateJob(taskId, {
          stage: isFinalizationJob ? "finalizing" : "interrupted",
          retryWaitReason: "manual_action_required",
          isActivelyFinalizing: false,
          autoResumeAttempts: activeEntry.attempts,
          autoResumeExhausted: true,
          requiresManualAction: true,
          message: isFinalizationJob
            ? "保存未完成，請手動重試"
            : `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`,
        });
        return false;
      }
      const effectiveEligibleAt = Math.max(
        activeEntry.nextEligibleAt,
        activeEntry.blockedUntilAt ?? 0,
      );
      if (effectiveEligibleAt > currentNow) {
        return false;
      }
    }

    const resolvedRetryPhase: SeparationRetryPhase =
      activeEntry.retryPhase ?? (isFinalizationJob ? "finalization" : "inference");

    this.inFlightAutoResume.add(taskId);
    const registeredHandler = this.autoResumeHandlers.get(taskId);

    const recordAttemptDiagnostic = (
      note: string,
      opts?: {
        attempts?: number;
        waitReason?: RetryWaitReason;
        nextEligibleAt?: number;
        finalizationOutcome?: string;
      },
    ) => {
      recordSeparationDiagnostic({
        source: "SeparationJobManager.requestAutoResume",
        taskId,
        songId: job.songId,
        generation: job.generation,
        jobStage: this.jobs.get(taskId)?.stage ?? job.stage,
        retryPhase: resolvedRetryPhase,
        retryWaitReason: opts?.waitReason ?? null,
        retryAttempts: opts?.attempts ?? previousAttemptsBeforeReservation,
        nextEligibleAt: opts?.nextEligibleAt ?? null,
        finalizationOutcome: opts?.finalizationOutcome ?? null,
        note,
        timestamp: this.now(),
      });
    };

    try {
      if (registeredHandler) {
        this.updateJob(taskId, {
          stage: "preparing",
          isActivelyFinalizing: false,
          message: "正在驗證 Checkpoint 與執行權，準備安全續跑…",
        });
        await registeredHandler();
        if (reservationToken) {
          await this.leaseManager
            .finalizeAutoResumeAttemptOutcome(taskId, reservationToken, null, this.now())
            .catch(() => undefined);
        }
        return true;
      }

      const outcome = await this.runSongSeparation({
        taskId,
        songId: job.songId,
        songName: job.songName,
        mode: job.requestedMode,
        isAutoResume: true,
        onlyFinalize: resolvedRetryPhase === "finalization",
      });

      if (
        outcome.status === "completed" ||
        outcome.status === "paused" ||
        outcome.status === "cancelled"
      ) {
        if (outcome.status === "completed" || outcome.status === "cancelled") {
          this.clearRetryEntry(taskId);
          if (reservationToken) {
            await this.leaseManager
              .finalizeAutoResumeAttemptOutcome(taskId, reservationToken, null, this.now())
              .catch(() => undefined);
          }
        } else if (reservationToken) {
          await this.leaseManager
            .releaseAutoResumeReservation(taskId, reservationToken, {
              previousAttempts: previousAttemptsBeforeReservation,
              waitReason: "manual_action_required",
              now: this.now(),
            })
            .catch(() => undefined);
        }
        recordAttemptDiagnostic(`outcome=${outcome.status}`, {
          finalizationOutcome: outcome.status,
        });
        return outcome.status === "completed";
      }

      if (outcome.status === "blocked") {
        // 等待資源／執行鎖／頁面隱藏：原子返還額度，不消耗 attempts，且設定低頻重新評估時間避免 0ms 迴圈
        if (
          outcome.code === "lock_unavailable" ||
          outcome.code === "foreign_lease" ||
          outcome.code === "already_running" ||
          outcome.code === "hidden" ||
          outcome.code === "resource_blocked"
        ) {
          const waitReason: RetryWaitReason =
            outcome.code === "lock_unavailable"
              ? "foreign_lock"
              : outcome.code === "foreign_lease"
                ? "foreign_lease"
                : outcome.code === "already_running"
                  ? "local_task_running"
                  : outcome.code === "hidden"
                    ? "document_hidden"
                    : "resource_unavailable";
          const nowAfter = this.now();
          const blockedUntilAt =
            waitReason === "document_hidden" || waitReason === "local_task_running"
              ? undefined
              : nowAfter + BLOCKED_RECHECK_DELAY_MS;
          const restoredEntry: AutoResumeRetryEntry = {
            ...activeEntry,
            attempts: previousAttemptsBeforeReservation,
            blockedUntilAt,
            waitReason,
            retryPhase: resolvedRetryPhase,
          };
          this.saveRetryEntry(restoredEntry, { skipSchedule: true });
          if (reservationToken) {
            await this.leaseManager
              .releaseAutoResumeReservation(taskId, reservationToken, {
                previousAttempts: previousAttemptsBeforeReservation,
                waitReason,
                blockedUntilAt,
                now: nowAfter,
              })
              .catch(() => undefined);
          }
          if (
            outcome.code === "lock_unavailable" ||
            outcome.code === "foreign_lease"
          ) {
            await this.refreshFromCheckpoint(taskId);
          }
          const refreshedJob = this.jobs.get(taskId);
          this.updateJob(
            taskId,
            {
              stage: refreshedJob?.stage ?? (resolvedRetryPhase === "finalization" ? "finalizing" : job.stage),
              retryPhase: resolvedRetryPhase,
              retryWaitReason: waitReason,
              isActivelyFinalizing: false,
              autoResumeAttempts: previousAttemptsBeforeReservation,
              autoResumeExhausted: false,
              requiresManualAction: false,
              message:
                waitReason === "foreign_lock" || waitReason === "foreign_lease"
                  ? "其他分頁正在處理"
                  : outcome.message,
            },
            { source: `requestAutoResume.blocked.${outcome.code}` },
          );
          recordAttemptDiagnostic(`blocked:${outcome.code} (quota refunded)`, {
            attempts: previousAttemptsBeforeReservation,
            waitReason,
            nextEligibleAt: blockedUntilAt,
          });
          return false;
        }

        if (!outcome.retryable) {
          const updatedEntry: AutoResumeRetryEntry = {
            ...activeEntry,
            attempts: previousAttemptsBeforeReservation,
            lastError: outcome.message,
            permanentlyBlockedReason: outcome.message,
            retryPhase: resolvedRetryPhase,
            waitReason: "manual_action_required",
          };
          this.saveRetryEntry(updatedEntry, { skipSchedule: true });
          if (reservationToken) {
            await this.leaseManager
              .finalizeAutoResumeAttemptOutcome(
                taskId,
                reservationToken,
                {
                  attempts: updatedEntry.attempts,
                  nextEligibleAt: updatedEntry.nextEligibleAt,
                  lastError: outcome.message,
                  permanentlyBlockedReason: outcome.message,
                  baselineCompletedChunks: updatedEntry.baselineCompletedChunks,
                  retryPhase: resolvedRetryPhase,
                  waitReason: "manual_action_required",
                  backoffCursor: updatedEntry.backoffCursor ?? 0,
                  updatedAt: this.now(),
                },
                this.now(),
              )
              .catch(() => undefined);
          }
          this.updateJob(taskId, {
            stage: resolvedRetryPhase === "finalization" ? "finalizing" : "interrupted",
            retryPhase: resolvedRetryPhase,
            retryWaitReason: "manual_action_required",
            isActivelyFinalizing: false,
            autoResumeAttempts: updatedEntry.attempts,
            autoResumeExhausted: true,
            requiresManualAction: true,
            message: outcome.message,
          });
          return false;
        }
      }

      // 實際進入執行並失敗：計算下一次精確退避（5s -> 15s -> 60s -> exhausted）
      const outcomeFailed = outcome.status === "failed" ? outcome : null;
      const nowAfterFail = this.now();

      if (outcomeFailed && !outcomeFailed.retryable) {
        if (outcomeFailed.failureCode === "song_missing") {
          this.clearRetryEntry(taskId);
          await this.leaseManager
            .finalizeAutoResumeAttemptOutcome(taskId, reservationToken ?? "", null, nowAfterFail)
            .catch(() => undefined);
          if (!this.hasActiveLocalController(taskId)) {
            this.jobs.delete(taskId);
            this.publish();
          }
          return false;
        }
        if (outcomeFailed.failureCode === "stale_generation") {
          this.clearRetryEntry(taskId);
          await this.refreshFromCheckpoint(taskId).catch(() => undefined);
          return false;
        }

        const updatedEntry: AutoResumeRetryEntry = {
          ...activeEntry,
          attempts: previousAttemptsBeforeReservation,
          lastError: outcomeFailed.message,
          permanentlyBlockedReason: outcomeFailed.message,
          retryPhase: outcomeFailed.retryPhase ?? resolvedRetryPhase,
          waitReason: "manual_action_required",
        };
        this.saveRetryEntry(updatedEntry, { skipSchedule: true });
        if (reservationToken) {
          await this.leaseManager
            .finalizeAutoResumeAttemptOutcome(
              taskId,
              reservationToken,
              {
                attempts: updatedEntry.attempts,
                nextEligibleAt: updatedEntry.nextEligibleAt,
                lastError: outcomeFailed.message,
                permanentlyBlockedReason: outcomeFailed.message,
                baselineCompletedChunks: updatedEntry.baselineCompletedChunks,
                retryPhase: updatedEntry.retryPhase ?? resolvedRetryPhase,
                waitReason: "manual_action_required",
                backoffCursor: updatedEntry.backoffCursor ?? 0,
                updatedAt: nowAfterFail,
              },
              nowAfterFail,
            )
            .catch(() => undefined);
        }
        this.updateJob(taskId, {
          stage: "failed",
          retryPhase: updatedEntry.retryPhase ?? resolvedRetryPhase,
          retryWaitReason: "manual_action_required",
          isActivelyFinalizing: false,
          completedChunks: outcomeFailed.completedChunks,
          totalChunks: outcomeFailed.totalChunks,
          committedBytes: outcomeFailed.committedBytes,
          autoResumeAttempts: updatedEntry.attempts,
          autoResumeExhausted: true,
          requiresManualAction: true,
          message: outcomeFailed.message,
        });
        return false;
      }

      const failCompletedChunks = outcomeFailed?.completedChunks ?? job.completedChunks;
      const failTotalChunks = outcomeFailed?.totalChunks ?? job.totalChunks;
      const failCommittedBytes = outcomeFailed?.committedBytes ?? job.committedBytes;
      const failMessage = outcomeFailed?.message ?? outcome.message;
      const effectivePhase: SeparationRetryPhase =
        outcomeFailed?.retryPhase ?? resolvedRetryPhase;

      // 只有推論階段真的新算出 Chunk 才重置重試計數；finalization 重試絕不重置
      if (
        effectivePhase === "inference" &&
        failCompletedChunks > activeEntry.baselineCompletedChunks
      ) {
        const nextEligibleAt = nowAfterFail + AUTO_RESUME_BACKOFF_MS[0];
        const resetEntry: AutoResumeRetryEntry = {
          taskId,
          attempts: 0,
          nextEligibleAt,
          baselineCompletedChunks: failCompletedChunks,
          retryPhase: "inference",
          waitReason: "backoff",
          backoffCursor: 1,
          lastError: failMessage,
        };
        this.saveRetryEntry(resetEntry, { skipSchedule: true });
        if (reservationToken) {
          await this.leaseManager
            .finalizeAutoResumeAttemptOutcome(
              taskId,
              reservationToken,
              {
                attempts: 0,
                nextEligibleAt,
                lastError: failMessage,
                baselineCompletedChunks: failCompletedChunks,
                retryPhase: "inference",
                waitReason: "backoff",
                backoffCursor: 1,
                updatedAt: nowAfterFail,
              },
              nowAfterFail,
            )
            .catch(() => undefined);
        }
        this.updateJob(taskId, {
          stage: "interrupted",
          retryPhase: "inference",
          retryWaitReason: "backoff",
          isActivelyFinalizing: false,
          nextRetryAt: nextEligibleAt,
          completedChunks: failCompletedChunks,
          totalChunks: failTotalChunks,
          committedBytes: failCommittedBytes,
          autoResumeAttempts: 0,
          autoResumeExhausted: false,
          requiresManualAction: false,
          message: `${failMessage}（進度已推進至第 ${failCompletedChunks} 段，稍後自動續跑）`,
        });
        return false;
      }

      const nextAttempts = previousAttemptsBeforeReservation + 1;
      const exhausted = nextAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
      const cursor = activeEntry.backoffCursor ?? 0;
      const backoffIdx = Math.min(cursor + (nextAttempts - 1), AUTO_RESUME_BACKOFF_MS.length - 1);
      const backoffMs = AUTO_RESUME_BACKOFF_MS[backoffIdx];
      const nextEligibleAt = exhausted ? nowAfterFail : nowAfterFail + backoffMs;
      const waitReason: RetryWaitReason = exhausted
        ? "manual_action_required"
        : outcomeFailed?.failureCode === "quota_exceeded"
          ? "storage_unavailable"
          : "backoff";

      const updatedEntry: AutoResumeRetryEntry = {
        taskId,
        attempts: nextAttempts,
        nextEligibleAt,
        blockedUntilAt: undefined,
        lastError: failMessage,
        baselineCompletedChunks: Math.max(activeEntry.baselineCompletedChunks, failCompletedChunks),
        retryPhase: effectivePhase,
        waitReason,
        backoffCursor: cursor,
      };
      this.saveRetryEntry(updatedEntry, { skipSchedule: true });
      if (reservationToken) {
        await this.leaseManager
          .finalizeAutoResumeAttemptOutcome(
            taskId,
            reservationToken,
            {
              attempts: nextAttempts,
              nextEligibleAt,
              lastError: failMessage,
              baselineCompletedChunks: updatedEntry.baselineCompletedChunks,
              retryPhase: effectivePhase,
              waitReason,
              backoffCursor: cursor,
              updatedAt: nowAfterFail,
            },
            nowAfterFail,
          )
          .catch(() => undefined);
      }

      const nextStage: SeparationJobStage =
        effectivePhase === "finalization" ? "finalizing" : "interrupted";
      const uiMessage =
        effectivePhase === "finalization"
          ? exhausted
            ? "保存未完成，請手動重試"
            : waitReason === "storage_unavailable"
              ? "請釋放空間後重試保存"
              : "分軌已完成，等待保存"
          : exhausted
            ? `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`
            : `${failMessage}（將於稍後自動重試 ${nextAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}）`;

      this.updateJob(taskId, {
        stage: nextStage,
        retryPhase: effectivePhase,
        retryWaitReason: waitReason,
        isActivelyFinalizing: false,
        nextRetryAt: exhausted ? undefined : nextEligibleAt,
        completedChunks: failCompletedChunks,
        totalChunks: failTotalChunks,
        committedBytes: failCommittedBytes,
        autoResumeAttempts: nextAttempts,
        autoResumeExhausted: exhausted,
        requiresManualAction: exhausted || waitReason === "storage_unavailable",
        message: uiMessage,
      });

      recordAttemptDiagnostic(`retry_failed attempt=${nextAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}`, {
        attempts: nextAttempts,
        waitReason,
        nextEligibleAt: exhausted ? undefined : nextEligibleAt,
        finalizationOutcome: outcomeFailed?.failureCode,
      });
      return false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "自動續跑失敗，等待下一次可用執行環境。";
      const nowOnCatch = this.now();
      const nextAttempts = previousAttemptsBeforeReservation + 1;
      const exhausted = nextAttempts >= MAX_AUTO_RESUME_ATTEMPTS;
      const cursor = activeEntry.backoffCursor ?? 0;
      const backoffIdx = Math.min(cursor + (nextAttempts - 1), AUTO_RESUME_BACKOFF_MS.length - 1);
      const backoffMs = AUTO_RESUME_BACKOFF_MS[backoffIdx];
      const nextEligibleAt = exhausted ? nowOnCatch : nowOnCatch + backoffMs;
      const waitReason: RetryWaitReason = exhausted ? "manual_action_required" : "backoff";
      const fallbackStage: SeparationJobStage =
        resolvedRetryPhase === "finalization" ? "finalizing" : "interrupted";

      this.saveRetryEntry(
        {
          ...activeEntry,
          attempts: nextAttempts,
          nextEligibleAt,
          blockedUntilAt: undefined,
          lastError: msg,
          retryPhase: resolvedRetryPhase,
          waitReason,
          backoffCursor: cursor,
        },
        { skipSchedule: true },
      );
      if (reservationToken) {
        await this.leaseManager
          .finalizeAutoResumeAttemptOutcome(
            taskId,
            reservationToken,
            {
              attempts: nextAttempts,
              nextEligibleAt,
              lastError: msg,
              baselineCompletedChunks: activeEntry.baselineCompletedChunks,
              retryPhase: resolvedRetryPhase,
              waitReason,
              backoffCursor: cursor,
              updatedAt: nowOnCatch,
            },
            nowOnCatch,
          )
          .catch(() => undefined);
      }
      this.updateJob(taskId, {
        stage: fallbackStage,
        retryPhase: resolvedRetryPhase,
        retryWaitReason: waitReason,
        isActivelyFinalizing: false,
        nextRetryAt: exhausted ? undefined : nextEligibleAt,
        autoResumeAttempts: nextAttempts,
        autoResumeExhausted: exhausted,
        requiresManualAction: exhausted,
        message:
          fallbackStage === "finalizing"
            ? exhausted
              ? "保存未完成，請手動重試"
              : "分軌已完成，等待保存"
            : exhausted
              ? `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`
              : msg,
      });
      return false;
    } finally {
      this.inFlightAutoResume.delete(taskId);
      this.scheduleRetryWakeup();
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
    const persistedSong = await getPersistedSongRecord(checkpoint.songId).catch(() => null);
    const isFinalized = isPersistedSongAuthoritativelyFinalized(persistedSong, checkpoint);

    const needsLockProbe =
      !hasActiveLocal &&
      !hasForeignLease &&
      (checkpoint.status === "running" || (checkpoint.status === "completed" && !isFinalized));
    const lockHeldByOther =
      needsLockProbe &&
      (await this.leaseManager.isTaskLockHeld(taskId, this.lockAdapter));

    const hasActiveForeignOwner = hasForeignLease || lockHeldByOther;
    const stage = mapCheckpointStatusToJobStage(checkpoint, {
      hasActiveLocalController: hasActiveLocal,
      hasActiveForeignOwner,
      isFinalized,
    });

    const resolvedSongName = existing?.songName ?? persistedSong?.name;
    const cpGeneration = Math.max(
      checkpoint.lease?.generation ?? 0,
      checkpoint.finalizationFence?.generation ?? 0,
      checkpoint.lastExecutionGeneration ?? 0,
      existing?.generation ?? 0,
    );

    const progress =
      stage === "completed"
        ? 1
        : checkpoint.totalChunks > 0
          ? Math.min(0.99, checkpoint.nextChunkIndex / checkpoint.totalChunks)
          : 0;

    // 同步 IndexedDB 持久化之重試紀錄至本分頁（維持跨分頁與重整一致）
    if (checkpoint.retryState && !isFinalized && checkpoint.status !== "cancelled") {
      const mirrored = this.getAutoResumeRetryState(taskId);
      const rs = checkpoint.retryState;
      if (
        !mirrored ||
        rs.updatedAt >= (existing?.updatedAt ?? 0) ||
        rs.attempts > mirrored.attempts
      ) {
        this.saveRetryEntry(
          {
            taskId,
            attempts: rs.attempts,
            nextEligibleAt: rs.nextEligibleAt,
            blockedUntilAt: rs.blockedUntilAt,
            lastError: rs.lastError,
            permanentlyBlockedReason: rs.permanentlyBlockedReason,
            baselineCompletedChunks: rs.baselineCompletedChunks,
            retryPhase: rs.retryPhase,
            waitReason: rs.waitReason as RetryWaitReason | undefined,
            backoffCursor: rs.backoffCursor,
          },
          { skipSchedule: true },
        );
      }
    }

    const effectiveRetry = checkpoint.retryState ?? this.getAutoResumeRetryState(taskId);
    const isForeignActiveNow = hasActiveForeignOwner && !hasActiveLocal;
    const isExhaustedNow = Boolean(
      effectiveRetry &&
        (effectiveRetry.permanentlyBlockedReason ||
          effectiveRetry.attempts >= MAX_AUTO_RESUME_ATTEMPTS),
    );
    const isQuotaWaitNow = effectiveRetry?.waitReason === "storage_unavailable";

    let message = existing?.message ?? "已從本機 Checkpoint 同步分離狀態。";
    let retryWaitReason: RetryWaitReason | undefined =
      effectiveRetry?.waitReason as RetryWaitReason | undefined;

    if (stage === "completed") {
      message = `分段分離完成（共 ${checkpoint.totalChunks} 段按需播放）。`;
      retryWaitReason = undefined;
    } else if (stage === "finalizing") {
      if (isForeignActiveNow) {
        retryWaitReason = hasForeignLease ? "foreign_lease" : "foreign_lock";
        message = "其他分頁正在處理";
      } else if (this.inFlightAutoResume.has(taskId) || existing?.isActivelyFinalizing) {
        retryWaitReason = undefined;
        message = "正在保存結果";
      } else if (isExhaustedNow) {
        retryWaitReason = "manual_action_required";
        message = "保存未完成，請手動重試";
      } else if (isQuotaWaitNow) {
        retryWaitReason = "storage_unavailable";
        message = "請釋放空間後重試保存";
      } else {
        retryWaitReason = retryWaitReason ?? "backoff";
        message = "分軌已完成，等待保存";
      }
    } else if (stage === "cancelled") {
      message = "已中止音軌分離（保留已提交分段）。";
      retryWaitReason = undefined;
    } else if (stage === "failed") {
      message = checkpoint.lastError || "音軌分離未完成。";
      retryWaitReason = "manual_action_required";
    } else if (stage === "paused") {
      message = `已暫停分離（已保存第 ${checkpoint.nextChunkIndex}/${checkpoint.totalChunks} 段）。`;
      retryWaitReason = "manual_action_required";
    } else if (stage === "processing" && isForeignActiveNow) {
      message = "其他分頁正在處理";
      retryWaitReason = hasForeignLease ? "foreign_lease" : "foreign_lock";
    } else if (stage === "interrupted") {
      if (isExhaustedNow) {
        retryWaitReason = "manual_action_required";
        message =
          effectiveRetry?.permanentlyBlockedReason ||
          `已達自動續跑重試上限（${MAX_AUTO_RESUME_ATTEMPTS} 次），請點擊「繼續分離」手動接續。`;
      } else {
        message = "偵測到未結束分離任務，準備驗證 Checkpoint 後接續。";
      }
    }

    // 若權威 IDB 已顯示明確終態／等待他頁／finalizing，同步至 Job 狀態（但禁止跨過 generation 降級檢查）
    const allowAuthoritativeSync =
      stage === "completed" ||
      stage === "finalizing" ||
      stage === "cancelled" ||
      stage === "paused" ||
      (isForeignActiveNow && stage === "processing");

    this.updateJob(
      taskId,
      {
        taskId,
        songId: checkpoint.songId,
        songName: resolvedSongName,
        generation: cpGeneration,
        ownerJobToken:
          checkpoint.lease?.ownerJobToken ??
          checkpoint.finalizationFence?.ownerJobToken ??
          existing?.ownerJobToken,
        ownerTabId:
          checkpoint.lease?.ownerTabId ??
          checkpoint.finalizationFence?.ownerTabId ??
          existing?.ownerTabId,
        requestedMode: checkpoint.requestedMode ?? existing?.requestedMode,
        isForeignActive: isForeignActiveNow,
        stage,
        retryPhase:
          stage === "finalizing"
            ? "finalization"
            : stage === "completed" || stage === "cancelled"
              ? undefined
              : "inference",
        retryWaitReason,
        isActivelyFinalizing:
          stage === "finalizing" && !isForeignActiveNow
            ? Boolean(this.inFlightAutoResume.has(taskId) || existing?.isActivelyFinalizing)
            : false,
        nextRetryAt:
          !isForeignActiveNow &&
          !isExhaustedNow &&
          effectiveRetry &&
          (stage === "finalizing" || stage === "interrupted")
            ? Math.max(effectiveRetry.nextEligibleAt, effectiveRetry.blockedUntilAt ?? 0)
            : undefined,
        progress,
        message,
        completedChunks: checkpoint.nextChunkIndex,
        totalChunks: checkpoint.totalChunks,
        committedBytes: checkpoint.committedBytes,
        autoResumeAttempts: effectiveRetry?.attempts ?? existing?.autoResumeAttempts,
        autoResumeExhausted: isExhaustedNow,
        requiresManualAction: isExhaustedNow || isQuotaWaitNow,
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
      this.clearRetryEntry(taskId);
      removedAny = true;
    }
    if (removedAny) {
      this.publish();
    }
    this.scheduleRetryWakeup();
  }

  /**
   * 統一生命週期恢復入口（visibilitychange / pageshow / resume / online）：
   * 進行去重與序列化，不會因事件連發而建立重複 Worker 或高頻排程。
   */
  triggerLifecycleRecovery(reason: string, debounceMs = 0): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.lifecycleRecoveryInFlight) {
      return this.lifecycleRecoveryInFlight;
    }
    const executeRecovery = async () => {
      try {
        await this.refreshFromStorage();
        if (this.disposed) return;
        if (this.isDocumentHiddenFn()) {
          recordSeparationDiagnostic({
            source: "SeparationJobManager.triggerLifecycleRecovery",
            lifecycleEvent: reason,
            retryWaitReason: "document_hidden",
            outcome: "deferred_hidden",
            timestamp: this.now(),
          });
          return;
        }
        const localBusy = this.hasRunningHeavyTask() || this.isGlobalFocusActive();
        const candidates = this.getJobs().filter(
          (job) => (job.stage === "interrupted" || job.stage === "finalizing") && !job.isForeignActive,
        );
        for (const job of candidates) {
          if (this.disposed || this.isDocumentHiddenFn()) break;
          const isFinalization =
            job.stage === "finalizing" || job.retryPhase === "finalization";
          if (localBusy && !isFinalization) {
            const entry = this.getAutoResumeRetryState(job.taskId);
            if (entry) {
              this.saveRetryEntry(
                { ...entry, waitReason: "local_task_running" },
                { skipSchedule: true },
              );
            }
            continue;
          }
          if (await this.requestAutoResume(job.taskId)) break;
        }
      } catch {
        // 排程器異常不得造成 unhandled rejection
      } finally {
        this.lifecycleRecoveryInFlight = null;
        if (!this.disposed) {
          this.scheduleRetryWakeup();
        }
      }
    };

    if (debounceMs > 0) {
      if (this.lifecycleDebounceTimer !== null) {
        clearTimeout(this.lifecycleDebounceTimer);
      }
      this.lifecycleRecoveryInFlight = new Promise<void>((resolve) => {
        this.lifecycleDebounceTimer = setTimeout(() => {
          this.lifecycleDebounceTimer = null;
          if (this.disposed) {
            this.lifecycleRecoveryInFlight = null;
            resolve();
            return;
          }
          void executeRecovery().then(resolve, resolve);
        }, debounceMs);
      });
      return this.lifecycleRecoveryInFlight;
    }

    this.lifecycleRecoveryInFlight = executeRecovery();
    return this.lifecycleRecoveryInFlight;
  }

  private handleBroadcastMessage(msg: LeaseBroadcastMessage): void {
    if (this.disposed) return;
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
            retryWaitReason: "foreign_lease",
            progress:
              msg.totalChunks && msg.totalChunks > 0
                ? Math.min(0.99, (msg.completedChunks ?? 0) / msg.totalChunks)
                : existing.progress,
            completedChunks: msg.completedChunks ?? existing.completedChunks,
            totalChunks: msg.totalChunks ?? existing.totalChunks,
            committedBytes: msg.committedBytes ?? existing.committedBytes,
            message: "其他分頁正在處理",
          },
          {
            generation: msg.generation ?? existing.generation,
            source: "broadcast.task-progress",
          },
        );
        return;
      }
    }

    void this.refreshFromCheckpoint(msg.taskId)
      .then(() => {
        if (this.disposed) return;
        // 若他頁釋放執行鎖或失敗，解除本頁的 foreign_lock/foreign_lease 等待標記並重新評估喚醒
        if (msg.type === "lease-released" || msg.type === "task-failed") {
          const entry = this.getAutoResumeRetryState(msg.taskId);
          if (
            entry &&
            (entry.waitReason === "foreign_lock" || entry.waitReason === "foreign_lease")
          ) {
            this.saveRetryEntry(
              {
                ...entry,
                waitReason: "backoff",
                blockedUntilAt: undefined,
              },
              { skipSchedule: true },
            );
          }
          if (!this.isDocumentHiddenFn()) {
            void this.triggerLifecycleRecovery(`broadcast:${msg.type}`);
          }
        }
      })
      .catch(() => undefined);
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
    // finalization 階段不得因重複讀取同一完成 Chunk 而重置失敗次數
    const job = this.jobs.get(taskId);
    if (existing.retryPhase === "finalization" || job?.stage === "finalizing") {
      return;
    }
    if (completedChunks > existing.baselineCompletedChunks) {
      entries[taskId] = {
        taskId,
        attempts: 0,
        nextEligibleAt: 0,
        baselineCompletedChunks: completedChunks,
        retryPhase: "inference",
        waitReason: "backoff",
        backoffCursor: 0,
      };
      this.writeRetryMap(entries);
      this.wakeupAttemptedMarkerByTask.delete(taskId);
      this.scheduleRetryWakeup();
    }
  }

  saveRetryEntry(
    entry: AutoResumeRetryEntry,
    options?: { skipSchedule?: boolean },
  ): void {
    const entries = this.readRetryMap();
    entries[entry.taskId] = entry;
    this.writeRetryMap(entries);
    if (!options?.skipSchedule) {
      this.scheduleRetryWakeup();
    }
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

  private clearRetryWakeup(): void {
    if (this.retryWakeupTimer !== null) {
      this.retryTimer.clearTimeout(this.retryWakeupTimer);
      this.retryWakeupTimer = null;
    }
  }

  /**
   * 單一、事件優先且防 0ms 高頻迴圈的重試排程器：
   * - disposed、document hidden、執行恢復進行中時不建立到期 Timer；
   * - 本地有重型任務忙碌時，推論重試等待任務收尾事件而不輪詢；
   * - 外部分頁鎖或資源暫時不可用時強制套用低頻下限（>= BLOCKED_RECHECK_DELAY_MS）；
   * - 對同一個已經喚醒測試過卻未消耗退避的時刻強制套用 MIN_RETRY_WAKEUP_DELAY_MS 下限，徹底杜絕 0ms 死循環。
   */
  private scheduleRetryWakeup(): void {
    this.clearRetryWakeup();
    if (this.disposed) return;
    if (this.isDocumentHiddenFn()) return;
    if (this.lifecycleRecoveryInFlight !== null || this.inFlightAutoResume.size > 0) return;

    const now = this.now();
    const localHeavyBusy = this.hasRunningHeavyTask() || this.isGlobalFocusActive();
    const candidates: Array<{ entry: AutoResumeRetryEntry; wakeupAt: number }> = [];

    for (const entry of Object.values(this.readRetryMap())) {
      if (entry.permanentlyBlockedReason || entry.attempts >= MAX_AUTO_RESUME_ATTEMPTS) {
        continue;
      }
      const job = this.jobs.get(entry.taskId);
      if (!job || job.isForeignActive) continue;
      if (job.stage !== "interrupted" && job.stage !== "finalizing") continue;

      const phase: SeparationRetryPhase =
        entry.retryPhase ?? (job.stage === "finalizing" ? "finalization" : "inference");
      if (localHeavyBusy && phase !== "finalization") {
        // 本地 Demucs 正在推論，等待 markControllerSettled 事件而非空轉輪詢
        continue;
      }

      let wakeupAt = Math.max(entry.nextEligibleAt, entry.blockedUntilAt ?? 0);
      if (wakeupAt <= now) {
        const lastMarker = this.wakeupAttemptedMarkerByTask.get(entry.taskId);
        if (lastMarker === entry.nextEligibleAt) {
          // 該任務於此退避時刻已被評估過但因環境條件無法推進，強制拉開至少 MIN_RETRY_WAKEUP_DELAY_MS 或 BLOCKED_RECHECK_DELAY_MS
          const waitFloor =
            entry.waitReason && entry.waitReason !== "backoff"
              ? BLOCKED_RECHECK_DELAY_MS
              : MIN_RETRY_WAKEUP_DELAY_MS;
          wakeupAt = now + waitFloor;
        }
      }
      candidates.push({ entry, wakeupAt });
    }

    if (candidates.length === 0) return;

    const earliest = candidates.reduce((best, cur) =>
      cur.wakeupAt < best.wakeupAt ? cur : best,
    );
    const delayMs = Math.max(0, earliest.wakeupAt - now);

    recordSeparationDiagnostic({
      source: "SeparationJobManager.scheduleRetryWakeup",
      taskId: earliest.entry.taskId,
      songId: this.jobs.get(earliest.entry.taskId)?.songId ?? null,
      retryPhase: earliest.entry.retryPhase ?? null,
      retryWaitReason: earliest.entry.waitReason ?? "backoff",
      retryAttempts: earliest.entry.attempts,
      nextEligibleAt: earliest.wakeupAt,
      retryTimerDelay: delayMs,
      timestamp: now,
    });

    const timerRef = this.retryTimer.setTimeout(() => {
      if (this.disposed || this.retryWakeupTimer !== timerRef) return;
      this.retryWakeupTimer = null;
      const fireNow = this.now();
      for (const { entry, wakeupAt } of candidates) {
        if (wakeupAt <= fireNow) {
          this.wakeupAttemptedMarkerByTask.set(entry.taskId, entry.nextEligibleAt);
        }
      }
      void this.triggerLifecycleRecovery("retry-wakeup").catch(() => undefined);
    }, delayMs);
    this.retryWakeupTimer = timerRef;
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    this.listeners.forEach((listener) => listener());
  }
}

export const sharedSeparationJobManager = new SeparationJobManager();
