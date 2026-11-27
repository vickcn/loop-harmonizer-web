"use client";

import type { CloudTaskRecord } from "@/lib/cloudTasks/cloudTaskTypes";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function CloudTaskProgress({ task }: { task: CloudTaskRecord }) {
  const hasTotal = typeof task.totalBytes === "number" && task.totalBytes > 0;
  const percent = hasTotal ? Math.min(100, Math.round(task.completedBytes / task.totalBytes! * 100)) : null;
  const indeterminateActive = ["queued", "preparing", "running", "recovering"].includes(task.status);
  const statusText = task.status === "completed" ? "已完成"
    : task.status === "paused" ? "已暫停"
      : task.status === "cancelled" ? "已取消"
        : task.status === "failed" ? "需要處理"
          : task.status === "waiting_auth" ? "等待重新授權"
            : task.status === "waiting_network" ? "等待網路恢復"
              : task.status === "waiting_resources" ? "等待裝置資源"
                : "等待可驗證進度";
  return <div className="cloud-task-progress">
    {percent === null && indeterminateActive ? <div className="cloud-task-rolling" aria-label="執行中，進度尚無法精確計算"><span /></div> : percent !== null ? <progress max={100} value={percent} aria-label={`完成 ${percent}%`} /> : null}
    <span className="small">{hasTotal ? `${formatBytes(task.completedBytes)} / ${formatBytes(task.totalBytes!)} · ${percent}%` : task.completedBytes > 0 ? `已完成 ${formatBytes(task.completedBytes)}` : statusText}</span>
  </div>;
}
