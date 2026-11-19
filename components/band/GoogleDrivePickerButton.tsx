"use client";

import { useState } from "react";
import {
  DriveDownloadProgress,
  isGoogleDrivePickerConfigured,
  pickAndDownloadGoogleDriveAudioFiles,
} from "@/lib/google/googleDrivePicker";

type Props = {
  disabled?: boolean;
  multiple?: boolean;
  onFilesPicked: (files: File[]) => void | Promise<void>;
  onError?: (message: string) => void;
  className?: string;
};

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 雲端硬碟音檔選取按鈕：串接純前端 Google Picker 與 Drive 下載。 */
export function GoogleDrivePickerButton({
  disabled = false,
  multiple = false,
  onFilesPicked,
  onError,
  className = "",
}: Props) {
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
      const files = await pickAndDownloadGoogleDriveAudioFiles({
        multiple,
        onStageChange: (stage) => setBusyStage(stage),
        onProgress: (nextProgress) => setProgress(nextProgress),
      });
      if (files.length > 0) {
        await onFilesPicked(files);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "無法從 Google 雲端硬碟載入音檔。";
      onError?.(message);
    } finally {
      setBusyStage(null);
      setProgress(null);
    }
  };

  let label = "雲端硬碟";
  if (busyStage === "sdk") {
    label = "載入 SDK…";
  } else if (busyStage === "auth") {
    label = "Google 授權中…";
  } else if (busyStage === "picker") {
    label = "選擇雲端音檔…";
  } else if (busyStage === "downloading") {
    if (progress) {
      const prefix =
        progress.totalFiles > 1
          ? `下載 (${progress.fileIndex + 1}/${progress.totalFiles}) `
          : "下載中 ";
      if (progress.totalBytes && progress.totalBytes > 0) {
        const pct = Math.min(
          100,
          Math.round((progress.loadedBytes / progress.totalBytes) * 100)
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
      title="從 Google 雲端硬碟載入音檔（含他人共享檔案）"
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
          <path
            d="M8.5 3.5L2.5 14l3 5.2h6l-3-5.2L14.5 3.5h-6z"
            fill="#4285F4"
          />
          <path
            d="M14.5 3.5L8.5 14l3 5.2h10l-3-5.2L14.5 3.5z"
            fill="#FBBC04"
            opacity="0.9"
          />
          <path
            d="M5.5 19.2h13l3-5.2h-13l-3 5.2z"
            fill="#34A853"
          />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
