import { mapResponseToDriveError } from "../google/driveClient.ts";
import type { ProjectShareVisibility, ShareAclReconciliationResult } from "./shareTypes.ts";

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

function normalizeEmails(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))));
}

export function evaluateShareAcl(params: {
  permissions: readonly DrivePermission[];
  visibility: Exclude<ProjectShareVisibility, "private">;
  recipientEmails?: readonly string[];
}): ShareAclReconciliationResult {
  const desiredEmails = new Set(normalizeEmails(params.recipientEmails ?? []));
  const direct = params.permissions.filter((permission) => isExternalSharePermission(permission) && !isInheritedPermission(permission));
  const inherited = params.permissions.filter((permission) => isExternalSharePermission(permission) && isInheritedPermission(permission));
  const anyone = direct.filter((permission) => permission.type === "anyone" && permission.role === "reader");
  const recipients = direct
    .filter((permission) => (permission.type === "user" || permission.type === "group") && permission.role === "reader" && permission.emailAddress)
    .map((permission) => ({
      email: permission.emailAddress!.trim().toLowerCase(),
      permissionId: permission.id,
      role: "reader" as const,
      type: permission.type as "user" | "group",
      createdAt: new Date().toISOString(),
    }));
  const actualEmails = new Set(recipients.map((recipient) => recipient.email));
  const exactRestricted = params.visibility === "restricted"
    && anyone.length === 0
    && direct.every((permission) => (permission.type === "user" || permission.type === "group") && permission.role === "reader" && Boolean(permission.emailAddress))
    && desiredEmails.size === actualEmails.size
    && [...desiredEmails].every((email) => actualEmails.has(email));
  const exactLink = params.visibility === "link"
    && anyone.length === 1
    && direct.length === 1
    && anyone[0].allowFileDiscovery !== true;
  return {
    verification: inherited.length > 0 ? "incomplete" : exactRestricted || exactLink ? "verified" : "mismatch",
    recipients,
    anyonePermissionId: anyone[0]?.id,
    permissions: params.permissions.filter(isExternalSharePermission).map((permission) => ({
      id: permission.id,
      type: permission.type,
      role: permission.role,
      emailAddress: permission.emailAddress,
      inherited: isInheritedPermission(permission),
    })),
    addedPermissionIds: [],
    removedPermissionIds: [],
  };
}

/** 先新增並確認，再移除舊 ACL；任何部分成功都以重新讀取的遠端 ACL 為準。 */
export async function reconcileSharePermissions(params: {
  fileId: string;
  accessToken: string;
  visibility: Exclude<ProjectShareVisibility, "private">;
  recipientEmails?: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ShareAclReconciliationResult> {
  const desiredEmails = normalizeEmails(params.recipientEmails ?? []);
  if (params.visibility === "restricted" && desiredEmails.length === 0) {
    throw new Error("指定對象分享至少需要一個有效的 Google 帳號 Email。");
  }
  const before = await listDrivePermissions(params);
  const addedPermissionIds: string[] = [];
  const currentDirect = before.filter((permission) => isExternalSharePermission(permission) && !isInheritedPermission(permission));
  if (params.visibility === "link") {
    if (!currentDirect.some((permission) => permission.type === "anyone" && permission.role === "reader" && permission.allowFileDiscovery !== true)) {
      const created = await createDriveReaderPermission({ ...params, fileId: params.fileId, type: "anyone", sendNotificationEmail: false });
      addedPermissionIds.push(created.id);
    }
  } else {
    for (const email of desiredEmails) {
      const existing = currentDirect.find((permission) => permission.role === "reader" && permission.emailAddress?.trim().toLowerCase() === email);
      if (!existing) {
        const created = await createDriveReaderPermission({ ...params, fileId: params.fileId, type: "user", emailAddress: email });
        addedPermissionIds.push(created.id);
      }
    }
  }
  const afterAdds = await listDrivePermissions(params);
  const addCheck = evaluateShareAcl({ permissions: afterAdds, visibility: params.visibility, recipientEmails: desiredEmails });
  const additionsPresent = params.visibility === "link"
    ? afterAdds.some((permission) => permission.type === "anyone" && permission.role === "reader")
    : desiredEmails.every((email) => afterAdds.some((permission) => permission.role === "reader" && permission.emailAddress?.trim().toLowerCase() === email));
  if (!additionsPresent) {
    return { ...addCheck, verification: "incomplete", addedPermissionIds, removedPermissionIds: [] };
  }
  const desiredIds = new Set<string>();
  for (const permission of afterAdds) {
    if (isInheritedPermission(permission) || !isExternalSharePermission(permission)) continue;
    if (params.visibility === "link" && permission.type === "anyone" && permission.role === "reader") desiredIds.add(permission.id);
    if (params.visibility === "restricted" && permission.role === "reader" && permission.emailAddress && desiredEmails.includes(permission.emailAddress.trim().toLowerCase())) desiredIds.add(permission.id);
  }
  const removedPermissionIds: string[] = [];
  for (const permission of afterAdds) {
    if (!isExternalSharePermission(permission) || isInheritedPermission(permission) || desiredIds.has(permission.id)) continue;
    await deleteDrivePermission({ ...params, fileId: params.fileId, permissionId: permission.id });
    removedPermissionIds.push(permission.id);
  }
  const finalPermissions = await listDrivePermissions(params);
  const evaluated = evaluateShareAcl({ permissions: finalPermissions, visibility: params.visibility, recipientEmails: desiredEmails });
  return { ...evaluated, addedPermissionIds, removedPermissionIds };
}
