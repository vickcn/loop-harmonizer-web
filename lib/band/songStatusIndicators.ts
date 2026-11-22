import type { BandSong } from "@/lib/band/bandTypes";
import type { ProjectSongAvailabilityState, ProjectSongBackupStatus } from "@/lib/projects/projectTypes";

export type StatusIndicatorTone =
  | "is-focus"
  | "is-muted"
  | "is-saved"
  | "is-saving"
  | "is-warn"
  | "is-error"
  | "is-drive"
  | "is-drive-stem";

export type StatusIndicatorItem = {
  key: string;
  label: string;
  tone: StatusIndicatorTone;
  detail?: string;
};

export const CONDENSED_STATUS_THRESHOLD = 3;

export function shouldCondenseStatusIndicators(
  count: number,
  threshold: number = CONDENSED_STATUS_THRESHOLD,
): boolean {
  return count >= threshold;
}

const PERSISTENCE_BADGE: Record<NonNullable<BandSong["persistenceStatus"]>, { label: string; tone: StatusIndicatorTone }> = {
  saving: { label: "儲存中…", tone: "is-saving" },
  saved: { label: "已保存在此裝置", tone: "is-saved" },
  error: { label: "儲存失敗", tone: "is-error" },
  restoring: { label: "正在恢復歌曲…", tone: "is-saving" },
  missing_audio: { label: "需重新匯入音檔", tone: "is-warn" },
  conflict: { label: "分頁設定衝突", tone: "is-warn" },
  unsaved: { label: "僅此工作階段", tone: "is-warn" },
};

const PROJECT_AVAILABILITY_BADGE: Record<ProjectSongAvailabilityState, { label: string; tone: StatusIndicatorTone }> = {
  local_playable: { label: "本機可播放", tone: "is-saved" },
  cloud_not_downloaded: { label: "已備份但尚未下載", tone: "is-drive" },
  downloading: { label: "下載中", tone: "is-saving" },
  stems_loaded: { label: "已載入分軌", tone: "is-drive-stem" },
  needs_reauth: { label: "需要重新授權", tone: "is-warn" },
  original_missing: { label: "來源音訊遺失", tone: "is-error" },
  stems_missing: { label: "分軌成果缺失", tone: "is-error" },
};

const PROJECT_BACKUP_BADGE: Record<ProjectSongBackupStatus, { label: string; tone: StatusIndicatorTone }> = {
  local_only: { label: "僅本機可用", tone: "is-warn" },
  original_backed_up: { label: "原曲已備份", tone: "is-drive" },
  stems_backed_up: { label: "分軌已備份", tone: "is-drive-stem" },
  cross_device_ready: { label: "可跨裝置恢復", tone: "is-saved" },
  pending_sync: { label: "尚待同步", tone: "is-saving" },
};

export function buildSongStatusIndicators(
  song: BandSong,
  options?: { isActive?: boolean },
): StatusIndicatorItem[] {
  const items: StatusIndicatorItem[] = [];
  const availabilityInfo = song.availabilityState
    ? PROJECT_AVAILABILITY_BADGE[song.availabilityState]
    : null;
  const backupInfo = song.backupStatus
    ? PROJECT_BACKUP_BADGE[song.backupStatus]
    : null;
  const persistenceInfo = song.persistenceStatus
    ? PERSISTENCE_BADGE[song.persistenceStatus]
    : null;

  if (options?.isActive) {
    items.push({ key: "focus", label: "焦點中", tone: "is-focus" });
  }
  if (song.muted) {
    items.push({ key: "muted", label: "已靜音", tone: "is-muted" });
  }
  if (availabilityInfo) {
    const availabilityDetail =
      !persistenceInfo &&
      song.persistenceMessage &&
      song.persistenceMessage !== availabilityInfo.label
        ? song.persistenceMessage
        : undefined;
    items.push({
      key: "availability",
      label: availabilityInfo.label,
      tone: availabilityInfo.tone,
      ...(availabilityDetail ? { detail: availabilityDetail } : {}),
    });
  }
  if (backupInfo) {
    items.push({
      key: "backup",
      label: backupInfo.label,
      tone: backupInfo.tone,
    });
  }
  if (song.source?.provider === "google_drive") {
    items.push({
      key: "drive-source",
      label: "Google Drive",
      tone: "is-drive",
      detail: "來源自 Google 雲端硬碟",
    });
  }
  if (song.importedStemOrigin) {
    items.push({
      key: "imported-stems",
      label: "雲端分軌",
      tone: "is-drive-stem",
      detail: `已自 Google Drive 匯入分軌（${song.importedStemOrigin.pcmFormat}）`,
    });
  }
  if (song.driveExport) {
    items.push({
      key: "drive-export",
      label: "已存 Drive",
      tone: "is-saved",
      detail: "分軌成果已備份至 Google Drive",
    });
  }
  if (song.audioLoadState === "unloaded" && !song.sourceAudioMissing) {
    items.push({
      key: "deferred-decode",
      label: "待按需解碼",
      tone: "is-warn",
      detail: "按播放或載入時才解碼，節省記憶體",
    });
  }
  if (song.audioLoadState === "decoding") {
    items.push({
      key: "decoding",
      label: "音訊解碼中…",
      tone: "is-saving",
    });
  }
  if (persistenceInfo) {
    const persistenceDetail =
      song.persistenceMessage && song.persistenceMessage !== persistenceInfo.label
        ? song.persistenceMessage
        : undefined;
    items.push({
      key: "persistence",
      label: persistenceInfo.label,
      tone: persistenceInfo.tone,
      ...(persistenceDetail ? { detail: persistenceDetail } : {}),
    });
  }

  return items;
}
