"use client";

import { useEffect, useMemo, useState } from "react";
import type { BandSong } from "@/lib/band/bandTypes";
import type { GoogleAccount } from "@/lib/google/googleAuthTypes";
import type { WavExportFormat } from "@/lib/audio/chunkedWavExporter";
import {
  type DriveExportProgress,
  type DriveExportSelection,
  estimateSongDriveExportBytes,
} from "@/lib/google/driveExportManager";
import { requiredStemRolesForMode } from "@/lib/google/driveManifest";

type Props = {
  open: boolean;
  song: BandSong | null;
  account: GoogleAccount | null;
  totalSamples: number;
  activeProgress: DriveExportProgress | null;
  submitting: boolean;
  errorMessage: string | null;
  needsReauth: boolean;
  onStartExport: (selection: DriveExportSelection) => void | Promise<void>;
  onPauseExport?: () => void;
  onCancelExport: () => void;
  onReauthorizeAndResume?: () => void | Promise<void>;
  onClose: () => void;
};

function formatMiB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const ROLE_NAMES: Record<string, string> = {
  vocals: "人聲 (vocals.wav)",
  drums: "鼓組 (drums.wav)",
  bass: "貝斯 (bass.wav)",
  other: "其他 (other.wav)",
  instrumental: "伴奏 (instrumental.wav)",
};

export function DriveExportDialog({
  open,
  song,
  account,
  totalSamples,
  activeProgress,
  submitting,
  errorMessage,
  needsReauth,
  onStartExport,
  onPauseExport,
  onCancelExport,
  onReauthorizeAndResume,
  onClose,
}: Props) {
  const mode = song?.separationMode ?? "four_stem";
  const allRoles = useMemo(() => requiredStemRolesForMode(mode), [mode]);

  const [format, setFormat] = useState<WavExportFormat>("wav-float32");
  const [includeStems, setIncludeStems] = useState(true);
  const [selectedRoles, setSelectedRoles] = useState<
    Array<"vocals" | "drums" | "bass" | "other" | "instrumental">
  >([...allRoles]);
  const [includeSessionJson, setIncludeSessionJson] = useState(true);
  const [includeCustomMix, setIncludeCustomMix] = useState(false);

  useEffect(() => {
    setSelectedRoles([...requiredStemRolesForMode(song?.separationMode ?? "four_stem")]);
  }, [song?.id, song?.separationMode]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, submitting, onClose]);

  if (!open || !song) return null;

  const selection: DriveExportSelection = {
    format,
    includeStems,
    selectedStemRoles: selectedRoles,
    includeSessionJson,
    includeCustomMix,
    forceNewRevision: Boolean(song.driveExport && song.driveExport.ownerAccountId === account?.accountId),
  };

  const estimate = estimateSongDriveExportBytes({
    totalSamples: totalSamples > 0 ? totalSamples : Math.max(1, Math.round(song.durationSec * 44100)),
    mode,
    selection,
  });

  const nothingSelected =
    (!includeStems || selectedRoles.length === 0) &&
    !includeSessionJson &&
    !includeCustomMix;

  const toggleRole = (role: "vocals" | "drums" | "bass" | "other" | "instrumental") => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((item) => item !== role) : [...prev, role],
    );
  };

  const pct =
    activeProgress && activeProgress.totalBytes > 0
      ? Math.min(100, Math.round((activeProgress.uploadedBytes / activeProgress.totalBytes) * 100))
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-export-dialog-title"
      className="mixer-modal-backdrop"
      onClick={(event) => {
        if (!submitting && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="card mixer-modal-panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div className="grid" style={{ gap: 4 }}>
            <strong id="drive-export-dialog-title" style={{ fontSize: 16 }}>
              儲存成果至 Google Drive
            </strong>
            <span className="small" style={{ opacity: 0.8 }}>
              {song.name}（{mode === "two_stem" ? "2 Stem" : "4 Stem"}）
            </span>
          </div>
          <span className="badge" style={{ background: "rgba(56, 189, 248, 0.16)", color: "#bae6fd", borderColor: "rgba(56, 189, 248, 0.4)" }}>
            純前端直傳
          </span>
        </div>

        <div className="grid mixer-modal-section" style={{ gap: 6 }}>
          <div className="small">
            預計儲存 Google 帳戶：
            <strong>{account ? `${account.displayName || ""} (${account.email || account.accountId})` : "尚未登入（確認時會引導登入）"}</strong>
          </div>
          <div className="small" style={{ opacity: 0.85 }}>
            目標資料夾：<code>.loopHarmonizer / songs / &lt;song-hash&gt; / revisions / &lt;revision&gt;</code>
          </div>
          {song.driveExport && account && song.driveExport.ownerAccountId === account.accountId && (
            <div className="small" style={{ color: "#fde68a" }}>
              此歌曲曾輸出過版本（{song.driveExport.revisionId}）；本次將建立新 Revision，保留既有雲端成果不覆寫。
            </div>
          )}
        </div>

        <div className="grid mixer-modal-section" style={{ gap: 8 }}>
          <strong className="small">WAV 編碼格式</strong>
          <label className="row mixer-modal-option">
            <input
              type="radio"
              name="wav-export-format"
              checked={format === "wav-float32"}
              disabled={submitting}
              onChange={() => setFormat("wav-float32")}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>Float32 無損 WAV（建議跨裝置恢復）</span>
              <span className="small" style={{ opacity: 0.75 }}>保留原始 32-bit 浮點分離精度，單軌約 {formatMiB(estimateSongDriveExportBytes({ totalSamples: totalSamples || Math.round(song.durationSec * 44100), mode, selection: { ...selection, format: "wav-float32" } }).stemBytesEach)}。</span>
            </span>
          </label>
          <label className="row mixer-modal-option">
            <input
              type="radio"
              name="wav-export-format"
              checked={format === "wav-pcm16"}
              disabled={submitting}
              onChange={() => setFormat("wav-pcm16")}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>PCM16 標準 WAV（體積減半）</span>
              <span className="small" style={{ opacity: 0.75 }}>經 [-1, 1] 飽和限制與 16-bit 量化（非與 Float32 逐位元一致），單軌約 {formatMiB(estimateSongDriveExportBytes({ totalSamples: totalSamples || Math.round(song.durationSec * 44100), mode, selection: { ...selection, format: "wav-pcm16" } }).stemBytesEach)}。</span>
            </span>
          </label>
        </div>

        <div className="grid mixer-modal-section" style={{ gap: 8 }}>
          <strong className="small">選擇輸出檔案</strong>
          <label className="row mixer-modal-option">
            <input
              type="checkbox"
              checked={includeStems}
              disabled={submitting}
              onChange={(e) => setIncludeStems(e.target.checked)}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>原始分離分軌 WAV（未套用變速、Key 與 Mute/Solo）</span>
              <span className="small" style={{ opacity: 0.75 }}>包含全部必要分軌時才會發布 completed Manifest 供跨裝置恢復。</span>
            </span>
          </label>

          {includeStems && (
            <div className="row" style={{ gap: 8, paddingLeft: 24, flexWrap: "wrap" }}>
              {allRoles.map((role) => (
                <label key={role} className="row" style={{ gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role)}
                    disabled={submitting}
                    onChange={() => toggleRole(role)}
                  />
                  <span>{ROLE_NAMES[role] ?? role}</span>
                </label>
              ))}
            </div>
          )}

          <label className="row mixer-modal-option">
            <input
              type="checkbox"
              checked={includeSessionJson}
              disabled={submitting}
              onChange={(e) => setIncludeSessionJson(e.target.checked)}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>混音與播放設定 JSON（session.json）</span>
              <span className="small" style={{ opacity: 0.75 }}>保存 BPM、Key、倍率、音量、Mute/Solo 與 Loop（不含任何 Token 或本機金鑰）。</span>
            </span>
          </label>

          <label className="row mixer-modal-option">
            <input
              type="checkbox"
              checked={includeCustomMix}
              disabled={submitting}
              onChange={(e) => setIncludeCustomMix(e.target.checked)}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>混音成品（exports/custom-mix.wav）</span>
              <span className="small" style={{ opacity: 0.75 }}>依各軌音量、Mute/Solo 與主音量即時合成；不包含即時 SoundTouch 變速或升降 Key 效果。</span>
            </span>
          </label>

          <div className="small" style={{ color: "#bae6fd", fontWeight: 600 }}>
            預估上傳總容量：約 {formatMiB(estimate.totalEstimatedBytes)}（分段按需讀取 IndexedDB，不載入整首四軌進入記憶體）
          </div>
        </div>

        {activeProgress && (
          <div className="grid mixer-modal-section" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small" style={{ color: "#bae6fd", fontWeight: 600 }}>
                {activeProgress.message}
              </span>
              {pct !== null && (
                <span className="small" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {pct}% ({formatMiB(activeProgress.uploadedBytes)} / {formatMiB(activeProgress.totalBytes)})
                </span>
              )}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              className={`mixer-progress-track${pct === null ? " is-indeterminate" : ""}`}
            >
              <div
                className="mixer-progress-fill"
                style={pct !== null ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        )}

        {errorMessage && (
          <div role="alert" className="card-error-banner">
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="row mixer-modal-actions">
          {submitting ? (
            <>
              {onPauseExport && (
                <button type="button" className="btn mixer-button" onClick={onPauseExport}>
                  暫停上傳
                </button>
              )}
              <button type="button" className="btn mixer-abort-button" onClick={onCancelExport}>
                取消上傳
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn mixer-button" onClick={onClose}>
                關閉
              </button>
              {needsReauth && onReauthorizeAndResume ? (
                <button
                  type="button"
                  className="btn mixer-button primary"
                  onClick={() => void onReauthorizeAndResume()}
                >
                  重新授權並續傳
                </button>
              ) : (
                <button
                  type="button"
                  className="btn mixer-button primary"
                  disabled={nothingSelected}
                  onClick={() => void onStartExport(selection)}
                >
                  確認上傳至 Drive
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
