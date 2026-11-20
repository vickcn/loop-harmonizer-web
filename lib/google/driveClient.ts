import { sharedNetworkBudgetLedger } from "../band/networkBudgetGuard.ts";
import {
  DRIVE_AUDIO_MIME_TYPES,
  DRIVE_SHORTCUT_MIME_TYPE,
  type PickedDriveFile,
} from "./googleDrivePicker.ts";
import type { VerifiedDriveFileMetadata } from "./driveTransferTypes.ts";

export type DriveApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "quota_exceeded"
  | "download_restricted"
  | "rate_limited"
  | "trashed"
  | "unsupported_mime"
  | "aborted"
  | "size_limit_exceeded"
  | "network"
  | "server";

export class DriveApiError extends Error {
  readonly status: number;
  readonly code: DriveApiErrorCode;
  readonly fileName?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      code: DriveApiErrorCode;
      fileName?: string;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "DriveApiError";
    this.status = options.status;
    this.code = options.code;
    this.fileName = options.fileName;
    this.retryable = Boolean(options.retryable);
  }
}

export interface DriveRawFileResource {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  createdTime?: string;
  modifiedTime?: string;
  version?: string | number;
  headRevisionId?: string;
  md5Checksum?: string;
  trashed?: boolean;
  driveId?: string;
  resourceKey?: string;
  webViewLink?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  capabilities?: {
    canDownload?: boolean;
    canCopy?: boolean;
    canDelete?: boolean;
    canEdit?: boolean;
    canAddChildren?: boolean;
  };
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
    targetResourceKey?: string;
  };
}

export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SUPPORTED_AUDIO_MIME_SET = new Set(
  DRIVE_AUDIO_MIME_TYPES.split(",").filter((item) => item && item !== DRIVE_SHORTCUT_MIME_TYPE),
);
const AUDIO_EXT_REGEX = /\.(mp3|wav|wave|m4a|aac|flac|ogg|opus|webm|aif|aiff|caf|3gp|amr|wma|mp4|mov)$/i;

export function buildResourceKeysHeader(
  entries: ReadonlyArray<{ fileId?: string; resourceKey?: string }>,
): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of entries) {
    const fileId = entry.fileId?.trim();
    const rk = entry.resourceKey?.trim();
    if (!fileId || !rk) continue;
    const pair = `${fileId}/${rk}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    parts.push(pair);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

function isAudioLikeFile(name: string, mimeType: string): boolean {
  if (!mimeType || mimeType === "application/octet-stream") {
    return AUDIO_EXT_REGEX.test(name);
  }
  if (mimeType.startsWith("audio/") || SUPPORTED_AUDIO_MIME_SET.has(mimeType)) {
    return true;
  }
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    return false;
  }
  return AUDIO_EXT_REGEX.test(name);
}

async function parseDriveErrorBody(response: Response): Promise<{
  reason?: string;
  message?: string;
}> {
  try {
    const text = await response.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
    return {
      reason: parsed.error?.errors?.[0]?.reason,
      message: parsed.error?.message ?? parsed.error?.errors?.[0]?.message,
    };
  } catch {
    return {};
  }
}

export async function mapResponseToDriveError(
  response: Response,
  fileName?: string,
): Promise<DriveApiError> {
  const detail = await parseDriveErrorBody(response);
  const label = fileName ? `「${fileName}」` : "Google Drive 檔案";

  if (response.status === 401) {
    return new DriveApiError("Google 授權已過期或無效，請重新登入後再試。", {
      status: 401,
      code: "unauthorized",
      fileName,
      retryable: false,
    });
  }
  if (response.status === 403) {
    if (detail.reason === "storageQuotaExceeded") {
      return new DriveApiError("Google 雲端硬碟儲存空間已滿，無法繼續上傳。", {
        status: 403,
        code: "quota_exceeded",
        fileName,
        retryable: false,
      });
    }
    if (detail.reason === "cannotDownloadFile" || detail.reason === "cannotDownloadAbusiveFile") {
      return new DriveApiError(
        `${label} 的擁有者已限制檢視者下載權限，無法自 Google Drive 匯入。`,
        {
          status: 403,
          code: "download_restricted",
          fileName,
          retryable: false,
        },
      );
    }
    if (
      detail.reason === "userRateLimitExceeded" ||
      detail.reason === "rateLimitExceeded"
    ) {
      return new DriveApiError(`存取 ${label} 過於頻繁（403 Rate Limit），請稍後重試。`, {
        status: 403,
        code: "rate_limited",
        fileName,
        retryable: true,
      });
    }
    return new DriveApiError(
      `沒有權限存取 ${label}（HTTP 403${detail.message ? `：${detail.message}` : ""}）。`,
      {
        status: 403,
        code: "forbidden",
        fileName,
        retryable: false,
      },
    );
  }
  if (response.status === 404) {
    return new DriveApiError(
      `找不到 ${label}，可能已被刪除、取消共享，或需要重新透過 Google Picker 授權存取。`,
      {
        status: 404,
        code: "not_found",
        fileName,
        retryable: false,
      },
    );
  }
  if (response.status === 429) {
    return new DriveApiError("Google Drive API 請求頻率過高（HTTP 429），請稍候再試。", {
      status: 429,
      code: "rate_limited",
      fileName,
      retryable: true,
    });
  }
  if (response.status >= 500) {
    return new DriveApiError(
      `Google Drive 服務暫時異常（HTTP ${response.status}），可稍後重試。`,
      {
        status: response.status,
        code: "server",
        fileName,
        retryable: true,
      },
    );
  }
  return new DriveApiError(
    `Google Drive 操作失敗（HTTP ${response.status}${detail.message ? `：${detail.message}` : ""}）。`,
    {
      status: response.status,
      code: "network",
      fileName,
      retryable: false,
    },
  );
}

export async function getDriveFileMetadata(
  fileId: string,
  options: {
    accessToken: string;
    resourceKey?: string;
    extraResourceKeys?: ReadonlyArray<{ fileId?: string; resourceKey?: string }>;
    fields?: string;
    fileName?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<DriveRawFileResource> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const fields =
    options.fields ??
    "id,name,mimeType,size,createdTime,modifiedTime,version,headRevisionId,md5Checksum,trashed,driveId,resourceKey,webViewLink,parents,appProperties,capabilities(canDownload,canCopy,canDelete,canEdit,canAddChildren),shortcutDetails(targetId,targetMimeType,targetResourceKey)";
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
  };
  const rkHeader = buildResourceKeysHeader([
    { fileId, resourceKey: options.resourceKey },
    ...(options.extraResourceKeys ?? []),
  ]);
  if (rkHeader) {
    headers["X-Goog-Drive-Resource-Keys"] = rkHeader;
  }

  const response = await fetchFn(url, {
    method: "GET",
    headers,
    signal: options.signal,
  });
  if (!response.ok) {
    throw await mapResponseToDriveError(response, options.fileName);
  }
  return (await response.json()) as DriveRawFileResource;
}

/** 驗證選取的 Drive 檔案（支援快捷方式、Shared Drive 與 Resource Key，不繞過權限）。 */
export async function resolveDriveFileForDownload(
  picked: PickedDriveFile,
  options: {
    accessToken: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<VerifiedDriveFileMetadata> {
  let currentId = picked.id;
  let currentResourceKey = picked.resourceKey;
  let isShortcut = picked.mimeType === DRIVE_SHORTCUT_MIME_TYPE;
  const resourceKeys: Array<{ fileId?: string; resourceKey?: string }> = [
    { fileId: picked.id, resourceKey: picked.resourceKey },
  ];

  let meta: DriveRawFileResource | null = null;
  for (let hop = 0; hop < 3; hop += 1) {
    meta = await getDriveFileMetadata(currentId, {
      accessToken: options.accessToken,
      resourceKey: currentResourceKey,
      extraResourceKeys: resourceKeys,
      fileName: picked.name,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });

    if (meta.trashed) {
      throw new DriveApiError(`「${meta.name || picked.name}」在 Google Drive 已被移至垃圾桶。`, {
        status: 404,
        code: "trashed",
        fileName: meta.name || picked.name,
      });
    }

    if (meta.mimeType === DRIVE_SHORTCUT_MIME_TYPE) {
      isShortcut = true;
      const targetId = meta.shortcutDetails?.targetId?.trim();
      if (!targetId) {
        throw new DriveApiError(`「${meta.name || picked.name}」為無效的雲端硬碟快捷方式。`, {
          status: 404,
          code: "not_found",
          fileName: meta.name || picked.name,
        });
      }
      const targetRk = meta.shortcutDetails?.targetResourceKey;
      if (targetRk) {
        resourceKeys.push({ fileId: targetId, resourceKey: targetRk });
      }
      currentId = targetId;
      currentResourceKey = targetRk ?? currentResourceKey;
      continue;
    }
    break;
  }

  if (!meta) {
    throw new DriveApiError(`無法取得「${picked.name}」的檔案中繼資料。`, {
      status: 404,
      code: "not_found",
      fileName: picked.name,
    });
  }

  if (meta.mimeType === DRIVE_SHORTCUT_MIME_TYPE) {
    throw new DriveApiError(`「${picked.name}」快捷方式階層過深，無法安全解析。`, {
      status: 400,
      code: "not_found",
      fileName: picked.name,
    });
  }

  const resolvedName = meta.name || picked.name;
  const resolvedMime = meta.mimeType || picked.mimeType || "application/octet-stream";

  if (meta.capabilities?.canDownload === false) {
    throw new DriveApiError(
      `「${resolvedName}」的擁有者已停用下載權限（canDownload=false），無法匯入本機播放。`,
      {
        status: 403,
        code: "download_restricted",
        fileName: resolvedName,
      },
    );
  }

  if (!isAudioLikeFile(resolvedName, resolvedMime)) {
    throw new DriveApiError(
      `「${resolvedName}」（類型：${resolvedMime}）不是受支援的音訊或可解碼媒體格式。`,
      {
        status: 415,
        code: "unsupported_mime",
        fileName: resolvedName,
      },
    );
  }

  const parsedSize =
    meta.size !== undefined && meta.size !== null && meta.size !== ""
      ? Number(meta.size)
      : picked.sizeBytes;
  const sizeBytes =
    typeof parsedSize === "number" && Number.isFinite(parsedSize) && parsedSize >= 0
      ? parsedSize
      : null;

  return {
    pickedFileId: picked.id,
    resolvedFileId: meta.id || currentId,
    name: resolvedName,
    mimeType: resolvedMime,
    sizeBytes,
    modifiedTime: meta.modifiedTime ?? picked.modifiedTime,
    md5Checksum: meta.md5Checksum ?? picked.md5Checksum,
    driveId: meta.driveId ?? picked.driveId,
    resourceKey: picked.resourceKey ?? meta.resourceKey,
    targetResourceKey:
      meta.id !== picked.id ? (meta.resourceKey ?? currentResourceKey) : undefined,
    webViewLink: meta.webViewLink ?? picked.webViewLink,
    isShortcut,
    canDownload: true,
  };
}

export async function downloadDriveFileBlob(
  meta: Pick<
    VerifiedDriveFileMetadata,
    "pickedFileId" | "resolvedFileId" | "name" | "mimeType" | "sizeBytes" | "modifiedTime" | "resourceKey" | "targetResourceKey"
  >,
  options: {
    accessToken: string;
    maxBytes?: number;
    signal?: AbortSignal;
    throttleMs?: number;
    fetchImpl?: typeof fetch;
    onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
  },
): Promise<{ file: File; loadedBytes: number }> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes;
  const throttleMs = options.throttleMs ?? 120;

  if (maxBytes && meta.sizeBytes !== null && meta.sizeBytes > maxBytes) {
    throw new DriveApiError(
      `「${meta.name}」大小（${(meta.sizeBytes / (1024 * 1024)).toFixed(1)} MiB）超過目前允許的下載上限（${(maxBytes / (1024 * 1024)).toFixed(1)} MiB）。`,
      {
        status: 413,
        code: "size_limit_exceeded",
        fileName: meta.name,
      },
    );
  }

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.resolvedFileId)}?alt=media&supportsAllDrives=true`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
  };
  const rkHeader = buildResourceKeysHeader([
    { fileId: meta.pickedFileId, resourceKey: meta.resourceKey },
    { fileId: meta.resolvedFileId, resourceKey: meta.targetResourceKey ?? meta.resourceKey },
  ]);
  if (rkHeader) {
    headers["X-Goog-Drive-Resource-Keys"] = rkHeader;
  }

  const response = await fetchFn(url, {
    method: "GET",
    headers,
    signal: options.signal,
  });
  if (!response.ok) {
    throw await mapResponseToDriveError(response, meta.name);
  }

  const contentLength = Number(response.headers.get("content-length"));
  const expectedTotal =
    Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : meta.sizeBytes;

  if (maxBytes && expectedTotal !== null && expectedTotal > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new DriveApiError(
      `「${meta.name}」大小（${(expectedTotal / (1024 * 1024)).toFixed(1)} MiB）超過允許上限（${(maxBytes / (1024 * 1024)).toFixed(1)} MiB）。`,
      {
        status: 413,
        code: "size_limit_exceeded",
        fileName: meta.name,
      },
    );
  }

  options.onProgress?.(0, expectedTotal);

  let blob: Blob;
  let loaded = 0;
  if (!response.body) {
    blob = await response.blob();
    loaded = blob.size;
    if (maxBytes && loaded > maxBytes) {
      throw new DriveApiError(
        `「${meta.name}」下載大小（${(loaded / (1024 * 1024)).toFixed(1)} MiB）超過安全上限，已中止。`,
        {
          status: 413,
          code: "size_limit_exceeded",
          fileName: meta.name,
        },
      );
    }
    options.onProgress?.(loaded, expectedTotal ?? loaded);
  } else {
    const reader = response.body.getReader();
    const parts: BlobPart[] = [];
    let lastEmitAt = 0;

    try {
      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw new DOMException("已取消 Google Drive 下載。", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          loaded += value.byteLength;
          if (maxBytes && loaded > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new DriveApiError(
              `「${meta.name}」已接收 ${(loaded / (1024 * 1024)).toFixed(1)} MiB，超過安全下載上限（${(maxBytes / (1024 * 1024)).toFixed(1)} MiB），已安全中止下載。`,
              {
                status: 413,
                code: "size_limit_exceeded",
                fileName: meta.name,
              },
            );
          }
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          parts.push(copy);
          const now = Date.now();
          if (now - lastEmitAt >= throttleMs) {
            lastEmitAt = now;
            options.onProgress?.(loaded, expectedTotal);
          }
        }
      }
      options.onProgress?.(loaded, expectedTotal);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    blob = new Blob(parts, {
      type:
        meta.mimeType && meta.mimeType !== "application/octet-stream"
          ? meta.mimeType
          : response.headers.get("content-type") || "audio/mpeg",
    });
  }

  sharedNetworkBudgetLedger.recordDriveTransfer("download", loaded, meta.resolvedFileId);

  const fileType =
    meta.mimeType && meta.mimeType !== "application/octet-stream"
      ? meta.mimeType
      : blob.type || "audio/mpeg";
  const lastModified = meta.modifiedTime ? Date.parse(meta.modifiedTime) || Date.now() : Date.now();
  const file = new File([blob], meta.name, {
    type: fileType,
    lastModified,
  });

  return { file, loadedBytes: loaded };
}

export async function listDriveFiles(params: {
  accessToken: string;
  q: string;
  fields?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ files: DriveRawFileResource[]; nextPageToken?: string }> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const search = new URLSearchParams({
    q: params.q,
    fields:
      params.fields ??
      "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,version,headRevisionId,md5Checksum,trashed,parents,appProperties,capabilities(canDownload,canDelete,canEdit,canAddChildren))",
    pageSize: String(params.pageSize ?? 50),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    spaces: "drive",
  });
  if (params.pageToken) search.set("pageToken", params.pageToken);
  if (params.orderBy) search.set("orderBy", params.orderBy);

  const response = await fetchFn(
    `https://www.googleapis.com/drive/v3/files?${search.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw await mapResponseToDriveError(response);
  }
  const data = (await response.json()) as {
    files?: DriveRawFileResource[];
    nextPageToken?: string;
  };
  return {
    files: Array.isArray(data.files) ? data.files : [],
    nextPageToken: data.nextPageToken,
  };
}

export async function createDriveFolder(params: {
  accessToken: string;
  name: string;
  parentId?: string;
  appProperties?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveRawFileResource> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const metadata: Record<string, unknown> = {
    name: params.name,
    mimeType: DRIVE_FOLDER_MIME_TYPE,
  };
  if (params.parentId) {
    metadata.parents = [params.parentId];
  }
  if (params.appProperties) {
    metadata.appProperties = params.appProperties;
  }

  const response = await fetchFn(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,trashed,parents,appProperties,capabilities(canDelete,canEdit,canAddChildren)",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(metadata),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw await mapResponseToDriveError(response, params.name);
  }
  return (await response.json()) as DriveRawFileResource;
}

export async function uploadDriveMultipartJson(params: {
  accessToken: string;
  name: string;
  parentId: string;
  payload: unknown;
  existingFileId?: string;
  appProperties?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveRawFileResource> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const boundary = `lh_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metadata: Record<string, unknown> = {
    name: params.name,
    mimeType: "application/json",
  };
  if (!params.existingFileId) {
    metadata.parents = [params.parentId];
  }
  if (params.appProperties) {
    metadata.appProperties = params.appProperties;
  }
  const jsonText = JSON.stringify(params.payload, null, 2);
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${jsonText}\r\n` +
    `--${boundary}--`;

  const url = params.existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.existingFileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,md5Checksum,modifiedTime,createdTime,version,headRevisionId,appProperties`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,md5Checksum,modifiedTime,createdTime,version,headRevisionId,appProperties";

  const response = await fetchFn(url, {
    method: params.existingFileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: params.signal,
  });
  if (!response.ok) {
    throw await mapResponseToDriveError(response, params.name);
  }
  sharedNetworkBudgetLedger.recordDriveTransfer("upload", body.length, params.name);
  return (await response.json()) as DriveRawFileResource;
}

export async function downloadDriveJson<T>(params: {
  fileId: string;
  accessToken: string;
  fileName?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const response = await fetchFn(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?alt=media&supportsAllDrives=true`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw await mapResponseToDriveError(response, params.fileName);
  }
  const text = await response.text();
  sharedNetworkBudgetLedger.recordDriveTransfer("download", text.length, params.fileId);
  return JSON.parse(text) as T;
}

export async function downloadDriveBinaryWithProgress(params: {
  fileId: string;
  accessToken: string;
  fileName: string;
  expectedSizeBytes?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
}): Promise<ArrayBuffer> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const response = await fetchFn(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?alt=media&supportsAllDrives=true`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw await mapResponseToDriveError(response, params.fileName);
  }
  const headerLength = Number(response.headers.get("content-length"));
  const expectedTotal =
    Number.isFinite(headerLength) && headerLength > 0
      ? headerLength
      : params.expectedSizeBytes ?? null;

  if (params.maxBytes && expectedTotal !== null && expectedTotal > params.maxBytes) {
    throw new DriveApiError(
      `「${params.fileName}」檔案大小超過允許的恢復上限。`,
      {
        status: 413,
        code: "size_limit_exceeded",
        fileName: params.fileName,
      },
    );
  }

  const buffer = await response.arrayBuffer();
  if (params.maxBytes && buffer.byteLength > params.maxBytes) {
    throw new DriveApiError(
      `「${params.fileName}」實際下載大小超過允許的恢復上限。`,
      {
        status: 413,
        code: "size_limit_exceeded",
        fileName: params.fileName,
      },
    );
  }
  optionsProgressSafe(params.onProgress, buffer.byteLength, expectedTotal ?? buffer.byteLength);
  sharedNetworkBudgetLedger.recordDriveTransfer("download", buffer.byteLength, params.fileId);
  return buffer;
}

function optionsProgressSafe(
  cb: ((loadedBytes: number, totalBytes: number | null) => void) | undefined,
  loaded: number,
  total: number | null,
): void {
  try {
    cb?.(loaded, total);
  } catch {
    // ignore progress callback error
  }
}

/** 僅刪除由 Loop Harmonizer 自行建立且具備 lhApp=loop-harmonizer 標記的 Drive 檔案或資料夾；支援嚴格角色/帳戶/專案驗證。 */
export async function deleteAppManagedDriveFile(params: {
  fileId: string;
  accessToken: string;
  fileName?: string;
  expectedRole?: string;
  expectedAccountId?: string;
  expectedProjectId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const meta = await getDriveFileMetadata(params.fileId, {
    accessToken: params.accessToken,
    fields: "id,name,trashed,appProperties,capabilities(canDelete)",
    fileName: params.fileName,
    signal: params.signal,
    fetchImpl: fetchFn,
  });
  if (meta.appProperties?.lhApp !== "loop-harmonizer") {
    throw new DriveApiError(
      `「${meta.name || params.fileName || params.fileId}」並非 Loop Harmonizer 管理的成果檔案，已拒絕刪除。`,
      {
        status: 403,
        code: "forbidden",
        fileName: meta.name || params.fileName,
      },
    );
  }
  if (params.expectedRole && meta.appProperties?.lhRole !== params.expectedRole) {
    throw new DriveApiError(
      `「${meta.name || params.fileName || params.fileId}」的系統角色（${meta.appProperties?.lhRole ?? "unknown"}）與預期不符，已拒絕刪除。`,
      {
        status: 403,
        code: "forbidden",
        fileName: meta.name || params.fileName,
      },
    );
  }
  if (
    params.expectedAccountId &&
    meta.appProperties?.lhAccountId &&
    meta.appProperties.lhAccountId !== params.expectedAccountId
  ) {
    throw new DriveApiError(
      `「${meta.name || params.fileName || params.fileId}」屬於其他 Google 帳戶，已拒絕跨帳戶刪除。`,
      {
        status: 403,
        code: "forbidden",
        fileName: meta.name || params.fileName,
      },
    );
  }
  if (params.expectedProjectId && meta.appProperties?.lhProjectId !== params.expectedProjectId) {
    throw new DriveApiError(
      `「${meta.name || params.fileName || params.fileId}」與指定 Project ID 不符，已拒絕刪除。`,
      {
        status: 403,
        code: "forbidden",
        fileName: meta.name || params.fileName,
      },
    );
  }
  if (meta.capabilities?.canDelete === false) {
    throw new DriveApiError(
      `目前帳戶沒有刪除「${meta.name || params.fileName || params.fileId}」的權限。`,
      {
        status: 403,
        code: "forbidden",
        fileName: meta.name || params.fileName,
      },
    );
  }

  const response = await fetchFn(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?supportsAllDrives=true`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      signal: params.signal,
    },
  );
  if (!response.ok && response.status !== 404) {
    throw await mapResponseToDriveError(response, meta.name || params.fileName);
  }
}
