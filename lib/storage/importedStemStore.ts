import type { WavExportFormat } from "../audio/chunkedWavExporter.ts";
import type { StemSeparationMode } from "../separation/stemTypes.ts";
import { isTaskPinnedByDriveTransfer } from "./driveTransferStore.ts";
import {
  IMPORTED_STEM_HASH_INDEX,
  idbGet,
  idbGetAll,
  idbRequestPromise,
  withIdbTransaction,
} from "./indexedDb.ts";
import {
  type SeparationChunkRecord,
  deleteChunksByTaskIdInStore,
  getChunkSampleBounds,
  getTaskChunkRecordsInStore,
  validateChunkRecordIntegrity,
} from "./separationChunkStore.ts";

export interface ImportedStemRecord {
  key: string;
  importId: string;
  songId: string;
  ownerAccountId: string;
  sourceAudioHash: string;
  revisionId: string;
  manifestFileId: string;
  requestedMode: StemSeparationMode;
  stemLayout: "four_stem" | "two_stem_direct";
  pcmFormat: WavExportFormat;
  modelVersion: string;
  processingVersion: string;
  sampleRate: number;
  channelCount: 2;
  totalSamples: number;
  strideSamples: number;
  totalChunks: number;
  committedBytes: number;
  checksumsByRole: Record<string, string>;
  referencedBySongIds: string[];
  createdAt: number;
  updatedAt: number;
}

export function createImportedStemId(params: {
  ownerAccountId: string;
  sourceAudioHash: string;
  revisionId: string;
  mode: StemSeparationMode;
}): string {
  return `imp:${params.ownerAccountId}:${params.sourceAudioHash}:${params.mode}:${params.revisionId}`;
}

export async function getImportedStemRecord(importId: string): Promise<ImportedStemRecord | null> {
  if (!importId) return null;
  return idbGet<ImportedStemRecord>("importedStems", importId);
}

export async function getAllImportedStemRecords(): Promise<ImportedStemRecord[]> {
  return idbGetAll<ImportedStemRecord>("importedStems").catch(() => []);
}

export async function findImportedStemByHash(params: {
  sourceAudioHash: string;
  mode?: StemSeparationMode;
  modelVersion?: string;
  processingVersion?: string;
}): Promise<ImportedStemRecord | null> {
  if (!params.sourceAudioHash) return null;
  const rows = await withIdbTransaction("importedStems", "readonly", async (tx) => {
    const store = tx.objectStore("importedStems");
    if (
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(IMPORTED_STEM_HASH_INDEX))
    ) {
      return (await idbRequestPromise(
        store.index(IMPORTED_STEM_HASH_INDEX).getAll(params.sourceAudioHash),
      )) as ImportedStemRecord[];
    }
    const all = (await idbRequestPromise(store.getAll())) as ImportedStemRecord[];
    return all.filter((item) => item.sourceAudioHash === params.sourceAudioHash);
  });

  const matched = rows
    .filter((item) => {
      if (params.mode && item.requestedMode !== params.mode) return false;
      if (params.modelVersion && item.modelVersion !== params.modelVersion) return false;
      if (params.processingVersion && item.processingVersion !== params.processingVersion) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return matched[0] ?? null;
}

export async function saveImportedStemsAtomically(params: {
  record: ImportedStemRecord;
  chunks: readonly SeparationChunkRecord[];
}): Promise<ImportedStemRecord> {
  if (params.chunks.length !== params.record.totalChunks) {
    throw new Error(
      `匯入分軌 Chunk 數量不一致（預期 ${params.record.totalChunks}，實際 ${params.chunks.length}）。`,
    );
  }
  return withIdbTransaction(["importedStems", "separationChunks"], "readwrite", async (tx) => {
    const impStore = tx.objectStore("importedStems");
    const chunkStore = tx.objectStore("separationChunks");

    for (const chunk of params.chunks) {
      const check = validateChunkRecordIntegrity(chunk);
      if (!check.valid) {
        throw new Error(check.reason ?? "匯入分軌 Chunk 驗證失敗。");
      }
      await idbRequestPromise(chunkStore.put(chunk));
    }

    const fullRecord: ImportedStemRecord = {
      ...params.record,
      key: params.record.importId,
      updatedAt: Date.now(),
    };
    await idbRequestPromise(impStore.put(fullRecord));
    return fullRecord;
  });
}

export async function validateImportedStemIntegrity(importId: string): Promise<{
  valid: boolean;
  record: ImportedStemRecord | null;
  reason?: string;
}> {
  const { record, chunks } = await withIdbTransaction(
    ["importedStems", "separationChunks"],
    "readonly",
    async (tx) => {
      const impStore = tx.objectStore("importedStems");
      const chunkStore = tx.objectStore("separationChunks");
      const rec =
        ((await idbRequestPromise(impStore.get(importId))) as ImportedStemRecord | undefined) ??
        null;
      const chunkList = rec ? await getTaskChunkRecordsInStore(chunkStore, importId) : [];
      return { record: rec, chunks: chunkList };
    },
  );

  if (!record) {
    return { valid: false, record: null, reason: "找不到已匯入的分軌中繼資料。" };
  }
  if (record.totalChunks <= 0 || chunks.length < record.totalChunks) {
    return {
      valid: false,
      record,
      reason: `匯入分軌片段遺失（需要 ${record.totalChunks} 段，僅找到 ${chunks.length} 段）。`,
    };
  }

  for (let i = 0; i < record.totalChunks; i += 1) {
    const chunk = chunks[i];
    if (!chunk || chunk.chunkIndex !== i) {
      return { valid: false, record, reason: `匯入分軌第 ${i + 1} 段缺失。` };
    }
    const bounds = getChunkSampleBounds(i, record.totalSamples, record.strideSamples);
    if (
      chunk.startSample !== bounds.startSample ||
      chunk.endSample !== bounds.endSample
    ) {
      return { valid: false, record, reason: `匯入分軌第 ${i + 1} 段樣本範圍不符。` };
    }
    const check = validateChunkRecordIntegrity(chunk);
    if (!check.valid) {
      return { valid: false, record, reason: check.reason };
    }
  }

  return { valid: true, record };
}

export async function addImportedStemReference(
  importId: string,
  songId: string,
): Promise<ImportedStemRecord | null> {
  if (!importId || !songId) return null;
  return withIdbTransaction("importedStems", "readwrite", async (tx) => {
    const store = tx.objectStore("importedStems");
    const rec = (await idbRequestPromise(store.get(importId))) as ImportedStemRecord | undefined;
    if (!rec) return null;
    const nextRefs = Array.from(new Set([...(rec.referencedBySongIds ?? []), songId]));
    const updated: ImportedStemRecord = {
      ...rec,
      referencedBySongIds: nextRefs,
      updatedAt: Date.now(),
    };
    await idbRequestPromise(store.put(updated));
    return updated;
  });
}

export async function releaseImportedStemReferenceAndMaybeGc(params: {
  importId: string;
  songId: string;
  knownInMemorySongs?: ReadonlyArray<{ id?: string; importedStemOrigin?: { importId?: string } | null }>;
}): Promise<{ deleted: boolean; remainingReferences: number; blockedByTransferPin: boolean }> {
  if (!params.importId) {
    return { deleted: false, remainingReferences: 0, blockedByTransferPin: false };
  }
  return withIdbTransaction(
    ["songs", "importedStems", "separationChunks"],
    "readwrite",
    async (tx) => {
      const songsStore = tx.objectStore("songs");
      const impStore = tx.objectStore("importedStems");
      const chunkStore = tx.objectStore("separationChunks");

      const rec = (await idbRequestPromise(impStore.get(params.importId))) as
        | ImportedStemRecord
        | undefined;
      if (!rec) {
        return { deleted: false, remainingReferences: 0, blockedByTransferPin: false };
      }

      const persistedSongs = (await idbRequestPromise(songsStore.getAll())) as Array<{
        songId?: string;
        importedStemOrigin?: { importId?: string } | null;
      }>;
      const activeIds = new Set<string>();
      for (const s of persistedSongs) {
        if (s.songId && s.songId !== params.songId && s.importedStemOrigin?.importId === params.importId) {
          activeIds.add(s.songId);
        }
      }
      for (const s of params.knownInMemorySongs ?? []) {
        if (s.id && s.id !== params.songId && s.importedStemOrigin?.importId === params.importId) {
          activeIds.add(s.id);
        }
      }
      for (const refId of rec.referencedBySongIds ?? []) {
        if (refId !== params.songId && persistedSongs.some((s) => s.songId === refId)) {
          activeIds.add(refId);
        }
      }

      if (activeIds.size > 0) {
        await idbRequestPromise(
          impStore.put({
            ...rec,
            referencedBySongIds: Array.from(activeIds),
            updatedAt: Date.now(),
          } satisfies ImportedStemRecord),
        );
        return {
          deleted: false,
          remainingReferences: activeIds.size,
          blockedByTransferPin: false,
        };
      }

      if (isTaskPinnedByDriveTransfer(params.importId)) {
        return {
          deleted: false,
          remainingReferences: 0,
          blockedByTransferPin: true,
        };
      }

      await deleteChunksByTaskIdInStore(chunkStore, params.importId);
      await idbRequestPromise(impStore.delete(params.importId));
      return { deleted: true, remainingReferences: 0, blockedByTransferPin: false };
    },
  );
}
