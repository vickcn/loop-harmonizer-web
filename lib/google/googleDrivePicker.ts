/**
 * 純前端 Google Identity Services + Google Picker + Drive v3 下載整合模組。
 * 僅在瀏覽器端執行，不經過任何後端伺服器中繼音訊。
 */

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GAPI_SCRIPT_URL = "https://apis.google.com/js/api.js";
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export const DRIVE_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/aiff",
  "audio/x-aiff",
  "audio/x-caf",
  "audio/3gpp",
  "audio/amr",
  "audio/x-ms-wma",
  "video/mp4",
  "video/quicktime",
  "video/webm",
].join(",");

export interface GoogleDriveConfig {
  clientId: string;
  apiKey: string;
  appId: string;
}

export interface PickedDriveFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
}

export interface DriveDownloadProgress {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  loadedBytes: number;
  totalBytes: number | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface PickerDoc {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

interface PickerCallbackData {
  action?: string;
  docs?: PickerDoc[];
}

interface PickerDocsView {
  setIncludeFolders: (enabled: boolean) => PickerDocsView;
  setSelectFolderEnabled: (enabled: boolean) => PickerDocsView;
  setMimeTypes: (mimeTypes: string) => PickerDocsView;
  setOwnedByMe: (ownedByMe: boolean) => PickerDocsView;
  setEnableDrives: (enabled: boolean) => PickerDocsView;
  setLabel: (label: string) => PickerDocsView;
}

interface PickerBuilder {
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  addView: (view: unknown) => PickerBuilder;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

interface GoogleNamespace {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => TokenClient;
      revoke?: (token: string, done?: () => void) => void;
    };
  };
  picker?: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: string) => PickerDocsView;
    ViewId: { DOCS: string };
    Action: { PICKED: string; CANCEL: string };
    Feature: {
      MULTISELECT_ENABLED: string;
      SUPPORT_DRIVES: string;
    };
  };
}

interface GapiNamespace {
  load: (apiName: string, options: { callback: () => void; onerror?: () => void }) => void;
}

declare global {
  interface Window {
    google?: GoogleNamespace;
    gapi?: GapiNamespace;
  }
}

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt = 0;
let gisLoadPromise: Promise<void> | null = null;
let pickerLoadPromise: Promise<void> | null = null;

/** 從 Client ID 解析純數字的 GCP Project Number（供 Picker setAppId 使用）。 */
export function extractGoogleAppId(clientId: string): string {
  const trimmed = clientId.trim();
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return "";
  const prefix = trimmed.slice(0, dashIndex);
  return /^\d+$/.test(prefix) ? prefix : "";
}

/** 讀取前端環境變數中的 Google Drive / Picker 設定。 */
export function getGoogleDriveConfig(): GoogleDriveConfig {
  const clientId = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "").trim();
  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "").trim();
  return {
    clientId,
    apiKey,
    appId: extractGoogleAppId(clientId),
  };
}

/** 檢查是否已設定 Google Client ID 與 Picker API Key。 */
export function isGoogleDrivePickerConfigured(): boolean {
  const { clientId, apiKey } = getGoogleDriveConfig();
  return clientId.length > 0 && apiKey.length > 0;
}

/** 清除記憶體中快取的 Google OAuth Access Token。 */
export function clearCachedGoogleAccessToken(): void {
  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
}

function loadExternalScript(src: string): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("僅支援在瀏覽器環境載入 Google SDK。"));
  }
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing?.dataset.loaded === "true") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    const onLoad = () => {
      script.dataset.loaded = "true";
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`無法載入 Google 外部腳本：${src}`));
    };
    const cleanup = () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };

    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);

    if (!existing) {
      script.src = src;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

/** 懶載入 Google Identity Services 與 Google Picker SDK。 */
export async function ensureGooglePickerSdkLoaded(): Promise<void> {
  if (!gisLoadPromise) {
    gisLoadPromise = loadExternalScript(GIS_SCRIPT_URL).catch((err) => {
      gisLoadPromise = null;
      throw err;
    });
  }

  if (!pickerLoadPromise) {
    pickerLoadPromise = loadExternalScript(GAPI_SCRIPT_URL)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (window.google?.picker) {
              resolve();
              return;
            }
            if (!window.gapi?.load) {
              reject(new Error("Google API loader (gapi) 初始化失敗。"));
              return;
            }
            window.gapi.load("picker", {
              callback: () => resolve(),
              onerror: () => reject(new Error("無法載入 Google Picker 模組。")),
            });
          })
      )
      .catch((err) => {
        pickerLoadPromise = null;
        throw err;
      });
  }

  await Promise.all([gisLoadPromise, pickerLoadPromise]);
}

/** 透過 Google Identity Services 彈窗取得有效的 Drive 只讀 Access Token。 */
export async function requestGoogleDriveAccessToken(
  clientId: string,
  options?: { forcePrompt?: boolean }
): Promise<string> {
  const now = Date.now();
  if (!options?.forcePrompt && cachedAccessToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const initTokenClient = window.google?.accounts?.oauth2?.initTokenClient;
  if (!initTokenClient) {
    throw new Error("Google 登入模組尚未就緒，請稍後再試。");
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const client = initTokenClient({
      client_id: clientId,
      scope: DRIVE_READONLY_SCOPE,
      callback: (response) => {
        if (settled) return;
        settled = true;
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ||
                response.error ||
                "Google 授權未完成，請確認此帳號已加入測試使用者名單。"
            )
          );
          return;
        }
        const expiresInSec = Number(response.expires_in) || 3600;
        cachedAccessToken = response.access_token;
        cachedTokenExpiresAt = Date.now() + expiresInSec * 1000;
        resolve(response.access_token);
      },
      error_callback: (err) => {
        if (settled) return;
        settled = true;
        if (err?.type === "popup_closed") {
          reject(new Error("已取消 Google 登入視窗。"));
          return;
        }
        if (err?.type === "popup_failed_to_open") {
          reject(new Error("瀏覽器封鎖了 Google 登入彈窗，請允許彈出式視窗後再試。"));
          return;
        }
        reject(new Error(err?.message || "Google 授權視窗發生錯誤。"));
      },
    });

    client.requestAccessToken({
      prompt: options?.forcePrompt ? "consent" : cachedAccessToken ? "" : "select_account",
    });
  });
}

/** 開啟 Google Picker 視窗讓使用者挑選雲端硬碟（含他人共享）的音檔。 */
export function openGoogleDrivePicker(params: {
  accessToken: string;
  apiKey: string;
  appId?: string;
  multiple?: boolean;
}): Promise<PickedDriveFile[]> {
  const pickerApi = window.google?.picker;
  if (!pickerApi) {
    return Promise.reject(new Error("Google Picker 尚未載入完成。"));
  }

  return new Promise<PickedDriveFile[]>((resolve) => {
    const myDriveView = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setEnableDrives(true)
      .setMimeTypes(DRIVE_AUDIO_MIME_TYPES)
      .setLabel("我的雲端硬碟");

    const sharedView = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
      .setOwnedByMe(false)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setEnableDrives(true)
      .setMimeTypes(DRIVE_AUDIO_MIME_TYPES)
      .setLabel("與我共用");

    const builder = new pickerApi.PickerBuilder()
      .setTitle("選擇 Google 雲端硬碟音檔（含共享檔案）")
      .setOAuthToken(params.accessToken)
      .setDeveloperKey(params.apiKey)
      .setOrigin(window.location.origin)
      .enableFeature(pickerApi.Feature.SUPPORT_DRIVES)
      .addView(myDriveView)
      .addView(sharedView)
      .setCallback((data) => {
        if (data.action === pickerApi.Action.CANCEL) {
          resolve([]);
          return;
        }
        if (data.action !== pickerApi.Action.PICKED) {
          return;
        }
        const files: PickedDriveFile[] = (data.docs ?? [])
          .filter((doc): doc is PickerDoc & { id: string } => Boolean(doc.id))
          .map((doc) => ({
            id: doc.id,
            name: doc.name || "drive-audio",
            mimeType: doc.mimeType || "audio/mpeg",
            sizeBytes: typeof doc.sizeBytes === "number" ? doc.sizeBytes : undefined,
          }));
        resolve(files);
      });

    if (params.appId) {
      builder.setAppId(params.appId);
    }
    if (params.multiple) {
      builder.enableFeature(pickerApi.Feature.MULTISELECT_ENABLED);
    }

    const picker = builder.build();
    picker.setVisible(true);
  });
}

async function readResponseBlobWithProgress(
  response: Response,
  expectedTotalBytes: number | null,
  onLoaded: (loadedBytes: number, totalBytes: number | null) => void
): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    onLoaded(blob.size, expectedTotalBytes ?? blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
      loaded += value.byteLength;
      onLoaded(loaded, expectedTotalBytes);
    }
  }

  return new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
}

/** 從 Google Drive v3 API 直接下載音訊二進位內容並封裝成標準 File 物件。 */
export async function downloadGoogleDriveFile(params: {
  file: PickedDriveFile;
  accessToken: string;
  fileIndex: number;
  totalFiles: number;
  onProgress?: (progress: DriveDownloadProgress) => void;
}): Promise<File> {
  const { file, accessToken, fileIndex, totalFiles, onProgress } = params;
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearCachedGoogleAccessToken();
      throw new Error("Google 授權已過期，請再點一次重新登入後重試。");
    }
    if (response.status === 403 || response.status === 404) {
      throw new Error(`無法存取「${file.name}」，請確認你對該雲端檔案擁有檢視或下載權限。`);
    }
    throw new Error(`從 Google 雲端硬碟下載「${file.name}」失敗（HTTP ${response.status}）。`);
  }

  const headerLength = Number(response.headers.get("content-length"));
  const totalBytes =
    Number.isFinite(headerLength) && headerLength > 0
      ? headerLength
      : file.sizeBytes ?? null;

  onProgress?.({
    fileIndex,
    totalFiles,
    fileName: file.name,
    loadedBytes: 0,
    totalBytes,
  });

  const blob = await readResponseBlobWithProgress(response, totalBytes, (loaded, total) => {
    onProgress?.({
      fileIndex,
      totalFiles,
      fileName: file.name,
      loadedBytes: loaded,
      totalBytes: total,
    });
  });

  const resolvedType =
    file.mimeType && file.mimeType !== "application/octet-stream"
      ? file.mimeType
      : blob.type || "audio/mpeg";

  return new File([blob], file.name, {
    type: resolvedType,
    lastModified: Date.now(),
  });
}

/** 完整互動流程：載入 SDK → 授權 → 開啟 Picker → 下載成 File[]。 */
export async function pickAndDownloadGoogleDriveAudioFiles(options?: {
  multiple?: boolean;
  onStageChange?: (stage: "sdk" | "auth" | "picker" | "downloading") => void;
  onProgress?: (progress: DriveDownloadProgress) => void;
}): Promise<File[]> {
  const config = getGoogleDriveConfig();
  if (!config.clientId || !config.apiKey) {
    throw new Error(
      "尚未設定 NEXT_PUBLIC_GOOGLE_CLIENT_ID 或 NEXT_PUBLIC_GOOGLE_API_KEY 環境變數。"
    );
  }

  options?.onStageChange?.("sdk");
  await ensureGooglePickerSdkLoaded();

  options?.onStageChange?.("auth");
  const accessToken = await requestGoogleDriveAccessToken(config.clientId);

  options?.onStageChange?.("picker");
  const pickedFiles = await openGoogleDrivePicker({
    accessToken,
    apiKey: config.apiKey,
    appId: config.appId,
    multiple: options?.multiple,
  });

  if (pickedFiles.length === 0) {
    return [];
  }

  options?.onStageChange?.("downloading");
  const downloaded: File[] = [];
  for (let i = 0; i < pickedFiles.length; i += 1) {
    const file = await downloadGoogleDriveFile({
      file: pickedFiles[i],
      accessToken,
      fileIndex: i,
      totalFiles: pickedFiles.length,
      onProgress: options?.onProgress,
    });
    downloaded.push(file);
  }

  return downloaded;
}
