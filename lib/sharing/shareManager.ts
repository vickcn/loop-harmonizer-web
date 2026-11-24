import { downloadDriveJson, moveDriveFile, uploadDriveMultipartJson } from "../google/driveClient.ts";
import { ensureShareRevisionFolder } from "../google/driveFolderManager.ts";
import type { PersistedProjectRecord } from "../projects/projectTypes.ts";
import {
  PROJECT_SHARE_ACCOUNT_INDEX,
  PROJECT_SHARE_SOURCE_INDEX,
  idbGet,
  idbGetAll,
  idbRequestPromise,
  withIdbTransaction,
} from "../storage/indexedDb.ts";
import { copyPreparedShareSong, runProjectSharePreflight } from "./shareArtifactManager.ts";
import { buildProjectShareManifest, buildProjectSharePointer, validateProjectSharePointer } from "./shareManifest.ts";
import {
  createDriveReaderPermission,
  deleteDrivePermission,
  isExternalSharePermission,
  isInheritedPermission,
  listDrivePermissions,
} from "./sharePermissions.ts";
import {
  PROJECT_SHARE_SCHEMA_VERSION,
  type ProjectShareRecord,
  type ProjectShareVisibility,
  type ShareRevokeResult,
} from "./shareTypes.ts";

function makeId(prefix: string): string {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id}`;
}

export function buildProjectShareUrl(record: Pick<ProjectShareRecord, "shareId" | "shareManifestFileId">, origin = "https://loop-harmonizer-web.vercel.app"): string | null {
  if (!record.shareManifestFileId) return null;
  const url = new URL(`/share/${encodeURIComponent(record.shareId)}`, origin);
  url.searchParams.set("file", record.shareManifestFileId);
  return url.toString();
}

export async function saveProjectShareRecord(record: ProjectShareRecord): Promise<ProjectShareRecord> {
  const normalized = { ...record, key: record.shareId, updatedAt: new Date().toISOString() };
  await withIdbTransaction("projectShares", "readwrite", async (tx) => {
    await idbRequestPromise(tx.objectStore("projectShares").put(normalized));
  });
  return normalized;
}

export async function getProjectShareRecord(shareId: string): Promise<ProjectShareRecord | null> {
  return idbGet<ProjectShareRecord>("projectShares", shareId);
}

export async function listProjectShareRecords(): Promise<ProjectShareRecord[]> {
  return idbGetAll<ProjectShareRecord>("projectShares").catch(() => []);
}

export async function listProjectSharesBySourceProject(sourceProjectId: string): Promise<ProjectShareRecord[]> {
  return withIdbTransaction("projectShares", "readonly", async (tx) => {
    const store = tx.objectStore("projectShares");
    if (typeof store.index === "function" && (!store.indexNames || store.indexNames.contains(PROJECT_SHARE_SOURCE_INDEX))) {
      return (await idbRequestPromise(store.index(PROJECT_SHARE_SOURCE_INDEX).getAll(sourceProjectId))) as ProjectShareRecord[];
    }
    return ((await idbRequestPromise(store.getAll())) as ProjectShareRecord[]).filter((r) => r.sourceProjectId === sourceProjectId);
  });
}

export async function listProjectSharesByOwner(ownerAccountId: string): Promise<ProjectShareRecord[]> {
  return withIdbTransaction("projectShares", "readonly", async (tx) => {
    const store = tx.objectStore("projectShares");
    if (typeof store.index === "function" && (!store.indexNames || store.indexNames.contains(PROJECT_SHARE_ACCOUNT_INDEX))) {
      return (await idbRequestPromise(store.index(PROJECT_SHARE_ACCOUNT_INDEX).getAll(ownerAccountId))) as ProjectShareRecord[];
    }
    return ((await idbRequestPromise(store.getAll())) as ProjectShareRecord[]).filter((r) => r.ownerAccountId === ownerAccountId);
  });
}

/** 共享專用副本採獨立生命週期；停止分享也不會自動刪除。 */
export function canGarbageCollectShareFolder(
  share: ProjectShareRecord,
  options?: { explicitUserConfirmation?: boolean; referencedByOtherShare?: boolean },
): { allowed: boolean; reason?: string } {
  if (!options?.explicitUserConfirmation) {
    return { allowed: false, reason: "共享副本需要獨立確認，不隨私人專案 GC 自動刪除。" };
  }
  if (options.referencedByOtherShare) {
    return { allowed: false, reason: "仍有其他共享版本引用此成果。" };
  }
  if (share.status !== "revoked") {
    return { allowed: false, reason: "分享仍有效或狀態未完成，禁止清除共享成果。" };
  }
  if (share.requiresPermissionRepair) {
    return { allowed: false, reason: "外部權限尚未完全撤銷，禁止清除共享成果。" };
  }
  return { allowed: true };
}

async function clearDirectExternalPermissions(params: {
  folderId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const before = await listDrivePermissions({ ...params, fileId: params.folderId });
  for (const permission of before) {
    if (!isExternalSharePermission(permission) || isInheritedPermission(permission)) continue;
    await deleteDrivePermission({ ...params, fileId: params.folderId, permissionId: permission.id });
  }
  return before;
}

async function applySharePermissions(params: {
  folderId: string;
  accessToken: string;
  visibility: Exclude<ProjectShareVisibility, "private">;
  recipientEmails: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  await clearDirectExternalPermissions(params);
  const recipients = [];
  let anyonePermissionId: string | undefined;
  if (params.visibility === "link") {
    const permission = await createDriveReaderPermission({ ...params, fileId: params.folderId, type: "anyone", sendNotificationEmail: false });
    anyonePermissionId = permission.id;
  } else {
    const unique = Array.from(new Set(params.recipientEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
    if (unique.length === 0) throw new Error("指定對象分享至少需要一個 Google 帳號 Email。");
    for (const email of unique) {
      const permission = await createDriveReaderPermission({ ...params, fileId: params.folderId, type: "user", emailAddress: email });
      recipients.push({ email, permissionId: permission.id, role: "reader" as const, type: "user" as const, createdAt: new Date().toISOString() });
    }
  }
  const verified = await listDrivePermissions({ ...params, fileId: params.folderId });
  if (params.visibility === "link" && !verified.some((p) => p.id === anyonePermissionId && p.type === "anyone" && p.role === "reader")) {
    throw new Error("Google Drive 未確認連結 reader 權限，分享尚未發布。");
  }
  for (const recipient of recipients) {
    if (!verified.some((p) => p.id === recipient.permissionId && p.role === "reader")) {
      throw new Error(`Google Drive 未確認 ${recipient.email} 的 reader 權限。`);
    }
  }
  return { recipients, anyonePermissionId };
}

export async function publishProjectShare(params: {
  record: PersistedProjectRecord;
  accountId: string;
  accessToken: string;
  visibility: Exclude<ProjectShareVisibility, "private">;
  recipientEmails?: string[];
  existingShare?: ProjectShareRecord | null;
  authGeneration: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onStage?: (stage: ProjectShareRecord["status"]) => void;
}): Promise<ProjectShareRecord> {
  if (!params.accountId || !params.accessToken) throw new Error("請先登入 Google 帳號並完成授權。");
  if (params.record.ownerAccountId && params.record.ownerAccountId !== params.accountId) throw new Error("目前 Google 帳號不是此專案擁有者。");
  const previous = params.existingShare ?? null;
  const shareId = previous?.shareId ?? makeId("share");
  const publishedRevisionId = makeId(`p${params.record.project.revision}`);
  const nowIso = new Date().toISOString();
  let working: ProjectShareRecord = {
    key: shareId,
    schemaVersion: PROJECT_SHARE_SCHEMA_VERSION,
    shareId,
    sourceProjectId: params.record.projectId,
    ownerAccountId: params.accountId,
    visibility: params.visibility,
    status: previous?.status === "published" ? "updating" : "preparing",
    operationGeneration: (previous?.operationGeneration ?? 0) + 1,
    sourceProjectRevision: params.record.project.revision,
    publishedRevisionId,
    shareFolderId: previous?.shareFolderId,
    revisionsFolderId: previous?.revisionsFolderId,
    shareManifestFileId: previous?.shareManifestFileId,
    currentRevisionManifestFileId: previous?.currentRevisionManifestFileId,
    recipients: previous?.recipients ?? [],
    anyonePermissionId: previous?.anyonePermissionId,
    estimatedBytes: 0,
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  let permissionMutationStarted = false;
  await saveProjectShareRecord(working);

  const setStage = async (status: ProjectShareRecord["status"]) => {
    if (!params.isGenerationValid(params.authGeneration, params.accountId)) throw new Error("Google 帳號已切換，已中止過期的分享操作。");
    working = await saveProjectShareRecord({ ...working, status });
    params.onStage?.(status);
  };

  try {
    const preflight = await runProjectSharePreflight({ ...params, accountId: params.accountId });
    working.estimatedBytes = preflight.estimatedBytes;
    if (!preflight.ok) throw new Error(preflight.issues.map((issue) => `${issue.songName}：${issue.message}`).join("\n"));
    await setStage("copying");
    const layout = await ensureShareRevisionFolder({
      accountId: params.accountId,
      shareId,
      sourceProjectId: params.record.projectId,
      publishedRevisionId,
      accessToken: params.accessToken,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    working.shareFolderId = layout.shareFolderId;
    working.revisionsFolderId = layout.revisionsFolderId;
    await saveProjectShareRecord(working);
    const songs = [];
    for (const prepared of preflight.preparedSongs) {
      songs.push(await copyPreparedShareSong({
        prepared,
        revisionFolderId: layout.revisionFolderId,
        shareId,
        publishedRevisionId,
        ownerAccountId: params.accountId,
        accessToken: params.accessToken,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      }));
    }
    await setStage("uploading");
    const manifest = buildProjectShareManifest({ shareId, sourceProject: params.record.project, ownerAccountId: params.accountId, publishedRevisionId, songs });
    const uploadedManifest = await uploadDriveMultipartJson({
      accessToken: params.accessToken,
      name: "share-manifest.json",
      parentId: layout.revisionFolderId,
      payload: manifest,
      appProperties: { lhApp: "loop-harmonizer", lhRole: "share_manifest", lhShareId: shareId, lhPublishedRevisionId: publishedRevisionId },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    await moveDriveFile({
      fileId: layout.revisionFolderId,
      accessToken: params.accessToken,
      addParentId: layout.revisionsFolderId,
      removeParentId: layout.revisionStagingParentId,
      appProperties: {
        lhApp: "loop-harmonizer",
        lhRole: "share_revision",
        lhShareId: shareId,
        lhPublishedRevisionId: publishedRevisionId,
      },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    await setStage("granting_permission");
    // 權限調整包含「先清除、再逐一建立」；即使中途失敗，也必須嘗試回滾
    // 首次發布可能已建立的部分外部權限，不能只在整段成功後才標記。
    permissionMutationStarted = true;
    const permissions = await applySharePermissions({
      folderId: layout.shareFolderId,
      accessToken: params.accessToken,
      visibility: params.visibility,
      recipientEmails: params.recipientEmails ?? [],
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    await setStage("validating");
    const pointer = buildProjectSharePointer({ manifest, revisionManifestFileId: uploadedManifest.id, visibility: params.visibility });
    const uploadedPointer = await uploadDriveMultipartJson({
      accessToken: params.accessToken,
      name: "share.json",
      parentId: layout.shareFolderId,
      existingFileId: previous?.shareManifestFileId,
      payload: pointer,
      appProperties: { lhApp: "loop-harmonizer", lhRole: "shared_project", lhShareId: shareId, lhSourceProjectId: params.record.projectId },
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    const verifyPointer = validateProjectSharePointer(await downloadDriveJson({ fileId: uploadedPointer.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
    if (verifyPointer.publishedRevisionId !== publishedRevisionId) throw new Error("分享指標檔驗證失敗。");
    working = await saveProjectShareRecord({
      ...working,
      status: "published",
      visibility: params.visibility,
      sourceProjectRevision: params.record.project.revision,
      publishedRevisionId,
      shareManifestFileId: uploadedPointer.id,
      currentRevisionManifestFileId: uploadedManifest.id,
      recipients: permissions.recipients,
      anyonePermissionId: permissions.anyonePermissionId,
      lastError: undefined,
      requiresPermissionRepair: false,
    });
    return working;
  } catch (err) {
    const message = err instanceof Error ? err.message : "分享發布失敗。";
    if (previous?.status === "published") {
      await saveProjectShareRecord({ ...previous, lastError: message, updatedAt: new Date().toISOString() });
    } else {
      let requiresPermissionRepair = false;
      if (permissionMutationStarted && working.shareFolderId) {
        try {
          await clearDirectExternalPermissions({
            folderId: working.shareFolderId,
            accessToken: params.accessToken,
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          });
          const remaining = await listDrivePermissions({
            fileId: working.shareFolderId,
            accessToken: params.accessToken,
            signal: params.signal,
            fetchImpl: params.fetchImpl,
          });
          requiresPermissionRepair = remaining.some(isExternalSharePermission);
        } catch {
          requiresPermissionRepair = true;
        }
      }
      await saveProjectShareRecord({ ...working, status: "error", lastError: message, requiresPermissionRepair });
    }
    throw err;
  }
}

export async function revokeProjectShare(params: {
  share: ProjectShareRecord;
  accountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ShareRevokeResult> {
  if (params.share.ownerAccountId !== params.accountId) throw new Error("目前 Google 帳號不是此分享擁有者。");
  if (!params.share.shareFolderId) throw new Error("分享紀錄缺少 Google Drive Folder ID。");
  await saveProjectShareRecord({ ...params.share, status: "revoking" });
  try {
    await clearDirectExternalPermissions({ folderId: params.share.shareFolderId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    const after = await listDrivePermissions({ fileId: params.share.shareFolderId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    const remaining = after.filter(isExternalSharePermission).map((p) => ({
      id: p.id, type: p.type, role: p.role, emailAddress: p.emailAddress, inherited: isInheritedPermission(p),
    }));
    if (remaining.length > 0) {
      await saveProjectShareRecord({ ...params.share, status: "error", requiresPermissionRepair: true, lastError: "仍存在無法直接撤銷的繼承或額外權限。" });
      return { revoked: false, remainingExternalPermissions: remaining };
    }
    await saveProjectShareRecord({
      ...params.share,
      status: "revoked",
      visibility: "private",
      recipients: [],
      anyonePermissionId: undefined,
      revokedAt: new Date().toISOString(),
      requiresPermissionRepair: false,
      lastError: undefined,
    });
    return { revoked: true, remainingExternalPermissions: [] };
  } catch (err) {
    await saveProjectShareRecord({ ...params.share, status: "error", requiresPermissionRepair: true, lastError: err instanceof Error ? err.message : "撤銷權限失敗。" });
    throw err;
  }
}
