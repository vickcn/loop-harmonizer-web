import assert from "node:assert/strict";
import test from "node:test";

import { createBandSong } from "../lib/band/songModel.ts";
import {
  configureInMemoryIdbForTests,
  idbRequestPromise,
  resetInMemoryIdbForTests,
  setInMemoryIdbHooksForTests,
  withIdbTransaction,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  createCheckpointTaskId,
  getCheckpoint,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  getPersistedSongRecord,
  saveSongWithAudioFile,
} from "../lib/storage/songSessionStore.ts";
import {
  AUTO_RESUME_BACKOFF_MS,
  BLOCKED_RECHECK_DELAY_MS,
  MAX_AUTO_RESUME_ATTEMPTS,
  MIN_RETRY_WAKEUP_DELAY_MS,
  SeparationJobManager,
} from "../lib/separation/separationJobManager.ts";
import { clearTransientSongAudioRegistry } from "../lib/separation/separationJobRunner.ts";
import {
  SeparationJobLeaseManager,
  getOrCreateTabId,
} from "../lib/separation/separationResumeController.ts";
import {
  clearSeparationDiagnosticLogs,
  getSeparationDiagnosticLogs,
} from "../lib/separation/separationStateRecovery.ts";
import { SeparationTaskCoordinator } from "../lib/separation/separationTaskController.ts";

const realSetTimeout = globalThis.setTimeout;

async function flushAsyncWork(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
}

function createFakeClock(initialNow = 10_000) {
  let currentNow = initialNow;
  let nextId = 1;
  const scheduled = [];
  const recordedDelays = [];

  const timer = {
    setTimeout(callback, delayMs) {
      const normalizedDelay = Math.max(0, Number(delayMs) || 0);
      recordedDelays.push(normalizedDelay);
      const token = {
        id: nextId++,
        runAt: currentNow + normalizedDelay,
        delayMs: normalizedDelay,
        callback,
        cleared: false,
        fired: false,
      };
      scheduled.push(token);
      return token;
    },
    clearTimeout(token) {
      if (token) {
        token.cleared = true;
      }
    },
  };

  return {
    timer,
    now: () => currentNow,
    setNow: (ms) => {
      currentNow = ms;
    },
    get recordedDelays() {
      return recordedDelays;
    },
    getActiveTimers() {
      return scheduled.filter((item) => !item.cleared && !item.fired);
    },
    getFiredCount() {
      return scheduled.filter((item) => item.fired).length;
    },
    async advanceTo(targetNow) {
      while (true) {
        const ready = scheduled
          .filter((item) => !item.cleared && !item.fired && item.runAt <= targetNow)
          .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
        if (ready.length === 0) break;
        const next = ready[0];
        currentNow = Math.max(currentNow, next.runAt);
        next.fired = true;
        next.callback();
        await flushAsyncWork();
      }
      currentNow = Math.max(currentNow, targetNow);
    },
    async advanceBy(deltaMs) {
      await this.advanceTo(currentNow + deltaMs);
    },
  };
}

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

function makeFakeCapabilities() {
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
  };
}

function makeFakeNetworkEval() {
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

async function seedSongWithCompletedChunks({ songId, hash = `hash-${songId}`, totalChunks = 2 }) {
  const totalSamples = DEMUCS_STRIDE_SAMPLES * (totalChunks - 1) + 4096;
  const blob = new Blob([new Uint8Array(96)], { type: "audio/wav" });
  const song = createBandSong({
    id: songId,
    name: `排程測試-${songId}`,
    fileName: `${songId}.wav`,
    sourceAudioId: `${songId}_original`,
    originalBpm: 120,
    durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
    sourceAudioHash: hash,
    fileSizeBytes: 96,
    mimeType: "audio/wav",
    fileLastModified: 1000,
  });
  const saved = await saveSongWithAudioFile({ song, file: blob, sourceAudioHash: hash, force: true });
  assert.equal(saved.ok, true);
  return { song, blob, hash, totalChunks, totalSamples };
}

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

test("10.4a: fake clock triggers real 5s / 15s / 60s backoff sequence (t=0 -> 5s -> 20s -> 80s) and stops at 3 attempts with zero spin", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();
  clearSeparationDiagnosticLogs();

  const fakeClock = createFakeClock(0);
  const { song, blob, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-backoff-exact",
    hash: "hash-backoff-exact",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();

  let workerRuns = 0;
  let songsWriteFailCount = 0;

  const manager = new SeparationJobManager({
    coordinator,
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        workerRuns += 1;
        await saveCheckpoint(
          buildInitialCheckpoint({
            taskId,
            songId: song.id,
            sourceAudioHash: hash,
            requestedMode: opts.mode,
            totalSamples,
            sampleRate: DEMUCS_SAMPLE_RATE,
            status: "running",
            userAuthorized: true,
            now: fakeClock.now(),
          }),
        );
        const leaseRes = await leaseManager.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        assert.equal(leaseRes.acquired, true);
        let latestCp = leaseRes.checkpoint;
        for (let idx = 0; idx < totalChunks; idx += 1) {
          const startSample = idx * DEMUCS_STRIDE_SAMPLES;
          const endSample = Math.min(totalSamples, startSample + DEMUCS_STRIDE_SAMPLES);
          const committed = await commitChunkAndCheckpointAtomically({
            taskId,
            chunkIndex: idx,
            startSample,
            endSample,
            payload: makeFakeChunkPayload(Math.max(1, endSample - startSample)),
            overlapCarryBuffer: null,
            expectedLease: leaseRes.lease,
            now: fakeClock.now(),
          });
          latestCp = committed.checkpoint;
        }
        await leaseManager.releaseLease(taskId, leaseRes.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              songsWriteFailCount += 1;
              throw new Error(`final write failed #${songsWriteFailCount}`);
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 15,
          executionFence: latestCp.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: latestCp.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    // t = 0: 初次分離完成 Chunk 後，songs 寫入失敗
    const initialOutcome = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(initialOutcome.status, "failed");
    assert.equal(songsWriteFailCount, 1);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts, 0);
    assert.equal(manager.getJob(taskId)?.nextRetryAt, 5_000);
    assert.deepEqual(
      fakeClock.getActiveTimers().map((t) => t.delayMs),
      [AUTO_RESUME_BACKOFF_MS[0]],
    );

    // t = 4999ms: 尚未到期，不應觸發第 1 次重試
    await fakeClock.advanceTo(4_999);
    assert.equal(songsWriteFailCount, 1);

    // t = 5000ms: 觸發第 1 次重試失敗 -> 排程 +15s（t = 20_000ms）
    await fakeClock.advanceTo(5_000);
    assert.equal(songsWriteFailCount, 2);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts, 1);
    assert.equal(manager.getJob(taskId)?.nextRetryAt, 20_000);
    assert.deepEqual(
      fakeClock.getActiveTimers().map((t) => t.delayMs),
      [AUTO_RESUME_BACKOFF_MS[1]],
    );

    // t = 19_999ms: 尚未到達第 2 次退避
    await fakeClock.advanceTo(19_999);
    assert.equal(songsWriteFailCount, 2);

    // t = 20_000ms: 觸發第 2 次重試失敗 -> 排程 +60s（t = 80_000ms）
    await fakeClock.advanceTo(20_000);
    assert.equal(songsWriteFailCount, 3);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts, 2);
    assert.equal(manager.getJob(taskId)?.nextRetryAt, 80_000);
    assert.deepEqual(
      fakeClock.getActiveTimers().map((t) => t.delayMs),
      [AUTO_RESUME_BACKOFF_MS[2]],
    );

    // t = 79_999ms: 尚未到達第 3 次退避
    await fakeClock.advanceTo(79_999);
    assert.equal(songsWriteFailCount, 3);

    // t = 80_000ms: 觸發第 3 次重試失敗 -> 耗盡額度（attempts === 3），轉手動重試
    await fakeClock.advanceTo(80_000);
    assert.equal(songsWriteFailCount, 4);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts, MAX_AUTO_RESUME_ATTEMPTS);
    assert.equal(manager.getJob(taskId)?.autoResumeExhausted, true);
    assert.equal(manager.getJob(taskId)?.requiresManualAction, true);
    assert.equal(manager.getJob(taskId)?.message, "保存未完成，請手動重試");
    assert.equal(fakeClock.getActiveTimers().length, 0);

    // 再推進 10 分鐘：絕不觸發第 4 次自動重試
    await fakeClock.advanceBy(600_000);
    assert.equal(songsWriteFailCount, 4);
    assert.equal(workerRuns, 1, "僅初次執行啟動過 1 次 Worker，重試皆走 onlyFinalize");
    assert.ok(
      fakeClock.recordedDelays.every((delay) => delay >= MIN_RETRY_WAKEUP_DELAY_MS),
      `偵測到低於 ${MIN_RETRY_WAKEUP_DELAY_MS}ms 的異常輪詢定時器: ${JSON.stringify(fakeClock.recordedDelays)}`,
    );
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});

test("10.4b: hidden tab for 5 minutes causes zero timer spin and wakes immediately when visible", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(1_000);
  let hidden = true;
  const { song, blob, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-hidden-5m",
    hash: "hash-hidden-5m",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  let finalWriteCalls = 0;

  const manager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    isDocumentHidden: () => hidden,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        await saveCheckpoint(
          buildInitialCheckpoint({
            taskId,
            songId: song.id,
            sourceAudioHash: hash,
            requestedMode: opts.mode,
            totalSamples,
            sampleRate: DEMUCS_SAMPLE_RATE,
            status: "running",
            userAuthorized: true,
            now: fakeClock.now(),
          }),
        );
        const leaseRes = await leaseManager.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        let latestCp = leaseRes.checkpoint;
        for (let idx = 0; idx < totalChunks; idx += 1) {
          const s = idx * DEMUCS_STRIDE_SAMPLES;
          const e = Math.min(totalSamples, s + DEMUCS_STRIDE_SAMPLES);
          const committed = await commitChunkAndCheckpointAtomically({
            taskId,
            chunkIndex: idx,
            startSample: s,
            endSample: e,
            payload: makeFakeChunkPayload(Math.max(1, e - s)),
            overlapCarryBuffer: null,
            expectedLease: leaseRes.lease,
            now: fakeClock.now(),
          });
          latestCp = committed.checkpoint;
        }
        await leaseManager.releaseLease(taskId, leaseRes.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              finalWriteCalls += 1;
              throw new Error("initial fail while hidden");
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 10,
          executionFence: latestCp.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: latestCp.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(finalWriteCalls, 1);
    // hidden 時不得建立任何輪詢定時器
    assert.equal(fakeClock.getActiveTimers().length, 0);

    // 維持 hidden 5 分鐘：定時器觸發次數為 0
    await fakeClock.advanceBy(5 * 60_000);
    assert.equal(fakeClock.getFiredCount(), 0);
    assert.equal(finalWriteCalls, 1);

    // 恢復 visible 後立即喚醒並完成最終提交
    setInMemoryIdbHooksForTests({});
    hidden = false;
    await manager.triggerLifecycleRecovery("visible");
    assert.equal(manager.getJob(taskId)?.stage, "completed");
    assert.equal((await getPersistedSongRecord(song.id))?.separationStatus, "completed");
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});

test("10.4c: local heavy task running for 5 minutes pauses inference retry scheduling without spin and resumes when controller settles", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(10_000);
  const { song, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-local-busy",
    hash: "hash-local-busy",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: song.id,
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      userAuthorized: true,
      now: fakeClock.now(),
    }),
  );
  await commitChunkAndCheckpointAtomically({
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    now: fakeClock.now(),
  });

  let localBusy = true;
  let resumeWorkerCalls = 0;
  const realCoordinator = new SeparationTaskCoordinator();

  const manager = new SeparationJobManager({
    coordinator: {
      startTask: realCoordinator.startTask.bind(realCoordinator),
      pauseTask: realCoordinator.pauseTask.bind(realCoordinator),
      cancelTask: realCoordinator.cancelTask.bind(realCoordinator),
      getActiveController: realCoordinator.getActiveController.bind(realCoordinator),
      hasRunningHeavyTask: () => localBusy || realCoordinator.hasRunningHeavyTask(),
    },
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        resumeWorkerCalls += 1;
        const acq = await leaseManager.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        const committed = await commitChunkAndCheckpointAtomically({
          taskId,
          chunkIndex: 1,
          startSample: DEMUCS_STRIDE_SAMPLES,
          endSample: totalSamples,
          payload: makeFakeChunkPayload(totalSamples - DEMUCS_STRIDE_SAMPLES),
          overlapCarryBuffer: null,
          expectedLease: acq.lease,
          now: fakeClock.now(),
        });
        await leaseManager.releaseLease(taskId, acq.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 20,
          executionFence: committed.checkpoint.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: committed.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    manager.saveRetryEntry(
      {
        taskId,
        attempts: 0,
        nextEligibleAt: fakeClock.now(),
        baselineCompletedChunks: 1,
        retryPhase: "inference",
      },
      { skipSchedule: true },
    );

    await manager.triggerLifecycleRecovery("local-busy-check");
    assert.equal(resumeWorkerCalls, 0);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts, 0);
    // 本地有重型任務執行中：不排高頻 polling timer
    assert.equal(fakeClock.getActiveTimers().length, 0);

    await fakeClock.advanceBy(5 * 60_000);
    assert.equal(resumeWorkerCalls, 0);
    assert.equal(fakeClock.getFiredCount(), 0);

    // 其他重型任務結束後觸發事件喚醒，立刻完成分離
    localBusy = false;
    await manager.triggerLifecycleRecovery("controller-settled");
    assert.equal(resumeWorkerCalls, 1);
    assert.equal(manager.getJob(taskId)?.stage, "completed");
  } finally {
    manager.dispose();
    leaseManager.close();
  }
});

test("10.4d: foreign lock / blocked state does not consume attempts and wakes immediately upon lease-released broadcast", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(20_000);
  const { song, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-foreign-wake",
    hash: "hash-foreign-wake",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const tabALeaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const tabBLeaseManager = new SeparationJobLeaseManager();

  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: song.id,
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      userAuthorized: true,
      now: 19_000,
    }),
  );
  const tabALease = await tabALeaseManager.acquireLease(taskId, "tab-A-foreign", 19_100);
  assert.equal(tabALease.acquired, true);
  let latestCp = tabALease.checkpoint;
  for (let idx = 0; idx < totalChunks; idx += 1) {
    const s = idx * DEMUCS_STRIDE_SAMPLES;
    const e = Math.min(totalSamples, s + DEMUCS_STRIDE_SAMPLES);
    const committed = await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: idx,
      startSample: s,
      endSample: e,
      payload: makeFakeChunkPayload(Math.max(1, e - s)),
      overlapCarryBuffer: null,
      expectedLease: tabALease.lease,
      now: 19_200 + idx,
    });
    latestCp = committed.checkpoint;
  }

  let foreignLocked = true;
  const lockAdapter = {
    async request(_name, _opts, cb) {
      if (foreignLocked) {
        return await cb(null);
      }
      return await cb({ name: _name });
    },
  };

  const tabBManager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager: tabBLeaseManager,
    lockAdapter,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: true,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      lockAdapter,
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
    },
  });

  try {
    // 模擬 Tab A 正在持鎖與持 Lease 執行最後階段
    await tabBManager.triggerLifecycleRecovery("visible-while-locked");
    assert.equal(tabBManager.getJob(taskId)?.isForeignActive, true);
    assert.equal(tabBManager.getJob(taskId)?.autoResumeAttempts ?? 0, 0);

    // 即使經過兩分鐘檢查，受阻鎖定絕不耗費重試額度
    await fakeClock.advanceBy(120_000);
    assert.equal(tabBManager.getAutoResumeRetryState(taskId)?.attempts ?? 0, 0);

    // Tab A 釋放 Lease 與鎖並發出 lease-released 廣播
    foreignLocked = false;
    await tabALeaseManager.releaseLease(taskId, tabALease.lease, "completed", fakeClock.now(), {
      suppressCompletedBroadcast: true,
    });

    await flushAsyncWork(15);
    assert.equal(tabBManager.getJob(taskId)?.stage, "completed");
    assert.equal((await getPersistedSongRecord(song.id))?.separationStatus, "completed");
    assert.ok(latestCp.nextChunkIndex === totalChunks);
  } finally {
    tabBManager.dispose();
    tabBLeaseManager.close();
    tabALeaseManager.close();
  }
});

test("10.4d2: resource_unavailable during inference auto-resume does not burn retry attempts and schedules blocked recheck delay", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(30_000);
  const { song, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-resource-wait",
    hash: "hash-resource-wait",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: song.id,
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      userAuthorized: true,
      now: 29_000,
    }),
  );
  await commitChunkAndCheckpointAtomically({
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: makeFakeChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    now: 29_500,
  });

  let storageLow = true;
  let workerCalls = 0;

  const manager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      collectCapabilitiesFn: async () => ({
        ...makeFakeCapabilities(),
        storageRemainingBytes: storageLow ? 100 : 900 * 1024 * 1024,
      }),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        workerCalls += 1;
        const acq = await leaseManager.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        const committed = await commitChunkAndCheckpointAtomically({
          taskId,
          chunkIndex: 1,
          startSample: DEMUCS_STRIDE_SAMPLES,
          endSample: totalSamples,
          payload: makeFakeChunkPayload(totalSamples - DEMUCS_STRIDE_SAMPLES),
          overlapCarryBuffer: null,
          expectedLease: acq.lease,
          now: fakeClock.now(),
        });
        await leaseManager.releaseLease(taskId, acq.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 15,
          executionFence: committed.checkpoint.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: committed.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    await manager.triggerLifecycleRecovery("startup-low-storage");
    assert.equal(workerCalls, 0);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts ?? 0, 0);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.waitReason, "resource_unavailable");
    assert.deepEqual(
      fakeClock.getActiveTimers().map((t) => t.delayMs),
      [BLOCKED_RECHECK_DELAY_MS],
    );

    // 推進超過一個 blocked recheck 仍資源不足 -> attempts 依舊維持 0
    await fakeClock.advanceBy(BLOCKED_RECHECK_DELAY_MS);
    assert.equal(workerCalls, 0);
    assert.equal(manager.getAutoResumeRetryState(taskId)?.attempts ?? 0, 0);
    assert.equal(manager.getJob(taskId)?.autoResumeExhausted ?? false, false);

    // 儲存空間恢復後再一次重檢即完成（無需消耗 3 次重試額度）
    storageLow = false;
    await fakeClock.advanceBy(BLOCKED_RECHECK_DELAY_MS);
    assert.equal(workerCalls, 1);
    assert.equal(manager.getJob(taskId)?.stage, "completed");
  } finally {
    manager.dispose();
    leaseManager.close();
  }
});

test("10.4e: simulated page reload preserves retry attempts and backoff schedule without resetting to 0", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(0);
  const sharedRetryStorage = makeMemoryRetryStorage();
  const { song, blob, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-reload-retry",
    hash: "hash-reload-retry",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  let songWriteCount = 0;

  const makeManagerDeps = () => ({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager,
    lockAdapter: null,
    retryStorage: sharedRetryStorage,
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        await saveCheckpoint(
          buildInitialCheckpoint({
            taskId,
            songId: song.id,
            sourceAudioHash: hash,
            requestedMode: opts.mode,
            totalSamples,
            sampleRate: DEMUCS_SAMPLE_RATE,
            status: "running",
            userAuthorized: true,
            now: fakeClock.now(),
          }),
        );
        const acq = await leaseManager.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        let latestCp = acq.checkpoint;
        for (let idx = 0; idx < totalChunks; idx += 1) {
          const s = idx * DEMUCS_STRIDE_SAMPLES;
          const e = Math.min(totalSamples, s + DEMUCS_STRIDE_SAMPLES);
          const committed = await commitChunkAndCheckpointAtomically({
            taskId,
            chunkIndex: idx,
            startSample: s,
            endSample: e,
            payload: makeFakeChunkPayload(Math.max(1, e - s)),
            overlapCarryBuffer: null,
            expectedLease: acq.lease,
            now: fakeClock.now(),
          });
          latestCp = committed.checkpoint;
        }
        await leaseManager.releaseLease(taskId, acq.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              songWriteCount += 1;
              throw new Error(`fail across reload #${songWriteCount}`);
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 12,
          executionFence: latestCp.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: latestCp.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  const managerBeforeReload = new SeparationJobManager(makeManagerDeps());
  let managerAfterReload = null;

  try {
    await managerBeforeReload.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(songWriteCount, 1);

    // 5s 時第 1 次重試失敗 -> attempts=1, nextEligibleAt=20_000
    await fakeClock.advanceTo(5_000);
    assert.equal(songWriteCount, 2);
    assert.equal(managerBeforeReload.getAutoResumeRetryState(taskId)?.attempts, 1);

    // 模擬重新整理頁面（卸載舊實例，於 t=6_000 建立全新實例）
    managerBeforeReload.dispose();
    fakeClock.setNow(6_000);
    managerAfterReload = new SeparationJobManager(makeManagerDeps());

    await managerAfterReload.triggerLifecycleRecovery("page-reload-startup");
    // 尚未到達 20_000，且必須保留 attempts=1，不得立即重試或歸零
    assert.equal(songWriteCount, 2);
    assert.equal(managerAfterReload.getJob(taskId)?.autoResumeAttempts, 1);

    // t=20_000 觸發第 2 次、t=80_000 觸發第 3 次後即耗盡，絕不變成額外 3 次
    await fakeClock.advanceTo(20_000);
    assert.equal(songWriteCount, 3);
    await fakeClock.advanceTo(80_000);
    assert.equal(songWriteCount, 4);
    assert.equal(managerAfterReload.getJob(taskId)?.autoResumeExhausted, true);

    await fakeClock.advanceBy(300_000);
    assert.equal(songWriteCount, 4);
  } finally {
    setInMemoryIdbHooksForTests({});
    managerBeforeReload.dispose();
    managerAfterReload?.dispose();
    leaseManager.close();
  }
});

test("10.4f: two managers sharing IDB enforce atomic retry reservation so total auto-resumes never exceed 3 (not 3 + 3)", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const fakeClock = createFakeClock(0);
  const { song, blob, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
    songId: "song-multi-tab-quota",
    hash: "hash-multi-tab-quota",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManagerA = new SeparationJobLeaseManager({ lockAdapter: null });
  const leaseManagerB = new SeparationJobLeaseManager({ lockAdapter: null });
  let totalFinalWriteFailures = 0;

  const makeSharedDeps = (lm) => ({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager: lm,
    lockAdapter: null,
    // 刻意給予各自獨立的 retryStorage，驗證僅靠 IndexedDB reserveAutoResumeAttempt 仍可跨分頁限額
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => makeFakeNetworkEval(),
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        await saveCheckpoint(
          buildInitialCheckpoint({
            taskId,
            songId: song.id,
            sourceAudioHash: hash,
            requestedMode: opts.mode,
            totalSamples,
            sampleRate: DEMUCS_SAMPLE_RATE,
            status: "running",
            userAuthorized: true,
            now: fakeClock.now(),
          }),
        );
        const acq = await lm.acquireLease(taskId, getOrCreateTabId(), fakeClock.now());
        let latestCp = acq.checkpoint;
        for (let idx = 0; idx < totalChunks; idx += 1) {
          const s = idx * DEMUCS_STRIDE_SAMPLES;
          const e = Math.min(totalSamples, s + DEMUCS_STRIDE_SAMPLES);
          const committed = await commitChunkAndCheckpointAtomically({
            taskId,
            chunkIndex: idx,
            startSample: s,
            endSample: e,
            payload: makeFakeChunkPayload(Math.max(1, e - s)),
            overlapCarryBuffer: null,
            expectedLease: acq.lease,
            now: fakeClock.now(),
          });
          latestCp = committed.checkpoint;
        }
        await lm.releaseLease(taskId, acq.lease, "completed", fakeClock.now(), {
          suppressCompletedBroadcast: true,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              totalFinalWriteFailures += 1;
              throw new Error(`multi-tab fail #${totalFinalWriteFailures}`);
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 10,
          executionFence: latestCp.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: latestCp.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  const managerA = new SeparationJobManager(makeSharedDeps(leaseManagerA));
  const managerB = new SeparationJobManager(makeSharedDeps(leaseManagerB));

  try {
    // Manager A 先完成分軌並在 t=0 失敗 1 次（尚未動用自動重試額度）
    await managerA.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(totalFinalWriteFailures, 1);

    // 讓 Manager B 也於啟動恢復同步此任務並一起跑過完整 120 秒
    await managerB.triggerLifecycleRecovery("tab-b-mount");
    await fakeClock.advanceTo(5_000);
    await managerB.triggerLifecycleRecovery("tab-b-race");
    await fakeClock.advanceTo(20_000);
    await managerB.triggerLifecycleRecovery("tab-b-race-2");
    await fakeClock.advanceTo(80_000);
    await managerB.triggerLifecycleRecovery("tab-b-race-3");
    await fakeClock.advanceTo(200_000);

    // 總寫入失敗次數 = 1 次初始 + 至多 3 次自動重試（共 <= 4 次，絕不會 1 + 3 + 3 = 7 次）
    assert.equal(totalFinalWriteFailures, 4);
    const cpAfterExhaust = await getCheckpoint(taskId);
    assert.equal(cpAfterExhaust?.retryState?.attempts, MAX_AUTO_RESUME_ATTEMPTS);
  } finally {
    setInMemoryIdbHooksForTests({});
    managerA.dispose();
    managerB.dispose();
    leaseManagerA.close();
    leaseManagerB.close();
  }
});

test("10.4g: manual cancel, song deletion, and dispose immediately clear retry timers so future clock advances fire nothing", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  // Case 1: manual cancel clears timers
  {
    const fakeClock = createFakeClock(0);
    const manager = new SeparationJobManager({
      enableBroadcastSync: false,
      retryStorage: makeMemoryRetryStorage(),
      now: fakeClock.now,
      retryTimer: fakeClock.timer,
    });
    try {
      manager.updateJob("task-cancel", {
        taskId: "task-cancel",
        songId: "song-cancel",
        stage: "finalizing",
        progress: 0.99,
        completedChunks: 2,
        totalChunks: 2,
        committedBytes: 100,
        message: "waiting",
      });
      manager.saveRetryEntry({
        taskId: "task-cancel",
        attempts: 0,
        nextEligibleAt: 5_000,
        baselineCompletedChunks: 2,
        retryPhase: "finalization",
      });
      assert.equal(fakeClock.getActiveTimers().length, 1);
      const cancelled = await manager.cancelJob("task-cancel");
      assert.equal(cancelled, true);
      assert.equal(fakeClock.getActiveTimers().length, 0);
      const firedBefore = fakeClock.getFiredCount();
      await fakeClock.advanceBy(120_000);
      assert.equal(fakeClock.getFiredCount(), firedBefore);
    } finally {
      manager.dispose();
    }
  }

  // Case 2: song deleted before scheduled retry -> stops cleanly without spinning further timers
  {
    resetInMemoryIdbForTests();
    configureInMemoryIdbForTests();
    const fakeClock = createFakeClock(0);
    const { song, hash, totalChunks, totalSamples } = await seedSongWithCompletedChunks({
      songId: "song-delete-timer",
      hash: "hash-delete-timer",
      totalChunks: 2,
    });
    const taskId = createCheckpointTaskId(song.id, hash);
    const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
    await saveCheckpoint(
      buildInitialCheckpoint({
        taskId,
        songId: song.id,
        sourceAudioHash: hash,
        requestedMode: "four_stem",
        totalSamples,
        sampleRate: DEMUCS_SAMPLE_RATE,
        status: "completed",
        nextChunkIndex: totalChunks,
        userAuthorized: true,
        now: 0,
      }),
    );
    const manager = new SeparationJobManager({
      coordinator: new SeparationTaskCoordinator(),
      leaseManager,
      lockAdapter: null,
      retryStorage: makeMemoryRetryStorage(),
      enableBroadcastSync: false,
      now: fakeClock.now,
      retryTimer: fakeClock.timer,
    });
    try {
      manager.updateJob(taskId, {
        taskId,
        songId: song.id,
        stage: "finalizing",
        progress: 0.99,
        completedChunks: totalChunks,
        totalChunks,
        committedBytes: 100,
        message: "waiting",
      });
      manager.saveRetryEntry({
        taskId,
        attempts: 0,
        nextEligibleAt: 5_000,
        baselineCompletedChunks: totalChunks,
        retryPhase: "finalization",
      });
      // 刪除歌曲後到達重試時間
      await withIdbTransaction("songs", "readwrite", (tx) =>
        idbRequestPromise(tx.objectStore("songs").delete(song.id)),
      );
      await fakeClock.advanceTo(5_000);
      assert.equal(fakeClock.getActiveTimers().length, 0);
      const firedAfterDelete = fakeClock.getFiredCount();
      await fakeClock.advanceBy(120_000);
      assert.equal(fakeClock.getFiredCount(), firedAfterDelete);
    } finally {
      manager.dispose();
      leaseManager.close();
    }
  }

  // Case 3: dispose clears pending timer cleanly
  {
    const fakeClock = createFakeClock(0);
    const manager = new SeparationJobManager({
      enableBroadcastSync: false,
      retryStorage: makeMemoryRetryStorage(),
      now: fakeClock.now,
      retryTimer: fakeClock.timer,
    });
    manager.updateJob("task-dispose", {
      taskId: "task-dispose",
      songId: "song-dispose",
      stage: "interrupted",
      progress: 0.5,
      completedChunks: 1,
      totalChunks: 2,
      committedBytes: 100,
      message: "waiting",
    });
    manager.saveRetryEntry({
      taskId: "task-dispose",
      attempts: 0,
      nextEligibleAt: 5_000,
      baselineCompletedChunks: 1,
      retryPhase: "inference",
    });
    assert.equal(fakeClock.getActiveTimers().length, 1);
    manager.dispose();
    assert.equal(fakeClock.getActiveTimers().length, 0);
    await fakeClock.advanceBy(120_000);
    assert.equal(fakeClock.getFiredCount(), 0);
  }
});

test("10.4h: unexpected scheduler or recovery error is safely caught without triggering unhandledRejection", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const fakeClock = createFakeClock(0);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const faultyLeaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  faultyLeaseManager.reserveAutoResumeAttempt = async () => {
    throw new Error("unexpected IDB failure inside scheduler reservation");
  };

  const manager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager: faultyLeaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    now: fakeClock.now,
    retryTimer: fakeClock.timer,
  });

  try {
    manager.updateJob("task-faulty-sched", {
      taskId: "task-faulty-sched",
      songId: "song-faulty-sched",
      stage: "finalizing",
      progress: 0.99,
      completedChunks: 2,
      totalChunks: 2,
      committedBytes: 100,
      message: "waiting",
    });
    manager.saveRetryEntry({
      taskId: "task-faulty-sched",
      attempts: 0,
      nextEligibleAt: 5_000,
      baselineCompletedChunks: 2,
      retryPhase: "finalization",
    });

    await fakeClock.advanceTo(5_000);
    await flushAsyncWork(10);

    assert.equal(unhandled.length, 0, "排程器異常不得產生任何 unhandledRejection");
    const logs = getSeparationDiagnosticLogs();
    assert.ok(logs.length > 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    manager.dispose();
    faultyLeaseManager.close();
  }
});
