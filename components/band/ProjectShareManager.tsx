"use client";

import type { ProjectShareRecord } from "@/lib/sharing/shareTypes";

const STATUS_LABELS: Record<ProjectShareRecord["status"], string> = {
  preparing: "準備共享成果",
  copying: "正在建立隔離副本",
  uploading: "正在發布 Manifest",
  granting_permission: "正在設定權限",
  validating: "正在驗證分享",
  published: "分享已發布",
  updating: "正在更新共享版本",
  revoking: "停止分享中",
  revoked: "已停止分享",
  error: "分享失敗",
};

export function ProjectShareManager({ share }: { share: ProjectShareRecord | null }) {
  if (!share) {
    return <span className="project-share-status is-private">🔒 私人</span>;
  }
  const active = ["preparing", "copying", "uploading", "granting_permission", "validating", "updating", "revoking"].includes(share.status);
  const visibility = share.visibility === "link" ? "連結分享" : share.visibility === "restricted" ? "指定對象" : "私人";
  return (
    <div className="project-share-summary" role="status" aria-live="polite">
      <span className={`project-share-status is-${share.status}`}>
        {active && <span className="mixer-spinner" aria-hidden="true" />}
        {STATUS_LABELS[share.status]}
      </span>
      <span className="small">{visibility} · 發布 v{share.sourceProjectRevision}</span>
      {share.lastError && <span className="small project-share-error">{share.lastError}</span>}
    </div>
  );
}
