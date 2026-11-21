import {
  lookupCanonicalAccountIdForDrivePermission,
  saveVerifiedAccountIdentityLink,
} from "../storage/projectStore.ts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_REQUESTED_SCOPES,
  type GoogleAccount,
  type GoogleAuthSnapshot,
  type GoogleAuthStatus,
  type GoogleSdkReadinessState,
} from "./googleAuthTypes.ts";
import {
  clearCachedGoogleAccessToken,
  ensureGooglePickerSdkLoaded,
  getGoogleDriveConfigStatus,
  getGoogleSdkReadiness,
  preloadGoogleSdk,
  requestGoogleAccessTokenWithMetadata,
  revokeGoogleAccessToken,
  subscribeGoogleSdkReadiness,
  type TokenGrantResult,
} from "./googleDrivePicker.ts";

export type AccountSessionEndReason = "signed_out" | "revoked" | "switched" | "expired";

export interface GoogleAccountManagerDeps {
  getConfigStatus?: typeof getGoogleDriveConfigStatus;
  ensureSdkLoaded?: (options?: { timeoutMs?: number }) => Promise<void>;
  getSdkReadiness?: () => GoogleSdkReadinessState;
  subscribeSdkReadiness?: (listener: (state: GoogleSdkReadinessState) => void) => () => void;
  requestAccessToken?: (
    clientId: string,
    options?: {
      forcePrompt?: boolean;
      prompt?: "" | "select_account" | "consent";
      hint?: string;
      scope?: string;
    },
  ) => Promise<TokenGrantResult>;
  revokeToken?: (token: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TOKEN_EXPIRY_SAFETY_BUFFER_MS = 60_000;

async function fetchGoogleUserAccount(
  accessToken: string,
  grantedScopes: string[],
  fetchImpl: typeof fetch,
): Promise<GoogleAccount> {
  if (grantedScopes.includes("openid") || grantedScopes.includes("profile") || grantedScopes.includes("email")) {
    try {
      const userInfoRes = await fetchImpl("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (userInfoRes.ok) {
        const data = (await userInfoRes.json()) as {
          sub?: string;
          email?: string;
          name?: string;
          picture?: string;
        };
        if (typeof data.sub === "string" && data.sub.trim()) {
          const sub = data.sub.trim();
          const canonicalId = `google:${sub}`;
          let drivePermissionId: string | undefined;

          // 嘗試以同一組有效 Token 查得 Drive permissionId 建立經驗證對應（僅此 token 成功才建立，絕不依 email 自動合併）
          try {
            const aboutPairRes = await fetchImpl(
              "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)",
              {
                headers: { Authorization: `Bearer ${accessToken}` },
              },
            );
            if (aboutPairRes.ok) {
              const pairJson = (await aboutPairRes.json()) as {
                user?: { permissionId?: string };
              };
              const pid = pairJson.user?.permissionId?.trim();
              if (pid) {
                drivePermissionId = pid;
                await saveVerifiedAccountIdentityLink(canonicalId, `drive:${pid}`).catch(
                  () => undefined,
                );
              }
            }
          } catch {
            // 僅輔助建立對應，失敗不阻斷登入
          }

          return {
            accountId: canonicalId,
            email: typeof data.email === "string" ? data.email : undefined,
            displayName: typeof data.name === "string" ? data.name : undefined,
            picture: typeof data.picture === "string" ? data.picture : undefined,
            googleSub: sub,
            drivePermissionId,
            identitySource: drivePermissionId ? "verified_pair" : "oidc_sub",
          };
        }
      }
    } catch {
      // fallback to Drive about.get
    }
  }

  const aboutRes = await fetchImpl(
    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!aboutRes.ok) {
    throw new Error(`無法驗證 Google 帳戶識別資訊（HTTP ${aboutRes.status}）。`);
  }
  const aboutJson = (await aboutRes.json()) as {
    user?: {
      permissionId?: string;
      displayName?: string;
      emailAddress?: string;
      photoLink?: string;
    };
  };
  const permissionId = aboutJson.user?.permissionId?.trim();
  if (!permissionId) {
    throw new Error("Google API 未回傳穩定的帳戶識別碼（sub / permissionId），無法建立安全帳戶隔離。");
  }
  const fallbackId = `drive:${permissionId}`;
  const linkedCanonicalId = await lookupCanonicalAccountIdForDrivePermission(fallbackId).catch(
    () => null,
  );
  const resolvedId = linkedCanonicalId ?? fallbackId;
  return {
    accountId: resolvedId,
    email: aboutJson.user?.emailAddress,
    displayName: aboutJson.user?.displayName,
    picture: aboutJson.user?.photoLink,
    googleSub: linkedCanonicalId ? linkedCanonicalId.slice("google:".length) : undefined,
    drivePermissionId: permissionId,
    identitySource: linkedCanonicalId ? "verified_pair" : "drive_permission_id",
  };
}

export class GoogleAccountManager {
  private readonly deps: Required<GoogleAccountManagerDeps>;
  private accessToken: string | null = null;
  private snapshot: GoogleAuthSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly sessionEndListeners = new Set<
    (info: { reason: AccountSessionEndReason; previousAccountId: string | null; nextAccountId: string | null }) => void
  >();
  private sdkUnsubscribe: (() => void) | null = null;
  private authInFlight: Promise<GoogleAuthSnapshot> | null = null;

  constructor(deps: GoogleAccountManagerDeps = {}) {
    this.deps = {
      getConfigStatus: deps.getConfigStatus ?? getGoogleDriveConfigStatus,
      ensureSdkLoaded: deps.ensureSdkLoaded ?? ensureGooglePickerSdkLoaded,
      getSdkReadiness: deps.getSdkReadiness ?? getGoogleSdkReadiness,
      subscribeSdkReadiness: deps.subscribeSdkReadiness ?? subscribeGoogleSdkReadiness,
      requestAccessToken: deps.requestAccessToken ?? requestGoogleAccessTokenWithMetadata,
      revokeToken: deps.revokeToken ?? revokeGoogleAccessToken,
      fetchImpl: deps.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
      now: deps.now ?? (() => Date.now()),
    };
    this.snapshot = this.buildInitialSnapshot();
    this.sdkUnsubscribe = this.deps.subscribeSdkReadiness((sdkState) => {
      if (this.snapshot.sdkState !== sdkState) {
        this.updateSnapshot({ ...this.snapshot, sdkState });
      }
    });
  }

  private buildInitialSnapshot(): GoogleAuthSnapshot {
    const cfg = this.deps.getConfigStatus();
    return {
      status: cfg.configured ? "signed_out" : "unconfigured",
      account: null,
      grantedScopes: [],
      expiresAt: null,
      generation: 1,
      errorMessage: null,
      sdkState: this.deps.getSdkReadiness(),
      missingConfigFields: cfg.missingFields,
    };
  }

  private updateSnapshot(next: GoogleAuthSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitSessionEnd(
    reason: AccountSessionEndReason,
    previousAccountId: string | null,
    nextAccountId: string | null,
  ): void {
    for (const listener of this.sessionEndListeners) {
      try {
        listener({ reason, previousAccountId, nextAccountId });
      } catch {
        // ignore listener errors
      }
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): GoogleAuthSnapshot => {
    return this.snapshot;
  };

  onAccountSessionEnd(
    listener: (info: { reason: AccountSessionEndReason; previousAccountId: string | null; nextAccountId: string | null }) => void,
  ): () => void {
    this.sessionEndListeners.add(listener);
    return () => {
      this.sessionEndListeners.delete(listener);
    };
  }

  refreshConfigStatus(): GoogleAuthSnapshot {
    const cfg = this.deps.getConfigStatus();
    const nextStatus: GoogleAuthStatus = cfg.configured
      ? (this.snapshot.status === "unconfigured" ? "signed_out" : this.snapshot.status)
      : "unconfigured";
    const next: GoogleAuthSnapshot = {
      ...this.snapshot,
      status: nextStatus,
      missingConfigFields: cfg.missingFields,
      sdkState: this.deps.getSdkReadiness(),
    };
    if (
      next.status !== this.snapshot.status ||
      next.sdkState !== this.snapshot.sdkState ||
      next.missingConfigFields.join(",") !== this.snapshot.missingConfigFields.join(",")
    ) {
      this.updateSnapshot(next);
    }
    return this.snapshot;
  }

  async prepareSdk(): Promise<void> {
    const cfg = this.deps.getConfigStatus();
    if (!cfg.configured) return;
    await this.deps.ensureSdkLoaded();
  }

  isGenerationValid(generation: number, expectedAccountId?: string): boolean {
    if (this.snapshot.generation !== generation) return false;
    if (this.snapshot.status !== "signed_in" || !this.accessToken) return false;
    if (expectedAccountId && this.snapshot.account?.accountId !== expectedAccountId) return false;
    return true;
  }

  getValidAccessToken(expectedAccountId?: string): string | null {
    if (this.snapshot.status !== "signed_in" || !this.accessToken) {
      return null;
    }
    if (expectedAccountId && this.snapshot.account?.accountId !== expectedAccountId) {
      return null;
    }
    if (
      this.snapshot.expiresAt !== null &&
      this.deps.now() >= this.snapshot.expiresAt - TOKEN_EXPIRY_SAFETY_BUFFER_MS
    ) {
      this.markTokenExpired(this.snapshot.generation, "Google 授權已過期，請重新授權後繼續。");
      return null;
    }
    return this.accessToken;
  }

  markTokenExpired(expectedGeneration?: number, message = "Google 授權已過期，請重新授權後再試。"): void {
    if (typeof expectedGeneration === "number" && expectedGeneration !== this.snapshot.generation) {
      return;
    }
    if (this.snapshot.status === "signed_out" || this.snapshot.status === "revoked" || this.snapshot.status === "unconfigured") {
      return;
    }
    const previousAccountId = this.snapshot.account?.accountId ?? null;
    this.accessToken = null;
    clearCachedGoogleAccessToken();
    this.updateSnapshot({
      ...this.snapshot,
      status: "expired",
      expiresAt: null,
      errorMessage: message,
    });
    if (previousAccountId) {
      this.emitSessionEnd("expired", previousAccountId, previousAccountId);
    }
  }

  async signIn(options?: {
    prompt?: "" | "select_account" | "consent";
    hint?: string;
    mode?: "sign_in" | "switch" | "reauthorize";
  }): Promise<GoogleAuthSnapshot> {
    if (this.authInFlight && options?.mode !== "switch") {
      return this.authInFlight;
    }

    const cfg = this.deps.getConfigStatus();
    if (!cfg.configured) {
      const next: GoogleAuthSnapshot = {
        ...this.snapshot,
        status: "unconfigured",
        missingConfigFields: cfg.missingFields,
        errorMessage: cfg.message,
      };
      this.updateSnapshot(next);
      throw new Error(cfg.message ?? "尚未設定 Google OAuth 環境變數。");
    }

    const previousSnapshot = this.snapshot;
    const previousToken = this.accessToken;
    const previousAccountId = previousSnapshot.account?.accountId ?? null;
    const mode = options?.mode ?? "sign_in";
    const startGeneration = this.snapshot.generation + 1;

    const run = (async () => {
      this.updateSnapshot({
        ...this.snapshot,
        status: mode === "switch" ? "switching" : "authorizing",
        generation: startGeneration,
        errorMessage: null,
        missingConfigFields: [],
      });

      try {
        await this.deps.ensureSdkLoaded();
        if (this.snapshot.generation !== startGeneration) {
          throw new Error("登入工作階段已變更，已忽略過期授權結果。");
        }

        const grant = await this.deps.requestAccessToken(cfg.clientId, {
          prompt:
            options?.prompt ??
            (mode === "reauthorize" ? "consent" : "select_account"),
          hint: options?.hint,
          scope: GOOGLE_REQUESTED_SCOPES,
        });

        if (this.snapshot.generation !== startGeneration) {
          throw new Error("登入工作階段已變更，已忽略過期授權結果。");
        }

        const account = await fetchGoogleUserAccount(
          grant.accessToken,
          grant.grantedScopes,
          this.deps.fetchImpl,
        );

        if (this.snapshot.generation !== startGeneration) {
          throw new Error("登入工作階段已變更，已忽略過期授權結果。");
        }

        if (!grant.grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
          throw new Error("未授予 Google Drive 檔案權限（drive.file），已保留本機模式。");
        }

        const switchedAccount = Boolean(previousAccountId && previousAccountId !== account.accountId);
        if (switchedAccount) {
          this.emitSessionEnd("switched", previousAccountId, account.accountId);
        }

        const nextGeneration = startGeneration + 1;
        this.accessToken = grant.accessToken;
        const expiresAt = this.deps.now() + grant.expiresInSec * 1000;
        const nextSnapshot: GoogleAuthSnapshot = {
          status: "signed_in",
          account,
          grantedScopes: [...grant.grantedScopes],
          expiresAt,
          generation: nextGeneration,
          errorMessage: null,
          sdkState: "ready",
          missingConfigFields: [],
        };
        this.updateSnapshot(nextSnapshot);
        return nextSnapshot;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Google 登入失敗。";
        const isUserCancel = /取消|popup_closed/i.test(message);

        if (this.snapshot.generation === startGeneration) {
          if (isUserCancel && previousToken && previousSnapshot.status === "signed_in" && previousSnapshot.account) {
            this.accessToken = previousToken;
            this.updateSnapshot({
              ...previousSnapshot,
              generation: startGeneration + 1,
              errorMessage: null,
            });
          } else if (isUserCancel && previousSnapshot.status === "expired" && previousSnapshot.account) {
            this.accessToken = null;
            this.updateSnapshot({
              ...previousSnapshot,
              generation: startGeneration + 1,
              errorMessage: message,
            });
          } else {
            this.accessToken = null;
            clearCachedGoogleAccessToken();
            this.updateSnapshot({
              ...this.snapshot,
              status: isUserCancel
                ? (previousSnapshot.status === "revoked" ? "revoked" : "signed_out")
                : "error",
              account: isUserCancel ? null : this.snapshot.account,
              grantedScopes: isUserCancel ? [] : this.snapshot.grantedScopes,
              expiresAt: isUserCancel ? null : this.snapshot.expiresAt,
              generation: startGeneration + 1,
              errorMessage: message,
              sdkState: this.deps.getSdkReadiness(),
            });
          }
        }
        throw err;
      }
    })();

    const tracked = run.finally(() => {
      if (this.authInFlight === tracked) {
        this.authInFlight = null;
      }
    });
    this.authInFlight = tracked;

    return tracked;
  }

  async reauthorize(): Promise<GoogleAuthSnapshot> {
    return this.signIn({
      prompt: "consent",
      hint: this.snapshot.account?.email,
      mode: "reauthorize",
    });
  }

  async switchAccount(): Promise<GoogleAuthSnapshot> {
    return this.signIn({
      prompt: "select_account",
      mode: "switch",
    });
  }

  /** 登出此應用程式：僅清除記憶體中 Token 與中止本帳戶傳輸，不撤銷 Google OAuth grant，亦不刪除本機或 Drive 檔案。 */
  signOut(): void {
    const prevAccountId = this.snapshot.account?.accountId ?? null;
    this.authInFlight = null;
    this.accessToken = null;
    clearCachedGoogleAccessToken();
    const cfg = this.deps.getConfigStatus();
    this.updateSnapshot({
      status: cfg.configured ? "signed_out" : "unconfigured",
      account: null,
      grantedScopes: [],
      expiresAt: null,
      generation: this.snapshot.generation + 1,
      errorMessage: null,
      sdkState: this.deps.getSdkReadiness(),
      missingConfigFields: cfg.missingFields,
    });
    if (prevAccountId) {
      this.emitSessionEnd("signed_out", prevAccountId, null);
    }
  }

  /** 撤銷 Google 授權：須經使用者明確確認後呼叫，撤銷 OAuth grant 並清空工作階段。 */
  async revokeAuthorization(): Promise<void> {
    const prevAccountId = this.snapshot.account?.accountId ?? null;
    const token = this.accessToken;
    this.authInFlight = null;
    this.accessToken = null;
    clearCachedGoogleAccessToken();
    try {
      if (token) {
        await this.deps.revokeToken(token);
      }
    } finally {
      const cfg = this.deps.getConfigStatus();
      this.updateSnapshot({
        status: cfg.configured ? "revoked" : "unconfigured",
        account: null,
        grantedScopes: [],
        expiresAt: null,
        generation: this.snapshot.generation + 1,
        errorMessage: null,
        sdkState: this.deps.getSdkReadiness(),
        missingConfigFields: cfg.missingFields,
      });
      if (prevAccountId) {
        this.emitSessionEnd("revoked", prevAccountId, null);
      }
    }
  }

  dispose(): void {
    this.sdkUnsubscribe?.();
    this.sdkUnsubscribe = null;
    this.listeners.clear();
    this.sessionEndListeners.clear();
  }
}

export const sharedGoogleAccountManager = new GoogleAccountManager();

export { preloadGoogleSdk };
