import type { PickedDriveFile } from "./googleDrivePicker.ts";

export type DriveImportStage =
  | "idle"
  | "sdk"
  | "auth"
  | "picker"
  | "inspecting"
  | "evaluating"
  | "downloading"
  | "persisting"
  | "completed"
  | "cancelled"
  | "error";

export type DriveExportStage =
  | "idle"
  | "preparing"
  | "uploading"
  | "verifying"
  | "publishing"
  | "completed"
  | "paused"
  | "waiting_auth"
  | "cancelled"
  | "failed";

export type DriveRestoreStage =
  | "idle"
  | "listing"
  | "validating"
  | "checking_local"
  | "evaluating"
  | "downloading"
  | "importing"
  | "completed"
  | "cancelled"
  | "failed";

export interface VerifiedDriveFileMetadata {
  pickedFileId: string;
  resolvedFileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime?: string;
  md5Checksum?: string;
  driveId?: string;
  resourceKey?: string;
  targetResourceKey?: string;
  webViewLink?: string;
  isShortcut: boolean;
  canDownload: boolean;
}

export interface DriveImportFailure {
  fileId: string;
  fileName: string;
  code: string;
  reason: string;
}

export interface DriveImportBatchAssessment {
  allowed: boolean;
  hardBlocked: boolean;
  requiresConfirmation: boolean;
  knownTotalBytes: number;
  estimatedTotalBytes: number;
  unknownSizeCount: number;
  perFileConservativeLimitBytes: number;
  reasons: string[];
}

export interface DriveImportProgress {
  stage: DriveImportStage;
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  loadedBytes: number;
  totalBytes: number | null;
  completedCount: number;
  failedCount: number;
}

export type DriveTransferJobStatus =
  | "queued"
  | "uploading"
  | "paused"
  | "waiting_auth"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

export type DriveArtifactRole =
  | "vocals"
  | "drums"
  | "bass"
  | "other"
  | "instrumental"
  | "custom_mix"
  | "session"
  | "manifest";

export interface DriveTransferJob {
  key: string;
  jobId: string;
  songId: string;
  ownerAccountId: string;
  sourceAudioHash: string;
  revisionId: string;
  artifactRole: DriveArtifactRole;
  fileName: string;
  targetFolderId: string;
  totalBytes: number;
  confirmedUploadedBytes: number;
  status: DriveTransferJobStatus;
  remoteFileId?: string;
  checksumSha256?: string;
  errorMessage?: string;
  updatedAt: number;
}

export type DrivePickerInspectionItem = PickedDriveFile;
