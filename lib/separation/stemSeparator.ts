"use client";

import { buildSeparatedStemSet, type SeparatedStemSet, type StemSeparationMode } from "./stemTypes";
import {
  isModelCached,
  isStaticAssetCached,
  prepareCachedModelUrl,
  revokeActiveModelObjectUrl,
} from "@/lib/storage/modelCache";
import { DEMUCS_MODEL_VERSION } from "@/lib/storage/cacheKeys";
import {
  DEFAULT_NETWORK_BUDGET_BYTES,
  evaluateNetworkAssetBatch,
  sharedNetworkBudgetLedger,
  type NetworkBatchEvaluation,
} from "@/lib/band/networkBudgetGuard";
import { sharedPerfTelemetry } from "@/lib/band/resourceGuard";
import {
  isAbortError,
  SeparationAbortError,
  SeparationTaskController,
} from "./separationTaskController";
export { DEMUCS_MODEL_VERSION } from "@/lib/storage/cacheKeys";

export const DEFAULT_DEMUCS_MODEL_URL =
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
export const DEMUCS_SAMPLE_RATE = 44100;

type SeparationBackend = "webgpu" | "wasm";

type FourStemResult = {
  vocals: { left: Float32Array; right: Float32Array };
  drums: { left: Float32Array; right: Float32Array };
  bass: { left: Float32Array; right: Float32Array };
  other: { left: Float32Array; right: Float32Array };
};

type DemucsProcessorLike = {
  session?: { release?: () => Promise<void> | void } | null;
  loadModel: (modelPath: string, options?: { signal?: AbortSignal }) => Promise<void>;
  disposeSession?: () => Promise<void>;
  separate: (
    left: Float32Array,
    right: Float32Array,
    options?: { signal?: AbortSignal },
  ) => Promise<FourStemResult>;
  onProgress?: (value: { progress: number; currentSegment: number; totalSegments: number }) => void;
  onDownloadProgress?: (loaded: number, total: number) => void;
};

type OrtRuntime = {
  env: {
    wasm: {
      numThreads: number;
      wasmPaths: string;
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

export type StemSeparationOptions = {
  mode: StemSeparationMode;
  controller?: SeparationTaskController;
  maxThreads?: number;
  preferWorker?: boolean;
  allowMainThreadLargeInference?: boolean;
  onStatus?: (message: string) => void;
  onDownloadProgress?: (progress: number) => void;
  onProgress?: (progress: number, currentSegment: number, totalSegments: number) => void;
};

export type StemSeparationResult = {
  backend: SeparationBackend;
  stems: SeparatedStemSet;
  durationMs: number;
  usedWorker: boolean;
};

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

export async function preflightSeparationNetworkBudget(options?: {
  budgetBytes?: number;
}): Promise<NetworkBatchEvaluation> {
  const [modelCacheStatus, ortWasmCached, ortBundleCached, ortGlueCached] = await Promise.all([
    isModelCached(DEFAULT_DEMUCS_MODEL_URL, DEMUCS_MODEL_VERSION),
    isStaticAssetCached("/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"),
    isStaticAssetCached("/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs"),
    isStaticAssetCached("/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
  ]);

  return evaluateNetworkAssetBatch({
    assets: [
      {
        url: "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs",
        isCached: ortBundleCached,
      },
      {
        url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
        isCached: ortGlueCached,
      },
      {
        url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
        isCached: ortWasmCached,
      },
      {
        url: DEFAULT_DEMUCS_MODEL_URL,
        isCached: modelCacheStatus.cached,
        knownSizeBytes: modelCacheStatus.sizeBytes ?? undefined,
      },
    ],
    budgetBytes: options?.budgetBytes ?? DEFAULT_NETWORK_BUDGET_BYTES,
    sessionTransferredBytes: sharedNetworkBudgetLedger.getSnapshot().totalBytes,
  });
}

async function loadRuntime(maxThreads?: number): Promise<Runtime> {
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
      ort.env.wasm.wasmPaths = "/vendor/onnxruntime-web/";
      return { ort, demucs };
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
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

async function validateSeparatedResultAsync(
  result: FourStemResult,
  inputRms: number,
  controller: SeparationTaskController,
): Promise<void> {
  const stems = [
    ["vocals", result.vocals],
    ["drums", result.drums],
    ["bass", result.bass],
    ["other", result.other],
  ] as const;
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
  left: Float32Array;
  right: Float32Array;
  preferWebGpu: boolean;
  maxThreads?: number;
  preserveInputsForFallback: boolean;
  options: StemSeparationOptions;
}): Promise<{ backend: SeparationBackend; fourStem: FourStemResult }> {
  const { controller, modelUrl, preferWebGpu, maxThreads, preserveInputsForFallback, options } = params;
  // 僅在明確允許 fallback 到其他路徑時才複製緩衝；預設直接轉移緩衝以降低行動裝置記憶體峰值
  const workerLeft = preserveInputsForFallback ? new Float32Array(params.left) : params.left;
  const workerRight = preserveInputsForFallback ? new Float32Array(params.right) : params.right;

  terminateActiveWorker();
  const worker = new Worker("/vendor/demucs-web/worker.js", { type: "module" });
  activeWorker = worker;

  return new Promise<{ backend: SeparationBackend; fourStem: FourStemResult }>((resolve, reject) => {
    let settled = false;

    const cleanupWorkerListeners = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
    };

    const unregister = controller.registerCleanup(async () => {
      if (!settled) {
        settled = true;
        cleanupWorkerListeners();
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
        details?: { currentSegment?: number; totalSegments?: number; downloadLoadedBytes?: number; downloadTotalBytes?: number };
        fourStem?: FourStemResult;
        errorMessage?: string;
      } | null;
      if (!data || data.taskId !== controller.taskId) return;
      if (!controller.isCurrent() || controller.isCancellingOrCancelled()) {
        return;
      }

      if (data.type === "progress") {
        if (data.backend) controller.setBackend(data.backend);
        if (data.stage && typeof data.progress === "number" && data.message) {
          controller.updateProgress(data.stage, data.progress, data.message, data.details);
        }
        if (data.message) options.onStatus?.(data.message);
        if (data.stage === "processing" && data.details?.currentSegment && data.details?.totalSegments) {
          const segProgress = data.details.currentSegment / Math.max(1, data.details.totalSegments);
          options.onProgress?.(segProgress, data.details.currentSegment, data.details.totalSegments);
        }
        return;
      }

      if (data.type === "completed" && data.fourStem) {
        if (settled) return;
        settled = true;
        unregister();
        cleanupWorkerListeners();
        if (activeWorker === worker) {
          terminateActiveWorker();
        } else {
          try { worker.terminate(); } catch { /* ignore */ }
        }
        resolve({
          backend: data.backend ?? "wasm",
          fourStem: data.fourStem,
        });
        return;
      }

      if (data.type === "cancelled") {
        if (settled) return;
        settled = true;
        unregister();
        cleanupWorkerListeners();
        terminateActiveWorker();
        reject(new SeparationAbortError());
        return;
      }

      if (data.type === "failed") {
        if (settled) return;
        settled = true;
        unregister();
        cleanupWorkerListeners();
        terminateActiveWorker();
        reject(new Error(data.errorMessage || "Worker 分離推論失敗"));
      }
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      reject(new Error(event.message || "Worker 執行發生錯誤"));
    };

    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      reject(new Error("Worker 訊息傳遞異常"));
    };

    if (controller.signal.aborted) {
      settled = true;
      unregister();
      cleanupWorkerListeners();
      terminateActiveWorker();
      reject(new SeparationAbortError());
      return;
    }

    worker.postMessage(
      {
        type: "run",
        taskId: controller.taskId,
        modelUrl,
        ortBaseUrl: "/vendor/onnxruntime-web/",
        preferWebGpu,
        maxThreads,
        leftBuffer: workerLeft.buffer,
        rightBuffer: workerRight.buffer,
      },
      [workerLeft.buffer, workerRight.buffer],
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
      songId: "standalone",
      generation: 1,
    });

  separationInProgress = true;
  let decodedLeft: Float32Array | null = null;
  let decodedRight: Float32Array | null = null;

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

    sharedPerfTelemetry.beginMainThreadStage("compute-input-rms");
    const inputRms = Math.max(
      await computeRmsAsync(decodedLeft, controller.signal),
      await computeRmsAsync(decodedRight, controller.signal),
    );
    sharedPerfTelemetry.endMainThreadStage("compute-input-rms");

    controller.throwIfAborted();
    controller.updateProgress("downloading", 0.08, "正在準備或下載 Demucs AI 模型…");
    options.onStatus?.("正在準備或下載 Demucs AI 模型…");
    const modelUrl = await prepareCachedModelUrl(DEFAULT_DEMUCS_MODEL_URL, DEMUCS_MODEL_VERSION, {
      signal: controller.signal,
      onProgress: (progress, details) => {
        if (!controller.isCurrent() || controller.isCancellingOrCancelled()) return;
        controller.updateProgress("downloading", 0.08 + progress * 0.14, "正在下載 Demucs AI 模型…", {
          downloadLoadedBytes: details?.loadedBytes,
          downloadTotalBytes: details?.totalBytes,
        });
        options.onDownloadProgress?.(progress);
      },
    });

    controller.throwIfAborted();
    const canUseWorker = options.preferWorker !== false && typeof Worker !== "undefined";
    const allowMainThread = options.allowMainThreadLargeInference === true;
    const preferredBackend = await pickBackend();

    if (!canUseWorker && !allowMainThread) {
      throw new Error("目前環境不支援背景 Web Worker，預設拒絕在主執行緒進行大型 Demucs 推論，以避免操作介面完全失去反應。");
    }

    if (canUseWorker) {
      try {
        sharedPerfTelemetry.beginMainThreadStage("worker-transfer-and-inference");
        const workerOutput = await runSeparationInWorker({
          controller,
          modelUrl,
          left: decodedLeft,
          right: decodedRight,
          preferWebGpu: preferredBackend === "webgpu",
          maxThreads: options.maxThreads,
          preserveInputsForFallback: allowMainThread,
          options,
        });
        sharedPerfTelemetry.endMainThreadStage("worker-transfer-and-inference");
        if (!allowMainThread) {
          decodedLeft = null;
          decodedRight = null;
        }
        controller.throwIfAborted();
        sharedPerfTelemetry.beginMainThreadStage("validate-output");
        await validateSeparatedResultAsync(workerOutput.fourStem, inputRms, controller);
        sharedPerfTelemetry.endMainThreadStage("validate-output");
        controller.throwIfAborted();
        const durationMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
        return {
          backend: workerOutput.backend,
          stems: buildSeparatedStemSet(workerOutput.fourStem, DEMUCS_SAMPLE_RATE, options.mode),
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

    const runtime = await loadRuntime(options.maxThreads);
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
        const result = await processor.separate(decodedLeft!, decodedRight!, { signal: controller.signal });
        controller.throwIfAborted();
        await validateSeparatedResultAsync(result, inputRms, controller);
        controller.throwIfAborted();
        const durationMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
        return {
          backend,
          stems: buildSeparatedStemSet(result, runtime.demucs.CONSTANTS.SAMPLE_RATE, options.mode),
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
          options.onStatus?.("WebGPU 初始化或推論失敗，正在改用 WASM 重試…");
        }
      }
    }

    throw describeError(lastError);
  } catch (error) {
    throw describeError(error);
  } finally {
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
