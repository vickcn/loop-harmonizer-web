"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BandSession, BandSong, SongPlaybackSource, StemChannel } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";
import {
  clampBpmValue,
  createBandSong,
  getEffectivePlaybackRate,
  getSongPlaybackTrackIds,
  getStemAudibility,
  reorderSongList,
  restoreBandSongFromRecord,
  sanitizeSongSavedRates,
  type PersistedSongRecord,
} from "@/lib/band/songModel";
import { MultiTrackEngine } from "@/lib/band/multiTrackEngine";
import { DEMUCS_MODEL_VERSION, disposeStemSeparator, separateAudio } from "@/lib/separation/stemSeparator";
import type { SeparatedStemSet, StemSeparationMode } from "@/lib/separation/stemTypes";
import { encodeStereoWav } from "@/lib/separation/wavEncoder";
import { createSeparationCacheKey, SEPARATION_PROCESSING_VERSION } from "@/lib/storage/cacheKeys";
import { clearAllCachedStemSets, createStemCacheRecord, deleteCachedStemSet, getCachedStemSet, hashSourceAudio, putCachedStemSet } from "@/lib/storage/separationCache";
import { clearModelCache } from "@/lib/storage/modelCache";
import { loadSongSettings, type SavedSongSettings } from "@/lib/storage/songSettings";
import {
  cancelPendingSongPersist,
  clearUnusedSeparationCaches,
  flushPendingSongPersists,
  getPersistedSongWithAudio,
  getStorageStatsSummary,
  hasPendingSongPersist,
  loadPersistedBandSession,
  removePersistedSong,
  requestPersistentStorage,
  savePersistedSongOrder,
  saveSongStateRecord,
  saveSongWithAudioFile,
  scheduleSongPersist,
  subscribeBandSync,
  type BandSyncMessage,
  type PersistedAudioFileRecord,
  type SaveSongResult,
  type StorageStatsSummary,
} from "@/lib/storage/songSessionStore";
import { SongCard } from "./SongCard";
import { IconActionButton } from "./IconActionButton";
import {
  EMPTY_MIXER_SELECTION,
  applyResetKey,
  applyResetMix,
  applyResetSpeed,
  describePlaybackError,
  resolveShortcutAction,
  sanitizeMixerSelection,
  toggleMuteBySelection,
  toggleSoloBySelection,
  type MixerSelection,
} from "@/lib/band/mixerShortcuts";

function clampBpm(value: number): number {
  return clampBpmValue(value);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "不支援";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const INITIAL_STORAGE_STATS: StorageStatsSummary = {
  audioBytes: 0,
  stemBytes: 0,
  modelBytes: 0,
  usage: null,
  quota: null,
  persisted: null,
  isLowStorage: false,
};

export function BandMixer() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [restoringSession, setRestoringSession] = useState(true);
  const [restoringMessage, setRestoringMessage] = useState("正在檢查本機保存的歌曲工作階段…");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selection, setSelection] = useState<MixerSelection>(EMPTY_MIXER_SELECTION);
  const [shortcutHint, setShortcutHint] = useState<string>("");
  const [storageActionMsg, setStorageActionMsg] = useState<string>("");
  const [startingSongIds, setStartingSongIds] = useState<Set<string>>(new Set());
  const [playbackErrors, setPlaybackErrors] = useState<Record<string, string>>({});
  const [cardFeedbacks, setCardFeedbacks] = useState<Record<string, string>>({});
  const [cacheStats, setCacheStats] = useState<StorageStatsSummary>(INITIAL_STORAGE_STATS);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const sessionRef = useRef(session);
  const selectionRef = useRef<MixerSelection>(selection);
  const startingSongIdsRef = useRef<Set<string>>(startingSongIds);
  const hintTimerRef = useRef<number | null>(null);
  const cardFeedbackTimersRef = useRef<Map<string, number>>(new Map());
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const relinkingSongIdRef = useRef<string | null>(null);
  const engineRef = useRef<MultiTrackEngine | null>(null);
  const sourceFilesRef = useRef(new Map<string, File>());
  const stemResultsRef = useRef(new Map<string, SeparatedStemSet>());
  const separationTokensRef = useRef(new Map<string, symbol>());
  const savedSettingsRef = useRef(new Map<string, SavedSongSettings>());
  const restorePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const removedSongIdsRef = useRef<Set<string>>(new Set());
  const lastPlayheadPersistAtRef = useRef<Map<string, number>>(new Map());
  const persistRequestedRef = useRef(false);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      const engine = new MultiTrackEngine();
      engine.onTrackEnded = (trackId) => {
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.map((song) => getSongPlaybackTrackIds(song).includes(trackId)
            ? { ...song, status: "stopped", playheadSec: 0 }
            : song),
        }));
      };
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const refreshCacheStats = useCallback(async () => {
    const stats = await getStorageStatsSummary().catch(() => INITIAL_STORAGE_STATS);
    setCacheStats(stats);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    startingSongIdsRef.current = startingSongIds;
  }, [startingSongIds]);

  const showShortcutHint = useCallback((message: string) => {
    setShortcutHint(message);
    if (hintTimerRef.current !== null) {
      window.clearTimeout(hintTimerRef.current);
    }
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      setShortcutHint("");
    }, 3000);
  }, []);

  const showCardFeedback = useCallback((songId: string, message: string) => {
    setCardFeedbacks((previous) => ({ ...previous, [songId]: message }));
    const existing = cardFeedbackTimersRef.current.get(songId);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      cardFeedbackTimersRef.current.delete(songId);
      setCardFeedbacks((previous) => {
        if (!(songId in previous)) return previous;
        const next = { ...previous };
        delete next[songId];
        return next;
      });
    }, 2600);
    cardFeedbackTimersRef.current.set(songId, timer);
  }, []);

  const patchSongMetadataOnly = useCallback((songId: string, patch: Partial<BandSong>) => {
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => (song.id === songId ? { ...song, ...patch } : song)),
    }));
  }, []);

  const handlePersistResult = useCallback((songId: string, result: SaveSongResult) => {
    if (!sessionRef.current.songs.some((candidate) => candidate.id === songId)) return;
    if (result.ok) {
      patchSongMetadataOnly(songId, {
        revision: result.record.revision,
        persistenceStatus: "saved",
        persistenceMessage: "已保存在此裝置",
        hasConflict: false,
      });
      return;
    }
    if (result.reason === "conflict") {
      patchSongMetadataOnly(songId, {
        hasConflict: true,
        persistenceStatus: "conflict",
        persistenceMessage: "偵測到其他分頁修改了此歌曲，請選擇要載入最新設定或覆蓋。",
      });
      showShortcutHint("偵測到多分頁設定衝突，請在歌曲卡片確認版本。");
      return;
    }
    patchSongMetadataOnly(songId, {
      persistenceStatus: "error",
      persistenceMessage: result.message,
    });
    showShortcutHint(result.message);
    if (result.isQuotaError) {
      void refreshCacheStats();
    }
  }, [patchSongMetadataOnly, refreshCacheStats, showShortcutHint]);

  const persistSongDebounced = useCallback((songId: string, delayMs = 300) => {
    const current = sessionRef.current.songs.find((candidate) => candidate.id === songId);
    if (current?.sourceAudioHash && current.persistenceStatus === "saved") {
      patchSongMetadataOnly(songId, { persistenceStatus: "saving", persistenceMessage: "儲存中…" });
    }
    scheduleSongPersist(
      songId,
      () => sessionRef.current.songs.find((candidate) => candidate.id === songId) ?? null,
      handlePersistResult,
      delayMs,
    );
  }, [handlePersistResult, patchSongMetadataOnly]);

  const applySongToEngine = useCallback((song: BandSong) => {
    const engine = getEngine();
    const allIds = [song.sourceAudioId, ...song.stemIds];
    const rate = getEffectivePlaybackRate(song);
    allIds.forEach((id) => {
      engine.setPlaybackRate(id, rate);
      engine.setPitchSemitones(id, song.keyShiftSemitones);
    });
    engine.setLoop(song.sourceAudioId, song.loop);
    engine.setLoopGroup(song.stemIds, song.loop);
    const isSongMuted = Boolean(song.muted);
    engine.setVolume(song.sourceAudioId, song.masterVolume);
    engine.setMuted(song.sourceAudioId, isSongMuted);
    const audibility = getStemAudibility(song.stemChannels);
    song.stemChannels.forEach((channel) => {
      engine.setVolume(channel.id, song.masterVolume * channel.volume);
      engine.setMuted(channel.id, isSongMuted || !audibility[channel.id]);
    });
  }, [getEngine]);

  const installStemSet = useCallback((
    song: BandSong,
    stems: SeparatedStemSet,
    cacheKey: string,
    message: string,
    options?: { preferredSource?: SongPlaybackSource; skipPersist?: boolean },
  ) => {
    const engine = getEngine();
    song.stemIds.forEach((id) => engine.removeTrack(id));
    const stemIds: string[] = [];
    const stemChannels: StemChannel[] = [];
    const saved = savedSettingsRef.current.get(song.id);
    for (const stem of stems.tracks) {
      const id = `${song.id}_stem_${stem.stemType}`;
      engine.loadStem(id, stem, stems.sampleRate);
      stemIds.push(id);
      const existingChannel = song.stemChannels.find((channel) => channel.stemType === stem.stemType);
      stemChannels.push({
        id,
        songId: song.id,
        stemType: stem.stemType,
        volume: existingChannel?.volume ?? saved?.stemVolumes?.[stem.stemType] ?? 1,
        muted: existingChannel?.muted ?? saved?.stemMuted?.[stem.stemType] ?? false,
        solo: existingChannel?.solo ?? saved?.stemSolo?.[stem.stemType] ?? false,
      });
    }
    engine.setStemMixGroup(song.id, stemIds);
    stemResultsRef.current.set(song.id, stems);
    const targetPlaybackSource: SongPlaybackSource = options?.preferredSource === "original" ? "original" : "stems";
    const nextSong: BandSong = {
      ...song,
      stemIds,
      stemChannels,
      separationStatus: "completed",
      separationMode: stems.mode,
      separationProgress: 1,
      separationMessage: message,
      playbackSource: targetPlaybackSource,
      cacheKey,
    };
    engine.seekTracks(stemIds, song.playheadSec);
    applySongToEngine(nextSong);
    if (song.status === "playing" && targetPlaybackSource === "stems") {
      void engine.playTracks(stemIds).then(() => {
        engine.crossfadeTracks([song.sourceAudioId], stemIds);
      });
    }
    const nextSongsSnapshot = sessionRef.current.songs.map((candidate) => candidate.id === song.id ? nextSong : candidate);
    setSession((previous) => ({ ...previous, songs: previous.songs.map((candidate) => candidate.id === song.id ? nextSong : candidate) }));
    setSelection((current) => sanitizeMixerSelection(current, nextSongsSnapshot));
    if (!options?.skipPersist) {
      setCollapsedIds((previous) => {
        if (!previous.has(song.id)) return previous;
        const next = new Set(previous);
        next.delete(song.id);
        return next;
      });
      persistSongDebounced(song.id);
    }
  }, [applySongToEngine, getEngine, persistSongDebounced]);

  const restoreCachedStems = useCallback(async (
    song: BandSong,
    file: Blob,
    token: symbol,
    options?: { preferredSource?: SongPlaybackSource; skipPersist?: boolean; knownHash?: string },
  ) => {
    try {
      const sourceAudioHash = options?.knownHash || await hashSourceAudio(file);
      const preferredMode = song.separationMode ?? "four_stem";
      const modes: StemSeparationMode[] = preferredMode === "four_stem"
        ? ["four_stem", "two_stem"]
        : ["two_stem", "four_stem"];
      for (const mode of modes) {
        const cacheKey = createSeparationCacheKey({
          sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: mode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
        const stems = await getCachedStemSet(cacheKey).catch(() => null);
        if (!stems) continue;
        if (separationTokensRef.current.get(song.id) !== token) return;
        const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
        installStemSet(latestSong, stems, cacheKey, "已自動從本機快取恢復分離結果。", {
          preferredSource: options?.preferredSource ?? "stems",
          skipPersist: options?.skipPersist,
        });
        void refreshCacheStats();
        return;
      }
    } finally {
      if (separationTokensRef.current.get(song.id) === token) separationTokensRef.current.delete(song.id);
    }
  }, [installStemSet, refreshCacheStats]);

  const hydrateOnePersistedSong = useCallback(async (
    record: PersistedSongRecord,
    audioRecord: PersistedAudioFileRecord | null | undefined,
    isCancelled: () => boolean,
  ) => {
    if (isCancelled() || removedSongIdsRef.current.has(record.songId)) return;
    if (!audioRecord || !(audioRecord.blob instanceof Blob)) {
      patchSongMetadataOnly(record.songId, {
        persistenceStatus: "missing_audio",
        persistenceMessage: "找不到本機原始音檔，請重新選取音檔以恢復播放。",
      });
      return;
    }

    const restoredFile = new File([audioRecord.blob], record.fileName, {
      type: audioRecord.mimeType || audioRecord.blob.type || "audio/*",
      lastModified: record.lastModified || audioRecord.lastModified || Date.now(),
    });
    const sourceAudioId = `${record.songId}_original`;
    const engine = getEngine();

    let durationSec = record.durationSec;
    try {
      durationSec = await engine.loadTrack(sourceAudioId, restoredFile, "soundtouch");
    } catch {
      engine.removeTrack(sourceAudioId);
      if (!isCancelled() && !removedSongIdsRef.current.has(record.songId)) {
        patchSongMetadataOnly(record.songId, {
          persistenceStatus: "missing_audio",
          persistenceMessage: "本機保存的音檔毀損或格式無法解碼，請重新選取音檔。",
        });
      }
      return;
    }

    if (isCancelled() || removedSongIdsRef.current.has(record.songId)) {
      engine.removeTrack(sourceAudioId);
      return;
    }

    const restoredSong = restoreBandSongFromRecord(record, {
      sourceAudioId,
      durationSec,
      persistenceStatus: "saved",
      persistenceMessage: "已保存在此裝置",
    });

    sourceFilesRef.current.set(record.songId, restoredFile);
    engine.seekTracks([sourceAudioId], restoredSong.playheadSec);
    applySongToEngine(restoredSong);

    setSession((previous) => {
      const exists = previous.songs.some((item) => item.id === restoredSong.id);
      return {
        ...previous,
        songs: exists
          ? previous.songs.map((item) => (item.id === restoredSong.id ? restoredSong : item))
          : [...previous.songs, restoredSong],
      };
    });

    // 若資料庫紀錄存有有效版本與分離模式，只讀取現有分離快取，不自動執行 Demucs
    const hasCompatibleCacheRecord = Boolean(
      record.cacheKey
      && record.modelVersion === DEMUCS_MODEL_VERSION
      && record.processingVersion === SEPARATION_PROCESSING_VERSION,
    );
    if (hasCompatibleCacheRecord && record.cacheKey) {
      const cached = await getCachedStemSet(record.cacheKey).catch(() => null);
      if (cached && !isCancelled() && !removedSongIdsRef.current.has(record.songId)) {
        const latest = sessionRef.current.songs.find((item) => item.id === record.songId) ?? restoredSong;
        installStemSet(latest, cached, record.cacheKey, "已從本機快取恢復分離結果。", {
          preferredSource: record.playbackSource,
          skipPersist: true,
        });
        return;
      }
    }

    if (record.separationMode) {
      const restoreToken = Symbol(`restore_${record.songId}`);
      separationTokensRef.current.set(record.songId, restoreToken);
      await restoreCachedStems(restoredSong, restoredFile, restoreToken, {
        preferredSource: record.playbackSource,
        skipPersist: true,
        knownHash: record.sourceAudioHash,
      });
    }
  }, [applySongToEngine, getEngine, installStemSet, patchSongMetadataOnly, restoreCachedStems]);

  useEffect(() => {
    let cancelled = false;

    const runRestore = async () => {
      setRestoringSession(true);
      setRestoringMessage("正在從本機資料庫恢復歌曲與設定…");
      try {
        const persisted = await loadPersistedBandSession();
        if (cancelled) return;
        if (persisted.songs.length === 0) {
          setRestoringSession(false);
          setRestoringMessage("");
          return;
        }

        const placeholders = persisted.songs.map((record) =>
          restoreBandSongFromRecord(record, {
            persistenceStatus: "restoring",
            persistenceMessage: "正在恢復音檔與設定…",
          }),
        );
        setSession((previous) => ({ ...previous, songs: placeholders }));
        setSelection((current) => (current.songId ? current : { songId: placeholders[0].id, stemId: null }));

        for (let i = 0; i < persisted.songs.length; i += 1) {
          if (cancelled) return;
          const record = persisted.songs[i];
          setRestoringMessage(`正在恢復歌曲 (${i + 1}/${persisted.songs.length})：${record.name}`);
          await hydrateOnePersistedSong(record, persisted.audioFilesByKey.get(record.audioKey), () => cancelled);
        }
      } catch {
        // IndexedDB 無法存取時保留空工作階段，不影響手動上傳使用
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
          setRestoringMessage("");
          void refreshCacheStats();
        }
      }
    };

    const restoreTask = runRestore();
    restorePromiseRef.current = restoreTask;

    const unsubscribeSync = subscribeBandSync((msg: BandSyncMessage) => {
      if (cancelled) return;
      if (msg.type === "song-updated") {
        const existing = sessionRef.current.songs.find((item) => item.id === msg.songId);
        if (!existing) return;
        if (hasPendingSongPersist(msg.songId) || separationTokensRef.current.has(msg.songId)) {
          patchSongMetadataOnly(msg.songId, {
            hasConflict: true,
            persistenceStatus: "conflict",
            persistenceMessage: "其他分頁剛修改過此歌曲，請選擇保留本頁或載入最新設定。",
          });
          showShortcutHint("其他分頁修改了同一首歌，請確認要保留哪一版設定。");
          return;
        }
        const synced = restoreBandSongFromRecord(msg.record, {
          sourceAudioId: existing.sourceAudioId,
          durationSec: existing.durationSec || msg.record.durationSec,
          persistenceStatus: "saved",
          persistenceMessage: "已同步其他分頁更新",
        });
        const mergedChannels: StemChannel[] = existing.stemChannels.map((ch) => {
          const remote = synced.stemChannels.find((item) => item.stemType === ch.stemType);
          return remote ? { ...ch, volume: remote.volume, muted: remote.muted, solo: remote.solo } : ch;
        });
        const merged: BandSong = {
          ...existing,
          originalBpm: synced.originalBpm,
          targetBpm: synced.targetBpm,
          keyShiftSemitones: synced.keyShiftSemitones,
          tempoMode: synced.tempoMode,
          manualRate: synced.manualRate,
          fineRateOffset: synced.fineRateOffset,
          savedRates: synced.savedRates,
          masterVolume: synced.masterVolume,
          muted: synced.muted,
          loop: synced.loop,
          playheadSec: existing.status === "playing" ? existing.playheadSec : synced.playheadSec,
          stemChannels: mergedChannels,
          revision: msg.record.revision,
          hasConflict: false,
          persistenceStatus: "saved",
          persistenceMessage: "已保存在此裝置",
        };
        if (existing.status !== "playing") {
          getEngine().seekTracks([existing.sourceAudioId, ...existing.stemIds], merged.playheadSec);
        }
        applySongToEngine(merged);
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.map((item) => (item.id === existing.id ? merged : item)),
        }));
        showCardFeedback(existing.id, "已同步其他分頁的最新設定");
        return;
      }

      if (msg.type === "song-added") {
        if (sessionRef.current.songs.some((item) => item.id === msg.songId)) return;
        void getPersistedSongWithAudio(msg.songId).then(async ({ song, audio }) => {
          if (cancelled || !song) return;
          if (sessionRef.current.songs.some((item) => item.id === song.songId)) return;
          const placeholder = restoreBandSongFromRecord(song, {
            persistenceStatus: "restoring",
            persistenceMessage: "正同步其他分頁新增的歌曲…",
          });
          setSession((previous) => ({ ...previous, songs: [...previous.songs, placeholder] }));
          await hydrateOnePersistedSong(song, audio, () => cancelled);
          void refreshCacheStats();
        });
        return;
      }

      if (msg.type === "order-updated") {
        const orderRank = new Map(msg.songOrder.map((id, index) => [id, index]));
        setSession((previous) => ({
          ...previous,
          songs: [...previous.songs].sort((a, b) => {
            const ra = orderRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const rb = orderRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return ra - rb;
          }),
        }));
        return;
      }

      if (msg.type === "song-removed") {
        const target = sessionRef.current.songs.find((item) => item.id === msg.songId);
        if (!target) return;
        cancelPendingSongPersist(target.id);
        separationTokensRef.current.delete(target.id);
        const ids = [target.sourceAudioId, ...target.stemIds];
        getEngine().stopTracks(ids);
        ids.forEach((id) => getEngine().removeTrack(id));
        sourceFilesRef.current.delete(target.id);
        stemResultsRef.current.delete(target.id);
        const remaining = sessionRef.current.songs.filter((item) => item.id !== target.id);
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.filter((item) => item.id !== target.id),
        }));
        setSelection((prev) => sanitizeMixerSelection(prev, remaining));
        showShortcutHint(`「${target.name}」已於其他分頁移除。`);
        void refreshCacheStats();
      }
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushPendingSongPersists();
      }
    };
    const onPageHide = () => {
      void flushPendingSongPersists();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    const feedbackTimers = cardFeedbackTimersRef.current;
    return () => {
      cancelled = true;
      unsubscribeSync();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      void flushPendingSongPersists();
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
      }
      feedbackTimers.forEach((timer) => window.clearTimeout(timer));
      feedbackTimers.clear();
      engineRef.current?.dispose();
      engineRef.current = null;
      void disposeStemSeparator();
    };
  }, [applySongToEngine, getEngine, hydrateOnePersistedSong, patchSongMetadataOnly, refreshCacheStats, showCardFeedback, showShortcutHint]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const now = Date.now();
      setSession((previous) => {
        let changed = false;
        const songs = previous.songs.map((song) => {
          if (song.status !== "playing") return song;
          const position = engine.getTrackPosition(getSongPlaybackTrackIds(song)[0]);
          if (Math.abs(position - song.playheadSec) < 0.03) return song;
          changed = true;
          const lastSaved = lastPlayheadPersistAtRef.current.get(song.id) ?? 0;
          if (song.sourceAudioHash && now - lastSaved >= 2000) {
            lastPlayheadPersistAtRef.current.set(song.id, now);
            scheduleSongPersist(
              song.id,
              () => sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? null,
              handlePersistResult,
              400,
            );
          }
          return { ...song, playheadSec: position };
        });
        return changed ? { ...previous, songs } : previous;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [handlePersistResult]);

  const updateSong = useCallback((songId: string, patch: Partial<BandSong>, options?: { persistDelayMs?: number }) => {
    let shouldPersist = false;
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => {
        if (song.id !== songId) return song;
        const normalized: Partial<BandSong> = { ...patch };
        if ("originalBpm" in normalized) normalized.originalBpm = clampBpm(normalized.originalBpm ?? song.originalBpm);
        if ("targetBpm" in normalized) normalized.targetBpm = clampBpm(normalized.targetBpm ?? song.targetBpm);
        if ("keyShiftSemitones" in normalized) normalized.keyShiftSemitones = Math.max(-12, Math.min(12, Math.round(normalized.keyShiftSemitones ?? 0)));
        const next = { ...song, ...normalized };
        applySongToEngine(next);
        shouldPersist = Boolean(next.sourceAudioHash);
        return next;
      }),
    }));
    if (shouldPersist) {
      persistSongDebounced(songId, options?.persistDelayMs ?? 300);
    }
  }, [applySongToEngine, persistSongDebounced]);

  const persistNewOrRelinkedSong = useCallback(async (song: BandSong, file: Blob, sourceAudioHash: string, force = false) => {
    const res = await saveSongWithAudioFile({ song, file, sourceAudioHash, force });
    handlePersistResult(song.id, res);
    void refreshCacheStats();
  }, [handlePersistResult, refreshCacheStats]);

  const handleFiles = async (fileList: File[] | FileList | null) => {
    const selectedFiles = fileList ? Array.from(fileList) : [];
    if (!selectedFiles.length) return;
    setLoading(true);
    setUploadError("");
    setUploadStatus(`正在準備載入 ${selectedFiles.length} 個音檔…`);
    try {
      await Promise.race([
        restorePromiseRef.current.catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
      if (!persistRequestedRef.current) {
        persistRequestedRef.current = true;
        void requestPersistentStorage().then(() => refreshCacheStats());
      }
      const engine = getEngine();
      for (const file of selectedFiles) {
        const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sourceAudioId = `${songId}_original`;
        setUploadStatus(`正在解碼音檔：${file.name}`);
        try {
          const durationSec = await engine.loadTrack(sourceAudioId, file, "soundtouch");
          const sourceAudioHash = await hashSourceAudio(file);
          const settingsKey = `${file.name}:${file.size}:${file.lastModified}`;
          const saved = await loadSongSettings(settingsKey).catch(() => null);
          const baseSong = createBandSong({
            id: songId,
            name: file.name.replace(/\.[^.]+$/, ""),
            fileName: file.name,
            sourceAudioId,
            settingsKey,
            originalBpm: 120,
            durationSec,
            sourceAudioHash,
            fileSizeBytes: file.size,
            mimeType: file.type,
            fileLastModified: file.lastModified,
            persistenceStatus: "saving",
            persistenceMessage: "儲存中…",
          });
          const restoredRates = saved ? sanitizeSongSavedRates(saved.savedRates) : [1];
          const song: BandSong = saved ? {
            ...baseSong,
            targetBpm: clampBpm(saved.targetBpm),
            keyShiftSemitones: Math.max(-12, Math.min(12, saved.keyShiftSemitones)),
            masterVolume: Math.max(0, Math.min(1, saved.masterVolume)),
            tempoMode: saved.tempoMode,
            manualRate: Math.max(0.25, Math.min(4, saved.manualRate)),
            fineRateOffset: Math.max(-0.05, Math.min(0.05, saved.fineRateOffset)),
            savedRates: restoredRates,
            loop: saved.loop,
            separationMode: saved.separationMode ?? null,
          } : baseSong;
          if (saved) savedSettingsRef.current.set(songId, saved);
          sourceFilesRef.current.set(songId, file);
          applySongToEngine(song);
          setSession((previous) => ({ ...previous, songs: [...previous.songs, song] }));
          setSelection((previous) => (previous.songId ? previous : { songId: song.id, stemId: null }));

          void persistNewOrRelinkedSong(song, file, sourceAudioHash);

          const restoreToken = Symbol(`restore_${songId}`);
          separationTokensRef.current.set(songId, restoreToken);
          window.setTimeout(() => void restoreCachedStems(song, file, restoreToken, { knownHash: sourceAudioHash }), 0);
        } catch (error) {
          engine.removeTrack(sourceAudioId);
          const detail = error instanceof Error && error.message ? error.message : "無法解碼或讀取此音檔格式";
          const msg = `「${file.name}」載入失敗：${detail}`;
          setUploadError(msg);
          showShortcutHint(msg);
        }
      }
    } finally {
      setUploadStatus("");
      setLoading(false);
    }
  };

  const handleRelinkFile = async (songId: string, fileList: File[] | FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const target = sessionRef.current.songs.find((item) => item.id === songId);
    if (!target) return;
    const engine = getEngine();
    patchSongMetadataOnly(songId, { persistenceStatus: "restoring", persistenceMessage: "正在解碼與連結音檔…" });
    try {
      const durationSec = await engine.loadTrack(target.sourceAudioId, file, "soundtouch");
      const sourceAudioHash = await hashSourceAudio(file);
      sourceFilesRef.current.set(songId, file);
      const nextPlayhead = Math.max(0, Math.min(durationSec, target.playheadSec));
      const updatedSong: BandSong = {
        ...target,
        fileName: file.name,
        fileSizeBytes: file.size,
        mimeType: file.type,
        fileLastModified: file.lastModified,
        durationSec,
        playheadSec: nextPlayhead,
        status: nextPlayhead > 0.01 ? "paused" : "stopped",
        sourceAudioHash,
        persistenceStatus: "saving",
        persistenceMessage: "儲存中…",
        hasConflict: false,
      };
      engine.seekTracks([updatedSong.sourceAudioId, ...updatedSong.stemIds], nextPlayhead);
      applySongToEngine(updatedSong);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((item) => (item.id === songId ? updatedSong : item)),
      }));
      await persistNewOrRelinkedSong(updatedSong, file, sourceAudioHash, true);
      showCardFeedback(songId, "已重新連結本機音檔並保存。");
      const restoreToken = Symbol(`relink_${songId}`);
      separationTokensRef.current.set(songId, restoreToken);
      void restoreCachedStems(updatedSong, file, restoreToken, {
        preferredSource: target.playbackSource,
        knownHash: sourceAudioHash,
      });
    } catch {
      engine.removeTrack(target.sourceAudioId);
      patchSongMetadataOnly(songId, {
        persistenceStatus: "missing_audio",
        persistenceMessage: "選取的音檔無法解碼，請確認檔案格式後再試。",
      });
    }
  };

  const retryPersistSong = async (song: BandSong) => {
    const file = sourceFilesRef.current.get(song.id);
    if (!file) {
      relinkingSongIdRef.current = song.id;
      relinkInputRef.current?.click();
      return;
    }
    patchSongMetadataOnly(song.id, { persistenceStatus: "saving", persistenceMessage: "正在重試保存…" });
    const hash = song.sourceAudioHash || await hashSourceAudio(file);
    await persistNewOrRelinkedSong({ ...song, sourceAudioHash: hash }, file, hash, false);
  };

  const reloadConflictSongFromDb = async (song: BandSong) => {
    const { song: serverRecord } = await getPersistedSongWithAudio(song.id).catch(() => ({ song: null }));
    if (!serverRecord) {
      showCardFeedback(song.id, "找不到資料庫紀錄，已保留目前設定。");
      return;
    }
    cancelPendingSongPersist(song.id);
    const restored = restoreBandSongFromRecord(serverRecord, {
      sourceAudioId: song.sourceAudioId,
      durationSec: song.durationSec || serverRecord.durationSec,
      persistenceStatus: "saved",
      persistenceMessage: "已載入最新本機設定",
    });
    const mergedChannels: StemChannel[] = song.stemChannels.map((ch) => {
      const remote = restored.stemChannels.find((item) => item.stemType === ch.stemType);
      return remote ? { ...ch, volume: remote.volume, muted: remote.muted, solo: remote.solo } : ch;
    });
    const merged: BandSong = {
      ...song,
      ...restored,
      status: song.status,
      stemIds: song.stemIds,
      stemChannels: mergedChannels.length ? mergedChannels : song.stemChannels,
      separationStatus: song.separationStatus,
      separationProgress: song.separationProgress,
      separationMessage: song.separationMessage,
      playbackSource: song.stemIds.length ? restored.playbackSource : "original",
      hasConflict: false,
      persistenceStatus: "saved",
      persistenceMessage: "已保存在此裝置",
    };
    getEngine().seekTracks([merged.sourceAudioId, ...merged.stemIds], merged.playheadSec);
    applySongToEngine(merged);
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((item) => (item.id === song.id ? merged : item)),
    }));
    showCardFeedback(song.id, "已套用其他分頁最新設定。");
  };

  const forceOverwriteSongInDb = async (song: BandSong) => {
    cancelPendingSongPersist(song.id);
    patchSongMetadataOnly(song.id, { persistenceStatus: "saving", persistenceMessage: "正在覆寫保存…" });
    const res = await saveSongStateRecord(song, { force: true });
    handlePersistResult(song.id, res);
    if (res.ok) showCardFeedback(song.id, "已保留目前分頁設定並更新本機資料。");
  };

  const playSong = async (song: BandSong) => {
    if (song.persistenceStatus === "missing_audio" || song.persistenceStatus === "restoring") {
      const msg = song.persistenceStatus === "restoring"
        ? "正在恢復音檔，請稍候再播放。"
        : "此歌曲缺少本機原始音檔，請先重新選取音檔。";
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
      showShortcutHint(msg);
      return;
    }
    if (startingSongIdsRef.current.has(song.id)) return;
    startingSongIdsRef.current.add(song.id);
    setStartingSongIds((previous) => new Set(previous).add(song.id));
    setPlaybackErrors((previous) => {
      if (!(song.id in previous)) return previous;
      const next = { ...previous };
      delete next[song.id];
      return next;
    });
    try {
      applySongToEngine(song);
      await getEngine().playTracks(getSongPlaybackTrackIds(song));
      updateSong(song.id, { status: "playing" });
    } catch (error) {
      const errorMsg = describePlaybackError(error);
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: errorMsg }));
      showShortcutHint(errorMsg);
    } finally {
      startingSongIdsRef.current.delete(song.id);
      setStartingSongIds((previous) => {
        if (!previous.has(song.id)) return previous;
        const next = new Set(previous);
        next.delete(song.id);
        return next;
      });
    }
  };

  const pauseSong = (song: BandSong) => {
    if (startingSongIdsRef.current.has(song.id)) return;
    getEngine().pauseTracks(getSongPlaybackTrackIds(song));
    updateSong(song.id, { status: "paused" }, { persistDelayMs: 80 });
  };

  const stopSong = (song: BandSong) => {
    getEngine().stopTracks([song.sourceAudioId, ...song.stemIds]);
    updateSong(song.id, { status: "stopped", playheadSec: 0 }, { persistDelayMs: 80 });
  };

  const seekSong = (song: BandSong, seconds: number) => {
    getEngine().seekTracks([song.sourceAudioId, ...song.stemIds], seconds);
    updateSong(song.id, { playheadSec: seconds }, { persistDelayMs: 250 });
  };

  const toggleMuteForSelection = useCallback((targetSelection: MixerSelection) => {
    const result = toggleMuteBySelection(sessionRef.current.songs, targetSelection);
    if (result.changedSong) {
      applySongToEngine(result.changedSong);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (
          candidate.id === result.changedSong!.id ? result.changedSong! : candidate
        )),
      }));
      persistSongDebounced(result.changedSong.id);
      showCardFeedback(result.changedSong.id, result.message);
    }
    showShortcutHint(result.message);
  }, [applySongToEngine, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const toggleSoloForSelection = useCallback((targetSelection: MixerSelection) => {
    const result = toggleSoloBySelection(sessionRef.current.songs, targetSelection);
    if (result.changedSong) {
      applySongToEngine(result.changedSong);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (
          candidate.id === result.changedSong!.id ? result.changedSong! : candidate
        )),
      }));
      persistSongDebounced(result.changedSong.id);
      showCardFeedback(result.changedSong.id, result.message);
    } else if (targetSelection.songId) {
      showCardFeedback(targetSelection.songId, result.message);
    }
    showShortcutHint(result.message);
  }, [applySongToEngine, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const switchSource = async (song: BandSong, playbackSource: "original" | "stems") => {
    if (song.playbackSource === playbackSource || (playbackSource === "stems" && song.stemIds.length === 0)) return;
    const engine = getEngine();
    const oldIds = getSongPlaybackTrackIds(song);
    const nextSong = { ...song, playbackSource };
    const newIds = getSongPlaybackTrackIds(nextSong);
    engine.seekTracks(newIds, song.playheadSec);
    applySongToEngine(nextSong);
    if (song.status === "playing") {
      await engine.playTracks(newIds);
      engine.crossfadeTracks(oldIds, newIds);
    }
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((candidate) => candidate.id === song.id ? nextSong : candidate),
    }));
    if (playbackSource === "original") {
      setSelection((previous) => (
        previous.songId === song.id && previous.stemId
          ? { songId: song.id, stemId: null }
          : previous
      ));
    }
    persistSongDebounced(song.id, 150);
  };

  const separateSong = async (song: BandSong, mode: StemSeparationMode) => {
    if (song.separationStatus === "processing" || separationTokensRef.current.has(song.id)) {
      return;
    }
    if (separationTokensRef.current.size > 0) {
      showCardFeedback(song.id, "另一首歌曲正在分離中，請待該任務完成後再試。");
      showShortcutHint("目前一次只能執行一個 Demucs 分離任務，請稍候。");
      return;
    }
    const file = sourceFilesRef.current.get(song.id);
    if (!file) {
      updateSong(song.id, { separationStatus: "failed", separationMessage: "原始音訊已不在記憶體，請重新載入歌曲。" });
      return;
    }
    const token = Symbol(song.id);
    separationTokensRef.current.set(song.id, token);
    updateSong(song.id, { separationStatus: "processing", separationMode: mode, separationProgress: 0, separationMessage: "正在計算歌曲指紋…" });
    try {
      const sourceAudioHash = await hashSourceAudio(file);
      const cacheKey = createSeparationCacheKey({ sourceAudioHash, modelVersion: DEMUCS_MODEL_VERSION, separationMode: mode, processingVersion: SEPARATION_PROCESSING_VERSION });
      let stems = await getCachedStemSet(cacheKey).catch(() => null);
      let message = "已從本機快取載入分離結果。";
      if (!stems) {
        const result = await separateAudio(file, {
          mode,
          onStatus: (separationMessage) => updateSong(song.id, { separationMessage }),
          onDownloadProgress: (progress) => updateSong(song.id, {
            separationProgress: progress > 0 && progress < 1 ? progress : 0,
            separationMessage: progress > 0 ? `模型下載 ${Math.round(progress * 100)}%` : "模型下載與準備中…",
          }),
          onProgress: (progress, current, total) => updateSong(song.id, {
            separationProgress: progress,
            separationMessage: `分離片段 ${current}/${total}`,
          }),
        });
        stems = result.stems;
        updateSong(song.id, { separationProgress: 0, separationMessage: "正在寫入本機快取…" });
        message = `分離完成（${result.backend === "webgpu" ? "WebGPU" : "WASM"}）。`;
        try {
          await putCachedStemSet(createStemCacheRecord({ key: cacheKey, sourceAudioHash, modelVersion: DEMUCS_MODEL_VERSION, processingVersion: SEPARATION_PROCESSING_VERSION, stems }));
        } catch (cacheError) {
          message += ` ${cacheError instanceof Error ? cacheError.message : "結果無法持久快取。"}`;
        }
      }
      if (separationTokensRef.current.get(song.id) !== token) return;
      const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id);
      if (!latestSong) return;
      installStemSet(latestSong, stems, cacheKey, message);
      showCardFeedback(song.id, message);
      void refreshCacheStats();
    } catch (error) {
      if (separationTokensRef.current.get(song.id) !== token) return;
      updateSong(song.id, { separationStatus: "failed", separationMessage: error instanceof Error ? error.message : "音源分離失敗。" });
    } finally {
      if (separationTokensRef.current.get(song.id) === token) separationTokensRef.current.delete(song.id);
    }
  };

  const updateStem = (song: BandSong, stemId: string, patch: Partial<StemChannel>) => {
    updateSong(song.id, { stemChannels: song.stemChannels.map((channel) => channel.id === stemId ? { ...channel, ...patch } : channel) });
  };

  const downloadStem = (song: BandSong, stemId: string) => {
    const stems = stemResultsRef.current.get(song.id);
    const channel = song.stemChannels.find((item) => item.id === stemId);
    const stem = stems?.tracks.find((item) => item.stemType === channel?.stemType);
    if (!stem || !stems) return;
    const blob = new Blob([encodeStereoWav(stem.left, stem.right, stems.sampleRate)], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${song.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}-${stem.stemType}.wav`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearSongCache = async (song: BandSong) => {
    if (!song.cacheKey) {
      showCardFeedback(song.id, "目前已無本機分軌快取。");
      return;
    }
    await deleteCachedStemSet(song.cacheKey).catch(() => undefined);
    updateSong(song.id, { cacheKey: null, separationMessage: "已清除硬碟快取；目前載入的分軌仍可繼續播放。" });
    showCardFeedback(song.id, "已清除本機分軌快取（目前播放不受影響）");
    void refreshCacheStats();
  };

  const clearAllSeparationCache = async () => {
    await clearAllCachedStemSets().catch(() => undefined);
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => ({
        ...song,
        cacheKey: null,
        separationMessage: song.stemIds.length
          ? "已清除持久快取；目前載入的分軌仍可播放。"
          : song.separationMessage,
      })),
    }));
    void refreshCacheStats();
  };

  const removeSong = async (song: BandSong, deleteLocalData: boolean) => {
    removedSongIdsRef.current.add(song.id);
    separationTokensRef.current.delete(song.id);
    cancelPendingSongPersist(song.id);
    const ids = [song.sourceAudioId, ...song.stemIds];
    getEngine().stopTracks(ids);
    ids.forEach((id) => getEngine().removeTrack(id));
    sourceFilesRef.current.delete(song.id);
    stemResultsRef.current.delete(song.id);
    savedSettingsRef.current.delete(song.id);
    const remainingSongs = sessionRef.current.songs.filter((candidate) => candidate.id !== song.id);
    setSession((previous) => ({ ...previous, songs: previous.songs.filter((candidate) => candidate.id !== song.id) }));
    setSelection((previous) => sanitizeMixerSelection(previous, remainingSongs));

    try {
      await restorePromiseRef.current.catch(() => undefined);
      const result = await removePersistedSong({
        song,
        deleteLocalData,
        inMemoryRemainingSongs: remainingSongs,
      });
      if (deleteLocalData && result.sharedWithOtherSongs) {
        showShortcutHint(`已移除「${song.name}」；另有其他歌曲共用此音檔，已保留共用資料。`);
      } else if (deleteLocalData) {
        showShortcutHint(`已移除「${song.name}」並刪除未共用的本機音檔與分離快取。`);
      } else {
        showShortcutHint(`已從清單移除「${song.name}」（已保留本機音檔與快取）。`);
      }
      void refreshCacheStats();
    } catch {
      showShortcutHint(`已從畫面移除「${song.name}」，但清理本機資料庫時發生錯誤。`);
    }
  };

  const handleClearUnusedSeparationCaches = async () => {
    try {
      const result = await clearUnusedSeparationCaches(sessionRef.current.songs);
      setStorageActionMsg(
        result.deletedCount > 0
          ? `已清除 ${result.deletedCount} 筆未使用的分離快取（釋放 ${formatBytes(result.freedBytes)}）。`
          : "目前沒有未使用的分離快取（使用中歌曲皆已完整保留）。",
      );
      void refreshCacheStats();
    } catch {
      setStorageActionMsg("清理未使用的分離快取時發生錯誤。");
    }
  };

  const handleRequestPersistentStorage = async () => {
    const result = await requestPersistentStorage();
    setStorageActionMsg(
      !result.supported
        ? "此瀏覽器不支援 Persistent Storage API。"
        : result.persisted
          ? "已啟用持久儲存（Persistent Storage），本機音檔與快取將優先保留。"
          : "瀏覽器暫未核准自動保護權限，目前仍已保存於 IndexedDB。",
    );
    void refreshCacheStats();
  };

  const moveSong = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const nextSongs = reorderSongList(sessionRef.current.songs, fromId, toId);
    setSession((previous) => ({
      ...previous,
      songs: reorderSongList(previous.songs, fromId, toId),
    }));
    void restorePromiseRef.current
      .catch(() => undefined)
      .then(() => savePersistedSongOrder(nextSongs.map((item) => item.id)));
  };

  const moveSongByStep = (songId: string, delta: -1 | 1) => {
    const songs = sessionRef.current.songs;
    const index = songs.findIndex((candidate) => candidate.id === songId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= songs.length) return;
    moveSong(songId, songs[targetIndex].id);
  };

  shortcutHandlerRef.current = (event: KeyboardEvent) => {
    const action = resolveShortcutAction(event);
    if (!action) return;
    event.preventDefault();

    if (action === "open-upload") {
      if (!loading) fileInputRef.current?.click();
      return;
    }

    const activeSelection = sanitizeMixerSelection(selectionRef.current, sessionRef.current.songs);
    const targetSong = activeSelection.songId
      ? sessionRef.current.songs.find((candidate) => candidate.id === activeSelection.songId) ?? null
      : null;

    if (!targetSong) {
      showShortcutHint("請先點選一首歌曲卡片以使用快捷鍵。");
      return;
    }

    switch (action) {
      case "toggle-play":
        if (targetSong.status === "playing") {
          pauseSong(targetSong);
          showShortcutHint(`已暫停：${targetSong.name}`);
        } else {
          void playSong(targetSong);
          showShortcutHint(`啟動播放：${targetSong.name}`);
        }
        return;
      case "toggle-mute":
        toggleMuteForSelection(activeSelection);
        return;
      case "toggle-solo":
        toggleSoloForSelection(activeSelection);
        return;
      case "toggle-loop": {
        const nextLoop = !targetSong.loop;
        updateSong(targetSong.id, { loop: nextLoop });
        const msg = `${targetSong.name} ${nextLoop ? "已開啟循環" : "已切換為單次播放"}`;
        showCardFeedback(targetSong.id, msg);
        showShortcutHint(msg);
        return;
      }
      case "reset-speed": {
        const res = applyResetSpeed(targetSong);
        if (res.changed && res.patch) updateSong(targetSong.id, res.patch);
        showCardFeedback(targetSong.id, res.message);
        showShortcutHint(res.message);
        return;
      }
      case "reset-key": {
        const res = applyResetKey(targetSong);
        if (res.changed && res.patch) updateSong(targetSong.id, res.patch);
        showCardFeedback(targetSong.id, res.message);
        showShortcutHint(res.message);
        return;
      }
      case "reset-mix": {
        const res = applyResetMix(targetSong);
        if (res.changed && res.patch) updateSong(targetSong.id, res.patch);
        showCardFeedback(targetSong.id, res.message);
        showShortcutHint(res.message);
        return;
      }
      case "seek-start": {
        const alreadyAtStart = Math.abs(targetSong.playheadSec) < 0.01;
        seekSong(targetSong, 0);
        const msg = alreadyAtStart
          ? `${targetSong.name} 已在起點 (0:00)`
          : `${targetSong.name} 已回到起點 (0:00)`;
        showCardFeedback(targetSong.id, msg);
        showShortcutHint(msg);
        return;
      }
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      shortcutHandlerRef.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const selectedSongs = session.songs.filter((song) => song.selected);
  const hasMultipleSelectedSongs = selectedSongs.length > 1;

  return (
    <div className={`grid mixer-shell${hasMultipleSelectedSongs ? " has-selected" : ""}`} style={{ gap: 16 }}>
      <div className="card row mixer-upload" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className={`btn mixer-button primary${loading ? " is-loading" : ""}`}
          disabled={loading}
          aria-busy={loading}
          title={loading ? "正在讀取與解碼音檔，請稍候" : undefined}
          onClick={() => fileInputRef.current?.click()}
        >
          {loading ? (
            <>
              <span className="mixer-spinner" aria-hidden="true" />
              載入中…
            </>
          ) : "＋ 載入歌曲 (Alt+N)"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(event) => {
            const picked = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = "";
            void handleFiles(picked);
          }}
        />
        <input
          ref={relinkInputRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            const targetId = relinkingSongIdRef.current;
            relinkingSongIdRef.current = null;
            const picked = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = "";
            if (targetId && picked.length) void handleRelinkFile(targetId, picked);
          }}
        />
        <div className="mixer-toolbar-actions">
          <IconActionButton
            icon="?"
            label="快捷鍵說明"
            pressed={showShortcuts}
            primary={showShortcuts}
            expanded={showShortcuts}
            onClick={() => setShowShortcuts((value) => !value)}
          />
          <IconActionButton
            icon={cacheStats.isLowStorage ? "💾⚠" : "💾"}
            label={cacheStats.isLowStorage ? "儲存空間管理（空間偏低）" : "本機儲存空間管理"}
            pressed={showStorage}
            primary={showStorage}
            expanded={showStorage}
            danger={cacheStats.isLowStorage}
            onClick={() => setShowStorage((value) => !value)}
          />
        </div>
        {uploadStatus && (
          <span role="status" aria-live="polite" className="small" style={{ color: "#38bdf8", width: "100%" }}>
            {uploadStatus}
          </span>
        )}
        {uploadError && (
          <div role="alert" className="card-error-banner" style={{ width: "100%" }}>
            <span>{uploadError}</span>
          </div>
        )}
      </div>

      {restoringSession && (
        <div role="status" aria-live="polite" className="card mixer-restore-banner">
          <span className="mixer-spinner" aria-hidden="true" />
          <span>{restoringMessage || "正在恢復先前保存的歌曲…"}</span>
        </div>
      )}

      {cacheStats.isLowStorage && (
        <div role="alert" className="card card-warning-banner">
          <span>⚠ 瀏覽器可用儲存空間偏低，建議清除不再使用的分離快取，避免後續寫入失敗。</span>
          <button type="button" className="btn mixer-button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => void handleClearUnusedSeparationCaches()}>
            清除未使用的分離快取
          </button>
        </div>
      )}

      {(showShortcuts || Boolean(shortcutHint)) && (
        <div className="card row mixer-shortcut-bar" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", paddingBlock: 10 }}>
          {showShortcuts && (
            <span className="small" style={{ opacity: 0.85 }}>
              ⌨ <strong>Space</strong> 播放／暫停 · <strong>方向鍵</strong> 微調滑桿 · <strong>Alt+L</strong> 循環 · <strong>Alt+M</strong> 靜音 · <strong>Alt+K</strong> 獨奏 · <strong>Alt+Z</strong> 原速 · <strong>Alt+X</strong> 原 Key · <strong>Alt+C</strong> 混音預設 · <strong>Alt+A</strong> 回起點 · <strong>Alt+N</strong> 載入音檔
            </span>
          )}
          {shortcutHint && (
            <span role="status" aria-live="polite" className="shortcut-feedback">
              {shortcutHint}
            </span>
          )}
        </div>
      )}

      {showStorage && (
        <div className="card mixer-cache">
          <div className="row" style={{ justifyContent: "space-between", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>
              本機音訊與儲存空間管理{cacheStats.isLowStorage ? "（⚠ 空間偏低）" : ""}
            </strong>
            <span className="small" style={{ opacity: 0.65 }}>全瀏覽器端處理，不經雲端音訊 API</span>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span className="small">原始音檔：{formatBytes(cacheStats.audioBytes)}</span>
            <span className="small">分離結果：{formatBytes(cacheStats.stemBytes)}</span>
            <span className="small">模型：{formatBytes(cacheStats.modelBytes)}</span>
            <span className="small">瀏覽器用量：{formatBytes(cacheStats.usage)} / {formatBytes(cacheStats.quota)}</span>
            <span className="small">
              持久儲存：{cacheStats.persisted === null ? "不支援" : cacheStats.persisted ? "已啟用" : "未啟用"}
            </span>
            {cacheStats.persisted === false && (
              <button type="button" className="btn mixer-button" onClick={() => void handleRequestPersistentStorage()}>
                啟用持久儲存保護
              </button>
            )}
            <button type="button" className="btn mixer-button" onClick={() => void handleClearUnusedSeparationCaches()}>清除未使用快取</button>
            <button type="button" className="btn mixer-button" onClick={() => void clearAllSeparationCache()}>清理分離結果</button>
            <button type="button" className="btn mixer-button" onClick={() => void clearModelCache().then(refreshCacheStats)}>清理模型快取</button>
            <button type="button" className="btn mixer-button" onClick={() => void refreshCacheStats()}>重新整理</button>
          </div>
          {storageActionMsg && (
            <p role="status" className="small" style={{ color: "#38bdf8", marginTop: 8, marginBottom: 0 }}>
              {storageActionMsg}
            </p>
          )}
          <p className="small" style={{ opacity: 0.6, marginBottom: 0 }}>清除未使用的分離快取與清理快取都不會刪除目前使用中的原始歌曲或中斷記憶體中的播放。</p>
        </div>
      )}

      {session.songs.length > 0 && (
        <div className={`card row mixer-bulk-controls${hasMultipleSelectedSongs ? " is-selected" : ""}`} style={{ gap: 8, flexWrap: "wrap", alignItems: "center", paddingBlock: 10 }}>
          <strong style={{ fontSize: 13 }}>批次播放</strong>
          <span className="small selected-song-count" style={{ opacity: selectedSongs.length ? 0.9 : 0.65 }}>已選 {selectedSongs.length} 首</span>
          <IconActionButton
            icon="▶"
            label="播放所選歌曲"
            primary={selectedSongs.length > 0}
            disabled={!selectedSongs.length}
            disabledReason={!selectedSongs.length ? "請先勾選至少一首歌曲" : undefined}
            className="is-compact"
            onClick={() => void Promise.all(selectedSongs.map(playSong))}
          />
          <IconActionButton
            icon="⏸"
            label="暫停所選歌曲"
            disabled={!selectedSongs.length}
            disabledReason={!selectedSongs.length ? "請先勾選至少一首歌曲" : undefined}
            className="is-compact"
            onClick={() => selectedSongs.forEach(pauseSong)}
          />
          <IconActionButton
            icon="■"
            label="停止所選歌曲"
            disabled={!selectedSongs.length}
            disabledReason={!selectedSongs.length ? "請先勾選至少一首歌曲" : undefined}
            className="is-compact"
            onClick={() => selectedSongs.forEach(stopSong)}
          />
        </div>
      )}

      {session.songs.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 16px" }}>
          <p className="small" style={{ opacity: 0.5, margin: 0 }}>
            {restoringSession ? "正在讀取先前保存的歌曲清單…" : "尚未載入歌曲"}
          </p>
          <p className="small" style={{ opacity: 0.35, marginTop: 6 }}>載入後可自動保存於此裝置，並於歌曲卡片內分離音源</p>
        </div>
      ) : (
        <div className="grid mixer-songs" style={{ gap: 12 }}>
          {session.songs.map((song) => (
            <div
              key={song.id}
              className="song-card-wrapper"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingId) moveSong(draggingId, song.id);
                setDraggingId(null);
              }}
              style={{
                opacity: draggingId === song.id ? 0.45 : 1,
                transition: "opacity 0.15s ease",
              }}
            >
              <SongCard
                song={song}
                collapsed={collapsedIds.has(song.id)}
                isDragging={draggingId === song.id}
                isActive={selection.songId === song.id}
                isStartingPlayback={startingSongIds.has(song.id)}
                playbackError={playbackErrors[song.id] ?? null}
                actionFeedback={cardFeedbacks[song.id] ?? null}
                selectedStemId={selection.songId === song.id ? selection.stemId : null}
                onSelectSong={() => setSelection({ songId: song.id, stemId: null })}
                onSelectStem={(stemId) => setSelection({ songId: song.id, stemId })}
                onToggleMute={() => toggleMuteForSelection({ songId: song.id, stemId: null })}
                onToggleStemMute={(stemId) => toggleMuteForSelection({ songId: song.id, stemId })}
                onToggleStemSolo={(stemId) => toggleSoloForSelection({ songId: song.id, stemId })}
                onDragStartHandle={(event) => {
                  setDraggingId(song.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", song.id);
                  const card = (event.currentTarget as HTMLElement).closest(".song-card");
                  if (card && event.dataTransfer.setDragImage) {
                    const rect = card.getBoundingClientRect();
                    event.dataTransfer.setDragImage(
                      card,
                      event.clientX - rect.left,
                      event.clientY - rect.top,
                    );
                  }
                }}
                onDragEndHandle={() => setDraggingId(null)}
                onMoveUp={() => moveSongByStep(song.id, -1)}
                onMoveDown={() => moveSongByStep(song.id, 1)}
                onToggleCollapse={() => setCollapsedIds((previous) => { const next = new Set(previous); next.has(song.id) ? next.delete(song.id) : next.add(song.id); return next; })}
                onChange={(patch) => updateSong(song.id, patch)}
                onPlayPause={() => song.status === "playing" ? pauseSong(song) : void playSong(song)}
                onStop={() => stopSong(song)}
                onSeek={(seconds) => seekSong(song, seconds)}
                onSeparate={(mode) => void separateSong(song, mode)}
                onSwitchSource={(source) => void switchSource(song, source)}
                onStemChange={(id, patch) => updateStem(song, id, patch)}
                onDownloadStem={(id) => downloadStem(song, id)}
                onClearSongCache={() => void clearSongCache(song)}
                onRemove={(deleteLocalData) => void removeSong(song, deleteLocalData)}
                onRelinkAudio={() => {
                  relinkingSongIdRef.current = song.id;
                  relinkInputRef.current?.click();
                }}
                onRetryPersist={() => void retryPersistSong(song)}
                onReloadFromDb={() => void reloadConflictSongFromDb(song)}
                onOverwriteDb={() => void forceOverwriteSongInDb(song)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
