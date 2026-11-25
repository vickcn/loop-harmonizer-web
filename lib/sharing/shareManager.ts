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

async function inspectRemoteShare(params: { share: ProjectShareRecord; accessToken: string; desiredVisibility?: Exclude<ProjectShareVisibility, "private">; desiredEmails?: string[]; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ pointerRevision?: string; pointerVersion?: string; acl: ShareAclReconciliationResult | null }> {
  let pointerRevision: string | undefined;
  let pointerVersion: string | undefined;
  if (params.share.shareManifestFileId) {
    const metadata = await getDriveFileMetadata(params.share.shareManifestFileId, { accessToken: params.accessToken, fields: "id,version,trashed,appProperties", signal: params.signal, fetchImpl: params.fetchImpl });
    if (!metadata.trashed) {
      pointerVersion = metadata.version === undefined ? undefined : String(metadata.version);
      pointerRevision = validateProjectSharePointer(await downloadDriveJson({ fileId: params.share.shareManifestFileId, accessToken: params.accessToken, fileName: "share.json", signal: params.signal, fetchImpl: params.fetchImpl })).publishedRevisionId;
    }
  }
  const acl = params.share.shareFolderId ? evaluateShareAcl({ permissions: await listDrivePermissions({ fileId: params.share.shareFolderId, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }), visibility: params.desiredVisibility ?? (params.share.visibility === "link" ? "link" : "restricted"), recipientEmails: params.desiredEmails ?? params.share.recipients.map((recipient) => recipient.email) }) : null;
  return { pointerRevision, pointerVersion, acl };
}

type PublishParams = {
  record: PersistedProjectRecord; accountId: string; accessToken: string;
  visibility: Exclude<ProjectShareVisibility, "private">; recipientEmails?: string[];
  existingShare?: ProjectShareRecord | null; authGeneration: number;
  isGenerationValid: (generation: number, accountId: string) => boolean;
  signal?: AbortSignal; fetchImpl?: typeof fetch; onStage?: (stage: ProjectShareRecord["status"]) => void;
};

async function publishUnlocked(params: PublishParams & { shareId: string; operationId: string; operationGeneration: number }): Promise<ProjectShareRecord> {
  const previous = params.existingShare ?? null;
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
    if (previous?.remotePointerVersion && previous.shareManifestFileId) {
      const remote = await getDriveFileMetadata(previous.shareManifestFileId, { accessToken: params.accessToken, fields: "id,version,trashed", signal: params.signal, fetchImpl: params.fetchImpl });
      if (remote.trashed || String(remote.version ?? "") !== previous.remotePointerVersion) throw new Error("遠端分享已由其他裝置更新，請先重新核對分享狀態。");
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
    const pointer = buildProjectSharePointer({ manifest, revisionManifestFileId: uploadedManifest.id, visibility: params.visibility });
    const uploadedPointer = await uploadDriveMultipartJson({ accessToken: params.accessToken, name: "share.json", parentId: layout.shareFolderId, existingFileId: previous?.shareManifestFileId, payload: pointer, appProperties: { lhApp: "loop-harmonizer", lhRole: "shared_project", lhShareId: params.shareId, lhSourceProjectId: params.record.projectId, lhAccountId: params.accountId }, signal: params.signal, fetchImpl: params.fetchImpl });
    working = await saveIfOperationCurrent({ ...working, pointerUpdatedInOperation: true, shareManifestFileId: uploadedPointer.id }, params.operationId, params.operationGeneration);
    const verifyPointer = validateProjectSharePointer(await downloadDriveJson({ fileId: uploadedPointer.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
    if (verifyPointer.publishedRevisionId !== publishedRevisionId) throw new Error("分享指標檔驗證失敗。");
    const pointerMeta = await getDriveFileMetadata(uploadedPointer.id, { accessToken: params.accessToken, fields: "id,version,trashed", signal: params.signal, fetchImpl: params.fetchImpl });
    return saveIfOperationCurrent({ ...working, status: "published", operationStage: "published", visibility: params.visibility, sourceProjectRevision: params.record.project.revision, publishedRevisionId, targetPublishedRevisionId: undefined, currentRevisionManifestFileId: uploadedManifest.id, recipients: permissions.recipients, anyonePermissionId: permissions.anyonePermissionId, aclVerification: "verified", remotePointerVersion: pointerMeta.version === undefined ? undefined : String(pointerMeta.version), lastError: undefined, requiresPermissionRepair: false, pointerUpdatedInOperation: false }, params.operationId, params.operationGeneration);
  } catch (err) {
    const message = err instanceof Error ? err.message : "分享發布失敗。";
    let remote: Awaited<ReturnType<typeof inspectRemoteShare>> | null = null;
    try { remote = await inspectRemoteShare({ share: working, accessToken: params.accessToken, desiredVisibility: params.visibility, desiredEmails: params.recipientEmails, signal: params.signal, fetchImpl: params.fetchImpl }); } catch { remote = null; }
    const pointerRevision = remote?.pointerRevision;
    const canKeepPublished = Boolean(remote?.acl?.verification === "verified" && pointerRevision && (pointerRevision === previous?.publishedRevisionId || pointerRevision === publishedRevisionId));
    const fallback: ProjectShareRecord = canKeepPublished ? { ...(pointerRevision === publishedRevisionId ? working : previous!), status: "published", publishedRevisionId: pointerRevision!, aclVerification: "verified", requiresPermissionRepair: false, remotePointerVersion: remote?.pointerVersion, lastError: `上次操作未完整回報，但已依 Drive 實際狀態修復：${message}` } : { ...working, status: "error", aclVerification: remote?.acl?.verification ?? "unknown", requiresPermissionRepair: true, lastError: message };
    await saveIfOperationCurrent(fallback, params.operationId, params.operationGeneration).catch(() => undefined);
    throw err;
  }
}

export async function publishProjectShare(params: PublishParams): Promise<ProjectShareRecord> {
  if (!params.accountId || !params.accessToken) throw new Error("請先登入 Google 帳號並完成授權。");
  if (params.record.ownerAccountId && params.record.ownerAccountId !== params.accountId) throw new Error("目前 Google 帳號不是此專案擁有者。");
  const shareId = params.existingShare?.shareId ?? makeId("share");
  return withProjectShareOperation({ lockKey: params.existingShare?.shareId ?? `source:${params.record.projectId}`, shareId, kind: params.existingShare?.status === "published" ? "update_revision" : "publish", expectedGeneration: params.existingShare?.operationGeneration, runner: (reservation) => publishUnlocked({ ...params, shareId, operationId: reservation.operationId, operationGeneration: reservation.generation }) });
}

export async function updateProjectSharePermissions(params: { share: ProjectShareRecord; accountId: string; accessToken: string; visibility: Exclude<ProjectShareVisibility, "private">; recipientEmails?: string[]; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProjectShareRecord> {
  if (params.share.ownerAccountId !== params.accountId || !params.share.shareFolderId) throw new Error("目前帳號不是分享擁有者，或分享資料夾缺失。");
  return withProjectShareOperation({ lockKey: params.share.shareId, shareId: params.share.shareId, kind: "update_acl", expectedGeneration: params.share.operationGeneration, runner: async ({ operationId, generation }) => {
    const current = await saveIfOperationCurrent({ ...params.share, operationId, operationGeneration: generation, operationKind: "update_acl", operationStartedAt: new Date().toISOString(), status: "granting_permission", operationStage: "granting_permission" }, operationId, generation);
    try {
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
    const published = remote.pointerRevision === params.share.publishedRevisionId && remote.acl?.verification === "verified" && params.share.status !== "revoked";
    const consistentRevoked = params.share.status === "revoked" && remote.acl?.permissions.length === 0;
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

export async function revokeProjectShare(params: { share: ProjectShareRecord; accountId: string; accessToken: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ShareRevokeResult> {
  if (params.share.ownerAccountId !== params.accountId) throw new Error("目前 Google 帳號不是此分享擁有者。");
  return withProjectShareOperation({ lockKey: params.share.shareId, shareId: params.share.shareId, kind: "revoke", expectedGeneration: params.share.operationGeneration, allowRevoked: true, runner: async ({ operationId, generation }) => {
    const current = await saveIfOperationCurrent({ ...params.share, status: "revoking", operationStage: "revoking", operationId, operationGeneration: generation, operationKind: "revoke", operationStartedAt: new Date().toISOString(), revocationGeneration: generation, revokedOperationId: operationId }, operationId, generation);
    try {
      const remaining = await clearAndVerifyAllSharePermissions({ ...params, share: current });
      if (remaining.length > 0) { await saveIfOperationCurrent({ ...current, status: "error", aclVerification: "incomplete", requiresPermissionRepair: true, lastError: "仍存在無法直接撤銷的繼承或額外權限。" }, operationId, generation); return { revoked: false, remainingExternalPermissions: remaining }; }
      await saveIfOperationCurrent({ ...current, status: "revoked", operationStage: "revoked", visibility: "private", recipients: [], anyonePermissionId: undefined, revokedAt: new Date().toISOString(), aclVerification: "verified", requiresPermissionRepair: false, lastError: undefined }, operationId, generation);
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
  if (!folders.complete) return { shares: [], complete: false, errorMessage: folders.errorMessage || "Google Drive 分享清單不完整。" };
  const shares: ProjectShareRecord[] = [];
  for (const folder of folders.files) {
    const shareId = folder.appProperties?.lhShareId; const sourceProjectId = folder.appProperties?.lhSourceProjectId;
    if (!shareId || !sourceProjectId || folder.appProperties?.lhAccountId !== params.accountId) continue;
    const pointers = await listDriveFilesPaginated({ accessToken: params.accessToken, q: `'${folder.id.replace(/'/g, "")}' in parents and trashed=false and appProperties has { key='lhRole' and value='shared_project' } and appProperties has { key='lhShareId' and value='${shareId.replace(/'/g, "")}' }`, pageSize: 20, throwOnError: false, signal: params.signal, fetchImpl: params.fetchImpl });
    if (!pointers.complete || pointers.files.length !== 1) continue;
    try {
      const pointerFile = pointers.files[0];
      const pointer = validateProjectSharePointer(await downloadDriveJson({ fileId: pointerFile.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl }));
      if (pointer.shareId !== shareId || pointer.sourceProjectId !== sourceProjectId || pointer.ownerAccountId !== params.accountId) continue;
      const remotePermissions = await listDrivePermissions({ fileId: folder.id, accessToken: params.accessToken, signal: params.signal, fetchImpl: params.fetchImpl });
      const discoveredEmails = remotePermissions.filter((permission) => !isInheritedPermission(permission) && permission.role === "reader" && permission.emailAddress).map((permission) => permission.emailAddress!);
      const acl = evaluateShareAcl({ permissions: remotePermissions, visibility: pointer.visibility, recipientEmails: discoveredEmails });
      const existing = await getProjectShareRecord(shareId);
      shares.push(await saveProjectShareRecord({ key: shareId, schemaVersion: 1, shareId, sourceProjectId, ownerAccountId: params.accountId, visibility: pointer.visibility, status: acl.verification === "verified" ? "published" : "error", operationGeneration: existing?.operationGeneration ?? 0, sourceProjectRevision: existing?.sourceProjectRevision ?? 0, publishedRevisionId: pointer.publishedRevisionId, shareFolderId: folder.id, shareManifestFileId: pointerFile.id, currentRevisionManifestFileId: pointer.revisionManifestFileId, recipients: acl.recipients, anyonePermissionId: acl.anyonePermissionId, estimatedBytes: existing?.estimatedBytes ?? 0, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), aclVerification: acl.verification, requiresPermissionRepair: acl.verification !== "verified", remotePointerVersion: pointerFile.version === undefined ? undefined : String(pointerFile.version), recoveredFromDriveAt: new Date().toISOString(), discoveryComplete: true }));
    } catch { /* invalid remote entry is not imported */ }
  }
  return { shares, complete: true };
}
