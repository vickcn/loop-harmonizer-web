"use client";

import { useState } from "react";
import { GoogleAccountButton } from "@/components/google/GoogleAccountButton";
import { getGoogleDriveConfig, openGoogleDrivePicker } from "@/lib/google/googleDrivePicker";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";
import { loadAndValidateSharedProject } from "@/lib/sharing/shareAccessValidator";
import { importSharedProjectMetadata } from "@/lib/sharing/shareImportManager";
import type { ProjectShareManifest } from "@/lib/sharing/shareTypes";
import { SharedProjectPreview } from "./SharedProjectPreview";

export function SharedProjectImportDialog({ shareId, pointerFileId }: { shareId: string; pointerFileId: string }) {
  const [selectedFileId, setSelectedFileId] = useState(pointerFileId);
  const [manifest, setManifest] = useState<ProjectShareManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const auth = async () => {
    let snap = sharedGoogleAccountManager.getSnapshot();
    let token = sharedGoogleAccountManager.getValidAccessToken();
    if (!snap.account || !token) { snap = await sharedGoogleAccountManager.signIn(); token = sharedGoogleAccountManager.getValidAccessToken(); }
    if (!snap.account || !token) throw new Error("請先登入具有分享權限的 Google 帳號。");
    return { snap, token };
  };
  const load = async (fileId = selectedFileId) => {
    setBusy(true); setMessage(null);
    try {
      const { token } = await auth();
      const loaded = await loadAndValidateSharedProject({ shareId, pointerFileId: fileId, accessToken: token });
      setSelectedFileId(fileId); setManifest(loaded.manifest);
    } catch (err) { setMessage(err instanceof Error ? err.message : "無法讀取共享專案。"); }
    finally { setBusy(false); }
  };
  const pick = async () => {
    setBusy(true); setMessage(null);
    try {
      const { token } = await auth();
      await sharedGoogleAccountManager.prepareSdk();
      const cfg = getGoogleDriveConfig();
      const picked = await openGoogleDrivePicker({ accessToken: token, apiKey: cfg.apiKey, appId: cfg.appId, mimeTypes: "application/json", title: "選取 Loop Harmonizer share.json" });
      if (picked[0]) await load(picked[0].id);
      else setBusy(false);
    } catch (err) { setMessage(err instanceof Error ? err.message : "無法選取共享檔案。"); setBusy(false); }
  };
  const importProject = async () => {
    if (!manifest) return;
    setBusy(true); setMessage(null);
    try {
      const { snap } = await auth();
      const record = await importSharedProjectMetadata({ manifest, recipientAccountId: snap.account!.accountId, pointerFileId: selectedFileId });
      setMessage(`已匯入「${record.project.name}」。返回歌曲混音器後可按需下載分軌，不會重新執行 Demucs。`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "匯入共享專案失敗。"); }
    finally { setBusy(false); }
  };
  return <section className="card shared-project-import">
    <div className="mixer-modal-header"><div><h1>匯入共享專案</h1><p>Google Drive ACL 是實際授權依據；分享連結本身不授權存取。</p></div><GoogleAccountButton onError={setMessage} /></div>
    {!manifest ? <div className="grid" style={{ gap: 10 }}><button type="button" className="btn mixer-button primary" disabled={busy || !selectedFileId} onClick={() => void load()}>{busy && <span className="mixer-spinner" aria-hidden="true" />}驗證並預覽</button><button type="button" className="btn mixer-button" disabled={busy} onClick={() => void pick()}>從「與我共用」選取 share.json</button><p className="small">若 `drive.file` 尚未授權此共享檔案，請透過 Picker 明確選取一次。</p></div> : <><SharedProjectPreview manifest={manifest} /><button type="button" className="btn mixer-button primary" disabled={busy} onClick={() => void importProject()}>{busy && <span className="mixer-spinner" aria-hidden="true" />}匯入為我的獨立專案</button></>}
    {message && <div className="card-warning-banner" role="status">{message}</div>}
  </section>;
}
