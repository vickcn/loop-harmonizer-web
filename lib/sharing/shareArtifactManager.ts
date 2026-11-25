import {
  copyDriveFile,
  downloadDriveFilePrefix,
  downloadDriveJson,
  getDriveFileMetadata,
  listDriveFiles,
  uploadDriveMultipartJson,
} from "../google/driveClient.ts";
import {
  getManifestTotalStemBytes,
  requiredStemRolesForMode,
  validateDriveSongManifest,
  type DriveSongManifest,
} from "../google/driveManifest.ts";
import { ensureShareSongArtifactFolder } from "../google/driveFolderManager.ts";
import type { PersistedProjectRecord, ProjectSongEntry } from "../projects/projectTypes.ts";
import type {
  ProjectSharePreflightIssue,
  ProjectSharePreflightResult,
  SharedProjectSong,
} from "./shareTypes.ts";

export type PreparedShareSong = {
  entry: ProjectSongEntry;
  sourceManifest: DriveSongManifest;
};

export function buildShareArtifactIdentity(params: {
  sourceAudioHash: string;
  separationMode: string;
  modelVersion: string;
  processingVersion: string;
  artifactRevision: string;
  role: string;
  checksum: string;
  sizeBytes: number;
  pcmFormat: string;
}): string {
  const input = [params.sourceAudioHash, params.separationMode, params.modelVersion, params.processingVersion, params.artifactRevision, params.role, params.checksum, String(params.sizeBytes), params.pcmFormat].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildSharedDriveSongManifest(params: {
  entry: ProjectSongEntry;
  sourceManifest: DriveSongManifest;
  copiedArtifacts: DriveSongManifest["artifacts"];
  shareId: string;
  ownerAccountId: string;
  nowIso?: string;
}): DriveSongManifest {
  const nowIso = params.nowIso ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    application: "loop-harmonizer",
    songId: params.entry.entryId,
    songName: params.entry.displayName,
    stableSongKey: `shared-${params.shareId}-${params.entry.entryId}`,
    revisionId: params.sourceManifest.revisionId,
    ownerAccountId: params.ownerAccountId,
    source: { provider: "local", fileName: "shared-stems", sourceAudioHash: params.sourceManifest.source.sourceAudioHash },
    separation: {
      mode: params.sourceManifest.separation.mode,
      modelVersion: params.sourceManifest.separation.modelVersion,
      processingVersion: params.sourceManifest.separation.processingVersion,
      sampleRate: params.sourceManifest.separation.sampleRate,
      channelCount: 2,
      totalSamples: params.sourceManifest.separation.totalSamples,
      format: params.sourceManifest.separation.format,
      derivedFrom: params.sourceManifest.separation.derivedFrom
        ? {
            sourceMode: params.sourceManifest.separation.derivedFrom.sourceMode,
            sourceRevisionId: params.sourceManifest.separation.derivedFrom.sourceRevisionId,
            modelVersion: params.sourceManifest.separation.derivedFrom.modelVersion,
            processingVersion: params.sourceManifest.separation.derivedFrom.processingVersion,
          }
        : null,
    },
    artifacts: params.copiedArtifacts,
    status: "completed",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function validateStandardWavHeader(
  buffer: ArrayBuffer,
  expected: DriveSongManifest["separation"],
  fileName: string,
): void {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") {
    throw new Error(`分軌「${fileName}」不是有效的標準 RIFF/WAVE 檔案。`);
  }
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const expectedAudioFormat = expected.format === "wav-float32" ? 3 : 1;
  const expectedBits = expected.format === "wav-float32" ? 32 : 16;
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const totalSamples = bytesPerFrame > 0 ? Math.floor(dataBytes / bytesPerFrame) : 0;
  if (
    audioFormat !== expectedAudioFormat ||
    bitsPerSample !== expectedBits ||
    channels !== expected.channelCount ||
    sampleRate !== expected.sampleRate ||
    totalSamples !== expected.totalSamples
  ) {
    throw new Error(`分軌「${fileName}」的 WAV 格式、取樣率、聲道或總樣本數與 Manifest 不一致。`);
  }
}

async function validateDriveArtifacts(params: {
  manifest: DriveSongManifest;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  for (const role of requiredStemRolesForMode(params.manifest.separation.mode)) {
    const artifact = params.manifest.artifacts[role]!;
    const metadata = await getDriveFileMetadata(artifact.fileId, {
      accessToken: params.accessToken,
      fields: "id,name,mimeType,size,md5Checksum,trashed,capabilities(canDownload,canCopy)",
      fileName: artifact.fileName,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    if (metadata.trashed || metadata.capabilities?.canDownload === false || metadata.capabilities?.canCopy === false) {
      throw new Error(`分軌「${artifact.fileName}」不存在、不可下載或不可建立安全副本。`);
    }
    if (Number(metadata.size) !== artifact.sizeBytes) {
      throw new Error(`分軌「${artifact.fileName}」的實際大小與 Manifest 不一致。`);
    }
    if (artifact.md5Checksum && metadata.md5Checksum !== artifact.md5Checksum) {
      throw new Error(`分軌「${artifact.fileName}」的 Drive MD5 checksum 不一致。`);
    }
    const header = await downloadDriveFilePrefix({
      fileId: artifact.fileId,
      accessToken: params.accessToken,
      byteLength: 44,
      fileName: artifact.fileName,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    validateStandardWavHeader(header, params.manifest.separation, artifact.fileName);
  }
}

export async function runProjectSharePreflight(params: {
  record: PersistedProjectRecord;
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProjectSharePreflightResult & { preparedSongs: PreparedShareSong[] }> {
  const issues: ProjectSharePreflightIssue[] = [];
  const preparedSongs: PreparedShareSong[] = [];
  let estimatedBytes = 0;

  for (const entry of params.record.project.songs.slice().sort((a, b) => a.order - b.order)) {
    const fail = (code: ProjectSharePreflightIssue["code"], message: string) => {
      issues.push({ entryId: entry.entryId, songName: entry.displayName, code, message });
    };
    if (!entry.sourceAudioHash) {
      fail("missing_source_hash", "缺少原始音訊 Hash，無法驗證分軌來源。");
      continue;
    }
    if (!entry.artifactRef || !entry.settings.separationMode) {
      fail("separation_incomplete", "尚未完成可分享的分軌成果。");
      continue;
    }
    if (!entry.artifactRef.manifestFileId) {
      fail("missing_manifest", "分軌尚未同步至 Google Drive，缺少 Manifest。");
      continue;
    }
    try {
      const raw = await downloadDriveJson<unknown>({
        fileId: entry.artifactRef.manifestFileId,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      const checked = validateDriveSongManifest(raw, { expectedAccountId: params.accountId });
      if (!checked.valid || !checked.manifest) {
        fail("manifest_invalid", checked.reasons.join("；"));
        continue;
      }
      const manifest = checked.manifest;
      if (
        manifest.source.sourceAudioHash !== entry.sourceAudioHash ||
        manifest.revisionId !== entry.artifactRef.revisionId ||
        manifest.separation.modelVersion !== entry.artifactRef.modelVersion ||
        manifest.separation.processingVersion !== entry.artifactRef.processingVersion
      ) {
        fail("artifact_invalid", "專案引用與分軌 Manifest 的來源或版本不一致。");
        continue;
      }
      const missingChecksum = requiredStemRolesForMode(manifest.separation.mode).find((role) => {
        const artifact = manifest.artifacts[role];
        return !artifact?.checksum && !artifact?.md5Checksum;
      });
      if (missingChecksum) {
        fail("artifact_invalid", `分軌 ${missingChecksum} 缺少可驗證 Checksum。`);
        continue;
      }
      await validateDriveArtifacts({
        manifest,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      estimatedBytes += getManifestTotalStemBytes(manifest);
      preparedSongs.push({ entry: structuredClone(entry), sourceManifest: manifest });
    } catch (err) {
      fail("manifest_invalid", err instanceof Error ? err.message : "無法讀取分軌 Manifest。");
    }
  }

  return { ok: issues.length === 0 && preparedSongs.length === params.record.project.songs.length, estimatedBytes, issues, preparedSongs };
}

async function findReusableCopiedFile(params: {
  parentId: string;
  shareId: string;
  role: string;
  checksum: string;
  sourceAudioHash: string;
  separationMode: string;
  modelVersion: string;
  processingVersion: string;
  artifactRevision: string;
  sizeBytes: number;
  pcmFormat: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const safe = (v: string) => v.replace(/'/g, "");
  const identity = buildShareArtifactIdentity(params);
  const result = await listDriveFiles({
    accessToken: params.accessToken,
    q: [
      `'${safe(params.parentId)}' in parents`,
      "trashed=false",
      `appProperties has { key='lhApp' and value='loop-harmonizer' }`,
      `appProperties has { key='lhRole' and value='share_artifact' }`,
      `appProperties has { key='lhShareId' and value='${safe(params.shareId)}' }`,
      `appProperties has { key='lhStemRole' and value='${safe(params.role)}' }`,
      `appProperties has { key='lhChecksum' and value='${safe(params.checksum)}' }`,
      `appProperties has { key='lhSourceAudioHash' and value='${safe(params.sourceAudioHash)}' }`,
      `appProperties has { key='lhSeparationMode' and value='${safe(params.separationMode)}' }`,
      `appProperties has { key='lhModelVersion' and value='${safe(params.modelVersion)}' }`,
      `appProperties has { key='lhProcessingVersion' and value='${safe(params.processingVersion)}' }`,
      `appProperties has { key='lhArtifactRevision' and value='${safe(params.artifactRevision)}' }`,
      `appProperties has { key='lhSizeBytes' and value='${safe(String(params.sizeBytes))}' }`,
      `appProperties has { key='lhPcmFormat' and value='${safe(params.pcmFormat)}' }`,
      `appProperties has { key='lhArtifactIdentity' and value='${safe(identity)}' }`,
    ].join(" and "),
    pageSize: 10,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  return result.files[0] ?? null;
}

export async function copyPreparedShareSong(params: {
  prepared: PreparedShareSong;
  revisionFolderId: string;
  artifactPoolFolderId?: string;
  shareId: string;
  publishedRevisionId: string;
  ownerAccountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SharedProjectSong> {
  const { entry, sourceManifest } = params.prepared;
  const artifactFolderId = await ensureShareSongArtifactFolder({
    revisionFolderId: params.artifactPoolFolderId ?? params.revisionFolderId,
    shareId: params.shareId,
    entryId: entry.entryId,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  const artifacts: SharedProjectSong["artifacts"] = [];
  const copiedArtifacts: DriveSongManifest["artifacts"] = {};

  for (const role of requiredStemRolesForMode(sourceManifest.separation.mode)) {
    const source = sourceManifest.artifacts[role]!;
    const checksum = source.checksum || source.md5Checksum!;
    const artifactIdentity = buildShareArtifactIdentity({
      sourceAudioHash: sourceManifest.source.sourceAudioHash,
      separationMode: sourceManifest.separation.mode,
      modelVersion: sourceManifest.separation.modelVersion,
      processingVersion: sourceManifest.separation.processingVersion,
      artifactRevision: sourceManifest.revisionId,
      role,
      checksum,
      sizeBytes: source.sizeBytes,
      pcmFormat: sourceManifest.separation.format,
    });
    const reusable = await findReusableCopiedFile({
      parentId: artifactFolderId,
      shareId: params.shareId,
      role,
      checksum,
      sourceAudioHash: sourceManifest.source.sourceAudioHash,
      separationMode: sourceManifest.separation.mode,
      modelVersion: sourceManifest.separation.modelVersion,
      processingVersion: sourceManifest.separation.processingVersion,
      artifactRevision: sourceManifest.revisionId,
      sizeBytes: source.sizeBytes,
      pcmFormat: sourceManifest.separation.format,
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    const copied = reusable ?? await copyDriveFile({
      fileId: source.fileId,
      accessToken: params.accessToken,
      name: source.fileName,
      parentId: artifactFolderId,
      appProperties: {
        lhApp: "loop-harmonizer",
        lhRole: "share_artifact",
        lhShareId: params.shareId,
        lhPublishedRevisionId: params.publishedRevisionId,
        lhEntryId: entry.entryId,
        lhStemRole: role,
        lhChecksum: checksum,
        lhSourceAudioHash: sourceManifest.source.sourceAudioHash,
        lhSeparationMode: sourceManifest.separation.mode,
        lhModelVersion: sourceManifest.separation.modelVersion,
        lhProcessingVersion: sourceManifest.separation.processingVersion,
        lhArtifactRevision: sourceManifest.revisionId,
        lhSizeBytes: String(source.sizeBytes),
        lhPcmFormat: sourceManifest.separation.format,
        lhArtifactIdentity: artifactIdentity,
      },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    const copiedDescriptor = {
      fileId: copied.id,
      fileName: copied.name || `${role}.wav`,
      mimeType: copied.mimeType || "audio/wav",
      sizeBytes: Number(copied.size) || source.sizeBytes,
      checksum: source.checksum,
      md5Checksum: copied.md5Checksum ?? source.md5Checksum,
    };
    copiedArtifacts[role] = copiedDescriptor;
    const copiedMetadata = await getDriveFileMetadata(copied.id, {
      accessToken: params.accessToken,
      fields: "id,name,mimeType,size,md5Checksum,trashed,capabilities(canDownload)",
      fileName: copiedDescriptor.fileName,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    if (
      copiedMetadata.trashed ||
      copiedMetadata.capabilities?.canDownload === false ||
      Number(copiedMetadata.size) !== source.sizeBytes ||
      (source.md5Checksum && copiedMetadata.md5Checksum !== source.md5Checksum)
    ) {
      throw new Error(`共享副本「${copiedDescriptor.fileName}」的大小或 Drive MD5 驗證失敗。`);
    }
    validateStandardWavHeader(await downloadDriveFilePrefix({
      fileId: copied.id,
      accessToken: params.accessToken,
      byteLength: 44,
      fileName: copiedDescriptor.fileName,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }), sourceManifest.separation, copiedDescriptor.fileName);
    artifacts.push({
      role,
      fileId: copied.id,
      fileName: copied.name || source.fileName,
      mimeType: copied.mimeType || source.mimeType,
      sizeBytes: Number(copied.size) || source.sizeBytes,
      checksum,
      checksumAlgorithm: source.checksum ? "sha256" : "md5",
      md5Checksum: copied.md5Checksum ?? source.md5Checksum,
      sourceAudioHash: sourceManifest.source.sourceAudioHash,
      separationMode: sourceManifest.separation.mode,
      modelVersion: sourceManifest.separation.modelVersion,
      processingVersion: sourceManifest.separation.processingVersion,
      pcmFormat: sourceManifest.separation.format,
      sampleRate: sourceManifest.separation.sampleRate,
      channelCount: 2,
      totalSamples: sourceManifest.separation.totalSamples,
      artifactRevision: sourceManifest.revisionId,
    });
  }

  const copiedManifest = buildSharedDriveSongManifest({ entry, sourceManifest, copiedArtifacts, shareId: params.shareId, ownerAccountId: params.ownerAccountId });
  const uploadedManifest = await uploadDriveMultipartJson({
    accessToken: params.accessToken,
    name: "song-manifest.json",
    parentId: artifactFolderId,
    payload: copiedManifest,
    appProperties: {
      lhApp: "loop-harmonizer",
      lhRole: "share_song_manifest",
      lhShareId: params.shareId,
      lhPublishedRevisionId: params.publishedRevisionId,
      lhEntryId: entry.entryId,
    },
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const sharedEntry: ProjectSongEntry = {
    ...structuredClone(entry),
    source: { provider: "local" },
    originalBackup: null,
    artifactRef: entry.artifactRef ? { ...entry.artifactRef, manifestFileId: uploadedManifest.id } : null,
    backupStatus: "stems_backed_up",
  };
  return {
    entry: sharedEntry,
    manifestFileId: uploadedManifest.id,
    artifacts,
    artifactRevision: sourceManifest.revisionId,
  };
}
