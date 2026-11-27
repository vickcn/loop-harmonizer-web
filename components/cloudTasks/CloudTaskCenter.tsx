"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { sharedCloudTaskManager } from "@/lib/cloudTasks/cloudTaskManager";
import type { CloudTaskRecord } from "@/lib/cloudTasks/cloudTaskTypes";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";
import { ConfirmDeleteDialog } from "@/components/band/ConfirmDeleteDialog";
import { CloudTaskList } from "./CloudTaskList";

export function CloudTaskCenter() {
  const tasks = useSyncExternalStore(sharedCloudTaskManager.subscribe, sharedCloudTaskManager.getSnapshot, sharedCloudTaskManager.getServerSnapshot);
  const [open, setOpen] = useState(false);
  const [cancelTask, setCancelTask] = useState<CloudTaskRecord | null>(null);
  const activeCount = tasks.filter((task) => !["completed", "cancelled", "failed"].includes(task.status)).length;
  useEffect(() => {
    const openCenter = () => setOpen(true);
    window.addEventListener("loop:open-cloud-task-center", openCenter);
    return () => window.removeEventListener("loop:open-cloud-task-center", openCenter);
  }, []);
  return <>
    <button type="button" className="cloud-task-center-trigger" title="背景雲端任務" aria-label={`背景雲端任務${activeCount ? `，${activeCount} 項進行中` : ""}`} onClick={() => setOpen(true)}>☁️<span>任務</span>{activeCount > 0 && <b>{activeCount}</b>}</button>
    {open && <div className="mixer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cloud-task-center-title"><div className="card mixer-modal-panel cloud-task-center"><div className="mixer-modal-header"><div><h2 id="cloud-task-center-title">背景雲端任務</h2><p>關閉此視窗不會取消任務；瀏覽器凍結後會從安全進度恢復。</p></div><button type="button" className="btn mixer-button" title="關閉任務中心" onClick={() => setOpen(false)}>× 關閉</button></div><CloudTaskList tasks={tasks} onPause={(id) => void sharedCloudTaskManager.pause(id)} onResume={(id) => void sharedCloudTaskManager.resume(id)} onRetry={(id) => void sharedCloudTaskManager.retry(id)} onCancel={setCancelTask} onReauthorize={(id) => { void sharedGoogleAccountManager.reauthorize().then(() => sharedCloudTaskManager.resume(id)); }} /></div></div>}
    <ConfirmDeleteDialog open={Boolean(cancelTask)} title="取消背景雲端任務？" subtitle={cancelTask?.projectName || cancelTask?.songName || ""} badgeLabel="停止自動恢復" changeHeading="將取消" preserveHeading="仍會保留" deleteItems={["目前請求與後續自動重試"]} preserveItems={["本機專案與音訊", "已成功提交的遠端檔案", "可供後續修復的進度紀錄"]} recoverability="已完成的 Google Drive 操作不會假裝回滾；取消後不會自動重啟。" confirmLabel="確認取消" submitting={false} onCancel={() => setCancelTask(null)} onConfirm={() => { if (cancelTask) void sharedCloudTaskManager.cancel(cancelTask.taskId); setCancelTask(null); }} />
  </>;
}
