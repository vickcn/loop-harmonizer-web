import type {
  BandSong,
  SongPlaybackSource,
  SongSource,
  SongTempoMode,
} from "../band/bandTypes.ts";
import { sanitizeSongSavedRates } from "../band/songModel.ts";
import type { StemSeparationMode } from "../separation/stemTypes.ts";
import type { WavExportFormat } from "../audio/chunkedWavExporter.ts";

export const DRIVE_MANIFEST_SCHEMA_VERSION = 1;
export const DRIVE_APPLICATION_ID = "loop-harmonizer";

export interface DriveArtifactDescriptor {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  checksum?: string;
  md5Checksum?: string;
  mimeType: string;
}

export interface DriveManifestSourceInfo {
  provider: "google_drive" | "local";
  fileId?: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  modifiedTime?: string;
  resourceKey?: string;
  driveId?: string;
  sourceAudioHash: string;
}

export interface DriveSongManifest {
  schemaVersion: 1;
  application: "loop-harmonizer";
  songId: string;
  songName: string;
  stableSongKey: string;
  revisionId: string;
  ownerAccountId: string;
  source: DriveManifestSourceInfo;
  separation: {
    mode: StemSeparationMode;
    modelVersion: string;
    processingVersion: string;
    sampleRate: number;
    channelCount: 2;
    totalSamples: number;
    format: WavExportFormat;
    derivedFrom?: {
      sourceMode: "four_stem";
      sourceRevisionId?: string;
      modelVersion: string;
      processingVersion: string;
    } | null;
  };
  artifacts: {
    vocals?: DriveArtifactDescriptor;
    drums?: DriveArtifactDescriptor;
    bass?: DriveArtifactDescriptor;
    other?: DriveArtifactDescriptor;
    instrumental?: DriveArtifactDescriptor;
    custom_mix?: DriveArtifactDescriptor;
  };
  sessionFileId?: string;
  status: "completed";
  createdAt: string;
  updatedAt: string;
}

export interface DriveSongSessionStemChannel {
  stemType: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface DriveSongSessionPayload {
  schemaVersion: 1;
  application: "loop-harmonizer";
  songId: string;
  name: string;
  fileName: string;
  originalBpm: number;
  targetBpm: number;
  tempoMode: SongTempoMode;
  manualRate: number;
  fineRateOffset: number;
  savedRates: number[];
  keyShiftSemitones: number;
  masterVolume: number;
  muted: boolean;
  loop: boolean;
  loopStartSec?: number;
  loopEndSec?: number | null;
  playbackSource: SongPlaybackSource;
  separationMode: StemSeparationMode | null;
  stemChannels: DriveSongSessionStemChannel[];
  updatedAt: string;
}

export function requiredStemRolesForMode(
  mode: StemSeparationMode,
): ReadonlyArray<"vocals" | "drums" | "bass" | "other" | "instrumental"> {
  return mode === "two_stem"
    ? ["vocals", "instrumental"]
    : ["vocals", "drums", "bass", "other"];
}

/**
 * 建構可跨裝置安全保存的歌曲混音設定 JSON。
 * 嚴格排除 Access Token、Refresh Token、API Key、Session URI、Worker Lease 與本機暫態執行 ID。
 */
export function buildDriveSongSessionPayload(song: BandSong): DriveSongSessionPayload {
  return {
    schemaVersion: 1,
    application: DRIVE_APPLICATION_ID,
    songId: song.id,
    name: song.name,
    fileName: song.fileName,
    originalBpm: song.originalBpm,
    targetBpm: song.targetBpm,
    tempoMode: song.tempoMode,
    manualRate: song.manualRate,
    fineRateOffset: song.fineRateOffset,
    savedRates: sanitizeSongSavedRates(song.savedRates),
    keyShiftSemitones: song.keyShiftSemitones,
    masterVolume: song.masterVolume,
    muted: Boolean(song.muted),
    loop: Boolean(song.loop),
    loopStartSec: song.loopStartSec,
    loopEndSec: song.loopEndSec,
    playbackSource: song.playbackSource,
    separationMode: song.separationMode,
    stemChannels: song.stemChannels.map((ch) => ({
      stemType: ch.stemType,
      volume: ch.volume,
      muted: Boolean(ch.muted),
      solo: Boolean(ch.solo),
    })),
    updatedAt: new Date().toISOString(),
  };
}

export function buildDriveManifestSource(params: {
  source?: SongSource;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceAudioHash: string;
}): DriveManifestSourceInfo {
  if (params.source?.provider === "google_drive") {
    return {
      provider: "google_drive",
      fileId: params.source.fileId,
      fileName: params.source.fileName || params.fileName,
      mimeType: params.source.mimeType || params.mimeType,
      sizeBytes: params.source.sizeBytes ?? params.sizeBytes,
      modifiedTime: params.source.modifiedTime,
      resourceKey: params.source.targetResourceKey ?? params.source.resourceKey,
      driveId: params.source.driveId,
      sourceAudioHash: params.sourceAudioHash,
    };
  }
  return {
    provider: "local",
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    sourceAudioHash: params.sourceAudioHash,
  };
}

export function buildDriveSongManifest(params: {
  songId: string;
  songName: string;
  stableSongKey: string;
  revisionId: string;
  ownerAccountId: string;
  source: DriveManifestSourceInfo;
  mode: StemSeparationMode;
  modelVersion: string;
  processingVersion: string;
  sampleRate: number;
  totalSamples: number;
  format: WavExportFormat;
  derivedFrom?: DriveSongManifest["separation"]["derivedFrom"];
  artifacts: DriveSongManifest["artifacts"];
  sessionFileId?: string;
  createdAt?: string;
  updatedAt?: string;
}): DriveSongManifest {
  const nowIso = new Date().toISOString();
  const manifest: DriveSongManifest = {
    schemaVersion: 1,
    application: DRIVE_APPLICATION_ID,
    songId: params.songId,
    songName: params.songName,
    stableSongKey: params.stableSongKey,
    revisionId: params.revisionId,
    ownerAccountId: params.ownerAccountId,
    source: { ...params.source },
    separation: {
      mode: params.mode,
      modelVersion: params.modelVersion,
      processingVersion: params.processingVersion,
      sampleRate: params.sampleRate,
      channelCount: 2,
      totalSamples: params.totalSamples,
      format: params.format,
      ...(params.derivedFrom ? { derivedFrom: params.derivedFrom } : {}),
    },
    artifacts: { ...params.artifacts },
    sessionFileId: params.sessionFileId,
    status: "completed",
    createdAt: params.createdAt ?? nowIso,
    updatedAt: params.updatedAt ?? nowIso,
  };

  const validation = validateDriveSongManifest(manifest);
  if (!validation.valid) {
    throw new Error(`無法發布未完成或不合法的 Manifest：${validation.reasons.join("；")}`);
  }
  return manifest;
}

export function validateDriveSongManifest(
  raw: unknown,
  options?: { expectedAccountId?: string },
): { valid: boolean; reasons: string[]; manifest?: DriveSongManifest } {
  const reasons: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { valid: false, reasons: ["Manifest 格式不是有效的 JSON 物件。"] };
  }
  const m = raw as Partial<DriveSongManifest>;

  if (m.schemaVersion !== DRIVE_MANIFEST_SCHEMA_VERSION) {
    reasons.push(`不支援的 Manifest Schema 版本：${String(m.schemaVersion ?? "unknown")}`);
  }
  if (m.application !== DRIVE_APPLICATION_ID) {
    reasons.push("Manifest application 識別不符。");
  }
  if (m.status !== "completed") {
    reasons.push(`Manifest 狀態非 completed（目前為 ${String(m.status ?? "unknown")}）。`);
  }
  if (!m.ownerAccountId || typeof m.ownerAccountId !== "string") {
    reasons.push("Manifest 缺少 ownerAccountId。");
  } else if (
    options?.expectedAccountId &&
    m.ownerAccountId !== options.expectedAccountId
  ) {
    reasons.push("Manifest 擁有者帳戶與目前登入的 Google 帳號不符。");
  }
  if (!m.revisionId || typeof m.revisionId !== "string") {
    reasons.push("Manifest 缺少 revisionId。");
  }
  if (!m.source?.sourceAudioHash) {
    reasons.push("Manifest 缺少 sourceAudioHash。");
  }

  const sep = m.separation;
  if (!sep || (sep.mode !== "two_stem" && sep.mode !== "four_stem")) {
    reasons.push("Manifest separation.mode 無效。");
  } else {
    if (sep.channelCount !== 2) {
      reasons.push(`不支援的聲道數：${String(sep.channelCount)}`);
    }
    if (!Number.isFinite(sep.sampleRate) || sep.sampleRate <= 0) {
      reasons.push("Manifest separation.sampleRate 無效。");
    }
    if (!Number.isFinite(sep.totalSamples) || sep.totalSamples <= 0) {
      reasons.push("Manifest separation.totalSamples 無效。");
    }
    if (sep.format !== "wav-float32" && sep.format !== "wav-pcm16") {
      reasons.push(`不支援的 WAV PCM 編碼格式：${String(sep.format)}`);
    }
    const requiredRoles = requiredStemRolesForMode(sep.mode);
    for (const role of requiredRoles) {
      const artifact = m.artifacts?.[role];
      if (!artifact || !artifact.fileId || !Number.isFinite(artifact.sizeBytes) || artifact.sizeBytes <= 44) {
        reasons.push(`缺少必要分軌檔案或大小無效：${role}`);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    manifest: reasons.length === 0 ? (m as DriveSongManifest) : undefined,
  };
}

export function getManifestTotalStemBytes(manifest: DriveSongManifest): number {
  const roles = requiredStemRolesForMode(manifest.separation.mode);
  let total = 0;
  for (const role of roles) {
    const art = manifest.artifacts[role];
    if (art) total += art.sizeBytes;
  }
  return total;
}
