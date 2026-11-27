import type { PersistedProjectRecord } from "../projects/projectTypes.ts";
import type { BandSong } from "../band/bandTypes.ts";

export type CloudTaskKind = "project_sync" | "original_backup" | "stem_export" | "share_publish";

export type CloudTaskStatus =
  | "queued" | "preparing" | "running" | "pausing" | "paused"
  | "waiting_network" | "waiting_auth" | "waiting_resources" | "recovering"
  | "completed" | "failed" | "cancelling" | "cancelled";

export type CloudTaskDescriptor = {
  project_sync: { projectId: string; snapshotRevision: string; projectSnapshot?: PersistedProjectRecord };
  original_backup: { projectId?: string; songId: string; sourceAudioHash: string; persistedAudioBlobKey: string };
  stem_export: { projectId?: string; songId: string; sourceAudioHash: string; artifactRevision: string; checkpointTaskId?: string; transferJobIds?: string[]; songSnapshot?: BandSong; selection: { format: "wav-float32" | "wav-pcm16"; selectedStemRoles: Array<"vocals" | "drums" | "bass" | "other" | "instrumental">; includeSessionJson: boolean; includeCustomMix: boolean; forceNewRevision: boolean } };
  share_publish: { projectId: string; shareId: string; snapshotRevision: string; projectSnapshot?: PersistedProjectRecord; visibility: "restricted" | "link"; recipientEmails: string[] };
};

export type CloudTaskRecord<K extends CloudTaskKind = CloudTaskKind> = {
  key: string;
  taskId: string;
  kind: K;
  status: CloudTaskStatus;
  ownerAccountId: string;
  projectId?: string;
  projectName?: string;
  songId?: string;
  songName?: string;
  shareId?: string;
  intentId: string;
  snapshotRevision?: string;
  descriptor: CloudTaskDescriptor[K];
  stage: string;
  currentFileName?: string;
  completedBytes: number;
  totalBytes?: number;
  completedFiles?: number;
  totalFiles?: number;
  retryCount: number;
  nextRetryAt?: number;
  operationGeneration: number;
  leaseOwnerId?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  pausedAt?: number;
  cancelledAt?: number;
  errorCode?: string;
  errorMessage?: string;
};

export type CloudTaskProgressPatch = Pick<CloudTaskRecord, "stage"> & Partial<Pick<CloudTaskRecord,
  "completedBytes" | "totalBytes" | "completedFiles" | "totalFiles" | "currentFileName"
>>;

export type CloudTaskExecutionResult =
  | { status: "completed"; stage?: string }
  | { status: "waiting_auth" | "waiting_network" | "waiting_resources" | "paused"; stage: string; errorMessage?: string }
  | { status: "failed"; stage: string; errorCode?: string; errorMessage: string; retryable: boolean; retryAfterMs?: number };

export type CloudTaskExecutorContext = {
  signal: AbortSignal;
  accessToken: string;
  accountGeneration: number;
  isAccountGenerationValid: () => boolean;
  updateProgress: (patch: CloudTaskProgressPatch) => Promise<void>;
};

export type CloudTaskExecutor<K extends CloudTaskKind = CloudTaskKind> = (
  task: CloudTaskRecord<K>,
  context: CloudTaskExecutorContext,
) => Promise<CloudTaskExecutionResult>;

export const TERMINAL_CLOUD_TASK_STATUSES = new Set<CloudTaskStatus>(["completed", "failed", "cancelled"]);
export const HEAVY_CLOUD_TASK_KINDS = new Set<CloudTaskKind>(["original_backup", "stem_export", "share_publish"]);
