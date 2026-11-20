import type { WebLockAdapter } from "../separation/separationResumeController.ts";
import {
  PROJECT_OWNER_ACCOUNT_INDEX,
  PROJECT_PROVIDER_INDEX,
  PROJECT_SYNC_ACCOUNT_INDEX,
  idbGet,
  idbGetAll,
  idbRequestPromise,
  withIdbTransaction,
} from "./indexedDb.ts";
import { computeProjectBackupSummary } from "../projects/projectModel.ts";
import type {
  BandProject,
  PendingProjectRevisionPublish,
  PersistedProjectRecord,
  PersistedProjectSyncJob,
  ProjectConflictInfo,
  ProjectSongArtifactRef,
  ProjectStorageProvider,
} from "../projects/projectTypes.ts";

const ACTIVE_PROJECT_PREF_KEY = "active-project";
const LEGACY_MIGRATION_PREF_KEY = "legacy-band-session-migrations";
const DELETED_PROJECTS_PREF_KEY = "deleted-project-tombstones";
const ACCOUNT_IDENTITY_LINKS_PREF_KEY = "verified-account-identity-links";
const PROJECT_SYNC_CHANNEL = "loop-harmonizer-project-sync";
const MAX_TOMBSTONES = 200;

export interface ActiveProjectPreferenceRecord {
  key: string;
  projectId: string | null;
  updatedAt: number;
}

export interface LegacyMigrationEntry {
  fingerprint: string;
  projectId: string;
  projectName: string;
  migratedAt: number;
}

export interface LegacyMigrationPreferenceRecord {
  key: string;
  entries: LegacyMigrationEntry[];
  updatedAt: number;
}

export interface DeletedProjectsPreferenceRecord {
  key: string;
  deletedIds: string[];
  updatedAt: number;
}

export interface AccountIdentityLinksPreferenceRecord {
  key: string;
  /** drivePermissionAccountId ("drive:...") -> canonical googleSubAccountId ("google:...") */
  drivePermToGoogleSub: Record<string, string>;
  updatedAt: number;
}

export type ProjectBroadcastMessage =
  | { type: "project-saved"; projectId: string; revision: number; updatedAt: number }
  | { type: "project-deleted"; projectId: string }
  | { type: "active-project-changed"; projectId: string | null };

export function postProjectSyncBroadcast(msg: ProjectBroadcastMessage): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(PROJECT_SYNC_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    // ignore environments without BroadcastChannel
  }
}

export function subscribeProjectSyncBroadcast(
  handler: (msg: ProjectBroadcastMessage) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(PROJECT_SYNC_CHANNEL);
    ch.onmessage = (event: MessageEvent<ProjectBroadcastMessage>) => {
      if (event.data) handler(event.data);
    };
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      ch?.close();
    } catch {
      // ignore
    }
  };
}

export async function withProjectWriteLock<T>(
  projectId: string,
  runner: () => Promise<T>,
  lockAdapter?: WebLockAdapter | null,
): Promise<T> {
  const locks: WebLockAdapter | null | undefined =
    lockAdapter === undefined
      ? typeof navigator !== "undefined"
        ? (navigator.locks as unknown as WebLockAdapter | undefined)
        : undefined
      : lockAdapter;
  if (!locks?.request) {
    return runner();
  }
  return locks.request(
    `loop-harmonizer:project-write:${projectId}`,
    { ifAvailable: false } as unknown as { ifAvailable: boolean },
    async () => runner(),
  );
}

export async function getProjectRecord(projectId: string): Promise<PersistedProjectRecord | null> {
  if (!projectId) return null;
  return idbGet<PersistedProjectRecord>("projects", projectId).catch(() => null);
}

export async function getAllProjectRecords(): Promise<PersistedProjectRecord[]> {
  const rows = await idbGetAll<PersistedProjectRecord>("projects").catch(() => []);
  return rows.sort((a, b) => Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt));
}

export async function listProjectRecords(options?: {
  includeLocal?: boolean;
  ownerAccountId?: string | null;
  storageProvider?: ProjectStorageProvider;
}): Promise<PersistedProjectRecord[]> {
  const includeLocal = options?.includeLocal ?? true;
  const all = await getAllProjectRecords();
  return all.filter((rec) => {
    if (options?.storageProvider && rec.storageProvider !== options.storageProvider) {
      return false;
    }
    if (rec.storageProvider === "local") {
      return includeLocal;
    }
    if (!options?.ownerAccountId) {
      return false;
    }
    return rec.ownerAccountId === options.ownerAccountId;
  });
}

export async function listCloudCachedProjectRecordsByAccount(
  ownerAccountId: string,
): Promise<PersistedProjectRecord[]> {
  if (!ownerAccountId) return [];
  return withIdbTransaction("projects", "readonly", async (tx) => {
    const store = tx.objectStore("projects");
    const rows =
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(PROJECT_OWNER_ACCOUNT_INDEX))
        ? ((await idbRequestPromise(
            store.index(PROJECT_OWNER_ACCOUNT_INDEX).getAll(ownerAccountId),
          )) as PersistedProjectRecord[])
        : ((await idbRequestPromise(store.getAll())) as PersistedProjectRecord[]).filter(
            (r) => r.ownerAccountId === ownerAccountId,
          );
    return rows.filter(
      (r) => r.storageProvider === "google_drive" && r.ownerAccountId === ownerAccountId,
    );
  }).catch(() => []);
}

export async function listLocalOnlyProjectRecords(): Promise<PersistedProjectRecord[]> {
  return withIdbTransaction("projects", "readonly", async (tx) => {
    const store = tx.objectStore("projects");
    const rows =
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(PROJECT_PROVIDER_INDEX))
        ? ((await idbRequestPromise(
            store.index(PROJECT_PROVIDER_INDEX).getAll("local"),
          )) as PersistedProjectRecord[])
        : ((await idbRequestPromise(store.getAll())) as PersistedProjectRecord[]).filter(
            (r) => r.storageProvider === "local",
          );
    return rows;
  }).catch(() => []);
}

export async function isProjectDeleted(projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const rec = await idbGet<DeletedProjectsPreferenceRecord>(
    "projectPreferences",
    DELETED_PROJECTS_PREF_KEY,
  ).catch(() => null);
  return Boolean(rec?.deletedIds?.includes(projectId));
}

export type SaveProjectRecordResult =
  | { saved: true; record: PersistedProjectRecord }
  | {
      saved: false;
      reason: "project_deleted" | "stale_revision" | "idb_error";
      errorMessage?: string;
      currentRecord?: PersistedProjectRecord;
    };

export interface ProjectSyncExpectedBase {
  ownerAccountId: string;
  syncGeneration: number;
  localRevision: number;
  revisionToken: string;
}

export interface ProjectSyncRemoteMetadataPatch {
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
}

export type ConditionalProjectSyncCommitResult =
  | {
      committed: true;
      outcome: "exact_committed" | "superseded_metadata_merged";
      superseded: boolean;
      needsFollowUpSync: boolean;
      record: PersistedProjectRecord;
    }
  | {
      committed: false;
      outcome:
        | "project_deleted"
        | "project_missing"
        | "account_mismatch"
        | "generation_mismatch"
        | "idb_error";
      record: PersistedProjectRecord | null;
      errorMessage?: string;
    };

export async function saveProjectRecord(
  record: PersistedProjectRecord,
  options?: {
    allowCreateIfDeleted?: boolean;
    preserveNewerRemoteMetadata?: boolean;
    rejectIfStaleRevision?: boolean;
    lockAdapter?: WebLockAdapter | null;
    silentBroadcast?: boolean;
  },
): Promise<SaveProjectRecordResult> {
  try {
    const outcome = await withProjectWriteLock(
      record.projectId,
      () =>
        withIdbTransaction(["projects", "projectPreferences"], "readwrite", async (tx) => {
          const projStore = tx.objectStore("projects");
          const prefStore = tx.objectStore("projectPreferences");

          const tomb = (await idbRequestPromise(
            prefStore.get(DELETED_PROJECTS_PREF_KEY),
          )) as DeletedProjectsPreferenceRecord | undefined;

          if (tomb?.deletedIds?.includes(record.projectId)) {
            if (!options?.allowCreateIfDeleted) {
              return { saved: false as const, reason: "project_deleted" as const };
            }
            const filtered = tomb.deletedIds.filter((id) => id !== record.projectId);
            await idbRequestPromise(
              prefStore.put({
                key: DELETED_PROJECTS_PREF_KEY,
                deletedIds: filtered,
                updatedAt: Date.now(),
              } satisfies DeletedProjectsPreferenceRecord),
            );
          }

          let recordToWrite = record;
          if (options?.preserveNewerRemoteMetadata || options?.rejectIfStaleRevision) {
            const existing = (await idbRequestPromise(
              projStore.get(record.projectId),
            )) as PersistedProjectRecord | undefined;

            if (existing) {
              if (
                options?.rejectIfStaleRevision &&
                existing.localRevision > record.localRevision
              ) {
                return {
                  saved: false as const,
                  reason: "stale_revision" as const,
                  currentRecord: existing,
                };
              }

              if (
                options?.preserveNewerRemoteMetadata &&
                existing.storageProvider === "google_drive" &&
                record.storageProvider === "google_drive" &&
                existing.ownerAccountId === record.ownerAccountId
              ) {
                const existingSyncedRev = existing.lastSyncedRemoteRevision ?? -1;
                const incomingSyncedRev = record.lastSyncedRemoteRevision ?? -1;
                const keepRemoteBaseFromExisting = existingSyncedRev > incomingSyncedRev;

                const existingKnownRev = existing.lastKnownRemoteRevision ?? -1;
                const incomingKnownRev = record.lastKnownRemoteRevision ?? -1;
                const keepKnownFromExisting = existingKnownRev > incomingKnownRev;

                const hasSyncedPastConflict =
                  existing.syncStatus === "conflict" &&
                  record.syncStatus !== "conflict" &&
                  (record.conflictInfo ?? null) === null;

                recordToWrite = {
                  ...record,
                  project: {
                    ...record.project,
                    driveFolderId:
                      record.project.driveFolderId ?? existing.project.driveFolderId,
                    driveProjectFileId:
                      record.project.driveProjectFileId ?? existing.project.driveProjectFileId,
                    driveRevisionsFolderId:
                      record.project.driveRevisionsFolderId ??
                      existing.project.driveRevisionsFolderId,
                  },
                  localBaseRevision: keepRemoteBaseFromExisting
                    ? existing.localBaseRevision
                    : record.localBaseRevision,
                  localBaseRevisionToken: keepRemoteBaseFromExisting
                    ? existing.localBaseRevisionToken
                    : record.localBaseRevisionToken,
                  lastSyncedRemoteRevision: keepRemoteBaseFromExisting
                    ? existing.lastSyncedRemoteRevision
                    : record.lastSyncedRemoteRevision,
                  lastSyncedRemoteRevisionToken: keepRemoteBaseFromExisting
                    ? existing.lastSyncedRemoteRevisionToken
                    : record.lastSyncedRemoteRevisionToken,
                  lastKnownRemoteRevision: keepKnownFromExisting
                    ? existing.lastKnownRemoteRevision
                    : record.lastKnownRemoteRevision,
                  lastKnownRemoteRevisionToken: keepKnownFromExisting
                    ? existing.lastKnownRemoteRevisionToken
                    : record.lastKnownRemoteRevisionToken,
                  lastKnownRemoteDriveVersion: keepKnownFromExisting
                    ? existing.lastKnownRemoteDriveVersion
                    : record.lastKnownRemoteDriveVersion,
                  lastSyncedAt:
                    Math.max(existing.lastSyncedAt ?? 0, record.lastSyncedAt ?? 0) || null,
                  pendingRevisionPublish:
                    record.pendingRevisionPublish ?? existing.pendingRevisionPublish ?? null,
                  dirty:
                    record.dirty ||
                    (keepRemoteBaseFromExisting &&
                      record.localRevision > existing.localBaseRevision),
                  syncStatus: hasSyncedPastConflict
                    ? "conflict"
                    : record.syncStatus,
                  conflictInfo: hasSyncedPastConflict
                    ? existing.conflictInfo
                    : record.conflictInfo,
                };
              }
            }
          }

          const sanitized: PersistedProjectRecord = {
            ...recordToWrite,
            key: recordToWrite.projectId,
            ownerAccountId:
              recordToWrite.storageProvider === "google_drive"
                ? recordToWrite.ownerAccountId || recordToWrite.project.ownerAccountId || ""
                : "",
            lastSavedAt: Date.now(),
          };
          await idbRequestPromise(projStore.put(sanitized));
          return { saved: true as const, record: sanitized };
        }),
      options?.lockAdapter,
    );

    if (outcome.saved && !options?.silentBroadcast) {
      postProjectSyncBroadcast({
        type: "project-saved",
        projectId: outcome.record.projectId,
        revision: outcome.record.localRevision,
        updatedAt: outcome.record.lastSavedAt,
      });
    }
    return outcome;
  } catch (err) {
    return {
      saved: false,
      reason: "idb_error",
      errorMessage: err instanceof Error ? err.message : "寫入本機專案資料庫失敗。",
    };
  }
}

export async function saveLocalProjectEditAtomically(
  record: PersistedProjectRecord,
  options?: {
    allowCreateIfDeleted?: boolean;
    lockAdapter?: WebLockAdapter | null;
    silentBroadcast?: boolean;
  },
): Promise<SaveProjectRecordResult> {
  return saveProjectRecord(record, {
    ...options,
    rejectIfStaleRevision: true,
    preserveNewerRemoteMetadata: true,
  });
}

function mergeDriveIdsOnProject(
  project: BandProject,
  meta: ProjectSyncRemoteMetadataPatch,
): BandProject {
  const driveFolderId = meta.driveFolderId ?? project.driveFolderId;
  const driveProjectFileId = meta.driveProjectFileId ?? project.driveProjectFileId;
  const driveRevisionsFolderId =
    meta.driveRevisionsFolderId ?? project.driveRevisionsFolderId;
  if (
    driveFolderId === project.driveFolderId &&
    driveProjectFileId === project.driveProjectFileId &&
    driveRevisionsFolderId === project.driveRevisionsFolderId
  ) {
    return project;
  }
  return {
    ...project,
    driveFolderId,
    driveProjectFileId,
    driveRevisionsFolderId,
  };
}

/**
 * 單一 IndexedDB readwrite transaction 內的條件式雲端同步提交：
 * - 若本機 localRevision/revisionToken 與 expectedBase 完全一致，正常更新完整同步狀態（synced/conflict/...）。
 * - 若同步期間本機已更新（例如 localRevision=11 > 10），嚴禁覆蓋 current.project.songs / 混音設定 / localRevision / dirty，
 *   只在相同專案與帳戶前提下安全合併遠端同步基準與 Drive File ID，並強制維持 dirty=true 等待下一次同步。
 * - 若交易或寫入失敗，明確回傳 outcome="idb_error"（committed=false），絕不誤判成功。
 */
export async function commitProjectSyncResultAtomically(params: {
  projectId: string;
  expectedBase: ProjectSyncExpectedBase;
  kind: "synced" | "conflict" | "waiting_auth" | "error" | "remote_ahead" | "pending_index";
  remoteMetadata: ProjectSyncRemoteMetadataPatch;
  syncedProjectForExactMatch?: BandProject;
  lockAdapter?: WebLockAdapter | null;
  silentBroadcast?: boolean;
}): Promise<ConditionalProjectSyncCommitResult> {
  if (!params.projectId) {
    return {
      committed: false,
      outcome: "project_missing",
      record: null,
      errorMessage: "缺少 projectId。",
    };
  }

  let outcome: ConditionalProjectSyncCommitResult;
  try {
    outcome = await withProjectWriteLock(
      params.projectId,
      () =>
        withIdbTransaction(["projects", "projectPreferences"], "readwrite", async (tx) => {
          const projStore = tx.objectStore("projects");
          const prefStore = tx.objectStore("projectPreferences");

          const tomb = (await idbRequestPromise(
            prefStore.get(DELETED_PROJECTS_PREF_KEY),
          )) as DeletedProjectsPreferenceRecord | undefined;
          if (tomb?.deletedIds?.includes(params.projectId)) {
            return {
              committed: false as const,
              outcome: "project_deleted" as const,
              record: null,
              errorMessage: "專案已於本機刪除。",
            };
          }

          const current = (await idbRequestPromise(
            projStore.get(params.projectId),
          )) as PersistedProjectRecord | undefined;
          if (!current) {
            return {
              committed: false as const,
              outcome: "project_missing" as const,
              record: null,
              errorMessage: "找不到目標專案記錄。",
            };
          }
          if (
            current.storageProvider !== "google_drive" ||
            current.ownerAccountId !== params.expectedBase.ownerAccountId
          ) {
            return {
              committed: false as const,
              outcome: "account_mismatch" as const,
              record: current,
              errorMessage: "專案擁有帳戶已變更或不再屬於此 Google 帳號。",
            };
          }
          if (current.syncGeneration !== params.expectedBase.syncGeneration) {
            return {
              committed: false as const,
              outcome: "generation_mismatch" as const,
              record: current,
              errorMessage: "同步世代已過期。",
            };
          }

          const hasExactMatch =
            current.localRevision === params.expectedBase.localRevision &&
            current.project.revisionToken === params.expectedBase.revisionToken;
          const isCallerAheadOfStaleDb =
            current.localRevision < params.expectedBase.localRevision;
          const canApplyPreparedContent = hasExactMatch || isCallerAheadOfStaleDb;
          const now = Date.now();
          const meta = params.remoteMetadata;
          let updated: PersistedProjectRecord;
          let needsFollowUpSync = false;

          if (params.kind === "synced") {
            const syncedRev = meta.syncedRevision ?? params.expectedBase.localRevision;
            const syncedToken = meta.syncedRevisionToken ?? params.expectedBase.revisionToken;
            if (canApplyPreparedContent) {
              const targetProj = mergeDriveIdsOnProject(
                params.syncedProjectForExactMatch ?? current.project,
                meta,
              );
              updated = {
                ...current,
                project: targetProj,
                localBaseRevision: syncedRev,
                localBaseRevisionToken: syncedToken,
                localRevision: syncedRev,
                lastSyncedRemoteRevision: syncedRev,
                lastSyncedRemoteRevisionToken: syncedToken,
                lastKnownRemoteRevision: meta.knownRemoteRevision ?? syncedRev,
                lastKnownRemoteRevisionToken: meta.knownRemoteRevisionToken ?? syncedToken,
                lastKnownRemoteDriveVersion:
                  meta.knownRemoteDriveVersion !== undefined
                    ? meta.knownRemoteDriveVersion
                    : current.lastKnownRemoteDriveVersion,
                pendingRevisionPublish: null,
                dirty: false,
                syncStatus: "synced",
                lastSavedAt: now,
                lastSyncedAt: meta.syncedAt ?? now,
                lastError: null,
                conflictInfo: null,
              };
            } else {
              // 本機已有更新修改（current.localRevision > expectedBase 或同版本不同 token）：
              // 嚴禁覆寫 current.project.songs / settings / localRevision / dirty
              const nextProjWithIds = mergeDriveIdsOnProject(current.project, meta);
              needsFollowUpSync = true;
              updated = {
                ...current,
                project: nextProjWithIds,
                localBaseRevision: syncedRev,
                localBaseRevisionToken: syncedToken,
                lastSyncedRemoteRevision: syncedRev,
                lastSyncedRemoteRevisionToken: syncedToken,
                lastKnownRemoteRevision: meta.knownRemoteRevision ?? syncedRev,
                lastKnownRemoteRevisionToken: meta.knownRemoteRevisionToken ?? syncedToken,
                lastKnownRemoteDriveVersion:
                  meta.knownRemoteDriveVersion !== undefined
                    ? meta.knownRemoteDriveVersion
                    : current.lastKnownRemoteDriveVersion,
                pendingRevisionPublish: null,
                dirty: true,
                syncStatus: current.syncStatus === "conflict" ? "conflict" : "dirty",
                lastSyncedAt: meta.syncedAt ?? now,
                lastError: current.syncStatus === "conflict" ? current.lastError : null,
              };
            }
          } else if (params.kind === "conflict") {
            const nextProjWithIds = mergeDriveIdsOnProject(current.project, meta);
            const rawConflict = meta.conflictInfo ?? null;
            const adjustedConflict =
              rawConflict && !canApplyPreparedContent
                ? {
                    ...rawConflict,
                    localRevision: current.localRevision,
                    localRevisionToken: current.project.revisionToken,
                  }
                : rawConflict;
            updated = {
              ...current,
              project: nextProjWithIds,
              lastKnownRemoteRevision:
                meta.knownRemoteRevision !== undefined
                  ? meta.knownRemoteRevision
                  : current.lastKnownRemoteRevision,
              lastKnownRemoteRevisionToken:
                meta.knownRemoteRevisionToken !== undefined
                  ? meta.knownRemoteRevisionToken
                  : current.lastKnownRemoteRevisionToken,
              lastKnownRemoteDriveVersion:
                meta.knownRemoteDriveVersion !== undefined
                  ? meta.knownRemoteDriveVersion
                  : current.lastKnownRemoteDriveVersion,
              pendingRevisionPublish:
                meta.pendingRevisionPublish !== undefined
                  ? meta.pendingRevisionPublish
                  : current.pendingRevisionPublish,
              syncStatus: "conflict",
              conflictInfo: adjustedConflict,
              lastError: meta.lastError ?? adjustedConflict?.reason ?? current.lastError,
              lastSavedAt: canApplyPreparedContent ? now : current.lastSavedAt,
            };
          } else if (params.kind === "pending_index") {
            const nextProjWithIds = mergeDriveIdsOnProject(current.project, meta);
            updated = {
              ...current,
              project: nextProjWithIds,
              pendingRevisionPublish: canApplyPreparedContent
                ? (meta.pendingRevisionPublish ?? null)
                : current.pendingRevisionPublish ?? meta.pendingRevisionPublish ?? null,
            };
          } else if (params.kind === "remote_ahead") {
            const nextProjWithIds = mergeDriveIdsOnProject(current.project, meta);
            needsFollowUpSync = !canApplyPreparedContent && current.dirty;
            updated = {
              ...current,
              project: nextProjWithIds,
              lastKnownRemoteRevision:
                meta.knownRemoteRevision !== undefined
                  ? meta.knownRemoteRevision
                  : current.lastKnownRemoteRevision,
              lastKnownRemoteRevisionToken:
                meta.knownRemoteRevisionToken !== undefined
                  ? meta.knownRemoteRevisionToken
                  : current.lastKnownRemoteRevisionToken,
              lastKnownRemoteDriveVersion:
                meta.knownRemoteDriveVersion !== undefined
                  ? meta.knownRemoteDriveVersion
                  : current.lastKnownRemoteDriveVersion,
            };
          } else {
            // waiting_auth | error
            const nextProjWithIds = mergeDriveIdsOnProject(current.project, meta);
            needsFollowUpSync = !canApplyPreparedContent && current.dirty;
            const targetStatus =
              current.syncStatus === "conflict"
                ? "conflict"
                : params.kind === "waiting_auth"
                  ? "waiting_auth"
                  : "error";
            updated = {
              ...current,
              project: nextProjWithIds,
              lastKnownRemoteRevision:
                meta.knownRemoteRevision !== undefined
                  ? meta.knownRemoteRevision
                  : current.lastKnownRemoteRevision,
              lastKnownRemoteRevisionToken:
                meta.knownRemoteRevisionToken !== undefined
                  ? meta.knownRemoteRevisionToken
                  : current.lastKnownRemoteRevisionToken,
              lastKnownRemoteDriveVersion:
                meta.knownRemoteDriveVersion !== undefined
                  ? meta.knownRemoteDriveVersion
                  : current.lastKnownRemoteDriveVersion,
              syncStatus: targetStatus,
              lastError: meta.lastError ?? current.lastError,
            };
          }

          await idbRequestPromise(projStore.put(updated));
          return {
            committed: true as const,
            outcome: canApplyPreparedContent
              ? ("exact_committed" as const)
              : ("superseded_metadata_merged" as const),
            superseded: !canApplyPreparedContent,
            needsFollowUpSync,
            record: updated,
          };
        }),
      params.lockAdapter,
    );
  } catch (err) {
    return {
      committed: false,
      outcome: "idb_error",
      record: null,
      errorMessage: err instanceof Error ? err.message : "條件式同步寫入 IndexedDB 失敗。",
    };
  }

  if (outcome.committed && !params.silentBroadcast) {
    postProjectSyncBroadcast({
      type: "project-saved",
      projectId: outcome.record.projectId,
      revision: outcome.record.localRevision,
      updatedAt: outcome.record.lastSavedAt,
    });
  }
  return outcome;
}

export async function deleteProjectRecord(
  projectId: string,
  options?: { lockAdapter?: WebLockAdapter | null },
): Promise<{ deleted: boolean }> {
  if (!projectId) return { deleted: false };
  const deleted = await withProjectWriteLock(
    projectId,
    () =>
      withIdbTransaction(
        ["projects", "projectPreferences", "projectSyncJobs"],
        "readwrite",
        async (tx) => {
          const projStore = tx.objectStore("projects");
          const prefStore = tx.objectStore("projectPreferences");
          const jobStore = tx.objectStore("projectSyncJobs");

          const existing = await idbRequestPromise(projStore.get(projectId));
          await idbRequestPromise(projStore.delete(projectId));
          await idbRequestPromise(jobStore.delete(projectId));

          const activePref = (await idbRequestPromise(
            prefStore.get(ACTIVE_PROJECT_PREF_KEY),
          )) as ActiveProjectPreferenceRecord | undefined;
          if (activePref?.projectId === projectId) {
            await idbRequestPromise(
              prefStore.put({
                key: ACTIVE_PROJECT_PREF_KEY,
                projectId: null,
                updatedAt: Date.now(),
              } satisfies ActiveProjectPreferenceRecord),
            );
          }

          const tomb = (await idbRequestPromise(
            prefStore.get(DELETED_PROJECTS_PREF_KEY),
          )) as DeletedProjectsPreferenceRecord | undefined;
          const nextDeleted = Array.from(
            new Set([...(tomb?.deletedIds ?? []), projectId]),
          ).slice(-MAX_TOMBSTONES);
          await idbRequestPromise(
            prefStore.put({
              key: DELETED_PROJECTS_PREF_KEY,
              deletedIds: nextDeleted,
              updatedAt: Date.now(),
            } satisfies DeletedProjectsPreferenceRecord),
          );

          return Boolean(existing);
        },
      ),
    options?.lockAdapter,
  );

  postProjectSyncBroadcast({ type: "project-deleted", projectId });
  return { deleted };
}

/**
 * 背景分離完成時，安全將分離 ArtifactRef 寫回對應專案與歌曲項目：
 * - 若專案已刪除或歌曲項目已從該專案移除，絕不復活專案或誤寫其他專案。
 * - 只更新 artifactRef 與 settings.separationMode，絕不覆寫專案內的 BPM/Key/音量/Mute/Solo。
 */
export async function commitProjectEntrySeparationArtifact(params: {
  projectId: string;
  entryId: string;
  sourceAudioHash: string;
  artifactRef: ProjectSongArtifactRef;
  lockAdapter?: WebLockAdapter | null;
}): Promise<{ updated: boolean; record: PersistedProjectRecord | null; errorMessage?: string }> {
  if (!params.projectId || !params.entryId) {
    return { updated: false, record: null };
  }
  let outcome: { updated: boolean; record: PersistedProjectRecord | null; errorMessage?: string };
  try {
    outcome = await withProjectWriteLock(
      params.projectId,
      () =>
        withIdbTransaction(["projects", "projectPreferences"], "readwrite", async (tx) => {
          const projStore = tx.objectStore("projects");
          const prefStore = tx.objectStore("projectPreferences");

          const tomb = (await idbRequestPromise(
            prefStore.get(DELETED_PROJECTS_PREF_KEY),
          )) as DeletedProjectsPreferenceRecord | undefined;
          if (tomb?.deletedIds?.includes(params.projectId)) {
            return { updated: false, record: null };
          }

          const existing = (await idbRequestPromise(
            projStore.get(params.projectId),
          )) as PersistedProjectRecord | undefined;
          if (!existing) {
            return { updated: false, record: null };
          }

          const targetIndex = existing.project.songs.findIndex(
            (entry) =>
              entry.entryId === params.entryId &&
              entry.sourceAudioHash === params.sourceAudioHash,
          );
          if (targetIndex < 0) {
            return { updated: false, record: null };
          }

          const nowIso = new Date().toISOString();
          const nextSongs = existing.project.songs.map((entry, idx) =>
            idx === targetIndex
              ? {
                  ...entry,
                  artifactRef: { ...params.artifactRef },
                  settings: {
                    ...entry.settings,
                    separationMode: params.artifactRef.separationMode,
                  },
                }
              : entry,
          );
          const nextRev = existing.localRevision + 1;
          const nextProject: BandProject = {
            ...existing.project,
            revision: nextRev,
            revisionToken: existing.project.revisionToken,
            updatedAt: nowIso,
            songs: nextSongs,
            backupSummary: computeProjectBackupSummary(
              nextSongs,
              existing.ownerAccountId || undefined,
            ),
          };
          const updatedRecord: PersistedProjectRecord = {
            ...existing,
            project: nextProject,
            localRevision: nextRev,
            dirty: existing.storageProvider === "google_drive" ? true : existing.dirty,
            syncStatus:
              existing.storageProvider === "google_drive"
                ? existing.syncStatus === "conflict"
                  ? "conflict"
                  : "dirty"
                : "local_only",
            lastSavedAt: Date.now(),
          };
          await idbRequestPromise(projStore.put(updatedRecord));
          return { updated: true, record: updatedRecord };
        }),
      params.lockAdapter,
    );
  } catch (err) {
    return {
      updated: false,
      record: null,
      errorMessage: err instanceof Error ? err.message : "寫入分離成果至專案失敗。",
    };
  }

  if (outcome.updated && outcome.record) {
    postProjectSyncBroadcast({
      type: "project-saved",
      projectId: outcome.record.projectId,
      revision: outcome.record.localRevision,
      updatedAt: outcome.record.lastSavedAt,
    });
  }
  return outcome;
}

export async function getActiveProjectId(): Promise<string | null> {
  const pref = await idbGet<ActiveProjectPreferenceRecord>(
    "projectPreferences",
    ACTIVE_PROJECT_PREF_KEY,
  ).catch(() => null);
  return pref?.projectId ?? null;
}

export async function setActiveProjectId(
  projectId: string | null,
): Promise<{ saved: boolean; errorMessage?: string }> {
  try {
    await withIdbTransaction("projectPreferences", "readwrite", async (tx) => {
      const store = tx.objectStore("projectPreferences");
      await idbRequestPromise(
        store.put({
          key: ACTIVE_PROJECT_PREF_KEY,
          projectId,
          updatedAt: Date.now(),
        } satisfies ActiveProjectPreferenceRecord),
      );
    });
    postProjectSyncBroadcast({ type: "active-project-changed", projectId });
    return { saved: true };
  } catch (err) {
    return {
      saved: false,
      errorMessage: err instanceof Error ? err.message : "寫入作用中專案偏好失敗。",
    };
  }
}

export async function findLegacyMigrationByFingerprint(
  fingerprint: string,
): Promise<LegacyMigrationEntry | null> {
  if (!fingerprint) return null;
  const pref = await idbGet<LegacyMigrationPreferenceRecord>(
    "projectPreferences",
    LEGACY_MIGRATION_PREF_KEY,
  ).catch(() => null);
  if (!pref?.entries) return null;
  return pref.entries.find((e) => e.fingerprint === fingerprint) ?? null;
}

export async function getLegacyMigrationEntries(): Promise<LegacyMigrationEntry[]> {
  const pref = await idbGet<LegacyMigrationPreferenceRecord>(
    "projectPreferences",
    LEGACY_MIGRATION_PREF_KEY,
  ).catch(() => null);
  return pref?.entries ?? [];
}

export async function saveLegacyMigrationEntry(entry: LegacyMigrationEntry): Promise<void> {
  await withIdbTransaction("projectPreferences", "readwrite", async (tx) => {
    const store = tx.objectStore("projectPreferences");
    const existing = (await idbRequestPromise(
      store.get(LEGACY_MIGRATION_PREF_KEY),
    )) as LegacyMigrationPreferenceRecord | undefined;
    const filtered = (existing?.entries ?? []).filter(
      (item) => item.fingerprint !== entry.fingerprint,
    );
    filtered.push(entry);
    await idbRequestPromise(
      store.put({
        key: LEGACY_MIGRATION_PREF_KEY,
        entries: filtered,
        updatedAt: Date.now(),
      } satisfies LegacyMigrationPreferenceRecord),
    );
  });
}

/**
 * 儲存由同一個有效 OAuth Token 驗證得到的 google:<sub> <-> drive:<permissionId> 對應。
 * 絕不依 email 自動合併不同帳戶。
 */
export async function saveVerifiedAccountIdentityLink(
  googleSubAccountId: string,
  drivePermissionAccountId: string,
): Promise<{ saved: boolean; errorMessage?: string }> {
  if (
    !googleSubAccountId.startsWith("google:") ||
    !drivePermissionAccountId.startsWith("drive:")
  ) {
    return { saved: false, errorMessage: "帳號識別前綴無效。" };
  }
  try {
    await withIdbTransaction("projectPreferences", "readwrite", async (tx) => {
      const store = tx.objectStore("projectPreferences");
      const existing = (await idbRequestPromise(
        store.get(ACCOUNT_IDENTITY_LINKS_PREF_KEY),
      )) as AccountIdentityLinksPreferenceRecord | undefined;
      const map = { ...(existing?.drivePermToGoogleSub ?? {}) };
      map[drivePermissionAccountId] = googleSubAccountId;
      await idbRequestPromise(
        store.put({
          key: ACCOUNT_IDENTITY_LINKS_PREF_KEY,
          drivePermToGoogleSub: map,
          updatedAt: Date.now(),
        } satisfies AccountIdentityLinksPreferenceRecord),
      );
    });
    return { saved: true };
  } catch (err) {
    return {
      saved: false,
      errorMessage: err instanceof Error ? err.message : "寫入帳戶對應失敗。",
    };
  }
}

export async function lookupCanonicalAccountIdForDrivePermission(
  drivePermissionAccountId: string,
): Promise<string | null> {
  if (!drivePermissionAccountId.startsWith("drive:")) return null;
  const existing = await idbGet<AccountIdentityLinksPreferenceRecord>(
    "projectPreferences",
    ACCOUNT_IDENTITY_LINKS_PREF_KEY,
  ).catch(() => null);
  return existing?.drivePermToGoogleSub?.[drivePermissionAccountId] ?? null;
}

export async function saveProjectSyncJob(
  job: Omit<PersistedProjectSyncJob, "key">,
): Promise<{ saved: boolean; job: PersistedProjectSyncJob; errorMessage?: string }> {
  const full: PersistedProjectSyncJob = {
    ...job,
    key: job.projectId,
  };
  try {
    await withIdbTransaction("projectSyncJobs", "readwrite", async (tx) => {
      await idbRequestPromise(tx.objectStore("projectSyncJobs").put(full));
    });
    return { saved: true, job: full };
  } catch (err) {
    return {
      saved: false,
      job: full,
      errorMessage: err instanceof Error ? err.message : "寫入專案同步狀態失敗。",
    };
  }
}

export async function getProjectSyncJob(
  projectId: string,
): Promise<PersistedProjectSyncJob | null> {
  if (!projectId) return null;
  return idbGet<PersistedProjectSyncJob>("projectSyncJobs", projectId).catch(() => null);
}

export async function listProjectSyncJobsByAccount(
  ownerAccountId: string,
): Promise<PersistedProjectSyncJob[]> {
  if (!ownerAccountId) return [];
  return withIdbTransaction("projectSyncJobs", "readonly", async (tx) => {
    const store = tx.objectStore("projectSyncJobs");
    const rows =
      typeof store.index === "function" &&
      (!store.indexNames || store.indexNames.contains(PROJECT_SYNC_ACCOUNT_INDEX))
        ? ((await idbRequestPromise(
            store.index(PROJECT_SYNC_ACCOUNT_INDEX).getAll(ownerAccountId),
          )) as PersistedProjectSyncJob[])
        : ((await idbRequestPromise(store.getAll())) as PersistedProjectSyncJob[]).filter(
            (j) => j.ownerAccountId === ownerAccountId,
          );
    return rows.filter((j) => j.ownerAccountId === ownerAccountId);
  }).catch(() => []);
}

export async function deleteProjectSyncJob(
  projectId: string,
): Promise<{ deleted: boolean; errorMessage?: string }> {
  if (!projectId) return { deleted: false };
  try {
    await withIdbTransaction("projectSyncJobs", "readwrite", async (tx) => {
      await idbRequestPromise(tx.objectStore("projectSyncJobs").delete(projectId));
    });
    return { deleted: true };
  } catch (err) {
    return {
      deleted: false,
      errorMessage: err instanceof Error ? err.message : "刪除專案同步狀態失敗。",
    };
  }
}
