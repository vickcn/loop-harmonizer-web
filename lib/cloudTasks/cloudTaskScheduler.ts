export const CLOUD_TASK_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 45_000] as const;
export const MAX_CLOUD_TASK_RETRIES = CLOUD_TASK_RETRY_DELAYS_MS.length;

export function computeCloudTaskRetryAt(params: {
  retryCount: number;
  now: number;
  retryAfterMs?: number;
  random?: () => number;
}): number | null {
  if (params.retryCount >= MAX_CLOUD_TASK_RETRIES) return null;
  const base = Math.max(params.retryAfterMs ?? 0, CLOUD_TASK_RETRY_DELAYS_MS[params.retryCount]);
  const jitter = Math.floor(base * 0.15 * ((params.random ?? Math.random)() * 2 - 1));
  return params.now + Math.max(250, base + jitter);
}
