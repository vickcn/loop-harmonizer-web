"use client";

import { useState, useSyncExternalStore } from "react";
import {
  downloadGoogleDriveFile,
  isGoogleDrivePickerConfigured,
  openGoogleDrivePicker,
  getGoogleDriveConfig,
  type DriveDownloadProgress,
  type PickedDriveFile,
} from "@/lib/google/googleDrivePicker";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";

type Props = {
  disabled?: boolean;
  multiple?: boolean;
  onFilesPicked?: (files: File[]) => void | Promise<void>;
  onMetadataPicked?: (
    pickedFiles: PickedDriveFile[],
    context: { accountId: string; generation: number; accessToken: string },
  ) => void | Promise<void>;
  onError?: (message: string) => void;
  className?: string;
};

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 雲端硬碟音檔選取按鈕：串接共用 Google Account Manager 與 Google Picker。 */
export function GoogleDrivePickerButton({
  disabled = false,
  multiple = false,
  onFilesPicked,
  onMetadataPicked,
  onError,
  className = "",
}: Props) {
  const auth = useSyncExternalStore(
    sharedGoogleAccountManager.subscribe,
    sharedGoogleAccountManager.getSnapshot,
    sharedGoogleAccountManager.getSnapshot,
  );
  const [busyStage, setBusyStage] = useState<
    null | "sdk" | "auth" | "picker" | "downloading"
  >(null);
  const [progress, setProgress] = useState<DriveDownloadProgress | null>(null);

  if (!isGoogleDrivePickerConfigured()) {
    return null;
  }

  const isBusy = busyStage !== null;

  const handleClick = async () => {
    if (disabled || isBusy) return;
    setProgress(null);
    try {
      setBusyStage("sdk");
      await sharedGoogleAccountManager.prepareSdk();

      let token = sharedGoogleAccountManager.getValidAccessToken();
      let accountId = sharedGoogleAccountManager.getSnapshot().account?.accountId ?? "";
      let generation = sharedGoogleAccountManager.getSnapshot().generation;

      if (!token || !accountId) {
        setBusyStage("auth");
        const nextSnap = await sharedGoogleAccountManager.signIn();
        token = sharedGoogleAccountManager.getValidAccessToken();
        accountId = nextSnap.account?.accountId ?? "";
        generation = nextSnap.generation;
      }

      if (!token || !accountId) {
        throw new Error("尚未完成 Google 帳號授權，無法開啟雲端硬碟選單。");
      }

      const cfg = getGoogleDriveConfig();
      setBusyStage("picker");
      const picked = await openGoogleDrivePicker({
        accessToken: token,
        apiKey: cfg.apiKey,
        appId: cfg.appId,
        multiple,
      });

      if (picked.length === 0) {
        return;
      }

      if (!sharedGoogleAccountManager.isGenerationValid(generation, accountId)) {
        throw new Error("Google 帳號狀態已切換，請重新選取檔案。");
      }

      if (onMetadataPicked) {
        await onMetadataPicked(picked, { accountId, generation, accessToken: token });
        return;
      }

      if (onFilesPicked) {
        setBusyStage("downloading");
        const downloaded: File[] = [];
        for (let i = 0; i < picked.length; i += 1) {
          const file = await downloadGoogleDriveFile({
            file: picked[i],
            accessToken: token,
            fileIndex: i,
            totalFiles: picked.length,
            onProgress: (p) => setProgress(p),
          });
          downloaded.push(file);
        }
        if (downloaded.length > 0) {
          await onFilesPicked(downloaded);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "無法從 Google 雲端硬碟載入音檔。";
      if (!/已取消/.test(message)) {
        onError?.(message);
      }
    } finally {
      setBusyStage(null);
      setProgress(null);
    }
  };

  let label = auth.status === "expired" ? "雲端硬碟（需重授權）" : "雲端硬碟";
  if (busyStage === "sdk") {
    label = "準備 Google SDK…";
  } else if (busyStage === "auth") {
    label = "等待 Google 授權…";
  } else if (busyStage === "picker") {
    label = "等待使用者選擇…";
  } else if (busyStage === "downloading") {
    if (progress) {
      const prefix =
        progress.totalFiles > 1
          ? `下載 (${progress.fileIndex + 1}/${progress.totalFiles}) `
          : "下載中 ";
      if (progress.totalBytes && progress.totalBytes > 0) {
        const pct = Math.min(
          100,
          Math.round((progress.loadedBytes / progress.totalBytes) * 100),
        );
        label = `${prefix}${pct}%`;
      } else {
        label = `${prefix}${formatMb(progress.loadedBytes)}`;
      }
    } else {
      label = "準備下載…";
    }
  }

  return (
    <button
      type="button"
      className={`btn mixer-button${isBusy ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled || isBusy}
      aria-busy={isBusy}
      title="從 Google 雲端硬碟選取音檔（含與我共用及共用雲端硬碟）"
      onClick={() => void handleClick()}
    >
      {isBusy ? (
        <span className="mixer-spinner" aria-hidden="true" />
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M8.5 3.5L2.5 14l3 5.2h6l-3-5.2L14.5 3.5h-6z" fill="#4285F4" />
          <path d="M14.5 3.5L8.5 14l3 5.2h10l-3-5.2L14.5 3.5z" fill="#FBBC04" opacity="0.9" />
          <path d="M5.5 19.2h13l3-5.2h-13l-3 5.2z" fill="#34A853" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
