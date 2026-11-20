import { getAllProjectRecords, listCloudCachedProjectRecordsByAccount } from "../storage/projectStore.ts";
import { loadPersistedBandSession } from "../storage/songSessionStore.ts";
import { listCloudProjects } from "./projectDriveSync.ts";
import type { PersistedProjectRecord } from "./projectTypes.ts";

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

/**
 * 刪除 Google Drive `songs/.../revisions/...` 成果前，檢查是否仍有同帳戶雲端專案引用該成果。
 * 若無法取得完整雲端專案清單（離線/權限不足/API 錯誤），禁止自動刪除，以防誤刪仍被其他專案引用的成果。
 */
export async function checkCloudArtifactReferencesAcrossProjects(params: {
  manifestFileId: string;
  revisionId: string;
  sourceAudioHash: string;
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CloudArtifactReferenceCheckResult> {
  const referencingProjectIds = new Set<string>();
  const referencingProjectNames = new Set<string>();

  const cachedCloudProjects = await listCloudCachedProjectRecordsByAccount(
    params.accountId,
  ).catch(() => []);
  for (const rec of cachedCloudProjects) {
    for (const entry of rec.project.songs) {
      const ref = entry.artifactRef;
      if (!ref) continue;
      if (
        ref.manifestFileId === params.manifestFileId ||
        (ref.sourceAudioHash === params.sourceAudioHash &&
          ref.revisionId === params.revisionId)
      ) {
        referencingProjectIds.add(rec.projectId);
        referencingProjectNames.add(rec.project.name);
      }
    }
  }

  let remoteCheckedOk = false;
  try {
    const remoteProjects = await listCloudProjects({
      accountId: params.accountId,
      accessToken: params.accessToken,
      strict: true,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    remoteCheckedOk = true;
    for (const { project } of remoteProjects) {
      for (const entry of project.songs) {
        const ref = entry.artifactRef;
        if (!ref) continue;
        if (
          ref.manifestFileId === params.manifestFileId ||
          (ref.sourceAudioHash === params.sourceAudioHash &&
            ref.revisionId === params.revisionId)
        ) {
          referencingProjectIds.add(project.projectId);
          referencingProjectNames.add(project.name);
        }
      }
    }
  } catch (err) {
    return {
      safeToDelete: false,
      unknownCloudCoverage: true,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: Array.from(referencingProjectNames),
      reason: `無法取得完整雲端專案引用清單（${err instanceof Error ? err.message : "網路或授權錯誤"}），為避免誤刪其他專案共用成果已拒絕自動刪除。`,
    };
  }

  if (!remoteCheckedOk) {
    return {
      safeToDelete: false,
      unknownCloudCoverage: true,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: Array.from(referencingProjectNames),
      reason: "無法確認雲端所有專案是否仍在引用此分軌。",
    };
  }

  if (referencingProjectIds.size > 0) {
    const names = Array.from(referencingProjectNames);
    return {
      safeToDelete: false,
      unknownCloudCoverage: false,
      referencingProjectIds: Array.from(referencingProjectIds),
      referencingProjectNames: names,
      reason: `此分軌成果仍被 ${names.length} 個雲端專案引用：${names.join("、")}。請先從該專案移除或改版後再刪除。`,
    };
  }

  return {
    safeToDelete: true,
    unknownCloudCoverage: false,
    referencingProjectIds: [],
    referencingProjectNames: [],
  };
}
