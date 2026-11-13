export function calculateGlobalPlaybackRate(globalBpm: number, originalBpm: number): number {
  const safeOriginalBpm = Math.max(20, Math.min(300, originalBpm || 120));
  return Math.max(0.25, Math.min(4, globalBpm / safeOriginalBpm));
}

export function normalizeKeyShift(semitones: number): number {
  return Math.max(-12, Math.min(12, Math.round(semitones) || 0));
}
