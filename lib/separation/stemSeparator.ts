"use client";

import { buildSeparatedStemSet, type SeparatedStemSet, type StemSeparationMode } from "./stemTypes";
import { prepareCachedModelUrl } from "@/lib/storage/modelCache";
import { DEMUCS_MODEL_VERSION } from "@/lib/storage/cacheKeys";
export { DEMUCS_MODEL_VERSION } from "@/lib/storage/cacheKeys";

type SeparationBackend = "webgpu" | "wasm";

type DemucsProcessorLike = {
  session?: { release?: () => Promise<void> | void } | null;
  loadModel: (modelPath: string) => Promise<void>;
  separate: (
    left: Float32Array,
    right: Float32Array,
  ) => Promise<{
    vocals: { left: Float32Array; right: Float32Array };
    drums: { left: Float32Array; right: Float32Array };
    bass: { left: Float32Array; right: Float32Array };
    other: { left: Float32Array; right: Float32Array };
  }>;
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
  onStatus?: (message: string) => void;
  onDownloadProgress?: (progress: number) => void;
  onProgress?: (progress: number, currentSegment: number, totalSegments: number) => void;
};

export type StemSeparationResult = {
  backend: SeparationBackend;
  stems: SeparatedStemSet;
};

let runtimePromise: Promise<Runtime> | null = null;
let cachedProcessor: CachedProcessor | null = null;
let separationInProgress = false;
let disposeWhenIdle = false;

function describeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/memory|allocation|out of memory/i.test(message)) {
    return new Error("瀏覽器記憶體不足，請關閉其他分頁後改用較短的音訊重試。");
  }
  if (/fetch|network|cors|http/i.test(message)) {
    return new Error(`無法下載 Demucs 模型或讀取音訊：${message}`);
  }
  return new Error(`音源分離失敗：${message}`);
}

async function loadRuntime(): Promise<Runtime> {
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
      ort.env.wasm.numThreads = window.crossOriginIsolated
        ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))
        : 1;
      ort.env.wasm.wasmPaths = "/vendor/onnxruntime-web/";
      return { ort, demucs };
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function computeRms(data: Float32Array): number {
  if (data.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / data.length);
}

function validateSeparatedResult(
  result: Awaited<ReturnType<DemucsProcessorLike["separate"]>>,
  inputLeft: Float32Array,
  inputRight: Float32Array,
): void {
  const stems = [
    ["vocals", result.vocals],
    ["drums", result.drums],
    ["bass", result.bass],
    ["other", result.other],
  ] as const;

  let combinedEnergy = 0;
  for (const [name, stem] of stems) {
    for (const ch of [stem.left, stem.right]) {
      let chSumSq = 0;
      for (let i = 0; i < ch.length; i += 1) {
        const v = ch[i];
        if (!Number.isFinite(v)) {
          throw new Error(`分離輸出（${name}）包含無效數值 (NaN/Infinity)。`);
        }
        if (Math.abs(v) > 4.0) {
          throw new Error(`分離輸出（${name}）峰值異常 (${Math.abs(v).toFixed(2)})。`);
        }
        chSumSq += v * v;
      }
      combinedEnergy += ch.length > 0 ? chSumSq / ch.length : 0;
    }
  }

  const inputRms = Math.max(computeRms(inputLeft), computeRms(inputRight));
  const combinedRms = Math.sqrt(combinedEnergy);
  if (inputRms > 1e-4 && combinedRms < 1e-5) {
    throw new Error("分離輸出幾乎為靜音，推論結果無效。");
  }
}

async function pickBackend(): Promise<SeparationBackend> {
  // Android 行動端 WebGPU 驅動差異大且可能有隱性數值問題，預設改用經實測穩定的 WASM 後端
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

async function decodeAudio(file: File, sampleRate: number): Promise<{ left: Float32Array; right: Float32Array }> {
  if (typeof window === "undefined" || !window.AudioContext) {
    throw new Error("這個瀏覽器不支援 AudioContext，無法執行音源分離。");
  }

  const context = new AudioContext({ sampleRate });
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    return { left, right };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function releaseProcessor(processor: DemucsProcessorLike | null): Promise<void> {
  if (!processor?.session) return;
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
    // Failed session cleanup must not prevent a WASM fallback or a later retry.
  }
}

async function getProcessor(
  runtime: Runtime,
  backend: SeparationBackend,
  options: StemSeparationOptions,
): Promise<DemucsProcessorLike> {
  if (cachedProcessor?.backend === backend) {
    cachedProcessor.processor.onProgress = ({ progress, currentSegment, totalSegments }) => {
      options.onProgress?.(progress, currentSegment, totalSegments);
    };
    cachedProcessor.processor.onDownloadProgress = (loaded, total) => {
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
    }) => options.onProgress?.(progress, currentSegment, totalSegments),
    onDownloadProgress: (loaded: number, total: number) => {
      if (total > 0) options.onDownloadProgress?.(loaded / total);
    },
  });

  options.onStatus?.("正在下載並載入 Demucs 模型…");
  try {
    const modelUrl = await prepareCachedModelUrl(
      runtime.demucs.CONSTANTS.DEFAULT_MODEL_URL,
      DEMUCS_MODEL_VERSION,
      (progress) => options.onDownloadProgress?.(progress),
    );
    await processor.loadModel(modelUrl);
  } catch (error) {
    await releaseProcessor(processor);
    throw error;
  }
  cachedProcessor = { backend, processor };
  return processor;
}

export async function separateAudio(
  file: File,
  options: StemSeparationOptions,
): Promise<StemSeparationResult> {
  if (separationInProgress) {
    throw new Error("已有音源分離工作正在執行，請等待它完成。");
  }
  if (!file.type.startsWith("audio/")) {
    throw new Error("請選擇音訊檔案。");
  }

  separationInProgress = true;
  try {
    const runtime = await loadRuntime();
    options.onStatus?.("正在將音訊轉換為 44.1 kHz 立體聲…");
    const decoded = await decodeAudio(file, runtime.demucs.CONSTANTS.SAMPLE_RATE);
    const preferredBackend = await pickBackend();
    const backends: SeparationBackend[] = preferredBackend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    let lastError: unknown = null;

    for (const backend of backends) {
      try {
        options.onStatus?.(backend === "webgpu" ? "使用 WebGPU 初始化模型…" : "使用 WASM 初始化模型…");
        const processor = await getProcessor(runtime, backend, options);
        options.onStatus?.(`正在以 ${backend === "webgpu" ? "WebGPU" : "WASM"} 分離音源…`);
        const result = await processor.separate(decoded.left, decoded.right);
        validateSeparatedResult(result, decoded.left, decoded.right);
        options.onStatus?.("音源分離完成。");
        return {
          backend,
          stems: buildSeparatedStemSet(result, runtime.demucs.CONSTANTS.SAMPLE_RATE, options.mode),
        };
      } catch (error) {
        lastError = error;
        await clearCachedProcessor();
        if (backend === "webgpu") {
          options.onStatus?.("WebGPU 初始化或推論失敗，正在改用 WASM 重試…");
        }
      }
    }

    throw describeError(lastError);
  } finally {
    separationInProgress = false;
    if (disposeWhenIdle) {
      disposeWhenIdle = false;
      await clearCachedProcessor();
    }
  }
}

export async function disposeStemSeparator(): Promise<void> {
  if (separationInProgress) {
    disposeWhenIdle = true;
    return;
  }
  await clearCachedProcessor();
}
