export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "profile", "email"] as const;
export const GOOGLE_REQUESTED_SCOPES = [
  GOOGLE_DRIVE_FILE_SCOPE,
  ...GOOGLE_IDENTITY_SCOPES,
].join(" ");

export type GoogleAuthStatus =
  | "unconfigured"
  | "signed_out"
  | "authorizing"
  | "signed_in"
  | "expired"
  | "revoked"
  | "switching"
  | "error";

export type GoogleSdkReadinessState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export type GoogleAccount = {
  accountId: string;
  email?: string;
  displayName?: string;
  picture?: string;
};

export interface GoogleAuthSnapshot {
  status: GoogleAuthStatus;
  account: GoogleAccount | null;
  grantedScopes: string[];
  expiresAt: number | null;
  generation: number;
  errorMessage: string | null;
  sdkState: GoogleSdkReadinessState;
  missingConfigFields: string[];
}

export interface GoogleDriveConfigStatus {
  configured: boolean;
  clientId: string;
  apiKey: string;
  appId: string;
  missingFields: string[];
  message: string | null;
}
