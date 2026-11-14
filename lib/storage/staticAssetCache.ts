export const STATIC_RUNTIME_CACHE_NAME = "loop-harmonizer-runtime-v1";

export async function ensureStaticAssetCached(
  assetUrl: string,
  options?: { allowNetworkFetch?: boolean },
): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const matched = await caches.match(assetUrl);
    if (matched) return true;
  } catch {
    return false;
  }

  if (typeof fetch !== "function") return false;

  try {
    const response = await fetch(assetUrl, {
      cache: options?.allowNetworkFetch ? "force-cache" : "only-if-cached",
      mode: "same-origin",
    });
    if (!response.ok) return false;
    const cache = await caches.open(STATIC_RUNTIME_CACHE_NAME);
    await cache.put(assetUrl, response.clone()).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function isStaticAssetCached(assetUrl: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const matched = await caches.match(assetUrl);
    if (matched) return true;
  } catch {
    return false;
  }

  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    try {
      const entries = performance.getEntriesByType("resource");
      const hitInSession = entries.some((entry) => entry.name.endsWith(assetUrl) || entry.name === assetUrl);
      if (hitInSession) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  // 若瀏覽器 HTTP Cache 已有此同源靜態檔（zero network），順勢寫入 CacheStorage
  if (assetUrl.startsWith("/")) {
    return ensureStaticAssetCached(assetUrl, { allowNetworkFetch: false });
  }
  return false;
}
