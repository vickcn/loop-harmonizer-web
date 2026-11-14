import type {
  BandSong,
  SeparationFocusSessionSnapshot,
  SeparationFocusSongEntry,
  SeparationStatus,
  SongAudioLoadState,
  SongOperationSnapshot,
  SongPlaybackSource,
  SongPersistenceStatus,
  SongTempoMode,
  StemChannel,
} from "./bandTypes";

export type PersistedStemChannelState = {
  stemType: string;
  volume: number;
  muted: boolean;
  solo: boolean;
};

export type PersistedSongRecord = {
  key: string;
  songId: string;
  audioKey: string;
  sourceAudioHash: string;
  settingsKey: string;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  durationSec: number;
  originalBpm: number;
  targetBpm: number;
  keyShiftSemitones: number;
  tempoMode: SongTempoMode;
  manualRate: number;
  fineRateOffset: number;
  savedRates: number[];
  masterVolume: number;
  muted: boolean;
  loop: boolean;
  selected: boolean;
  playheadSec: number;
  playbackSource: SongPlaybackSource;
  separationMode: "two_stem" | "four_stem" | null;
  separationStatus?: SeparationStatus;
  separationTaskId?: string | null;
  separationCompletedChunks?: number;
  separationTotalChunks?: number;
  separationCommittedBytes?: number;
  separationUserAuthorized?: boolean;
  cacheKey: string | null;
  modelVersion: string;
  processingVersion: string;
  stemChannels: PersistedStemChannelState[];
  revision: number;
  updatedAt: number;
  updatedByTabId: string;
};

export type PersistedSessionMetaRecord = {
  key: "band-session";
  songOrder: string[];
  revision: number;
  updatedAt: number;
  updatedByTabId: string;
};

type CreateBandSongInput = {
  id: string;
  name: string;
  fileName?: string;
  sourceAudioId: string;
  settingsKey?: string;
  originalBpm: number;
  durationSec?: number;
  sourceAudioHash?: string | null;
  fileSizeBytes?: number;
  mimeType?: string;
  fileLastModified?: number;
  persistenceStatus?: SongPersistenceStatus;
  persistenceMessage?: string;
  revision?: number;
  audioLoadState?: SongAudioLoadState;
};

export function createBandSong(input: CreateBandSongInput): BandSong {
  return {
    id: input.id,
    settingsKey: input.settingsKey ?? input.sourceAudioId,
    name: input.name,
    fileName: input.fileName ?? input.name,
    originalBpm: input.originalBpm,
    targetBpm: input.originalBpm,
    keyShiftSemitones: 0,
    tempoMode: "target-bpm",
    manualRate: 1,
    fineRateOffset: 0,
    savedRates: [1],
    masterVolume: 1,
    playheadSec: 0,
    durationSec: input.durationSec ?? 0,
    status: "stopped",
    loop: false,
    muted: false,
    selected: false,
    sourceAudioId: input.sourceAudioId,
    stemIds: [],
    stemChannels: [],
    separationStatus: "not_started",
    separationMode: null,
    separationProgress: 0,
    separationMessage: "",
    playbackSource: "original",
    cacheKey: null,
    sourceAudioHash: input.sourceAudioHash ?? null,
    fileSizeBytes: input.fileSizeBytes,
    mimeType: input.mimeType,
    fileLastModified: input.fileLastModified,
    persistenceStatus: input.persistenceStatus ?? "unsaved",
    persistenceMessage: input.persistenceMessage ?? "",
    revision: input.revision ?? 0,
    hasConflict: false,
    audioLoadState: input.audioLoadState ?? "ready",
    activeSnapshot: null,
  };
}

export function getEffectivePlaybackRate(song: Pick<BandSong,
  "tempoMode" | "targetBpm" | "originalBpm" | "manualRate" | "fineRateOffset"
>): number {
  const coarse = song.tempoMode === "manual-rate"
    ? song.manualRate
    : song.targetBpm / Math.max(1, song.originalBpm);
  return Math.max(0.25, Math.min(4, coarse + song.fineRateOffset));
}

export function getSongPlaybackTrackIds(song: Pick<BandSong, "playbackSource" | "sourceAudioId" | "stemIds">): string[] {
  return song.playbackSource === "stems" && song.stemIds.length > 0
    ? [...song.stemIds]
    : [song.sourceAudioId];
}

export function getStemAudibility(channels: Array<Pick<StemChannel, "id" | "muted" | "solo">>): Record<string, boolean> {
  const hasSolo = channels.some((channel) => channel.solo);
  return Object.fromEntries(channels.map((channel) => [
    channel.id,
    !channel.muted && (!hasSolo || channel.solo),
  ]));
}

export function serializeSongSettings(song: BandSong) {
  return {
    songId: song.id,
    targetBpm: song.targetBpm,
    keyShiftSemitones: song.keyShiftSemitones,
    masterVolume: song.masterVolume,
    tempoMode: song.tempoMode,
    manualRate: song.manualRate,
    fineRateOffset: song.fineRateOffset,
    savedRates: [...song.savedRates],
    loop: song.loop,
    separationMode: song.separationMode,
    stemVolumes: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.volume])),
    stemMuted: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.muted])),
    stemSolo: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.solo])),
  };
}

export function reorderSongList<T extends { id: string }>(songs: readonly T[], fromId: string, toId: string): T[] {
  if (fromId === toId) return [...songs];
  const list = [...songs];
  const from = list.findIndex((song) => song.id === fromId);
  const to = list.findIndex((song) => song.id === toId);
  if (from < 0 || to < 0) return [...songs];
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return list;
}

export function clampBpmValue(value: number): number {
  return Math.max(20, Math.min(300, Math.round(Number.isFinite(value) ? value : 120)));
}

export function sanitizeSongSavedRates(savedRates: unknown): number[] {
  if (!Array.isArray(savedRates)) return [1];
  const valid = savedRates
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0.25 && value <= 4);
  if (!valid.includes(1)) valid.unshift(1);
  return [...new Set(valid)].sort((a, b) => a - b);
}

export function serializePersistedSong(
  song: BandSong,
  meta: {
    audioKey: string;
    sourceAudioHash: string;
    modelVersion: string;
    processingVersion: string;
    revision: number;
    updatedAt: number;
    updatedByTabId: string;
  },
): PersistedSongRecord {
  return {
    key: song.id,
    songId: song.id,
    audioKey: meta.audioKey,
    sourceAudioHash: meta.sourceAudioHash,
    settingsKey: song.settingsKey,
    name: song.name,
    fileName: song.fileName,
    mimeType: song.mimeType ?? "",
    sizeBytes: song.fileSizeBytes ?? 0,
    lastModified: song.fileLastModified ?? 0,
    durationSec: Number.isFinite(song.durationSec) && song.durationSec >= 0 ? song.durationSec : 0,
    originalBpm: clampBpmValue(song.originalBpm),
    targetBpm: clampBpmValue(song.targetBpm),
    keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(song.keyShiftSemitones || 0))),
    tempoMode: song.tempoMode === "manual-rate" ? "manual-rate" : "target-bpm",
    manualRate: Math.max(0.25, Math.min(4, Number.isFinite(song.manualRate) ? song.manualRate : 1)),
    fineRateOffset: Math.max(-0.05, Math.min(0.05, Number.isFinite(song.fineRateOffset) ? song.fineRateOffset : 0)),
    savedRates: sanitizeSongSavedRates(song.savedRates),
    masterVolume: Math.max(0, Math.min(1, Number.isFinite(song.masterVolume) ? song.masterVolume : 1)),
    muted: Boolean(song.muted),
    loop: Boolean(song.loop),
    selected: Boolean(song.selected),
    playheadSec: Math.max(0, Number.isFinite(song.playheadSec) ? song.playheadSec : 0),
    playbackSource: song.playbackSource === "stems" ? "stems" : "original",
    separationMode: song.separationMode ?? null,
    separationStatus: song.separationStatus,
    separationTaskId: song.separationTaskId ?? null,
    separationCompletedChunks: song.separationCompletedChunks ?? 0,
    separationTotalChunks: song.separationTotalChunks ?? 0,
    separationCommittedBytes: song.separationCommittedBytes ?? 0,
    separationUserAuthorized: Boolean(song.separationUserAuthorized),
    cacheKey: song.cacheKey ?? null,
    modelVersion: meta.modelVersion,
    processingVersion: meta.processingVersion,
    stemChannels: song.stemChannels.map((channel) => ({
      stemType: channel.stemType,
      volume: Math.max(0, Math.min(1, Number.isFinite(channel.volume) ? channel.volume : 1)),
      muted: Boolean(channel.muted),
      solo: Boolean(channel.solo),
    })),
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    updatedByTabId: meta.updatedByTabId,
  };
}

export function restoreBandSongFromRecord(
  record: PersistedSongRecord,
  options?: {
    sourceAudioId?: string;
    durationSec?: number;
    persistenceStatus?: SongPersistenceStatus;
    persistenceMessage?: string;
    audioLoadState?: SongAudioLoadState;
  },
): BandSong {
  const duration = options?.durationSec ?? record.durationSec ?? 0;
  const maxPlayhead = duration > 0 ? duration : Math.max(0, record.playheadSec || 0);
  const clampedPlayhead = Math.max(0, Math.min(maxPlayhead, Number.isFinite(record.playheadSec) ? record.playheadSec : 0));
  const song = createBandSong({
    id: record.songId,
    name: record.name,
    fileName: record.fileName,
    sourceAudioId: options?.sourceAudioId ?? `${record.songId}_original`,
    settingsKey: record.settingsKey,
    originalBpm: clampBpmValue(record.originalBpm),
    durationSec: duration,
    sourceAudioHash: record.sourceAudioHash,
    fileSizeBytes: record.sizeBytes,
    mimeType: record.mimeType,
    fileLastModified: record.lastModified,
    persistenceStatus: options?.persistenceStatus ?? "saved",
    persistenceMessage: options?.persistenceMessage ?? "",
    revision: record.revision,
    audioLoadState: options?.audioLoadState ?? "ready",
  });

  const restoredChannels: StemChannel[] = Array.isArray(record.stemChannels)
    ? record.stemChannels.map((ch) => ({
      id: `${record.songId}_stem_${ch.stemType}`,
      songId: record.songId,
      stemType: ch.stemType,
      volume: Math.max(0, Math.min(1, Number.isFinite(ch.volume) ? ch.volume : 1)),
      muted: Boolean(ch.muted),
      solo: Boolean(ch.solo),
    }))
    : [];

  return {
    ...song,
    targetBpm: clampBpmValue(record.targetBpm),
    keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(record.keyShiftSemitones || 0))),
    tempoMode: record.tempoMode === "manual-rate" ? "manual-rate" : "target-bpm",
    manualRate: Math.max(0.25, Math.min(4, Number.isFinite(record.manualRate) ? record.manualRate : 1)),
    fineRateOffset: Math.max(-0.05, Math.min(0.05, Number.isFinite(record.fineRateOffset) ? record.fineRateOffset : 0)),
    savedRates: sanitizeSongSavedRates(record.savedRates),
    masterVolume: Math.max(0, Math.min(1, Number.isFinite(record.masterVolume) ? record.masterVolume : 1)),
    muted: Boolean(record.muted),
    loop: Boolean(record.loop),
    selected: Boolean(record.selected),
    playheadSec: clampedPlayhead,
    // 恢復工作階段後絕不自動播放
    status: clampedPlayhead > 0.01 ? "paused" : "stopped",
    // 在分軌 AudioBuffer 實際掛載前先保持 original，待分離快取載入成功再切換為紀錄中的來源
    playbackSource: "original",
    separationMode: record.separationMode ?? null,
    // 若頁面重整或瀏覽器中止前尚處於 processing/cancelling，恢復時轉為 interrupted 避免誤顯示進行中
    separationStatus:
      record.separationStatus === "processing" || record.separationStatus === "cancelling"
        ? "interrupted"
        : (record.separationStatus ?? "not_started"),
    separationTaskId: record.separationTaskId ?? null,
    separationCompletedChunks: record.separationCompletedChunks ?? 0,
    separationTotalChunks: record.separationTotalChunks ?? 0,
    separationCommittedBytes: record.separationCommittedBytes ?? 0,
    separationUserAuthorized: Boolean(record.separationUserAuthorized),
    cacheKey: record.cacheKey ?? null,
    stemChannels: restoredChannels,
  };
}

export function sortPersistedSongsByOrder(
  records: readonly PersistedSongRecord[],
  songOrder: readonly string[],
): PersistedSongRecord[] {
  const rank = new Map(songOrder.map((id, index) => [id, index]));
  return [...records].sort((a, b) => {
    const rankA = rank.get(a.songId);
    const rankB = rank.get(b.songId);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.updatedAt - b.updatedAt;
  });
}

export function findUnreferencedAudioKeys(
  audioKeys: readonly string[],
  remainingSongs: ReadonlyArray<{ audioKey?: string | null; sourceAudioHash?: string | null }>,
): string[] {
  const referenced = new Set<string>();
  for (const song of remainingSongs) {
    if (song.audioKey) referenced.add(song.audioKey);
    if (song.sourceAudioHash) referenced.add(song.sourceAudioHash);
  }
  return audioKeys.filter((key) => !referenced.has(key));
}

export function createSongOperationSnapshot(
  song: BandSong,
  reason = "執行高負載操作前快照",
): SongOperationSnapshot {
  return {
    snapshotId: `snap_${song.id}_${Date.now()}`,
    createdAt: Date.now(),
    reason,
    songId: song.id,
    playbackSource: song.playbackSource,
    separationStatus: song.separationStatus === "processing" || song.separationStatus === "cancelling"
      ? (song.cacheKey ? "completed" : "not_started")
      : song.separationStatus,
    separationMode: song.separationMode,
    cacheKey: song.cacheKey,
    targetBpm: song.targetBpm,
    tempoMode: song.tempoMode,
    manualRate: song.manualRate,
    fineRateOffset: song.fineRateOffset,
    keyShiftSemitones: song.keyShiftSemitones,
    masterVolume: song.masterVolume,
    playheadSec: song.playheadSec,
    stemChannels: song.stemChannels.map((ch) => ({ ...ch })),
  };
}

export function applySongOperationSnapshot(
  song: BandSong,
  snapshot: SongOperationSnapshot,
): BandSong {
  if (snapshot.songId !== song.id) return song;
  const restoredSource: SongPlaybackSource =
    snapshot.playbackSource === "stems" && song.stemIds.length > 0 ? "stems" : "original";
  return {
    ...song,
    playbackSource: restoredSource,
    separationStatus: snapshot.separationStatus,
    separationMode: snapshot.separationMode,
    cacheKey: snapshot.cacheKey,
    targetBpm: snapshot.targetBpm,
    tempoMode: snapshot.tempoMode,
    manualRate: snapshot.manualRate,
    fineRateOffset: snapshot.fineRateOffset,
    keyShiftSemitones: snapshot.keyShiftSemitones,
    masterVolume: snapshot.masterVolume,
    playheadSec: snapshot.playheadSec,
    stemChannels: snapshot.stemChannels.map((ch) => ({ ...ch })),
    separationProgress: 0,
    separationStage: "idle",
  };
}

export function createSeparationFocusSessionSnapshot(
  songs: readonly BandSong[],
  targetSongId: string,
  reasons: readonly string[],
  playheadOverrides?: Record<string, number>,
): SeparationFocusSessionSnapshot {
  const target = songs.find((item) => item.id === targetSongId);
  const pausedSongIds: string[] = [];
  const entries: SeparationFocusSongEntry[] = songs.map((song) => {
    const playhead = playheadOverrides && Number.isFinite(playheadOverrides[song.id])
      ? Math.max(0, playheadOverrides[song.id])
      : song.playheadSec;
    const wasPlaying = song.status === "playing";
    if (wasPlaying) {
      pausedSongIds.push(song.id);
    }
    const baseSnapshot = createSongOperationSnapshot(song, "分離專注模式前工作階段快照");
    return {
      songId: song.id,
      songName: song.name,
      wasPlaying,
      previousStatus: song.status,
      playheadSec: playhead,
      snapshot: {
        ...baseSnapshot,
        playheadSec: playhead,
      },
    };
  });

  return {
    focusId: `focus_${targetSongId}_${Date.now()}`,
    targetSongId,
    targetSongName: target?.name ?? "",
    createdAt: Date.now(),
    reasons: [...reasons],
    pausedSongIds,
    entries,
  };
}

export function restoreSongsAfterSeparationFocus(
  songs: readonly BandSong[],
  focusSnapshot: SeparationFocusSessionSnapshot,
  options: { outcome: "completed" | "paused" | "cancelled" | "failed" },
): BandSong[] {
  const entryMap = new Map(focusSnapshot.entries.map((entry) => [entry.songId, entry]));

  return songs.map((song) => {
    const entry = entryMap.get(song.id);
    if (!entry) {
      return song.status === "playing" ? { ...song, status: "paused" } : song;
    }

    const safeStatus = entry.wasPlaying || entry.previousStatus === "playing"
      ? "paused"
      : entry.previousStatus;

    if (
      song.id === focusSnapshot.targetSongId &&
      (options.outcome === "cancelled" || options.outcome === "paused" || options.outcome === "failed")
    ) {
      const reverted = applySongOperationSnapshot(song, entry.snapshot);
      const hasChunks = (song.separationCompletedChunks ?? 0) > 0 && (song.separationTotalChunks ?? 0) > 0;
      const chunkProgress = hasChunks
        ? (song.separationCompletedChunks ?? 0) / Math.max(1, song.separationTotalChunks ?? 1)
        : 0;
      return {
        ...reverted,
        status: safeStatus,
        playheadSec: entry.playheadSec,
        separationStatus: options.outcome,
        separationStage: options.outcome,
        separationProgress: hasChunks ? chunkProgress : 0,
        separationMessage: song.separationMessage,
        separationTaskId: song.separationTaskId,
        separationCompletedChunks: song.separationCompletedChunks,
        separationTotalChunks: song.separationTotalChunks,
        separationCommittedBytes: song.separationCommittedBytes,
        separationUserAuthorized:
          options.outcome === "cancelled" ? false : song.separationUserAuthorized,
      };
    }

    return {
      ...song,
      status: safeStatus,
      playheadSec: entry.playheadSec,
      targetBpm: entry.snapshot.targetBpm,
      tempoMode: entry.snapshot.tempoMode,
      manualRate: entry.snapshot.manualRate,
      fineRateOffset: entry.snapshot.fineRateOffset,
      keyShiftSemitones: entry.snapshot.keyShiftSemitones,
      masterVolume: entry.snapshot.masterVolume,
      stemChannels:
        song.id === focusSnapshot.targetSongId && options.outcome === "completed"
          ? song.stemChannels
          : entry.snapshot.stemChannels.map((ch) => ({ ...ch })),
    };
  });
}

export function findUnusedSeparationRecordKeys(
  separations: ReadonlyArray<{ key: string; sourceAudioHash: string }>,
  activeSongs: ReadonlyArray<{
    sourceAudioHash?: string | null;
    cacheKey?: string | null;
    activeSnapshot?: { cacheKey?: string | null } | null;
  }>,
): string[] {
  const activeHashes = new Set<string>();
  const activeCacheKeys = new Set<string>();
  for (const song of activeSongs) {
    if (song.sourceAudioHash) activeHashes.add(song.sourceAudioHash);
    if (song.cacheKey) activeCacheKeys.add(song.cacheKey);
    if (song.activeSnapshot?.cacheKey) activeCacheKeys.add(song.activeSnapshot.cacheKey);
  }
  return separations
    .filter((record) => !activeHashes.has(record.sourceAudioHash) && !activeCacheKeys.has(record.key))
    .map((record) => record.key);
}

export function detectSongRevisionConflict(params: {
  existingRevision: number | null;
  existingUpdatedByTabId: string | null;
  expectedRevision?: number;
  currentTabId: string;
  force?: boolean;
}): boolean {
  if (params.force) return false;
  if (params.existingRevision === null || params.expectedRevision === undefined) return false;
  return (
    params.existingRevision > params.expectedRevision
    && params.existingUpdatedByTabId !== null
    && params.existingUpdatedByTabId !== params.currentTabId
  );
}

export function isStorageQuotaLow(usage: number | null, quota: number | null): boolean {
  if (usage === null || quota === null || quota <= 0) return false;
  const remaining = quota - usage;
  return usage / quota >= 0.85 || remaining < 50 * 1024 * 1024;
}
