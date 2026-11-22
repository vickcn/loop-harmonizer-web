"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BandSession, BandSong, SeparationFocusSessionSnapshot, SongPlaybackSource, SongSource, StemChannel } from "@/lib/band/bandTypes";
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
  isQuotaExceededError,
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
  type SongPersistFailure,
  type StorageStatsSummary,
} from "@/lib/storage/songSessionStore";
import { SongCard } from "./SongCard";
import { ProjectToolbar, type ProjectBusyState } from "./ProjectToolbar";
import { ProjectManagerDialog, type ProjectDialogMode } from "./ProjectManagerDialog";
import { IconActionButton } from "./IconActionButton";
import { GoogleDrivePickerButton } from "./GoogleDrivePickerButton";
import { GoogleAccountButton } from "@/components/google/GoogleAccountButton";
import { DriveExportDialog } from "./DriveExportDialog";
import { DriveLibraryDialog } from "./DriveLibraryDialog";
import { ResourceGuardModal, type ResourceGuardConfirmSelection } from "./ResourceGuardModal";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { idbPut } from "@/lib/storage/indexedDb";
import {
  commitProjectSyncResultAtomically,
  getProjectRecord,
  setActiveProjectId,
  subscribeProjectSyncBroadcast,
} from "@/lib/storage/projectStore";
import type {
  BandProject,
  PersistedProjectRecord,
  ProjectListEntrySummary,
  ProjectStorageProvider,
} from "@/lib/projects/projectTypes";
import {
  buildProjectFromBandSongs,
  isProjectContentEqual,
  computeEntryBackupStatus,
} from "@/lib/projects/projectModel";
import {
  buildDeleteProjectConfirmConfig,
  type LocalSaveState,
} from "@/lib/projects/projectToolbarModel";
import {
  ProjectAutoSyncController,
  type ProjectDriveSyncOutcome,
} from "@/lib/projects/projectDriveSync";
import {
  ProjectManualSyncCoordinator,
  type ManualSyncFlowResult,
} from "@/lib/projects/projectSyncCoordinator";
import {
  assessProjectOfflineDownload,
  downloadEntireProjectOffline,
  projectToBandSongsMetadataOnly,
  restoreSingleProjectSongOnDemand,
  type ProjectOfflineAssessment,
  type ProjectOfflineDownloadProgress,
} from "@/lib/projects/projectRestoreManager";
import {
  checkCloudArtifactReferencesAcrossProjects,
  isAudioHashReferencedAcrossWorkspace,
} from "@/lib/projects/projectResourceReferences";
import {
  createNewProject,
  deleteProjectSafely,
  listAllProjectsForUi,
  migrateLegacyBandSessionToProject,
  openProjectMetadataAndEntries,
  prepareAndSaveProjectAs,
  promoteLocalProjectToDrive,
  loadRemoteAheadProject,
  renameProject,
  resolveProjectConflict,
  restoreLastActiveProjectOrNull,
  saveLocalProjectSnapshot,
  type ProjectAuthContext,
  type PromoteLocalToDriveProgress,
} from "@/lib/projects/projectManager";
import {
  isGoogleTokenSnapshotUsable,
  sharedGoogleAccountManager,
} from "@/lib/google/googleAccountManager";
import {
  isGoogleDrivePickerConfigured,
  type PickedDriveFile,
} from "@/lib/google/googleDrivePicker";
import {
  assessDriveImportBatch,
  executeSequentialDriveImport,
  inspectPickedDriveFiles,
} from "@/lib/google/driveImportManager";
import type { DriveImportProgress } from "@/lib/google/driveTransferTypes";
import { downloadDriveFileBlob, resolveDriveFileForDownload } from "@/lib/google/driveClient";
import { clearCachedFolderLayoutForAccount } from "@/lib/google/driveFolderManager";
import { clearResumableSessionUrisForAccount } from "@/lib/google/driveResumableUpload";
import {
  exportSongArtifactsToDrive,
  type DriveExportProgress,
  type DriveExportSelection,
} from "@/lib/google/driveExportManager";
import {
  deleteDriveRevisionArtifacts,
  listDriveLibraryEntries,
  restoreSongFromDrive,
  type DriveLibraryEntry,
  type DriveRestoreProgress,
  type InvalidDriveLibraryEntry,
} from "@/lib/google/driveRestoreManager";
import { isTaskPinnedByDriveTransfer } from "@/lib/storage/driveTransferStore";
import {
  findImportedStemByHash,
  getImportedStemRecord,
  releaseImportedStemReferenceAndMaybeGc,
  validateImportedStemIntegrity,
} from "@/lib/storage/importedStemStore";
import {
  EMPTY_MIXER_SELECTION,
  applyResetKey,
  applyResetMix,
  applyResetSpeed,
  describePlaybackError,
  formatBatchPlaySummary,
  resolveShortcutAction,
  sanitizeMixerSelection,
  toggleMuteBySelection,
  toggleSoloBySelection,
  type BatchPlayAttemptResult,
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
    badgeLabel?: string;
    changeHeading?: string;
    preserveHeading?: string;
    deleteItems: string[];
    preserveItems: string[];
    recoverability: string;
    safetyNote?: string | null;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    checkboxLabel?: string;
    checkboxDescription?: string;
    onCancelNotice?: () => void;
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
  const [uploadMoreOpen, setUploadMoreOpen] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticLogs, setDiagnosticLogs] = useState<SeparationDiagnosticEntry[]>([]);
  const googleAuth = useSyncExternalStore(
    sharedGoogleAccountManager.subscribe,
    sharedGoogleAccountManager.getSnapshot,
    sharedGoogleAccountManager.getSnapshot,
  );
  const [driveImportProgress, setDriveImportProgress] = useState<DriveImportProgress | null>(null);
  const [driveExportModalSongId, setDriveExportModalSongId] = useState<string | null>(null);
  const [driveExportSubmitting, setDriveExportSubmitting] = useState(false);
  const [driveExportError, setDriveExportError] = useState<string | null>(null);
  const [driveExportNeedsReauth, setDriveExportNeedsReauth] = useState(false);
  const [driveExportProgressBySongId, setDriveExportProgressBySongId] = useState<Record<string, DriveExportProgress>>({});
  const [driveLibraryOpen, setDriveLibraryOpen] = useState(false);
  const [driveLibraryLoading, setDriveLibraryLoading] = useState(false);
  const [driveLibraryEntries, setDriveLibraryEntries] = useState<DriveLibraryEntry[]>([]);
  const [driveLibraryInvalidEntries, setDriveLibraryInvalidEntries] = useState<InvalidDriveLibraryEntry[]>([]);
  const [driveLibraryError, setDriveLibraryError] = useState<string | null>(null);
  const [driveRestoreProgress, setDriveRestoreProgress] = useState<DriveRestoreProgress | null>(null);
  const [restoringManifestId, setRestoringManifestId] = useState<string | null>(null);
  const [restoringOriginalIds, setRestoringOriginalIds] = useState<Set<string>>(new Set());
  const driveImportAbortRef = useRef<AbortController | null>(null);
  const driveExportAbortRef = useRef<AbortController | null>(null);
  const driveExportPauseRequestedRef = useRef(false);
  const lastDriveExportSelectionRef = useRef<DriveExportSelection | null>(null);
  const driveRestoreAbortRef = useRef<AbortController | null>(null);
  const uploadMoreRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef(session);
  const selectionRef = useRef<MixerSelection>(selection);
  const startingSongIdsRef = useRef<Set<string>>(startingSongIds);
  const switchingSourceSongIdsRef = useRef<Set<string>>(new Set());
  const switchSourceRef = useRef<
    ((song: BandSong, playbackSource: "original" | "stems", options?: { autoReason?: string }) => Promise<void>) | null
  >(null);
  const profileWarningRef = useRef<string>(profileWarning);
  const hintTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!uploadMoreOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!uploadMoreRef.current?.contains(event.target as Node)) {
        setUploadMoreOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUploadMoreOpen(false);
    };
    window.addEventListener("pointerdown", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [uploadMoreOpen]);
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
  const [activeProjectRecord, setActiveProjectRecord] = useState<PersistedProjectRecord | null>(null);
  const activeProjectRecordRef = useRef<PersistedProjectRecord | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const [hasLegacyWorkspaceSongs, setHasLegacyWorkspaceSongs] = useState(false);
  const hasLegacyWorkspaceSongsRef = useRef(false);
  useEffect(() => {
    hasLegacyWorkspaceSongsRef.current = hasLegacyWorkspaceSongs;
  }, [hasLegacyWorkspaceSongs]);
  const [projectBusyState, setProjectBusyState] = useState<ProjectBusyState | null>(null);
  const projectBusyStateRef = useRef<ProjectBusyState | null>(null);
  const updateProjectBusyState = useCallback((next: ProjectBusyState | null) => {
    projectBusyStateRef.current = next;
    setProjectBusyState(next);
  }, []);
  const [projectDialogMode, setProjectDialogMode] = useState<ProjectDialogMode>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<{ projectId: string; name: string } | null>(null);
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [projectListEntries, setProjectListEntries] = useState<ProjectListEntrySummary[]>([]);
  const [projectListLoading, setProjectListLoading] = useState(false);
  const [projectListError, setProjectListError] = useState<string | null>(null);
  const [projectListIncompleteReason, setProjectListIncompleteReason] = useState<string | null>(null);
  const projectListLoadSeqRef = useRef(0);
  const cloudProjectsMapRef = useRef(new Map<string, { project: BandProject; driveVersion?: string | null }>());
  const [promoteProgress, setPromoteProgress] = useState<PromoteLocalToDriveProgress | null>(null);
  const [promoteBackupFailures, setPromoteBackupFailures] = useState<Array<{ entryId: string; displayName: string; reason: string }>>([]);
  const promoteAbortRef = useRef<AbortController | null>(null);
  const [offlineAssessment, setOfflineAssessment] = useState<ProjectOfflineAssessment | null>(null);
  const [offlineAssessmentLoading, setOfflineAssessmentLoading] = useState(false);
  const offlineAssessmentSeqRef = useRef(0);
  const [offlineDownloadProgress, setOfflineDownloadProgress] = useState<ProjectOfflineDownloadProgress | null>(null);
  const [offlineDownloadResult, setOfflineDownloadResult] = useState<{
    completedCount: number;
    reusedCount: number;
    failedSongs: Array<{ entryId: string; displayName: string; reason: string }>;
    cancelled: boolean;
  } | null>(null);
  const offlineDownloadAbortRef = useRef<AbortController | null>(null);
  const [restoringOnDemandBySongId, setRestoringOnDemandBySongId] = useState<Record<string, string>>({});
  const autoSyncControllerRef = useRef<ProjectAutoSyncController | null>(null);
  const manualSyncCoordinatorRef = useRef<ProjectManualSyncCoordinator | null>(null);
  const inFlightAudioPersistsRef = useRef<
    Map<string, Promise<{ songId: string; ok: boolean; failure?: SongPersistFailure }>>
  >(new Map());
  const [localSaveState, setLocalSaveState] = useState<LocalSaveState>("idle");
  const projectOpGenerationRef = useRef(0);
  const backgroundSeparationJobs = useSyncExternalStore(
    sharedSeparationJobManager.subscribe.bind(sharedSeparationJobManager),
    sharedSeparationJobManager.getSnapshot,
    sharedSeparationJobManager.getSnapshot,
  );
  const otherProjectJobs = backgroundSeparationJobs.filter(
    (job) =>
      Boolean(job.projectId) &&
      job.projectId !== (activeProjectRecord?.projectId ?? null) &&
      (job.stage === "preparing" ||
        job.stage === "downloading" ||
        job.stage === "processing" ||
        job.stage === "finalizing" ||
        job.stage === "pausing" ||
        job.stage === "cancelling"),
  );

  function shouldApplyIncomingProjectRecord(
    current: PersistedProjectRecord | null,
    incoming: PersistedProjectRecord,
    currentGoogleAccountId: string | null,
  ): boolean {
    if (
      incoming.storageProvider === "google_drive" &&
      incoming.ownerAccountId &&
      currentGoogleAccountId &&
      incoming.ownerAccountId !== currentGoogleAccountId
    ) {
      return false;
    }
    if (!current) return true;
    if (current.projectId !== incoming.projectId) return false;
    if (incoming.localRevision < current.localRevision) {
      return false;
    }
    if (
      incoming.localRevision === current.localRevision &&
      current.dirty &&
      !incoming.dirty &&
      current.project.revisionToken !== incoming.project.revisionToken &&
      incoming.lastSyncedRemoteRevisionToken !== incoming.project.revisionToken
    ) {
      return false;
    }
    return true;
  }

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
    activeProjectRecordRef.current = activeProjectRecord;
    activeProjectIdRef.current = activeProjectRecord?.projectId ?? null;
  }, [activeProjectRecord]);

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
    const currentProjId = activeProjectRecord?.projectId ?? null;
    setSession((previous) => {
      let changed = false;
      const songs = previous.songs.map((song) => {
        const matchingJobs = backgroundSeparationJobs.filter((candidate) => {
          const idMatch =
            candidate.songId === song.id ||
            (Boolean(candidate.entryId) && candidate.entryId === (song.projectEntryId ?? song.id));
          if (!idMatch) return false;
          if (currentProjId) {
            return candidate.projectId === currentProjId;
          }
          return !candidate.projectId;
        });
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
  }, [backgroundSeparationJobs, activeProjectRecord?.projectId]);

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

  const getProjectAuthContext = useCallback((): ProjectAuthContext => {
    const snap = sharedGoogleAccountManager.getSnapshot();
    const token = sharedGoogleAccountManager.getValidAccessToken();
    return {
      accountId: snap.account?.accountId ?? null,
      accessToken: token,
      generation: snap.generation,
      isGenerationValid: (gen, acc) => sharedGoogleAccountManager.isGenerationValid(gen, acc),
      onAuthExpired: () => sharedGoogleAccountManager.markTokenExpired(snap.generation),
    };
  }, []);

  const applyActiveProjectRecordMonotonically = useCallback((incoming: PersistedProjectRecord) => {
    const current = activeProjectRecordRef.current;
    const currentAcc = sharedGoogleAccountManager.getSnapshot().account?.accountId ?? null;
    if (!shouldApplyIncomingProjectRecord(current, incoming, currentAcc)) {
      return false;
    }
    activeProjectRecordRef.current = incoming;
    activeProjectIdRef.current = incoming.projectId;
    setActiveProjectRecord(incoming);
    return true;
  }, []);

  if (!autoSyncControllerRef.current) {
    autoSyncControllerRef.current = new ProjectAutoSyncController({
      getAuthContext: getProjectAuthContext,
      onStatusChanged: (projectId, outcome) => {
        if (!mountedRef.current || activeProjectIdRef.current !== projectId) return;
        if (outcome.status === "local_dirty") {
          setLocalSaveState("dirty");
          return;
        }
        if (outcome.status === "local_saving") {
          setLocalSaveState("saving");
          return;
        }
        if (outcome.status === "local_save_error") {
          setLocalSaveState("error");
          showShortcutHint(outcome.errorMessage || "寫入本機專案資料庫失敗。");
          return;
        }
        if (outcome.status === "local_saved") {
          if (!autoSyncControllerRef.current?.hasPendingLocalEdits(projectId)) {
            setLocalSaveState("saved");
          }
        }
        if ("record" in outcome && outcome.record) {
          applyActiveProjectRecordMonotonically(outcome.record);
          if (outcome.status === "synced" && outcome.superseded) {
            showShortcutHint("本次同步完成，但仍有較新的本機修改尚未同步。");
          }
        } else if (outcome.status === "conflict") {
          void getProjectRecord(projectId).then((fresh) => {
            if (fresh && mountedRef.current && activeProjectIdRef.current === projectId) {
              applyActiveProjectRecordMonotonically(fresh);
            }
          });
        }
      },
    });
  }

  const scheduleActiveProjectSave = useCallback((
    songsOverride?: readonly BandSong[],
    options?: { immediateLocal?: boolean; incrementRevision?: boolean },
  ) => {
    const current = activeProjectRecordRef.current;
    if (!current) return;
    const nextSongs = songsOverride ?? sessionRef.current.songs;
    const builtProject = buildProjectFromBandSongs({
      existingProject: current.project,
      songs: nextSongs,
      incrementRevision: options?.incrementRevision ?? true,
    });
    const nextRecord: PersistedProjectRecord = {
      ...current,
      project: builtProject,
      localRevision: builtProject.revision,
      dirty: current.storageProvider === "google_drive" ? true : false,
      syncStatus:
        current.storageProvider === "google_drive"
          ? current.syncStatus === "conflict"
            ? "conflict"
            : "dirty"
          : "local_only",
      lastSavedAt: Date.now(),
    };
    activeProjectRecordRef.current = nextRecord;
    setActiveProjectRecord(nextRecord);
    setLocalSaveState(options?.immediateLocal ? "saving" : "dirty");
    // 一般編輯只做本機儲存並標記 dirty；Google Drive 同步須由使用者按下同步鈕
    autoSyncControllerRef.current?.scheduleProjectEdit(nextRecord, {
      immediateLocal: options?.immediateLocal,
    });
  }, []);

  const persistSongDebounced = useCallback((songId: string, delayMs = 300) => {
    if (activeProjectRecordRef.current) {
      scheduleActiveProjectSave(sessionRef.current.songs);
      return;
    }
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
  }, [handlePersistResult, patchSongMetadataOnly, scheduleActiveProjectSave]);

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
      if (activeProjectRecordRef.current) {
        const syncedEntrySong: BandSong = {
          ...nextSong,
          projectEntryId: nextSong.projectEntryId ?? nextSong.id,
          availabilityState: "stems_loaded",
          persistenceStatus: "saved",
          persistenceMessage: "已載入分軌",
        };
        const projSongsSnapshot = sessionRef.current.songs.map((candidate) => candidate.id === song.id ? syncedEntrySong : candidate);
        sessionRef.current = { ...sessionRef.current, songs: projSongsSnapshot };
        setSession((previous) => ({ ...previous, songs: previous.songs.map((candidate) => candidate.id === song.id ? syncedEntrySong : candidate) }));
        setSelection((current) => sanitizeMixerSelection(current, projSongsSnapshot));
        if (!options?.skipPersist) {
          scheduleActiveProjectSave(projSongsSnapshot);
        }
        return syncedEntrySong;
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
  }, [applySongToEngine, getEngine, persistSongDebounced, scheduleActiveProjectSave]);

  const installChunkedStemSet = useCallback(async (
    song: BandSong,
    summary: ChunkedSeparationSummary,
    cacheKey: string,
    message: string,
    options?: {
      preferredSource?: SongPlaybackSource;
      skipPersist?: boolean;
      stemLayout?: "four_stem" | "two_stem_direct";
      isImportedStem?: boolean;
    },
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
      stemLayout: options?.stemLayout,
      tracks: groupTracks,
      playbackRate: getEffectivePlaybackRate(song),
      keyShiftSemitones: song.keyShiftSemitones,
      loop: song.loop,
      initialPositionSec: song.playheadSec,
    });

    const targetPlaybackSource: SongPlaybackSource =
      song.sourceAudioMissing
        ? "stems"
        : options?.preferredSource === "original"
          ? "original"
          : "stems";
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
      ...(activeProjectRecordRef.current ? { availabilityState: "stems_loaded" as const, persistenceStatus: "saved" as const } : {}),
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
    if (!options?.isImportedStem) {
      void addCheckpointReference({
        taskId: summary.taskId,
        songId: song.id,
        mode: summary.mode,
        source: "BandMixer.installChunkedStemSet",
      }).catch(() => undefined);
    }
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

      // 檢查是否已有相容來源 Hash 的雲端匯入分軌（ImportedStemRecord）
      const importedByHash = await findImportedStemByHash({
        sourceAudioHash,
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
      }).catch(() => null);
      if (importedByHash) {
        const impValidation = await validateImportedStemIntegrity(importedByHash.importId).catch(() => null);
        if (impValidation?.valid && impValidation.record && separationTokensRef.current.get(song.id) === token) {
          const freshSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
          const resolvedCacheKey = createSeparationCacheKey({
            sourceAudioHash,
            modelVersion: impValidation.record.modelVersion,
            separationMode: impValidation.record.requestedMode,
            processingVersion: impValidation.record.processingVersion,
          });
          await installChunkedStemSet(
            {
              ...freshSong,
              importedStemOrigin: freshSong.importedStemOrigin ?? {
                importId: impValidation.record.importId,
                ownerAccountId: impValidation.record.ownerAccountId,
                revisionId: impValidation.record.revisionId,
                manifestFileId: impValidation.record.manifestFileId,
                pcmFormat: impValidation.record.pcmFormat,
                stemLayout: impValidation.record.stemLayout,
                importedAt: impValidation.record.createdAt,
              },
            },
            {
              taskId: impValidation.record.importId,
              mode: impValidation.record.requestedMode,
              sampleRate: impValidation.record.sampleRate,
              totalSamples: impValidation.record.totalSamples,
              totalChunks: impValidation.record.totalChunks,
              committedBytes: impValidation.record.committedBytes,
              durationSeconds: impValidation.record.totalSamples / impValidation.record.sampleRate,
            },
            resolvedCacheKey,
            `已從雲端匯入分軌恢復（共 ${impValidation.record.totalChunks} 段按需播放）。`,
            {
              preferredSource: options?.preferredSource ?? "stems",
              skipPersist: options?.skipPersist,
              stemLayout: impValidation.record.stemLayout,
              isImportedStem: true,
            },
          );
          void refreshCacheStats();
        }
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
      const nextIdleSongs = sessionRef.current.songs.map((song) => (
        idleIdSet.has(song.id)
          ? {
              ...song,
              status: song.status === "playing" ? song.status : ("stopped" as const),
              audioLoadState: "unloaded" as const,
              stemIds: [],
            }
          : song
      ));
      sessionRef.current = { ...sessionRef.current, songs: nextIdleSongs };
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((song) => (
          idleIdSet.has(song.id)
            ? {
                ...song,
                status: song.status === "playing" ? song.status : "stopped",
                audioLoadState: "unloaded",
                stemIds: [],
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
    if (readySong.importedStemOrigin?.importId && !removedSongIdsRef.current.has(readySong.id)) {
      const impCheck = await validateImportedStemIntegrity(readySong.importedStemOrigin.importId).catch(() => null);
      if (impCheck?.valid && impCheck.record && !removedSongIdsRef.current.has(readySong.id)) {
        const resolvedCacheKey =
          readySong.cacheKey ||
          createSeparationCacheKey({
            sourceAudioHash: impCheck.record.sourceAudioHash,
            modelVersion: impCheck.record.modelVersion,
            separationMode: impCheck.record.requestedMode,
            processingVersion: impCheck.record.processingVersion,
          });
        await installChunkedStemSet(
          readySong,
          {
            taskId: impCheck.record.importId,
            mode: impCheck.record.requestedMode,
            sampleRate: impCheck.record.sampleRate,
            totalSamples: impCheck.record.totalSamples,
            totalChunks: impCheck.record.totalChunks,
            committedBytes: impCheck.record.committedBytes,
            durationSeconds: impCheck.record.totalSamples / impCheck.record.sampleRate,
          },
          resolvedCacheKey,
          `已從雲端匯入分軌載入（共 ${impCheck.record.totalChunks} 段按需播放）。`,
          {
            preferredSource,
            skipPersist: true,
            stemLayout: impCheck.record.stemLayout,
            isImportedStem: true,
          },
        );
        return;
      }
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
    if (song.sourceAudioMissing && song.playbackSource === "stems") {
      const latestSong = sessionRef.current.songs.find((item) => item.id === song.id) ?? song;
      const stemsMissing =
        latestSong.stemIds.length === 0 ||
        latestSong.stemIds.some((id) => !engine.hasTrack(id)) ||
        (latestSong.separationUsesChunkPlayback && !engine.hasHealthyStemMixBus(latestSong.id));
      if (stemsMissing) {
        if (isFocusLocked() && !options?.allowDuringFocus) {
          return false;
        }
        await ensureStemsInstalledForReadySong(latestSong, "stems");
      }
      const afterInstall = sessionRef.current.songs.find((item) => item.id === song.id) ?? latestSong;
      return afterInstall.stemIds.length > 0 && engine.hasHealthyStemMixBus(afterInstall.id);
    }
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
      sessionRef.current = {
        ...sessionRef.current,
        songs: sessionRef.current.songs.map((item) => (item.id === song.id ? readySong : item)),
      };
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
      if (record.importedStemOrigin?.importId) {
        const impCheck = await validateImportedStemIntegrity(record.importedStemOrigin.importId).catch(() => null);
        if (isCancelled() || removedSongIdsRef.current.has(record.songId)) return;
        if (impCheck?.valid && impCheck.record) {
          const stemOnlySong = restoreBandSongFromRecord(record, {
            sourceAudioId: `${record.songId}_original`,
            durationSec: impCheck.record.totalSamples / impCheck.record.sampleRate,
            persistenceStatus: "saved",
            persistenceMessage: "已恢復雲端分軌（無本機原曲，可直接播放分軌）",
            audioLoadState: "unloaded",
            sourceAudioMissing: true,
          });
          const existsInRef = sessionRef.current.songs.some((item) => item.id === stemOnlySong.id);
          sessionRef.current = {
            ...sessionRef.current,
            songs: existsInRef
              ? sessionRef.current.songs.map((item) => (item.id === stemOnlySong.id ? stemOnlySong : item))
              : [...sessionRef.current.songs, stemOnlySong],
          };
          setSession((previous) => {
            const exists = previous.songs.some((item) => item.id === stemOnlySong.id);
            return {
              ...previous,
              songs: exists
                ? previous.songs.map((item) => (item.id === stemOnlySong.id ? stemOnlySong : item))
                : [...previous.songs, stemOnlySong],
            };
          });
          await installChunkedStemSet(
            stemOnlySong,
            {
              taskId: impCheck.record.importId,
              mode: impCheck.record.requestedMode,
              sampleRate: impCheck.record.sampleRate,
              totalSamples: impCheck.record.totalSamples,
              totalChunks: impCheck.record.totalChunks,
              committedBytes: impCheck.record.committedBytes,
              durationSeconds: impCheck.record.totalSamples / impCheck.record.sampleRate,
            },
            record.cacheKey ||
              createSeparationCacheKey({
                sourceAudioHash: impCheck.record.sourceAudioHash,
                modelVersion: impCheck.record.modelVersion,
                separationMode: impCheck.record.requestedMode,
                processingVersion: impCheck.record.processingVersion,
              }),
            `已從雲端匯入分軌恢復（共 ${impCheck.record.totalChunks} 段按需播放）。`,
            {
              preferredSource: "stems",
              skipPersist: true,
              stemLayout: impCheck.record.stemLayout,
              isImportedStem: true,
            },
          );
          return;
        }
      }
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
      } else if (record.importedStemOrigin?.importId) {
        const impCheck = await validateImportedStemIntegrity(record.importedStemOrigin.importId).catch(() => null);
        if (isCancelled() || removedSongIdsRef.current.has(record.songId)) return;
        if (impCheck?.valid && impCheck.record) {
          const resolvedCacheKey =
            record.cacheKey ||
            createSeparationCacheKey({
              sourceAudioHash: impCheck.record.sourceAudioHash,
              modelVersion: impCheck.record.modelVersion,
              separationMode: impCheck.record.requestedMode,
              processingVersion: impCheck.record.processingVersion,
            });
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
              taskId: impCheck.record.importId,
              mode: impCheck.record.requestedMode,
              sampleRate: impCheck.record.sampleRate,
              totalSamples: impCheck.record.totalSamples,
              totalChunks: impCheck.record.totalChunks,
              committedBytes: impCheck.record.committedBytes,
              durationSeconds: impCheck.record.totalSamples / impCheck.record.sampleRate,
            },
            resolvedCacheKey,
            `已從雲端匯入分軌恢復（共 ${impCheck.record.totalChunks} 段按需播放）。`,
            {
              preferredSource: record.playbackSource,
              skipPersist: true,
              stemLayout: impCheck.record.stemLayout,
              isImportedStem: true,
            },
          );
          return;
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
    const unsubscribeAccountEnd = sharedGoogleAccountManager.onAccountSessionEnd(
      ({ reason, previousAccountId }) => {
        if (previousAccountId) {
          clearResumableSessionUrisForAccount(previousAccountId);
          clearCachedFolderLayoutForAccount(previousAccountId);
          autoSyncControllerRef.current?.invalidateAccount(previousAccountId);
        }
        driveImportAbortRef.current?.abort();
        driveImportAbortRef.current = null;
        driveExportPauseRequestedRef.current = false;
        driveExportAbortRef.current?.abort();
        driveExportAbortRef.current = null;
        driveRestoreAbortRef.current?.abort();
        driveRestoreAbortRef.current = null;
        promoteAbortRef.current?.abort();
        promoteAbortRef.current = null;
        offlineDownloadAbortRef.current?.abort();
        offlineDownloadAbortRef.current = null;
        setDriveImportProgress(null);
        setDriveExportSubmitting(false);
        setDriveExportProgressBySongId({});
        setRestoringManifestId(null);
        setDriveRestoreProgress(null);
        if (reason === "signed_out" || reason === "revoked" || reason === "switched") {
          manualSyncCoordinatorRef.current?.invalidate();
          setDriveLibraryEntries([]);
          setDriveLibraryInvalidEntries([]);
          setDriveLibraryError(null);
          setProjectListIncompleteReason(null);
          cloudProjectsMapRef.current.clear();
          setProjectListEntries((prev) => prev.filter((item) => item.storageProvider === "local"));
          if (reason !== "switched") {
            setDriveLibraryOpen(false);
          }
          const activeProj = activeProjectRecordRef.current;
          if (
            reason === "switched" &&
            activeProj &&
            activeProj.storageProvider === "google_drive" &&
            (!previousAccountId || activeProj.ownerAccountId === previousAccountId)
          ) {
            const engine = getEngine();
            sessionRef.current.songs.forEach((s) => {
              const ids = [s.sourceAudioId, ...s.stemIds];
              engine.stopTracks(ids);
              ids.forEach((id) => engine.removeTrack(id));
            });
            sourceFilesRef.current.clear();
            stemResultsRef.current.clear();
            activeProjectRecordRef.current = null;
            activeProjectIdRef.current = null;
            setActiveProjectRecord(null);
            setLocalSaveState("idle");
            setSession((prev) => ({ ...prev, songs: [] }));
            setSelection(EMPTY_MIXER_SELECTION);
            void setActiveProjectId(null).then(() => {
              if (mountedRef.current) {
                setRestoreAttempt((n) => n + 1);
              }
            });
            showShortcutHint("已切換 Google 帳號，已卸載前帳號的雲端專案畫面（未儲存修改與本機快取安全保留）。");
          }
        }
        if (reason === "expired") {
          setDriveExportNeedsReauth(true);
          setDriveExportError("Google 授權已過期，請重新授權後接續上傳。");
          const activeProj = activeProjectRecordRef.current;
          if (activeProj && activeProj.storageProvider === "google_drive" && activeProj.dirty) {
            const waitMsg = "Google 授權已過期，請重新授權後同步變更（本機已安全保存）。";
            void commitProjectSyncResultAtomically({
              projectId: activeProj.projectId,
              expectedBase: {
                ownerAccountId: activeProj.ownerAccountId,
                syncGeneration: activeProj.syncGeneration,
                localRevision: activeProj.localRevision,
                revisionToken: activeProj.project.revisionToken,
              },
              kind: "waiting_auth",
              remoteMetadata: { lastError: waitMsg },
            }).then((commitRes) => {
              if (
                commitRes.committed &&
                mountedRef.current &&
                activeProjectIdRef.current === activeProj.projectId
              ) {
                applyActiveProjectRecordMonotonically(commitRes.record);
              }
            });
          }
        }
      },
    );
    return unsubscribeAccountEnd;
  }, [getEngine, showShortcutHint]);

  useEffect(() => {
    mountedRef.current = true;
    sharedPerfTelemetry.startObservingLongTasks();
    const feedbackTimers = cardFeedbackTimersRef.current;
    return () => {
      mountedRef.current = false;
      manualSyncCoordinatorRef.current?.invalidate();
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
      }
      feedbackTimers.forEach((timer) => window.clearTimeout(timer));
      feedbackTimers.clear();
      void autoSyncControllerRef.current?.dispose();
      sharedPerfTelemetry.stopObserving();
      engineRef.current?.dispose();
      engineRef.current = null;
      // 路由切換只會卸載 UI；全域 Job Manager 與 Runner 持有中的 Worker 必須繼續執行，不得清理使用中音訊/模型。
      if (!sharedSeparationJobManager.hasRunningHeavyTask() && !sharedSeparationCoordinator.hasRunningHeavyTask()) {
        void disposeStemSeparator({ revokeModelUrl: true });
      }
    };
  }, []);

  // 當全域分軌任務在背景／其他路由完成或結束時，若 BandMixer 處於掛載狀態，僅為所屬目前專案載入分軌播放資源並解除專注模式
  useEffect(() => {
    const currentProjId = activeProjectRecord?.projectId ?? null;
    for (const job of backgroundSeparationJobs) {
      if (currentProjId) {
        if (job.projectId !== currentProjId) continue;
      } else if (job.projectId) {
        continue;
      }
      const targetSong = sessionRef.current.songs.find(
        (item) =>
          item.id === job.songId ||
          (Boolean(job.entryId) && (item.projectEntryId ?? item.id) === job.entryId),
      );
      if (!targetSong) continue;

      if (job.stage === "completed") {
        const hydrationKey = `${currentProjId ?? "legacy"}:${job.taskId}:${job.generation}:${targetSong.separationMode ?? ""}`;
        const needsStemAttach =
          !targetSong.separationUsesChunkPlayback ||
          targetSong.stemIds.length === 0 ||
          targetSong.separationStatus !== "completed";
        if (!needsStemAttach || hydratedCompletedJobsRef.current.has(hydrationKey)) {
          continue;
        }
        hydratedCompletedJobsRef.current.add(hydrationKey);
        void (async () => {
          if (currentProjId !== activeProjectIdRef.current) return;
          const latest = sessionRef.current.songs.find(
            (item) =>
              item.id === job.songId ||
              (Boolean(job.entryId) && (item.projectEntryId ?? item.id) === job.entryId),
          );
          if (!latest || !mountedRef.current) return;
          const validation = await verifyAuthoritativeCheckpointForSong(latest, true).catch(() => null);
          if (!mountedRef.current || currentProjId !== activeProjectIdRef.current) return;
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
            if (currentProjId) {
              const latestRec = await getProjectRecord(currentProjId).catch(() => null);
              if (latestRec && mountedRef.current && activeProjectIdRef.current === currentProjId) {
                activeProjectRecordRef.current = latestRec;
                setActiveProjectRecord(latestRec);
              }
            }
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
  }, [backgroundSeparationJobs, activeProjectRecord?.projectId, finishSeparationFocus, installChunkedStemSet, refreshCacheStats, verifyAuthoritativeCheckpointForSong]);

  useEffect(() => {
    let cancelled = false;
    void refreshResourceProfile();

    const runRestore = async () => {
      setRestoringSession(true);
      setRestoreError("");
      setRestoringMessage("正在檢查作用中專案與本機歌曲資料庫…");
      try {
        const authSnap = sharedGoogleAccountManager.getSnapshot();
        const validToken = sharedGoogleAccountManager.getValidAccessToken();
        const [activeProj, persisted] = await Promise.all([
          restoreLastActiveProjectOrNull({
            currentAccountId: authSnap.account?.accountId ?? null,
          }),
          loadPersistedBandSession(),
        ]);
        if (cancelled) return;
        setHasLegacyWorkspaceSongs(persisted.songs.length > 0);

        if (activeProj) {
          setRestoringMessage(`正在開啟專案「${activeProj.project.name}」（僅讀取 Metadata，不一次下載或解碼全部歌曲）…`);
          const projSongs = await projectToBandSongsMetadataOnly(activeProj.project, {
            currentAccountId: authSnap.account?.accountId ?? null,
            hasValidGoogleToken: Boolean(authSnap.account && validToken),
          });
          if (cancelled) return;
          activeProjectRecordRef.current = activeProj;
          activeProjectIdRef.current = activeProj.projectId;
          setActiveProjectRecord(activeProj);
          setLocalSaveState("saved");
          autoSyncControllerRef.current?.setProjectLocalSaveState(activeProj.projectId, "saved");
          sessionRef.current = { ...sessionRef.current, songs: projSongs };
          setSession((previous) => ({ ...previous, songs: projSongs }));
          setSelection(projSongs.length > 0 ? { songId: projSongs[0].id, stemId: null } : EMPTY_MIXER_SELECTION);
          setRestoringSession(false);
          setRestoringMessage("");
          return;
        }
        setLocalSaveState("idle");

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
        void autoSyncControllerRef.current?.flushLocalSaves();
      }
    };
    const onPageHide = () => {
      void flushPendingSongPersists();
      void autoSyncControllerRef.current?.flushLocalSaves();
    };
    const onOnline = () => {
      // 網路恢復只保存本機資料並提示待同步專案，絕不自動同步
      const accountId = sharedGoogleAccountManager.getSnapshot().account?.accountId;
      if (accountId) {
        void autoSyncControllerRef.current?.listPendingSyncProjects(accountId).then((res) => {
          if (res.dirtyProjectIds.length > 0 && mountedRef.current) {
            showShortcutHint(`已恢復連線；有 ${res.dirtyProjectIds.length} 個專案尚未同步，請手動按「同步至 Google Drive」。`);
          }
        });
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);

    const unsubscribeProjectBroadcast = subscribeProjectSyncBroadcast((msg) => {
      if (cancelled) return;
      if (msg.type === "project-deleted" && msg.projectId === activeProjectIdRef.current) {
        activeProjectRecordRef.current = null;
        activeProjectIdRef.current = null;
        setActiveProjectRecord(null);
        setSession((prev) => ({ ...prev, songs: [] }));
        showShortcutHint("目前開啟的專案已在其他分頁刪除。");
      }
    });

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
      unsubscribeProjectBroadcast();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      void flushPendingSongPersists();
      void autoSyncControllerRef.current?.flushLocalSaves();
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
          if (!activeProjectIdRef.current && song.sourceAudioHash && now - lastSaved >= 2000) {
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
    const patchKeys = Object.keys(patch) as Array<keyof BandSong>;
    const isTransientPlaybackOnlyPatch =
      patchKeys.length > 0 &&
      patchKeys.every(
        (key) =>
          key === "status" ||
          key === "playheadSec" ||
          key === "selected" ||
          key === "audioLoadState",
      );

    let shouldPersist = false;
    const nextSongs = sessionRef.current.songs.map((song) => {
      if (song.id !== songId) return song;
      const normalized: Partial<BandSong> = { ...patch };
      if ("originalBpm" in normalized) normalized.originalBpm = clampBpm(normalized.originalBpm ?? song.originalBpm);
      if ("targetBpm" in normalized) normalized.targetBpm = clampBpm(normalized.targetBpm ?? song.targetBpm);
      if ("keyShiftSemitones" in normalized) normalized.keyShiftSemitones = Math.max(-12, Math.min(12, Math.round(normalized.keyShiftSemitones ?? 0)));
      const next = { ...song, ...normalized };
      applySongAudioPatch(song, next);
      shouldPersist = activeProjectRecordRef.current
        ? !isTransientPlaybackOnlyPatch
        : Boolean(next.sourceAudioHash);
      return next;
    });
    sessionRef.current = { ...sessionRef.current, songs: nextSongs };
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => {
        if (song.id !== songId) return song;
        const matched = nextSongs.find((candidate) => candidate.id === songId);
        return matched ?? song;
      }),
    }));
    if (shouldPersist) {
      persistSongDebounced(songId, options?.persistDelayMs ?? 300);
    }
  }, [applySongAudioPatch, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const persistNewOrRelinkedSong = useCallback((song: BandSong, file: Blob, sourceAudioHash: string, force = false) => {
    const task = (async (): Promise<{ songId: string; ok: boolean; failure?: SongPersistFailure }> => {
      if (activeProjectRecordRef.current) {
        try {
          await idbPut("audioFiles", {
            key: sourceAudioHash,
            sourceAudioHash,
            blob: file,
            fileName: song.fileName,
            mimeType: song.mimeType || file.type || "",
            sizeBytes: file.size,
            lastModified: song.fileLastModified || Date.now(),
            createdAt: Date.now(),
          });
          patchSongMetadataOnly(song.id, {
            persistenceStatus: "saved",
            persistenceMessage: "已保存本機音檔於目前專案",
            hasConflict: false,
          });
          scheduleActiveProjectSave(sessionRef.current.songs, { immediateLocal: true });
          void refreshCacheStats();
          return { songId: song.id, ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "無法寫入本機音檔資料庫。";
          patchSongMetadataOnly(song.id, {
            persistenceStatus: "error",
            persistenceMessage: msg,
          });
          void refreshCacheStats();
          return {
            songId: song.id,
            ok: false,
            failure: {
              songId: song.id,
              songName: song.name,
              reason: "error",
              message: msg,
              isQuotaError: isQuotaExceededError(err),
            },
          };
        }
      }
      const res = await saveSongWithAudioFile({ song, file, sourceAudioHash, force });
      handlePersistResult(song.id, res);
      void refreshCacheStats();
      if (res.ok) {
        return { songId: song.id, ok: true };
      }
      return {
        songId: song.id,
        ok: false,
        failure: res.reason === "conflict"
          ? {
              songId: song.id,
              songName: song.name,
              reason: "conflict",
              message: "偵測到其他分頁修改了此歌曲，請先確認版本衝突。",
            }
          : {
              songId: song.id,
              songName: song.name,
              reason: "error",
              message: res.message,
              isQuotaError: res.isQuotaError,
            },
      };
    })().finally(() => {
      if (inFlightAudioPersistsRef.current.get(song.id) === task) {
        inFlightAudioPersistsRef.current.delete(song.id);
      }
    });
    inFlightAudioPersistsRef.current.set(song.id, task);
    return task;
  }, [handlePersistResult, patchSongMetadataOnly, refreshCacheStats, scheduleActiveProjectSave]);

  /** 共用單首匯入核心：本機檔案與 Google Drive 音檔皆走同一套持久化、設定還原與快取比對管線。 */
  const importSingleSongCore = async (
    file: File,
    options?: {
      source?: SongSource;
      deferDecode?: boolean;
      statusReporter?: (message: string) => void;
    },
  ): Promise<BandSong | null> => {
    const engine = getEngine();
    const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sourceAudioId = `${songId}_original`;
    const shouldDeferDecode = Boolean(options?.deferDecode);
    options?.statusReporter?.(
      shouldDeferDecode ? `正在保存至本機（待按需解碼）：${file.name}` : `正在解碼音檔：${file.name}`,
    );

    try {
      let durationSec = 0;
      if (!shouldDeferDecode) {
        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        durationSec = await engine.loadTrack(sourceAudioId, file, "soundtouch");
        sharedPerfTelemetry.recordDecodeDuration(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt,
        );
      }

      const sourceAudioHash = await hashSourceAudio(file);
      const settingsKey = `${file.name}:${file.size}:${file.lastModified}`;
      const saved = await loadSongSettings(settingsKey).catch(() => null);
      const songSource: SongSource = options?.source
        ? options.source.provider === "google_drive"
          ? { ...options.source, sourceAudioHash }
          : options.source
        : { provider: "local" };

      const activeProj = activeProjectRecordRef.current;
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
        audioLoadState: shouldDeferDecode ? "unloaded" : "ready",
        source: songSource,
        ...(activeProj
          ? {
              projectEntryId: songId,
              availabilityState: "local_playable" as const,
              backupStatus: songSource.provider === "google_drive" ? ("cross_device_ready" as const) : ("local_only" as const),
            }
          : {}),
      });
      const restoredRates = saved ? sanitizeSongSavedRates(saved.savedRates) : [1];
      const song: BandSong = saved
        ? {
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
          }
        : baseSong;

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
      if (!shouldDeferDecode) {
        applySongToEngine(song);
      }
      sessionRef.current = { ...sessionRef.current, songs: [...sessionRef.current.songs, song] };
      setSession((previous) => ({ ...previous, songs: [...previous.songs, song] }));
      setSelection((previous) => (previous.songId ? previous : { songId: song.id, stemId: null }));

      await persistNewOrRelinkedSong(song, file, sourceAudioHash);

      const restoreToken = Symbol(`restore_${songId}`);
      separationTokensRef.current.set(songId, restoreToken);
      window.setTimeout(
        () =>
          void restoreCachedStems(song, file, restoreToken, {
            knownHash: sourceAudioHash,
          }),
        0,
      );
      return song;
    } catch (error) {
      if (!shouldDeferDecode) {
        engine.removeTrack(sourceAudioId);
      }
      const detail =
        error instanceof Error && error.message ? error.message : "無法解碼或讀取此音檔格式";
      const msg = `「${file.name}」載入失敗：${detail}`;
      setUploadError(msg);
      showShortcutHint(msg);
      return null;
    }
  };

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
        await importSingleSongCore(file, {
          source: { provider: "local" },
          statusReporter: setUploadStatus,
        });
      }
    } finally {
      setUploadStatus("");
      setLoading(false);
    }
  };

  const handleDriveMetadataPicked = async (
    pickedFiles: PickedDriveFile[],
    context: { accountId: string; generation: number; accessToken: string },
  ) => {
    if (!pickedFiles.length) return;
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已鎖定雲端音檔下載與匯入。";
      setUploadError(msg);
      showShortcutHint(msg);
      return;
    }

    setUploadError("");
    const inspectController = new AbortController();
    driveImportAbortRef.current = inspectController;
    setDriveImportProgress({
      stage: "inspecting",
      fileIndex: 0,
      totalFiles: pickedFiles.length,
      fileName: pickedFiles[0].name,
      loadedBytes: 0,
      totalBytes: null,
      completedCount: 0,
      failedCount: 0,
    });

    try {
      await restorePromiseRef.current.catch(() => undefined);

      const inspected = await inspectPickedDriveFiles(pickedFiles, {
        accessToken: context.accessToken,
        signal: inspectController.signal,
        onInspectingFile: (idx, total, f) => {
          setDriveImportProgress({
            stage: "inspecting",
            fileIndex: idx,
            totalFiles: total,
            fileName: f.name,
            loadedBytes: 0,
            totalBytes: f.sizeBytes ?? null,
            completedCount: 0,
            failedCount: 0,
          });
        },
      });

      if (inspected.authExpired) {
        sharedGoogleAccountManager.markTokenExpired(context.generation);
      }

      if (!sharedGoogleAccountManager.isGenerationValid(context.generation, context.accountId)) {
        setDriveImportProgress(null);
        return;
      }

      if (inspected.readyFiles.length === 0) {
        const reasonText = inspected.failedFiles.map((f) => f.reason).join("；");
        setUploadError(reasonText || "選取的雲端檔案無法下載或沒有存取權限。");
        setDriveImportProgress(null);
        return;
      }

      const cap = await collectDeviceCapabilities();
      const profileEval = sharedResourceProfileManager.evaluate(cap, sharedPerfTelemetry.getSignals());
      setResourceProfile(profileEval.profile);

      const batchAssessment = assessDriveImportBatch(inspected.readyFiles, cap, {
        profile: profileEval.profile,
        separationFocusActive: isFocusLocked(),
      });

      if (batchAssessment.hardBlocked || batchAssessment.requiresConfirmation) {
        const engine = getEngine();
        const guardAssessment = assessResourceRisk({
          operation: "upload",
          songName:
            inspected.readyFiles.length === 1
              ? inspected.readyFiles[0].name
              : `${inspected.readyFiles.length} 首 Google Drive 音檔`,
          fileSizeBytes: batchAssessment.estimatedTotalBytes,
          activeSongCount: sessionRef.current.songs.length,
          playingSongCount: sessionRef.current.songs.filter((s) => s.status === "playing").length,
          estimatedInMemoryAudioBytes: engine.getTrackMemoryEstimateBytes(),
          hasOtherIdleDecodedSongs: sessionRef.current.songs.some(
            (s) => s.status !== "playing" && engine.hasTrack(s.sourceAudioId),
          ),
          profile: profileEval.profile,
          capabilities: cap,
          performanceSignals: sharedPerfTelemetry.getSignals(),
        });

        const mergedAssessment: ResourceRiskAssessment = {
          ...guardAssessment,
          requiresConfirmation: true,
          blockedByDefault: batchAssessment.hardBlocked || guardAssessment.blockedByDefault,
          riskLevel: batchAssessment.hardBlocked ? "critical" : guardAssessment.riskLevel === "low" ? "medium" : guardAssessment.riskLevel,
          admission: batchAssessment.hardBlocked
            ? {
                ...guardAssessment.admission,
                allowed: false,
                hardRejected: true,
                message: batchAssessment.reasons[0] ?? guardAssessment.admission.message,
              }
            : guardAssessment.admission,
          reasons: [...batchAssessment.reasons, ...guardAssessment.reasons.filter((r) => !batchAssessment.reasons.includes(r))],
        };

        const decision = await requestGuardConfirmation({
          title: `確認從 Google Drive 下載 ${inspected.readyFiles.length} 首歌曲`,
          subtitle: `估計下載大小約 ${(batchAssessment.estimatedTotalBytes / (1024 * 1024)).toFixed(1)} MiB（將以 concurrency = 1 逐首下載並持久化，不經 Vercel 中繼）`,
          assessment: mergedAssessment,
        });
        if (!decision || batchAssessment.hardBlocked) {
          setDriveImportProgress(null);
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

      if (!persistRequestedRef.current) {
        persistRequestedRef.current = true;
        void requestPersistentStorage().then(() => refreshCacheStats());
      }

      const downloadController = new AbortController();
      driveImportAbortRef.current = downloadController;
      const isConstrained =
        profileEval.profile.tier === "constrained" ||
        profileEval.profile.formFactorHint === "mobile" ||
        profileEval.profile.formFactorHint === "tablet";

      const result = await executeSequentialDriveImport(inspected.readyFiles, {
        accessToken: context.accessToken,
        accountId: context.accountId,
        generation: context.generation,
        isGenerationValid: (gen, acc) => sharedGoogleAccountManager.isGenerationValid(gen, acc),
        onAuthExpired: () => sharedGoogleAccountManager.markTokenExpired(context.generation),
        perFileConservativeLimitBytes: batchAssessment.perFileConservativeLimitBytes,
        signal: downloadController.signal,
        onProgress: (p) => setDriveImportProgress(p),
        onFileDownloaded: async (file, meta, ctx) => {
          // 多首選取或受限裝置除第 1 首外採延遲解碼：先持久化至 IndexedDB，播放時才按需解碼
          const deferDecode = isConstrained ? ctx.index > 0 || ctx.total > 1 : ctx.index > 0;
          await importSingleSongCore(file, {
            deferDecode,
            source: {
              provider: "google_drive",
              fileId: meta.pickedFileId,
              authorizedAccountId: context.accountId,
              fileName: meta.name,
              mimeType: meta.mimeType,
              sizeBytes: file.size,
              modifiedTime: meta.modifiedTime,
              resourceKey: meta.resourceKey,
              targetResourceKey: meta.targetResourceKey,
              driveId: meta.driveId,
              webViewLink: meta.webViewLink,
            },
          });
        },
      });

      const allFailures = [...inspected.failedFiles, ...result.failures];
      if (allFailures.length > 0) {
        const failureSummary = allFailures
          .map((item) => `「${item.fileName}」：${item.reason}`)
          .join("；");
        setUploadError(
          result.importedCount > 0
            ? `已成功匯入 ${result.importedCount} 首歌曲；另有 ${allFailures.length} 首無法載入（${failureSummary}）。`
            : failureSummary,
        );
      } else if (result.cancelled) {
        showShortcutHint(
          result.importedCount > 0
            ? `已取消剩餘下載（已成功保存 ${result.importedCount} 首歌曲）。`
            : "已取消 Google Drive 音檔下載。",
        );
      } else if (result.importedCount > 0) {
        showShortcutHint(`已從 Google Drive 逐首匯入並保存 ${result.importedCount} 首歌曲。`);
      }
    } finally {
      driveImportAbortRef.current = null;
      setDriveImportProgress(null);
    }
  };

  const handleRestoreOriginalFromDrive = async (song: BandSong) => {
    const driveSource = song.source?.provider === "google_drive" ? song.source : null;
    const backupRef = song.originalBackup?.driveFileId ? song.originalBackup : null;
    if (!driveSource && !backupRef) return;
    if (isFocusLocked()) {
      showCardFeedback(song.id, "分離專注模式啟動中，暫時無法從 Drive 恢復原曲。");
      return;
    }

    let token = sharedGoogleAccountManager.getValidAccessToken();
    let authSnap = sharedGoogleAccountManager.getSnapshot();
    if (!token || !authSnap.account) {
      try {
        authSnap = await sharedGoogleAccountManager.signIn();
        token = sharedGoogleAccountManager.getValidAccessToken();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "尚未登入 Google 帳號。";
        if (!/已取消/.test(msg)) showCardFeedback(song.id, msg);
        return;
      }
    }
    if (!token || !authSnap.account) return;
    const expectedAccountId = driveSource?.authorizedAccountId ?? backupRef?.ownerAccountId;
    if (expectedAccountId && authSnap.account.accountId !== expectedAccountId) {
      showCardFeedback(
        song.id,
        "目前登入的 Google 帳號與原曲授權帳號不同，請切換回原帳號或手動重新選取音檔。",
      );
      return;
    }

    setRestoringOriginalIds((prev) => new Set(prev).add(song.id));
    try {
      const verifiedMeta = await resolveDriveFileForDownload(
        {
          id: driveSource?.fileId ?? backupRef!.driveFileId,
          name: driveSource?.fileName ?? backupRef!.fileName,
          mimeType: driveSource?.mimeType ?? backupRef!.mimeType,
          sizeBytes: driveSource?.sizeBytes ?? backupRef!.sizeBytes,
          resourceKey: driveSource?.resourceKey,
          driveId: driveSource?.driveId,
          modifiedTime: driveSource?.modifiedTime ?? backupRef?.backedUpAt,
        },
        { accessToken: token },
      );
      const { file } = await downloadDriveFileBlob(verifiedMeta, {
        accessToken: token,
        onProgress: (loaded, total) => {
          const pct = total ? ` ${Math.round((loaded / total) * 100)}%` : "";
          patchSongMetadataOnly(song.id, {
            persistenceStatus: "restoring",
            persistenceMessage: `正在從 Google Drive 恢復原曲${pct}…`,
          });
        },
      });
      const newHash = await hashSourceAudio(file);
      const hashChanged = Boolean(song.sourceAudioHash && newHash !== song.sourceAudioHash);

      const engine = getEngine();
      const durationSec = await engine.loadTrack(song.sourceAudioId, file, "soundtouch");
      sourceFilesRef.current.set(song.id, file);
      registerTransientSongAudio(song.id, {
        blob: file,
        name: song.name,
        fileName: file.name,
        mimeType: file.type,
        durationSec,
        sourceAudioHash: newHash,
      });

      let updatedSong: BandSong = {
        ...song,
        fileName: file.name,
        fileSizeBytes: file.size,
        mimeType: file.type,
        fileLastModified: file.lastModified,
        durationSec,
        sourceAudioHash: newHash,
        sourceAudioMissing: false,
        audioLoadState: "ready",
        availabilityState: song.stemIds.length > 0 ? "stems_loaded" : "local_playable",
        persistenceStatus: "saving",
        persistenceMessage: "正在保存恢復的原曲…",
        source: driveSource
          ? {
              ...driveSource,
              fileId: verifiedMeta.pickedFileId,
              resourceKey: verifiedMeta.resourceKey,
              targetResourceKey: verifiedMeta.targetResourceKey,
              modifiedTime: verifiedMeta.modifiedTime,
              sourceAudioHash: newHash,
            }
          : song.source,
      };

      if (hashChanged) {
        // 原曲在雲端已被修改：絕不誤用舊版 Demucs 分軌
        song.stemIds.forEach((id) => engine.removeTrack(id));
        stemResultsRef.current.delete(song.id);
        updatedSong = {
          ...updatedSong,
          stemIds: [],
          stemChannels: [],
          playbackSource: "original",
          separationStatus: "not_started",
          separationTaskId: null,
          cacheKey: null,
          importedStemOrigin: null,
          separationMessage: "偵測到 Google Drive 原曲已變更，已解除舊版分軌連結以免錯配。",
        };
      }

      engine.seekTracks([updatedSong.sourceAudioId, ...updatedSong.stemIds], updatedSong.playheadSec);
      applySongToEngine(updatedSong);
      sessionRef.current = {
        ...sessionRef.current,
        songs: sessionRef.current.songs.map((item) => (item.id === song.id ? updatedSong : item)),
      };
      setSession((prev) => ({
        ...prev,
        songs: prev.songs.map((item) => (item.id === song.id ? updatedSong : item)),
      }));
      await persistNewOrRelinkedSong(updatedSong, file, newHash, true);
      showCardFeedback(
        song.id,
        hashChanged
          ? "已從 Drive 恢復原曲（原曲內容已變更，請重新分離音軌）。"
          : "已從 Google Drive 恢復原曲並驗證內容一致。",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "無法從 Google Drive 恢復原曲。";
      showCardFeedback(song.id, msg);
      patchSongMetadataOnly(song.id, {
        persistenceStatus: song.stemIds.length > 0 ? "saved" : "missing_audio",
        persistenceMessage: msg,
      });
    } finally {
      setRestoringOriginalIds((prev) => {
        const next = new Set(prev);
        next.delete(song.id);
        return next;
      });
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

  const playSong = async (song: BandSong): Promise<{ started: boolean; reason?: string }> => {
    if (isFocusLocked()) {
      const msg = "目前處於分離專注模式，已暫停音訊處理並鎖定啟動播放；請待分離完成或點擊「中止分離」。";
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return { started: false, reason: "分離專注模式啟動中" };
    }
    const activeProjForPlay = activeProjectRecordRef.current;
    const isOnDemandCandidate = Boolean(
      activeProjForPlay &&
      (song.availabilityState === "cloud_not_downloaded" || song.availabilityState === "needs_reauth"),
    );
    if (!isOnDemandCandidate && (song.persistenceStatus === "missing_audio" || song.persistenceStatus === "restoring")) {
      const msg = song.persistenceStatus === "restoring"
        ? "正在恢復音檔，請稍候再播放。"
        : "此歌曲缺少本機原始音檔，請先重新選取音檔。";
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
      showShortcutHint(msg);
      return {
        started: false,
        reason: song.persistenceStatus === "restoring" ? "正在恢復音檔" : "缺少本機原始音檔",
      };
    }
    if (startingSongIdsRef.current.has(song.id)) {
      return { started: false, reason: "正在啟動播放中" };
    }
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
      let songForReady = song;
      if (activeProjForPlay) {
        const entry = activeProjForPlay.project.songs.find(
          (item) => item.entryId === (song.projectEntryId ?? song.id),
        );
        const needsCloudRestore = Boolean(
          entry &&
          (song.availabilityState === "cloud_not_downloaded" ||
            song.availabilityState === "needs_reauth" ||
            (song.playbackSource === "stems" &&
              entry.artifactRef?.manifestFileId &&
              song.stemIds.length === 0 &&
              !song.separationUsesChunkPlayback) ||
            (song.sourceAudioMissing &&
              (entry.originalBackup?.driveFileId ||
                (entry.source.provider === "google_drive" && entry.source.fileId)))),
        );
        if (entry && needsCloudRestore) {
          const authSnap = sharedGoogleAccountManager.getSnapshot();
          const validToken = sharedGoogleAccountManager.getValidAccessToken();
          const hasCloudRef = Boolean(
            entry.artifactRef?.manifestFileId ||
              entry.originalBackup?.driveFileId ||
              (entry.source.provider === "google_drive" && entry.source.fileId),
          );
          if (hasCloudRef && (!authSnap.account || !validToken)) {
            patchSongMetadataOnly(song.id, {
              availabilityState: "needs_reauth",
              persistenceMessage: "需先登入或重新授權 Google 帳號才能按需下載此曲。",
            });
            const msg = "此歌曲尚未下載至本機，請先重新授權 Google 帳號後再點擊播放。";
            setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
            showShortcutHint(msg);
            return { started: false, reason: "需要重新授權 Google 帳號" };
          }
          setRestoringOnDemandBySongId((prev) => ({
            ...prev,
            [song.id]: "正在檢查本機並按需恢復雲端歌曲…",
          }));
          patchSongMetadataOnly(song.id, { availabilityState: "downloading" });
          try {
            const cap = await collectDeviceCapabilities();
            const restored = await restoreSingleProjectSongOnDemand({
              project: activeProjForPlay.project,
              entry,
              accountId: authSnap.account?.accountId ?? null,
              accessToken: validToken,
              generation: authSnap.generation,
              isGenerationValid: (g, a) => sharedGoogleAccountManager.isGenerationValid(g, a),
              includeOriginalAudio:
                song.playbackSource === "original" ||
                Boolean(
                  entry.originalBackup?.driveFileId ||
                    (entry.source.provider === "google_drive" && entry.source.fileId),
                ),
              capabilities: cap,
              onProgress: (prog) => {
                setRestoringOnDemandBySongId((prev) => ({
                  ...prev,
                  [song.id]: prog.message,
                }));
              },
            });
            if (activeProjectIdRef.current !== activeProjForPlay.projectId) {
              return { started: false, reason: "已切換專案" };
            }
            const updatedSong = {
              ...song,
              ...restored.song,
              id: song.id,
              sourceAudioId: song.sourceAudioId,
            };
            sessionRef.current = {
              ...sessionRef.current,
              songs: sessionRef.current.songs.map((item) =>
                item.id === song.id ? updatedSong : item,
              ),
            };
            setSession((prev) => ({
              ...prev,
              songs: prev.songs.map((item) => (item.id === song.id ? updatedSong : item)),
            }));
            songForReady = updatedSong;
            if (
              (restored.importedStemRecord || restored.checkpointTaskId) &&
              entry.artifactRef
            ) {
              const totalSamples =
                restored.importedStemRecord?.totalSamples ?? entry.artifactRef.totalSamples;
              const sampleRate =
                restored.importedStemRecord?.sampleRate ?? entry.artifactRef.sampleRate;
              const totalChunks =
                restored.importedStemRecord?.totalChunks ?? updatedSong.separationTotalChunks ?? 1;
              songForReady = await installChunkedStemSet(
                updatedSong,
                {
                  taskId: restored.importedStemRecord?.importId ?? restored.checkpointTaskId!,
                  mode: entry.artifactRef.separationMode,
                  sampleRate,
                  totalSamples,
                  totalChunks,
                  committedBytes:
                    restored.importedStemRecord?.committedBytes ??
                    updatedSong.separationCommittedBytes ??
                    0,
                  durationSeconds: totalSamples / sampleRate,
                },
                updatedSong.cacheKey ?? "",
                restored.reusedLocal
                  ? "已重用相容本機分軌，準備播放。"
                  : "已完成單曲按需恢復，準備播放。",
                {
                  preferredSource: entry.settings.playbackSource,
                  skipPersist: true,
                  stemLayout: restored.importedStemRecord?.stemLayout ?? "four_stem",
                  isImportedStem: Boolean(restored.importedStemRecord),
                },
              );
            }
            if (restored.originalAudioWarning) {
              showCardFeedback(song.id, restored.originalAudioWarning);
            }
          } finally {
            setRestoringOnDemandBySongId((prev) => {
              if (!(song.id in prev)) return prev;
              const next = { ...prev };
              delete next[song.id];
              return next;
            });
          }
        }
      }
      const ready = await ensureSongAudioReady(songForReady);
      if (!ready) {
        const failedMsg = sessionRef.current.songs.find((item) => item.id === song.id)?.persistenceMessage;
        return { started: false, reason: failedMsg || "音訊尚未就緒" };
      }
      if (isFocusLocked()) {
        const msg = "分離專注模式已啟動，取消本次播放。";
        setPlaybackErrors((previous) => ({ ...previous, [song.id]: msg }));
        showCardFeedback(song.id, msg);
        return { started: false, reason: "分離專注模式已啟動" };
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
          return { started: false, reason: admission.message };
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
          return { started: false, reason: admission.message };
        }

        const decision = await requestGuardConfirmation({
          title: `多軌播放負載過高：「${latestSong.name}」`,
          subtitle: `目前 ${profileEval.profile.tier} 配置建議 SoundTouch 上限為 ${profileEval.profile.maxActiveSoundTouchTracks} 軌，需先套用降載後才允許播放。`,
          assessment: playbackAssessment,
        });
        if (!decision) {
          setPlaybackErrors((previous) => ({ ...previous, [latestSong.id]: admission.message }));
          return { started: false, reason: "已取消高負載確認" };
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
          return { started: false, reason: admission.message };
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
          return { started: true };
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
          return { started: true };
        }
      }

      updateSong(preparedSong.id, { status: "playing" });
      return { started: true };
    } catch (error) {
      const errorMsg = describePlaybackError(error);
      setPlaybackErrors((previous) => ({ ...previous, [song.id]: errorMsg }));
      showShortcutHint(errorMsg);
      return { started: false, reason: errorMsg };
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
      const nextSongs = sessionRef.current.songs.map((candidate) => (
        candidate.id === result.changedSong!.id ? result.changedSong! : candidate
      ));
      sessionRef.current = { ...sessionRef.current, songs: nextSongs };
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (
          candidate.id === result.changedSong!.id ? result.changedSong! : candidate
        )),
      }));
      persistSongDebounced(result.changedSong.id);
      showCardFeedback(result.changedSong.id, result.message);
      if (
        targetSelection.stemId &&
        result.changedSong.playbackSource === "original" &&
        result.changedSong.stemIds.length > 0
      ) {
        void switchSourceRef.current?.(result.changedSong, "stems", {
          autoReason: "已自動切換為分軌混音",
        });
      }
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
      const nextSongsSolo = sessionRef.current.songs.map((candidate) => (
        candidate.id === result.changedSong!.id ? result.changedSong! : candidate
      ));
      sessionRef.current = { ...sessionRef.current, songs: nextSongsSolo };
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (
          candidate.id === result.changedSong!.id ? result.changedSong! : candidate
        )),
      }));
      persistSongDebounced(result.changedSong.id);
      showCardFeedback(result.changedSong.id, result.message);
      if (
        result.changedSong.playbackSource === "original" &&
        result.changedSong.stemIds.length > 0
      ) {
        void switchSourceRef.current?.(result.changedSong, "stems", {
          autoReason: "已自動切換為分軌混音",
        });
      }
    } else if (targetSelection.songId) {
      showCardFeedback(targetSelection.songId, result.message);
    }
    showShortcutHint(result.message);
  }, [applySongAudioPatch, applySongToEngine, isFocusLocked, persistSongDebounced, showCardFeedback, showShortcutHint]);

  const switchSource = async (
    song: BandSong,
    playbackSource: "original" | "stems",
    options?: { autoReason?: string },
  ) => {
    if (isFocusLocked()) {
      const msg = "分離專注模式啟動中，已鎖定切換播放來源。";
      showCardFeedback(song.id, msg);
      showShortcutHint(msg);
      return;
    }
    if (switchingSourceSongIdsRef.current.has(song.id)) return;
    const initialSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
    if (
      initialSong.playbackSource === playbackSource ||
      (playbackSource === "stems" && initialSong.stemIds.length === 0)
    ) {
      return;
    }
    switchingSourceSongIdsRef.current.add(song.id);
    try {
      const engine = getEngine();
      let currentSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? initialSong;
      if (playbackSource === "stems") {
        const stemsMissing =
          currentSong.stemIds.length === 0 ||
          currentSong.stemIds.some((id) => !engine.hasTrack(id)) ||
          (currentSong.separationUsesChunkPlayback && !engine.hasHealthyStemMixBus(currentSong.id));
        if (stemsMissing) {
          await ensureStemsInstalledForReadySong(currentSong, currentSong.playbackSource);
          currentSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? currentSong;
        }
        const stemsReady =
          currentSong.stemIds.length > 0 &&
          currentSong.stemIds.every((id) => engine.hasTrack(id)) &&
          (!currentSong.separationUsesChunkPlayback || engine.hasHealthyStemMixBus(currentSong.id));
        if (!stemsReady) {
          const msg = "目前找不到可播放的本機分軌資料，暫維持原始混音（請重新分離或從雲端恢復分軌）。";
          showCardFeedback(song.id, msg);
          showShortcutHint(msg);
          return;
        }
      } else {
        if (currentSong.sourceAudioMissing) {
          const msg = "缺少原始音檔，無法切回原始混音。";
          showCardFeedback(song.id, msg);
          showShortcutHint(msg);
          return;
        }
        if (!engine.hasTrack(currentSong.sourceAudioId)) {
          const ready = await ensureSongAudioReady(currentSong);
          if (!ready) return;
          currentSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? currentSong;
        }
      }

      if (currentSong.playbackSource === playbackSource) return;
      const oldIds = getSongPlaybackTrackIds(currentSong);
      const livePos =
        currentSong.status === "playing" && oldIds[0]
          ? engine.getTrackPosition(oldIds[0])
          : currentSong.playheadSec;

      if (currentSong.status === "playing") {
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

      // 再讀一次最新分軌音量/靜音設定，避免非同步準備期間的調整被覆寫
      const latestBeforeCommit = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? currentSong;
      const committedSong: BandSong = {
        ...latestBeforeCommit,
        playbackSource,
      };
      const committedNewIds = getSongPlaybackTrackIds(committedSong);
      engine.seekTracks(committedNewIds, livePos);
      applySongToEngine(committedSong);
      if (committedSong.status === "playing") {
        await engine.playTracks(committedNewIds);
        engine.crossfadeTracks(oldIds, committedNewIds);
      }
      sessionRef.current = {
        ...sessionRef.current,
        songs: sessionRef.current.songs.map((candidate) => (candidate.id === song.id ? committedSong : candidate)),
      };
      setSession((previous) => ({
        ...previous,
        songs: previous.songs.map((candidate) => (candidate.id === song.id ? committedSong : candidate)),
      }));
      if (playbackSource === "original") {
        setSelection((previous) => (
          previous.songId === song.id && previous.stemId
            ? { songId: song.id, stemId: null }
            : previous
        ));
      }
      if (options?.autoReason) {
        showCardFeedback(song.id, options.autoReason);
        showShortcutHint(options.autoReason);
      }
      persistSongDebounced(song.id, 150);
    } finally {
      switchingSourceSongIdsRef.current.delete(song.id);
    }
  };
  switchSourceRef.current = switchSource;

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
      if (isTaskPinnedByDriveTransfer(taskId)) {
        const reason = "此分軌正由 Google Drive 上傳讀取中，為保護分段完整性已暫時阻擋刪除。";
        showCardFeedback(latestSong.id, reason);
        return { status: "blocked", reason };
      }
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
      artifactRef: null,
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

    if (latestSong.importedStemOrigin?.importId) {
      await releaseImportedStemReferenceAndMaybeGc({
        importId: latestSong.importedStemOrigin.importId,
        songId: latestSong.id,
        knownInMemorySongs: nextSongsSnapshot,
      }).catch(() => undefined);
    }

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

    sessionRef.current = {
      ...sessionRef.current,
      songs: sessionRef.current.songs.map((item) => (item.id === latestSong.id ? clearedSong : item)),
    };
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((item) => (item.id === latestSong.id ? clearedSong : item)),
    }));
    applySongToEngine(clearedSong);
    if (activeProjectRecordRef.current) {
      scheduleActiveProjectSave(nextSongsSnapshot, { immediateLocal: true });
    } else if (clearedSong.sourceAudioHash && clearedSong.persistenceStatus !== "missing_audio") {
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
      projectId: activeProjectIdRef.current,
      entryId: song.projectEntryId ?? song.id,
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
    const nextSongs = sessionRef.current.songs.map((candidate) => {
      if (candidate.id !== song.id) return candidate;
      const next: BandSong = {
        ...candidate,
        stemChannels: candidate.stemChannels.map((channel) => (
          channel.id === stemId ? { ...channel, ...patch } : channel
        )),
      };
      applySongAudioPatch(candidate, next);
      shouldPersist = Boolean(activeProjectRecordRef.current || next.sourceAudioHash);
      return next;
    });
    sessionRef.current = { ...sessionRef.current, songs: nextSongs };
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((candidate) => {
        if (candidate.id !== song.id) return candidate;
        return nextSongs.find((n) => n.id === song.id) ?? candidate;
      }),
    }));
    const updatedSong = nextSongs.find((n) => n.id === song.id);
    if (updatedSong && updatedSong.playbackSource === "original" && updatedSong.stemIds.length > 0) {
      void switchSourceRef.current?.(updatedSong, "stems", {
        autoReason: "已自動切換為分軌混音",
      });
    }
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
      let sharedWithOtherSongs = false;
      if (activeProjectRecordRef.current) {
        const activeProjId = activeProjectRecordRef.current.projectId;
        const nextEntrySongs = remainingSongs;
        scheduleActiveProjectSave(nextEntrySongs, { immediateLocal: true });
        await autoSyncControllerRef.current?.flushLocalSaves();
        if (deleteLocalData && song.sourceAudioHash) {
          const refCheck = await isAudioHashReferencedAcrossWorkspace(song.sourceAudioHash, {
            excludeProjectId: activeProjId,
          }).catch(() => ({ referenced: true, referencingProjectIds: [], referencedByLegacySession: true }));
          const usedInCurrentProject = nextEntrySongs.some((s) => s.sourceAudioHash === song.sourceAudioHash);
          sharedWithOtherSongs = refCheck.referenced || usedInCurrentProject;
          if (!sharedWithOtherSongs) {
            await releaseCheckpointReferenceAndMaybeGc({
              taskId: song.separationTaskId ?? null,
              sourceAudioHash: song.sourceAudioHash,
              songId: song.id,
              cacheKeyToRelease: song.cacheKey ?? null,
              knownInMemorySongs: nextEntrySongs,
              knownRemovedSongIds: removedSongIdsRef.current,
              source: "BandMixer.removeProjectSong",
            }).catch(() => undefined);
            if (song.importedStemOrigin?.importId) {
              await releaseImportedStemReferenceAndMaybeGc({
                importId: song.importedStemOrigin.importId,
                songId: song.id,
                knownInMemorySongs: nextEntrySongs,
              }).catch(() => undefined);
            }
            if (song.cacheKey) {
              await deleteCachedStemSet(song.cacheKey).catch(() => undefined);
            }
          }
        }
      } else {
        const result = await removePersistedSong({
          song,
          deleteLocalData,
          inMemoryRemainingSongs: remainingSongs,
        });
        sharedWithOtherSongs = result.sharedWithOtherSongs;
      }

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
      sessionRef.current = { ...sessionRef.current, songs: remainingSongs };
      setSession((previous) => ({ ...previous, songs: previous.songs.filter((candidate) => candidate.id !== song.id) }));
      setSelection((previous) => sanitizeMixerSelection(previous, remainingSongs));

      if (deleteLocalData && sharedWithOtherSongs) {
        showShortcutHint(`已移除「${song.name}」；另有其他歌曲或專案共用此音檔，已保留共用資料。`);
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
        "已上傳保存至 Google Drive .loopHarmonizer 的雲端成果（絕不連帶刪除）",
        "BPM、Key、播放倍率與歌曲其他設定",
        "若有其他歌曲共用同一分軌資源或持有分頁鎖定，底層共用資料將自動保留",
      ],
      recoverability: "不可恢復；若需再次分離須重新執行分軌。刪除前會再次確認分頁鎖定與共用引用。",
      confirmLabel: "確認刪除分軌",
      danger: true,
      onExecute: async () => clearSongSeparationData(latestSong, "completed"),
    });
  };

  const openDriveExportForSong = (song: BandSong) => {
    setDriveExportError(null);
    setDriveExportNeedsReauth(false);
    setDriveExportModalSongId(song.id);
  };

  const startDriveExport = async (selectionInput: DriveExportSelection) => {
    const targetSong = driveExportModalSongId
      ? sessionRef.current.songs.find((item) => item.id === driveExportModalSongId)
      : null;
    if (!targetSong) return;

    lastDriveExportSelectionRef.current = selectionInput;
    setDriveExportError(null);
    setDriveExportNeedsReauth(false);

    let token = sharedGoogleAccountManager.getValidAccessToken();
    let snap = sharedGoogleAccountManager.getSnapshot();
    if (!token || !snap.account) {
      try {
        snap = await sharedGoogleAccountManager.signIn();
        token = sharedGoogleAccountManager.getValidAccessToken();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "尚未完成 Google 授權。";
        if (!/已取消/.test(msg)) setDriveExportError(msg);
        return;
      }
    }
    if (!token || !snap.account) {
      setDriveExportError("尚未取得有效 Google 帳號授權，無法輸出。");
      return;
    }

    const controller = new AbortController();
    driveExportAbortRef.current = controller;
    driveExportPauseRequestedRef.current = false;
    setDriveExportSubmitting(true);

    try {
      const cap = await collectDeviceCapabilities();
      const profileEval = sharedResourceProfileManager.evaluate(cap, sharedPerfTelemetry.getSignals());
      const isConstrained =
        profileEval.profile.tier === "constrained" ||
        profileEval.profile.formFactorHint === "mobile" ||
        profileEval.profile.formFactorHint === "tablet";

      const result = await exportSongArtifactsToDrive({
        song: targetSong,
        accountId: snap.account.accountId,
        accessToken: token,
        generation: snap.generation,
        isGenerationValid: (gen, acc) => sharedGoogleAccountManager.isGenerationValid(gen, acc),
        selection: selectionInput,
        inMemoryStems: stemResultsRef.current.get(targetSong.id) ?? null,
        isConstrainedDevice: isConstrained,
        isFocusActive: () => isFocusLocked(),
        isPauseRequested: () => driveExportPauseRequestedRef.current,
        onAuthExpired: () => {
          sharedGoogleAccountManager.markTokenExpired(snap.generation);
          setDriveExportNeedsReauth(true);
        },
        signal: controller.signal,
        onProgress: (progress) => {
          setDriveExportProgressBySongId((prev) => ({
            ...prev,
            [targetSong.id]: progress,
          }));
        },
      });

      if (result.status === "completed") {
        if (result.manifestFileId && result.manifest) {
          const nextDriveExport = {
            ownerAccountId: snap.account.accountId,
            revisionId: result.revisionId,
            manifestFileId: result.manifestFileId,
            sessionFileId: result.sessionFileId,
            folderId: result.folderId ?? "",
            format: selectionInput.format,
            exportedAt: Date.now(),
          };
          const artifactChecksums: Record<string, string> = {};
          for (const [role, desc] of Object.entries(result.manifest.artifacts)) {
            if (desc?.checksum) artifactChecksums[role] = desc.checksum;
          }
          const nextArtifactRef = {
            manifestFileId: result.manifestFileId,
            revisionId: result.revisionId,
            sourceAudioHash: result.manifest.source.sourceAudioHash || targetSong.sourceAudioHash || "",
            separationMode: result.manifest.separation.mode,
            modelVersion: result.manifest.separation.modelVersion,
            processingVersion: result.manifest.separation.processingVersion,
            sampleRate: result.manifest.separation.sampleRate,
            channelCount: 2 as const,
            totalSamples: result.manifest.separation.totalSamples,
            pcmFormat: result.manifest.separation.format,
            artifactChecksums: Object.keys(artifactChecksums).length > 0 ? artifactChecksums : undefined,
            derivedFrom: result.manifest.separation.derivedFrom ?? null,
            localTaskId: targetSong.separationTaskId ?? null,
            localSourceType: targetSong.importedStemOrigin
              ? ("imported_stem" as const)
              : targetSong.separationTaskId
                ? ("demucs_checkpoint" as const)
                : null,
          };
          const nextBackupStatus = computeEntryBackupStatus(
            {
              source: targetSong.source ?? { provider: "local" },
              originalBackup: targetSong.originalBackup ?? null,
              artifactRef: nextArtifactRef,
              settings: {
                displayName: targetSong.name,
                fileName: targetSong.fileName,
                originalBpm: targetSong.originalBpm,
                targetBpm: targetSong.targetBpm,
                tempoMode: targetSong.tempoMode,
                manualRate: targetSong.manualRate,
                fineRateOffset: targetSong.fineRateOffset,
                savedRates: targetSong.savedRates,
                keyShiftSemitones: targetSong.keyShiftSemitones,
                masterVolume: targetSong.masterVolume,
                muted: Boolean(targetSong.muted),
                loop: targetSong.loop,
                playbackSource: targetSong.playbackSource,
                separationMode: targetSong.separationMode,
                stemChannels: [],
              },
            },
            snap.account.accountId,
          );
          updateSong(
            targetSong.id,
            {
              driveExport: nextDriveExport,
              artifactRef: nextArtifactRef,
              ...(activeProjectRecordRef.current ? { backupStatus: nextBackupStatus } : {}),
            },
            { persistDelayMs: 50 },
          );
        }
        showCardFeedback(targetSong.id, "已將分軌與設定成功儲存至 Google Drive。");
        setDriveExportModalSongId(null);
      } else if (result.status === "waiting_auth") {
        setDriveExportNeedsReauth(true);
        setDriveExportError(result.errorMessage ?? "Google 授權已過期，請重新授權後接續上傳。");
      } else if (result.status === "paused") {
        setDriveExportError("已暫停上傳，您可隨時重新點擊確認從伺服端進度續傳。");
      } else if (result.status === "cancelled") {
        setDriveExportError("已取消 Google Drive 上傳。");
      } else {
        setDriveExportError(result.errorMessage ?? "上傳至 Google Drive 失敗。");
      }
    } finally {
      driveExportAbortRef.current = null;
      driveExportPauseRequestedRef.current = false;
      setDriveExportSubmitting(false);
      setDriveExportProgressBySongId((prev) => {
        if (!(targetSong.id in prev)) return prev;
        const next = { ...prev };
        delete next[targetSong.id];
        return next;
      });
    }
  };

  const pauseDriveExport = () => {
    driveExportPauseRequestedRef.current = true;
    driveExportAbortRef.current?.abort();
  };

  const cancelDriveExport = () => {
    driveExportPauseRequestedRef.current = false;
    driveExportAbortRef.current?.abort();
  };

  const reauthorizeAndResumeDriveExport = async () => {
    try {
      await sharedGoogleAccountManager.reauthorize();
      setDriveExportNeedsReauth(false);
      setDriveExportError(null);
      if (lastDriveExportSelectionRef.current) {
        await startDriveExport(lastDriveExportSelectionRef.current);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "重新授權失敗。";
      if (!/已取消/.test(msg)) setDriveExportError(msg);
    }
  };

  const refreshDriveLibrary = useCallback(async () => {
    let token = sharedGoogleAccountManager.getValidAccessToken();
    let snap = sharedGoogleAccountManager.getSnapshot();
    if (!token || !snap.account) {
      try {
        snap = await sharedGoogleAccountManager.signIn();
        token = sharedGoogleAccountManager.getValidAccessToken();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "尚未登入 Google 帳號。";
        if (!/已取消/.test(msg)) setDriveLibraryError(msg);
        return;
      }
    }
    if (!token || !snap.account) return;
    const targetAccountId = snap.account.accountId;
    const targetGeneration = snap.generation;

    setDriveLibraryLoading(true);
    setDriveLibraryError(null);
    try {
      const res = await listDriveLibraryEntries({
        accountId: targetAccountId,
        accessToken: token,
      });
      if (!sharedGoogleAccountManager.isGenerationValid(targetGeneration, targetAccountId)) {
        return;
      }
      setDriveLibraryEntries(res.entries);
      setDriveLibraryInvalidEntries(res.invalidEntries);
    } catch (err) {
      if (err instanceof Error && /過期|401/.test(err.message)) {
        sharedGoogleAccountManager.markTokenExpired(targetGeneration);
      }
      setDriveLibraryError(err instanceof Error ? err.message : "無法讀取 .loopHarmonizer 雲端成果清單。");
    } finally {
      setDriveLibraryLoading(false);
    }
  }, []);

  const openDriveLibrary = async () => {
    setDriveLibraryOpen(true);
    await refreshDriveLibrary();
  };

  const handleRestoreDriveEntry = async (
    entry: DriveLibraryEntry,
    options: { includeOriginalAudio: boolean },
  ) => {
    const snap = sharedGoogleAccountManager.getSnapshot();
    const token = sharedGoogleAccountManager.getValidAccessToken();
    if (!token || !snap.account) {
      setDriveLibraryError("Google 授權已過期或已登出，請先重新授權後再恢復。");
      return;
    }

    const controller = new AbortController();
    driveRestoreAbortRef.current = controller;
    setRestoringManifestId(entry.manifestFileId);
    setDriveLibraryError(null);
    setDriveRestoreProgress({ stage: "validating", message: "正在準備恢復雲端分軌…" });

    try {
      const cap = await collectDeviceCapabilities();
      const restored = await restoreSongFromDrive({
        entry,
        accountId: snap.account.accountId,
        accessToken: token,
        generation: snap.generation,
        isGenerationValid: (gen, acc) => sharedGoogleAccountManager.isGenerationValid(gen, acc),
        includeOriginalAudio: options.includeOriginalAudio,
        capabilities: cap,
        signal: controller.signal,
        onProgress: (p) => setDriveRestoreProgress(p),
      });

      const song = activeProjectRecordRef.current
        ? {
            ...restored.song,
            projectEntryId: restored.song.id,
            availabilityState: "stems_loaded" as const,
            backupStatus: computeEntryBackupStatus(
              {
                source: restored.song.source ?? { provider: "local" },
                originalBackup: restored.song.originalBackup ?? null,
                artifactRef: restored.song.importedStemOrigin
                  ? {
                      manifestFileId: restored.song.importedStemOrigin.manifestFileId,
                      revisionId: restored.song.importedStemOrigin.revisionId,
                      sourceAudioHash: restored.song.sourceAudioHash ?? "",
                      separationMode: restored.song.separationMode ?? "four_stem",
                      modelVersion: DEMUCS_MODEL_VERSION,
                      processingVersion: SEPARATION_PROCESSING_VERSION,
                      sampleRate: restored.importedStemRecord?.sampleRate ?? 44100,
                      channelCount: 2 as const,
                      totalSamples: restored.importedStemRecord?.totalSamples ?? Math.round(restored.song.durationSec * 44100),
                      pcmFormat: restored.song.importedStemOrigin.pcmFormat,
                    }
                  : null,
                settings: {
                  displayName: restored.song.name,
                  fileName: restored.song.fileName,
                  originalBpm: restored.song.originalBpm,
                  targetBpm: restored.song.targetBpm,
                  tempoMode: restored.song.tempoMode,
                  manualRate: restored.song.manualRate,
                  fineRateOffset: restored.song.fineRateOffset,
                  savedRates: restored.song.savedRates,
                  keyShiftSemitones: restored.song.keyShiftSemitones,
                  masterVolume: restored.song.masterVolume,
                  muted: Boolean(restored.song.muted),
                  loop: restored.song.loop,
                  playbackSource: restored.song.playbackSource,
                  separationMode: restored.song.separationMode,
                  stemChannels: [],
                },
              },
              snap.account.accountId,
            ),
          }
        : restored.song;
      if (restored.restoredOriginalAudio) {
        const audioRec = await getPersistedAudioBlobByKey(song.sourceAudioHash!).catch(() => null);
        if (audioRec?.blob) {
          const originalFile = new File([audioRec.blob], song.fileName, {
            type: song.mimeType || audioRec.mimeType || "audio/*",
            lastModified: song.fileLastModified || Date.now(),
          });
          sourceFilesRef.current.set(song.id, originalFile);
          await getEngine().loadTrack(song.sourceAudioId, originalFile, "soundtouch").catch(() => undefined);
        }
      }

      sessionRef.current = { ...sessionRef.current, songs: [...sessionRef.current.songs, song] };
      setSession((prev) => ({
        ...prev,
        songs: [...prev.songs, song],
      }));
      if (activeProjectRecordRef.current) {
        scheduleActiveProjectSave(sessionRef.current.songs, { immediateLocal: true });
      }
      setSelection((prev) => (prev.songId ? prev : { songId: song.id, stemId: null }));

      if (song.separationTaskId && song.separationTotalChunks) {
        await installChunkedStemSet(
          song,
          {
            taskId: song.separationTaskId,
            mode: song.separationMode ?? "four_stem",
            sampleRate: restored.importedStemRecord?.sampleRate ?? 44100,
            totalSamples: restored.importedStemRecord?.totalSamples ?? Math.round(song.durationSec * 44100),
            totalChunks: song.separationTotalChunks,
            committedBytes: song.separationCommittedBytes ?? 0,
            durationSeconds: song.durationSec,
          },
          song.cacheKey ?? "",
          song.separationMessage,
          {
            preferredSource: song.playbackSource,
            skipPersist: true,
            stemLayout: restored.importedStemRecord?.stemLayout ?? "four_stem",
            isImportedStem: Boolean(restored.importedStemRecord),
          },
        );
      }

      showShortcutHint(
        restored.originalAudioWarning ??
          (restored.reusedLocalStems
            ? `已恢復「${song.name}」（重用本機分軌並套用雲端設定）。`
            : `已自 Google Drive 恢復「${song.name}」並載入分軌播放。`),
      );
      void refreshCacheStats();
      setDriveLibraryOpen(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setDriveLibraryError("已取消恢復操作。");
      } else {
        setDriveLibraryError(err instanceof Error ? err.message : "恢復雲端分軌失敗。");
      }
    } finally {
      driveRestoreAbortRef.current = null;
      setRestoringManifestId(null);
      setDriveRestoreProgress(null);
    }
  };

  const requestDeleteDriveEntry = (entry: DriveLibraryEntry) => {
    openDeleteConfirmDialog({
      title: "刪除 Google Drive 雲端分軌成果",
      subtitle: `${entry.manifest.songName}（${entry.manifest.revisionId}）`,
      deleteItems: [
        `Google Drive .loopHarmonizer 內此 Revision 的分軌 WAV、session.json 與 manifest.json`,
      ],
      preserveItems: [
        "您 Google Drive 中的原始歌曲音檔（絕不刪除 Picker 選取的原曲）",
        "您本機裝置已載入或保存的歌曲、分軌快取與混音設定",
      ],
      recoverability: "雲端檔案刪除後需至 Google Drive 垃圾桶或透過本機重新上傳才能恢復。",
      confirmLabel: "確認刪除雲端成果",
      danger: true,
      onExecute: async () => {
        const snap = sharedGoogleAccountManager.getSnapshot();
        const token = sharedGoogleAccountManager.getValidAccessToken();
        if (!token || !snap.account) {
          return { status: "error", message: "Google 授權已過期，請重新登入後再試。" };
        }
        const refCheck = await checkCloudArtifactReferencesAcrossProjects({
          manifestFileId: entry.manifestFileId,
          revisionId: entry.manifest.revisionId,
          sourceAudioHash: entry.manifest.source.sourceAudioHash,
          accountId: snap.account.accountId,
          accessToken: token,
        });
        if (!refCheck.safeToDelete) {
          return {
            status: "blocked",
            reason:
              refCheck.reason ||
              `仍有雲端專案（${refCheck.referencingProjectNames.join("、")}）引用此分軌成果，為防止破壞其他專案已保護拒絕刪除。`,
          };
        }
        await deleteDriveRevisionArtifacts({
          entry,
          accountId: snap.account.accountId,
          accessToken: token,
        });
        setDriveLibraryEntries((prev) =>
          prev.filter((item) => item.manifestFileId !== entry.manifestFileId),
        );
        return { status: "success" };
      },
    });
  };

  const requestRevokeGoogleAuth = (execRevoke: () => Promise<void>) => {
    openDeleteConfirmDialog({
      title: "撤銷 Loop Harmonizer 的 Google Drive 授權",
      deleteItems: [
        "撤銷本應用程式的 Google OAuth Grant（Token 與 drive.file 權限）",
        "中止進行中的雲端匯入或上傳任務",
      ],
      preserveItems: [
        "所有已保存於本機裝置的歌曲原曲、分軌快取與混音設定（離線仍可播放）",
        "您 Google Drive .loopHarmonizer 資料夾內既有的雲端檔案",
      ],
      recoverability: "可隨時重新登入 Google 並重新授予權限。",
      confirmLabel: "確認撤銷 Google 授權",
      danger: true,
      onExecute: async () => {
        await execRevoke();
        showShortcutHint("已撤銷 Google 授權；本機歌曲與分軌完整保留。");
        return { status: "success" };
      },
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
          "已備份至 Google Drive 的雲端分軌與設定（本機刪除絕不影響雲端成果）",
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
    sessionRef.current = { ...sessionRef.current, songs: nextSongs };
    setSession((previous) => ({
      ...previous,
      songs: reorderSongList(previous.songs, fromId, toId),
    }));
    if (activeProjectRecordRef.current) {
      scheduleActiveProjectSave(nextSongs, { immediateLocal: true });
      return;
    }
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
    if (
      Boolean(projectDialogMode) ||
      Boolean(deleteDialog) ||
      Boolean(guardDialog) ||
      Boolean(driveExportModalSongId) ||
      driveLibraryOpen
    ) {
      return;
    }
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

  const teardownActiveWorkspaceRuntime = useCallback(async (options?: {
    discardPendingLocal?: boolean;
  }) => {
    manualSyncCoordinatorRef.current?.invalidate();
    const prevProjectId = activeProjectIdRef.current;
    if (prevProjectId) {
      await autoSyncControllerRef.current
        ?.invalidateProject(prevProjectId, {
          discardPendingLocal: options?.discardPendingLocal ?? true,
        })
        .catch(() => undefined);
    }
    const engine = getEngine();
    for (const s of sessionRef.current.songs) {
      const ids = [s.sourceAudioId, ...s.stemIds];
      engine.stopTracks(ids);
      ids.forEach((id) => engine.removeTrack(id));
    }
    sourceFilesRef.current.clear();
    stemResultsRef.current.clear();
    persistedMetaBySongIdRef.current.clear();
    savedSettingsRef.current.clear();
    separationTokensRef.current.clear();
    hydratedCompletedJobsRef.current.clear();
    setPlaybackErrors({});
    setCardFeedbacks({});
    setRestoringOnDemandBySongId({});
    setSelection(EMPTY_MIXER_SELECTION);
    setLocalSaveState("idle");
  }, [getEngine]);

  const flushCurrentWorkspaceBeforeSwitch = async (): Promise<
    { ok: true } | { ok: false; failures: string[]; summary: string }
  > => {
    const prevActive = activeProjectRecordRef.current;
    const prevProjectId = activeProjectIdRef.current;
    if (prevActive) {
      const probe = buildProjectFromBandSongs({
        existingProject: prevActive.project,
        songs: sessionRef.current.songs,
        incrementRevision: false,
      });
      if (!isProjectContentEqual(prevActive.project, probe)) {
        scheduleActiveProjectSave(sessionRef.current.songs);
      }
    }

    const failures: string[] = [];
    const inFlightEntries = [...inFlightAudioPersistsRef.current.entries()];
    if (inFlightEntries.length > 0) {
      try {
        const audioResults = await Promise.all(inFlightEntries.map(([, p]) => p));
        for (const r of audioResults) {
          if (!r.ok && r.failure) {
            failures.push(`音檔「${r.failure.songName}」保存失敗：${r.failure.reason}`);
          }
        }
      } catch (err) {
        failures.push(err instanceof Error ? err.message : "待保存音檔寫入 IndexedDB 失敗。");
      }
    }

    try {
      const songFlush = await flushPendingSongPersists();
      if (!songFlush.ok) {
        for (const item of songFlush.failed) {
          failures.push(`歌曲「${item.songName}」保存失敗：${item.reason}`);
        }
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : "待保存歌曲寫入 IndexedDB 失敗。");
    }

    if (autoSyncControllerRef.current) {
      try {
        const projFlush = await autoSyncControllerRef.current.flushLocalSaves(
          prevProjectId
            ? { projectId: prevProjectId, suppressStatusCallback: true }
            : { suppressStatusCallback: true },
        );
        for (const item of projFlush.failed) {
          failures.push(`專案紀錄保存失敗：${item.reason}`);
        }
      } catch (err) {
        failures.push(err instanceof Error ? err.message : "專案寫入 IndexedDB 失敗。");
      }
    }

    if (failures.length > 0) {
      if (prevProjectId) {
        setLocalSaveState("error");
        autoSyncControllerRef.current?.setProjectLocalSaveState(prevProjectId, "error");
      }
      return {
        ok: false,
        failures,
        summary: failures[0] || "寫入本機 IndexedDB 失敗，已停止切換以免資料遺失。",
      };
    }

    return { ok: true };
  };

  const promptForceSwitchAfterSaveFailure = (
    actionLabel: string,
    failures: string[],
    retryForceAction: () => Promise<void>,
  ) => {
    openDeleteConfirmDialog(
      {
        title: "目前工作區尚有未成功保存的變更",
        subtitle: `執行「${actionLabel}」前寫入本機 IndexedDB 失敗`,
        badgeLabel: "未保存變更",
        changeHeading: "以下本機變更寫入失敗，繼續切換將會遺失",
        preserveHeading: "保留的既有資料",
        deleteItems: failures,
        preserveItems: [
          "已成功寫入 IndexedDB 的既有歌曲、音檔與先前已保存專案版本",
        ],
        recoverability:
          "建議先點「留在目前工作區」並清理儲存空間後按「儲存」；僅在確認可放棄本次修改時再強制切換。",
        confirmLabel: "放棄未保存變更並繼續",
        cancelLabel: "留在目前工作區",
        danger: true,
        onExecute: async () => {
          await retryForceAction();
          return { status: "success" };
        },
      },
      false,
    );
  };

  const applyProjectWorkspaceState = useCallback((record: PersistedProjectRecord, songs: BandSong[]) => {
    activeProjectRecordRef.current = record;
    activeProjectIdRef.current = record.projectId;
    setActiveProjectRecord(record);
    setLocalSaveState("saved");
    autoSyncControllerRef.current?.setProjectLocalSaveState(record.projectId, "saved");
    sessionRef.current = { ...sessionRef.current, songs };
    setSession((prev) => ({ ...prev, songs }));
    setSelection(songs.length > 0 ? { songId: songs[0].id, stemId: null } : EMPTY_MIXER_SELECTION);
  }, []);

  const refreshProjectListEntries = useCallback(async () => {
    const seq = ++projectListLoadSeqRef.current;
    const auth = getProjectAuthContext();
    setProjectListLoading(true);
    setProjectListError(null);
    setProjectListIncompleteReason(null);
    try {
      const res = await listAllProjectsForUi({
        currentAccountId: auth.accountId,
        accessToken: auth.accessToken,
        includeCloud: Boolean(auth.accountId && auth.accessToken),
      });
      if (!mountedRef.current || seq !== projectListLoadSeqRef.current) return;
      cloudProjectsMapRef.current = res.cloudProjectsMap;
      setProjectListEntries(res.projects);
      setProjectListError(res.cloudError ?? null);
      setProjectListIncompleteReason(
        res.cloudListIncomplete
          ? res.cloudIncompleteReason || "雲端專案清單未完整讀取（僅顯示已讀取部分）"
          : null,
      );
    } catch (err) {
      if (mountedRef.current && seq === projectListLoadSeqRef.current) {
        setProjectListError(err instanceof Error ? err.message : "無法載入專案清單。");
      }
    } finally {
      if (mountedRef.current && seq === projectListLoadSeqRef.current) {
        setProjectListLoading(false);
      }
    }
  }, [getProjectAuthContext]);

  const openProjectModal = (
    mode: Exclude<ProjectDialogMode, null>,
    renameTarget?: { projectId: string; name: string } | null,
  ) => {
    setProjectDialogError(null);
    setProjectRenameTarget(renameTarget ?? null);
    setProjectDialogMode(mode);
    if (mode === "list") {
      void refreshProjectListEntries();
    }
  };

  const handleOpenProjectEntry = async (
    entry: ProjectListEntrySummary,
    options?: { forceDiscardFailed?: boolean },
  ) => {
    const gen = ++projectOpGenerationRef.current;
    setProjectDialogError(null);
    updateProjectBusyState({ action: "open", message: `正在載入專案「${entry.name}」Metadata…` });
    try {
      if (!options?.forceDiscardFailed) {
        const flush = await flushCurrentWorkspaceBeforeSwitch();
        if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
        if (!flush.ok) {
          setProjectDialogError(flush.summary);
          promptForceSwitchAfterSaveFailure(
            `開啟專案「${entry.name}」`,
            flush.failures,
            () => handleOpenProjectEntry(entry, { forceDiscardFailed: true }),
          );
          return;
        }
      }

      const auth = getProjectAuthContext();
      const cloudHint = cloudProjectsMapRef.current.get(entry.projectId);
      const res = await openProjectMetadataAndEntries({
        projectId: entry.projectId,
        cloudEntryHint: cloudHint,
        auth,
        setActive: false,
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await setActiveProjectId(res.record.projectId);
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      applyProjectWorkspaceState(res.record, res.songs);
      setProjectDialogMode(null);
      if (res.remoteAheadAvailable) {
        showShortcutHint("雲端有更新版本，請於衝突選單確認處理方式。");
      } else {
        showShortcutHint(`已開啟專案「${res.record.project.name}」（僅載入 Metadata，點擊播放再按需下載/解碼）。`);
      }
      void refreshCacheStats();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "開啟專案失敗。";
      setProjectDialogError(msg);
      showShortcutHint(msg);
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const handleCreateProjectSubmit = async (
    params: {
      name: string;
      description?: string;
      storageProvider: ProjectStorageProvider;
    },
    options?: { forceDiscardFailed?: boolean },
  ) => {
    const gen = ++projectOpGenerationRef.current;
    setProjectDialogError(null);
    updateProjectBusyState({
      action: "create",
      message: params.storageProvider === "google_drive"
        ? `正在建立 Google Drive 專案「${params.name}」…`
        : `正在建立本機專案「${params.name}」…`,
    });
    try {
      if (!options?.forceDiscardFailed) {
        const flush = await flushCurrentWorkspaceBeforeSwitch();
        if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
        if (!flush.ok) {
          setProjectDialogError(flush.summary);
          promptForceSwitchAfterSaveFailure(
            `建立專案「${params.name}」`,
            flush.failures,
            () => handleCreateProjectSubmit(params, { forceDiscardFailed: true }),
          );
          return;
        }
      }

      const auth = getProjectAuthContext();
      const { record, syncOutcome } = await createNewProject({
        name: params.name,
        description: params.description,
        storageProvider: params.storageProvider,
        auth,
        setActive: false,
        syncImmediatelyIfDrive: params.storageProvider === "google_drive",
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await setActiveProjectId(record.projectId);
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      applyProjectWorkspaceState(record, []);
      setProjectDialogMode(null);
      if (syncOutcome && syncOutcome.status !== "synced") {
        showShortcutHint(`已建立本機草稿；雲端同步狀態：${syncOutcome.status === "waiting_auth" ? "等待重新授權" : "待同步"}`);
      } else {
        showShortcutHint(`已建立新專案「${record.project.name}」。`);
      }
      void refreshProjectListEntries();
    } catch (err) {
      setProjectDialogError(err instanceof Error ? err.message : "建立專案失敗。");
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const handleSaveAsProjectSubmit = async (params: {
    name: string;
    description?: string;
    storageProvider: ProjectStorageProvider;
  }) => {
    const gen = ++projectOpGenerationRef.current;
    setProjectDialogError(null);
    updateProjectBusyState({
      action: "save_as",
      message: `正在另存為新專案「${params.name}」…`,
    });
    try {
      const songsSnapshot = sessionRef.current.songs;
      const currentProj = activeProjectRecordRef.current?.project;
      const sourceProj =
        currentProj ??
        buildProjectFromBandSongs({
          existingProject: {
            schemaVersion: 1,
            application: "loop-harmonizer",
            projectId: "legacy-snapshot",
            name: "目前工作空間",
            storageProvider: "local",
            revision: 1,
            revisionToken: "r1-legacy",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            masterSettings: {},
            songs: [],
          },
          songs: songsSnapshot,
          incrementRevision: false,
        });

      const auth = getProjectAuthContext();
      const { record } = await prepareAndSaveProjectAs({
        sourceProject: sourceProj,
        currentSongs: sessionRef.current.songs,
        name: params.name,
        description: params.description,
        storageProvider: params.storageProvider,
        auth,
        setActive: false,
        awaitInFlightAudioPersists: async () => {
          const entries = [...inFlightAudioPersistsRef.current.entries()];
          const results = await Promise.all(entries.map(([, p]) => p));
          const okSongIds: string[] = [];
          const failed: SongPersistFailure[] = [];
          for (const res of results) {
            if (res.ok) {
              okSongIds.push(res.songId);
            } else if (res.failure) {
              failed.push(res.failure);
            }
          }
          return { okSongIds, failed };
        },
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      const opened = await openProjectMetadataAndEntries({
        projectId: record.projectId,
        auth,
        setActive: false,
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await teardownActiveWorkspaceRuntime({ discardPendingLocal: false });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      await setActiveProjectId(opened.record.projectId);
      applyProjectWorkspaceState(opened.record, opened.songs);
      setProjectDialogMode(null);
      showShortcutHint(`已另存新專案「${opened.record.project.name}」（未重複複製 WAV 與分軌快取）。`);
      void refreshProjectListEntries();
    } catch (err) {
      setProjectDialogError(err instanceof Error ? err.message : "另存新專案失敗。");
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const handleRenameProjectSubmit = async (params: { projectId: string; name: string }) => {
    const gen = ++projectOpGenerationRef.current;
    setProjectDialogError(null);
    updateProjectBusyState({ action: "rename", message: "正在重新命名專案…" });
    try {
      const auth = getProjectAuthContext();
      const { record } = await renameProject({
        projectId: params.projectId,
        newName: params.name,
        auth,
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      if (activeProjectIdRef.current === record.projectId) {
        activeProjectRecordRef.current = record;
        setActiveProjectRecord(record);
      }
      setProjectDialogMode(null);
      showShortcutHint(`已將專案重新命名為「${record.project.name}」。`);
      void refreshProjectListEntries();
    } catch (err) {
      setProjectDialogError(err instanceof Error ? err.message : "重新命名失敗。");
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  /** 若畫面最新設定與目前專案內容不同，先建立最新本機 Snapshot（排入本機 Debounce 佇列）。 */
  const captureLatestProjectSnapshot = (expectedProjectId?: string) => {
    const active = activeProjectRecordRef.current;
    if (!active) return;
    if (expectedProjectId && active.projectId !== expectedProjectId) return;
    const probe = buildProjectFromBandSongs({
      existingProject: active.project,
      songs: sessionRef.current.songs,
      incrementRevision: false,
    });
    if (!isProjectContentEqual(active.project, probe)) {
      scheduleActiveProjectSave(sessionRef.current.songs);
    }
  };

  /** 儲存本機：只寫入 IndexedDB，不呼叫任何 Google Drive API；尚無正式專案時引導建立或另存新專案。 */
  const handleManualSaveProject = async () => {
    const active = activeProjectRecordRef.current;
    if (!active) {
      if (sessionRef.current.songs.length > 0) {
        openProjectModal("save_as");
      } else {
        showShortcutHint("尚未建立專案且目前無歌曲，請先載入歌曲或從「專案」建立專案。");
      }
      return;
    }
    const targetProjectId = active.projectId;
    const gen = ++projectOpGenerationRef.current;
    updateProjectBusyState({ action: "save", message: "正在儲存本機專案…" });
    setLocalSaveState("saving");
    try {
      captureLatestProjectSnapshot(targetProjectId);
      const res = await autoSyncControllerRef.current?.saveProjectLocallyNow(targetProjectId);
      if (!mountedRef.current || activeProjectIdRef.current !== targetProjectId) return;
      if (!res || !res.ok) {
        setLocalSaveState("error");
        showShortcutHint(res && !res.ok ? `儲存失敗：${res.errorMessage}` : "儲存失敗。");
        return;
      }
      const pendingNewer = autoSyncControllerRef.current?.hasPendingLocalEdits(targetProjectId) ?? false;
      setLocalSaveState(
        pendingNewer ? autoSyncControllerRef.current!.getLocalSaveState(targetProjectId) : "saved",
      );
      const saved = res.record;
      if (saved && activeProjectIdRef.current === saved.projectId) {
        applyActiveProjectRecordMonotonically(saved);
      }
      if (saved?.storageProvider === "google_drive" && saved.dirty) {
        showShortcutHint("本機已儲存 · 尚未同步（不自動寫入 Google Drive）。");
      } else if (saved?.storageProvider === "google_drive") {
        showShortcutHint("本機已儲存 · 雲端已同步。");
      } else {
        showShortcutHint(`本機已儲存（${saved?.project.name ?? active.project.name}）。`);
      }
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  if (!manualSyncCoordinatorRef.current) {
    manualSyncCoordinatorRef.current = new ProjectManualSyncCoordinator({
      getActiveProject: () => activeProjectRecordRef.current,
      getSongCount: () => sessionRef.current.songs.length,
      getHasLegacySongs: () => hasLegacyWorkspaceSongsRef.current,
      isGoogleConfigured: () => isGoogleDrivePickerConfigured(),
      getExternalBusyAction: () => {
        const busy = projectBusyStateRef.current;
        return busy && busy.action !== "sync" ? busy.action : null;
      },
      getAuthSnapshot: () => {
        const snap = sharedGoogleAccountManager.getSnapshot();
        const validToken = snap.account
          ? sharedGoogleAccountManager.getValidAccessToken(snap.account.accountId)
          : null;
        return {
          accountId: snap.account?.accountId ?? null,
          accessToken: validToken,
          generation: snap.generation,
        };
      },
      getSyncController: () => autoSyncControllerRef.current,
      signInGoogle: async () => {
        const after = await sharedGoogleAccountManager.signIn();
        const token = after.account
          ? sharedGoogleAccountManager.getValidAccessToken(after.account.accountId)
          : null;
        return {
          accountId: after.account?.accountId ?? null,
          accessToken: token,
          generation: after.generation,
        };
      },
      reauthorizeGoogle: async () => {
        const after = await sharedGoogleAccountManager.reauthorize();
        const token = after.account
          ? sharedGoogleAccountManager.getValidAccessToken(after.account.accountId)
          : null;
        return {
          accountId: after.account?.accountId ?? null,
          accessToken: token,
          generation: after.generation,
        };
      },
      captureLatestSnapshot: (projectId) => {
        const active = activeProjectRecordRef.current;
        if (!active || active.projectId !== projectId) return;
        const probe = buildProjectFromBandSongs({
          existingProject: active.project,
          songs: sessionRef.current.songs,
          incrementRevision: false,
        });
        if (!isProjectContentEqual(active.project, probe)) {
          scheduleActiveProjectSave(sessionRef.current.songs);
        }
      },
      onBusyChange: (busy) => {
        if (!mountedRef.current) return;
        updateProjectBusyState(busy);
      },
      onLocalSaveStateChange: (projectId, nextLocalState) => {
        if (!mountedRef.current || activeProjectIdRef.current !== projectId) return;
        setLocalSaveState(nextLocalState);
      },
      onFreshRecordLoaded: (record) => {
        if (!mountedRef.current || activeProjectIdRef.current !== record.projectId) return;
        applyActiveProjectRecordMonotonically(record);
      },
    });
  }

  const applyManualSyncFlowResult = async (res: ManualSyncFlowResult) => {
    if (!mountedRef.current) return;
    switch (res.kind) {
      case "ignored":
        return;
      case "no_project":
      case "unconfigured":
      case "account_mismatch":
        showShortcutHint(res.message);
        return;
      case "open_promote":
        if (res.message) showShortcutHint(res.message);
        openProjectModal("promote");
        return;
      case "open_conflict":
        if (res.record && activeProjectIdRef.current === res.record.projectId) {
          applyActiveProjectRecordMonotonically(res.record);
        }
        showShortcutHint(res.message);
        openProjectModal("conflict");
        return;
      case "auth_cancelled":
      case "auth_failed":
        if (!/已取消/.test(res.message)) {
          showShortcutHint(res.message);
        }
        return;
      case "aborted":
        if (res.message && res.reason !== "stale_operation") {
          showShortcutHint(res.message);
        }
        return;
      case "synced_outcome": {
        const { outcome, localSaveFailed, projectId } = res;
        if (!outcome) return;
        if ("record" in outcome && outcome.record && activeProjectIdRef.current === outcome.record.projectId) {
          applyActiveProjectRecordMonotonically(outcome.record);
        }
        if (outcome.status === "synced") {
          const summary = outcome.record.project.backupSummary;
          const unbacked = summary ? summary.localOnlyCount + summary.pendingSyncCount : 0;
          if (outcome.superseded || outcome.needsFollowUpSync || outcome.record.dirty) {
            showShortcutHint("本次同步完成，但仍有較新的本機修改尚未同步。");
          } else if (unbacked > 0) {
            showShortcutHint("專案設定已同步；部分歌曲成果仍僅存在本機，可由匯出對話框備份。");
          } else {
            showShortcutHint(`已同步「${outcome.record.project.name}」（v${outcome.record.localRevision}）至 Google Drive。`);
          }
        } else if (outcome.status === "remote_ahead") {
          const remoteProject = outcome.remoteProject;
          const localRecordBeforeLoad = outcome.record;
          const remoteUpdatedLabel = remoteProject.updatedAt
            ? new Date(remoteProject.updatedAt).toLocaleString("zh-TW", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "未知時間";
          openDeleteConfirmDialog(
            {
              title: "雲端有更新版本可用",
              subtitle: localRecordBeforeLoad.project.name,
              badgeLabel: "雲端新版",
              changeHeading: "版本對比與即將套用的變更",
              preserveHeading: "以下本機資料將完整保留",
              deleteItems: [
                `本機目前版本：v${localRecordBeforeLoad.localRevision}（${localRecordBeforeLoad.project.songs.length} 首歌曲，無未同步修改）`,
                `雲端最新版本：v${remoteProject.revision}（${remoteProject.songs.length} 首歌曲 · 更新於 ${remoteUpdatedLabel}）`,
                "載入後將把此專案清單與混音設定更新至雲端版本",
              ],
              preserveItems: [
                "Google Drive 與本機 IndexedDB 的原始音檔及已完成分軌快取",
                "點擊播放或切換來源時仍會保留本地已就緒的資源引用",
              ],
              recoverability: "切換前本機已與遠端基底同步，或可從 Google Drive revisions/ 目錄查閱歷史版本。",
              confirmLabel: `載入雲端版本 (v${remoteProject.revision})`,
              cancelLabel: "維持本機版本",
              danger: false,
              onCancelNotice: () => {
                showShortcutHint("雲端有較新版本，尚未載入；本機資料未被覆蓋。");
              },
              onExecute: async () => {
                const loaded = await loadRemoteAheadProject({
                  projectId,
                  remoteProject,
                  expectedLocalRevisionToken: localRecordBeforeLoad.project.revisionToken,
                });
                const nextAuth = getProjectAuthContext();
                const nextSongs = await projectToBandSongsMetadataOnly(loaded.project, {
                  currentAccountId: nextAuth.accountId,
                  hasValidGoogleToken: Boolean(nextAuth.accountId && nextAuth.accessToken),
                });
                await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
                applyProjectWorkspaceState(loaded, nextSongs);
                showShortcutHint(`已載入雲端版本（v${loaded.localRevision}）。`);
                void refreshProjectListEntries();
                return { status: "success" };
              },
            },
            false,
          );
        } else if (outcome.status === "conflict") {
          showShortcutHint("偵測到跨裝置版本衝突，請選擇衝突處理方式。");
          openProjectModal("conflict");
        } else if (outcome.status === "waiting_auth") {
          showShortcutHint("本機已儲存 · 需要登入 Google 帳號或重新授權後完成雲端同步。");
        } else if (outcome.status === "error") {
          showShortcutHint(
            localSaveFailed
              ? outcome.errorMessage
              : `本機已儲存 · 同步失敗：${outcome.errorMessage}`,
          );
        } else if (outcome.status === "cancelled") {
          showShortcutHint(outcome.reason);
        }
        return;
      }
    }
  };

  /** 使用者點擊「重新授權並同步」後，走同一套授權優先 + 重入防護同步編排流程。 */
  const handleReauthorizeAndSync = async () => {
    const coordinator = manualSyncCoordinatorRef.current;
    if (!coordinator) return;
    try {
      const res = await coordinator.requestSync();
      await applyManualSyncFlowResult(res);
    } catch (err) {
      showShortcutHint(err instanceof Error ? err.message : "Google 登入或重新授權同步失敗，本機資料已保留。");
    }
  };

  /** 同步至 Google Drive：點擊後先檢查 Sync Intent，需登入/重新授權則直接先完成授權，條件全過才執行一次手動同步。 */
  const handleSyncProjectToDrive = async (expectedProjectId?: string) => {
    const coordinator = manualSyncCoordinatorRef.current;
    if (!coordinator) return;
    try {
      const res = await coordinator.requestSync({ expectedProjectId });
      await applyManualSyncFlowResult(res);
    } catch (err) {
      showShortcutHint(err instanceof Error ? err.message : "同步失敗，本機資料已保留。");
    }
  };

  const handlePromoteToDrive = async (params: { backupLocalOriginals: boolean }) => {
    const active = activeProjectRecordRef.current;
    if (!active) return;
    const auth = getProjectAuthContext();
    if (!auth.accountId || !auth.accessToken) {
      setProjectDialogError("將專案儲存到 Google Drive 需要先登入 Google 帳號。");
      return;
    }
    const gen = ++projectOpGenerationRef.current;
    const controller = new AbortController();
    promoteAbortRef.current = controller;
    setProjectDialogError(null);
    setPromoteBackupFailures([]);
    updateProjectBusyState({ action: "promote", message: "正在準備儲存專案至 Google Drive…" });
    try {
      const res = await promoteLocalProjectToDrive({
        projectId: active.projectId,
        currentSongs: sessionRef.current.songs,
        auth,
        backupLocalOriginals: params.backupLocalOriginals,
        inMemoryFilesBySongId: sourceFilesRef.current,
        signal: controller.signal,
        onProgress: (p) => {
          setPromoteProgress(p);
          updateProjectBusyState({ action: "promote", message: p.message });
        },
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      const mappedSongs = await projectToBandSongsMetadataOnly(res.record.project, {
        currentAccountId: auth.accountId,
        hasValidGoogleToken: Boolean(auth.accountId && auth.accessToken),
      });
      const mergedSongs = sessionRef.current.songs.map((cur) => {
        const m = mappedSongs.find((x) => x.id === cur.id);
        return m ? { ...cur, backupStatus: m.backupStatus, originalBackup: m.originalBackup, artifactRef: m.artifactRef } : cur;
      });
      applyProjectWorkspaceState(res.record, mergedSongs);
      setPromoteBackupFailures(res.originalBackupFailures);
      if (res.originalBackupFailures.length === 0) {
        setProjectDialogMode(null);
        showShortcutHint(`已將專案「${res.record.project.name}」儲存至 Google Drive。`);
      }
      void refreshProjectListEntries();
    } catch (err) {
      setProjectDialogError(err instanceof Error ? err.message : "儲存至 Google Drive 失敗。");
    } finally {
      promoteAbortRef.current = null;
      setPromoteProgress(null);
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const refreshOfflineAssessment = async (
    project: BandProject,
    auth: ProjectAuthContext,
  ) => {
    if (!auth.accountId || !auth.accessToken) return;
    const seq = ++offlineAssessmentSeqRef.current;
    setOfflineAssessmentLoading(true);
    try {
      const cap = await collectDeviceCapabilities();
      const assessment = await assessProjectOfflineDownload({
        project,
        accountId: auth.accountId,
        accessToken: auth.accessToken,
        capabilities: cap,
      });
      if (mountedRef.current && seq === offlineAssessmentSeqRef.current) {
        setOfflineAssessment(assessment);
      }
    } catch (err) {
      if (mountedRef.current && seq === offlineAssessmentSeqRef.current) {
        setProjectDialogError(err instanceof Error ? err.message : "無法評估離線下載容量。");
      }
    } finally {
      if (mountedRef.current && seq === offlineAssessmentSeqRef.current) {
        setOfflineAssessmentLoading(false);
      }
    }
  };

  const handleOpenOfflineDialog = async () => {
    const active = activeProjectRecordRef.current;
    if (!active) return;
    setOfflineDownloadResult(null);
    setOfflineDownloadProgress(null);
    setOfflineAssessment(null);
    openProjectModal("offline");
    const auth = getProjectAuthContext();
    if (!auth.accountId || !auth.accessToken) {
      setProjectDialogError("下載專案供離線使用需要先登入 Google 帳號。");
      return;
    }
    await refreshOfflineAssessment(active.project, auth);
  };

  const handleStartOfflineDownload = async () => {
    const active = activeProjectRecordRef.current;
    if (!active) return;
    const auth = getProjectAuthContext();
    if (!auth.accountId || !auth.accessToken) {
      setProjectDialogError("缺少有效的 Google 帳號授權。");
      return;
    }
    const controller = new AbortController();
    offlineDownloadAbortRef.current = controller;
    setProjectDialogError(null);
    setOfflineDownloadResult(null);
    try {
      const cap = await collectDeviceCapabilities();
      const result = await downloadEntireProjectOffline({
        project: active.project,
        accountId: auth.accountId,
        accessToken: auth.accessToken,
        generation: auth.generation,
        isGenerationValid: auth.isGenerationValid,
        includeOriginalAudio: true,
        capabilities: cap,
        signal: controller.signal,
        onProgress: (p) => setOfflineDownloadProgress(p),
      });
      if (!mountedRef.current) return;
      setOfflineDownloadResult(result);
      if (activeProjectIdRef.current === active.projectId) {
        const refreshedSongs = await projectToBandSongsMetadataOnly(active.project, {
          currentAccountId: auth.accountId,
          hasValidGoogleToken: true,
        });
        const merged = sessionRef.current.songs.map((cur) => {
          const fresh = refreshedSongs.find((x) => x.id === cur.id);
          return fresh
            ? {
                ...cur,
                availabilityState: fresh.availabilityState,
                sourceAudioMissing: fresh.sourceAudioMissing,
                importedStemOrigin: fresh.importedStemOrigin,
                separationTaskId: fresh.separationTaskId,
                separationCompletedChunks: fresh.separationCompletedChunks,
                separationTotalChunks: fresh.separationTotalChunks,
                separationCommittedBytes: fresh.separationCommittedBytes,
              }
            : cur;
        });
        sessionRef.current = { ...sessionRef.current, songs: merged };
        setSession((prev) => ({ ...prev, songs: merged }));
        await refreshOfflineAssessment(active.project, auth);
      }
      void refreshCacheStats();
    } catch (err) {
      setProjectDialogError(err instanceof Error ? err.message : "離線下載失敗。");
    } finally {
      offlineDownloadAbortRef.current = null;
      setOfflineDownloadProgress(null);
    }
  };

  const executeConflictResolution = async (params: {
    strategy: "load_remote" | "save_local_as_new" | "overwrite_remote";
    newProjectNameForSaveAs?: string;
  }): Promise<{ ok: true } | { ok: false; errorMessage: string }> => {
    const active = activeProjectRecordRef.current;
    if (!active) return { ok: false, errorMessage: "目前沒有作用中的專案。" };
    const gen = ++projectOpGenerationRef.current;
    setProjectDialogError(null);
    updateProjectBusyState({ action: "conflict", message: "正在套用版本衝突處理…" });
    try {
      const auth = getProjectAuthContext();
      const res = await resolveProjectConflict({
        projectId: active.projectId,
        strategy: params.strategy,
        newProjectNameForSaveAs: params.newProjectNameForSaveAs,
        auth,
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) {
        return { ok: false, errorMessage: "操作已被新的切換取代，已中止。" };
      }
      await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
      const nextSongs = await projectToBandSongsMetadataOnly(res.activeRecord.project, {
        currentAccountId: auth.accountId,
        hasValidGoogleToken: Boolean(auth.accountId && auth.accessToken),
      });
      await setActiveProjectId(res.activeRecord.projectId);
      applyProjectWorkspaceState(res.activeRecord, nextSongs);
      setProjectDialogMode(null);
      showShortcutHint(`已完成版本衝突處理，目前專案為「${res.activeRecord.project.name}」。`);
      void refreshProjectListEntries();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "處理版本衝突失敗。";
      setProjectDialogError(msg);
      return { ok: false, errorMessage: msg };
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const handleResolveProjectConflict = (params: {
    strategy: "load_remote" | "save_local_as_new" | "overwrite_remote";
    newProjectNameForSaveAs?: string;
  }) => {
    if (params.strategy === "overwrite_remote") {
      const active = activeProjectRecordRef.current;
      openDeleteConfirmDialog({
        title: "明確確認以本機版本取代雲端專案",
        subtitle: active?.project.name,
        deleteItems: [
          "將 Google Drive 上現行 project.json 指向此裝置的本機版本（舊遠端版本仍會保留歷史 Revision 快照與衝突備份）",
        ],
        preserveItems: [
          "revisions/ 目錄下的不可變歷史與衝突快照",
          "所有 songs/ 原始音檔與分軌 WAV 成果",
        ],
        recoverability: "可從 .loopHarmonizer/projects/project_<id>/revisions/ 檢視先前遠端快照。",
        confirmLabel: "確認覆寫雲端專案",
        danger: true,
        onExecute: async () => {
          const res = await executeConflictResolution({ strategy: "overwrite_remote" });
          return res.ok ? { status: "success" } : { status: "error", message: res.errorMessage };
        },
      });
      return;
    }
    void executeConflictResolution(params);
  };

  const handleMigrateLegacyWorkspace = async () => {
    const gen = ++projectOpGenerationRef.current;
    updateProjectBusyState({ action: "migrate", message: "正在將目前工作空間另存為本機專案…" });
    try {
      const res = await migrateLegacyBandSessionToProject({
        songsOverride: activeProjectRecordRef.current ? undefined : sessionRef.current.songs,
        setActive: true,
      });
      if (gen !== projectOpGenerationRef.current || !mountedRef.current) return;
      const auth = getProjectAuthContext();
      const nextSongs = await projectToBandSongsMetadataOnly(res.record.project, {
        currentAccountId: auth.accountId,
        hasValidGoogleToken: Boolean(auth.accountId && auth.accessToken),
      });
      await teardownActiveWorkspaceRuntime({ discardPendingLocal: false });
      applyProjectWorkspaceState(res.record, nextSongs);
      setProjectDialogMode(null);
      showShortcutHint(
        res.created
          ? `已將目前工作空間另存為本機專案「${res.record.project.name}」（原始工作階段完整保留且未上傳至雲端）。`
          : `先前已建立對應專案「${res.record.project.name}」，已直接切換開啟。`,
      );
      void refreshProjectListEntries();
    } catch (err) {
      showShortcutHint(err instanceof Error ? err.message : "工作空間遷移失敗。");
    } finally {
      if (gen === projectOpGenerationRef.current && mountedRef.current) {
        updateProjectBusyState(null);
      }
    }
  };

  const requestDeleteProject = (target?: {
    projectId: string;
    name: string;
    storageProvider: ProjectStorageProvider;
  }) => {
    const resolvedTarget = target ?? (
      activeProjectRecordRef.current
        ? {
            projectId: activeProjectRecordRef.current.projectId,
            name: activeProjectRecordRef.current.project.name,
            storageProvider: activeProjectRecordRef.current.storageProvider,
          }
        : null
    );
    if (!resolvedTarget) return;

    const isCloud = resolvedTarget.storageProvider === "google_drive";
    const confirmConfig = buildDeleteProjectConfirmConfig(resolvedTarget);
    openDeleteConfirmDialog(
      {
        title: confirmConfig.title,
        subtitle: confirmConfig.subtitle,
        deleteItems: confirmConfig.deleteItems,
        preserveItems: confirmConfig.preserveItems,
        safetyNote: confirmConfig.safetyNote,
        recoverability: confirmConfig.recoverability,
        checkboxLabel: confirmConfig.checkboxLabel,
        checkboxDescription: confirmConfig.checkboxDescription,
        confirmLabel: confirmConfig.confirmLabel,
        danger: confirmConfig.danger,
        onExecute: async (alsoDeleteCloud) => {
          const auth = getProjectAuthContext();
          const scope = isCloud && alsoDeleteCloud ? "cloud_and_local" : "local_only";
          await deleteProjectSafely({
            projectId: resolvedTarget.projectId,
            scope,
            auth,
            autoSyncController: autoSyncControllerRef.current ?? undefined,
          });
          if (activeProjectIdRef.current === resolvedTarget.projectId) {
            await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
            activeProjectRecordRef.current = null;
            activeProjectIdRef.current = null;
            setActiveProjectRecord(null);
            setLocalSaveState("idle");
            setSession((prev) => ({ ...prev, songs: [] }));
            setRestoreAttempt((n) => n + 1);
          }
          void refreshProjectListEntries();
          showShortcutHint(`已刪除專案「${resolvedTarget.name}」（原始音檔與共用分軌成果已安全保留）。`);
          return { status: "success" };
        },
      },
      false,
    );
  };

  const exitProjectToLegacyWorkspace = async (options?: { forceDiscardFailed?: boolean }) => {
    if (!options?.forceDiscardFailed) {
      const flush = await flushCurrentWorkspaceBeforeSwitch();
      if (!flush.ok) {
        setProjectDialogError(flush.summary);
        promptForceSwitchAfterSaveFailure(
          "返回預設工作空間",
          flush.failures,
          () => exitProjectToLegacyWorkspace({ forceDiscardFailed: true }),
        );
        return;
      }
    }
    await teardownActiveWorkspaceRuntime({ discardPendingLocal: true });
    await setActiveProjectId(null);
    activeProjectRecordRef.current = null;
    activeProjectIdRef.current = null;
    setActiveProjectRecord(null);
    setLocalSaveState("idle");
    setProjectDialogMode(null);
    setSession((prev) => ({ ...prev, songs: [] }));
    setRestoreAttempt((n) => n + 1);
  };

  const selectedSongs = session.songs.filter((song) => song.selected);
  const hasSelectedSongs = selectedSongs.length > 0;
  const focusLocked = Boolean(separationFocus?.active) || sharedSeparationJobManager.isGlobalFocusActive();
  const focusAbortSong = separationFocus
    ? session.songs.find((song) => song.id === separationFocus.songId) ?? null
    : null;
  const playSelectedSongs = async () => {
    if (isFocusLocked()) {
      showShortcutHint("分離專注模式啟動中，已鎖定批次播放。");
      return;
    }
    const results: BatchPlayAttemptResult[] = [];
    for (let i = 0; i < selectedSongs.length; i += 1) {
      const target = selectedSongs[i];
      if (isFocusLocked()) {
        for (let j = i; j < selectedSongs.length; j += 1) {
          results.push({
            songName: selectedSongs[j].name,
            started: false,
            reason: "分離專注模式啟動中",
          });
        }
        break;
      }
      const res = await playSong(target);
      results.push({
        songName: target.name,
        started: res.started,
        reason: res.reason,
      });
    }
    showShortcutHint(formatBatchPlaySummary(results));
  };

  return (
    <div className={`grid mixer-shell${hasSelectedSongs ? " has-selected" : ""}`} style={{ gap: 16 }}>
      <ProjectToolbar
        activeProject={activeProjectRecord}
        songCount={session.songs.length}
        hasLegacySongs={hasLegacyWorkspaceSongs}
        isGoogleConfigured={isGoogleDrivePickerConfigured()}
        isGoogleSignedIn={Boolean(googleAuth.account)}
        hasValidGoogleToken={isGoogleTokenSnapshotUsable(googleAuth)}
        projectBusyState={projectBusyState}
        otherProjectJobs={otherProjectJobs}
        localSaveState={localSaveState}
        isSyncRunning={projectBusyState?.action === "sync"}
        onOpenProjectManager={() => openProjectModal("list")}
        onSaveProject={() => void handleManualSaveProject()}
        onSyncProject={() => void handleSyncProjectToDrive()}
        onOpenConflict={() => openProjectModal("conflict")}
        onReauthorizeSync={() => void handleReauthorizeAndSync()}
      />
      <div className="card row mixer-upload">
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
        <div className="mixer-upload-overflow" ref={uploadMoreRef}>
          <button
            type="button"
            className={`btn mixer-button mixer-upload-more${uploadMoreOpen ? " is-pressed" : ""}`}
            aria-label="更多載入與工具操作"
            aria-expanded={uploadMoreOpen}
            aria-haspopup="menu"
            title="更多操作"
            onClick={() => setUploadMoreOpen((open) => !open)}
          >
            ⋯
          </button>
          {uploadMoreOpen && (
            <div
              className="mixer-upload-more-menu"
              role="menu"
              aria-label="載入與工具操作"
            >
              <GoogleDrivePickerButton
                multiple
                disabled={loading || focusLocked || Boolean(driveImportProgress)}
                onMetadataPicked={(picked, ctx) => void handleDriveMetadataPicked(picked, ctx)}
                onError={(message) => showShortcutHint(message)}
              />
              {isGoogleDrivePickerConfigured() && (
                <button
                  type="button"
                  className="btn mixer-button mixer-upload-menu-action"
                  disabled={loading || focusLocked}
                  title="瀏覽並恢復 Google Drive .loopHarmonizer 雲端音樂成果"
                  onClick={() => {
                    setUploadMoreOpen(false);
                    void openDriveLibrary();
                  }}
                >
                  📚 雲端成果庫
                </button>
              )}
              <span className="mixer-upload-menu-divider" aria-hidden="true" />
              <GoogleAccountButton
                disabled={focusLocked}
                onRequestRevoke={requestRevokeGoogleAuth}
                onError={(msg) => showShortcutHint(msg)}
              />
              <button
                type="button"
                className="btn mixer-button mixer-upload-menu-action"
                onClick={() => {
                  setUploadMoreOpen(false);
                  void releaseIdleResources();
                }}
              >
                🧹 釋放閒置資源
              </button>
              <button
                type="button"
                className={`btn mixer-button mixer-upload-menu-action${showShortcuts ? " primary" : ""}`}
                aria-pressed={showShortcuts}
                onClick={() => {
                  setUploadMoreOpen(false);
                  setShowShortcuts((value) => !value);
                }}
              >
                ? 快捷鍵說明
              </button>
              <button
                type="button"
                className={`btn mixer-button mixer-upload-menu-action${showStorage ? " primary" : ""}${cacheStats.isLowStorage ? " is-danger" : ""}`}
                aria-pressed={showStorage}
                onClick={() => {
                  setUploadMoreOpen(false);
                  setShowStorage((value) => !value);
                }}
              >
                {cacheStats.isLowStorage ? "💾⚠" : "💾"} 本機儲存空間
              </button>
            </div>
          )}
        </div>
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
        {uploadStatus && (
          <span role="status" aria-live="polite" className="small" style={{ color: "#38bdf8", width: "100%" }}>
            {uploadStatus}
          </span>
        )}
        {driveImportProgress && (() => {
          const pct =
            driveImportProgress.totalBytes && driveImportProgress.totalBytes > 0
              ? Math.min(100, Math.round((driveImportProgress.loadedBytes / driveImportProgress.totalBytes) * 100))
              : null;
          const stageLabel =
            driveImportProgress.stage === "inspecting"
              ? "驗證音檔"
              : driveImportProgress.stage === "persisting"
                ? "儲存至本機"
                : "下載中";
          return (
            <div role="status" aria-live="polite" className="grid mixer-modal-section" style={{ width: "100%", gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className="mixer-spinner" aria-hidden="true" />
                  <span className="small" style={{ color: "#bae6fd" }}>
                    {`${stageLabel} (${driveImportProgress.fileIndex + 1}/${driveImportProgress.totalFiles})：${driveImportProgress.fileName}${pct !== null ? ` · ${pct}%` : ""}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn mixer-abort-button"
                  style={{ minHeight: 34, padding: "4px 10px", fontSize: 12 }}
                  onClick={() => driveImportAbortRef.current?.abort()}
                >
                  取消
                </button>
              </div>
              <div className={`mixer-progress-track${pct !== null ? "" : " is-indeterminate"}`}>
                <div className="mixer-progress-fill" style={pct !== null ? { width: `${pct}%` } : undefined} />
              </div>
            </div>
          );
        })()}
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
        <div className={`card row mixer-bulk-controls${hasSelectedSongs ? " is-selected" : ""}`} style={{ gap: 8, flexWrap: "wrap", alignItems: "center", paddingBlock: 10 }}>
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
          <button
            type="button"
            className="btn mixer-button mixer-bulk-select-all-btn"
            disabled={
              session.songs.length === 0 ||
              selectedSongs.length === session.songs.length ||
              focusLocked
            }
            title={
              focusLocked
                ? "分離專注模式啟動中"
                : selectedSongs.length === session.songs.length
                  ? "已全選所有歌曲"
                  : "全選目前清單所有歌曲"
            }
            style={{ minHeight: 40, padding: "6px 10px", fontSize: 12 }}
            onClick={() => {
              setSession((prev) => ({
                ...prev,
                songs: prev.songs.map((s) => (s.selected ? s : { ...s, selected: true })),
              }));
            }}
          >
            全選
          </button>
          <button
            type="button"
            className="btn mixer-button mixer-bulk-clear-btn"
            disabled={selectedSongs.length === 0 || focusLocked}
            title={
              focusLocked
                ? "分離專注模式啟動中"
                : selectedSongs.length === 0
                  ? "目前尚未勾選任何歌曲"
                  : "清除全部勾選狀態"
            }
            style={{ minHeight: 40, padding: "6px 10px", fontSize: 12 }}
            onClick={() => {
              setSession((prev) => ({
                ...prev,
                songs: prev.songs.map((s) => (s.selected ? { ...s, selected: false } : s)),
              }));
            }}
          >
            清除選取
          </button>
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
                isRestoringOnDemand={Boolean(restoringOnDemandBySongId[song.id])}
                onDemandRestoreMessage={restoringOnDemandBySongId[song.id] ?? null}
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
                isGoogleConfigured={isGoogleDrivePickerConfigured()}
                isDriveExportBusy={Boolean(driveExportProgressBySongId[song.id])}
                restoringOriginalFromDrive={restoringOriginalIds.has(song.id)}
                driveExportProgress={driveExportProgressBySongId[song.id] ?? null}
                onExportToDrive={() => openDriveExportForSong(song)}
                onRestoreOriginalFromDrive={() => void handleRestoreOriginalFromDrive(song)}
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
      {(() => {
        const exportTargetSong = driveExportModalSongId
          ? session.songs.find((item) => item.id === driveExportModalSongId) ?? null
          : null;
        return (
          <DriveExportDialog
            open={Boolean(exportTargetSong)}
            song={exportTargetSong}
            account={googleAuth.account}
            totalSamples={exportTargetSong ? Math.round(exportTargetSong.durationSec * 44100) : 0}
            activeProgress={exportTargetSong ? driveExportProgressBySongId[exportTargetSong.id] ?? null : null}
            submitting={driveExportSubmitting}
            errorMessage={driveExportError}
            needsReauth={driveExportNeedsReauth}
            onStartExport={(sel) => void startDriveExport(sel)}
            onPauseExport={pauseDriveExport}
            onCancelExport={cancelDriveExport}
            onReauthorizeAndResume={() => void reauthorizeAndResumeDriveExport()}
            onClose={() => {
              if (!driveExportSubmitting) {
                setDriveExportModalSongId(null);
                setDriveExportError(null);
                setDriveExportNeedsReauth(false);
              }
            }}
          />
        );
      })()}
      <DriveLibraryDialog
        open={driveLibraryOpen}
        account={googleAuth.account}
        loading={driveLibraryLoading}
        entries={driveLibraryEntries}
        invalidEntries={driveLibraryInvalidEntries}
        restoreProgress={driveRestoreProgress}
        restoringManifestId={restoringManifestId}
        errorMessage={driveLibraryError}
        onRefresh={() => void refreshDriveLibrary()}
        onRestoreEntry={(entry, opts) => void handleRestoreDriveEntry(entry, opts)}
        onDeleteEntry={(entry) => requestDeleteDriveEntry(entry)}
        onCancelRestore={() => driveRestoreAbortRef.current?.abort()}
        onClose={() => {
          if (!restoringManifestId) {
            setDriveLibraryOpen(false);
          }
        }}
      />
      <ProjectManagerDialog
        open={Boolean(projectDialogMode)}
        mode={projectDialogMode}
        activeProject={activeProjectRecord}
        songCount={session.songs.length}
        focusLocked={focusLocked}
        renameTarget={projectRenameTarget}
        projects={projectListEntries}
        projectsLoading={projectListLoading}
        cloudError={projectListError}
        cloudIncompleteReason={projectListIncompleteReason}
        account={googleAuth.account}
        isGoogleConfigured={isGoogleDrivePickerConfigured()}
        hasLegacyWorkspaceSongs={hasLegacyWorkspaceSongs}
        busyMessage={projectBusyState?.message ?? null}
        errorMessage={projectDialogError}
        promoteProgress={promoteProgress}
        promoteBackupFailures={promoteBackupFailures}
        offlineAssessment={offlineAssessment}
        offlineAssessmentLoading={offlineAssessmentLoading}
        offlineDownloadProgress={offlineDownloadProgress}
        offlineDownloadResult={offlineDownloadResult}
        onClose={() => {
          if (!projectBusyState && !promoteProgress && !offlineDownloadProgress) {
            setProjectDialogMode(null);
            setProjectDialogError(null);
          }
        }}
        onChangeMode={(m) => {
          setProjectDialogError(null);
          setProjectDialogMode(m);
        }}
        onRefreshProjects={() => void refreshProjectListEntries()}
        onOpenProject={(entry) => void handleOpenProjectEntry(entry)}
        onCreateProject={(p) => void handleCreateProjectSubmit(p)}
        onSaveAsProject={(p) => void handleSaveAsProjectSubmit(p)}
        onRenameProject={(p) => void handleRenameProjectSubmit(p)}
        onStartRenameActiveProject={() => {
          const active = activeProjectRecordRef.current;
          if (active) {
            openProjectModal("rename", {
              projectId: active.projectId,
              name: active.project.name,
            });
          }
        }}
        onStartRenameFromList={(entry) => {
          openProjectModal("rename", {
            projectId: entry.projectId,
            name: entry.name,
          });
        }}
        onDeleteActiveProject={() => requestDeleteProject()}
        onDeleteProjectEntry={(entry) =>
          requestDeleteProject({
            projectId: entry.projectId,
            name: entry.name,
            storageProvider: entry.storageProvider,
          })
        }
        onOpenOfflineDownload={() => void handleOpenOfflineDialog()}
        onPromoteToDrive={(p) => void handlePromoteToDrive(p)}
        onCancelPromote={() => promoteAbortRef.current?.abort()}
        onStartOfflineDownload={() => void handleStartOfflineDownload()}
        onCancelOfflineDownload={() => offlineDownloadAbortRef.current?.abort()}
        onResolveConflict={(p) => handleResolveProjectConflict(p)}
        onMigrateLegacyWorkspace={() => void handleMigrateLegacyWorkspace()}
        onReturnToLegacyWorkspace={activeProjectRecord ? () => void exitProjectToLegacyWorkspace() : undefined}
        onSignInGoogle={async () => {
          try {
            await sharedGoogleAccountManager.signIn();
            void refreshProjectListEntries();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Google 登入失敗。";
            if (!/已取消/.test(msg)) setProjectDialogError(msg);
          }
        }}
      />
      {deleteDialog && (
        <ConfirmDeleteDialog
          open
          title={deleteDialog.title}
          subtitle={deleteDialog.subtitle}
          badgeLabel={deleteDialog.badgeLabel}
          changeHeading={deleteDialog.changeHeading}
          preserveHeading={deleteDialog.preserveHeading}
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
          cancelLabel={deleteDialog.cancelLabel}
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
            const activeDialog = deleteDialog;
            setDeleteDialog(null);
            setDeleteDialogCheckbox(false);
            setDeleteError("");
            activeDialog?.onCancelNotice?.();
          }}
        />
      )}
    </div>
  );
}
