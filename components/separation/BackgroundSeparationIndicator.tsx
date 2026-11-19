"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sharedSeparationJobManager, type SeparationJobState } from "@/lib/separation/separationJobManager";

const announcedCompletionKeys = new Set<string>();

function resolveStageText(active: SeparationJobState): string {
  if (active.stage === "finalizing") {
    if (
      active.isForeignActive ||
      active.retryWaitReason === "foreign_lock" ||
      active.retryWaitReason === "foreign_lease"
    ) {
      return "其他分頁正在處理";
    }
    if (active.isActivelyFinalizing) {
      return "正在保存結果";
    }
    if (active.retryWaitReason === "storage_unavailable") {
      return "請釋放空間後重試保存";
    }
    if (active.autoResumeExhausted || active.requiresManualAction) {
      return "保存未完成，請手動重試";
    }
    return "分軌已完成，等待保存";
  }
  if (active.stage === "downloading") return "載入模型";
  if (active.stage === "pausing") return "準備暫停";
  if (active.stage === "cancelling") return "正在停止";
  if (active.isForeignActive) return "其他分頁正在處理";
  if (active.stage === "processing" && active.totalChunks > 0) {
    const current = Math.min(active.completedChunks + 1, active.totalChunks);
    return `分離第 ${current} / ${active.totalChunks} 段`;
  }
  return "背景分軌";
}

export function BackgroundSeparationIndicator() {
  const jobs = useSyncExternalStore(
    sharedSeparationJobManager.subscribe.bind(sharedSeparationJobManager),
    sharedSeparationJobManager.getSnapshot,
    sharedSeparationJobManager.getSnapshot,
  );
  const active =
    jobs.find(
      (job) =>
        job.stage === "preparing" ||
        job.stage === "downloading" ||
        job.stage === "processing" ||
        (job.stage === "finalizing" && Boolean(job.isActivelyFinalizing)) ||
        job.stage === "pausing" ||
        job.stage === "cancelling",
    ) ?? jobs.find((job) => job.stage === "finalizing");

  const [completedNotice, setCompletedNotice] = useState<string | null>(null);
  const previousStageByTaskRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let newlyCompletedMsg: string | null = null;
    for (const job of jobs) {
      const prevStage = previousStageByTaskRef.current.get(job.taskId);
      const completionKey = `${job.taskId}:${job.generation}`;
      if (
        job.stage === "completed" &&
        !announcedCompletionKeys.has(completionKey) &&
        (prevStage === "preparing" ||
          prevStage === "downloading" ||
          prevStage === "processing" ||
          prevStage === "finalizing" ||
          prevStage === "pausing" ||
          prevStage === "interrupted" ||
          (prevStage === undefined && Date.now() - job.updatedAt < 10_000))
      ) {
        announcedCompletionKeys.add(completionKey);
        newlyCompletedMsg = `${job.songName ?? "音軌分離"} 已完成分軌`;
      }
      previousStageByTaskRef.current.set(job.taskId, job.stage);
    }

    if (newlyCompletedMsg) {
      setCompletedNotice(newlyCompletedMsg);
    }
  }, [jobs]);

  useEffect(() => {
    if (!completedNotice) return;
    const timer = window.setTimeout(() => setCompletedNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [completedNotice]);

  if (!active && !completedNotice) return null;
  if (!active) {
    return (
      <aside className="background-separation-indicator" aria-live="polite">
        ✓ {completedNotice}
      </aside>
    );
  }
  const percentage = Math.round(Math.max(0, Math.min(1, active.progress)) * 100);
  const chunks =
    active.totalChunks > 0 ? `${active.completedChunks}/${active.totalChunks} chunks` : "準備中";
  const stageText = resolveStageText(active);
  const showSpinner = active.stage !== "finalizing" || Boolean(active.isActivelyFinalizing);
  const canRetryFinalization =
    active.stage === "finalizing" && !active.isActivelyFinalizing && !active.isForeignActive;
  return (
    <aside className="background-separation-indicator" aria-live="polite" aria-label="背景音軌分離任務">
      {showSpinner ? <span className="background-separation-spinner" aria-hidden="true" /> : null}
      <span className="background-separation-copy">
        <strong>{active.songName ?? "音軌分離"}</strong>
        <span>
          {stageText} · {percentage}% · {chunks}
        </span>
      </span>
      {canRetryFinalization ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "5px 10px", fontSize: 12, borderRadius: 9, flexShrink: 0 }}
          onClick={() => void sharedSeparationJobManager.retryFinalization(active.taskId)}
        >
          ↻ 重試保存
        </button>
      ) : null}
    </aside>
  );
}
