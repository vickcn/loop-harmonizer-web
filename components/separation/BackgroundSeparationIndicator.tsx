"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sharedSeparationJobManager } from "@/lib/separation/separationJobManager";

export function BackgroundSeparationIndicator() {
  const jobs = useSyncExternalStore(
    sharedSeparationJobManager.subscribe.bind(sharedSeparationJobManager),
    sharedSeparationJobManager.getSnapshot,
    sharedSeparationJobManager.getSnapshot,
  );
  const active = jobs.find(
    (job) =>
      job.stage === "preparing" ||
      job.stage === "downloading" ||
      job.stage === "processing" ||
      job.stage === "finalizing" ||
      job.stage === "pausing" ||
      job.stage === "cancelling",
  );

  const [completedNotice, setCompletedNotice] = useState<string | null>(null);
  const previousStageByTaskRef = useRef<Map<string, string>>(new Map());
  const announcedCompletionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let newlyCompletedMsg: string | null = null;
    for (const job of jobs) {
      const prevStage = previousStageByTaskRef.current.get(job.taskId);
      const completionKey = `${job.taskId}:${job.generation}`;
      if (
        job.stage === "completed" &&
        !announcedCompletionsRef.current.has(completionKey) &&
        (prevStage === "preparing" ||
          prevStage === "downloading" ||
          prevStage === "processing" ||
          prevStage === "pausing" ||
          prevStage === "interrupted" ||
          (prevStage === undefined && Date.now() - job.updatedAt < 10_000))
      ) {
        announcedCompletionsRef.current.add(completionKey);
        newlyCompletedMsg = `${job.songName ?? "音軌分離"} 已完成分軌`;
      }
      previousStageByTaskRef.current.set(job.taskId, job.stage);
    }

    if (!newlyCompletedMsg) return;
    setCompletedNotice(newlyCompletedMsg);
    const timer = window.setTimeout(() => setCompletedNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [jobs]);

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
  const stageText =
    active.stage === "downloading"
      ? "載入模型"
      : active.stage === "finalizing"
        ? "保存結果"
      : active.stage === "pausing"
        ? "準備暫停"
        : active.stage === "cancelling"
          ? "正在停止"
          : active.isForeignActive
            ? "其他分頁背景分軌"
            : "背景分軌";
  return (
    <aside className="background-separation-indicator" aria-live="polite" aria-label="背景音軌分離任務">
      <span className="background-separation-spinner" aria-hidden="true" />
      <span className="background-separation-copy">
        <strong>{active.songName ?? "音軌分離"}</strong>
        <span>
          {stageText} · {percentage}% · {chunks}
        </span>
      </span>
    </aside>
  );
}
