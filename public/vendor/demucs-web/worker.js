import { DemucsProcessor } from "./processor.js";

let currentAbortController = null;
let activeProcessor = null;
let cachedBackend = null;
let ortModulePromise = null;

function isAbort(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (typeof error.message === "string" && error.message.includes("取消")) return true;
  return false;
}

async function loadOrt(ortBaseUrl, maxThreads) {
  if (!ortModulePromise) {
    ortModulePromise = import(`${ortBaseUrl}ort.webgpu.bundle.min.mjs`).then((mod) => mod.default ?? mod);
  }
  const ort = await ortModulePromise;
  ort.env.wasm.wasmPaths = ortBaseUrl;
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
    await releaseProcessor();
    self.postMessage({ type: "disposed" });
    return;
  }

  if (msg.type === "cancel") {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    await releaseProcessor();
    self.postMessage({ type: "cancelled", taskId: msg.taskId ?? null });
    return;
  }

  if (msg.type !== "run") return;

  const {
    taskId,
    modelUrl,
    ortBaseUrl = "/vendor/onnxruntime-web/",
    preferWebGpu = true,
    maxThreads = 4,
    leftBuffer,
    rightBuffer,
  } = msg;

  let left = new Float32Array(leftBuffer);
  let right = new Float32Array(rightBuffer);

  const abortController = new AbortController();
  currentAbortController = abortController;

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
    const ort = await loadOrt(ortBaseUrl, maxThreads);
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

    let result;
    try {
      result = await activeProcessor.separate(left, right, { signal: abortController.signal });
    } catch (sepErr) {
      if (isAbort(sepErr) || abortController.signal.aborted) throw sepErr;
      if (backend === "webgpu") {
        await releaseProcessor();
        backend = "wasm";
        postProgress("preparing", 0.15, "WebGPU 推論異常，安全降級至 WASM 重新處理…", backend);
        activeProcessor = createProcessorWithBackend("wasm");
        await activeProcessor.loadModel(modelUrl, { signal: abortController.signal });
        cachedBackend = "wasm";
        result = await activeProcessor.separate(left, right, { signal: abortController.signal });
      } else {
        throw sepErr;
      }
    }

    if (abortController.signal.aborted) {
      result = null;
      throw Object.assign(new Error("音源分離已取消"), { name: "AbortError" });
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

    left = null;
    right = null;

    self.postMessage(
      {
        type: "completed",
        taskId,
        backend,
        fourStem: result,
      },
      transferList,
    );
  } catch (error) {
    left = null;
    right = null;
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
  }
});
