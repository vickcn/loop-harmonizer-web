export type SeparationTaskStage =
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
  | "failed";

export type SeparationProgressEvent = {
  taskId: string;
  songId: string;
  generation: number;
  stage: SeparationTaskStage;
  progress: number;
  message: string;
  backend?: "webgpu" | "wasm";
  details?: {
    currentSegment?: number;
    totalSegments?: number;
    committedBytes?: number;
    checkpointTaskId?: string;
    downloadLoadedBytes?: number;
    downloadTotalBytes?: number;
  };
};

export class SeparationAbortError extends Error {
  readonly isSeparationAbort = true;

  constructor(message = "音源分離已取消") {
    super(message);
    this.name = "AbortError";
  }
}

export class SeparationPauseError extends Error {
  readonly isSeparationPause = true;

  constructor(message = "音源分離已於安全 Chunk 邊界暫停") {
    super(message);
    this.name = "PauseError";
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof SeparationAbortError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if ((error as { isSeparationAbort?: boolean }).isSeparationAbort) return true;
  }
  return false;
}

export function isPauseError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof SeparationPauseError) return true;
  if (error instanceof Error) {
    if (error.name === "PauseError") return true;
    if ((error as { isSeparationPause?: boolean }).isSeparationPause) return true;
  }
  return false;
}

export type CleanupCallback = () => void | Promise<void>;

export type SeparationTaskOptions = {
  songId: string;
  generation: number;
  throttleMs?: number;
  cooldownMs?: number;
  onProgress?: (event: SeparationProgressEvent) => void;
  onSettled?: (stage: SeparationTaskStage) => void;
  isGenerationCurrent?: (songId: string, generation: number) => boolean;
  now?: () => number;
};

const TERMINAL_STAGES = new Set<SeparationTaskStage>([
  "paused",
  "cancelled",
  "completed",
  "failed",
]);

export class SeparationTaskController {
  readonly taskId: string;
  readonly songId: string;
  readonly generation: number;
  readonly signal: AbortSignal;

  private readonly abortController = new AbortController();
  private readonly cleanups: CleanupCallback[] = [];
  private readonly pauseListeners: Array<() => void> = [];
  private readonly throttleMs: number;
  private readonly cooldownMs: number;
  private readonly onProgress?: (event: SeparationProgressEvent) => void;
  private readonly onSettled?: (stage: SeparationTaskStage) => void;
  private readonly isGenerationCurrent?: (songId: string, generation: number) => boolean;
  private readonly now: () => number;

  private stage: SeparationTaskStage = "idle";
  private lastEmitTime = 0;
  private lastEmitStage: SeparationTaskStage = "idle";
  private lastEmitProgress = -1;
  private backend: "webgpu" | "wasm" | undefined;
  private cancelPromise: Promise<void> | null = null;
  private pausePromise: Promise<void> | null = null;
  private pauseRequested = false;
  private settled = false;

  constructor(options: SeparationTaskOptions) {
    this.songId = options.songId;
    this.generation = options.generation;
    this.taskId = `sep_${options.songId}_g${options.generation}`;
    this.signal = this.abortController.signal;
    this.throttleMs = options.throttleMs ?? 180;
    this.cooldownMs = options.cooldownMs ?? 0;
    this.onProgress = options.onProgress;
    this.onSettled = options.onSettled;
    this.isGenerationCurrent = options.isGenerationCurrent;
    this.now = options.now ?? (() => Date.now());
  }

  getStage(): SeparationTaskStage {
    return this.stage;
  }

  isTerminal(): boolean {
    return TERMINAL_STAGES.has(this.stage);
  }

  isCancellingOrCancelled(): boolean {
    return this.stage === "cancelling" || this.stage === "cancelled" || this.signal.aborted;
  }

  isPausingOrPaused(): boolean {
    return this.pauseRequested || this.stage === "pausing" || this.stage === "paused";
  }

  onPauseRequested(listener: () => void): () => void {
    if (this.isPausingOrPaused()) {
      queueMicrotask(() => listener());
      return () => undefined;
    }
    this.pauseListeners.push(listener);
    return () => {
      const idx = this.pauseListeners.indexOf(listener);
      if (idx >= 0) this.pauseListeners.splice(idx, 1);
    };
  }

  /** 確認目前仍為該歌曲的有效世代，避免過期非同步 callback 覆寫 UI。 */
  isCurrent(): boolean {
    if (this.isGenerationCurrent) {
      return this.isGenerationCurrent(this.songId, this.generation);
    }
    return true;
  }

  setBackend(backend: "webgpu" | "wasm"): void {
    this.backend = backend;
  }

  registerCleanup(callback: CleanupCallback): () => void {
    if (this.settled || this.isCancellingOrCancelled()) {
      void Promise.resolve().then(() => callback()).catch(() => undefined);
      return () => undefined;
    }
    this.cleanups.push(callback);
    return () => {
      const idx = this.cleanups.indexOf(callback);
      if (idx >= 0) this.cleanups.splice(idx, 1);
    };
  }

  throwIfAborted(message?: string): void {
    if (this.signal.aborted || this.stage === "cancelling" || this.stage === "cancelled") {
      throw new SeparationAbortError(message);
    }
    if (!this.isCurrent()) {
      throw new SeparationAbortError("任務已被更新的操作取代");
    }
  }

  updateProgress(
    stage: Exclude<
      SeparationTaskStage,
      "idle" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "failed"
    >,
    progress: number,
    message: string,
    details?: SeparationProgressEvent["details"],
  ): void {
    if (
      !this.isCurrent() ||
      this.isTerminal() ||
      this.isCancellingOrCancelled() ||
      this.stage === "pausing"
    ) {
      return;
    }

    const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const currentNow = this.now();
    const stageChanged = stage !== this.lastEmitStage;
    const progressDelta = Math.abs(clamped - this.lastEmitProgress);
    const elapsed = currentNow - this.lastEmitTime;

    this.stage = stage;

    if (!stageChanged && clamped < 0.999 && progressDelta < 0.03 && elapsed < this.throttleMs) {
      return;
    }

    this.lastEmitTime = currentNow;
    this.lastEmitStage = stage;
    this.lastEmitProgress = clamped;

    this.emit(stage, clamped, message, details);
  }

  markCompleted(message = "音源分離完成"): void {
    if (!this.isCurrent() || this.settled || this.isCancellingOrCancelled()) {
      return;
    }
    this.stage = "completed";
    this.settled = true;
    this.emit("completed", 1, message);
    this.onSettled?.("completed");
  }

  markPaused(message = "已於安全 Chunk 邊界暫停，可隨時續跑"): void {
    if (!this.isCurrent() || this.settled || this.isCancellingOrCancelled()) {
      return;
    }
    this.stage = "paused";
    this.settled = true;
    this.emit("paused", this.lastEmitProgress >= 0 ? this.lastEmitProgress : 0, message);
    this.onSettled?.("paused");
  }

  markFailed(message: string): void {
    if (!this.isCurrent() || this.settled || this.stage === "cancelled" || this.stage === "paused") {
      return;
    }
    if (this.stage === "cancelling") {
      return;
    }
    this.stage = "failed";
    this.settled = true;
    this.emit("failed", this.lastEmitProgress >= 0 ? this.lastEmitProgress : 0, message);
    this.onSettled?.("failed");
  }

  /**
   * 要求於下一個安全 Chunk 提交邊界暫停：
   * - 不立即 abort 正在寫入 IndexedDB 的原子交易；
   * - Worker 完成當前 Chunk 並 commit 後，停止並保留 Checkpoint 供後續續跑。
   */
  pause(reason = "已暫停分離，已完成進度已安全保存", overrideCooldownMs?: number): Promise<void> {
    if (this.pausePromise) return this.pausePromise;
    if (
      this.stage === "completed" ||
      this.stage === "failed" ||
      this.stage === "cancelled" ||
      this.stage === "paused" ||
      this.stage === "cancelling"
    ) {
      return Promise.resolve();
    }
    this.pauseRequested = true;
    this.stage = "pausing";
    if (this.isCurrent()) {
      this.emit(
        "pausing",
        this.lastEmitProgress >= 0 ? this.lastEmitProgress : 0,
        "正在等待當前 Chunk 提交完成後暫停…",
      );
    }
    for (const listener of [...this.pauseListeners]) {
      try {
        listener();
      } catch {
        // 忽略單一 listener 例外
      }
    }
    const waitMs = overrideCooldownMs ?? this.cooldownMs;
    this.pausePromise = (async () => {
      // 若任務尚未註冊 worker 或未在推論中，清理並進入 paused
      if (this.cleanups.length === 0) {
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        this.markPaused(reason);
      }
    })();
    return this.pausePromise;
  }

  /**
   * 主動要求中止分離任務：
   * 1. 立即進入 `cancelling` 並封鎖後續進度更新；
   * 2. 觸發 AbortController 訊號以中止下載或推論迴圈；
   * 3. 依 LIFO 執行所有註冊的 Worker / Session / Buffer 清理；
   * 4. 於安全邊界後轉為 `cancelled` 並解除重任務鎖。
   */
  cancel(reason = "使用者已中止音源分離", overrideCooldownMs?: number): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.stage === "completed" || this.stage === "failed" || this.stage === "cancelled") {
      return Promise.resolve();
    }

    this.stage = "cancelling";
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new SeparationAbortError(reason));
    }

    if (this.isCurrent()) {
      this.emit("cancelling", this.lastEmitProgress >= 0 ? this.lastEmitProgress : 0, "正在停止並釋放分離資源…");
    }

    const waitMs = overrideCooldownMs ?? this.cooldownMs;
    this.cancelPromise = (async () => {
      await this.runCleanups();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.stage = "cancelled";
      this.settled = true;
      if (this.isCurrent()) {
        this.emit("cancelled", 0, reason);
      }
      this.onSettled?.("cancelled");
    })();

    return this.cancelPromise;
  }

  async runCleanups(): Promise<void> {
    const callbacks = this.cleanups.splice(0, this.cleanups.length).reverse();
    await Promise.allSettled(
      callbacks.map(async (cb) => {
        await cb();
      }),
    );
  }

  private emit(
    stage: SeparationTaskStage,
    progress: number,
    message: string,
    details?: SeparationProgressEvent["details"],
  ): void {
    this.onProgress?.({
      taskId: this.taskId,
      songId: this.songId,
      generation: this.generation,
      stage,
      progress,
      message,
      backend: this.backend,
      details,
    });
  }
}

export class SeparationTaskCoordinator {
  private generationSeq = 0;
  private songGenerations = new Map<string, number>();
  private activeControllers = new Map<string, SeparationTaskController>();
  private globalBusyTask: SeparationTaskController | null = null;

  getActiveController(songId: string): SeparationTaskController | null {
    return this.activeControllers.get(songId) ?? null;
  }

  getCurrentGeneration(songId: string): number | null {
    return this.songGenerations.get(songId) ?? null;
  }

  isBusyWaitingCleanup(): boolean {
    const stage = this.globalBusyTask?.getStage();
    return Boolean(this.globalBusyTask && (stage === "cancelling" || stage === "pausing"));
  }

  hasRunningHeavyTask(excludeSongId?: string): boolean {
    for (const [songId, controller] of this.activeControllers.entries()) {
      if (songId === excludeSongId) continue;
      if (!controller.isTerminal()) return true;
    }
    if (this.globalBusyTask && !this.globalBusyTask.isTerminal()) {
      if (!excludeSongId || this.globalBusyTask.songId !== excludeSongId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 啟動歌曲分離任務前取得有效 Controller；
   * 若上一個重型分離仍在 `cancelling`/`pausing` 釋放資源，或已有其他歌曲正在執行推論，拒絕立即疊加執行。
   */
  startTask(options: Omit<SeparationTaskOptions, "generation" | "isGenerationCurrent" | "onSettled">): SeparationTaskController {
    const globalStage = this.globalBusyTask?.getStage();
    if (this.globalBusyTask && (globalStage === "cancelling" || globalStage === "pausing")) {
      throw new Error("上一個音源分離任務仍在停止並釋放資源，請稍候片刻再試。");
    }

    const existingForSong = this.activeControllers.get(options.songId);
    if (existingForSong && !existingForSong.isTerminal()) {
      const stage = existingForSong.getStage();
      if (stage === "cancelling" || stage === "pausing") {
        throw new Error("此歌曲仍在停止或暫停分離並提交進度，請稍候片刻再重試。");
      }
      throw new Error("此歌曲已有進行中的音源分離任務。");
    }

    if (this.hasRunningHeavyTask(options.songId)) {
      throw new Error("目前已有另一首歌曲正在執行音源分離，請先等待完成或中止後再試。");
    }

    const nextGeneration = ++this.generationSeq;
    this.songGenerations.set(options.songId, nextGeneration);

    const controller = new SeparationTaskController({
      ...options,
      generation: nextGeneration,
      isGenerationCurrent: (songId, gen) => this.songGenerations.get(songId) === gen,
      onSettled: () => {
        if (this.activeControllers.get(options.songId) === controller) {
          this.activeControllers.delete(options.songId);
        }
        if (this.globalBusyTask === controller) {
          this.globalBusyTask = null;
        }
      },
    });

    this.activeControllers.set(options.songId, controller);
    this.globalBusyTask = controller;
    return controller;
  }

  async pauseTask(songId: string, reason?: string, cooldownMs?: number): Promise<boolean> {
    const controller = this.activeControllers.get(songId) ?? (
      this.globalBusyTask?.songId === songId ? this.globalBusyTask : null
    );
    if (!controller) return false;
    await controller.pause(reason, cooldownMs);
    return true;
  }

  async cancelTask(songId: string, reason?: string, cooldownMs?: number): Promise<boolean> {
    const controller = this.activeControllers.get(songId) ?? (
      this.globalBusyTask?.songId === songId ? this.globalBusyTask : null
    );
    if (!controller) return false;
    await controller.cancel(reason, cooldownMs);
    return true;
  }

  /** 移除歌曲或強制廢止時遞增 generation token，確保舊任務永遠無法寫回。 */
  invalidateSongGeneration(songId: string): number {
    const nextGeneration = ++this.generationSeq;
    this.songGenerations.set(songId, nextGeneration);
    return nextGeneration;
  }
}

export const sharedSeparationCoordinator = new SeparationTaskCoordinator();
