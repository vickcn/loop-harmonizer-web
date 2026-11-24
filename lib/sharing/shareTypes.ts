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
};

export type SharedArtifactDescriptor = {
  role: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
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
