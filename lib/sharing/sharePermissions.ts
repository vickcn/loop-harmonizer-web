import { mapResponseToDriveError } from "../google/driveClient.ts";

export type DrivePermission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: string;
  emailAddress?: string;
  allowFileDiscovery?: boolean;
  deleted?: boolean;
  permissionDetails?: Array<{ inherited?: boolean; inheritedFrom?: string; role?: string }>;
};

export async function createDriveReaderPermission(params: {
  fileId: string;
  accessToken: string;
  type: "user" | "group" | "anyone";
  emailAddress?: string;
  sendNotificationEmail?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DrivePermission> {
  if ((params.type === "user" || params.type === "group") && !params.emailAddress?.trim()) {
    throw new Error("指定對象分享需要有效的 Google 帳號 Email。");
  }
  const query = new URLSearchParams({ supportsAllDrives: "true", fields: "id,type,role,emailAddress,allowFileDiscovery,deleted,permissionDetails" });
  if (params.type !== "anyone") {
    query.set("sendNotificationEmail", params.sendNotificationEmail === false ? "false" : "true");
  }
  const response = await (params.fetchImpl ?? globalThis.fetch)(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}/permissions?${query}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${params.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: params.type,
        role: "reader",
        ...(params.emailAddress ? { emailAddress: params.emailAddress.trim() } : {}),
        ...(params.type === "anyone" ? { allowFileDiscovery: false } : {}),
      }),
      signal: params.signal,
    },
  );
  if (!response.ok) throw await mapResponseToDriveError(response, params.fileId);
  return (await response.json()) as DrivePermission;
}

export async function listDrivePermissions(params: {
  fileId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DrivePermission[]> {
  const out: DrivePermission[] = [];
  let pageToken = "";
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({
      supportsAllDrives: "true",
      pageSize: "100",
      fields: "nextPageToken,permissions(id,type,role,emailAddress,allowFileDiscovery,deleted,permissionDetails)",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await (params.fetchImpl ?? globalThis.fetch)(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}/permissions?${query}`,
      { headers: { Authorization: `Bearer ${params.accessToken}` }, signal: params.signal },
    );
    if (!response.ok) throw await mapResponseToDriveError(response, params.fileId);
    const data = (await response.json()) as { permissions?: DrivePermission[]; nextPageToken?: string };
    out.push(...(data.permissions ?? []));
    const next = data.nextPageToken ?? "";
    if (next && seen.has(next)) throw new Error("Google Drive Permission 分頁 Token 重複，無法安全確認完整權限。");
    if (next) seen.add(next);
    pageToken = next;
  } while (pageToken);
  return out;
}

export async function deleteDrivePermission(params: {
  fileId: string;
  permissionId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const response = await (params.fetchImpl ?? globalThis.fetch)(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}/permissions/${encodeURIComponent(params.permissionId)}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${params.accessToken}` }, signal: params.signal },
  );
  if (!response.ok && response.status !== 404) {
    throw await mapResponseToDriveError(response, params.permissionId);
  }
}

export function isExternalSharePermission(permission: DrivePermission): boolean {
  if (permission.deleted || permission.role === "owner" || permission.role === "organizer") return false;
  return permission.type === "user" || permission.type === "group" || permission.type === "domain" || permission.type === "anyone";
}

export function isInheritedPermission(permission: DrivePermission): boolean {
  return Boolean(permission.permissionDetails?.some((detail) => detail.inherited));
}
