import { createInitialPersistedProjectRecord, generateEntryId, generateProjectUuid, generateRevisionToken } from "../projects/projectModel.ts";
import type { BandProject, PersistedProjectRecord } from "../projects/projectTypes.ts";
import { saveProjectRecord, setActiveProjectId } from "../storage/projectStore.ts";
import type { ProjectShareManifest } from "./shareTypes.ts";
import { validateProjectShareManifest } from "./shareManifest.ts";

export function createImportedProjectFromShare(params: {
  manifest: ProjectShareManifest;
  recipientAccountId: string;
  pointerFileId?: string;
  projectId?: string;
  nowIso?: string;
}): BandProject {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const projectId = params.projectId ?? generateProjectUuid();
  const sharedByEntry = new Map(params.manifest.songs.map((song) => [song.entry.entryId, song]));
  const songs = params.manifest.project.songs
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((entry, order) => {
      const shared = sharedByEntry.get(entry.entryId);
      if (!shared) throw new Error(`共享專案缺少歌曲「${entry.displayName}」的成果索引。`);
      return {
        ...structuredClone(entry),
        entryId: generateEntryId(),
        order,
        source: { provider: "local" as const },
        originalBackup: null,
        artifactRef: entry.artifactRef
          ? {
              ...entry.artifactRef,
              manifestFileId: shared.manifestFileId,
              artifactChecksums: Object.fromEntries(shared.artifacts
                .filter((artifact) => (artifact.checksumDescriptor?.algorithm ?? artifact.checksumAlgorithm ?? "sha256") === "sha256")
                .map((artifact) => [artifact.role, artifact.checksum])),
              localTaskId: null,
              localSourceType: null,
            }
          : null,
        backupStatus: "stems_backed_up" as const,
      };
    });
  return {
    ...structuredClone(params.manifest.project),
    projectId,
    name: `${params.manifest.project.name}（共享副本）`,
    storageProvider: "local",
    ownerAccountId: undefined,
    driveFolderId: undefined,
    driveProjectFileId: undefined,
    driveRevisionsFolderId: undefined,
    revision: 1,
    revisionToken: generateRevisionToken(1),
    parentRevisionId: undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    songs,
    importedFromShare: {
      shareId: params.manifest.shareId,
      sourceProjectId: params.manifest.sourceProjectId,
      publishedRevisionId: params.manifest.publishedRevisionId,
      importedAt: nowIso,
      ownerAccountId: params.manifest.ownerAccountId,
      shareManifestFileId: params.pointerFileId ?? "",
      dependsOnSourceDrive: true,
    },
  };
}

export async function importSharedProjectMetadata(params: {
  manifest: ProjectShareManifest;
  recipientAccountId: string;
  pointerFileId?: string;
  setActive?: boolean;
}): Promise<PersistedProjectRecord> {
  const validated = validateProjectShareManifest(params.manifest, {
    shareId: params.manifest.shareId,
    publishedRevisionId: params.manifest.publishedRevisionId,
  });
  const project = createImportedProjectFromShare({ ...params, manifest: validated });
  const initial = createInitialPersistedProjectRecord(project, { dirty: false, syncStatus: "local_only" });
  const saved = await saveProjectRecord(initial, { allowCreateIfDeleted: true });
  if (!saved.saved) throw new Error(saved.errorMessage || "無法保存匯入的共享專案。");
  if (params.setActive !== false) await setActiveProjectId(saved.record.projectId);
  return saved.record;
}
