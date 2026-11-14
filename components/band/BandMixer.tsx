"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BandSession, BandSong, SeparationFocusSessionSnapshot, SongPlaybackSource, StemChannel } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";
import {
  applySongOperationSnapshot,
  clampBpmValue,
  createBandSong,
  createSeparationFocusSessionSnapshot,
  createSongOperationSnapshot,
  getEffectivePlaybackRate,
  getSongPlaybackTrackIds,
  getStemAudibility,
  reorderSongList,
  restoreBandSongFromRecord,
  restoreSongsAfterSeparationFocus,
  sanitizeSongSavedRates,
  type PersistedSongRecord,
} from "@/lib/band/songModel";
import { MultiTrackEngine } from "@/lib/band/multiTrackEngine";
import {
  DEMUCS_MODEL_VERSION,
  disposeStemSeparator,
  isSeparatorWorkerActive,
  preflightSeparationNetworkBudget,
  separateAudio,
} from "@/lib/separation/stemSeparator";
import {
  isAbortError,
  sharedSeparationCoordinator,
  type SeparationTaskStage,
} from "@/lib/separation/separationTaskController";
import {
  assessResourceRisk,
  collectDeviceCapabilities,
  estimateOperationFootprint,
  evaluateTaskAdmission,
  formatEstimatedMiB,
  sharedPerfTelemetry,
  sharedResourceProfileManager,
  shouldEnterSeparationFocusMode,
  type DeviceResourceProfile,
  type LowLoadActionId,
  type ResourceRiskAssessment,
} from "@/lib/band/resourceGuard";
import {
  sharedNetworkBudgetLedger,
  type NetworkBatchEvaluation,
} from "@/lib/band/networkBudgetGuard";
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
  getPersistedAudioBlobByKey,
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
import { ResourceGuardModal, type ResourceGuardConfirmSelection } from "./ResourceGuardModal";
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

type SeparationFocusUiState = {
  active: boolean;
  outcome: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  songId: string;
  songName: string;
  stage: SeparationTaskStage;
  progress: number | null;
  message: string;
  reasons: string[];
  pausedSongNames: string[];
  snapshot: SeparationFocusSessionSnapshot | null;
  diagnosticsSummary: string | null;
};

const FOCUS_BLOCKED_SONG_KEYS: ReadonlyArray<keyof BandSong> = [
  "originalBpm",
  "targetBpm",
  "tempoMode",
  "manualRate",
  "fineRateOffset",
  "keyShiftSemitones",
  "playbackSource",
  "loop",
  "masterVolume",
  "muted",
  "stemChannels",
  "savedRates",
  "status",
];

function formatSeparationFocusStageLabel(stage: SeparationTaskStage): string {
  switch (stage) {
    case "preparing":
      return "準備環境與檢查快取";
    case "downloading":
      return "下載模型權重（本機快取）";
    case "processing":
      return "Demucs AI 推論計算中";
    case "cancelling":
      return "正在停止 Worker 與清理暫存";
    case "cancelled":
      return "已中止音源分離";
    case "completed":
      return "音源分離完成";
    case "failed":
      return "音源分離失敗";
    default:
      return "待命";
  }
}

function FocusAbortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

export function BandMixer() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [restoringSession, setRestoringSession] = useState(true);
  const [restoringMessage, setRestoringMessage] = useState("正在檢查本機保存的歌曲工作階段…");
  const [restoreError, setRestoreError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [guardDialog, setGuardDialog] = useState<{
    title: string;
    subtitle?: string;
    assessment: ResourceRiskAssessment | null;
    networkEvaluation?: NetworkBatchEvaluation | null;
    resolve: (selection: ResourceGuardConfirmSelection | null) => void;
  } | null>(null);
  const [idleCleanupReport, setIdleCleanupReport] = useState<string>("");
  const [resourceProfile, setResourceProfile] = useState<DeviceResourceProfile | null>(null);
  const [profileWarning, setProfileWarning] = useState<string>("");
  const [separationFocus, setSeparationFocus] = useState<SeparationFocusUiState | null>(null);
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
  const persistedMetaBySongIdRef = useRef(new Map<string, PersistedSongRecord>());
  const separationTokensRef = useRef(new Map<string, symbol>());
  const separationFocusRef = useRef<SeparationFocusUiState | null>(null);
  const focusCleanupPromisesRef = useRef(new Map<string, Promise<void>>());
  const savedSettingsRef = useRef(new Map<string, SavedSongSettings>());
  const restorePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const removedSongIdsRef = useRef<Set<string>>(new Set());
  const lastPlayheadPersistAtRef = useRef<Map<string, number>>(new Map());
  const lastTimerTickAtRef = useRef<number>(0);
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

  const setSeparationFocusState = useCallback((next: SeparationFocusUiState | null) => {
    separationFocusRef.current = next;
    setSeparationFocus(next);
  }, []);

  const updateSeparationFocusState = useCallback((
    updater: (prev: SeparationFocusUiState | null) => SeparationFocusUiState | null,
  ) => {
    const next = updater(separationFocusRef.current);
    separationFocusRef.current = next;
    setSeparationFocus(next);
  }, []);

  const isFocusLocked = useCallback(() => Boolean(separationFocusRef.current?.active), []);

  const refreshResourceProfile = useCallback(async (options?: {
    afterCleanup?: boolean;
    stabilityVerified?: boolean;
  }): Promise<DeviceResourceProfile> => {
    const cap = await collectDeviceCapabilities();
    const signals = sharedPerfTelemetry.getSignals();
    if (options?.afterCleanup) {
      const result = sharedResourceProfileManager.reevaluateAfterCleanup({
        capabilities: cap,
        performanceSignals: signals,
        cleanupCompleted: true,
        stabilityVerified: Boolean(options.stabilityVerified),
      });
      setResourceProfile(result.profile);
      if (result.upgraded) {
        setProfileWarning("");
      } else if (result.profile.degradationReason) {
        setProfileWarning(result.profile.degradationReason);
      }
      return result.profile;
    }

    const result = sharedResourceProfileManager.evaluate(cap, signals);
    setResourceProfile(result.profile);
    if (result.justDegraded && result.profile.degradationReason) {
      setProfileWarning(result.profile.degradationReason);
      showShortcutHint(`資源保護已自動降級至 ${result.profile.tier} 模式：${result.profile.degradationReason}`);
    } else if (result.profile.degradationReason && !profileWarning) {
      setProfileWarning(result.profile.degradationReason);
    }
    return result.profile;
  }, [profileWarning, showShortcutHint]);

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
  ): BandSong => {
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
    return nextSong;
  }, [applySongToEngine, getEngine, persistSongDebounced]);

  const finishSeparationFocus = useCallback((params: {
    songId: string;
    outcome: "completed" | "cancelled" | "failed";
    message: string;
    completedSong?: BandSong;
  }): Promise<void> => {
    const existing = focusCleanupPromisesRef.current.get(params.songId);
    if (existing) return existing;

    const cleanupPromise = (async () => {
      await disposeStemSeparator({ revokeModelUrl: false }).catch(() => undefined);
      if (params.outcome === "cancelled") {
        sharedPerfTelemetry.markAbortSettled();
      }
      const diagnostics = sharedPerfTelemetry.getDiagnosticsReport();
      if (params.outcome === "cancelled" || params.outcome === "completed") {
        sharedPerfTelemetry.resetStressCountersAfterCleanup();
      }
      const workerStillActive = isSeparatorWorkerActive();
      const currentFocus = separationFocusRef.current;

      if (currentFocus && currentFocus.songId === params.songId && currentFocus.active) {
        const snapshot = currentFocus.snapshot;
        if (snapshot) {
          const engine = getEngine();
          const songsForEngine = sessionRef.current.songs.map((item) => (
            params.completedSong && item.id === params.completedSong.id ? params.completedSong : item
          ));
          const restoredForEngine = restoreSongsAfterSeparationFocus(songsForEngine, snapshot, {
            outcome: params.outcome,
          });
          for (const restoredSong of restoredForEngine) {
            // 僅還原設定與播放位置，保持暫停絕不自動播放
            engine.pauseTracks([restoredSong.sourceAudioId, ...restoredSong.stemIds]);
            engine.seekTracks([restoredSong.sourceAudioId, ...restoredSong.stemIds], restoredSong.playheadSec);
            applySongToEngine(restoredSong);
            if (restoredSong.sourceAudioHash) {
              persistSongDebounced(restoredSong.id, 150);
            }
          }
          setSession((previous) => ({
            ...previous,
            songs: restoreSongsAfterSeparationFocus(previous.songs, snapshot, {
              outcome: params.outcome,
            }),
          }));
        }

        const workerNote = workerStillActive
          ? "（Worker 仍在背景結束中）"
          : "（Worker 與暫存已釋放，資源鎖已解除）";
        updateSeparationFocusState((prev) => {
          if (!prev || prev.songId !== params.songId) return prev;
          return {
            ...prev,
            active: false,
            outcome: params.outcome,
            stage: params.outcome,
            progress: params.outcome === "completed" ? 1 : 0,
            message: `${params.message}${workerNote}`,
            snapshot: null,
            diagnosticsSummary: diagnostics.longTaskCount > 0 || diagnostics.lastAbortLatencyMs !== null
              ? diagnostics.summary
              : null,
          };
        });
      }

      await refreshResourceProfile({
        afterCleanup: params.outcome === "cancelled" || params.outcome === "completed",
        stabilityVerified:
          !workerStillActive
          && !sharedSeparationCoordinator.hasRunningHeavyTask()
          && !sharedSeparationCoordinator.isBusyWaitingCleanup(),
      }).catch(() => undefined);
    })().finally(() => {
      focusCleanupPromisesRef.current.delete(params.songId);
    });

    focusCleanupPromisesRef.current.set(params.songId, cleanupPromise);
    return cleanupPromise;
  }, [applySongToEngine, getEngine, persistSongDebounced, refreshResourceProfile, updateSeparationFocusState]);

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

  const requestGuardConfirmation = useCallback(
    (params: {
      title: string;
      subtitle?: string;
      assessment: ResourceRiskAssessment | null;
      networkEvaluation?: NetworkBatchEvaluation | null;
    }): Promise<ResourceGuardConfirmSelection | null> =>
      new Promise((resolve) => {
        setGuardDialog({
          title: params.title,
          subtitle: params.subtitle,
          assessment: params.assessment,
          networkEvaluation: params.networkEvaluation,
          resolve,
        });
      }),
    [],
  );

  const releaseIdleResources = useCallback(async (options?: {
    excludeSongIds?: readonly string[];
    quiet?: boolean;
  }): Promise<{ releasedSongs: number; estimatedFreedBytes: number; revokedModelUrl: boolean }> => {
    const engine = getEngine();
    const excludeSet = new Set(options?.excludeSongIds ?? []);
    const activeProtectedIds = new Set<string>(excludeSet);

    for (const song of sessionRef.current.songs) {
      if (song.status === "playing" || song.separationStatus === "processing" || song.separationStatus === "cancelling") {
        activeProtectedIds.add(song.id);
      }
      if (sharedSeparationCoordinator.getActiveController(song.id)) {
        activeProtectedIds.add(song.id);
      }
    }

    const idleSongIds: string[] = [];
    const idleTrackIds: string[] = [];
    for (const song of sessionRef.current.songs) {
      if (activeProtectedIds.has(song.id)) continue;
      const trackIds = [song.sourceAudioId, ...song.stemIds];
      const hasLoadedTrack = trackIds.some((id) => engine.hasTrack(id));
      const hasStemPcm = stemResultsRef.current.has(song.id);
      if (hasLoadedTrack || hasStemPcm) {
        idleSongIds.push(song.id);
        idleTrackIds.push(...trackIds);
      }
    }

    const { estimatedFreedBytes } = engine.releaseIdleTracks(idleTrackIds);
    for (const songId of idleSongIds) {
      stemResultsRef.current.delete(songId);
    }

    if (idleSongIds.length > 0) {
      const idleIdSet = new Set(idleSongIds);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((song) => (
          idleIdSet.has(song.id)
            ? {
                ...song,
                status: song.status === "playing" ? song.status : "stopped",
                audioLoadState: "unloaded",
                stemIds: [],
                playbackSource: song.playbackSource === "stems" ? "original" : song.playbackSource,
              }
            : song
        )),
      }));
    }

    let revokedModelUrl = false;
    if (!sharedSeparationCoordinator.hasRunningHeavyTask() && !sharedSeparationCoordinator.isBusyWaitingCleanup()) {
      await disposeStemSeparator({ revokeModelUrl: true });
      revokedModelUrl = true;
    }

    if (!options?.quiet && (idleSongIds.length > 0 || revokedModelUrl)) {
      sharedPerfTelemetry.resetStressCountersAfterCleanup();
    }
    const stabilityVerified = Boolean(
      !options?.quiet
      && (idleSongIds.length > 0 || revokedModelUrl)
      && !sharedSeparationCoordinator.hasRunningHeavyTask()
      && !sharedSeparationCoordinator.isBusyWaitingCleanup(),
    );
    await refreshResourceProfile({
      afterCleanup: idleSongIds.length > 0 || revokedModelUrl,
      stabilityVerified,
    }).catch(() => undefined);

    const reportText = idleSongIds.length > 0 || revokedModelUrl
      ? `已釋放 ${idleSongIds.length} 首閒置歌曲的解碼音訊緩衝（估計減少約 ${formatEstimatedMiB(estimatedFreedBytes)}）${revokedModelUrl ? "、已關閉閒置 AI 分離模型/Worker" : ""}。已解除記憶體參照與斷開音訊節點，實際作業系統 RAM 回收由瀏覽器決定（不會刪除原始音檔與已存快取）。`
      : "目前沒有可安全釋放的閒置音訊資源（播放中／分離中歌曲及快照參照已保留）。";

    if (!options?.quiet) {
      setIdleCleanupReport(reportText);
      showShortcutHint(reportText);
    }

    return {
      releasedSongs: idleSongIds.length,
      estimatedFreedBytes,
      revokedModelUrl,
    };
  }, [getEngine, refreshResourceProfile, showShortcutHint]);

  const ensureSongAudioReady = useCallback(async (
    song: BandSong,
    options?: { skipGuard?: boolean; allowDuringFocus?: boolean },
  ): Promise<boolean> => {
    const engine = getEngine();
    if (engine.hasTrack(song.sourceAudioId) && song.audioLoadState !== "unloaded") {
      return true;
    }
    if (!options?.allowDuringFocus && isFocusLocked()) {
      const msg = "分離專注模式啟動中，暫時鎖定解碼與載入其他音檔。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return false;
    }

    let file = sourceFilesRef.current.get(song.id);
    if (!file && song.sourceAudioHash) {
      const audioRecord = await getPersistedAudioBlobByKey(song.sourceAudioHash).catch(() => null);
      if (audioRecord && audioRecord.blob instanceof Blob) {
        file = new File([audioRecord.blob], song.fileName, {
          type: song.mimeType || audioRecord.mimeType || audioRecord.blob.type || "audio/*",
          lastModified: song.fileLastModified || audioRecord.lastModified || Date.now(),
        });
        sourceFilesRef.current.set(song.id, file);
      }
    }

    if (!file) {
      patchSongMetadataOnly(song.id, {
        audioLoadState: "error",
        persistenceStatus: "missing_audio",
        persistenceMessage: "找不到本機原始音檔，請重新選取音檔。",
      });
      return false;
    }

    if (!options?.skipGuard) {
      const cap = await collectDeviceCapabilities();
      const profileEval = sharedResourceProfileManager.evaluate(cap, sharedPerfTelemetry.getSignals());
      setResourceProfile(profileEval.profile);
      const assessment = assessResourceRisk({
        operation: "decode",
        songName: song.name,
        fileSizeBytes: file.size,
        durationSec: song.durationSec,
        mimeType: file.type,
        activeSongCount: sessionRef.current.songs.length,
        playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
        activeSoundTouchTracks: engine.getActiveSoundTouchCount(),
        estimatedInMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
        hasOtherIdleDecodedSongs: sessionRef.current.songs.some((s) => s.id !== song.id && s.status !== "playing" && engine.hasTrack(s.sourceAudioId)),
        profile: profileEval.profile,
        capabilities: cap,
        performanceSignals: sharedPerfTelemetry.getSignals(),
      });
      if (assessment.requiresConfirmation) {
        const decision = await requestGuardConfirmation({
          title: `確認解碼載入「${song.name}」`,
          subtitle: "大型或高負載音檔解碼前風險檢查",
          assessment,
        });
        if (!decision || assessment.admission.hardRejected) return false;
        if (decision.applyLowLoadActions.includes("pause-other-songs")) {
          for (const other of sessionRef.current.songs) {
            if (other.id !== song.id && other.status === "playing") {
              engine.pauseTracks(getSongPlaybackTrackIds(other));
              patchSongMetadataOnly(other.id, { status: "paused" });
            }
          }
        }
        if (decision.applyLowLoadActions.includes("release-idle-buffers")) {
          await releaseIdleResources({ excludeSongIds: [song.id], quiet: true });
        }
      }
    }

    patchSongMetadataOnly(song.id, {
      audioLoadState: "decoding",
      persistenceMessage: "正在按需解碼音訊…",
    });

    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const durationSec = await engine.loadTrack(song.sourceAudioId, file, "soundtouch");
      const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
      sharedPerfTelemetry.recordDecodeDuration(elapsed);

      if (removedSongIdsRef.current.has(song.id)) {
        engine.removeTrack(song.sourceAudioId);
        return false;
      }

      const persistedRecord = persistedMetaBySongIdRef.current.get(song.id);
      const restoredSnapshot = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
      const nextDuration = durationSec || restoredSnapshot.durationSec;
      const nextPlayhead = Math.min(nextDuration, restoredSnapshot.playheadSec);

      engine.seekTracks([song.sourceAudioId], nextPlayhead);
      const readySong: BandSong = {
        ...restoredSnapshot,
        durationSec: nextDuration,
        playheadSec: nextPlayhead,
        audioLoadState: "ready",
        persistenceStatus: "saved",
        persistenceMessage: "已保存在此裝置",
      };
      applySongToEngine(readySong);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((item) => (item.id === song.id ? readySong : item)),
      }));

      if (readySong.cacheKey) {
        const cached = await getCachedStemSet(readySong.cacheKey).catch(() => null);
        if (cached && !removedSongIdsRef.current.has(song.id)) {
          const preferred = persistedRecord?.playbackSource ?? readySong.playbackSource;
          installStemSet(readySong, cached, readySong.cacheKey, "已從本機快取載入分離結果。", {
            preferredSource: preferred,
            skipPersist: true,
          });
        }
      }
      return true;
    } catch {
      engine.removeTrack(song.sourceAudioId);
      patchSongMetadataOnly(song.id, {
        audioLoadState: "error",
        persistenceStatus: "missing_audio",
        persistenceMessage: "本機音檔毀損或格式無法解碼，請重新選取音檔。",
      });
      return false;
    }
  }, [applySongToEngine, getEngine, installStemSet, isFocusLocked, patchSongMetadataOnly, releaseIdleResources, requestGuardConfirmation, showCardFeedback, showShortcutHint]);

  const hydrateOnePersistedSong = useCallback(async (
    record: PersistedSongRecord,
    audioRecord: PersistedAudioFileRecord | null | undefined,
    isCancelled: () => boolean,
    options?: { deferDecode?: boolean },
  ) => {
    if (isCancelled() || removedSongIdsRef.current.has(record.songId)) return;
    persistedMetaBySongIdRef.current.set(record.songId, record);

    if (!audioRecord || !(audioRecord.blob instanceof Blob)) {
      patchSongMetadataOnly(record.songId, {
        audioLoadState: "error",
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
    sourceFilesRef.current.set(record.songId, restoredFile);

    if (options?.deferDecode) {
      const lazySong = restoreBandSongFromRecord(record, {
        sourceAudioId,
        durationSec: record.durationSec,
        persistenceStatus: "saved",
        persistenceMessage: "已保存在此裝置（點擊播放再按需解碼，節省手機記憶體）",
        audioLoadState: "unloaded",
      });
      setSession((previous) => {
        const exists = previous.songs.some((item) => item.id === lazySong.id);
        return {
          ...previous,
          songs: exists
            ? previous.songs.map((item) => (item.id === lazySong.id ? lazySong : item))
            : [...previous.songs, lazySong],
        };
      });
      return;
    }

    const engine = getEngine();
    let durationSec = record.durationSec;
    const decodeStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      durationSec = await engine.loadTrack(sourceAudioId, restoredFile, "soundtouch");
      sharedPerfTelemetry.recordDecodeDuration((typeof performance !== "undefined" ? performance.now() : Date.now()) - decodeStartedAt);
    } catch {
      engine.removeTrack(sourceAudioId);
      if (!isCancelled() && !removedSongIdsRef.current.has(record.songId)) {
        patchSongMetadataOnly(record.songId, {
          audioLoadState: "error",
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
      audioLoadState: "ready",
    });

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
    sharedPerfTelemetry.startObservingLongTasks();
    void refreshResourceProfile();

    const runRestore = async () => {
      setRestoringSession(true);
      setRestoreError("");
      setRestoringMessage("正在從本機資料庫恢復歌曲與設定…");
      try {
        const persisted = await loadPersistedBandSession();
        if (cancelled) return;
        if (persisted.songs.length === 0) {
          setRestoringSession(false);
          setRestoringMessage("");
          return;
        }

        const placeholders = persisted.songs.map((record, index) =>
          restoreBandSongFromRecord(record, {
            persistenceStatus: index === 0 ? "restoring" : "saved",
            persistenceMessage: index === 0 ? "正在恢復音檔與設定…" : "待按需解碼",
            audioLoadState: index === 0 ? "decoding" : "unloaded",
          }),
        );
        setSession((previous) => ({ ...previous, songs: placeholders }));
        setSelection((current) => (current.songId ? current : { songId: placeholders[0].id, stemId: null }));

        for (let i = 0; i < persisted.songs.length; i += 1) {
          if (cancelled) return;
          const record = persisted.songs[i];
          const shouldDeferDecode = i > 0;
          setRestoringMessage(
            shouldDeferDecode
              ? `正在建立清單（${i + 1}/${persisted.songs.length}，延遲解碼省記憶體）：${record.name}`
              : `正在恢復歌曲 (${i + 1}/${persisted.songs.length})：${record.name}`,
          );
          await hydrateOnePersistedSong(record, persisted.audioFilesByKey.get(record.audioKey), () => cancelled, {
            deferDecode: shouldDeferDecode,
          });
        }
      } catch (error) {
        if (!cancelled) {
          const reason = error instanceof Error && error.message ? error.message : "無法開啟或讀取本機 IndexedDB";
          setRestoreError(`工作階段恢復失敗：${reason}。你可以立即重試，或先手動匯入音檔使用。`);
        }
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
      sharedPerfTelemetry.stopObserving();
      engineRef.current?.dispose();
      engineRef.current = null;
      void disposeStemSeparator({ revokeModelUrl: true });
    };
  }, [applySongToEngine, getEngine, hydrateOnePersistedSong, patchSongMetadataOnly, refreshCacheStats, refreshResourceProfile, restoreAttempt, showCardFeedback, showShortcutHint]);

  useEffect(() => {
    lastTimerTickAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      const now = Date.now();
      const elapsed = now - lastTimerTickAtRef.current;
      lastTimerTickAtRef.current = now;
      if (elapsed > 380 && sessionRef.current.songs.some((song) => song.status === "playing")) {
        sharedPerfTelemetry.recordAudioUnderrun();
        void refreshResourceProfile();
      }
      if (!engine) return;
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
  }, [handlePersistResult, refreshResourceProfile]);

  const updateSong = useCallback((songId: string, patch: Partial<BandSong>, options?: { persistDelayMs?: number }) => {
    if (isFocusLocked()) {
      const blockedKey = FOCUS_BLOCKED_SONG_KEYS.find((key) => key in patch);
      if (blockedKey) {
        const msg = "分離專注模式啟動中，已暫時鎖定變速、升降 Key 與音軌參數變更。";
        showCardFeedback(songId, msg);
        showShortcutHint(msg);
        return;
      }
    }
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
  }, [applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const persistNewOrRelinkedSong = useCallback(async (song: BandSong, file: Blob, sourceAudioHash: string, force = false) => {
    const res = await saveSongWithAudioFile({ song, file, sourceAudioHash, force });
    handlePersistResult(song.id, res);
    void refreshCacheStats();
  }, [handlePersistResult, refreshCacheStats]);

  const handleFiles = async (fileList: File[] | FileList | null) => {
    const selectedFiles = fileList ? Array.from(fileList) : [];
    if (!selectedFiles.length) return;
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已鎖定載入新音檔與解碼，請待分離完成或中止後操作。";
      setUploadError(msg);
      showShortcutHint(msg);
      return;
    }
    setLoading(true);
    setUploadError("");
    setUploadStatus("正在等候工作階段同步完成…");
    try {
      await restorePromiseRef.current.catch(() => undefined);

      const engine = getEngine();
      const totalSelectedBytes = selectedFiles.reduce((sum, item) => sum + item.size, 0);
      const largestFile = selectedFiles.reduce((prev, curr) => (curr.size > prev.size ? curr : prev), selectedFiles[0]);
      const cap = await collectDeviceCapabilities();
      const uploadAssessment = assessResourceRisk({
        operation: "upload",
        songName: selectedFiles.length === 1 ? largestFile.name : `${selectedFiles.length} 個音訊檔`,
        fileSizeBytes: totalSelectedBytes,
        mimeType: largestFile.type,
        activeSongCount: sessionRef.current.songs.length,
        playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
        estimatedInMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
        hasOtherIdleDecodedSongs: sessionRef.current.songs.some((s) => s.status !== "playing" && engine.hasTrack(s.sourceAudioId)),
        capabilities: cap,
        performanceSignals: sharedPerfTelemetry.getSignals(),
      });

      if (uploadAssessment.requiresConfirmation) {
        const decision = await requestGuardConfirmation({
          title: `確認載入 ${selectedFiles.length} 個大型音檔`,
          subtitle: `總容量約 ${(totalSelectedBytes / (1024 * 1024)).toFixed(1)} MiB`,
          assessment: uploadAssessment,
        });
        if (!decision) {
          setUploadStatus("");
          return;
        }
        if (decision.applyLowLoadActions.includes("pause-other-songs")) {
          for (const other of sessionRef.current.songs) {
            if (other.status === "playing") {
              engine.pauseTracks(getSongPlaybackTrackIds(other));
              patchSongMetadataOnly(other.id, { status: "paused" });
            }
          }
        }
        if (decision.applyLowLoadActions.includes("release-idle-buffers")) {
          await releaseIdleResources({ quiet: true });
        }
      }

      setUploadStatus(`正在準備載入 ${selectedFiles.length} 個音檔…`);
      if (!persistRequestedRef.current) {
        persistRequestedRef.current = true;
        void requestPersistentStorage().then(() => refreshCacheStats());
      }
      for (const file of selectedFiles) {
        const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sourceAudioId = `${songId}_original`;
        setUploadStatus(`正在解碼音檔：${file.name}`);
        try {
          const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
          const durationSec = await engine.loadTrack(sourceAudioId, file, "soundtouch");
          sharedPerfTelemetry.recordDecodeDuration((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);
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
            audioLoadState: "ready",
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
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，暫時無法重新連結並解碼音檔。";
      showCardFeedback(songId, msg);
      showShortcutHint(msg);
      return;
    }
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
    if (isFocusLocked()) {
      const msg = "目前處於分離專注模式，已暫停音訊處理並鎖定啟動播放；請待分離完成或點擊「中止分離」。";
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
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
      const ready = await ensureSongAudioReady(song);
      if (!ready) return;
      if (isFocusLocked()) {
        const msg = "分離專注模式已啟動，取消本次播放。";
        setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
        showCardFeedback(song.id, msg);
        return;
      }
      const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
      const trackIds = getSongPlaybackTrackIds(latestSong);
      const engine = getEngine();
      const cap = await collectDeviceCapabilities();
      const perfSignals = sharedPerfTelemetry.getSignals();
      const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
      setResourceProfile(profileEval.profile);

      let projectedActiveSoundTouchTracks = engine.getProjectedSoundTouchCount(trackIds);
      let admission = evaluateTaskAdmission({
        operation: "soundtouch-playback",
        profile: profileEval.profile,
        capabilities: cap,
        estimatedTaskMemoryBytes: 0,
        inMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
        projectedActiveSoundTouchTracks,
        performanceSignals: perfSignals,
        separationFocusActive: isFocusLocked(),
      });

      if (!admission.allowed) {
        if (admission.hardRejected) {
          setPlaybackErrors((previous) => ({ ...previous, [latestSong.id]: admission.message }));
          setProfileWarning(admission.message);
          showCardFeedback(latestSong.id, admission.message);
          showShortcutHint(admission.message);
          return;
        }

        const otherPlayingSongs = sessionRef.current.songs.filter(
          (candidate) => candidate.id !== latestSong.id && candidate.status === "playing",
        );
        const hasOtherIdleDecoded = sessionRef.current.songs.some(
          (candidate) => candidate.id !== latestSong.id && candidate.status !== "playing" && engine.hasTrack(candidate.sourceAudioId),
        );
        const playbackAssessment = assessResourceRisk({
          operation: "soundtouch-playback",
          songName: latestSong.name,
          durationSec: latestSong.durationSec,
          fileSizeBytes: latestSong.fileSizeBytes,
          mimeType: latestSong.mimeType,
          activeSongCount: sessionRef.current.songs.length,
          playingSongCount: otherPlayingSongs.length,
          activeSoundTouchTracks: projectedActiveSoundTouchTracks,
          estimatedInMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
          hasOtherIdleDecodedSongs: hasOtherIdleDecoded,
          profile: profileEval.profile,
          capabilities: cap,
          performanceSignals: perfSignals,
        });

        if (playbackAssessment.lowLoadSuggestions.length === 0) {
          setPlaybackErrors((previous) => ({ ...previous, [latestSong.id]: admission.message }));
          setProfileWarning(admission.message);
          showCardFeedback(latestSong.id, admission.message);
          showShortcutHint(admission.message);
          return;
        }

        const decision = await requestGuardConfirmation({
          title: `多軌播放負載過高：「${latestSong.name}」`,
          subtitle: `目前 ${profileEval.profile.tier} 配置建議 SoundTouch 上限為 ${profileEval.profile.maxActiveSoundTouchTracks} 軌，需先套用降載後才允許播放。`,
          assessment: playbackAssessment,
        });
        if (!decision) {
          setPlaybackErrors((previous) => ({ ...previous, [latestSong.id]: admission.message }));
          return;
        }

        if (decision.applyLowLoadActions.includes("pause-other-songs")) {
          for (const other of otherPlayingSongs) {
            engine.pauseTracks(getSongPlaybackTrackIds(other));
            patchSongMetadataOnly(other.id, { status: "paused" });
          }
        }
        if (decision.applyLowLoadActions.includes("release-idle-buffers")) {
          await releaseIdleResources({ excludeSongIds: [latestSong.id], quiet: true });
        }

        projectedActiveSoundTouchTracks = engine.getProjectedSoundTouchCount(trackIds);
        admission = evaluateTaskAdmission({
          operation: "soundtouch-playback",
          profile: profileEval.profile,
          capabilities: cap,
          estimatedTaskMemoryBytes: 0,
          inMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
          projectedActiveSoundTouchTracks,
          performanceSignals: sharedPerfTelemetry.getSignals(),
          separationFocusActive: isFocusLocked(),
        });

        if (!admission.allowed) {
          setPlaybackErrors((previous) => ({ ...previous, [latestSong.id]: admission.message }));
          setProfileWarning(admission.message);
          showCardFeedback(latestSong.id, admission.message);
          showShortcutHint(admission.message);
          return;
        }
      }

      if (admission.requiresWarning) {
        setProfileWarning(admission.message);
        showShortcutHint(admission.message);
        showCardFeedback(latestSong.id, admission.message);
      }
      applySongToEngine(latestSong);
      await engine.playTracks(trackIds);
      updateSong(latestSong.id, { status: "playing" });
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
    if (isFocusLocked()) {
      showCardFeedback(song.id, "分離專注模式啟動中，已鎖定播放控制。");
      return;
    }
    if (startingSongIdsRef.current.has(song.id)) return;
    getEngine().pauseTracks(getSongPlaybackTrackIds(song));
    updateSong(song.id, { status: "paused" }, { persistDelayMs: 80 });
  };

  const stopSong = (song: BandSong) => {
    if (isFocusLocked()) {
      showCardFeedback(song.id, "分離專注模式啟動中，已鎖定播放控制。");
      return;
    }
    getEngine().stopTracks([song.sourceAudioId, ...song.stemIds]);
    updateSong(song.id, { status: "stopped", playheadSec: 0 }, { persistDelayMs: 80 });
  };

  const seekSong = (song: BandSong, seconds: number) => {
    if (isFocusLocked()) {
      showCardFeedback(song.id, "分離專注模式啟動中，暫時鎖定調整播放位置，以確保回復原始時間點。");
      return;
    }
    getEngine().seekTracks([song.sourceAudioId, ...song.stemIds], seconds);
    updateSong(song.id, { playheadSec: seconds }, { persistDelayMs: 250 });
  };

  const toggleMuteForSelection = useCallback((targetSelection: MixerSelection) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已暫停音訊處理並鎖定靜音變更。";
      if (targetSelection.songId) showCardFeedback(targetSelection.songId, msg);
      showShortcutHint(msg);
      return;
    }
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
  }, [applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const toggleSoloForSelection = useCallback((targetSelection: MixerSelection) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已暫停音訊處理並鎖定獨奏變更。";
      if (targetSelection.songId) showCardFeedback(targetSelection.songId, msg);
      showShortcutHint(msg);
      return;
    }
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
  }, [applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const switchSource = async (song: BandSong, playbackSource: "original" | "stems") => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已鎖定切換播放來源。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
    if (song.playbackSource === playbackSource || (playbackSource === "stems" && song.stemIds.length === 0)) return;
    const engine = getEngine();
    const oldIds = getSongPlaybackTrackIds(song);
    const nextSong = { ...song, playbackSource };
    const newIds = getSongPlaybackTrackIds(nextSong);
    if (song.status === "playing") {
      const cap = await collectDeviceCapabilities();
      const perfSignals = sharedPerfTelemetry.getSignals();
      const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
      setResourceProfile(profileEval.profile);
      const projected = Math.max(0, engine.getActiveSoundTouchCount() - 1) + 1;
      const admission = evaluateTaskAdmission({
        operation: "soundtouch-playback",
        profile: profileEval.profile,
        capabilities: cap,
        estimatedTaskMemoryBytes: 0,
        inMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
        projectedActiveSoundTouchTracks: projected,
        performanceSignals: perfSignals,
        separationFocusActive: isFocusLocked(),
      });
      if (!admission.allowed) {
        setProfileWarning(admission.message);
        showShortcutHint(admission.message);
        showCardFeedback(song.id, admission.message);
        return;
      }
      if (admission.requiresWarning) {
        setProfileWarning(admission.message);
        showShortcutHint(admission.message);
        showCardFeedback(song.id, admission.message);
      }
    }
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

  const abortSongSeparation = async (song: BandSong) => {
    sharedPerfTelemetry.markAbortRequested();
    patchSongMetadataOnly(song.id, {
      separationStatus: "cancelling",
      separationStage: "cancelling",
      separationMessage: "正在停止並釋放 Worker / Tensor 資源…",
    });
    if (separationFocusRef.current?.songId === song.id && separationFocusRef.current.active) {
      updateSeparationFocusState((prev) => (
        prev && prev.songId === song.id
          ? {
              ...prev,
              outcome: "cancelling",
              stage: "cancelling",
              message: "正在停止 Worker、清理 Tensor 並解除資源鎖定…",
            }
          : prev
      ));
    }
    await sharedSeparationCoordinator.cancelTask(song.id, "已中止音源分離，未改動既有設定與快取。", 80);
    await finishSeparationFocus({
      songId: song.id,
      outcome: "cancelled",
      message: "已中止音源分離，未改動既有設定與快取。",
    });
  };

  const restoreSongSnapshot = (song: BandSong) => {
    if (isFocusLocked()) {
      showCardFeedback(song.id, "分離專注模式啟動中，請待分離完成或中止後再回復狀態。");
      return;
    }
    const snapshot = song.activeSnapshot;
    if (!snapshot) return;
    const restored = applySongOperationSnapshot(song, snapshot);
    applySongToEngine(restored);
    getEngine().seekTracks([restored.sourceAudioId, ...restored.stemIds], restored.playheadSec);
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((item) => (
        item.id === song.id
          ? {
              ...restored,
              activeSnapshot: null,
              separationMessage: "已回復上一個穩定狀態與設定。",
            }
          : item
      )),
    }));
    showCardFeedback(song.id, "已回復上一個穩定狀態。");
    persistSongDebounced(song.id, 150);
  };

  const separateSong = async (song: BandSong, mode: StemSeparationMode) => {
    if (isFocusLocked()) {
      showCardFeedback(song.id, "目前處於分離專注模式，請等待目前分離任務完成或先中止後再試。");
      return;
    }
    if (song.separationStatus === "processing" || song.separationStatus === "cancelling") {
      return;
    }
    if (sharedSeparationCoordinator.isBusyWaitingCleanup()) {
      showCardFeedback(song.id, "上一個分離任務仍在停止並釋放資源，請稍候片刻再試。");
      return;
    }
    if (sharedSeparationCoordinator.hasRunningHeavyTask(song.id)) {
      showCardFeedback(song.id, "目前已有其他歌曲正在分離，請先完成或中止後再試。");
      showShortcutHint("一次僅執行一個 Demucs AI 分離任務，以保護行動裝置記憶體。");
      return;
    }

    const ready = await ensureSongAudioReady(song, { skipGuard: true, allowDuringFocus: true });
    if (!ready) return;
    const latestReadySong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    const file = sourceFilesRef.current.get(song.id);
    if (!file) {
      updateSong(song.id, { separationStatus: "failed", separationMessage: "原始音訊已不在記憶體，請重新載入歌曲。" });
      return;
    }

    const sourceAudioHash = latestReadySong.sourceAudioHash || await hashSourceAudio(file);
    const cacheKey = createSeparationCacheKey({
      sourceAudioHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: mode,
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });
    const preCached = await getCachedStemSet(cacheKey).catch(() => null);

    const engine = getEngine();
    const cap = await collectDeviceCapabilities();
    const perfSignals = sharedPerfTelemetry.getSignals();
    const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
    setResourceProfile(profileEval.profile);
    let maxThreads = profileEval.profile.maxWasmThreads;
    let userSelectedPausePlayback = false;
    const footprint = preCached
      ? { estimatedMemoryBytes: 0, estimatedStorageBytes: 0 }
      : estimateOperationFootprint({
          operation: "separate",
          songName: latestReadySong.name,
          fileSizeBytes: file.size,
          durationSec: latestReadySong.durationSec,
          mimeType: file.type,
          separationMode: mode,
          capabilities: cap,
        });

    if (!preCached) {
      const networkEval = await preflightSeparationNetworkBudget();
      const assessment = assessResourceRisk({
        operation: "separate",
        songName: latestReadySong.name,
        fileSizeBytes: file.size,
        durationSec: latestReadySong.durationSec,
        mimeType: file.type,
        separationMode: mode,
        activeSongCount: sessionRef.current.songs.length,
        playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
        activeSoundTouchTracks: engine.getActiveSoundTouchCount(),
        runningDemucsCount: sharedSeparationCoordinator.hasRunningHeavyTask() ? 1 : 0,
        estimatedInMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
        hasOtherIdleDecodedSongs: sessionRef.current.songs.some((s) => s.id !== song.id && s.status !== "playing" && engine.hasTrack(s.sourceAudioId)),
        profile: profileEval.profile,
        capabilities: cap,
        performanceSignals: perfSignals,
      });

      if (assessment.requiresConfirmation || !networkEval.allowed) {
        const decision = await requestGuardConfirmation({
          title: `音源分離風險與傳輸確認：「${latestReadySong.name}」`,
          subtitle: `目前選擇：${mode === "four_stem" ? "4 Stem（人聲／鼓／貝斯／其他）" : "2 Stem（人聲／伴奏）"}`,
          assessment,
          networkEvaluation: networkEval,
        });
        if (!decision) return;
        if (assessment.admission.hardRejected || !networkEval.allowed) return;
        if (decision.applyLowLoadActions.includes("pause-other-songs")) {
          userSelectedPausePlayback = true;
        }
        if (decision.applyLowLoadActions.includes("release-idle-buffers")) {
          await releaseIdleResources({ excludeSongIds: [song.id], quiet: true });
        }
        if (decision.applyLowLoadActions.includes("limit-inference-threads")) {
          maxThreads = Math.max(1, Math.min(maxThreads, 2));
        }
      } else if (assessment.riskLevel === "medium") {
        showCardFeedback(song.id, `提示：本裝置估計達中等負載（${assessment.estimatedDurationLabel}）。`);
      }
    }

    const focusDecision = preCached
      ? { enabled: false, reasons: [] as string[] }
      : shouldEnterSeparationFocusMode({
          profile: profileEval.profile,
          performanceSignals: sharedPerfTelemetry.getSignals(),
          estimatedSeparationMemoryBytes: footprint.estimatedMemoryBytes,
          inMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
          activeSoundTouchTracks: engine.getActiveSoundTouchCount(),
          userSelectedPausePlayback,
        });

    if (focusDecision.enabled) {
      // 必須在啟動 Demucs 前實質暫停所有播放以停止 SoundTouch DSP（禁止僅用 Mute）
      const pauseResult = engine.pauseAllActivePlayback();
      const currentSongs = sessionRef.current.songs;
      const playheadOverrides: Record<string, number> = {};
      for (const candidate of currentSongs) {
        const trackIds = [candidate.sourceAudioId, ...candidate.stemIds];
        for (const tid of trackIds) {
          const pos = pauseResult.positionsByTrackId[tid];
          if (typeof pos === "number" && Number.isFinite(pos)) {
            playheadOverrides[candidate.id] = pos;
            break;
          }
        }
      }
      const focusSnapshot = createSeparationFocusSessionSnapshot(
        currentSongs,
        song.id,
        focusDecision.reasons,
        playheadOverrides,
      );
      const pausedIdSet = new Set(focusSnapshot.pausedSongIds);
      const pausedSongNames = currentSongs
        .filter((candidate) => pausedIdSet.has(candidate.id))
        .map((candidate) => candidate.name);

      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => {
          const pos = playheadOverrides[candidate.id];
          if (pausedIdSet.has(candidate.id)) {
            return {
              ...candidate,
              status: "paused",
              playheadSec: Number.isFinite(pos) ? pos : candidate.playheadSec,
            };
          }
          return candidate;
        }),
      }));

      setSeparationFocusState({
        active: true,
        outcome: "running",
        songId: song.id,
        songName: latestReadySong.name,
        stage: "preparing",
        progress: 0.02,
        message: pausedSongNames.length
          ? `已暫停 ${pausedSongNames.length} 首播放中歌曲，準備開始分離…`
          : "已開啟分離專注模式並鎖定高負載音訊操作，準備開始分離…",
        reasons: focusDecision.reasons,
        pausedSongNames,
        snapshot: focusSnapshot,
        diagnosticsSummary: null,
      });
    } else if (userSelectedPausePlayback) {
      engine.pauseAllActivePlayback();
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (
          candidate.status === "playing" ? { ...candidate, status: "paused" } : candidate
        )),
      }));
    }

    const postPauseSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? latestReadySong;
    const stableSnapshot = createSongOperationSnapshot(
      focusDecision.enabled && postPauseSong.status === "playing"
        ? { ...postPauseSong, status: "paused" }
        : postPauseSong,
      "音源分離前穩定狀態",
    );
    patchSongMetadataOnly(song.id, {
      activeSnapshot: stableSnapshot,
      separationStatus: "processing",
      separationMode: mode,
      separationStage: "preparing",
      separationProgress: 0.02,
      separationMessage: "正在準備分離任務…",
    });

    let controller;
    try {
      controller = sharedSeparationCoordinator.startTask({
        songId: song.id,
        throttleMs: 180,
        cooldownMs: 80,
        onProgress: (event) => {
          if (event.stage === "cancelling") {
            patchSongMetadataOnly(song.id, {
              separationStatus: "cancelling",
              separationStage: "cancelling",
              separationMessage: event.message,
            });
            if (separationFocusRef.current?.songId === song.id && separationFocusRef.current.active) {
              updateSeparationFocusState((prev) => (
                prev && prev.songId === song.id
                  ? { ...prev, outcome: "cancelling", stage: "cancelling", message: event.message }
                  : prev
              ));
            }
            return;
          }
          if (event.stage === "cancelled") {
            const restoredSource =
              stableSnapshot.playbackSource === "stems" && (sessionRef.current.songs.find((s) => s.id === song.id)?.stemIds.length ?? 0) > 0
                ? "stems"
                : "original";
            patchSongMetadataOnly(song.id, {
              separationStatus: "cancelled",
              separationStage: "cancelled",
              separationProgress: 0,
              playbackSource: restoredSource,
              separationMessage: event.message,
            });
            return;
          }
          if (event.stage === "preparing" || event.stage === "downloading" || event.stage === "processing") {
            patchSongMetadataOnly(song.id, {
              separationStatus: "processing",
              separationStage: event.stage,
              separationProgress: event.progress,
              separationMessage: event.message,
            });
            if (separationFocusRef.current?.songId === song.id && separationFocusRef.current.active) {
              updateSeparationFocusState((prev) => (
                prev && prev.songId === song.id && prev.active
                  ? {
                      ...prev,
                      stage: event.stage,
                      progress: typeof event.progress === "number" ? event.progress : prev.progress,
                      message: event.message,
                    }
                  : prev
              ));
            }
          }
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "目前無法啟動分離任務。";
      patchSongMetadataOnly(song.id, {
        separationStatus: stableSnapshot.separationStatus,
        separationMessage: errMsg,
      });
      await finishSeparationFocus({
        songId: song.id,
        outcome: "failed",
        message: errMsg,
      });
      return;
    }

    const token = Symbol(song.id);
    separationTokensRef.current.set(song.id, token);

    try {
      let stems = preCached;
      let message = "已從本機快取載入分離結果。";
      if (!stems) {
        const result = await separateAudio(file, {
          mode,
          controller,
          maxThreads,
        });
        sharedPerfTelemetry.recordSeparationDuration(result.durationMs);
        controller.throwIfAborted();
        stems = result.stems;
        controller.updateProgress("processing", 0.98, "正在驗證並寫入本機分離快取…");
        message = `分離完成（${result.backend === "webgpu" ? "WebGPU" : "WASM"}${result.usedWorker ? " · Worker" : ""}）。`;
        try {
          controller.throwIfAborted();
          await putCachedStemSet(createStemCacheRecord({
            key: cacheKey,
            sourceAudioHash,
            modelVersion: DEMUCS_MODEL_VERSION,
            processingVersion: SEPARATION_PROCESSING_VERSION,
            stems,
          }));
        } catch (cacheError) {
          if (isAbortError(cacheError)) throw cacheError;
          message += ` ${cacheError instanceof Error ? cacheError.message : "結果無法持久快取。"}`;
        }
      }

      controller.throwIfAborted();
      if (!controller.isCurrent() || removedSongIdsRef.current.has(song.id)) {
        await finishSeparationFocus({
          songId: song.id,
          outcome: "cancelled",
          message: "任務已結束，已解除專注模式鎖定。",
        });
        return;
      }
      const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id);
      if (!latestSong) {
        await finishSeparationFocus({
          songId: song.id,
          outcome: "cancelled",
          message: "歌曲已移除，已解除專注模式鎖定。",
        });
        return;
      }

      controller.markCompleted(message);
      const installedSong = installStemSet(latestSong, stems, cacheKey, message);
      showCardFeedback(song.id, message);
      void refreshCacheStats();
      await finishSeparationFocus({
        songId: song.id,
        outcome: "completed",
        message,
        completedSong: installedSong,
      });
    } catch (error) {
      if (isAbortError(error) || controller.isCancellingOrCancelled()) {
        await controller.cancel("已中止音源分離，已恢復操作前穩定狀態。");
        await finishSeparationFocus({
          songId: song.id,
          outcome: "cancelled",
          message: "已中止音源分離，已恢復操作前穩定狀態。",
        });
        return;
      }
      if (!controller.isCurrent()) return;
      const errMsg = error instanceof Error ? error.message : "音源分離失敗。";
      controller.markFailed(errMsg);
      patchSongMetadataOnly(song.id, {
        separationStatus: "failed",
        separationStage: "failed",
        separationProgress: 0,
        playbackSource: stableSnapshot.playbackSource === "stems" && song.stemIds.length > 0 ? "stems" : "original",
        separationMessage: errMsg,
      });
      await finishSeparationFocus({
        songId: song.id,
        outcome: "failed",
        message: errMsg,
      });
    } finally {
      if (separationTokensRef.current.get(song.id) === token) {
        separationTokensRef.current.delete(song.id);
      }
      if (
        separationFocusRef.current?.active
        && separationFocusRef.current.songId === song.id
        && !focusCleanupPromisesRef.current.has(song.id)
      ) {
        await finishSeparationFocus({
          songId: song.id,
          outcome: "cancelled",
          message: "分離流程結束並釋放資源鎖定。",
        });
      }
    }
  };

  const updateStem = (song: BandSong, stemId: string, patch: Partial<StemChannel>) => {
    updateSong(song.id, { stemChannels: song.stemChannels.map((channel) => channel.id === stemId ? { ...channel, ...patch } : channel) });
  };

  const downloadStem = (song: BandSong, stemId: string) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，為避免額外記憶體尖峰已暫停大型 WAV 匯出。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
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
    if (isFocusLocked()) {
      const msg = "分離進行中暫停清理快取，以確保既有分離快取不被誤刪。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
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
    if (isFocusLocked()) {
      showShortcutHint("分離專注模式啟動中，暫停清理分離快取。");
      return;
    }
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
    sharedSeparationCoordinator.invalidateSongGeneration(song.id);
    void sharedSeparationCoordinator.cancelTask(song.id, "歌曲已移除，中止進行中的分離任務。", 0);
    if (separationFocusRef.current?.songId === song.id && separationFocusRef.current.active) {
      void finishSeparationFocus({
        songId: song.id,
        outcome: "cancelled",
        message: "歌曲已移除並中止分離，解除資源鎖定。",
      });
    }
    cancelPendingSongPersist(song.id);
    persistedMetaBySongIdRef.current.delete(song.id);
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

    if (isFocusLocked()) {
      showShortcutHint("目前處於分離專注模式，已暫停播放（Space）與所有高負載音訊快捷鍵操作。");
      return;
    }

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
  const focusLocked = Boolean(separationFocus?.active);
  const focusAbortSong = separationFocus
    ? session.songs.find((song) => song.id === separationFocus.songId) ?? null
    : null;
  const playSelectedSongs = async () => {
    if (isFocusLocked()) {
      showShortcutHint("分離專注模式啟動中，已鎖定批次播放。");
      return;
    }
    for (const target of selectedSongs) {
      if (isFocusLocked()) break;
      await playSong(target);
    }
  };

  return (
    <div className={`grid mixer-shell${hasMultipleSelectedSongs ? " has-selected" : ""}`} style={{ gap: 16 }}>
      <div className="card row mixer-upload" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className={`btn mixer-button primary${loading ? " is-loading" : ""}`}
          disabled={loading || focusLocked}
          aria-busy={loading}
          title={
            focusLocked
              ? "分離專注模式啟動中，暫停載入與解碼新音檔"
              : loading
                ? "正在讀取與解碼音檔，請稍候"
                : undefined
          }
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
            icon="🧹"
            label="釋放閒置資源（卸載未播放歌曲緩衝與閒置 Worker）"
            onClick={() => void releaseIdleResources()}
          />
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

      {separationFocus && (() => {
        const isRunning = separationFocus.active;
        const isCancelling = separationFocus.outcome === "cancelling";
        const hasDeterminate =
          isRunning
          && !isCancelling
          && typeof separationFocus.progress === "number"
          && Number.isFinite(separationFocus.progress)
          && separationFocus.progress > 0
          && separationFocus.progress < 1;
        const pct = hasDeterminate ? Math.round((separationFocus.progress ?? 0) * 100) : null;
        const bannerStateClass =
          separationFocus.outcome === "failed"
            ? " is-failed"
            : separationFocus.outcome === "cancelling"
              ? " is-cancelling"
              : separationFocus.outcome === "completed"
                ? " is-completed"
                : "";
        return (
          <section
            role="status"
            aria-live="polite"
            aria-label="音源分離專注模式狀態"
            className={`card mixer-focus-banner${bannerStateClass}`}
          >
            <div className="row" style={{ gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div className="row" style={{ gap: 10, alignItems: "center", flex: "1 1 220px", minWidth: 0 }}>
                {isRunning && <span className="mixer-spinner" aria-hidden="true" />}
                <div className="grid" style={{ gap: 3, minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>
                    分離專注模式｜{separationFocus.songName}
                  </strong>
                  <span className="small" style={{ color: "#e2e8f0" }}>
                    目前階段：{formatSeparationFocusStageLabel(separationFocus.stage)}
                    {pct !== null ? `（${pct}%）` : ""}
                  </span>
                </div>
              </div>
              {isRunning ? (
                <button
                  type="button"
                  className="btn mixer-abort-button"
                  disabled={isCancelling || !focusAbortSong}
                  aria-label={isCancelling ? "正在中止音源分離" : `中止「${separationFocus.songName}」音源分離`}
                  onClick={() => {
                    if (focusAbortSong) void abortSongSeparation(focusAbortSong);
                  }}
                >
                  <FocusAbortIcon />
                  <span>{isCancelling ? "正在停止…" : "中止分離"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn mixer-button"
                  style={{ minHeight: 44, padding: "6px 14px", fontSize: 13 }}
                  onClick={() => setSeparationFocusState(null)}
                >
                  關閉狀態列
                </button>
              )}
            </div>

            {isRunning && (
              <div
                role="progressbar"
                aria-label="分離專注模式進度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                className={`mixer-progress-track${hasDeterminate ? "" : " is-indeterminate"}`}
              >
                <div
                  className="mixer-progress-fill"
                  style={pct !== null ? { width: `${pct}%` } : undefined}
                />
              </div>
            )}

            <p className="small" style={{ margin: 0, color: "#cbd5e1" }}>
              {separationFocus.message}
            </p>

            {isRunning && (
              <p className="small" style={{ margin: 0, color: "#bae6fd" }}>
                已暫停音訊播放以降低資源負擔，並鎖定變速、升降 Key、匯出 WAV 與啟動新播放；原有設定與播放位置將於結束後完整保留（維持暫停，不會自動發聲）。
                {separationFocus.pausedSongNames.length > 0
                  ? ` 已暫停：${separationFocus.pausedSongNames.join("、")}。`
                  : ""}
              </p>
            )}

            {separationFocus.diagnosticsSummary && (
              <p className="small" style={{ margin: 0, color: "#94a3b8" }}>
                效能診斷：{separationFocus.diagnosticsSummary}
              </p>
            )}
          </section>
        );
      })()}

      {restoreError && (
        <div role="alert" className="card card-error-banner">
          <span>{restoreError}</span>
          <button
            type="button"
            className="btn mixer-button"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setRestoreAttempt((n) => n + 1)}
          >
            ↻ 重試恢復工作階段
          </button>
        </div>
      )}

      {profileWarning && (
        <div role="status" aria-live="polite" className="card card-warning-banner">
          <span>{profileWarning}</span>
          <button type="button" className="btn mixer-button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setProfileWarning("")}>
            關閉
          </button>
        </div>
      )}

      {idleCleanupReport && (
        <div role="status" aria-live="polite" className="card card-warning-banner" style={{ borderColor: "rgba(56, 189, 248, 0.35)", background: "rgba(56, 189, 248, 0.08)", color: "#e0f2fe" }}>
          <span>{idleCleanupReport}</span>
          <button type="button" className="btn mixer-button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setIdleCleanupReport("")}>
            關閉
          </button>
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
            <button type="button" className="btn mixer-button" disabled={focusLocked} onClick={() => void releaseIdleResources()}>🧹 釋放閒置資源</button>
            <button type="button" className="btn mixer-button" disabled={focusLocked} onClick={() => void handleClearUnusedSeparationCaches()}>清除未使用快取</button>
            <button type="button" className="btn mixer-button" disabled={focusLocked} onClick={() => void clearAllSeparationCache()}>清理分離結果</button>
            <button type="button" className="btn mixer-button" disabled={focusLocked} onClick={() => void clearModelCache().then(refreshCacheStats)}>清理模型快取</button>
            <button type="button" className="btn mixer-button" onClick={() => void refreshCacheStats()}>重新整理</button>
          </div>
          <div className="small" style={{ opacity: 0.78, marginTop: 8 }}>
            網路預算監測（所有裝置統一上限 {(sharedNetworkBudgetLedger.getSnapshot().budgetBytes / (1024 * 1024)).toFixed(1)} MiB）：
            Vercel 靜態 {(sharedNetworkBudgetLedger.getSnapshot().vercelStaticBytes / (1024 * 1024)).toFixed(1)} MiB ｜ 外部 CDN {(sharedNetworkBudgetLedger.getSnapshot().externalCdnBytes / (1024 * 1024)).toFixed(1)} MiB
          </div>
          {resourceProfile && (
            <div className="small" style={{ opacity: 0.85, marginTop: 6 }}>
              動態資源配置：<strong>{resourceProfile.tier.toUpperCase()}</strong>
              {resourceProfile.degraded ? `（已自動降級，原 ${resourceProfile.initialTier}）` : ""}
              {" ｜ "}WASM Threads 上限：{resourceProfile.maxWasmThreads}
              {" ｜ "}工作記憶體預算：{(resourceProfile.workingMemoryBudgetBytes / (1024 * 1024)).toFixed(0)} MiB
              {" ｜ "}SoundTouch 上限：{resourceProfile.maxActiveSoundTouchTracks} 軌
              {" ｜ "}Demucs 併發上限：{resourceProfile.demucsConcurrency}
            </div>
          )}
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
            disabled={!selectedSongs.length || focusLocked}
            disabledReason={
              focusLocked
                ? "分離專注模式啟動中，已暫停播放與批次啟動"
                : !selectedSongs.length
                  ? "請先勾選至少一首歌曲"
                  : undefined
            }
            className="is-compact"
            onClick={() => void playSelectedSongs()}
          />
          <IconActionButton
            icon="⏸"
            label="暫停所選歌曲"
            disabled={!selectedSongs.length || focusLocked}
            disabledReason={
              focusLocked
                ? "分離專注模式啟動中，所有歌曲皆已暫停"
                : !selectedSongs.length
                  ? "請先勾選至少一首歌曲"
                  : undefined
            }
            className="is-compact"
            onClick={() => selectedSongs.forEach(pauseSong)}
          />
          <IconActionButton
            icon="■"
            label="停止所選歌曲"
            disabled={!selectedSongs.length || focusLocked}
            disabledReason={
              focusLocked
                ? "分離專注模式啟動中，已鎖定停止以保留還原位置"
                : !selectedSongs.length
                  ? "請先勾選至少一首歌曲"
                  : undefined
            }
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
                separationFocusLocked={focusLocked}
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
                onAbortSeparation={() => void abortSongSeparation(song)}
                onRestoreSnapshot={() => restoreSongSnapshot(song)}
                onLoadAudio={() => void ensureSongAudioReady(song)}
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
      {guardDialog && (
        <ResourceGuardModal
          title={guardDialog.title}
          subtitle={guardDialog.subtitle}
          assessment={guardDialog.assessment}
          networkEvaluation={guardDialog.networkEvaluation}
          onConfirm={(choice) => {
            const finish = guardDialog.resolve;
            setGuardDialog(null);
            finish(choice);
          }}
          onCancel={() => {
            const finish = guardDialog.resolve;
            setGuardDialog(null);
            finish(null);
          }}
        />
      )}
    </div>
  );
}
