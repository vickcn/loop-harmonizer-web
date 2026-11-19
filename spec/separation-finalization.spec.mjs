import assert from "node:assert/strict";
import test from "node:test";

import { createBandSong } from "../lib/band/songModel.ts";
import {
  DEMUCS_MODEL_VERSION,
  SEPARATION_PROCESSING_VERSION,
  createSeparationCacheKey,
} from "../lib/storage/cacheKeys.ts";
import {
  configureInMemoryIdbForTests,
  idbRequestPromise,
  resetInMemoryIdbForTests,
  setInMemoryIdbHooksForTests,
  withIdbTransaction,
} from "../lib/storage/indexedDb.ts";
import {
  createStemCacheRecord,
  putCachedStemSet,
} from "../lib/storage/separationCache.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  getTaskChunkRecords,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  createCheckpointTaskId,
  createIsolatedRecomputeTaskId,
  getCheckpoint,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  commitPersistedSongSeparationFinalization,
  getPersistedSongRecord,
  saveSongStateRecord,
  saveSongWithAudioFile,
} from "../lib/storage/songSessionStore.ts";
import {
  SeparationJobManager,
  canTransitionJobStage,
  mapCheckpointStatusToJobStage,
  mapJobStageToSongSeparationStatus,
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

function makeFakeStems(mode = "four_stem", frames = 1024) {
  const mk = (stemType, seed) => ({
    stemType,
    left: new Float32Array(frames).fill(seed),
    right: new Float32Array(frames).fill(seed),
  });
  return mode === "two_stem"
    ? {
        mode: "two_stem",
        sampleRate: DEMUCS_SAMPLE_RATE,
        tracks: [mk("vocals", 0.1), mk("instrumental", 0.2)],
      }
    : {
        mode: "four_stem",
        sampleRate: DEMUCS_SAMPLE_RATE,
        tracks: [
          mk("vocals", 0.1),
          mk("drums", 0.2),
          mk("bass", 0.3),
          mk("other", 0.4),
        ],
      };
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

async function seedSongAndAudio({
  songId,
  hash = `hash-${songId}`,
  totalChunks = 2,
  mode = "four_stem",
}) {
  const totalSamples = DEMUCS_STRIDE_SAMPLES * (totalChunks - 1) + 4096;
  const blob = new Blob([new Uint8Array(128)], { type: "audio/wav" });
  const song = createBandSong({
    id: songId,
    name: `測試歌曲-${songId}`,
    fileName: `${songId}.wav`,
    sourceAudioId: `${songId}_original`,
    originalBpm: 120,
    durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
    sourceAudioHash: hash,
    fileSizeBytes: 128,
    mimeType: "audio/wav",
    fileLastModified: 1000,
    separationMode: mode,
  });
  const saved = await saveSongWithAudioFile({ song, file: blob, sourceAudioHash: hash, force: true });
  assert.equal(saved.ok, true);
  return { song, blob, hash, totalChunks, totalSamples };
}

async function commitAllChunksForTask({
  taskId,
  songId,
  hash,
  totalChunks,
  totalSamples,
  mode = "four_stem",
  leaseManager,
  tabId = getOrCreateTabId(),
}) {
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId,
      sourceAudioHash: hash,
      requestedMode: mode,
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      userAuthorized: true,
      now: 1000,
    }),
  );
  const leaseRes = await leaseManager.acquireLease(taskId, tabId);
  assert.equal(leaseRes.acquired, true);

  let latestCp = leaseRes.checkpoint;
  for (let idx = 0; idx < totalChunks; idx += 1) {
    const startSample = idx * DEMUCS_STRIDE_SAMPLES;
    const endSample = Math.min(totalSamples, startSample + DEMUCS_STRIDE_SAMPLES);
    const frameCount = Math.max(1, endSample - startSample);
    const committed = await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: idx,
      startSample,
      endSample,
      payload: makeFakeChunkPayload(frameCount),
      overlapCarryBuffer: null,
      expectedLease: leaseRes.lease,
      now: 1100 + idx * 100,
    });
    assert.ok(committed.chunkRecord && committed.checkpoint);
    latestCp = committed.checkpoint;
  }

  await leaseManager.releaseLease(taskId, leaseRes.lease, "completed", 1500, {
    suppressCompletedBroadcast: true,
  });
  return {
    checkpoint: latestCp,
    lease: leaseRes.lease,
  };
}

test("completed checkpoint is finalizing until the authoritative song result is committed", () => {
  const checkpoint = { status: "completed" };
  assert.equal(
    mapCheckpointStatusToJobStage(checkpoint, { hasActiveLocalController: false, hasActiveForeignOwner: false }),
    "finalizing",
  );
  assert.equal(
    mapCheckpointStatusToJobStage(checkpoint, {
      hasActiveLocalController: false,
      hasActiveForeignOwner: false,
      isFinalized: true,
    }),
    "completed",
  );
  assert.equal(mapJobStageToSongSeparationStatus("finalizing"), "processing");
});

test("10.1a: last chunk succeeds then songs write throws -> stays finalizing, preserves valid chunks, retryFinalization succeeds with 0 worker & 0 network preflight & task-completed emitted only after commit", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();
  clearSeparationDiagnosticLogs();

  const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-final-fail",
    hash: "hash-final-fail",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const receiverLeaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  const broadcasts = [];
  const unsubscribe = receiverLeaseManager.onBroadcast((msg) => broadcasts.push(msg));

  let workerCalls = 0;
  let preflightCalls = 0;

  const manager = new SeparationJobManager({
    coordinator,
    leaseManager,
    lockAdapter: null,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    runnerDeps: {
      collectCapabilitiesFn: async () => makeFakeCapabilities(),
      preflightNetworkFn: async () => {
        preflightCalls += 1;
        return makeFakeNetworkEval();
      },
      hashSourceAudioFn: async () => hash,
      separateAudioFn: async (_file, opts) => {
        workerCalls += 1;
        const result = await commitAllChunksForTask({
          taskId: opts.checkpointTaskId ?? taskId,
          songId: song.id,
          hash,
          totalChunks,
          totalSamples,
          mode: opts.mode,
          leaseManager,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              throw new Error("simulated songs commit failure");
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 40,
          executionFence: result.checkpoint.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: result.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    const failedOutcome = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });

    assert.equal(failedOutcome.status, "failed");
    assert.equal(failedOutcome.retryable, true);
    assert.equal(workerCalls, 1);
    assert.equal(preflightCalls, 1);

    const jobAfterFail = manager.getJob(taskId);
    assert.equal(jobAfterFail?.stage, "finalizing");
    assert.equal(jobAfterFail?.retryPhase, "finalization");
    assert.equal(jobAfterFail?.isActivelyFinalizing, false);

    // 歌曲不得被標記為 completed，且不提前廣播 task-completed
    const persistedBeforeRetry = await getPersistedSongRecord(song.id);
    assert.notEqual(persistedBeforeRetry?.separationStatus, "completed");
    assert.equal(
      broadcasts.some((msg) => msg.type === "task-completed" && msg.taskId === taskId),
      false,
    );

    // 所有已提交的合法 Chunk 完整保留
    const chunks = await getTaskChunkRecords(taskId);
    assert.equal(chunks.length, totalChunks);

    // 移除故障並手動重試保存：0 Worker、0 模型下載，只完成最終提交
    setInMemoryIdbHooksForTests({});
    const retryOutcome = await manager.retryFinalization(taskId);
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(retryOutcome?.status, "completed");
    assert.equal(workerCalls, 1, "retryFinalization 不得重建 Demucs Worker");
    assert.equal(preflightCalls, 1, "retryFinalization 不得重跑模型/網路預檢");

    const persistedAfterRetry = await getPersistedSongRecord(song.id);
    assert.equal(persistedAfterRetry?.separationStatus, "completed");
    assert.equal(persistedAfterRetry?.separationTaskId, taskId);
    assert.ok((await getCheckpoint(taskId))?.finalizedAt);
    assert.equal(manager.getJob(taskId)?.stage, "completed");
    assert.equal(
      broadcasts.some((msg) => msg.type === "task-completed" && msg.taskId === taskId),
      true,
      "僅於 authoritative songs commit 成功後才廣播 task-completed",
    );
  } finally {
    setInMemoryIdbHooksForTests({});
    unsubscribe();
    manager.dispose();
    receiverLeaseManager.close();
    leaseManager.close();
  }
});

test("10.1b: QuotaExceededError during finalization -> failureCode quota_exceeded, waitReason storage_unavailable, does not burn backoff quota", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-quota-fail",
    hash: "hash-quota-fail",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
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
        const result = await commitAllChunksForTask({
          taskId,
          songId: song.id,
          hash,
          totalChunks,
          totalSamples,
          mode: opts.mode,
          leaseManager,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              throw new DOMException("Storage quota exceeded", "QuotaExceededError");
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 30,
          executionFence: result.checkpoint.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: result.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    const outcome = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "quota_exceeded");
    const job = manager.getJob(taskId);
    assert.equal(job?.stage, "finalizing");
    assert.equal(job?.retryWaitReason, "storage_unavailable");
    assert.equal(job?.message, "請釋放空間後重試保存");
    assert.equal(job?.autoResumeAttempts ?? 0, 0);
    assert.notEqual((await getPersistedSongRecord(song.id))?.separationStatus, "completed");

    setInMemoryIdbHooksForTests({});
    const retried = await manager.retryFinalization(taskId);
    assert.equal(retried?.status, "completed");
    assert.equal((await getPersistedSongRecord(song.id))?.separationStatus, "completed");
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});

test("10.1c: song_missing, stale_generation, source_mismatch, transition_rejected never mark completed & mark non-retryable cleanly", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  // 1) transition_rejected: stage transition guard
  assert.equal(
    canTransitionJobStage("finalizing", "completed", {
      currentGeneration: 2,
      incomingGeneration: 1,
    }),
    false,
  );
  assert.equal(
    canTransitionJobStage("cancelled", "finalizing", { allowRepairOrReset: true }),
    false,
  );
  assert.equal(
    canTransitionJobStage("completed", "finalizing", { allowRepairOrReset: true }),
    false,
  );

  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  try {
    // 2) song_missing in runner
    {
      const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
        songId: "song-missing-case",
        hash: "hash-missing-case",
      });
      const taskId = createCheckpointTaskId(song.id, hash);
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
            const res = await commitAllChunksForTask({
              taskId,
              songId: song.id,
              hash,
              totalChunks,
              totalSamples,
              mode: opts.mode,
              leaseManager,
            });
            await withIdbTransaction("songs", "readwrite", (tx) =>
              idbRequestPromise(tx.objectStore("songs").delete(song.id)),
            );
            return {
              backend: "wasm",
              usedWorker: true,
              durationMs: 25,
              executionFence: res.checkpoint.finalizationFence,
              chunkedTask: {
                taskId,
                mode: opts.mode,
                sampleRate: DEMUCS_SAMPLE_RATE,
                totalSamples,
                totalChunks,
                committedBytes: res.checkpoint.committedBytes,
                durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
              },
            };
          },
        },
      });
      const out = await manager.runSongSeparation({
        songId: song.id,
        songName: song.name,
        file: blob,
        sourceAudioHash: hash,
        mode: "four_stem",
        guardAlreadyConfirmed: true,
      });
      assert.equal(out.status, "failed");
      assert.equal(out.retryable, false);
      assert.equal(out.failureCode, "song_missing");
      assert.equal(manager.getJob(taskId)?.requiresManualAction, true);
      assert.equal(manager.getJob(taskId)?.autoResumeExhausted, true);
      assert.equal(await getPersistedSongRecord(song.id), null);
      manager.dispose();
    }

    // 3) source_mismatch in direct commit & runner
    {
      const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
        songId: "song-mismatch-case",
        hash: "hash-mismatch-case",
      });
      const taskId = createCheckpointTaskId(song.id, hash);
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
            const res = await commitAllChunksForTask({
              taskId,
              songId: song.id,
              hash,
              totalChunks,
              totalSamples,
              mode: opts.mode,
              leaseManager,
            });
            // 篡改 persisted song 的 sourceAudioHash 模擬來源不一致
            const existing = await getPersistedSongRecord(song.id);
            await withIdbTransaction("songs", "readwrite", (tx) =>
              idbRequestPromise(
                tx.objectStore("songs").put({
                  ...existing,
                  sourceAudioHash: "different-audio-hash",
                }),
              ),
            );
            return {
              backend: "wasm",
              usedWorker: true,
              durationMs: 25,
              executionFence: res.checkpoint.finalizationFence,
              chunkedTask: {
                taskId,
                mode: opts.mode,
                sampleRate: DEMUCS_SAMPLE_RATE,
                totalSamples,
                totalChunks,
                committedBytes: res.checkpoint.committedBytes,
                durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
              },
            };
          },
        },
      });
      const out = await manager.runSongSeparation({
        songId: song.id,
        songName: song.name,
        file: blob,
        sourceAudioHash: hash,
        mode: "four_stem",
        guardAlreadyConfirmed: true,
      });
      assert.equal(out.status, "failed");
      assert.equal(out.retryable, false);
      assert.equal(out.failureCode, "source_mismatch");
      assert.equal(manager.getJob(taskId)?.requiresManualAction, true);
      assert.notEqual((await getPersistedSongRecord(song.id))?.separationStatus, "completed");
      manager.dispose();
    }

    // 4) stale_generation direct commit rejection preserves newer generation
    {
      const { song, hash, totalChunks, totalSamples } = await seedSongAndAudio({
        songId: "song-stale-gen",
        hash: "hash-stale-gen",
      });
      const taskId = createCheckpointTaskId(song.id, hash);
      await commitAllChunksForTask({
        taskId,
        songId: song.id,
        hash,
        totalChunks,
        totalSamples,
        leaseManager,
      });
      const own2 = await leaseManager.acquireFinalizationOwnership(taskId, "tab-B");
      assert.equal(own2.acquired, true);
      const cacheKey = createSeparationCacheKey({
        sourceAudioHash: hash,
        modelVersion: DEMUCS_MODEL_VERSION,
        separationMode: "four_stem",
        processingVersion: SEPARATION_PROCESSING_VERSION,
      });
      const commit2 = await commitPersistedSongSeparationFinalization({
        songId: song.id,
        taskId,
        sourceAudioHash: hash,
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        generation: own2.fence.generation,
        ownerJobToken: own2.fence.ownerJobToken,
        ownerTabId: "tab-B",
        mode: "four_stem",
        totalChunks,
        committedBytes: 2048,
        cacheKey,
        stemRoles: ["vocals", "drums", "bass", "other"],
      });
      assert.equal(commit2.status, "committed");

      const staleCommit = await commitPersistedSongSeparationFinalization({
        songId: song.id,
        taskId,
        sourceAudioHash: hash,
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        generation: own2.fence.generation - 1,
        ownerJobToken: "stale-token",
        ownerTabId: "tab-A",
        mode: "four_stem",
        totalChunks,
        committedBytes: 2048,
        cacheKey,
        stemRoles: ["vocals", "drums", "bass", "other"],
      });
      assert.equal(staleCommit.status, "stale_generation");
      assert.equal((await getPersistedSongRecord(song.id))?.separationGeneration, own2.fence.generation);
    }
  } finally {
    leaseManager.close();
  }
});

test("10.1d: forceRecompute failure preserves original completed song, cacheKey, and chunks while retryFinalization completes isolated :r checkpoint", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-recompute",
    hash: "hash-recompute",
    totalChunks: 2,
  });
  const baseTaskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  let workerCalls = 0;
  let shouldFailSongsOnRecompute = false;
  let isolatedTaskIdObserved = null;

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
        workerCalls += 1;
        const targetTaskId = opts.checkpointTaskId ?? baseTaskId;
        if (targetTaskId !== baseTaskId) {
          isolatedTaskIdObserved = targetTaskId;
        }
        const res = await commitAllChunksForTask({
          taskId: targetTaskId,
          songId: song.id,
          hash,
          totalChunks,
          totalSamples,
          mode: opts.mode,
          leaseManager,
        });
        if (shouldFailSongsOnRecompute) {
          setInMemoryIdbHooksForTests({
            beforeWrite: (storeName) => {
              if (storeName === "songs") {
                throw new Error("recompute final write failed");
              }
            },
          });
        }
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 35,
          executionFence: res.checkpoint.finalizationFence,
          chunkedTask: {
            taskId: targetTaskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: res.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    // 1) 初次完整完成
    const first = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(first.status, "completed");
    const persistedFirst = await getPersistedSongRecord(song.id);
    assert.equal(persistedFirst?.separationStatus, "completed");
    assert.equal(persistedFirst?.separationTaskId, baseTaskId);
    const originalCacheKey = persistedFirst?.cacheKey;
    assert.equal((await getTaskChunkRecords(baseTaskId)).length, totalChunks);

    // 2) 強制重算並於最終提交失敗
    shouldFailSongsOnRecompute = true;
    const recomputeFail = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      forceRecompute: true,
      guardAlreadyConfirmed: true,
    });
    assert.equal(recomputeFail.status, "failed");
    assert.ok(isolatedTaskIdObserved && isolatedTaskIdObserved !== baseTaskId);
    assert.equal(isolatedTaskIdObserved.includes(":r"), true);

    // 原完成歌曲與舊 Chunks 必須毫髮無傷
    const persistedDuringFail = await getPersistedSongRecord(song.id);
    assert.equal(persistedDuringFail?.separationStatus, "completed");
    assert.equal(persistedDuringFail?.separationTaskId, baseTaskId);
    assert.equal(persistedDuringFail?.cacheKey, originalCacheKey);
    assert.equal((await getTaskChunkRecords(baseTaskId)).length, totalChunks);
    assert.equal((await getTaskChunkRecords(isolatedTaskIdObserved)).length, totalChunks);
    assert.equal(manager.getJob(isolatedTaskIdObserved)?.stage, "finalizing");

    // 3) 清除故障並只重試新的隔離 taskId：0 次重建 Worker 完成替換
    setInMemoryIdbHooksForTests({});
    shouldFailSongsOnRecompute = false;
    const workerCallsBeforeRetry = workerCalls;
    const retried = await manager.retryFinalization(isolatedTaskIdObserved);
    assert.equal(retried?.status, "completed");
    assert.equal(workerCalls, workerCallsBeforeRetry);

    const persistedAfterReplace = await getPersistedSongRecord(song.id);
    assert.equal(persistedAfterReplace?.separationStatus, "completed");
    assert.equal(persistedAfterReplace?.separationTaskId, isolatedTaskIdObserved);
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});

test("10.1e: fast-cache hit and 4->2 stem conversion adhere to commitPersistedSongSeparationFinalization and recover without worker", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { song, blob, hash } = await seedSongAndAudio({
    songId: "song-fast-cache",
    hash: "hash-fast-cache",
    totalChunks: 1,
    mode: "two_stem",
  });
  const fourKey = createSeparationCacheKey({
    sourceAudioHash: hash,
    modelVersion: DEMUCS_MODEL_VERSION,
    separationMode: "four_stem",
    processingVersion: SEPARATION_PROCESSING_VERSION,
  });
  await putCachedStemSet(
    createStemCacheRecord({
      key: fourKey,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      stems: makeFakeStems("four_stem"),
    }),
  );

  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  let workerCalls = 0;

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
      separateAudioFn: async () => {
        workerCalls += 1;
        throw new Error("should never start worker on fast cache / 4->2 derive");
      },
    },
  });

  try {
    // 注入寫入 songs 失敗：4->2 衍生路徑走統一 finalization，失敗時不可誤標 completed
    setInMemoryIdbHooksForTests({
      beforeWrite: (storeName) => {
        if (storeName === "songs") {
          throw new Error("fast-cache commit fail");
        }
      },
    });

    const firstAttempt = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "two_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(firstAttempt.status, "failed");
    assert.equal(workerCalls, 0);
    assert.equal(manager.getJob(taskId)?.stage, "finalizing");
    assert.notEqual((await getPersistedSongRecord(song.id))?.separationStatus, "completed");

    // 修復資料庫並重試保存（此時 2-stem 快取已寫入 separations store，走 fast-cache 路徑完成）
    setInMemoryIdbHooksForTests({});
    const retried = await manager.retryFinalization(taskId);
    assert.equal(retried?.status, "completed");
    assert.equal(workerCalls, 0);
    const persisted = await getPersistedSongRecord(song.id);
    assert.equal(persisted?.separationStatus, "completed");
    assert.equal(persisted?.separationMode, "two_stem");
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});

test("10.1f: delayed debounced saveSongStateRecord with stale fields cannot overwrite completed separation state unless allowResetSeparation is true", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const { song, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-stale-save",
    hash: "hash-stale-save",
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const res = await commitAllChunksForTask({
    taskId,
    songId: song.id,
    hash,
    totalChunks,
    totalSamples,
    leaseManager,
  });

  try {
    const own = await leaseManager.acquireFinalizationOwnership(taskId, "tab-A");
    assert.equal(own.acquired, true);
    const cacheKey = createSeparationCacheKey({
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });
    const commitRes = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: own.fence.generation,
      ownerJobToken: own.fence.ownerJobToken,
      ownerTabId: "tab-A",
      mode: "four_stem",
      totalChunks,
      committedBytes: res.checkpoint.committedBytes,
      cacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(commitRes.status, "committed");

    // 延遲的 UI 設定存檔（帶舊的 processing / 0 chunks）不得覆寫已完成分軌欄位
    const staleUiSong = {
      ...song,
      targetBpm: 132,
      volume: 0.77,
      separationStatus: "processing",
      separationStage: "processing",
      separationTaskId: null,
      separationCompletedChunks: 0,
      separationTotalChunks: 0,
      cacheKey: null,
    };
    const saveRes = await saveSongStateRecord(staleUiSong, { force: true });
    assert.equal(saveRes.ok, true);

    const stored = await getPersistedSongRecord(song.id);
    assert.equal(stored?.targetBpm, 132, "使用者最新混音設定應保留");
    assert.equal(stored?.separationStatus, "completed", "延遲儲存不得降級 completed");
    assert.equal(stored?.separationTaskId, taskId);
    assert.equal(stored?.separationGeneration, own.fence.generation);
    assert.equal(stored?.separationCompletedChunks, totalChunks);

    // 明確要求重設分軌（allowResetSeparation: true）時才允許清除分軌欄位
    const clearedSong = {
      ...song,
      separationStatus: "not_started",
      separationStage: "idle",
      separationTaskId: null,
      separationCompletedChunks: 0,
      separationTotalChunks: 0,
      cacheKey: null,
    };
    const clearRes = await saveSongStateRecord(clearedSong, {
      force: true,
      allowResetSeparation: true,
    });
    assert.equal(clearRes.ok, true);
    const storedAfterClear = await getPersistedSongRecord(song.id);
    assert.equal(storedAfterClear?.separationStatus, "not_started");
  } finally {
    leaseManager.close();
  }
});

test("10.2a: Gen 1 vs Gen 2 finalization race without Web Locks rejects stale Gen 1 commit and mismatched ownerJobToken", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const { song, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-gen-race",
    hash: "hash-gen-race",
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });

  try {
    await commitAllChunksForTask({
      taskId,
      songId: song.id,
      hash,
      totalChunks,
      totalSamples,
      leaseManager,
    });

    const tabAOwnership = await leaseManager.acquireFinalizationOwnership(taskId, "tab-A");
    assert.equal(tabAOwnership.acquired, true);
    const tabBOwnership = await leaseManager.acquireFinalizationOwnership(taskId, "tab-B");
    assert.equal(tabBOwnership.acquired, true);
    assert.ok(tabBOwnership.fence.generation > tabAOwnership.fence.generation);

    const cacheKey = createSeparationCacheKey({
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });

    // 無 Web Locks 環境：Tab B (Gen 2) 領先提交成功
    const commitB = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: tabBOwnership.fence.generation,
      ownerJobToken: tabBOwnership.fence.ownerJobToken,
      ownerTabId: "tab-B",
      mode: "four_stem",
      totalChunks,
      committedBytes: 4096,
      cacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(commitB.status, "committed");

    // Tab A (Gen 1) 較晚送出最終提交 -> 即使無 Web Locks 仍因 generation 過時被 IDB 交易拒絕
    const commitA = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: tabAOwnership.fence.generation,
      ownerJobToken: tabAOwnership.fence.ownerJobToken,
      ownerTabId: "tab-A",
      mode: "four_stem",
      totalChunks,
      committedBytes: 4096,
      cacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(commitA.status, "stale_generation");

    // 相同 generation 但錯誤 ownerJobToken 一樣拒絕
    const wrongTokenCommit = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: tabBOwnership.fence.generation,
      ownerJobToken: "forged-wrong-token",
      ownerTabId: "tab-C",
      mode: "four_stem",
      totalChunks,
      committedBytes: 4096,
      cacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(wrongTokenCommit.status, "stale_generation");
  } finally {
    leaseManager.close();
  }
});

test("10.2b: active foreign Web Lock during finalization blocks second tab, projects foreign finalizing without burning retries, and cancel/delete race prevents resurrection", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();

  const { song, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-foreign-final",
    hash: "hash-foreign-final",
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager();
  const heldLocks = new Set([`loop-harmonizer:separation:${taskId}`]);
  const sharedLockAdapter = {
    async request(name, options, callback) {
      const held = heldLocks.has(name);
      if (options?.ifAvailable && held) {
        return await callback(null);
      }
      if (held) {
        return await callback(null);
      }
      heldLocks.add(name);
      try {
        return await callback({ name });
      } finally {
        heldLocks.delete(name);
      }
    },
  };

  const tabBManager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager,
    lockAdapter: sharedLockAdapter,
    retryStorage: makeMemoryRetryStorage(),
    enableBroadcastSync: false,
    runnerDeps: {
      lockAdapter: sharedLockAdapter,
    },
  });

  try {
    const chunkRes = await commitAllChunksForTask({
      taskId,
      songId: song.id,
      hash,
      totalChunks,
      totalSamples,
      leaseManager,
      tabId: "tab-A",
    });

    await tabBManager.triggerLifecycleRecovery("visible");
    const foreignView = tabBManager.getJob(taskId);
    assert.equal(foreignView?.stage, "finalizing");
    assert.equal(foreignView?.isForeignActive, true);
    assert.equal(foreignView?.message, "其他分頁正在處理");
    assert.equal(foreignView?.autoResumeAttempts ?? 0, 0);

    // 取消後舊執行者（即使帶同世代合法 Token）仍不得將已取消任務復活為 completed
    await updateCheckpointStatus(taskId, {
      status: "cancelled",
      lastError: "user cancelled",
      allowDowngradeCompleted: true,
    });
    const staleCacheKey = createSeparationCacheKey({
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });
    const resurrectedSameToken = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: chunkRes.checkpoint.finalizationFence.generation,
      ownerJobToken: chunkRes.checkpoint.finalizationFence.ownerJobToken,
      ownerTabId: "tab-A",
      mode: "four_stem",
      totalChunks,
      committedBytes: 2048,
      cacheKey: staleCacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(resurrectedSameToken.status, "transition_rejected");
    const resurrectedForeignToken = await commitPersistedSongSeparationFinalization({
      songId: song.id,
      taskId,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      generation: 1,
      ownerJobToken: "stale-worker-token",
      ownerTabId: "tab-A",
      mode: "four_stem",
      totalChunks,
      committedBytes: 2048,
      cacheKey: staleCacheKey,
      stemRoles: ["vocals", "drums", "bass", "other"],
    });
    assert.equal(resurrectedForeignToken.status, "transition_rejected");
    assert.notEqual((await getPersistedSongRecord(song.id))?.separationStatus, "completed");
  } finally {
    tabBManager.dispose();
    leaseManager.close();
  }
});

test("10.3: repeated finalization failures settle SeparationTaskController so hasRunningHeavyTask()===false and retry succeeds", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();
  clearSeparationDiagnosticLogs();

  const { song, blob, hash, totalChunks, totalSamples } = await seedSongAndAudio({
    songId: "song-ctrl-settle",
    hash: "hash-ctrl-settle",
    totalChunks: 2,
  });
  const taskId = createCheckpointTaskId(song.id, hash);
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter: null });
  const coordinator = new SeparationTaskCoordinator();
  let capturedController = null;
  let workerCalls = 0;

  const originalStartTask = coordinator.startTask.bind(coordinator);
  coordinator.startTask = (opts) => {
    const ctrl = originalStartTask(opts);
    capturedController = ctrl;
    return ctrl;
  };

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
        workerCalls += 1;
        const res = await commitAllChunksForTask({
          taskId,
          songId: song.id,
          hash,
          totalChunks,
          totalSamples,
          mode: opts.mode,
          leaseManager,
        });
        setInMemoryIdbHooksForTests({
          beforeWrite: (storeName) => {
            if (storeName === "songs") {
              throw new Error("songs tx aborted");
            }
          },
        });
        return {
          backend: "wasm",
          usedWorker: true,
          durationMs: 20,
          executionFence: res.checkpoint.finalizationFence,
          chunkedTask: {
            taskId,
            mode: opts.mode,
            sampleRate: DEMUCS_SAMPLE_RATE,
            totalSamples,
            totalChunks,
            committedBytes: res.checkpoint.committedBytes,
            durationSeconds: totalSamples / DEMUCS_SAMPLE_RATE,
          },
        };
      },
    },
  });

  try {
    const out1 = await manager.runSongSeparation({
      songId: song.id,
      songName: song.name,
      file: blob,
      sourceAudioHash: hash,
      mode: "four_stem",
      guardAlreadyConfirmed: true,
    });
    assert.equal(out1.status, "failed");
    assert.equal(capturedController?.isTerminal(), true, "首次 finalization 失敗後 controller 必須立即結算");
    assert.equal(coordinator.hasRunningHeavyTask(), false, "失敗後 coordinator 不得卡住重型任務名額");

    // 第二次持續失敗，controller 同樣即時結算不阻塞後續重試
    const out2 = await manager.retryFinalization(taskId);
    assert.equal(out2?.status, "failed");
    assert.equal(capturedController?.isTerminal(), true);
    assert.equal(coordinator.hasRunningHeavyTask(), false);

    // 移除故障後第三次重試成功，0 Worker
    setInMemoryIdbHooksForTests({});
    const out3 = await manager.retryFinalization(taskId);
    assert.equal(out3?.status, "completed");
    assert.equal(workerCalls, 1);
    assert.equal(coordinator.hasRunningHeavyTask(), false);
    const logs = getSeparationDiagnosticLogs();
    assert.ok(logs.some((entry) => entry.controllerSettled === true));
  } finally {
    setInMemoryIdbHooksForTests({});
    manager.dispose();
    leaseManager.close();
  }
});
