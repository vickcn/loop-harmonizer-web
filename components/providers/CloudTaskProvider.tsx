"use client";

import { useEffect } from "react";
import { CloudTaskCenter } from "@/components/cloudTasks/CloudTaskCenter";
import { sharedCloudTaskManager } from "@/lib/cloudTasks/cloudTaskManager";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";

export function CloudTaskProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void sharedCloudTaskManager.initialize();
    const wake = (reason: string) => { void sharedCloudTaskManager.recover(reason); };
    const onVisibility = () => { if (document.visibilityState === "visible") wake("visibilitychange"); };
    const onOnline = () => wake("online");
    const onOffline = () => wake("offline");
    const onPageShow = () => wake("pageshow");
    const onPageHide = () => { void sharedCloudTaskManager.refreshFromStorage(); };
    const onFocus = () => wake("focus");
    const unsubscribeAuth = sharedGoogleAccountManager.subscribe(() => wake("auth-change"));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribeAuth();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return <>{children}<CloudTaskCenter /></>;
}
