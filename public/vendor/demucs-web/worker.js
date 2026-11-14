import { DemucsProcessor } from "./processor.js";

let currentAbortController = null;
let currentTaskId = null;
let pauseRequested = false;
let activeProcessor = null;
let cachedBackend = null;
let ortModulePromise = null;
const pendingChunkAcks = new Map();

function rejectAllPendingAcks(reason) {
  for (const [, pending] of pendingChunkAcks.entries()) {
    pending.reject(reason);
  }
  pendingChunkAcks.clear();
}

function isAbort(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (typeof error.message === "string" && error.message.includes("取消")) return true;
  return false;
}

async function loadOrt(ortBaseUrl, maxThreads, wasmBinaryUrl) {
  if (!ortModulePromise) {
    ortModulePromise = import(`${ortBaseUrl}ort.webgpu.bundle.min.mjs`).then((mod) => mod.default ?? mod);
  }
  const ort = await ortModulePromise;
  ort.env.wasm.wasmPaths = wasmBinaryUrl
    ? {
        mjs: `${ortBaseUrl}ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: wasmBinaryUrl,
      }
    : ortBaseUrl;
  const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 2) : 2;
  const threadCap = typeof maxThreads === "number" && maxThreads > 0 ? maxThreads : 4;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(threadCap, hw) : 1;
  ort.env.wasm.proxy = false;
  return ort;
}

async function detectBackend(preferWebGpu) {
  if (!preferWebGpu) return "wasm";
  try {
    const gpu = typeof navigator !== "undefined" ? navigator.gpu : undefined;
    if (gpu && typeof gpu.requestAdapter === "function") {
      const adapter = await gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    // Fallback safely to WASM when WebGPU adapter cannot be initialized inside worker.
  }
  return "wasm";
}

async function releaseProcessor() {
  const proc = activeProcessor;
  activeProcessor = null;
  cachedBackend = null;
  if (proc && typeof proc.disposeSession === "function") {
    try {
      await proc.disposeSession();
    } catch {
      // ignore dispose errors
    }
  }
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "dispose") {
    if (currentAbortController) currentAbortController.abort();
    rejectAllPendingAcks(Object.assign(new Error("音源分離已停止"), { name: "AbortError" }));
    await releaseProcessor();
    self.postMessage({ type: "disposed" });
    return;
  }

  if (msg.type === "cancel") {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    rejectAllPendingAcks(Object.assign(new Error("音源分離已取消"), { name: "AbortError" }));
    await releaseProcessor();
    self.postMessage({ type: "cancelled", taskId: msg.taskId ?? null });
    return;
  }

  if (msg.type === "pause") {
    if (!currentTaskId || !msg.taskId || msg.taskId === currentTaskId) {
      pauseRequested = true;
    }
    return;
  }

  if (msg.type === "chunk-ack") {
    const key = `${msg.taskId}:${msg.chunkIndex}`;
    const pending = pendingChunkAcks.get(key);
    if (pending) {
      pendingChunkAcks.delete(key);
      if (msg.ok === false) {
        pending.reject(new Error(msg.errorMessage || `Chunk ${msg.chunkIndex} 保存失敗`));
      } else {
        pending.resolve();
      }
    }
    return;
  }

  if (msg.type !== "run") return;

  const {
    taskId,
    modelUrl,
    ortBaseUrl = "/vendor/onnxruntime-web/",
    wasmBinaryUrl = null,
    mode = "four_stem",
    preferWebGpu = true,
    maxThreads = 4,
    streamChunks = false,
    startChunkIndex = 0,
    inputOffsetSample = 0,
    totalSamples,
    initialOverlapCarryBuffer = null,
    leftBuffer,
    rightBuffer,
  } = msg;

  let left = new Float32Array(leftBuffer);
  let right = new Float32Array(rightBuffer);

  const abortController = new AbortController();
  currentAbortController = abortController;
  currentTaskId = taskId;
  pauseRequested = false;

  const postProgress = (stage, progress, message, backend, details) => {
    if (abortController.signal.aborted) return;
    self.postMessage({
      type: "progress",
      taskId,
      stage,
      progress,
      message,
      backend,
      details,
    });
  };

  try {
    const ort = await loadOrt(ortBaseUrl, maxThreads, wasmBinaryUrl);
    if (abortController.signal.aborted) {
      throw Object.assign(new Error("音源分離已取消"), { name: "AbortError" });
    }

    let backend = await detectBackend(preferWebGpu);
    postProgress("preparing", 0.05, `正在初始化模型（${backend === "webgpu" ? "WebGPU" : "WASM"}）…`, backend);

    const createProcessorWithBackend = (targetBackend) =>
      new DemucsProcessor({
        ort,
        sessionOptions: { executionProviders: [targetBackend] },
        onDownloadProgress: (loaded, total) => {
          const pct = total > 0 ? loaded / total : 0;
          postProgress("downloading", 0.08 + pct * 0.14, "正在載入 AI 分離模型…", targetBackend, {
            downloadLoadedBytes: loaded,
            downloadTotalBytes: total,
          });
        },
        onProgress: ({ progress, currentSegment, totalSegments }) => {
          postProgress(
            "processing",
            0.25 + progress * 0.72,
            `正在分離音源片段（${currentSegment}/${totalSegments}）…`,
            targetBackend,
            { currentSegment, totalSegments },
          );
        },
      });

    if (!activeProcessor || cachedBackend !== backend) {
      await releaseProcessor();
      activeProcessor = createProcessorWithBackend(backend);
      try {
        await activeProcessor.loadModel(modelUrl, { signal: abortController.signal });
        cachedBackend = backend;
      } catch (loadErr) {
        if (isAbort(loadErr) || abortController.signal.aborted) throw loadErr;
        if (backend === "webgpu") {
          await releaseProcessor();
          backend = "wasm";
          postProgress("preparing", 0.06, "Worker WebGPU 載入失敗，安全切換至 WASM…", backend);
          activeProcessor = createProcessorWithBackend("wasm");
          await activeProcessor.loadModel(modelUrl, { signal: abortController.signal });
          cachedBackend = "wasm";
        } else {
          throw loadErr;
        }
      }
    }

    if (abortController.signal.aborted) {
      throw Object.assign(new Error("音源分離已取消"), { name: "AbortError" });
    }

    postProgress("processing", 0.25, `正在執行本機 AI 分離（${backend === "webgpu" ? "WebGPU" : "WASM"}）…`, backend);

    let activeStartChunkIndex = Math.max(0, Math.floor(startChunkIndex));
    let activeCarryBuffer = initialOverlapCarryBuffer;

    const createChunkSender = () => {
      if (!streamChunks) return null;
      return async (chunk) => {
        if (abortController.signal.aborted) {
          throw Object.assign(new Error("音源分離已取消"), { name: "AbortError" });
        }
        const ackKey = `${taskId}:${chunk.chunkIndex}`;
        const ackPromise = new Promise((resolve, reject) => {
          pendingChunkAcks.set(ackKey, { resolve, reject });
        });
        const transferList = [chunk.payloadBuffer];
        if (chunk.overlapCarryBuffer) {
          transferList.push(chunk.overlapCarryBuffer);
        }
        // 更新下一次（若 WebGPU fallback 重試）可銜接的游標，並立刻轉移權限至主執行緒提交 IndexedDB
        activeStartChunkIndex = chunk.chunkIndex + 1;
        activeCarryBuffer = null;
        self.postMessage(
          {
            type: "chunk",
            taskId,
            chunkIndex: chunk.chunkIndex,
            startSample: chunk.startSample,
            endSample: chunk.endSample,
            frameCount: chunk.frameCount,
            totalSegments: chunk.totalSegments,
            payloadBuffer: chunk.payloadBuffer,
            overlapCarryBuffer: chunk.overlapCarryBuffer,
          },
          transferList,
        );
        await ackPromise;
      };
    };

    const runSeparateOptions = () => ({
      signal: abortController.signal,
      mode,
      startChunkIndex: activeStartChunkIndex,
      inputOffsetSample,
      totalSamples,
      initialOverlapCarryBuffer: activeCarryBuffer,
      shouldPause: () => pauseRequested,
      onChunk: createChunkSender(),
    });

    let result;
    try {
      result = await activeProcessor.separate(left, right, runSeparateOptions());
    } catch (sepErr) {
      if (isAbort(sepErr) || abortController.signal.aborted) throw sepErr;
      if (backend === "webgpu") {
        await releaseProcessor();
        backend = "wasm";
        postProgress("preparing", 0.15, "WebGPU 推論異常，安全降級至 WASM 重新處理…", backend);
        activeProcessor = createProcessorWithBackend("wasm");
        await activeProcessor.loadModel(modelUrl, { signal: abortController.signal });
        cachedBackend = "wasm";
        result = await activeProcessor.separate(left, right, runSeparateOptions());
      } else {
        throw sepErr;
      }
    } finally {
      left = null;
      right = null;
      activeCarryBuffer = null;
    }

    // 推論完成或安全暫停後立即釋放 ONNX Session 與 Arena
    await releaseProcessor();

    if (abortController.signal.aborted) {
      result = null;
      throw Object.assign(new Error("音源分離已取消"), { name: "AbortError" });
    }

    if (streamChunks) {
      if (result && result.paused) {
        self.postMessage({
          type: "paused",
          taskId,
          backend,
          nextChunkIndex: result.completedChunks,
          totalSegments: result.totalSegments,
        });
        return;
      }
      self.postMessage({
        type: "completed",
        taskId,
        backend,
        streamed: true,
        totalSegments: result?.totalSegments ?? 0,
      });
      return;
    }

    if (mode === "two_stem" && result && result.instrumental && result.vocals) {
      const transferList = [
        result.vocals.left.buffer,
        result.vocals.right.buffer,
        result.instrumental.left.buffer,
        result.instrumental.right.buffer,
      ];
      self.postMessage(
        {
          type: "completed",
          taskId,
          backend,
          mode: "two_stem",
          twoStem: result,
        },
        transferList,
      );
      return;
    }

    const transferList = [
      result.vocals.left.buffer,
      result.vocals.right.buffer,
      result.drums.left.buffer,
      result.drums.right.buffer,
      result.bass.left.buffer,
      result.bass.right.buffer,
      result.other.left.buffer,
      result.other.right.buffer,
    ];

    self.postMessage(
      {
        type: "completed",
        taskId,
        backend,
        mode: "four_stem",
        fourStem: result,
      },
      transferList,
    );
  } catch (error) {
    left = null;
    right = null;
    rejectAllPendingAcks(error);
    if (isAbort(error) || abortController.signal.aborted) {
      await releaseProcessor();
      self.postMessage({
        type: "cancelled",
        taskId,
      });
    } else {
      await releaseProcessor();
      self.postMessage({
        type: "failed",
        taskId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null;
    }
    if (currentTaskId === taskId) {
      currentTaskId = null;
    }
    pauseRequested = false;
  }
});
