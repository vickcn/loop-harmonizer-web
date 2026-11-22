import type { BandSong, ImportedStemOrigin, SongAudioLoadState, SongSource } from "../band/bandTypes.ts";
import { clampBpmValue, createBandSong, sanitizeSongSavedRates } from "../band/songModel.ts";
import { computeSha256HexSync } from "../audio/chunkedWavExporter.ts";
import type { StemSeparationMode } from "../separation/stemTypes.ts";
import {
  DEMUCS_MODEL_VERSION,
  SEPARATION_PROCESSING_VERSION,
  createSeparationCacheKey,
} from "../storage/cacheKeys.ts";
import { DEMUCS_SAMPLE_RATE } from "../storage/separationChunkStore.ts";
import {
  PROJECT_SCHEMA_VERSION,
  type ArtifactCompatibilityResult,
  type BandProject,
  type PersistedProjectRecord,
  type ProjectBackupSummary,
  type ProjectSongArtifactRef,
  type ProjectSongAvailabilityState,
  type ProjectSongBackupStatus,
  type ProjectSongDerivedFromRef,
  type ProjectSongEntry,
  type ProjectSongSettings,
  type ProjectStorageProvider,
} from "./projectTypes.ts";

export const PROJECT_APPLICATION_ID = "loop-harmonizer";

export function generateProjectUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rnd}-${Math.random().toString(36).slice(2, 6)}`;
}

export function generateEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `entry_${crypto.randomUUID()}`;
  }
  return `entry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateRevisionToken(revision: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `r${revision}-${Date.now().toString(36)}-${rand}`;
}

export function sanitizeProjectName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed || "未命名專案";
}

function cloneSource(source?: SongSource | null): SongSource {
  if (!source || source.provider !== "google_drive") {
    return { provider: "local" };
  }
  return { ...source };
}

export function computeEntryBackupStatus(
  entry: Pick<ProjectSongEntry, "source" | "originalBackup" | "artifactRef" | "settings">,
  ownerAccountId?: string,
): ProjectSongBackupStatus {
  const hasDriveOriginal = Boolean(
    (entry.source?.provider === "google_drive" && entry.source.fileId) ||
      (entry.originalBackup?.driveFileId &&
        (!ownerAccountId || entry.originalBackup.ownerAccountId === ownerAccountId)),
  );
  const hasDriveStems = Boolean(
    entry.artifactRef?.manifestFileId && entry.artifactRef.revisionId,
  );
  const requiresStemsBackup = Boolean(entry.artifactRef || entry.settings.separationMode);

  if (hasDriveOriginal && (!requiresStemsBackup || hasDriveStems)) {
    return "cross_device_ready";
  }
  if (hasDriveStems && !hasDriveOriginal) {
    return "stems_backed_up";
  }
  if (hasDriveOriginal && requiresStemsBackup && !hasDriveStems) {
    return "original_backed_up";
  }
  return "local_only";
}

export function computeProjectBackupSummary(
  songs: readonly ProjectSongEntry[],
  ownerAccountId?: string,
): ProjectBackupSummary {
  let crossDeviceReadyCount = 0;
  let originalBackedUpCount = 0;
  let stemsBackedUpCount = 0;
  let localOnlyCount = 0;
  let pendingSyncCount = 0;
  const missingOriginalEntryIds: string[] = [];
  const missingStemsEntryIds: string[] = [];

  for (const entry of songs) {
    const status = computeEntryBackupStatus(entry, ownerAccountId);
    if (status === "cross_device_ready") {
      crossDeviceReadyCount += 1;
    } else if (status === "original_backed_up") {
      originalBackedUpCount += 1;
      pendingSyncCount += 1;
      missingStemsEntryIds.push(entry.entryId);
    } else if (status === "stems_backed_up") {
      stemsBackedUpCount += 1;
      missingOriginalEntryIds.push(entry.entryId);
    } else {
      localOnlyCount += 1;
      pendingSyncCount += 1;
      missingOriginalEntryIds.push(entry.entryId);
      if (entry.artifactRef || entry.settings.separationMode) {
        missingStemsEntryIds.push(entry.entryId);
      }
    }
  }

  return {
    totalSongs: songs.length,
    crossDeviceReadyCount,
    originalBackedUpCount,
    stemsBackedUpCount,
    localOnlyCount,
    pendingSyncCount,
    missingOriginalEntryIds,
    missingStemsEntryIds,
  };
}

export function createEmptyProject(params: {
  name: string;
  description?: string;
  storageProvider: ProjectStorageProvider;
  ownerAccountId?: string;
  projectId?: string;
  nowIso?: string;
}): BandProject {
  const projectId = params.projectId?.trim() || generateProjectUuid();
  const nowIso = params.nowIso ?? new Date().toISOString();
  const revisionToken = generateRevisionToken(1);
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    application: PROJECT_APPLICATION_ID,
    projectId,
    name: sanitizeProjectName(params.name),
    description: params.description?.trim() || undefined,
    storageProvider: params.storageProvider,
    ownerAccountId:
      params.storageProvider === "google_drive" ? params.ownerAccountId : params.ownerAccountId,
    revision: 1,
    revisionToken,
    createdAt: nowIso,
    updatedAt: nowIso,
    masterSettings: {},
    songs: [],
    backupSummary: computeProjectBackupSummary([], params.ownerAccountId),
  };
}

export function extractProjectSongSettings(song: BandSong): ProjectSongSettings {
  return {
    displayName: song.name,
    fileName: song.fileName,
    originalBpm: clampBpmValue(song.originalBpm),
    targetBpm: clampBpmValue(song.targetBpm),
    tempoMode: song.tempoMode === "manual-rate" ? "manual-rate" : "target-bpm",
    manualRate: Math.max(0.25, Math.min(4, Number.isFinite(song.manualRate) ? song.manualRate : 1)),
    fineRateOffset: Math.max(
      -0.05,
      Math.min(0.05, Number.isFinite(song.fineRateOffset) ? song.fineRateOffset : 0),
    ),
    savedRates: sanitizeSongSavedRates(song.savedRates),
    keyShiftSemitones: Math.max(
      -12,
      Math.min(12, Math.round(Number.isFinite(song.keyShiftSemitones) ? song.keyShiftSemitones : 0)),
    ),
    masterVolume: Math.max(0, Math.min(1, Number.isFinite(song.masterVolume) ? song.masterVolume : 1)),
    muted: Boolean(song.muted),
    loop: Boolean(song.loop),
    playbackSource: song.playbackSource === "stems" ? "stems" : "original",
    separationMode: song.separationMode ?? null,
    stemChannels: song.stemChannels.map((ch) => ({
      stemType: ch.stemType,
      volume: Math.max(0, Math.min(1, Number.isFinite(ch.volume) ? ch.volume : 1)),
      muted: Boolean(ch.muted),
      solo: Boolean(ch.solo),
    })),
  };
}

export function bandSongToProjectEntry(
  song: BandSong,
  order: number,
  options?: {
    existingEntry?: ProjectSongEntry | null;
    ownerAccountId?: string;
    forceNewEntryId?: boolean;
  },
): ProjectSongEntry {
  const entryId = options?.forceNewEntryId
    ? generateEntryId()
    : song.projectEntryId || options?.existingEntry?.entryId || song.id || generateEntryId();

  const sourceAudioHash =
    song.sourceAudioHash ||
    options?.existingEntry?.sourceAudioHash ||
    (song.source?.provider === "google_drive" ? song.source.sourceAudioHash : undefined) ||
    "";

  const targetAccountId = options?.ownerAccountId;
  const matchingDriveExport =
    song.driveExport &&
    (!targetAccountId || song.driveExport.ownerAccountId === targetAccountId)
      ? song.driveExport
      : null;

  let artifactRef: ProjectSongArtifactRef | null =
    song.artifactRef
      ? { ...song.artifactRef }
      : options?.existingEntry?.artifactRef
        ? { ...options.existingEntry.artifactRef }
        : null;

  const sampleRate = artifactRef?.sampleRate ?? DEMUCS_SAMPLE_RATE;
  const derivedTotalSamples =
    artifactRef?.totalSamples ??
    Math.max(1, Math.round((song.durationSec || 0) * sampleRate));

  if (matchingDriveExport) {
    artifactRef = {
      manifestFileId: matchingDriveExport.manifestFileId,
      revisionId: matchingDriveExport.revisionId,
      sourceAudioHash,
      separationMode:
        song.separationMode ?? artifactRef?.separationMode ?? "four_stem",
      modelVersion: artifactRef?.modelVersion ?? DEMUCS_MODEL_VERSION,
      processingVersion: artifactRef?.processingVersion ?? SEPARATION_PROCESSING_VERSION,
      sampleRate,
      channelCount: 2,
      totalSamples: derivedTotalSamples,
      pcmFormat: matchingDriveExport.format,
      artifactChecksums: artifactRef?.artifactChecksums,
      derivedFrom: artifactRef?.derivedFrom ?? null,
      localTaskId: song.separationTaskId ?? artifactRef?.localTaskId ?? null,
      localSourceType:
        song.importedStemOrigin ? "imported_stem" : song.separationTaskId ? "demucs_checkpoint" : artifactRef?.localSourceType ?? null,
    };
  } else if (song.importedStemOrigin && song.separationStatus === "completed") {
    artifactRef = {
      manifestFileId: song.importedStemOrigin.manifestFileId || artifactRef?.manifestFileId,
      revisionId: song.importedStemOrigin.revisionId || artifactRef?.revisionId || `imp-${song.importedStemOrigin.importId}`,
      sourceAudioHash,
      separationMode: song.separationMode ?? artifactRef?.separationMode ?? "four_stem",
      modelVersion: artifactRef?.modelVersion ?? DEMUCS_MODEL_VERSION,
      processingVersion: artifactRef?.processingVersion ?? SEPARATION_PROCESSING_VERSION,
      sampleRate,
      channelCount: 2,
      totalSamples: derivedTotalSamples,
      pcmFormat: song.importedStemOrigin.pcmFormat,
      artifactChecksums: artifactRef?.artifactChecksums,
      derivedFrom: artifactRef?.derivedFrom ?? null,
      localTaskId: song.importedStemOrigin.importId,
      localSourceType: "imported_stem",
    };
  } else if (song.separationStatus === "completed" && song.separationMode && sourceAudioHash) {
    artifactRef = {
      manifestFileId: artifactRef?.manifestFileId,
      revisionId: artifactRef?.revisionId || `local-${song.separationTaskId || sourceAudioHash.slice(0, 12)}`,
      sourceAudioHash,
      separationMode: song.separationMode,
      modelVersion: artifactRef?.modelVersion ?? DEMUCS_MODEL_VERSION,
      processingVersion: artifactRef?.processingVersion ?? SEPARATION_PROCESSING_VERSION,
      sampleRate,
      channelCount: 2,
      totalSamples: derivedTotalSamples,
      pcmFormat: artifactRef?.pcmFormat,
      artifactChecksums: artifactRef?.artifactChecksums,
      derivedFrom: artifactRef?.derivedFrom ?? null,
      localTaskId: song.separationTaskId ?? artifactRef?.localTaskId ?? null,
      localSourceType: "demucs_checkpoint",
    };
  } else if (song.separationStatus === "not_started" && !song.cacheKey && !song.separationTaskId) {
    artifactRef = null;
  }

  const originalBackup = song.originalBackup
    ? { ...song.originalBackup }
    : options?.existingEntry?.originalBackup
      ? { ...options.existingEntry.originalBackup }
      : null;

  const entry: ProjectSongEntry = {
    entryId,
    sourceAudioHash,
    source: cloneSource(song.source ?? options?.existingEntry?.source),
    originalBackup,
    displayName: song.name,
    fileName: song.fileName,
    mimeType: song.mimeType,
    sizeBytes: song.fileSizeBytes,
    durationSec: Number.isFinite(song.durationSec) && song.durationSec >= 0 ? song.durationSec : 0,
    order,
    artifactRef,
    settings: extractProjectSongSettings(song),
  };
  entry.backupStatus = computeEntryBackupStatus(entry, targetAccountId);
  return entry;
}

function formatProjectStemsReadyMessage(revisionId?: string): string {
  const trimmed = revisionId?.trim() ?? "";
  if (!trimmed) return "已依專案分軌版本就緒";
  if (trimmed.startsWith("local-")) return "已依專案本機分軌版本就緒";
  const displayRev = trimmed.length > 24 ? `${trimmed.slice(0, 16)}…` : trimmed;
  return `已依專案版本 ${displayRev} 就緒`;
}

export function projectEntryToBandSong(
  entry: ProjectSongEntry,
  options?: {
    projectId?: string;
    ownerAccountId?: string;
    availabilityState?: ProjectSongAvailabilityState;
    sourceAudioMissing?: boolean;
    audioLoadState?: SongAudioLoadState;
    localTaskId?: string | null;
    localStemsReady?: boolean;
    importedStemOrigin?: ImportedStemOrigin | null;
    totalChunks?: number;
    committedBytes?: number;
    persistenceMessage?: string;
  },
): BandSong {
  const s = entry.settings;
  const sourceAudioId = `${entry.entryId}_original`;
  const settingsKey = `proj:${entry.entryId}:${entry.sourceAudioHash.slice(0, 12)}`;
  const driveExport =
    entry.artifactRef?.manifestFileId && options?.ownerAccountId
      ? {
          ownerAccountId: options.ownerAccountId,
          revisionId: entry.artifactRef.revisionId,
          manifestFileId: entry.artifactRef.manifestFileId,
          folderId: "",
          format: entry.artifactRef.pcmFormat ?? "wav-float32",
          exportedAt: Date.now(),
        }
      : null;

  const song = createBandSong({
    id: entry.entryId,
    name: s.displayName || entry.displayName,
    fileName: s.fileName || entry.fileName,
    sourceAudioId,
    settingsKey,
    originalBpm: clampBpmValue(s.originalBpm),
    durationSec: entry.durationSec,
    sourceAudioHash: entry.sourceAudioHash,
    fileSizeBytes: entry.sizeBytes,
    mimeType: entry.mimeType,
    persistenceStatus: "saved",
    persistenceMessage: options?.persistenceMessage ?? "專案歌曲已就緒（延遲解碼）",
    audioLoadState: options?.audioLoadState ?? "unloaded",
    source: cloneSource(entry.source),
    driveExport,
    importedStemOrigin: options?.importedStemOrigin ?? null,
    sourceAudioMissing: Boolean(options?.sourceAudioMissing),
    projectEntryId: entry.entryId,
    availabilityState: options?.availabilityState,
    backupStatus: computeEntryBackupStatus(entry, options?.ownerAccountId),
    artifactRef: entry.artifactRef ? { ...entry.artifactRef } : null,
    originalBackup: entry.originalBackup ? { ...entry.originalBackup } : null,
  });

  const stemChannels = s.stemChannels.map((ch) => ({
    id: `${entry.entryId}_stem_${ch.stemType}`,
    songId: entry.entryId,
    stemType: ch.stemType,
    volume: ch.volume,
    muted: ch.muted,
    solo: ch.solo,
  }));

  const cacheKey =
    entry.artifactRef && entry.sourceAudioHash
      ? createSeparationCacheKey({
          sourceAudioHash: entry.sourceAudioHash,
          modelVersion: entry.artifactRef.modelVersion,
          separationMode: entry.artifactRef.separationMode,
          processingVersion: entry.artifactRef.processingVersion,
        })
      : null;

  const localStemsReady = Boolean(options?.localStemsReady && options?.localTaskId && entry.artifactRef);

  return {
    ...song,
    targetBpm: clampBpmValue(s.targetBpm),
    tempoMode: s.tempoMode === "manual-rate" ? "manual-rate" : "target-bpm",
    manualRate: Math.max(0.25, Math.min(4, s.manualRate)),
    fineRateOffset: Math.max(-0.05, Math.min(0.05, s.fineRateOffset)),
    savedRates: sanitizeSongSavedRates(s.savedRates),
    keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(s.keyShiftSemitones))),
    masterVolume: Math.max(0, Math.min(1, s.masterVolume)),
    muted: Boolean(s.muted),
    loop: Boolean(s.loop),
    playbackSource:
      localStemsReady && s.playbackSource === "stems"
        ? "stems"
        : options?.sourceAudioMissing && localStemsReady
          ? "stems"
          : s.playbackSource === "stems" && entry.artifactRef
            ? "stems"
            : "original",
    separationMode: s.separationMode ?? entry.artifactRef?.separationMode ?? null,
    separationStatus: localStemsReady ? "completed" : "not_started",
    separationStage: localStemsReady ? "completed" : "idle",
    separationProgress: localStemsReady ? 1 : 0,
    separationMessage: localStemsReady
      ? formatProjectStemsReadyMessage(entry.artifactRef?.revisionId)
      : entry.artifactRef?.manifestFileId
        ? "雲端已備份分軌，點擊播放時按需下載恢復"
        : "",
    separationTaskId: options?.localTaskId ?? entry.artifactRef?.localTaskId ?? null,
    separationCompletedChunks: options?.totalChunks,
    separationTotalChunks: options?.totalChunks,
    separationCommittedBytes: options?.committedBytes,
    separationUserAuthorized: Boolean(entry.artifactRef),
    separationUsesChunkPlayback: localStemsReady,
    cacheKey,
    stemIds: localStemsReady ? stemChannels.map((c) => c.id) : [],
    stemChannels,
  };
}

export function cloneProjectForSaveAs(
  source: BandProject,
  options: {
    name: string;
    description?: string;
    storageProvider: ProjectStorageProvider;
    ownerAccountId?: string;
    nowIso?: string;
  },
): BandProject {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const projectId = generateProjectUuid();
  const songs: ProjectSongEntry[] = source.songs
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((entry, idx) => {
      const cloned: ProjectSongEntry = {
        ...entry,
        entryId: generateEntryId(),
        order: idx,
        source: cloneSource(entry.source),
        originalBackup: entry.originalBackup ? { ...entry.originalBackup } : null,
        artifactRef: entry.artifactRef ? { ...entry.artifactRef } : null,
        settings: {
          ...entry.settings,
          savedRates: [...entry.settings.savedRates],
          stemChannels: entry.settings.stemChannels.map((c) => ({ ...c })),
        },
      };
      cloned.backupStatus = computeEntryBackupStatus(cloned, options.ownerAccountId);
      return cloned;
    });

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    application: PROJECT_APPLICATION_ID,
    projectId,
    name: sanitizeProjectName(options.name),
    description: options.description?.trim() || source.description,
    storageProvider: options.storageProvider,
    ownerAccountId: options.ownerAccountId,
    driveFolderId: undefined,
    driveProjectFileId: undefined,
    driveRevisionsFolderId: undefined,
    revision: 1,
    revisionToken: generateRevisionToken(1),
    parentRevisionId: undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    masterSettings: { ...source.masterSettings },
    songs,
    backupSummary: computeProjectBackupSummary(songs, options.ownerAccountId),
  };
}

export function buildProjectFromBandSongs(params: {
  existingProject: BandProject;
  songs: readonly BandSong[];
  incrementRevision?: boolean;
  nowIso?: string;
}): BandProject {
  const existingById = new Map(params.existingProject.songs.map((e) => [e.entryId, e]));
  const nextSongs: ProjectSongEntry[] = params.songs.map((song, index) =>
    bandSongToProjectEntry(song, index, {
      existingEntry: existingById.get(song.projectEntryId || song.id) ?? null,
      ownerAccountId: params.existingProject.ownerAccountId,
    }),
  );
  const nextRevision = params.incrementRevision
    ? params.existingProject.revision + 1
    : params.existingProject.revision;
  const nextToken = params.incrementRevision
    ? generateRevisionToken(nextRevision)
    : params.existingProject.revisionToken;
  const nowIso = params.nowIso ?? new Date().toISOString();

  return {
    ...params.existingProject,
    revision: nextRevision,
    revisionToken: nextToken,
    parentRevisionId: params.incrementRevision
      ? params.existingProject.revisionToken
      : params.existingProject.parentRevisionId,
    updatedAt: nowIso,
    songs: nextSongs,
    backupSummary: computeProjectBackupSummary(
      nextSongs,
      params.existingProject.ownerAccountId,
    ),
  };
}

/** 比較兩份專案的「使用者可見內容」（名稱、說明、混音設定、歌曲），忽略 revision/updatedAt 等版本欄位。 */
export function isProjectContentEqual(a: BandProject, b: BandProject): boolean {
  const pick = (p: BandProject) =>
    JSON.stringify({
      name: p.name,
      description: p.description ?? null,
      masterSettings: p.masterSettings,
      songs: p.songs,
    });
  return pick(a) === pick(b);
}

export function createInitialPersistedProjectRecord(
  project: BandProject,
  options?: {
    dirty?: boolean;
    syncStatus?: PersistedProjectRecord["syncStatus"];
    syncedAt?: number | null;
    migratedFromLegacySession?: boolean;
    legacyMigrationFingerprint?: string;
  },
): PersistedProjectRecord {
  const now = Date.now();
  const isDrive = project.storageProvider === "google_drive";
  return {
    key: project.projectId,
    projectId: project.projectId,
    storageProvider: project.storageProvider,
    ownerAccountId: isDrive ? (project.ownerAccountId ?? "") : "",
    project,
    localBaseRevision: project.revision,
    localBaseRevisionToken: project.revisionToken,
    localRevision: project.revision,
    lastSyncedRemoteRevision: isDrive && options?.syncStatus === "synced" ? project.revision : null,
    lastSyncedRemoteRevisionToken:
      isDrive && options?.syncStatus === "synced" ? project.revisionToken : null,
    lastKnownRemoteRevision: isDrive && options?.syncStatus === "synced" ? project.revision : null,
    lastKnownRemoteRevisionToken:
      isDrive && options?.syncStatus === "synced" ? project.revisionToken : null,
    dirty: Boolean(options?.dirty ?? isDrive),
    syncStatus: options?.syncStatus ?? (isDrive ? "dirty" : "local_only"),
    lastSavedAt: now,
    lastSyncedAt: options?.syncedAt ?? null,
    conflictInfo: null,
    syncGeneration: 1,
    migratedFromLegacySession: options?.migratedFromLegacySession,
    legacyMigrationFingerprint: options?.legacyMigrationFingerprint,
  };
}

export function validateProjectDocument(
  raw: unknown,
  options?: { expectedAccountId?: string },
): { valid: boolean; reasons: string[]; project?: BandProject } {
  const reasons: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { valid: false, reasons: ["專案 JSON 格式不是有效物件。"] };
  }
  const doc = raw as Partial<BandProject>;
  if (doc.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    reasons.push(`不支援的專案 Schema 版本：${String(doc.schemaVersion ?? "unknown")}`);
  }
  if (doc.application !== PROJECT_APPLICATION_ID) {
    reasons.push("專案 JSON application 識別不符。");
  }
  if (!doc.projectId || typeof doc.projectId !== "string") {
    reasons.push("專案 JSON 缺少 projectId。");
  }
  if (!doc.name || typeof doc.name !== "string") {
    reasons.push("專案 JSON 缺少專案名稱。");
  }
  if (doc.storageProvider === "google_drive") {
    if (!doc.ownerAccountId || typeof doc.ownerAccountId !== "string") {
      reasons.push("雲端專案缺少 ownerAccountId。");
    } else if (
      options?.expectedAccountId &&
      doc.ownerAccountId !== options.expectedAccountId
    ) {
      reasons.push("此專案屬於其他 Google 帳號，已拒絕跨帳戶載入。");
    }
  }
  if (!Number.isFinite(doc.revision) || (doc.revision ?? 0) < 1) {
    reasons.push("專案 JSON revision 無效。");
  }
  if (!Array.isArray(doc.songs)) {
    reasons.push("專案 JSON songs 清單無效。");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    project: reasons.length === 0 ? (doc as BandProject) : undefined,
  };
}

export function normalizeArtifactChecksum(value?: string | null): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^sha256:[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return `sha256:${trimmed.toLowerCase()}`;
  }
  return trimmed;
}

/**
 * 嚴格檢驗本地既有或待重用分軌成果是否完全相容於專案指定的 ProjectSongArtifactRef。
 * 區分 verified / insufficient_evidence / incompatible 三態：
 * - 不得將缺少 checksum 或缺少必要角色的候選直接視為 verified。
 * - 舊版 local-* Revision 保留必要本機相容路徑，正式雲端版本不得降低驗證要求。
 */
export function isArtifactRefStrictlyCompatible(
  expected: ProjectSongArtifactRef,
  candidate: {
    sourceAudioHash: string;
    separationMode: StemSeparationMode;
    modelVersion: string;
    processingVersion: string;
    sampleRate: number;
    channelCount: number;
    totalSamples: number;
    revisionId?: string;
    exportedRevisionIds?: readonly string[];
    checksumsByRole?: Record<string, string>;
    derivedFrom?: ProjectSongDerivedFromRef | null;
  },
  options?: { requireExactRevision?: boolean },
): ArtifactCompatibilityResult {
  if (expected.sourceAudioHash !== candidate.sourceAudioHash) {
    return { compatible: false, status: "incompatible", reason: "sourceAudioHash 不符" };
  }
  if (expected.modelVersion !== candidate.modelVersion) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `模型版本不符（專案指定 ${expected.modelVersion}，候選為 ${candidate.modelVersion}）`,
    };
  }
  if (expected.processingVersion !== candidate.processingVersion) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `處理管線版本不符（專案指定 ${expected.processingVersion}，候選為 ${candidate.processingVersion}）`,
    };
  }
  if (expected.sampleRate !== candidate.sampleRate) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `取樣率不符（專案 ${expected.sampleRate}Hz，候選 ${candidate.sampleRate}Hz）`,
    };
  }
  if (expected.channelCount !== candidate.channelCount) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `聲道數不符（專案 ${expected.channelCount}，候選 ${candidate.channelCount}）`,
    };
  }
  if (expected.totalSamples !== candidate.totalSamples) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `總樣本數不符（專案 ${expected.totalSamples}，候選 ${candidate.totalSamples}）`,
    };
  }

  const modeDirectMatch = expected.separationMode === candidate.separationMode;
  const twoStemDerivedFromFour =
    expected.separationMode === "two_stem" && candidate.separationMode === "four_stem";

  if (!modeDirectMatch && !twoStemDerivedFromFour) {
    return {
      compatible: false,
      status: "incompatible",
      reason: `分軌模式不相容（專案需要 ${expected.separationMode}，候選為 ${candidate.separationMode}）`,
    };
  }

  const isLegacyLocalRevision =
    !expected.revisionId || expected.revisionId.startsWith("local-");
  const requireExact = options?.requireExactRevision ?? true;

  if (
    requireExact &&
    !isLegacyLocalRevision
  ) {
    const revMatches =
      candidate.revisionId === expected.revisionId ||
      Boolean(candidate.exportedRevisionIds?.includes(expected.revisionId)) ||
      Boolean(
        twoStemDerivedFromFour &&
          expected.derivedFrom?.sourceRevisionId &&
          !expected.derivedFrom.sourceRevisionId.startsWith("local-") &&
          (candidate.revisionId === expected.derivedFrom.sourceRevisionId ||
            candidate.exportedRevisionIds?.includes(expected.derivedFrom.sourceRevisionId)),
      );
    if (!revMatches) {
      return {
        compatible: false,
        status: "incompatible",
        reason: `分軌版本不符（專案指定 ${expected.revisionId}，本機為 ${candidate.revisionId ?? "未知"}）`,
      };
    }
  }

  let derivedFromNeedsEvidenceReason: string | undefined;
  if (expected.derivedFrom) {
    if (
      expected.derivedFrom.modelVersion !== candidate.modelVersion ||
      expected.derivedFrom.processingVersion !== candidate.processingVersion
    ) {
      return {
        compatible: false,
        status: "incompatible",
        reason: "2 Stem 派生來源模型或處理版本與專案指定版本不一致，禁止混用不同來源音軌",
      };
    }
    if (twoStemDerivedFromFour) {
      const expSrcRev = expected.derivedFrom.sourceRevisionId;
      if (expSrcRev && !expSrcRev.startsWith("local-")) {
        const matchesSourceRev =
          candidate.revisionId === expSrcRev ||
          Boolean(candidate.exportedRevisionIds?.includes(expSrcRev));
        if (!matchesSourceRev) {
          return {
            compatible: false,
            status: "incompatible",
            reason: "2 Stem 派生來源 4 Stem Revision 與專案指定版本不一致，禁止混用不同來源音軌",
          };
        }
      }
      if (candidate.derivedFrom) {
        if (
          expected.derivedFrom.modelVersion !== candidate.derivedFrom.modelVersion ||
          expected.derivedFrom.processingVersion !== candidate.derivedFrom.processingVersion ||
          (expected.derivedFrom.sourceRevisionId &&
            candidate.derivedFrom.sourceRevisionId &&
            expected.derivedFrom.sourceRevisionId !== candidate.derivedFrom.sourceRevisionId)
        ) {
          return {
            compatible: false,
            status: "incompatible",
            reason: "2 Stem 派生來源版本與專案指定版本不一致，禁止混用不同版本音軌",
          };
        }
      }
    } else if (candidate.derivedFrom) {
      if (
        expected.derivedFrom.modelVersion !== candidate.derivedFrom.modelVersion ||
        expected.derivedFrom.processingVersion !== candidate.derivedFrom.processingVersion ||
        (expected.derivedFrom.sourceRevisionId &&
          candidate.derivedFrom.sourceRevisionId &&
          expected.derivedFrom.sourceRevisionId !== candidate.derivedFrom.sourceRevisionId)
      ) {
        return {
          compatible: false,
          status: "incompatible",
          reason: "2 Stem 派生來源版本與專案指定版本不一致，禁止混用不同版本音軌",
        };
      }
      if (expected.derivedFrom.sourceRevisionId && !candidate.derivedFrom.sourceRevisionId) {
        derivedFromNeedsEvidenceReason = "2 Stem 候選缺少派生來源 Revision 紀錄";
      }
    } else if (expected.derivedFrom.sourceRevisionId && !isLegacyLocalRevision) {
      derivedFromNeedsEvidenceReason = "2 Stem 候選缺少 derivedFrom 譜系紀錄";
    }
  }

  const requiredRoles =
    expected.separationMode === "two_stem"
      ? (["vocals", "instrumental"] as const)
      : (["vocals", "drums", "bass", "other"] as const);

  const normalizedExpected: Record<string, string> = {};
  if (expected.artifactChecksums) {
    for (const [role, sum] of Object.entries(expected.artifactChecksums)) {
      const norm = normalizeArtifactChecksum(sum);
      if (norm) normalizedExpected[role] = norm;
    }
  }
  const normalizedCandidate: Record<string, string> = {};
  if (candidate.checksumsByRole) {
    for (const [role, sum] of Object.entries(candidate.checksumsByRole)) {
      const norm = normalizeArtifactChecksum(sum);
      if (norm) normalizedCandidate[role] = norm;
    }
  }

  // 優先檢查已存在欄位之間是否明確不符（checksum 不一致屬於 incompatible）
  for (const [role, expSum] of Object.entries(normalizedExpected)) {
    const gotSum = normalizedCandidate[role];
    if (gotSum && gotSum !== expSum) {
      return {
        compatible: false,
        status: "incompatible",
        reason: `分軌 ${role} Checksum 不一致`,
      };
    }
  }

  const expectedKeys = Object.keys(normalizedExpected);
  const hasExplicitExpectedChecksums =
    expected.artifactChecksums !== undefined && expectedKeys.length > 0;

  if (hasExplicitExpectedChecksums) {
    if (!candidate.checksumsByRole) {
      const missingRoles = Array.from(
        new Set(isLegacyLocalRevision ? expectedKeys : [...requiredRoles, ...expectedKeys]),
      );
      return {
        compatible: false,
        status: "insufficient_evidence",
        missingChecksumRoles: missingRoles,
        canAttemptRecomputeVerification: true,
        reason: `候選分軌缺少 checksumsByRole 完整性證明（缺少：${missingRoles.join("、")}）`,
      };
    }
    const rolesToCheck = isLegacyLocalRevision
      ? expectedKeys
      : Array.from(new Set([...requiredRoles, ...expectedKeys]));
    const missingRoles = rolesToCheck.filter(
      (role) => !normalizedCandidate[role] || (!isLegacyLocalRevision && (requiredRoles as readonly string[]).includes(role) && !normalizedExpected[role]),
    );
    if (missingRoles.length > 0) {
      return {
        compatible: false,
        status: "insufficient_evidence",
        missingChecksumRoles: missingRoles,
        canAttemptRecomputeVerification: !rolesToCheck.some(
          (role) => !isLegacyLocalRevision && (requiredRoles as readonly string[]).includes(role) && !normalizedExpected[role],
        ),
        reason: `缺少必要角色的 Checksum 完整性證明（${missingRoles.join("、")}），不可直接視為已驗證`,
      };
    }
  } else if (!isLegacyLocalRevision) {
    // 正式雲端版本不得因未傳 expected.artifactChecksums 而免除完整性檢查
    const rolesToCheck = [...requiredRoles];
    const missingCandidateRoles = rolesToCheck.filter((role) => !normalizedCandidate[role]);
    const missingExpectedRoles = expected.artifactChecksums !== undefined
      ? rolesToCheck.filter((role) => !normalizedExpected[role])
      : [];
    const missingRoles = Array.from(new Set([...missingCandidateRoles, ...missingExpectedRoles]));
    if (missingRoles.length > 0) {
      return {
        compatible: false,
        status: "insufficient_evidence",
        missingChecksumRoles: missingRoles,
        canAttemptRecomputeVerification: missingExpectedRoles.length === 0 && Object.keys(normalizedExpected).length > 0,
        reason: `正式雲端版本缺少完整 Checksum 證明（缺少：${missingRoles.join("、")}）`,
      };
    }
  }

  if (derivedFromNeedsEvidenceReason) {
    const canAcceptExactWithAllChecksums =
      hasExplicitExpectedChecksums &&
      candidate.revisionId === expected.revisionId &&
      requiredRoles.every(
        (role) => normalizedExpected[role] && normalizedCandidate[role] === normalizedExpected[role],
      );
    if (!canAcceptExactWithAllChecksums) {
      return {
        compatible: false,
        status: "insufficient_evidence",
        reason: derivedFromNeedsEvidenceReason,
      };
    }
  }

  return { compatible: true, status: "verified" };
}

export function computeLegacySessionFingerprint(
  songs: ReadonlyArray<{ id?: string; songId?: string; sourceAudioHash?: string | null; name?: string }>,
): string {
  const canonical = songs
    .map((s) => `${s.id ?? s.songId ?? ""}:${s.sourceAudioHash ?? ""}:${s.name ?? ""}`)
    .join("|");
  const bytes = new TextEncoder().encode(canonical);
  return computeSha256HexSync(bytes).slice(0, 24);
}
