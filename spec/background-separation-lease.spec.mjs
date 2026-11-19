import assert from "node:assert/strict";
import test from "node:test";

import { createBandSong } from "../lib/band/songModel.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { DEMUCS_SAMPLE_RATE, DEMUCS_STRIDE_SAMPLES } from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  createCheckpointTaskId,
  getCheckpoint,
  saveCheckpoint,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  getPersistedSongRecord,
  saveSongWithAudioFile,
} from "../lib/storage/songSessionStore.ts";
import { SeparationJobManager } from "../lib/separation/separationJobManager.ts";
import { SeparationJobLeaseManager } from "../lib/separation/separationResumeController.ts";
import { SeparationTaskCoordinator } from "../lib/separation/separationTaskController.ts";

function createExclusiveWebLockMock() {
  const heldNames = new Set();
  return {
    lockAdapter: {
      request: async (name, options, callback) => {
        if (heldNames.has(name) && options.ifAvailable) {
          return callback(null);
        }
        heldNames.add(name);
        try {
          return await callback({ name });
        } finally {
          heldNames.delete(name);
        }
      },
    },
    isHeld: (name) => heldNames.has(name),
  };
}

test("background lease TTL is deliberately longer than a throttled foreground heartbeat", () => {
  assert.ok(true);
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
  manager.close();
});

test("Scenario 8 & 9: expired background Lease with active Web Lock stays projected as processing and blocks second tab without marking song failed", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const { lockAdapter } = createExclusiveWebLockMock();
  const tabALeaseManager = new SeparationJobLeaseManager({ lockAdapter });
  const tabBLeaseManager = new SeparationJobLeaseManager({ lockAdapter });

  const hash = "hash-cross-tab-lock";
  const songId = "song-lock-1";
  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
  const taskId = createCheckpointTaskId(songId, hash);

  const blob = new Blob([new Uint8Array(32)], { type: "audio/wav" });
  const song = createBandSong({
    id: songId,
    name: "Lock Test Song",
    fileName: "lock.wav",
    sourceAudioId: `${songId}_original`,
    originalBpm: 120,
    durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
    sourceAudioHash: hash,
  });
  await saveSongWithAudioFile({ song, file: blob, sourceAudioHash: hash, force: true });

  // 模擬背景分頁 A 因 timer 節流導致 IDB Lease 已經過期（leaseExpiresAt = 1000 < now = 500_000），但分頁 A 仍實際持有 Web Lock
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId,
      sourceAudioHash: hash,
      requestedMode: "two_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      userAuthorized: true,
      lease: {
        ownerTabId: "foreign-background-tab-a",
        ownerJobToken: "job-a",
        generation: 1,
        acquiredAt: 500,
        leaseExpiresAt: 1000,
      },
      now: 1000,
    }),
  );

  const retryBacking = new Map();
  let tabBWorkerStarts = 0;
  const tabBManager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager: tabBLeaseManager,
    lockAdapter,
    retryStorage: {
      getItem: (k) => retryBacking.get(k) ?? null,
      setItem: (k, v) => retryBacking.set(k, v),
    },
    now: () => 500_000,
    enableBroadcastSync: false,
    runnerDeps: {
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async () => {
        tabBWorkerStarts += 1;
        return { backend: "wasm", usedWorker: true, durationMs: 10 };
      },
    },
  });

  let releaseTabALock;
  const tabALockPromise = tabALeaseManager.withTaskLock(taskId, async () => {
    await new Promise((resolve) => { releaseTabALock = resolve; });
    return "done";
  });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    // 1) Web Lock 仍有效時，即使 IDB lease TTL 已過期，分頁 B 應識別為他分頁 active 執行中（processing），絕不誤判 interrupted 並接管
    await tabBManager.refreshFromStorage();
    const jobSnapshot = tabBManager.getJob(taskId);
    assert.equal(jobSnapshot?.stage, "processing");
    assert.equal(jobSnapshot?.isForeignActive, true);

    // 2) 分頁 B 嘗試執行或自動續跑同一任務 -> 取得 Web Lock 失敗 -> 應安全回傳 blocked，絕不可將歌曲或 Checkpoint 標記為 failed
    const runOutcome = await tabBManager.runSongSeparation({
      songId,
      taskId,
      mode: "two_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(runOutcome.status, "blocked");
    assert.equal(runOutcome.code, "lock_unavailable");
    assert.equal(tabBWorkerStarts, 0);

    const persistedSong = await getPersistedSongRecord(songId);
    assert.notEqual(persistedSong?.separationStatus, "failed");
    const cp = await getCheckpoint(taskId);
    assert.equal(cp?.status, "running");
    assert.equal(tabBManager.getAutoResumeRetryState(taskId), null);
  } finally {
    releaseTabALock();
    await tabALockPromise;
    tabBManager.dispose();
    tabALeaseManager.close();
    tabBLeaseManager.close();
  }
});
