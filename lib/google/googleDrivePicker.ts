import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_REQUESTED_SCOPES,
  type GoogleDriveConfigStatus,
  type GoogleSdkReadinessState,
} from "./googleAuthTypes.ts";

/**
 * 純前端 Google Identity Services + Google Picker + Drive v3 下載整合模組。
 * 僅在瀏覽器端執行，不經過任何後端伺服器中繼音訊。
 */

export const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
export const GAPI_SCRIPT_URL = "https://apis.google.com/js/api.js";
export const DEFAULT_GOOGLE_SDK_TIMEOUT_MS = 15_000;

export const DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

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
  DRIVE_SHORTCUT_MIME_TYPE,
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
  resourceKey?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  driveId?: string;
  webViewLink?: string;
}

export interface DriveDownloadProgress {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  loadedBytes: number;
  totalBytes: number | null;
}

export interface TokenGrantResult {
  accessToken: string;
  expiresInSec: number;
  grantedScopes: string[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
  requestAccessToken: (overrideConfig?: { prompt?: string; hint?: string }) => void;
}

interface PickerDoc {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  resourceKey?: string;
  driveId?: string;
  url?: string;
  lastEditedUtc?: number;
  md5Checksum?: string;
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
      hasGrantedAllScopes?: (tokenResponse: TokenResponse, firstScope: string, ...otherScopes: string[]) => boolean;
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
  load: (apiName: string, options: { callback: () => void; onerror?: () => void; timeout?: number; ontimeout?: () => void }) => void;
}

declare global {
  interface Window {
    google?: GoogleNamespace;
    gapi?: GapiNamespace;
  }
}

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt = 0;
let cachedGrantedScopes: string[] = [];
let gisLoadPromise: Promise<void> | null = null;
let pickerLoadPromise: Promise<void> | null = null;
let sdkReadinessState: GoogleSdkReadinessState = "idle";
let activeTokenRequestPromise: Promise<TokenGrantResult> | null = null;
let activePickerPromise: Promise<PickedDriveFile[]> | null = null;
const sdkStateListeners = new Set<(state: GoogleSdkReadinessState) => void>();

function setSdkReadinessState(next: GoogleSdkReadinessState): void {
  sdkReadinessState = next;
  for (const listener of sdkStateListeners) {
    try {
      listener(next);
    } catch {
      // ignore listener errors
    }
  }
}

export function getGoogleSdkReadiness(): GoogleSdkReadinessState {
  if (typeof window !== "undefined" && window.google?.accounts?.oauth2 && window.google?.picker) {
    return "ready";
  }
  return sdkReadinessState;
}

export function subscribeGoogleSdkReadiness(
  listener: (state: GoogleSdkReadinessState) => void,
): () => void {
  sdkStateListeners.add(listener);
  return () => {
    sdkStateListeners.delete(listener);
  };
}

/** 僅供單元測試重置 SDK 單飛狀態。 */
export function resetGoogleSdkLoaderForTests(): void {
  gisLoadPromise = null;
  pickerLoadPromise = null;
  activeTokenRequestPromise = null;
  activePickerPromise = null;
  sdkReadinessState = "idle";
  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
  cachedGrantedScopes = [];
}

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
  const explicitAppId = (process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? "").trim();
  const appId = /^\d+$/.test(explicitAppId) ? explicitAppId : extractGoogleAppId(clientId);
  return {
    clientId,
    apiKey,
    appId,
  };
}

/** 檢查環境變數設定狀態並列出缺少欄位。 */
export function getGoogleDriveConfigStatus(): GoogleDriveConfigStatus {
  const { clientId, apiKey, appId } = getGoogleDriveConfig();
  const missingFields: string[] = [];
  if (!clientId) missingFields.push("NEXT_PUBLIC_GOOGLE_CLIENT_ID");
  if (!apiKey) missingFields.push("NEXT_PUBLIC_GOOGLE_API_KEY");
  const configured = missingFields.length === 0;
  return {
    configured,
    clientId,
    apiKey,
    appId,
    missingFields,
    message: configured
      ? appId
        ? null
        : "無法自 Client ID 解析 GCP Project Number，建議補充 NEXT_PUBLIC_GOOGLE_APP_ID 以確保 Picker drive.file 授權正常運作。"
      : `尚未設定 ${missingFields.join("、")}，目前保留完整本機使用模式。`,
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
  cachedGrantedScopes = [];
}

function loadExternalScript(src: string, timeoutMs = DEFAULT_GOOGLE_SDK_TIMEOUT_MS): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("僅支援在瀏覽器環境載入 Google SDK。"));
  }
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === "true" || existing.dataset.lhStatus === "loaded") {
      return Promise.resolve();
    }
    if (existing.dataset.lhStatus === "error") {
      existing.remove();
    }
  }

  const currentExisting = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  return new Promise((resolve, reject) => {
    const script = currentExisting ?? document.createElement("script");
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      script.dataset.lhStatus = "error";
      try {
        script.remove();
      } catch {
        // ignore DOM removal error
      }
      reject(new Error(reason));
    };

    const onLoad = () => {
      if (settled) return;
      settled = true;
      cleanup();
      script.dataset.loaded = "true";
      script.dataset.lhStatus = "loaded";
      resolve();
    };

    const onError = () => {
      fail(`無法載入 Google 外部腳本：${src}`);
    };

    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    timer = setTimeout(() => {
      fail(`載入 Google 外部腳本逾時（${Math.round(timeoutMs / 1000)} 秒）：${src}`);
    }, timeoutMs);

    if (!currentExisting) {
      script.dataset.lhStatus = "loading";
      script.src = src;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

/** 懶載入 Google Identity Services 與 Google Picker SDK（含 timeout 與失敗可重試）。 */
export async function ensureGooglePickerSdkLoaded(options?: {
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GOOGLE_SDK_TIMEOUT_MS;
  if (typeof window !== "undefined" && window.google?.accounts?.oauth2 && window.google?.picker) {
    setSdkReadinessState("ready");
    return;
  }

  setSdkReadinessState("loading");

  if (!gisLoadPromise) {
    gisLoadPromise = loadExternalScript(GIS_SCRIPT_URL, timeoutMs).catch((err) => {
      gisLoadPromise = null;
      throw err;
    });
  }

  if (!pickerLoadPromise) {
    pickerLoadPromise = loadExternalScript(GAPI_SCRIPT_URL, timeoutMs)
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
            let settled = false;
            const moduleTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error("載入 Google Picker 模組逾時，請稍後再試。"));
            }, timeoutMs);
            window.gapi.load("picker", {
              callback: () => {
                if (settled) return;
                settled = true;
                clearTimeout(moduleTimer);
                resolve();
              },
              onerror: () => {
                if (settled) return;
                settled = true;
                clearTimeout(moduleTimer);
                reject(new Error("無法載入 Google Picker 模組。"));
              },
              timeout: timeoutMs,
              ontimeout: () => {
                if (settled) return;
                settled = true;
                clearTimeout(moduleTimer);
                reject(new Error("載入 Google Picker 模組逾時，請稍後再試。"));
              },
            });
          }),
      )
      .catch((err) => {
        pickerLoadPromise = null;
        throw err;
      });
  }

  try {
    await Promise.all([gisLoadPromise, pickerLoadPromise]);
    setSdkReadinessState("ready");
  } catch (err) {
    setSdkReadinessState("error");
    throw err;
  }
}

/** 進入混音介面時預先載入 Google SDK 以減少彈窗被瀏覽器手勢限制的機率（絕不預先下載音檔）。 */
export function preloadGoogleSdk(): Promise<void> {
  if (!isGoogleDrivePickerConfigured()) {
    return Promise.resolve();
  }
  return ensureGooglePickerSdkLoaded().catch(() => undefined);
}

function parseGrantedScopes(response: TokenResponse, fallbackScope: string): string[] {
  const raw = typeof response.scope === "string" && response.scope.trim() ? response.scope : fallbackScope;
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasDriveFileScope(response: TokenResponse, grantedScopes: string[]): boolean {
  const checker =
    typeof window !== "undefined" ? window.google?.accounts?.oauth2?.hasGrantedAllScopes : undefined;
  if (typeof checker === "function") {
    try {
      return checker(response, GOOGLE_DRIVE_FILE_SCOPE);
    } catch {
      // fallback to scope string inspection
    }
  }
  return grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE);
}

/** 透過 Google Identity Services 彈窗取得授權 Token 與已核准 Scope。 */
export async function requestGoogleAccessTokenWithMetadata(
  clientId: string,
  options?: {
    forcePrompt?: boolean;
    prompt?: "" | "select_account" | "consent";
    hint?: string;
    scope?: string;
  },
): Promise<TokenGrantResult> {
  const requestedScope = options?.scope ?? GOOGLE_REQUESTED_SCOPES;
  if (activeTokenRequestPromise) {
    return activeTokenRequestPromise;
  }

  const initTokenClient =
    typeof window !== "undefined" ? window.google?.accounts?.oauth2?.initTokenClient : undefined;
  if (!initTokenClient) {
    throw new Error("Google 登入模組尚未就緒，請稍後再試。");
  }

  const promptValue =
    options?.prompt !== undefined
      ? options.prompt
      : options?.forcePrompt
        ? "consent"
        : "select_account";

  const promise = new Promise<TokenGrantResult>((resolve, reject) => {
    let settled = false;
    const client = initTokenClient({
      client_id: clientId,
      scope: requestedScope,
      callback: (response) => {
        if (settled) return;
        settled = true;
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ||
                response.error ||
                "Google 授權未完成，請確認此帳號已加入測試使用者名單。",
            ),
          );
          return;
        }
        const grantedScopes = parseGrantedScopes(response, requestedScope);
        if (!hasDriveFileScope(response, grantedScopes)) {
          reject(
            new Error(
              "未授予 Google Drive 檔案存取權限（drive.file），已保留本機模式；若需使用雲端硬碟請重新授權並勾選權限。",
            ),
          );
          return;
        }
        const expiresInSec = Number(response.expires_in) || 3600;
        cachedAccessToken = response.access_token;
        cachedTokenExpiresAt = Date.now() + expiresInSec * 1000;
        cachedGrantedScopes = grantedScopes;
        resolve({
          accessToken: response.access_token,
          expiresInSec,
          grantedScopes,
        });
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

    try {
      client.requestAccessToken({
        prompt: promptValue,
        ...(options?.hint ? { hint: options.hint } : {}),
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error("無法啟動 Google 授權視窗。"));
      }
    }
  });

  const tracked = promise.finally(() => {
    if (activeTokenRequestPromise === tracked) {
      activeTokenRequestPromise = null;
    }
  });
  activeTokenRequestPromise = tracked;

  return tracked;
}

/** 撤銷 Google OAuth Token 授權（僅於使用者明確確認撤銷授權時呼叫）。 */
export async function revokeGoogleAccessToken(accessToken: string): Promise<void> {
  if (!accessToken) return;
  const revokeFn =
    typeof window !== "undefined" ? window.google?.accounts?.oauth2?.revoke : undefined;
  if (typeof revokeFn !== "function") {
    clearCachedGoogleAccessToken();
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 5_000);
    try {
      revokeFn(accessToken, () => {
        if (settled) return;
        settled = true;
        clearCachedGoogleAccessToken();
        clearTimeout(timer);
        resolve();
      });
    } catch {
      if (!settled) {
        settled = true;
        clearCachedGoogleAccessToken();
        clearTimeout(timer);
        resolve();
      }
    }
  });
}

/** 透過 Google Identity Services 彈窗取得有效的 Drive Access Token（相容既有介面）。 */
export async function requestGoogleDriveAccessToken(
  clientId: string,
  options?: { forcePrompt?: boolean },
): Promise<string> {
  const now = Date.now();
  if (
    !options?.forcePrompt &&
    cachedAccessToken &&
    now < cachedTokenExpiresAt - 60_000 &&
    cachedGrantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)
  ) {
    return cachedAccessToken;
  }

  const result = await requestGoogleAccessTokenWithMetadata(clientId, {
    forcePrompt: options?.forcePrompt,
    prompt: options?.forcePrompt ? "consent" : cachedAccessToken ? "" : "select_account",
  });
  return result.accessToken;
}

/** 開啟 Google Picker 視窗讓使用者挑選雲端硬碟（含他人共享與 Shared Drives）的音檔。 */
export function openGoogleDrivePicker(params: {
  accessToken: string;
  apiKey: string;
  appId?: string;
  multiple?: boolean;
}): Promise<PickedDriveFile[]> {
  if (activePickerPromise) {
    return activePickerPromise;
  }
  const pickerApi = typeof window !== "undefined" ? window.google?.picker : undefined;
  if (!pickerApi) {
    return Promise.reject(new Error("Google Picker 尚未載入完成。"));
  }

  const promise = new Promise<PickedDriveFile[]>((resolve, reject) => {
    try {
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
              resourceKey: typeof doc.resourceKey === "string" && doc.resourceKey ? doc.resourceKey : undefined,
              driveId: typeof doc.driveId === "string" && doc.driveId ? doc.driveId : undefined,
              webViewLink: typeof doc.url === "string" && doc.url ? doc.url : undefined,
              modifiedTime:
                typeof doc.lastEditedUtc === "number" && Number.isFinite(doc.lastEditedUtc)
                  ? new Date(doc.lastEditedUtc).toISOString()
                  : undefined,
              md5Checksum: typeof doc.md5Checksum === "string" && doc.md5Checksum ? doc.md5Checksum : undefined,
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
    } catch (err) {
      reject(err instanceof Error ? err : new Error("無法開啟 Google Picker 視窗。"));
    }
  });

  const tracked = promise.finally(() => {
    if (activePickerPromise === tracked) {
      activePickerPromise = null;
    }
  });
  activePickerPromise = tracked;

  return tracked;
}

async function readResponseBlobWithProgress(
  response: Response,
  expectedTotalBytes: number | null,
  onLoaded: (loadedBytes: number, totalBytes: number | null) => void,
  options?: { maxBytes?: number; signal?: AbortSignal; throttleMs?: number },
): Promise<Blob> {
  const maxBytes = options?.maxBytes;
  const throttleMs = options?.throttleMs ?? 100;

  if (!response.body) {
    const blob = await response.blob();
    if (maxBytes && blob.size > maxBytes) {
      throw new Error(`音檔大小超過本次安全下載上限（${(maxBytes / (1024 * 1024)).toFixed(0)} MiB）。`);
    }
    onLoaded(blob.size, expectedTotalBytes ?? blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  let lastEmitAt = 0;

  try {
    while (true) {
      if (options?.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("已取消 Google Drive 下載。", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        loaded += value.byteLength;
        if (maxBytes && loaded > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(
            `已接收位元組（${(loaded / (1024 * 1024)).toFixed(1)} MiB）超過安全下載上限（${(maxBytes / (1024 * 1024)).toFixed(0)} MiB），已安全中止下載。`,
          );
        }
        const chunkBytes = new Uint8Array(value.byteLength);
        chunkBytes.set(value);
        chunks.push(chunkBytes);
        const now = Date.now();
        if (now - lastEmitAt >= throttleMs) {
          lastEmitAt = now;
          onLoaded(loaded, expectedTotalBytes);
        }
      }
    }
    onLoaded(loaded, expectedTotalBytes);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
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
  resourceKey?: string;
  signal?: AbortSignal;
  maxBytes?: number;
  throttleMs?: number;
  onProgress?: (progress: DriveDownloadProgress) => void;
}): Promise<File> {
  const { file, accessToken, fileIndex, totalFiles, onProgress } = params;
  const effectiveResourceKey = params.resourceKey ?? file.resourceKey;
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (effectiveResourceKey) {
    headers["X-Goog-Drive-Resource-Keys"] = `${file.id}/${effectiveResourceKey}`;
  }

  const response = await fetch(url, {
    headers,
    signal: params.signal,
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

  if (params.maxBytes && totalBytes && totalBytes > params.maxBytes) {
    throw new Error(
      `「${file.name}」大小（${(totalBytes / (1024 * 1024)).toFixed(1)} MiB）超過安全下載上限，已取消下載。`,
    );
  }

  onProgress?.({
    fileIndex,
    totalFiles,
    fileName: file.name,
    loadedBytes: 0,
    totalBytes,
  });

  const blob = await readResponseBlobWithProgress(
    response,
    totalBytes,
    (loaded, total) => {
      onProgress?.({
        fileIndex,
        totalFiles,
        fileName: file.name,
        loadedBytes: loaded,
        totalBytes: total,
      });
    },
    {
      maxBytes: params.maxBytes,
      signal: params.signal,
      throttleMs: params.throttleMs,
    },
  );

  const resolvedType =
    file.mimeType && file.mimeType !== "application/octet-stream"
      ? file.mimeType
      : blob.type || "audio/mpeg";

  return new File([blob], file.name, {
    type: resolvedType,
    lastModified: file.modifiedTime ? Date.parse(file.modifiedTime) || Date.now() : Date.now(),
  });
}

/** 完整互動流程：載入 SDK → 授權 → 開啟 Picker → 逐首下載成 File[]。 */
export async function pickAndDownloadGoogleDriveAudioFiles(options?: {
  multiple?: boolean;
  signal?: AbortSignal;
  onStageChange?: (stage: "sdk" | "auth" | "picker" | "downloading") => void;
  onProgress?: (progress: DriveDownloadProgress) => void;
}): Promise<File[]> {
  const config = getGoogleDriveConfig();
  if (!config.clientId || !config.apiKey) {
    throw new Error(
      "尚未設定 NEXT_PUBLIC_GOOGLE_CLIENT_ID 或 NEXT_PUBLIC_GOOGLE_API_KEY 環境變數。",
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
      signal: options?.signal,
      onProgress: options?.onProgress,
    });
    downloaded.push(file);
  }

  return downloaded;
}
