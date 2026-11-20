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
  PersistedProjectRecord,
  PersistedProjectSyncJob,
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

export async function saveProjectRecord(
  record: PersistedProjectRecord,
  options?: {
    allowCreateIfDeleted?: boolean;
    lockAdapter?: WebLockAdapter | null;
    silentBroadcast?: boolean;
  },
): Promise<
  | { saved: true; record: PersistedProjectRecord }
  | { saved: false; reason: "project_deleted" }
> {
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

        const sanitized: PersistedProjectRecord = {
          ...record,
          key: record.projectId,
          ownerAccountId:
            record.storageProvider === "google_drive" ? (record.ownerAccountId || record.project.ownerAccountId || "") : "",
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
}): Promise<{ updated: boolean; record: PersistedProjectRecord | null }> {
  if (!params.projectId || !params.entryId) {
    return { updated: false, record: null };
  }
  const outcome = await withProjectWriteLock(
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
  ).catch(() => ({ updated: false, record: null }));

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

export async function setActiveProjectId(projectId: string | null): Promise<void> {
  await withIdbTransaction("projectPreferences", "readwrite", async (tx) => {
    const store = tx.objectStore("projectPreferences");
    await idbRequestPromise(
      store.put({
        key: ACTIVE_PROJECT_PREF_KEY,
        projectId,
        updatedAt: Date.now(),
      } satisfies ActiveProjectPreferenceRecord),
    );
  }).catch(() => undefined);
  postProjectSyncBroadcast({ type: "active-project-changed", projectId });
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
): Promise<void> {
  if (
    !googleSubAccountId.startsWith("google:") ||
    !drivePermissionAccountId.startsWith("drive:")
  ) {
    return;
  }
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
  }).catch(() => undefined);
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
): Promise<PersistedProjectSyncJob> {
  const full: PersistedProjectSyncJob = {
    ...job,
    key: job.projectId,
  };
  await withIdbTransaction("projectSyncJobs", "readwrite", async (tx) => {
    await idbRequestPromise(tx.objectStore("projectSyncJobs").put(full));
  });
  return full;
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

export async function deleteProjectSyncJob(projectId: string): Promise<void> {
  if (!projectId) return;
  await withIdbTransaction("projectSyncJobs", "readwrite", async (tx) => {
    await idbRequestPromise(tx.objectStore("projectSyncJobs").delete(projectId));
  }).catch(() => undefined);
}
