export const DEFAULT_NETWORK_BUDGET_BYTES = 10 * 1024 * 1024; // 10 MiB

export type NetworkAssetOrigin = "vercel-static" | "external-cdn" | "local-cache" | "unknown";

export type KnownNetworkAssetEntry = {
  id: string;
  label: string;
  matchPathOrUrl: string;
  origin: Exclude<NetworkAssetOrigin, "local-cache" | "unknown">;
  sizeBytes: number;
  sizeSource: "exact-static-file" | "estimated-upstream";
};

export const KNOWN_NETWORK_ASSETS: readonly KnownNetworkAssetEntry[] = [
  {
    id: "ort-wasm-threaded-asyncify",
    label: "ONNX Runtime WASM 核心檔（ort-wasm-simd-threaded.asyncify.wasm）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
    origin: "vercel-static",
    sizeBytes: 25749873,
    sizeSource: "exact-static-file",
  },
  {
    id: "ort-webgpu-bundle",
    label: "ONNX Runtime WebGPU 模組（ort.webgpu.bundle.min.mjs）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs",
    origin: "vercel-static",
    sizeBytes: 116102,
    sizeSource: "exact-static-file",
  },
  {
    id: "ort-wasm-glue",
    label: "ONNX Runtime WASM 載入器（ort-wasm-simd-threaded.asyncify.mjs）",
    matchPathOrUrl: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
    origin: "vercel-static",
    sizeBytes: 51407,
    sizeSource: "exact-static-file",
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
    sizeBytes: 15104,
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
    sizeBytes: 7144,
    sizeSource: "exact-static-file",
  },
  {
    id: "demucs-htdemucs-onnx",
    label: "Demucs AI 分離模型權重（htdemucs_embedded.onnx）",
    matchPathOrUrl: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx",
    origin: "external-cdn",
    sizeBytes: 172 * 1024 * 1024,
    sizeSource: "estimated-upstream",
  },
];

export type NetworkTransferEvaluationInput = {
  url: string;
  isCached?: boolean;
  knownSizeBytes?: number | null;
  budgetBytes?: number;
  sessionTransferredBytes?: number;
  allowOverBudget?: boolean;
  allowUnknownAsset?: boolean;
};

export type NetworkTransferDecision = {
  allowed: boolean;
  fromCache: boolean;
  failClosed: boolean;
  requiresConfirmation: boolean;
  origin: NetworkAssetOrigin;
  assetLabel: string;
  estimatedTransferBytes: number;
  projectedSessionBytes: number;
  budgetBytes: number;
  sizeSource: "cached" | "exact-static-file" | "estimated-upstream" | "caller-supplied" | "unknown";
  reason: "cached" | "within-budget" | "approved-over-budget" | "exceeds-budget" | "unknown-asset-or-size";
  message: string;
};

export type NetworkAssetBatchItem = {
  url: string;
  isCached?: boolean;
  knownSizeBytes?: number | null;
};

export type NetworkBatchEvaluation = {
  allowed: boolean;
  failClosed: boolean;
  requiresConfirmation: boolean;
  totalEstimatedTransferBytes: number;
  vercelStaticBytes: number;
  externalCdnBytes: number;
  budgetBytes: number;
  items: NetworkTransferDecision[];
  blockingReason: "unknown-asset-or-size" | "exceeds-budget" | null;
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
  const budgetBytes = Math.max(1, input.budgetBytes ?? DEFAULT_NETWORK_BUDGET_BYTES);
  const priorBytes = Math.max(0, input.sessionTransferredBytes ?? 0);
  const normalized = normalizeAssetUrlPath(input.url);

  if (normalized.startsWith("blob:") || normalized.startsWith("data:") || input.isCached) {
    return {
      allowed: true,
      fromCache: true,
      failClosed: false,
      requiresConfirmation: false,
      origin: "local-cache",
      assetLabel: resolveKnownNetworkAsset(input.url)?.label ?? normalized,
      estimatedTransferBytes: 0,
      projectedSessionBytes: priorBytes,
      budgetBytes,
      sizeSource: "cached",
      reason: "cached",
      message: "已命中本機快取，無須額外網路下載。",
    };
  }

  const known = resolveKnownNetworkAsset(input.url);
  const origin = known?.origin ?? classifyUrlOrigin(input.url);
  const resolvedSize =
    typeof input.knownSizeBytes === "number" && Number.isFinite(input.knownSizeBytes) && input.knownSizeBytes >= 0
      ? input.knownSizeBytes
      : known?.sizeBytes ?? null;

  if (origin === "unknown" || resolvedSize === null) {
    const allowed = Boolean(input.allowUnknownAsset && input.allowOverBudget);
    return {
      allowed,
      fromCache: false,
      failClosed: !allowed,
      requiresConfirmation: !allowed,
      origin,
      assetLabel: known?.label ?? (normalized || "未識別資產"),
      estimatedTransferBytes: resolvedSize ?? 0,
      projectedSessionBytes: priorBytes,
      budgetBytes,
      sizeSource: "unknown",
      reason: "unknown-asset-or-size",
      message: `未登記來源或未知檔案大小（${normalized || "空白 URL"}），依安全策略預設拒絕下載（fail-closed）。`,
    };
  }

  const sizeSource =
    typeof input.knownSizeBytes === "number" && Number.isFinite(input.knownSizeBytes)
      ? "caller-supplied"
      : known?.sizeSource ?? "estimated-upstream";
  const projected = priorBytes + resolvedSize;
  const exceeds = resolvedSize > budgetBytes || projected > budgetBytes;
  const label = known?.label ?? normalized;
  const originText = origin === "vercel-static" ? "Vercel 本站靜態資產" : "外部 CDN";

  if (exceeds && !input.allowOverBudget) {
    return {
      allowed: false,
      fromCache: false,
      failClosed: false,
      requiresConfirmation: true,
      origin,
      assetLabel: label,
      estimatedTransferBytes: resolvedSize,
      projectedSessionBytes: projected,
      budgetBytes,
      sizeSource,
      reason: "exceeds-budget",
      message: `${label}（來源：${originText}）預計下載 ${formatMiB(resolvedSize)}，將使本次網路傳輸達 ${formatMiB(projected)}，超過 ${formatMiB(budgetBytes)} 預設上限。`,
    };
  }

  return {
    allowed: true,
    fromCache: false,
    failClosed: false,
    requiresConfirmation: false,
    origin,
    assetLabel: label,
    estimatedTransferBytes: resolvedSize,
    projectedSessionBytes: projected,
    budgetBytes,
    sizeSource,
    reason: exceeds ? "approved-over-budget" : "within-budget",
    message: exceeds
      ? `使用者已授權超額下載 ${label}（${formatMiB(resolvedSize)}，${originText}）。`
      : `${label} 預計下載 ${formatMiB(resolvedSize)}（${originText}），位於預算內。`,
  };
}

export function evaluateNetworkAssetBatch(options: {
  assets: readonly NetworkAssetBatchItem[];
  budgetBytes?: number;
  sessionTransferredBytes?: number;
  allowOverBudget?: boolean;
  allowUnknownAsset?: boolean;
}): NetworkBatchEvaluation {
  const budgetBytes = Math.max(1, options.budgetBytes ?? DEFAULT_NETWORK_BUDGET_BYTES);
  let runningBytes = Math.max(0, options.sessionTransferredBytes ?? 0);
  let totalEstimatedTransferBytes = 0;
  let vercelStaticBytes = 0;
  let externalCdnBytes = 0;
  let failClosed = false;
  let requiresConfirmation = false;

  const items: NetworkTransferDecision[] = [];
  for (const asset of options.assets) {
    const decision = evaluateNetworkTransfer({
      url: asset.url,
      isCached: asset.isCached,
      knownSizeBytes: asset.knownSizeBytes,
      budgetBytes,
      sessionTransferredBytes: runningBytes,
      allowOverBudget: options.allowOverBudget,
      allowUnknownAsset: options.allowUnknownAsset,
    });
    items.push(decision);
    runningBytes = decision.projectedSessionBytes;
    totalEstimatedTransferBytes += decision.estimatedTransferBytes;
    if (decision.origin === "vercel-static") vercelStaticBytes += decision.estimatedTransferBytes;
    if (decision.origin === "external-cdn") externalCdnBytes += decision.estimatedTransferBytes;
    if (decision.failClosed) failClosed = true;
    if (decision.requiresConfirmation) requiresConfirmation = true;
  }

  const allowed = !failClosed && !requiresConfirmation;
  const blockingReason = failClosed
    ? "unknown-asset-or-size"
    : requiresConfirmation
      ? "exceeds-budget"
      : null;

  let message = "本次操作不需下載超過預算之大型網路資產。";
  if (blockingReason === "unknown-asset-or-size") {
    const unknownItem = items.find((item) => item.failClosed);
    message = unknownItem?.message ?? "偵測到未知來源或無法估算大小的網路下載，已依安全策略停止。";
  } else if (blockingReason === "exceeds-budget") {
    message = `預計下載 ${formatMiB(totalEstimatedTransferBytes)}（Vercel 靜態：${formatMiB(vercelStaticBytes)}；外部 CDN：${formatMiB(externalCdnBytes)}），超過 ${formatMiB(budgetBytes)} 預設下載上限，需經確認後才能繼續。`;
  }

  return {
    allowed,
    failClosed,
    requiresConfirmation,
    totalEstimatedTransferBytes,
    vercelStaticBytes,
    externalCdnBytes,
    budgetBytes,
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
