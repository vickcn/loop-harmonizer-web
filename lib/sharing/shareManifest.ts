import type { BandProject, ProjectSongEntry } from "../projects/projectTypes.ts";
import {
  PROJECT_SHARE_APPLICATION_ID,
  PROJECT_SHARE_SCHEMA_VERSION,
  type ProjectShareManifest,
  type ProjectSharePointer,
  type SharedProjectSong,
} from "./shareTypes.ts";

function cloneEntryForShare(entry: ProjectSongEntry): ProjectSongEntry {
  return {
    ...structuredClone(entry),
    source: { provider: "local" },
    originalBackup: null,
    backupStatus: entry.artifactRef ? "stems_backed_up" : "local_only",
  };
}

export function buildSharedProjectSnapshot(
  source: BandProject,
  songs: readonly SharedProjectSong[],
): BandProject {
  const sharedByEntry = new Map(songs.map((song) => [song.entry.entryId, song]));
  return {
    ...structuredClone(source),
    storageProvider: "local",
    driveFolderId: undefined,
    driveProjectFileId: undefined,
    driveRevisionsFolderId: undefined,
    importedFromShare: undefined,
    songs: source.songs.map((entry) => {
      const shared = sharedByEntry.get(entry.entryId);
      return shared ? cloneEntryForShare(shared.entry) : cloneEntryForShare(entry);
    }),
  };
}

export function buildProjectShareManifest(params: {
  shareId: string;
  sourceProject: BandProject;
  ownerAccountId: string;
  publishedRevisionId: string;
  songs: SharedProjectSong[];
  nowIso?: string;
}): ProjectShareManifest {
  return {
    schemaVersion: PROJECT_SHARE_SCHEMA_VERSION,
    application: PROJECT_SHARE_APPLICATION_ID,
    kind: "project-share-revision",
    shareId: params.shareId,
    sourceProjectId: params.sourceProject.projectId,
    ownerAccountId: params.ownerAccountId,
    publishedRevisionId: params.publishedRevisionId,
    sourceProjectRevision: params.sourceProject.revision,
    project: buildSharedProjectSnapshot(params.sourceProject, params.songs),
    songs: params.songs.map((song) => ({
      ...structuredClone(song),
      entry: cloneEntryForShare(song.entry),
    })),
    includeOriginalAudio: false,
    createdAt: params.nowIso ?? new Date().toISOString(),
  };
}

export function buildProjectSharePointer(params: {
  manifest: ProjectShareManifest;
  revisionManifestFileId: string;
  visibility: "restricted" | "link";
  nowIso?: string;
}): ProjectSharePointer {
  return {
    schemaVersion: PROJECT_SHARE_SCHEMA_VERSION,
    application: PROJECT_SHARE_APPLICATION_ID,
    kind: "project-share-pointer",
    shareId: params.manifest.shareId,
    sourceProjectId: params.manifest.sourceProjectId,
    ownerAccountId: params.manifest.ownerAccountId,
    visibility: params.visibility,
    publishedRevisionId: params.manifest.publishedRevisionId,
    revisionManifestFileId: params.revisionManifestFileId,
    projectName: params.manifest.project.name,
    songCount: params.manifest.songs.length,
    updatedAt: params.nowIso ?? new Date().toISOString(),
  };
}

export function validateProjectSharePointer(value: unknown): ProjectSharePointer {
  const row = value as Partial<ProjectSharePointer> | null;
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.application !== PROJECT_SHARE_APPLICATION_ID ||
    row.kind !== "project-share-pointer" ||
    !row.shareId ||
    !row.sourceProjectId ||
    !row.ownerAccountId ||
    !row.publishedRevisionId ||
    !row.revisionManifestFileId ||
    (row.visibility !== "restricted" && row.visibility !== "link")
  ) {
    throw new Error("分享描述檔格式無效或缺少必要欄位。");
  }
  return row as ProjectSharePointer;
}

export function validateProjectShareManifest(
  value: unknown,
  expected?: { shareId?: string; publishedRevisionId?: string },
): ProjectShareManifest {
  const row = value as Partial<ProjectShareManifest> | null;
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.application !== PROJECT_SHARE_APPLICATION_ID ||
    row.kind !== "project-share-revision" ||
    !row.shareId ||
    !row.sourceProjectId ||
    !row.ownerAccountId ||
    !row.publishedRevisionId ||
    !row.project ||
    !Array.isArray(row.songs) ||
    row.includeOriginalAudio !== false
  ) {
    throw new Error("共享專案 Manifest 格式無效。");
  }
  if (expected?.shareId && row.shareId !== expected.shareId) {
    throw new Error("分享連結與 Manifest 的 shareId 不一致。");
  }
  if (
    expected?.publishedRevisionId &&
    row.publishedRevisionId !== expected.publishedRevisionId
  ) {
    throw new Error("分享描述檔指向的 Revision 與 Manifest 不一致。");
  }
  const ids = new Set<string>();
  for (const song of row.songs) {
    if (!song?.entry?.entryId || ids.has(song.entry.entryId)) {
      throw new Error("共享歌曲缺少唯一 Entry ID。");
    }
    ids.add(song.entry.entryId);
    if (!song.manifestFileId || !song.artifactRevision || !Array.isArray(song.artifacts)) {
      throw new Error(`歌曲「${song.entry.displayName}」缺少共享分軌資料。`);
    }
    if (song.artifacts.some((a) => !a.fileId || !a.checksum || a.sizeBytes <= 0)) {
      throw new Error(`歌曲「${song.entry.displayName}」包含無效的分軌成果。`);
    }
  }
  return row as ProjectShareManifest;
}
