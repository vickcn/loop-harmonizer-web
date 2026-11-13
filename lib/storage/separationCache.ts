import type { SeparatedStemSet } from "../separation/stemTypes";
import { idbClear, idbDelete, idbGet, idbGetAll, idbPut } from "./indexedDb";
import { restoreStemSet, type StemCacheRecord } from "./separationCacheRecord";
export { createStemCacheRecord, restoreStemSet } from "./separationCacheRecord";
export type { StemCacheRecord } from "./separationCacheRecord";

export async function hashSourceAudio(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b) >>> 0;
  }
  return `fallback-${bytes.length}-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export async function getCachedStemSet(key: string): Promise<SeparatedStemSet | null> {
  const record = await idbGet<StemCacheRecord>("separations", key);
  return record ? restoreStemSet(record) : null;
}

export async function putCachedStemSet(record: StemCacheRecord): Promise<void> {
  try {
    await idbPut("separations", record);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
      throw new Error("瀏覽器儲存空間不足，分離結果仍可在本次頁面使用，但無法持久快取。");
    }
    throw error;
  }
}

export const deleteCachedStemSet = (key: string) => idbDelete("separations", key);
export const clearAllCachedStemSets = () => idbClear("separations");

export async function getCachedStemBytes(): Promise<number> {
  const records = await idbGetAll<StemCacheRecord>("separations");
  return records.reduce((total, record) => total + record.sizeBytes, 0);
}
