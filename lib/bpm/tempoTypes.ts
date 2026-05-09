export type LiveTransition = {
  fromBpm: number;
  toBpm: number;
  startTime: number;
  durationSeconds: number;
};

export type PlaybackParams = {
  currentBpm: number;
  playbackRate: number;
  beatIntervalMs: number;
};
