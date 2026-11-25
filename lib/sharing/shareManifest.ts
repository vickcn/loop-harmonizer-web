import type { BandProject, ProjectSongEntry } from "../projects/projectTypes.ts";
import {
  PROJECT_SHARE_APPLICATION_ID,
  PROJECT_SHARE_SCHEMA_VERSION,
  type ProjectShareManifest,
  type ProjectSharePointer,
  type SharedProjectSong,
} from "./shareTypes.ts";

function cloneEntryForShare(entry: ProjectSongEntry): ProjectSongEntry {
  const artifactRef = entry.artifactRef
    ? {
        revisionId: entry.artifactRef.revisionId,
        sourceAudioHash: entry.artifactRef.sourceAudioHash,
        separationMode: entry.artifactRef.separationMode,
        modelVersion: entry.artifactRef.modelVersion,
        processingVersion: entry.artifactRef.processingVersion,
        sampleRate: entry.artifactRef.sampleRate,
        channelCount: entry.artifactRef.channelCount,
        totalSamples: entry.artifactRef.totalSamples,
        pcmFormat: entry.artifactRef.pcmFormat,
        artifactChecksums: entry.artifactRef.artifactChecksums
          ? { ...entry.artifactRef.artifactChecksums }
          : undefined,
        derivedFrom: entry.artifactRef.derivedFrom
          ? {
              sourceMode: entry.artifactRef.derivedFrom.sourceMode,
              modelVersion: entry.artifactRef.derivedFrom.modelVersion,
              processingVersion: entry.artifactRef.derivedFrom.processingVersion,
            }
          : null,
        manifestFileId: entry.artifactRef.manifestFileId,
        localTaskId: null,
        localSourceType: null,
      }
    : null;
  return {
    ...structuredClone(entry),
    source: { provider: "local" },
    originalBackup: null,
    artifactRef,
    backupStatus: artifactRef ? "stems_backed_up" : "local_only",
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
    ownerAccountId: undefined,
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
      artifacts: song.artifacts.map((artifact) => ({
        ...structuredClone(artifact),
        checksumAlgorithm: artifact.checksumAlgorithm ?? (artifact.md5Checksum === artifact.checksum ? "md5" : "sha256"),
        checksumDescriptor: artifact.checksumDescriptor ?? {
          algorithm: artifact.checksumAlgorithm ?? (artifact.md5Checksum === artifact.checksum ? "md5" : "sha256"),
          value: artifact.checksum,
        },
        sourceAudioHash: artifact.sourceAudioHash ?? song.entry.sourceAudioHash,
        separationMode: artifact.separationMode ?? song.entry.artifactRef!.separationMode,
        modelVersion: artifact.modelVersion ?? song.entry.artifactRef!.modelVersion,
        processingVersion: artifact.processingVersion ?? song.entry.artifactRef!.processingVersion,
        pcmFormat: artifact.pcmFormat ?? song.entry.artifactRef!.pcmFormat ?? "wav-pcm16",
        sampleRate: artifact.sampleRate ?? song.entry.artifactRef!.sampleRate,
        channelCount: 2,
        totalSamples: artifact.totalSamples ?? song.entry.artifactRef!.totalSamples,
        artifactRevision: artifact.artifactRevision ?? song.artifactRevision,
      })),
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
  lifecycle?: "published" | "revoking" | "revoked";
  operationId?: string;
  revocationGeneration?: number;
  revokedAt?: string;
}): ProjectSharePointer {
  return {
    schemaVersion: PROJECT_SHARE_SCHEMA_VERSION,
    application: PROJECT_SHARE_APPLICATION_ID,
    kind: "project-share-pointer",
    shareId: params.manifest.shareId,
    sourceProjectId: params.manifest.sourceProjectId,
    ownerAccountId: params.manifest.ownerAccountId,
    visibility: params.visibility,
    lifecycle: params.lifecycle ?? "published",
    operationId: params.operationId,
    revocationGeneration: params.revocationGeneration,
    revokedAt: params.revokedAt,
    publishedRevisionId: params.manifest.publishedRevisionId,
    revisionManifestFileId: params.revisionManifestFileId,
    projectName: params.manifest.project.name,
    songCount: params.manifest.songs.length,
    updatedAt: params.nowIso ?? new Date().toISOString(),
  };
}

export function validateProjectSharePointer(value: unknown): ProjectSharePointer {
  let serializedBytes = 0;
  try { serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { throw new Error("分享描述檔無法序列化。"); }
  const row = value as Partial<ProjectSharePointer> | null;
  if (
    serializedBytes <= 0 ||
    serializedBytes > 64 * 1024 ||
    !row ||
    row.schemaVersion !== 1 ||
    row.application !== PROJECT_SHARE_APPLICATION_ID ||
    row.kind !== "project-share-pointer" ||
    !row.shareId ||
    !row.sourceProjectId ||
    !row.ownerAccountId ||
    !row.publishedRevisionId ||
    !row.revisionManifestFileId ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(row.revisionManifestFileId) ||
    typeof row.projectName !== "string" ||
    row.projectName.length > 300 ||
    !Number.isInteger(row.songCount) ||
    row.songCount! < 0 ||
    row.songCount! > 500 ||
    (row.visibility !== "restricted" && row.visibility !== "link")
  ) {
    throw new Error("分享描述檔格式無效或缺少必要欄位。");
  }
  if (row.lifecycle && !["published", "revoking", "revoked"].includes(row.lifecycle)) {
    throw new Error("分享描述檔生命週期無效。");
  }
  return row as ProjectSharePointer;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SAFE_CHECKSUM = /^[A-Za-z0-9+/=_:-]{3,256}$/;
const REQUIRED_ROLES = {
  two_stem: ["vocals", "instrumental"],
  four_stem: ["vocals", "drums", "bass", "other"],
} as const;

function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function validateProjectShareManifest(
  value: unknown,
  expected?: { shareId?: string; publishedRevisionId?: string },
): ProjectShareManifest {
  let serializedBytes = 0;
  try { serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { throw new Error("共享專案 Manifest 無法序列化。"); }
  if (serializedBytes <= 0 || serializedBytes > 4 * 1024 * 1024) {
    throw new Error("共享專案 Manifest 大小超過安全上限。");
  }
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
  if (!Array.isArray(row.project.songs) || row.project.songs.length > 500 || row.songs.length > 500) {
    throw new Error("共享專案歌曲數量超過安全上限。");
  }
  if (row.project.songs.length !== row.songs.length) {
    throw new Error("Project Songs 與 Shared Songs 數量不一致。");
  }
  const ids = new Set<string>();
  const projectIds = new Set<string>();
  for (const entry of row.project.songs) {
    if (!entry?.entryId || projectIds.has(entry.entryId)) throw new Error("共享專案歌曲 Entry ID 重複或缺失。");
    projectIds.add(entry.entryId);
    const settings = entry.settings;
    if (!settings || !finiteBetween(settings.originalBpm, 20, 400) || !finiteBetween(settings.targetBpm, 20, 400)) {
      throw new Error(`歌曲「${entry.displayName ?? "未命名"}」BPM 超出安全範圍。`);
    }
    if (!finiteBetween(settings.keyShiftSemitones, -12, 12) || !finiteBetween(settings.manualRate, 0.25, 4) || !finiteBetween(settings.masterVolume, 0, 1)) {
      throw new Error(`歌曲「${entry.displayName ?? "未命名"}」Key、速度或音量設定無效。`);
    }
    if (settings.loop) {
      const start = settings.loopStartSec ?? 0;
      const end = settings.loopEndSec ?? entry.durationSec;
      if (!finiteBetween(start, 0, Math.max(0, entry.durationSec)) || !finiteBetween(end, 0, Math.max(0, entry.durationSec)) || end <= start) {
        throw new Error(`歌曲「${entry.displayName ?? "未命名"}」Loop 區間無效。`);
      }
    }
    if (settings.stemChannels.some((stem) => !finiteBetween(stem.volume, 0, 1))) {
      throw new Error(`歌曲「${entry.displayName ?? "未命名"}」分軌音量無效。`);
    }
  }
  for (const song of row.songs) {
    if (!song?.entry?.entryId || ids.has(song.entry.entryId)) {
      throw new Error("共享歌曲缺少唯一 Entry ID。");
    }
    ids.add(song.entry.entryId);
    if (!projectIds.has(song.entry.entryId)) throw new Error("共享歌曲與 Project Songs 無法一一對應。");
    if (!song.manifestFileId || !song.artifactRevision || !Array.isArray(song.artifacts)) {
      throw new Error(`歌曲「${song.entry.displayName}」缺少共享分軌資料。`);
    }
    const ref = song.entry.artifactRef;
    if (!ref || ref.sourceAudioHash !== song.entry.sourceAudioHash || ref.revisionId !== song.artifactRevision) {
      throw new Error(`歌曲「${song.entry.displayName}」來源 Hash 或 Artifact Revision 不一致。`);
    }
    if (!finiteBetween(ref.sampleRate, 8_000, 384_000) || ref.channelCount !== 2 || !finiteBetween(ref.totalSamples, 1, 2_147_483_647)) {
      throw new Error(`歌曲「${song.entry.displayName}」音訊規格無效。`);
    }
    const required = REQUIRED_ROLES[ref.separationMode];
    const roles = new Set<string>();
    if (song.artifacts.length !== required.length) throw new Error(`歌曲「${song.entry.displayName}」分軌角色數量不正確。`);
    for (const artifact of song.artifacts) {
      if (roles.has(artifact.role)) throw new Error(`歌曲「${song.entry.displayName}」含重複 Stem Role。`);
      roles.add(artifact.role);
      if (
        !required.includes(artifact.role as never) ||
        !SAFE_ID.test(artifact.fileId) ||
        !SAFE_CHECKSUM.test(artifact.checksum) ||
        (artifact.checksumAlgorithm !== undefined && artifact.checksumAlgorithm !== "sha256" && artifact.checksumAlgorithm !== "md5") ||
        (artifact.checksumDescriptor !== undefined &&
          (artifact.checksumDescriptor.algorithm !== "sha256" && artifact.checksumDescriptor.algorithm !== "md5" ||
            artifact.checksumDescriptor.value !== artifact.checksum)) ||
        !finiteBetween(artifact.sizeBytes, 45, 16 * 1024 * 1024 * 1024) ||
        (artifact.sourceAudioHash !== undefined && artifact.sourceAudioHash !== ref.sourceAudioHash) ||
        (artifact.separationMode !== undefined && artifact.separationMode !== ref.separationMode) ||
        (artifact.modelVersion !== undefined && artifact.modelVersion !== ref.modelVersion) ||
        (artifact.processingVersion !== undefined && artifact.processingVersion !== ref.processingVersion) ||
        (artifact.artifactRevision !== undefined && artifact.artifactRevision !== ref.revisionId) ||
        (artifact.sampleRate !== undefined && artifact.sampleRate !== ref.sampleRate) ||
        (artifact.channelCount !== undefined && artifact.channelCount !== 2) ||
        (artifact.totalSamples !== undefined && artifact.totalSamples !== ref.totalSamples)
      ) {
        throw new Error(`歌曲「${song.entry.displayName}」包含無效或不一致的分軌成果。`);
      }
    }
    if (required.some((role) => !roles.has(role))) {
      throw new Error(`歌曲「${song.entry.displayName}」缺少必要 Stem Role。`);
    }
    if (song.artifacts.some((a) => !a.fileId || !a.checksum || a.sizeBytes <= 0)) {
      throw new Error(`歌曲「${song.entry.displayName}」包含無效的分軌成果。`);
    }
  }
  return row as ProjectShareManifest;
}
