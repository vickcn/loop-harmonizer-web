import { evaluateNetworkTransfer, sharedNetworkBudgetLedger } from "../band/networkBudgetGuard.ts";
import { idbClear, idbGet, idbPut } from "./indexedDb.ts";
import {
  STATIC_RUNTIME_CACHE_NAME,
  clearStaticRuntimeCache,
  configureStaticAssetNetworkGuard,
  ensureStaticAssetCached,
  inspectStaticAssetCacheStatus,
  isStaticAssetCached,
  prepareApprovedOrtWasmUrl,
  revokeActiveOrtWasmBlobUrl,
} from "./staticAssetCache.ts";

configureStaticAssetNetworkGuard({
  evaluateTransfer: evaluateNetworkTransfer,
  recordTransfer: (url, bytes, explicitOrigin) => {
    sharedNetworkBudgetLedger.recordTransfer(url, bytes, explicitOrigin);
  },
  getSnapshot: () => sharedNetworkBudgetLedger.getSnapshot(),
});

export {
  STATIC_RUNTIME_CACHE_NAME,
  clearStaticRuntimeCache,
  configureStaticAssetNetworkGuard,
  ensureStaticAssetCached,
  inspectStaticAssetCacheStatus,
  isStaticAssetCached,
  prepareApprovedOrtWasmUrl,
  revokeActiveOrtWasmBlobUrl,
};

const CACHE_NAME = "loop-harmonizer-models-v1";
const MODEL_META_KEY = "demucs-default";
let activeModelUrl: string | null = null;
let inFlightDownload: Promise<string> | null = null;
let inFlightKey: string | null = null;

export type ModelCacheMetadata = {
  key: string;
  modelId: string;
  modelVersion: string;
  modelHash: string;
  cachedAt: number;
  sizeBytes: number;
  sourceUrl: string;
};

async function computeQuickOrSha256(blob: Blob): Promise<string> {
  // 大型模型分塊摘要或 crypto.subtle（優先避免為 170MB 模型額外配置過度複製）
  if (blob.size <= 32 * 1024 * 1024 && typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  const sampleSize = 64 * 1024;
  const head = new Uint8Array(await blob.slice(0, sampleSize).arrayBuffer());
  const tailStart = Math.max(0, blob.size - sampleSize);
  const tail = new Uint8Array(await blob.slice(tailStart, blob.size).arrayBuffer());
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < head.length; i += 1) {
    h1 = Math.imul(h1 ^ head[i], 0x01000193) >>> 0;
  }
  for (let i = 0; i < tail.length; i += 1) {
    h2 = Math.imul(h2 ^ tail[i], 0x85ebca6b) >>> 0;
  }
  return `len-${blob.size}-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("模型下載已取消");
    error.name = "AbortError";
    throw error;
  }
}

export async function isModelCached(sourceUrl: string, modelVersion: string): Promise<{ cached: boolean; sizeBytes: number | null }> {
  if (typeof caches === "undefined") return { cached: false, sizeBytes: null };
  try {
    const cache = await caches.open(CACHE_NAME);
    const previousMetadata = await idbGet<ModelCacheMetadata>("modelMeta", MODEL_META_KEY).catch(() => null);
    const response = await cache.match(sourceUrl);
    if (!response) return { cached: false, sizeBytes: null };
    const blob = await response.blob();
    if (blob.size <= 0) return { cached: false, sizeBytes: null };
    const valid = Boolean(
      previousMetadata?.modelVersion === modelVersion
      && previousMetadata.sizeBytes === blob.size,
    );
    return { cached: valid, sizeBytes: valid ? blob.size : null };
  } catch {
    return { cached: false, sizeBytes: null };
  }
}

export type PrepareModelUrlOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number, details?: { loadedBytes: number; totalBytes: number }) => void;
};

export async function prepareCachedModelUrl(
  sourceUrl: string,
  modelVersion: string,
  optionsOrCallback?: PrepareModelUrlOptions | ((progress: number) => void),
): Promise<string> {
  const options: PrepareModelUrlOptions =
    typeof optionsOrCallback === "function" ? { onProgress: optionsOrCallback } : (optionsOrCallback ?? {});
  const { signal, onProgress } = options;

  throwIfAborted(signal);

  if (typeof caches === "undefined") {
    const ledger = sharedNetworkBudgetLedger.getSnapshot();
    const decision = evaluateNetworkTransfer({
      url: sourceUrl,
      isCached: false,
      sessionTransferredBytes: ledger.vercelStaticBytes,
      sessionExternalTransferredBytes: ledger.externalCdnBytes,
    });
    if (!decision.allowed) {
      throw new Error(decision.message);
    }
    return sourceUrl;
  }

  const requestKey = `${modelVersion}::${sourceUrl}`;
  if (inFlightDownload && inFlightKey === requestKey) {
    return inFlightDownload;
  }

  inFlightKey = requestKey;
  inFlightDownload = (async () => {
    let cache: Cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      const ledger = sharedNetworkBudgetLedger.getSnapshot();
      const decision = evaluateNetworkTransfer({
        url: sourceUrl,
        isCached: false,
        sessionTransferredBytes: ledger.vercelStaticBytes,
        sessionExternalTransferredBytes: ledger.externalCdnBytes,
      });
      if (!decision.allowed) throw new Error(decision.message);
      return sourceUrl;
    }

    throwIfAborted(signal);
    const previousMetadata = await idbGet<ModelCacheMetadata>("modelMeta", MODEL_META_KEY).catch(() => null);
    const cachedResponse = await cache.match(sourceUrl);
    let blob = cachedResponse ? await cachedResponse.blob() : null;
    let modelHash = blob && blob.size > 0 ? await computeQuickOrSha256(blob) : "";

    const cacheIsValid = Boolean(
      blob
      && blob.size > 0
      && previousMetadata?.modelVersion === modelVersion
      && previousMetadata.sizeBytes === blob.size
      && (previousMetadata.modelHash === modelHash || previousMetadata.modelHash.length > 0),
    );

    if (!cacheIsValid) {
      const ledger = sharedNetworkBudgetLedger.getSnapshot();
      const budgetDecision = evaluateNetworkTransfer({
        url: sourceUrl,
        isCached: false,
        sessionTransferredBytes: ledger.vercelStaticBytes,
        sessionExternalTransferredBytes: ledger.externalCdnBytes,
      });
      if (!budgetDecision.allowed) {
        throw new Error(budgetDecision.message);
      }

      onProgress?.(0);
      await cache.delete(sourceUrl).catch(() => false);
      const downloaded = await fetch(sourceUrl, { signal });
      if (!downloaded.ok) {
        throw new Error(`Demucs 模型下載失敗：HTTP ${downloaded.status}（已停止自動重試）`);
      }

      const expectedSize = Number(downloaded.headers.get("content-length") ?? 0);
      const chunks: BlobPart[] = [];
      let loadedBytes = 0;

      if (downloaded.body) {
        const reader = downloaded.body.getReader();
        try {
          while (true) {
            if (signal?.aborted) {
              try { await reader.cancel(); } catch { /* ignore */ }
              chunks.length = 0;
              throwIfAborted(signal);
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loadedBytes += value.byteLength;
              const pct = expectedSize > 0 ? Math.min(0.99, loadedBytes / expectedSize) : 0.1;
              onProgress?.(pct, { loadedBytes, totalBytes: expectedSize });
            }
          }
        } catch (err) {
          chunks.length = 0;
          throw err;
        }
        blob = new Blob(chunks, {
          type: downloaded.headers.get("content-type") || "application/octet-stream",
        });
        chunks.length = 0;
      } else {
        const buf = await downloaded.arrayBuffer();
        throwIfAborted(signal);
        loadedBytes = buf.byteLength;
        blob = new Blob([buf], {
          type: downloaded.headers.get("content-type") || "application/octet-stream",
        });
      }

      if (!blob || blob.size === 0 || (expectedSize > 0 && blob.size !== expectedSize)) {
        throw new Error("Demucs 模型下載不完整，請重試。");
      }

      throwIfAborted(signal);
      sharedNetworkBudgetLedger.recordTransfer(sourceUrl, blob.size);
      modelHash = await computeQuickOrSha256(blob);

      await cache.put(
        sourceUrl,
        new Response(blob, {
          status: 200,
          headers: {
            "Content-Type": downloaded.headers.get("content-type") || "application/octet-stream",
            "Content-Length": String(blob.size),
          },
        }),
      ).catch(() => undefined);
    }

    if (!blob || blob.size === 0) return sourceUrl;

    throwIfAborted(signal);
    const metadata: ModelCacheMetadata = {
      key: MODEL_META_KEY,
      modelId: "demucs-htdemucs",
      modelVersion,
      modelHash,
      cachedAt: Date.now(),
      sizeBytes: blob.size,
      sourceUrl,
    };
    await idbPut("modelMeta", metadata).catch(() => undefined);

    if (activeModelUrl) {
      URL.revokeObjectURL(activeModelUrl);
    }
    activeModelUrl = URL.createObjectURL(blob);
    onProgress?.(1, { loadedBytes: blob.size, totalBytes: blob.size });
    return activeModelUrl;
  })().finally(() => {
    if (inFlightKey === requestKey) {
      inFlightDownload = null;
      inFlightKey = null;
    }
  });

  return inFlightDownload;
}

export const getModelCacheMetadata = () => idbGet<ModelCacheMetadata>("modelMeta", MODEL_META_KEY);

export function revokeActiveModelObjectUrl(): boolean {
  if (!activeModelUrl) return false;
  URL.revokeObjectURL(activeModelUrl);
  activeModelUrl = null;
  return true;
}

export async function clearModelCache(options?: { includeRuntimeCache?: boolean }): Promise<void> {
  revokeActiveModelObjectUrl();
  if (typeof caches !== "undefined") {
    await caches.delete(CACHE_NAME).catch(() => false);
  }
  await idbClear("modelMeta").catch(() => undefined);
  if (options?.includeRuntimeCache) {
    await clearStaticRuntimeCache();
  }
}
