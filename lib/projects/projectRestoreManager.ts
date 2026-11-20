import type { BandSong } from "../band/bandTypes.ts";
import type { DeviceCapabilitiesSnapshot } from "../band/resourceGuard.ts";
import { collectDeviceCapabilities } from "../band/resourceGuard.ts";
import {
  DriveApiError,
  downloadDriveFileBlob,
  getDriveFileMetadata,
} from "../google/driveClient.ts";
import { getManifestTotalStemBytes } from "../google/driveManifest.ts";
import {
  type DriveLibraryEntry,
  type DriveRestoreProgress,
  fetchDriveManifestByFileId,
  recomputeAndVerifyLocalStemChecksums,
  restoreSongFromDrive,
} from "../google/driveRestoreManager.ts";
import { validateAndPrepareResume } from "../separation/separationResumeController.ts";
import { isValidationCompleted } from "../separation/separationStateRecovery.ts";
import type { ImportedStemRecord } from "../storage/importedStemStore.ts";
import {
  addImportedStemReference,
  findImportedStemCandidatesBySpec,
  validateImportedStemIntegrity,
} from "../storage/importedStemStore.ts";
import { idbPut } from "../storage/indexedDb.ts";
import { hashSourceAudio } from "../storage/separationCache.ts";
import {
  addCheckpointReference,
  findCompletedCheckpointBySourceAudioHash,
  type SeparationCheckpoint,
} from "../storage/separationCheckpointStore.ts";
import { DEMUCS_STRIDE_SAMPLES } from "../storage/separationChunkStore.ts";
import { getPersistedAudioBlobByKey } from "../storage/songSessionStore.ts";
import { isArtifactRefStrictlyCompatible, projectEntryToBandSong } from "./projectModel.ts";
import type {
  ArtifactCompatibilityStatus,
  BandProject,
  ProjectSongAvailabilityState,
  ProjectSongEntry,
} from "./projectTypes.ts";

export interface EvaluatedProjectSongAvailability {
  entryId: string;
  availabilityState: ProjectSongAvailabilityState;
  localOriginalAvailable: boolean;
  localStemsAvailable: boolean;
  verificationStatus?: ArtifactCompatibilityStatus;
  recomputeCandidateCheckpoint?: SeparationCheckpoint | null;
  recomputeCandidateImportedStem?: ImportedStemRecord | null;
  localTaskId: string | null;
  localSourceType: "demucs_checkpoint" | "imported_stem" | null;
  importedStemRecord: ImportedStemRecord | null;
  totalChunks?: number;
  committedBytes?: number;
  missingReason?: string;
}

/**
 * 僅檢視本機 IndexedDB Metadata 評估專案每首歌的可用性（不解碼 AudioBuffer、不下載 WAV、不執行 Demucs）。
 * 若正式雲端版本僅找到缺乏 Checksum 證明的本機舊資料（insufficient_evidence），絕不偽報 localStemsAvailable=true。
 */
export async function evaluateProjectSongsAvailability(
  project: BandProject,
  options?: {
    currentAccountId?: string | null;
    hasValidGoogleToken?: boolean;
  },
): Promise<Map<string, EvaluatedProjectSongAvailability>> {
  const result = new Map<string, EvaluatedProjectSongAvailability>();

  for (const entry of project.songs) {
    const hasLocalOriginal = Boolean(
      entry.sourceAudioHash &&
        (await getPersistedAudioBlobByKey(entry.sourceAudioHash).catch(() => null)),
    );

    let localStemsAvailable = false;
    let verificationStatus: ArtifactCompatibilityStatus | undefined;
    let recomputeCandidateCheckpoint: SeparationCheckpoint | null = null;
    let recomputeCandidateImportedStem: ImportedStemRecord | null = null;
    let missingReason: string | undefined;
    let localTaskId: string | null = null;
    let localSourceType: "demucs_checkpoint" | "imported_stem" | null = null;
    let importedStemRecord: ImportedStemRecord | null = null;
    let totalChunks: number | undefined;
    let committedBytes: number | undefined;

    if (entry.artifactRef) {
      const ref = entry.artifactRef;
      const requireExact = !ref.revisionId.startsWith("local-");
      const cp = await findCompletedCheckpointBySourceAudioHash(ref.sourceAudioHash, {
        modelVersion: ref.modelVersion,
        processingVersion: ref.processingVersion,
      }).catch(() => null);

      if (cp) {
        const cpChecksums =
          cp.exportedChecksumsByRevision?.[ref.revisionId] ??
          (ref.derivedFrom?.sourceRevisionId
            ? cp.exportedChecksumsByRevision?.[ref.derivedFrom.sourceRevisionId]
            : undefined);
        const compat = isArtifactRefStrictlyCompatible(
          ref,
          {
            sourceAudioHash: cp.sourceAudioHash,
            separationMode: cp.requestedMode,
            modelVersion: cp.modelVersion,
            processingVersion: cp.processingVersion,
            sampleRate: cp.sampleRate,
            channelCount: 2,
            totalSamples: cp.totalSamples,
            exportedRevisionIds: cp.exportedRevisionIds,
            checksumsByRole: cpChecksums,
          },
          { requireExactRevision: requireExact },
        );
        verificationStatus = compat.status;
        if (compat.status === "verified") {
          const check = await validateAndPrepareResume(cp.taskId, {
            sourceAudioAvailable: true,
            sourceAudioHash: cp.sourceAudioHash,
            totalSamples: cp.totalSamples,
            sampleRate: cp.sampleRate,
          }).catch(() => null);
          if (isValidationCompleted(check)) {
            localStemsAvailable = true;
            localTaskId = cp.taskId;
            localSourceType = "demucs_checkpoint";
            totalChunks = cp.totalChunks;
            committedBytes = cp.committedBytes;
          }
        } else if (compat.status === "insufficient_evidence") {
          const check = await validateAndPrepareResume(cp.taskId, {
            sourceAudioAvailable: true,
            sourceAudioHash: cp.sourceAudioHash,
            totalSamples: cp.totalSamples,
            sampleRate: cp.sampleRate,
          }).catch(() => null);
          if (isValidationCompleted(check)) {
            recomputeCandidateCheckpoint = cp;
            missingReason = compat.reason;
          }
        } else {
          missingReason = compat.reason;
        }
      }

      if (!localStemsAvailable) {
        const candidates = await findImportedStemCandidatesBySpec({
          sourceAudioHash: ref.sourceAudioHash,
          mode: ref.separationMode,
          modelVersion: ref.modelVersion,
          processingVersion: ref.processingVersion,
          sampleRate: ref.sampleRate,
          channelCount: ref.channelCount,
          totalSamples: ref.totalSamples,
          expectedRevisionId: ref.revisionId,
          expectedChecksums: ref.artifactChecksums,
          expectedDerivedFrom: ref.derivedFrom ?? null,
        }).catch(() => []);

        for (const cand of candidates) {
          const impValid = await validateImportedStemIntegrity(cand.record.importId).catch(() => ({
            valid: false,
            record: null,
          }));
          if (!impValid.valid || !impValid.record) continue;

          if (cand.compatibility.status === "verified") {
            localStemsAvailable = true;
            verificationStatus = "verified";
            localTaskId = impValid.record.importId;
            localSourceType = "imported_stem";
            importedStemRecord = impValid.record;
            totalChunks = impValid.record.totalChunks;
            committedBytes = impValid.record.committedBytes;
            missingReason = undefined;
            break;
          }
          if (
            cand.compatibility.status === "insufficient_evidence" &&
            !recomputeCandidateImportedStem
          ) {
            recomputeCandidateImportedStem = impValid.record;
            verificationStatus = "insufficient_evidence";
            missingReason = cand.compatibility.reason;
          }
        }
      }
    }

    const canDownloadOriginalFromDrive = Boolean(
      entry.originalBackup?.driveFileId ||
        (entry.source.provider === "google_drive" && entry.source.fileId),
    );
    const canDownloadStemsFromDrive = Boolean(entry.artifactRef?.manifestFileId);
    const hasAuthForCloud = Boolean(
      options?.currentAccountId &&
        options?.hasValidGoogleToken &&
        (!project.ownerAccountId || project.ownerAccountId === options.currentAccountId),
    );

    let availabilityState: ProjectSongAvailabilityState;
    if (localStemsAvailable) {
      availabilityState = "stems_loaded";
    } else if (hasLocalOriginal && !entry.artifactRef) {
      availabilityState = "local_playable";
    } else if (hasLocalOriginal && entry.artifactRef && !canDownloadStemsFromDrive && verificationStatus !== "insufficient_evidence") {
      availabilityState = "local_playable";
    } else if (canDownloadStemsFromDrive || (!hasLocalOriginal && canDownloadOriginalFromDrive)) {
      availabilityState = hasAuthForCloud ? "cloud_not_downloaded" : "needs_reauth";
    } else if (entry.artifactRef && !localStemsAvailable) {
      availabilityState = "stems_missing";
    } else {
      availabilityState = "original_missing";
    }

    result.set(entry.entryId, {
      entryId: entry.entryId,
      availabilityState,
      localOriginalAvailable: hasLocalOriginal,
      localStemsAvailable,
      verificationStatus,
      recomputeCandidateCheckpoint,
      recomputeCandidateImportedStem,
      localTaskId,
      localSourceType,
      importedStemRecord,
      totalChunks,
      committedBytes,
      missingReason,
    });
  }

  return result;
}

export async function projectToBandSongsMetadataOnly(
  project: BandProject,
  options?: {
    currentAccountId?: string | null;
    hasValidGoogleToken?: boolean;
  },
): Promise<BandSong[]> {
  const availabilityMap = await evaluateProjectSongsAvailability(project, options);
  const sortedEntries = project.songs.slice().sort((a, b) => a.order - b.order);

  return sortedEntries.map((entry) => {
    const avail = availabilityMap.get(entry.entryId);
    const imp = avail?.importedStemRecord ?? null;
    const bandSong = projectEntryToBandSong(entry, {
      projectId: project.projectId,
      ownerAccountId: project.ownerAccountId,
      availabilityState: avail?.availabilityState,
      sourceAudioMissing: !avail?.localOriginalAvailable,
      audioLoadState: "unloaded",
      localTaskId: avail?.localTaskId ?? null,
      localStemsReady: Boolean(avail?.localStemsAvailable),
      totalChunks: avail?.totalChunks,
      committedBytes: avail?.committedBytes,
      importedStemOrigin: imp
        ? {
            importId: imp.importId,
            ownerAccountId: imp.ownerAccountId,
            revisionId: imp.revisionId,
            manifestFileId: imp.manifestFileId,
            pcmFormat: imp.pcmFormat,
            stemLayout: imp.stemLayout,
            importedAt: imp.updatedAt,
          }
        : null,
      persistenceMessage:
        avail?.availabilityState === "cloud_not_downloaded"
          ? "已備份於雲端，點擊播放時按需下載"
          : avail?.availabilityState === "needs_reauth"
            ? "需重新登入授權以下載雲端音訊"
            : avail?.availabilityState === "stems_loaded"
              ? "本機分軌已就緒（待按需載入播放）"
              : avail?.availabilityState === "local_playable"
                ? "本機原曲已就緒（延遲解碼）"
                : "缺少本機原始音訊",
    });
    return bandSong;
  });
}

export interface ProjectOfflineAssessment {
  songsToDownloadCount: number;
  alreadyLocalCount: number;
  unavailableCount: number;
  estimatedDownloadBytes: number;
  estimatedStorageBytes: number;
  storageRemainingBytes: number | null;
  hasEnoughStorage: boolean;
  perSongDetails: Array<{
    entryId: string;
    displayName: string;
    needsOriginal: boolean;
    needsStems: boolean;
    estimatedBytes: number;
    unavailableReason?: string;
  }>;
  warnings: string[];
}

/**
 * 離線下載整個專案前資源評估（僅查詢 metadata 與剩餘空間，不下載 WAV）。
 */
export async function assessProjectOfflineDownload(params: {
  project: BandProject;
  accountId: string;
  accessToken: string;
  capabilities?: DeviceCapabilitiesSnapshot | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProjectOfflineAssessment> {
  const availMap = await evaluateProjectSongsAvailability(params.project, {
    currentAccountId: params.accountId,
    hasValidGoogleToken: true,
  });

  const cap = params.capabilities ?? (await collectDeviceCapabilities());
  let estimatedDownloadBytes = 0;
  let estimatedStorageBytes = 0;
  let songsToDownloadCount = 0;
  let alreadyLocalCount = 0;
  let unavailableCount = 0;
  const warnings: string[] = [];
  const perSongDetails: ProjectOfflineAssessment["perSongDetails"] = [];

  for (const entry of params.project.songs) {
    const avail = availMap.get(entry.entryId);
    const hasOrigBackup = Boolean(
      entry.originalBackup?.driveFileId ||
        (entry.source.provider === "google_drive" && entry.source.fileId),
    );
    const needsOriginal = !avail?.localOriginalAvailable && hasOrigBackup;
    const needsStems = Boolean(
      entry.artifactRef?.manifestFileId && !avail?.localStemsAvailable,
    );

    if (!needsOriginal && !needsStems) {
      if (avail?.localOriginalAvailable || avail?.localStemsAvailable) {
        alreadyLocalCount += 1;
      } else {
        unavailableCount += 1;
        perSongDetails.push({
          entryId: entry.entryId,
          displayName: entry.displayName,
          needsOriginal: false,
          needsStems: false,
          estimatedBytes: 0,
          unavailableReason: "僅存在舊裝置本機，尚未備份至 Google Drive",
        });
      }
      continue;
    }

    let songBytes = 0;
    let songStorageBytes = 0;
    if (needsOriginal) {
      const origSize =
        entry.originalBackup?.sizeBytes ??
        (entry.source.provider === "google_drive" ? entry.source.sizeBytes : undefined) ??
        entry.sizeBytes ??
        0;
      songBytes += origSize;
      songStorageBytes += origSize;
    }

    if (needsStems && entry.artifactRef?.manifestFileId) {
      try {
        const manifestEntry = await fetchDriveManifestByFileId({
          manifestFileId: entry.artifactRef.manifestFileId,
          expectedAccountId: params.accountId,
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
        const stemBytes = getManifestTotalStemBytes(manifestEntry.manifest);
        songBytes += stemBytes;
        songStorageBytes +=
          stemBytes +
          manifestEntry.manifest.separation.totalSamples * 4 * 2 * Float32Array.BYTES_PER_ELEMENT;
      } catch (err) {
        warnings.push(
          `無法評估「${entry.displayName}」的分軌大小：${err instanceof Error ? err.message : "讀取失敗"}`,
        );
      }
    }

    songsToDownloadCount += 1;
    estimatedDownloadBytes += songBytes;
    estimatedStorageBytes += songStorageBytes;
    perSongDetails.push({
      entryId: entry.entryId,
      displayName: entry.displayName,
      needsOriginal,
      needsStems,
      estimatedBytes: songBytes,
    });
  }

  const remaining = cap.storageRemainingBytes ?? null;
  const hasEnoughStorage =
    remaining === null ? true : estimatedStorageBytes <= remaining * 0.9;
  if (!hasEnoughStorage && remaining !== null) {
    warnings.push(
      `預估寫入容量（${(estimatedStorageBytes / (1024 * 1024)).toFixed(1)} MiB）接近或超過瀏覽器剩餘空間（${(remaining / (1024 * 1024)).toFixed(1)} MiB）。`,
    );
  }

  return {
    songsToDownloadCount,
    alreadyLocalCount,
    unavailableCount,
    estimatedDownloadBytes,
    estimatedStorageBytes,
    storageRemainingBytes: remaining,
    hasEnoughStorage,
    perSongDetails,
    warnings,
  };
}

export interface OnDemandSongRestoreResult {
  song: BandSong;
  reusedLocal: boolean;
  restoredStems: boolean;
  restoredOriginal: boolean;
  importedStemRecord: ImportedStemRecord | null;
  checkpointTaskId: string | null;
  originalAudioWarning?: string;
}

/**
 * 按需恢復專案內單首歌曲（點擊播放尚未下載的歌曲時觸發）：
 * 1. 先檢查本機 IndexedDB（有嚴格相符之分軌或原曲即零下載）；
 * 2. 若需分軌且雲端有指定 Manifest/Revision，僅下載該曲缺少之分軌 WAV；
 * 3. 若需原曲且雲端有原曲（originalBackup 或 Drive source），下載並驗證 sourceAudioHash 後存至 audioFiles；
 * 4. 絕不重跑 Demucs，絕不下載同一專案其他歌曲。
 */
export async function restoreSingleProjectSongOnDemand(params: {
  project: BandProject;
  entry: ProjectSongEntry;
  accountId: string | null;
  accessToken: string | null;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  includeOriginalAudio?: boolean;
  capabilities?: DeviceCapabilitiesSnapshot | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DriveRestoreProgress) => void;
}): Promise<OnDemandSongRestoreResult> {
  const { project, entry } = params;

  params.onProgress?.({
    stage: "checking_local",
    message: `正在檢查「${entry.displayName}」本機音訊與分軌版本…`,
  });

  const availMap = await evaluateProjectSongsAvailability(
    { ...project, songs: [entry] },
    {
      currentAccountId: params.accountId,
      hasValidGoogleToken: Boolean(params.accountId && params.accessToken),
    },
  );
  const avail = availMap.get(entry.entryId)!;

  let importedStemRecord = avail.importedStemRecord;
  let checkpointTaskId =
    avail.localSourceType === "demucs_checkpoint" ? avail.localTaskId : null;
  let restoredOriginal = avail.localOriginalAvailable;
  let restoredStems = avail.localStemsAvailable;
  let reusedLocal = true;
  let originalAudioWarning: string | undefined;

  // 若本地僅有缺乏 checksum 證明的舊版分軌且專案已記錄完整 artifactChecksums + pcmFormat，先串流重算驗證
  if (
    !restoredStems &&
    entry.artifactRef &&
    entry.artifactRef.artifactChecksums &&
    Object.keys(entry.artifactRef.artifactChecksums).length > 0 &&
    entry.artifactRef.pcmFormat
  ) {
    const ref = entry.artifactRef;
    const targetPcmFormat = entry.artifactRef.pcmFormat;
    const requireExact = !ref.revisionId.startsWith("local-");
    if (avail.recomputeCandidateImportedStem) {
      const impCand = avail.recomputeCandidateImportedStem;
      if (impCand.pcmFormat === targetPcmFormat) {
        params.onProgress?.({
          stage: "validating",
          message: `正在重新驗證「${entry.displayName}」本機分軌 Checksum…`,
        });
        const recomputeRes = await recomputeAndVerifyLocalStemChecksums({
          taskId: impCand.importId,
          sourceType: "imported_stem",
          stemLayout: impCand.stemLayout,
          pcmFormat: impCand.pcmFormat,
          strideSamples: impCand.strideSamples,
          expectedRef: ref,
          candidateMetadata: {
            sourceAudioHash: impCand.sourceAudioHash,
            separationMode: impCand.requestedMode,
            modelVersion: impCand.modelVersion,
            processingVersion: impCand.processingVersion,
            sampleRate: impCand.sampleRate,
            channelCount: impCand.channelCount,
            totalSamples: impCand.totalSamples,
            revisionId: impCand.revisionId,
            derivedFrom: impCand.derivedFrom ?? null,
          },
          existingChecksums: impCand.checksumsByRole,
          requireExactRevision: requireExact,
          signal: params.signal,
        });
        if (recomputeRes.verified) {
          importedStemRecord = {
            ...impCand,
            checksumsByRole: { ...impCand.checksumsByRole, ...recomputeRes.checksumsByRole },
          };
          restoredStems = true;
        }
      }
    } else if (avail.recomputeCandidateCheckpoint) {
      const cpCand = avail.recomputeCandidateCheckpoint;
      params.onProgress?.({
        stage: "validating",
        message: `正在重新驗證「${entry.displayName}」本機分段 Checksum…`,
      });
      const recomputeRes = await recomputeAndVerifyLocalStemChecksums({
        taskId: cpCand.taskId,
        sourceType: "demucs_checkpoint",
        stemLayout: "four_stem",
        pcmFormat: targetPcmFormat,
        totalChunks: cpCand.totalChunks,
        strideSamples: cpCand.strideSamples,
        expectedRef: ref,
        candidateMetadata: {
          sourceAudioHash: cpCand.sourceAudioHash,
          separationMode: cpCand.requestedMode,
          modelVersion: cpCand.modelVersion,
          processingVersion: cpCand.processingVersion,
          sampleRate: cpCand.sampleRate,
          channelCount: 2,
          totalSamples: cpCand.totalSamples,
          exportedRevisionIds: cpCand.exportedRevisionIds,
        },
        requireExactRevision: requireExact,
        signal: params.signal,
      });
      if (recomputeRes.verified) {
        checkpointTaskId = cpCand.taskId;
        restoredStems = true;
      }
    }
  }

  const needStemsFromCloud = Boolean(
    entry.artifactRef?.manifestFileId && !restoredStems,
  );
  const originalDriveFileId =
    entry.originalBackup?.driveFileId ||
    (entry.source.provider === "google_drive" ? entry.source.fileId : undefined);
  const needOriginalFromCloud = Boolean(
    !avail.localOriginalAvailable &&
      originalDriveFileId &&
      (params.includeOriginalAudio ||
        entry.settings.playbackSource === "original" ||
        !entry.artifactRef),
  );

  if (
    !needStemsFromCloud &&
    !restoredStems &&
    entry.artifactRef &&
    avail.verificationStatus === "insufficient_evidence"
  ) {
    throw new Error(
      `無法驗證「${entry.displayName}」本機分軌完整性（${avail.missingReason ?? "缺少 Checksum 證明"}），且目前無可用的雲端 Manifest 可供重新下載。`,
    );
  }

  if (needStemsFromCloud || needOriginalFromCloud) {
    if (!params.accountId || !params.accessToken) {
      throw new Error("需要登入 Google 並重新授權才能下載雲端備份的音訊或分軌。");
    }
    if (!params.isGenerationValid(params.generation, params.accountId)) {
      throw new Error("Google 帳戶工作階段已變更，請重新授權後再試。");
    }
  }

  if (needStemsFromCloud && entry.artifactRef?.manifestFileId && params.accountId && params.accessToken) {
    reusedLocal = false;
    const manifestEntry: DriveLibraryEntry = await fetchDriveManifestByFileId({
      manifestFileId: entry.artifactRef.manifestFileId,
      expectedAccountId: params.accountId,
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });

    const restored = await restoreSongFromDrive({
      entry: manifestEntry,
      accountId: params.accountId,
      accessToken: params.accessToken,
      generation: params.generation,
      isGenerationValid: params.isGenerationValid,
      includeOriginalAudio: needOriginalFromCloud,
      originalBackupDriveFileId: needOriginalFromCloud ? originalDriveFileId : undefined,
      expectedRevisionId: entry.artifactRef.revisionId,
      strictRevisionMatch: true,
      projectSettingsOverride: entry.settings,
      skipLegacySessionSongSave: true,
      capabilities: params.capabilities,
      songIdOverride: entry.entryId,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      onProgress: params.onProgress,
    });

    if (
      entry.artifactRef.artifactChecksums &&
      restored.importedStemRecord &&
      entry.artifactRef.revisionId === manifestEntry.manifest.revisionId
    ) {
      const postCheck = isArtifactRefStrictlyCompatible(
        entry.artifactRef,
        {
          sourceAudioHash: restored.importedStemRecord.sourceAudioHash,
          separationMode: restored.importedStemRecord.requestedMode,
          modelVersion: restored.importedStemRecord.modelVersion,
          processingVersion: restored.importedStemRecord.processingVersion,
          sampleRate: restored.importedStemRecord.sampleRate,
          channelCount: restored.importedStemRecord.channelCount,
          totalSamples: restored.importedStemRecord.totalSamples,
          revisionId: restored.importedStemRecord.revisionId,
          checksumsByRole: restored.importedStemRecord.checksumsByRole,
          derivedFrom: restored.importedStemRecord.derivedFrom ?? null,
        },
        { requireExactRevision: !entry.artifactRef.revisionId.startsWith("local-") },
      );
      if (!postCheck.compatible) {
        throw new Error(`雲端恢復後的分軌未能通過專案 Checksum 驗證：${postCheck.reason}`);
      }
    }

    importedStemRecord = restored.importedStemRecord;
    checkpointTaskId = restored.checkpointTaskId;
    restoredStems = true;
    restoredOriginal = avail.localOriginalAvailable || restored.restoredOriginalAudio;
    originalAudioWarning = restored.originalAudioWarning;
  } else if (
    needOriginalFromCloud &&
    originalDriveFileId &&
    params.accountId &&
    params.accessToken
  ) {
    reusedLocal = false;
    params.onProgress?.({
      stage: "downloading",
      message: `正在從 Google Drive 下載原曲「${entry.fileName}」…`,
      currentFile: entry.fileName,
    });

    const meta = await getDriveFileMetadata(originalDriveFileId, {
      accessToken: params.accessToken,
      resourceKey:
        entry.source.provider === "google_drive"
          ? entry.source.targetResourceKey ?? entry.source.resourceKey
          : undefined,
      fileName: entry.fileName,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    if (meta.trashed || meta.capabilities?.canDownload === false) {
      throw new DriveApiError(`「${entry.fileName}」無法從 Google Drive 下載（已刪除或無權限）。`, {
        status: 403,
        code: "download_restricted",
        fileName: entry.fileName,
      });
    }
    const downloaded = await downloadDriveFileBlob(
      {
        pickedFileId: originalDriveFileId,
        resolvedFileId: meta.id,
        name: meta.name || entry.fileName,
        mimeType: meta.mimeType || entry.mimeType || "audio/mpeg",
        sizeBytes: meta.size ? Number(meta.size) : entry.sizeBytes ?? null,
        modifiedTime: meta.modifiedTime,
      },
      {
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        onProgress: (loadedBytes, totalBytes) => {
          params.onProgress?.({
            stage: "downloading",
            message: `正在下載原曲 ${entry.fileName}…`,
            currentFile: entry.fileName,
            loadedBytes,
            totalBytes,
          });
        },
      },
    );

    const actualHash = await hashSourceAudio(downloaded.file);
    if (entry.sourceAudioHash && actualHash !== entry.sourceAudioHash) {
      throw new Error(
        `雲端原曲「${entry.fileName}」內容雜湊不符（預期 ${entry.sourceAudioHash.slice(0, 8)}，實際 ${actualHash.slice(0, 8)}），拒絕使用錯誤檔案。`,
      );
    }

    const storeHash = entry.sourceAudioHash || actualHash;
    await idbPut("audioFiles", {
      key: storeHash,
      sourceAudioHash: storeHash,
      blob: downloaded.file,
      fileName: entry.fileName,
      mimeType: entry.mimeType || downloaded.file.type || "",
      sizeBytes: downloaded.file.size,
      lastModified: downloaded.file.lastModified || Date.now(),
      createdAt: Date.now(),
    });
    restoredOriginal = true;
  }

  if (checkpointTaskId) {
    await addCheckpointReference({
      taskId: checkpointTaskId,
      songId: entry.entryId,
      mode: entry.artifactRef?.separationMode,
      source: "projectRestoreManager.onDemand",
    }).catch(() => undefined);
  } else if (importedStemRecord) {
    await addImportedStemReference(importedStemRecord.importId, entry.entryId).catch(
      () => undefined,
    );
  }

  const effectiveTaskId = importedStemRecord?.importId ?? checkpointTaskId ?? null;
  const totalChunks =
    importedStemRecord?.totalChunks ??
    (entry.artifactRef
      ? Math.max(1, Math.ceil(entry.artifactRef.totalSamples / DEMUCS_STRIDE_SAMPLES))
      : avail.totalChunks);

  const song = projectEntryToBandSong(entry, {
    projectId: project.projectId,
    ownerAccountId: project.ownerAccountId,
    availabilityState: restoredStems
      ? "stems_loaded"
      : restoredOriginal
        ? "local_playable"
        : "original_missing",
    sourceAudioMissing: !restoredOriginal,
    audioLoadState: restoredOriginal || restoredStems ? "unloaded" : "error",
    localTaskId: effectiveTaskId,
    localStemsReady: restoredStems && Boolean(effectiveTaskId),
    totalChunks,
    committedBytes: importedStemRecord?.committedBytes ?? avail.committedBytes,
    importedStemOrigin: importedStemRecord
      ? {
          importId: importedStemRecord.importId,
          ownerAccountId: importedStemRecord.ownerAccountId,
          revisionId: importedStemRecord.revisionId,
          manifestFileId: importedStemRecord.manifestFileId,
          pcmFormat: importedStemRecord.pcmFormat,
          stemLayout: importedStemRecord.stemLayout,
          importedAt: importedStemRecord.updatedAt,
        }
      : null,
    persistenceMessage:
      restoredStems && !restoredOriginal
        ? "已按需恢復分軌（無原曲，可直接播放分軌）"
        : "已在本機準備就緒",
  });

  params.onProgress?.({
    stage: "completed",
    message: reusedLocal ? "已直接重用本機資料" : "已完成單曲按需恢復",
  });

  return {
    song,
    reusedLocal,
    restoredStems,
    restoredOriginal,
    importedStemRecord,
    checkpointTaskId,
    originalAudioWarning,
  };
}

export interface ProjectOfflineDownloadProgress {
  completedSongs: number;
  totalSongs: number;
  currentSongName: string;
  stageMessage: string;
  failedSongs: Array<{ entryId: string; displayName: string; reason: string }>;
}

/**
 * 逐首、逐軌順序下載整個專案供離線使用，絕不一次配置全部歌曲 PCM；支援取消並保留已完成項目。
 */
export async function downloadEntireProjectOffline(params: {
  project: BandProject;
  accountId: string;
  accessToken: string;
  generation: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  includeOriginalAudio?: boolean;
  capabilities?: DeviceCapabilitiesSnapshot | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: ProjectOfflineDownloadProgress) => void;
}): Promise<{
  completedCount: number;
  reusedCount: number;
  failedSongs: Array<{ entryId: string; displayName: string; reason: string }>;
  cancelled: boolean;
}> {
  const sorted = params.project.songs.slice().sort((a, b) => a.order - b.order);
  const failedSongs: Array<{ entryId: string; displayName: string; reason: string }> = [];
  let completedCount = 0;
  let reusedCount = 0;
  let cancelled = false;

  for (let i = 0; i < sorted.length; i += 1) {
    if (params.signal?.aborted || !params.isGenerationValid(params.generation, params.accountId)) {
      cancelled = true;
      break;
    }
    const entry = sorted[i];
    params.onProgress?.({
      completedSongs: i,
      totalSongs: sorted.length,
      currentSongName: entry.displayName,
      stageMessage: `正在檢查與準備 (${i + 1}/${sorted.length})：${entry.displayName}`,
      failedSongs: [...failedSongs],
    });
    if (params.signal?.aborted) {
      cancelled = true;
      break;
    }

    try {
      const res = await restoreSingleProjectSongOnDemand({
        project: params.project,
        entry,
        accountId: params.accountId,
        accessToken: params.accessToken,
        generation: params.generation,
        isGenerationValid: params.isGenerationValid,
        includeOriginalAudio: params.includeOriginalAudio ?? true,
        capabilities: params.capabilities,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        onProgress: (sub) => {
          params.onProgress?.({
            completedSongs: i,
            totalSongs: sorted.length,
            currentSongName: entry.displayName,
            stageMessage: `${entry.displayName}：${sub.message}`,
            failedSongs: [...failedSongs],
          });
        },
      });
      completedCount += 1;
      if (res.reusedLocal) reusedCount += 1;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        cancelled = true;
        break;
      }
      failedSongs.push({
        entryId: entry.entryId,
        displayName: entry.displayName,
        reason: err instanceof Error ? err.message : "下載失敗",
      });
    }
  }

  return {
    completedCount,
    reusedCount,
    failedSongs,
    cancelled,
  };
}
