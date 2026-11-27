import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_TASK_RETRY_DELAYS_MS, computeCloudTaskRetryAt } from "../lib/cloudTasks/cloudTaskScheduler.ts";

test("cloud retry schedule runs 1s, 5s, 15s and 45s attempts, then stops", () => {
  assert.deepEqual(CLOUD_TASK_RETRY_DELAYS_MS, [1_000, 5_000, 15_000, 45_000]);
  const now = 10_000;
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(computeCloudTaskRetryAt({ retryCount: attempt, now, random: () => 0.5 }), now + CLOUD_TASK_RETRY_DELAYS_MS[attempt]);
  assert.equal(computeCloudTaskRetryAt({ retryCount: 4, now, random: () => 0.5 }), null);
});

test("Retry-After is respected and jitter remains bounded", () => {
  assert.equal(computeCloudTaskRetryAt({ retryCount: 0, now: 0, retryAfterMs: 20_000, random: () => 0 }), 17_000);
  assert.equal(computeCloudTaskRetryAt({ retryCount: 0, now: 0, retryAfterMs: 20_000, random: () => 1 }), 23_000);
});
