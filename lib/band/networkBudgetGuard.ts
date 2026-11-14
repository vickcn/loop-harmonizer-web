export const DEFAULT_NETWORK_BUDGET_BYTES = 10 * 1024 * 1024; // 10 MiB（Vercel 靜態資源統一下載硬上限）
export const DEFAULT_VERCEL_STATIC_BUDGET_BYTES = DEFAULT_NETWORK_BUDGET_BYTES;
export const DEFAULT_EXTERNAL_CDN_BUDGET_BYTES = 220 * 1024 * 1024; // 220 MiB（外部可信 CDN：Demucs 172 MiB + ORT WASM 24.6 MiB）

export const ORT_RUNTIME_VERSION = "1.29.0";
export const EXTERNAL_ORT_WASM_CDN_URL =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_RUNTIME_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`;

let configuredExternalCdnBudgetBytes = DEFAULT_EXTERNAL_CDN_BUDGET_BYTES;

export function getExternalCdnBudgetBytes(): number {
  return configuredExternalCdnBudgetBytes;
}

export function setExternalCdnBudgetBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 1) {
    configuredExternalCdnBudgetBytes = DEFAULT_EXTERNAL_CDN_BUDGET_BYTES;
    return configuredExternalCdnBudgetBytes;
  }
  configuredExternalCdnBudgetBytes = Math.round(bytes);
  return configuredExternalCdnBudgetBytes;
}

export type NetworkAssetOrigin = "vercel-static" | "external-cdn" | "local-cache" | "unknown";
export type NetworkCacheStatus = "cache-storage-hit" | "http-cache-hit" | "uncached" | "unknown";

export type KnownNetworkAssetEntry = {
  id: string;
  label: string;
  matchPathOrUrl: string;
  origin: Exclude<NetworkAssetOrigin, "local-cache" | "unknown">;
  sizeBytes: number;
  sizeSource: "exact-static-file" | "estimated-upstream";
  version?: string;
};

export const KNOWN_NETWORK_ASSETS: readonly KnownNetworkAssetEntry[] = [
  {
    id: "ort-wasm-threaded-asyncify",
    label: "ONNX Runtime WASM 核心檔（ort-wasm-simd-threaded.asyncify.wasm）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
    origin: "vercel-static",
    sizeBytes: 25749873,
    sizeSource: "exact-static-file",
    version: ORT_RUNTIME_VERSION,
  },
  {
    id: "ort-wasm-threaded-asyncify-external-cdn",
    label: "ONNX Runtime WASM 核心檔（外部可信 jsDelivr CDN）",
    matchPathOrUrl: EXTERNAL_ORT_WASM_CDN_URL,
    origin: "external-cdn",
    sizeBytes: 25749873,
    sizeSource: "estimated-upstream",
    version: ORT_RUNTIME_VERSION,
  },
  {
    id: "ort-webgpu-bundle",
    label: "ONNX Runtime WebGPU 模組（ort.webgpu.bundle.min.mjs）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs",
    origin: "vercel-static",
    sizeBytes: 116102,
    sizeSource: "exact-static-file",
    version: ORT_RUNTIME_VERSION,
  },
  {
    id: "ort-wasm-glue",
    label: "ONNX Runtime WASM 載入器（ort-wasm-simd-threaded.asyncify.mjs）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
    origin: "vercel-static",
    sizeBytes: 51407,
    sizeSource: "exact-static-file",
    version: ORT_RUNTIME_VERSION,
  },
  {
    id: "soundtouch-js",
    label: "SoundTouch 變速變調模組（soundtouch.js）",
    matchPathOrUrl: "/vendor/soundtouch.js",
    origin: "vercel-static",
    sizeBytes: 26324,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-processor",
    label: "Demucs 分離處理器（processor.js）",
    matchPathOrUrl: "/vendor/demucs-web/processor.js",
    origin: "vercel-static",
    sizeBytes: 16482,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-fft",
    label: "Demucs STFT/iSTFT 模組（fft.js）",
    matchPathOrUrl: "/vendor/demucs-web/fft.js",
    origin: "vercel-static",
    sizeBytes: 6313,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-constants",
    label: "Demucs 參數設定（constants.js）",
    matchPathOrUrl: "/vendor/demucs-web/constants.js",
    origin: "vercel-static",
    sizeBytes: 426,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-index",
    label: "Demucs 模組進入點（index.js）",
    matchPathOrUrl: "/vendor/demucs-web/index.js",
    origin: "vercel-static",
    sizeBytes: 318,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-worker",
    label: "Demucs 背景 Worker（worker.js）",
    matchPathOrUrl: "/vendor/demucs-web/worker.js",
    origin: "vercel-static",
    sizeBytes: 8062,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-htdemucs-onnx",
    label: "Demucs AI 分離模型權重（htdemucs_embedded.onnx）",
    matchPathOrUrl: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx",
    origin: "external-cdn",
    sizeBytes: 172 * 1024 * 1024,
    sizeSource: "estimated-upstream",
    version: "browser-demucs-v1",
  },
];

export type NetworkTransferEvaluationInput = {
  url: string;
  isCached?: boolean;
  cacheStatus?: NetworkCacheStatus;
  knownSizeBytes?: number | null;
  budgetBytes?: number;
  externalCdnBudgetBytes?: number;
  sessionTransferredBytes?: number;
  sessionExternalTransferredBytes?: number;
};

export type NetworkTransferDecision = {
  allowed: boolean;
  fromCache: boolean;
  cacheStatus: NetworkCacheStatus;
  failClosed: boolean;
  hardBlocked: boolean;
  requiresExternalDownloadConfirmation: boolean;
  origin: NetworkAssetOrigin;
  assetLabel: string;
  estimatedTransferBytes: number;
  projectedSessionBytes: number;
  budgetBytes: number;
  sizeSource: "cached" | "exact-static-file" | "estimated-upstream" | "caller-supplied" | "unknown";
  reason: "cached" | "within-budget" | "exceeds-budget" | "exceeds-external-cdn-budget" | "unknown-asset-or-size" | "server-compute-prohibited";
  message: string;
};

export type NetworkAssetBatchItem = {
  url: string;
  isCached?: boolean;
  cacheStatus?: NetworkCacheStatus;
  knownSizeBytes?: number | null;
};

export type NetworkBatchEvaluation = {
  allowed: boolean;
  failClosed: boolean;
  hardBlocked: boolean;
  requiresExternalDownloadConfirmation: boolean;
  totalEstimatedTransferBytes: number;
  vercelStaticBytes: number;
  externalCdnBytes: number;
  cachedHitCount: number;
  uncachedCount: number;
  budgetBytes: number;
  vercelStaticBudgetBytes: number;
  externalCdnBudgetBytes: number;
  items: NetworkTransferDecision[];
  blockingReason: "unknown-asset-or-size" | "exceeds-budget" | "exceeds-external-cdn-budget" | "server-compute-prohibited" | null;
  message: string;
};

export function normalizeAssetUrlPath(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return trimmed;
  if (trimmed.startsWith("/")) return trimmed.split("?")[0] ?? trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return trimmed;
  } catch {
    return trimmed.split("?")[0] ?? trimmed;
  }
}

export function resolveKnownNetworkAsset(rawUrl: string): KnownNetworkAssetEntry | null {
  const normalized = normalizeAssetUrlPath(rawUrl);
  if (!normalized) return null;

  for (const entry of KNOWN_NETWORK_ASSETS) {
    if (normalized === entry.matchPathOrUrl) return entry;
    if (entry.matchPathOrUrl.startsWith("/") && normalized.endsWith(entry.matchPathOrUrl)) {
      return entry;
    }
  }
  return null;
}

export function classifyUrlOrigin(rawUrl: string, baseOrigin?: string): NetworkAssetOrigin {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return "local-cache";
  const known = resolveKnownNetworkAsset(trimmed);
  if (known) return known.origin;

  if (trimmed.startsWith("/")) return "vercel-static";
  try {
    const parsed = new URL(trimmed);
    if (baseOrigin && parsed.origin === baseOrigin) {
      return "vercel-static";
    }
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return "external-cdn";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function evaluateNetworkTransfer(
  input: NetworkTransferEvaluationInput,
): NetworkTransferDecision {
  const vercelBudgetBytes = Math.min(
    DEFAULT_VERCEL_STATIC_BUDGET_BYTES,
    Math.max(1, input.budgetBytes ?? DEFAULT_VERCEL_STATIC_BUDGET_BYTES),
  );
  const externalBudgetBytes = Math.max(
    1,
    input.externalCdnBudgetBytes ?? input.budgetBytes ?? configuredExternalCdnBudgetBytes,
  );
  const priorVercelBytes = Math.max(0, input.sessionTransferredBytes ?? 0);
  const priorExternalBytes = Math.max(0, input.sessionExternalTransferredBytes ?? 0);
  const normalized = normalizeAssetUrlPath(input.url);

  if (normalized.startsWith("/api/") || normalized.includes("/api/")) {
    return {
      allowed: false,
      fromCache: false,
      cacheStatus: "uncached",
      failClosed: true,
      hardBlocked: true,
      requiresExternalDownloadConfirmation: false,
      origin: "unknown",
      assetLabel: normalized || "後端 API",
      estimatedTransferBytes: 0,
      projectedSessionBytes: priorVercelBytes,
      budgetBytes: vercelBudgetBytes,
      sizeSource: "unknown",
      reason: "server-compute-prohibited",
      message: "禁止使用 Vercel Functions 或後端 Worker 代替本機音訊與 AI 運算。",
    };
  }

  if (normalized.startsWith("blob:") || normalized.startsWith("data:") || input.isCached) {
    const resolvedCacheStatus: NetworkCacheStatus =
      input.cacheStatus && (input.cacheStatus === "cache-storage-hit" || input.cacheStatus === "http-cache-hit")
        ? input.cacheStatus
        : "cache-storage-hit";
    return {
      allowed: true,
      fromCache: true,
      cacheStatus: resolvedCacheStatus,
      failClosed: false,
      hardBlocked: false,
      requiresExternalDownloadConfirmation: false,
      origin: "local-cache",
      assetLabel: resolveKnownNetworkAsset(input.url)?.label ?? normalized,
      estimatedTransferBytes: 0,
      projectedSessionBytes: priorVercelBytes,
      budgetBytes: vercelBudgetBytes,
      sizeSource: "cached",
      reason: "cached",
      message:
        resolvedCacheStatus === "http-cache-hit"
          ? "已確定命中瀏覽器 HTTP Cache，無須新增網路下載。"
          : "已確定命中本機 CacheStorage，無須額外網路下載。",
    };
  }

  const known = resolveKnownNetworkAsset(input.url);
  const origin = known?.origin ?? classifyUrlOrigin(input.url);
  const resolvedSize =
    typeof input.knownSizeBytes === "number" && Number.isFinite(input.knownSizeBytes) && input.knownSizeBytes >= 0
      ? input.knownSizeBytes
      : known?.sizeBytes ?? null;
  const effectiveCacheStatus: NetworkCacheStatus = input.cacheStatus ?? "uncached";

  if (origin === "unknown" || resolvedSize === null) {
    return {
      allowed: false,
      fromCache: false,
      cacheStatus: effectiveCacheStatus,
      failClosed: true,
      hardBlocked: true,
      requiresExternalDownloadConfirmation: false,
      origin,
      assetLabel: known?.label ?? (normalized || "未識別資產"),
      estimatedTransferBytes: resolvedSize ?? 0,
      projectedSessionBytes: priorVercelBytes,
      budgetBytes: vercelBudgetBytes,
      sizeSource: "unknown",
      reason: "unknown-asset-or-size",
      message: `未登記來源、快取狀態未知或無法確認大小（${normalized || "空白 URL"}），已採保守策略直接拒絕下載（fail-closed，不提供繞過）。`,
    };
  }

  const sizeSource =
    typeof input.knownSizeBytes === "number" && Number.isFinite(input.knownSizeBytes)
      ? "caller-supplied"
      : known?.sizeSource ?? "estimated-upstream";
  const label = known?.label ?? normalized;
  const isVercelStatic = origin === "vercel-static";
  const activeBudgetBytes = isVercelStatic ? vercelBudgetBytes : externalBudgetBytes;
  const activePriorBytes = isVercelStatic ? priorVercelBytes : priorExternalBytes;
  const projected = activePriorBytes + resolvedSize;
  const exceeds = resolvedSize > activeBudgetBytes || projected > activeBudgetBytes;
  const originText = isVercelStatic ? "Vercel 本站靜態資產" : "外部可信 CDN";

  if (exceeds) {
    return {
      allowed: false,
      fromCache: false,
      cacheStatus: effectiveCacheStatus,
      failClosed: false,
      hardBlocked: true,
      requiresExternalDownloadConfirmation: !isVercelStatic,
      origin,
      assetLabel: label,
      estimatedTransferBytes: resolvedSize,
      projectedSessionBytes: projected,
      budgetBytes: activeBudgetBytes,
      sizeSource,
      reason: isVercelStatic ? "exceeds-budget" : "exceeds-external-cdn-budget",
      message: isVercelStatic
        ? `${label}（來源：${originText}）未快取下載量約 ${formatMiB(resolvedSize)}，超過統一 ${formatMiB(activeBudgetBytes)} 靜態預算上限，已直接拒絕（不因裝置等級或確認放行）。`
        : `${label}（來源：${originText}）預計下載約 ${formatMiB(resolvedSize)}，超出外部 CDN 獨立預算（${formatMiB(activeBudgetBytes)}），已拒絕下載。`,
    };
  }

  return {
    allowed: true,
    fromCache: false,
    cacheStatus: effectiveCacheStatus,
    failClosed: false,
    hardBlocked: false,
    requiresExternalDownloadConfirmation: !isVercelStatic && resolvedSize > 0,
    origin,
    assetLabel: label,
    estimatedTransferBytes: resolvedSize,
    projectedSessionBytes: projected,
    budgetBytes: activeBudgetBytes,
    sizeSource,
    reason: "within-budget",
    message: isVercelStatic
      ? `${label} 預計下載 ${formatMiB(resolvedSize)}（${originText}），位於 ${formatMiB(activeBudgetBytes)} 靜態預算內。`
      : `${label} 預計自外部可信 CDN 下載 ${formatMiB(resolvedSize)}（不經 Vercel 計費），快取後重複執行為 0 MiB。`,
  };
}

export function evaluateNetworkAssetBatch(options: {
  assets: readonly NetworkAssetBatchItem[];
  budgetBytes?: number;
  vercelStaticBudgetBytes?: number;
  externalCdnBudgetBytes?: number;
  sessionTransferredBytes?: number;
  sessionExternalTransferredBytes?: number;
}): NetworkBatchEvaluation {
  const vercelStaticBudgetBytes = Math.min(
    DEFAULT_VERCEL_STATIC_BUDGET_BYTES,
    Math.max(1, options.vercelStaticBudgetBytes ?? options.budgetBytes ?? DEFAULT_VERCEL_STATIC_BUDGET_BYTES),
  );
  const externalCdnBudgetBytes = Math.max(
    1,
    options.externalCdnBudgetBytes ?? options.budgetBytes ?? configuredExternalCdnBudgetBytes,
  );
  let runningVercelBytes = Math.max(0, options.sessionTransferredBytes ?? 0);
  let runningExternalBytes = Math.max(0, options.sessionExternalTransferredBytes ?? 0);
  let totalEstimatedTransferBytes = 0;
  let vercelStaticBytes = 0;
  let externalCdnBytes = 0;
  let cachedHitCount = 0;
  let uncachedCount = 0;
  let failClosed = false;
  let hardBlocked = false;
  let serverBlocked = false;
  let vercelExceeded = false;
  let externalExceeded = false;
  let requiresExternalDownloadConfirmation = false;

  const items: NetworkTransferDecision[] = [];
  for (const asset of options.assets) {
    const decision = evaluateNetworkTransfer({
      url: asset.url,
      isCached: asset.isCached,
      cacheStatus: asset.cacheStatus,
      knownSizeBytes: asset.knownSizeBytes,
      budgetBytes: vercelStaticBudgetBytes,
      externalCdnBudgetBytes,
      sessionTransferredBytes: runningVercelBytes,
      sessionExternalTransferredBytes: runningExternalBytes,
    });
    items.push(decision);
    totalEstimatedTransferBytes += decision.estimatedTransferBytes;
    if (decision.fromCache) {
      cachedHitCount += 1;
    } else {
      uncachedCount += 1;
    }
    if (decision.origin === "vercel-static") {
      vercelStaticBytes += decision.estimatedTransferBytes;
      runningVercelBytes = decision.projectedSessionBytes;
    }
    if (decision.origin === "external-cdn") {
      externalCdnBytes += decision.estimatedTransferBytes;
      runningExternalBytes = decision.projectedSessionBytes;
    }
    if (decision.requiresExternalDownloadConfirmation) {
      requiresExternalDownloadConfirmation = true;
    }
    if (decision.failClosed) failClosed = true;
    if (decision.hardBlocked) hardBlocked = true;
    if (decision.reason === "server-compute-prohibited") serverBlocked = true;
    if (decision.reason === "exceeds-budget") vercelExceeded = true;
    if (decision.reason === "exceeds-external-cdn-budget") externalExceeded = true;
  }

  const allowed = !failClosed && !hardBlocked;
  const blockingReason: NetworkBatchEvaluation["blockingReason"] = serverBlocked
    ? "server-compute-prohibited"
    : failClosed
      ? "unknown-asset-or-size"
      : vercelExceeded
        ? "exceeds-budget"
        : externalExceeded
          ? "exceeds-external-cdn-budget"
          : hardBlocked
            ? "exceeds-budget"
            : null;

  let message = "所需資源已全數在本機快取命中，新增網路下載 0.0 MiB。";
  if (blockingReason === "server-compute-prohibited") {
    message = "禁止使用後端伺服器／Vercel Functions 執行本機音訊與 AI 運算，已拒絕請求。";
  } else if (blockingReason === "unknown-asset-or-size") {
    const unknownItem = items.find((item) => item.failClosed);
    message = unknownItem?.message ?? "偵測到未知來源、未知快取狀態或無法確認大小的網路下載，已直接拒絕（不提供繞過）。";
  } else if (blockingReason === "exceeds-budget") {
    message = `Vercel 靜態未快取下載 ${formatMiB(vercelStaticBytes)}，超過所有裝置統一的 ${formatMiB(vercelStaticBudgetBytes)} 下載硬上限，已直接拒絕（不提供繞過）。`;
  } else if (blockingReason === "exceeds-external-cdn-budget") {
    message = `外部 CDN 未快取下載 ${formatMiB(externalCdnBytes)}，超出外部下載預算上限 ${formatMiB(externalCdnBudgetBytes)}，已拒絕下載。`;
  } else if (requiresExternalDownloadConfirmation) {
    message = `首次載入或快取遺失時需自外部可信 CDN 下載約 ${formatMiB(externalCdnBytes)}（Vercel 靜態僅 ${formatMiB(vercelStaticBytes)} ≤ ${formatMiB(vercelStaticBudgetBytes)}），請確認後下載並存入本機快取。`;
  } else if (vercelStaticBytes > 0) {
    message = `預計僅下載輕量執行期腳本 ${formatMiB(vercelStaticBytes)}（位於 Vercel ${formatMiB(vercelStaticBudgetBytes)} 上限內）。`;
  }

  return {
    allowed,
    failClosed,
    hardBlocked,
    requiresExternalDownloadConfirmation,
    totalEstimatedTransferBytes,
    vercelStaticBytes,
    externalCdnBytes,
    cachedHitCount,
    uncachedCount,
    budgetBytes: vercelStaticBudgetBytes,
    vercelStaticBudgetBytes,
    externalCdnBudgetBytes,
    items,
    blockingReason,
    message,
  };
}

export type NetworkBudgetLedgerSnapshot = {
  budgetBytes: number;
  vercelStaticBytes: number;
  externalCdnBytes: number;
  totalBytes: number;
  transfers: Array<{
    url: string;
    origin: NetworkAssetOrigin;
    bytes: number;
    recordedAt: number;
  }>;
};

export class NetworkBudgetLedger {
  private readonly budgetBytes: number;
  private vercelStaticBytes = 0;
  private externalCdnBytes = 0;
  private readonly recordedUrls = new Set<string>();
  private readonly transfers: NetworkBudgetLedgerSnapshot["transfers"] = [];

  constructor(budgetBytes = DEFAULT_NETWORK_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  recordTransfer(url: string, bytes: number, explicitOrigin?: NetworkAssetOrigin): void {
    const normalized = normalizeAssetUrlPath(url);
    if (!normalized || bytes <= 0) return;
    if (this.recordedUrls.has(normalized)) return;
    this.recordedUrls.add(normalized);

    const origin = explicitOrigin ?? classifyUrlOrigin(normalized);
    if (origin === "vercel-static") {
      this.vercelStaticBytes += bytes;
    } else if (origin === "external-cdn") {
      this.externalCdnBytes += bytes;
    }
    this.transfers.push({
      url: normalized,
      origin,
      bytes,
      recordedAt: Date.now(),
    });
  }

  getSnapshot(): NetworkBudgetLedgerSnapshot {
    return {
      budgetBytes: this.budgetBytes,
      vercelStaticBytes: this.vercelStaticBytes,
      externalCdnBytes: this.externalCdnBytes,
      totalBytes: this.vercelStaticBytes + this.externalCdnBytes,
      transfers: [...this.transfers],
    };
  }
}

export const sharedNetworkBudgetLedger = new NetworkBudgetLedger();
