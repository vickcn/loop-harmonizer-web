import { downloadDriveJson, getDriveFileMetadata, listDriveFilesPaginated, moveDriveFile, uploadDriveMultipartJson } from "../google/driveClient.ts";
import { ensureShareRevisionFolder } from "../google/driveFolderManager.ts";
import type { PersistedProjectRecord } from "../projects/projectTypes.ts";
import { PROJECT_SHARE_ACCOUNT_INDEX, PROJECT_SHARE_SOURCE_INDEX, idbGet, idbGetAll, idbRequestPromise, withIdbTransaction } from "../storage/indexedDb.ts";
import { copyPreparedShareSong, runProjectSharePreflight } from "./shareArtifactManager.ts";
import { buildProjectShareManifest, buildProjectSharePointer, validateProjectSharePointer } from "./shareManifest.ts";
import { assertShareOperationCurrent, withProjectShareOperation } from "./shareOperationCoordinator.ts";
import { deleteDrivePermission, evaluateShareAcl, isExternalSharePermission, isInheritedPermission, listDrivePermissions, reconcileSharePermissions } from "./sharePermissions.ts";
import { PROJECT_SHARE_SCHEMA_VERSION, type ProjectShareDiscoveryResult, type ProjectShareRecord, type ProjectShareVisibility, type ShareAclReconciliationResult, type ShareRevokeResult } from "./shareTypes.ts";

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
  await withIdbTransaction("projectShares", "readwrite", async (tx) => { await idbRequestPromise(tx.objectStore("projectShares").put(normalized)); });
  return normalized;
}

async function saveIfOperationCurrent(record: ProjectShareRecord, operationId: string, generation: number): Promise<ProjectShareRecord> {
  return withIdbTransaction("projectShares", "readwrite", async (tx) => {
    const store = tx.objectStore("projectShares");
    const current = (await idbRequestPromise(store.get(record.shareId))) as ProjectShareRecord | undefined;
    if (current && (current.operationId !== operationId || current.operationGeneration !== generation || (current.status === "revoked" && record.status !== "revoked"))) throw new Error("分享操作已被其他分頁取代或撤銷。");
    const normalized = { ...record, key: record.shareId, operationId, operationGeneration: generation, updatedAt: new Date().toISOString() };
    await idbRequestPromise(store.put(normalized));
    return normalized;
  });
}

export async function getProjectShareRecord(shareId: string): Promise<ProjectShareRecord | null> { return idbGet<ProjectShareRecord>("projectShares", shareId); }
export async function listProjectShareRecords(): Promise<ProjectShareRecord[]> { return idbGetAll<ProjectShareRecord>("projectShares").catch(() => []); }
export async function listProjectSharesBySourceProject(sourceProjectId: string): Promise<ProjectShareRecord[]> {
  return withIdbTransaction("projectShares", "readonly", async (tx) => {
    const store = tx.objectStore("projectShares");
    if (typeof store.index === "function" && (!store.indexNames || store.indexNames.contains(PROJECT_SHARE_SOURCE_INDEX))) return (await idbRequestPromise(store.index(PROJECT_SHARE_SOURCE_INDEX).getAll(sourceProjectId))) as ProjectShareRecord[];
    return ((await idbRequestPromise(store.getAll())) as ProjectShareRecord[]).filter((record) => record.sourceProjectId === sourceProjectId);
  });
}
export async function listProjectSharesByOwner(ownerAccountId: string): Promise<ProjectShareRecord[]> {
  return withIdbTransaction("projectShares", "readonly", async (tx) => {
    const store = tx.objectStore("projectShares");
    if (typeof store.index === "function" && (!store.indexNames || store.indexNames.contains(PROJECT_SHARE_ACCOUNT_INDEX))) return (await idbRequestPromise(store.index(PROJECT_SHARE_ACCOUNT_INDEX).getAll(ownerAccountId))) as ProjectShareRecord[];
    return ((await idbRequestPromise(store.getAll())) as ProjectShareRecord[]).filter((record) => record.ownerAccountId === ownerAccountId);
  });
}

export function canGarbageCollectShareFolder(share: ProjectShareRecord, options?: { explicitUserConfirmation?: boolean; referencedByOtherShare?: boolean; inventoryComplete?: boolean; hasStagingRevision?: boolean }): { allowed: boolean; reason?: string } {
  if (!options?.explicitUserConfirmation) return { allowed: false, reason: "共享副本需要獨立確認，不隨私人專案 GC 自動刪除。" };
  if (options.inventoryComplete !== true) return { allowed: false, reason: "共享引用清單不完整，依 Fail Closed 原則禁止刪除。" };
  if (options.hasStagingRevision) return { allowed: false, reason: "仍有 Staging Revision，禁止清除共享成果。" };
  if (options.referencedByOtherShare) return { allowed: false, reason: "仍有其他共享版本引用此成果。" };
  if (share.status !== "revoked") return { allowed: false, reason: "分享仍有效或狀態未完成，禁止清除共享成果。" };
  if (share.requiresPermissionRepair || share.aclVerification !== "verified") return { allowed: false, reason: "外部權限尚未完整驗證，禁止清除共享成果。" };
  return { allowed: true };
}

async function inspectRemoteShare(params: { share: ProjectShareRecord; accessToken: string; desiredVisibility?: Exclude<ProjectShareVisibility, "private">; desiredEmails?: string[]; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ pointerRevision?: string; pointerVersion?: string; pointerLifecycle?: "published" | "revoking" | "revoked"; pointerOperationId?: string; acl: ShareAclReconciliationResult | null }> {
  let pointerRevision: string | undefined;
  let pointerVersion: string | undefined;
  let pointerLifecycle: "published" | "revoking" | "revoked" | undefined;
  let pointerOperationId: string | undefined;
  if (params.share.shareManifestFileId) {
    const metadata = await getDriveFileMetadata(params.share.shareManifestFileId, { accessToken: params.accessToken, fields: "id,version,trashed,appProperties", signal: params.signal, fetchImpl: params.fetchImpl });
    if (!metadata.trashed) {
      pointerVersion = metadata.version === undefined ? undefined : String(metadata.version);
      const pointer = validateProjectSharePointer(await downloadDriveJson({ fileId: params.share.shareManifestFileId, accessToken: params.accessToken, fileName: "share.json", signal: params.signal, fetchImpl: params.fetchImpl }));
      pointerRevision = pointer.publishedRevisionId;
      pointerLifecycle = pointer.lifecycle ?? "published";
      pointerOperationId = pointer.operationId;
    }
  }
  const acl = params.share.shareFolderId ? evaluateShareAcl({ permissions: await listDrivePermissions({ fileId: params.share.shareFolderId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }), visibility: params.desiredVisibility ?? (params.share.visibility === "link" ? "link" : "restricted"), recipientEmails: params.desiredEmails ?? params.share.recipients.map((recipient) => recipient.email) }) : null;
  return { pointerRevision, pointerVersion, pointerLifecycle, pointerOperationId, acl };
}

type PublishParams = {
  record: PersistedProjectRecord; accountId: string; accessToken: string;
  visibility: Exclude<ProjectShareVisibility, "private">; recipientEmails?: string[];
  existingShare?: ProjectShareRecord | null; authGeneration: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  signal?: AbortSignal; fetchImpl?: typeof fetch; onStage?: (stage: ProjectShareRecord["status"]) => void;
};

export function validateProjectSharePublishOwnership(record: PersistedProjectRecord, accountId: string): void {
  if (!accountId) throw new Error("請先登入 Google 帳號並完成授權。");
  if (record.storageProvider === "google_drive" && record.ownerAccountId !== accountId) {
    throw new Error("目前 Google 帳號不是此雲端專案擁有者。");
  }
  if (record.storageProvider !== "local" && record.storageProvider !== "google_drive") {
    throw new Error("不支援的專案儲存來源。");
  }
}

async function publishUnlocked(params: PublishParams & { shareId: string; operationId: string; operationGeneration: number }): Promise<ProjectShareRecord> {
  const previous = params.existingShare ?? null;
  let expectedPointerVersion = previous?.remotePointerVersion;
  const publishedRevisionId = makeId(`p${params.record.project.revision}`);
  const nowIso = new Date().toISOString();
  let working: ProjectShareRecord = {
    key: params.shareId, schemaVersion: PROJECT_SHARE_SCHEMA_VERSION, shareId: params.shareId,
    sourceProjectId: params.record.projectId, ownerAccountId: params.accountId, visibility: params.visibility,
    status: previous?.status === "published" ? "updating" : "preparing", operationGeneration: params.operationGeneration,
    operationId: params.operationId, operationKind: previous?.status === "published" ? "update_revision" : "publish",
    operationStartedAt: nowIso, operationStage: previous?.status === "published" ? "updating" : "preparing",
    sourceProjectRevision: params.record.project.revision, publishedRevisionId: previous?.publishedRevisionId ?? publishedRevisionId,
    targetPublishedRevisionId: publishedRevisionId, shareFolderId: previous?.shareFolderId, revisionsFolderId: previous?.revisionsFolderId,
    shareManifestFileId: previous?.shareManifestFileId, currentRevisionManifestFileId: previous?.currentRevisionManifestFileId,
    recipients: previous?.recipients ?? [], anyonePermissionId: previous?.anyonePermissionId, estimatedBytes: 0,
    createdAt: previous?.createdAt ?? nowIso, updatedAt: nowIso, aclVerification: previous?.aclVerification ?? "unknown",
    pointerUpdatedInOperation: false,
  };
  await saveProjectShareRecord(working);
  const setStage = async (status: ProjectShareRecord["status"]) => {
    if (!params.isGenerationValid(params.authGeneration, params.accountId)) throw new Error("Google 帳號已切換，已中止過期的分享操作。");
    await assertShareOperationCurrent(params.shareId, params.operationId, params.operationGeneration);
    working = await saveIfOperationCurrent({ ...working, status, operationStage: status }, params.operationId, params.operationGeneration);
    params.onStage?.(status);
  };
  try {
    if (previous?.shareManifestFileId) {
      const remote = await getDriveFileMetadata(previous.shareManifestFileId, { accessToken: params.accessToken, fields: "id,version,trashed", signal: params.signal, fetchImpl: params.fetchImpl });
      if (remote.trashed || (expectedPointerVersion && String(remote.version ?? "") !== expectedPointerVersion)) throw new Error("遠端分享已由其他裝置更新，請先重新核對分享狀態。");
      expectedPointerVersion = remote.version === undefined ? undefined : String(remote.version);
      const remotePointer = validateProjectSharePointer(await downloadDriveJson({ fileId: previous.shareManifestFileId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
      if ((remotePointer.lifecycle ?? "published") !== "published") throw new Error("此分享已撤銷或正在撤銷，過期發布操作不得重新開放權限。");
    }
    const preflight = await runProjectSharePreflight({ ...params, accountId: params.accountId });
    working.estimatedBytes = preflight.estimatedBytes;
    if (!preflight.ok) throw new Error(preflight.issues.map((issue) => `${issue.songName}：${issue.message}`).join("\n"));
    await setStage("copying");
    const layout = await ensureShareRevisionFolder({ accountId: params.accountId, shareId: params.shareId, sourceProjectId: params.record.projectId, publishedRevisionId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    working.shareFolderId = layout.shareFolderId; working.revisionsFolderId = layout.revisionsFolderId;
    await saveIfOperationCurrent(working, params.operationId, params.operationGeneration);
    const songs = [];
    for (const prepared of preflight.preparedSongs) songs.push(await copyPreparedShareSong({ prepared, revisionFolderId: layout.revisionFolderId, artifactPoolFolderId: layout.artifactPoolFolderId, shareId: params.shareId, publishedRevisionId, ownerAccountId: params.accountId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
    await setStage("uploading");
    const manifest = buildProjectShareManifest({ shareId: params.shareId, sourceProject: params.record.project, ownerAccountId: params.accountId, publishedRevisionId, songs });
    const uploadedManifest = await uploadDriveMultipartJson({ accessToken: params.accessToken, name: "share-manifest.json", parentId: layout.revisionFolderId, payload: manifest, appProperties: { lhApp: "loop-harmonizer", lhRole: "share_manifest", lhShareId: params.shareId, lhPublishedRevisionId: publishedRevisionId, lhAccountId: params.accountId }, signal: params.signal, fetchImpl: params.fetchImpl });
    await moveDriveFile({ fileId: layout.revisionFolderId, accessToken: params.accessToken, addParentId: layout.revisionsFolderId, removeParentId: layout.revisionStagingParentId, appProperties: { lhApp: "loop-harmonizer", lhRole: "share_revision", lhShareId: params.shareId, lhPublishedRevisionId: publishedRevisionId, lhAccountId: params.accountId }, signal: params.signal, fetchImpl: params.fetchImpl });
    await setStage("granting_permission");
    const permissions = await reconcileSharePermissions({ fileId: layout.shareFolderId, accessToken: params.accessToken, visibility: params.visibility, recipientEmails: params.recipientEmails, signal: params.signal, fetchImpl: params.fetchImpl });
    if (permissions.verification !== "verified") throw new Error("Google Drive ACL 與要求的分享設定不一致，需重新核對與修復。");
    await setStage("validating");
    if (previous?.shareManifestFileId) {
      const latest = await getDriveFileMetadata(previous.shareManifestFileId, { accessToken: params.accessToken, fields: "id,version,trashed", signal: params.signal, fetchImpl: params.fetchImpl });
      if (latest.trashed || (expectedPointerVersion && String(latest.version ?? "") !== expectedPointerVersion)) {
        throw new Error("跨裝置衝突：Pointer 在成果準備期間已更新；已保留本次不可變 Revision，但不會覆蓋遠端最新版。");
      }
      const latestPointer = validateProjectSharePointer(await downloadDriveJson({ fileId: previous.shareManifestFileId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
      if ((latestPointer.lifecycle ?? "published") !== "published") throw new Error("此分享已進入撤銷流程，禁止由過期操作重新開放。");
    }
    const pointer = buildProjectSharePointer({ manifest, revisionManifestFileId: uploadedManifest.id, visibility: params.visibility, lifecycle: "published", operationId: params.operationId });
    const uploadedPointer = await uploadDriveMultipartJson({ accessToken: params.accessToken, name: "share.json", parentId: layout.shareFolderId, existingFileId: previous?.shareManifestFileId, payload: pointer, appProperties: { lhApp: "loop-harmonizer", lhRole: "shared_project", lhShareId: params.shareId, lhSourceProjectId: params.record.projectId, lhAccountId: params.accountId }, signal: params.signal, fetchImpl: params.fetchImpl });
    working = await saveIfOperationCurrent({ ...working, pointerUpdatedInOperation: true, shareManifestFileId: uploadedPointer.id }, params.operationId, params.operationGeneration);
    const verifyPointer = validateProjectSharePointer(await downloadDriveJson({ fileId: uploadedPointer.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
    if (verifyPointer.publishedRevisionId !== publishedRevisionId || verifyPointer.operationId !== params.operationId || (verifyPointer.lifecycle ?? "published") !== "published") {
      throw new Error("跨裝置衝突：分享 Pointer 寫後驗證不屬於本次操作；不可變 Revision 已保留，請重新核對遠端最新版。");
    }
    const pointerMeta = await getDriveFileMetadata(uploadedPointer.id, { accessToken: params.accessToken, fields: "id,version,trashed", signal: params.signal, fetchImpl: params.fetchImpl });
    if (pointerMeta.trashed || (uploadedPointer.version !== undefined && String(pointerMeta.version ?? "") !== String(uploadedPointer.version))) {
      throw new Error("跨裝置衝突：Pointer 在寫後驗證期間又被更新；本次不可變 Revision 已保留，請重新核對。");
    }
    return saveIfOperationCurrent({ ...working, status: "published", operationStage: "published", visibility: params.visibility, sourceProjectRevision: params.record.project.revision, publishedRevisionId, targetPublishedRevisionId: undefined, currentRevisionManifestFileId: uploadedManifest.id, recipients: permissions.recipients, anyonePermissionId: permissions.anyonePermissionId, aclVerification: "verified", remotePointerVersion: pointerMeta.version === undefined ? undefined : String(pointerMeta.version), lastError: undefined, requiresPermissionRepair: false, pointerUpdatedInOperation: false }, params.operationId, params.operationGeneration);
  } catch (err) {
    const message = err instanceof Error ? err.message : "分享發布失敗。";
    let remote: Awaited<ReturnType<typeof inspectRemoteShare>> | null = null;
    try { remote = await inspectRemoteShare({ share: working, accessToken: params.accessToken, desiredVisibility: params.visibility, desiredEmails: params.recipientEmails, signal: params.signal, fetchImpl: params.fetchImpl }); } catch { remote = null; }
    const pointerRevision = remote?.pointerRevision;
    const canKeepPublished = Boolean((remote?.pointerLifecycle ?? "published") === "published" && remote?.acl?.verification === "verified" && pointerRevision && (pointerRevision === previous?.publishedRevisionId || pointerRevision === publishedRevisionId));
    const fallback: ProjectShareRecord = canKeepPublished ? { ...(pointerRevision === publishedRevisionId ? working : previous!), status: "published", publishedRevisionId: pointerRevision!, aclVerification: "verified", requiresPermissionRepair: false, remotePointerVersion: remote?.pointerVersion, lastError: `上次操作未完整回報，但已依 Drive 實際狀態修復：${message}` } : { ...working, status: "error", aclVerification: remote?.acl?.verification ?? "unknown", requiresPermissionRepair: true, lastError: message };
    await saveIfOperationCurrent(fallback, params.operationId, params.operationGeneration).catch(() => undefined);
    throw err;
  }
}

export async function publishProjectShare(params: PublishParams): Promise<ProjectShareRecord> {
  if (!params.accountId || !params.accessToken) throw new Error("請先登入 Google 帳號並完成授權。");
  validateProjectSharePublishOwnership(params.record, params.accountId);
  const shareId = params.existingShare?.shareId ?? makeId("share");
  return withProjectShareOperation({ lockKey: params.existingShare?.shareId ?? `source:${params.record.projectId}`, shareId, kind: params.existingShare?.status === "published" ? "update_revision" : "publish", expectedGeneration: params.existingShare?.operationGeneration, runner: (reservation) => publishUnlocked({ ...params, shareId, operationId: reservation.operationId, operationGeneration: reservation.generation }) });
}

export async function updateProjectSharePermissions(params: { share: ProjectShareRecord; accountId: string; accessToken: string; visibility: Exclude<ProjectShareVisibility, "private">; recipientEmails?: string[]; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProjectShareRecord> {
  if (params.share.ownerAccountId !== params.accountId || !params.share.shareFolderId) throw new Error("目前帳號不是分享擁有者，或分享資料夾缺失。");
  return withProjectShareOperation({ lockKey: params.share.shareId, shareId: params.share.shareId, kind: "update_acl", expectedGeneration: params.share.operationGeneration, runner: async ({ operationId, generation }) => {
    const current = await saveIfOperationCurrent({ ...params.share, operationId, operationGeneration: generation, operationKind: "update_acl", operationStartedAt: new Date().toISOString(), status: "granting_permission", operationStage: "granting_permission" }, operationId, generation);
    try {
      const remote = await inspectRemoteShare({ share: current, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
      if (remote.pointerLifecycle && remote.pointerLifecycle !== "published") throw new Error("遠端分享已撤銷或正在撤銷，禁止重新新增 Reader。");
      const acl = await reconcileSharePermissions({ fileId: current.shareFolderId!, accessToken: params.accessToken, visibility: params.visibility, recipientEmails: params.recipientEmails, signal: params.signal, fetchImpl: params.fetchImpl });
      if (acl.verification !== "verified") throw new Error("Drive ACL 未能完整符合要求。");
      return saveIfOperationCurrent({ ...current, status: "published", operationStage: "published", visibility: params.visibility, recipients: acl.recipients, anyonePermissionId: acl.anyonePermissionId, aclVerification: "verified", requiresPermissionRepair: false, lastError: undefined }, operationId, generation);
    } catch (err) {
      let acl: ShareAclReconciliationResult | null = null;
      try { acl = evaluateShareAcl({ permissions: await listDrivePermissions({ fileId: current.shareFolderId!, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }), visibility: params.visibility, recipientEmails: params.recipientEmails }); } catch { /* fail closed */ }
      await saveIfOperationCurrent({ ...current, status: "error", aclVerification: acl?.verification ?? "unknown", recipients: acl?.recipients ?? current.recipients, anyonePermissionId: acl?.anyonePermissionId, requiresPermissionRepair: true, lastError: err instanceof Error ? err.message : "更新分享權限失敗。" }, operationId, generation).catch(() => undefined);
      throw err;
    }
  } });
}

export async function repairProjectShareState(params: { share: ProjectShareRecord; accessToken: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProjectShareRecord> {
  return withProjectShareOperation({ lockKey: params.share.shareId, shareId: params.share.shareId, kind: "repair", expectedGeneration: params.share.operationGeneration, allowRevoked: true, runner: async ({ operationId, generation }) => {
    const remote = await inspectRemoteShare({ share: params.share, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    const published = (remote.pointerLifecycle ?? "published") === "published" && remote.pointerRevision === params.share.publishedRevisionId && remote.acl?.verification === "verified" && params.share.status !== "revoked";
    const consistentRevoked = remote.pointerLifecycle === "revoked" && (remote.acl?.permissions.length ?? 0) === 0;
    return saveIfOperationCurrent({ ...params.share, operationId, operationGeneration: generation, operationKind: "repair", operationStartedAt: new Date().toISOString(), status: published ? "published" : consistentRevoked ? "revoked" : "error", aclVerification: consistentRevoked ? "verified" : remote.acl?.verification ?? "unknown", recipients: remote.acl?.recipients ?? params.share.recipients, anyonePermissionId: remote.acl?.anyonePermissionId, remotePointerVersion: remote.pointerVersion, requiresPermissionRepair: !(published || consistentRevoked), lastError: published || consistentRevoked ? undefined : "Drive Pointer 或 ACL 與本機分享紀錄不一致，請檢查遠端權限。" }, operationId, generation);
  } });
}

async function clearAndVerifyAllSharePermissions(params: { share: ProjectShareRecord; accessToken: string; signal?: AbortSignal; fetchImpl?: typeof fetch }) {
  if (!params.share.shareFolderId) throw new Error("分享紀錄缺少 Google Drive Folder ID。");
  const inventory = await listDriveFilesPaginated({ accessToken: params.accessToken, q: `trashed=false and appProperties has { key='lhShareId' and value='${params.share.shareId.replace(/'/g, "")}' }`, fields: "nextPageToken,files(id,name,mimeType,trashed,appProperties)", pageSize: 100, throwOnError: false, signal: params.signal, fetchImpl: params.fetchImpl });
  if (!inventory.complete) throw new Error("無法取得完整共享檔案清單，停止分享採 Fail Closed。");
  const ids = Array.from(new Set([params.share.shareFolderId, ...inventory.files.map((file) => file.id)]));
  for (const fileId of ids) {
    const permissions = await listDrivePermissions({ fileId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    for (const permission of permissions) if (isExternalSharePermission(permission) && !isInheritedPermission(permission)) await deleteDrivePermission({ fileId, permissionId: permission.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
  }
  const remaining = [] as ShareRevokeResult["remainingExternalPermissions"];
  for (const fileId of ids) {
    const permissions = await listDrivePermissions({ fileId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
    remaining.push(...permissions.filter(isExternalSharePermission).map((permission) => ({ id: permission.id, type: permission.type, role: permission.role, emailAddress: permission.emailAddress, inherited: isInheritedPermission(permission) })));
  }
  return remaining;
}

async function writeRemoteShareLifecycle(params: {
  share: ProjectShareRecord;
  lifecycle: "revoking" | "revoked";
  operationId: string;
  generation: number;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  if (!params.share.shareManifestFileId || !params.share.shareFolderId) throw new Error("分享缺少遠端 Pointer，無法安全記錄撤銷狀態。");
  const current = validateProjectSharePointer(await downloadDriveJson({ fileId: params.share.shareManifestFileId, accessToken: params.accessToken, fileName: "share.json", signal: params.signal, fetchImpl: params.fetchImpl }));
  if (current.shareId !== params.share.shareId || current.ownerAccountId !== params.share.ownerAccountId) throw new Error("遠端 Pointer 與分享紀錄不一致。");
  const payload = {
    ...current,
    lifecycle: params.lifecycle,
    operationId: params.operationId,
    revocationGeneration: params.generation,
    revokedAt: params.lifecycle === "revoked" ? new Date().toISOString() : undefined,
    updatedAt: new Date().toISOString(),
  };
  const uploaded = await uploadDriveMultipartJson({
    accessToken: params.accessToken,
    name: "share.json",
    parentId: params.share.shareFolderId,
    existingFileId: params.share.shareManifestFileId,
    payload,
    appProperties: { lhApp: "loop-harmonizer", lhRole: "shared_project", lhShareId: params.share.shareId, lhSourceProjectId: params.share.sourceProjectId, lhAccountId: params.share.ownerAccountId, lhLifecycle: params.lifecycle },
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  const verified = validateProjectSharePointer(await downloadDriveJson({ fileId: uploaded.id, accessToken: params.accessToken, fileName: "share.json", signal: params.signal, fetchImpl: params.fetchImpl }));
  if (verified.lifecycle !== params.lifecycle || verified.operationId !== params.operationId || verified.revocationGeneration !== params.generation) {
    throw new Error("遠端撤銷 Tombstone 寫後驗證失敗。");
  }
  return uploaded.version === undefined ? undefined : String(uploaded.version);
}

export async function revokeProjectShare(params: { share: ProjectShareRecord; accountId: string; accessToken: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ShareRevokeResult> {
  if (params.share.ownerAccountId !== params.accountId) throw new Error("目前 Google 帳號不是此分享擁有者。");
  return withProjectShareOperation({ lockKey: params.share.shareId, shareId: params.share.shareId, kind: "revoke", expectedGeneration: params.share.operationGeneration, allowRevoked: true, runner: async ({ operationId, generation }) => {
    const current = await saveIfOperationCurrent({ ...params.share, status: "revoking", operationStage: "revoking", operationId, operationGeneration: generation, operationKind: "revoke", operationStartedAt: new Date().toISOString(), revocationGeneration: generation, revokedOperationId: operationId }, operationId, generation);
    try {
      await writeRemoteShareLifecycle({ ...params, share: current, lifecycle: "revoking", operationId, generation });
      const remaining = await clearAndVerifyAllSharePermissions({ ...params, share: current });
      if (remaining.length > 0) { await saveIfOperationCurrent({ ...current, status: "error", aclVerification: "incomplete", requiresPermissionRepair: true, lastError: "仍存在無法直接撤銷的繼承或額外權限。" }, operationId, generation); return { revoked: false, remainingExternalPermissions: remaining }; }
      const pointerVersion = await writeRemoteShareLifecycle({ ...params, share: current, lifecycle: "revoked", operationId, generation });
      await saveIfOperationCurrent({ ...current, status: "revoked", operationStage: "revoked", visibility: "private", recipients: [], anyonePermissionId: undefined, revokedAt: new Date().toISOString(), aclVerification: "verified", requiresPermissionRepair: false, remotePointerVersion: pointerVersion, lastError: undefined }, operationId, generation);
      return { revoked: true, remainingExternalPermissions: [] };
    } catch (err) {
      await saveIfOperationCurrent({ ...current, status: "error", aclVerification: "unknown", requiresPermissionRepair: true, lastError: err instanceof Error ? err.message : "撤銷權限失敗。" }, operationId, generation).catch(() => undefined);
      throw err;
    }
  } });
}

export async function discoverProjectSharesFromDrive(params: { accountId: string; accessToken: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProjectShareDiscoveryResult> {
  const safeAccount = params.accountId.replace(/'/g, "");
  const folders = await listDriveFilesPaginated({ accessToken: params.accessToken, q: `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='lhApp' and value='loop-harmonizer' } and appProperties has { key='lhRole' and value='shared_project' } and appProperties has { key='lhAccountId' and value='${safeAccount}' }`, fields: "nextPageToken,files(id,name,mimeType,version,modifiedTime,trashed,parents,appProperties)", pageSize: 100, throwOnError: false, signal: params.signal, fetchImpl: params.fetchImpl });
  if (!folders.complete) return { shares: [], complete: false, skippedCount: 0, errors: [{ reason: folders.errorMessage || "Google Drive 分享清單不完整。" }], errorMessage: folders.errorMessage || "Google Drive 分享清單不完整。" };
  const shares: ProjectShareRecord[] = [];
  const errors: ProjectShareDiscoveryResult["errors"] = [];
  for (const folder of folders.files) {
    const shareId = folder.appProperties?.lhShareId; const sourceProjectId = folder.appProperties?.lhSourceProjectId;
    if (!shareId || !sourceProjectId || folder.appProperties?.lhAccountId !== params.accountId) {
      errors.push({ shareId, folderId: folder.id, reason: "分享資料夾缺少識別欄位或帳戶不一致。" });
      continue;
    }
    const pointers = await listDriveFilesPaginated({ accessToken: params.accessToken, q: `'${folder.id.replace(/'/g, "")}' in parents and trashed=false and appProperties has { key='lhRole' and value='shared_project' } and appProperties has { key='lhShareId' and value='${shareId.replace(/'/g, "")}' }`, pageSize: 20, throwOnError: false, signal: params.signal, fetchImpl: params.fetchImpl });
    if (!pointers.complete || pointers.files.length !== 1) {
      errors.push({ shareId, folderId: folder.id, reason: !pointers.complete ? "Pointer 清單讀取不完整。" : `預期一個 Pointer，實際為 ${pointers.files.length} 個。` });
      continue;
    }
    try {
      const pointerFile = pointers.files[0];
      const pointer = validateProjectSharePointer(await downloadDriveJson({ fileId: pointerFile.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
      if (pointer.shareId !== shareId || pointer.sourceProjectId !== sourceProjectId || pointer.ownerAccountId !== params.accountId) throw new Error("Pointer 識別欄位與資料夾不一致。");
      const remotePermissions = await listDrivePermissions({ fileId: folder.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
      const discoveredEmails = remotePermissions.filter((permission) => !isInheritedPermission(permission) && permission.role === "reader" && permission.emailAddress).map((permission) => permission.emailAddress!);
      const acl = evaluateShareAcl({ permissions: remotePermissions, visibility: pointer.visibility, recipientEmails: discoveredEmails });
      const existing = await getProjectShareRecord(shareId);
      const lifecycle = pointer.lifecycle ?? "published";
      const noExternalPermissions = acl.permissions.length === 0;
      const status: ProjectShareRecord["status"] = lifecycle === "revoked" && noExternalPermissions
        ? "revoked"
        : lifecycle === "revoking"
          ? "revoking"
          : lifecycle === "published" && acl.verification === "verified"
            ? "published"
            : "error";
      shares.push(await saveProjectShareRecord({ key: shareId, schemaVersion: 1, shareId, sourceProjectId, ownerAccountId: params.accountId, visibility: status === "revoked" ? "private" : pointer.visibility, status, operationGeneration: Math.max(existing?.operationGeneration ?? 0, pointer.revocationGeneration ?? 0), sourceProjectRevision: existing?.sourceProjectRevision ?? 0, publishedRevisionId: pointer.publishedRevisionId, shareFolderId: folder.id, shareManifestFileId: pointerFile.id, currentRevisionManifestFileId: pointer.revisionManifestFileId, recipients: acl.recipients, anyonePermissionId: acl.anyonePermissionId, estimatedBytes: existing?.estimatedBytes ?? 0, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), revokedAt: pointer.revokedAt ?? existing?.revokedAt, revocationGeneration: pointer.revocationGeneration, revokedOperationId: lifecycle !== "published" ? pointer.operationId : undefined, aclVerification: status === "revoked" ? "verified" : acl.verification, requiresPermissionRepair: status === "error" || status === "revoking", remotePointerVersion: pointerFile.version === undefined ? undefined : String(pointerFile.version), recoveredFromDriveAt: new Date().toISOString(), discoveryComplete: true }));
    } catch (err) {
      errors.push({ shareId, folderId: folder.id, reason: err instanceof Error ? err.message : "遠端 Pointer 損壞或無法驗證。" });
    }
  }
  return { shares, complete: errors.length === 0, skippedCount: errors.length, errors, errorMessage: errors.length ? `有 ${errors.length} 個分享無法完整驗證。` : undefined };
}
