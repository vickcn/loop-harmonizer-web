export type TrackStatus = "stopped" | "playing" | "paused";
export type TrackSyncMode = "free" | "global-bpm" | "manual-rate";

export type BandTrack = {
  id: string;
  name: string;
  fileName: string;
  originalBpm: number;
  baseRate: number;
  volume: number;
  muted: boolean;
  selected: boolean;
  playheadSec: number;
  durationSec: number;
  status: TrackStatus;
  syncMode: TrackSyncMode;
  loop: boolean;
};

export type BandSession = {
  id: string;
  globalBpm: number;
  tracks: BandTrack[];
};
