import { PlaybackParams } from "./tempoTypes";

export function getPlaybackRate(currentBpm: number, baseBpm: number): number {
  return baseBpm > 0 ? currentBpm / baseBpm : 1;
}

export function getBeatIntervalMs(bpm: number): number {
  return 60000 / Math.max(1, bpm);
}

export function interpolateBpm(from: number, to: number, progress: number): number {
  return from + (to - from) * Math.max(0, Math.min(1, progress));
}

export function resolvePlaybackParams(currentBpm: number, baseBpm: number): PlaybackParams {
  return {
    currentBpm,
    playbackRate: getPlaybackRate(currentBpm, baseBpm),
    beatIntervalMs: getBeatIntervalMs(currentBpm),
  };
}
