"use client";

import type { CloudTaskRecord } from "@/lib/cloudTasks/cloudTaskTypes";
import { CloudTaskProgress } from "./CloudTaskProgress";

const KIND_LABEL: Record<CloudTaskRecord["kind"], string> = { project_sync: "專案同步", original_backup: "原曲備份", stem_export: "分軌輸出", share_publish: "發布分享" };

export function CloudTaskList({ tasks, onPause, onResume, onCancel, onRetry, onReauthorize }: {
  tasks: readonly CloudTaskRecord[];
  onPause: (taskId: string) => void; onResume: (taskId: string) => void; onCancel: (task: CloudTaskRecord) => void;
  onRetry: (taskId: string) => void; onReauthorize: (taskId: string) => void;
}) {
  if (!tasks.length) return <p className="small">目前沒有背景雲端任務。只有使用者明確按下同步、備份、輸出或發布後才會建立任務。</p>;
  return <div className="cloud-task-list">{tasks.map((task) => {
    const running = ["queued", "preparing", "running", "recovering"].includes(task.status);
    const canPause = running || ["waiting_network", "waiting_resources"].includes(task.status);
    return <article key={task.taskId} className="cloud-task-item">
      <div className="cloud-task-item-head"><div><strong>{KIND_LABEL[task.kind]}</strong><div className="small">{task.projectName || task.songName || task.projectId || task.songId || task.shareId}</div></div><span className={`project-share-status is-${task.status}`}>{running && <span className="mixer-spinner" aria-hidden="true" />}{task.status}</span></div>
      <div className="small">{task.stage}{task.currentFileName ? ` · ${task.currentFileName}` : ""}</div>
      <CloudTaskProgress task={task} />
      {task.totalFiles ? <div className="small">檔案 {task.completedFiles ?? 0} / {task.totalFiles} · Retry {task.retryCount}</div> : <div className="small">Retry {task.retryCount}</div>}
      {task.errorMessage && <div className="small project-share-error">{task.errorMessage}</div>}
      <div className="cloud-task-actions">
        {canPause && <button type="button" className="btn mixer-button" title="暫停任務" onClick={() => onPause(task.taskId)}>⏸ 暫停</button>}
        {task.status === "paused" && <button type="button" className="btn mixer-button primary" title="繼續任務" onClick={() => onResume(task.taskId)}>▶ 繼續</button>}
        {task.status === "waiting_auth" && <button type="button" className="btn mixer-button primary" title="重新授權 Google" onClick={() => onReauthorize(task.taskId)}>↻ 重新授權</button>}
        {task.status === "failed" && <button type="button" className="btn mixer-button" title="重試任務" onClick={() => onRetry(task.taskId)}>↻ 重試</button>}
        {!(["completed", "cancelled"].includes(task.status)) && <button type="button" className="btn mixer-button danger" title="取消任務" onClick={() => onCancel(task)}>× 取消</button>}
      </div>
    </article>;
  })}</div>;
}
