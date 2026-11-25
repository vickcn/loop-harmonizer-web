import type { BandProject, ProjectSongEntry } from "../projects/projectTypes.ts";

export const PROJECT_SHARE_SCHEMA_VERSION = 1;
export const PROJECT_SHARE_APPLICATION_ID = "loop-harmonizer" as const;

export type ProjectShareVisibility = "private" | "restricted" | "link";

export type ProjectShareStatus =
  | "preparing"
  | "copying"
  | "uploading"
  | "granting_permission"
  | "validating"
  | "published"
  | "updating"
  | "revoking"
  | "revoked"
  | "error";

export type ShareAclVerification = "verified" | "mismatch" | "incomplete" | "unknown";
export type ShareOperationKind = "publish" | "update_revision" | "update_acl" | "repair" | "revoke";

export type ProjectShareRecipient = {
  email: string;
  permissionId: string;
  role: "reader";
  type: "user" | "group";
  createdAt: string;
};

export type ProjectShareRecord = {
  key: string;
  schemaVersion: 1;
  shareId: string;
  sourceProjectId: string;
  ownerAccountId: string;
  visibility: ProjectShareVisibility;
  status: ProjectShareStatus;
  operationGeneration: number;
  sourceProjectRevision: number;
  publishedRevisionId: string;
  shareFolderId?: string;
  revisionsFolderId?: string;
  shareManifestFileId?: string;
  currentRevisionManifestFileId?: string;
  recipients: ProjectShareRecipient[];
  anyonePermissionId?: string;
  estimatedBytes: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastError?: string;
  requiresPermissionRepair?: boolean;
  aclVerification?: ShareAclVerification;
  operationId?: string;
  operationKind?: ShareOperationKind;
  operationStartedAt?: string;
  operationStage?: ProjectShareStatus;
  pointerUpdatedInOperation?: boolean;
  targetPublishedRevisionId?: string;
  remotePointerVersion?: string;
  revocationGeneration?: number;
  revokedOperationId?: string;
  recoveredFromDriveAt?: string;
  discoveryComplete?: boolean;
};

export type SharedArtifactDescriptor = {
  role: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  checksumAlgorithm?: "sha256" | "md5";
  md5Checksum?: string;
  sourceAudioHash: string;
  separationMode: "two_stem" | "four_stem";
  modelVersion: string;
  processingVersion: string;
  pcmFormat: "wav-float32" | "wav-pcm16";
  sampleRate: number;
  channelCount: 2;
  totalSamples: number;
  artifactRevision: string;
};

export type SharedProjectSong = {
  entry: ProjectSongEntry;
  manifestFileId: string;
  artifacts: SharedArtifactDescriptor[];
  artifactRevision: string;
};

export type ProjectShareManifest = {
  schemaVersion: 1;
  application: "loop-harmonizer";
  kind: "project-share-revision";
  shareId: string;
  sourceProjectId: string;
  ownerAccountId: string;
  publishedRevisionId: string;
  sourceProjectRevision: number;
  project: BandProject;
  songs: SharedProjectSong[];
  includeOriginalAudio: false;
  createdAt: string;
};

export type ProjectSharePointer = {
  schemaVersion: 1;
  application: "loop-harmonizer";
  kind: "project-share-pointer";
  shareId: string;
  sourceProjectId: string;
  ownerAccountId: string;
  visibility: Exclude<ProjectShareVisibility, "private">;
  publishedRevisionId: string;
  revisionManifestFileId: string;
  projectName: string;
  songCount: number;
  updatedAt: string;
};

export type ProjectSharePreflightIssue = {
  entryId: string;
  songName: string;
  code:
    | "missing_source_hash"
    | "separation_incomplete"
    | "missing_manifest"
    | "manifest_invalid"
    | "artifact_invalid"
    | "source_redistribution_blocked";
  message: string;
};

export type ProjectSharePreflightResult = {
  ok: boolean;
  estimatedBytes: number;
  issues: ProjectSharePreflightIssue[];
};

export type ShareRevokeResult = {
  revoked: boolean;
  remainingExternalPermissions: Array<{
    id: string;
    type: string;
    role: string;
    emailAddress?: string;
    inherited: boolean;
  }>;
};

export type ShareAclReconciliationResult = {
  verification: ShareAclVerification;
  recipients: ProjectShareRecipient[];
  anyonePermissionId?: string;
  permissions: Array<{
    id: string;
    type: string;
    role: string;
    emailAddress?: string;
    inherited: boolean;
  }>;
  addedPermissionIds: string[];
  removedPermissionIds: string[];
};

export type ProjectShareDiscoveryResult = {
  shares: ProjectShareRecord[];
  complete: boolean;
  errorMessage?: string;
};
