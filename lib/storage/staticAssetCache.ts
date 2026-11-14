import type {
  NetworkAssetOrigin,
  NetworkCacheStatus,
  NetworkTransferDecision,
  NetworkTransferEvaluationInput,
} from "../band/networkBudgetGuard";

export const ORT_ASSET_VERSION = "1.29.0";
export const EXTERNAL_ORT_WASM_CDN_URL_DEFAULT =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_ASSET_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`;

export const STATIC_RUNTIME_CACHE_SCHEMA = "v2";
export const getRuntimeCacheName = (version = ORT_ASSET_VERSION): string =>
  `loop-harmonizer-runtime-ort-${version}-${STATIC_RUNTIME_CACHE_SCHEMA}`;
export const STATIC_RUNTIME_CACHE_NAME = getRuntimeCacheName(ORT_ASSET_VERSION);
const ASSET_VERSION_HEADER = "X-Loop-Harmonizer-Asset-Version";

export type StaticAssetNetworkGuardHook = {
  evaluateTransfer: (input: NetworkTransferEvaluationInput) => Pick<NetworkTransferDecision, "allowed" | "message">;
  recordTransfer: (url: string, bytes: number, explicitOrigin?: NetworkAssetOrigin) => void;
  getSnapshot: () => { vercelStaticBytes: number; externalCdnBytes: number };
};

function defaultNormalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return trimmed;
  if (trimmed.startsWith("/")) return trimmed.split("?")[0] ?? trimmed;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return trimmed.split("?")[0] ?? trimmed;
  }
}

const DEFAULT_FALLBACK_GUARD: StaticAssetNetworkGuardHook = {
  evaluateTransfer(input) {
    const url = defaultNormalizeUrl(input.url);
    if (url.startsWith("/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm") || url.includes(".wasm") && url.startsWith("/")) {
      return {
        allowed: false,
        message: "Vercel 靜態資源未快取的 24.6 MiB ORT WASM 超過 10.0 MiB 上限，已拒絕下載（不提供強制繞過）。",
      };
    }
    if (url.startsWith("/vendor/")) {
      return { allowed: true, message: "輕量本機靜態腳本位於 10 MiB 上限內。" };
    }
    if (url === EXTERNAL_ORT_WASM_CDN_URL_DEFAULT) {
      return { allowed: true, message: "外部可信 CDN ORT WASM 已列入外部下載預算。" };
    }
    return {
      allowed: false,
      message: `未經登記或未注入預算守衛之資源請求（${url}），依 fail-closed 原則拒絕。`,
    };
  },
  recordTransfer() {},
  getSnapshot() {
    return { vercelStaticBytes: 0, externalCdnBytes: 0 };
  },
};

let activeNetworkGuardHook: StaticAssetNetworkGuardHook = DEFAULT_FALLBACK_GUARD;

export function configureStaticAssetNetworkGuard(hook: StaticAssetNetworkGuardHook): void {
  activeNetworkGuardHook = hook;
}

export type StaticAssetCacheInspection = {
  status: NetworkCacheStatus;
  isCached: boolean;
  loadedInSessionHint: boolean;
  cacheName: string;
  version: string;
};

const inFlightApprovedDownloads = new Map<string, Promise<boolean>>();
const inFlightWasmBlobLoads = new Map<string, Promise<string>>();
let activeOrtWasmBlobUrl: string | null = null;
let activeOrtWasmBlobVersion: string | null = null;

function isTestOnlyMockCacheHit(response: Response | undefined): boolean {
  if (!response) return false;
  if (typeof response.ok === "boolean" && !response.ok) return false;
  return true;
}

function getHeaderVersion(response: Response): string | null {
  try {
    return response.headers?.get?.(ASSET_VERSION_HEADER) ?? null;
  } catch {
    return null;
  }
}

/**
 * PerformanceResourceTiming 僅能當作「當次工作階段曾載入」的診斷提示，
 * 不可作為檔案仍有效保存於本機離線快取的充分證據。
 */
export function hasResourceTimingSessionHint(assetUrl: string): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return false;
  }
  const normalized = defaultNormalizeUrl(assetUrl);
  try {
    const entries = performance.getEntriesByType("resource");
    return entries.some((entry) => {
      const entryPath = defaultNormalizeUrl(entry.name);
      return entry.name === assetUrl || entryPath === normalized || entry.name.endsWith(normalized);
    });
  } catch {
    return false;
  }
}

async function matchVersionedCache(
  assetUrl: string,
  expectedVersion: string,
): Promise<Response | null> {
  if (typeof caches === "undefined") return null;
  const cacheName = getRuntimeCacheName(expectedVersion);
  try {
    let matched: Response | undefined;
    if (typeof caches.open === "function") {
      const cache = await caches.open(cacheName).catch(() => null);
      if (cache && typeof (cache as Cache).match === "function") {
        matched = await cache.match(assetUrl).catch(() => undefined);
      }
    }
    if (!matched && typeof caches.match === "function") {
      matched = await caches.match(assetUrl).catch(() => undefined);
    }
    if (!isTestOnlyMockCacheHit(matched)) return null;
    const storedVersion = getHeaderVersion(matched!);
    if (storedVersion !== null && storedVersion !== expectedVersion) {
      return null;
    }
    return matched!;
  } catch {
    return null;
  }
}

async function putVersionedCache(
  assetUrl: string,
  response: Response,
  version: string,
): Promise<void> {
  if (typeof caches === "undefined" || typeof caches.open !== "function") return;
  const cacheName = getRuntimeCacheName(version);
  try {
    const cache = await caches.open(cacheName);
    const cloned = response.clone();
    const headers = new Headers(cloned.headers);
    headers.set(ASSET_VERSION_HEADER, version);
    const body = await cloned.arrayBuffer();
    const wrapped = new Response(body, {
      status: 200,
      headers,
    });
    await cache.put(assetUrl, wrapped).catch(() => undefined);
  } catch {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(assetUrl, response.clone()).catch(() => undefined);
    } catch {
      // ignore storage quota errors
    }
  }
}

/**
 * 檢查靜態或執行期資源的本機快取狀態（零網路請求）：
 * 1. CacheStorage 命中且版本一致 -> cache-storage-hit
 * 2. 同源 HTTP Cache (`only-if-cached`) 命中並補寫入 CacheStorage -> http-cache-hit
 * 3. ResourceTiming 僅記錄為 loadedInSessionHint，絕不當作 isCached: true
 * 4. 無法確認者採保守政策 -> uncached / unknown (`isCached: false`)
 */
export async function inspectStaticAssetCacheStatus(
  assetUrl: string,
  options?: { version?: string },
): Promise<StaticAssetCacheInspection> {
  const version = options?.version ?? ORT_ASSET_VERSION;
  const cacheName = getRuntimeCacheName(version);
  const loadedInSessionHint = hasResourceTimingSessionHint(assetUrl);

  if (typeof caches === "undefined") {
    return {
      status: "unknown",
      isCached: false,
      loadedInSessionHint,
      cacheName,
      version,
    };
  }

  const cached = await matchVersionedCache(assetUrl, version);
  if (cached) {
    return {
      status: "cache-storage-hit",
      isCached: true,
      loadedInSessionHint,
      cacheName,
      version,
    };
  }

  if (assetUrl.startsWith("/") && typeof fetch === "function") {
    try {
      const response = await fetch(assetUrl, {
        cache: "only-if-cached",
        mode: "same-origin",
      });
      if (response.ok) {
        const storedVersion = getHeaderVersion(response);
        if (storedVersion === null || storedVersion === version) {
          await putVersionedCache(assetUrl, response, version);
          return {
            status: "http-cache-hit",
            isCached: true,
            loadedInSessionHint,
            cacheName,
            version,
          };
        }
      }
    } catch {
      // TypeError when not in browser HTTP cache (expected under only-if-cached)
    }
  }

  return {
    status: "uncached",
    isCached: false,
    loadedInSessionHint,
    cacheName,
    version,
  };
}

export async function isStaticAssetCached(
  assetUrl: string,
  options?: { version?: string },
): Promise<boolean> {
  const result = await inspectStaticAssetCacheStatus(assetUrl, options);
  return result.isCached;
}

/**
 * 僅在沒有網路請求（CacheStorage 或 HTTP only-if-cached）時同步資源進 CacheStorage；
 * 或在 Network Budget Guard 明確核准且通過 in-flight 去重時才允許發起單次下載。
 * 嚴禁未經准入使用 `cache: "force-cache"`。
 */
export async function ensureStaticAssetCached(
  assetUrl: string,
  options?: { allowApprovedNetworkFetch?: boolean; version?: string; signal?: AbortSignal },
): Promise<boolean> {
  const version = options?.version ?? ORT_ASSET_VERSION;
  const inspection = await inspectStaticAssetCacheStatus(assetUrl, { version });
  if (inspection.isCached) {
    return true;
  }

  if (!options?.allowApprovedNetworkFetch) {
    return false;
  }

  const flightKey = `${version}:${assetUrl}`;
  const existing = inFlightApprovedDownloads.get(flightKey);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const ledger = activeNetworkGuardHook.getSnapshot();
    const decision = activeNetworkGuardHook.evaluateTransfer({
      url: assetUrl,
      isCached: false,
      sessionTransferredBytes: ledger.vercelStaticBytes,
      sessionExternalTransferredBytes: ledger.externalCdnBytes,
    });
    if (!decision.allowed) {
      throw new Error(decision.message);
    }

    if (typeof fetch !== "undefined") {
      const response = await fetch(assetUrl, {
        cache: "default",
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error(`執行期資源下載失敗：HTTP ${response.status}`);
      }

      const buf = await response.clone().arrayBuffer();
      activeNetworkGuardHook.recordTransfer(assetUrl, buf.byteLength);
      await putVersionedCache(
        assetUrl,
        new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
            "Content-Length": String(buf.byteLength),
            [ASSET_VERSION_HEADER]: version,
          },
        }),
        version,
      );
      return true;
    }
    return false;
  })().finally(() => {
    inFlightApprovedDownloads.delete(flightKey);
  });

  inFlightApprovedDownloads.set(flightKey, task);
  return task;
}

export function revokeActiveOrtWasmBlobUrl(): void {
  if (activeOrtWasmBlobUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(activeOrtWasmBlobUrl);
    } catch {
      // ignore
    }
  }
  activeOrtWasmBlobUrl = null;
  activeOrtWasmBlobVersion = null;
}

/**
 * 準備 ONNX Runtime WASM 核心檔（24.6 MiB）：
 * 1. 先檢查同源 `/vendor/onnxruntime-web/...wasm` 的本機 CacheStorage / HTTP Cache（0 網路下載）
 * 2. 再檢查外部 CDN URL 的本機 CacheStorage（0 網路下載）
 * 3. 若皆未快取，先經 Network Budget Guard 核准外部 CDN 配額（不觸碰 10 MiB Vercel 靜態配額），
 *    以單飛下載存入版本化 CacheStorage 並建立 `blob:` URL 交由 Worker 載入，避免雙重下載或對 Vercel 發出大型請求。
 */
export async function prepareApprovedOrtWasmUrl(options?: {
  localStaticWasmUrl?: string;
  externalCdnWasmUrl?: string;
  version?: string;
  signal?: AbortSignal;
}): Promise<{ wasmUrl: string; source: "cache" | "external-cdn"; downloadedBytes: number }> {
  const version = options?.version ?? ORT_ASSET_VERSION;
  const localWasmUrl = options?.localStaticWasmUrl ?? "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm";
  const cdnWasmUrl = options?.externalCdnWasmUrl ?? EXTERNAL_ORT_WASM_CDN_URL_DEFAULT;

  if (options?.signal?.aborted) {
    const abortErr = new Error("載入 WASM 核心檔已取消");
    abortErr.name = "AbortError";
    throw abortErr;
  }

  if (activeOrtWasmBlobUrl && activeOrtWasmBlobVersion === version) {
    return { wasmUrl: activeOrtWasmBlobUrl, source: "cache", downloadedBytes: 0 };
  }

  // 1) 同源本地靜態 HTTP Cache / CacheStorage 零網路檢查
  const localCheck = await inspectStaticAssetCacheStatus(localWasmUrl, { version });
  if (localCheck.isCached) {
    const cachedResp = await matchVersionedCache(localWasmUrl, version);
    if (cachedResp && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      try {
        const blob = await cachedResp.blob();
        if (blob.size > 0) {
          revokeActiveOrtWasmBlobUrl();
          activeOrtWasmBlobUrl = URL.createObjectURL(blob);
          activeOrtWasmBlobVersion = version;
          return { wasmUrl: activeOrtWasmBlobUrl, source: "cache", downloadedBytes: 0 };
        }
      } catch {
        // fallback to local URL if already HTTP-cached
      }
    }
    return { wasmUrl: localWasmUrl, source: "cache", downloadedBytes: 0 };
  }

  // 2) 外部 CDN URL 的本機版本化 CacheStorage 檢查（0 網路下載）
  const cdnCheck = await inspectStaticAssetCacheStatus(cdnWasmUrl, { version });
  if (cdnCheck.isCached) {
    const cachedResp = await matchVersionedCache(cdnWasmUrl, version);
    if (cachedResp && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      try {
        const blob = await cachedResp.blob();
        if (blob.size > 0) {
          revokeActiveOrtWasmBlobUrl();
          activeOrtWasmBlobUrl = URL.createObjectURL(blob);
          activeOrtWasmBlobVersion = version;
          return { wasmUrl: activeOrtWasmBlobUrl, source: "cache", downloadedBytes: 0 };
        }
      } catch {
        // fall through carefully
      }
    }
    return { wasmUrl: cdnWasmUrl, source: "cache", downloadedBytes: 0 };
  }

  // 3) 全新無快取或版本更新：僅透過 Network Budget Guard 核准後從外部 CDN 下載一次並寫入 CacheStorage
  const flightKey = `${version}:${cdnWasmUrl}`;
  let blobPromise = inFlightWasmBlobLoads.get(flightKey);
  if (!blobPromise) {
    blobPromise = (async () => {
      const ledger = activeNetworkGuardHook.getSnapshot();
      const decision = activeNetworkGuardHook.evaluateTransfer({
        url: cdnWasmUrl,
        isCached: false,
        sessionTransferredBytes: ledger.vercelStaticBytes,
        sessionExternalTransferredBytes: ledger.externalCdnBytes,
      });
      if (!decision.allowed) {
        throw new Error(decision.message);
      }

      if (typeof fetch !== "function") {
        throw new Error("目前環境不支援 fetch，無法下載外部 ONNX Runtime WASM 核心檔。");
      }

      const response = await fetch(cdnWasmUrl, {
        cache: "default",
        signal: options?.signal,
      });
      if (!response.ok) {
        throw new Error(`外部 WASM 核心檔下載失敗：HTTP ${response.status}（請檢查網路連線，已停止自動重試）`);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength <= 0) {
        throw new Error("外部 WASM 核心檔內容為空，已中止初始化（不自動重試）。");
      }

      activeNetworkGuardHook.recordTransfer(cdnWasmUrl, buffer.byteLength, "external-cdn");
      await putVersionedCache(
        cdnWasmUrl,
        new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": "application/wasm",
            "Content-Length": String(buffer.byteLength),
            [ASSET_VERSION_HEADER]: version,
          },
        }),
        version,
      );

      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const wasmBlob = new Blob([buffer], { type: "application/wasm" });
        revokeActiveOrtWasmBlobUrl();
        activeOrtWasmBlobUrl = URL.createObjectURL(wasmBlob);
        activeOrtWasmBlobVersion = version;
        return activeOrtWasmBlobUrl;
      }
      return cdnWasmUrl;
    })().finally(() => {
      inFlightWasmBlobLoads.delete(flightKey);
    });
    inFlightWasmBlobLoads.set(flightKey, blobPromise);
  }

  const wasmUrl = await blobPromise;
  return {
    wasmUrl,
    source: "external-cdn",
    downloadedBytes: 25749873,
  };
}

export async function clearStaticRuntimeCache(version?: string): Promise<void> {
  revokeActiveOrtWasmBlobUrl();
  if (typeof caches === "undefined") return;
  if (version) {
    await caches.delete(getRuntimeCacheName(version)).catch(() => false);
    return;
  }
  await caches.delete(STATIC_RUNTIME_CACHE_NAME).catch(() => false);
  if (typeof caches.keys === "function") {
    const keys = await caches.keys().catch(() => [] as string[]);
    await Promise.all(
      keys
        .filter((key) => key.startsWith("loop-harmonizer-runtime-"))
        .map((key) => caches.delete(key).catch(() => false)),
    );
  }
}
