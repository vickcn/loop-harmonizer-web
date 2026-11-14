import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyUrlOrigin,
  DEFAULT_NETWORK_BUDGET_BYTES,
  evaluateNetworkAssetBatch,
  evaluateNetworkTransfer,
  KNOWN_NETWORK_ASSETS,
  NetworkBudgetLedger,
} from "../lib/band/networkBudgetGuard.ts";
import {
  ensureStaticAssetCached,
  isStaticAssetCached,
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

    const hitSecond = await ensureStaticAssetCached(targetUrl, { allowNetworkFetch: false });
    assert.equal(hitSecond, true);
  } finally {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  }
});
