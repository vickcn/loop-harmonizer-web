import type { BandSong, SeparationStatus } from "../band/bandTypes.ts";
import {
  detectSongRevisionConflict,
  findUnreferencedAudioKeys,
  findUnusedSeparationRecordKeys,
  isStorageQuotaLow,
  serializePersistedSong,
  sortPersistedSongsByOrder,
  type PersistedSessionMetaRecord,
  type PersistedSongRecord,
  type PersistedStemChannelState,
} from "../band/songModel.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "./cacheKeys.ts";
import { idbGetAll, idbRequestPromise, withIdbTransaction } from "./indexedDb.ts";
import { getModelCacheMetadata } from "./modelCache.ts";
import type { StemCacheRecord } from "./separationCacheRecord.ts";
import {
  releaseCheckpointReferenceAndMaybeGc,
  runCheckpointGarbageCollection,
} from "./separationCheckpointStore.ts";
import { canTransitionSeparationStatus } from "../separation/separationStateRecovery.ts";

const SESSION_META_KEY = "band-session" as const;
const SYNC_CHANNEL_NAME = "loop-harmonizer-band-sync";

export type PersistedAudioFileRecord = {
  key: string;
  sourceAudioHash: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  createdAt: number;
};

export type StorageStatsSummary = {
  audioBytes: number;
  stemBytes: number;
  modelBytes: number;
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  isLowStorage: boolean;
};

export type SaveSongResult =
  | { ok: true; record: PersistedSongRecord }
  | { ok: false; reason: "conflict"; serverRecord: PersistedSongRecord }
  | { ok: false; reason: "error"; message: string; isQuotaError: boolean };

export type RemoveSongStorageResult = {
  deletedAudioFile: boolean;
  deletedSeparationCount: number;
  sharedWithOtherSongs: boolean;
};

export type BandSyncMessage =
  | { type: "song-added"; tabId: string; songId: string; record: PersistedSongRecord; songOrder: string[] }
  | { type: "song-updated"; tabId: string; songId: string; record: PersistedSongRecord }
  | { type: "order-updated"; tabId: string; songOrder: string[] }
  | { type: "song-removed"; tabId: string; songId: string; songOrder: string[] };

let cachedTabId: string | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

export function getTabSyncId(): string {
  if (cachedTabId) return cachedTabId;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    cachedTabId = crypto.randomUUID();
  } else {
    cachedTabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return cachedTabId;
}

function enqueueDbWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
  }
  if (error instanceof Error) {
    return /quota|storage|空間不足/i.test(error.message);
  }
  return false;
}

export function describePersistenceError(error: unknown): string {
  if (isQuotaExceededError(error)) {
    return "瀏覽器儲存空間不足，目前僅暫存於此工作階段，重新整理後可能遺失。";
  }
  const detail = error instanceof Error ? error.message : "";
  return detail
    ? `無法寫入本機資料庫（${detail}），重新整理後可能遺失。`
    : "無法寫入本機資料庫，目前僅暫存於此工作階段，重新整理後可能遺失。";
}

function postSyncMessage(message: BandSyncMessage): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // 忽略跨分頁廣播不可用環境
  }
}

export function subscribeBandSync(handler: (message: BandSyncMessage) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    const currentTabId = getTabSyncId();
    channel.onmessage = (event: MessageEvent<BandSyncMessage>) => {
      const payload = event.data;
      if (!payload || payload.tabId === currentTabId) return;
      handler(payload);
    };
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      channel?.close();
    } catch {
      // ignore
    }
  };
}

export async function requestPersistentStorage(): Promise<{ supported: boolean; persisted: boolean }> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return { supported: false, persisted: false };
  }
  try {
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: granted };
  } catch {
    return { supported: true, persisted: false };
  }
}

export async function getStorageStatsSummary(): Promise<StorageStatsSummary> {
  const estimatePromise = typeof navigator !== "undefined" && navigator.storage?.estimate
    ? navigator.storage.estimate().catch(() => null)
    : Promise.resolve(null);
  const persistedPromise = typeof navigator !== "undefined" && navigator.storage?.persisted
    ? navigator.storage.persisted().catch(() => null)
    : Promise.resolve(null);

  const [audioRecords, stemRecords, modelMeta, estimate, persisted] = await Promise.all([
    idbGetAll<PersistedAudioFileRecord>("audioFiles").catch(() => [] as PersistedAudioFileRecord[]),
    idbGetAll<StemCacheRecord>("separations").catch(() => [] as StemCacheRecord[]),
    getModelCacheMetadata().catch(() => null),
    estimatePromise,
    persistedPromise,
  ]);

  const audioBytes = audioRecords.reduce((sum, item) => sum + (item.sizeBytes || item.blob?.size || 0), 0);
  const stemBytes = stemRecords.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  const modelBytes = modelMeta?.sizeBytes ?? 0;
  const usage = typeof estimate?.usage === "number" ? estimate.usage : null;
  const quota = typeof estimate?.quota === "number" ? estimate.quota : null;

  return {
    audioBytes,
    stemBytes,
    modelBytes,
    usage,
    quota,
    persisted,
    isLowStorage: isStorageQuotaLow(usage, quota),
  };
}

export async function loadPersistedBandSession(): Promise<{
  songs: PersistedSongRecord[];
  songOrder: string[];
  audioFilesByKey: Map<string, PersistedAudioFileRecord>;
  sessionRevision: number;
}> {
  return withIdbTransaction(["songs", "sessionMeta", "audioFiles"], "readonly", async (tx) => {
    const songsStore = tx.objectStore("songs");
    const metaStore = tx.objectStore("sessionMeta");
    const audioStore = tx.objectStore("audioFiles");

    const [songRecords, sessionMeta, audioRecords] = await Promise.all([
      idbRequestPromise<PersistedSongRecord[]>(songsStore.getAll()),
      idbRequestPromise<PersistedSessionMetaRecord | undefined>(metaStore.get(SESSION_META_KEY)),
      idbRequestPromise<PersistedAudioFileRecord[]>(audioStore.getAll()),
    ]);

    const songOrder = Array.isArray(sessionMeta?.songOrder) ? sessionMeta.songOrder : [];
    const sortedSongs = sortPersistedSongsByOrder(songRecords, songOrder);
    const audioFilesByKey = new Map<string, PersistedAudioFileRecord>(
      audioRecords.map((record) => [record.key, record]),
    );

    return {
      songs: sortedSongs,
      songOrder,
      audioFilesByKey,
      sessionRevision: sessionMeta?.revision ?? 0,
    };
  });
}

export async function getPersistedAudioBlobByKey(audioKey: string): Promise<PersistedAudioFileRecord | null> {
  if (!audioKey) return null;
  return withIdbTransaction(["audioFiles"], "readonly", async (tx) => {
    const record = await idbRequestPromise<PersistedAudioFileRecord | undefined>(
      tx.objectStore("audioFiles").get(audioKey),
    );
    return record ?? null;
  });
}

export async function getPersistedSongWithAudio(songId: string): Promise<{
  song: PersistedSongRecord | null;
  audio: PersistedAudioFileRecord | null;
}> {
  return withIdbTransaction(["songs", "audioFiles"], "readonly", async (tx) => {
    const song = (await idbRequestPromise<PersistedSongRecord | undefined>(
      tx.objectStore("songs").get(songId),
    )) ?? null;
    if (!song) return { song: null, audio: null };
    const audio = (await idbRequestPromise<PersistedAudioFileRecord | undefined>(
      tx.objectStore("audioFiles").get(song.audioKey),
    )) ?? null;
    return { song, audio };
  });
}

export async function getPersistedSongRecord(songId: string): Promise<PersistedSongRecord | null> {
  if (!songId) return null;
  return withIdbTransaction(["songs"], "readonly", async (tx) => {
    const song = await idbRequestPromise<PersistedSongRecord | undefined>(
      tx.objectStore("songs").get(songId),
    );
    return song ?? null;
  });
}

export async function getAllPersistedSongRecords(): Promise<PersistedSongRecord[]> {
  return idbGetAll<PersistedSongRecord>("songs").catch(() => []);
}

export type SeparationSongRecordPatch = {
  separationMode?: "two_stem" | "four_stem" | null;
  separationStatus?: SeparationStatus;
  separationTaskId?: string | null;
  separationCompletedChunks?: number;
  separationTotalChunks?: number;
  separationCommittedBytes?: number;
  separationUserAuthorized?: boolean;
  cacheKey?: string | null;
  playbackSource?: "original" | "stems";
  ensureStemRoles?: readonly string[];
  allowResetCompleted?: boolean;
  allowChunkRegression?: boolean;
};

/**
 * 僅在資料層以欄位級合併更新歌曲的分軌持久化欄位，完整保留使用者在背景分軌期間
 * 修改的 targetBpm、keyShiftSemitones、音量、Loop 與分軌混音設定，絕不以過期快照覆寫。
 */
export async function patchPersistedSongSeparationFields(
  songId: string,
  patch: SeparationSongRecordPatch,
): Promise<PersistedSongRecord | null> {
  if (!songId) return null;
  const tabId = getTabSyncId();
  return enqueueDbWrite(async () => {
    const outcome = await withIdbTransaction(["songs"], "readwrite", async (tx) => {
      const songsStore = tx.objectStore("songs");
      const existing = await idbRequestPromise<PersistedSongRecord | undefined>(songsStore.get(songId));
      if (!existing) return { updated: false as const, record: null };

      const currentStatus: SeparationStatus = existing.separationStatus ?? "not_started";
      if (
        patch.separationStatus &&
        !canTransitionSeparationStatus(currentStatus, patch.separationStatus, {
          allowResetCompleted: patch.allowResetCompleted,
        })
      ) {
        return { updated: false as const, record: existing };
      }

      const nextTaskId =
        patch.separationTaskId !== undefined ? patch.separationTaskId : existing.separationTaskId ?? null;
      const sameTask = Boolean(nextTaskId && existing.separationTaskId === nextTaskId);

      let nextCompletedChunks =
        patch.separationCompletedChunks !== undefined
          ? patch.separationCompletedChunks
          : existing.separationCompletedChunks ?? 0;
      let nextCommittedBytes =
        patch.separationCommittedBytes !== undefined
          ? patch.separationCommittedBytes
          : existing.separationCommittedBytes ?? 0;

      if (
        sameTask &&
        !patch.allowResetCompleted &&
        !patch.allowChunkRegression &&
        patch.separationStatus !== "not_started" &&
        patch.separationStatus !== "cancelled"
      ) {
        nextCompletedChunks = Math.max(existing.separationCompletedChunks ?? 0, nextCompletedChunks);
        nextCommittedBytes = Math.max(existing.separationCommittedBytes ?? 0, nextCommittedBytes);
      }

      let nextStemChannels: PersistedStemChannelState[] = existing.stemChannels;
      if (patch.ensureStemRoles && patch.ensureStemRoles.length > 0) {
        nextStemChannels = patch.ensureStemRoles.map((role) => {
          const prev = existing.stemChannels.find((ch) => ch.stemType === role);
          return prev
            ? { ...prev }
            : { stemType: role, volume: 1, muted: false, solo: false };
        });
      }

      const nextRecord: PersistedSongRecord = {
        ...existing,
        separationMode:
          patch.separationMode !== undefined ? patch.separationMode : existing.separationMode,
        separationStatus: patch.separationStatus ?? existing.separationStatus,
        separationTaskId: nextTaskId,
        separationCompletedChunks: nextCompletedChunks,
        separationTotalChunks:
          patch.separationTotalChunks !== undefined
            ? patch.separationTotalChunks
            : existing.separationTotalChunks,
        separationCommittedBytes: nextCommittedBytes,
        separationUserAuthorized:
          patch.separationUserAuthorized !== undefined
            ? patch.separationUserAuthorized
            : existing.separationUserAuthorized,
        cacheKey: patch.cacheKey !== undefined ? patch.cacheKey : existing.cacheKey,
        playbackSource: patch.playbackSource ?? existing.playbackSource,
        stemChannels: nextStemChannels,
        revision: (existing.revision ?? 0) + 1,
        updatedAt: Date.now(),
        updatedByTabId: tabId,
      };

      await idbRequestPromise(songsStore.put(nextRecord));
      return { updated: true as const, record: nextRecord };
    });

    if (outcome.updated && outcome.record) {
      postSyncMessage({
        type: "song-updated",
        tabId,
        songId,
        record: outcome.record,
      });
    }
    return outcome.record;
  });
}

export function buildSongRecordFromSong(
  song: BandSong,
  sourceAudioHash: string,
  revision: number,
): PersistedSongRecord {
  return serializePersistedSong(song, {
    audioKey: sourceAudioHash,
    sourceAudioHash,
    modelVersion: DEMUCS_MODEL_VERSION,
    processingVersion: SEPARATION_PROCESSING_VERSION,
    revision,
    updatedAt: Date.now(),
    updatedByTabId: getTabSyncId(),
  });
}

export async function saveSongWithAudioFile(input: {
  song: BandSong;
  file: Blob;
  sourceAudioHash: string;
  force?: boolean;
}): Promise<SaveSongResult> {
  const tabId = getTabSyncId();
  return enqueueDbWrite(async () => {
    try {
      const outcome = await withIdbTransaction(["audioFiles", "songs", "sessionMeta"], "readwrite", async (tx) => {
        const audioStore = tx.objectStore("audioFiles");
        const songsStore = tx.objectStore("songs");
        const metaStore = tx.objectStore("sessionMeta");

        const existingAudio = await idbRequestPromise<PersistedAudioFileRecord | undefined>(
          audioStore.get(input.sourceAudioHash),
        );
        // 以內容雜湊去重，相同音檔 Blob 不重複寫入
        if (!existingAudio) {
          const audioRecord: PersistedAudioFileRecord = {
            key: input.sourceAudioHash,
            sourceAudioHash: input.sourceAudioHash,
            blob: input.file,
            fileName: input.song.fileName,
            mimeType: input.song.mimeType ?? input.file.type ?? "",
            sizeBytes: input.song.fileSizeBytes ?? input.file.size,
            lastModified: input.song.fileLastModified ?? Date.now(),
            createdAt: Date.now(),
          };
          await idbRequestPromise(audioStore.put(audioRecord));
        }

        const existingSong = await idbRequestPromise<PersistedSongRecord | undefined>(
          songsStore.get(input.song.id),
        );
        if (
          existingSong
          && detectSongRevisionConflict({
            existingRevision: existingSong.revision,
            existingUpdatedByTabId: existingSong.updatedByTabId,
            expectedRevision: input.song.revision,
            currentTabId: tabId,
            force: input.force,
          })
        ) {
          return { conflict: true as const, serverRecord: existingSong };
        }

        const nextRevision = Math.max(existingSong?.revision ?? 0, input.song.revision ?? 0) + 1;
        const record = serializePersistedSong(input.song, {
          audioKey: input.sourceAudioHash,
          sourceAudioHash: input.sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          processingVersion: SEPARATION_PROCESSING_VERSION,
          revision: nextRevision,
          updatedAt: Date.now(),
          updatedByTabId: tabId,
        });
        await idbRequestPromise(songsStore.put(record));

        const existingMeta = await idbRequestPromise<PersistedSessionMetaRecord | undefined>(
          metaStore.get(SESSION_META_KEY),
        );
        const currentOrder = Array.isArray(existingMeta?.songOrder) ? [...existingMeta.songOrder] : [];
        if (!currentOrder.includes(input.song.id)) currentOrder.push(input.song.id);
        const nextMeta: PersistedSessionMetaRecord = {
          key: SESSION_META_KEY,
          songOrder: currentOrder,
          revision: (existingMeta?.revision ?? 0) + 1,
          updatedAt: Date.now(),
          updatedByTabId: tabId,
        };
        await idbRequestPromise(metaStore.put(nextMeta));

        return {
          conflict: false as const,
          isNew: !existingSong,
          record,
          songOrder: currentOrder,
        };
      });

      if (outcome.conflict) {
        return { ok: false, reason: "conflict", serverRecord: outcome.serverRecord };
      }

      postSyncMessage(
        outcome.isNew
          ? { type: "song-added", tabId, songId: input.song.id, record: outcome.record, songOrder: outcome.songOrder }
          : { type: "song-updated", tabId, songId: input.song.id, record: outcome.record },
      );

      return { ok: true, record: outcome.record };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        message: describePersistenceError(error),
        isQuotaError: isQuotaExceededError(error),
      };
    }
  });
}

export async function saveSongStateRecord(
  song: BandSong,
  options?: { force?: boolean },
): Promise<SaveSongResult> {
  if (!song.sourceAudioHash) {
    return {
      ok: false,
      reason: "error",
      message: "尚未建立音檔雜湊識別，請重試儲存或重新匯入音檔。",
      isQuotaError: false,
    };
  }
  const sourceAudioHash = song.sourceAudioHash;
  const tabId = getTabSyncId();
  return enqueueDbWrite(async () => {
    try {
      const outcome = await withIdbTransaction(["songs", "sessionMeta"], "readwrite", async (tx) => {
        const songsStore = tx.objectStore("songs");
        const metaStore = tx.objectStore("sessionMeta");

        const existing = await idbRequestPromise<PersistedSongRecord | undefined>(songsStore.get(song.id));
        if (
          existing
          && detectSongRevisionConflict({
            existingRevision: existing.revision,
            existingUpdatedByTabId: existing.updatedByTabId,
            expectedRevision: song.revision,
            currentTabId: tabId,
            force: options?.force,
          })
        ) {
          return { conflict: true as const, serverRecord: existing };
        }

        const nextRevision = Math.max(existing?.revision ?? 0, song.revision ?? 0) + 1;
        const record = serializePersistedSong(song, {
          audioKey: sourceAudioHash,
          sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          processingVersion: SEPARATION_PROCESSING_VERSION,
          revision: nextRevision,
          updatedAt: Date.now(),
          updatedByTabId: tabId,
        });
        await idbRequestPromise(songsStore.put(record));

        const existingMeta = await idbRequestPromise<PersistedSessionMetaRecord | undefined>(
          metaStore.get(SESSION_META_KEY),
        );
        const currentOrder = Array.isArray(existingMeta?.songOrder) ? [...existingMeta.songOrder] : [];
        if (!currentOrder.includes(song.id)) {
          currentOrder.push(song.id);
          await idbRequestPromise(metaStore.put({
            key: SESSION_META_KEY,
            songOrder: currentOrder,
            revision: (existingMeta?.revision ?? 0) + 1,
            updatedAt: Date.now(),
            updatedByTabId: tabId,
          } satisfies PersistedSessionMetaRecord));
        }

        return { conflict: false as const, record };
      });

      if (outcome.conflict) {
        return { ok: false, reason: "conflict", serverRecord: outcome.serverRecord };
      }
      postSyncMessage({ type: "song-updated", tabId, songId: song.id, record: outcome.record });
      return { ok: true, record: outcome.record };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        message: describePersistenceError(error),
        isQuotaError: isQuotaExceededError(error),
      };
    }
  });
}

export async function savePersistedSongOrder(songOrder: readonly string[]): Promise<void> {
  const tabId = getTabSyncId();
  await enqueueDbWrite(async () => {
    const nextOrder = await withIdbTransaction(["sessionMeta", "songs"], "readwrite", async (tx) => {
      const metaStore = tx.objectStore("sessionMeta");
      const songsStore = tx.objectStore("songs");
      const [existingMeta, allSongs] = await Promise.all([
        idbRequestPromise<PersistedSessionMetaRecord | undefined>(metaStore.get(SESSION_META_KEY)),
        idbRequestPromise<PersistedSongRecord[]>(songsStore.getAll()),
      ]);
      const validIds = new Set(allSongs.map((item) => item.songId));
      const mergedOrder = songOrder.filter((id) => validIds.has(id));
      for (const item of allSongs) {
        if (!mergedOrder.includes(item.songId)) mergedOrder.push(item.songId);
      }
      const nextMeta: PersistedSessionMetaRecord = {
        key: SESSION_META_KEY,
        songOrder: mergedOrder,
        revision: (existingMeta?.revision ?? 0) + 1,
        updatedAt: Date.now(),
        updatedByTabId: tabId,
      };
      await idbRequestPromise(metaStore.put(nextMeta));
      return mergedOrder;
    });
    postSyncMessage({ type: "order-updated", tabId, songOrder: nextOrder });
  }).catch(() => undefined);
}

export async function removePersistedSong(input: {
  song: BandSong;
  deleteLocalData: boolean;
  inMemoryRemainingSongs?: readonly BandSong[];
}): Promise<RemoveSongStorageResult> {
  cancelPendingSongPersist(input.song.id);
  const tabId = getTabSyncId();
  return enqueueDbWrite(async () => {
    const res = await withIdbTransaction(
      ["songs", "sessionMeta", "audioFiles", "separations", "settings"],
      "readwrite",
      async (tx) => {
        const songsStore = tx.objectStore("songs");
        const metaStore = tx.objectStore("sessionMeta");
        const audioStore = tx.objectStore("audioFiles");
        const separationsStore = tx.objectStore("separations");
        const settingsStore = tx.objectStore("settings");

        const existingRecord = await idbRequestPromise<PersistedSongRecord | undefined>(
          songsStore.get(input.song.id),
        );
        const targetAudioHash = existingRecord?.sourceAudioHash ?? input.song.sourceAudioHash ?? null;
        const targetTaskId = existingRecord?.separationTaskId ?? input.song.separationTaskId ?? null;
        const targetCacheKey = existingRecord?.cacheKey ?? input.song.cacheKey ?? null;

        await idbRequestPromise(songsStore.delete(input.song.id));

        const existingMeta = await idbRequestPromise<PersistedSessionMetaRecord | undefined>(
          metaStore.get(SESSION_META_KEY),
        );
        const nextOrder = (existingMeta?.songOrder ?? []).filter((id) => id !== input.song.id);
        await idbRequestPromise(metaStore.put({
          key: SESSION_META_KEY,
          songOrder: nextOrder,
          revision: (existingMeta?.revision ?? 0) + 1,
          updatedAt: Date.now(),
          updatedByTabId: tabId,
        } satisfies PersistedSessionMetaRecord));

        const remainingDbSongs = await idbRequestPromise<PersistedSongRecord[]>(songsStore.getAll());
        const remainingAllRefs = [
          ...remainingDbSongs.map((item) => ({
            audioKey: item.audioKey,
            sourceAudioHash: item.sourceAudioHash,
            settingsKey: item.settingsKey,
          })),
          ...(input.inMemoryRemainingSongs ?? [])
            .filter((item) => item.id !== input.song.id)
            .map((item) => ({
              audioKey: item.sourceAudioHash ?? null,
              sourceAudioHash: item.sourceAudioHash ?? null,
              settingsKey: item.settingsKey,
            })),
        ];

        const sharedWithOtherSongs = Boolean(
          targetAudioHash
          && remainingAllRefs.some(
            (ref) => ref.sourceAudioHash === targetAudioHash || ref.audioKey === targetAudioHash,
          ),
        );

        let deletedAudioFile = false;
        let deletedSeparationCount = 0;

        if (input.deleteLocalData && targetAudioHash && !sharedWithOtherSongs) {
          const unusedAudio = findUnreferencedAudioKeys([targetAudioHash], remainingAllRefs);
          if (unusedAudio.includes(targetAudioHash)) {
            await idbRequestPromise(audioStore.delete(targetAudioHash));
            deletedAudioFile = true;
          }
          const allSeparations = await idbRequestPromise<StemCacheRecord[]>(separationsStore.getAll());
          for (const sep of allSeparations) {
            if (sep.sourceAudioHash === targetAudioHash) {
              await idbRequestPromise(separationsStore.delete(sep.key));
              deletedSeparationCount += 1;
            }
          }
          if (!remainingAllRefs.some((ref) => ref.settingsKey === input.song.settingsKey)) {
            await idbRequestPromise(settingsStore.delete(input.song.settingsKey));
          }
        }

        return {
          deletedAudioFile,
          deletedSeparationCount,
          sharedWithOtherSongs,
          nextOrder,
          targetTaskId,
          targetAudioHash,
          targetCacheKey,
        };
      },
    );

    if (input.deleteLocalData && (res.targetTaskId || res.targetAudioHash)) {
      await releaseCheckpointReferenceAndMaybeGc({
        taskId: res.targetTaskId,
        sourceAudioHash: res.targetAudioHash,
        songId: input.song.id,
        cacheKeyToRelease: res.targetCacheKey,
        knownInMemorySongs: input.inMemoryRemainingSongs
          ? [...input.inMemoryRemainingSongs]
          : undefined,
        source: "removePersistedSong",
      }).catch(() => undefined);
    }

    postSyncMessage({
      type: "song-removed",
      tabId,
      songId: input.song.id,
      songOrder: res.nextOrder,
    });

    return {
      deletedAudioFile: res.deletedAudioFile,
      deletedSeparationCount: res.deletedSeparationCount,
      sharedWithOtherSongs: res.sharedWithOtherSongs,
    };
  });
}

export async function clearUnusedSeparationCaches(
  inMemorySongs: readonly BandSong[] = [],
): Promise<{ deletedCount: number; freedBytes: number }> {
  const res = await enqueueDbWrite(() =>
    withIdbTransaction(["songs", "separations"], "readwrite", async (tx) => {
      const songsStore = tx.objectStore("songs");
      const separationsStore = tx.objectStore("separations");
      const [dbSongs, allSeparations] = await Promise.all([
        idbRequestPromise<PersistedSongRecord[]>(songsStore.getAll()),
        idbRequestPromise<StemCacheRecord[]>(separationsStore.getAll()),
      ]);

      const activeRefs = [
        ...dbSongs.map((item) => ({ sourceAudioHash: item.sourceAudioHash, cacheKey: item.cacheKey })),
        ...inMemorySongs.map((item) => ({
          sourceAudioHash: item.sourceAudioHash ?? null,
          cacheKey: item.cacheKey ?? null,
          activeSnapshot: item.activeSnapshot ?? null,
        })),
      ];
      const unusedKeys = new Set(findUnusedSeparationRecordKeys(allSeparations, activeRefs));

      let deletedCount = 0;
      let freedBytes = 0;
      for (const record of allSeparations) {
        if (!unusedKeys.has(record.key)) continue;
        await idbRequestPromise(separationsStore.delete(record.key));
        deletedCount += 1;
        freedBytes += record.sizeBytes || 0;
      }
      return { deletedCount, freedBytes };
    }),
  );
  await runCheckpointGarbageCollection({
    knownInMemorySongs: [...inMemorySongs],
    source: "clearUnusedSeparationCaches",
  }).catch(() => undefined);
  return res;
}

// ── Debounced song settings/state queue ──

type PendingPersistEntry = {
  timer: number;
  getSong: () => BandSong | null;
  onResult: (songId: string, result: SaveSongResult) => void;
};

const pendingSongSaves = new Map<string, PendingPersistEntry>();

export function hasPendingSongPersist(songId: string): boolean {
  return pendingSongSaves.has(songId);
}

export function cancelPendingSongPersist(songId: string): void {
  const existing = pendingSongSaves.get(songId);
  if (existing !== undefined) {
    if (typeof window !== "undefined") window.clearTimeout(existing.timer);
    pendingSongSaves.delete(songId);
  }
}

export function scheduleSongPersist(
  songId: string,
  getSong: () => BandSong | null,
  onResult: (songId: string, result: SaveSongResult) => void,
  delayMs = 300,
): void {
  if (typeof window === "undefined") return;
  const existing = pendingSongSaves.get(songId);
  if (existing !== undefined) window.clearTimeout(existing.timer);

  const timer = window.setTimeout(() => {
    pendingSongSaves.delete(songId);
    const latest = getSong();
    if (!latest || !latest.sourceAudioHash || latest.persistenceStatus === "missing_audio") return;
    void saveSongStateRecord(latest).then((result) => onResult(songId, result));
  }, delayMs);

  pendingSongSaves.set(songId, { timer, getSong, onResult });
}

export async function flushPendingSongPersists(): Promise<void> {
  const entries = [...pendingSongSaves.entries()];
  pendingSongSaves.clear();
  await Promise.all(
    entries.map(async ([songId, entry]) => {
      if (typeof window !== "undefined") window.clearTimeout(entry.timer);
      const latest = entry.getSong();
      if (!latest || !latest.sourceAudioHash || latest.persistenceStatus === "missing_audio") return;
      const result = await saveSongStateRecord(latest);
      entry.onResult(songId, result);
    }),
  );
}
