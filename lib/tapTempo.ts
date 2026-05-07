export function calculateTapBpm(tapTimes: number[]): number | null {
  if (tapTimes.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
  const avg = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return 60000 / avg;
}

export function calculateTapConfidence(tapTimes: number[]): number {
  if (tapTimes.length < 3) return 0.45;
  const intervals: number[] = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
  const avg = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / intervals.length;
  const std = Math.sqrt(variance);
  const stability = 1 - Math.min(std / avg, 1);
  return Math.max(0.1, Math.min(0.99, stability));
}
