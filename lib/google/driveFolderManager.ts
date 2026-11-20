import type { WebLockAdapter } from "../separation/separationResumeController.ts";
import {
  clearPersistedDriveAccountFolders,
  getPersistedDriveAccountFolders,
  savePersistedDriveAccountFolders,
} from "../storage/driveTransferStore.ts";
import {
  DRIVE_FOLDER_MIME_TYPE,
  DriveApiError,
  createDriveFolder,
  getDriveFileMetadata,
  listDriveFiles,
  type DriveRawFileResource,
} from "./driveClient.ts";

export const LOOP_HARMONIZER_FOLDER_NAME = ".loopHarmonizer";
export const LOOP_HARMONIZER_APP_TAG = "loop-harmonizer";

export interface AppFolderLayout {
  accountId: string;
  rootFolderId: string;
  songsFolderId: string;
  sessionsFolderId: string;
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
