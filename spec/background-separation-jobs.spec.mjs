import assert from "node:assert/strict";
import test from "node:test";

import { createBandSong } from "../lib/band/songModel.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../lib/storage/cacheKeys.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  createCheckpointTaskId,
  deleteCheckpointAndChunks,
  getCheckpoint,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  getPersistedSongRecord,
  patchPersistedSongSeparationFields,
  saveSongWithAudioFile,
} from "../lib/storage/songSessionStore.ts";
import {
  AUTO_RESUME_BACKOFF_MS,
  MAX_AUTO_RESUME_ATTEMPTS,
  SeparationJobManager,
  canTransitionJobStage,
  mapCheckpointStatusToJobStage,
  mapJobStageToSongSeparationStatus,
} from "../lib/separation/separationJobManager.ts";
import {
  clearTransientSongAudioRegistry,
  reconstructJobDescriptor,
} from "../lib/separation/separationJobRunner.ts";
import {
  SeparationJobLeaseManager,
  getOrCreateTabId,
} from "../lib/separation/separationResumeController.ts";
import { SeparationTaskCoordinator } from "../lib/separation/separationTaskController.ts";

function makeFakeChunkPayload(frameCount) {
  const mk = () => {
    const arr = new Float32Array(frameCount);
    if (frameCount > 0) arr[0] = 0.05;
    return arr;
  };
  return packChunkStemsToBuffer(
    {
      vocals: { left: mk(), right: mk() },
      drums: { left: mk(), right: mk() },
      bass: { left: mk(), right: mk() },
      other: { left: mk(), right: mk() },
    },
    frameCount,
  );
}

function makeFakeNetworkEval(overrides = {}) {
  return {
    allowed: true,
    blockedOrigin: null,
    requiresExternalDownloadConfirmation: false,
    pendingExternalBytes: 0,
    pendingVercelStaticBytes: 0,
    vercelStaticBudgetBytes: 10 * 1024 * 1024,
    externalCdnBudgetBytes: 512 * 1024 * 1024,
    message: "OK",
    assets: [],
    ...overrides,
  };
}

function makeFakeCapabilities(overrides = {}) {
  return {
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    storageUsageBytes: 1024,
    storageQuotaBytes: 1024 * 1024 * 1024,
    storageRemainingBytes: 900 * 1024 * 1024,
    storagePersisted: true,
    jsHeapUsedBytes: 20 * 1024 * 1024,
    jsHeapLimitBytes: 1024 * 1024 * 1024,
    jsHeapEstimatedAvailableBytes: 900 * 1024 * 1024,
    supportsWebGpu: false,
    supportsWorker: true,
    crossOriginIsolated: true,
    formFactorHint: "desktop",
    collectedAt: Date.now(),
    ...overrides,
  };
}

function makeMemoryRetryStorage(backing = new Map()) {
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      backing.set(key, value);
    },
  };
}

async function seedSongWithAudio({ songId, hash = "hash-song-1", totalSamples = DEMUCS_STRIDE_SAMPLES * 2 }) {
  const blob = new Blob([new Uint8Array(64)], { type: "audio/wav" });
  const song = createBandSong({
    id: songId,
    name: `歌曲-${songId}`,
    fileName: `${songId}.wav`,
    sourceAudioId: `${songId}_original`,
    originalBpm: 120,
    durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
    sourceAudioHash: hash,
    fileSizeBytes: 64,
    mimeType: "audio/wav",
    fileLastModified: 1000,
  });
  const saved = await saveSongWithAudioFile({ song, file: blob, sourceAudioHash: hash, force: true });
  assert.equal(saved.ok, true);
  return { song, blob, hash, totalSamples };
}

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
    enableBroadcastSync: false,
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
  assert.equal(manager.getListenerCount(), 0);
  manager.dispose();
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
    enableBroadcastSync: false,
  });

  const first = manager.startJob({ songId: "song-1" });
  const again = manager.startJob({ songId: "song-1" });

  assert.equal(again.taskId, first.taskId);
  assert.equal(starts, 1);
  manager.dispose();
});

test("only an interrupted job with a registered runner is eligible for global auto resume", async () => {
  const manager = new SeparationJobManager({
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
  });
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
  manager.dispose();
});

test("Scenario 1 & 2 & 5: independent Runner completes separation without BandMixer, distinguishes last-chunk vs final submit, and maps completed stage accurately", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  assert.equal(mapJobStageToSongSeparationStatus("completed"), "completed");
  assert.equal(mapJobStageToSongSeparationStatus("idle"), "not_started");
  assert.equal(mapJobStageToSongSeparationStatus("pausing"), "processing");
  assert.equal(mapJobStageToSongSeparationStatus("paused"), "paused");
  assert.equal(mapJobStageToSongSeparationStatus("cancelling"), "cancelling");
  assert.equal(mapJobStageToSongSeparationStatus("cancelled"), "cancelled");
  assert.equal(mapJobStageToSongSeparationStatus("failed"), "failed");
  assert.equal(mapJobStageToSongSeparationStatus("interrupted"), "interrupted");

  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  const observedStagesOnChunk = [];

  const manager = new SeparationJobManager({
    coordinator,
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => "hash-s1",
      separateAudioFn: async (_file, opts) => {
        const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
        const cp = buildInitialCheckpoint({
          taskId: opts.checkpointTaskId,
          songId: opts.songId,
          sourceAudioHash: opts.sourceAudioHash,
          requestedMode: opts.mode,
          totalSamples,
          sampleRate: DEMUCS_SAMPLE_RATE,
          status: "queued",
          userAuthorized: true,
        });
        await saveCheckpoint(cp);
        const leaseRes = await leaseManager.acquireLease(cp.taskId, getOrCreateTabId());
        assert.equal(leaseRes.acquired, true);

        for (let idx = 0; idx < 2; idx++) {
          const startSample = idx * DEMUCS_STRIDE_SAMPLES;
          const endSample = (idx + 1) * DEMUCS_STRIDE_SAMPLES;
          const committed = await commitChunkAndCheckpointAtomically({
            taskId: cp.taskId,
            chunkIndex: idx,
            startSample,
            endSample,
            payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
            overlapCarryBuffer: null,
            expectedLease: leaseRes.lease,
          });
          opts.onChunkCommitted?.({
            checkpoint: committed.checkpoint,
            chunkIndex: idx,
            totalChunks: 2,
          });
          // 最後一個 chunk 剛提交完，尚未完成歌曲記錄與收尾前，Job stage 不可提前變 completed
          observedStagesOnChunk.push(manager.getJob(cp.taskId)?.stage);
        }

        await leaseManager.releaseLease(cp.taskId, leaseRes.lease, "completed");
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 120,
          chunkedTask: {
            taskId: cp.taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks: 2,
            committedBytes: DEMUCS_STRIDE_SAMPLES * 2 * 4 * 2 * 2,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    const { hash } = await seedSongWithAudio({ songId: "song-headless", hash: "hash-s1" });
    const taskId = createCheckpointTaskId("song-headless", hash);

    const outcome = await manager.runSongSeparation({
      songId: "song-headless",
      mode: "two_stem",
      guardAlreadyConfirmed: true,
    });

    assert.equal(outcome.status, "completed");
    assert.deepEqual(observedStagesOnChunk, ["processing", "processing"]);
    assert.equal(manager.getJob(taskId)?.stage, "completed");
    assert.equal(manager.getJob(taskId)?.progress, 1);

    const persisted = await getPersistedSongRecord("song-headless");
    assert.equal(persisted?.separationStatus, "completed");
    assert.equal(persisted?.separationCompletedChunks, 2);
    assert.equal(persisted?.separationTotalChunks, 2);
    assert.ok(persisted?.cacheKey);
    assert.equal(manager.getActiveControllerCount(), 0);
    assert.equal(manager.getAutoResumeHandlerCount(), 0);
  } finally {
    manager.dispose();
    leaseManager.close();
  }
});

test("Scenario 3: after simulated reload without BandMixer mounted, triggerLifecycleRecovery reconstructs descriptor and completes interrupted task", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { hash, totalSamples } = await seedSongWithAudio({ songId: "song-studio-reload", hash: "hash-reload" });
  const taskId = createCheckpointTaskId("song-studio-reload", hash);
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-studio-reload",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      userAuthorized: true,
      now: 1000,
    }),
  );
  await commitChunkAndCheckpointAtomically({
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    now: 1100,
  });

  const reconstructed = await reconstructJobDescriptor({ taskId });
  assert.ok(reconstructed?.audioBlob);
  assert.equal(reconstructed?.descriptor.songId, "song-studio-reload");
  assert.equal(reconstructed?.descriptor.userAuthorized, true);

  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  let resumedFromChunk = -1;

  const freshManagerAfterReload = new SeparationJobManager({
    coordinator,
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        const leaseRes = await leaseManager.acquireLease(taskId, getOrCreateTabId());
        assert.equal(leaseRes.acquired, true);
        resumedFromChunk = leaseRes.checkpoint.nextChunkIndex;
        const committed = await commitChunkAndCheckpointAtomically({
          taskId,
          chunkIndex: 1,
          startSample: DEMUCS_STRIDE_SAMPLES,
          endSample: totalSamples,
          payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
          overlapCarryBuffer: null,
          expectedLease: leaseRes.lease,
        });
        opts.onChunkCommitted?.({
          checkpoint: committed.checkpoint,
          chunkIndex: 1,
          totalChunks: 2,
        });
        await leaseManager.releaseLease(taskId, leaseRes.lease, "completed");
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 90,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks: 2,
            committedBytes: committed.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    await freshManagerAfterReload.triggerLifecycleRecovery("mount");
    assert.equal(resumedFromChunk, 1);
    assert.equal(freshManagerAfterReload.getJob(taskId)?.stage, "completed");
    const persisted = await getPersistedSongRecord("song-studio-reload");
    assert.equal(persisted?.separationStatus, "completed");
  } finally {
    freshManagerAfterReload.dispose();
    leaseManager.close();
  }
});

test("Scenario 4: completing background separation does NOT overwrite recent BPM, Key, volume, or loop edits", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { hash, totalSamples } = await seedSongWithAudio({ songId: "song-concurrent-edits", hash: "hash-edits" });
  const taskId = createCheckpointTaskId("song-concurrent-edits", hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();

  const manager = new SeparationJobManager({
    coordinator,
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        const cp = buildInitialCheckpoint({
          taskId,
          songId: "song-concurrent-edits",
          sourceAudioHash: hash,
          requestedMode: opts.mode,
          totalSamples,
          sampleRate: DEMUCS_SAMPLE_RATE,
          status: "queued",
          userAuthorized: true,
        });
        await saveCheckpoint(cp);
        const leaseRes = await leaseManager.acquireLease(taskId, getOrCreateTabId());

        // 模擬使用者在背景分軌進行期間於 UI 調整 BPM=148、Key=+3、主音量=0.35、Loop=true
        const { withIdbTransaction, idbRequestPromise } = await import("../lib/storage/indexedDb.ts");
        await withIdbTransaction(["songs"], "readwrite", async (tx) => {
          const store = tx.objectStore("songs");
          const rec = await idbRequestPromise(store.get("song-concurrent-edits"));
          await idbRequestPromise(
            store.put({
              ...rec,
              targetBpm: 148,
              keyShiftSemitones: 3,
              masterVolume: 0.35,
              loop: true,
              playheadSec: 12.5,
              revision: rec.revision + 1,
            }),
          );
        });

        for (let idx = 0; idx < 2; idx++) {
          await commitChunkAndCheckpointAtomically({
            taskId,
            chunkIndex: idx,
            startSample: idx * DEMUCS_STRIDE_SAMPLES,
            endSample: (idx + 1) * DEMUCS_STRIDE_SAMPLES,
            payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
            overlapCarryBuffer: null,
            expectedLease: leaseRes.lease,
          });
        }
        await leaseManager.releaseLease(taskId, leaseRes.lease, "completed");
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 80,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks: 2,
            committedBytes: DEMUCS_STRIDE_SAMPLES * 2 * 4 * 4,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    const outcome = await manager.runSongSeparation({
      songId: "song-concurrent-edits",
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(outcome.status, "completed");
    const persisted = await getPersistedSongRecord("song-concurrent-edits");
    assert.equal(persisted?.separationStatus, "completed");
    assert.equal(persisted?.targetBpm, 148);
    assert.equal(persisted?.keyShiftSemitones, 3);
    assert.equal(persisted?.masterVolume, 0.35);
    assert.equal(persisted?.loop, true);
    assert.equal(persisted?.playheadSec, 12.5);
  } finally {
    manager.dispose();
    leaseManager.close();
  }
});

test("Scenario 6 & 7: job manager blocks stale generations, chunk regressions, and completed/cancelled downgrades while permitting authoritative repair", () => {
  const manager = new SeparationJobManager({
    lockAdapter: null,
    enableBroadcastSync: false,
  });

  assert.equal(canTransitionJobStage("completed", "processing"), false);
  assert.equal(canTransitionJobStage("completed", "interrupted"), false);
  assert.equal(canTransitionJobStage("completed", "failed"), false);
  assert.equal(canTransitionJobStage("cancelled", "processing", { incomingGeneration: 1, currentGeneration: 1 }), false);

  manager.updateJob("task-guard", {
    taskId: "task-guard",
    songId: "song-g",
    generation: 2,
    stage: "processing",
    progress: 0.6,
    completedChunks: 3,
    totalChunks: 5,
    message: "進行中",
  });

  // 過期 generation=1 不得倒退或覆寫狀態
  manager.updateJob("task-guard", {
    generation: 1,
    stage: "failed",
    completedChunks: 1,
    message: "舊 worker 錯誤",
  });
  assert.equal(manager.getJob("task-guard")?.generation, 2);
  assert.equal(manager.getJob("task-guard")?.stage, "processing");
  assert.equal(manager.getJob("task-guard")?.completedChunks, 3);

  // 同 generation 較舊 chunk 進度不得倒退
  manager.updateJob("task-guard", {
    generation: 2,
    stage: "processing",
    completedChunks: 1,
    totalChunks: 5,
    progress: 0.2,
  });
  assert.equal(manager.getJob("task-guard")?.completedChunks, 3);

  // 完成後禁止降級為 interrupted / failed / processing
  manager.updateJob("task-guard", {
    generation: 2,
    stage: "completed",
    progress: 1,
    completedChunks: 5,
    totalChunks: 5,
  });
  manager.updateJob("task-guard", { generation: 2, stage: "interrupted", completedChunks: 0 });
  manager.updateJob("task-guard", { generation: 3, stage: "failed", message: "stale fail" });
  assert.equal(manager.getJob("task-guard")?.stage, "completed");

  // 專用權威修復入口可依據驗證結果調整狀態並寫入診斷紀錄
  const damagedCp = buildInitialCheckpoint({
    taskId: "task-guard",
    songId: "song-g",
    sourceAudioHash: "hash-g",
    requestedMode: "four_stem",
    totalSamples: DEMUCS_STRIDE_SAMPLES * 5,
    status: "interrupted",
  });
  manager.repairJobFromAuthoritativeCheckpoint("task-guard", damagedCp, 2, "偵測到第 3 段毀損，從第 3 段修復接續");
  assert.equal(manager.getJob("task-guard")?.stage, "interrupted");
  assert.equal(manager.getJob("task-guard")?.completedChunks, 2);

  // cancelled 同 generation 不可轉回 processing
  manager.updateJob("task-cancel", {
    taskId: "task-cancel",
    songId: "song-c",
    generation: 4,
    stage: "cancelled",
  });
  manager.updateJob("task-cancel", {
    generation: 4,
    stage: "processing",
  });
  assert.equal(manager.getJob("task-cancel")?.stage, "cancelled");
  manager.dispose();
});

test("Scenario 10 & 11: cross-tab refreshFromStorage keeps completed chunks in finalizing until the song result is committed", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const taskId = createCheckpointTaskId("song-sync", "hash-sync");
  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-sync",
      sourceAudioHash: "hash-sync",
      requestedMode: "two_stem",
      totalSamples,
      status: "running",
      lease: {
        ownerTabId: "tab-remote-a",
        ownerJobToken: "tok-a",
        generation: 1,
        acquiredAt: Date.now(),
        leaseExpiresAt: Date.now() + 60_000,
      },
    }),
  );

  const tabBManager = new SeparationJobManager({
    lockAdapter: null,
    enableBroadcastSync: false,
  });

  try {
    await tabBManager.refreshFromStorage();
    assert.equal(tabBManager.getJob(taskId)?.stage, "processing");
    assert.equal(tabBManager.getJob(taskId)?.isForeignActive, true);

    // 另一分頁不得誤回報成功取消他頁執行中的任務
    assert.equal(await tabBManager.cancelJob(taskId), false);

    // 模擬 Tab A 完成任務並提交所有 Chunk
    for (let i = 0; i < 2; i++) {
      await commitChunkAndCheckpointAtomically({
        taskId,
        chunkIndex: i,
        startSample: i * DEMUCS_STRIDE_SAMPLES,
        endSample: (i + 1) * DEMUCS_STRIDE_SAMPLES,
        payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
        overlapCarryBuffer: null,
      });
    }
    await tabBManager.refreshFromStorage();
    assert.equal(tabBManager.getJob(taskId)?.stage, "finalizing");

    // 測試另一任務在其他分頁取消後，Tab B 同步停止顯示執行動畫
    const cancelTaskId = createCheckpointTaskId("song-sync-2", "hash-sync-2");
    await saveCheckpoint(
      buildInitialCheckpoint({
        taskId: cancelTaskId,
        songId: "song-sync-2",
        sourceAudioHash: "hash-sync-2",
        requestedMode: "four_stem",
        totalSamples,
        status: "running",
        lease: {
          ownerTabId: "tab-remote-a",
          ownerJobToken: "tok-a2",
          generation: 1,
          acquiredAt: Date.now(),
          leaseExpiresAt: Date.now() + 60_000,
        },
      }),
    );
    await tabBManager.refreshFromStorage();
    assert.equal(tabBManager.getJob(cancelTaskId)?.stage, "processing");

    await updateCheckpointStatus(cancelTaskId, { status: "cancelled", clearLeaseIfTerminal: true });
    await tabBManager.refreshFromStorage();
    assert.equal(tabBManager.getJob(cancelTaskId)?.stage, "cancelled");

    // 若 Checkpoint 已從資料庫刪除，refreshFromStorage 應移除過期投影
    await deleteCheckpointAndChunks(cancelTaskId);
    await tabBManager.refreshFromStorage();
    assert.equal(tabBManager.getJob(cancelTaskId), null);
  } finally {
    tabBManager.dispose();
  }
});

test("Scenario 12, 13, 14 & 15: lifecycle deduplication, manual pause/cancel protection, retry limit/backoff across reloads, and clean teardown", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { hash, totalSamples } = await seedSongWithAudio({ songId: "song-retry", hash: "hash-retry" });
  const taskId = createCheckpointTaskId("song-retry", hash);

  // 1) 手動暫停與取消後絕不觸發自動續跑
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-retry",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      status: "paused",
      userAuthorized: true,
    }),
  );
  let startCount = 0;
  const retryBacking = new Map();
  let fakeNow = 1_000_000;

  const makeManager = (shouldFailWith) =>
    new SeparationJobManager({
      coordinator: new SeparationTaskCoordinator(),
      leaseManager: new SeparationJobLeaseManager({ lockAdapter: null }),
      lockAdapter: null,
      retryStorage: makeMemoryRetryStorage(retryBacking),
      now: () => fakeNow,
      enableBroadcastSync: false,
      runnerDeps: {
        collectCapabilitiesFn: async () => makeFakeCapabilities(),
        preflightNetworkFn: async () => makeFakeNetworkEval(),
        hashSourceAudioFn: async () => hash,
        separateAudioFn: async () => {
          startCount += 1;
          if (shouldFailWith) throw new Error(shouldFailWith);
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { backend: "wasm", usedWorker: true, durationMs: 10 };
        },
      },
    });

  const mPaused = makeManager("不應被執行");
  await mPaused.triggerLifecycleRecovery("mount");
  assert.equal(startCount, 0);
  mPaused.dispose();

  // 2) 轉為 interrupted 後，並發觸發多個生命週期事件僅啟動一次，並依退避與 3 次上限停止
  await updateCheckpointStatus(taskId, { status: "interrupted", userAuthorized: true });
  const m1 = makeManager("GPU 暫時無回應");
  await Promise.all([
    m1.triggerLifecycleRecovery("visibilitychange"),
    m1.triggerLifecycleRecovery("pageshow"),
    m1.triggerLifecycleRecovery("resume"),
    m1.triggerLifecycleRecovery("online"),
  ]);
  assert.equal(startCount, 1);
  assert.equal(m1.getAutoResumeRetryState(taskId)?.attempts, 1);

  // 退避期內不得立即重試
  fakeNow += 1_000;
  assert.equal(await m1.requestAutoResume(taskId), false);
  assert.equal(startCount, 1);

  // 模擬頁面重新整理（新建 manager 共用 persistent retryStorage）且已過第 1 次退避 (5s)
  m1.dispose();
  fakeNow += AUTO_RESUME_BACKOFF_MS[0] + 100;
  const m2 = makeManager("GPU 暫時無回應");
  await m2.refreshFromStorage();
  await m2.requestAutoResume(taskId);
  assert.equal(startCount, 2);
  assert.equal(m2.getAutoResumeRetryState(taskId)?.attempts, 2);

  // 第 3 次嘗試失敗後達 MAX_AUTO_RESUME_ATTEMPTS=3 上限，之後停止自動續跑並要求手動操作
  fakeNow += AUTO_RESUME_BACKOFF_MS[1] + 100;
  await m2.requestAutoResume(taskId);
  assert.equal(startCount, 3);
  assert.equal(m2.getAutoResumeRetryState(taskId)?.attempts, MAX_AUTO_RESUME_ATTEMPTS);
  assert.equal(m2.getJob(taskId)?.autoResumeExhausted, true);
  assert.equal(m2.getJob(taskId)?.requiresManualAction, true);

  fakeNow += AUTO_RESUME_BACKOFF_MS[2] + 100;
  await m2.requestAutoResume(taskId);
  assert.equal(startCount, 3);

  // 若有實質 Chunk 進展（例如透過外部恢復推進了 1 段），失敗計數會重置為 0
  m2.updateJob(taskId, { completedChunks: 1, stage: "interrupted" });
  assert.equal(m2.getAutoResumeRetryState(taskId)?.attempts, 0);
  assert.equal(m2.getActiveControllerCount(), 0);
  m2.dispose();
});
