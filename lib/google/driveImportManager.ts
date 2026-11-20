import {
  selectDeviceResourceProfile,
  type DeviceCapabilitiesSnapshot,
  type DeviceResourceProfile,
} from "../band/resourceGuard.ts";
import {
  DriveApiError,
  downloadDriveFileBlob,
  resolveDriveFileForDownload,
} from "./driveClient.ts";
import type { PickedDriveFile } from "./googleDrivePicker.ts";
import type {
  DriveImportBatchAssessment,
  DriveImportFailure,
  DriveImportProgress,
  VerifiedDriveFileMetadata,
} from "./driveTransferTypes.ts";

const BYTES_PER_MIB = 1024 * 1024;
export const DEFAULT_UNKNOWN_SIZE_ESTIMATE_BYTES = 40 * BYTES_PER_MIB;
export const DEFAULT_UNKNOWN_SIZE_DOWNLOAD_LIMIT_BYTES = 150 * BYTES_PER_MIB;
export const DEFAULT_CONSTRAINED_MAX_SINGLE_FILE_BYTES = 250 * BYTES_PER_MIB;
export const DEFAULT_DESKTOP_MAX_SINGLE_FILE_BYTES = 500 * BYTES_PER_MIB;

export interface DriveBatchInspectionResult {
  readyFiles: VerifiedDriveFileMetadata[];
  failedFiles: DriveImportFailure[];
  authExpired: boolean;
}

export async function inspectPickedDriveFiles(
  pickedFiles: readonly PickedDriveFile[],
  options: {
    accessToken: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onInspectingFile?: (index: number, total: number, file: PickedDriveFile) => void;
  },
): Promise<DriveBatchInspectionResult> {
  const readyFiles: VerifiedDriveFileMetadata[] = [];
  const failedFiles: DriveImportFailure[] = [];
  let authExpired = false;

  for (let i = 0; i < pickedFiles.length; i += 1) {
    if (options.signal?.aborted) {
      break;
    }
    const picked = pickedFiles[i];
    options.onInspectingFile?.(i, pickedFiles.length, picked);
    try {
      const verified = await resolveDriveFileForDownload(picked, {
        accessToken: options.accessToken,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      });
      readyFiles.push(verified);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        break;
      }
      if (err instanceof DriveApiError) {
        if (err.code === "unauthorized") {
          authExpired = true;
          failedFiles.push({
            fileId: picked.id,
            fileName: picked.name,
            code: err.code,
            reason: err.message,
          });
          break;
        }
        failedFiles.push({
          fileId: picked.id,
          fileName: err.fileName || picked.name,
          code: err.code,
          reason: err.message,
        });
      } else {
        failedFiles.push({
          fileId: picked.id,
          fileName: picked.name,
          code: "network",
          reason: err instanceof Error ? err.message : `無法讀取「${picked.name}」的檔案資訊。`,
        });
      }
    }
  }

  return { readyFiles, failedFiles, authExpired };
}

export function assessDriveImportBatch(
  files: readonly VerifiedDriveFileMetadata[],
  capabilities: DeviceCapabilitiesSnapshot,
  options?: {
    profile?: DeviceResourceProfile;
    separationFocusActive?: boolean;
  },
): DriveImportBatchAssessment {
  const profile =
    options?.profile ?? selectDeviceResourceProfile({ capabilities });
  const reasons: string[] = [];

  if (options?.separationFocusActive) {
    return {
      allowed: false,
      hardBlocked: true,
      requiresConfirmation: true,
      knownTotalBytes: 0,
      estimatedTotalBytes: 0,
      unknownSizeCount: 0,
      perFileConservativeLimitBytes: DEFAULT_UNKNOWN_SIZE_DOWNLOAD_LIMIT_BYTES,
      reasons: [
        "目前正處於分離專注模式，已暫停雲端音檔下載與解碼，請待分離完成或中止後再試。",
      ],
    };
  }

  let knownTotalBytes = 0;
  let unknownSizeCount = 0;
  let largestKnownBytes = 0;

  for (const file of files) {
    if (typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0) {
      knownTotalBytes += file.sizeBytes;
      if (file.sizeBytes > largestKnownBytes) largestKnownBytes = file.sizeBytes;
    } else {
      unknownSizeCount += 1;
    }
  }

  // 缺少檔案大小時絕不視為 0 bytes，改以保守估值與串流位元組上限保護
  const estimatedTotalBytes =
    knownTotalBytes + unknownSizeCount * DEFAULT_UNKNOWN_SIZE_ESTIMATE_BYTES;

  const isConstrained =
    profile.tier === "constrained" ||
    profile.formFactorHint === "mobile" ||
    profile.formFactorHint === "tablet";
  const singleFileHardLimit = isConstrained
    ? DEFAULT_CONSTRAINED_MAX_SINGLE_FILE_BYTES
    : DEFAULT_DESKTOP_MAX_SINGLE_FILE_BYTES;
  const perFileConservativeLimitBytes = isConstrained
    ? Math.min(DEFAULT_UNKNOWN_SIZE_DOWNLOAD_LIMIT_BYTES, singleFileHardLimit)
    : DEFAULT_UNKNOWN_SIZE_DOWNLOAD_LIMIT_BYTES;

  let hardBlocked = false;
  let requiresConfirmation = false;

  if (largestKnownBytes > singleFileHardLimit) {
    hardBlocked = true;
    reasons.push(
      `單一檔案大小（${(largestKnownBytes / BYTES_PER_MIB).toFixed(1)} MiB）超過目前 ${profile.tier} 裝置允許上限（${(singleFileHardLimit / BYTES_PER_MIB).toFixed(0)} MiB）。`,
    );
  }

  // 估算寫入 IndexedDB 加上首首解碼暫存需要空間
  const projectedStorageNeeded = Math.round(estimatedTotalBytes * 1.15);
  if (
    capabilities.storageRemainingBytes !== null &&
    projectedStorageNeeded > capabilities.storageRemainingBytes * 0.9
  ) {
    hardBlocked = true;
    reasons.push(
      `選取音檔預估需要約 ${(projectedStorageNeeded / BYTES_PER_MIB).toFixed(1)} MiB 本機空間，已接近或超出瀏覽器剩餘可用容量（${(capabilities.storageRemainingBytes / BYTES_PER_MIB).toFixed(1)} MiB）。`,
    );
  } else if (
    capabilities.storageRemainingBytes !== null &&
    projectedStorageNeeded > capabilities.storageRemainingBytes * 0.5
  ) {
    requiresConfirmation = true;
    reasons.push(
      `選取音檔預計佔用 ${(projectedStorageNeeded / BYTES_PER_MIB).toFixed(1)} MiB，將耗用超過一半剩餘本機空間。`,
    );
  }

  const confirmSingleThreshold = isConstrained ? 20 * BYTES_PER_MIB : 40 * BYTES_PER_MIB;
  const confirmBatchThreshold = isConstrained ? 25 * BYTES_PER_MIB : 50 * BYTES_PER_MIB;

  if (largestKnownBytes >= confirmSingleThreshold || estimatedTotalBytes >= confirmBatchThreshold) {
    requiresConfirmation = true;
    reasons.push(
      `本次將自 Google Drive 逐首下載 ${files.length} 個音檔（預估約 ${(estimatedTotalBytes / BYTES_PER_MIB).toFixed(1)} MiB），下載後直接存入本機 IndexedDB。`,
    );
  }

  if (unknownSizeCount > 0) {
    requiresConfirmation = true;
    reasons.push(
      `其中 ${unknownSizeCount} 個檔案未提供明確檔案大小，將啟用串流位元組監測（單檔保守上限 ${(perFileConservativeLimitBytes / BYTES_PER_MIB).toFixed(0)} MiB）。`,
    );
  }

  if (files.length > 1 && isConstrained) {
    reasons.push("為保護行動裝置記憶體，將以 concurrency = 1 逐首下載並立即持久化，不會一次下載全部檔案。");
  }

  return {
    allowed: !hardBlocked,
    hardBlocked,
    requiresConfirmation: hardBlocked || requiresConfirmation,
    knownTotalBytes,
    estimatedTotalBytes,
    unknownSizeCount,
    perFileConservativeLimitBytes,
    reasons:
      reasons.length > 0
        ? reasons
        : ["雲端音檔規模與裝置空間檢查通過。"],
  };
}

export interface SequentialDriveImportResult {
  importedCount: number;
  failures: DriveImportFailure[];
  cancelled: boolean;
  authExpired: boolean;
}

/**
 * 嚴格以 concurrency = 1 逐首下載、單首持久化後立即釋放參照，絕不同時把全部雲端音檔拉入 JS Heap。
 */
export async function executeSequentialDriveImport(
  files: readonly VerifiedDriveFileMetadata[],
  options: {
    accessToken: string;
    accountId: string;
    generation: number;
    isGenerationValid: (generation: number, accountId: string) => boolean;
    onAuthExpired?: () => void;
    perFileConservativeLimitBytes?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onProgress?: (progress: DriveImportProgress) => void;
    onFileDownloaded: (
      file: File,
      metadata: VerifiedDriveFileMetadata,
      context: { index: number; total: number },
    ) => Promise<void>;
  },
): Promise<SequentialDriveImportResult> {
  const failures: DriveImportFailure[] = [];
  let importedCount = 0;
  let cancelled = false;
  let authExpired = false;

  for (let index = 0; index < files.length; index += 1) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (!options.isGenerationValid(options.generation, options.accountId)) {
      cancelled = true;
      break;
    }

    const meta = files[index];
    const maxBytes =
      meta.sizeBytes === null
        ? (options.perFileConservativeLimitBytes ?? DEFAULT_UNKNOWN_SIZE_DOWNLOAD_LIMIT_BYTES)
        : undefined;

    options.onProgress?.({
      stage: "downloading",
      fileIndex: index,
      totalFiles: files.length,
      fileName: meta.name,
      loadedBytes: 0,
      totalBytes: meta.sizeBytes,
      completedCount: importedCount,
      failedCount: failures.length,
    });

    try {
      let downloaded: File | null = (
        await downloadDriveFileBlob(meta, {
          accessToken: options.accessToken,
          maxBytes,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
          onProgress: (loadedBytes, totalBytes) => {
            options.onProgress?.({
              stage: "downloading",
              fileIndex: index,
              totalFiles: files.length,
              fileName: meta.name,
              loadedBytes,
              totalBytes,
              completedCount: importedCount,
              failedCount: failures.length,
            });
          },
        })
      ).file;

      if (
        options.signal?.aborted ||
        !options.isGenerationValid(options.generation, options.accountId)
      ) {
        downloaded = null;
        cancelled = true;
        break;
      }

      options.onProgress?.({
        stage: "persisting",
        fileIndex: index,
        totalFiles: files.length,
        fileName: meta.name,
        loadedBytes: downloaded.size,
        totalBytes: downloaded.size,
        completedCount: importedCount,
        failedCount: failures.length,
      });

      await options.onFileDownloaded(downloaded, meta, {
        index,
        total: files.length,
      });
      // 持久化交接後立即解除區域檔案參照，避免大檔持續累積於迴圈 closure
      downloaded = null;
      importedCount += 1;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        cancelled = true;
        break;
      }
      if (err instanceof DriveApiError && err.code === "unauthorized") {
        authExpired = true;
        options.onAuthExpired?.();
        failures.push({
          fileId: meta.pickedFileId,
          fileName: meta.name,
          code: err.code,
          reason: err.message,
        });
        break;
      }
      failures.push({
        fileId: meta.pickedFileId,
        fileName: meta.name,
        code: err instanceof DriveApiError ? err.code : "download_failed",
        reason:
          err instanceof Error
            ? err.message
            : `從 Google Drive 下載「${meta.name}」時發生錯誤。`,
      });
    }
  }

  return {
    importedCount,
    failures,
    cancelled,
    authExpired,
  };
}
