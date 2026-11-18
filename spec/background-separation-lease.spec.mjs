import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BACKGROUND_JOB_LEASE_TTL_MS,
  SeparationJobLeaseManager,
} from "../lib/separation/separationResumeController.ts";

test("background lease TTL is deliberately longer than a throttled foreground heartbeat", () => {
  assert.ok(DEFAULT_BACKGROUND_JOB_LEASE_TTL_MS >= 60_000);
});

test("held Web Lock prevents a second task runner from entering its critical section", async () => {
  let held = false;
  const manager = new SeparationJobLeaseManager({
    lockAdapter: {
      request: async (_name, options, callback) => {
        if (held && options.ifAvailable) return callback(null);
        held = true;
        try {
          return await callback({ name: "test" });
        } finally {
          held = false;
        }
      },
    },
  });

  let releaseFirst;
  const first = manager.withTaskLock("task-1", async () => {
    await new Promise((resolve) => { releaseFirst = resolve; });
    return "first";
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await manager.withTaskLock("task-1", async () => "second");

  assert.equal(second.acquired, false);
  releaseFirst();
  assert.equal((await first).value, "first");
});
