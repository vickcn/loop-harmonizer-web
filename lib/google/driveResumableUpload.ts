import { sharedNetworkBudgetLedger } from "../band/networkBudgetGuard.ts";
import { saveDriveTransferJob } from "../storage/driveTransferStore.ts";
import { DriveApiError, listDriveFiles, mapResponseToDriveError } from "./driveClient.ts";
import { LOOP_HARMONIZER_APP_TAG } from "./driveFolderManager.ts";
import type { DriveArtifactRole, DriveTransferJob } from "./driveTransferTypes.ts";

/** Google Drive Resumable Upload 規定：非最後一塊的大小必須是 256 KiB 的整數倍。 */
export const DRIVE_RESUMABLE_CHUNK_ALIGNMENT = 256 * 1024; // 262,144 bytes
export const DEFAULT_DESKTOP_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB (16 * 256 KiB)
export const DEFAULT_CONSTRAINED_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB (8 * 256 KiB)

export interface UploadByteSource {
  readonly totalBytes: number;
  readSlice(startByte: number, endByte: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * 記憶體內暫存 Resumable Session URI：
 * 屬敏感授權憑證等價端點，絕不寫入 localStorage、IndexedDB、日誌或 Manifest；
 * 帳號登出／切換時一律清除。
 */
const activeSessionUriMap = new Map<
  string,
  { sessionUri: string; ownerAccountId: string; createdAt: number }
>();

export function clearResumableSessionUrisForAccount(accountId?: string): void {
  if (!accountId) {
    activeSessionUriMap.clear();
    return;
  }
  for (const [key, entry] of activeSessionUriMap.entries()) {
    if (entry.ownerAccountId === accountId) {
      activeSessionUriMap.delete(key);
    }
  }
}

export function getActiveResumableSessionCountForTests(): number {
  return activeSessionUriMap.size;
}

export function alignUploadChunkSize(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < DRIVE_RESUMABLE_CHUNK_ALIGNMENT) {
    return DRIVE_RESUMABLE_CHUNK_ALIGNMENT;
  }
  return Math.floor(bytes / DRIVE_RESUMABLE_CHUNK_ALIGNMENT) * DRIVE_RESUMABLE_CHUNK_ALIGNMENT;
}

/** 解析 Google Drive HTTP 308 回應之 Range Header（例如 `bytes=0-524287` → 524288）。 */
export function parseDriveRangeHeader(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=\s*(\d+)\s*-\s*(\d+)/i.exec(rangeHeader);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start !== 0 || end < 0) {
    return null;
  }
  return end + 1;
}

export type ResumableStatusProbeResult =
  | { status: "incomplete"; confirmedBytes: number }
  | { status: "completed"; remoteFileId: string; sizeBytes: number; md5Checksum?: string; modifiedTime?: string }
  | { status: "expired" }
  | { status: "unauthorized" };

export async function queryResumableUploadStatus(params: {
  sessionUri: string;
  totalBytes: number;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ResumableStatusProbeResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const response = await fetchFn(params.sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${params.totalBytes}`,
    },
    signal: params.signal,
  });

  if (response.status === 308) {
    const confirmed = parseDriveRangeHeader(response.headers.get("range"));
    return {
      status: "incomplete",
      confirmedBytes: confirmed ?? 0,
    };
  }
  if (response.status === 200 || response.status === 201) {
    const body = (await response.json()) as {
      id?: string;
      size?: string | number;
      md5Checksum?: string;
      modifiedTime?: string;
    };
    return {
      status: "completed",
      remoteFileId: body.id ?? "",
      sizeBytes: Number(body.size ?? params.totalBytes),
      md5Checksum: body.md5Checksum,
      modifiedTime: body.modifiedTime,
    };
  }
  if (response.status === 404 || response.status === 410) {
    return { status: "expired" };
  }
  if (response.status === 401) {
    return { status: "unauthorized" };
  }
  throw await mapResponseToDriveError(response);
}

async function initiateResumableSession(params: {
  accessToken: string;
  fileName: string;
  mimeType: string;
  parentFolderId: string;
  totalBytes: number;
  appProperties: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const response = await fetchFn(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum,modifiedTime",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": params.mimeType,
        "X-Upload-Content-Length": String(params.totalBytes),
      },
      body: JSON.stringify({
        name: params.fileName,
        mimeType: params.mimeType,
        parents: [params.parentFolderId],
        appProperties: params.appProperties,
      }),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw await mapResponseToDriveError(response, params.fileName);
  }
  const sessionUri = response.headers.get("location")?.trim();
  if (!sessionUri) {
    throw new Error(
      `Google Drive Resumable Upload 未回傳 Session Location header（${params.fileName}）。`,
    );
  }
  return sessionUri;
}

async function findAlreadyUploadedArtifactInFolder(params: {
  accessToken: string;
  parentFolderId: string;
  revisionId: string;
  artifactRole: DriveArtifactRole;
  expectedBytes: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; sizeBytes: number; md5Checksum?: string; modifiedTime?: string } | null> {
  const safeParent = params.parentFolderId.replace(/'/g, "");
  const safeRev = params.revisionId.replace(/'/g, "");
  const safeRole = params.artifactRole.replace(/'/g, "");
  const q = [
    `'${safeParent}' in parents`,
    "trashed=false",
    `appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' }`,
    `appProperties has { key='lhRevisionId' and value='${safeRev}' }`,
    `appProperties has { key='lhArtifactRole' and value='${safeRole}' }`,
  ].join(" and ");

  const res = await listDriveFiles({
    accessToken: params.accessToken,
    q,
    pageSize: 5,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  for (const file of res.files) {
    const sz = Number(file.size ?? 0);
    if (file.id && sz === params.expectedBytes) {
      return {
        id: file.id,
        sizeBytes: sz,
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
      };
    }
  }
  return null;
}

export interface ResumableUploadResult {
  status: "completed" | "paused" | "waiting_auth" | "cancelled" | "failed";
  job: DriveTransferJob;
  remoteFileId?: string;
  sizeBytes?: number;
  md5Checksum?: string;
  modifiedTime?: string;
  errorMessage?: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("已中止重試等待。", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("已中止重試等待。", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function uploadChunkedResumable(params: {
  jobId: string;
  songId: string;
  ownerAccountId: string;
  sourceAudioHash: string;
  revisionId: string;
  artifactRole: DriveArtifactRole;
  fileName: string;
  mimeType: string;
  targetFolderId: string;
  source: UploadByteSource;
  accessToken: string;
  chunkSizeBytes?: number;
  maxRetries?: number;
  isPauseRequested?: () => boolean;
  isAccountStillValid?: () => boolean;
  onAuthExpired?: () => void;
  onProgress?: (job: DriveTransferJob) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  persistJob?: boolean;
}): Promise<ResumableUploadResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const sleepFn = params.sleepImpl ?? defaultSleep;
  const totalBytes = params.source.totalBytes;
  const chunkSize = alignUploadChunkSize(
    params.chunkSizeBytes ?? DEFAULT_DESKTOP_UPLOAD_CHUNK_BYTES,
  );
  const maxRetries = params.maxRetries ?? 5;
  const shouldPersist = params.persistJob !== false;

  let job: DriveTransferJob = {
    key: params.jobId,
    jobId: params.jobId,
    songId: params.songId,
    ownerAccountId: params.ownerAccountId,
    sourceAudioHash: params.sourceAudioHash,
    revisionId: params.revisionId,
    artifactRole: params.artifactRole,
    fileName: params.fileName,
    targetFolderId: params.targetFolderId,
    totalBytes,
    confirmedUploadedBytes: 0,
    status: "uploading",
    updatedAt: Date.now(),
  };

  const commitJob = async (patch: Partial<DriveTransferJob>) => {
    job = {
      ...job,
      ...patch,
      updatedAt: Date.now(),
    };
    if (shouldPersist) {
      await saveDriveTransferJob(job).catch(() => undefined);
    }
    params.onProgress?.(job);
  };

  try {
    // 1) 防重複建立：先檢查遠端是否已存在同 Revision 與 Artifact Role 之完整檔案
    const existingRemote = await findAlreadyUploadedArtifactInFolder({
      accessToken: params.accessToken,
      parentFolderId: params.targetFolderId,
      revisionId: params.revisionId,
      artifactRole: params.artifactRole,
      expectedBytes: totalBytes,
      signal: params.signal,
      fetchImpl: fetchFn,
    });
    if (existingRemote) {
      activeSessionUriMap.delete(params.jobId);
      await commitJob({
        status: "completed",
        confirmedUploadedBytes: totalBytes,
        remoteFileId: existingRemote.id,
      });
      return {
        status: "completed",
        job,
        remoteFileId: existingRemote.id,
        sizeBytes: existingRemote.sizeBytes,
        md5Checksum: existingRemote.md5Checksum,
        modifiedTime: existingRemote.modifiedTime,
      };
    }

    // 2) 若記憶體中有同帳戶的未完成 Session URI，先向 Drive 查詢真實 offset
    let sessionEntry = activeSessionUriMap.get(params.jobId);
    if (sessionEntry && sessionEntry.ownerAccountId !== params.ownerAccountId) {
      activeSessionUriMap.delete(params.jobId);
      sessionEntry = undefined;
    }

    let offset = 0;
    let sessionUri: string | null = sessionEntry?.sessionUri ?? null;
    let recreatedSessionCount = 0;

    if (sessionUri) {
      const probe = await queryResumableUploadStatus({
        sessionUri,
        totalBytes,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: fetchFn,
      });
      if (probe.status === "completed") {
        activeSessionUriMap.delete(params.jobId);
        await commitJob({
          status: "completed",
          confirmedUploadedBytes: totalBytes,
          remoteFileId: probe.remoteFileId,
        });
        return {
          status: "completed",
          job,
          remoteFileId: probe.remoteFileId,
          sizeBytes: probe.sizeBytes,
          md5Checksum: probe.md5Checksum,
          modifiedTime: probe.modifiedTime,
        };
      }
      if (probe.status === "unauthorized") {
        params.onAuthExpired?.();
        await commitJob({
          status: "waiting_auth",
          errorMessage: "Google 授權已過期，重新授權後可續傳。",
        });
        return { status: "waiting_auth", job, errorMessage: job.errorMessage };
      }
      if (probe.status === "expired") {
        activeSessionUriMap.delete(params.jobId);
        sessionUri = null;
        offset = 0;
      } else {
        offset = Math.max(0, Math.min(totalBytes, probe.confirmedBytes));
      }
    }

    if (!sessionUri) {
      sessionUri = await initiateResumableSession({
        accessToken: params.accessToken,
        fileName: params.fileName,
        mimeType: params.mimeType,
        parentFolderId: params.targetFolderId,
        totalBytes,
        appProperties: {
          lhApp: LOOP_HARMONIZER_APP_TAG,
          lhRole: "artifact",
          lhAccountId: params.ownerAccountId,
          lhRevisionId: params.revisionId,
          lhArtifactRole: params.artifactRole,
        },
        signal: params.signal,
        fetchImpl: fetchFn,
      });
      activeSessionUriMap.set(params.jobId, {
        sessionUri,
        ownerAccountId: params.ownerAccountId,
        createdAt: Date.now(),
      });
      offset = 0;
    }

    await commitJob({
      status: "uploading",
      confirmedUploadedBytes: offset,
      errorMessage: undefined,
    });

    let retryAttempt = 0;
    while (offset < totalBytes) {
      if (params.isAccountStillValid && !params.isAccountStillValid()) {
        activeSessionUriMap.delete(params.jobId);
        await commitJob({
          status: "cancelled",
          errorMessage: "Google 帳戶工作階段已變更，已停止上傳。",
        });
        return { status: "cancelled", job, errorMessage: job.errorMessage };
      }
      if (params.isPauseRequested?.()) {
        await commitJob({
          status: "paused",
          confirmedUploadedBytes: offset,
          errorMessage: "使用者已暫停上傳。",
        });
        return { status: "paused", job };
      }
      if (params.signal?.aborted) {
        activeSessionUriMap.delete(params.jobId);
        await commitJob({
          status: "cancelled",
          confirmedUploadedBytes: offset,
          errorMessage: "使用者已取消上傳。",
        });
        return { status: "cancelled", job };
      }

      const remaining = totalBytes - offset;
      const currentChunkSize =
        remaining <= chunkSize ? remaining : alignUploadChunkSize(chunkSize);
      const endExclusive = offset + currentChunkSize;
      const chunkBytes = await params.source.readSlice(offset, endExclusive, params.signal);

      let response: Response;
      try {
        response = await fetchFn(sessionUri, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            "Content-Type": params.mimeType,
            "Content-Length": String(chunkBytes.byteLength),
            "Content-Range": `bytes ${offset}-${endExclusive - 1}/${totalBytes}`,
          },
          body: chunkBytes as unknown as BodyInit,
          signal: params.signal,
        });
      } catch (networkErr) {
        if (networkErr instanceof DOMException && networkErr.name === "AbortError") {
          const paused = Boolean(params.isPauseRequested?.());
          if (!paused) {
            activeSessionUriMap.delete(params.jobId);
          }
          await commitJob({
            status: paused ? "paused" : "cancelled",
            confirmedUploadedBytes: offset,
            errorMessage: paused ? "使用者已暫停上傳。" : "使用者已取消上傳。",
          });
          return { status: paused ? "paused" : "cancelled", job };
        }
        if (retryAttempt >= maxRetries) {
          const msg =
            networkErr instanceof Error
              ? `網路中斷且重試次數已達上限：${networkErr.message}`
              : "網路中斷且重試次數已達上限。";
          await commitJob({ status: "interrupted", confirmedUploadedBytes: offset, errorMessage: msg });
          return { status: "failed", job, errorMessage: msg };
        }
        retryAttempt += 1;
        await sleepFn(Math.min(16_000, 500 * Math.pow(2, retryAttempt - 1)), params.signal);
        const probe = await queryResumableUploadStatus({
          sessionUri,
          totalBytes,
          accessToken: params.accessToken,
          signal: params.signal,
          fetchImpl: fetchFn,
        });
        if (probe.status === "completed") {
          activeSessionUriMap.delete(params.jobId);
          await commitJob({
            status: "completed",
            confirmedUploadedBytes: totalBytes,
            remoteFileId: probe.remoteFileId,
          });
          return {
            status: "completed",
            job,
            remoteFileId: probe.remoteFileId,
            sizeBytes: probe.sizeBytes,
            md5Checksum: probe.md5Checksum,
            modifiedTime: probe.modifiedTime,
          };
        }
        if (probe.status === "incomplete") {
          offset = probe.confirmedBytes;
          await commitJob({ confirmedUploadedBytes: offset });
        } else if (probe.status === "expired") {
          if (recreatedSessionCount >= 1) {
            const msg = "Resumable Upload Session 已過期且無法重建。";
            await commitJob({ status: "failed", errorMessage: msg });
            return { status: "failed", job, errorMessage: msg };
          }
          recreatedSessionCount += 1;
          activeSessionUriMap.delete(params.jobId);
          sessionUri = await initiateResumableSession({
            accessToken: params.accessToken,
            fileName: params.fileName,
            mimeType: params.mimeType,
            parentFolderId: params.targetFolderId,
            totalBytes,
            appProperties: {
              lhApp: LOOP_HARMONIZER_APP_TAG,
              lhRole: "artifact",
              lhAccountId: params.ownerAccountId,
              lhRevisionId: params.revisionId,
              lhArtifactRole: params.artifactRole,
            },
            signal: params.signal,
            fetchImpl: fetchFn,
          });
          activeSessionUriMap.set(params.jobId, {
            sessionUri,
            ownerAccountId: params.ownerAccountId,
            createdAt: Date.now(),
          });
          offset = 0;
        }
        continue;
      }

      if (response.status === 308) {
        retryAttempt = 0;
        const confirmedFromHeader = parseDriveRangeHeader(response.headers.get("range"));
        let nextOffset = confirmedFromHeader;
        if (nextOffset === null) {
          // 若伺服端未在 308 回應附帶 Range header，主動查詢伺服端實際 offset
          const probe = await queryResumableUploadStatus({
            sessionUri,
            totalBytes,
            accessToken: params.accessToken,
            signal: params.signal,
            fetchImpl: fetchFn,
          });
          if (probe.status === "completed") {
            activeSessionUriMap.delete(params.jobId);
            await commitJob({
              status: "completed",
              confirmedUploadedBytes: totalBytes,
              remoteFileId: probe.remoteFileId,
            });
            return {
              status: "completed",
              job,
              remoteFileId: probe.remoteFileId,
              sizeBytes: probe.sizeBytes,
              md5Checksum: probe.md5Checksum,
              modifiedTime: probe.modifiedTime,
            };
          }
          nextOffset = probe.status === "incomplete" ? probe.confirmedBytes : endExclusive;
        }
        sharedNetworkBudgetLedger.recordDriveTransfer(
          "upload",
          Math.max(0, nextOffset - offset),
          params.jobId,
        );
        offset = Math.max(0, Math.min(totalBytes, nextOffset));
        await commitJob({
          status: "uploading",
          confirmedUploadedBytes: offset,
        });
        continue;
      }

      if (response.status === 200 || response.status === 201) {
        const body = (await response.json()) as {
          id?: string;
          size?: string | number;
          md5Checksum?: string;
          modifiedTime?: string;
        };
        const remoteFileId = body.id ?? "";
        const remoteSize = Number(body.size ?? totalBytes);
        if (!remoteFileId || remoteSize !== totalBytes) {
          const msg = `Drive 回傳檔案驗證失敗（id=${remoteFileId || "missing"}, size=${remoteSize}, expected=${totalBytes}）。`;
          await commitJob({ status: "failed", errorMessage: msg });
          return { status: "failed", job, errorMessage: msg };
        }
        sharedNetworkBudgetLedger.recordDriveTransfer("upload", chunkBytes.byteLength, params.jobId);
        activeSessionUriMap.delete(params.jobId);
        await commitJob({
          status: "completed",
          confirmedUploadedBytes: totalBytes,
          remoteFileId,
        });
        return {
          status: "completed",
          job,
          remoteFileId,
          sizeBytes: remoteSize,
          md5Checksum: body.md5Checksum,
          modifiedTime: body.modifiedTime,
        };
      }

      if (response.status === 401) {
        params.onAuthExpired?.();
        await commitJob({
          status: "waiting_auth",
          confirmedUploadedBytes: offset,
          errorMessage: "Google 授權已過期，請重新授權以接續上傳。",
        });
        return { status: "waiting_auth", job, errorMessage: job.errorMessage };
      }

      if (response.status === 404 || response.status === 410) {
        if (recreatedSessionCount >= 1) {
          const msg = "Resumable Upload Session 已過期（HTTP 404/410）。";
          activeSessionUriMap.delete(params.jobId);
          await commitJob({ status: "failed", errorMessage: msg });
          return { status: "failed", job, errorMessage: msg };
        }
        recreatedSessionCount += 1;
        activeSessionUriMap.delete(params.jobId);
        sessionUri = await initiateResumableSession({
          accessToken: params.accessToken,
          fileName: params.fileName,
          mimeType: params.mimeType,
          parentFolderId: params.targetFolderId,
          totalBytes,
          appProperties: {
            lhApp: LOOP_HARMONIZER_APP_TAG,
            lhRole: "artifact",
            lhAccountId: params.ownerAccountId,
            lhRevisionId: params.revisionId,
            lhArtifactRole: params.artifactRole,
          },
          signal: params.signal,
          fetchImpl: fetchFn,
        });
        activeSessionUriMap.set(params.jobId, {
          sessionUri,
          ownerAccountId: params.ownerAccountId,
          createdAt: Date.now(),
        });
        offset = 0;
        await commitJob({ confirmedUploadedBytes: 0 });
        continue;
      }

      const apiErr = await mapResponseToDriveError(response, params.fileName);
      if (apiErr.retryable && retryAttempt < maxRetries) {
        retryAttempt += 1;
        const retryAfterSec = Number(response.headers.get("retry-after"));
        const backoffMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(30_000, retryAfterSec * 1000)
            : Math.min(16_000, 500 * Math.pow(2, retryAttempt - 1));
        await sleepFn(backoffMs, params.signal);
        let probe: ResumableStatusProbeResult;
        try {
          probe = await queryResumableUploadStatus({
            sessionUri,
            totalBytes,
            accessToken: params.accessToken,
            signal: params.signal,
            fetchImpl: fetchFn,
          });
        } catch (probeErr) {
          if (probeErr instanceof DriveApiError && probeErr.retryable) {
            continue;
          }
          throw probeErr;
        }
        if (probe.status === "incomplete") {
          offset = probe.confirmedBytes;
          await commitJob({ confirmedUploadedBytes: offset });
        } else if (probe.status === "completed") {
          activeSessionUriMap.delete(params.jobId);
          await commitJob({
            status: "completed",
            confirmedUploadedBytes: totalBytes,
            remoteFileId: probe.remoteFileId,
          });
          return {
            status: "completed",
            job,
            remoteFileId: probe.remoteFileId,
            sizeBytes: probe.sizeBytes,
            md5Checksum: probe.md5Checksum,
            modifiedTime: probe.modifiedTime,
          };
        }
        continue;
      }

      await commitJob({
        status: "failed",
        confirmedUploadedBytes: offset,
        errorMessage: apiErr.message,
      });
      return { status: "failed", job, errorMessage: apiErr.message };
    }

    throw new Error("上傳迴圈異常結束，尚未取得 Drive 完成回應。");
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const paused = Boolean(params.isPauseRequested?.());
      if (!paused) {
        activeSessionUriMap.delete(params.jobId);
      }
      await commitJob({
        status: paused ? "paused" : "cancelled",
        errorMessage: paused ? "使用者已暫停上傳。" : "使用者已取消上傳。",
      });
      return { status: paused ? "paused" : "cancelled", job };
    }
    if (err instanceof DriveApiError && err.code === "unauthorized") {
      params.onAuthExpired?.();
      await commitJob({ status: "waiting_auth", errorMessage: err.message });
      return { status: "waiting_auth", job, errorMessage: err.message };
    }
    const msg = err instanceof Error ? err.message : "Google Drive 分段上傳失敗。";
    await commitJob({ status: "failed", errorMessage: msg });
    return { status: "failed", job, errorMessage: msg };
  }
}
