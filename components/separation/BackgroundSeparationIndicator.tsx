"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { sharedSeparationJobManager } from "@/lib/separation/separationJobManager";

export function BackgroundSeparationIndicator() {
  const jobs = useSyncExternalStore(
    sharedSeparationJobManager.subscribe.bind(sharedSeparationJobManager),
    sharedSeparationJobManager.getSnapshot,
    sharedSeparationJobManager.getSnapshot,
  );
  const active = jobs.find((job) =>
    job.stage === "preparing" || job.stage === "downloading" || job.stage === "processing" || job.stage === "pausing",
  );
  const [completedNotice, setCompletedNotice] = useState<string | null>(null);
  useEffect(() => {
    const completed = jobs.find((job) => job.stage === "completed");
    if (!completed) return;
    setCompletedNotice(`${completed.songName ?? "音源分離"} 已完成分軌`);
    const timer = window.setTimeout(() => setCompletedNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [jobs]);
  if (!active && !completedNotice) return null;
  if (!active) {
    return <aside className="background-separation-indicator" aria-live="polite">✓ {completedNotice}</aside>;
  }
  const percentage = Math.round(active.progress * 100);
  const chunks = active.totalChunks > 0 ? `${active.completedChunks}/${active.totalChunks} chunks` : "準備中";
  return (
    <aside className="background-separation-indicator" aria-live="polite" aria-label="背景音源分離任務">
      <span className="background-separation-spinner" aria-hidden="true" />
      <span className="background-separation-copy">
        <strong>{active.songName ?? "音源分離"}</strong>
        <span>{active.stage === "downloading" ? "載入模型" : "背景分軌"} · {percentage}% · {chunks}</span>
      </span>
    </aside>
  );
}
