"use client";

import {
  buildDirectTwoStemSet,
  buildSeparatedStemSet,
  type FourStemPcm,
  type SeparatedStemSet,
  type StemSeparationMode,
  type TwoStemPcm,
} from "./stemTypes.ts";
import {
  ensureStaticAssetCached,
  inspectStaticAssetCacheStatus,
  isModelCached,
  prepareApprovedOrtWasmUrl,
  prepareCachedModelUrl,
  revokeActiveModelObjectUrl,
} from "../storage/modelCache.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../storage/cacheKeys.ts";
import {
  type CheckpointSongReferenceCandidate,
  type SeparationCheckpoint,
  type SeparationLeaseInfo,
  addCheckpointReference,
  buildInitialCheckpoint,
  createCheckpointTaskId,
  createIsolatedRecomputeTaskId,
  deleteCheckpointAndChunks,
  findCompletedCheckpointBySourceAudioHash,
  getCheckpoint,
  isCheckpointSharedOrLeased,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../storage/separationCheckpointStore.ts";
import { commitChunkAndCheckpointAtomically } from "../storage/separationCheckpointStore.ts";
import { DEMUCS_STRIDE_SAMPLES, computeTotalChunks } from "../storage/separationChunkStore.ts";
import {
  DEFAULT_EXTERNAL_CDN_BUDGET_BYTES,
  DEFAULT_NETWORK_BUDGET_BYTES,
  EXTERNAL_ORT_WASM_CDN_URL,
  ORT_RUNTIME_VERSION,
  evaluateNetworkAssetBatch,
  sharedNetworkBudgetLedger,
  type NetworkBatchEvaluation,
} from "../band/networkBudgetGuard.ts";
import { sharedPerfTelemetry } from "../band/resourceGuard.ts";
import {
  DEFAULT_JOB_HEARTBEAT_MS,
  getOrCreateTabId,
  sharedSeparationLeaseManager,
  validateAndPrepareResume,
} from "./separationResumeController.ts";
import { recordSeparationDiagnostic } from "./separationStateRecovery.ts";
import {
  isAbortError,
  isPauseError,
  SeparationAbortError,
  SeparationTaskController,
} from "./separationTaskController.ts";
export { DEMUCS_MODEL_VERSION } from "../storage/cacheKeys.ts";

export const DEFAULT_DEMUCS_MODEL_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
export const DEMUCS_SAMPLE_RATE = 44100;

type SeparationBackend = "webgpu" | "wasm";

type FourStemResult = FourStemPcm;
type TwoStemResult = TwoStemPcm;

interface ProcessorChunkEmission {
  chunkIndex: number;
  startSample: number;
  endSample: number;
  frameCount: number;
  totalSegments: number;
  payloadBuffer: ArrayBuffer;
  overlapCarryBuffer: ArrayBuffer | null;
}

interface ProcessorStreamResult {
  streamed: true;
  paused: boolean;
  completedChunks: number;
  totalSegments: number;
}

type DemucsProcessorLike = {
  session?: { release?: () => Promise<void> | void } | null;
  loadModel: (modelPath: string, options?: { signal?: AbortSignal }) => Promise<void>;
  disposeSession?: () => Promise<void>;
  separate: (
    left: Float32Array,
    right: Float32Array,
    options?: {
      signal?: AbortSignal;
      mode?: StemSeparationMode;
      startChunkIndex?: number;
      inputOffsetSample?: number;
      totalSamples?: number;
      initialOverlapCarryBuffer?: ArrayBuffer | null;
      shouldPause?: () => boolean;
      onChunk?: (chunk: ProcessorChunkEmission) => Promise<void> | void;
    },
  ) => Promise<FourStemResult | TwoStemResult | ProcessorStreamResult>;
  onProgress?: (value: { progress: number; currentSegment: number; totalSegments: number }) => void;
  onDownloadProgress?: (loaded: number, total: number) => void;
};

type OrtRuntime = {
  env: {
    wasm: {
      numThreads: number;
      wasmPaths: string | { mjs?: string; wasm?: string };
    };
  };
};

type DemucsRuntime = {
  CONSTANTS: {
    SAMPLE_RATE: number;
    DEFAULT_MODEL_URL: string;
  };
  DemucsProcessor: new (options: Record<string, unknown>) => DemucsProcessorLike;
};

type Runtime = {
  ort: OrtRuntime;
  demucs: DemucsRuntime;
};

type CachedProcessor = {
  backend: SeparationBackend;
  processor: DemucsProcessorLike;
};

export type ChunkCommittedInfo = {
  checkpoint: SeparationCheckpoint;
  chunkIndex: number;
  totalChunks: number;
};

export type ChunkedSeparationSummary = {
  taskId: string;
  mode: StemSeparationMode;
  sampleRate: number;
  totalSamples: number;
  totalChunks: number;
  committedBytes: number;
  durationSeconds: number;
};

export type StemSeparationOptions = {
  mode: StemSeparationMode;
  controller?: SeparationTaskController;
  songId?: string;
  projectId?: string | null;
  entryId?: string | null;
  sourceAudioHash?: string;
  checkpointTaskId?: string;
  userAuthorized?: boolean;
  forceRecompute?: boolean;
  knownInMemorySongs?: CheckpointSongReferenceCandidate[];
  preferChunkStreaming?: boolean;
  maxThreads?: number;
  preferWorker?: boolean;
  allowMainThreadLargeInference?: boolean;
  onStatus?: (message: string) => void;
  onDownloadProgress?: (progress: number) => void;
  onProgress?: (progress: number, currentSegment: number, totalSegments: number) => void;
  onChunkCommitted?: (info: ChunkCommittedInfo) => void;
};

export type StemSeparationResult = {
  backend: SeparationBackend;
  stems?: SeparatedStemSet;
  chunkedTask?: ChunkedSeparationSummary;
  paused?: boolean;
  checkpoint?: SeparationCheckpoint;
  executionFence?: {
    generation: number;
    ownerJobToken: string;
    ownerTabId: string;
  };
  durationMs: number;
  usedWorker: boolean;
};

function isCheckpointStreamComplete(
  cp: SeparationCheckpoint | null | undefined,
  expectedTotalSamples: number,
): boolean {
  if (!cp || cp.totalChunks <= 0) return false;
  return (
    cp.nextChunkIndex >= cp.totalChunks &&
    cp.committedEndSample >= Math.max(expectedTotalSamples, cp.totalSamples)
  );
}

function isStreamResult(value: unknown): value is ProcessorStreamResult {
  return Boolean(value && typeof value === "object" && (value as ProcessorStreamResult).streamed === true);
}

let runtimePromise: Promise<Runtime> | null = null;
let cachedProcessor: CachedProcessor | null = null;
let activeWorker: Worker | null = null;
let separationInProgress = false;
let disposeWhenIdle = false;

function describeError(error: unknown): Error {
  if (isAbortError(error)) {
    return error instanceof SeparationAbortError ? error : new SeparationAbortError();
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/memory|allocation|out of memory/i.test(message)) {
    return new Error("瀏覽器記憶體不足，請關閉其他分頁或釋放閒置資源後再試。");
  }
  if (/fetch|network|cors|http/i.test(message)) {
    return new Error(`無法下載 Demucs 模型或讀取音訊：${message}`);
  }
  return new Error(`音源分離失敗：${message}`);
}

const LOCAL_ORT_WASM_PATH = "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm";
const LOCAL_LIGHTWEIGHT_SEPARATION_SCRIPTS = [
  "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs",
  "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
  "/vendor/demucs-web/worker.js",
  "/vendor/demucs-web/processor.js",
  "/vendor/demucs-web/fft.js",
  "/vendor/demucs-web/constants.js",
  "/vendor/demucs-web/index.js",
] as const;

export async function preflightSeparationNetworkBudget(options?: {
  budgetBytes?: number;
  vercelStaticBudgetBytes?: number;
  externalCdnBudgetBytes?: number;
}): Promise<NetworkBatchEvaluation> {
  const [modelCacheStatus, localWasmCheck, cdnWasmCheck, ...scriptChecks] = await Promise.all([
    isModelCached(DEFAULT_DEMUCS_MODEL_URL, DEMUCS_MODEL_VERSION),
    inspectStaticAssetCacheStatus(LOCAL_ORT_WASM_PATH, { version: ORT_RUNTIME_VERSION }),
    inspectStaticAssetCacheStatus(EXTERNAL_ORT_WASM_CDN_URL, { version: ORT_RUNTIME_VERSION }),
    ...LOCAL_LIGHTWEIGHT_SEPARATION_SCRIPTS.map((url) =>
      inspectStaticAssetCacheStatus(url, { version: ORT_RUNTIME_VERSION }),
    ),
  ]);

  const ledger = sharedNetworkBudgetLedger.getSnapshot();
  const wasmCached = localWasmCheck.isCached || cdnWasmCheck.isCached;
  const wasmUrlForBatch = localWasmCheck.isCached ? LOCAL_ORT_WASM_PATH : EXTERNAL_ORT_WASM_CDN_URL;
  const wasmCacheStatus = localWasmCheck.isCached
    ? localWasmCheck.status
    : cdnWasmCheck.status;

  return evaluateNetworkAssetBatch({
    assets: [
      ...LOCAL_LIGHTWEIGHT_SEPARATION_SCRIPTS.map((url, idx) => ({
        url,
        isCached: scriptChecks[idx]?.isCached ?? false,
        cacheStatus: scriptChecks[idx]?.status ?? "uncached",
      })),
      {
        url: wasmUrlForBatch,
        isCached: wasmCached,
        cacheStatus: wasmCacheStatus,
      },
      {
        url: DEFAULT_DEMUCS_MODEL_URL,
        isCached: modelCacheStatus.cached,
        cacheStatus: modelCacheStatus.cached ? "cache-storage-hit" : "uncached",
        knownSizeBytes: modelCacheStatus.sizeBytes ?? undefined,
      },
    ],
    vercelStaticBudgetBytes: options?.vercelStaticBudgetBytes ?? options?.budgetBytes ?? DEFAULT_NETWORK_BUDGET_BYTES,
    externalCdnBudgetBytes: options?.externalCdnBudgetBytes ?? DEFAULT_EXTERNAL_CDN_BUDGET_BYTES,
    sessionTransferredBytes: ledger.vercelStaticBytes,
    sessionExternalTransferredBytes: ledger.externalCdnBytes,
  });
}

function syncApprovedStaticScriptsFromHttpCacheOnly(): void {
  // 僅將瀏覽器 HTTP Cache 已存在的輕量靜態模組同步至 CacheStorage（`only-if-cached` 零網路請求），
  // 嚴禁未經准入使用 `force-cache` 發出大型請求，且不觸碰 24.6 MiB 本地靜態 WASM。
  void Promise.all(
    LOCAL_LIGHTWEIGHT_SEPARATION_SCRIPTS.map((url) =>
      ensureStaticAssetCached(url, { allowApprovedNetworkFetch: false, version: ORT_RUNTIME_VERSION }).catch(() => false),
    ),
  );
}

async function loadRuntime(maxThreads?: number, wasmBinaryUrl?: string): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const ortUrl = "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs";
      const demucsUrl = "/vendor/demucs-web/index.js";
      const [ortModule, demucsModule] = await Promise.all([
        import(/* webpackIgnore: true */ ortUrl),
        import(/* webpackIgnore: true */ demucsUrl),
      ]);
      const ort = ortModule as unknown as OrtRuntime;
      const demucs = demucsModule as unknown as DemucsRuntime;
      const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
      const capped = maxThreads && maxThreads > 0 ? Math.min(maxThreads, hw) : Math.min(8, hw);
      ort.env.wasm.numThreads = window.crossOriginIsolated ? Math.max(1, capped) : 1;
      ort.env.wasm.wasmPaths = wasmBinaryUrl
        ? {
            mjs: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
            wasm: wasmBinaryUrl,
          }
        : "/vendor/onnxruntime-web/";
      syncApprovedStaticScriptsFromHttpCacheOnly();
      return { ort, demucs };
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  } else if (wasmBinaryUrl) {
    const rt = await runtimePromise;
    rt.ort.env.wasm.wasmPaths = {
      mjs: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: wasmBinaryUrl,
    };
  }
  return runtimePromise;
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function computeRmsAsync(data: Float32Array, signal?: AbortSignal): Promise<number> {
  if (data.length === 0) return 0;
  const CHUNK_SIZE = 262_144;
  let sumSq = 0;
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) throw new SeparationAbortError();
    const end = Math.min(data.length, offset + CHUNK_SIZE);
    for (let i = offset; i < end; i += 1) {
      const v = data[i];
      sumSq += v * v;
    }
    if (end < data.length) {
      await yieldToMainThread();
    }
  }
  return Math.sqrt(sumSq / data.length);
}

function isTwoStemResult(result: FourStemResult | TwoStemResult): result is TwoStemResult {
  return "instrumental" in result && !("drums" in result);
}

async function validateSeparatedResultAsync(
  result: FourStemResult | TwoStemResult,
  inputRms: number,
  controller: SeparationTaskController,
): Promise<void> {
  const stems = isTwoStemResult(result)
    ? ([
        ["vocals", result.vocals],
        ["instrumental", result.instrumental],
      ] as const)
    : ([
        ["vocals", result.vocals],
        ["drums", result.drums],
        ["bass", result.bass],
        ["other", result.other],
      ] as const);
  const CHUNK_SIZE = 262_144;

  let combinedEnergy = 0;
  for (const [name, stem] of stems) {
    for (const ch of [stem.left, stem.right]) {
      let chSumSq = 0;
      for (let offset = 0; offset < ch.length; offset += CHUNK_SIZE) {
        controller.throwIfAborted();
        const end = Math.min(ch.length, offset + CHUNK_SIZE);
        for (let i = offset; i < end; i += 1) {
          const v = ch[i];
          if (!Number.isFinite(v)) {
            throw new Error(`分離輸出（${name}）包含無效數值 (NaN/Infinity)。`);
          }
          if (Math.abs(v) > 4.0) {
            throw new Error(`分離輸出（${name}）峰值異常 (${Math.abs(v).toFixed(2)})。`);
          }
          chSumSq += v * v;
        }
        if (end < ch.length) {
          await yieldToMainThread();
        }
      }
      combinedEnergy += ch.length > 0 ? chSumSq / ch.length : 0;
    }
  }

  const combinedRms = Math.sqrt(combinedEnergy);
  if (inputRms > 1e-4 && combinedRms < 1e-5) {
    throw new Error("分離輸出幾乎為靜音，推論結果無效。");
  }
}

async function pickBackend(): Promise<SeparationBackend> {
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
    return "wasm";
  }
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter?: () => Promise<unknown> };
  }).gpu;
  if (!gpu?.requestAdapter) return "wasm";
  try {
    return (await gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

async function decodeAudio(
  file: File,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<{ left: Float32Array; right: Float32Array }> {
  if (signal?.aborted) throw new SeparationAbortError();
  if (typeof window === "undefined" || !window.AudioContext) {
    throw new Error("這個瀏覽器不支援 AudioContext，無法執行音源分離。");
  }

  const context = new AudioContext({ sampleRate });
  try {
    const rawBuffer = await file.arrayBuffer();
    if (signal?.aborted) throw new SeparationAbortError();
    const audioBuffer = await context.decodeAudioData(rawBuffer);
    if (signal?.aborted) throw new SeparationAbortError();
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    // 複製為獨立 Float32Array 以便可安全 Transfer 給 Worker 並立即放開 AudioBuffer 參照
    const left = new Float32Array(ch0);
    const right = new Float32Array(ch1);
    return { left, right };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function releaseProcessor(processor: DemucsProcessorLike | null): Promise<void> {
  if (!processor) return;
  if (typeof processor.disposeSession === "function") {
    await processor.disposeSession();
    return;
  }
  if (!processor.session) return;
  const session = processor.session;
  processor.session = null;
  await session.release?.();
}

async function clearCachedProcessor(): Promise<void> {
  const processor = cachedProcessor?.processor ?? null;
  cachedProcessor = null;
  try {
    await releaseProcessor(processor);
  } catch {
    // 清理失敗不阻擋後續 WASM fallback 或重試
  }
}

function terminateActiveWorker(): void {
  if (!activeWorker) return;
  const worker = activeWorker;
  activeWorker = null;
  try {
    worker.terminate();
  } catch {
    // ignore terminate failure
  }
}

async function runSeparationInWorker(params: {
  controller: SeparationTaskController;
  modelUrl: string;
  wasmBinaryUrl: string;
  mode: StemSeparationMode;
  left: Float32Array;
  right: Float32Array;
  preferWebGpu: boolean;
  maxThreads?: number;
  preserveInputsForFallback: boolean;
  streamChunks: boolean;
  checkpointTaskId?: string;
  lease?: SeparationLeaseInfo;
  startChunkIndex?: number;
  inputOffsetSample?: number;
  totalSamples?: number;
  initialOverlapCarryBuffer?: ArrayBuffer | null;
  options: StemSeparationOptions;
}): Promise<{
  backend: SeparationBackend;
  fourStem?: FourStemResult;
  twoStem?: TwoStemResult;
  streamed?: boolean;
  paused?: boolean;
  nextChunkIndex?: number;
  latestCheckpoint?: SeparationCheckpoint;
}> {
  const {
    controller,
    modelUrl,
    wasmBinaryUrl,
    mode,
    preferWebGpu,
    maxThreads,
    preserveInputsForFallback,
    streamChunks,
    checkpointTaskId,
    lease,
    startChunkIndex = 0,
    inputOffsetSample = 0,
    totalSamples,
    initialOverlapCarryBuffer = null,
    options,
  } = params;
  // 僅在明確允許 fallback 到其他路徑時才複製緩衝；預設直接轉移緩衝以降低行動裝置記憶體峰值
  let workerLeft: Float32Array | null = preserveInputsForFallback
    ? new Float32Array(params.left)
    : params.left;
  let workerRight: Float32Array | null = preserveInputsForFallback
    ? new Float32Array(params.right)
    : params.right;

  terminateActiveWorker();
  const worker = new Worker("/vendor/demucs-web/worker.js?v=2", { type: "module" });
  activeWorker = worker;

  return new Promise<{
    backend: SeparationBackend;
    fourStem?: FourStemResult;
    twoStem?: TwoStemResult;
    streamed?: boolean;
    paused?: boolean;
    nextChunkIndex?: number;
    latestCheckpoint?: SeparationCheckpoint;
  }>((resolve, reject) => {
    let settled = false;
    let latestCheckpoint: SeparationCheckpoint | undefined;
    let commitChain: Promise<void> = Promise.resolve();

    const logWorkerExit = (workerExitReason: string, toState: string, note?: string) => {
      recordSeparationDiagnostic({
        source: "runSeparationInWorker",
        taskId: checkpointTaskId ?? controller.taskId,
        songId: latestCheckpoint?.songId ?? null,
        generation: lease?.generation ?? null,
        checkpointStatus: latestCheckpoint?.status ?? null,
        validChunkCount: latestCheckpoint?.nextChunkIndex ?? null,
        totalChunks: latestCheckpoint?.totalChunks ?? null,
        workerExitReason,
        leaseOwner: lease?.ownerTabId ?? null,
        fromState: "running",
        toState,
        note,
      });
    };

    const cleanupWorkerListeners = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
    };

    const unregisterPause = controller.onPauseRequested(() => {
      try {
        worker.postMessage({ type: "pause", taskId: controller.taskId });
      } catch {
        // ignore pause signal failure
      }
    });

    const unregister = controller.registerCleanup(async () => {
      unregisterPause();
      if (!settled) {
        settled = true;
        cleanupWorkerListeners();
        logWorkerExit("cleanup-abort", "cancelled");
        try {
          worker.postMessage({ type: "cancel", taskId: controller.taskId });
        } catch {
          // ignore
        }
        if (activeWorker === worker) {
          terminateActiveWorker();
        } else {
          try { worker.terminate(); } catch { /* ignore */ }
        }
        reject(new SeparationAbortError());
      }
    });

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type: string;
        taskId?: string;
        stage?: "preparing" | "downloading" | "processing";
        progress?: number;
        message?: string;
        backend?: SeparationBackend;
        mode?: StemSeparationMode;
        details?: {
          currentSegment?: number;
          totalSegments?: number;
          committedBytes?: number;
          checkpointTaskId?: string;
          downloadLoadedBytes?: number;
          downloadTotalBytes?: number;
        };
        chunkIndex?: number;
        startSample?: number;
        endSample?: number;
        frameCount?: number;
        totalSegments?: number;
        payloadBuffer?: ArrayBuffer;
        overlapCarryBuffer?: ArrayBuffer | null;
        streamed?: boolean;
        nextChunkIndex?: number;
        fourStem?: FourStemResult;
        twoStem?: TwoStemResult;
        errorMessage?: string;
      } | null;
      if (!data || data.taskId !== controller.taskId) return;
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) {
        if (data.type === "chunk" && typeof data.chunkIndex === "number") {
          try {
            worker.postMessage({
              type: "chunk-ack",
              taskId: controller.taskId,
              chunkIndex: data.chunkIndex,
              ok: false,
              errorMessage: "任務已取消",
            });
          } catch {
            // ignore
          }
        }
        return;
      }

      if (data.type === "progress") {
        if (data.backend) controller.setBackend(data.backend);
        if (data.stage && typeof data.progress === "number" && data.message) {
          controller.updateProgress(data.stage, data.progress, data.message, {
            ...data.details,
            checkpointTaskId,
          });
        }
        if (data.message) options.onStatus?.(data.message);
        if (data.stage === "processing" && data.details?.currentSegment && data.details?.totalSegments) {
          const segProgress = data.details.currentSegment / Math.max(1, data.details.totalSegments);
          options.onProgress?.(segProgress, data.details.currentSegment, data.details.totalSegments);
        }
        return;
      }

      if (data.type === "chunk" && streamChunks && checkpointTaskId) {
        const chunkIndex = data.chunkIndex ?? 0;
        const startSample = data.startSample ?? 0;
        const endSample = data.endSample ?? 0;
        const payloadBuffer = data.payloadBuffer;
        const overlapCarryBuffer = data.overlapCarryBuffer ?? null;
        if (!payloadBuffer) {
          try {
            worker.postMessage({
              type: "chunk-ack",
              taskId: controller.taskId,
              chunkIndex,
              ok: false,
              errorMessage: "Worker 未提供 Chunk payload",
            });
          } catch {
            // ignore
          }
          return;
        }

        commitChain = commitChain.then(async () => {
          if (settled || controller.isCancellingOrCancelled() || !controller.isCurrent()) {
            try {
              worker.postMessage({
                type: "chunk-ack",
                taskId: controller.taskId,
                chunkIndex,
                ok: false,
                errorMessage: "任務已取消",
              });
            } catch {
              // ignore
            }
            return;
          }
          try {
            const commitStartMs =
              typeof performance !== "undefined" ? performance.now() : Date.now();
            const committed = await commitChunkAndCheckpointAtomically({
              taskId: checkpointTaskId,
              chunkIndex,
              startSample,
              endSample,
              payload: payloadBuffer,
              overlapCarryBuffer,
              expectedLease: lease,
            });
            const commitEndMs =
              typeof performance !== "undefined" ? performance.now() : Date.now();
            const commitAckMs = Math.max(0, Math.round(commitEndMs - commitStartMs));
            latestCheckpoint = committed.checkpoint;
            options.onChunkCommitted?.({
              checkpoint: committed.checkpoint,
              chunkIndex,
              totalChunks: committed.checkpoint.totalChunks,
            });
            recordSeparationDiagnostic({
              source: "runSeparationInWorker.chunkCommitAck",
              taskId: checkpointTaskId,
              songId: committed.checkpoint.songId,
              generation: lease?.generation ?? null,
              ownerJobToken: lease?.ownerJobToken ?? null,
              checkpointStatus: committed.checkpoint.status,
              validChunkCount: committed.checkpoint.nextChunkIndex,
              totalChunks: committed.checkpoint.totalChunks,
              lastChunkCommitAt: committed.checkpoint.updatedAt,
              lastCommitAckMs: commitAckMs,
              outcome: "chunk_committed",
            });
            worker.postMessage({
              type: "chunk-ack",
              taskId: controller.taskId,
              chunkIndex,
              ok: true,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              worker.postMessage({
                type: "chunk-ack",
                taskId: controller.taskId,
                chunkIndex,
                ok: false,
                errorMessage: msg,
              });
            } catch {
              // ignore
            }
            throw err;
          }
        });
        commitChain.catch((err) => {
          if (settled) return;
          settled = true;
          unregisterPause();
          unregister();
          cleanupWorkerListeners();
          terminateActiveWorker();
          const msg = err instanceof Error ? err.message : String(err);
          logWorkerExit("chunk-commit-error", "failed", msg);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }

      if (data.type === "paused") {
        void commitChain
          .then(() => {
            if (settled) return;
            settled = true;
            unregisterPause();
            unregister();
            cleanupWorkerListeners();
            terminateActiveWorker();
            syncApprovedStaticScriptsFromHttpCacheOnly();
            logWorkerExit("paused", "paused");
            resolve({
              backend: data.backend ?? "wasm",
              streamed: true,
              paused: true,
              nextChunkIndex: data.nextChunkIndex ?? latestCheckpoint?.nextChunkIndex,
              latestCheckpoint,
            });
          })
          .catch(() => undefined);
        return;
      }

      if (data.type === "completed" && (data.streamed || data.fourStem || data.twoStem)) {
        void commitChain
          .then(() => {
            if (settled) return;
            settled = true;
            unregisterPause();
            unregister();
            cleanupWorkerListeners();
            if (activeWorker === worker) {
              terminateActiveWorker();
            } else {
              try { worker.terminate(); } catch { /* ignore */ }
            }
            syncApprovedStaticScriptsFromHttpCacheOnly();
            logWorkerExit("completed", "completed");
            resolve({
              backend: data.backend ?? "wasm",
              streamed: Boolean(data.streamed),
              fourStem: data.fourStem,
              twoStem: data.twoStem,
              latestCheckpoint,
            });
          })
          .catch(() => undefined);
        return;
      }

      if (data.type === "cancelled") {
        if (settled) return;
        settled = true;
        unregisterPause();
        unregister();
        cleanupWorkerListeners();
        terminateActiveWorker();
        logWorkerExit("cancelled", "cancelled");
        reject(new SeparationAbortError());
        return;
      }

      if (data.type === "failed") {
        if (settled) return;
        settled = true;
        unregisterPause();
        unregister();
        cleanupWorkerListeners();
        terminateActiveWorker();
        logWorkerExit("failed", "failed", data.errorMessage);
        reject(new Error(data.errorMessage || "Worker 分離推論失敗"));
      }
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      unregisterPause();
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      logWorkerExit("onerror", "failed", event.message);
      reject(new Error(event.message || "Worker 執行發生錯誤"));
    };

    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      unregisterPause();
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      logWorkerExit("onmessageerror", "failed");
      reject(new Error("Worker 訊息傳遞異常"));
    };

    if (controller.signal.aborted) {
      settled = true;
      unregisterPause();
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      reject(new SeparationAbortError());
      return;
    }

    if (!workerLeft || !workerRight) {
      settled = true;
      unregisterPause();
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      reject(new Error("音源輸入緩衝區已釋放。"));
      return;
    }

    const leftBuf = workerLeft.buffer as ArrayBuffer;
    const rightBuf = workerRight.buffer as ArrayBuffer;
    workerLeft = null;
    workerRight = null;
    const transferList: Transferable[] = [leftBuf, rightBuf];
    const carryCopy =
      initialOverlapCarryBuffer instanceof ArrayBuffer
        ? initialOverlapCarryBuffer.slice(0)
        : null;
    if (carryCopy) {
      transferList.push(carryCopy);
    }

    worker.postMessage(
      {
        type: "run",
        taskId: controller.taskId,
        modelUrl,
        ortBaseUrl: "/vendor/onnxruntime-web/",
        wasmBinaryUrl,
        mode,
        preferWebGpu,
        maxThreads,
        streamChunks,
        startChunkIndex,
        inputOffsetSample,
        totalSamples,
        initialOverlapCarryBuffer: carryCopy,
        leftBuffer: leftBuf,
        rightBuffer: rightBuf,
      },
      transferList,
    );
  });
}

async function getMainThreadProcessor(
  runtime: Runtime,
  backend: SeparationBackend,
  modelUrl: string,
  controller: SeparationTaskController,
  options: StemSeparationOptions,
): Promise<DemucsProcessorLike> {
  if (cachedProcessor?.backend === backend && cachedProcessor.processor.session) {
    cachedProcessor.processor.onProgress = ({ progress, currentSegment, totalSegments }) => {
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
      controller.updateProgress(
        "processing",
        0.25 + progress * 0.72,
        `正在分離音源片段（${currentSegment}/${totalSegments}）…`,
        { currentSegment, totalSegments },
      );
      options.onProgress?.(progress, currentSegment, totalSegments);
    };
    cachedProcessor.processor.onDownloadProgress = (loaded, total) => {
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
      if (total > 0) options.onDownloadProgress?.(loaded / total);
    };
    return cachedProcessor.processor;
  }

  await clearCachedProcessor();
  const processor = new runtime.demucs.DemucsProcessor({
    ort: runtime.ort,
    sessionOptions: {
      executionProviders: [backend],
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
    onProgress: ({ progress, currentSegment, totalSegments }: {
      progress: number;
      currentSegment: number;
      totalSegments: number;
    }) => {
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
      controller.updateProgress(
        "processing",
        0.25 + progress * 0.72,
        `正在分離音源片段（${currentSegment}/${totalSegments}）…`,
        { currentSegment, totalSegments },
      );
      options.onProgress?.(progress, currentSegment, totalSegments);
    },
    onDownloadProgress: (loaded: number, total: number) => {
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
      if (total > 0) options.onDownloadProgress?.(loaded / total);
    },
  });

  const unregister = controller.registerCleanup(async () => {
    await releaseProcessor(processor);
    if (cachedProcessor?.processor === processor) {
      cachedProcessor = null;
    }
  });

  try {
    await processor.loadModel(modelUrl, { signal: controller.signal });
  } catch (error) {
    unregister();
    await releaseProcessor(processor);
    throw error;
  }
  unregister();
  cachedProcessor = { backend, processor };
  return processor;
}

export async function separateAudio(
  file: File,
  options: StemSeparationOptions,
): Promise<StemSeparationResult> {
  if (separationInProgress) {
    throw new Error("已有音源分離工作正在執行，請等待完成或先中止目前任務。");
  }
  if (!file.type.startsWith("audio/")) {
    throw new Error("請選擇音訊檔案。");
  }

  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const controller =
    options.controller
    ?? new SeparationTaskController({
      songId: options.songId ?? "standalone",
      generation: 1,
    });

  const streamChunks = Boolean(
    (options.preferChunkStreaming ?? Boolean(options.songId && options.sourceAudioHash)) &&
      options.sourceAudioHash,
  );
  const effectiveSongId = options.songId ?? controller.songId;
  let checkpointTaskId = streamChunks
    ? options.checkpointTaskId ??
      createCheckpointTaskId(
        effectiveSongId,
        options.sourceAudioHash!,
        DEMUCS_MODEL_VERSION,
        SEPARATION_PROCESSING_VERSION,
      )
    : undefined;

  separationInProgress = true;
  let decodedLeft: Float32Array | null = null;
  let decodedRight: Float32Array | null = null;
  let activeLease: SeparationLeaseInfo | null = null;
  let leaseReleased = false;
  let streamCompleted = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopLeaseHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const releaseActiveLease = async (
    nextStatus: "completed" | "paused" | "cancelled" | "failed" | "interrupted",
    lastError?: string,
  ) => {
    stopLeaseHeartbeat();
    if (!checkpointTaskId) return;
    let effectiveNextStatus = nextStatus;
    const latestCp = await getCheckpoint(checkpointTaskId).catch(() => null);
    if (streamCompleted || isCheckpointStreamComplete(latestCp, latestCp?.totalSamples ?? 0)) {
      effectiveNextStatus = "completed";
    }
    if (!activeLease || leaseReleased) return;
    leaseReleased = true;
    try {
      await sharedSeparationLeaseManager.releaseLease(
        checkpointTaskId,
        activeLease,
        effectiveNextStatus,
        Date.now(),
        { suppressCompletedBroadcast: true },
      );
      if (effectiveNextStatus !== "completed" && lastError !== undefined) {
        await updateCheckpointStatus(checkpointTaskId, {
          status: effectiveNextStatus,
          lastError,
        });
      }
      recordSeparationDiagnostic({
        source: "stemSeparator.releaseActiveLease",
        taskId: checkpointTaskId,
        songId: effectiveSongId,
        generation: activeLease.generation,
        checkpointStatus: latestCp?.status ?? effectiveNextStatus,
        validChunkCount: latestCp?.nextChunkIndex ?? null,
        totalChunks: latestCp?.totalChunks ?? null,
        leaseOwner: activeLease.ownerTabId,
        fromState: latestCp?.status ?? "running",
        toState: effectiveNextStatus,
        note: lastError,
      });
    } catch {
      // 釋放鎖失敗不覆蓋原始錯誤
    }
  };

  try {
    controller.throwIfAborted();
    controller.updateProgress("preparing", 0.02, "正在檢查資源與傳輸預算…");
    options.onStatus?.("正在檢查資源與傳輸預算…");

    const networkCheck = await preflightSeparationNetworkBudget();
    if (!networkCheck.allowed) {
      throw new Error(networkCheck.message);
    }

    controller.throwIfAborted();
    controller.updateProgress("preparing", 0.05, "正在將音訊解碼為 44.1 kHz 立體聲…");
    options.onStatus?.("正在將音訊解碼為 44.1 kHz 立體聲…");
    sharedPerfTelemetry.beginMainThreadStage("decode-audio");
    const decoded = await decodeAudio(file, DEMUCS_SAMPLE_RATE, controller.signal).finally(() => {
      sharedPerfTelemetry.endMainThreadStage("decode-audio");
    });
    decodedLeft = decoded.left;
    decodedRight = decoded.right;
    const totalSamples = decodedLeft.length;

    let startChunkIndex = 0;
    let initialOverlapCarryBuffer: ArrayBuffer | null = null;
    let sliceStartSample = 0;

    if (streamChunks && checkpointTaskId && options.sourceAudioHash) {
      if (options.forceRecompute) {
        const shareStatus = await isCheckpointSharedOrLeased({
          taskId: checkpointTaskId,
          actingSongId: effectiveSongId,
          knownInMemorySongs: options.knownInMemorySongs,
        });
        const existingForRecompute = shareStatus.exists
          ? await getCheckpoint(checkpointTaskId)
          : null;
        if (
          shareStatus.sharedWithOtherSongs ||
          shareStatus.activeLease ||
          existingForRecompute?.status === "completed"
        ) {
          recordSeparationDiagnostic({
            event: "checkpoint-delete-blocked",
            source: "stemSeparator.forceRecompute",
            taskId: checkpointTaskId,
            songId: effectiveSongId,
            checkpointStatus: existingForRecompute?.status ?? null,
            referenceCount: shareStatus.otherReferenceSongIds.length,
            leaseOwner: existingForRecompute?.lease?.ownerTabId ?? null,
            leaseState: shareStatus.activeLease ? "active" : "none",
            outcome: "isolated_recompute_task",
            note: "isolated forceRecompute into new taskId without destroying existing checkpoint",
          });
          checkpointTaskId = createIsolatedRecomputeTaskId(
            effectiveSongId,
            options.sourceAudioHash,
          );
        } else {
          await deleteCheckpointAndChunks(checkpointTaskId);
        }
      }

      const tabId = getOrCreateTabId();
      let resolvedTaskId = checkpointTaskId;
      let validation = await validateAndPrepareResume(resolvedTaskId, {
        sourceAudioAvailable: true,
        sourceAudioHash: options.sourceAudioHash,
        totalSamples,
        sampleRate: DEMUCS_SAMPLE_RATE,
        viewerTabId: tabId,
      });

      if (!validation.checkpoint && !options.forceRecompute) {
        const completedByHash = await findCompletedCheckpointBySourceAudioHash(
          options.sourceAudioHash,
        );
        if (completedByHash) {
          const hashValidation = await validateAndPrepareResume(completedByHash.taskId, {
            sourceAudioAvailable: true,
            sourceAudioHash: options.sourceAudioHash,
            totalSamples,
            sampleRate: DEMUCS_SAMPLE_RATE,
            viewerTabId: tabId,
          });
          if (hashValidation.action === "already_completed") {
            resolvedTaskId = completedByHash.taskId;
            validation = hashValidation;
          }
        }
      }

      if (validation.action === "already_completed" && !options.forceRecompute && validation.checkpoint) {
        decodedLeft = null;
        decodedRight = null;
        streamCompleted = true;
        await addCheckpointReference({
          taskId: resolvedTaskId,
          songId: effectiveSongId,
          mode: options.mode,
          source: "stemSeparator.alreadyCompleted",
        });
        if (validation.checkpoint.requestedMode !== options.mode) {
          await updateCheckpointStatus(resolvedTaskId, {
            status: "completed",
            requestedMode: options.mode,
          });
        }
        const finalCp = (await getCheckpoint(resolvedTaskId)) ?? validation.checkpoint;
        const durationMs =
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
        recordSeparationDiagnostic({
          source: "stemSeparator.alreadyCompleted",
          taskId: resolvedTaskId,
          songId: effectiveSongId,
          generation: finalCp.finalizationFence?.generation ?? finalCp.lastExecutionGeneration ?? controller.generation,
          ownerJobToken: finalCp.finalizationFence?.ownerJobToken ?? null,
          checkpointStatus: finalCp.status,
          validChunkCount: validation.validChunkCount,
          totalChunks: validation.totalChunks,
          referenceCount: finalCp.referencedBySongIds?.length ?? null,
          workerExitReason: "skipped-already-completed",
          leaseOwner: finalCp.lease?.ownerTabId ?? null,
          fromState: validation.checkpoint.status,
          toState: "finalizing",
        });
        return {
          backend: "wasm",
          chunkedTask: {
            taskId: resolvedTaskId,
            mode: options.mode,
            sampleRate: finalCp.sampleRate,
            totalSamples: finalCp.totalSamples,
            totalChunks: finalCp.totalChunks,
            committedBytes: finalCp.committedBytes,
            durationSeconds: finalCp.totalSamples / finalCp.sampleRate,
          },
          checkpoint: finalCp,
          executionFence: finalCp.finalizationFence
            ? {
                generation: finalCp.finalizationFence.generation,
                ownerJobToken: finalCp.finalizationFence.ownerJobToken,
                ownerTabId: finalCp.finalizationFence.ownerTabId,
              }
            : undefined,
          durationMs,
          usedWorker: false,
        };
      }

      if (!validation.checkpoint || validation.action === "recompute_from_scratch") {
        if (validation.checkpoint) {
          const shareStatus = await isCheckpointSharedOrLeased({
            taskId: checkpointTaskId,
            actingSongId: effectiveSongId,
            knownInMemorySongs: options.knownInMemorySongs,
          });
          if (
            shareStatus.sharedWithOtherSongs ||
            shareStatus.activeLease ||
            validation.checkpoint.status === "completed"
          ) {
            recordSeparationDiagnostic({
              event: "checkpoint-delete-blocked",
              source: "stemSeparator.recomputeFromScratch",
              taskId: checkpointTaskId,
              songId: effectiveSongId,
              checkpointStatus: validation.checkpoint.status,
              referenceCount: shareStatus.otherReferenceSongIds.length,
              leaseState: shareStatus.activeLease ? "active" : "none",
              outcome: "isolated_recompute_task",
            });
            checkpointTaskId = createIsolatedRecomputeTaskId(
              effectiveSongId,
              options.sourceAudioHash,
            );
          } else {
            await deleteCheckpointAndChunks(checkpointTaskId);
          }
        }
        const initCp = buildInitialCheckpoint({
          taskId: checkpointTaskId,
          songId: effectiveSongId,
          sourceAudioHash: options.sourceAudioHash,
          requestedMode: options.mode,
          totalSamples,
          sampleRate: DEMUCS_SAMPLE_RATE,
          userAuthorized: options.userAuthorized ?? true,
          status: "queued",
          projectId: options.projectId ?? null,
          entryId: options.entryId ?? null,
        });
        await saveCheckpoint(initCp);
        recordSeparationDiagnostic({
          event: "shared-checkpoint-reference-added",
          source: "stemSeparator.initCheckpoint",
          taskId: checkpointTaskId,
          songId: effectiveSongId,
          checkpointStatus: initCp.status,
          validChunkCount: 0,
          totalChunks: initCp.totalChunks,
          referenceCount: initCp.referencedBySongIds?.length ?? 1,
          leaseState: "none",
          outcome: "added",
        });
      } else {
        await addCheckpointReference({
          taskId: checkpointTaskId,
          songId: effectiveSongId,
          mode: options.mode,
          source: "stemSeparator.resumeCheckpoint",
        });
        await updateCheckpointStatus(checkpointTaskId, {
          status: "running",
          requestedMode: options.mode,
          userAuthorized: options.userAuthorized ?? true,
          allowDowngradeCompleted: true,
        });
      }

      const leaseResult = await sharedSeparationLeaseManager.acquireLease(
        checkpointTaskId,
        tabId,
      );
      if (!leaseResult.acquired) {
        throw new Error(leaseResult.reason);
      }
      activeLease = leaseResult.lease;
      recordSeparationDiagnostic({
        source: "stemSeparator.acquireLease",
        taskId: checkpointTaskId,
        songId: effectiveSongId,
        generation: activeLease.generation,
        checkpointStatus: leaseResult.checkpoint.status,
        validChunkCount: validation.validChunkCount,
        totalChunks: validation.totalChunks || leaseResult.checkpoint.totalChunks,
        leaseOwner: activeLease.ownerTabId,
        fromState: validation.checkpoint?.status ?? "queued",
        toState: "running",
        note: `resumeFrom=${validation.action === "resume" ? validation.resumeFromChunkIndex : 0}`,
      });

      heartbeatTimer = setInterval(() => {
        if (!checkpointTaskId || !activeLease || controller.isTerminal()) return;
        const currentLease = activeLease;
        void sharedSeparationLeaseManager
          .renewLease(checkpointTaskId, currentLease)
          .then((ok) => {
            if (ok) {
              recordSeparationDiagnostic({
                source: "stemSeparator.heartbeat",
                taskId: checkpointTaskId,
                songId: effectiveSongId,
                generation: currentLease.generation,
                ownerJobToken: currentLease.ownerJobToken,
                lastHeartbeatAt: Date.now(),
                outcome: "lease_renewed",
              });
              return;
            }
            if (!controller.isTerminal() && !controller.isCancellingOrCancelled()) {
              void controller.cancel("其他分頁已接手或執行權已失效，已安全停止分離");
            }
          })
          .catch(() => undefined);
      }, DEFAULT_JOB_HEARTBEAT_MS);

      startChunkIndex =
        validation.action === "resume" ? validation.resumeFromChunkIndex : 0;
      initialOverlapCarryBuffer =
        validation.action === "resume" && !validation.needsOverlapWarmup
          ? (leaseResult.checkpoint.overlapCarryBuffer ?? null)
          : null;
      const warmupChunkOffset =
        validation.action === "resume" && validation.needsOverlapWarmup ? 1 : 0;
      sliceStartSample = Math.max(0, (startChunkIndex - warmupChunkOffset) * DEMUCS_STRIDE_SAMPLES);

      const totalChunks = computeTotalChunks(totalSamples, DEMUCS_STRIDE_SAMPLES);
      if (startChunkIndex > 0) {
        options.onStatus?.(
          `正在驗證 Checkpoint 並從第 ${startChunkIndex + 1} / ${totalChunks} 段接續分離…`,
        );
      }
    }

    let inputRms = 0;
    if (!streamChunks) {
      sharedPerfTelemetry.beginMainThreadStage("compute-input-rms");
      inputRms = Math.max(
        await computeRmsAsync(decodedLeft, controller.signal),
        await computeRmsAsync(decodedRight, controller.signal),
      );
      sharedPerfTelemetry.endMainThreadStage("compute-input-rms");
    }

    controller.throwIfAborted();
    controller.updateProgress("downloading", 0.08, "正在準備或下載 Demucs AI 模型與執行期 WASM…");
    options.onStatus?.("正在準備或下載 Demucs AI 模型與執行期 WASM…");
    const [modelUrl, ortWasmPrep] = await Promise.all([
      prepareCachedModelUrl(DEFAULT_DEMUCS_MODEL_URL, DEMUCS_MODEL_VERSION, {
        signal: controller.signal,
        onProgress: (progress, details) => {
          if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
          controller.updateProgress("downloading", 0.08 + progress * 0.14, "正在下載 Demucs AI 模型…", {
            downloadLoadedBytes: details?.loadedBytes,
            downloadTotalBytes: details?.totalBytes,
          });
          options.onDownloadProgress?.(progress);
        },
      }),
      prepareApprovedOrtWasmUrl({
        version: ORT_RUNTIME_VERSION,
        signal: controller.signal,
      }),
    ]);

    controller.throwIfAborted();
    const canUseWorker = options.preferWorker !== false && typeof Worker !== "undefined";
    const allowMainThread = options.allowMainThreadLargeInference === true;
    const preferredBackend = await pickBackend();

    if (!canUseWorker && !allowMainThread) {
      throw new Error("目前環境不支援背景 Web Worker，預設拒絕在主執行緒進行大型 Demucs 推論，以避免操作介面完全失去反應。");
    }

    const inputLeftForRun =
      sliceStartSample > 0 ? new Float32Array(decodedLeft.subarray(sliceStartSample)) : decodedLeft;
    const inputRightForRun =
      sliceStartSample > 0 ? new Float32Array(decodedRight.subarray(sliceStartSample)) : decodedRight;
    if (sliceStartSample > 0 && !allowMainThread) {
      // 續跑時僅需傳送剩餘切片給 Worker，立刻釋放完整前置已算完的 PCM 參考
      decodedLeft = null;
      decodedRight = null;
    }

    if (canUseWorker) {
      try {
        sharedPerfTelemetry.beginMainThreadStage("worker-transfer-and-inference");
        const workerOutput = await runSeparationInWorker({
          controller,
          modelUrl,
          wasmBinaryUrl: ortWasmPrep.wasmUrl,
          mode: options.mode,
          left: inputLeftForRun,
          right: inputRightForRun,
          preferWebGpu: preferredBackend === "webgpu",
          maxThreads: options.maxThreads,
          preserveInputsForFallback: allowMainThread,
          streamChunks,
          checkpointTaskId,
          lease: activeLease ?? undefined,
          startChunkIndex,
          inputOffsetSample: sliceStartSample,
          totalSamples,
          initialOverlapCarryBuffer,
          options,
        });
        sharedPerfTelemetry.endMainThreadStage("worker-transfer-and-inference");
        if (!allowMainThread) {
          decodedLeft = null;
          decodedRight = null;
        }
        initialOverlapCarryBuffer = null;
        controller.throwIfAborted();

        if (streamChunks && checkpointTaskId) {
          const durationMs =
            (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
          if (workerOutput.paused) {
            await releaseActiveLease("paused");
            const pausedCp = await getCheckpoint(checkpointTaskId);
            controller.markPaused("已於安全 Chunk 邊界暫停，可隨時繼續分離");
            return {
              backend: workerOutput.backend,
              paused: true,
              checkpoint: pausedCp ?? workerOutput.latestCheckpoint,
              durationMs,
              usedWorker: true,
            };
          }

          const finalCp =
            (await getCheckpoint(checkpointTaskId)) ?? workerOutput.latestCheckpoint;
          const totalChunks =
            finalCp?.totalChunks ?? computeTotalChunks(totalSamples, DEMUCS_STRIDE_SAMPLES);
          if (!isCheckpointStreamComplete(finalCp, totalSamples)) {
            const committedChunks = finalCp?.nextChunkIndex ?? 0;
            const errMsg = `分軌分段寫入不完整（已完成 ${committedChunks} / ${totalChunks} 段），請重新整理頁面載入最新運算模組後再試。`;
            await releaseActiveLease("interrupted", errMsg);
            throw new Error(errMsg);
          }

          streamCompleted = true;
          await releaseActiveLease("completed");
          recordSeparationDiagnostic({
            source: "stemSeparator.chunksCompleted",
            taskId: checkpointTaskId,
            songId: effectiveSongId,
            generation: activeLease?.generation ?? controller.generation,
            ownerJobToken: activeLease?.ownerJobToken ?? null,
            checkpointStatus: finalCp?.status ?? "completed",
            validChunkCount: finalCp?.nextChunkIndex ?? totalChunks,
            totalChunks,
            workerExitReason: "completed",
            leaseOwner: activeLease?.ownerTabId ?? null,
            fromState: "running",
            toState: "finalizing",
          });
          return {
            backend: workerOutput.backend,
            chunkedTask: {
              taskId: checkpointTaskId,
              mode: options.mode,
              sampleRate: finalCp?.sampleRate ?? DEMUCS_SAMPLE_RATE,
              totalSamples: finalCp?.totalSamples ?? totalSamples,
              totalChunks,
              committedBytes: finalCp?.committedBytes ?? 0,
              durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
            },
            checkpoint: finalCp,
            executionFence: activeLease
              ? {
                  generation: activeLease.generation,
                  ownerJobToken: activeLease.ownerJobToken,
                  ownerTabId: activeLease.ownerTabId,
                }
              : finalCp?.finalizationFence
                ? {
                    generation: finalCp.finalizationFence.generation,
                    ownerJobToken: finalCp.finalizationFence.ownerJobToken,
                    ownerTabId: finalCp.finalizationFence.ownerTabId,
                  }
                : undefined,
            durationMs,
            usedWorker: true,
          };
        }

        sharedPerfTelemetry.beginMainThreadStage("validate-output");
        const outputToValidate = workerOutput.twoStem ?? workerOutput.fourStem;
        if (!outputToValidate) {
          throw new Error("Worker 未回傳有效的分離音軌資料。");
        }
        await validateSeparatedResultAsync(outputToValidate, inputRms, controller);
        sharedPerfTelemetry.endMainThreadStage("validate-output");
        controller.throwIfAborted();
        const durationMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
        const stems = isTwoStemResult(outputToValidate)
          ? buildDirectTwoStemSet(outputToValidate, DEMUCS_SAMPLE_RATE)
          : buildSeparatedStemSet(outputToValidate, DEMUCS_SAMPLE_RATE, options.mode);
        return {
          backend: workerOutput.backend,
          stems,
          durationMs,
          usedWorker: true,
        };
      } catch (workerError) {
        sharedPerfTelemetry.endMainThreadStage("worker-transfer-and-inference");
        sharedPerfTelemetry.endMainThreadStage("validate-output");
        if (isAbortError(workerError) || controller.isCancellingOrCancelled()) {
          throw workerError;
        }
        if (!allowMainThread) {
          const reason = workerError instanceof Error ? workerError.message : String(workerError);
          throw new Error(`背景 Web Worker 推論無法運作（${reason}），預設拒絕切換至主執行緒執行大型推論以避免畫面卡死。請釋放資源後重試。`);
        }
        controller.updateProgress("preparing", 0.16, "Worker 無法啟動，切換至分段讓出執行模式…");
        options.onStatus?.("Worker 無法啟動，切換至分段讓出執行模式…");
      }
    }

    const runtime = await loadRuntime(options.maxThreads, ortWasmPrep.wasmUrl);
    const backends: SeparationBackend[] = preferredBackend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    let lastError: unknown = null;

    for (const backend of backends) {
      controller.throwIfAborted();
      try {
        controller.setBackend(backend);
        controller.updateProgress(
          "preparing",
          0.2,
          backend === "webgpu" ? "使用 WebGPU 初始化模型…" : "使用 WASM 初始化模型…",
        );
        options.onStatus?.(backend === "webgpu" ? "使用 WebGPU 初始化模型…" : "使用 WASM 初始化模型…");
        const processor = await getMainThreadProcessor(runtime, backend, modelUrl, controller, options);
        controller.throwIfAborted();
        controller.updateProgress("processing", 0.25, `正在以 ${backend === "webgpu" ? "WebGPU" : "WASM"} 分離音源…`);
        options.onStatus?.(`正在以 ${backend === "webgpu" ? "WebGPU" : "WASM"} 分離音源…`);

        if (streamChunks && checkpointTaskId && decodedLeft && decodedRight) {
          const mainThreadTaskId = checkpointTaskId;
          const freshCp = await getCheckpoint(mainThreadTaskId);
          const resumeFrom = freshCp?.nextChunkIndex ?? startChunkIndex;
          const carry =
            resumeFrom > 0 ? (freshCp?.overlapCarryBuffer ?? initialOverlapCarryBuffer) : null;
          const result = await processor.separate(decodedLeft, decodedRight, {
            signal: controller.signal,
            mode: options.mode,
            startChunkIndex: resumeFrom,
            inputOffsetSample: 0,
            totalSamples,
            initialOverlapCarryBuffer: carry,
            shouldPause: () => controller.isPausingOrPaused(),
            onChunk: async (chunk) => {
              const committed = await commitChunkAndCheckpointAtomically({
                taskId: mainThreadTaskId,
                chunkIndex: chunk.chunkIndex,
                startSample: chunk.startSample,
                endSample: chunk.endSample,
                payload: chunk.payloadBuffer,
                overlapCarryBuffer: chunk.overlapCarryBuffer,
                expectedLease: activeLease ?? undefined,
              });
              options.onChunkCommitted?.({
                checkpoint: committed.checkpoint,
                chunkIndex: chunk.chunkIndex,
                totalChunks: committed.checkpoint.totalChunks,
              });
            },
          });
          controller.throwIfAborted();
          const durationMs =
            (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
          if (isStreamResult(result) && result.paused) {
            await releaseActiveLease("paused");
            const pausedCp = await getCheckpoint(checkpointTaskId);
            controller.markPaused("已於安全 Chunk 邊界暫停，可隨時繼續分離");
            return {
              backend,
              paused: true,
              checkpoint: pausedCp ?? undefined,
              durationMs,
              usedWorker: false,
            };
          }
          const finalCp = await getCheckpoint(checkpointTaskId);
          const totalChunks =
            finalCp?.totalChunks ?? computeTotalChunks(totalSamples, DEMUCS_STRIDE_SAMPLES);
          if (!isCheckpointStreamComplete(finalCp, totalSamples)) {
            const committedChunks = finalCp?.nextChunkIndex ?? 0;
            const errMsg = `分軌分段寫入不完整（已完成 ${committedChunks} / ${totalChunks} 段），請重新整理頁面載入最新運算模組後再試。`;
            await releaseActiveLease("interrupted", errMsg);
            throw new Error(errMsg);
          }
          streamCompleted = true;
          await releaseActiveLease("completed");
          return {
            backend,
            chunkedTask: {
              taskId: checkpointTaskId,
              mode: options.mode,
              sampleRate: finalCp?.sampleRate ?? DEMUCS_SAMPLE_RATE,
              totalSamples: finalCp?.totalSamples ?? totalSamples,
              totalChunks,
              committedBytes: finalCp?.committedBytes ?? 0,
              durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
            },
            checkpoint: finalCp ?? undefined,
            executionFence: activeLease
              ? {
                  generation: activeLease.generation,
                  ownerJobToken: activeLease.ownerJobToken,
                  ownerTabId: activeLease.ownerTabId,
                }
              : finalCp?.finalizationFence
                ? {
                    generation: finalCp.finalizationFence.generation,
                    ownerJobToken: finalCp.finalizationFence.ownerJobToken,
                    ownerTabId: finalCp.finalizationFence.ownerTabId,
                  }
                : undefined,
            durationMs,
            usedWorker: false,
          };
        }

        const result = await processor.separate(decodedLeft!, decodedRight!, {
          signal: controller.signal,
          mode: options.mode,
        });
        controller.throwIfAborted();
        if (isStreamResult(result)) {
          throw new Error("非串流呼叫收到非預期之串流結果");
        }
        await validateSeparatedResultAsync(result, inputRms, controller);
        controller.throwIfAborted();
        const durationMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
        const stems = isTwoStemResult(result)
          ? buildDirectTwoStemSet(result, runtime.demucs.CONSTANTS.SAMPLE_RATE)
          : buildSeparatedStemSet(result, runtime.demucs.CONSTANTS.SAMPLE_RATE, options.mode);
        return {
          backend,
          stems,
          durationMs,
          usedWorker: false,
        };
      } catch (error) {
        if (isAbortError(error) || controller.isCancellingOrCancelled()) {
          await clearCachedProcessor();
          throw error;
        }
        lastError = error;
        await clearCachedProcessor();
        if (backend === "webgpu") {
          options.onStatus?.("WebGPU 初始化或推論失敗，改以單次本機 WASM 執行（不重新下載）…");
        }
      }
    }

    throw describeError(lastError);
  } catch (error) {
    if (!streamCompleted) {
      const latestCp = checkpointTaskId ? await getCheckpoint(checkpointTaskId).catch(() => null) : null;
      if (isCheckpointStreamComplete(latestCp, latestCp?.totalSamples ?? 0)) {
        streamCompleted = true;
        await releaseActiveLease("completed");
      } else if (isAbortError(error) || controller.isCancellingOrCancelled()) {
        await releaseActiveLease("cancelled");
      } else if (!isPauseError(error)) {
        const msg = error instanceof Error ? error.message : String(error);
        await releaseActiveLease("failed", msg);
      }
    } else {
      await releaseActiveLease("completed");
    }
    throw describeError(error);
  } finally {
    stopLeaseHeartbeat();
    if (!leaseReleased && checkpointTaskId && activeLease) {
      await releaseActiveLease(
        streamCompleted
          ? "completed"
          : controller.isCancellingOrCancelled()
            ? "cancelled"
            : "interrupted",
      );
    }
    decodedLeft = null;
    decodedRight = null;
    separationInProgress = false;
    terminateActiveWorker();
    if (disposeWhenIdle) {
      disposeWhenIdle = false;
      await clearCachedProcessor();
    }
  }
}

export function isSeparatorWorkerActive(): boolean {
  return activeWorker !== null;
}

export async function disposeStemSeparator(options?: { revokeModelUrl?: boolean }): Promise<void> {
  if (separationInProgress) {
    disposeWhenIdle = true;
    return;
  }
  terminateActiveWorker();
  await clearCachedProcessor();
  if (options?.revokeModelUrl) {
    revokeActiveModelObjectUrl();
  }
}
