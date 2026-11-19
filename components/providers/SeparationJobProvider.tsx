"use client";

import { useEffect } from "react";
import { BackgroundSeparationIndicator } from "@/components/separation/BackgroundSeparationIndicator";
import { sharedSeparationJobManager } from "@/lib/separation/separationJobManager";

/**
 * RootLayout 層唯一的頁面生命週期與背景任務恢復器：
 * - hidden / freeze 不會停止或釋放執行中的背景分軌任務；
 * - 透過 SeparationJobManager 獨立從 IndexedDB 重建 Descriptor 續跑，不依賴 BandMixer 掛載
 *   （因此重新整理後直接停留在 /studio 等其他路由也能自動安全恢復）。
 */
export function SeparationJobProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let disposed = false;
    const triggerRecovery = (reason: string, debounceMs = 0) => {
      if (disposed) return;
      void sharedSeparationJobManager.triggerLifecycleRecovery(reason, debounceMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerRecovery("visibilitychange", 200);
      }
    };
    const onPageShow = () => triggerRecovery("pageshow", 200);
    const onResume = () => triggerRecovery("resume", 200);
    const onOnline = () => triggerRecovery("online", 200);
    const onFreeze = () => {
      // Chunk commit 是正確性的邊界；freeze 只留給瀏覽器自行排程，絕不在此取消 Worker。
    };

    triggerRecovery("mount", 0);
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

  return (
    <>
      {children}
      <BackgroundSeparationIndicator />
    </>
  );
}
