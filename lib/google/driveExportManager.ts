import type { BandSong } from "../band/bandTypes.ts";
import {
  type CustomMixExportConfig,
  type WavByteSource,
  type WavExportFormat,
  type WavStemExportRole,
  computeWavSourceSha256,
  computeWavTotalBytes,
  createChunkedStemWavSource,
  createInMemoryStemWavSource,
  validateChunksForExport,
} from "../audio/chunkedWavExporter.ts";
import type { SeparatedStemSet, StemSeparationMode } from "../separation/stemTypes.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../storage/cacheKeys.ts";
import {
  getDriveTransferJobsBySong,
  pinTaskForDriveTransfer,
  unpinTaskForDriveTransfer,
} from "../storage/driveTransferStore.ts";
import { getImportedStemRecord } from "../storage/importedStemStore.ts";
import { getCheckpoint, recordCheckpointExportedRevision } from "../storage/separationCheckpointStore.ts";
import { DEMUCS_SAMPLE_RATE, DEMUCS_STRIDE_SAMPLES } from "../storage/separationChunkStore.ts";
import { uploadDriveMultipartJson } from "./driveClient.ts";
import {
  LOOP_HARMONIZER_APP_TAG,
  buildStableSongFolderKey,
  ensureSongRevisionFolders,
} from "./driveFolderManager.ts";
import {
  type DriveArtifactDescriptor,
  type DriveSongManifest,
  buildDriveManifestSource,
  buildDriveSongManifest,
  buildDriveSongSessionPayload,
  requiredStemRolesForMode,
} from "./driveManifest.ts";
import {
  DEFAULT_CONSTRAINED_UPLOAD_CHUNK_BYTES,
  DEFAULT_DESKTOP_UPLOAD_CHUNK_BYTES,
  uploadChunkedResumable,
} from "./driveResumableUpload.ts";
import type { DriveArtifactRole, DriveExportStage, DriveTransferJob } from "./driveTransferTypes.ts";

export interface DriveExportSelection {
  format: WavExportFormat;
  includeStems: boolean;
  includeSessionJson: boolean;
  includeCustomMix: boolean;
  selectedStemRoles?: Array<"vocals" | "drums" | "bass" | "other" | "instrumental">;
  forceNewRevision?: boolean;
}

export interface DriveExportProgress {
  stage: DriveExportStage;
  revisionId: string;
  currentArtifactRole?: DriveArtifactRole;
  currentFileName?: string;
  fileIndex: number;
  totalFiles: number;
  uploadedBytes: number;
  totalBytes: number;
  message: string;
}

export interface DriveExportResult {
  status: "completed" | "paused" | "waiting_auth" | "cancelled" | "failed";
  revisionId: string;
  folderId?: string;
  manifest?: DriveSongManifest;
  manifestFileId?: string;
  sessionFileId?: string;
  errorMessage?: string;
}

export function estimateSongDriveExportBytes(params: {
  totalSamples: number;
  mode: StemSeparationMode;
  selection: DriveExportSelection;
}): {
  stemBytesEach: number;
  stemCount: number;
  customMixBytes: number;
  sessionEstimateBytes: number;
  totalEstimatedBytes: number;
} {
  const roles = requiredStemRolesForMode(params.mode);
  const selectedRoles = params.selection.selectedStemRoles?.length
    ? roles.filter((r) => params.selection.selectedStemRoles!.includes(r))
    : [...roles];
  const stemBytesEach = computeWavTotalBytes(params.totalSamples, params.selection.format, 2);
  const stemCount = params.selection.includeStems ? selectedRoles.length : 0;
  const customMixBytes = params.selection.includeCustomMix ? stemBytesEach : 0;
  const sessionEstimateBytes = params.selection.includeSessionJson ? 4096 : 0;
  const manifestEstimateBytes = 4096;
  return {
    stemBytesEach,
    stemCount,
    customMixBytes,
    sessionEstimateBytes,
    totalEstimatedBytes:
      stemBytesEach * stemCount + customMixBytes + sessionEstimateBytes + manifestEstimateBytes,
  };
}

function getSafeFileSlug(name: string): string {
  const clean = name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return clean || "song";
}

function buildArtifactFileName(role: WavStemExportRole): string {
  if (role === "custom_mix") return "custom-mix.wav";
  return `${role}.wav`;
}

/**
 * 決定本次匯出使用的 Revision ID：
 * - 若有同歌曲、同來源 Hash 且尚未完成的重試任務且未要求 forceNewRevision，沿用該 pending revisionId 避免產生無限重複資料夾。
 * - 若先前已發布過 completed 版本，預設建立全新 revisionId，不覆寫既有重要成果。
 */
export async function resolveExportRevisionId(params: {
  songId: string;
  ownerAccountId: string;
  sourceAudioHash: string;
  mode: StemSeparationMode;
  forceNewRevision?: boolean;
  existingCompletedRevisionId?: string | null;
}): Promise<string> {
  if (!params.forceNewRevision) {
    const priorJobs = await getDriveTransferJobsBySong(params.songId, params.ownerAccountId).catch(
      () => [] as DriveTransferJob[],
    );
    const resumable = priorJobs
      .filter(
        (job) =>
          job.sourceAudioHash === params.sourceAudioHash &&
          job.revisionId !== params.existingCompletedRevisionId &&
          (job.status === "paused" ||
            job.status === "waiting_auth" ||
            job.status === "interrupted" ||
            job.status === "uploading"),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (resumable?.revisionId) {
      return resumable.revisionId;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rev-${params.mode}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function exportSongArtifactsToDrive(params: {
  song: BandSong;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  selection: DriveExportSelection;
  inMemoryStems?: SeparatedStemSet | null;
  isConstrainedDevice?: boolean;
  isFocusActive?: () => boolean;
  isPauseRequested?: () => boolean;
  onAuthExpired?: () => void;
  onProgress?: (progress: DriveExportProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveExportResult> {
  const { song, accountId, accessToken, selection } = params;
  const sourceAudioHash = song.sourceAudioHash;
  if (!sourceAudioHash) {
    return {
      status: "failed",
      revisionId: "",
      errorMessage: "缺少原始音檔內容雜湊（sourceAudioHash），無法安全輸出至 Google Drive。",
    };
  }
  if (song.separationStatus !== "completed" || !song.separationMode) {
    return {
      status: "failed",
      revisionId: "",
      errorMessage: "請先完成音軌分離，再輸出分軌成果到 Google Drive。",
    };
  }
  if (params.isFocusActive?.()) {
    return {
      status: "failed",
      revisionId: "",
      errorMessage: "目前正在執行 Demucs 分離專注模式，為保護裝置記憶體請待分離結束後再輸出至 Google Drive。",
    };
  }

  const mode = song.separationMode;
  const requiredRoles = requiredStemRolesForMode(mode);
  const transferPinId = `drive-export-${song.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let pinnedTaskId: string | null = null;
  let revisionId = "";

  try {
    // 解析來源分段資料（支援 Demucs 分段 Checkpoint、正式 ImportedStem、或記憶體快取 SeparatedStemSet）
    let taskId: string | null = song.separationTaskId ?? null;
    let totalSamples = 0;
    let sampleRate = DEMUCS_SAMPLE_RATE;
    let strideSamples = DEMUCS_STRIDE_SAMPLES;
    let stemLayout: "four_stem" | "two_stem_direct" = "four_stem";
    let modelVersion = DEMUCS_MODEL_VERSION;
    let processingVersion = SEPARATION_PROCESSING_VERSION;

    if (song.importedStemOrigin?.importId) {
      const imp = await getImportedStemRecord(song.importedStemOrigin.importId).catch(() => null);
      if (imp) {
        taskId = imp.importId;
        totalSamples = imp.totalSamples;
        sampleRate = imp.sampleRate;
        strideSamples = imp.strideSamples;
        stemLayout = imp.stemLayout;
        modelVersion = imp.modelVersion;
        processingVersion = imp.processingVersion;
      }
    }

    if (totalSamples <= 0 && taskId) {
      const cp = await getCheckpoint(taskId).catch(() => null);
      if (cp && cp.status === "completed" && cp.totalSamples > 0) {
        totalSamples = cp.totalSamples;
        sampleRate = cp.sampleRate;
        strideSamples = cp.strideSamples;
        modelVersion = cp.modelVersion;
        processingVersion = cp.processingVersion;
        await validateChunksForExport({
          taskId,
          totalSamples,
          totalChunks: cp.totalChunks,
          strideSamples,
        });
      } else {
        taskId = null;
      }
    }

    if (taskId && totalSamples > 0) {
      pinnedTaskId = taskId;
      pinTaskForDriveTransfer(taskId, transferPinId);
    } else if (params.inMemoryStems && params.inMemoryStems.tracks.length > 0) {
      totalSamples = params.inMemoryStems.tracks[0].left.length;
      sampleRate = params.inMemoryStems.sampleRate;
    } else {
      return {
        status: "failed",
        revisionId: "",
        errorMessage: "找不到已完成的分軌分段或 PCM 資料，無法輸出至 Google Drive。",
      };
    }

    revisionId = await resolveExportRevisionId({
      songId: song.id,
      ownerAccountId: accountId,
      sourceAudioHash,
      mode,
      forceNewRevision: selection.forceNewRevision,
      existingCompletedRevisionId:
        song.driveExport?.ownerAccountId === accountId ? song.driveExport.revisionId : null,
    });

    params.onProgress?.({
      stage: "preparing",
      revisionId,
      fileIndex: 0,
      totalFiles: 1,
      uploadedBytes: 0,
      totalBytes: 0,
      message: "正在準備 .loopHarmonizer 雲端資料夾與檢查輸出檔案…",
    });

    if (!params.isGenerationValid(params.generation, accountId)) {
      return {
        status: "cancelled",
        revisionId,
        errorMessage: "Google 帳號狀態已變更，已停止匯出。",
      };
    }

    const stableSongKey = buildStableSongFolderKey(sourceAudioHash);
    const folders = await ensureSongRevisionFolders({
      accountId,
      accessToken,
      stableSongKey,
      revisionId,
      includeExports: selection.includeCustomMix,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    const rolesToUpload: Array<{
      role: DriveArtifactRole;
      wavRole?: WavStemExportRole;
      fileName: string;
      targetFolderId: string;
      source?: WavByteSource;
    }> = [];

    const mixConfig: CustomMixExportConfig = {
      masterVolume: song.masterVolume,
      songMuted: Boolean(song.muted),
      stemChannels: song.stemChannels,
      appliesEffectsNote: "套用各分軌音量、Mute/Solo 與主音量（不含即時變速與升降 Key）。",
    };

    const buildWavSource = (wavRole: WavStemExportRole): WavByteSource => {
      if (taskId) {
        return createChunkedStemWavSource({
          taskId,
          role: wavRole,
          totalSamples,
          sampleRate,
          strideSamples,
          format: selection.format,
          stemLayout,
          mixConfig: wavRole === "custom_mix" ? mixConfig : undefined,
        });
      }
      return createInMemoryStemWavSource({
        stems: params.inMemoryStems!,
        role: wavRole,
        format: selection.format,
        mixConfig: wavRole === "custom_mix" ? mixConfig : undefined,
      });
    };

    if (selection.includeStems) {
      const requestedRoles = selection.selectedStemRoles?.length
        ? requiredRoles.filter((r) => selection.selectedStemRoles!.includes(r))
        : [...requiredRoles];
      for (const r of requestedRoles) {
        rolesToUpload.push({
          role: r,
          wavRole: r,
          fileName: buildArtifactFileName(r),
          targetFolderId: folders.stemsFolderId,
          source: buildWavSource(r),
        });
      }
    }

    if (selection.includeCustomMix && folders.exportsFolderId) {
      rolesToUpload.push({
        role: "custom_mix",
        wavRole: "custom_mix",
        fileName: `${getSafeFileSlug(song.name)}-custom-mix.wav`,
        targetFolderId: folders.exportsFolderId,
        source: buildWavSource("custom_mix"),
      });
    }

    const totalExpectedBytes = rolesToUpload.reduce(
      (sum, item) => sum + (item.source?.totalBytes ?? 0),
      0,
    );
    const totalSteps =
      rolesToUpload.length + (selection.includeSessionJson ? 1 : 0) + (selection.includeStems ? 1 : 0);

    const artifacts: DriveSongManifest["artifacts"] = {};
    let completedBytesBeforeCurrent = 0;

    for (let i = 0; i < rolesToUpload.length; i += 1) {
      const item = rolesToUpload[i];
      const wavSource = item.source!;
      const jobId = `drive-up:${accountId}:${song.id}:${revisionId}:${item.role}`;
      const chunkSizeBytes = params.isConstrainedDevice
        ? DEFAULT_CONSTRAINED_UPLOAD_CHUNK_BYTES
        : DEFAULT_DESKTOP_UPLOAD_CHUNK_BYTES;

      const sha256 = await computeWavSourceSha256(wavSource, params.signal);

      const res = await uploadChunkedResumable({
        jobId,
        songId: song.id,
        ownerAccountId: accountId,
        sourceAudioHash,
        revisionId,
        artifactRole: item.role,
        fileName: item.fileName,
        mimeType: "audio/wav",
        targetFolderId: item.targetFolderId,
        source: wavSource,
        accessToken,
        chunkSizeBytes,
        isPauseRequested: params.isPauseRequested,
        isAccountStillValid: () => params.isGenerationValid(params.generation, accountId),
        onAuthExpired: params.onAuthExpired,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        onProgress: (job) => {
          params.onProgress?.({
            stage: "uploading",
            revisionId,
            currentArtifactRole: item.role,
            currentFileName: item.fileName,
            fileIndex: i,
            totalFiles: Math.max(1, totalSteps),
            uploadedBytes: completedBytesBeforeCurrent + job.confirmedUploadedBytes,
            totalBytes: totalExpectedBytes,
            message: `正在上傳 ${item.fileName}（${i + 1}/${Math.max(1, totalSteps)}）…`,
          });
        },
      });

      if (res.status !== "completed" || !res.remoteFileId) {
        return {
          status: res.status,
          revisionId,
          folderId: folders.revisionFolderId,
          errorMessage: res.errorMessage,
        };
      }

      if ((res.sizeBytes ?? 0) !== wavSource.totalBytes) {
        return {
          status: "failed",
          revisionId,
          folderId: folders.revisionFolderId,
          errorMessage: `Drive 回傳「${item.fileName}」大小不符，已停止發布 Manifest。`,
        };
      }

      const descriptor: DriveArtifactDescriptor = {
        fileId: res.remoteFileId,
        fileName: item.fileName,
        sizeBytes: wavSource.totalBytes,
        checksum: `sha256:${sha256}`,
        md5Checksum: res.md5Checksum,
        mimeType: "audio/wav",
      };
      if (item.role === "vocals") artifacts.vocals = descriptor;
      else if (item.role === "drums") artifacts.drums = descriptor;
      else if (item.role === "bass") artifacts.bass = descriptor;
      else if (item.role === "other") artifacts.other = descriptor;
      else if (item.role === "instrumental") artifacts.instrumental = descriptor;
      else if (item.role === "custom_mix") artifacts.custom_mix = descriptor;

      completedBytesBeforeCurrent += wavSource.totalBytes;
    }

    // 寫入 session.json
    let sessionFileId: string | undefined;
    if (selection.includeSessionJson) {
      params.onProgress?.({
        stage: "verifying",
        revisionId,
        currentArtifactRole: "session",
        currentFileName: "session.json",
        fileIndex: rolesToUpload.length,
        totalFiles: Math.max(1, totalSteps),
        uploadedBytes: completedBytesBeforeCurrent,
        totalBytes: totalExpectedBytes,
        message: "正在寫入歌曲混音設定 session.json…",
      });
      const sessionPayload = buildDriveSongSessionPayload(song);
      const uploadedSession = await uploadDriveMultipartJson({
        accessToken,
        name: "session.json",
        parentId: folders.revisionFolderId,
        payload: sessionPayload,
        appProperties: {
          lhApp: LOOP_HARMONIZER_APP_TAG,
          lhRole: "song_session",
          lhAccountId: accountId,
          lhRevisionId: revisionId,
          lhArtifactRole: "session",
        },
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      sessionFileId = uploadedSession.id;
    }

    // 僅當所有必要分軌均已完整上傳且驗證成功時，最後才發布 completed Manifest
    const missingRequired = requiredRoles.filter((role) => !artifacts[role]);
    if (missingRequired.length > 0) {
      return {
        status: "completed",
        revisionId,
        folderId: folders.revisionFolderId,
        sessionFileId,
      };
    }

    params.onProgress?.({
      stage: "publishing",
      revisionId,
      currentArtifactRole: "manifest",
      currentFileName: "manifest.json",
      fileIndex: Math.max(0, totalSteps - 1),
      totalFiles: Math.max(1, totalSteps),
      uploadedBytes: totalExpectedBytes,
      totalBytes: totalExpectedBytes,
      message: "正在驗證成果並發布 completed manifest.json…",
    });

    const derivedFrom =
      mode === "two_stem" && song.artifactRef?.derivedFrom
        ? song.artifactRef.derivedFrom
        : mode === "two_stem" && taskId && !song.importedStemOrigin
          ? {
              sourceMode: "four_stem" as const,
              modelVersion,
              processingVersion,
            }
          : null;

    const manifest = buildDriveSongManifest({
      songId: song.id,
      songName: song.name,
      stableSongKey,
      revisionId,
      ownerAccountId: accountId,
      source: buildDriveManifestSource({
        source: song.source,
        fileName: song.fileName,
        mimeType: song.mimeType,
        sizeBytes: song.fileSizeBytes,
        sourceAudioHash,
      }),
      mode,
      modelVersion,
      processingVersion,
      sampleRate,
      totalSamples,
      format: selection.format,
      derivedFrom,
      artifacts,
      sessionFileId,
    });

    const uploadedManifest = await uploadDriveMultipartJson({
      accessToken,
      name: "manifest.json",
      parentId: folders.revisionFolderId,
      payload: manifest,
      appProperties: {
        lhApp: LOOP_HARMONIZER_APP_TAG,
        lhRole: "manifest",
        lhAccountId: accountId,
        lhRevisionId: revisionId,
        lhStableSongKey: stableSongKey,
        lhSourceAudioHash: sourceAudioHash.slice(0, 64),
      },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    if (pinnedTaskId) {
      await recordCheckpointExportedRevision(pinnedTaskId, revisionId).catch(() => undefined);
    }

    params.onProgress?.({
      stage: "completed",
      revisionId,
      fileIndex: Math.max(1, totalSteps),
      totalFiles: Math.max(1, totalSteps),
      uploadedBytes: totalExpectedBytes,
      totalBytes: totalExpectedBytes,
      message: "已將分軌與混音設定完整保存至 Google Drive。",
    });

    return {
      status: "completed",
      revisionId,
      folderId: folders.revisionFolderId,
      manifest,
      manifestFileId: uploadedManifest.id,
      sessionFileId,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        status: params.isPauseRequested?.() ? "paused" : "cancelled",
        revisionId,
      };
    }
    const msg = err instanceof Error ? err.message : "輸出成果至 Google Drive 失敗。";
    return {
      status: "failed",
      revisionId,
      errorMessage: msg,
    };
  } finally {
    if (pinnedTaskId) {
      unpinTaskForDriveTransfer(pinnedTaskId, transferPinId);
    }
  }
}
