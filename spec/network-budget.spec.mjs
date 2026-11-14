import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyUrlOrigin,
  DEFAULT_EXTERNAL_CDN_BUDGET_BYTES,
  DEFAULT_NETWORK_BUDGET_BYTES,
  evaluateNetworkAssetBatch,
  evaluateNetworkTransfer,
  EXTERNAL_ORT_WASM_CDN_URL,
  KNOWN_NETWORK_ASSETS,
  NetworkBudgetLedger,
} from "../lib/band/networkBudgetGuard.ts";
import {
  clearStaticRuntimeCache,
  configureStaticAssetNetworkGuard,
  ensureStaticAssetCached,
  inspectStaticAssetCacheStatus,
  isStaticAssetCached,
  ORT_ASSET_VERSION,
  prepareApprovedOrtWasmUrl,
  revokeActiveOrtWasmBlobUrl,
} from "../lib/storage/staticAssetCache.ts";

test("default network budget is capped at 10 MiB and static asset manifest sizes match disk files", () => {
  assert.equal(DEFAULT_NETWORK_BUDGET_BYTES, 10 * 1024 * 1024);

  const exactAssets = KNOWN_NETWORK_ASSETS.filter((entry) => entry.sizeSource === "exact-static-file");
  assert.ok(exactAssets.length >= 6);
  for (const entry of exactAssets) {
    const filePath = path.join(process.cwd(), "public", entry.matchPathOrUrl.replace(/^\//, ""));
    const stat = fs.statSync(filePath);
    assert.equal(
      stat.size,
      entry.sizeBytes,
      `Static manifest byte size for ${entry.matchPathOrUrl} must match real disk asset`,
    );
  }
});

test("blocks uncached 25 MB Vercel static ORT WASM over 10 MiB limit and tracks origin separately", () => {
  const wasmUrl = "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm";
  const decision = evaluateNetworkTransfer({
    url: wasmUrl,
    isCached: false,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.hardBlocked, true);
  assert.equal(decision.origin, "vercel-static");
  assert.ok(decision.estimatedTransferBytes > 25_000_000);
  assert.equal(decision.reason, "exceeds-budget");
});

test("distinguishes vercel-static and external-cdn in separation preflight batch evaluation", () => {
  const batch = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", isCached: false },
      { url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", isCached: false },
    ],
  });

  assert.equal(batch.allowed, false);
  assert.equal(batch.blockingReason, "exceeds-budget");
  assert.ok(batch.vercelStaticBytes > 25_000_000);
  assert.ok(batch.externalCdnBytes > 100 * 1024 * 1024);
  assert.equal(batch.totalEstimatedTransferBytes, batch.vercelStaticBytes + batch.externalCdnBytes);
});

test("cached assets and blob/data URLs count zero network transfer and pass without consuming budget", () => {
  const batch = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", isCached: true },
      { url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", isCached: true },
      { url: "blob:https://app.example.com/12345" },
    ],
  });

  assert.equal(batch.allowed, true);
  assert.equal(batch.totalEstimatedTransferBytes, 0);
  assert.equal(batch.vercelStaticBytes, 0);
  assert.equal(batch.externalCdnBytes, 0);
});

test("unknown asset URL or unknown size fails closed by default", () => {
  const unknown = evaluateNetworkTransfer({
    url: "https://untrusted-cdn.example.invalid/weights.bin",
    isCached: false,
  });

  assert.equal(unknown.allowed, false);
  assert.equal(unknown.failClosed, true);
  assert.equal(unknown.reason, "unknown-asset-or-size");
  assert.equal(classifyUrlOrigin("/vendor/soundtouch.js"), "vercel-static");
  assert.equal(classifyUrlOrigin("https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx"), "external-cdn");
});

test("ledger records approved transfers by origin without double counting the same URL", () => {
  const ledger = new NetworkBudgetLedger(DEFAULT_NETWORK_BUDGET_BYTES);
  ledger.recordTransfer("/vendor/soundtouch.js", 26324);
  ledger.recordTransfer("/vendor/soundtouch.js", 26324);
  ledger.recordTransfer("https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", 172000000);

  const snapshot = ledger.getSnapshot();
  assert.equal(snapshot.vercelStaticBytes, 26324);
  assert.equal(snapshot.externalCdnBytes, 172000000);
  assert.equal(snapshot.totalBytes, 26324 + 172000000);
});

test("enforces strict 10 MiB cap with hardBlocked even on high-end desktop and blocks /api/ server compute", () => {
  const highEndDesktopBatch = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", isCached: false },
      { url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", isCached: false },
    ],
  });
  assert.equal(highEndDesktopBatch.allowed, false);
  assert.equal(highEndDesktopBatch.hardBlocked, true);
  assert.equal(highEndDesktopBatch.blockingReason, "exceeds-budget");
  assert.equal(highEndDesktopBatch.budgetBytes, 10 * 1024 * 1024);

  const serverCompute = evaluateNetworkTransfer({
    url: "/api/separate",
    isCached: false,
  });
  assert.equal(serverCompute.allowed, false);
  assert.equal(serverCompute.hardBlocked, true);
  assert.equal(serverCompute.reason, "server-compute-prohibited");
});

test("detects and syncs HTTP-cached vendor runtime asset into CacheStorage with zero network fetch", async () => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const stored = new Map();
  let fetchCacheMode = null;

  globalThis.caches = {
    match: async (url) => stored.get(url),
    open: async () => ({
      put: async (url, response) => {
        stored.set(url, response);
      },
    }),
  };
  globalThis.fetch = async (url, init) => {
    fetchCacheMode = init?.cache ?? null;
    return new Response("wasm-bytes", { status: 200 });
  };

  try {
    const targetUrl = "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm";
    const ok = await isStaticAssetCached(targetUrl);
    assert.equal(ok, true);
    assert.equal(fetchCacheMode, "only-if-cached");
    assert.equal(stored.has(targetUrl), true);

    const hitSecond = await ensureStaticAssetCached(targetUrl, { allowApprovedNetworkFetch: false });
    assert.equal(hitSecond, true);
  } finally {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  }
});

test("fresh browser with zero cache passes Vercel 10 MiB cap using external CDN WASM and asks external download confirmation", () => {
  const firstVisitBatch = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs", isCached: false },
      { url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs", isCached: false },
      { url: "/vendor/demucs-web/worker.js", isCached: false },
      { url: "/vendor/demucs-web/processor.js", isCached: false },
      { url: "/vendor/demucs-web/fft.js", isCached: false },
      { url: "/vendor/demucs-web/constants.js", isCached: false },
      { url: "/vendor/demucs-web/index.js", isCached: false },
      { url: EXTERNAL_ORT_WASM_CDN_URL, isCached: false },
      { url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", isCached: false },
    ],
  });

  assert.equal(firstVisitBatch.allowed, true);
  assert.equal(firstVisitBatch.hardBlocked, false);
  assert.equal(firstVisitBatch.requiresExternalDownloadConfirmation, true);
  assert.ok(firstVisitBatch.vercelStaticBytes < 300 * 1024);
  assert.ok(firstVisitBatch.vercelStaticBytes < DEFAULT_NETWORK_BUDGET_BYTES);
  assert.equal(firstVisitBatch.vercelStaticBudgetBytes, DEFAULT_NETWORK_BUDGET_BYTES);
  assert.equal(firstVisitBatch.externalCdnBudgetBytes, DEFAULT_EXTERNAL_CDN_BUDGET_BYTES);
  assert.ok(firstVisitBatch.externalCdnBytes > 190 * 1024 * 1024);
  assert.ok(firstVisitBatch.externalCdnBytes <= DEFAULT_EXTERNAL_CDN_BUDGET_BYTES);

  // If external CDN budget is tightened below required size, external batch is blocked separately
  const tightExternalBudget = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs", isCached: true },
      { url: EXTERNAL_ORT_WASM_CDN_URL, isCached: false },
      { url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx", isCached: false },
    ],
    externalCdnBudgetBytes: 50 * 1024 * 1024,
  });
  assert.equal(tightExternalBudget.allowed, false);
  assert.equal(tightExternalBudget.blockingReason, "exceeds-external-cdn-budget");
});

test("Resource Timing entry alone does NOT count as cached, and cache eviction invalidates offline proof", async () => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const originalPerf = globalThis.performance;
  const bucketMap = new Map();

  globalThis.caches = {
    open: async (name) => {
      if (!bucketMap.has(name)) bucketMap.set(name, new Map());
      const bucket = bucketMap.get(name);
      return {
        match: async (url) => bucket.get(url),
        put: async (url, response) => {
          bucket.set(url, response);
        },
      };
    },
    match: async (url) => {
      for (const bucket of bucketMap.values()) {
        if (bucket.has(url)) return bucket.get(url);
      }
      return undefined;
    },
    delete: async (name) => bucketMap.delete(name),
    keys: async () => [...bucketMap.keys()],
  };
  globalThis.fetch = async () => {
    throw new TypeError("only-if-cached miss");
  };
  globalThis.performance = {
    ...originalPerf,
    getEntriesByType: (type) => (type === "resource" ? [{ name: "https://app.example.com/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs" }] : []),
  };

  try {
    const assetUrl = "/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs";
    const timingOnly = await inspectStaticAssetCacheStatus(assetUrl);
    assert.equal(timingOnly.isCached, false);
    assert.equal(timingOnly.status, "uncached");
    assert.equal(timingOnly.loadedInSessionHint, true);

    // Put in CacheStorage -> becomes cache-storage-hit
    const cache = await globalThis.caches.open(`loop-harmonizer-runtime-ort-${ORT_ASSET_VERSION}-v2`);
    await cache.put(assetUrl, new Response("js-code", { status: 200 }));
    const cachedHit = await inspectStaticAssetCacheStatus(assetUrl);
    assert.equal(cachedHit.isCached, true);
    assert.equal(cachedHit.status, "cache-storage-hit");

    // Simulate browser storage eviction
    await clearStaticRuntimeCache();
    const afterEviction = await inspectStaticAssetCacheStatus(assetUrl);
    assert.equal(afterEviction.isCached, false);
    assert.equal(afterEviction.status, "uncached");
  } finally {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
    globalThis.performance = originalPerf;
  }
});

test("WASM version change invalidates old versioned CacheStorage entry and triggers fail-safe single download without retry loop", async () => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const bucketMap = new Map();
  let networkFetchCount = 0;

  configureStaticAssetNetworkGuard({
    evaluateTransfer: evaluateNetworkTransfer,
    recordTransfer: () => {},
    getSnapshot: () => ({ vercelStaticBytes: 0, externalCdnBytes: 0 }),
  });

  globalThis.caches = {
    open: async (name) => {
      if (!bucketMap.has(name)) bucketMap.set(name, new Map());
      const bucket = bucketMap.get(name);
      return {
        match: async (url) => bucket.get(url),
        put: async (url, response) => {
          bucket.set(url, response);
        },
      };
    },
    match: async (url) => {
      for (const bucket of bucketMap.values()) {
        if (bucket.has(url)) return bucket.get(url);
      }
      return undefined;
    },
    delete: async (name) => bucketMap.delete(name),
    keys: async () => [...bucketMap.keys()],
  };
  globalThis.fetch = async (url, init) => {
    if (init?.cache === "only-if-cached") {
      throw new TypeError("miss");
    }
    networkFetchCount += 1;
    return new Response("wasm-failed", { status: 503 });
  };

  try {
    revokeActiveOrtWasmBlobUrl();
    const oldCache = await globalThis.caches.open(`loop-harmonizer-runtime-ort-${ORT_ASSET_VERSION}-v2`);
    await oldCache.put(
      EXTERNAL_ORT_WASM_CDN_URL,
      new Response("old-wasm-bytes", {
        status: 200,
        headers: { "X-Loop-Harmonizer-Asset-Version": ORT_ASSET_VERSION },
      }),
    );

    const oldVersionCheck = await inspectStaticAssetCacheStatus(EXTERNAL_ORT_WASM_CDN_URL, { version: ORT_ASSET_VERSION });
    assert.equal(oldVersionCheck.isCached, true);

    const bumpedVersionCheck = await inspectStaticAssetCacheStatus(EXTERNAL_ORT_WASM_CDN_URL, { version: "1.30.0" });
    assert.equal(bumpedVersionCheck.isCached, false);
    assert.equal(bumpedVersionCheck.status, "uncached");

    // Failed CDN download must stop immediately after 1 attempt without retry loop
    await assert.rejects(
      () => prepareApprovedOrtWasmUrl({ version: "1.30.0" }),
      /HTTP 503|已停止自動重試/,
    );
    assert.equal(networkFetchCount, 1);

    // Unapproved local large static WASM fetch must be blocked even if ensureStaticAssetCached is forced
    await assert.rejects(
      () => ensureStaticAssetCached("/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", { allowApprovedNetworkFetch: true }),
      /超過|靜態預算上限|拒絕/,
    );
    // Network fetch count stays 1 (no unapproved request sent to Vercel)
    assert.equal(networkFetchCount, 1);
  } finally {
    revokeActiveOrtWasmBlobUrl();
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  }
});

test("deduplicates concurrent external WASM downloads so runtime and cache sync never fetch twice", async () => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const originalCreateObjUrl = URL.createObjectURL;
  const originalRevokeObjUrl = URL.revokeObjectURL;
  const bucketMap = new Map();
  const ledger = new NetworkBudgetLedger(DEFAULT_NETWORK_BUDGET_BYTES);
  let externalFetchCalls = 0;

  configureStaticAssetNetworkGuard({
    evaluateTransfer: evaluateNetworkTransfer,
    recordTransfer: (url, bytes, explicitOrigin) => ledger.recordTransfer(url, bytes, explicitOrigin),
    getSnapshot: () => ledger.getSnapshot(),
  });

  globalThis.caches = {
    open: async (name) => {
      if (!bucketMap.has(name)) bucketMap.set(name, new Map());
      const bucket = bucketMap.get(name);
      return {
        match: async (url) => bucket.get(url),
        put: async (url, response) => {
          bucket.set(url, response);
        },
      };
    },
    match: async () => undefined,
  };
  URL.createObjectURL = () => "blob:https://app.example.com/cached-ort-wasm";
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url, init) => {
    if (init?.cache === "only-if-cached") throw new TypeError("miss");
    externalFetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), { status: 200 });
  };

  try {
    revokeActiveOrtWasmBlobUrl();
    const [r1, r2] = await Promise.all([
      prepareApprovedOrtWasmUrl({ version: "1.29.9-test" }),
      prepareApprovedOrtWasmUrl({ version: "1.29.9-test" }),
    ]);
    assert.equal(externalFetchCalls, 1);
    assert.equal(r1.wasmUrl, "blob:https://app.example.com/cached-ort-wasm");
    assert.equal(r2.wasmUrl, "blob:https://app.example.com/cached-ort-wasm");
    assert.equal(ledger.getSnapshot().vercelStaticBytes, 0);
    assert.equal(ledger.getSnapshot().externalCdnBytes, 8);
  } finally {
    revokeActiveOrtWasmBlobUrl();
    URL.createObjectURL = originalCreateObjUrl;
    URL.revokeObjectURL = originalRevokeObjUrl;
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  }
});
