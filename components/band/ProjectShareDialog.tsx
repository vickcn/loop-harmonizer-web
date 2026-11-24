"use client";

import { useEffect, useMemo, useState } from "react";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";
import type { PersistedProjectRecord } from "@/lib/projects/projectTypes";
import {
  buildProjectShareUrl,
  getProjectShareRecord,
  listProjectSharesBySourceProject,
  publishProjectShare,
  revokeProjectShare,
} from "@/lib/sharing/shareManager";
import type { ProjectShareRecord, ProjectShareVisibility } from "@/lib/sharing/shareTypes";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { ProjectShareManager } from "./ProjectShareManager";

type Props = {
  open: boolean;
  project: PersistedProjectRecord | null;
  onClose: () => void;
  onMessage: (message: string) => void;
};

export function ProjectShareDialog({ open, project, onClose, onMessage }: Props) {
  const [share, setShare] = useState<ProjectShareRecord | null>(null);
  const [visibility, setVisibility] = useState<Exclude<ProjectShareVisibility, "private">>("restricted");
  const [emailText, setEmailText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    let active = true;
    void listProjectSharesBySourceProject(project.projectId).then((rows) => {
      if (!active) return;
      const latest = rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      setShare(latest);
      if (latest?.visibility === "link" || latest?.visibility === "restricted") setVisibility(latest.visibility);
      setEmailText(latest?.recipients.map((r) => r.email).join(", ") ?? "");
    });
    return () => { active = false; };
  }, [open, project]);

  const link = useMemo(() => share ? buildProjectShareUrl(share, typeof window !== "undefined" ? window.location.origin : undefined) : null, [share]);
  if (!open) return null;

  const requireAuth = async () => {
    let snap = sharedGoogleAccountManager.getSnapshot();
    let token = sharedGoogleAccountManager.getValidAccessToken();
    if (!snap.account || !token) {
      snap = await sharedGoogleAccountManager.signIn();
      token = sharedGoogleAccountManager.getValidAccessToken();
    }
    if (!snap.account || !token) throw new Error("請先登入 Google 帳號。");
    return { snap, token };
  };

  const publish = async () => {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { snap, token } = await requireAuth();
      const next = await publishProjectShare({
        record: project,
        accountId: snap.account!.accountId,
        accessToken: token,
        visibility,
        recipientEmails: emailText.split(/[\s,;]+/).filter(Boolean),
        existingShare: share?.status === "revoked" ? null : share,
        authGeneration: snap.generation,
        isGenerationValid: sharedGoogleAccountManager.isGenerationValid,
        onStage: (stage) => setShare((current) => current ? { ...current, status: stage } : current),
      });
      setShare(next);
      onMessage(share?.status === "published" ? "共享版本已更新。" : "專案分享已發布。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "專案分享失敗。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!share || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { snap, token } = await requireAuth();
      const result = await revokeProjectShare({ share, accountId: snap.account!.accountId, accessToken: token });
      const refreshed = await getProjectShareRecord(share.shareId);
      setShare(refreshed);
      setConfirmRevoke(false);
      if (!result.revoked) throw new Error("部分繼承或額外權限仍存在，尚未宣告完全停止分享。");
      onMessage("已停止分享；接收者先前下載或另存的檔案無法遠端收回。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "停止分享失敗。");
    } finally {
      setBusy(false);
    }
  };

  const copyShareLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onMessage("分享連結已複製。");
    } catch {
      setError("無法自動複製分享連結，請手動選取連結後複製。");
    }
  };

  const isPublished = share?.status === "published";
  const needsUpdate = isPublished && share.sourceProjectRevision !== project?.project.revision;
  return (
    <>
      <div className="mixer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-share-title">
        <div className="card mixer-modal-panel project-share-dialog">
          <div className="mixer-modal-header">
            <div><h2 id="project-share-title">分享專案</h2><p>發布獨立唯讀快照，不會開放私人專案或原曲。</p></div>
            <button type="button" className="btn mixer-button" disabled={busy} onClick={onClose}>關閉</button>
          </div>
          {!project ? <p className="small">請先建立或開啟專案。</p> : (
            <div className="grid" style={{ gap: 14 }}>
              <ProjectShareManager share={share} />
              {needsUpdate && <div className="card-warning-banner">私人專案目前為 v{project.project.revision}，已分享版本為 v{share.sourceProjectRevision}；只會在您按下更新後發布。</div>}
              <fieldset className="project-share-options" disabled={busy}>
                <legend>分享方式</legend>
                <label><input type="radio" name="share-visibility" checked={visibility === "restricted"} onChange={() => setVisibility("restricted")} /> 指定 Google 帳號（唯讀）</label>
                <label><input type="radio" name="share-visibility" checked={visibility === "link"} onChange={() => setVisibility("link")} /> 知道連結的任何人（唯讀）</label>
              </fieldset>
              {visibility === "restricted" && <label className="grid" style={{ gap: 5 }}><span className="small">受邀者 Email（可用逗號分隔）</span><input className="project-text-input" type="text" value={emailText} onChange={(e) => setEmailText(e.target.value)} placeholder="member@example.com" disabled={busy} /></label>}
              {visibility === "link" && <div className="card-warning-banner">知道連結的人可能取得此共享專案的音訊成果；不會包含原始 MP3／WAV。</div>}
              <p className="small" style={{ margin: 0 }}>分享時會建立隔離的 WAV 副本並占用 Google Drive 空間；不會重新執行 Demucs。</p>
              {link && isPublished && <div className="project-share-link"><input readOnly value={link} aria-label="專案分享連結" /><button type="button" className="btn mixer-button" onClick={() => void copyShareLink()}>複製</button></div>}
              {error && <div className="card-warning-banner" role="alert">{error}</div>}
              <div className="mixer-modal-actions">
                <button type="button" className="btn mixer-button primary" disabled={busy || (visibility === "restricted" && !emailText.trim()) || project.project.songs.length === 0} onClick={() => void publish()}>
                  {busy && <span className="mixer-spinner" aria-hidden="true" />}{isPublished ? "更新共享版本" : "發布共享版本"}
                </button>
                {isPublished && <button type="button" className="btn mixer-button danger" disabled={busy} onClick={() => setConfirmRevoke(true)}>停止分享／改回私人</button>}
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDeleteDialog
        open={confirmRevoke}
        title="停止專案分享？"
        subtitle="將重新讀取 Drive ACL 並撤銷可撤銷的外部權限。"
        badgeLabel="權限撤銷"
        changeHeading="將停止"
        preserveHeading="仍會保留"
        deleteItems={["分享資料夾的指定對象或連結讀取權限"]}
        preserveItems={["您的私人專案與分軌", "已發布快照紀錄", "接收者已下載或另存的資料"]}
        recoverability="停止後可再次發布新分享；已由他人下載的檔案無法遠端收回。"
        confirmLabel="停止分享"
        submitting={busy}
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={() => void revoke()}
      />
    </>
  );
}
