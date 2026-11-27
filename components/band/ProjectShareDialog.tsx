"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";
import { sharedCloudTaskManager } from "@/lib/cloudTasks/cloudTaskManager";
import { getProjectRecord } from "@/lib/storage/projectStore";
import type { PersistedProjectRecord } from "@/lib/projects/projectTypes";
import {
  buildProjectShareUrl,
  discoverProjectSharesFromDrive,
  getProjectShareRecord,
  listProjectSharesBySourceProject,
  publishProjectShare,
  repairProjectShareState,
  revokeProjectShare,
  updateProjectSharePermissions,
} from "@/lib/sharing/shareManager";
import type { ProjectShareRecord, ProjectShareVisibility } from "@/lib/sharing/shareTypes";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { ProjectShareManager } from "./ProjectShareManager";

type Props = {
  open: boolean;
  project: PersistedProjectRecord | null;
  prepareProjectSnapshot: (projectId: string) => Promise<PersistedProjectRecord>;
  onCompleteShareArtifacts: (entryIds: string[], onProgress: (completed: number, total: number, songName: string) => void, signal: AbortSignal) => Promise<{ completed: number; total: number }>;
  onClose: () => void;
  onMessage: (message: string) => void;
};

function parseEmails(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean)));
}

export function ProjectShareDialog({ open, project, prepareProjectSnapshot, onCompleteShareArtifacts, onClose, onMessage }: Props) {
  const [share, setShare] = useState<ProjectShareRecord | null>(null);
  const [visibility, setVisibility] = useState<Exclude<ProjectShareVisibility, "private">>("restricted");
  const [emailText, setEmailText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"revoke" | "link" | "remove" | "batch" | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number; songName: string } | null>(null);
  const [availableStorageBytes, setAvailableStorageBytes] = useState<number | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    let active = true;
    void listProjectSharesBySourceProject(project.projectId).then((rows) => {
      if (!active) return;
      const latest = rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      setShare(latest);
      if (latest?.visibility === "link" || latest?.visibility === "restricted") setVisibility(latest.visibility);
      setEmailText(latest?.recipients.map((recipient) => recipient.email).join(", ") ?? "");
    });
    return () => { active = false; };
  }, [open, project]);

  useEffect(() => {
    if (!open || !navigator.storage?.estimate) return;
    void navigator.storage.estimate()
      .then(({ quota = 0, usage = 0 }) => setAvailableStorageBytes(Math.max(0, quota - usage)))
      .catch(() => setAvailableStorageBytes(null));
  }, [open]);

  const emails = useMemo(() => parseEmails(emailText), [emailText]);
  const link = useMemo(() => share ? buildProjectShareUrl(share, typeof window !== "undefined" ? window.location.origin : undefined) : null, [share]);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const requireAuth = async () => {
    let snapshot = sharedGoogleAccountManager.getSnapshot();
    let token = snapshot.account ? sharedGoogleAccountManager.getValidAccessToken(snapshot.account.accountId) : null;
    if (!snapshot.account || !token) {
      snapshot = await sharedGoogleAccountManager.signIn();
      token = snapshot.account ? sharedGoogleAccountManager.getValidAccessToken(snapshot.account.accountId) : null;
    }
    if (!snapshot.account || !token) throw new Error("請先登入 Google 帳號。");
    return { snapshot, token };
  };

  useEffect(() => {
    let active = true;
    const unregister = sharedCloudTaskManager.registerExecutor("share_publish", async (task, context) => {
      const descriptor = task.descriptor;
      const current = await getProjectRecord(descriptor.projectId);
      if (!current) return { status: "failed", stage: "專案不存在", errorCode: "project_missing", errorMessage: "來源專案已刪除，無法恢復分享發布。", retryable: false };
      if (current.storageProvider === "google_drive" && current.ownerAccountId !== task.ownerAccountId) return { status: "failed", stage: "帳戶不一致", errorCode: "account_mismatch", errorMessage: "目前帳戶不是此雲端專案擁有者。", retryable: false };
      const record = descriptor.projectSnapshot ?? (current.project.revisionToken === descriptor.snapshotRevision ? current : null);
      if (!record || record.project.revisionToken !== descriptor.snapshotRevision) return { status: "failed", stage: "共享快照不存在", errorCode: "snapshot_missing", errorMessage: "無法重建使用者確認的共享版本，已安全停止。", retryable: false };
      const existing = await getProjectShareRecord(descriptor.shareId);
      if (existing?.status === "revoked") return { status: "failed", stage: "分享已撤銷", errorCode: "share_revoked", errorMessage: "已撤銷分享不得由背景續跑重新公開。", retryable: false };
      const next = await publishProjectShare({
        record, accountId: task.ownerAccountId, accessToken: context.accessToken,
        visibility: descriptor.visibility, recipientEmails: descriptor.recipientEmails,
        existingShare: existing, requestedShareId: descriptor.shareId,
        authGeneration: context.accountGeneration,
        isGenerationValid: (_generation, accountId) => accountId === task.ownerAccountId && context.isAccountGenerationValid(),
        signal: context.signal,
        onStage: (stage) => { void context.updateProgress({ stage: `分享發布：${stage}` }).catch(() => undefined); },
      });
      if (next.status !== "published") {
        return { status: "failed", stage: "分享結果未通過驗證", errorCode: "share_validation_failed", errorMessage: "Share Pointer、Revision 或 ACL 未完成驗證。", retryable: false };
      }
      if (active) { setShare(next); onMessageRef.current("背景共享版本已發布並完成 ACL 驗證。"); }
      return { status: "completed", stage: "Share Pointer、Revision、Lifecycle 與 ACL 已驗證" };
    });
    return () => { active = false; unregister(); };
  }, []);

  if (!open) return null;

  const publishRevision = async () => {
    if (!project || busy) return;
    setBusy(true); setError(null);
    try {
      const { snapshot } = await requireAuth();
      const fresh = await prepareProjectSnapshot(project.projectId);
      if (fresh.projectId !== project.projectId) throw new Error("專案已切換，已停止發布。");
      if (fresh.storageProvider === "google_drive" && fresh.ownerAccountId !== snapshot.account!.accountId) {
        throw new Error("目前 Google 帳號不是此雲端專案擁有者。");
      }
      const shareId = share?.status !== "revoked" ? share?.shareId : undefined;
      const requestedShareId = shareId ?? `share_${crypto.randomUUID()}`;
      await sharedCloudTaskManager.enqueue({
        kind: "share_publish", ownerAccountId: snapshot.account!.accountId,
        projectId: fresh.projectId, projectName: fresh.project.name, shareId: requestedShareId,
        snapshotRevision: fresh.project.revisionToken,
        intentId: `share_publish:${snapshot.account!.accountId}:${requestedShareId}:${fresh.project.revisionToken}:${visibility}:${emails.slice().sort().join(",")}`,
        descriptor: { projectId: fresh.projectId, shareId: requestedShareId, snapshotRevision: fresh.project.revisionToken, projectSnapshot: fresh, visibility, recipientEmails: emails.slice().sort() },
      });
      onMessage("已建立背景分享發布任務；關閉視窗不會取消，完成前不會提供可用分享連結。");
    } catch (err) { setError(err instanceof Error ? err.message : "專案分享失敗。"); }
    finally { setBusy(false); }
  };

  const savePermissions = async (confirmedLinkExpansion = false) => {
    if (!share || busy) return;
    if (visibility === "link" && share.visibility !== "link" && !confirmedLinkExpansion) { setConfirmAction("link"); return; }
    setBusy(true); setError(null);
    try {
      const { snapshot, token } = await requireAuth();
      const next = await updateProjectSharePermissions({ share, accountId: snapshot.account!.accountId, accessToken: token, visibility, recipientEmails: emails });
      setShare(next); setEmailText(next.recipients.map((recipient) => recipient.email).join(", "));
      onMessage("分享名單已依 Google Drive 實際權限更新；未建立新的音訊 Revision。");
    } catch (err) { setError(err instanceof Error ? err.message : "更新分享權限失敗。"); }
    finally { setBusy(false); setConfirmAction(null); }
  };

  const repair = async () => {
    if (!share || busy) return;
    setBusy(true); setError(null);
    try {
      const { token } = await requireAuth();
      const next = await repairProjectShareState({ share, accessToken: token });
      setShare(next);
      if (next.status !== "published") throw new Error(next.lastError || "遠端分享仍不一致，需要人工檢查 Drive ACL。");
      onMessage("已重新讀取 Drive Pointer 與 ACL，分享狀態一致。");
    } catch (err) { setError(err instanceof Error ? err.message : "核對分享狀態失敗。"); }
    finally { setBusy(false); }
  };

  const discover = async () => {
    if (!project || busy) return;
    setBusy(true); setError(null);
    try {
      const { snapshot, token } = await requireAuth();
      const result = await discoverProjectSharesFromDrive({ accountId: snapshot.account!.accountId, accessToken: token });
      setDiscoveryWarning(result.complete ? null : `${result.errorMessage || "Drive 分享清單不完整。"}（略過 ${result.skippedCount} 項）`);
      const recovered = result.shares.filter((candidate) => candidate.sourceProjectId === project.projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!recovered) throw new Error("Google Drive 中找不到可驗證的此專案分享紀錄。");
      setShare(recovered); setVisibility(recovered.visibility === "link" ? "link" : "restricted"); setEmailText(recovered.recipients.map((recipient) => recipient.email).join(", "));
      onMessage("已從 Google Drive 重建本機分享紀錄，未修改遠端權限。");
    } catch (err) { setError(err instanceof Error ? err.message : "無法從 Drive 恢復分享紀錄。"); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!share || busy) return;
    setBusy(true); setError(null);
    try {
      const { snapshot, token } = await requireAuth();
      const result = await revokeProjectShare({ share, accountId: snapshot.account!.accountId, accessToken: token });
      const refreshed = await getProjectShareRecord(share.shareId); setShare(refreshed); setConfirmAction(null);
      if (!result.revoked) throw new Error("部分繼承或子檔案權限仍存在，尚未宣告完全停止分享。");
      onMessage("已停止分享；接收者先前下載或另存的檔案無法遠端收回。");
    } catch (err) { setError(err instanceof Error ? err.message : "停止分享失敗。"); }
    finally { setBusy(false); }
  };

  const copyShareLink = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); onMessage("分享連結已複製。"); }
    catch { setError("無法自動複製分享連結，請手動選取後複製。"); }
  };

  const isPublished = share?.status === "published";
  const needsRevisionUpdate = isPublished && share.sourceProjectRevision !== project?.project.revision;
  const needsArtifacts = Boolean(project?.project.songs.some((song) => song.artifactRef && !song.artifactRef.manifestFileId));
  const batchCandidates = project?.project.songs.filter((song) => song.artifactRef && !song.artifactRef.manifestFileId) ?? [];
  const batchStemCount = batchCandidates.reduce((total, song) => total + (song.artifactRef?.separationMode === "four_stem" ? 4 : 2), 0);
  const batchEstimatedBytes = batchCandidates.reduce((total, song) => {
    const ref = song.artifactRef;
    return ref ? total + ref.totalSamples * 2 * 4 * (ref.separationMode === "four_stem" ? 4 : 2) : total;
  }, 0);
  const aclDirty = isPublished && (visibility !== share.visibility || (visibility === "restricted" && emails.join(",") !== share.recipients.map((recipient) => recipient.email).sort().join(",")));
  return <>
    <div className="mixer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-share-title">
      <div className="card mixer-modal-panel project-share-dialog">
        <div className="mixer-modal-header"><div><h2 id="project-share-title">分享專案</h2><p>權限名單與音樂版本分開管理；不會公開私人原曲。</p></div><button type="button" className="btn mixer-button" disabled={busy} onClick={onClose}>關閉</button></div>
        {!project ? <p className="small">請先建立或開啟專案。</p> : <div className="grid" style={{ gap: 14 }}>
          <ProjectShareManager share={share} />
          {needsRevisionUpdate && <div className="card-warning-banner">私人專案目前為 v{project.project.revision}，共享音樂版本為 v{share.sourceProjectRevision}；不會自動發布。</div>}
          <section className="project-share-section"><div className="project-share-section-heading"><strong>權限與成員</strong>{isPublished && <button type="button" className="btn mixer-button" disabled={busy} onClick={() => void repair()}>重新核對權限</button>}</div>
            <fieldset className="project-share-options" disabled={busy}>
              <legend>分享方式</legend>
              <label><input type="radio" name="share-visibility" checked={visibility === "restricted"} onChange={() => setVisibility("restricted")} /> 指定 Google 帳號（Reader）</label>
              <label><input type="radio" name="share-visibility" checked={visibility === "link"} onChange={() => setVisibility("link")} /> 知道連結的任何人（Reader）</label>
            </fieldset>
            {visibility === "restricted" && <><label className="grid" style={{ gap: 5 }}><span className="small">新增 Email（可用逗號分隔）</span><input className="project-text-input" type="text" value={emailText} onChange={(event) => setEmailText(event.target.value)} placeholder="member@example.com" disabled={busy} /></label><div className="project-share-members" aria-label="分享成員清單">{emails.map((email) => <span className="project-share-member" key={email}><span>{email}</span><span className="small">Reader</span><button type="button" className="icon-button" aria-label={`移除 ${email}`} title="移除成員" onClick={() => { setPendingRemoval(email); setConfirmAction("remove"); }}>×</button></span>)}</div></>}
            {visibility === "link" && <div className="card-warning-banner">知道連結的人可能取得共享分軌；切換為連結分享前會再次確認。</div>}
            {isPublished && <button type="button" className="btn mixer-button primary" disabled={busy || !aclDirty || (visibility === "restricted" && emails.length === 0)} onClick={() => void savePermissions()}>{busy && <span className="mixer-spinner" aria-hidden="true" />}儲存權限變更</button>}
          </section>
          <section className="project-share-section"><strong>共享音樂版本</strong><p className="small">只有這個操作會建立不可變 Revision；內容相同的 WAV 會在同一 Share 內重用。</p><button type="button" className="btn mixer-button primary" disabled={busy || project.project.songs.length === 0 || (!isPublished && visibility === "restricted" && emails.length === 0)} onClick={() => void publishRevision()}>{busy && <span className="mixer-spinner" aria-hidden="true" />}{isPublished ? "更新共享版本" : "發布共享版本"}</button></section>
          {needsArtifacts && <div className="card-warning-banner"><span>有 {batchCandidates.length} 首已完成分軌尚無 Google Drive Manifest，共 {batchStemCount} 個 Stem，預估新增 {(batchEstimatedBytes / 1024 / 1024).toFixed(1)} MiB；裝置可用空間約 {availableStorageBytes === null ? "無法取得" : `${(availableStorageBytes / 1024 / 1024).toFixed(0)} MiB`}。{availableStorageBytes !== null && batchEstimatedBytes > availableStorageBytes ? "儲存空間風險偏高。" : "將單工逐首上傳，不會重新執行 Demucs。"}</span><button type="button" className="btn mixer-button" title="批次補齊共享成果" disabled={busy} onClick={() => setConfirmAction("batch")}>☁️ 補齊共享成果</button>{batchProgress && <><span className="small">第 {Math.min(batchProgress.completed + 1, batchProgress.total)} / {batchProgress.total} 首：{batchProgress.songName}</span><button type="button" className="btn mixer-button" title="取消批次補齊" onClick={() => batchAbortRef.current?.abort()}>⏹ 取消</button></>}</div>}
          {link && isPublished && <div className="project-share-link"><input readOnly value={link} aria-label="專案分享連結" /><button type="button" className="btn mixer-button" onClick={() => void copyShareLink()}>複製</button></div>}
          <div className="mixer-modal-actions"><button type="button" className="btn mixer-button" disabled={busy} onClick={() => void discover()}>從 Drive 恢復分享紀錄</button>{share && (share.requiresPermissionRepair || share.status === "error") && <button type="button" className="btn mixer-button" disabled={busy} onClick={() => void repair()}>修復分享狀態</button>}{isPublished && <button type="button" className="btn mixer-button danger" disabled={busy} onClick={() => setConfirmAction("revoke")}>停止分享／改回私人</button>}</div>
          {error && <div className="card-warning-banner" role="alert">{error}</div>}
          {discoveryWarning && <div className="card-warning-banner" role="alert">⚠️ {discoveryWarning} 已恢復可驗證項目，但不會宣稱完整，也不會清除異常分享。</div>}
        </div>}
      </div>
    </div>
    <ConfirmDeleteDialog open={confirmAction === "revoke"} title="停止專案分享？" subtitle="將重新讀取資料夾與子檔案 ACL，撤銷可撤銷的外部權限。" badgeLabel="權限撤銷" changeHeading="將停止" preserveHeading="仍會保留" deleteItems={["分享資料夾及共享子檔案的直接外部 Reader 權限"]} preserveItems={["私人專案與分軌", "歷史共享 Revision", "接收者已下載或另存的資料"]} recoverability="已下載資料無法遠端收回；共享副本需另行確認才能清除。" confirmLabel="停止分享" submitting={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void revoke()} />
    <ConfirmDeleteDialog open={confirmAction === "link"} title="改為連結分享？" subtitle="知道連結的人都可能取得共享音訊成果。" badgeLabel="擴大公開範圍" changeHeading="將變更" preserveHeading="仍不會公開" deleteItems={["指定對象限制；改為 Anyone Reader"]} preserveItems={["私人原曲", "其他私人專案", "Google OAuth Token"]} recoverability="可稍後改回指定對象；已下載的副本無法收回。" confirmLabel="確認連結分享" submitting={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void savePermissions(true)} />
    <ConfirmDeleteDialog open={confirmAction === "remove"} title="移除分享成員？" subtitle={pendingRemoval ?? ""} badgeLabel="移除 Reader" changeHeading="將移除" preserveHeading="不受影響" deleteItems={[pendingRemoval ?? "選取的成員"]} preserveItems={["其他成員", "共享音樂版本", "私人專案"]} recoverability="按下儲存權限變更前只修改草稿；儲存後將撤銷該直接權限。" confirmLabel="移除成員" submitting={false} onCancel={() => { setConfirmAction(null); setPendingRemoval(null); }} onConfirm={() => { if (pendingRemoval) setEmailText(emails.filter((email) => email !== pendingRemoval).join(", ")); setConfirmAction(null); setPendingRemoval(null); }} />
    <ConfirmDeleteDialog open={confirmAction === "batch"} title="批次輸出共享成果？" subtitle="是否將這些已完成的分軌成果輸出至 Google Drive，以建立共享專案？" badgeLabel="Google Drive 單工上傳" changeHeading="將新增" preserveHeading="不會執行" deleteItems={[`${batchCandidates.length} 首歌曲、${batchStemCount} 個 Stem，預估 ${(batchEstimatedBytes / 1024 / 1024).toFixed(1)} MiB`]} preserveItems={["私人原曲不會上傳", "不重新執行 Demucs", "不會未經確認發布 Share Revision"]} recoverability="可取消；已完成歌曲會保留，下次從缺少項目接續。" confirmLabel="確認逐首補齊" submitting={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => { void (async () => { const controller = new AbortController(); batchAbortRef.current = controller; setBusy(true); setError(null); setConfirmAction(null); try { const result = await onCompleteShareArtifacts(batchCandidates.map((song) => song.entryId), (completed, total, songName) => setBatchProgress({ completed, total, songName }), controller.signal); onMessage(`已補齊 ${result.completed} / ${result.total} 首共享成果；請再次確認後發布共享版本。`); } catch (err) { setError(controller.signal.aborted ? "已取消批次補齊；已完成成果會保留，下次可接續。" : err instanceof Error ? err.message : "批次補齊失敗。"); } finally { batchAbortRef.current = null; setBusy(false); setBatchProgress(null); } })(); }} />
  </>;
}
