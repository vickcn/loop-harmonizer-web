import type { BandSong } from "../band/bandTypes.ts";
import { restoreBandSongFromRecord } from "../band/songModel.ts";
import { saveCheckpoint } from "../storage/separationCheckpointStore.ts";
import { findCompletedCheckpointBySourceAudioHash } from "../storage/separationCheckpointStore.ts";
import {
  deleteProjectRecord,
  findLegacyMigrationByFingerprint,
  getActiveProjectId,
  getProjectRecord,
  listProjectRecords,
  saveLegacyMigrationEntry,
  saveProjectRecord,
  setActiveProjectId,
} from "../storage/projectStore.ts";
import {
  getPersistedAudioBlobByKey,
  loadPersistedBandSession,
} from "../storage/songSessionStore.ts";
import {
  type ProjectAutoSyncController,
  type ProjectDriveSyncOutcome,
  backupLocalOriginalAudioToDrive,
  buildProjectListSummary,
  deleteCloudProject,
  listCloudProjects,
  saveProjectToDrive,
} from "./projectDriveSync.ts";
import {
  bandSongToProjectEntry,
  buildProjectFromBandSongs,
  cloneProjectForSaveAs,
  computeLegacySessionFingerprint,
  computeProjectBackupSummary,
  createEmptyProject,
  createInitialPersistedProjectRecord,
  generateRevisionToken,
  sanitizeProjectName,
} from "./projectModel.ts";
import { projectToBandSongsMetadataOnly } from "./projectRestoreManager.ts";
import type {
  BandProject,
  PersistedProjectRecord,
  ProjectListEntrySummary,
  ProjectSongEntry,
  ProjectStorageProvider,
} from "./projectTypes.ts";

export interface ProjectAuthContext {
  accountId: string | null;
  accessToken: string | null;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  onAuthExpired?: () => void;
}

export async function createNewProject(params: {
  name: string;
  description?: string;
  storageProvider: ProjectStorageProvider;
  auth?: ProjectAuthContext;
  setActive?: boolean;
  syncImmediatelyIfDrive?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ record: PersistedProjectRecord; syncOutcome?: ProjectDriveSyncOutcome }> {
  if (params.storageProvider === "google_drive") {
    if (!params.auth?.accountId) {
      throw new Error("建立 Google Drive 雲端專案需要先登入 Google 帳號；您也可以先選擇本機專案。");
    }
  }

  const project = createEmptyProject({
    name: params.name,
    description: params.description,
    storageProvider: params.storageProvider,
    ownerAccountId:
      params.storageProvider === "google_drive" ? params.auth?.accountId ?? undefined : undefined,
  });

  const initialRecord = createInitialPersistedProjectRecord(project, {
    dirty: params.storageProvider === "google_drive",
    syncStatus: params.storageProvider === "google_drive" ? "dirty" : "local_only",
  });

  const saveRes = await saveProjectRecord(initialRecord, { allowCreateIfDeleted: true });
  if (!saveRes.saved) {
    throw new Error("無法寫入本機專案資料庫。");
  }

  if (params.setActive !== false) {
    await setActiveProjectId(saveRes.record.projectId);
  }

  let syncOutcome: ProjectDriveSyncOutcome | undefined;
  if (
    params.storageProvider === "google_drive" &&
    params.syncImmediatelyIfDrive !== false &&
    params.auth?.accountId &&
    params.auth.accessToken
  ) {
    syncOutcome = await saveProjectToDrive({
      record: saveRes.record,
      accountId: params.auth.accountId,
      accessToken: params.auth.accessToken,
      generation: params.auth.generation,
      isGenerationValid: params.auth.isGenerationValid,
      fetchImpl: params.fetchImpl,
    });
    if (syncOutcome.status === "synced") {
      return { record: syncOutcome.record, syncOutcome };
    }
    return { record: (await getProjectRecord(saveRes.record.projectId)) ?? saveRes.record, syncOutcome };
  }

  return { record: saveRes.record };
}

export async function saveLocalProjectSnapshot(params: {
  projectId: string;
  songs: readonly BandSong[];
  nameOverride?: string;
  incrementRevision?: boolean;
}): Promise<PersistedProjectRecord | null> {
  const existing = await getProjectRecord(params.projectId);
  if (!existing) return null;

  const builtProject = buildProjectFromBandSongs({
    existingProject: {
      ...existing.project,
      name: params.nameOverride ? sanitizeProjectName(params.nameOverride) : existing.project.name,
    },
    songs: params.songs,
    incrementRevision: params.incrementRevision ?? true,
  });

  const nextRecord: PersistedProjectRecord = {
    ...existing,
    project: builtProject,
    localRevision: builtProject.revision,
    dirty: existing.storageProvider === "google_drive" ? true : false,
    syncStatus:
      existing.storageProvider === "google_drive"
        ? existing.syncStatus === "conflict"
          ? "conflict"
          : "dirty"
        : "local_only",
    lastSavedAt: Date.now(),
  };

  const saved = await saveProjectRecord(nextRecord);
  return saved.saved ? saved.record : null;
}

export async function saveProjectAs(params: {
  sourceProject: BandProject;
  currentSongs?: readonly BandSong[];
  name: string;
  description?: string;
  storageProvider: ProjectStorageProvider;
  auth?: ProjectAuthContext;
  setActive?: boolean;
  syncImmediatelyIfDrive?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ record: PersistedProjectRecord; syncOutcome?: ProjectDriveSyncOutcome }> {
  if (params.storageProvider === "google_drive" && !params.auth?.accountId) {
    throw new Error("另存為 Google Drive 專案需要登入 Google 帳號。");
  }

  const snapshotSource = params.currentSongs
    ? buildProjectFromBandSongs({
        existingProject: params.sourceProject,
        songs: params.currentSongs,
        incrementRevision: false,
      })
    : params.sourceProject;

  const clonedProject = cloneProjectForSaveAs(snapshotSource, {
    name: params.name,
    description: params.description,
    storageProvider: params.storageProvider,
    ownerAccountId:
      params.storageProvider === "google_drive" ? params.auth?.accountId ?? undefined : undefined,
  });

  const rec = createInitialPersistedProjectRecord(clonedProject, {
    dirty: params.storageProvider === "google_drive",
    syncStatus: params.storageProvider === "google_drive" ? "dirty" : "local_only",
  });

  const saveRes = await saveProjectRecord(rec, { allowCreateIfDeleted: true });
  if (!saveRes.saved) {
    throw new Error("另存新專案寫入 IndexedDB 失敗。");
  }
  if (params.setActive !== false) {
    await setActiveProjectId(saveRes.record.projectId);
  }

  if (
    params.storageProvider === "google_drive" &&
    params.syncImmediatelyIfDrive !== false &&
    params.auth?.accountId &&
    params.auth.accessToken
  ) {
    const syncOutcome = await saveProjectToDrive({
      record: saveRes.record,
      accountId: params.auth.accountId,
      accessToken: params.auth.accessToken,
      generation: params.auth.generation,
      isGenerationValid: params.auth.isGenerationValid,
      fetchImpl: params.fetchImpl,
    });
    const finalRec =
      syncOutcome.status === "synced"
        ? syncOutcome.record
        : (await getProjectRecord(saveRes.record.projectId)) ?? saveRes.record;
    return { record: finalRec, syncOutcome };
  }

  return { record: saveRes.record };
}

export async function renameProject(params: {
  projectId: string;
  newName: string;
  auth?: ProjectAuthContext;
  fetchImpl?: typeof fetch;
}): Promise<{ record: PersistedProjectRecord; syncOutcome?: ProjectDriveSyncOutcome }> {
  const existing = await getProjectRecord(params.projectId);
  if (!existing) {
    throw new Error("找不到要重新命名的專案。");
  }
  const cleanName = sanitizeProjectName(params.newName);
  const nextRevision = existing.localRevision + 1;
  const nextProject: BandProject = {
    ...existing.project,
    name: cleanName,
    revision: nextRevision,
    revisionToken: generateRevisionToken(nextRevision),
    parentRevisionId: existing.project.revisionToken,
    updatedAt: new Date().toISOString(),
  };
  const updated: PersistedProjectRecord = {
    ...existing,
    project: nextProject,
    localRevision: nextRevision,
    dirty: existing.storageProvider === "google_drive",
    syncStatus: existing.storageProvider === "google_drive" ? "dirty" : "local_only",
    lastSavedAt: Date.now(),
  };

  const saved = await saveProjectRecord(updated);
  if (!saved.saved) {
    throw new Error("此專案已被刪除，無法重新命名。");
  }

  if (
    saved.record.storageProvider === "google_drive" &&
    params.auth?.accountId &&
    params.auth.accessToken &&
    saved.record.ownerAccountId === params.auth.accountId
  ) {
    const syncOutcome = await saveProjectToDrive({
      record: saved.record,
      accountId: params.auth.accountId,
      accessToken: params.auth.accessToken,
      generation: params.auth.generation,
      isGenerationValid: params.auth.isGenerationValid,
      fetchImpl: params.fetchImpl,
    });
    return {
      record:
        syncOutcome.status === "synced"
          ? syncOutcome.record
          : (await getProjectRecord(params.projectId)) ?? saved.record,
      syncOutcome,
    };
  }
  return { record: saved.record };
}

export interface PromoteLocalToDriveProgress {
  stage: "preparing" | "backing_up_originals" | "uploading_project" | "completed";
  message: string;
  currentSongName?: string;
  completedOriginals?: number;
  totalOriginals?: number;
}

/**
 * 將本機專案轉存為目前登入帳戶的正式 Google Drive 專案（不會主動上傳其他本機專案）。
 * - 支援勾選「一併備份原始音檔」，僅上傳本地檔案且已有完整複本時重用。
 * - 不會將未備份或未上傳分軌的歌曲偽報為「可跨裝置恢復」。
 */
export async function promoteLocalProjectToDrive(params: {
  projectId: string;
  currentSongs?: readonly BandSong[];
  auth: ProjectAuthContext;
  backupLocalOriginals: boolean;
  inMemoryFilesBySongId?: ReadonlyMap<string, File>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: PromoteLocalToDriveProgress) => void;
}): Promise<{
  record: PersistedProjectRecord;
  syncOutcome: ProjectDriveSyncOutcome;
  originalBackupFailures: Array<{ entryId: string; displayName: string; reason: string }>;
}> {
  if (!params.auth.accountId || !params.auth.accessToken) {
    throw new Error("將專案儲存到 Google Drive 需要有效的 Google 授權。");
  }
  const accountId = params.auth.accountId;
  const accessToken = params.auth.accessToken;

  const existing = await getProjectRecord(params.projectId);
  if (!existing) {
    throw new Error("找不到要儲存至雲端的本機專案。");
  }

  let workingProject = params.currentSongs
    ? buildProjectFromBandSongs({
        existingProject: existing.project,
        songs: params.currentSongs,
        incrementRevision: false,
      })
    : existing.project;

  const originalBackupFailures: Array<{ entryId: string; displayName: string; reason: string }> = [];

  if (params.backupLocalOriginals) {
    const localEntries = workingProject.songs.filter(
      (e) =>
        e.source.provider === "local" &&
        e.sourceAudioHash &&
        (!e.originalBackup?.driveFileId || e.originalBackup.ownerAccountId !== accountId),
    );

    for (let i = 0; i < localEntries.length; i += 1) {
      const entry = localEntries[i];
      params.onProgress?.({
        stage: "backing_up_originals",
        message: `正在備份本機原始音檔 (${i + 1}/${localEntries.length})：${entry.displayName}`,
        currentSongName: entry.displayName,
        completedOriginals: i,
        totalOriginals: localEntries.length,
      });

      let blob: Blob | null = params.inMemoryFilesBySongId?.get(entry.entryId) ?? null;
      if (!blob && entry.sourceAudioHash) {
        const audioRec = await getPersistedAudioBlobByKey(entry.sourceAudioHash).catch(() => null);
        if (audioRec?.blob) blob = audioRec.blob;
      }

      if (!blob) {
        originalBackupFailures.push({
          entryId: entry.entryId,
          displayName: entry.displayName,
          reason: "本機資料庫找不到此曲的原始音檔，已保留專案 metadata 並標為未備份原曲。",
        });
        continue;
      }

      try {
        const backupRef = await backupLocalOriginalAudioToDrive({
          file: blob,
          fileName: entry.fileName,
          mimeType: entry.mimeType || blob.type || "audio/mpeg",
          sourceAudioHash: entry.sourceAudioHash,
          accountId,
          accessToken,
          generation: params.auth.generation,
          isGenerationValid: params.auth.isGenerationValid,
          onAuthExpired: params.auth.onAuthExpired,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        workingProject = {
          ...workingProject,
          songs: workingProject.songs.map((item) =>
            item.entryId === entry.entryId
              ? { ...item, originalBackup: backupRef }
              : item,
          ),
        };
      } catch (err) {
        originalBackupFailures.push({
          entryId: entry.entryId,
          displayName: entry.displayName,
          reason: err instanceof Error ? err.message : "原曲備份失敗",
        });
      }
    }
  }

  const nextRevision = workingProject.revision + 1;
  const nextToken = generateRevisionToken(nextRevision);
  const preparedProject: BandProject = {
    ...workingProject,
    storageProvider: "google_drive",
    ownerAccountId: accountId,
    revision: nextRevision,
    revisionToken: nextToken,
    parentRevisionId: workingProject.revisionToken,
    updatedAt: new Date().toISOString(),
    backupSummary: computeProjectBackupSummary(workingProject.songs, accountId),
  };

  const nextRecord: PersistedProjectRecord = {
    ...existing,
    storageProvider: "google_drive",
    ownerAccountId: accountId,
    project: preparedProject,
    localBaseRevision: nextRevision,
    localBaseRevisionToken: nextToken,
    localRevision: nextRevision,
    lastSyncedRemoteRevision: null,
    lastSyncedRemoteRevisionToken: null,
    dirty: true,
    syncStatus: "dirty",
    lastSavedAt: Date.now(),
  };

  await saveProjectRecord(nextRecord);

  params.onProgress?.({
    stage: "uploading_project",
    message: "正在上傳 project.json 至 Google Drive…",
  });

  const syncOutcome = await saveProjectToDrive({
    record: nextRecord,
    accountId,
    accessToken,
    generation: params.auth.generation,
    isGenerationValid: params.auth.isGenerationValid,
    fetchImpl: params.fetchImpl,
  });

  params.onProgress?.({
    stage: "completed",
    message:
      syncOutcome.status === "synced"
        ? "已將專案 Metadata 與可恢復狀態儲存至 Google Drive。"
        : "已保存本機專案，雲端同步待處理。",
  });

  return {
    record:
      syncOutcome.status === "synced"
        ? syncOutcome.record
        : (await getProjectRecord(params.projectId)) ?? nextRecord,
    syncOutcome,
    originalBackupFailures,
  };
}

export async function openProjectMetadataAndEntries(params: {
  projectId: string;
  cloudEntryHint?: { project: BandProject; driveVersion?: string | null };
  auth?: ProjectAuthContext;
  setActive?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  record: PersistedProjectRecord;
  songs: BandSong[];
  remoteAheadAvailable: boolean;
}> {
  let localRec = await getProjectRecord(params.projectId);
  let remoteAheadAvailable = false;

  if (!localRec && params.cloudEntryHint) {
    const cloudProj = params.cloudEntryHint.project;
    if (
      cloudProj.storageProvider === "google_drive" &&
      (!params.auth?.accountId || cloudProj.ownerAccountId !== params.auth.accountId)
    ) {
      throw new Error("此專案屬於其他 Google 帳戶，已拒絕載入。");
    }
    const createdRec: PersistedProjectRecord = {
      key: cloudProj.projectId,
      projectId: cloudProj.projectId,
      storageProvider: "google_drive",
      ownerAccountId: cloudProj.ownerAccountId ?? "",
      project: cloudProj,
      localBaseRevision: cloudProj.revision,
      localBaseRevisionToken: cloudProj.revisionToken,
      localRevision: cloudProj.revision,
      lastSyncedRemoteRevision: cloudProj.revision,
      lastSyncedRemoteRevisionToken: cloudProj.revisionToken,
      lastKnownRemoteRevision: cloudProj.revision,
      lastKnownRemoteRevisionToken: cloudProj.revisionToken,
      lastKnownRemoteDriveVersion: params.cloudEntryHint.driveVersion ?? null,
      dirty: false,
      syncStatus: "synced",
      lastSavedAt: Date.now(),
      lastSyncedAt: Date.now(),
      syncGeneration: 1,
    };
    const saveRes = await saveProjectRecord(createdRec, { allowCreateIfDeleted: true });
    localRec = saveRes.saved ? saveRes.record : createdRec;
  }

  if (!localRec) {
    throw new Error("找不到指定的專案。");
  }

  if (
    localRec.storageProvider === "google_drive" &&
    localRec.ownerAccountId &&
    params.auth?.accountId &&
    localRec.ownerAccountId !== params.auth.accountId
  ) {
    throw new Error("此雲端專案不屬於目前登入的 Google 帳號。");
  }

  if (
    params.cloudEntryHint &&
    localRec.storageProvider === "google_drive" &&
    params.cloudEntryHint.project.revisionToken !== localRec.project.revisionToken
  ) {
    if (!localRec.dirty) {
      // 本機無未同步修改，安全套用最新雲端專案 Metadata
      const remoteProj = params.cloudEntryHint.project;
      const refreshed: PersistedProjectRecord = {
        ...localRec,
        project: remoteProj,
        localBaseRevision: remoteProj.revision,
        localBaseRevisionToken: remoteProj.revisionToken,
        localRevision: remoteProj.revision,
        lastSyncedRemoteRevision: remoteProj.revision,
        lastSyncedRemoteRevisionToken: remoteProj.revisionToken,
        lastKnownRemoteRevision: remoteProj.revision,
        lastKnownRemoteRevisionToken: remoteProj.revisionToken,
        lastKnownRemoteDriveVersion: params.cloudEntryHint.driveVersion ?? null,
        dirty: false,
        syncStatus: "synced",
        lastSavedAt: Date.now(),
        lastSyncedAt: Date.now(),
        conflictInfo: null,
      };
      await saveProjectRecord(refreshed);
      localRec = refreshed;
    } else if (
      params.cloudEntryHint.project.revision > (localRec.lastSyncedRemoteRevision ?? localRec.localBaseRevision)
    ) {
      remoteAheadAvailable = true;
    }
  }

  if (params.setActive !== false) {
    await setActiveProjectId(localRec.projectId);
  }

  const songs = await projectToBandSongsMetadataOnly(localRec.project, {
    currentAccountId: params.auth?.accountId,
    hasValidGoogleToken: Boolean(params.auth?.accountId && params.auth.accessToken),
  });

  return {
    record: localRec,
    songs,
    remoteAheadAvailable,
  };
}

/**
 * 刪除專案本身與其專屬設定：
 * - 絕不刪除任何原始音檔、songs/ 雲端分軌、Checkpoint、ImportedStem 或他人共享檔案。
 * - 先廢止同步 Controller，避免刪除後又被背景自動儲存重建。
 */
export async function deleteProjectSafely(params: {
  projectId: string;
  scope: "local_only" | "cloud_and_local";
  auth?: ProjectAuthContext;
  autoSyncController?: ProjectAutoSyncController;
  fetchImpl?: typeof fetch;
}): Promise<{
  deletedLocal: boolean;
  deletedCloud: boolean;
  cloudError?: string;
}> {
  params.autoSyncController?.invalidateProject(params.projectId);
  const existing = await getProjectRecord(params.projectId);

  let deletedCloud = false;
  let cloudError: string | undefined;

  if (
    params.scope === "cloud_and_local" &&
    existing?.storageProvider === "google_drive"
  ) {
    if (!params.auth?.accountId || !params.auth.accessToken) {
      throw new Error("刪除雲端 Google Drive 專案需要有效的 Google 帳號授權。");
    }
    if (existing.ownerAccountId && existing.ownerAccountId !== params.auth.accountId) {
      throw new Error("無權刪除屬於其他 Google 帳戶的雲端專案。");
    }
    try {
      await deleteCloudProject({
        projectId: params.projectId,
        driveFolderId: existing.project.driveFolderId,
        driveProjectFileId: existing.project.driveProjectFileId,
        accountId: params.auth.accountId,
        accessToken: params.auth.accessToken,
        fetchImpl: params.fetchImpl,
      });
      deletedCloud = true;
    } catch (err) {
      cloudError = err instanceof Error ? err.message : "刪除雲端專案資料夾失敗。";
      throw err;
    }
  }

  const res = await deleteProjectRecord(params.projectId);
  return {
    deletedLocal: res.deleted,
    deletedCloud,
    cloudError,
  };
}

export async function resolveProjectConflict(params: {
  projectId: string;
  strategy: "load_remote" | "save_local_as_new" | "overwrite_remote";
  newProjectNameForSaveAs?: string;
  auth: ProjectAuthContext;
  fetchImpl?: typeof fetch;
}): Promise<{
  activeRecord: PersistedProjectRecord;
  createdLocalCopyRecord?: PersistedProjectRecord;
  syncOutcome?: ProjectDriveSyncOutcome;
}> {
  const existing = await getProjectRecord(params.projectId);
  if (!existing) {
    throw new Error("找不到存在版本衝突的專案。");
  }
  const conflict = existing.conflictInfo;

  if (params.strategy === "load_remote") {
    if (!conflict?.remoteProjectSnapshot) {
      throw new Error("遠端專案快照不存在（可能已在雲端刪除），請改用「保留本機另存新專案」或覆寫。");
    }
    const remoteProj = conflict.remoteProjectSnapshot;
    const loadedRec: PersistedProjectRecord = {
      ...existing,
      project: {
        ...remoteProj,
        driveFolderId: remoteProj.driveFolderId ?? existing.project.driveFolderId,
        driveProjectFileId: remoteProj.driveProjectFileId ?? existing.project.driveProjectFileId,
        driveRevisionsFolderId:
          remoteProj.driveRevisionsFolderId ?? existing.project.driveRevisionsFolderId,
      },
      localBaseRevision: remoteProj.revision,
      localBaseRevisionToken: remoteProj.revisionToken,
      localRevision: remoteProj.revision,
      lastSyncedRemoteRevision: remoteProj.revision,
      lastSyncedRemoteRevisionToken: remoteProj.revisionToken,
      dirty: false,
      syncStatus: "synced",
      lastSavedAt: Date.now(),
      lastSyncedAt: Date.now(),
      conflictInfo: null,
      lastError: null,
    };
    await saveProjectRecord(loadedRec);
    return { activeRecord: loadedRec };
  }

  if (params.strategy === "save_local_as_new") {
    const backupCopy = await saveProjectAs({
      sourceProject: existing.project,
      name: params.newProjectNameForSaveAs || `${existing.project.name}（衝突本機副本）`,
      storageProvider: "local",
      setActive: !conflict?.remoteProjectSnapshot,
    });

    if (conflict?.remoteProjectSnapshot) {
      const remoteProj = conflict.remoteProjectSnapshot;
      const syncedRemoteRec: PersistedProjectRecord = {
        ...existing,
        project: remoteProj,
        localBaseRevision: remoteProj.revision,
        localBaseRevisionToken: remoteProj.revisionToken,
        localRevision: remoteProj.revision,
        lastSyncedRemoteRevision: remoteProj.revision,
        lastSyncedRemoteRevisionToken: remoteProj.revisionToken,
        dirty: false,
        syncStatus: "synced",
        lastSavedAt: Date.now(),
        lastSyncedAt: Date.now(),
        conflictInfo: null,
        lastError: null,
      };
      await saveProjectRecord(syncedRemoteRec);
      return {
        activeRecord: backupCopy.record,
        createdLocalCopyRecord: backupCopy.record,
      };
    }

    return {
      activeRecord: backupCopy.record,
      createdLocalCopyRecord: backupCopy.record,
    };
  }

  // strategy === "overwrite_remote"
  if (!params.auth.accountId || !params.auth.accessToken) {
    throw new Error("以本機取代雲端版本需要有效的 Google 帳號授權。");
  }
  const syncOutcome = await saveProjectToDrive({
    record: existing,
    accountId: params.auth.accountId,
    accessToken: params.auth.accessToken,
    generation: params.auth.generation,
    isGenerationValid: params.auth.isGenerationValid,
    forceReplaceRemote: true,
    fetchImpl: params.fetchImpl,
  });
  if (syncOutcome.status !== "synced") {
    throw new Error(
      syncOutcome.status === "error" || syncOutcome.status === "waiting_auth"
        ? syncOutcome.errorMessage
        : "無法強制覆寫雲端專案。",
    );
  }
  return {
    activeRecord: syncOutcome.record,
    syncOutcome,
  };
}

/**
 * 將舊版單一 Band Mixer 工作階段另存為正式本機專案：
 * - 絕不刪除原有 IndexedDB band-session 或 Google Drive sessions/default-band-mixer.json；
 * - 絕不自動上傳至 Google Drive；
 * - 依內容 Fingerprint 防止重複遷移建立多個相同專案。
 */
export async function migrateLegacyBandSessionToProject(params?: {
  name?: string;
  songsOverride?: readonly BandSong[];
  forceCreateDuplicate?: boolean;
  setActive?: boolean;
}): Promise<{
  created: boolean;
  record: PersistedProjectRecord;
  alreadyMigratedProjectId?: string;
}> {
  let songs: BandSong[] = [];
  if (params?.songsOverride) {
    songs = [...params.songsOverride];
  } else {
    const persisted = await loadPersistedBandSession();
    songs = persisted.songs.map((rec) =>
      restoreBandSongFromRecord(rec, {
        audioLoadState: "unloaded",
        persistenceStatus: "saved",
      }),
    );
  }

  const fingerprint = computeLegacySessionFingerprint(songs);
  if (!params?.forceCreateDuplicate) {
    const existingMigration = await findLegacyMigrationByFingerprint(fingerprint);
    if (existingMigration) {
      const existingProj = await getProjectRecord(existingMigration.projectId);
      if (existingProj) {
        if (params?.setActive) {
          await setActiveProjectId(existingProj.projectId);
        }
        return {
          created: false,
          record: existingProj,
          alreadyMigratedProjectId: existingProj.projectId,
        };
      }
    }
  }

  const projectName = sanitizeProjectName(
    params?.name || "預設工作空間（已遷移）",
  );
  const project = createEmptyProject({
    name: projectName,
    storageProvider: "local",
  });

  const entries: ProjectSongEntry[] = [];
  for (let i = 0; i < songs.length; i += 1) {
    const song = songs[i];
    const entry = bandSongToProjectEntry(song, i, { forceNewEntryId: true });
    // 若此曲在本機已有已完成 Checkpoint，確保新 entry 建立安全引用
    if (song.separationStatus === "completed" && song.sourceAudioHash && !entry.artifactRef?.localTaskId) {
      const cp = await findCompletedCheckpointBySourceAudioHash(song.sourceAudioHash).catch(
        () => null,
      );
      if (cp) {
        entry.artifactRef = {
          ...(entry.artifactRef ?? {
            revisionId: `local-${cp.taskId}`,
            sourceAudioHash: song.sourceAudioHash,
            separationMode: song.separationMode ?? cp.requestedMode,
            modelVersion: cp.modelVersion,
            processingVersion: cp.processingVersion,
            sampleRate: cp.sampleRate,
            channelCount: 2,
            totalSamples: cp.totalSamples,
          }),
          localTaskId: cp.taskId,
          localSourceType: "demucs_checkpoint",
        };
      }
    }
    if (entry.artifactRef?.localTaskId && entry.artifactRef.localSourceType === "demucs_checkpoint") {
      // 保留引用到現有 Checkpoint 的紀錄而不改動原歌曲
      const cp = await findCompletedCheckpointBySourceAudioHash(entry.sourceAudioHash).catch(() => null);
      if (cp) {
        const refs = Array.from(new Set([...(cp.referencedBySongIds ?? []), entry.entryId]));
        await saveCheckpoint({ ...cp, referencedBySongIds: refs }).catch(() => undefined);
      }
    }
    entries.push(entry);
  }

  const finalizedProject: BandProject = {
    ...project,
    songs: entries,
    backupSummary: computeProjectBackupSummary(entries),
  };

  const rec = createInitialPersistedProjectRecord(finalizedProject, {
    dirty: false,
    syncStatus: "local_only",
    migratedFromLegacySession: true,
    legacyMigrationFingerprint: fingerprint,
  });

  const saved = await saveProjectRecord(rec, { allowCreateIfDeleted: true });
  if (!saved.saved) {
    throw new Error("無法儲存遷移後的新專案。");
  }

  await saveLegacyMigrationEntry({
    fingerprint,
    projectId: saved.record.projectId,
    projectName: saved.record.project.name,
    migratedAt: Date.now(),
  });

  if (params?.setActive !== false) {
    await setActiveProjectId(saved.record.projectId);
  }

  return {
    created: true,
    record: saved.record,
  };
}

/**
 * 載入本機與目前登入 Google 帳戶的專案清單（嚴格帳戶隔離，不混入其他帳號之雲端專案）。
 */
export async function listAllProjectsForUi(params?: {
  currentAccountId?: string | null;
  accessToken?: string | null;
  includeCloud?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{
  projects: ProjectListEntrySummary[];
  cloudProjectsMap: Map<string, { project: BandProject; driveVersion?: string | null }>;
  cloudError?: string;
}> {
  const localRecords = await listProjectRecords({
    includeLocal: true,
    ownerAccountId: params?.currentAccountId ?? null,
  });

  const byId = new Map<string, ProjectListEntrySummary>();
  for (const rec of localRecords) {
    byId.set(
      rec.projectId,
      buildProjectListSummary(
        rec,
        rec.storageProvider === "google_drive" ? "synced_cache" : "local_only",
      ),
    );
  }

  const cloudProjectsMap = new Map<string, { project: BandProject; driveVersion?: string | null }>();
  let cloudError: string | undefined;

  if (params?.includeCloud !== false && params?.currentAccountId && params?.accessToken) {
    try {
      const cloudList = await listCloudProjects({
        accountId: params.currentAccountId,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      for (const item of cloudList) {
        if (item.project.ownerAccountId !== params.currentAccountId) continue;
        cloudProjectsMap.set(item.project.projectId, item);
        const existingLocal = localRecords.find((r) => r.projectId === item.project.projectId);
        if (!existingLocal) {
          byId.set(item.project.projectId, {
            projectId: item.project.projectId,
            name: item.project.name,
            description: item.project.description,
            storageProvider: "google_drive",
            ownerAccountId: item.project.ownerAccountId,
            songCount: item.project.songs.length,
            updatedAt: item.project.updatedAt,
            localUpdatedAt: Date.parse(item.project.updatedAt) || 0,
            revision: item.project.revision,
            syncStatus: "synced",
            dirty: false,
            hasConflict: false,
            driveFolderId: item.project.driveFolderId,
            driveProjectFileId: item.project.driveProjectFileId,
            backupSummary:
              item.project.backupSummary ??
              computeProjectBackupSummary(item.project.songs, params.currentAccountId),
            sourceLocation: "cloud_only",
          });
        } else {
          // 若遠端版本更新且本機沒有衝突，更新清單顯示資訊
          const existingSummary = byId.get(item.project.projectId)!;
          if (!existingLocal.dirty && item.project.revision > existingLocal.localRevision) {
            byId.set(item.project.projectId, {
              ...existingSummary,
              name: item.project.name,
              songCount: item.project.songs.length,
              updatedAt: item.project.updatedAt,
              revision: item.project.revision,
            });
          } else if (
            existingLocal.dirty &&
            item.project.revision > (existingLocal.lastSyncedRemoteRevision ?? existingLocal.localBaseRevision)
          ) {
            byId.set(item.project.projectId, {
              ...existingSummary,
              syncStatus: "conflict",
              hasConflict: true,
            });
          }
        }
      }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : "無法載入 Google Drive 專案清單";
    }
  }

  const projects = Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  return {
    projects,
    cloudProjectsMap,
    cloudError,
  };
}

export async function restoreLastActiveProjectOrNull(params?: {
  currentAccountId?: string | null;
}): Promise<PersistedProjectRecord | null> {
  const activeId = await getActiveProjectId();
  if (!activeId) return null;
  const rec = await getProjectRecord(activeId);
  if (!rec) return null;
  // 本機專案隨時可用；雲端專案於未登入時仍保留本機已快取離線資料，但不得切換帳戶後顯示其他帳戶專案
  if (
    rec.storageProvider === "google_drive" &&
    params?.currentAccountId &&
    rec.ownerAccountId &&
    rec.ownerAccountId !== params.currentAccountId
  ) {
    return null;
  }
  return rec;
}
