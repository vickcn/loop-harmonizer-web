import type { StemMetadata } from "@/lib/separation/stemTypes";

export type TrackStatus = "stopped" | "playing" | "paused";
export type TrackSyncMode = "free" | "global-bpm" | "manual-rate";

/**
 * fast-rate   — AudioBufferSourceNode.playbackRate (M1, 已生效)
 * pitch-preserve — 保音高變速，M2B/M2C 再實作
 */
export type TrackPlaybackMode = "fast-rate" | "pitch-preserve" | "soundtouch";

export type SongTempoMode = "target-bpm" | "manual-rate";
export type SongPlaybackSource = "original" | "stems";
export type LocalSongSource = {
  provider: "local";
};

export type GoogleDriveSongSource = {
  provider: "google_drive";
  fileId: string;
  authorizedAccountId: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  modifiedTime?: string;
  resourceKey?: string;
  targetResourceKey?: string;
  driveId?: string;
  webViewLink?: string;
  sourceAudioHash?: string;
};

export type SongSource = LocalSongSource | GoogleDriveSongSource;

export type DriveExportStatusSummary = {
  ownerAccountId: string;
  revisionId: string;
  manifestFileId: string;
  sessionFileId?: string;
  folderId: string;
  format: "wav-float32" | "wav-pcm16";
  exportedAt: number;
};

export type ImportedStemOrigin = {
  importId: string;
  ownerAccountId: string;
  revisionId: string;
  manifestFileId: string;
  pcmFormat: "wav-float32" | "wav-pcm16";
  stemLayout: "four_stem" | "two_stem_direct";
  importedAt: number;
};
export type SeparationStatus =
  | "not_started"
  | "processing"
  | "paused"
  | "interrupted"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";
export type SongAudioLoadState = "ready" | "unloaded" | "decoding" | "error";

export type SongOperationSnapshot = {
  snapshotId: string;
  createdAt: number;
  reason: string;
  songId: string;
  playbackSource: SongPlaybackSource;
  separationStatus: SeparationStatus;
  separationMode: "two_stem" | "four_stem" | null;
  cacheKey: string | null;
  targetBpm: number;
  tempoMode: SongTempoMode;
  manualRate: number;
  fineRateOffset: number;
  keyShiftSemitones: number;
  masterVolume: number;
  playheadSec: number;
  stemChannels: StemChannel[];
};

export type SongPersistenceStatus =
  | "unsaved"
  | "saving"
  | "saved"
  | "error"
  | "restoring"
  | "missing_audio"
  | "conflict";

export type StemChannel = {
  id: string;
  songId: string;
  stemType: string;
  volume: number;
  muted: boolean;
  solo: boolean;
};

export type BandSong = {
  id: string;
  settingsKey: string;
  name: string;
  fileName: string;
  originalBpm: number;
  targetBpm: number;
  keyShiftSemitones: number;
  tempoMode: SongTempoMode;
  manualRate: number;
  fineRateOffset: number;
  savedRates: number[];
  masterVolume: number;
  playheadSec: number;
  durationSec: number;
  status: TrackStatus;
  loop: boolean;
  muted?: boolean;
  selected: boolean;
  sourceAudioId: string;
  stemIds: string[];
  stemChannels: StemChannel[];
  separationStatus: SeparationStatus;
  separationMode: "two_stem" | "four_stem" | null;
  separationProgress: number;
  separationMessage: string;
  separationTaskId?: string | null;
  separationCompletedChunks?: number;
  separationTotalChunks?: number;
  separationCommittedBytes?: number;
  separationUserAuthorized?: boolean;
  separationUsesChunkPlayback?: boolean;
  separationRetryPhase?: "inference" | "finalization";
  separationWaitReason?: string;
  separationActivelyFinalizing?: boolean;
  separationAutoResumeExhausted?: boolean;
  separationRequiresManualAction?: boolean;
  separationForeignActive?: boolean;
  separationGeneration?: number;
  separationOwnerJobToken?: string | null;
  separationFinalizedAt?: number | null;
  playbackSource: SongPlaybackSource;
  cacheKey: string | null;
  sourceAudioHash?: string | null;
  fileSizeBytes?: number;
  mimeType?: string;
  fileLastModified?: number;
  persistenceStatus?: SongPersistenceStatus;
  persistenceMessage?: string;
  revision?: number;
  hasConflict?: boolean;
  audioLoadState?: SongAudioLoadState;
  separationStage?: string;
  activeSnapshot?: SongOperationSnapshot | null;
  source?: SongSource;
  driveExport?: DriveExportStatusSummary | null;
  importedStemOrigin?: ImportedStemOrigin | null;
  sourceAudioMissing?: boolean;
};

export type BandTrack = {
  id: string;
  name: string;
  fileName: string;
  originalBpm: number;
  /** 粗調中心速率（引擎實際速率 = coarseRate + fineOffset） */
  coarseRate: number;
  /** 引擎實際播放速率 = coarseRate + fineOffset */
  baseRate: number;
  /** 使用者儲存的倍率快捷選項 */
  savedRates: number[];
  volume: number;
  muted: boolean;
  selected: boolean;
  playheadSec: number;
  durationSec: number;
  status: TrackStatus;
  syncMode: TrackSyncMode;
  loop: boolean;
  playbackMode: TrackPlaybackMode;
  /** 目前套用到此軌的升降 Key，範圍為 -12 至 +12 半音。 */
  keyShiftSemitones: number;
  /** 只有分離音軌預設跟隨全域 Key；一般上傳音檔維持獨立設定。 */
  followsGlobalKey: boolean;
  /** 分離音源才會設定；同組分軌以相同 AudioContext 時鐘共同排程。 */
  stemMetadata?: StemMetadata;
};

export type SeparationFocusSongEntry = {
  songId: string;
  songName: string;
  wasPlaying: boolean;
  previousStatus: TrackStatus;
  playheadSec: number;
  snapshot: SongOperationSnapshot;
};

export type SeparationFocusSessionSnapshot = {
  focusId: string;
  targetSongId: string;
  targetSongName: string;
  createdAt: number;
  reasons: string[];
  pausedSongIds: string[];
  entries: SeparationFocusSongEntry[];
};

export type BandSession = {
  id: string;
  songs: BandSong[];
};
