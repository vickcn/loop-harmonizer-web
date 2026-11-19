"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
} from "@/lib/separation/stemSeparator";
import {
  isAbortError,
  sharedSeparationCoordinator,
  type SeparationTaskStage,
} from "@/lib/separation/separationTaskController";
import {
  mapJobStageToSongSeparationStatus,
  sharedSeparationJobManager,
} from "@/lib/separation/separationJobManager";
import {
  registerTransientSongAudio,
  unregisterTransientSongAudio,
  verifyAuthoritativeCheckpoint,
} from "@/lib/separation/separationJobRunner";
import {
  assessResourceRisk,
  collectDeviceCapabilities,
  estimateOperationFootprint,
  estimateStereoPcmBytes,
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
import {
  deriveTwoStemFromFourStemSet,
  type SeparatedStemSet,
  type StemSeparationMode,
} from "@/lib/separation/stemTypes";
import type { ChunkedSeparationSummary } from "@/lib/separation/stemSeparator";
import {
  isPauseError,
} from "@/lib/separation/separationTaskController";
import {
  evaluateAutoResumeEligibility,
  getOrCreateTabId,
  sharedSeparationLeaseManager,
  validateAndPrepareResume,
  type ResumeValidationResult,
} from "@/lib/separation/separationResumeController";
import {
  clearSeparationDiagnosticLogs,
  deriveSeparationStateFromValidation,
  formatSeparationDiagnosticLine,
  getSeparationDiagnosticLogs,
  guardSeparationPatch,
  isValidationCompleted,
  reconcileCrossTabSongUpdate,
  recordSeparationDiagnostic,
  type SeparationDiagnosticEntry,
} from "@/lib/separation/separationStateRecovery";
import {
  DEMUCS_CHUNK_STEM_ORDER,
  getTaskChunkRecords,
  unpackBufferToChunkStems,
} from "@/lib/storage/separationChunkStore";
import {
  addCheckpointReference,
  createCheckpointTaskId,
  deleteAllIncompleteCheckpoints,
  deleteIncompleteCheckpointsForSong,
  findCompletedCheckpointBySourceAudioHash,
  findLatestCheckpointBySourceAudioHash,
  getAllCheckpoints,
  getCheckpoint,
  isCheckpointLeaseActive,
  isCheckpointSharedOrLeased,
  releaseCheckpointReferenceAndMaybeGc,
  updateCheckpointStatus,
} from "@/lib/storage/separationCheckpointStore";
import type { ChunkMixStemRole } from "@/lib/band/playbackAdapters/ChunkPlaybackAdapter";
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
import { GoogleDrivePickerButton } from "./GoogleDrivePickerButton";
import { ResourceGuardModal, type ResourceGuardConfirmSelection } from "./ResourceGuardModal";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
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
  outcome: "running" | "cancelling" | "pausing" | "paused" | "completed" | "cancelled" | "failed";
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
    case "finalizing":
      return "正在寫入與驗證分軌結果";
    case "cancelling":
      return "正在停止 Worker 與清理暫存";
    case "cancelled":
      return "已中止音軌分離";
    case "completed":
      return "音軌分離完成";
    case "failed":
      return "音軌分離失敗";
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
  const [deleteDialog, setDeleteDialog] = useState<{
    title: string;
    subtitle?: string;
    deleteItems: string[];
    preserveItems: string[];
    recoverability: string;
    safetyNote?: string | null;
    confirmLabel: string;
    danger?: boolean;
    checkboxLabel?: string;
    checkboxDescription?: string;
    onExecute: (checkboxChecked: boolean) => Promise<
      | { status: "success"; message?: string }
      | { status: "blocked"; reason: string }
      | { status: "error"; message: string }
    >;
  } | null>(null);
  const [deleteDialogCheckbox, setDeleteDialogCheckbox] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [idleCleanupReport, setIdleCleanupReport] = useState<string>("");
  const [resourceProfile, setResourceProfile] = useState<DeviceResourceProfile | null>(null);
  const [profileWarning, setProfileWarning] = useState<string>("");
  const [separationFocus, setSeparationFocus] = useState<SeparationFocusUiState | null>(null);
  const [startingSeparationSongIds, setStartingSeparationSongIds] = useState<string[]>([]);
  const startingSeparationSongIdsRef = useRef<Set<string>>(new Set());
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
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticLogs, setDiagnosticLogs] = useState<SeparationDiagnosticEntry[]>([]);
  const sessionRef = useRef(session);
  const selectionRef = useRef<MixerSelection>(selection);
  const startingSongIdsRef = useRef<Set<string>>(startingSongIds);
  const profileWarningRef = useRef<string>(profileWarning);
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
  const persistSongDebouncedRef = useRef<(songId: string, delayMs?: number) => void>(() => undefined);
  const mountedRef = useRef(true);
  const hydratedCompletedJobsRef = useRef<Set<string>>(new Set());
  const backgroundSeparationJobs = useSyncExternalStore(
    sharedSeparationJobManager.subscribe.bind(sharedSeparationJobManager),
    sharedSeparationJobManager.getSnapshot,
    sharedSeparationJobManager.getSnapshot,
  );

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      const engine = new MultiTrackEngine();
      engine.onTrackEnded = (trackId) => {
        const endedIds = sessionRef.current.songs
          .filter((song) => getSongPlaybackTrackIds(song).includes(trackId) && Boolean(song.sourceAudioHash))
          .map((song) => song.id);
        const nextSongsSnapshot = sessionRef.current.songs.map((song) =>
          getSongPlaybackTrackIds(song).includes(trackId)
            ? { ...song, status: "stopped" as const, playheadSec: 0 }
            : song,
        );
        sessionRef.current = { ...sessionRef.current, songs: nextSongsSnapshot };
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.map((song) => getSongPlaybackTrackIds(song).includes(trackId)
            ? { ...song, status: "stopped", playheadSec: 0 }
            : song),
        }));
        for (const endedId of endedIds) {
          persistSongDebouncedRef.current(endedId, 150);
        }
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

  useEffect(() => {
    profileWarningRef.current = profileWarning;
  }, [profileWarning]);

  // BandMixer 僅訂閱全域投影；明確映射所有階段（含 completed），不以未掛載 UI 重建 Worker 或降級 completed。
  useEffect(() => {
    if (backgroundSeparationJobs.length === 0) return;
    setSession((previous) => {
      let changed = false;
      const songs = previous.songs.map((song) => {
        const matchingJobs = backgroundSeparationJobs.filter((candidate) => candidate.songId === song.id);
        const job = matchingJobs.reduce<typeof matchingJobs[number] | undefined>((best, candidate) => {
          if (!best) return candidate;
          const bestActive =
            best.stage === "preparing" ||
            best.stage === "downloading" ||
            best.stage === "processing" ||
            best.stage === "finalizing" ||
            best.stage === "pausing" ||
            best.stage === "cancelling";
          const candActive =
            candidate.stage === "preparing" ||
            candidate.stage === "downloading" ||
            candidate.stage === "processing" ||
            candidate.stage === "finalizing" ||
            candidate.stage === "pausing" ||
            candidate.stage === "cancelling";
          if (candActive !== bestActive) return candActive ? candidate : best;
          return candidate.updatedAt >= best.updatedAt ? candidate : best;
        }, undefined);
        if (!job) return song;
        if (song.separationStatus === "completed" && job.stage !== "completed") return song;
        const status: BandSong["separationStatus"] = mapJobStageToSongSeparationStatus(job.stage);
        const mappedStage: SeparationTaskStage =
          job.stage === "interrupted" ? "idle" : job.stage;
        const nextTaskId =
          job.stage !== "completed" || Boolean(song.separationTaskId)
            ? job.taskId
            : song.separationTaskId;
        const nextProgress = job.stage === "completed" ? 1 : job.progress;
        const nextActivelyFinalizing = Boolean(job.isActivelyFinalizing);
        const nextAutoResumeExhausted = Boolean(job.autoResumeExhausted);
        const nextRequiresManualAction = Boolean(job.requiresManualAction);
        const nextForeignActive = Boolean(job.isForeignActive);
        if (
          song.separationStatus === status &&
          song.separationStage === mappedStage &&
          song.separationProgress === nextProgress &&
          song.separationCompletedChunks === job.completedChunks &&
          song.separationTotalChunks === job.totalChunks &&
          song.separationCommittedBytes === job.committedBytes &&
          song.separationMessage === job.message &&
          song.separationTaskId === nextTaskId &&
          song.separationRetryPhase === job.retryPhase &&
          song.separationWaitReason === job.retryWaitReason &&
          Boolean(song.separationActivelyFinalizing) === nextActivelyFinalizing &&
          Boolean(song.separationAutoResumeExhausted) === nextAutoResumeExhausted &&
          Boolean(song.separationRequiresManualAction) === nextRequiresManualAction &&
          Boolean(song.separationForeignActive) === nextForeignActive
        ) {
          return song;
        }
        changed = true;
        return {
          ...song,
          separationStatus: status,
          separationStage: mappedStage,
          separationProgress: nextProgress,
          separationCompletedChunks: job.completedChunks,
          separationTotalChunks: job.totalChunks,
          separationCommittedBytes: job.committedBytes,
          separationMessage: job.message,
          separationTaskId: nextTaskId,
          separationRetryPhase: job.retryPhase,
          separationWaitReason: job.retryWaitReason,
          separationActivelyFinalizing: nextActivelyFinalizing,
          separationAutoResumeExhausted: nextAutoResumeExhausted,
          separationRequiresManualAction: nextRequiresManualAction,
          separationForeignActive: nextForeignActive,
        };
      });
      return changed ? { ...previous, songs } : previous;
    });
  }, [backgroundSeparationJobs]);

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

  const isFocusLocked = useCallback(
    () => Boolean(separationFocusRef.current?.active) || sharedSeparationJobManager.isGlobalFocusActive(),
    [],
  );

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
      profileWarningRef.current = result.profile.degradationReason;
      setProfileWarning(result.profile.degradationReason);
      showShortcutHint(`資源保護已自動降級至 ${result.profile.tier} 模式：${result.profile.degradationReason}`);
    } else if (result.profile.degradationReason && !profileWarningRef.current) {
      profileWarningRef.current = result.profile.degradationReason;
      setProfileWarning(result.profile.degradationReason);
    }
    return result.profile;
  }, [showShortcutHint]);

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

  const patchSongMetadataOnly = useCallback(
    (
      songId: string,
      patch: Partial<BandSong>,
      options?: {
        generation?: number | null;
        allowResetCompleted?: boolean;
        source?: string;
        checkpointStatus?: string | null;
      },
    ) => {
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((song) => {
          if (song.id !== songId) return song;
          const guarded = guardSeparationPatch(song, patch, {
            source: options?.source ?? "BandMixer.patchSongMetadataOnly",
            generation: options?.generation ?? null,
            activeGeneration: sharedSeparationCoordinator.getCurrentGeneration(songId),
            allowResetCompleted: options?.allowResetCompleted,
            checkpointStatus: options?.checkpointStatus ?? null,
          });
          if (!guarded) return song;
          return { ...song, ...guarded };
        }),
      }));
    },
    [],
  );

  const verifyAuthoritativeCheckpointForSong = useCallback(
    async (
      song: { id: string; sourceAudioHash?: string | null; separationTaskId?: string | null },
      sourceAudioAvailable: boolean,
    ): Promise<ResumeValidationResult | null> => {
      return verifyAuthoritativeCheckpoint(song, sourceAudioAvailable);
    },
    [],
  );

  const handlePersistResult = useCallback((songId: string, result: SaveSongResult) => {
    if (!sessionRef.current.songs.some((candidate) => candidate.id === songId)) return;
    if (result.ok) {
      persistedMetaBySongIdRef.current.set(songId, result.record);
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

  useEffect(() => {
    persistSongDebouncedRef.current = persistSongDebounced;
  }, [persistSongDebounced]);

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

  const applySongAudioPatch = useCallback((prevSong: BandSong, nextSong: BandSong) => {
    const engine = getEngine();
    const allIds = [nextSong.sourceAudioId, ...nextSong.stemIds];

    const prevRate = getEffectivePlaybackRate(prevSong);
    const nextRate = getEffectivePlaybackRate(nextSong);
    if (prevRate !== nextRate) {
      allIds.forEach((id) => {
        engine.setPlaybackRate(id, nextRate);
      });
    }

    if (prevSong.keyShiftSemitones !== nextSong.keyShiftSemitones) {
      allIds.forEach((id) => {
        engine.setPitchSemitones(id, nextSong.keyShiftSemitones);
      });
    }

    if (prevSong.loop !== nextSong.loop) {
      engine.setLoop(nextSong.sourceAudioId, nextSong.loop);
      engine.setLoopGroup(nextSong.stemIds, nextSong.loop);
    }

    if (prevSong.masterVolume !== nextSong.masterVolume) {
      engine.setVolume(nextSong.sourceAudioId, nextSong.masterVolume);
      nextSong.stemChannels.forEach((channel) => {
        engine.setVolume(channel.id, nextSong.masterVolume * channel.volume);
      });
    } else if (prevSong.stemChannels !== nextSong.stemChannels) {
      nextSong.stemChannels.forEach((channel) => {
        const prevChannel = prevSong.stemChannels.find((candidate) => candidate.id === channel.id);
        if (!prevChannel || prevChannel.volume !== channel.volume) {
          engine.setVolume(channel.id, nextSong.masterVolume * channel.volume);
        }
      });
    }

    const songMutedChanged = Boolean(prevSong.muted) !== Boolean(nextSong.muted);
    const stemMuteOrSoloChanged =
      prevSong.stemChannels !== nextSong.stemChannels &&
      (prevSong.stemChannels.length !== nextSong.stemChannels.length ||
        nextSong.stemChannels.some((channel, index) => {
          const prevChannel = prevSong.stemChannels[index];
          return (
            !prevChannel ||
            prevChannel.id !== channel.id ||
            prevChannel.muted !== channel.muted ||
            prevChannel.solo !== channel.solo
          );
        }));

    if (songMutedChanged) {
      engine.setMuted(nextSong.sourceAudioId, Boolean(nextSong.muted));
    }
    if (songMutedChanged || stemMuteOrSoloChanged) {
      const isSongMuted = Boolean(nextSong.muted);
      const audibility = getStemAudibility(nextSong.stemChannels);
      nextSong.stemChannels.forEach((channel) => {
        engine.setMuted(channel.id, isSongMuted || !audibility[channel.id]);
      });
    }
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
    sessionRef.current = { ...sessionRef.current, songs: nextSongsSnapshot };
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

  const installChunkedStemSet = useCallback(async (
    song: BandSong,
    summary: ChunkedSeparationSummary,
    cacheKey: string,
    message: string,
    options?: { preferredSource?: SongPlaybackSource; skipPersist?: boolean },
  ): Promise<BandSong> => {
    const engine = getEngine();
    song.stemIds.forEach((id) => engine.removeTrack(id));
    stemResultsRef.current.delete(song.id);

    const roles: ChunkMixStemRole[] = summary.mode === "two_stem"
      ? ["vocals", "instrumental"]
      : ["vocals", "drums", "bass", "other"];
    const saved = savedSettingsRef.current.get(song.id);
    const stemIds: string[] = [];
    const stemChannels: StemChannel[] = [];
    const groupTracks: Array<{
      trackId: string;
      role: ChunkMixStemRole;
      volume: number;
      muted: boolean;
    }> = [];

    for (const role of roles) {
      const id = `${song.id}_stem_${role}`;
      const existingChannel = song.stemChannels.find((ch) => ch.stemType === role);
      const volume = existingChannel?.volume ?? saved?.stemVolumes?.[role] ?? 1;
      const muted = existingChannel?.muted ?? saved?.stemMuted?.[role] ?? false;
      const solo = existingChannel?.solo ?? saved?.stemSolo?.[role] ?? false;
      stemIds.push(id);
      stemChannels.push({
        id,
        songId: song.id,
        stemType: role,
        volume,
        muted,
        solo,
      });
      groupTracks.push({ trackId: id, role, volume, muted });
    }

    await engine.loadChunkedStemGroup({
      groupId: song.id,
      taskId: summary.taskId,
      totalSamples: summary.totalSamples,
      sampleRate: summary.sampleRate,
      tracks: groupTracks,
      playbackRate: getEffectivePlaybackRate(song),
      keyShiftSemitones: song.keyShiftSemitones,
      loop: song.loop,
      initialPositionSec: song.playheadSec,
    });

    const targetPlaybackSource: SongPlaybackSource = options?.preferredSource === "original" ? "original" : "stems";
    const latestFromRef = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
    const completedFields: Partial<BandSong> = {
      stemIds,
      stemChannels,
      separationStatus: "completed",
      separationStage: "completed",
      separationMode: summary.mode,
      separationProgress: 1,
      separationMessage: message,
      separationTaskId: summary.taskId,
      separationCompletedChunks: summary.totalChunks,
      separationTotalChunks: summary.totalChunks,
      separationCommittedBytes: summary.committedBytes,
      separationUsesChunkPlayback: true,
      playbackSource: targetPlaybackSource,
      cacheKey,
    };
    const nextSong: BandSong = {
      ...latestFromRef,
      ...completedFields,
    };
    engine.seekTracks(stemIds, nextSong.playheadSec);
    applySongToEngine(nextSong);
    if (nextSong.status === "playing" && targetPlaybackSource === "stems") {
      void engine.playTracks(stemIds).then(() => {
        engine.crossfadeTracks([nextSong.sourceAudioId], stemIds);
      });
    }
    recordSeparationDiagnostic({
      source: "BandMixer.installChunkedStemSet",
      songId: song.id,
      taskId: summary.taskId,
      checkpointStatus: "completed",
      validChunkCount: summary.totalChunks,
      totalChunks: summary.totalChunks,
      fromState: latestFromRef.separationStatus,
      toState: "completed",
    });
    const nextSongsSnapshot = sessionRef.current.songs.map((candidate) =>
      candidate.id === song.id ? { ...candidate, ...completedFields } : candidate,
    );
    sessionRef.current = { ...sessionRef.current, songs: nextSongsSnapshot };
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((candidate) =>
        candidate.id === song.id ? { ...candidate, ...completedFields } : candidate,
      ),
    }));
    setSelection((current) => sanitizeMixerSelection(current, nextSongsSnapshot));
    if (!options?.skipPersist) {
      setCollapsedIds((previous) => {
        if (!previous.has(song.id)) return previous;
        const next = new Set(previous);
        next.delete(song.id);
        return next;
      });
      persistSongDebounced(song.id, 0);
    }
    void addCheckpointReference({
      taskId: summary.taskId,
      songId: song.id,
      mode: summary.mode,
      source: "BandMixer.installChunkedStemSet",
    }).catch(() => undefined);
    return nextSong;
  }, [applySongToEngine, getEngine, persistSongDebounced]);

  const finishSeparationFocus = useCallback((params: {
    songId: string;
    outcome: "completed" | "paused" | "cancelled" | "failed";
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

      const currentInSession = sessionRef.current.songs.find((item) => item.id === params.songId);
      const safeOutcome: "completed" | "paused" | "cancelled" | "failed" =
        params.completedSong?.separationStatus === "completed" ||
        currentInSession?.separationStatus === "completed"
          ? "completed"
          : params.outcome;

      if (safeOutcome !== params.outcome) {
        recordSeparationDiagnostic({
          source: "BandMixer.finishSeparationFocus",
          songId: params.songId,
          taskId: currentInSession?.separationTaskId ?? null,
          validChunkCount: currentInSession?.separationCompletedChunks ?? null,
          totalChunks: currentInSession?.separationTotalChunks ?? null,
          fromState: "completed",
          toState: params.outcome,
          note: "blocked finishSeparationFocus downgrade from completed",
        });
      }

      if (currentFocus && currentFocus.songId === params.songId && currentFocus.active) {
        const snapshot = currentFocus.snapshot;
        if (snapshot) {
          const engine = getEngine();
          const songsForEngine = sessionRef.current.songs.map((item) => (
            params.completedSong && item.id === params.completedSong.id ? params.completedSong : item
          ));
          const restoredForEngine = restoreSongsAfterSeparationFocus(songsForEngine, snapshot, {
            outcome: safeOutcome,
          });
          sessionRef.current = { ...sessionRef.current, songs: restoredForEngine };
          for (const restoredSong of restoredForEngine) {
            // 僅還原設定與播放位置，保持暫停絕不自動播放
            engine.pauseTracks([restoredSong.sourceAudioId, ...restoredSong.stemIds]);
            engine.seekTracks([restoredSong.sourceAudioId, ...restoredSong.stemIds], restoredSong.playheadSec);
            applySongToEngine(restoredSong);
            if (restoredSong.sourceAudioHash) {
              persistSongDebounced(restoredSong.id, 150);
            }
          }
          setSession((previous) => {
            const merged = previous.songs.map((item) =>
              params.completedSong && item.id === params.completedSong.id
                ? { ...item, ...params.completedSong }
                : item,
            );
            return {
              ...previous,
              songs: restoreSongsAfterSeparationFocus(merged, snapshot, {
                outcome: safeOutcome,
              }),
            };
          });
        }

        const workerNote = workerStillActive
          ? "（Worker 仍在背景結束中）"
          : "（Worker 與暫存已釋放，資源鎖已解除）";
        updateSeparationFocusState((prev) => {
          if (!prev || prev.songId !== params.songId) return prev;
          return {
            ...prev,
            active: false,
            outcome: safeOutcome,
            stage: safeOutcome,
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
        afterCleanup: params.outcome === "cancelled" || params.outcome === "completed" || params.outcome === "paused",
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

      // 優先檢查權威分段 Checkpoint 與 Chunk（依 taskId 與 sourceAudioHash 搜尋，優先恢復按需分段播放）
      const validation = await verifyAuthoritativeCheckpointForSong(
        {
          id: song.id,
          sourceAudioHash,
          separationTaskId: song.separationTaskId,
        },
        true,
      );
      if (separationTokensRef.current.get(song.id) !== token) return;

      const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
      if (validation?.checkpoint) {
        if (
          isValidationCompleted(validation) &&
          Boolean(validation.checkpoint.finalizedAt || latestSong.separationStatus === "completed")
        ) {
          const resolvedMode =
            latestSong.separationMode ?? validation.checkpoint.requestedMode ?? preferredMode;
          const cacheKey = createSeparationCacheKey({
            sourceAudioHash,
            modelVersion: DEMUCS_MODEL_VERSION,
            separationMode: resolvedMode,
            processingVersion: SEPARATION_PROCESSING_VERSION,
          });
          await installChunkedStemSet(
            latestSong,
            {
              taskId: validation.checkpoint.taskId,
              mode: resolvedMode,
              sampleRate: validation.checkpoint.sampleRate,
              totalSamples: validation.checkpoint.totalSamples,
              totalChunks: validation.checkpoint.totalChunks,
              committedBytes: validation.checkpoint.committedBytes,
              durationSeconds: validation.checkpoint.totalSamples / validation.checkpoint.sampleRate,
            },
            cacheKey,
            `分段分離完成（共 ${validation.checkpoint.totalChunks} 段按需播放）。`,
            {
              preferredSource: options?.preferredSource ?? "stems",
              skipPersist: options?.skipPersist,
            },
          );
          void refreshCacheStats();
          return;
        }
        if (isValidationCompleted(validation)) {
          patchSongMetadataOnly(
            song.id,
            {
              separationStatus: "processing",
              separationStage: "finalizing",
              separationTaskId: validation.checkpoint.taskId,
              separationProgress: 0.99,
              separationCompletedChunks: validation.checkpoint.totalChunks,
              separationTotalChunks: validation.checkpoint.totalChunks,
              separationCommittedBytes: validation.checkpoint.committedBytes,
              separationMessage: "分軌已完成，等待保存",
            },
            {
              source: "BandMixer.restoreCachedStems",
              checkpointStatus: validation.checkpoint.status,
            },
          );
          return;
        }

        const derivedPatch = deriveSeparationStateFromValidation({ validation });
        recordSeparationDiagnostic({
          source: "BandMixer.restoreCachedStems",
          songId: song.id,
          taskId: validation.checkpoint.taskId,
          checkpointStatus: validation.checkpoint.status,
          validChunkCount: validation.validChunkCount,
          totalChunks: validation.totalChunks,
          fromState: latestSong.separationStatus,
          toState: derivedPatch.separationStatus ?? latestSong.separationStatus,
        });
        patchSongMetadataOnly(song.id, derivedPatch, {
          source: "BandMixer.restoreCachedStems",
          checkpointStatus: validation.checkpoint.status,
        });
      }

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
        const freshSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
        installStemSet(freshSong, stems, cacheKey, "已自動從本機快取恢復分離結果。", {
          preferredSource: options?.preferredSource ?? "stems",
          skipPersist: options?.skipPersist,
        });
        void refreshCacheStats();
        return;
      }
    } finally {
      if (separationTokensRef.current.get(song.id) === token) separationTokensRef.current.delete(song.id);
    }
  }, [installChunkedStemSet, installStemSet, patchSongMetadataOnly, refreshCacheStats, verifyAuthoritativeCheckpointForSong]);

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

  const ensureStemsInstalledForReadySong = useCallback(async (
    readySong: BandSong,
    preferredSource: SongPlaybackSource,
  ): Promise<void> => {
    if (removedSongIdsRef.current.has(readySong.id)) return;
    const cpValidation = readySong.sourceAudioHash
      ? await verifyAuthoritativeCheckpointForSong(readySong, true)
      : null;
    if (isValidationCompleted(cpValidation) && cpValidation?.checkpoint && !removedSongIdsRef.current.has(readySong.id)) {
      const preferredMode = readySong.separationMode ?? cpValidation.checkpoint.requestedMode ?? "four_stem";
      const resolvedCacheKey =
        readySong.cacheKey ||
        createSeparationCacheKey({
          sourceAudioHash: readySong.sourceAudioHash!,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: preferredMode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
      await installChunkedStemSet(
        readySong,
        {
          taskId: cpValidation.checkpoint.taskId,
          mode: preferredMode,
          sampleRate: cpValidation.checkpoint.sampleRate,
          totalSamples: cpValidation.checkpoint.totalSamples,
          totalChunks: cpValidation.checkpoint.totalChunks,
          committedBytes: cpValidation.checkpoint.committedBytes,
          durationSeconds: cpValidation.checkpoint.totalSamples / cpValidation.checkpoint.sampleRate,
        },
        resolvedCacheKey,
        `分段分離完成（共 ${cpValidation.checkpoint.totalChunks} 段按需播放）。`,
        { preferredSource, skipPersist: true },
      );
      return;
    }
    if (readySong.cacheKey && !removedSongIdsRef.current.has(readySong.id)) {
      const cached = await getCachedStemSet(readySong.cacheKey).catch(() => null);
      if (cached && !removedSongIdsRef.current.has(readySong.id)) {
        installStemSet(readySong, cached, readySong.cacheKey, "已從本機快取載入分離結果。", {
          preferredSource,
          skipPersist: true,
        });
      }
      return;
    }
    if (cpValidation?.checkpoint && !removedSongIdsRef.current.has(readySong.id)) {
      patchSongMetadataOnly(readySong.id, deriveSeparationStateFromValidation({ validation: cpValidation }), {
        source: "BandMixer.ensureSongAudioReady",
        checkpointStatus: cpValidation.checkpoint.status,
      });
    }
  }, [installChunkedStemSet, installStemSet, patchSongMetadataOnly, verifyAuthoritativeCheckpointForSong]);

  const ensureSongAudioReady = useCallback(async (
    song: BandSong,
    options?: { skipGuard?: boolean; allowDuringFocus?: boolean },
  ): Promise<boolean> => {
    const engine = getEngine();
    if (engine.hasTrack(song.sourceAudioId) && song.audioLoadState !== "unloaded") {
      const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
      const stemsMissing =
        latestSong.playbackSource === "stems" &&
        (latestSong.stemIds.length === 0 ||
          latestSong.stemIds.some((id) => !engine.hasTrack(id)) ||
          (latestSong.separationUsesChunkPlayback && !engine.hasHealthyStemMixBus(latestSong.id)));
      if (stemsMissing && (!isFocusLocked() || options?.allowDuringFocus)) {
        await ensureStemsInstalledForReadySong(latestSong, latestSong.playbackSource);
      }
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

      if (!removedSongIdsRef.current.has(song.id)) {
        const preferred =
          readySong.separationStatus === "completed"
            ? readySong.playbackSource
            : (persistedRecord?.playbackSource ?? readySong.playbackSource);
        await ensureStemsInstalledForReadySong(readySong, preferred);
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
  }, [applySongToEngine, ensureStemsInstalledForReadySong, getEngine, isFocusLocked, patchSongMetadataOnly, releaseIdleResources, requestGuardConfirmation, showCardFeedback, showShortcutHint]);

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
      let lazySong = restoreBandSongFromRecord(record, {
        sourceAudioId,
        durationSec: record.durationSec,
        persistenceStatus: "saved",
        persistenceMessage: "已保存在此裝置（點擊播放再按需解碼，節省手機記憶體）",
        audioLoadState: "unloaded",
      });
      const cpValidation = await verifyAuthoritativeCheckpointForSong(
        {
          id: record.songId,
          sourceAudioHash: record.sourceAudioHash,
          separationTaskId: record.separationTaskId,
        },
        true,
      );
      if (isCancelled() || removedSongIdsRef.current.has(record.songId)) return;

      if (cpValidation?.checkpoint) {
        if (
          isValidationCompleted(cpValidation) &&
          Boolean(cpValidation.checkpoint.finalizedAt || record.separationStatus === "completed")
        ) {
          const resolvedMode =
            record.separationMode ?? cpValidation.checkpoint.requestedMode ?? "four_stem";
          const resolvedCacheKey =
            record.cacheKey ||
            createSeparationCacheKey({
              sourceAudioHash: record.sourceAudioHash,
              modelVersion: DEMUCS_MODEL_VERSION,
              separationMode: resolvedMode,
              processingVersion: SEPARATION_PROCESSING_VERSION,
            });
          lazySong = {
            ...lazySong,
            ...deriveSeparationStateFromValidation({
              validation: cpValidation,
              cacheKey: resolvedCacheKey,
            }),
          };
          const existsInRef = sessionRef.current.songs.some((item) => item.id === lazySong.id);
          sessionRef.current = {
            ...sessionRef.current,
            songs: existsInRef
              ? sessionRef.current.songs.map((item) => (item.id === lazySong.id ? lazySong : item))
              : [...sessionRef.current.songs, lazySong],
          };
          setSession((previous) => {
            const exists = previous.songs.some((item) => item.id === lazySong.id);
            return {
              ...previous,
              songs: exists
                ? previous.songs.map((item) => (item.id === lazySong.id ? lazySong : item))
                : [...previous.songs, lazySong],
            };
          });
          await installChunkedStemSet(
            lazySong,
            {
              taskId: cpValidation.checkpoint.taskId,
              mode: resolvedMode,
              sampleRate: cpValidation.checkpoint.sampleRate,
              totalSamples: cpValidation.checkpoint.totalSamples,
              totalChunks: cpValidation.checkpoint.totalChunks,
              committedBytes: cpValidation.checkpoint.committedBytes,
              durationSeconds: cpValidation.checkpoint.totalSamples / cpValidation.checkpoint.sampleRate,
            },
            resolvedCacheKey,
            `分段分離完成（共 ${cpValidation.checkpoint.totalChunks} 段按需播放）。`,
            { preferredSource: record.playbackSource, skipPersist: true },
          );
          return;
        }
        if (isValidationCompleted(cpValidation)) {
          lazySong = {
            ...lazySong,
            separationStatus: "processing",
            separationStage: "finalizing",
            separationTaskId: cpValidation.checkpoint.taskId,
            separationProgress: 0.99,
            separationCompletedChunks: cpValidation.checkpoint.totalChunks,
            separationTotalChunks: cpValidation.checkpoint.totalChunks,
            separationCommittedBytes: cpValidation.checkpoint.committedBytes,
            separationMessage: "分軌已完成，等待保存",
          };
        } else {
          lazySong = {
            ...lazySong,
            ...deriveSeparationStateFromValidation({ validation: cpValidation }),
          };
        }
      }

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

    const existsInRef = sessionRef.current.songs.some((item) => item.id === restoredSong.id);
    sessionRef.current = {
      ...sessionRef.current,
      songs: existsInRef
        ? sessionRef.current.songs.map((item) => (item.id === restoredSong.id ? restoredSong : item))
        : [...sessionRef.current.songs, restoredSong],
    };
    setSession((previous) => {
      const exists = previous.songs.some((item) => item.id === restoredSong.id);
      return {
        ...previous,
        songs: exists
          ? previous.songs.map((item) => (item.id === restoredSong.id ? restoredSong : item))
          : [...previous.songs, restoredSong],
      };
    });

    // 優先從已驗證的 Checkpoint / Chunk 還原按需分段播放
    const cpValidation = await verifyAuthoritativeCheckpointForSong(
      {
        id: record.songId,
        sourceAudioHash: record.sourceAudioHash,
        separationTaskId: record.separationTaskId,
      },
      true,
    );
    if (
      isValidationCompleted(cpValidation) &&
      cpValidation?.checkpoint &&
      Boolean(cpValidation.checkpoint.finalizedAt || record.separationStatus === "completed") &&
      !isCancelled() &&
      !removedSongIdsRef.current.has(record.songId)
    ) {
      const latest = sessionRef.current.songs.find((item) => item.id === record.songId) ?? restoredSong;
      const resolvedMode =
        record.separationMode ?? cpValidation.checkpoint.requestedMode ?? "four_stem";
      const resolvedCacheKey =
        record.cacheKey ||
        createSeparationCacheKey({
          sourceAudioHash: record.sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: resolvedMode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
      await installChunkedStemSet(
        latest,
        {
          taskId: cpValidation.checkpoint.taskId,
          mode: resolvedMode,
          sampleRate: cpValidation.checkpoint.sampleRate,
          totalSamples: cpValidation.checkpoint.totalSamples,
          totalChunks: cpValidation.checkpoint.totalChunks,
          committedBytes: cpValidation.checkpoint.committedBytes,
          durationSeconds: cpValidation.checkpoint.totalSamples / cpValidation.checkpoint.sampleRate,
        },
        resolvedCacheKey,
        `分段分離完成（共 ${cpValidation.checkpoint.totalChunks} 段按需播放）。`,
        { preferredSource: record.playbackSource, skipPersist: true },
      );
      return;
    }
    if (
      isValidationCompleted(cpValidation) &&
      cpValidation?.checkpoint &&
      !isCancelled() &&
      !removedSongIdsRef.current.has(record.songId)
    ) {
      patchSongMetadataOnly(
        record.songId,
        {
          separationStatus: "processing",
          separationStage: "finalizing",
          separationTaskId: cpValidation.checkpoint.taskId,
          separationProgress: 0.99,
          separationCompletedChunks: cpValidation.checkpoint.totalChunks,
          separationTotalChunks: cpValidation.checkpoint.totalChunks,
          separationCommittedBytes: cpValidation.checkpoint.committedBytes,
          separationMessage: "分軌已完成，等待保存",
        },
        {
          source: "BandMixer.hydrateOnePersistedSong.finalizing",
          checkpointStatus: cpValidation.checkpoint.status,
        },
      );
      return;
    }

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

    if (record.separationMode || record.sourceAudioHash) {
      const restoreToken = Symbol(`restore_${record.songId}`);
      separationTokensRef.current.set(record.songId, restoreToken);
      await restoreCachedStems(restoredSong, restoredFile, restoreToken, {
        preferredSource: record.playbackSource,
        skipPersist: true,
        knownHash: record.sourceAudioHash,
      });
    }
  }, [applySongToEngine, getEngine, installChunkedStemSet, installStemSet, patchSongMetadataOnly, restoreCachedStems, verifyAuthoritativeCheckpointForSong]);

  useEffect(() => {
    mountedRef.current = true;
    sharedPerfTelemetry.startObservingLongTasks();
    const feedbackTimers = cardFeedbackTimersRef.current;
    return () => {
      mountedRef.current = false;
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
      }
      feedbackTimers.forEach((timer) => window.clearTimeout(timer));
      feedbackTimers.clear();
      sharedPerfTelemetry.stopObserving();
      engineRef.current?.dispose();
      engineRef.current = null;
      // 路由切換只會卸載 UI；全域 Job Manager 與 Runner 持有中的 Worker 必須繼續執行，不得清理使用中音訊/模型。
      if (!sharedSeparationJobManager.hasRunningHeavyTask() && !sharedSeparationCoordinator.hasRunningHeavyTask()) {
        void disposeStemSeparator({ revokeModelUrl: true });
      }
    };
  }, []);

  // 當全域分軌任務在背景／其他路由完成或結束時，若 BandMixer 處於掛載狀態，自動載入分軌播放資源並解除專注模式
  useEffect(() => {
    for (const job of backgroundSeparationJobs) {
      const targetSong = sessionRef.current.songs.find((item) => item.id === job.songId);
      if (!targetSong) continue;

      if (job.stage === "completed") {
        const hydrationKey = `${job.taskId}:${job.generation}:${targetSong.separationMode ?? ""}`;
        const needsStemAttach =
          !targetSong.separationUsesChunkPlayback ||
          targetSong.stemIds.length === 0 ||
          targetSong.separationStatus !== "completed";
        if (!needsStemAttach || hydratedCompletedJobsRef.current.has(hydrationKey)) {
          continue;
        }
        hydratedCompletedJobsRef.current.add(hydrationKey);
        void (async () => {
          const latest = sessionRef.current.songs.find((item) => item.id === job.songId);
          if (!latest || !mountedRef.current) return;
          const validation = await verifyAuthoritativeCheckpointForSong(latest, true).catch(() => null);
          if (!mountedRef.current) return;
          if (isValidationCompleted(validation) && validation?.checkpoint) {
            const resolvedMode =
              latest.separationMode ?? validation.checkpoint.requestedMode ?? "four_stem";
            const resolvedCacheKey =
              latest.cacheKey ||
              (latest.sourceAudioHash
                ? createSeparationCacheKey({
                    sourceAudioHash: latest.sourceAudioHash,
                    modelVersion: DEMUCS_MODEL_VERSION,
                    separationMode: resolvedMode,
                    processingVersion: SEPARATION_PROCESSING_VERSION,
                  })
                : "");
            const installed = await installChunkedStemSet(
              latest,
              {
                taskId: validation.checkpoint.taskId,
                mode: resolvedMode,
                sampleRate: validation.checkpoint.sampleRate,
                totalSamples: validation.checkpoint.totalSamples,
                totalChunks: validation.checkpoint.totalChunks,
                committedBytes: validation.checkpoint.committedBytes,
                durationSeconds:
                  validation.checkpoint.totalSamples / validation.checkpoint.sampleRate,
              },
              resolvedCacheKey,
              job.message || `分段分離完成（共 ${validation.checkpoint.totalChunks} 段按需播放）。`,
              { preferredSource: latest.playbackSource === "original" ? "stems" : latest.playbackSource, skipPersist: true },
            );
            if (separationFocusRef.current?.active && separationFocusRef.current.songId === latest.id) {
              await finishSeparationFocus({
                songId: latest.id,
                outcome: "completed",
                message: job.message || "分段分離已完成。",
                completedSong: installed,
              });
            }
            void refreshCacheStats();
          }
        })();
      } else if (
        (job.stage === "paused" || job.stage === "cancelled" || job.stage === "failed") &&
        separationFocusRef.current?.active &&
        separationFocusRef.current.songId === job.songId
      ) {
        void finishSeparationFocus({
          songId: job.songId,
          outcome: job.stage,
          message: job.message || "分離作業已停止。",
        });
      }
    }
  }, [backgroundSeparationJobs, finishSeparationFocus, installChunkedStemSet, refreshCacheStats, verifyAuthoritativeCheckpointForSong]);

  useEffect(() => {
    let cancelled = false;
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
        const remoteRecord = msg.record;
        const isIncomingCompleted = remoteRecord.separationStatus === "completed";
        if (
          !isIncomingCompleted &&
          (hasPendingSongPersist(msg.songId) || separationTokensRef.current.has(msg.songId))
        ) {
          patchSongMetadataOnly(msg.songId, {
            hasConflict: true,
            persistenceStatus: "conflict",
            persistenceMessage: "其他分頁剛修改過此歌曲，請選擇保留本頁或載入最新設定。",
          });
          showShortcutHint("其他分頁修改了同一首歌，請確認要保留哪一版設定。");
          return;
        }
        void (async () => {
          const latestLocal =
            sessionRef.current.songs.find((item) => item.id === msg.songId) ?? existing;
          const cpValidation =
            latestLocal.sourceAudioHash
              ? await verifyAuthoritativeCheckpointForSong(
                  {
                    id: latestLocal.id,
                    sourceAudioHash: latestLocal.sourceAudioHash,
                    separationTaskId:
                      remoteRecord.separationTaskId ?? latestLocal.separationTaskId,
                  },
                  true,
                )
              : null;
          if (cancelled) return;

          const verifiedCompletedCheckpoint =
            isValidationCompleted(cpValidation) &&
            Boolean(cpValidation?.checkpoint?.finalizedAt || remoteRecord.separationStatus === "completed");
          const reconciled = reconcileCrossTabSongUpdate(
            latestLocal,
            {
              ...remoteRecord,
              separationCompletedChunks:
                cpValidation?.validChunkCount ?? remoteRecord.separationCompletedChunks,
              separationTotalChunks:
                cpValidation?.totalChunks ?? remoteRecord.separationTotalChunks,
            },
            {
              verifiedCompletedCheckpoint,
              verifiedValidChunkCount: cpValidation?.validChunkCount,
              hasAuthoritativeCheckpoint: Boolean(cpValidation?.checkpoint),
            },
          );

          const syncedBase = restoreBandSongFromRecord(remoteRecord, {
            sourceAudioId: latestLocal.sourceAudioId,
            durationSec: latestLocal.durationSec || remoteRecord.durationSec,
            persistenceStatus: "saved",
            persistenceMessage: "已同步其他分頁更新",
          });
          const mergedChannels: StemChannel[] =
            latestLocal.stemChannels.length > 0
              ? latestLocal.stemChannels.map((ch) => {
                  const remoteCh = syncedBase.stemChannels.find(
                    (item) => item.stemType === ch.stemType,
                  );
                  return remoteCh
                    ? { ...ch, volume: remoteCh.volume, muted: remoteCh.muted, solo: remoteCh.solo }
                    : ch;
                })
              : syncedBase.stemChannels;

          const merged: BandSong = {
            ...reconciled.song,
            originalBpm: syncedBase.originalBpm,
            savedRates: syncedBase.savedRates,
            muted: syncedBase.muted,
            loop: syncedBase.loop,
            playheadSec:
              latestLocal.status === "playing"
                ? latestLocal.playheadSec
                : syncedBase.playheadSec,
            stemChannels: mergedChannels,
            revision: remoteRecord.revision,
            hasConflict: false,
            persistenceStatus: "saved",
            persistenceMessage: "已保存在此裝置",
          };
          if (latestLocal.status !== "playing") {
            getEngine().seekTracks(
              [latestLocal.sourceAudioId, ...latestLocal.stemIds],
              merged.playheadSec,
            );
          }
          applySongToEngine(merged);
          setSession((previous) => ({
            ...previous,
            songs: previous.songs.map((item) => (item.id === latestLocal.id ? merged : item)),
          }));
          if (
            reconciled.needsChunkPlaybackRestore &&
            verifiedCompletedCheckpoint &&
            cpValidation?.checkpoint
          ) {
            const resolvedMode =
              merged.separationMode ?? cpValidation.checkpoint.requestedMode ?? "four_stem";
            const resolvedCacheKey =
              merged.cacheKey ||
              createSeparationCacheKey({
                sourceAudioHash: merged.sourceAudioHash ?? cpValidation.checkpoint.sourceAudioHash,
                modelVersion: DEMUCS_MODEL_VERSION,
                separationMode: resolvedMode,
                processingVersion: SEPARATION_PROCESSING_VERSION,
              });
            await installChunkedStemSet(
              merged,
              {
                taskId: cpValidation.checkpoint.taskId,
                mode: resolvedMode,
                sampleRate: cpValidation.checkpoint.sampleRate,
                totalSamples: cpValidation.checkpoint.totalSamples,
                totalChunks: cpValidation.checkpoint.totalChunks,
                committedBytes: cpValidation.checkpoint.committedBytes,
                durationSeconds:
                  cpValidation.checkpoint.totalSamples / cpValidation.checkpoint.sampleRate,
              },
              resolvedCacheKey,
              `分段分離完成（共 ${cpValidation.checkpoint.totalChunks} 段按需播放）。`,
              { preferredSource: merged.playbackSource, skipPersist: true },
            );
          } else if (reconciled.needsChunkPlaybackRestore) {
            const localFile = sourceFilesRef.current.get(merged.id);
            if (localFile) {
              const token = Symbol(`sync_restore_${merged.id}`);
              separationTokensRef.current.set(merged.id, token);
              await restoreCachedStems(merged, localFile, token, {
                preferredSource: merged.playbackSource,
                skipPersist: true,
                knownHash: merged.sourceAudioHash ?? undefined,
              });
            }
          }
          showCardFeedback(latestLocal.id, "已同步其他分頁的最新設定");
        })();
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
        unregisterTransientSongAudio(msg.songId);
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

    const currentTabId = getOrCreateTabId();
    const unsubscribeLease = sharedSeparationLeaseManager.onBroadcast((leaseMsg) => {
      if (cancelled || leaseMsg.ownerTabId === currentTabId) return;
      if (
        leaseMsg.type !== "task-completed" &&
        leaseMsg.type !== "task-paused" &&
        leaseMsg.type !== "task-cancelled"
      ) {
        return;
      }
      void (async () => {
        const cp = await getCheckpoint(leaseMsg.taskId).catch(() => null);
        if (cancelled || !cp) return;
        const matchedSong = sessionRef.current.songs.find(
          (item) =>
            item.separationTaskId === leaseMsg.taskId ||
            item.id === cp.songId ||
            (item.sourceAudioHash && item.sourceAudioHash === cp.sourceAudioHash),
        );
        if (!matchedSong || !matchedSong.sourceAudioHash) return;

        const validation = await validateAndPrepareResume(cp.taskId, {
          sourceAudioAvailable: true,
          sourceAudioHash: cp.sourceAudioHash,
          totalSamples: cp.totalSamples,
          sampleRate: cp.sampleRate,
          viewerTabId: currentTabId,
        }).catch(() => null);
        if (cancelled || !validation?.checkpoint) return;

        if (isValidationCompleted(validation) && Boolean(validation.checkpoint.finalizedAt)) {
          const resolvedMode =
            matchedSong.separationMode ?? validation.checkpoint.requestedMode ?? "four_stem";
          const resolvedCacheKey =
            matchedSong.cacheKey ||
            createSeparationCacheKey({
              sourceAudioHash: cp.sourceAudioHash,
              modelVersion: DEMUCS_MODEL_VERSION,
              separationMode: resolvedMode,
              processingVersion: SEPARATION_PROCESSING_VERSION,
            });
          await installChunkedStemSet(
            matchedSong,
            {
              taskId: validation.checkpoint.taskId,
              mode: resolvedMode,
              sampleRate: validation.checkpoint.sampleRate,
              totalSamples: validation.checkpoint.totalSamples,
              totalChunks: validation.checkpoint.totalChunks,
              committedBytes: validation.checkpoint.committedBytes,
              durationSeconds:
                validation.checkpoint.totalSamples / validation.checkpoint.sampleRate,
            },
            resolvedCacheKey,
            `分段分離完成（共 ${validation.checkpoint.totalChunks} 段按需播放）。`,
            { preferredSource: matchedSong.playbackSource, skipPersist: true },
          );
          void refreshCacheStats();
        } else if (isValidationCompleted(validation)) {
          patchSongMetadataOnly(
            matchedSong.id,
            {
              separationStatus: "processing",
              separationStage: "finalizing",
              separationProgress: 0.99,
              separationCompletedChunks: validation.checkpoint.totalChunks,
              separationTotalChunks: validation.checkpoint.totalChunks,
              separationCommittedBytes: validation.checkpoint.committedBytes,
              separationMessage: "分軌已完成，等待保存",
            },
            {
              source: "BandMixer.leaseBroadcast",
              checkpointStatus: validation.checkpoint.status,
            },
          );
        } else {
          patchSongMetadataOnly(
            matchedSong.id,
            deriveSeparationStateFromValidation({ validation }),
            {
              source: "BandMixer.leaseBroadcast",
              checkpointStatus: validation.checkpoint.status,
            },
          );
        }
      })();
    });

    return () => {
      cancelled = true;
      unsubscribeLease();
      unsubscribeSync();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      void flushPendingSongPersists();
    };
  }, [applySongToEngine, getEngine, hydrateOnePersistedSong, installChunkedStemSet, patchSongMetadataOnly, refreshCacheStats, refreshResourceProfile, restoreAttempt, restoreCachedStems, showCardFeedback, showShortcutHint, verifyAuthoritativeCheckpointForSong]);

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
        applySongAudioPatch(song, next);
        shouldPersist = Boolean(next.sourceAudioHash);
        return next;
      }),
    }));
    if (shouldPersist) {
      persistSongDebounced(songId, options?.persistDelayMs ?? 300);
    }
  }, [applySongAudioPatch, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

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
          registerTransientSongAudio(songId, {
            blob: file,
            name: song.name,
            fileName: song.fileName,
            mimeType: song.mimeType,
            durationSec: song.durationSec,
            sourceAudioHash,
          });
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
      registerTransientSongAudio(songId, {
        blob: file,
        name: target.name,
        fileName: file.name,
        mimeType: file.type,
        durationSec,
        sourceAudioHash,
      });
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
    getEngine().primeContextFromGesture();
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

      let preparedSong = latestSong;
      if (
        preparedSong.playbackSource === "stems" &&
        preparedSong.stemChannels.length === 0 &&
        preparedSong.stemIds.length > 0
      ) {
        const saved = savedSettingsRef.current.get(preparedSong.id);
        const rebuiltChannels: StemChannel[] = [];
        for (const id of preparedSong.stemIds) {
          const match = id.match(/_stem_(vocals|drums|bass|other|instrumental)$/);
          if (!match) continue;
          const stemType = match[1] as StemChannel["stemType"];
          rebuiltChannels.push({
            id,
            songId: preparedSong.id,
            stemType,
            volume: saved?.stemVolumes?.[stemType] ?? 1,
            muted: saved?.stemMuted?.[stemType] ?? false,
            solo: saved?.stemSolo?.[stemType] ?? false,
          });
        }
        if (rebuiltChannels.length > 0) {
          preparedSong = { ...preparedSong, stemChannels: rebuiltChannels };
          sessionRef.current = {
            ...sessionRef.current,
            songs: sessionRef.current.songs.map((item) => (item.id === preparedSong.id ? preparedSong : item)),
          };
          setSession((previous) => ({
            ...previous,
            songs: previous.songs.map((item) => (item.id === preparedSong.id ? preparedSong : item)),
          }));
          if (preparedSong.sourceAudioHash) {
            persistSongDebounced(preparedSong.id, 150);
          }
        }
      }

      if (preparedSong.durationSec > 0.5 && preparedSong.playheadSec >= preparedSong.durationSec - 0.4) {
        engine.seekTracks([preparedSong.sourceAudioId, ...preparedSong.stemIds], 0);
        preparedSong = { ...preparedSong, playheadSec: 0 };
        sessionRef.current = {
          ...sessionRef.current,
          songs: sessionRef.current.songs.map((item) => (item.id === preparedSong.id ? preparedSong : item)),
        };
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.map((item) => (item.id === preparedSong.id ? preparedSong : item)),
        }));
      }

      if (preparedSong.muted) {
        showCardFeedback(preparedSong.id, "此歌曲目前為靜音狀態（M），解除靜音即可聽見聲音。");
      } else if (preparedSong.masterVolume <= 0) {
        showCardFeedback(preparedSong.id, "此歌曲主音量目前為 0%，調高音量即可聽見聲音。");
      } else if (preparedSong.playbackSource === "stems" && preparedSong.stemChannels.length > 0) {
        const audibility = getStemAudibility(preparedSong.stemChannels);
        const anyAudible = preparedSong.stemChannels.some((ch) => audibility[ch.id] && ch.volume > 0);
        if (!anyAudible) {
          showCardFeedback(preparedSong.id, "所有分軌目前均為靜音或音量為 0%，取消靜音或調高音量即可聽見聲音。");
        }
      }

      const activeTrackIds = getSongPlaybackTrackIds(preparedSong);
      applySongToEngine(preparedSong);
      await engine.playTracks(activeTrackIds);

      const diag = engine.diagnosePlayback(activeTrackIds);
      console.info("[BandMixer AudioDiag]", JSON.stringify(diag));

      const missingChunkBus =
        preparedSong.playbackSource === "stems"
          ? diag.buses.find(
              (bus) =>
                bus.adapterDiagnostics !== null &&
                bus.adapterDiagnostics.residentChunks.length === 0 &&
                bus.adapterDiagnostics.missingChunkCount > 0,
            )
          : undefined;

      if (missingChunkBus) {
        const verified = preparedSong.sourceAudioHash
          ? await verifyAuthoritativeCheckpointForSong(preparedSong, true).catch(() => null)
          : null;
        if (isValidationCompleted(verified) && verified?.checkpoint) {
          engine.pauseTracks(activeTrackIds);
          await ensureStemsInstalledForReadySong(preparedSong, "stems");
          const repairedSong =
            sessionRef.current.songs.find((item) => item.id === preparedSong.id) ?? preparedSong;
          const repairedTrackIds = getSongPlaybackTrackIds(repairedSong);
          applySongToEngine(repairedSong);
          await engine.playTracks(repairedTrackIds);
          const repairedDiag = engine.diagnosePlayback(repairedTrackIds);
          console.info("[BandMixer AudioDiag][Repaired]", JSON.stringify(repairedDiag));
          updateSong(repairedSong.id, { status: "playing" });
          return;
        }

        if (engine.hasTrack(preparedSong.sourceAudioId)) {
          engine.pauseTracks(activeTrackIds);
          preparedSong.stemIds.forEach((id) => engine.removeTrack(id));
          const derived: Partial<BandSong> = verified
            ? deriveSeparationStateFromValidation({ validation: verified })
            : {
                separationStatus: "interrupted",
                separationProgress: 0,
                separationMessage: "",
                separationTaskId: null,
                separationCompletedChunks: 0,
                separationTotalChunks: 0,
                separationCommittedBytes: 0,
                separationUsesChunkPlayback: false,
              };
          const nextCompleted = derived.separationCompletedChunks ?? 0;
          const nextTotal = derived.separationTotalChunks ?? 0;
          const fallbackMsg =
            nextCompleted > 0 && nextCompleted < nextTotal
              ? `偵測到先前分軌僅完成第 ${nextCompleted}/${nextTotal} 段，已切換回原曲播放；可點擊「繼續分離」接續完成。`
              : "偵測到先前分軌資料尚未完整保存，已自動切換回原曲播放；請重新分離音軌。";
          const fallbackSong: BandSong = {
            ...preparedSong,
            ...derived,
            playbackSource: "original",
            stemIds: [],
            stemChannels: [],
            separationStage:
              derived.separationStatus === "paused" || derived.separationStatus === "interrupted"
                ? (nextCompleted > 0 ? "paused" : "idle")
                : derived.separationStatus === "failed"
                  ? "failed"
                  : "idle",
            separationUsesChunkPlayback: false,
            separationMessage: fallbackMsg,
            status: "playing",
          };
          sessionRef.current = {
            ...sessionRef.current,
            songs: sessionRef.current.songs.map((item) =>
              item.id === fallbackSong.id ? fallbackSong : item,
            ),
          };
          setSession((previous) => ({
            ...previous,
            songs: previous.songs.map((item) =>
              item.id === fallbackSong.id ? fallbackSong : item,
            ),
          }));
          engine.seekTracks([fallbackSong.sourceAudioId], fallbackSong.playheadSec);
          applySongToEngine(fallbackSong);
          await engine.playTracks([fallbackSong.sourceAudioId]);
          if (fallbackSong.sourceAudioHash) {
            persistSongDebounced(fallbackSong.id, 150);
          }
          showCardFeedback(fallbackSong.id, fallbackMsg);
          showShortcutHint(fallbackMsg);
          return;
        }
      }

      updateSong(preparedSong.id, { status: "playing" });
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
      const prevSong = sessionRef.current.songs.find((candidate) => candidate.id === result.changedSong!.id);
      if (prevSong) {
        applySongAudioPatch(prevSong, result.changedSong);
      } else {
        applySongToEngine(result.changedSong);
      }
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
  }, [applySongAudioPatch, applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const toggleSoloForSelection = useCallback((targetSelection: MixerSelection) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已暫停音訊處理並鎖定獨奏變更。";
      if (targetSelection.songId) showCardFeedback(targetSelection.songId, msg);
      showShortcutHint(msg);
      return;
    }
    const result = toggleSoloBySelection(sessionRef.current.songs, targetSelection);
    if (result.changedSong) {
      const prevSong = sessionRef.current.songs.find((candidate) => candidate.id === result.changedSong!.id);
      if (prevSong) {
        applySongAudioPatch(prevSong, result.changedSong);
      } else {
        applySongToEngine(result.changedSong);
      }
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
  }, [applySongAudioPatch, applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

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
      separationUserAuthorized: false,
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
    const taskId = song.separationTaskId || (song.sourceAudioHash
      ? createCheckpointTaskId(song.id, song.sourceAudioHash, DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION)
      : null);
    if (taskId) {
      await updateCheckpointStatus(taskId, {
        status: "cancelled",
        userAuthorized: false,
        clearLeaseIfTerminal: true,
      }).catch(() => undefined);
    }
    if (taskId) {
      await sharedSeparationJobManager.cancelJob(taskId);
    } else {
      await sharedSeparationCoordinator.cancelTask(song.id, "已中止音軌分離（保留已提交 Chunk；不會自動續跑）。", 80);
    }
    await finishSeparationFocus({
      songId: song.id,
      outcome: "cancelled",
      message: "已中止音軌分離（保留已提交 Chunk）。",
    });
    persistSongDebounced(song.id, 150);
  };

  const pauseSongSeparation = async (song: BandSong) => {
    patchSongMetadataOnly(song.id, {
      separationStage: "pausing",
      separationMessage: "正在等待目前 Chunk 安全提交至 IndexedDB 後暫停…",
    });
    if (separationFocusRef.current?.songId === song.id && separationFocusRef.current.active) {
      updateSeparationFocusState((prev) => (
        prev && prev.songId === song.id
          ? { ...prev, stage: "cancelling", message: "正在安全提交目前 Chunk 並暫停…" }
          : prev
      ));
    }
    const taskId = song.separationTaskId || (song.sourceAudioHash
      ? createCheckpointTaskId(song.id, song.sourceAudioHash, DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION)
      : null);
    if (taskId) {
      await sharedSeparationJobManager.pauseJob(taskId);
    } else {
      await sharedSeparationCoordinator.pauseTask(song.id, "已於安全 Chunk 邊界暫停，可隨時繼續分離。", 80);
    }
  };

  const resumeSongSeparation = async (song: BandSong) => {
    const mode = song.separationMode ?? "four_stem";
    await separateSong(song, mode, { isAutoResume: false });
  };

  const retrySongFinalization = async (song: BandSong) => {
    const matchingJob = backgroundSeparationJobs.find(
      (job) => job.songId === song.id && job.stage === "finalizing",
    );
    const taskId =
      song.separationTaskId ||
      matchingJob?.taskId ||
      (song.sourceAudioHash
        ? createCheckpointTaskId(
            song.id,
            song.sourceAudioHash,
            DEMUCS_MODEL_VERSION,
            SEPARATION_PROCESSING_VERSION,
          )
        : null);
    if (!taskId) return;
    const outcome = await sharedSeparationJobManager.retryFinalization(taskId);
    if (outcome?.status === "completed") {
      const latest = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
      const summary = outcome.chunkedTask;
      const resolvedMode = outcome.mode ?? latest.separationMode ?? "four_stem";
      const hydrationKey = `${outcome.taskId}:${outcome.generation}:${resolvedMode}`;
      if (summary) {
        hydratedCompletedJobsRef.current.add(hydrationKey);
        const installed = await installChunkedStemSet(
          latest,
          summary,
          outcome.cacheKey || latest.cacheKey || "",
          outcome.message || `分段分離完成（共 ${summary.totalChunks} 段按需播放）。`,
          {
            preferredSource: latest.playbackSource === "original" ? "stems" : latest.playbackSource,
            skipPersist: true,
          },
        );
        if (separationFocusRef.current?.active && separationFocusRef.current.songId === latest.id) {
          await finishSeparationFocus({
            songId: latest.id,
            outcome: "completed",
            message: outcome.message || "分段分離已完成。",
            completedSong: installed,
          });
        }
      } else {
        const validation = await verifyAuthoritativeCheckpointForSong(latest, true).catch(() => null);
        if (isValidationCompleted(validation) && validation?.checkpoint) {
          hydratedCompletedJobsRef.current.add(hydrationKey);
          const resolvedCacheKey =
            outcome.cacheKey ||
            latest.cacheKey ||
            (latest.sourceAudioHash
              ? createSeparationCacheKey({
                  sourceAudioHash: latest.sourceAudioHash,
                  modelVersion: DEMUCS_MODEL_VERSION,
                  separationMode: resolvedMode,
                  processingVersion: SEPARATION_PROCESSING_VERSION,
                })
              : "");
          const installed = await installChunkedStemSet(
            latest,
            {
              taskId: validation.checkpoint.taskId,
              mode: resolvedMode,
              sampleRate: validation.checkpoint.sampleRate,
              totalSamples: validation.checkpoint.totalSamples,
              totalChunks: validation.checkpoint.totalChunks,
              committedBytes: validation.checkpoint.committedBytes,
              durationSeconds:
                validation.checkpoint.totalSamples / validation.checkpoint.sampleRate,
            },
            resolvedCacheKey,
            outcome.message || `分段分離完成（共 ${validation.checkpoint.totalChunks} 段按需播放）。`,
            {
              preferredSource: latest.playbackSource === "original" ? "stems" : latest.playbackSource,
              skipPersist: true,
            },
          );
          if (separationFocusRef.current?.active && separationFocusRef.current.songId === latest.id) {
            await finishSeparationFocus({
              songId: latest.id,
              outcome: "completed",
              message: outcome.message || "分段分離已完成。",
              completedSong: installed,
            });
          }
        }
      }
      void refreshCacheStats();
    }
  };

  type CleanupActionResult =
    | { status: "success"; message?: string }
    | { status: "blocked"; reason: string }
    | { status: "error"; message: string };

  const clearSongSeparationData = async (
    song: BandSong,
    scope?: "temp" | "completed",
  ): Promise<CleanupActionResult> => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const reason = "分離作業進行中，請先暫停或中止後再執行清除。";
      showCardFeedback(song.id, reason);
      return { status: "blocked", reason };
    }

    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id);
    if (!latestSong) {
      return { status: "blocked", reason: "找不到對應的歌曲資料，可能已被移除或狀態已變更。" };
    }

    const effectiveScope: "temp" | "completed" =
      scope ?? (latestSong.separationStatus === "completed" ? "completed" : "temp");

    if (effectiveScope === "temp") {
      // 安全清理暫存：僅刪除未完成的暫存進度，若本機已有已完成分軌 Checkpoint 則予以保留並優先恢復播放
      const completedCheck = latestSong.sourceAudioHash
        ? await verifyAuthoritativeCheckpointForSong(latestSong, true)
        : null;
      const result = await deleteIncompleteCheckpointsForSong({
        songId: latestSong.id,
        sourceAudioHash: latestSong.sourceAudioHash ?? undefined,
        knownInMemorySongs: sessionRef.current.songs,
      });

      if (result.blockedByLeaseTaskIds.length > 0) {
        const reason = "其他分頁正在執行或持有此分離任務，已安全保護並保留暫存進度。";
        showCardFeedback(latestSong.id, reason);
        void refreshCacheStats();
        return { status: "blocked", reason };
      }

      if (isValidationCompleted(completedCheck) && completedCheck?.checkpoint) {
        const resolvedMode =
          latestSong.separationMode ?? completedCheck.checkpoint.requestedMode ?? "four_stem";
        const resolvedCacheKey =
          latestSong.cacheKey ||
          createSeparationCacheKey({
            sourceAudioHash: latestSong.sourceAudioHash!,
            modelVersion: DEMUCS_MODEL_VERSION,
            separationMode: resolvedMode,
            processingVersion: SEPARATION_PROCESSING_VERSION,
          });
        await installChunkedStemSet(
          latestSong,
          {
            taskId: completedCheck.checkpoint.taskId,
            mode: resolvedMode,
            sampleRate: completedCheck.checkpoint.sampleRate,
            totalSamples: completedCheck.checkpoint.totalSamples,
            totalChunks: completedCheck.checkpoint.totalChunks,
            committedBytes: completedCheck.checkpoint.committedBytes,
            durationSeconds:
              completedCheck.checkpoint.totalSamples / completedCheck.checkpoint.sampleRate,
          },
          resolvedCacheKey,
          `已清理未完成暫存，並自動恢復既有的已完成分軌（共 ${completedCheck.checkpoint.totalChunks} 段按需播放）。`,
          { preferredSource: latestSong.playbackSource },
        );
        showCardFeedback(latestSong.id, "已清理未完成暫存，既有已完成分軌已保留並恢復。");
        void refreshCacheStats();
        return { status: "success" };
      }

      if (latestSong.separationStatus === "completed") {
        showCardFeedback(latestSong.id, "已清理未完成暫存，已完成分軌不受影響。");
        void refreshCacheStats();
        return { status: "success" };
      }

      patchSongMetadataOnly(
        latestSong.id,
        {
          separationStatus: "not_started",
          separationStage: "idle",
          separationProgress: 0,
          separationMessage:
            result.deletedCheckpoints > 0 || result.deletedChunks > 0
              ? "已清理未完成暫存進度，已完成分軌未受影響（原曲未受影響）。"
              : "目前無未完成暫存進度。",
          separationTaskId: null,
          separationCompletedChunks: 0,
          separationTotalChunks: 0,
          separationCommittedBytes: 0,
          separationUserAuthorized: false,
          separationUsesChunkPlayback: false,
        },
        { source: "BandMixer.clearSongTempProgress" },
      );
      persistSongDebounced(latestSong.id, 150);
      showCardFeedback(latestSong.id, "已清理未完成暫存進度。");
      void refreshCacheStats();
      return { status: "success" };
    }

    const taskId =
      latestSong.separationTaskId ||
      (latestSong.sourceAudioHash
        ? createCheckpointTaskId(latestSong.id, latestSong.sourceAudioHash, DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION)
        : null);
    if (taskId) {
      const freshCp = await getCheckpoint(taskId).catch(() => null);
      const currentTabId = getOrCreateTabId();
      if (
        freshCp
        && freshCp.status === "running"
        && freshCp.lease
        && freshCp.lease.ownerTabId !== currentTabId
        && isCheckpointLeaseActive(freshCp)
      ) {
        const reason = "其他分頁正在執行此歌曲的分離任務，已安全阻擋刪除。";
        showCardFeedback(latestSong.id, reason);
        return { status: "blocked", reason };
      }
    }

    const cacheKeyToRelease =
      latestSong.cacheKey ||
      (latestSong.sourceAudioHash && latestSong.separationMode
        ? createSeparationCacheKey({
            sourceAudioHash: latestSong.sourceAudioHash,
            modelVersion: DEMUCS_MODEL_VERSION,
            separationMode: latestSong.separationMode,
            processingVersion: SEPARATION_PROCESSING_VERSION,
          })
        : null);

    const clearedSong: BandSong = {
      ...latestSong,
      stemIds: [],
      stemChannels: [],
      playbackSource: "original",
      cacheKey: null,
      separationStatus: "not_started",
      separationStage: "idle",
      separationProgress: 0,
      separationMessage: "已刪除已完成分軌與本機分段檔案，原曲未受影響。",
      separationTaskId: null,
      separationCompletedChunks: 0,
      separationTotalChunks: 0,
      separationCommittedBytes: 0,
      separationUserAuthorized: false,
      separationUsesChunkPlayback: false,
      status: latestSong.playbackSource === "stems" && latestSong.status === "playing" ? "paused" : latestSong.status,
    };
    const nextSongsSnapshot = sessionRef.current.songs.map((item) =>
      item.id === latestSong.id ? clearedSong : item,
    );

    const releaseResult = taskId || latestSong.sourceAudioHash || cacheKeyToRelease
      ? await releaseCheckpointReferenceAndMaybeGc({
          taskId,
          sourceAudioHash: latestSong.sourceAudioHash ?? null,
          songId: latestSong.id,
          cacheKeyToRelease,
          knownInMemorySongs: nextSongsSnapshot,
          knownRemovedSongIds: removedSongIdsRef.current,
          source: "BandMixer.deleteCompletedStems",
        })
      : null;

    await deleteIncompleteCheckpointsForSong({
      songId: latestSong.id,
      sourceAudioHash: latestSong.sourceAudioHash ?? undefined,
      excludeTaskId: releaseResult?.preservedTaskIds[0],
      knownInMemorySongs: nextSongsSnapshot,
    });

    sharedSeparationCoordinator.invalidateSongGeneration(latestSong.id);
    const engine = getEngine();
    if (latestSong.playbackSource === "stems" && latestSong.status === "playing") {
      engine.pauseTracks(latestSong.stemIds);
    }
    latestSong.stemIds.forEach((id) => engine.removeTrack(id));
    stemResultsRef.current.delete(latestSong.id);

    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((item) => (item.id === latestSong.id ? clearedSong : item)),
    }));
    applySongToEngine(clearedSong);
    if (clearedSong.sourceAudioHash && clearedSong.persistenceStatus !== "missing_audio") {
      await saveSongStateRecord(clearedSong, { allowResetSeparation: true }).catch(() => undefined);
    } else {
      persistSongDebounced(latestSong.id, 0);
    }

    const keptSharedData = Boolean(
      releaseResult &&
        (releaseResult.preservedTaskIds.length > 0 ||
          releaseResult.blockedByLeaseTaskIds.length > 0),
    );
    if (keptSharedData) {
      patchSongMetadataOnly(
        latestSong.id,
        {
          separationStatus: "not_started",
          separationTaskId: null,
          cacheKey: null,
          separationMessage: "已解除本歌曲的分軌關聯（其他歌曲或分頁仍在使用共用分段，已保留底層檔案）。",
        },
        { allowResetCompleted: true, source: "BandMixer.deleteCompletedStems" },
      );
    }

    recordSeparationDiagnostic({
      source: "BandMixer.deleteCompletedStems",
      songId: latestSong.id,
      taskId,
      fromState: latestSong.separationStatus,
      toState: "not_started",
      referenceCount: releaseResult?.remainingReferences ?? 0,
      leaseState: releaseResult?.blockedByLeaseTaskIds.length ? "active" : "none",
      outcome: keptSharedData ? "detached_shared_preserved" : "deleted",
      note: keptSharedData
        ? "user cleared song stems; shared checkpoint preserved for remaining refs"
        : "user deleted completed stems",
    });

    showCardFeedback(
      latestSong.id,
      keptSharedData
        ? "已解除本歌曲分軌連結（共用底層資料仍為其他歌曲保留）。"
        : "已刪除已完成分軌。",
    );
    void refreshCacheStats();
    return { status: "success" };
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

  const markSeparationStarting = useCallback((songId: string): boolean => {
    if (startingSeparationSongIdsRef.current.has(songId)) {
      return false;
    }
    startingSeparationSongIdsRef.current.add(songId);
    setStartingSeparationSongIds((previous) =>
      previous.includes(songId) ? previous : [...previous, songId],
    );
    return true;
  }, []);

  const clearSeparationStarting = useCallback((songId: string) => {
    if (!startingSeparationSongIdsRef.current.delete(songId)) {
      return;
    }
    setStartingSeparationSongIds((previous) => previous.filter((id) => id !== songId));
  }, []);

  useEffect(() => {
    return () => {
      startingSeparationSongIdsRef.current.clear();
    };
  }, []);

  const separateSong = async (
    song: BandSong,
    mode: StemSeparationMode,
    options?: { isAutoResume?: boolean; forceRecompute?: boolean },
  ) => {
    const isAutoResume = Boolean(options?.isAutoResume);
    if (isFocusLocked()) {
      if (!isAutoResume) {
        showCardFeedback(song.id, "目前處於分離專注模式，請等待目前分離任務完成或先中止後再試。");
      }
      return;
    }
    if (song.separationStatus === "processing" || song.separationStatus === "cancelling") {
      return;
    }
    if (sharedSeparationCoordinator.isBusyWaitingCleanup()) {
      if (!isAutoResume) {
        showCardFeedback(song.id, "上一個分離任務仍在停止並釋放資源，請稍候片刻再試。");
      }
      return;
    }
    if (
      sharedSeparationJobManager.hasRunningHeavyTask(song.id) ||
      sharedSeparationCoordinator.hasRunningHeavyTask(song.id)
    ) {
      if (!isAutoResume) {
        showCardFeedback(song.id, "目前已有其他歌曲正在分離，請先完成或中止後再試。");
        showShortcutHint("一次僅執行一個 Demucs AI 分離任務，以保護行動裝置記憶體。");
      }
      return;
    }

    const ready = await ensureSongAudioReady(song, { skipGuard: isAutoResume, allowDuringFocus: true });
    if (!ready) return;
    const latestReadySong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    const file = sourceFilesRef.current.get(song.id);
    if (!file) {
      updateSong(song.id, { separationStatus: "failed", separationMessage: "原始音訊已不在記憶體，請重新載入歌曲。" });
      return;
    }

    const sourceAudioHash = latestReadySong.sourceAudioHash || await hashSourceAudio(file);
    registerTransientSongAudio(song.id, {
      blob: file,
      name: latestReadySong.name,
      fileName: latestReadySong.fileName,
      mimeType: latestReadySong.mimeType,
      durationSec: latestReadySong.durationSec,
      sourceAudioHash,
    });

    const previousCompletedTaskId =
      latestReadySong.separationStatus === "completed"
        ? (latestReadySong.separationTaskId ?? null)
        : null;
    const previousCacheKey =
      latestReadySong.separationStatus === "completed"
        ? (latestReadySong.cacheKey ?? null)
        : null;

    let effectiveMode: StemSeparationMode = mode;
    const checkpointTaskId =
      latestReadySong.separationTaskId ||
      createCheckpointTaskId(
        song.id,
        sourceAudioHash,
        DEMUCS_MODEL_VERSION,
        SEPARATION_PROCESSING_VERSION,
      );

    // 若本機 Checkpoint 或 fast cache 已完整可用，直接載入播放引擎而不顯示多餘彈窗
    if (!options?.forceRecompute) {
      const existingValidation = await verifyAuthoritativeCheckpointForSong(
        { id: song.id, sourceAudioHash, separationTaskId: checkpointTaskId },
        true,
      );
      if (isValidationCompleted(existingValidation) && existingValidation?.checkpoint) {
        const activeCacheKey = createSeparationCacheKey({
          sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: effectiveMode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
        const msg =
          effectiveMode === "two_stem"
            ? "已從既有 4 軌分段 Checkpoint 即時合成 2 Stem（零 AI 重算與網路下載）。"
            : `已從本機分段 Checkpoint 驗證並載入完整分軌（共 ${existingValidation.totalChunks} 段按需播放）。`;
        await installChunkedStemSet(
          latestReadySong,
          {
            taskId: existingValidation.checkpoint.taskId,
            mode: effectiveMode,
            sampleRate: existingValidation.checkpoint.sampleRate,
            totalSamples: existingValidation.checkpoint.totalSamples,
            totalChunks: existingValidation.checkpoint.totalChunks,
            committedBytes: existingValidation.checkpoint.committedBytes,
            durationSeconds:
              existingValidation.checkpoint.totalSamples / existingValidation.checkpoint.sampleRate,
          },
          activeCacheKey,
          msg,
        );
        showCardFeedback(song.id, msg);
        void refreshCacheStats();
        return;
      }
    }

    const inMemoryStems = stemResultsRef.current.get(song.id) ?? null;
    const activeCacheKeyForMode = createSeparationCacheKey({
      sourceAudioHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: effectiveMode,
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });
    const hasFastCacheHit =
      !options?.forceRecompute &&
      (inMemoryStems?.mode === effectiveMode ||
        Boolean(await getCachedStemSet(activeCacheKeyForMode).catch(() => null)) ||
        (effectiveMode === "two_stem" &&
          (inMemoryStems?.mode === "four_stem" ||
            Boolean(
              await getCachedStemSet(
                createSeparationCacheKey({
                  sourceAudioHash,
                  modelVersion: DEMUCS_MODEL_VERSION,
                  separationMode: "four_stem",
                  processingVersion: SEPARATION_PROCESSING_VERSION,
                }),
              ).catch(() => null),
            ))));

    const engine = getEngine();
    const cap = await collectDeviceCapabilities();
    const perfSignals = sharedPerfTelemetry.getSignals();
    const profileEval = sharedResourceProfileManager.evaluate(cap, perfSignals);
    setResourceProfile(profileEval.profile);
    let maxThreads = profileEval.profile.maxWasmThreads;
    let userSelectedPausePlayback = false;
    const targetSongDecodedBytes = engine.hasTrack(latestReadySong.sourceAudioId)
      ? estimateStereoPcmBytes(latestReadySong.durationSec)
      : 0;
    const totalInMemoryAudioBytes = engine.getTrackMemoryEstimateBytes();
    const backgroundInMemoryBytes = Math.max(0, totalInMemoryAudioBytes - targetSongDecodedBytes);
    const activeSoundTouchCount = engine.getActiveSoundTouchCount();
    const hasIdleDecodedOthers = sessionRef.current.songs.some(
      (s) => s.id !== song.id && s.status !== "playing" && engine.hasTrack(s.sourceAudioId),
    );

    let footprint = hasFastCacheHit
      ? { estimatedMemoryBytes: 0, estimatedStorageBytes: 0, stageBreakdown: null }
      : estimateOperationFootprint({
          operation: "separate",
          songName: latestReadySong.name,
          fileSizeBytes: file.size,
          durationSec: latestReadySong.durationSec,
          mimeType: file.type,
          separationMode: effectiveMode,
          capabilities: cap,
        });

    let guardAlreadyConfirmed = false;
    if (!hasFastCacheHit) {
      const networkEval = await preflightSeparationNetworkBudget();
      const assessment = assessResourceRisk({
        operation: "separate",
        songName: latestReadySong.name,
        fileSizeBytes: file.size,
        durationSec: latestReadySong.durationSec,
        mimeType: file.type,
        separationMode: effectiveMode,
        activeSongCount: sessionRef.current.songs.length,
        playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
        activeSoundTouchTracks: activeSoundTouchCount,
        runningDemucsCount: sharedSeparationJobManager.hasRunningHeavyTask() ? 1 : 0,
        estimatedInMemoryAudioBytes: backgroundInMemoryBytes,
        hasOtherIdleDecodedSongs: hasIdleDecodedOthers,
        profile: profileEval.profile,
        capabilities: cap,
        performanceSignals: perfSignals,
      });

      if (isAutoResume) {
        if (
          !assessment.admission.allowed ||
          assessment.admission.hardRejected ||
          !networkEval.allowed ||
          networkEval.requiresExternalDownloadConfirmation
        ) {
          return;
        }
      } else if (
        assessment.requiresConfirmation ||
        !networkEval.allowed ||
        networkEval.requiresExternalDownloadConfirmation
      ) {
        const decision = await requestGuardConfirmation({
          title: `音軌分離風險與傳輸確認：「${latestReadySong.name}」`,
          subtitle: `目前選擇：${effectiveMode === "four_stem" ? "4 Stem（人聲／鼓／貝斯／其他）" : "2 Stem（人聲／伴奏）"}`,
          assessment,
          networkEvaluation: networkEval,
        });
        if (!decision) return;
        guardAlreadyConfirmed = true;
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
        if (decision.applyLowLoadActions.includes("use-two-stem-buffers") && effectiveMode !== "two_stem") {
          effectiveMode = "two_stem";
          footprint = estimateOperationFootprint({
            operation: "separate",
            songName: latestReadySong.name,
            fileSizeBytes: file.size,
            durationSec: latestReadySong.durationSec,
            mimeType: file.type,
            separationMode: effectiveMode,
            capabilities: cap,
          });
        }
      } else if (assessment.riskLevel === "medium") {
        showCardFeedback(song.id, `提示：本裝置估計達中等負載（${assessment.estimatedDurationLabel}）。`);
      }
    }

    const postReleaseOtherBytes = Math.max(
      0,
      engine.getTrackMemoryEstimateBytes() -
        (engine.hasTrack(latestReadySong.sourceAudioId)
          ? estimateStereoPcmBytes(latestReadySong.durationSec)
          : 0),
    );
    const focusDecision = hasFastCacheHit
      ? { enabled: false, reasons: [] as string[] }
      : shouldEnterSeparationFocusMode({
          profile: profileEval.profile,
          performanceSignals: sharedPerfTelemetry.getSignals(),
          estimatedSeparationMemoryBytes: footprint.estimatedMemoryBytes,
          inMemoryAudioBytes: postReleaseOtherBytes,
          activeSoundTouchTracks: engine.getActiveSoundTouchCount(),
          userSelectedPausePlayback,
        });

    if (focusDecision.enabled) {
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
      "音軌分離前穩定狀態",
    );
    patchSongMetadataOnly(song.id, {
      activeSnapshot: stableSnapshot,
      separationStatus: "processing",
      separationMode: effectiveMode,
      separationStage: "preparing",
      separationProgress: 0.02,
      separationMessage: "正在準備分離任務…",
    });

    // 將實際執行、Web Lock、Checkpoint/Chunk 提交、持久化與資源清理全數交由全域 Runner + JobManager 接管
    const outcome = await sharedSeparationJobManager.runSongSeparation({
      songId: song.id,
      taskId: checkpointTaskId,
      songName: latestReadySong.name,
      mode: effectiveMode,
      file,
      sourceAudioHash,
      fileName: latestReadySong.fileName,
      mimeType: latestReadySong.mimeType,
      fileSizeBytes: file.size,
      durationSec: latestReadySong.durationSec,
      maxThreads,
      userAuthorized: true,
      isAutoResume,
      forceRecompute: options?.forceRecompute,
      guardAlreadyConfirmed,
      userSelectedPausePlayback,
      inMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
      activeSoundTouchTracks: engine.getActiveSoundTouchCount(),
      activeSongCount: sessionRef.current.songs.length,
      playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
      hasOtherIdleDecodedSongs: sessionRef.current.songs.some(
        (s) => s.id !== song.id && s.status !== "playing" && engine.hasTrack(s.sourceAudioId),
      ),
      playbackSourceBefore: stableSnapshot.playbackSource,
      hadStemsBefore: latestReadySong.stemIds.length > 0,
      previousCompletedTaskId,
      previousCacheKey,
      inMemoryStems,
      knownInMemorySongs: sessionRef.current.songs,
      knownRemovedSongIds: removedSongIdsRef.current,
    });

    if (!mountedRef.current || removedSongIdsRef.current.has(song.id)) {
      return;
    }

    const latestSongAfterRun = sessionRef.current.songs.find((item) => item.id === song.id);
    if (!latestSongAfterRun) return;

    if (outcome.status === "completed") {
      hydratedCompletedJobsRef.current.add(
        `${outcome.taskId}:${outcome.generation}:${outcome.mode}`,
      );
      let installedSong: BandSong = latestSongAfterRun;
      if (outcome.chunkedTask) {
        installedSong = await installChunkedStemSet(
          latestSongAfterRun,
          outcome.chunkedTask,
          outcome.cacheKey,
          outcome.message,
        );
      } else if (outcome.stems) {
        installedSong = installStemSet(
          latestSongAfterRun,
          outcome.stems,
          outcome.cacheKey,
          outcome.message,
        );
      }
      showCardFeedback(song.id, outcome.message);
      void refreshCacheStats();
      await finishSeparationFocus({
        songId: song.id,
        outcome: "completed",
        message: outcome.message,
        completedSong: installedSong,
      });
      return;
    }

    if (outcome.status === "paused") {
      showCardFeedback(song.id, outcome.message);
      void refreshCacheStats();
      await finishSeparationFocus({
        songId: song.id,
        outcome: "paused",
        message: outcome.message,
      });
      return;
    }

    if (outcome.status === "cancelled") {
      await finishSeparationFocus({
        songId: song.id,
        outcome: "cancelled",
        message: outcome.message,
      });
      return;
    }

    if (outcome.status === "blocked") {
      showCardFeedback(song.id, outcome.message);
      if (outcome.code === "lock_unavailable" || outcome.code === "foreign_lease") {
        patchSongMetadataOnly(
          song.id,
          { separationStatus: stableSnapshot.separationStatus },
          { source: "BandMixer.separateSong.blocked" },
        );
      }
      await finishSeparationFocus({
        songId: song.id,
        outcome: "cancelled",
        message: outcome.message,
      });
      return;
    }

    // outcome.status === "failed"
    const activeJobAfterFail = sharedSeparationJobManager.getJob(outcome.taskId);
    const isFinalizingWait =
      outcome.retryPhase === "finalization" || activeJobAfterFail?.stage === "finalizing";
    showCardFeedback(song.id, activeJobAfterFail?.message ?? outcome.message);
    await finishSeparationFocus({
      songId: song.id,
      outcome: "failed",
      message: activeJobAfterFail?.message ?? outcome.message,
    });
    if (isFinalizingWait && activeJobAfterFail) {
      patchSongMetadataOnly(
        song.id,
        {
          separationStatus: "processing",
          separationStage: "finalizing",
          separationTaskId: activeJobAfterFail.taskId,
          separationProgress: activeJobAfterFail.progress,
          separationCompletedChunks: activeJobAfterFail.completedChunks,
          separationTotalChunks: activeJobAfterFail.totalChunks,
          separationCommittedBytes: activeJobAfterFail.committedBytes,
          separationMessage: activeJobAfterFail.message,
          separationRetryPhase: activeJobAfterFail.retryPhase,
          separationWaitReason: activeJobAfterFail.retryWaitReason,
          separationActivelyFinalizing: Boolean(activeJobAfterFail.isActivelyFinalizing),
          separationAutoResumeExhausted: Boolean(activeJobAfterFail.autoResumeExhausted),
          separationRequiresManualAction: Boolean(activeJobAfterFail.requiresManualAction),
          separationForeignActive: Boolean(activeJobAfterFail.isForeignActive),
        },
        { source: "BandMixer.separateSong.finalizingWait" },
      );
    }
  };

  const requestStartSeparation = (
    song: BandSong,
    mode: StemSeparationMode,
    options?: { isAutoResume?: boolean; forceRecompute?: boolean },
  ) => {
    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    if (
      startingSeparationSongIdsRef.current.has(latestSong.id) ||
      latestSong.separationStatus === "processing" ||
      latestSong.separationStatus === "cancelling"
    ) {
      return;
    }
    if (!markSeparationStarting(latestSong.id)) {
      return;
    }
    void (async () => {
      try {
        await new Promise<void>((resolve) => {
          if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => resolve());
            });
          } else {
            resolve();
          }
        });
        await separateSong(latestSong, mode, options);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "啟動音軌分離時發生未預期錯誤。";
        const isAbort =
          (error instanceof Error && error.name === "AbortError") ||
          /已取消|已中止|aborted|cancelled/i.test(message);
        if (!isAbort) {
          showCardFeedback(latestSong.id, `音軌分離失敗：${message}`);
          const currentSong = sessionRef.current.songs.find((item) => item.id === latestSong.id);
          if (
            currentSong &&
            currentSong.separationStatus !== "completed" &&
            currentSong.separationStage !== "finalizing"
          ) {
            patchSongMetadataOnly(
              latestSong.id,
              {
                separationStatus: "failed",
                separationMessage: `音軌分離失敗：${message}`,
              },
              { source: "BandMixer.requestStartSeparation.catch" },
            );
          }
        }
      } finally {
        clearSeparationStarting(latestSong.id);
      }
    })();
  };

  const updateStem = (song: BandSong, stemId: string, patch: Partial<StemChannel>) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已暫時鎖定變速、升降 Key 與音軌參數變更。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
    let shouldPersist = false;
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((candidate) => {
        if (candidate.id !== song.id) return candidate;
        const next: BandSong = {
          ...candidate,
          stemChannels: candidate.stemChannels.map((channel) => (
            channel.id === stemId ? { ...channel, ...patch } : channel
          )),
        };
        applySongAudioPatch(candidate, next);
        shouldPersist = Boolean(next.sourceAudioHash);
        return next;
      }),
    }));
    if (shouldPersist) {
      persistSongDebounced(song.id, 300);
    }
  };

  const downloadStem = async (song: BandSong, stemId: string) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，為避免額外記憶體尖峰已暫停大型 WAV 匯出。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
    const channel = song.stemChannels.find((item) => item.id === stemId);
    if (!channel) return;

    const stems = stemResultsRef.current.get(song.id);
    const stem = stems?.tracks.find((item) => item.stemType === channel.stemType);
    if (stem && stems) {
      const blob = new Blob([encodeStereoWav(stem.left, stem.right, stems.sampleRate)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${song.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}-${stem.stemType}.wav`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    if (song.separationUsesChunkPlayback && song.separationTaskId) {
      const cp = await getCheckpoint(song.separationTaskId).catch(() => null);
      if (!cp || cp.totalSamples <= 0) return;
      const chunks = await getTaskChunkRecords(song.separationTaskId).catch(() => []);
      if (chunks.length === 0) return;

      // 單軌按需組裝匯出 WAV，避免同時在記憶體重建 4 軌全曲音訊
      const outLeft = new Float32Array(cp.totalSamples);
      const outRight = new Float32Array(cp.totalSamples);
      const role = channel.stemType;
      for (const chunk of chunks) {
        const frameCount = chunk.endSample - chunk.startSample;
        if (frameCount <= 0) continue;
        const decoded = unpackBufferToChunkStems(chunk.payload, frameCount);
        if (role === "instrumental") {
          for (let i = 0; i < frameCount; i++) {
            outLeft[chunk.startSample + i] = decoded.drums.left[i] + decoded.bass.left[i] + decoded.other.left[i];
            outRight[chunk.startSample + i] = decoded.drums.right[i] + decoded.bass.right[i] + decoded.other.right[i];
          }
        } else if (role === "vocals" || role === "drums" || role === "bass" || role === "other") {
          const pair = decoded[role];
          outLeft.set(pair.left, chunk.startSample);
          outRight.set(pair.right, chunk.startSample);
        }
      }
      const blob = new Blob([encodeStereoWav(outLeft, outRight, cp.sampleRate)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${song.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}-${role}.wav`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const clearSongCache = async (song: BandSong): Promise<CleanupActionResult> => {
    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const msg = "分離進行中暫停清理快取，以確保既有分離快取不被誤刪。";
      showCardFeedback(latestSong.id, msg);
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    if (!latestSong.cacheKey) {
      const msg = "目前已無本機分軌快取。";
      showCardFeedback(latestSong.id, msg);
      return { status: "blocked", reason: msg };
    }
    const cacheSharedByOtherSong = sessionRef.current.songs.some(
      (candidate) => candidate.id !== latestSong.id && candidate.cacheKey === latestSong.cacheKey,
    );
    const currentTabId = getOrCreateTabId();
    const allCheckpoints = await getAllCheckpoints().catch(() => []);
    const activeForeignCheckpoint = allCheckpoints.find((cp) => {
      if (!cp.lease || cp.lease.ownerTabId === currentTabId || !isCheckpointLeaseActive(cp)) {
        return false;
      }
      if (latestSong.sourceAudioHash && cp.sourceAudioHash === latestSong.sourceAudioHash) {
        return true;
      }
      const cpCacheKey = createSeparationCacheKey({
        sourceAudioHash: cp.sourceAudioHash,
        modelVersion: cp.modelVersion,
        separationMode: cp.requestedMode,
        processingVersion: cp.processingVersion,
      });
      return cpCacheKey === latestSong.cacheKey;
    });
    if (activeForeignCheckpoint) {
      const msg = "其他分頁正在使用此分軌快取，已安全阻擋清理。";
      showCardFeedback(latestSong.id, msg);
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    if (!cacheSharedByOtherSong) {
      await deleteCachedStemSet(latestSong.cacheKey);
    }
    updateSong(latestSong.id, {
      cacheKey: null,
      separationMessage: cacheSharedByOtherSong
        ? "已解除此曲分軌快取連結（其他歌曲仍共用同一快取，底層資料已保留）。"
        : "已清除硬碟分軌快取；目前載入的分軌仍可繼續播放。",
    });
    showCardFeedback(
      latestSong.id,
      cacheSharedByOtherSong ? "已解除快取連結（共用快取已保留）" : "已清除本機分軌快取（目前播放不受影響）",
    );
    void refreshCacheStats();
    return { status: "success" };
  };

  const clearAllSeparationCache = async (): Promise<CleanupActionResult> => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const msg = "分離進行中暫停刪除已完成分軌快取。";
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    const currentTabId = getOrCreateTabId();
    const allCheckpoints = await getAllCheckpoints().catch(() => []);
    const foreignActiveLease = allCheckpoints.find(
      (cp) => cp.lease && cp.lease.ownerTabId !== currentTabId && isCheckpointLeaseActive(cp),
    );
    if (foreignActiveLease) {
      const msg = "偵測到其他分頁正持有分離或資源鎖定，已安全阻擋清除所有分軌快取。";
      setStorageActionMsg(msg);
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    await clearAllCachedStemSets();
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => ({
        ...song,
        cacheKey: null,
        separationMessage: song.stemIds.length
          ? "已刪除已完成分軌快取；目前載入的分軌仍可繼續播放。"
          : song.separationMessage,
      })),
    }));
    setStorageActionMsg("已刪除所有本機已完成分軌快取（原曲檔案完整保留）。");
    void refreshCacheStats();
    return { status: "success" };
  };

  const handleClearTempSeparationProgress = async (): Promise<CleanupActionResult> => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const msg = "分離進行中暫停清理暫存。";
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    try {
      const [unusedResult, incompleteResult] = await Promise.all([
        clearUnusedSeparationCaches(sessionRef.current.songs),
        deleteAllIncompleteCheckpoints(),
      ]);
      const blockedSet = new Set(incompleteResult.blockedByLeaseTaskIds);
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((song) => {
          if (song.separationStatus === "completed") return song;
          if (song.separationTaskId && blockedSet.has(song.separationTaskId)) {
            return song;
          }
          if (
            song.separationStatus === "interrupted" ||
            song.separationStatus === "paused" ||
            song.separationStatus === "failed" ||
            song.separationStatus === "cancelled" ||
            (song.separationCompletedChunks ?? 0) > 0
          ) {
            return {
              ...song,
              separationStatus: "not_started",
              separationProgress: 0,
              separationMessage: "已清理未完成暫存進度（已完成分軌未受影響）。",
              separationTaskId: null,
              separationCompletedChunks: 0,
              separationTotalChunks: 0,
              separationCommittedBytes: 0,
              separationUsesChunkPlayback: false,
            };
          }
          return song;
        }),
      }));
      const blockedNote =
        incompleteResult.blockedByLeaseTaskIds.length > 0
          ? `；另有 ${incompleteResult.blockedByLeaseTaskIds.length} 筆任務正由其他分頁鎖定而略過`
          : "";
      if (
        incompleteResult.blockedByLeaseTaskIds.length > 0 &&
        incompleteResult.deletedCheckpoints === 0 &&
        incompleteResult.deletedChunks === 0 &&
        unusedResult.deletedCount === 0
      ) {
        const reason = `共有 ${incompleteResult.blockedByLeaseTaskIds.length} 筆暫存任務正由其他分頁鎖定，已安全保護並阻擋清理。`;
        setStorageActionMsg(reason);
        setDiagnosticLogs(getSeparationDiagnosticLogs());
        void refreshCacheStats();
        return { status: "blocked", reason };
      }
      setStorageActionMsg(
        `已清理未完成暫存：刪除 ${incompleteResult.deletedCheckpoints} 筆中斷進度（${incompleteResult.deletedChunks} 個暫存分段）與 ${unusedResult.deletedCount} 筆未使用快取；已保留 ${incompleteResult.preservedCompletedCount} 首已完成分軌${blockedNote}。`,
      );
      setDiagnosticLogs(getSeparationDiagnosticLogs());
      void refreshCacheStats();
      return { status: "success" };
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : "清理未完成暫存時發生錯誤。";
      setStorageActionMsg(msg);
      return { status: "error", message: msg };
    }
  };

  const removeSong = async (song: BandSong, deleteLocalData: boolean): Promise<CleanupActionResult> => {
    const remainingSongs = sessionRef.current.songs.filter((candidate) => candidate.id !== song.id);
    try {
      await restorePromiseRef.current.catch(() => undefined);
      const result = await removePersistedSong({
        song,
        deleteLocalData,
        inMemoryRemainingSongs: remainingSongs,
      });

      removedSongIdsRef.current.add(song.id);
      unregisterTransientSongAudio(song.id);
      startingSeparationSongIdsRef.current.delete(song.id);
      setStartingSeparationSongIds((previous) => previous.filter((id) => id !== song.id));
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
      setSession((previous) => ({ ...previous, songs: previous.songs.filter((candidate) => candidate.id !== song.id) }));
      setSelection((previous) => sanitizeMixerSelection(previous, remainingSongs));

      if (deleteLocalData && result.sharedWithOtherSongs) {
        showShortcutHint(`已移除「${song.name}」；另有其他歌曲共用此音檔，已保留共用資料。`);
      } else if (deleteLocalData) {
        showShortcutHint(`已移除「${song.name}」並刪除未共用的本機音檔與分離快取。`);
      } else {
        showShortcutHint(`已從清單移除「${song.name}」（已保留本機音檔與快取）。`);
      }
      void refreshCacheStats();
      return { status: "success" };
    } catch (error) {
      const msg = error instanceof Error && error.message
        ? error.message
        : `移除「${song.name}」並清理本機資料庫時發生錯誤。`;
      showShortcutHint(msg);
      return { status: "error", message: msg };
    }
  };

  const handleClearUnusedSeparationCaches = async (): Promise<CleanupActionResult> => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const msg = "分離進行中暫停清理未使用快取。";
      showShortcutHint(msg);
      return { status: "blocked", reason: msg };
    }
    try {
      const result = await clearUnusedSeparationCaches(sessionRef.current.songs);
      setStorageActionMsg(
        result.deletedCount > 0
          ? `已清除 ${result.deletedCount} 筆未使用的分離快取（釋放 ${formatBytes(result.freedBytes)}）。`
          : "目前沒有未使用的分離快取（使用中歌曲皆已完整保留）。",
      );
      void refreshCacheStats();
      return { status: "success" };
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : "清理未使用的分離快取時發生錯誤。";
      setStorageActionMsg(msg);
      return { status: "error", message: msg };
    }
  };

  const openDeleteConfirmDialog = (config: NonNullable<typeof deleteDialog>, defaultChecked = false) => {
    setDeleteError("");
    setDeleteDialogCheckbox(defaultChecked);
    setDeleteDialog(config);
  };

  const requestClearSongSeparationData = (song: BandSong, scope?: "temp" | "completed") => {
    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    const effectiveScope: "temp" | "completed" =
      scope ?? (latestSong.separationStatus === "completed" ? "completed" : "temp");
    if (
      latestSong.separationStatus === "processing" ||
      latestSong.separationStatus === "cancelling" ||
      isFocusLocked() ||
      sharedSeparationCoordinator.hasRunningHeavyTask()
    ) {
      const msg = "此歌曲或混音器目前正在進行音軌分離，請先等待完成或手動中止後再進行清理。";
      showCardFeedback(latestSong.id, msg);
      showShortcutHint(msg);
      return;
    }
    if (effectiveScope === "temp") {
      if (latestSong.separationStatus === "completed") {
        showCardFeedback(latestSong.id, "已完成分軌受到保護，清理未完成進度不會刪除已完成分軌。");
        return;
      }
      openDeleteConfirmDialog({
        title: "清理未完成暫存進度",
        subtitle: latestSong.name,
        deleteItems: [
          "此歌曲尚未完成的 Checkpoint 紀錄",
          "已算出的未完成分軌 Chunk（不會寫入/保留至已完成分軌）",
        ],
        preserveItems: [
          "原始音檔與清單中的歌曲項目",
          "所有其他歌曲與既有的已完成分軌資料",
          "跨歌曲或跨分頁仍被鎖定/共用的底層 Chunk（安全檢查後才會釋放）",
        ],
        recoverability: "不可恢復；清理後若需分軌需從頭重新計算。執行前會再次檢查跨分頁鎖定。",
        confirmLabel: "確認清理",
        danger: false,
        onExecute: async () => clearSongSeparationData(latestSong, "temp"),
      });
      return;
    }

    openDeleteConfirmDialog({
      title: "刪除已完成分軌",
      subtitle: latestSong.name,
      deleteItems: [
        "此歌曲的已完成分軌 AudioBuffer 與本機暫存 Chunk/Checkpoint",
        "分軌播放快取連結（若無其他歌曲共用則同步釋放底層 Chunk）",
      ],
      preserveItems: [
        "原始音檔（歌曲維持載入，可立即切回「原曲」播放）",
        "BPM、Key、播放倍率與歌曲其他設定",
        "若有其他歌曲共用同一分軌資源或持有分頁鎖定，底層共用資料將自動保留",
      ],
      recoverability: "不可恢復；若需再次分離須重新執行分軌。刪除前會再次確認分頁鎖定與共用引用。",
      confirmLabel: "確認刪除分軌",
      danger: true,
      onExecute: async () => clearSongSeparationData(latestSong, "completed"),
    });
  };

  const requestClearSongCache = (song: BandSong) => {
    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      const msg = "分離進行中暫停清理快取，以確保既有分離快取不被誤刪。";
      showCardFeedback(latestSong.id, msg);
      showShortcutHint(msg);
      return;
    }
    if (!latestSong.cacheKey) {
      showCardFeedback(latestSong.id, "目前已無本機分軌快取。");
      return;
    }
    openDeleteConfirmDialog({
      title: "清除歌曲分軌快取",
      subtitle: latestSong.name,
      deleteItems: [
        "此歌曲對應的 IndexedDB 分軌快取索引（若無其他歌曲共用將釋放快取紀錄）",
      ],
      preserveItems: [
        "原始音檔、目前載入記憶體中的分軌（仍可繼續播放至頁面關閉前）",
        "未完成的分離 Checkpoint 與共用同一快取的其他歌曲",
      ],
      recoverability: "不可恢復；下次重新載入頁面時將不再自動從此快取還原（執行前會再檢查共用與鎖定）。",
      confirmLabel: "確認清除快取",
      danger: true,
      onExecute: async () => clearSongCache(latestSong),
    });
  };

  const requestClearAllSeparationCache = () => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      showShortcutHint("分離進行中暫停刪除已完成分軌快取。");
      return;
    }
    openDeleteConfirmDialog({
      title: "清除所有分軌快取",
      deleteItems: [
        "IndexedDB 中所有「已完成分軌」快取索引與快取資料",
      ],
      preserveItems: [
        "所有歌曲的原始音檔與清單設定（BPM / Key / 倍率）",
        "未完成的分離 Checkpoint 與目前記憶體內已載入的音軌",
      ],
      recoverability: "不可恢復；下次重新整理頁面後已清除快取的分軌需重新分離（刪除前會再檢查跨分頁鎖定）。",
      confirmLabel: "確認清除全部",
      danger: true,
      onExecute: async () => clearAllSeparationCache(),
    });
  };

  const requestClearAllTempSeparationProgress = () => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      showShortcutHint("分離進行中暫停清理暫存。");
      return;
    }
    openDeleteConfirmDialog({
      title: "清理未完成暫存進度",
      deleteItems: [
        "所有未完成（已暫停 / 已中斷 / 失敗 / 已取消）的分離 Checkpoint 與暫存 Chunk",
        "已未被任何歌曲使用的孤立快取",
      ],
      preserveItems: [
        "所有已完成分軌與其 Checkpoint / Chunk",
        "所有歌曲的原始音檔與設定",
        "其他分頁正持有有效 Lease 鎖定的進行中任務",
      ],
      recoverability: "不可恢復；中斷任務將無法續接，僅能重新開始分離。",
      confirmLabel: "確認清理暫存",
      danger: false,
      onExecute: async () => handleClearTempSeparationProgress(),
    });
  };

  const requestClearUnusedSeparationCaches = () => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      showShortcutHint("分離進行中暫停清理未使用快取。");
      return;
    }
    openDeleteConfirmDialog({
      title: "清理未使用暫存",
      deleteItems: [
        "IndexedDB 中已不再被任何已保存歌曲或進行中任務引用的分離快取與孤立 Chunk",
      ],
      preserveItems: [
        "所有目前清單與已保存工作階段中的原曲與已完成分軌",
        "正在進行或暫停中可續接的分離 Checkpoint",
      ],
      recoverability: "不可恢復；已刪除之孤立快取無法還原，但使用中的歌曲資料完整保留。",
      confirmLabel: "確認清理未使用項目",
      danger: false,
      onExecute: async () => handleClearUnusedSeparationCaches(),
    });
  };

  const requestRemoveSong = (song: BandSong) => {
    const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
    openDeleteConfirmDialog(
      {
        title: "移除歌曲",
        subtitle: latestSong.name,
        deleteItems: [
          "從目前混音器工作階段清單移除此歌曲與畫面播放控制項目",
          "若勾選下方選項：將同步刪除僅由本曲持有的本機原始音檔與分離快取/Checkpoint",
        ],
        preserveItems: [
          "未勾選下方選項時：本機原始音檔、分軌快取與模型檔將完整保留於 IndexedDB",
          "即使勾選同步刪除，若有其他歌曲共用同一檔案/Chunk 或其他分頁正鎖定，底層共用資料仍會自動保留",
        ],
        recoverability: "清單項目將立即移除；若一併刪除未共用的本機音檔與快取，該資料將無法恢復。",
        checkboxLabel: "同時刪除未共用的本機音檔與分離快取（若無其他歌曲共用）",
        checkboxDescription: "建議僅在確定釋放瀏覽器磁碟空間時勾選；若有其他歌曲共用相同檔案將自動略過底層刪除。",
        confirmLabel: "確認移除歌曲",
        danger: true,
        onExecute: async (deleteLocalData) => removeSong(latestSong, deleteLocalData),
      },
      false,
    );
  };

  const requestClearModelCache = () => {
    if (isFocusLocked() || sharedSeparationCoordinator.hasRunningHeavyTask()) {
      showShortcutHint("分離進行中暫停清理模型快取。");
      return;
    }
    openDeleteConfirmDialog({
      title: "清理 Demucs 模型快取",
      deleteItems: [
        "本機 CacheStorage / IndexedDB 中已下載的 Demucs ONNX 模型檔案",
      ],
      preserveItems: [
        "所有歌曲的原始音檔、已完成分軌與未完成進度",
        "混音器 BPM / Key / 倍率等所有設定",
      ],
      recoverability: "可透過網路重新下載；下次執行分離時會再次下載模型權重。",
      confirmLabel: "確認清理模型快取",
      danger: false,
      onExecute: async () => {
        await clearModelCache();
        await refreshCacheStats();
        setStorageActionMsg("已清理本機 Demucs 模型快取（既有歌曲與分軌資料已保留）。");
        return { status: "success" };
      },
    });
  };

  const requestClearDiagnosticLogs = () => {
    openDeleteConfirmDialog({
      title: "清空本機診斷紀錄",
      deleteItems: [
        "儲存於瀏覽器 localStorage 中的本機分離診斷循環日誌",
      ],
      preserveItems: [
        "所有歌曲音檔、已完成分軌、暫存進度與模型快取",
      ],
      recoverability: "不可恢復；僅影響除錯紀錄檢視，不影響播放與分離功能。",
      confirmLabel: "確認清空紀錄",
      danger: false,
      onExecute: async () => {
        clearSeparationDiagnosticLogs();
        setDiagnosticLogs([]);
        setStorageActionMsg("已清空本機診斷紀錄。");
        return { status: "success" };
      },
    });
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
  const focusLocked = Boolean(separationFocus?.active) || sharedSeparationJobManager.isGlobalFocusActive();
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
        <GoogleDrivePickerButton
          multiple
          disabled={loading || focusLocked}
          onFilesPicked={(files) => handleFiles(files)}
          onError={(message) => showShortcutHint(message)}
        />
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
            aria-label="音軌分離專注模式狀態"
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
                  aria-label={isCancelling ? "正在中止音軌分離" : `中止「${separationFocus.songName}」音軌分離`}
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
          <IconActionButton
            icon="🫧"
            label="清除未使用的分離快取"
            disabled={focusLocked}
            disabledReason={focusLocked ? "分離專注模式啟動中，暫停清理未使用快取。" : undefined}
            className="is-compact"
            onClick={requestClearUnusedSeparationCaches}
          />
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
            <IconActionButton
              icon="♻️"
              label="釋放閒置資源（卸載未播放歌曲緩衝與閒置 Worker）"
              disabled={focusLocked}
              disabledReason={focusLocked ? "分離專注模式啟動中，暫停釋放資源。" : undefined}
              className="is-compact"
              onClick={() => void releaseIdleResources()}
            />
            <IconActionButton
              icon="🧹"
              label="清理暫存進度"
              disabled={focusLocked}
              disabledReason={focusLocked ? "分離專注模式啟動中，暫停清理暫存。" : undefined}
              className="is-compact"
              onClick={requestClearAllTempSeparationProgress}
            />
            <IconActionButton
              icon="🫧"
              label="清除未使用快取"
              disabled={focusLocked}
              disabledReason={focusLocked ? "分離專注模式啟動中，暫停清理未使用快取。" : undefined}
              className="is-compact"
              onClick={requestClearUnusedSeparationCaches}
            />
            <IconActionButton
              icon="🗑"
              label="刪除已完成分軌快取"
              danger
              disabled={focusLocked}
              disabledReason={focusLocked ? "分離專注模式啟動中，暫停刪除已完成分軌快取。" : undefined}
              className="is-compact"
              onClick={requestClearAllSeparationCache}
            />
            <IconActionButton
              icon="📦"
              label="清理模型快取"
              disabled={focusLocked}
              disabledReason={focusLocked ? "分離專注模式啟動中，暫停清理模型快取。" : undefined}
              className="is-compact"
              onClick={requestClearModelCache}
            />
            <button
              type="button"
              className="btn mixer-button"
              onClick={() => {
                setDiagnosticLogs(getSeparationDiagnosticLogs());
                void refreshCacheStats();
              }}
            >
              重新整理
            </button>
            <button
              type="button"
              className="btn mixer-button"
              onClick={() => {
                setDiagnosticLogs(getSeparationDiagnosticLogs());
                setShowDiagnostics((prev) => !prev);
              }}
            >
              {showDiagnostics ? "隱藏本機診斷紀錄" : "檢視本機診斷紀錄"}
            </button>
          </div>
          {showDiagnostics && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(148, 163, 184, 0.2)" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span className="small" style={{ opacity: 0.85 }}>
                  本機分離狀態診斷循環日誌（僅存本機 · 最近 {diagnosticLogs.length} 筆 · 不含原始音訊）
                </span>
                <IconActionButton
                  icon="🧹"
                  label="清空本機診斷紀錄"
                  disabled={diagnosticLogs.length === 0}
                  disabledReason={diagnosticLogs.length === 0 ? "目前沒有本機診斷紀錄可清空。" : undefined}
                  className="is-compact"
                  onClick={requestClearDiagnosticLogs}
                />
              </div>
              {diagnosticLogs.length === 0 ? (
                <div className="small" style={{ opacity: 0.65 }}>尚無本機診斷紀錄。</div>
              ) : (
                <pre style={{ margin: 0, maxHeight: 160, overflow: "auto", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {[...diagnosticLogs].reverse().slice(0, 40).map(formatSeparationDiagnosticLine).join("\n")}
                </pre>
              )}
            </div>
          )}
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
          <p className="small" style={{ opacity: 0.35, marginTop: 6 }}>載入後可自動保存於此裝置，並於歌曲卡片內分離音軌</p>
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
                isStartingSeparation={startingSeparationSongIds.includes(song.id)}
                onSeparate={(mode, separateOpts) => requestStartSeparation(song, mode, separateOpts)}
                onSwitchSource={(source) => void switchSource(song, source)}
                onStemChange={(id, patch) => updateStem(song, id, patch)}
                onDownloadStem={(id) => void downloadStem(song, id)}
                onClearSongCache={() => requestClearSongCache(song)}
                onPauseSeparation={() => void pauseSongSeparation(song)}
                onResumeSeparation={() => void resumeSongSeparation(song)}
                onRetryFinalization={() => void retrySongFinalization(song)}
                onClearSeparationData={(scope) => requestClearSongSeparationData(song, scope)}
                onAbortSeparation={() => void abortSongSeparation(song)}
                onRestoreSnapshot={() => restoreSongSnapshot(song)}
                onLoadAudio={() => void ensureSongAudioReady(song)}
                onRemove={(_deleteLocalData) => requestRemoveSong(song)}
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
      {deleteDialog && (
        <ConfirmDeleteDialog
          open
          title={deleteDialog.title}
          subtitle={deleteDialog.subtitle}
          deleteItems={deleteDialog.deleteItems}
          preserveItems={deleteDialog.preserveItems}
          recoverability={deleteDialog.recoverability}
          safetyNote={deleteDialog.safetyNote}
          errorMessage={deleteError || null}
          checkboxOption={
            deleteDialog.checkboxLabel
              ? {
                  label: deleteDialog.checkboxLabel,
                  description: deleteDialog.checkboxDescription,
                  checked: deleteDialogCheckbox,
                  onChange: setDeleteDialogCheckbox,
                }
              : undefined
          }
          confirmLabel={deleteDialog.confirmLabel}
          danger={deleteDialog.danger}
          submitting={deleteSubmitting}
          onConfirm={async () => {
            if (deleteSubmitting) return;
            const activeDialog = deleteDialog;
            const checked = deleteDialogCheckbox;
            setDeleteError("");
            setDeleteSubmitting(true);
            try {
              const result = await activeDialog.onExecute(checked);
              if (result.status === "success") {
                setDeleteDialog(null);
                setDeleteDialogCheckbox(false);
                setDeleteError("");
              } else if (result.status === "blocked") {
                setDeleteError(result.reason);
              } else {
                setDeleteError(result.message);
              }
            } catch (error) {
              const msg =
                error instanceof Error && error.message
                  ? error.message
                  : "執行清理或刪除時發生錯誤，資料未完全清除，請再試一次或按取消。";
              setDeleteError(msg);
            } finally {
              setDeleteSubmitting(false);
            }
          }}
          onCancel={() => {
            if (deleteSubmitting) return;
            setDeleteDialog(null);
            setDeleteDialogCheckbox(false);
            setDeleteError("");
          }}
        />
      )}
    </div>
  );
}
