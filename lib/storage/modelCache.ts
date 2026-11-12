import { idbClear, idbGet, idbPut } from "./indexedDb";

const CACHE_NAME = "loop-harmonizer-models-v1";
const MODEL_META_KEY = "demucs-default";
let modelRequest: Promise<string> | null = null;
let activeModelUrl: string | null = null;

export type ModelCacheMetadata = {
  key: string;
  modelId: string;
  modelVersion: string;
  modelHash: string;
  cachedAt: number;
  sizeBytes: number;
  sourceUrl: string;
};

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function prepareCachedModelUrl(
  sourceUrl: string,
  modelVersion: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  if (modelRequest) return modelRequest;
  modelRequest = (async () => {
    if (typeof caches === "undefined") return sourceUrl;
    let cache: Cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      return sourceUrl;
    }
    const previousMetadata = await idbGet<ModelCacheMetadata>("modelMeta", MODEL_META_KEY).catch(() => null);
    let response = await cache.match(sourceUrl);
    let blob = response ? await response.blob() : null;
    let modelHash = blob ? await sha256(blob) : "";
    const cacheIsValid = Boolean(
      blob
      && blob.size > 0
      && previousMetadata?.modelVersion === modelVersion
      && previousMetadata.sizeBytes === blob.size
      && previousMetadata.modelHash === modelHash,
    );
    if (!cacheIsValid) {
      onProgress?.(0);
      await cache.delete(sourceUrl).catch(() => false);
      const downloaded = await fetch(sourceUrl);
      if (!downloaded.ok) throw new Error(`Demucs 模型下載失敗：HTTP ${downloaded.status}`);
      const expectedSize = Number(downloaded.headers.get("content-length") ?? 0);
      response = downloaded.clone();
      blob = await response.blob();
      if (blob.size === 0 || (expectedSize > 0 && blob.size !== expectedSize)) {
        throw new Error("Demucs 模型下載不完整，請重試。");
      }
      modelHash = await sha256(blob);
      await cache.put(sourceUrl, downloaded).catch(() => undefined);
    }
    if (!blob || blob.size === 0) return sourceUrl;
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
    if (activeModelUrl) URL.revokeObjectURL(activeModelUrl);
    activeModelUrl = URL.createObjectURL(blob);
    onProgress?.(1);
    return activeModelUrl;
  })().catch((error) => {
    modelRequest = null;
    throw error;
  });
  return modelRequest;
}

export const getModelCacheMetadata = () => idbGet<ModelCacheMetadata>("modelMeta", MODEL_META_KEY);

export async function clearModelCache(): Promise<void> {
  modelRequest = null;
  if (activeModelUrl) URL.revokeObjectURL(activeModelUrl);
  activeModelUrl = null;
  if (typeof caches !== "undefined") await caches.delete(CACHE_NAME);
  await idbClear("modelMeta").catch(() => undefined);
}
