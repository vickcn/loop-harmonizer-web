import type { UploadByteSource } from "../google/driveResumableUpload.ts";
import { uploadChunkedResumable } from "../google/driveResumableUpload.ts";
import {
  DriveApiError,
  type DriveRawFileResource,
  type PaginatedDriveIncompleteReason,
  deleteAppManagedDriveFile,
  downloadDriveJson,
  getDriveFileMetadata,
  listDriveFiles,
  listDriveFilesPaginated,
  uploadDriveMultipartJson,
} from "../google/driveClient.ts";
import {
  LOOP_HARMONIZER_APP_TAG,
  buildStableSongFolderKey,
  ensureProjectFolder,
  ensureSongOriginalsFolder,
  listManagedProjectsPaginated,
} from "../google/driveFolderManager.ts";
import type { WebLockAdapter } from "../separation/separationResumeController.ts";
import {
  commitProjectSyncResultAtomically,
  getProjectRecord,
  isProjectDeleted,
  saveLocalProjectEditAtomically,
  saveProjectSyncJob,
} from "../storage/projectStore.ts";
import {
  computeProjectBackupSummary,
  generateRevisionToken,
  validateProjectDocument,
} from "./projectModel.ts";
import type {
  BandProject,
  PendingProjectRevisionPublish,
  PersistedProjectRecord,
  ProjectConflictInfo,
  ProjectListEntrySummary,
  ProjectRevisionMetaSummary,
  ProjectSongOriginalBackupRef,
} from "./projectTypes.ts";

export const PROJECT_SYNC_LOCAL_DEBOUNCE_MS = 500;
export const PROJECT_SYNC_DRIVE_DEBOUNCE_MS = 4000;
export const PROJECT_SYNC_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000] as const;
export const PROJECT_SYNC_MAX_RETRIES = 3;

export const DRIVE_CAS_LIMITATION_NOTE =
  "Google Drive API files.update 未提供針對應用程式自訂版本號之跨裝置原子 CAS，因此無法從 API 層保證完全避免並行寫入；Loop Harmonizer 採用不可變 revisions/ 快照、二階段可恢復發布、寫前與寫後驗證、同父版本 Sibling 分支掃描及非破壞性衝突快照防止靜默覆寫。";

export type ProjectDriveSyncOutcome =
  | {
      status: "synced";
      record: PersistedProjectRecord;
      driveVersion?: string | null;
      immutableRevisionFileId: string;
      superseded?: boolean;
      needsFollowUpSync?: boolean;
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

function parseRevisionNumberFromMeta(meta: DriveRawFileResource): number | undefined {
  const rawProp = meta.appProperties?.lhProjectRevision;
  if (rawProp) {
    const parsed = Number(rawProp);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  const m = /^rev_(\d+)_/.exec(meta.name ?? "");
  if (m) {
    const parsed = Number(m[1]);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return undefined;
}

export interface ProjectRevisionMetadataScanResult {
  revisions: ProjectRevisionMetaSummary[];
  complete: boolean;
  truncated: boolean;
  incompleteReason?: PaginatedDriveIncompleteReason;
  errorMessage?: string;
}

/**
 * 完整分頁掃描單一專案 `revisions/` 資料夾內的不可變 Revision Metadata，用於偵測同父版本的 Sibling 分支。
 */
export async function listProjectRevisionMetadata(params: {
  revisionsFolderId: string;
  projectId: string;
  accountId: string;
  accessToken: string;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  maxRetriesPerPage?: number;
  retryDelayMs?: readonly number[];
  maxFallbackDownloads?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProjectRevisionMetadataScanResult> {
  if (!params.revisionsFolderId) {
    return { revisions: [], complete: true, truncated: false };
  }
  const safeFolder = params.revisionsFolderId.replace(/'/g, "");
  const safeProj = params.projectId.replace(/'/g, "");
  const safeAcc = params.accountId.replace(/'/g, "");

  const q = [
    `'${safeFolder}' in parents`,
    "trashed=false",
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRole' and value='project_revision' }`,
    `appProperties has { key='lhAccountId' and value='${safeAcc}' }`,
    `appProperties has { key='lhProjectId' and value='${safeProj}' }`,
  ].join(" and ");

  const listRes = await listDriveFilesPaginated({
    accessToken: params.accessToken,
    q,
    pageSize: params.pageSize ?? 100,
    orderBy: "modifiedTime desc",
    maxPages: params.maxPages ?? 20,
    maxItems: params.maxItems ?? 2000,
    maxRetriesPerPage: params.maxRetriesPerPage ?? 2,
    retryDelayMs: params.retryDelayMs,
    throwOnError: true,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const byToken = new Map<string, ProjectRevisionMetaSummary>();
  let fallbackReads = 0;
  const maxFallback = params.maxFallbackDownloads ?? 5;

  for (const file of listRes.files) {
    if (file.trashed || !file.id) continue;
    if (file.appProperties?.lhAccountId && file.appProperties.lhAccountId !== params.accountId) {
      continue;
    }
    let revisionToken = file.appProperties?.lhRevisionToken ?? "";
    let revision = parseRevisionNumberFromMeta(file);
    let parentRevisionId =
      file.appProperties && "lhParentRevisionId" in file.appProperties
        ? (file.appProperties.lhParentRevisionId || undefined)
        : undefined;

    if ((!revisionToken || (file.appProperties && !("lhParentRevisionId" in file.appProperties))) && fallbackReads < maxFallback) {
      fallbackReads += 1;
      const raw = await downloadDriveJson<unknown>({
        fileId: file.id,
        accessToken: params.accessToken,
        fileName: file.name || "revision.json",
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      }).catch(() => null);
      const doc = validateProjectDocument(raw, { expectedAccountId: params.accountId }).project;
      if (doc) {
        revisionToken = revisionToken || doc.revisionToken;
        revision = revision ?? doc.revision;
        if (parentRevisionId === undefined) {
          parentRevisionId = doc.parentRevisionId || undefined;
        }
      }
    }

    if (!revisionToken || byToken.has(revisionToken)) continue;
    byToken.set(revisionToken, {
      fileId: file.id,
      fileName: file.name,
      revision,
      revisionToken,
      parentRevisionId,
      modifiedTime: file.modifiedTime,
    });
  }

  return {
    revisions: Array.from(byToken.values()),
    complete: listRes.complete,
    truncated: listRes.truncated,
    incompleteReason: listRes.incompleteReason,
    errorMessage: listRes.errorMessage,
  };
}

function findSiblingBranchRevisions(params: {
  revisions: readonly ProjectRevisionMetaSummary[];
  parentToken?: string;
  targetRevision: number;
  ownTokensToIgnore: ReadonlySet<string>;
}): ProjectRevisionMetaSummary[] {
  return params.revisions.filter((rev) => {
    if (params.ownTokensToIgnore.has(rev.revisionToken)) return false;
    if (params.parentToken) {
      return rev.parentRevisionId === params.parentToken;
    }
    return params.targetRevision === 1 && rev.revision === 1 && !rev.parentRevisionId;
  });
}

/**
 * 將專案保存至 Google Drive（採用不可變 Revision 檔案 + 二階段可恢復發布 + 寫前/寫後及 Sibling 分支衝突檢查 + IndexedDB 條件式提交）。
 */
export async function saveProjectToDrive(params: {
  record: PersistedProjectRecord;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  forceReplaceRemote?: boolean;
  onBeforeCommit?: () => Promise<void>;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<ProjectDriveSyncOutcome> {
  const { record, accountId, accessToken } = params;
  const expectedBase = {
    ownerAccountId: accountId,
    syncGeneration: record.syncGeneration,
    localRevision: record.localRevision,
    revisionToken: record.project.revisionToken,
  };

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

  const commitAtomic = async (
    kind: "synced" | "conflict" | "waiting_auth" | "error" | "remote_ahead" | "pending_index",
    remoteMetadata: {
      driveFolderId?: string;
      driveProjectFileId?: string;
      driveRevisionsFolderId?: string;
      syncedRevision?: number;
      syncedRevisionToken?: string;
      knownRemoteRevision?: number | null;
      knownRemoteRevisionToken?: string | null;
      knownRemoteDriveVersion?: string | null;
      syncedAt?: number;
      conflictInfo?: ProjectConflictInfo | null;
      lastError?: string | null;
      pendingRevisionPublish?: PendingProjectRevisionPublish | null;
    },
    syncedProjectForExactMatch?: BandProject,
  ) => {
    if (params.onBeforeCommit) {
      await params.onBeforeCommit();
    }
    if (!params.isGenerationValid(params.generation, accountId)) {
      return {
        committed: false as const,
        outcome: "generation_mismatch" as const,
        record: null,
        errorMessage: "Google 帳戶工作階段已切換，已中止提交。",
      };
    }
    return commitProjectSyncResultAtomically({
      projectId: record.projectId,
      expectedBase,
      kind,
      remoteMetadata,
      syncedProjectForExactMatch,
      lockAdapter: params.lockAdapter,
    });
  };

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
    let remoteMetaRevisionToken: string | undefined;

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
          remoteMetaRevisionToken = meta.appProperties?.lhRevisionToken;
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
          conflictSubType: "remote_deleted",
          localRevision: record.localRevision,
          localRevisionToken: record.project.revisionToken,
          localBaseRevision: record.localBaseRevision,
          remoteRevision: record.lastSyncedRemoteRevision ?? 0,
          remoteRevisionToken: record.lastSyncedRemoteRevisionToken ?? "",
          remoteProjectSnapshot: null,
          reason:
            "遠端 Google Drive 中的此專案檔案已不存在或已被移至垃圾桶，為防止意外重建請確認處理方式。",
        };
        const commitRes = await commitAtomic("conflict", {
          driveFolderId: folders.projectFolderId,
          driveRevisionsFolderId: folders.projectRevisionsFolderId,
          conflictInfo,
          lastError: conflictInfo.reason,
        });
        if (!commitRes.committed) {
          return commitRes.outcome === "idb_error"
            ? { status: "error", record, retryable: true, errorMessage: commitRes.errorMessage || "寫入衝突狀態失敗。" }
            : { status: "cancelled", reason: commitRes.errorMessage || "專案已變更或刪除。" };
        }
        return {
          status: "conflict",
          record: commitRes.record,
          conflictInfo: commitRes.record.conflictInfo ?? conflictInfo,
        };
      }

      if (remoteProject && !params.forceReplaceRemote) {
        const baseRev = record.lastSyncedRemoteRevision ?? record.localBaseRevision;
        const baseToken = record.lastSyncedRemoteRevisionToken ?? record.localBaseRevisionToken;
        const remoteAhead = isRemoteChangedSinceBase({
          remoteProject,
          baseRevision: baseRev,
          baseRevisionToken: baseToken,
        });
        const matchedPendingPublish =
          record.pendingRevisionPublish &&
          record.pendingRevisionPublish.localRevisionAtStart === record.localRevision &&
          record.pendingRevisionPublish.localTokenAtStart === record.project.revisionToken &&
          remoteProject.revisionToken === record.pendingRevisionPublish.revisionToken;

        if (remoteAhead && !record.dirty && !matchedPendingPublish) {
          const commitRes = await commitAtomic("remote_ahead", {
            driveFolderId: folders.projectFolderId,
            driveProjectFileId: targetFileId,
            driveRevisionsFolderId: folders.projectRevisionsFolderId,
            knownRemoteRevision: remoteProject.revision,
            knownRemoteRevisionToken: remoteProject.revisionToken,
            knownRemoteDriveVersion: remoteDriveVersion,
          });
          if (!commitRes.committed) {
            return commitRes.outcome === "idb_error"
              ? { status: "error", record, retryable: true, errorMessage: commitRes.errorMessage || "更新遠端版本資訊失敗。" }
              : { status: "cancelled", reason: commitRes.errorMessage || "專案狀態已變更。" };
          }
          if (!commitRes.superseded && !commitRes.record.dirty) {
            return {
              status: "remote_ahead",
              record: commitRes.record,
              remoteProject,
              driveVersion: remoteDriveVersion,
            };
          }
          // 若檢查期間本機已被編輯成 dirty，需立即視為衝突而非覆寫！
          const divergedConflict: ProjectConflictInfo = {
            detectedAt: Date.now(),
            kind: "diverged",
            conflictSubType: "pre_write_diverged",
            localRevision: commitRes.record.localRevision,
            localRevisionToken: commitRes.record.project.revisionToken,
            localBaseRevision: baseRev,
            remoteRevision: remoteProject.revision,
            remoteRevisionToken: remoteProject.revisionToken,
            remoteUpdatedAt: remoteProject.updatedAt,
            remoteProjectSnapshot: remoteProject,
            reason: `同步期間偵測到遠端已更新為 r${remoteProject.revision}，同時本機剛產生未同步修改（r${commitRes.record.localRevision}），已保護雙方版本避免覆寫。`,
          };
          const cRes = await commitProjectSyncResultAtomically({
            projectId: record.projectId,
            expectedBase: {
              ownerAccountId: accountId,
              syncGeneration: commitRes.record.syncGeneration,
              localRevision: commitRes.record.localRevision,
              revisionToken: commitRes.record.project.revisionToken,
            },
            kind: "conflict",
            remoteMetadata: {
              driveFolderId: folders.projectFolderId,
              driveProjectFileId: targetFileId,
              driveRevisionsFolderId: folders.projectRevisionsFolderId,
              knownRemoteRevision: remoteProject.revision,
              knownRemoteRevisionToken: remoteProject.revisionToken,
              knownRemoteDriveVersion: remoteDriveVersion,
              conflictInfo: divergedConflict,
              lastError: divergedConflict.reason,
            },
            lockAdapter: params.lockAdapter,
          });
          if (!cRes.committed) {
            return { status: "error", record: commitRes.record, retryable: true, errorMessage: cRes.errorMessage || "保存衝突狀態失敗。" };
          }
          return {
            status: "conflict",
            record: cRes.record,
            conflictInfo: cRes.record.conflictInfo ?? divergedConflict,
          };
        }

        if (remoteAhead && record.dirty && !matchedPendingPublish) {
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
            conflictSubType: "pre_write_diverged",
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
          const commitRes = await commitAtomic("conflict", {
            driveFolderId: folders.projectFolderId,
            driveProjectFileId: targetFileId,
            driveRevisionsFolderId: folders.projectRevisionsFolderId,
            knownRemoteRevision: remoteProject.revision,
            knownRemoteRevisionToken: remoteProject.revisionToken,
            knownRemoteDriveVersion: remoteDriveVersion,
            conflictInfo,
            lastError: conflictInfo.reason,
          });
          if (!commitRes.committed) {
            return commitRes.outcome === "idb_error"
              ? { status: "error", record, retryable: true, errorMessage: commitRes.errorMessage || "寫入衝突狀態失敗。" }
              : { status: "cancelled", reason: commitRes.errorMessage || "專案狀態已變更。" };
          }
          return {
            status: "conflict",
            record: commitRes.record,
            conflictInfo: commitRes.record.conflictInfo ?? conflictInfo,
          };
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

    // 檢查是否有上一輪 Stage 1 已寫入、Stage 2 主索引中斷的 pendingRevisionPublish 可直接恢復重用
    let reusablePending: PendingProjectRevisionPublish | null = null;
    if (
      !params.forceReplaceRemote &&
      record.pendingRevisionPublish &&
      record.pendingRevisionPublish.localRevisionAtStart === record.localRevision &&
      record.pendingRevisionPublish.localTokenAtStart === record.project.revisionToken &&
      record.pendingRevisionPublish.revisionFileId
    ) {
      const pendingMeta = await getDriveFileMetadata(record.pendingRevisionPublish.revisionFileId, {
        accessToken,
        fields: "id,trashed,appProperties",
        fileName: "revision.json",
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      }).catch(() => null);
      if (pendingMeta && !pendingMeta.trashed) {
        reusablePending = record.pendingRevisionPublish;
      }
    }

    const baseVersionForNext = remoteProject
      ? Math.max(record.localRevision, remoteProject.revision)
      : record.localRevision;
    const computedNextRevision =
      record.lastSyncedRemoteRevision === null && !remoteProject
        ? Math.max(1, record.localRevision)
        : params.forceReplaceRemote && remoteProject
          ? baseVersionForNext + 1
          : Math.max(record.localRevision, (remoteProject?.revision ?? 0) + (record.dirty ? 1 : 0));

    const nextRevision = reusablePending ? reusablePending.revision : computedNextRevision;
    const nextToken = reusablePending ? reusablePending.revisionToken : generateRevisionToken(nextRevision);
    const parentToken = reusablePending
      ? reusablePending.parentRevisionId
      : remoteProject?.revisionToken ??
        record.lastSyncedRemoteRevisionToken ??
        record.project.parentRevisionId;

    const abandonedLocalDraftToken =
      record.pendingRevisionPublish &&
      record.pendingRevisionPublish.revisionToken !== nextToken &&
      (!remoteProject || remoteProject.revisionToken !== record.pendingRevisionPublish.revisionToken)
        ? record.pendingRevisionPublish.revisionToken
        : null;

    // 寫前 Sibling Revision 分支檢查（即使 project.json 尚未指向新版本，只要同父版本已出現他裝置 revision 就先阻斷）
    if (!params.forceReplaceRemote && folders.projectRevisionsFolderId) {
      const preScan = await listProjectRevisionMetadata({
        revisionsFolderId: folders.projectRevisionsFolderId,
        projectId: record.projectId,
        accountId,
        accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (!preScan.complete) {
        const incompleteErr =
          preScan.errorMessage || "無法完整掃描雲端 Revision 歷程，暫緩寫入以確保版本安全。";
        const errCommit = await commitAtomic("error", {
          driveFolderId: folders.projectFolderId,
          driveProjectFileId: targetFileId,
          driveRevisionsFolderId: folders.projectRevisionsFolderId,
          lastError: incompleteErr,
        });
        const recOut = errCommit.committed && errCommit.record ? errCommit.record : record;
        return {
          status: "error",
          record: recOut,
          retryable: true,
          errorMessage: incompleteErr,
        };
      }
      const ownTokens = new Set<string>([nextToken]);
      if (abandonedLocalDraftToken) ownTokens.add(abandonedLocalDraftToken);
      if (reusablePending) ownTokens.add(reusablePending.revisionToken);

      const preSiblings = findSiblingBranchRevisions({
        revisions: preScan.revisions,
        parentToken,
        targetRevision: nextRevision,
        ownTokensToIgnore: ownTokens,
      });
      if (preSiblings.length > 0) {
        const newestSibling = preSiblings[0];
        const siblingDoc = await downloadDriveJson<unknown>({
          fileId: newestSibling.fileId,
          accessToken,
          fileName: newestSibling.fileName || "revision.json",
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        }).catch(() => null);
        const siblingProject =
          validateProjectDocument(siblingDoc, { expectedAccountId: accountId }).project ??
          remoteProject ??
          null;

        let conflictSnapshotFileId = reusablePending?.revisionFileId;
        if (!conflictSnapshotFileId) {
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
              lhParentRevisionId: parentToken ?? "",
            },
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          }).catch(() => null);
          conflictSnapshotFileId = conflictFile?.id;
        }

        const conflictInfo: ProjectConflictInfo = {
          detectedAt: Date.now(),
          kind: "diverged",
          conflictSubType: "sibling_branch",
          localRevision: record.localRevision,
          localRevisionToken: record.project.revisionToken,
          localBaseRevision: record.lastSyncedRemoteRevision ?? record.localBaseRevision,
          remoteRevision: siblingProject?.revision ?? newestSibling.revision ?? nextRevision,
          remoteRevisionToken: newestSibling.revisionToken,
          remoteUpdatedAt: siblingProject?.updatedAt ?? newestSibling.modifiedTime,
          remoteProjectSnapshot: siblingProject,
          conflictSnapshotFileId,
          siblingRevisions: preSiblings,
          parentRevisionId: parentToken,
          reason: `偵測到跨裝置 Revision 分支衝突：同父版本${parentToken ? `（${parentToken}）` : ""}下已存在其他裝置寫入的 Revision（${newestSibling.revisionToken}），雙方版本皆已保留於 revisions/，請選擇處理方式。`,
        };
        const commitRes = await commitAtomic("conflict", {
          driveFolderId: folders.projectFolderId,
          driveProjectFileId: targetFileId,
          driveRevisionsFolderId: folders.projectRevisionsFolderId,
          knownRemoteRevision: conflictInfo.remoteRevision,
          knownRemoteRevisionToken: newestSibling.revisionToken,
          conflictInfo,
          lastError: conflictInfo.reason,
        });
        if (!commitRes.committed) {
          return commitRes.outcome === "idb_error"
            ? { status: "error", record, retryable: true, errorMessage: commitRes.errorMessage || "保存分支衝突狀態失敗。" }
            : { status: "cancelled", reason: commitRes.errorMessage || "專案狀態已變更。" };
        }
        return {
          status: "conflict",
          record: commitRes.record,
          conflictInfo: commitRes.record.conflictInfo ?? conflictInfo,
        };
      }
    }

    const stage2AlreadyDone = Boolean(
      reusablePending &&
        remoteProject &&
        (remoteProject.revisionToken === reusablePending.revisionToken ||
          remoteMetaRevisionToken === reusablePending.revisionToken),
    );

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

    // 階段 1：若尚無可恢復 Revision 快照，先寫入不可變 Revision 快照至 revisions/，並立刻紀錄 pendingRevisionPublish
    let revFileId = reusablePending?.revisionFileId;
    if (!revFileId) {
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
          lhParentRevisionId: parentToken ?? "",
        },
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      revFileId = revFile.id;

      const pendingCommit = await commitAtomic("pending_index", {
        driveFolderId: folders.projectFolderId,
        driveProjectFileId: targetFileId,
        driveRevisionsFolderId: folders.projectRevisionsFolderId,
        pendingRevisionPublish: {
          revision: nextRevision,
          revisionToken: nextToken,
          parentRevisionId: parentToken,
          revisionFileId: revFileId,
          targetProjectFileId: targetFileId,
          localRevisionAtStart: record.localRevision,
          localTokenAtStart: record.project.revisionToken,
          createdAt: Date.now(),
        },
      });
      if (!pendingCommit.committed) {
        return pendingCommit.outcome === "idb_error"
          ? {
              status: "error",
              record,
              retryable: true,
              errorMessage: pendingCommit.errorMessage || "無法寫入二階段發布恢復狀態。",
            }
          : {
              status: "cancelled",
              reason: pendingCommit.errorMessage || "專案已刪除或同步世代過期。",
            };
      }
    }

    // 階段 2：更新或建立主索引 project.json（若 Stage 2 前一輪已寫成功則跳過重複寫入）
    let uploadedMainId = targetFileId;
    let uploadedMainVersion: string | number | undefined = remoteDriveVersion ?? undefined;
    if (!stage2AlreadyDone) {
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
          lhParentRevisionId: parentToken ?? "",
        },
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      uploadedMainId = uploadedMain.id;
      uploadedMainVersion = uploadedMain.version;
    }

    if (!uploadedMainId) {
      throw new Error("Google Drive 未回傳 project.json File ID。");
    }

    // 階段 3：寫後回讀驗證（檢查寫入期間是否遭其他裝置同時寫入不同 revisionToken）
    const verifyMeta = await getDriveFileMetadata(uploadedMainId, {
      accessToken,
      fields: "id,version,modifiedTime,appProperties",
      fileName: "project.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    if (
      verifyMeta?.appProperties?.lhRevisionToken &&
      verifyMeta.appProperties.lhRevisionToken !== nextToken
    ) {
      const winnerDoc = await downloadDriveJson<unknown>({
        fileId: uploadedMainId,
        accessToken,
        fileName: "project.json",
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      }).catch(() => null);
      const parsedWinner =
        validateProjectDocument(winnerDoc, {
          expectedAccountId: accountId,
        }).project ?? null;

      const conflictInfo: ProjectConflictInfo = {
        detectedAt: Date.now(),
        kind: "diverged",
        conflictSubType: "read_after_write_race",
        localRevision: record.localRevision,
        localRevisionToken: record.project.revisionToken,
        localBaseRevision: record.localBaseRevision,
        remoteRevision: parsedWinner?.revision ?? nextRevision,
        remoteRevisionToken: verifyMeta.appProperties.lhRevisionToken,
        remoteUpdatedAt: parsedWinner?.updatedAt,
        remoteProjectSnapshot: parsedWinner,
        conflictSnapshotFileId: revFileId,
        parentRevisionId: parentToken,
        reason:
          "寫入期間另有其他裝置同時更新同一專案，雙方版本已分別保存於 revisions/，請選擇如何處理衝突。",
      };
      const conflictCommit = await commitAtomic("conflict", {
        driveFolderId: folders.projectFolderId,
        driveProjectFileId: uploadedMainId,
        driveRevisionsFolderId: folders.projectRevisionsFolderId,
        knownRemoteRevision: conflictInfo.remoteRevision,
        knownRemoteRevisionToken: verifyMeta.appProperties.lhRevisionToken,
        knownRemoteDriveVersion:
          verifyMeta.version !== undefined ? String(verifyMeta.version) : null,
        pendingRevisionPublish: null,
        conflictInfo,
        lastError: conflictInfo.reason,
      });
      if (!conflictCommit.committed) {
        return conflictCommit.outcome === "idb_error"
          ? { status: "error", record, retryable: true, errorMessage: conflictCommit.errorMessage || "保存寫後衝突狀態失敗。" }
          : { status: "cancelled", reason: conflictCommit.errorMessage || "專案狀態已變更。" };
      }
      return {
        status: "conflict",
        record: conflictCommit.record,
        conflictInfo: conflictCommit.record.conflictInfo ?? conflictInfo,
      };
    }

    // 階段 4：即使 project.json 目前指向我們剛寫入的版本，仍掃描同父版本是否出現其他裝置的 Sibling Revision 分支
    if (!params.forceReplaceRemote && folders.projectRevisionsFolderId) {
      const postScan = await listProjectRevisionMetadata({
        revisionsFolderId: folders.projectRevisionsFolderId,
        projectId: record.projectId,
        accountId,
        accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (!postScan.complete) {
        const incompleteErr =
          postScan.errorMessage || "寫後無法完整掃描 revisions/ 驗證無並行分支，請重試同步。";
        const errCommit = await commitAtomic("error", {
          driveFolderId: folders.projectFolderId,
          driveProjectFileId: uploadedMainId,
          driveRevisionsFolderId: folders.projectRevisionsFolderId,
          lastError: incompleteErr,
        });
        return {
          status: "error",
          record: errCommit.committed && errCommit.record ? errCommit.record : record,
          retryable: true,
          errorMessage: incompleteErr,
        };
      }

      const ownTokens = new Set<string>([nextToken]);
      if (abandonedLocalDraftToken) ownTokens.add(abandonedLocalDraftToken);
      const siblings = findSiblingBranchRevisions({
        revisions: postScan.revisions,
        parentToken,
        targetRevision: nextRevision,
        ownTokensToIgnore: ownTokens,
      });

      if (siblings.length > 0) {
        const siblingRev = siblings[0];
        const siblingDoc = await downloadDriveJson<unknown>({
          fileId: siblingRev.fileId,
          accessToken,
          fileName: siblingRev.fileName || "revision.json",
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        }).catch(() => null);
        const siblingProject =
          validateProjectDocument(siblingDoc, { expectedAccountId: accountId }).project ?? null;

        const selfMeta: ProjectRevisionMetaSummary = {
          fileId: revFileId,
          revision: nextRevision,
          revisionToken: nextToken,
          parentRevisionId: parentToken,
        };
        const conflictInfo: ProjectConflictInfo = {
          detectedAt: Date.now(),
          kind: "diverged",
          conflictSubType: "sibling_branch",
          localRevision: record.localRevision,
          localRevisionToken: record.project.revisionToken,
          localBaseRevision: record.localBaseRevision,
          remoteRevision: siblingProject?.revision ?? siblingRev.revision ?? nextRevision,
          remoteRevisionToken: siblingRev.revisionToken,
          remoteUpdatedAt: siblingProject?.updatedAt ?? siblingRev.modifiedTime,
          remoteProjectSnapshot: siblingProject,
          conflictSnapshotFileId: revFileId,
          siblingRevisions: [selfMeta, ...siblings],
          parentRevisionId: parentToken,
          reason: `寫後掃描發現同父版本${parentToken ? `（${parentToken}）` : ""}下存在另一裝置之分支 Revision（${siblingRev.revisionToken}），雖主索引暫指向本裝置寫入版本，但為防靜默覆寫已保留雙方 Revision 並標記衝突。`,
        };
        const conflictCommit = await commitAtomic("conflict", {
          driveFolderId: folders.projectFolderId,
          driveProjectFileId: uploadedMainId,
          driveRevisionsFolderId: folders.projectRevisionsFolderId,
          knownRemoteRevision: conflictInfo.remoteRevision,
          knownRemoteRevisionToken: siblingRev.revisionToken,
          knownRemoteDriveVersion:
            verifyMeta?.version !== undefined ? String(verifyMeta.version) : null,
          pendingRevisionPublish: null,
          conflictInfo,
          lastError: conflictInfo.reason,
        });
        if (!conflictCommit.committed) {
          return conflictCommit.outcome === "idb_error"
            ? { status: "error", record, retryable: true, errorMessage: conflictCommit.errorMessage || "寫入分支衝突狀態失敗。" }
            : { status: "cancelled", reason: conflictCommit.errorMessage || "專案狀態已變更。" };
        }
        return {
          status: "conflict",
          record: conflictCommit.record,
          conflictInfo: conflictCommit.record.conflictInfo ?? conflictInfo,
        };
      }
    }

    const finalProject: BandProject = {
      ...preparedProject,
      driveProjectFileId: uploadedMainId,
    };
    const finalVersion =
      verifyMeta?.version !== undefined
        ? String(verifyMeta.version)
        : uploadedMainVersion !== undefined
          ? String(uploadedMainVersion)
          : null;

    const syncedCommit = await commitAtomic(
      "synced",
      {
        driveFolderId: folders.projectFolderId,
        driveProjectFileId: uploadedMainId,
        driveRevisionsFolderId: folders.projectRevisionsFolderId,
        syncedRevision: nextRevision,
        syncedRevisionToken: nextToken,
        knownRemoteRevision: nextRevision,
        knownRemoteRevisionToken: nextToken,
        knownRemoteDriveVersion: finalVersion,
        syncedAt: Date.now(),
        pendingRevisionPublish: null,
      },
      finalProject,
    );
    if (!syncedCommit.committed) {
      if (syncedCommit.outcome === "idb_error") {
        return {
          status: "error",
          record,
          retryable: true,
          errorMessage: syncedCommit.errorMessage || "寫入已同步狀態至本機資料庫失敗。",
        };
      }
      return {
        status: "cancelled",
        reason: syncedCommit.errorMessage || "專案已於同步完成前被刪除或切換帳戶。",
      };
    }

    return {
      status: "synced",
      record: syncedCommit.record,
      driveVersion: finalVersion,
      immutableRevisionFileId: revFileId,
      superseded: syncedCommit.superseded,
      needsFollowUpSync: syncedCommit.needsFollowUpSync,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "cancelled", reason: "雲端同步已中止。" };
    }
    if (err instanceof DriveApiError && err.code === "unauthorized") {
      const waitMsg = "Google 授權已過期，重新授權後可繼續同步（本機編輯已完整保留）。";
      const waitCommit = await commitAtomic("waiting_auth", {
        lastError: waitMsg,
      });
      if (!waitCommit.committed && waitCommit.outcome !== "idb_error") {
        return { status: "cancelled", reason: waitCommit.errorMessage || "同步工作已中止。" };
      }
      return {
        status: "waiting_auth",
        record:
          waitCommit.committed
            ? waitCommit.record
            : { ...record, syncStatus: "waiting_auth", lastError: waitMsg },
        errorMessage: waitMsg,
      };
    }
    const retryable =
      err instanceof DriveApiError ? err.retryable : !(err instanceof SyntaxError);
    const msg = err instanceof Error ? err.message : "Google Drive 同步專案失敗。";
    const errCommit = await commitAtomic("error", {
      lastError: msg,
    });
    if (!errCommit.committed && errCommit.outcome !== "idb_error") {
      return { status: "cancelled", reason: errCommit.errorMessage || "同步工作已中止。" };
    }
    return {
      status: "error",
      record:
        errCommit.committed
          ? errCommit.record
          : { ...record, syncStatus: "error", lastError: msg },
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

export interface CloudProjectsListResult {
  projects: Array<{ project: BandProject; driveVersion?: string | null }>;
  complete: boolean;
  truncated: boolean;
  incompleteReason?: PaginatedDriveIncompleteReason | "partial_failure";
  errorMessage?: string;
  failedProjectIds: string[];
  missingFileProjectIds: string[];
  folderPagesFetched: number;
  filePagesFetched: number;
}

/**
 * 完整分頁列出目前登入帳戶於 Google Drive `.loopHarmonizer/projects/` 內管理的全部專案 Metadata（僅讀小型 JSON，不下載 WAV）。
 * 明確區分完整清單與不完整清單，避免分頁遺漏造成 GC 誤判或 UI 誤宣稱已列出全部。
 */
export async function listCloudProjectsDetailed(params: {
  accountId: string;
  accessToken: string;
  strict?: boolean;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  maxRetriesPerPage?: number;
  retryDelayMs?: readonly number[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CloudProjectsListResult> {
  if (params.signal?.aborted) {
    throw new DOMException("已取消 Google Drive 專案清單讀取。", "AbortError");
  }

  const managedRes = await listManagedProjectsPaginated({
    accountId: params.accountId,
    accessToken: params.accessToken,
    pageSize: params.pageSize,
    maxPages: params.maxPages,
    maxItems: params.maxItems,
    maxRetriesPerPage: params.maxRetriesPerPage,
    retryDelayMs: params.retryDelayMs,
    strict: params.strict ?? true,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  if (params.strict && !managedRes.complete) {
    throw new Error(
      managedRes.errorMessage || "Google Drive 專案清單未完整讀取完畢。",
    );
  }

  const projects: Array<{ project: BandProject; driveVersion?: string | null }> = [];
  const failedProjectIds: string[] = [];
  const missingFileProjectIds: string[] = [];
  let firstErrorMessage = managedRes.errorMessage;

  for (const entry of managedRes.entries) {
    if (params.signal?.aborted) {
      throw new DOMException("已取消 Google Drive 專案清單讀取。", "AbortError");
    }
    if (!entry.projectFileId) {
      missingFileProjectIds.push(entry.projectId);
      if (params.strict) {
        throw new Error(`專案 ${entry.projectId} 缺少 project.json，無法驗證完整引用清單。`);
      }
      continue;
    }
    try {
      const loaded = await loadProjectFromDrive({
        projectFileId: entry.projectFileId,
        expectedAccountId: params.accountId,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (loaded.project.ownerAccountId === params.accountId) {
        projects.push(loaded);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      failedProjectIds.push(entry.projectId);
      if (!firstErrorMessage && err instanceof Error) {
        firstErrorMessage = err.message;
      }
      if (params.strict) {
        throw err;
      }
    }
  }

  const hasFailures = failedProjectIds.length > 0 || missingFileProjectIds.length > 0;
  const complete = managedRes.complete && !hasFailures;
  const incompleteReason =
    managedRes.incompleteReason ?? (hasFailures ? "partial_failure" : undefined);

  return {
    projects,
    complete,
    truncated: managedRes.truncated,
    incompleteReason,
    errorMessage: firstErrorMessage,
    failedProjectIds,
    missingFileProjectIds,
    folderPagesFetched: managedRes.folderPagesFetched,
    filePagesFetched: managedRes.filePagesFetched,
  };
}

/**
 * 列出目前登入帳戶於 Google Drive `.loopHarmonizer/projects/` 內管理的全部專案 Metadata（僅讀小型 JSON，不下載 WAV）。
 */
export async function listCloudProjects(params: {
  accountId: string;
  accessToken: string;
  strict?: boolean;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Array<{ project: BandProject; driveVersion?: string | null }>> {
  const res = await listCloudProjectsDetailed(params);
  if (params.strict && !res.complete) {
    throw new Error(res.errorMessage || "Google Drive 專案清單不完整。");
  }
  return res.projects;
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

  const managedRes = await listManagedProjectsPaginated({
    accountId: params.accountId,
    accessToken: params.accessToken,
    strict: true,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  const target = managedRes.entries.find((m) => m.projectId === params.projectId);
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

export type ProjectAutoSyncStatusEvent =
  | ProjectDriveSyncOutcome
  | { status: "local_saved"; record: PersistedProjectRecord }
  | { status: "local_save_error"; record: PersistedProjectRecord; errorMessage: string };

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
  onStatusChanged?: (projectId: string, outcome: ProjectAutoSyncStatusEvent) => void;
}

interface ProjectLocalWriteSlot {
  projectId: string;
  ownerAccountId: string;
  localTimer: ReturnType<typeof setTimeout> | null;
  pendingRecord: PersistedProjectRecord | null;
  pendingSuppressUi: boolean;
  inFlightFlush: Promise<void> | null;
  deleted: boolean;
  suppressUi: boolean;
  lastFlushFailedReason: string | null;
}

interface ProjectCloudSyncSlot {
  generation: number;
  ownerAccountId: string;
  driveTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  abortController: AbortController | null;
  pendingFollowUp: boolean;
  retryAttempt: number;
}

/**
 * 本機 Debounced 序列化寫入佇列 + 雲端 Google Drive 單飛合併同步控制器：
 * - 徹底分離本機保存（`localSlots`）與雲端傳輸取消（`cloudSlots`）的生命週期：
 *   切換帳號、登出、授權過期、切換專案或元件卸載時，立即中止舊帳戶雲端同步，但保留並安全 flush 尚未寫入之本機修改，絕不遺失，亦不誤將舊帳戶回呼掛載回新帳戶 UI。
 * - 使用者主動刪除專案時先 discard 待存佇列，並受 IndexedDB tombstone 保護絕不復活。
 * - 雲端同步全程以 `commitProjectSyncResultAtomically` 與 `onBeforeCommit` 保護，絕不以舊快照覆蓋較新本機修改。
 */
export class ProjectAutoSyncController {
  private readonly deps: ProjectAutoSyncControllerDeps;
  private readonly timer: AutoSyncTimerAdapter;
  private readonly localSlots = new Map<string, ProjectLocalWriteSlot>();
  private readonly cloudSlots = new Map<string, ProjectCloudSyncSlot>();
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

  private getOrCreateLocalSlot(projectId: string, ownerAccountId: string): ProjectLocalWriteSlot {
    let slot = this.localSlots.get(projectId);
    if (!slot) {
      slot = {
        projectId,
        ownerAccountId,
        localTimer: null,
        pendingRecord: null,
        pendingSuppressUi: false,
        inFlightFlush: null,
        deleted: false,
        suppressUi: false,
        lastFlushFailedReason: null,
      };
      this.localSlots.set(projectId, slot);
    } else if (ownerAccountId && slot.ownerAccountId !== ownerAccountId) {
      slot.ownerAccountId = ownerAccountId;
    }
    return slot;
  }

  private getOrCreateCloudSlot(projectId: string, ownerAccountId: string): ProjectCloudSyncSlot {
    let slot = this.cloudSlots.get(projectId);
    if (!slot) {
      slot = {
        generation: 1,
        ownerAccountId,
        driveTimer: null,
        retryTimer: null,
        inFlight: null,
        abortController: null,
        pendingFollowUp: false,
        retryAttempt: 0,
      };
      this.cloudSlots.set(projectId, slot);
    } else if (ownerAccountId && slot.ownerAccountId !== ownerAccountId) {
      slot.ownerAccountId = ownerAccountId;
    }
    return slot;
  }

  private runSerializedLocalFlush(
    slot: ProjectLocalWriteSlot,
    forceSuppressUi = false,
  ): Promise<void> {
    if (forceSuppressUi) {
      slot.pendingSuppressUi = true;
    }
    if (slot.inFlightFlush) {
      return slot.inFlightFlush;
    }

    const flushPromise = (async () => {
      slot.lastFlushFailedReason = null;
      while (!slot.deleted && slot.pendingRecord) {
        const target = slot.pendingRecord;
        const suppressUi = forceSuppressUi || slot.suppressUi || slot.pendingSuppressUi;
        slot.pendingRecord = null;
        slot.pendingSuppressUi = false;

        let savedOk = false;
        let savedRecord = target;
        let blockedReason: "project_deleted" | "stale_revision" | "idb_error" | undefined;
        let errorMessage: string | undefined;

        try {
          if (this.deps.saveLocalFn) {
            savedOk = await this.deps.saveLocalFn(target);
            if (!savedOk) {
              errorMessage = "本機儲存失敗。";
            }
          } else {
            const res = await saveLocalProjectEditAtomically(target);
            savedOk = res.saved;
            if (res.saved) {
              savedRecord = res.record;
            } else {
              blockedReason = res.reason;
              errorMessage = res.errorMessage;
            }
          }
        } catch (err) {
          savedOk = false;
          blockedReason = "idb_error";
          errorMessage = err instanceof Error ? err.message : "寫入本機專案資料庫失敗。";
        }

        if (slot.deleted || blockedReason === "project_deleted") {
          slot.deleted = true;
          slot.pendingRecord = null;
          if (this.localSlots.get(slot.projectId) === slot) {
            this.localSlots.delete(slot.projectId);
          }
          return;
        }

        if (!savedOk && blockedReason !== "stale_revision") {
          slot.lastFlushFailedReason = errorMessage ?? "寫入本機資料庫失敗。";
          if (!suppressUi) {
            this.deps.onStatusChanged?.(slot.projectId, {
              status: "local_save_error",
              record: target,
              errorMessage: slot.lastFlushFailedReason,
            });
          }
          return;
        }

        if (savedOk && !suppressUi && !slot.suppressUi) {
          this.deps.onStatusChanged?.(slot.projectId, {
            status: "local_saved",
            record: savedRecord,
          });
        }
      }
    })().finally(() => {
      if (slot.inFlightFlush === flushPromise) {
        slot.inFlightFlush = null;
      }
      if (
        !slot.deleted &&
        !slot.pendingRecord &&
        slot.localTimer === null &&
        this.localSlots.get(slot.projectId) === slot
      ) {
        // 清理已完全寫畢之空插槽（保留 tombstone/帳號隔離標記不需要長期駐留）
        this.localSlots.delete(slot.projectId);
      }
    });

    slot.inFlightFlush = flushPromise;
    return flushPromise;
  }

  scheduleProjectEdit(
    record: PersistedProjectRecord,
    options?: { immediateLocal?: boolean; syncImmediately?: boolean },
  ): void {
    const localSlot = this.getOrCreateLocalSlot(record.projectId, record.ownerAccountId);
    if (localSlot.deleted) return;

    if (
      !localSlot.pendingRecord ||
      record.localRevision >= localSlot.pendingRecord.localRevision
    ) {
      localSlot.pendingRecord = record;
      localSlot.pendingSuppressUi = false;
      localSlot.suppressUi = false;
      localSlot.ownerAccountId = record.ownerAccountId;
    }

    if (localSlot.localTimer !== null) {
      this.timer.clearTimeout(localSlot.localTimer);
      localSlot.localTimer = null;
    }

    if (options?.immediateLocal) {
      void this.runSerializedLocalFlush(localSlot);
    } else {
      localSlot.localTimer = this.timer.setTimeout(() => {
        localSlot.localTimer = null;
        void this.runSerializedLocalFlush(localSlot);
      }, this.localDebounceMs);
    }

    if (record.storageProvider !== "google_drive" || !record.ownerAccountId) {
      return;
    }

    const cloudSlot = this.getOrCreateCloudSlot(record.projectId, record.ownerAccountId);
    if (cloudSlot.retryTimer !== null) {
      this.timer.clearTimeout(cloudSlot.retryTimer);
      cloudSlot.retryTimer = null;
    }
    cloudSlot.retryAttempt = 0;

    if (cloudSlot.driveTimer !== null) {
      this.timer.clearTimeout(cloudSlot.driveTimer);
      cloudSlot.driveTimer = null;
    }

    if (cloudSlot.inFlight) {
      // 同步進行中若有新編輯，標記 pendingFollowUp 待目前同步條件提交後自動續傳新版
      cloudSlot.pendingFollowUp = true;
      return;
    }

    if (options?.syncImmediately) {
      void this.triggerDriveSync(record.projectId);
      return;
    }

    cloudSlot.driveTimer = this.timer.setTimeout(() => {
      cloudSlot.driveTimer = null;
      void this.triggerDriveSync(record.projectId);
    }, this.driveDebounceMs);
  }

  async flushLocalSaves(options?: {
    projectId?: string;
    ownerAccountId?: string;
    suppressStatusCallback?: boolean;
  }): Promise<{ flushedProjectIds: string[]; failed: Array<{ projectId: string; reason: string }> }> {
    const tasks: Array<Promise<void>> = [];
    const targetSlots: ProjectLocalWriteSlot[] = [];

    for (const [projectId, slot] of this.localSlots.entries()) {
      if (options?.projectId && projectId !== options.projectId) continue;
      if (options?.ownerAccountId && slot.ownerAccountId !== options.ownerAccountId) continue;
      if (slot.deleted) continue;

      if (slot.localTimer !== null) {
        this.timer.clearTimeout(slot.localTimer);
        slot.localTimer = null;
      }
      if (slot.pendingRecord || slot.inFlightFlush) {
        if (options?.suppressStatusCallback) {
          slot.suppressUi = true;
          slot.pendingSuppressUi = true;
        }
        targetSlots.push(slot);
        tasks.push(this.runSerializedLocalFlush(slot, Boolean(options?.suppressStatusCallback)));
      }
    }

    await Promise.all(tasks);
    const flushedProjectIds: string[] = [];
    const failed: Array<{ projectId: string; reason: string }> = [];
    for (const slot of targetSlots) {
      if (slot.lastFlushFailedReason) {
        failed.push({ projectId: slot.projectId, reason: slot.lastFlushFailedReason });
      } else if (!slot.deleted) {
        flushedProjectIds.push(slot.projectId);
      }
    }
    return { flushedProjectIds, failed };
  }

  async triggerDriveSync(
    projectId: string,
    options?: { forceReplaceRemote?: boolean },
  ): Promise<ProjectDriveSyncOutcome | null> {
    const existingCloudSlot = this.cloudSlots.get(projectId);
    if (existingCloudSlot?.inFlight) {
      existingCloudSlot.pendingFollowUp = true;
      await existingCloudSlot.inFlight;
      return null;
    }

    // 先把還在 500ms 防抖或佇列中的本機編輯寫入 IDB，確保同步送出前即讀到最新狀態
    await this.flushLocalSaves({ projectId, suppressStatusCallback: true });

    const latestFromDb = await getProjectRecord(projectId);
    const localSlotPending = this.localSlots.get(projectId)?.pendingRecord ?? null;
    const current = latestFromDb ?? localSlotPending;
    if (!current || current.storageProvider !== "google_drive" || !current.ownerAccountId) {
      return null;
    }
    if (await isProjectDeleted(projectId)) {
      await this.invalidateProject(projectId, { discardPendingLocal: true });
      return { status: "cancelled", reason: "專案已刪除。" };
    }
    if (current.syncStatus === "conflict" && !options?.forceReplaceRemote) {
      return null;
    }

    const activeSlot = this.getOrCreateCloudSlot(projectId, current.ownerAccountId);
    if (activeSlot.driveTimer !== null) {
      this.timer.clearTimeout(activeSlot.driveTimer);
      activeSlot.driveTimer = null;
    }
    if (activeSlot.retryTimer !== null) {
      this.timer.clearTimeout(activeSlot.retryTimer);
      activeSlot.retryTimer = null;
    }

    const expectedBase = {
      ownerAccountId: current.ownerAccountId,
      syncGeneration: current.syncGeneration,
      localRevision: current.localRevision,
      revisionToken: current.project.revisionToken,
    };

    const auth = this.deps.getAuthContext();
    if (!auth.accountId || !auth.accessToken || auth.accountId !== current.ownerAccountId) {
      const waitMsg = "尚未登入或授權過期，等待重新授權後同步（已保存於本機）。";
      const commitRes = await commitProjectSyncResultAtomically({
        projectId,
        expectedBase,
        kind: "waiting_auth",
        remoteMetadata: { lastError: waitMsg },
      });
      if (!commitRes.committed && commitRes.outcome !== "idb_error") {
        return { status: "cancelled", reason: commitRes.errorMessage || "專案狀態已變更。" };
      }
      const waitingRec = commitRes.committed
        ? commitRes.record
        : { ...current, syncStatus: "waiting_auth" as const, lastError: waitMsg };
      await saveProjectSyncJob({
        projectId,
        ownerAccountId: current.ownerAccountId,
        status: "waiting_auth",
        attempts: activeSlot.retryAttempt,
        syncGeneration: activeSlot.generation,
        lastError: waitingRec.lastError ?? undefined,
        updatedAt: Date.now(),
      });
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
      const offlineMsg = "目前處於離線狀態，待恢復連線後將自動同步。";
      const commitRes = await commitProjectSyncResultAtomically({
        projectId,
        expectedBase,
        kind: "error",
        remoteMetadata: { lastError: offlineMsg },
      });
      const offlineRec =
        commitRes.committed
          ? commitRes.record
          : { ...current, syncStatus: "error" as const, lastError: offlineMsg };
      const out: ProjectDriveSyncOutcome = {
        status: "error",
        record: offlineRec,
        retryable: true,
        errorMessage: offlineMsg,
      };
      this.deps.onStatusChanged?.(projectId, out);
      return out;
    }

    const capturedSlotGen = activeSlot.generation;
    const capturedAuthGen = auth.generation;
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
      });

      const freshRecord = (await getProjectRecord(projectId)) ?? current;
      const outcome = await syncFn({
        record: freshRecord,
        accountId: auth.accountId!,
        accessToken: auth.accessToken!,
        generation: capturedAuthGen,
        isGenerationValid: (g, a) =>
          activeSlot.generation === capturedSlotGen &&
          this.cloudSlots.get(projectId) === activeSlot &&
          auth.isGenerationValid(g, a),
        forceReplaceRemote: options?.forceReplaceRemote,
        onBeforeCommit: async () => {
          await this.flushLocalSaves({ projectId, suppressStatusCallback: true });
        },
        signal: controller.signal,
      });

      finalOutcome = outcome;

      if (
        activeSlot.generation !== capturedSlotGen ||
        this.cloudSlots.get(projectId) !== activeSlot
      ) {
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
        });
      } else if (outcome.status === "synced") {
        activeSlot.retryAttempt = 0;
        const stillHasLocalPending = Boolean(this.localSlots.get(projectId)?.pendingRecord);
        if (
          outcome.superseded ||
          outcome.needsFollowUpSync ||
          outcome.record.dirty ||
          stillHasLocalPending
        ) {
          activeSlot.pendingFollowUp = true;
        }
        await saveProjectSyncJob({
          projectId,
          ownerAccountId: current.ownerAccountId,
          status: activeSlot.pendingFollowUp ? "queued" : "idle",
          attempts: 0,
          syncGeneration: capturedSlotGen,
          updatedAt: Date.now(),
        });
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
        });
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
          });
          activeSlot.retryTimer = this.timer.setTimeout(() => {
            activeSlot.retryTimer = null;
            if (
              activeSlot.generation === capturedSlotGen &&
              this.cloudSlots.get(projectId) === activeSlot
            ) {
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
          });
        }
      }

      if (
        activeSlot.generation === capturedSlotGen &&
        this.cloudSlots.get(projectId) === activeSlot
      ) {
        this.deps.onStatusChanged?.(projectId, outcome);
      }
    })().finally(() => {
      if (activeSlot.inFlight === run) {
        activeSlot.inFlight = null;
      }
      if (activeSlot.abortController === controller) {
        activeSlot.abortController = null;
      }
      if (
        activeSlot.pendingFollowUp &&
        activeSlot.generation === capturedSlotGen &&
        this.cloudSlots.get(projectId) === activeSlot
      ) {
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
    await this.flushLocalSaves({ ownerAccountId: accountId, suppressStatusCallback: true });
    const { listCloudCachedProjectRecordsByAccount } = await import("../storage/projectStore.ts");
    const cached = await listCloudCachedProjectRecordsByAccount(accountId);
    for (const rec of cached) {
      if (rec.dirty && rec.syncStatus !== "conflict") {
        await this.triggerDriveSync(rec.projectId);
      }
    }
  }

  invalidateProject(
    projectId: string,
    options?: { discardPendingLocal?: boolean },
  ): Promise<void> {
    const cloudSlot = this.cloudSlots.get(projectId);
    if (cloudSlot) {
      cloudSlot.generation += 1;
      cloudSlot.pendingFollowUp = false;
      if (cloudSlot.driveTimer !== null) this.timer.clearTimeout(cloudSlot.driveTimer);
      if (cloudSlot.retryTimer !== null) this.timer.clearTimeout(cloudSlot.retryTimer);
      cloudSlot.abortController?.abort();
      this.cloudSlots.delete(projectId);
    }

    const localSlot = this.localSlots.get(projectId);
    if (!localSlot) {
      return Promise.resolve();
    }

    if (options?.discardPendingLocal !== false) {
      // 主動刪除專案情境：放棄尚未寫入之暫存並停止後續本機寫入，遵守 tombstone
      localSlot.deleted = true;
      localSlot.pendingRecord = null;
      if (localSlot.localTimer !== null) {
        this.timer.clearTimeout(localSlot.localTimer);
        localSlot.localTimer = null;
      }
      this.localSlots.delete(projectId);
      return Promise.resolve();
    }

    // 非刪除情境（切換專案等）：先停止 UI 回呼，立即將待提交本機修改寫入 IDB
    localSlot.suppressUi = true;
    localSlot.pendingSuppressUi = true;
    return this.flushLocalSaves({
      projectId,
      suppressStatusCallback: true,
    }).then(() => undefined);
  }

  invalidateAccount(accountId: string | null | undefined): Promise<void> {
    if (!accountId) return Promise.resolve();
    for (const [projectId, cloudSlot] of this.cloudSlots.entries()) {
      if (cloudSlot.ownerAccountId === accountId) {
        cloudSlot.generation += 1;
        cloudSlot.pendingFollowUp = false;
        if (cloudSlot.driveTimer !== null) this.timer.clearTimeout(cloudSlot.driveTimer);
        if (cloudSlot.retryTimer !== null) this.timer.clearTimeout(cloudSlot.retryTimer);
        cloudSlot.abortController?.abort();
        this.cloudSlots.delete(projectId);
      }
    }

    for (const localSlot of this.localSlots.values()) {
      if (localSlot.ownerAccountId === accountId) {
        localSlot.suppressUi = true;
        localSlot.pendingSuppressUi = true;
      }
    }

    return this.flushLocalSaves({
      ownerAccountId: accountId,
      suppressStatusCallback: true,
    }).then(() => undefined);
  }

  dispose(): Promise<void> {
    for (const [projectId, cloudSlot] of this.cloudSlots.entries()) {
      cloudSlot.generation += 1;
      cloudSlot.pendingFollowUp = false;
      if (cloudSlot.driveTimer !== null) this.timer.clearTimeout(cloudSlot.driveTimer);
      if (cloudSlot.retryTimer !== null) this.timer.clearTimeout(cloudSlot.retryTimer);
      cloudSlot.abortController?.abort();
      this.cloudSlots.delete(projectId);
    }

    for (const localSlot of this.localSlots.values()) {
      localSlot.suppressUi = true;
      localSlot.pendingSuppressUi = true;
    }

    return this.flushLocalSaves({ suppressStatusCallback: true }).then(() => undefined);
  }
}
