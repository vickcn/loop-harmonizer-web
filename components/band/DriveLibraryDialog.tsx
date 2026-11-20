"use client";

import { useEffect, useState } from "react";
import type { GoogleAccount } from "@/lib/google/googleAuthTypes";
import type {
  DriveLibraryEntry,
  DriveRestoreProgress,
  InvalidDriveLibraryEntry,
} from "@/lib/google/driveRestoreManager";

type Props = {
  open: boolean;
  account: GoogleAccount | null;
  loading: boolean;
  entries: DriveLibraryEntry[];
  invalidEntries: InvalidDriveLibraryEntry[];
  restoreProgress: DriveRestoreProgress | null;
  restoringManifestId: string | null;
  errorMessage: string | null;
  onRefresh: () => void;
  onRestoreEntry: (entry: DriveLibraryEntry, options: { includeOriginalAudio: boolean }) => void | Promise<void>;
  onDeleteEntry: (entry: DriveLibraryEntry) => void;
  onCancelRestore: () => void;
  onClose: () => void;
};

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function DriveLibraryDialog({
  open,
  account,
  loading,
  entries,
  invalidEntries,
  restoreProgress,
  restoringManifestId,
  errorMessage,
  onRefresh,
  onRestoreEntry,
  onDeleteEntry,
  onCancelRestore,
  onClose,
}: Props) {
  const [includeOriginalById, setIncludeOriginalById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !restoringManifestId) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, restoringManifestId, onClose]);

  if (!open) return null;

  const isRestoring = Boolean(restoringManifestId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-library-dialog-title"
      className="mixer-modal-backdrop"
      onClick={(event) => {
        if (!isRestoring && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="card mixer-modal-panel" style={{ width: "min(680px, 100%)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div className="grid" style={{ gap: 4 }}>
            <strong id="drive-library-dialog-title" style={{ fontSize: 16 }}>
              我的雲端音樂成果（.loopHarmonizer）
            </strong>
            <span className="small" style={{ opacity: 0.8 }}>
              {account
                ? `帳戶：${account.displayName || ""} (${account.email || account.accountId}) · 預設僅讀取 metadata`
                : "請先登入 Google 帳號"}
            </span>
          </div>
          <button
            type="button"
            className="btn mixer-button"
            disabled={loading || isRestoring}
            onClick={onRefresh}
          >
            {loading ? "讀取中…" : "↻ 重新整理"}
          </button>
        </div>

        {restoreProgress && (
          <div className="grid mixer-modal-section" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="small" style={{ color: "#bae6fd", fontWeight: 600 }}>
                {restoreProgress.message}
              </span>
              {isRestoring && (
                <button
                  type="button"
                  className="btn mixer-abort-button"
                  style={{ minHeight: 34, padding: "4px 10px", fontSize: 12 }}
                  onClick={onCancelRestore}
                >
                  取消恢復
                </button>
              )}
            </div>
            <div
              role="progressbar"
              className={`mixer-progress-track${
                restoreProgress.totalBytes && restoreProgress.loadedBytes !== undefined
                  ? ""
                  : " is-indeterminate"
              }`}
            >
              <div
                className="mixer-progress-fill"
                style={
                  restoreProgress.totalBytes && restoreProgress.loadedBytes !== undefined
                    ? {
                        width: `${Math.min(100, Math.round((restoreProgress.loadedBytes / restoreProgress.totalBytes) * 100))}%`,
                      }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {errorMessage && (
          <div role="alert" className="card-error-banner">
            <span>{errorMessage}</span>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="row mixer-modal-section" style={{ gap: 10, justifyContent: "center", padding: 24 }}>
            <span className="mixer-spinner" aria-hidden="true" />
            <span className="small">正在讀取 .loopHarmonizer 雲端成果清單…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="mixer-modal-section" style={{ textAlign: "center", padding: 24 }}>
            <p className="small" style={{ margin: 0 }}>
              目前此 Google 帳號的 .loopHarmonizer 資料夾尚未有已完成的雲端分軌成果。
            </p>
            <p className="small" style={{ opacity: 0.7, marginTop: 6, marginBottom: 0 }}>
              在本機完成分離後，於歌曲卡片點擊「儲存成果到 Google Drive」即可同步至此處。
            </p>
          </div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            {entries.map((entry) => {
              const m = entry.manifest;
              const includeOriginal =
                includeOriginalById[entry.manifestFileId] ?? entry.sourceLikelyAvailableOnDrive;
              const isThisRestoring = restoringManifestId === entry.manifestFileId;

              return (
                <div key={entry.manifestFileId} className="grid mixer-modal-section" style={{ gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div className="grid" style={{ gap: 2 }}>
                      <strong style={{ fontSize: 14 }}>{m.songName}</strong>
                      <span className="small" style={{ opacity: 0.75 }}>
                        {m.separation.mode === "two_stem" ? "2 Stem" : "4 Stem"}
                        {" · "}
                        {m.separation.format}
                        {" · "}
                        模型 {m.separation.modelVersion}
                        {" · "}
                        約 {formatMiB(entry.totalStemBytes)}
                      </span>
                      <span className="small" style={{ opacity: 0.65, fontSize: 11 }}>
                        完成時間：{new Date(m.updatedAt).toLocaleString("zh-TW")}
                        {" · "}
                        {entry.sourceLikelyAvailableOnDrive ? "原曲來源：Google Drive（可選恢復）" : "原曲來源：本機檔案"}
                      </span>
                    </div>

                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      {entry.localAlreadyAvailable && (
                        <span className="song-storage-pill is-saved">本機已有分軌</span>
                      )}
                    </div>
                  </div>

                  {entry.sourceLikelyAvailableOnDrive && (
                    <label className="row" style={{ gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={includeOriginal}
                        disabled={isRestoring}
                        onChange={(e) =>
                          setIncludeOriginalById((prev) => ({
                            ...prev,
                            [entry.manifestFileId]: e.target.checked,
                          }))
                        }
                      />
                      <span>同時嘗試從 Drive 恢復原始音檔（將驗證 SHA-256 一致性）</span>
                    </label>
                  )}

                  <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                    <button
                      type="button"
                      className="btn mixer-button is-danger"
                      style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
                      disabled={isRestoring}
                      onClick={() => onDeleteEntry(entry)}
                    >
                      刪除雲端成果
                    </button>
                    <button
                      type="button"
                      className="btn mixer-button primary"
                      style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
                      disabled={isRestoring}
                      onClick={() =>
                        void onRestoreEntry(entry, {
                          includeOriginalAudio: entry.sourceLikelyAvailableOnDrive && includeOriginal,
                        })
                      }
                    >
                      {isThisRestoring
                        ? "恢復中…"
                        : entry.localAlreadyAvailable
                          ? "套用設定並恢復（重用本機分軌）"
                          : "下載並恢復至混音器"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {invalidEntries.length > 0 && (
          <details className="mixer-modal-section">
            <summary className="small" style={{ cursor: "pointer", color: "#fde68a" }}>
              略過 {invalidEntries.length} 筆不完整或版本不相容的雲端項目
            </summary>
            <ul className="mixer-modal-list" style={{ marginTop: 6 }}>
              {invalidEntries.map((item) => (
                <li key={item.manifestFileId} className="small">
                  {item.fileName}：{item.reasons.join("；")}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="row mixer-modal-actions">
          <button
            type="button"
            className="btn mixer-button"
            disabled={isRestoring}
            onClick={onClose}
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
