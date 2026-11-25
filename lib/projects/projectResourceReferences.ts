import { getAllProjectRecords, listCloudCachedProjectRecordsByAccount } from "../storage/projectStore.ts";
import { loadPersistedBandSession } from "../storage/songSessionStore.ts";
import { listCloudProjectsDetailed } from "./projectDriveSync.ts";
import type { PersistedProjectRecord, ProjectSongArtifactRef } from "./projectTypes.ts";
import { canGarbageCollectShareFolder, getProjectShareRecord } from "../sharing/shareManager.ts";

export interface LocalProjectResourceReferenceSummary {
  referencedSourceAudioHashes: Set<string>;
  referencedTaskIds: Set<string>;
  referencedEntryIds: Set<string>;
  projectCountByHash: Map<string, Set<string>>;
}

export function collectLocalProjectResourceReferences(
  projects: readonly PersistedProjectRecord[],
  options?: { excludeProjectId?: string },
): LocalProjectResourceReferenceSummary {
  const referencedSourceAudioHashes = new Set<string>();
  const referencedTaskIds = new Set<string>();
  const referencedEntryIds = new Set<string>();
  const projectCountByHash = new Map<string, Set<string>>();

  for (const rec of projects) {
    if (options?.excludeProjectId && rec.projectId === options.excludeProjectId) continue;
    for (const entry of rec.project.songs) {
      referencedEntryIds.add(entry.entryId);
      if (entry.sourceAudioHash) {
        referencedSourceAudioHashes.add(entry.sourceAudioHash);
        let set = projectCountByHash.get(entry.sourceAudioHash);
        if (!set) {
          set = new Set();
          projectCountByHash.set(entry.sourceAudioHash, set);
        }
        set.add(rec.projectId);
      }
      if (entry.artifactRef?.localTaskId) {
        referencedTaskIds.add(entry.artifactRef.localTaskId);
      }
    }
  }

  return {
    referencedSourceAudioHashes,
    referencedTaskIds,
    referencedEntryIds,
    projectCountByHash,
  };
}

export async function isAudioHashReferencedAcrossWorkspace(
  sourceAudioHash: string,
  options?: { excludeProjectId?: string; excludeLegacySongId?: string },
): Promise<{
  referenced: boolean;
  referencingProjectIds: string[];
  referencedByLegacySession: boolean;
}> {
  if (!sourceAudioHash) {
    return { referenced: false, referencingProjectIds: [], referencedByLegacySession: false };
  }
  const [projects, legacySession] = await Promise.all([
    getAllProjectRecords(),
    loadPersistedBandSession().catch(() => ({ songs: [] })),
  ]);
  const summary = collectLocalProjectResourceReferences(projects, {
    excludeProjectId: options?.excludeProjectId,
  });
  const projIds = Array.from(summary.projectCountByHash.get(sourceAudioHash) ?? []);
  const referencedByLegacySession = legacySession.songs.some(
    (s) => s.songId !== options?.excludeLegacySongId && s.sourceAudioHash === sourceAudioHash,
  );
  return {
    referenced: projIds.length > 0 || referencedByLegacySession,
    referencingProjectIds: projIds,
    referencedByLegacySession,
  };
}

export interface CloudArtifactReferenceCheckResult {
  safeToDelete: boolean;
  unknownCloudCoverage: boolean;
  referencingProjectIds: string[];
  referencingProjectNames: string[];
  reason?: string;
}

export async function checkShareFolderGcSafety(params: {
  shareId: string;
  explicitUserConfirmation: boolean;
  referencedByOtherShare?: boolean;
  inventoryComplete?: boolean;
  hasStagingRevision?: boolean;
}): Promise<{ safeToDelete: boolean; reason?: string }> {
  const share = await getProjectShareRecord(params.shareId).catch(() => null);
  if (!share) return { safeToDelete: false, reason: "無法取得完整分享紀錄，已採 Fail Closed。" };
  const result = canGarbageCollectShareFolder(share, {
    explicitUserConfirmation: params.explicitUserConfirmation,
    referencedByOtherShare: params.referencedByOtherShare,
    inventoryComplete: params.inventoryComplete,
    hasStagingRevision: params.hasStagingRevision,
  });
  return { safeToDelete: result.allowed, reason: result.reason };
}

function matchesTargetCloudArtifactRevision(
  ref: ProjectSongArtifactRef,
  params: { manifestFileId: string; revisionId: string; sourceAudioHash: string },
): "matched" | "ambiguous_missing_revision" | "not_matched" {
  if (params.manifestFileId && ref.manifestFileId === params.manifestFileId) {
    return "matched";
  }
  if (params.revisionId && ref.revisionId === params.revisionId) {
    return "matched";
  }
  if (params.revisionId && ref.derivedFrom?.sourceRevisionId === params.revisionId) {
    return "matched";
  }
  if (
    ref.sourceAudioHash === params.sourceAudioHash &&
    !ref.revisionId &&
    !ref.manifestFileId
  ) {
    return "ambiguous_missing_revision";
  }
  return "not_matched";
}

/**
 * 刪除 Google Drive `songs/.../revisions/...` 成果前，檢查是否仍有同帳戶雲端專案引用該成果。
 * - 完整分頁讀取全部受管理雲端專案；不可只依 sourceAudioHash 判定指定 Revision 可刪除。
 * - 若清單讀取失敗、Abort、分頁重複/超限、或部分專案缺檔/驗證失敗（incomplete），一律 fail closed 禁止刪除。
 */
export async function checkCloudArtifactReferencesAcrossProjects(params: {
  manifestFileId: string;
  revisionId: string;
  sourceAudioHash: string;
  accountId: string;
  accessToken: string;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  maxRetriesPerPage?: number;
  retryDelayMs?: readonly number[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CloudArtifactReferenceCheckResult> {
  const referencingProjectIds = new Set<string>();
  const referencingProjectNames = new Set<string>();
  let ambiguousReferenceFound = false;

  const inspectProject = (projectId: string, projectName: string, songs: ReadonlyArray<{ artifactRef?: ProjectSongArtifactRef | null }>) => {
    for (const entry of songs) {
      const ref = entry.artifactRef;
      if (!ref) continue;
      const match = matchesTargetCloudArtifactRevision(ref, params);
      if (match === "matched") {
        referencingProjectIds.add(projectId);
        referencingProjectNames.add(projectName);
      } else if (match === "ambiguous_missing_revision") {
        ambiguousReferenceFound = true;
        referencingProjectIds.add(projectId);
        referencingProjectNames.add(projectName);
      }
    }
  };

  const cachedCloudProjects = await listCloudCachedProjectRecordsByAccount(
    params.accountId,
  ).catch(() => []);
  for (const rec of cachedCloudProjects) {
    inspectProject(rec.projectId, rec.project.name, rec.project.songs);
  }

  let listRes;
  try {
    listRes = await listCloudProjectsDetailed({
      accountId: params.accountId,
      accessToken: params.accessToken,
      strict: true,
      pageSize: params.pageSize,
      maxPages: params.maxPages,
      maxItems: params.maxItems,
      maxRetriesPerPage: params.maxRetriesPerPage,
      retryDelayMs: params.retryDelayMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
  } catch (err) {
    return {
      safeToDelete: false,
      unknownCloudCoverage: true,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: Array.from(referencingProjectNames),
      reason: `無法取得完整雲端專案引用清單（${err instanceof Error ? err.message : "網路或授權錯誤"}），為避免誤刪其他專案共用成果已拒絕自動刪除。`,
    };
  }

  if (
    !listRes.complete ||
    listRes.truncated ||
    listRes.failedProjectIds.length > 0 ||
    listRes.missingFileProjectIds.length > 0
  ) {
    return {
      safeToDelete: false,
      unknownCloudCoverage: true,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: Array.from(referencingProjectNames),
      reason:
        listRes.errorMessage ||
        "雲端專案清單未完整讀取完畢（分頁受限或部分專案無法讀取），為避免誤刪已拒絕自動刪除。",
    };
  }

  for (const { project } of listRes.projects) {
    inspectProject(project.projectId, project.name, project.songs);
  }

  if (referencingProjectIds.size > 0) {
    const names = Array.from(referencingProjectNames);
    return {
      safeToDelete: false,
      unknownCloudCoverage: ambiguousReferenceFound,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: names,
      reason: ambiguousReferenceFound
        ? `偵測到 ${names.length} 個專案引用同來源音訊且缺少明確 Revision 資訊，保守拒絕自動刪除：${names.join("、")}。`
        : `此分軌成果仍被 ${names.length} 個雲端專案引用：${names.join("、")}。請先從該專案移除或改版後再刪除。`,
    };
  }

  return {
    safeToDelete: true,
    unknownCloudCoverage: false,
    referencingProjectIds: [],
    referencingProjectNames: [],
  };
}
