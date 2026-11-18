"use client";

import { useEffect } from "react";
import { BackgroundSeparationIndicator } from "@/components/separation/BackgroundSeparationIndicator";
import { sharedSeparationJobManager } from "@/lib/separation/separationJobManager";

/** Layout 層唯一的頁面生命週期監聽器；hidden/freeze 不會停止或釋放任務。 */
export function SeparationJobProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (disposed) return;
      void sharedSeparationJobManager.refreshFromStorage().then(async () => {
        if (disposed || document.visibilityState === "hidden") return;
        const interrupted = sharedSeparationJobManager.getJobs().filter((job) => job.stage === "interrupted");
        for (const job of interrupted) {
          if (await sharedSeparationJobManager.requestAutoResume(job.taskId)) break;
        }
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onPageShow = () => refresh();
    const onResume = () => refresh();
    const onOnline = () => refresh();
    const onFreeze = () => {
      // Chunk commit 是正確性的邊界；freeze 只留給瀏覽器自行排程，絕不在此取消 Worker。
    };

    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return <>{children}<BackgroundSeparationIndicator /></>;
}
