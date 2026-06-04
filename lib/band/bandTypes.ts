export type TrackStatus = "stopped" | "playing" | "paused";
export type TrackSyncMode = "free" | "global-bpm" | "manual-rate";

/**
 * fast-rate   — AudioBufferSourceNode.playbackRate (M1, 已生效)
 * pitch-preserve — 保音高變速，M2B/M2C 再實作
 */
export type TrackPlaybackMode = "fast-rate" | "pitch-preserve";

export type BandTrack = {
  id: string;
  name: string;
  fileName: string;
  originalBpm: number;
  /** 粗調中心速率（引擎實際速率 = coarseRate + fineOffset） */
  coarseRate: number;
  /** 引擎實際播放速率 = coarseRate + fineOffset */
  baseRate: number;
  /** 使用者儲存的倍率快捷選項 */
  savedRates: number[];
  volume: number;
  muted: boolean;
  selected: boolean;
  playheadSec: number;
  durationSec: number;
  status: TrackStatus;
  syncMode: TrackSyncMode;
  loop: boolean;
  playbackMode: TrackPlaybackMode;
};

export type BandSession = {
  id: string;
  globalBpm: number;
  tracks: BandTrack[];
};
