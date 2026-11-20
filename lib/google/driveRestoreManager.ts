import {
  computeSha256HexSync,
  decodeWavSampleRange,
  parseWavHeader,
} from "../audio/chunkedWavExporter.ts";
import type { BandSong } from "../band/bandTypes.ts";
import type { DeviceCapabilitiesSnapshot } from "../band/resourceGuard.ts";
import { clampBpmValue, createBandSong, sanitizeSongSavedRates } from "../band/songModel.ts";
import type { FourStemPcm } from "../separation/stemTypes.ts";
import { validateAndPrepareResume } from "../separation/separationResumeController.ts";
import { isValidationCompleted } from "../separation/separationStateRecovery.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION, createSeparationCacheKey } from "../storage/cacheKeys.ts";
import {
  type ImportedStemRecord,
  addImportedStemReference,
  createImportedStemId,
  findImportedStemByHash,
  saveImportedStemsAtomically,
  validateImportedStemIntegrity,
} from "../storage/importedStemStore.ts";
import { hashSourceAudio } from "../storage/separationCache.ts";
import {
  addCheckpointReference,
  findCompletedCheckpointBySourceAudioHash,
} from "../storage/separationCheckpointStore.ts";
import {
  DEMUCS_STRIDE_SAMPLES,
  type SeparationChunkRecord,
  computeBufferChecksum,
  computeTotalChunks,
  createChunkKey,
  getChunkSampleBounds,
  packChunkStemsToBuffer,
} from "../storage/separationChunkStore.ts";
import { saveSongStateRecord, saveSongWithAudioFile } from "../storage/songSessionStore.ts";
import {
  DriveApiError,
  deleteAppManagedDriveFile,
  downloadDriveBinaryWithProgress,
  downloadDriveFileBlob,
  downloadDriveJson,
  getDriveFileMetadata,
  listDriveFiles,
} from "./driveClient.ts";
import { LOOP_HARMONIZER_APP_TAG, ensureAppFolder } from "./driveFolderManager.ts";
import {
  type DriveSongManifest,
  type DriveSongSessionPayload,
  getManifestTotalStemBytes,
  requiredStemRolesForMode,
  validateDriveSongManifest,
} from "./driveManifest.ts";
import type { DriveRestoreStage } from "./driveTransferTypes.ts";

export const SUPPORTED_IMPORT_MODEL_VERSIONS = new Set([DEMUCS_MODEL_VERSION]);
export const SUPPORTED_IMPORT_PROCESSING_VERSIONS = new Set([SEPARATION_PROCESSING_VERSION]);

export interface DriveLibraryEntry {
  manifestFileId: string;
  revisionFolderId?: string;
  manifest: DriveSongManifest;
  totalStemBytes: number;
  localAlreadyAvailable: boolean;
  localSourceType: "demucs_checkpoint" | "imported_stem" | null;
  sourceLikelyAvailableOnDrive: boolean;
}

export interface InvalidDriveLibraryEntry {
  manifestFileId: string;
  fileName: string;
  reasons: string[];
}

export interface DriveLibraryListResult {
  entries: DriveLibraryEntry[];
  invalidEntries: InvalidDriveLibraryEntry[];
}

export interface DriveRestoreProgress {
  stage: DriveRestoreStage;
  message: string;
  currentFile?: string;
  fileIndex?: number;
  totalFiles?: number;
  loadedBytes?: number;
  totalBytes?: number | null;
}

export interface DriveRestoreResult {
  song: BandSong;
  reusedLocalStems: boolean;
  restoredOriginalAudio: boolean;
  importedStemRecord: ImportedStemRecord | null;
  checkpointTaskId: string | null;
  originalAudioWarning?: string;
}

/**
 * 預設僅讀取 `.loopHarmonizer` 內的 manifest metadata，絕不自動下載龐大的分軌 WAV 或原曲音檔。
 */
export async function listDriveLibraryEntries(params: {
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveLibraryListResult> {
  const layout = await ensureAppFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  }).catch(() => null);

  // 只查詢本系統標記且屬於目前登入帳戶的 manifest.json
  const q = [
    "trashed=false",
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRole' and value='manifest' }`,
    `appProperties has { key='lhAccountId' and value='${params.accountId.replace(/'/g, "")}' }`,
  ].join(" and ");

  const listRes = await listDriveFiles({
    accessToken: params.accessToken,
    q,
    pageSize: 50,
    orderBy: "modifiedTime desc",
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const entries: DriveLibraryEntry[] = [];
  const invalidEntries: InvalidDriveLibraryEntry[] = [];

  for (const file of listRes.files) {
    if (params.signal?.aborted) break;
    try {
      const raw = await downloadDriveJson<unknown>({
        fileId: file.id,
        accessToken: params.accessToken,
        fileName: file.name || "manifest.json",
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });

      const validation = validateDriveSongManifest(raw, {
        expectedAccountId: params.accountId,
      });
      if (!validation.valid || !validation.manifest) {
        invalidEntries.push({
          manifestFileId: file.id,
          fileName: file.name || "manifest.json",
          reasons: validation.reasons,
        });
        continue;
      }

      const manifest = validation.manifest;
      if (
        !SUPPORTED_IMPORT_MODEL_VERSIONS.has(manifest.separation.modelVersion) ||
        !SUPPORTED_IMPORT_PROCESSING_VERSIONS.has(manifest.separation.processingVersion)
      ) {
        invalidEntries.push({
          manifestFileId: file.id,
          fileName: file.name || "manifest.json",
          reasons: [
            `不支援的模型或處理版本：${manifest.separation.modelVersion} / ${manifest.separation.processingVersion}`,
          ],
        });
        continue;
      }

      const localCp = await findCompletedCheckpointBySourceAudioHash(
        manifest.source.sourceAudioHash,
        {
          modelVersion: manifest.separation.modelVersion,
          processingVersion: manifest.separation.processingVersion,
        },
      ).catch(() => null);

      let localAlreadyAvailable = false;
      let localSourceType: DriveLibraryEntry["localSourceType"] = null;

      if (localCp) {
        const cpCheck = await validateAndPrepareResume(localCp.taskId, {
          sourceAudioAvailable: true,
          sourceAudioHash: manifest.source.sourceAudioHash,
          totalSamples: localCp.totalSamples,
          sampleRate: localCp.sampleRate,
        }).catch(() => null);
        if (isValidationCompleted(cpCheck)) {
          localAlreadyAvailable = true;
          localSourceType = "demucs_checkpoint";
        }
      }

      if (!localAlreadyAvailable) {
        const localImp = await findImportedStemByHash({
          sourceAudioHash: manifest.source.sourceAudioHash,
          mode: manifest.separation.mode,
          modelVersion: manifest.separation.modelVersion,
          processingVersion: manifest.separation.processingVersion,
        }).catch(() => null);
        if (localImp) {
          const impCheck = await validateImportedStemIntegrity(localImp.importId).catch(() => ({
            valid: false,
          }));
          if (impCheck.valid) {
            localAlreadyAvailable = true;
            localSourceType = "imported_stem";
          }
        }
      }

      entries.push({
        manifestFileId: file.id,
        revisionFolderId: file.parents?.[0],
        manifest,
        totalStemBytes: getManifestTotalStemBytes(manifest),
        localAlreadyAvailable,
        localSourceType,
        sourceLikelyAvailableOnDrive:
          manifest.source.provider === "google_drive" && Boolean(manifest.source.fileId),
      });
    } catch (err) {
      invalidEntries.push({
        manifestFileId: file.id,
        fileName: file.name || "manifest.json",
        reasons: [err instanceof Error ? err.message : "無法讀取或解析 Manifest"],
      });
    }
  }

  void layout;
  return { entries, invalidEntries };
}

function buildRestoredBandSongFromManifest(params: {
  manifest: DriveSongManifest;
  manifestFileId: string;
  sessionPayload: DriveSongSessionPayload | null;
  songId: string;
  taskId: string;
  importedRecord: ImportedStemRecord | null;
  sourceAudioMissing: boolean;
  originalFileMeta?: { sizeBytes?: number; mimeType?: string; lastModified?: number };
}): BandSong {
  const { manifest, sessionPayload } = params;
  const roles = requiredStemRolesForMode(manifest.separation.mode);
  const songName = sessionPayload?.name || manifest.songName || manifest.source.fileName.replace(/\.[^.]+$/, "");
  const fileName = sessionPayload?.fileName || manifest.source.fileName || `${songName}.wav`;
  const durationSec = manifest.separation.totalSamples / manifest.separation.sampleRate;

  const base = createBandSong({
    id: params.songId,
    name: songName,
    fileName,
    sourceAudioId: `${params.songId}_original`,
    settingsKey: `${fileName}:${manifest.source.sourceAudioHash.slice(0, 12)}`,
    originalBpm: clampBpmValue(sessionPayload?.originalBpm ?? 120),
    durationSec,
    sourceAudioHash: manifest.source.sourceAudioHash,
    fileSizeBytes: params.originalFileMeta?.sizeBytes ?? manifest.source.sizeBytes,
    mimeType: params.originalFileMeta?.mimeType ?? manifest.source.mimeType,
    fileLastModified: params.originalFileMeta?.lastModified,
    persistenceStatus: "saved",
    persistenceMessage: params.sourceAudioMissing
      ? "已自 Google Drive 恢復分軌（無原曲，僅可播放分軌）"
      : "已自 Google Drive 恢復完整歌曲與分軌",
    audioLoadState: params.sourceAudioMissing ? "unloaded" : "ready",
    source:
      manifest.source.provider === "google_drive" && manifest.source.fileId
        ? {
            provider: "google_drive",
            fileId: manifest.source.fileId,
            authorizedAccountId: manifest.ownerAccountId,
            fileName,
            mimeType: manifest.source.mimeType || "audio/mpeg",
            sizeBytes: manifest.source.sizeBytes,
            modifiedTime: manifest.source.modifiedTime,
            resourceKey: manifest.source.resourceKey,
            driveId: manifest.source.driveId,
            sourceAudioHash: manifest.source.sourceAudioHash,
          }
        : { provider: "local" },
    driveExport: {
      ownerAccountId: manifest.ownerAccountId,
      revisionId: manifest.revisionId,
      manifestFileId: params.manifestFileId,
      sessionFileId: manifest.sessionFileId,
      folderId: "",
      format: manifest.separation.format,
      exportedAt: Date.parse(manifest.updatedAt) || Date.now(),
    },
    importedStemOrigin: params.importedRecord
      ? {
          importId: params.importedRecord.importId,
          ownerAccountId: manifest.ownerAccountId,
          revisionId: manifest.revisionId,
          manifestFileId: params.manifestFileId,
          pcmFormat: manifest.separation.format,
          stemLayout: params.importedRecord.stemLayout,
          importedAt: Date.now(),
        }
      : null,
    sourceAudioMissing: params.sourceAudioMissing,
  });

  const stemIds = roles.map((role) => `${params.songId}_stem_${role}`);
  const stemChannels = roles.map((role) => {
    const savedCh = sessionPayload?.stemChannels?.find((item) => item.stemType === role);
    return {
      id: `${params.songId}_stem_${role}`,
      songId: params.songId,
      stemType: role,
      volume: savedCh ? Math.max(0, Math.min(1, savedCh.volume)) : 1,
      muted: Boolean(savedCh?.muted),
      solo: Boolean(savedCh?.solo),
    };
  });

  const cacheKey = createSeparationCacheKey({
    sourceAudioHash: manifest.source.sourceAudioHash,
    modelVersion: manifest.separation.modelVersion,
    separationMode: manifest.separation.mode,
    processingVersion: manifest.separation.processingVersion,
  });

  return {
    ...base,
    targetBpm: clampBpmValue(sessionPayload?.targetBpm ?? base.originalBpm),
    tempoMode: sessionPayload?.tempoMode === "manual-rate" ? "manual-rate" : "target-bpm",
    manualRate: Math.max(0.25, Math.min(4, sessionPayload?.manualRate ?? 1)),
    fineRateOffset: Math.max(-0.05, Math.min(0.05, sessionPayload?.fineRateOffset ?? 0)),
    savedRates: sanitizeSongSavedRates(sessionPayload?.savedRates),
    keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(sessionPayload?.keyShiftSemitones ?? 0))),
    masterVolume: Math.max(0, Math.min(1, sessionPayload?.masterVolume ?? 1)),
    muted: Boolean(sessionPayload?.muted),
    loop: Boolean(sessionPayload?.loop),
    // 無原曲時強制使用 stems，絕不切到無法播放的原曲
    playbackSource: params.sourceAudioMissing
      ? "stems"
      : sessionPayload?.playbackSource === "original"
        ? "original"
        : "stems",
    separationStatus: "completed",
    separationStage: "completed",
    separationMode: manifest.separation.mode,
    separationProgress: 1,
    separationMessage: params.importedRecord
      ? `已從 Google Drive 匯入分軌（${manifest.separation.format} · 共 ${params.importedRecord.totalChunks} 段）`
      : "已重用本機既有完成分軌並套用雲端混音設定",
    separationTaskId: params.taskId,
    separationCompletedChunks: params.importedRecord?.totalChunks,
    separationTotalChunks: params.importedRecord?.totalChunks,
    separationCommittedBytes: params.importedRecord?.committedBytes,
    separationUserAuthorized: true,
    separationUsesChunkPlayback: true,
    cacheKey,
    stemIds,
    stemChannels,
  };
}

/**
 * 跨裝置恢復單首雲端歌曲成果：
 * 1. 驗證帳戶、Manifest Schema 與版本相容性；
 * 2. 若本機已有相同完成分軌，零重複下載；
 * 3. 下載 WAV 後驗證檔案大小、Checksum 與 WAV Header/取樣率/總樣本數；
 * 4. 建立正式 ImportedStemRecord + Chunk（不偽造非法 Demucs Checkpoint）；
 * 5. 恢復混音設定並選擇性恢復原曲。
 */
export async function restoreSongFromDrive(params: {
  entry: DriveLibraryEntry;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  includeOriginalAudio?: boolean;
  capabilities?: DeviceCapabilitiesSnapshot | null;
  songIdOverride?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DriveRestoreProgress) => void;
}): Promise<DriveRestoreResult> {
  const { entry, accountId, accessToken } = params;
  if (!params.isGenerationValid(params.generation, accountId)) {
    throw new Error("Google 帳戶狀態已變更，無法恢復雲端成果。");
  }

  params.onProgress?.({
    stage: "validating",
    message: "正在驗證雲端成果 Manifest 與檔案完整性…",
  });

  const manifestValidation = validateDriveSongManifest(entry.manifest, {
    expectedAccountId: accountId,
  });
  if (!manifestValidation.valid || !manifestValidation.manifest) {
    throw new Error(`雲端成果 Manifest 不完整或損壞：${manifestValidation.reasons.join("；")}`);
  }
  const manifest = manifestValidation.manifest;

  if (
    !SUPPORTED_IMPORT_MODEL_VERSIONS.has(manifest.separation.modelVersion) ||
    !SUPPORTED_IMPORT_PROCESSING_VERSIONS.has(manifest.separation.processingVersion)
  ) {
    throw new Error(
      `不支援的分軌模型版本（${manifest.separation.modelVersion} / ${manifest.separation.processingVersion}）。`,
    );
  }

  const songId =
    params.songIdOverride ??
    `song_drive_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 讀取 session.json（混音設定）
  let sessionPayload: DriveSongSessionPayload | null = null;
  if (manifest.sessionFileId) {
    sessionPayload = await downloadDriveJson<DriveSongSessionPayload>({
      fileId: manifest.sessionFileId,
      accessToken,
      fileName: "session.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }).catch(() => null);
  }

  // 先檢查本機是否已存在相同來源且完整的分離成果（有則不重複下載）
  params.onProgress?.({
    stage: "checking_local",
    message: "正在比對本機是否已存有相同分軌成果…",
  });

  const existingCp = await findCompletedCheckpointBySourceAudioHash(
    manifest.source.sourceAudioHash,
    {
      modelVersion: manifest.separation.modelVersion,
      processingVersion: manifest.separation.processingVersion,
    },
  ).catch(() => null);

  let reusedCheckpointTaskId: string | null = null;
  let importedRecord: ImportedStemRecord | null = null;
  let reusedLocalStems = false;

  if (existingCp) {
    const cpCheck = await validateAndPrepareResume(existingCp.taskId, {
      sourceAudioAvailable: true,
      sourceAudioHash: manifest.source.sourceAudioHash,
      totalSamples: existingCp.totalSamples,
      sampleRate: existingCp.sampleRate,
    }).catch(() => null);
    if (isValidationCompleted(cpCheck)) {
      reusedCheckpointTaskId = existingCp.taskId;
      reusedLocalStems = true;
      await addCheckpointReference({
        taskId: existingCp.taskId,
        songId,
        mode: manifest.separation.mode,
        source: "driveRestoreManager.reuseLocalCheckpoint",
      }).catch(() => undefined);
    }
  }

  if (!reusedLocalStems) {
    const existingImp = await findImportedStemByHash({
      sourceAudioHash: manifest.source.sourceAudioHash,
      mode: manifest.separation.mode,
      modelVersion: manifest.separation.modelVersion,
      processingVersion: manifest.separation.processingVersion,
    }).catch(() => null);

    if (existingImp) {
      const impCheck = await validateImportedStemIntegrity(existingImp.importId).catch(() => ({
        valid: false,
        record: null,
      }));
      if (impCheck.valid && impCheck.record) {
        importedRecord =
          (await addImportedStemReference(existingImp.importId, songId).catch(() => null)) ??
          impCheck.record;
        reusedLocalStems = true;
      }
    }
  }

  if (!reusedLocalStems) {
    const roles = requiredStemRolesForMode(manifest.separation.mode);
    const totalExpectedStemBytes = getManifestTotalStemBytes(manifest);
    const estimatedChunkWriteBytes =
      manifest.separation.totalSamples * 4 * 2 * Float32Array.BYTES_PER_ELEMENT;
    const totalRequiredStorage = totalExpectedStemBytes + estimatedChunkWriteBytes;

    params.onProgress?.({
      stage: "evaluating",
      message: "正在檢查裝置儲存空間與容量需求…",
    });

    if (
      params.capabilities?.storageRemainingBytes !== null &&
      params.capabilities?.storageRemainingBytes !== undefined &&
      totalRequiredStorage > params.capabilities.storageRemainingBytes * 0.9
    ) {
      throw new Error(
        `瀏覽器剩餘空間不足以儲存恢復的分軌（需要約 ${(totalRequiredStorage / (1024 * 1024)).toFixed(1)} MiB，剩餘 ${(params.capabilities.storageRemainingBytes / (1024 * 1024)).toFixed(1)} MiB）。`,
      );
    }

    const importId = createImportedStemId({
      ownerAccountId: accountId,
      sourceAudioHash: manifest.source.sourceAudioHash,
      revisionId: manifest.revisionId,
      mode: manifest.separation.mode,
    });
    const totalSamples = manifest.separation.totalSamples;
    const sampleRate = manifest.separation.sampleRate;
    const strideSamples = DEMUCS_STRIDE_SAMPLES;
    const totalChunks = computeTotalChunks(totalSamples, strideSamples);

    // 建立各 Chunk 的空白 4 軌緩衝區並依序下載單軌填入（每次僅駐留一條 WAV 音訊）
    const chunkStemsPerIndex: Array<{
      startSample: number;
      endSample: number;
      frameCount: number;
      stems: FourStemPcm;
    }> = [];
    for (let c = 0; c < totalChunks; c += 1) {
      const bounds = getChunkSampleBounds(c, totalSamples, strideSamples);
      chunkStemsPerIndex.push({
        startSample: bounds.startSample,
        endSample: bounds.endSample,
        frameCount: bounds.frameCount,
        stems: {
          vocals: {
            left: new Float32Array(bounds.frameCount),
            right: new Float32Array(bounds.frameCount),
          },
          drums: {
            left: new Float32Array(bounds.frameCount),
            right: new Float32Array(bounds.frameCount),
          },
          bass: {
            left: new Float32Array(bounds.frameCount),
            right: new Float32Array(bounds.frameCount),
          },
          other: {
            left: new Float32Array(bounds.frameCount),
            right: new Float32Array(bounds.frameCount),
          },
        },
      });
    }

    const checksumsByRole: Record<string, string> = {};

    for (let i = 0; i < roles.length; i += 1) {
      if (params.signal?.aborted) {
        throw new DOMException("已取消從 Google Drive 恢復。", "AbortError");
      }
      if (!params.isGenerationValid(params.generation, accountId)) {
        throw new Error("Google 帳戶已變更，已安全中止恢復。");
      }

      const role = roles[i];
      const artifact = manifest.artifacts[role];
      if (!artifact) {
        throw new Error(`Manifest 缺少必要分軌檔案：${role}`);
      }

      params.onProgress?.({
        stage: "downloading",
        message: `正在下載分軌 ${artifact.fileName}（${i + 1}/${roles.length}）…`,
        currentFile: artifact.fileName,
        fileIndex: i,
        totalFiles: roles.length,
        loadedBytes: 0,
        totalBytes: artifact.sizeBytes,
      });

      let wavBuffer: ArrayBuffer | null = await downloadDriveBinaryWithProgress({
        fileId: artifact.fileId,
        accessToken,
        fileName: artifact.fileName,
        expectedSizeBytes: artifact.sizeBytes,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        onProgress: (loadedBytes, totalBytes) => {
          params.onProgress?.({
            stage: "downloading",
            message: `正在下載分軌 ${artifact.fileName}（${i + 1}/${roles.length}）…`,
            currentFile: artifact.fileName,
            fileIndex: i,
            totalFiles: roles.length,
            loadedBytes,
            totalBytes,
          });
        },
      });

      const actualByteLength = wavBuffer.byteLength;
      if (actualByteLength !== artifact.sizeBytes) {
        wavBuffer = null;
        throw new Error(
          `分軌「${artifact.fileName}」下載大小不符（預期 ${artifact.sizeBytes} bytes，實際 ${actualByteLength}），可能檔案已損壞。`,
        );
      }

      if (artifact.checksum?.startsWith("sha256:")) {
        const expectedHex = artifact.checksum.slice("sha256:".length).toLowerCase();
        const actualHex = computeSha256HexSync(new Uint8Array(wavBuffer)).toLowerCase();
        if (actualHex !== expectedHex) {
          wavBuffer = null;
          throw new Error(
            `分軌「${artifact.fileName}」Checksum 驗證失敗，資料已損壞，拒絕恢復。`,
          );
        }
        checksumsByRole[role] = artifact.checksum;
      }

      const header = parseWavHeader(wavBuffer);
      if (
        header.sampleRate !== sampleRate ||
        header.totalSamples !== totalSamples ||
        header.pcmFormat !== manifest.separation.format
      ) {
        wavBuffer = null;
        throw new Error(
          `分軌「${artifact.fileName}」WAV 規格與 Manifest 不符（取樣率 ${header.sampleRate}/${sampleRate}，樣本數 ${header.totalSamples}/${totalSamples}）。`,
        );
      }

      for (let c = 0; c < totalChunks; c += 1) {
        const target = chunkStemsPerIndex[c];
        const decoded = decodeWavSampleRange(
          wavBuffer,
          header,
          target.startSample,
          target.endSample,
        );
        // 2-stem 匯入把 instrumental 寫入 slot 1 (drums 欄位) 並標記 stemLayout="two_stem_direct"
        const slotKey: keyof FourStemPcm =
          role === "instrumental" ? "drums" : role;
        target.stems[slotKey].left.set(decoded.left);
        target.stems[slotKey].right.set(decoded.right);
      }

      // 立即釋放單軌 WAV 緩衝區
      wavBuffer = null;
    }

    params.onProgress?.({
      stage: "importing",
      message: "正在建立正式匯入分軌索引並寫入本機儲存…",
    });

    const chunkRecords: SeparationChunkRecord[] = [];
    let committedBytes = 0;
    const now = Date.now();
    for (let c = 0; c < totalChunks; c += 1) {
      const item = chunkStemsPerIndex[c];
      const payload = packChunkStemsToBuffer(item.stems, item.frameCount);
      committedBytes += payload.byteLength;
      chunkRecords.push({
        key: createChunkKey(importId, c),
        taskId: importId,
        chunkIndex: c,
        startSample: item.startSample,
        endSample: item.endSample,
        modelVersion: manifest.separation.modelVersion,
        processingVersion: manifest.separation.processingVersion,
        separationMode: "four_stem",
        sampleRate,
        stemCount: 4,
        payload,
        checksum: computeBufferChecksum(payload),
        sizeBytes: payload.byteLength,
        createdAt: now,
      });
    }

    const stemLayout: "four_stem" | "two_stem_direct" =
      manifest.separation.mode === "two_stem" ? "two_stem_direct" : "four_stem";

    importedRecord = await saveImportedStemsAtomically({
      record: {
        key: importId,
        importId,
        songId,
        ownerAccountId: accountId,
        sourceAudioHash: manifest.source.sourceAudioHash,
        revisionId: manifest.revisionId,
        manifestFileId: entry.manifestFileId,
        requestedMode: manifest.separation.mode,
        stemLayout,
        pcmFormat: manifest.separation.format,
        modelVersion: manifest.separation.modelVersion,
        processingVersion: manifest.separation.processingVersion,
        sampleRate,
        channelCount: 2,
        totalSamples,
        strideSamples,
        totalChunks,
        committedBytes,
        checksumsByRole,
        referencedBySongIds: [songId],
        createdAt: now,
        updatedAt: now,
      },
      chunks: chunkRecords,
    });
  }

  // 選擇性恢復原曲（僅限 source.provider === "google_drive" 且使用者要求）
  let restoredOriginalAudio = false;
  let originalAudioWarning: string | undefined;
  let restoredOriginalFile: File | null = null;

  if (
    params.includeOriginalAudio &&
    manifest.source.provider === "google_drive" &&
    manifest.source.fileId
  ) {
    try {
      const meta = await getDriveFileMetadata(manifest.source.fileId, {
        accessToken,
        resourceKey: manifest.source.resourceKey,
        fileName: manifest.source.fileName,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      if (!meta.trashed && meta.capabilities?.canDownload !== false) {
        const downloaded = await downloadDriveFileBlob(
          {
            pickedFileId: manifest.source.fileId,
            resolvedFileId: meta.id,
            name: meta.name || manifest.source.fileName,
            mimeType: meta.mimeType || manifest.source.mimeType || "audio/mpeg",
            sizeBytes: meta.size ? Number(meta.size) : manifest.source.sizeBytes ?? null,
            modifiedTime: meta.modifiedTime,
            resourceKey: manifest.source.resourceKey,
          },
          {
            accessToken,
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          },
        );
        const downloadedHash = await hashSourceAudio(downloaded.file);
        if (downloadedHash === manifest.source.sourceAudioHash) {
          restoredOriginalFile = downloaded.file;
          restoredOriginalAudio = true;
        } else {
          originalAudioWarning =
            "Google Drive 原曲內容已變更（Hash 與匯出時不符），為避免錯配僅保留雲端分軌供播放。";
        }
      } else {
        originalAudioWarning = "雲端原曲已被刪除或停用下載，已僅恢復分軌供播放。";
      }
    } catch (err) {
      originalAudioWarning =
        err instanceof DriveApiError
          ? `無法恢復原曲（${err.message}），已僅恢復分軌供播放。`
          : "無法恢復雲端原曲，已僅恢復分軌供播放。";
    }
  }

  const effectiveTaskId = importedRecord?.importId ?? reusedCheckpointTaskId ?? "";
  const song = buildRestoredBandSongFromManifest({
    manifest,
    manifestFileId: entry.manifestFileId,
    sessionPayload,
    songId,
    taskId: effectiveTaskId,
    importedRecord,
    sourceAudioMissing: !restoredOriginalAudio,
    originalFileMeta: restoredOriginalFile
      ? {
          sizeBytes: restoredOriginalFile.size,
          mimeType: restoredOriginalFile.type,
          lastModified: restoredOriginalFile.lastModified,
        }
      : undefined,
  });

  if (restoredOriginalFile) {
    await saveSongWithAudioFile({
      song,
      file: restoredOriginalFile,
      sourceAudioHash: manifest.source.sourceAudioHash,
      force: true,
    });
  } else {
    await saveSongStateRecord(song, { force: true });
  }

  params.onProgress?.({
    stage: "completed",
    message: restoredOriginalAudio
      ? "已完成雲端分軌與原曲恢復。"
      : "已完成雲端分軌與混音設定恢復（無原曲，可直接播放分軌）。",
  });

  return {
    song,
    reusedLocalStems,
    restoredOriginalAudio,
    importedStemRecord: importedRecord,
    checkpointTaskId: reusedCheckpointTaskId,
    originalAudioWarning,
  };
}

/**
 * 僅刪除 Loop Harmonizer 管理於 `.loopHarmonizer` 內的特定 Revision 成果，絕不刪除原曲或本機分軌。
 */
export async function deleteDriveRevisionArtifacts(params: {
  entry: DriveLibraryEntry;
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (params.entry.manifest.ownerAccountId !== params.accountId) {
    throw new Error("此雲端成果不屬於目前登入的 Google 帳號，已拒絕刪除。");
  }

  const folderId = params.entry.revisionFolderId;
  if (folderId) {
    try {
      await deleteAppManagedDriveFile({
        fileId: folderId,
        accessToken: params.accessToken,
        fileName: params.entry.manifest.revisionId,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      return;
    } catch (err) {
      if (err instanceof DriveApiError && err.code !== "forbidden") {
        throw err;
      }
    }
  }

  // Fallback：逐一刪除 manifest 登記的受管理檔案（不含 source 原曲）
  const artifactIds = [
    params.entry.manifestFileId,
    params.entry.manifest.sessionFileId,
    ...Object.values(params.entry.manifest.artifacts)
      .map((a) => a?.fileId)
      .filter((id): id is string => Boolean(id)),
  ].filter((id): id is string => Boolean(id));

  for (const fileId of artifactIds) {
    await deleteAppManagedDriveFile({
      fileId,
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
  }
}
