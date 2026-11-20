import type { DriveTransferJob } from "../google/driveTransferTypes.ts";
import {
  DRIVE_TRANSFER_ACCOUNT_INDEX,
  DRIVE_TRANSFER_SONG_INDEX,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  idbRequestPromise,
  withIdbTransaction,
} from "./indexedDb.ts";

/**
 * 儲存各 Google 帳戶隔離的 .loopHarmonizer 專用資料夾 ID。
 * 絕不保存 Access Token 或 Refresh Token。
 */
export interface PersistedDriveAccountRecord {
  key: string;
  accountId: string;
  rootFolderId: string;
  songsFolderId: string;
  sessionsFolderId: string;
  projectsFolderId?: string;
  updatedAt: number;
}

export async function getPersistedDriveAccountFolders(
  accountId: string,
): Promise<PersistedDriveAccountRecord | null> {
  if (!accountId) return null;
  return idbGet<PersistedDriveAccountRecord>("driveAccounts", accountId);
}

export async function savePersistedDriveAccountFolders(
  record: Omit<PersistedDriveAccountRecord, "key">,
): Promise<PersistedDriveAccountRecord> {
  const full: PersistedDriveAccountRecord = {
    key: record.accountId,
    accountId: record.accountId,
    rootFolderId: record.rootFolderId,
    songsFolderId: record.songsFolderId,
    sessionsFolderId: record.sessionsFolderId,
    projectsFolderId: record.projectsFolderId,
    updatedAt: record.updatedAt,
  };
  await idbPut("driveAccounts", full);
  return full;
}

export async function clearPersistedDriveAccountFolders(accountId: string): Promise<void> {
  if (!accountId) return;
  await idbDelete("driveAccounts", accountId);
}

/** 儲存上傳任務中繼資料（絕不含 accessToken 或 Resumable Session URI）。 */
export async function saveDriveTransferJob(job: DriveTransferJob): Promise<DriveTransferJob> {
  const sanitized: DriveTransferJob = {
    key: job.jobId,
    jobId: job.jobId,
    songId: job.songId,
    ownerAccountId: job.ownerAccountId,
    sourceAudioHash: job.sourceAudioHash,
    revisionId: job.revisionId,
    artifactRole: job.artifactRole,
    fileName: job.fileName,
    targetFolderId: job.targetFolderId,
    totalBytes: job.totalBytes,
    confirmedUploadedBytes: job.confirmedUploadedBytes,
    status: job.status,
    remoteFileId: job.remoteFileId,
    checksumSha256: job.checksumSha256,
    errorMessage: job.errorMessage,
    updatedAt: job.updatedAt,
  };
  await idbPut("driveTransfers", sanitized);
  return sanitized;
}

export async function getDriveTransferJob(jobId: string): Promise<DriveTransferJob | null> {
  if (!jobId) return null;
  return idbGet<DriveTransferJob>("driveTransfers", jobId);
}

export async function getDriveTransferJobsByAccount(
  ownerAccountId: string,
): Promise<DriveTransferJob[]> {
  if (!ownerAccountId) return [];
  return withIdbTransaction("driveTransfers", "readonly", async (tx) => {
    const store = tx.objectStore("driveTransfers");
    if (
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(DRIVE_TRANSFER_ACCOUNT_INDEX))
    ) {
      const rows = (await idbRequestPromise(
        store.index(DRIVE_TRANSFER_ACCOUNT_INDEX).getAll(ownerAccountId),
      )) as DriveTransferJob[];
      return rows.filter((row) => row.ownerAccountId === ownerAccountId);
    }
    const all = (await idbRequestPromise(store.getAll())) as DriveTransferJob[];
    return all.filter((row) => row.ownerAccountId === ownerAccountId);
  });
}

export async function getDriveTransferJobsBySong(
  songId: string,
  ownerAccountId?: string,
): Promise<DriveTransferJob[]> {
  if (!songId) return [];
  return withIdbTransaction("driveTransfers", "readonly", async (tx) => {
    const store = tx.objectStore("driveTransfers");
    const rows =
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(DRIVE_TRANSFER_SONG_INDEX))
        ? ((await idbRequestPromise(
            store.index(DRIVE_TRANSFER_SONG_INDEX).getAll(songId),
          )) as DriveTransferJob[])
        : ((await idbRequestPromise(store.getAll())) as DriveTransferJob[]).filter(
            (row) => row.songId === songId,
          );
    return ownerAccountId
      ? rows.filter((row) => row.ownerAccountId === ownerAccountId)
      : rows;
  });
}

export async function getAllDriveTransferJobs(): Promise<DriveTransferJob[]> {
  return idbGetAll<DriveTransferJob>("driveTransfers");
}

export async function deleteDriveTransferJob(jobId: string): Promise<void> {
  if (!jobId) return;
  await idbDelete("driveTransfers", jobId);
}

/**
 * 傳輸使用中的 Chunk 保護登錄表：
 * 確保 Google Drive 上傳讀取分段 WAV 期間，本機不會誤刪或 GC 正在讀取的 separationChunks。
 */
class TransferChunkPinRegistry {
  private readonly pinsByTask = new Map<string, Set<string>>();

  pinTask(taskId: string, transferId: string): void {
    if (!taskId || !transferId) return;
    let set = this.pinsByTask.get(taskId);
    if (!set) {
      set = new Set();
      this.pinsByTask.set(taskId, set);
    }
    set.add(transferId);
  }

  unpinTask(taskId: string, transferId: string): void {
    if (!taskId || !transferId) return;
    const set = this.pinsByTask.get(taskId);
    if (!set) return;
    set.delete(transferId);
    if (set.size === 0) {
      this.pinsByTask.delete(taskId);
    }
  }

  isTaskPinned(taskId: string): boolean {
    const set = this.pinsByTask.get(taskId);
    return Boolean(set && set.size > 0);
  }

  getPinnedTaskIds(): string[] {
    return Array.from(this.pinsByTask.keys());
  }

  clearAllForTests(): void {
    this.pinsByTask.clear();
  }
}

export const sharedTransferChunkPinRegistry = new TransferChunkPinRegistry();

export function pinTaskForDriveTransfer(taskId: string, transferId: string): void {
  sharedTransferChunkPinRegistry.pinTask(taskId, transferId);
}

export function unpinTaskForDriveTransfer(taskId: string, transferId: string): void {
  sharedTransferChunkPinRegistry.unpinTask(taskId, transferId);
}

export function isTaskPinnedByDriveTransfer(taskId: string): boolean {
  return sharedTransferChunkPinRegistry.isTaskPinned(taskId);
}

export function getPinnedDriveTransferTaskIds(): string[] {
  return sharedTransferChunkPinRegistry.getPinnedTaskIds();
}
