import type { UploadByteSource } from "../google/driveResumableUpload.ts";
import { uploadChunkedResumable } from "../google/driveResumableUpload.ts";
import {
  DriveApiError,
  deleteAppManagedDriveFile,
  downloadDriveJson,
  getDriveFileMetadata,
  listDriveFiles,
  uploadDriveMultipartJson,
} from "../google/driveClient.ts";
import {
  LOOP_HARMONIZER_APP_TAG,
  buildStableSongFolderKey,
  ensureProjectFolder,
  ensureSongOriginalsFolder,
  listManagedProjects,
} from "../google/driveFolderManager.ts";
import type { WebLockAdapter } from "../separation/separationResumeController.ts";
import {
  getProjectRecord,
  isProjectDeleted,
  saveProjectRecord,
  saveProjectSyncJob,
} from "../storage/projectStore.ts";
import {
  computeProjectBackupSummary,
  generateRevisionToken,
  validateProjectDocument,
} from "./projectModel.ts";
import type {
  BandProject,
  PersistedProjectRecord,
  ProjectConflictInfo,
  ProjectListEntrySummary,
  ProjectSongOriginalBackupRef,
} from "./projectTypes.ts";

export const PROJECT_SYNC_LOCAL_DEBOUNCE_MS = 500;
export const PROJECT_SYNC_DRIVE_DEBOUNCE_MS = 4000;
export const PROJECT_SYNC_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000] as const;
export const PROJECT_SYNC_MAX_RETRIES = 3;

export const DRIVE_CAS_LIMITATION_NOTE =
  "Google Drive API files.update 未提供針對應用程式自訂版本號之跨裝置原子 CAS；Loop Harmonizer 採用不可變 revisions/ 快照、寫前版本檢查、寫後回讀驗證及非破壞性衝突快照防止靜默覆寫。";

export type ProjectDriveSyncOutcome =
  | {
      status: "synced";
      record: PersistedProjectRecord;
      driveVersion?: string | null;
      immutableRevisionFileId: string;
    }
  | {
      status: "remote_ahead";
      record: PersistedProjectRecord;
      remoteProject: BandProject;
      driveVersion?: string | null;
    }
  | {
      status: "conflict";
      record: PersistedProjectRecord;
      conflictInfo: ProjectConflictInfo;
    }
  | {
      status: "waiting_auth";
      record: PersistedProjectRecord;
      errorMessage: string;
    }
  | {
      status: "cancelled";
      reason: string;
    }
  | {
      status: "error";
      record: PersistedProjectRecord;
      retryable: boolean;
      errorMessage: string;
    };

function buildSafeProjectDocumentForCloud(
  project: BandProject,
  accountId: string,
): BandProject {
  // 嚴格排除任何本機私有暫態欄位或憑證，並重算真實 backupSummary
  return {
    ...project,
    storageProvider: "google_drive",
    ownerAccountId: accountId,
    backupSummary: computeProjectBackupSummary(project.songs, accountId),
  };
}

function isRemoteChangedSinceBase(params: {
  remoteProject: BandProject;
  baseRevision: number;
  baseRevisionToken?: string;
}): boolean {
  if (params.remoteProject.revision > params.baseRevision) return true;
  if (
    params.baseRevisionToken &&
    params.remoteProject.revisionToken &&
    params.remoteProject.revisionToken !== params.baseRevisionToken
  ) {
    return true;
  }
  return false;
}

/**
 * 將專案保存至 Google Drive（採用不可變 Revision 檔案 + 寫前/寫後衝突檢查）。
 */
export async function saveProjectToDrive(params: {
  record: PersistedProjectRecord;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  forceReplaceRemote?: boolean;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<ProjectDriveSyncOutcome> {
  const { record, accountId, accessToken } = params;

  if (!params.isGenerationValid(params.generation, accountId)) {
    return { status: "cancelled", reason: "Google 帳戶授權工作階段已變更。" };
  }
  if (
    record.project.storageProvider !== "google_drive" ||
    !record.ownerAccountId ||
    record.ownerAccountId !== accountId ||
    (record.project.ownerAccountId && record.project.ownerAccountId !== accountId)
  ) {
    return { status: "cancelled", reason: "專案擁有帳戶與目前登入 Google 帳號不符，已阻止跨帳戶上傳。" };
  }
  if (await isProjectDeleted(record.projectId)) {
    return { status: "cancelled", reason: "專案已於本機刪除，中止背景雲端同步。" };
  }

  try {
    const folders = await ensureProjectFolder({
      accountId,
      accessToken,
      projectId: record.projectId,
      driveFolderId: record.project.driveFolderId,
      includeRevisionsFolder: true,
      signal: params.signal,
      lockAdapter: params.lockAdapter,
      fetchImpl: params.fetchImpl,
    });

    if (!params.isGenerationValid(params.generation, accountId)) {
      return { status: "cancelled", reason: "授權工作階段已切換。" };
    }

    let targetFileId = record.project.driveProjectFileId;

    // 若紀錄上沒有 fileId，先查詢該專案資料夾內是否已存在 project.json（例如跨裝置或上次中斷後建立）
    if (!targetFileId) {
      const safeFolder = folders.projectFolderId.replace(/'/g, "");
      const safeProj = record.projectId.replace(/'/g, "");
      const safeAcc = accountId.replace(/'/g, "");
      const existingFiles = await listDriveFiles({
        accessToken,
        q: `'${safeFolder}' in parents and trashed=false and appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' } and appProperties has { key='lhRole' and value='project_json' } and appProperties has { key='lhAccountId' and value='${safeAcc}' } and appProperties has { key='lhProjectId' and value='${safeProj}' }`,
        pageSize: 3,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (existingFiles.files[0]?.id) {
        targetFileId = existingFiles.files[0].id;
      }
    }

    let remoteProject: BandProject | null = null;
    let remoteDriveVersion: string | null = null;

    if (targetFileId) {
      let remoteMissing = false;
      try {
        const meta = await getDriveFileMetadata(targetFileId, {
          accessToken,
          fields: "id,name,trashed,version,modifiedTime,appProperties",
          fileName: "project.json",
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        if (meta.trashed) {
          remoteMissing = true;
        } else {
          remoteDriveVersion =
            meta.version !== undefined ? String(meta.version) : null;
          const rawRemote = await downloadDriveJson<unknown>({
            fileId: targetFileId,
            accessToken,
            fileName: "project.json",
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          });
          const validation = validateProjectDocument(rawRemote, {
            expectedAccountId: accountId,
          });
          if (validation.valid && validation.project) {
            remoteProject = validation.project;
          }
        }
      } catch (err) {
        if (err instanceof DriveApiError && (err.code === "not_found" || err.code === "trashed")) {
          remoteMissing = true;
        } else {
          throw err;
        }
      }

      if (remoteMissing && !params.forceReplaceRemote) {
        const conflictInfo: ProjectConflictInfo = {
          detectedAt: Date.now(),
          kind: "remote_deleted",
          localRevision: record.localRevision,
          localRevisionToken: record.project.revisionToken,
          localBaseRevision: record.localBaseRevision,
          remoteRevision: record.lastSyncedRemoteRevision ?? 0,
          remoteRevisionToken: record.lastSyncedRemoteRevisionToken ?? "",
          remoteProjectSnapshot: null,
          reason:
            "遠端 Google Drive 中的此專案檔案已不存在或已被移至垃圾桶，為防止意外重建請確認處理方式。",
        };
        const updatedRecord: PersistedProjectRecord = {
          ...record,
          syncStatus: "conflict",
          conflictInfo,
          lastError: conflictInfo.reason,
        };
        await saveProjectRecord(updatedRecord, { lockAdapter: params.lockAdapter });
        return { status: "conflict", record: updatedRecord, conflictInfo };
      }

      if (remoteProject && !params.forceReplaceRemote) {
        const baseRev = record.lastSyncedRemoteRevision ?? record.localBaseRevision;
        const baseToken = record.lastSyncedRemoteRevisionToken ?? record.localBaseRevisionToken;
        const remoteAhead = isRemoteChangedSinceBase({
          remoteProject,
          baseRevision: baseRev,
          baseRevisionToken: baseToken,
        });

        if (remoteAhead && !record.dirty) {
          const updatedRecord: PersistedProjectRecord = {
            ...record,
            lastKnownRemoteRevision: remoteProject.revision,
            lastKnownRemoteRevisionToken: remoteProject.revisionToken,
            lastKnownRemoteDriveVersion: remoteDriveVersion,
          };
          return {
            status: "remote_ahead",
            record: updatedRecord,
            remoteProject,
            driveVersion: remoteDriveVersion,
          };
        }

        if (remoteAhead && record.dirty) {
          // 絕不覆寫遠端變更：先把本機衝突版本作為不可變衝突快照保存至 revisions/
          let conflictSnapshotFileId: string | undefined;
          if (folders.projectRevisionsFolderId) {
            const conflictFile = await uploadDriveMultipartJson({
              accessToken,
              name: `conflict_${Date.now()}_${record.project.revisionToken}.json`,
              parentId: folders.projectRevisionsFolderId,
              payload: buildSafeProjectDocumentForCloud(record.project, accountId),
              appProperties: {
                lhApp: LOOP_HARMONIZER_APP_TAG,
                lhRole: "project_conflict",
                lhAccountId: accountId,
                lhProjectId: record.projectId,
                lhRevisionToken: record.project.revisionToken,
              },
              signal: params.signal,
              fetchImpl: params.fetchImpl,
            }).catch(() => null);
            conflictSnapshotFileId = conflictFile?.id;
          }

          const conflictInfo: ProjectConflictInfo = {
            detectedAt: Date.now(),
            kind: "diverged",
            localRevision: record.localRevision,
            localRevisionToken: record.project.revisionToken,
            localBaseRevision: baseRev,
            remoteRevision: remoteProject.revision,
            remoteRevisionToken: remoteProject.revisionToken,
            remoteUpdatedAt: remoteProject.updatedAt,
            remoteProjectSnapshot: remoteProject,
            conflictSnapshotFileId,
            reason: `偵測到跨裝置編輯衝突：雲端版本已更新為 r${remoteProject.revision}，同時本機仍有未同步修改（r${record.localRevision}，基準 r${baseRev}）。`,
          };
          const updatedRecord: PersistedProjectRecord = {
            ...record,
            syncStatus: "conflict",
            lastKnownRemoteRevision: remoteProject.revision,
            lastKnownRemoteRevisionToken: remoteProject.revisionToken,
            lastKnownRemoteDriveVersion: remoteDriveVersion,
            conflictInfo,
            lastError: conflictInfo.reason,
          };
          await saveProjectRecord(updatedRecord, { lockAdapter: params.lockAdapter });
          return { status: "conflict", record: updatedRecord, conflictInfo };
        }
      }
    }

    if (!params.isGenerationValid(params.generation, accountId)) {
      return { status: "cancelled", reason: "授權工作階段已變更，已於寫入前中止。" };
    }
    if (await isProjectDeleted(record.projectId)) {
      return { status: "cancelled", reason: "專案已於本機刪除，中止寫入。" };
    }

    // 若強制取代遠端且遠端本來被刪掉，需清掉舊的 fileId 以便重新 POST
    if (params.forceReplaceRemote && targetFileId && !remoteProject) {
      targetFileId = undefined;
    }

    const baseVersionForNext = remoteProject
      ? Math.max(record.localRevision, remoteProject.revision)
      : record.localRevision;
    const nextRevision =
      record.lastSyncedRemoteRevision === null && !remoteProject
        ? Math.max(1, record.localRevision)
        : params.forceReplaceRemote && remoteProject
          ? baseVersionForNext + 1
          : Math.max(record.localRevision, (remoteProject?.revision ?? 0) + (record.dirty ? 1 : 0));
    const nextToken = generateRevisionToken(nextRevision);
    const parentToken =
      remoteProject?.revisionToken ??
      record.lastSyncedRemoteRevisionToken ??
      record.project.parentRevisionId;

    const preparedProject: BandProject = buildSafeProjectDocumentForCloud(
      {
        ...record.project,
        driveFolderId: folders.projectFolderId,
        driveRevisionsFolderId: folders.projectRevisionsFolderId,
        driveProjectFileId: targetFileId,
        revision: nextRevision,
        revisionToken: nextToken,
        parentRevisionId: parentToken,
        updatedAt: new Date().toISOString(),
      },
      accountId,
    );

    // 階段 1：先寫入不可變 Revision 快照至 revisions/
    const revFile = await uploadDriveMultipartJson({
      accessToken,
      name: `rev_${nextRevision}_${nextToken}.json`,
      parentId: folders.projectRevisionsFolderId || folders.projectFolderId,
      payload: preparedProject,
      appProperties: {
        lhApp: LOOP_HARMONIZER_APP_TAG,
        lhRole: "project_revision",
        lhAccountId: accountId,
        lhProjectId: record.projectId,
        lhProjectRevision: String(nextRevision),
        lhRevisionToken: nextToken,
      },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    // 階段 2：更新或建立主索引 project.json
    const uploadedMain = await uploadDriveMultipartJson({
      accessToken,
      name: "project.json",
      parentId: folders.projectFolderId,
      existingFileId: targetFileId,
      payload: {
        ...preparedProject,
        driveProjectFileId: targetFileId,
      },
      appProperties: {
        lhApp: LOOP_HARMONIZER_APP_TAG,
        lhRole: "project_json",
        lhAccountId: accountId,
        lhProjectId: record.projectId,
        lhProjectRevision: String(nextRevision),
        lhRevisionToken: nextToken,
      },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    // 階段 3：寫後回讀驗證（檢查寫入期間是否遭其他裝置同時寫入不同 revisionToken）
    const verifyMeta = await getDriveFileMetadata(uploadedMain.id, {
      accessToken,
      fields: "id,version,modifiedTime,appProperties",
      fileName: "project.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }).catch(() => null);

    if (
      verifyMeta?.appProperties?.lhRevisionToken &&
      verifyMeta.appProperties.lhRevisionToken !== nextToken
    ) {
      const winnerDoc = await downloadDriveJson<unknown>({
        fileId: uploadedMain.id,
        accessToken,
        fileName: "project.json",
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      }).catch(() => null);
      const parsedWinner = validateProjectDocument(winnerDoc, {
        expectedAccountId: accountId,
      }).project ?? null;

      const conflictInfo: ProjectConflictInfo = {
        detectedAt: Date.now(),
        kind: "diverged",
        localRevision: nextRevision,
        localRevisionToken: nextToken,
        localBaseRevision: record.localBaseRevision,
        remoteRevision: parsedWinner?.revision ?? nextRevision,
        remoteRevisionToken: verifyMeta.appProperties.lhRevisionToken,
        remoteUpdatedAt: parsedWinner?.updatedAt,
        remoteProjectSnapshot: parsedWinner,
        conflictSnapshotFileId: revFile.id,
        reason:
          "寫入期間另有其他裝置同時更新同一專案，雙方版本已分別保存於 revisions/，請選擇如何處理衝突。",
      };
      const conflictRec: PersistedProjectRecord = {
        ...record,
        project: {
          ...preparedProject,
          driveProjectFileId: uploadedMain.id,
        },
        syncStatus: "conflict",
        conflictInfo,
        lastError: conflictInfo.reason,
      };
      await saveProjectRecord(conflictRec, { lockAdapter: params.lockAdapter });
      return { status: "conflict", record: conflictRec, conflictInfo };
    }

    const finalProject: BandProject = {
      ...preparedProject,
      driveProjectFileId: uploadedMain.id,
    };
    const finalVersion =
      verifyMeta?.version !== undefined
        ? String(verifyMeta.version)
        : uploadedMain.version !== undefined
          ? String(uploadedMain.version)
          : null;

    const syncedRecord: PersistedProjectRecord = {
      ...record,
      ownerAccountId: accountId,
      project: finalProject,
      localBaseRevision: nextRevision,
      localBaseRevisionToken: nextToken,
      localRevision: nextRevision,
      lastSyncedRemoteRevision: nextRevision,
      lastSyncedRemoteRevisionToken: nextToken,
      lastKnownRemoteRevision: nextRevision,
      lastKnownRemoteRevisionToken: nextToken,
      lastKnownRemoteDriveVersion: finalVersion,
      dirty: false,
      syncStatus: "synced",
      lastSavedAt: Date.now(),
      lastSyncedAt: Date.now(),
      lastError: null,
      conflictInfo: null,
    };

    const saveRes = await saveProjectRecord(syncedRecord, {
      lockAdapter: params.lockAdapter,
    });
    if (!saveRes.saved) {
      return { status: "cancelled", reason: "專案已於同步完成前被刪除。" };
    }

    return {
      status: "synced",
      record: saveRes.record,
      driveVersion: finalVersion,
      immutableRevisionFileId: revFile.id,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "cancelled", reason: "雲端同步已中止。" };
    }
    if (err instanceof DriveApiError && err.code === "unauthorized") {
      const waitingRec: PersistedProjectRecord = {
        ...record,
        syncStatus: "waiting_auth",
        lastError: "Google 授權已過期，重新授權後可繼續同步（本機編輯已完整保留）。",
      };
      await saveProjectRecord(waitingRec, { lockAdapter: params.lockAdapter }).catch(() => undefined);
      return {
        status: "waiting_auth",
        record: waitingRec,
        errorMessage: waitingRec.lastError!,
      };
    }
    const retryable =
      err instanceof DriveApiError ? err.retryable : !(err instanceof SyntaxError);
    const msg = err instanceof Error ? err.message : "Google Drive 同步專案失敗。";
    const errRec: PersistedProjectRecord = {
      ...record,
      syncStatus: "error",
      lastError: msg,
    };
    await saveProjectRecord(errRec, { lockAdapter: params.lockAdapter }).catch(() => undefined);
    return {
      status: "error",
      record: errRec,
      retryable,
      errorMessage: msg,
    };
  }
}

export async function loadProjectFromDrive(params: {
  projectFileId: string;
  expectedAccountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ project: BandProject; driveVersion?: string | null }> {
  const [meta, raw] = await Promise.all([
    getDriveFileMetadata(params.projectFileId, {
      accessToken: params.accessToken,
      fields: "id,name,trashed,version,modifiedTime,parents,appProperties",
      fileName: "project.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
    downloadDriveJson<unknown>({
      fileId: params.projectFileId,
      accessToken: params.accessToken,
      fileName: "project.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
  ]);

  if (meta.trashed) {
    throw new Error("此 Google Drive 專案已被移至垃圾桶。");
  }
  const validation = validateProjectDocument(raw, {
    expectedAccountId: params.expectedAccountId,
  });
  if (!validation.valid || !validation.project) {
    throw new Error(`無法載入雲端專案：${validation.reasons.join("；")}`);
  }
  const project: BandProject = {
    ...validation.project,
    storageProvider: "google_drive",
    ownerAccountId: params.expectedAccountId,
    driveProjectFileId: meta.id,
    driveFolderId: validation.project.driveFolderId || meta.parents?.[0],
  };
  return {
    project,
    driveVersion: meta.version !== undefined ? String(meta.version) : null,
  };
}

/**
 * 列出目前登入帳戶於 Google Drive `.loopHarmonizer/projects/` 內管理的全部專案 Metadata（僅讀小型 JSON，不下載 WAV）。
 */
export async function listCloudProjects(params: {
  accountId: string;
  accessToken: string;
  strict?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Array<{ project: BandProject; driveVersion?: string | null }>> {
  const entries = await listManagedProjects({
    accountId: params.accountId,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const results: Array<{ project: BandProject; driveVersion?: string | null }> = [];
  for (const entry of entries) {
    if (params.signal?.aborted) break;
    if (!entry.projectFileId) continue;
    try {
      const loaded = await loadProjectFromDrive({
        projectFileId: entry.projectFileId,
        expectedAccountId: params.accountId,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (loaded.project.ownerAccountId === params.accountId) {
        results.push(loaded);
      }
    } catch (err) {
      if (params.strict) {
        throw err;
      }
      // 非嚴格清單載入時略過單一損壞或跨帳戶項目
    }
  }
  return results;
}

export async function deleteCloudProject(params: {
  projectId: string;
  driveFolderId?: string;
  driveProjectFileId?: string;
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ deletedFolderId?: string; deletedFileId?: string }> {
  if (params.driveFolderId) {
    await deleteAppManagedDriveFile({
      fileId: params.driveFolderId,
      accessToken: params.accessToken,
      fileName: `project_${params.projectId}`,
      expectedRole: "project",
      expectedAccountId: params.accountId,
      expectedProjectId: params.projectId,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    return { deletedFolderId: params.driveFolderId };
  }

  const managed = await listManagedProjects({
    accountId: params.accountId,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  const target = managed.find((m) => m.projectId === params.projectId);
  if (target?.projectFolderId) {
    await deleteAppManagedDriveFile({
      fileId: target.projectFolderId,
      accessToken: params.accessToken,
      fileName: target.projectFolderName,
      expectedRole: "project",
      expectedAccountId: params.accountId,
      expectedProjectId: params.projectId,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    return { deletedFolderId: target.projectFolderId };
  }

  if (params.driveProjectFileId) {
    await deleteAppManagedDriveFile({
      fileId: params.driveProjectFileId,
      accessToken: params.accessToken,
      fileName: "project.json",
      expectedRole: "project_json",
      expectedAccountId: params.accountId,
      expectedProjectId: params.projectId,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    return { deletedFileId: params.driveProjectFileId };
  }

  return {};
}

/**
 * 將本機原始音檔備份至 Google Drive `.loopHarmonizer/songs/song_<hash>/originals/<fileName>`：
 * - 若相同 sourceAudioHash 與大小檔案已完整存在於同帳戶 originals/，重用既有 Drive File ID。
 * - 使用分段 Resumable Upload，不更改歌曲原本之 sourceAudioHash。
 */
export async function backupLocalOriginalAudioToDrive(params: {
  file: Blob;
  fileName: string;
  mimeType: string;
  sourceAudioHash: string;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  onAuthExpired?: () => void;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<ProjectSongOriginalBackupRef> {
  if (!params.isGenerationValid(params.generation, params.accountId)) {
    throw new Error("Google 帳號狀態已變更，無法備份原始音檔。");
  }
  const stableSongKey = buildStableSongFolderKey(params.sourceAudioHash);
  const folders = await ensureSongOriginalsFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    stableSongKey,
    signal: params.signal,
    lockAdapter: params.lockAdapter,
    fetchImpl: params.fetchImpl,
  });

  const totalBytes = params.file.size;
  const safeParent = folders.originalsFolderId.replace(/'/g, "");
  const safeHash = params.sourceAudioHash.slice(0, 64).replace(/'/g, "");
  const safeAcc = params.accountId.replace(/'/g, "");
  const existing = await listDriveFiles({
    accessToken: params.accessToken,
    q: `'${safeParent}' in parents and trashed=false and appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' } and appProperties has { key='lhAccountId' and value='${safeAcc}' } and appProperties has { key='lhSourceAudioHash' and value='${safeHash}' }`,
    pageSize: 5,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  const reused = existing.files.find((f) => f.id && Number(f.size ?? 0) === totalBytes);
  if (reused) {
    params.onProgress?.(totalBytes, totalBytes);
    return {
      driveFileId: reused.id,
      ownerAccountId: params.accountId,
      fileName: reused.name || params.fileName,
      mimeType: reused.mimeType || params.mimeType || "audio/mpeg",
      sizeBytes: totalBytes,
      sourceAudioHash: params.sourceAudioHash,
      backedUpAt: reused.modifiedTime || new Date().toISOString(),
    };
  }

  const byteSource: UploadByteSource = {
    totalBytes,
    async readSlice(startByte, endByte) {
      const buf = await params.file.slice(startByte, endByte).arrayBuffer();
      return new Uint8Array(buf);
    },
  };

  const res = await uploadChunkedResumable({
    jobId: `drive-orig:${params.accountId}:${params.sourceAudioHash}`,
    songId: params.sourceAudioHash,
    ownerAccountId: params.accountId,
    sourceAudioHash: params.sourceAudioHash,
    revisionId: `orig-${params.sourceAudioHash.slice(0, 16)}`,
    artifactRole: "original_audio",
    fileName: params.fileName,
    mimeType: params.mimeType || params.file.type || "audio/mpeg",
    targetFolderId: folders.originalsFolderId,
    source: byteSource,
    accessToken: params.accessToken,
    isAccountStillValid: () => params.isGenerationValid(params.generation, params.accountId),
    onAuthExpired: params.onAuthExpired,
    onProgress: (job) => params.onProgress?.(job.confirmedUploadedBytes, job.totalBytes),
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  if (res.status !== "completed" || !res.remoteFileId) {
    throw new Error(res.errorMessage || "備份原始音檔至 Google Drive 失敗。");
  }

  return {
    driveFileId: res.remoteFileId,
    ownerAccountId: params.accountId,
    fileName: params.fileName,
    mimeType: params.mimeType || params.file.type || "audio/mpeg",
    sizeBytes: totalBytes,
    sourceAudioHash: params.sourceAudioHash,
    backedUpAt: res.modifiedTime || new Date().toISOString(),
  };
}

export function buildProjectListSummary(
  record: PersistedProjectRecord,
  sourceLocation: ProjectListEntrySummary["sourceLocation"] = "local_only",
): ProjectListEntrySummary {
  const summary =
    record.project.backupSummary ??
    computeProjectBackupSummary(
      record.project.songs,
      record.ownerAccountId || undefined,
    );
  return {
    projectId: record.projectId,
    name: record.project.name,
    description: record.project.description,
    storageProvider: record.storageProvider,
    ownerAccountId: record.ownerAccountId || undefined,
    songCount: record.project.songs.length,
    updatedAt: record.project.updatedAt,
    localUpdatedAt: record.lastSavedAt,
    revision: record.localRevision,
    syncStatus: record.syncStatus,
    dirty: record.dirty,
    hasConflict: record.syncStatus === "conflict" || Boolean(record.conflictInfo),
    driveFolderId: record.project.driveFolderId,
    driveProjectFileId: record.project.driveProjectFileId,
    backupSummary: summary,
    sourceLocation,
  };
}

export interface AutoSyncTimerAdapter {
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export interface ProjectAutoSyncControllerDeps {
  localDebounceMs?: number;
  driveDebounceMs?: number;
  retryBackoffMs?: readonly number[];
  maxRetries?: number;
  timer?: AutoSyncTimerAdapter;
  isOnline?: () => boolean;
  getAuthContext: () => {
    accountId: string | null;
    accessToken: string | null;
    generation: number;
    isGenerationValid: (generation: number, accountId: string) => boolean;
    onAuthExpired?: () => void;
  };
  saveLocalFn?: (record: PersistedProjectRecord) => Promise<boolean>;
  syncDriveFn?: typeof saveProjectToDrive;
  onStatusChanged?: (projectId: string, outcome: ProjectDriveSyncOutcome | { status: "local_saved"; record: PersistedProjectRecord }) => void;
}

interface ProjectSyncSlot {
  generation: number;
  ownerAccountId: string;
  localTimer: ReturnType<typeof setTimeout> | null;
  driveTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  abortController: AbortController | null;
  pendingFollowUp: boolean;
  latestRecordSnapshot: PersistedProjectRecord | null;
  retryAttempt: number;
}

/**
 * 本機 Debounced 自動儲存 + 雲端 Google Drive 單飛合併同步控制器：
 * - 不論線上/離線一律先寫入本機 IndexedDB；
 * - 同專案同時只執行一個 Drive 同步，期間變更會標記 pendingFollowUp 待完成後合併送出；
 * - 401 進入 waiting_auth 並停止自動輪詢；帳戶切換或刪除專案立即廢止舊世代同步工作。
 */
export class ProjectAutoSyncController {
  private readonly deps: ProjectAutoSyncControllerDeps;
  private readonly timer: AutoSyncTimerAdapter;
  private readonly slots = new Map<string, ProjectSyncSlot>();
  private readonly localDebounceMs: number;
  private readonly driveDebounceMs: number;
  private readonly retryBackoffMs: readonly number[];
  private readonly maxRetries: number;

  constructor(deps: ProjectAutoSyncControllerDeps) {
    this.deps = deps;
    this.localDebounceMs = deps.localDebounceMs ?? PROJECT_SYNC_LOCAL_DEBOUNCE_MS;
    this.driveDebounceMs = deps.driveDebounceMs ?? PROJECT_SYNC_DRIVE_DEBOUNCE_MS;
    this.retryBackoffMs = deps.retryBackoffMs ?? PROJECT_SYNC_RETRY_BACKOFF_MS;
    this.maxRetries = deps.maxRetries ?? PROJECT_SYNC_MAX_RETRIES;
    this.timer = deps.timer ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
    };
  }

  private getOrCreateSlot(projectId: string, ownerAccountId: string): ProjectSyncSlot {
    let slot = this.slots.get(projectId);
    if (!slot) {
      slot = {
        generation: 1,
        ownerAccountId,
        localTimer: null,
        driveTimer: null,
        retryTimer: null,
        inFlight: null,
        abortController: null,
        pendingFollowUp: false,
        latestRecordSnapshot: null,
        retryAttempt: 0,
      };
      this.slots.set(projectId, slot);
    } else if (ownerAccountId && slot.ownerAccountId !== ownerAccountId) {
      slot.ownerAccountId = ownerAccountId;
    }
    return slot;
  }

  scheduleProjectEdit(
    record: PersistedProjectRecord,
    options?: { immediateLocal?: boolean; syncImmediately?: boolean },
  ): void {
    const slot = this.getOrCreateSlot(record.projectId, record.ownerAccountId);
    slot.latestRecordSnapshot = record;

    if (slot.localTimer !== null) {
      this.timer.clearTimeout(slot.localTimer);
      slot.localTimer = null;
    }
    if (slot.retryTimer !== null) {
      this.timer.clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
    }
    slot.retryAttempt = 0;

    const runLocalSave = async () => {
      const target = slot.latestRecordSnapshot;
      if (!target) return;
      const savedOk = this.deps.saveLocalFn
        ? await this.deps.saveLocalFn(target)
        : (await saveProjectRecord(target)).saved;
      if (!savedOk) return;
      this.deps.onStatusChanged?.(target.projectId, {
        status: "local_saved",
        record: target,
      });
    };

    if (options?.immediateLocal) {
      void runLocalSave();
    } else {
      slot.localTimer = this.timer.setTimeout(() => {
        slot.localTimer = null;
        void runLocalSave();
      }, this.localDebounceMs);
    }

    if (record.storageProvider !== "google_drive" || !record.ownerAccountId) {
      return;
    }

    if (slot.driveTimer !== null) {
      this.timer.clearTimeout(slot.driveTimer);
      slot.driveTimer = null;
    }

    if (options?.syncImmediately) {
      void this.triggerDriveSync(record.projectId);
      return;
    }

    slot.driveTimer = this.timer.setTimeout(() => {
      slot.driveTimer = null;
      void this.triggerDriveSync(record.projectId);
    }, this.driveDebounceMs);
  }

  async flushLocalSaves(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const [projectId, slot] of this.slots.entries()) {
      if (slot.localTimer !== null) {
        this.timer.clearTimeout(slot.localTimer);
        slot.localTimer = null;
        const target = slot.latestRecordSnapshot;
        if (target) {
          tasks.push(
            (async () => {
              const savedOk = this.deps.saveLocalFn
                ? await this.deps.saveLocalFn(target)
                : (await saveProjectRecord(target)).saved;
              if (savedOk) {
                this.deps.onStatusChanged?.(projectId, { status: "local_saved", record: target });
              }
            })(),
          );
        }
      }
    }
    await Promise.all(tasks);
  }

  async triggerDriveSync(
    projectId: string,
    options?: { forceReplaceRemote?: boolean },
  ): Promise<ProjectDriveSyncOutcome | null> {
    const slot = this.slots.get(projectId);
    if (slot?.inFlight) {
      slot.pendingFollowUp = true;
      await slot.inFlight;
      return null;
    }

    const latestFromDb = await getProjectRecord(projectId);
    const current = latestFromDb ?? slot?.latestRecordSnapshot ?? null;
    if (!current || current.storageProvider !== "google_drive" || !current.ownerAccountId) {
      return null;
    }
    if (await isProjectDeleted(projectId)) {
      this.invalidateProject(projectId);
      return { status: "cancelled", reason: "專案已刪除。" };
    }
    if (current.syncStatus === "conflict" && !options?.forceReplaceRemote) {
      return null;
    }

    const activeSlot = this.getOrCreateSlot(projectId, current.ownerAccountId);
    if (activeSlot.driveTimer !== null) {
      this.timer.clearTimeout(activeSlot.driveTimer);
      activeSlot.driveTimer = null;
    }
    if (activeSlot.retryTimer !== null) {
      this.timer.clearTimeout(activeSlot.retryTimer);
      activeSlot.retryTimer = null;
    }

    const auth = this.deps.getAuthContext();
    if (!auth.accountId || !auth.accessToken || auth.accountId !== current.ownerAccountId) {
      const waitingRec: PersistedProjectRecord = {
        ...current,
        syncStatus: "waiting_auth",
        lastError: "尚未登入或授權過期，等待重新授權後同步（已保存於本機）。",
      };
      await saveProjectRecord(waitingRec);
      await saveProjectSyncJob({
        projectId,
        ownerAccountId: current.ownerAccountId,
        status: "waiting_auth",
        attempts: activeSlot.retryAttempt,
        syncGeneration: activeSlot.generation,
        lastError: waitingRec.lastError ?? undefined,
        updatedAt: Date.now(),
      }).catch(() => undefined);
      const out: ProjectDriveSyncOutcome = {
        status: "waiting_auth",
        record: waitingRec,
        errorMessage: waitingRec.lastError!,
      };
      this.deps.onStatusChanged?.(projectId, out);
      return out;
    }

    const online = this.deps.isOnline
      ? this.deps.isOnline()
      : typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;
    if (!online) {
      const offlineRec: PersistedProjectRecord = {
        ...current,
        syncStatus: "dirty",
        lastError: "目前處於離線狀態，待恢復連線後將自動同步。",
      };
      await saveProjectRecord(offlineRec);
      const out: ProjectDriveSyncOutcome = {
        status: "error",
        record: offlineRec,
        retryable: true,
        errorMessage: offlineRec.lastError!,
      };
      this.deps.onStatusChanged?.(projectId, out);
      return out;
    }

    const capturedSlotGen = activeSlot.generation;
    const controller = new AbortController();
    activeSlot.abortController = controller;
    activeSlot.pendingFollowUp = false;

    const syncFn = this.deps.syncDriveFn ?? saveProjectToDrive;
    let finalOutcome: ProjectDriveSyncOutcome | null = null;

    const run = (async () => {
      await saveProjectSyncJob({
        projectId,
        ownerAccountId: current.ownerAccountId,
        status: "syncing",
        attempts: activeSlot.retryAttempt,
        syncGeneration: capturedSlotGen,
        updatedAt: Date.now(),
      }).catch(() => undefined);

      // 先確保 local pending 已寫入
      if (activeSlot.localTimer !== null && activeSlot.latestRecordSnapshot) {
        this.timer.clearTimeout(activeSlot.localTimer);
        activeSlot.localTimer = null;
        await saveProjectRecord(activeSlot.latestRecordSnapshot).catch(() => undefined);
      }

      const freshRecord = (await getProjectRecord(projectId)) ?? current;
      const outcome = await syncFn({
        record: freshRecord,
        accountId: auth.accountId!,
        accessToken: auth.accessToken!,
        generation: auth.generation,
        isGenerationValid: (g, a) =>
          activeSlot.generation === capturedSlotGen && auth.isGenerationValid(g, a),
        forceReplaceRemote: options?.forceReplaceRemote,
        signal: controller.signal,
      });

      finalOutcome = outcome;

      if (activeSlot.generation !== capturedSlotGen) {
        return;
      }

      if (outcome.status === "waiting_auth") {
        auth.onAuthExpired?.();
        await saveProjectSyncJob({
          projectId,
          ownerAccountId: current.ownerAccountId,
          status: "waiting_auth",
          attempts: activeSlot.retryAttempt,
          syncGeneration: capturedSlotGen,
          lastError: outcome.errorMessage,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      } else if (outcome.status === "synced") {
        activeSlot.retryAttempt = 0;
        activeSlot.latestRecordSnapshot = outcome.record;
        await saveProjectSyncJob({
          projectId,
          ownerAccountId: current.ownerAccountId,
          status: "idle",
          attempts: 0,
          syncGeneration: capturedSlotGen,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      } else if (outcome.status === "conflict") {
        activeSlot.pendingFollowUp = false;
        await saveProjectSyncJob({
          projectId,
          ownerAccountId: current.ownerAccountId,
          status: "conflict",
          attempts: activeSlot.retryAttempt,
          syncGeneration: capturedSlotGen,
          lastError: outcome.conflictInfo.reason,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      } else if (outcome.status === "error") {
        if (outcome.retryable && activeSlot.retryAttempt < this.maxRetries) {
          const delayMs =
            this.retryBackoffMs[
              Math.min(activeSlot.retryAttempt, this.retryBackoffMs.length - 1)
            ] ?? 15_000;
          activeSlot.retryAttempt += 1;
          await saveProjectSyncJob({
            projectId,
            ownerAccountId: current.ownerAccountId,
            status: "queued",
            attempts: activeSlot.retryAttempt,
            nextRetryAt: Date.now() + delayMs,
            syncGeneration: capturedSlotGen,
            lastError: outcome.errorMessage,
            updatedAt: Date.now(),
          }).catch(() => undefined);
          activeSlot.retryTimer = this.timer.setTimeout(() => {
            activeSlot.retryTimer = null;
            if (activeSlot.generation === capturedSlotGen) {
              void this.triggerDriveSync(projectId);
            }
          }, delayMs);
        } else {
          await saveProjectSyncJob({
            projectId,
            ownerAccountId: current.ownerAccountId,
            status: "error",
            attempts: activeSlot.retryAttempt,
            syncGeneration: capturedSlotGen,
            lastError: outcome.errorMessage,
            updatedAt: Date.now(),
          }).catch(() => undefined);
        }
      }

      this.deps.onStatusChanged?.(projectId, outcome);
    })().finally(() => {
      if (activeSlot.inFlight === run) {
        activeSlot.inFlight = null;
      }
      if (activeSlot.abortController === controller) {
        activeSlot.abortController = null;
      }
      if (activeSlot.pendingFollowUp && activeSlot.generation === capturedSlotGen) {
        activeSlot.pendingFollowUp = false;
        void this.triggerDriveSync(projectId);
      }
    });

    activeSlot.inFlight = run;
    await run;
    return finalOutcome;
  }

  async resumePendingForAccount(accountId: string): Promise<void> {
    if (!accountId) return;
    const { listCloudCachedProjectRecordsByAccount } = await import("../storage/projectStore.ts");
    const cached = await listCloudCachedProjectRecordsByAccount(accountId);
    for (const rec of cached) {
      if (rec.dirty && rec.syncStatus !== "conflict") {
        await this.triggerDriveSync(rec.projectId);
      }
    }
  }

  invalidateProject(projectId: string): void {
    const slot = this.slots.get(projectId);
    if (!slot) return;
    slot.generation += 1;
    slot.pendingFollowUp = false;
    if (slot.localTimer !== null) this.timer.clearTimeout(slot.localTimer);
    if (slot.driveTimer !== null) this.timer.clearTimeout(slot.driveTimer);
    if (slot.retryTimer !== null) this.timer.clearTimeout(slot.retryTimer);
    slot.abortController?.abort();
    this.slots.delete(projectId);
  }

  invalidateAccount(accountId: string | null | undefined): void {
    if (!accountId) return;
    for (const [projectId, slot] of this.slots.entries()) {
      if (slot.ownerAccountId === accountId) {
        this.invalidateProject(projectId);
      }
    }
  }

  dispose(): void {
    for (const projectId of Array.from(this.slots.keys())) {
      this.invalidateProject(projectId);
    }
  }
}
