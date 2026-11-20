import type { WebLockAdapter } from "../separation/separationResumeController.ts";
import {
  clearPersistedDriveAccountFolders,
  getPersistedDriveAccountFolders,
  savePersistedDriveAccountFolders,
} from "../storage/driveTransferStore.ts";
import {
  DRIVE_FOLDER_MIME_TYPE,
  DriveApiError,
  type PaginatedDriveIncompleteReason,
  createDriveFolder,
  getDriveFileMetadata,
  listDriveFiles,
  listDriveFilesPaginated,
  type DriveRawFileResource,
} from "./driveClient.ts";

export const LOOP_HARMONIZER_FOLDER_NAME = ".loopHarmonizer";
export const LOOP_HARMONIZER_APP_TAG = "loop-harmonizer";

export interface AppFolderLayout {
  accountId: string;
  rootFolderId: string;
  songsFolderId: string;
  sessionsFolderId: string;
  projectsFolderId?: string;
}

export interface ProjectFolderLayout {
  accountId: string;
  projectId: string;
  rootFolderId: string;
  projectsFolderId: string;
  projectFolderId: string;
  projectRevisionsFolderId?: string;
  duplicateFolderIds: string[];
}

export interface ManagedDriveProjectEntry {
  projectId: string;
  projectFolderId: string;
  projectFolderName: string;
  projectFileId?: string;
  projectFileModifiedTime?: string;
  projectFileVersion?: string;
  projectFileRevisionToken?: string;
  revisionsFolderId?: string;
}

export interface ManagedProjectsListResult {
  entries: ManagedDriveProjectEntry[];
  complete: boolean;
  truncated: boolean;
  incompleteReason?: PaginatedDriveIncompleteReason | "partial_failure";
  errorMessage?: string;
  folderPagesFetched: number;
  filePagesFetched: number;
}

export interface SongRevisionFolders {
  accountId: string;
  rootFolderId: string;
  songsFolderId: string;
  songFolderId: string;
  revisionsFolderId: string;
  revisionFolderId: string;
  stemsFolderId: string;
  exportsFolderId?: string;
}

export interface SongOriginalsFolders {
  accountId: string;
  rootFolderId: string;
  songsFolderId: string;
  songFolderId: string;
  originalsFolderId: string;
}

export class MultipleManagedAppFoldersError extends Error {
  readonly candidates: DriveRawFileResource[];

  constructor(candidates: DriveRawFileResource[]) {
    super(
      `在您的 Google Drive 根目錄發現 ${candidates.length} 個由 Loop Harmonizer 管理的「${LOOP_HARMONIZER_FOLDER_NAME}」資料夾，請選擇要使用哪一個資料夾以避免覆寫錯誤。`,
    );
    this.name = "MultipleManagedAppFoldersError";
    this.candidates = candidates;
  }
}

const inMemoryLayoutByAccount = new Map<string, AppFolderLayout>();
const ensureFolderInFlightByAccount = new Map<string, Promise<AppFolderLayout>>();

export function clearCachedFolderLayoutForAccount(accountId?: string): void {
  if (accountId) {
    inMemoryLayoutByAccount.delete(accountId);
  } else {
    inMemoryLayoutByAccount.clear();
  }
}

export function buildStableSongFolderKey(sourceAudioHash: string): string {
  const clean = sourceAudioHash.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean ? `song_${clean}` : "song_unknown";
}

function isManagedAppFolder(
  meta: DriveRawFileResource | null | undefined,
  expectedRole: string,
): meta is DriveRawFileResource {
  if (!meta || meta.trashed) return false;
  if (meta.mimeType !== DRIVE_FOLDER_MIME_TYPE) return false;
  if (meta.appProperties?.lhApp !== LOOP_HARMONIZER_APP_TAG) return false;
  if (meta.appProperties?.lhRole !== expectedRole) return false;
  if (meta.capabilities?.canAddChildren === false) return false;
  return true;
}

async function verifyFolderSafe(
  folderId: string,
  expectedRole: string,
  options: {
    accessToken: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<DriveRawFileResource | null> {
  if (!folderId) return null;
  try {
    const meta = await getDriveFileMetadata(folderId, {
      accessToken: options.accessToken,
      fields:
        "id,name,mimeType,trashed,parents,appProperties,capabilities(canEdit,canAddChildren,canDelete)",
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    return isManagedAppFolder(meta, expectedRole) ? meta : null;
  } catch (err) {
    if (err instanceof DriveApiError && err.code === "unauthorized") {
      throw err;
    }
    return null;
  }
}

async function findManagedSubfolder(params: {
  parentId: string;
  role: string;
  extraAppProps?: Record<string, string>;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveRawFileResource[]> {
  const appPropClauses = [
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRole' and value='${params.role}' }`,
  ];
  if (params.extraAppProps) {
    for (const [key, value] of Object.entries(params.extraAppProps)) {
      if (value === undefined || value === null || value === "") continue;
      const safeKey = String(key).replace(/'/g, "");
      const safeVal = String(value).replace(/'/g, "");
      appPropClauses.push(`appProperties has { key='${safeKey}' and value='${safeVal}' }`);
    }
  }
  const q = [
    `'${params.parentId.replace(/'/g, "")}' in parents`,
    `mimeType='${DRIVE_FOLDER_MIME_TYPE}'`,
    "trashed=false",
    ...appPropClauses,
  ].join(" and ");

  const res = await listDriveFiles({
    accessToken: params.accessToken,
    q,
    pageSize: 10,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  return res.files.filter((file) => {
    if (!isManagedAppFolder(file, params.role)) return false;
    if (!params.extraAppProps) return true;
    return Object.entries(params.extraAppProps).every(
      ([k, v]) => file.appProperties?.[k] === v,
    );
  });
}

async function ensureChildManagedFolder(params: {
  parentId: string;
  name: string;
  role: string;
  extraAppProps?: Record<string, string>;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const existing = await findManagedSubfolder({
    parentId: params.parentId,
    role: params.role,
    extraAppProps: params.extraAppProps,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  if (existing.length > 0) {
    return existing[0].id;
  }
  const created = await createDriveFolder({
    accessToken: params.accessToken,
    name: params.name,
    parentId: params.parentId,
    appProperties: {
      lhApp: LOOP_HARMONIZER_APP_TAG,
      lhRole: params.role,
      ...(params.extraAppProps ?? {}),
    },
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  return created.id;
}

async function withAccountFolderLock<T>(
  accountId: string,
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
    `loop-harmonizer:drive-folder:${accountId}`,
    { ifAvailable: false } as unknown as { ifAvailable: boolean },
    async () => runner(),
  );
}

/**
 * 確保目前 Google 帳戶專屬的 `.loopHarmonizer` 資料夾結構就緒。
 * - 使用 appProperties 辨識系統管理的資料夾，絕不誤用使用者既有同名資料夾。
 * - 透過帳戶別與跨分頁鎖避免重複建立。
 */
export async function ensureAppFolder(params: {
  accountId: string;
  accessToken: string;
  preferredRootFolderId?: string;
  onMultipleCandidates?: (candidates: DriveRawFileResource[]) => Promise<string | null>;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<AppFolderLayout> {
  if (!params.accountId) {
    throw new Error("缺乏穩定的 Google Account ID，無法建立雲端專用資料夾。");
  }
  if (!params.accessToken) {
    throw new Error("尚未取得有效 Google 授權 Token，無法建立雲端專用資料夾。");
  }

  const existingInFlight = ensureFolderInFlightByAccount.get(params.accountId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const run = withAccountFolderLock(
    params.accountId,
    async () => {
      const cachedMem = inMemoryLayoutByAccount.get(params.accountId);
      const cachedDb =
        cachedMem ??
        (await getPersistedDriveAccountFolders(params.accountId).catch(() => null));

      let rootFolderId: string | null = null;
      let songsFolderId: string | null = null;
      let sessionsFolderId: string | null = null;

      if (params.preferredRootFolderId) {
        const preferredMeta = await verifyFolderSafe(params.preferredRootFolderId, "root", {
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        if (preferredMeta) {
          rootFolderId = preferredMeta.id;
        }
      }

      if (!rootFolderId && cachedDb?.rootFolderId) {
        const verifiedRoot = await verifyFolderSafe(cachedDb.rootFolderId, "root", {
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        if (verifiedRoot) {
          rootFolderId = verifiedRoot.id;
          if (cachedDb.songsFolderId) {
            const verifiedSongs = await verifyFolderSafe(cachedDb.songsFolderId, "songs", {
              accessToken: params.accessToken,
              signal: params.signal,
              fetchImpl: params.fetchImpl,
            });
            if (verifiedSongs) songsFolderId = verifiedSongs.id;
          }
          if (cachedDb.sessionsFolderId) {
            const verifiedSessions = await verifyFolderSafe(
              cachedDb.sessionsFolderId,
              "sessions",
              {
                accessToken: params.accessToken,
                signal: params.signal,
                fetchImpl: params.fetchImpl,
              },
            );
            if (verifiedSessions) sessionsFolderId = verifiedSessions.id;
          }
        } else {
          await clearPersistedDriveAccountFolders(params.accountId).catch(() => undefined);
        }
      }

      if (!rootFolderId) {
        const candidates = await findManagedSubfolder({
          parentId: "root",
          role: "root",
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });

        if (candidates.length === 1) {
          rootFolderId = candidates[0].id;
        } else if (candidates.length > 1) {
          const chosenId = params.onMultipleCandidates
            ? await params.onMultipleCandidates(candidates)
            : null;
          if (!chosenId) {
            throw new MultipleManagedAppFoldersError(candidates);
          }
          const verifiedChosen = await verifyFolderSafe(chosenId, "root", {
            accessToken: params.accessToken,
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          });
          if (!verifiedChosen) {
            throw new Error("所選資料夾不是有效的 Loop Harmonizer 管理資料夾。");
          }
          rootFolderId = verifiedChosen.id;
        } else {
          const createdRoot = await createDriveFolder({
            accessToken: params.accessToken,
            name: LOOP_HARMONIZER_FOLDER_NAME,
            parentId: "root",
            appProperties: {
              lhApp: LOOP_HARMONIZER_APP_TAG,
              lhRole: "root",
              lhAccountId: params.accountId,
            },
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          });
          rootFolderId = createdRoot.id;
        }
      }

      if (!songsFolderId) {
        songsFolderId = await ensureChildManagedFolder({
          parentId: rootFolderId,
          name: "songs",
          role: "songs",
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
      }

      if (!sessionsFolderId) {
        sessionsFolderId = await ensureChildManagedFolder({
          parentId: rootFolderId,
          name: "sessions",
          role: "sessions",
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
      }

      const layout: AppFolderLayout = {
        accountId: params.accountId,
        rootFolderId,
        songsFolderId,
        sessionsFolderId,
        projectsFolderId: cachedDb?.projectsFolderId,
      };
      inMemoryLayoutByAccount.set(params.accountId, layout);
      await savePersistedDriveAccountFolders({
        ...layout,
        updatedAt: Date.now(),
      }).catch(() => undefined);
      return layout;
    },
    params.lockAdapter,
  );

  const tracked = run.finally(() => {
    if (ensureFolderInFlightByAccount.get(params.accountId) === tracked) {
      ensureFolderInFlightByAccount.delete(params.accountId);
    }
  });
  ensureFolderInFlightByAccount.set(params.accountId, tracked);
  return tracked;
}

function selectCanonicalFolder(
  candidates: readonly DriveRawFileResource[],
): { canonical: DriveRawFileResource; duplicateIds: string[] } {
  const sorted = [...candidates].sort((a, b) => {
    const ta = a.createdTime ? Date.parse(a.createdTime) : Number.MAX_SAFE_INTEGER;
    const tb = b.createdTime ? Date.parse(b.createdTime) : Number.MAX_SAFE_INTEGER;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
  const canonical = sorted[0];
  return {
    canonical,
    duplicateIds: sorted.slice(1).map((item) => item.id),
  };
}

export function buildStableProjectFolderName(projectId: string): string {
  const clean = projectId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return clean ? `project_${clean}` : "project_unknown";
}

export async function ensureProjectsFolder(params: {
  accountId: string;
  accessToken: string;
  preferredRootFolderId?: string;
  onMultipleCandidates?: (candidates: DriveRawFileResource[]) => Promise<string | null>;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<{ rootFolderId: string; projectsFolderId: string }> {
  const layout = await ensureAppFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    preferredRootFolderId: params.preferredRootFolderId,
    onMultipleCandidates: params.onMultipleCandidates,
    signal: params.signal,
    lockAdapter: params.lockAdapter,
    fetchImpl: params.fetchImpl,
  });

  if (layout.projectsFolderId) {
    const verified = await verifyFolderSafe(layout.projectsFolderId, "projects", {
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    if (verified) {
      return { rootFolderId: layout.rootFolderId, projectsFolderId: verified.id };
    }
  }

  return withAccountFolderLock(
    `${params.accountId}:projects`,
    async () => {
      const existing = await findManagedSubfolder({
        parentId: layout.rootFolderId,
        role: "projects",
        extraAppProps: { lhAccountId: params.accountId },
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });

      let projectsFolderId: string;
      if (existing.length > 0) {
        projectsFolderId = selectCanonicalFolder(existing).canonical.id;
      } else {
        const created = await createDriveFolder({
          accessToken: params.accessToken,
          name: "projects",
          parentId: layout.rootFolderId,
          appProperties: {
            lhApp: LOOP_HARMONIZER_APP_TAG,
            lhRole: "projects",
            lhAccountId: params.accountId,
          },
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        // 無 Web Locks 跨裝置並發防護：建立後再檢查一次並確定性收斂
        const afterCheck = await findManagedSubfolder({
          parentId: layout.rootFolderId,
          role: "projects",
          extraAppProps: { lhAccountId: params.accountId },
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        projectsFolderId =
          afterCheck.length > 0
            ? selectCanonicalFolder(afterCheck).canonical.id
            : created.id;
      }

      const nextLayout: AppFolderLayout = {
        ...layout,
        projectsFolderId,
      };
      inMemoryLayoutByAccount.set(params.accountId, nextLayout);
      await savePersistedDriveAccountFolders({
        ...nextLayout,
        updatedAt: Date.now(),
      }).catch(() => undefined);

      return { rootFolderId: layout.rootFolderId, projectsFolderId };
    },
    params.lockAdapter,
  );
}

export async function findProjectFolder(params: {
  accountId: string;
  accessToken: string;
  projectId: string;
  driveFolderId?: string;
  projectsFolderId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ folder: DriveRawFileResource | null; duplicateFolderIds: string[] }> {
  if (params.driveFolderId) {
    const direct = await verifyFolderSafe(params.driveFolderId, "project", {
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    if (
      direct &&
      direct.appProperties?.lhProjectId === params.projectId &&
      direct.appProperties?.lhAccountId === params.accountId
    ) {
      return { folder: direct, duplicateFolderIds: [] };
    }
  }

  let projectsFolderId = params.projectsFolderId;
  if (!projectsFolderId) {
    const { projectsFolderId: resolvedProjectsId } = await ensureProjectsFolder({
      accountId: params.accountId,
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    projectsFolderId = resolvedProjectsId;
  }

  const matched = await findManagedSubfolder({
    parentId: projectsFolderId,
    role: "project",
    extraAppProps: {
      lhAccountId: params.accountId,
      lhProjectId: params.projectId,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  if (matched.length === 0) {
    return { folder: null, duplicateFolderIds: [] };
  }
  const { canonical, duplicateIds } = selectCanonicalFolder(matched);
  return { folder: canonical, duplicateFolderIds: duplicateIds };
}

export async function ensureProjectFolder(params: {
  accountId: string;
  accessToken: string;
  projectId: string;
  driveFolderId?: string;
  includeRevisionsFolder?: boolean;
  preferredRootFolderId?: string;
  onMultipleCandidates?: (candidates: DriveRawFileResource[]) => Promise<string | null>;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<ProjectFolderLayout> {
  const { rootFolderId, projectsFolderId } = await ensureProjectsFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    preferredRootFolderId: params.preferredRootFolderId,
    onMultipleCandidates: params.onMultipleCandidates,
    signal: params.signal,
    lockAdapter: params.lockAdapter,
    fetchImpl: params.fetchImpl,
  });

  return withAccountFolderLock(
    `${params.accountId}:project:${params.projectId}`,
    async () => {
      const found = await findProjectFolder({
        accountId: params.accountId,
        accessToken: params.accessToken,
        projectId: params.projectId,
        driveFolderId: params.driveFolderId,
        projectsFolderId,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });

      let projectFolderId: string;
      let duplicateFolderIds = [...found.duplicateFolderIds];

      if (found.folder) {
        projectFolderId = found.folder.id;
      } else {
        const created = await createDriveFolder({
          accessToken: params.accessToken,
          name: buildStableProjectFolderName(params.projectId),
          parentId: projectsFolderId,
          appProperties: {
            lhApp: LOOP_HARMONIZER_APP_TAG,
            lhRole: "project",
            lhAccountId: params.accountId,
            lhProjectId: params.projectId,
          },
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        // 跨裝置無 Web Locks 競態防護：建立後重新查詢確定性選用最早 canonical 資料夾
        const recheck = await findManagedSubfolder({
          parentId: projectsFolderId,
          role: "project",
          extraAppProps: {
            lhAccountId: params.accountId,
            lhProjectId: params.projectId,
          },
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        if (recheck.length > 0) {
          const selection = selectCanonicalFolder(recheck);
          projectFolderId = selection.canonical.id;
          duplicateFolderIds = selection.duplicateIds;
        } else {
          projectFolderId = created.id;
        }
      }

      let projectRevisionsFolderId: string | undefined;
      if (params.includeRevisionsFolder !== false) {
        projectRevisionsFolderId = await ensureChildManagedFolder({
          parentId: projectFolderId,
          name: "revisions",
          role: "project_revisions",
          extraAppProps: {
            lhAccountId: params.accountId,
            lhProjectId: params.projectId,
          },
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
      }

      return {
        accountId: params.accountId,
        projectId: params.projectId,
        rootFolderId,
        projectsFolderId,
        projectFolderId,
        projectRevisionsFolderId,
        duplicateFolderIds,
      };
    },
    params.lockAdapter,
  );
}

export async function listManagedProjectsPaginated(params: {
  accountId: string;
  accessToken: string;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  maxRetriesPerPage?: number;
  retryDelayMs?: readonly number[];
  strict?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ManagedProjectsListResult> {
  if (!params.accountId || !params.accessToken) {
    return {
      entries: [],
      complete: true,
      truncated: false,
      folderPagesFetched: 0,
      filePagesFetched: 0,
    };
  }
  const safeAccount = params.accountId.replace(/'/g, "");
  const pageSize = params.pageSize ?? 100;

  // 確保只讀取目前登入帳戶、受 Loop Harmonizer 管理之專案資料夾與 project.json
  const folderQuery = [
    `mimeType='${DRIVE_FOLDER_MIME_TYPE}'`,
    "trashed=false",
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRole' and value='project' }`,
    `appProperties has { key='lhAccountId' and value='${safeAccount}' }`,
  ].join(" and ");

  const fileQuery = [
    "trashed=false",
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRole' and value='project_json' }`,
    `appProperties has { key='lhAccountId' and value='${safeAccount}' }`,
  ].join(" and ");

  const [folderRes, fileRes] = await Promise.all([
    listDriveFilesPaginated({
      accessToken: params.accessToken,
      q: folderQuery,
      pageSize,
      orderBy: "modifiedTime desc",
      maxPages: params.maxPages,
      maxItems: params.maxItems,
      maxRetriesPerPage: params.maxRetriesPerPage,
      retryDelayMs: params.retryDelayMs,
      throwOnError: params.strict ?? true,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
    listDriveFilesPaginated({
      accessToken: params.accessToken,
      q: fileQuery,
      pageSize,
      orderBy: "modifiedTime desc",
      maxPages: params.maxPages,
      maxItems: params.maxItems,
      maxRetriesPerPage: params.maxRetriesPerPage,
      retryDelayMs: params.retryDelayMs,
      throwOnError: params.strict ?? true,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
  ]);

  const jsonByProjectId = new Map<string, DriveRawFileResource>();
  for (const file of fileRes.files) {
    if (file.trashed) continue;
    if (file.appProperties?.lhAccountId !== params.accountId) continue;
    const pid = file.appProperties?.lhProjectId;
    if (!pid) continue;
    if (!jsonByProjectId.has(pid)) {
      jsonByProjectId.set(pid, file);
    }
  }

  const foldersByProjectId = new Map<string, DriveRawFileResource[]>();
  for (const folder of folderRes.files) {
    if (!isManagedAppFolder(folder, "project")) continue;
    if (folder.appProperties?.lhAccountId !== params.accountId) continue;
    const pid = folder.appProperties?.lhProjectId;
    if (!pid) continue;
    const arr = foldersByProjectId.get(pid) ?? [];
    arr.push(folder);
    foldersByProjectId.set(pid, arr);
  }

  const entries: ManagedDriveProjectEntry[] = [];
  for (const [projectId, candidates] of foldersByProjectId.entries()) {
    const canonical = selectCanonicalFolder(candidates).canonical;
    const projectFile = jsonByProjectId.get(projectId);
    entries.push({
      projectId,
      projectFolderId: canonical.id,
      projectFolderName: canonical.name || buildStableProjectFolderName(projectId),
      projectFileId: projectFile?.id,
      projectFileModifiedTime: projectFile?.modifiedTime ?? canonical.modifiedTime,
      projectFileVersion:
        projectFile?.version !== undefined ? String(projectFile.version) : undefined,
      projectFileRevisionToken: projectFile?.appProperties?.lhRevisionToken,
    });
  }

  // 也容錯收錄未附在資料夾清單但有明確 lhProjectId 的 project.json
  for (const [projectId, projectFile] of jsonByProjectId.entries()) {
    if (foldersByProjectId.has(projectId)) continue;
    entries.push({
      projectId,
      projectFolderId: projectFile.parents?.[0] ?? "",
      projectFolderName: buildStableProjectFolderName(projectId),
      projectFileId: projectFile.id,
      projectFileModifiedTime: projectFile.modifiedTime,
      projectFileVersion:
        projectFile.version !== undefined ? String(projectFile.version) : undefined,
      projectFileRevisionToken: projectFile.appProperties?.lhRevisionToken,
    });
  }

  const complete = folderRes.complete && fileRes.complete;
  const incompleteReason = !folderRes.complete
    ? folderRes.incompleteReason
    : !fileRes.complete
      ? fileRes.incompleteReason
      : undefined;
  const errorMessage = !folderRes.complete
    ? folderRes.errorMessage
    : !fileRes.complete
      ? fileRes.errorMessage
      : undefined;

  return {
    entries,
    complete,
    truncated: !complete,
    incompleteReason,
    errorMessage,
    folderPagesFetched: folderRes.pagesFetched,
    filePagesFetched: fileRes.pagesFetched,
  };
}

export async function listManagedProjects(params: {
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ManagedDriveProjectEntry[]> {
  const res = await listManagedProjectsPaginated({
    ...params,
    strict: true,
  });
  return res.entries;
}

export async function ensureSongOriginalsFolder(params: {
  accountId: string;
  accessToken: string;
  stableSongKey: string;
  preferredRootFolderId?: string;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<SongOriginalsFolders> {
  const layout = await ensureAppFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    preferredRootFolderId: params.preferredRootFolderId,
    signal: params.signal,
    lockAdapter: params.lockAdapter,
    fetchImpl: params.fetchImpl,
  });

  const songFolderId = await ensureChildManagedFolder({
    parentId: layout.songsFolderId,
    name: params.stableSongKey,
    role: "song",
    extraAppProps: {
      lhStableSongKey: params.stableSongKey,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const originalsFolderId = await ensureChildManagedFolder({
    parentId: songFolderId,
    name: "originals",
    role: "originals",
    extraAppProps: {
      lhStableSongKey: params.stableSongKey,
      lhAccountId: params.accountId,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  return {
    accountId: params.accountId,
    rootFolderId: layout.rootFolderId,
    songsFolderId: layout.songsFolderId,
    songFolderId,
    originalsFolderId,
  };
}

export async function ensureSongRevisionFolders(params: {
  accountId: string;
  accessToken: string;
  stableSongKey: string;
  revisionId: string;
  includeExports?: boolean;
  preferredRootFolderId?: string;
  onMultipleCandidates?: (candidates: DriveRawFileResource[]) => Promise<string | null>;
  signal?: AbortSignal;
  lockAdapter?: WebLockAdapter | null;
  fetchImpl?: typeof fetch;
}): Promise<SongRevisionFolders> {
  const layout = await ensureAppFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    preferredRootFolderId: params.preferredRootFolderId,
    onMultipleCandidates: params.onMultipleCandidates,
    signal: params.signal,
    lockAdapter: params.lockAdapter,
    fetchImpl: params.fetchImpl,
  });

  const songFolderId = await ensureChildManagedFolder({
    parentId: layout.songsFolderId,
    name: params.stableSongKey,
    role: "song",
    extraAppProps: {
      lhStableSongKey: params.stableSongKey,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const revisionsFolderId = await ensureChildManagedFolder({
    parentId: songFolderId,
    name: "revisions",
    role: "revisions",
    extraAppProps: {
      lhStableSongKey: params.stableSongKey,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const revisionFolderId = await ensureChildManagedFolder({
    parentId: revisionsFolderId,
    name: params.revisionId,
    role: "revision",
    extraAppProps: {
      lhStableSongKey: params.stableSongKey,
      lhRevisionId: params.revisionId,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const stemsFolderId = await ensureChildManagedFolder({
    parentId: revisionFolderId,
    name: "stems",
    role: "stems",
    extraAppProps: {
      lhRevisionId: params.revisionId,
    },
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  let exportsFolderId: string | undefined;
  if (params.includeExports) {
    exportsFolderId = await ensureChildManagedFolder({
      parentId: revisionFolderId,
      name: "exports",
      role: "exports",
      extraAppProps: {
        lhRevisionId: params.revisionId,
      },
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
  }

  return {
    accountId: params.accountId,
    rootFolderId: layout.rootFolderId,
    songsFolderId: layout.songsFolderId,
    songFolderId,
    revisionsFolderId,
    revisionFolderId,
    stemsFolderId,
    exportsFolderId,
  };
}
