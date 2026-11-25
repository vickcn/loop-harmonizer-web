"use client";

import { useEffect, useMemo, useState } from "react";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";
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
  onCompleteShareArtifacts: () => void;
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
  const [confirmAction, setConfirmAction] = useState<"revoke" | "link" | "remove" | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

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

  const emails = useMemo(() => parseEmails(emailText), [emailText]);
  const link = useMemo(() => share ? buildProjectShareUrl(share, typeof window !== "undefined" ? window.location.origin : undefined) : null, [share]);
  if (!open) return null;

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

  const publishRevision = async () => {
    if (!project || busy) return;
    setBusy(true); setError(null);
    try {
      const { snapshot, token } = await requireAuth();
      const fresh = await prepareProjectSnapshot(project.projectId);
      if (fresh.projectId !== project.projectId || fresh.ownerAccountId !== snapshot.account!.accountId) throw new Error("專案或 Google 帳號已切換，已停止發布。");
      const next = await publishProjectShare({
        record: fresh,
        accountId: snapshot.account!.accountId,
        accessToken: token,
        visibility,
        recipientEmails: emails,
        existingShare: share?.status === "revoked" ? null : share,
        authGeneration: snapshot.generation,
        isGenerationValid: sharedGoogleAccountManager.isGenerationValid,
        onStage: (stage) => setShare((current) => current ? { ...current, status: stage } : current),
      });
      setShare(next);
      onMessage(share?.status === "published" ? "共享音樂版本已更新。" : "專案分享已發布。");
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
      if (!result.complete) throw new Error(result.errorMessage || "Drive 分享清單不完整。");
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
          {needsArtifacts && <div className="card-warning-banner"><span>部分已完成分軌尚無 Google Drive Manifest，發布前需由使用者確認輸出。</span><button type="button" className="btn mixer-button" disabled={busy} onClick={onCompleteShareArtifacts}>補齊共享成果</button></div>}
          {link && isPublished && <div className="project-share-link"><input readOnly value={link} aria-label="專案分享連結" /><button type="button" className="btn mixer-button" onClick={() => void copyShareLink()}>複製</button></div>}
          <div className="mixer-modal-actions"><button type="button" className="btn mixer-button" disabled={busy} onClick={() => void discover()}>從 Drive 恢復分享紀錄</button>{share && (share.requiresPermissionRepair || share.status === "error") && <button type="button" className="btn mixer-button" disabled={busy} onClick={() => void repair()}>修復分享狀態</button>}{isPublished && <button type="button" className="btn mixer-button danger" disabled={busy} onClick={() => setConfirmAction("revoke")}>停止分享／改回私人</button>}</div>
          {error && <div className="card-warning-banner" role="alert">{error}</div>}
        </div>}
      </div>
    </div>
    <ConfirmDeleteDialog open={confirmAction === "revoke"} title="停止專案分享？" subtitle="將重新讀取資料夾與子檔案 ACL，撤銷可撤銷的外部權限。" badgeLabel="權限撤銷" changeHeading="將停止" preserveHeading="仍會保留" deleteItems={["分享資料夾及共享子檔案的直接外部 Reader 權限"]} preserveItems={["私人專案與分軌", "歷史共享 Revision", "接收者已下載或另存的資料"]} recoverability="已下載資料無法遠端收回；共享副本需另行確認才能清除。" confirmLabel="停止分享" submitting={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void revoke()} />
    <ConfirmDeleteDialog open={confirmAction === "link"} title="改為連結分享？" subtitle="知道連結的人都可能取得共享音訊成果。" badgeLabel="擴大公開範圍" changeHeading="將變更" preserveHeading="仍不會公開" deleteItems={["指定對象限制；改為 Anyone Reader"]} preserveItems={["私人原曲", "其他私人專案", "Google OAuth Token"]} recoverability="可稍後改回指定對象；已下載的副本無法收回。" confirmLabel="確認連結分享" submitting={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void savePermissions(true)} />
    <ConfirmDeleteDialog open={confirmAction === "remove"} title="移除分享成員？" subtitle={pendingRemoval ?? ""} badgeLabel="移除 Reader" changeHeading="將移除" preserveHeading="不受影響" deleteItems={[pendingRemoval ?? "選取的成員"]} preserveItems={["其他成員", "共享音樂版本", "私人專案"]} recoverability="按下儲存權限變更前只修改草稿；儲存後將撤銷該直接權限。" confirmLabel="移除成員" submitting={false} onCancel={() => { setConfirmAction(null); setPendingRemoval(null); }} onConfirm={() => { if (pendingRemoval) setEmailText(emails.filter((email) => email !== pendingRemoval).join(", ")); setConfirmAction(null); setPendingRemoval(null); }} />
  </>;
}
