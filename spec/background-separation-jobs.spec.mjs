import assert from "node:assert/strict";
import test from "node:test";

import { SeparationJobManager } from "../lib/separation/separationJobManager.ts";

test("background job enters preparing immediately and remains observable after a UI unsubscribe", async () => {
  const manager = new SeparationJobManager({
    coordinator: {
      startTask: ({ songId, onProgress }) => ({
        taskId: `task:${songId}`,
        songId,
        generation: 1,
        getStage: () => "preparing",
        isTerminal: () => false,
        pause: async () => undefined,
        cancel: async () => undefined,
        onProgress,
      }),
      pauseTask: async () => true,
      cancelTask: async () => true,
      getActiveController: () => null,
      hasRunningHeavyTask: () => false,
    },
    lockAdapter: null,
  });

  const observed = [];
  const unsubscribe = manager.subscribe(() => observed.push(manager.getSnapshot()));
  const controller = manager.startJob({ songId: "song-1", songName: "背景歌曲" });

  assert.equal(manager.getJob(controller.taskId)?.stage, "preparing");
  unsubscribe();
  manager.updateJob(controller.taskId, {
    stage: "processing",
    completedChunks: 2,
    totalChunks: 5,
  });

  assert.equal(manager.getJob(controller.taskId)?.completedChunks, 2);
  assert.equal(observed.length, 1);
});

test("visible recovery does not create a second worker while the task is already active", async () => {
  let starts = 0;
  const manager = new SeparationJobManager({
    coordinator: {
      startTask: ({ songId, onProgress }) => {
        starts += 1;
        return {
          taskId: `task:${songId}`,
          songId,
          generation: starts,
          getStage: () => "preparing",
          isTerminal: () => false,
          pause: async () => undefined,
          cancel: async () => undefined,
          onProgress,
        };
      },
      pauseTask: async () => true,
      cancelTask: async () => true,
      getActiveController: () => null,
      hasRunningHeavyTask: () => false,
    },
    lockAdapter: null,
  });

  const first = manager.startJob({ songId: "song-1" });
  const again = manager.startJob({ songId: "song-1" });

  assert.equal(again.taskId, first.taskId);
  assert.equal(starts, 1);
});

test("only an interrupted job with a registered runner is eligible for global auto resume", async () => {
  const manager = new SeparationJobManager({ lockAdapter: null });
  manager.updateJob("task:resume", {
    taskId: "task:resume",
    songId: "song-1",
    stage: "interrupted",
  });
  let calls = 0;
  manager.registerAutoResume("task:resume", async () => { calls += 1; });

  assert.equal(await manager.requestAutoResume("task:resume"), true);
  assert.equal(calls, 1);
  manager.updateJob("task:resume", { stage: "paused" });
  assert.equal(await manager.requestAutoResume("task:resume"), false);
  assert.equal(calls, 1);
});
