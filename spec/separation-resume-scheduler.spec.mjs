import assert from "node:assert/strict";
import test from "node:test";

import { SeparationJobManager } from "../lib/separation/separationJobManager.ts";

test("retry scheduler keeps one wakeup for the earliest persisted eligible task", () => {
  let now = 10_000;
  const scheduled = [];
  const timer = {
    setTimeout(callback, delayMs) {
      const token = { callback, delayMs, cleared: false };
      scheduled.push(token);
      return token;
    },
    clearTimeout(token) {
      token.cleared = true;
    },
  };
  const manager = new SeparationJobManager({
    enableBroadcastSync: false,
    retryStorage: null,
    now: () => now,
    retryTimer: timer,
  });
  try {
    manager.updateJob("task-a", {
      taskId: "task-a", songId: "song-a", generation: 1, stage: "interrupted",
      progress: 0.5, message: "retry", completedChunks: 1, totalChunks: 2, committedBytes: 1,
    });
    manager.updateJob("task-b", {
      taskId: "task-b", songId: "song-b", generation: 1, stage: "finalizing",
      progress: 0.99, message: "save retry", completedChunks: 2, totalChunks: 2, committedBytes: 2,
    });
    manager.saveRetryEntry({ taskId: "task-a", attempts: 1, nextEligibleAt: now + 15_000, baselineCompletedChunks: 1 });
    manager.saveRetryEntry({ taskId: "task-b", attempts: 1, nextEligibleAt: now + 5_000, baselineCompletedChunks: 2 });
    const active = scheduled.filter((item) => !item.cleared);
    assert.equal(active.length, 1);
    assert.equal(active[0].delayMs, 5_000);
    now += 5_000;
    manager.clearRetryEntry("task-b");
    const rescheduled = scheduled.filter((item) => !item.cleared);
    assert.equal(rescheduled.length, 1);
    assert.equal(rescheduled[0].delayMs, 10_000);
  } finally {
    manager.dispose();
  }
});
