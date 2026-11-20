import type { StemSeparationMode } from "../separation/stemTypes.ts";
import type { SongPlaybackSource, SongSource, SongTempoMode } from "../band/bandTypes.ts";

export const PROJECT_SCHEMA_VERSION = 1;

export type ProjectStorageProvider = "local" | "google_drive";

export type ProjectSyncStatus =
  | "local_only"
  | "synced"
  | "dirty"
  | "syncing"
  | "waiting_auth"
  | "conflict"
  | "error";

export type ProjectSongBackupStatus =
  | "local_only"
  | "original_backed_up"
  | "stems_backed_up"
  | "cross_device_ready"
  | "pending_sync";

export type ProjectSongAvailabilityState =
  | "local_playable"
  | "cloud_not_downloaded"
  | "downloading"
  | "stems_loaded"
  | "needs_reauth"
  | "original_missing"
  | "stems_missing";

export type ArtifactCompatibilityStatus =
  | "verified"
  | "insufficient_evidence"
  | "incompatible";

export interface ArtifactCompatibilityResult {
  compatible: boolean;
  status: ArtifactCompatibilityStatus;
  reason?: string;
  missingChecksumRoles?: string[];
  canAttemptRecomputeVerification?: boolean;
}

export type ProjectRevisionMetaSummary = {
  fileId: string;
  fileName?: string;
  revision?: number;
  revisionToken: string;
  parentRevisionId?: string;
  modifiedTime?: string;
};

export type PendingProjectRevisionPublish = {
  revision: number;
  revisionToken: string;
  parentRevisionId?: string;
  revisionFileId: string;
  targetProjectFileId?: string;
  localRevisionAtStart: number;
  localTokenAtStart: string;
  createdAt: number;
};

export type ProjectMasterSettings = {
  notes?: string;
};

export type ProjectSongDerivedFromRef = {
  sourceMode: "four_stem";
  sourceRevisionId?: string;
  sourceTaskId?: string;
  modelVersion: string;
  processingVersion: string;
};

export type ProjectSongArtifactRef = {
  manifestFileId?: string;
  revisionId: string;
  sourceAudioHash: string;
  separationMode: StemSeparationMode;
  modelVersion: string;
  processingVersion: string;
  sampleRate: number;
  channelCount: 2;
  totalSamples: number;
  pcmFormat?: "wav-float32" | "wav-pcm16";
  artifactChecksums?: Record<string, string>;
  derivedFrom?: ProjectSongDerivedFromRef | null;
  localTaskId?: string | null;
  localSourceType?: "demucs_checkpoint" | "imported_stem" | null;
};

export type ProjectSongOriginalBackupRef = {
  driveFileId: string;
  ownerAccountId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceAudioHash: string;
  sha256?: string;
  backedUpAt: string;
};

export type ProjectSongSettings = {
  displayName: string;
  fileName: string;
  originalBpm: number;
  targetBpm: number;
  tempoMode: SongTempoMode;
  manualRate: number;
  fineRateOffset: number;
  savedRates: number[];
  keyShiftSemitones: number;
  masterVolume: number;
  muted: boolean;
  loop: boolean;
  playbackSource: SongPlaybackSource;
  separationMode: StemSeparationMode | null;
  stemChannels: Array<{
    stemType: string;
    volume: number;
    muted: boolean;
    solo: boolean;
  }>;
};

export type ProjectSongEntry = {
  entryId: string;
  sourceAudioHash: string;
  source: SongSource;
  originalBackup?: ProjectSongOriginalBackupRef | null;
  displayName: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec: number;
  order: number;
  artifactRef?: ProjectSongArtifactRef | null;
  settings: ProjectSongSettings;
  backupStatus?: ProjectSongBackupStatus;
};

export type ProjectBackupSummary = {
  totalSongs: number;
  crossDeviceReadyCount: number;
  originalBackedUpCount: number;
  stemsBackedUpCount: number;
  localOnlyCount: number;
  pendingSyncCount: number;
  missingOriginalEntryIds: string[];
  missingStemsEntryIds: string[];
};

export type BandProject = {
  schemaVersion: 1;
  application: "loop-harmonizer";
  projectId: string;
  name: string;
  description?: string;
  storageProvider: ProjectStorageProvider;
  ownerAccountId?: string;
  driveFolderId?: string;
  driveProjectFileId?: string;
  driveRevisionsFolderId?: string;
  revision: number;
  revisionToken: string;
  parentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  masterSettings: ProjectMasterSettings;
  songs: ProjectSongEntry[];
  backupSummary?: ProjectBackupSummary;
};

export type ProjectConflictInfo = {
  detectedAt: number;
  kind: "diverged" | "remote_deleted";
  conflictSubType?: "pre_write_diverged" | "read_after_write_race" | "sibling_branch" | "remote_deleted";
  localRevision: number;
  localRevisionToken: string;
  localBaseRevision: number;
  remoteRevision: number;
  remoteRevisionToken: string;
  remoteUpdatedAt?: string;
  remoteProjectSnapshot: BandProject | null;
  conflictSnapshotFileId?: string;
  siblingRevisions?: ProjectRevisionMetaSummary[];
  parentRevisionId?: string;
  reason: string;
};

export type PersistedProjectRecord = {
  key: string;
  projectId: string;
  storageProvider: ProjectStorageProvider;
  /** 本機專案為空字串 ""；雲端專案為 canonical ownerAccountId */
  ownerAccountId: string;
  project: BandProject;
  localBaseRevision: number;
  localBaseRevisionToken?: string;
  localRevision: number;
  lastSyncedRemoteRevision: number | null;
  lastSyncedRemoteRevisionToken?: string | null;
  lastKnownRemoteRevision?: number | null;
  lastKnownRemoteRevisionToken?: string | null;
  lastKnownRemoteDriveVersion?: string | null;
  pendingRevisionPublish?: PendingProjectRevisionPublish | null;
  dirty: boolean;
  syncStatus: ProjectSyncStatus;
  lastSavedAt: number;
  lastSyncedAt: number | null;
  lastError?: string | null;
  conflictInfo?: ProjectConflictInfo | null;
  syncGeneration: number;
  migratedFromLegacySession?: boolean;
  legacyMigrationFingerprint?: string;
};

export type PersistedProjectSyncJobStatus =
  | "idle"
  | "queued"
  | "syncing"
  | "waiting_auth"
  | "conflict"
  | "error";

export type PersistedProjectSyncJob = {
  key: string;
  projectId: string;
  ownerAccountId: string;
  status: PersistedProjectSyncJobStatus;
  attempts: number;
  nextRetryAt?: number;
  syncGeneration: number;
  lastError?: string;
  updatedAt: number;
};

export type ProjectListEntrySummary = {
  projectId: string;
  name: string;
  description?: string;
  storageProvider: ProjectStorageProvider;
  ownerAccountId?: string;
  songCount: number;
  updatedAt: string;
  localUpdatedAt: number;
  revision: number;
  syncStatus: ProjectSyncStatus;
  dirty: boolean;
  hasConflict: boolean;
  driveFolderId?: string;
  driveProjectFileId?: string;
  backupSummary: ProjectBackupSummary;
  sourceLocation: "local_only" | "synced_cache" | "cloud_only";
};
