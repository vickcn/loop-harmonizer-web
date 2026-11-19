import assert from "node:assert/strict";
import test from "node:test";

import {
  INDEXEDDB_VERSION,
  SEPARATION_CHECKPOINT_HASH_INDEX,
  SEPARATION_CHUNK_TASK_INDEX,
  applyIndexedDbSchemaUpgrade,
  configureInMemoryIdbForTests,
  idbGet,
  idbPut,
  idbRequestPromise,
  resetInMemoryIdbForTests,
  withIdbTransaction,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_MODEL_VERSION,
  SEPARATION_PROCESSING_VERSION,
  createSeparationCacheKey,
} from "../lib/storage/cacheKeys.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  computeTotalChunks,
  getChunkRecord,
  getTaskChunkRecords,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  addCheckpointReference,
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  createCheckpointTaskId,
  createIsolatedRecomputeTaskId,
  deleteAllIncompleteCheckpoints,
  deleteCheckpointAndChunks,
  deleteIncompleteCheckpointsForSong,
  findCompletedCheckpointBySourceAudioHash,
  getCheckpoint,
  isCheckpointSharedOrLeased,
  releaseCheckpointReferenceAndMaybeGc,
  runCheckpointGarbageCollection,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  SeparationJobLeaseManager,
  validateAndPrepareResume,
} from "../lib/separation/separationResumeController.ts";
import {
  MAX_SEPARATION_DIAGNOSTIC_ENTRIES,
  SEPARATION_DIAGNOSTIC_STORAGE_KEY,
  clearSeparationDiagnosticLogs,
  deriveSeparationStateFromValidation,
  formatSeparationDiagnosticLine,
  getSeparationDiagnosticLogs,
  guardSeparationPatch,
  reconcileCrossTabSongUpdate,
  recordSeparationDiagnostic,
} from "../lib/separation/separationStateRecovery.ts";
import {
  createBandSong,
  createSeparationFocusSessionSnapshot,
  restoreSongsAfterSeparationFocus,
  serializePersistedSong,
} from "../lib/band/songModel.ts";

function createZeroChunkPayload(frameCount) {
  const mk = () => new Float32Array(frameCount);
  const packed = packChunkStemsToBuffer(
    {
      vocals: { left: mk(), right: mk() },
      drums: { left: mk(), right: mk() },
      bass: { left: mk(), right: mk() },
      other: { left: mk(), right: mk() },
    },
    frameCount,
  );
  // 確保至少有一個非零樣本以符合 PCM checksum / 振幅有效性檢查
  const f32 = new Float32Array(packed);
  if (f32.length > 0) f32[0] = 0.05;
  return packed;
}

async function seedCompletedChunks(params) {
  const { songId, sourceAudioHash, totalChunks = 3, ownerTabId = "tab-owner" } = params;
  const totalSamples = DEMUCS_STRIDE_SAMPLES * (totalChunks - 1) + 4096;
  const taskId = createCheckpointTaskId(songId, sourceAudioHash);
  const lease = {
    ownerTabId,
    ownerJobToken: "job-1",
    generation: 1,
    acquiredAt: 1000,
    leaseExpiresAt: 1000 + 20_000,
  };
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId,
      sourceAudioHash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      lease,
      now: 1000,
    }),
  );

  let latestCp = null;
  for (let i = 0; i < totalChunks; i++) {
    const startSample = i * DEMUCS_STRIDE_SAMPLES;
    const endSample = Math.min(totalSamples, startSample + DEMUCS_STRIDE_SAMPLES);
    const committed = await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: i,
      startSample,
      endSample,
      payload: createZeroChunkPayload(endSample - startSample),
      overlapCarryBuffer: null,
      expectedLease: lease,
      now: 1100 + i * 50,
    });
    latestCp = committed.checkpoint;
  }

  return { taskId, totalSamples, totalChunks, lease, checkpoint: latestCp };
}

test("1. React stale-generation & focus recovery never downgrade a completed song", () => {
  clearSeparationDiagnosticLogs();
  const completedSong = {
    ...createBandSong({
      id: "song-1",
      name: "Demo",
      fileName: "demo.mp3",
      durationSec: 180,
      sourceAudioId: "song-1_original",
    }),
    separationStatus: "completed",
    separationMode: "four_stem",
    separationProgress: 1,
    separationCompletedChunks: 40,
    separationTotalChunks: 40,
    separationCommittedBytes: 24_000_000,
    separationUsesChunkPlayback: true,
    separationMessage: "分段分離完成（WASM · Worker，共 40 段按需播放）",
    playbackSource: "stems",
    cacheKey: "cache-1",
  };

  // Stale generation update is ignored even on processing/interrupted patches
  const staleGenPatch = guardSeparationPatch(
    completedSong,
    { separationStatus: "interrupted", separationCompletedChunks: 0 },
    { generation: 1, activeGeneration: 2, source: "test-stale-gen" },
  );
  assert.equal(staleGenPatch, null);

  // Stale post-completion downgrade is blocked even without generation mismatch
  const staleDowngradePatch = guardSeparationPatch(
    completedSong,
    {
      separationStatus: "interrupted",
      separationCompletedChunks: 0,
      separationMessage: "背景中斷",
    },
    { source: "test-post-complete-downgrade" },
  );
  assert.equal(staleDowngradePatch, null);

  // Focus cleanup called with stale outcome ("cancelled" / "failed") cannot revert completed song
  const snapshot = createSeparationFocusSessionSnapshot([completedSong], "song-1", ["test"]);
  const afterCancel = restoreSongsAfterSeparationFocus([completedSong], snapshot, {
    outcome: "cancelled",
  });
  assert.equal(afterCancel[0].separationStatus, "completed");
  assert.equal(afterCancel[0].separationUsesChunkPlayback, true);
  assert.equal(afterCancel[0].separationCompletedChunks, 40);

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((entry) => entry.note?.includes("stale generation")));
  assert.ok(logs.some((entry) => entry.note?.includes("blocked downgrade from completed")));
});

test("2. Zero verified chunks (0/totalChunks) never claims saved progress or resumability", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 40;
  const taskId = createCheckpointTaskId("song-zero", "hash-zero");
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-zero",
      sourceAudioHash: "hash-zero",
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      now: 1000,
    }),
  );

  const validation = await validateAndPrepareResume(taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-zero",
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
  });
  assert.equal(validation.validChunkCount, 0);
  assert.equal(computeTotalChunks(totalSamples, DEMUCS_STRIDE_SAMPLES), validation.totalChunks);

  const statePatch = deriveSeparationStateFromValidation({ validation });
  assert.equal(statePatch.separationStatus, "interrupted");
  assert.equal(statePatch.separationCompletedChunks, 0);
  assert.equal(statePatch.separationCommittedBytes, 0);
  assert.equal(statePatch.separationProgress, 0);
  assert.equal(statePatch.separationUsesChunkPlayback, false);
  assert.ok(!statePatch.separationMessage.includes("可從最近完成段落接續"));
  assert.ok(!statePatch.separationMessage.includes("已保存 0.0"));
  assert.ok(statePatch.separationMessage.includes("尚無可接續的分段進度"));
});

test("3. IDB verified chunks repair stale interrupted checkpoint to completed & block lease/status downgrades", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const { taskId, totalSamples, totalChunks, lease } = await seedCompletedChunks({
    songId: "song-repair",
    sourceAudioHash: "hash-repair",
    totalChunks: 3,
    ownerTabId: "tab-A",
  });

  // 模擬異常情況：Checkpoint 被錯誤標記為 interrupted 且 nextChunkIndex 倒退，但 Chunks 全數已保存並通過驗證
  const cp = await getCheckpoint(taskId);
  assert.equal(cp.status, "completed");
  await saveCheckpoint({
    ...cp,
    status: "interrupted",
    nextChunkIndex: 0,
    committedEndSample: 0,
    committedBytes: 0,
  });

  // validateAndPrepareResume 在單一交易內讀取 Checkpoint 與 Chunks 並依權威 Chunks 修復為 completed
  const validation = await validateAndPrepareResume(taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-repair",
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
    viewerTabId: "tab-B",
  });
  assert.equal(validation.action, "already_completed");
  assert.equal(validation.validChunkCount, totalChunks);
  assert.equal(validation.checkpoint?.status, "completed");

  const derived = deriveSeparationStateFromValidation({
    validation,
    cacheKey: "cache-repair",
    backendLabel: "WASM · Worker",
  });
  assert.equal(derived.separationStatus, "completed");
  assert.equal(derived.separationUsesChunkPlayback, true);
  assert.equal(derived.separationCompletedChunks, totalChunks);

  // Completed checkpoint cannot be downgraded by stale updateCheckpointStatus or releaseLease
  const afterUpdate = await updateCheckpointStatus(taskId, {
    status: "interrupted",
    lastError: "stale disconnect",
  });
  assert.equal(afterUpdate?.status, "completed");

  const senderLeaseManager = new SeparationJobLeaseManager();
  const receiverLeaseManager = new SeparationJobLeaseManager();
  const broadcasts = [];
  const unsubscribe = receiverLeaseManager.onBroadcast((msg) => broadcasts.push(msg));
  try {
    // Even when final chunk cleared lease:null, releaseLease(..., "completed") still broadcasts task-completed cleanly
    // and releaseLease(..., "interrupted") never downgrades status
    const relInterrupted = await senderLeaseManager.releaseLease(taskId, lease, "interrupted");
    assert.equal(relInterrupted, false);
    assert.equal((await getCheckpoint(taskId))?.status, "completed");

    await senderLeaseManager.releaseLease(taskId, lease, "completed");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(broadcasts.some((msg) => msg.type === "task-completed" && msg.taskId === taskId));
  } finally {
    unsubscribe();
    senderLeaseManager.close();
    receiverLeaseManager.close();
  }
});

test("4. Cross-tab update & non-owner validation preserve active lease and prevent state regression", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const { taskId, totalSamples } = await seedCompletedChunks({
    songId: "song-tab",
    sourceAudioHash: "hash-tab",
    totalChunks: 2,
    ownerTabId: "tab-A",
  });

  // Test non-owner read-safety while an active lease is held on an incomplete task
  const incompleteTaskId = createCheckpointTaskId("song-active", "hash-active");
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId: incompleteTaskId,
      songId: "song-active",
      sourceAudioHash: "hash-active",
      requestedMode: "four_stem",
      totalSamples: DEMUCS_STRIDE_SAMPLES * 2,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      lease: {
        ownerTabId: "tab-A",
        ownerJobToken: "job-active",
        generation: 1,
        acquiredAt: 5000,
        leaseExpiresAt: 25_000,
      },
      now: 5000,
    }),
  );
  // Corrupt checkpoint count while foreign active lease exists: viewer Tab B must not mutate IDB
  const activeValidation = await validateAndPrepareResume(incompleteTaskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-active",
    totalSamples: DEMUCS_STRIDE_SAMPLES * 2,
    sampleRate: DEMUCS_SAMPLE_RATE,
    viewerTabId: "tab-B",
    now: 10_000,
  });
  assert.equal(activeValidation.validChunkCount, 0);
  assert.equal((await getCheckpoint(incompleteTaskId))?.status, "running");

  // Stale cross-tab song-updated ("interrupted 0/40") cannot downgrade Tab A ("completed")
  const localCompletedSong = {
    ...createBandSong({
      id: "song-tab",
      name: "Song Tab",
      fileName: "tab.mp3",
      durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
      sourceAudioId: "song-tab_original",
    }),
    sourceAudioHash: "hash-tab",
    separationTaskId: taskId,
    separationStatus: "completed",
    separationCompletedChunks: 2,
    separationTotalChunks: 2,
    separationUsesChunkPlayback: true,
    cacheKey: "cache-tab",
  };
  const blockedSync = reconcileCrossTabSongUpdate(localCompletedSong, {
    separationStatus: "interrupted",
    separationCompletedChunks: 0,
    separationTotalChunks: 2,
    separationTaskId: taskId,
  });
  assert.equal(blockedSync.blockedDowngrade, true);
  assert.equal(blockedSync.song.separationStatus, "completed");

  // Conversely, Tab B stuck at interrupted 0/2 receives completed status or IDB verification -> upgrades & triggers Chunk Playback restore
  const localStaleSong = {
    ...localCompletedSong,
    separationStatus: "interrupted",
    separationCompletedChunks: 0,
    separationUsesChunkPlayback: false,
    cacheKey: null,
  };
  const upgradedSync = reconcileCrossTabSongUpdate(
    localStaleSong,
    {
      separationStatus: "completed",
      separationCompletedChunks: 2,
      separationTotalChunks: 2,
      separationTaskId: taskId,
      cacheKey: "cache-tab",
    },
    { verifiedCompletedCheckpoint: true, verifiedValidChunkCount: 2 },
  );
  assert.equal(upgradedSync.song.separationStatus, "completed");
  assert.equal(upgradedSync.needsChunkPlaybackRestore, true);
});

test("5. Cold-start hash recovery & clear distinction between '清理暫存' vs '刪除已完成分軌'", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  // Seed one completed task for sourceAudioHash = "hash-shared"
  const completed = await seedCompletedChunks({
    songId: "song-original-id",
    sourceAudioHash: "hash-shared",
    totalChunks: 3,
  });

  // Seed one incomplete temp task for same hash (or orphaned temp task) under a different songId
  const tempTaskId = createCheckpointTaskId("song-reimported-id", "hash-shared");
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId: tempTaskId,
      songId: "song-reimported-id",
      sourceAudioHash: "hash-shared",
      requestedMode: "four_stem",
      totalSamples: DEMUCS_STRIDE_SAMPLES * 5,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      now: 9000,
    }),
  );

  // Cold-start lookup by sourceAudioHash prioritizes completed checkpoint over incomplete temp checkpoint
  const foundCompleted = await findCompletedCheckpointBySourceAudioHash("hash-shared");
  assert.equal(foundCompleted?.taskId, completed.taskId);
  assert.equal(foundCompleted?.status, "completed");

  // "清理暫存" (deleteIncompleteCheckpointsForSong / deleteAllIncompleteCheckpoints) removes temp only, never completed chunks
  const tempDeleted = await deleteIncompleteCheckpointsForSong({
    sourceAudioHash: "hash-shared",
  });
  assert.equal(tempDeleted.deletedCheckpoints, 1);
  assert.deepEqual(tempDeleted.preservedCompletedTaskIds, [completed.taskId]);
  assert.equal(await getCheckpoint(tempTaskId), null);
  assert.equal((await getCheckpoint(completed.taskId))?.status, "completed");
  assert.equal((await getTaskChunkRecords(completed.taskId)).length, 3);

  const globalTempDeleted = await deleteAllIncompleteCheckpoints();
  assert.equal(globalTempDeleted.preservedCompletedCount, 1);
  assert.equal((await getTaskChunkRecords(completed.taskId)).length, 3);

  // "刪除已完成分軌" explicitly removes completed checkpoint & chunks
  const explicitDelete = await deleteCheckpointAndChunks(completed.taskId);
  assert.equal(explicitDelete.deletedCheckpoint, true);
  assert.equal(explicitDelete.deletedChunks, 3);
  assert.equal(await getCheckpoint(completed.taskId), null);
});

test("6. Local circular diagnostic buffer caps entries, persists JSON to localStorage only, and formats all required fields", () => {
  const backing = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => {
      backing.set(k, String(v));
    },
    removeItem: (k) => {
      backing.delete(k);
    },
  };

  try {
    clearSeparationDiagnosticLogs();
    for (let i = 0; i < MAX_SEPARATION_DIAGNOSTIC_ENTRIES + 15; i++) {
      recordSeparationDiagnostic({
        source: "spec.circular",
        taskId: `task-${i}`,
        generation: i,
        checkpointStatus: "running",
        validChunkCount: i,
        totalChunks: 40,
        workerExitReason: i % 2 === 0 ? "completed" : "paused",
        leaseOwner: "tab-local",
        fromState: "processing",
        toState: i % 2 === 0 ? "completed" : "paused",
      });
    }

    const logs = getSeparationDiagnosticLogs();
    assert.equal(logs.length, MAX_SEPARATION_DIAGNOSTIC_ENTRIES);
    assert.equal(logs[0].taskId, "task-15");
    const last = logs[logs.length - 1];
    const formatted = formatSeparationDiagnosticLine(last);
    assert.ok(formatted.includes("task="));
    assert.ok(formatted.includes("gen="));
    assert.ok(formatted.includes("cp="));
    assert.ok(formatted.includes("chunks="));
    assert.ok(formatted.includes("exit="));
    assert.ok(formatted.includes("lease="));
    assert.ok(formatted.includes("tx="));

    const persistedRaw = backing.get(SEPARATION_DIAGNOSTIC_STORAGE_KEY);
    assert.ok(persistedRaw);
    const parsed = JSON.parse(persistedRaw);
    assert.equal(parsed.length, MAX_SEPARATION_DIAGNOSTIC_ENTRIES);
  } finally {
    clearSeparationDiagnosticLogs();
    globalThis.localStorage = prevStorage;
  }
});

async function seedSongAndFastCache(params) {
  const {
    id,
    sourceAudioHash,
    separationMode = "four_stem",
    separationStatus = "completed",
    separationTaskId,
    totalChunks = 3,
    cacheKey = null,
    seedFastCache = false,
  } = params;

  const song = {
    ...createBandSong({
      id,
      name: `Song ${id}`,
      fileName: `${id}.mp3`,
      durationSec: 30,
      sourceAudioId: `${id}_original`,
    }),
    sourceAudioHash,
    separationMode,
    separationStatus,
    separationTaskId,
    separationCompletedChunks: separationStatus === "completed" ? totalChunks : 0,
    separationTotalChunks: totalChunks,
    separationUsesChunkPlayback: separationStatus === "completed",
    cacheKey,
  };

  await idbPut(
    "songs",
    serializePersistedSong(song, {
      audioKey: sourceAudioHash,
      sourceAudioHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      revision: 1,
      updatedAt: Date.now(),
      updatedByTabId: "tab-test",
    }),
  );

  if (seedFastCache && cacheKey) {
    await idbPut("separations", {
      key: cacheKey,
      sourceAudioHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      mode: separationMode,
      sizeBytes: 1024,
      createdAt: Date.now(),
    });
  }

  return song;
}

test("7. Two different songIds with same sourceAudioHash: deleting one preserves complete chunks for the other without full binary scan", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const seeded = await seedCompletedChunks({
    songId: "song-alpha",
    sourceAudioHash: "hash-dup-song",
    totalChunks: 4,
  });
  await seedSongAndFastCache({
    id: "song-alpha",
    sourceAudioHash: "hash-dup-song",
    separationTaskId: seeded.taskId,
    totalChunks: 4,
  });
  await seedSongAndFastCache({
    id: "song-beta",
    sourceAudioHash: "hash-dup-song",
    separationTaskId: null, // 模擬僅以 hash / cold-start 配對完成分軌的另一首歌曲
    totalChunks: 4,
  });

  // 安裝 beforeRead hook：確認檢查引用與釋放過程中絕不掃描 separationChunks 二進位 getAll/get
  configureInMemoryIdbForTests({
    beforeRead: (storeName, op) => {
      if (storeName === "separationChunks" && (op === "getAll" || op === "get")) {
        throw new Error(`禁止掃描完整二進位 Chunk 資料：${op}`);
      }
    },
  });

  // 移除 song-alpha 的持久歌曲狀態後解除引用
  await idbPut("songs", {
    ...(await idbGet("songs", "song-alpha")),
    separationStatus: "not_started",
    separationTaskId: null,
  });

  const rel = await releaseCheckpointReferenceAndMaybeGc({
    taskId: seeded.taskId,
    sourceAudioHash: "hash-dup-song",
    songId: "song-alpha",
  });
  assert.deepEqual(rel.preservedTaskIds, [seeded.taskId]);
  assert.deepEqual(rel.deletedTaskIds, []);
  assert.equal(rel.deletedChunks, 0);
  assert.ok(rel.remainingReferences >= 1);

  // 停用 guard 後驗證 song-beta 仍可逐段讀取完整 Chunk
  configureInMemoryIdbForTests();
  const cpAfter = await getCheckpoint(seeded.taskId);
  assert.equal(cpAfter?.status, "completed");
  for (let i = 0; i < 4; i++) {
    const rec = await getChunkRecord(seeded.taskId, i);
    assert.ok(rec, `song-beta should still read chunk ${i}`);
  }

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((e) => e.event === "shared-checkpoint-reference-removed"));
  assert.ok(logs.some((e) => e.event === "checkpoint-delete-blocked"));
});

test("8. Two songs sharing the same taskId: deleting one keeps checkpoint and increments/decrements ref counts cleanly", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const seeded = await seedCompletedChunks({
    songId: "song-1",
    sourceAudioHash: "hash-shared-task",
    totalChunks: 3,
  });
  const afterAdd = await addCheckpointReference({
    taskId: seeded.taskId,
    songId: "song-2",
    mode: "four_stem",
  });
  assert.deepEqual(new Set(afterAdd?.referencedBySongIds), new Set(["song-1", "song-2"]));

  const song1 = await seedSongAndFastCache({
    id: "song-1",
    sourceAudioHash: "hash-shared-task",
    separationTaskId: seeded.taskId,
    totalChunks: 3,
  });
  const song2 = await seedSongAndFastCache({
    id: "song-2",
    sourceAudioHash: "hash-shared-task",
    separationTaskId: seeded.taskId,
    totalChunks: 3,
  });

  // 模擬「刪除已完成分軌」先解除 song-1 自身狀態
  const clearedSong1 = { ...song1, separationStatus: "not_started", separationTaskId: null };
  await idbPut(
    "songs",
    serializePersistedSong(clearedSong1, {
      audioKey: "hash-shared-task",
      sourceAudioHash: "hash-shared-task",
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      revision: 2,
      updatedAt: Date.now(),
      updatedByTabId: "tab-B",
    }),
  );

  const rel1 = await releaseCheckpointReferenceAndMaybeGc({
    taskId: seeded.taskId,
    sourceAudioHash: "hash-shared-task",
    songId: "song-1",
    knownInMemorySongs: [clearedSong1, song2],
  });
  assert.deepEqual(rel1.preservedTaskIds, [seeded.taskId]);
  assert.deepEqual(rel1.deletedTaskIds, []);

  const cpAfter = await getCheckpoint(seeded.taskId);
  assert.ok(cpAfter);
  assert.deepEqual(cpAfter.referencedBySongIds, ["song-2"]);
  assert.equal((await getTaskChunkRecords(seeded.taskId)).length, 3);

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((e) => e.event === "shared-checkpoint-reference-added"));
  assert.ok(logs.some((e) => e.event === "shared-checkpoint-reference-removed"));
  assert.ok(logs.some((e) => e.event === "checkpoint-delete-blocked"));
});

test("9. Releasing last reference cleanly GC checkpoint & chunks and sweeps orphan chunks with zero orphan residue", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const seeded = await seedCompletedChunks({
    songId: "song-sole",
    sourceAudioHash: "hash-gc",
    totalChunks: 3,
  });
  const songSole = await seedSongAndFastCache({
    id: "song-sole",
    sourceAudioHash: "hash-gc",
    separationTaskId: seeded.taskId,
    totalChunks: 3,
  });

  // 額外植入無主孤兒 Chunk（對應不存在 Checkpoint 的 taskId）
  await idbPut("separationChunks", {
    key: "sep:orphan:hash-orphan:chunk:0",
    taskId: "sep:orphan:hash-orphan",
    chunkIndex: 0,
    startSample: 0,
    endSample: 4096,
    modelVersion: DEMUCS_MODEL_VERSION,
    processingVersion: SEPARATION_PROCESSING_VERSION,
    separationMode: "four_stem",
    sampleRate: DEMUCS_SAMPLE_RATE,
    stemCount: 4,
    payload: createZeroChunkPayload(4096),
    checksum: 123,
    sizeBytes: 4096 * 8 * 4,
    createdAt: Date.now(),
  });

  // 禁止 GC 與解除引用階段觸發 chunkStore.getAll / chunkStore.get
  configureInMemoryIdbForTests({
    beforeRead: (storeName, op) => {
      if (storeName === "separationChunks" && (op === "getAll" || op === "get")) {
        throw new Error(`GC 不應掃描完整 Chunk payload：${op}`);
      }
    },
  });

  // 解除最後一首歌曲引用
  await withIdbTransaction("songs", "readwrite", async (tx) => {
    await idbRequestPromise(tx.objectStore("songs").delete(songSole.id));
  });
  const rel = await releaseCheckpointReferenceAndMaybeGc({
    taskId: seeded.taskId,
    songId: songSole.id,
    knownInMemorySongs: [],
  });
  assert.deepEqual(rel.deletedTaskIds, [seeded.taskId]);
  assert.equal(rel.deletedChunks, 3);
  assert.equal(rel.remainingReferences, 0);

  // 透過 key cursor 回收無主孤兒 Chunk
  const gcRes = await runCheckpointGarbageCollection({ knownInMemorySongs: [] });
  assert.equal(gcRes.deletedOrphanChunkTasks, 1);
  assert.equal(gcRes.deletedChunks, 1);

  configureInMemoryIdbForTests();
  assert.equal(await getCheckpoint(seeded.taskId), null);
  assert.equal((await getTaskChunkRecords(seeded.taskId)).length, 0);
  assert.equal((await getTaskChunkRecords("sep:orphan:hash-orphan")).length, 0);

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((e) => e.event === "checkpoint-gc-started"));
  assert.ok(logs.some((e) => e.event === "checkpoint-gc-completed"));
});

test("10. Active unexpired lease strictly blocks chunk/checkpoint deletion across GC and temp cleanup", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
  const taskId = createCheckpointTaskId("song-leased", "hash-leased");
  const lease = {
    ownerTabId: "tab-worker-1",
    ownerJobToken: "job-lease",
    generation: 2,
    acquiredAt: 10_000,
    leaseExpiresAt: 50_000,
  };
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-leased",
      sourceAudioHash: "hash-leased",
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      lease,
      now: 10_000,
    }),
  );
  await commitChunkAndCheckpointAtomically({
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: createZeroChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    expectedLease: lease,
    now: 12_000,
  });

  // 即使無 songs 引用，只要 Lease 未過期（now = 20_000 < 50_000），任何 GC 或暫存清理都不准刪除底層資料
  const relBlocked = await releaseCheckpointReferenceAndMaybeGc({
    taskId,
    songId: "song-leased",
    now: 20_000,
  });
  assert.deepEqual(relBlocked.blockedByLeaseTaskIds, [taskId]);
  assert.equal(relBlocked.deletedChunks, 0);

  const gcBlocked = await runCheckpointGarbageCollection({ now: 20_000 });
  assert.deepEqual(gcBlocked.blockedByLeaseTaskIds, [taskId]);

  const tempBlocked = await deleteAllIncompleteCheckpoints({ now: 20_000 });
  assert.deepEqual(tempBlocked.blockedByLeaseTaskIds, [taskId]);
  assert.equal((await getTaskChunkRecords(taskId)).length, 1);

  // 當 Lease 過期（now = 60_000 > 50_000）且無引用時，才允許回收
  const gcAllowed = await runCheckpointGarbageCollection({ now: 60_000 });
  assert.equal(gcAllowed.deletedCheckpoints, 1);
  assert.equal(gcAllowed.deletedChunks, 1);
  assert.equal(await getCheckpoint(taskId), null);

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((e) => e.event === "checkpoint-delete-blocked" && e.leaseState === "active"));
});

test("11. Deleting 4 Stem mode separation preserves shared chunks and 2 Stem mode playback/cache", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const hash = "hash-4v2";
  const fourKey = createSeparationCacheKey({
    sourceAudioHash: hash,
    modelVersion: DEMUCS_MODEL_VERSION,
    separationMode: "four_stem",
  });
  const twoKey = createSeparationCacheKey({
    sourceAudioHash: hash,
    modelVersion: DEMUCS_MODEL_VERSION,
    separationMode: "two_stem",
  });

  const seeded = await seedCompletedChunks({
    songId: "song-4stem",
    sourceAudioHash: hash,
    totalChunks: 3,
  });
  await addCheckpointReference({ taskId: seeded.taskId, songId: "song-2stem", mode: "two_stem" });

  const song4 = await seedSongAndFastCache({
    id: "song-4stem",
    sourceAudioHash: hash,
    separationMode: "four_stem",
    separationTaskId: seeded.taskId,
    cacheKey: fourKey,
    seedFastCache: true,
    totalChunks: 3,
  });
  const song2 = await seedSongAndFastCache({
    id: "song-2stem",
    sourceAudioHash: hash,
    separationMode: "two_stem",
    separationTaskId: seeded.taskId,
    cacheKey: twoKey,
    seedFastCache: true,
    totalChunks: 3,
  });

  const cleared4 = {
    ...song4,
    separationStatus: "not_started",
    separationTaskId: null,
    cacheKey: null,
  };
  await idbPut(
    "songs",
    serializePersistedSong(cleared4, {
      audioKey: hash,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      revision: 2,
      updatedAt: Date.now(),
      updatedByTabId: "tab-test",
    }),
  );

  const rel = await releaseCheckpointReferenceAndMaybeGc({
    taskId: seeded.taskId,
    sourceAudioHash: hash,
    songId: "song-4stem",
    cacheKeyToRelease: fourKey,
    knownInMemorySongs: [cleared4, song2],
  });

  assert.deepEqual(rel.preservedTaskIds, [seeded.taskId]);
  assert.equal(rel.deletedChunks, 0);
  // 僅允許移除已無引用的 4 Stem fast cache，絕不可誤刪 2 Stem fast cache 與共用 Chunks
  assert.equal(await idbGet("separations", fourKey), null);
  assert.ok(await idbGet("separations", twoKey));
  assert.equal((await getTaskChunkRecords(seeded.taskId)).length, 3);
  assert.equal((await getCheckpoint(seeded.taskId))?.status, "completed");
});

test("12. Post-completion stale worker interrupted 0/40 events never downgrade UI or IDB, and explicit delete stays cleanly not_started", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const seeded = await seedCompletedChunks({
    songId: "song-40",
    sourceAudioHash: "hash-40",
    totalChunks: 4, // seed 4 chunks simulating full completion
  });

  // 模擬已完成 Checkpoint（將 totalChunks 等效測試）
  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: seeded.taskId,
        chunkIndex: 0,
        startSample: 0,
        endSample: DEMUCS_STRIDE_SAMPLES,
        payload: createZeroChunkPayload(DEMUCS_STRIDE_SAMPLES),
        overlapCarryBuffer: null,
        expectedLease: seeded.lease,
      }),
    /已完成|拒絕/,
  );

  const afterStatus = await updateCheckpointStatus(seeded.taskId, {
    status: "interrupted",
    lastError: "stale worker exit 0/40",
  });
  assert.equal(afterStatus?.status, "completed");

  const completedSong = {
    ...createBandSong({
      id: "song-40",
      name: "Song 40",
      fileName: "40.mp3",
      durationSec: 120,
      sourceAudioId: "song-40_original",
    }),
    separationTaskId: seeded.taskId,
    separationStatus: "completed",
    separationCompletedChunks: 40,
    separationTotalChunks: 40,
    separationUsesChunkPlayback: true,
    cacheKey: "cache-40",
  };
  assert.equal(
    guardSeparationPatch(
      completedSong,
      { separationStatus: "interrupted", separationCompletedChunks: 0, separationTotalChunks: 40 },
      { source: "worker.exit", workerExitReason: "terminated" },
    ),
    null,
  );

  // 明確允許刪除轉回 not_started（帶 allowResetCompleted: true）
  const allowedClear = guardSeparationPatch(
    completedSong,
    {
      separationStatus: "not_started",
      separationTaskId: null,
      separationCompletedChunks: 0,
      separationUsesChunkPlayback: false,
      cacheKey: null,
    },
    { allowResetCompleted: true, source: "user.clear" },
  );
  assert.equal(allowedClear?.separationStatus, "not_started");
  const clearedSong = { ...completedSong, ...allowedClear };

  // 清除成為 not_started 後，舊分頁/過期事件仍傳來 interrupted 0/40 且無權威 checkpoint 時必須拒絕倒退成錯誤狀態
  const staleCrossTabAfterDelete = reconcileCrossTabSongUpdate(
    clearedSong,
    {
      separationStatus: "interrupted",
      separationCompletedChunks: 0,
      separationTotalChunks: 40,
      separationTaskId: seeded.taskId,
    },
    { hasAuthoritativeCheckpoint: false },
  );
  assert.equal(staleCrossTabAfterDelete.blockedDowngrade, true);
  assert.equal(staleCrossTabAfterDelete.song.separationStatus, "not_started");

  const logs = getSeparationDiagnosticLogs();
  assert.ok(logs.some((e) => e.event === "stale-worker-update-rejected"));
});

test("13. Cold-start refresh validates local IDB & restores chunked playback without recomputing; v3->v4 upgrade keeps data & adds indexes", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  // 驗證 v3 -> v4 非破壞性 IndexedDB schema 升級：不刪除既有 store，僅補建索引
  const existingStores = new Map();
  const createdIndexes = [];
  for (const name of [
    "separations",
    "settings",
    "modelMeta",
    "audioFiles",
    "songs",
    "sessionMeta",
    "separationCheckpoints",
    "separationChunks",
  ]) {
    existingStores.set(name, new Set());
  }
  const fakeUpgradeDb = {
    objectStoreNames: { contains: (n) => existingStores.has(n) },
    createObjectStore: (n) => {
      throw new Error(`不應重建既有資料表：${n}`);
    },
  };
  const fakeUpgradeTx = {
    objectStore: (n) => ({
      indexNames: { contains: (idx) => existingStores.get(n).has(idx) },
      createIndex: (idx, keyPath) => {
        existingStores.get(n).add(idx);
        createdIndexes.push({ store: n, idx, keyPath });
      },
    }),
  };
  applyIndexedDbSchemaUpgrade(fakeUpgradeDb, fakeUpgradeTx);
  assert.equal(INDEXEDDB_VERSION, 4);
  assert.ok(
    createdIndexes.some(
      (x) => x.store === "separationCheckpoints" && x.idx === SEPARATION_CHECKPOINT_HASH_INDEX,
    ),
  );
  assert.ok(
    createdIndexes.some(
      (x) => x.store === "separationChunks" && x.idx === SEPARATION_CHUNK_TASK_INDEX,
    ),
  );

  // 冷啟動恢復測試：即使 UI 狀態曾錯為 interrupted 0/3，重新整理先驗證本機 IDB 後直接恢復 Chunk Playback
  const { taskId, totalSamples, totalChunks } = await seedCompletedChunks({
    songId: "song-cold",
    sourceAudioHash: "hash-cold",
    totalChunks: 3,
  });
  const cpByHash = await findCompletedCheckpointBySourceAudioHash("hash-cold");
  assert.equal(cpByHash?.taskId, taskId);

  const validation = await validateAndPrepareResume(taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-cold",
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
  });
  assert.equal(validation.action, "already_completed");
  assert.equal(validation.validChunkCount, totalChunks);

  const restored = deriveSeparationStateFromValidation({
    validation,
    cacheKey: createSeparationCacheKey({
      sourceAudioHash: "hash-cold",
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
    }),
    backendLabel: "WASM · Worker",
  });
  assert.equal(restored.separationStatus, "completed");
  assert.equal(restored.separationUsesChunkPlayback, true);
  assert.equal(restored.separationCompletedChunks, totalChunks);
  assert.ok(restored.separationMessage.includes("按需播放"));
});

test("14. Partial chunks interrupted resumes accurately from next valid chunk without re-running valid prefix", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const totalChunks = 5;
  const totalSamples = DEMUCS_STRIDE_SAMPLES * (totalChunks - 1) + 4096;
  const taskId = createCheckpointTaskId("song-partial", "hash-partial");
  const lease = {
    ownerTabId: "tab-partial",
    ownerJobToken: "job-partial",
    generation: 1,
    acquiredAt: 1000,
    leaseExpiresAt: 20_000,
  };
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-partial",
      sourceAudioHash: "hash-partial",
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      lease,
      now: 1000,
    }),
  );

  // 完成 0, 1, 2 三段後中斷
  for (let i = 0; i < 3; i++) {
    const startSample = i * DEMUCS_STRIDE_SAMPLES;
    const endSample = startSample + DEMUCS_STRIDE_SAMPLES;
    await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: i,
      startSample,
      endSample,
      payload: createZeroChunkPayload(endSample - startSample),
      overlapCarryBuffer: null,
      expectedLease: lease,
      now: 1100 + i * 50,
    });
  }
  await updateCheckpointStatus(taskId, {
    status: "interrupted",
    clearLeaseIfTerminal: false,
  });
  // 同時模擬第 4 段（缺洞）或損毀資料存在，驗證自動修補只刪除缺洞後段並保留 0..2
  await idbPut("separationChunks", {
    key: `${taskId}:chunk:4`,
    taskId,
    chunkIndex: 4,
    startSample: 4 * DEMUCS_STRIDE_SAMPLES,
    endSample: totalSamples,
    modelVersion: DEMUCS_MODEL_VERSION,
    processingVersion: SEPARATION_PROCESSING_VERSION,
    separationMode: "four_stem",
    sampleRate: DEMUCS_SAMPLE_RATE,
    stemCount: 4,
    payload: createZeroChunkPayload(totalSamples - 4 * DEMUCS_STRIDE_SAMPLES),
    checksum: 9999,
    sizeBytes: (totalSamples - 4 * DEMUCS_STRIDE_SAMPLES) * 8 * 4,
    createdAt: 2000,
  });

  const validation = await validateAndPrepareResume(taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-partial",
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
    viewerTabId: "tab-partial",
    now: 25_000,
  });
  assert.equal(validation.action, "resume");
  assert.equal(validation.validChunkCount, 3);
  assert.equal(validation.resumeFromChunkIndex, 3);
  assert.equal(validation.repairedChunksDeleted, 1);

  const derived = deriveSeparationStateFromValidation({ validation });
  assert.equal(derived.separationStatus, "interrupted");
  assert.equal(derived.separationCompletedChunks, 3);
  assert.equal(derived.separationTotalChunks, totalChunks);
  assert.ok(derived.separationMessage.includes("已保存第 3/5 段"));
});

test("15. Force recompute isolation: failure during recompute preserves shared completed stems for other songs", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const shared = await seedCompletedChunks({
    songId: "song-host",
    sourceAudioHash: "hash-recompute-share",
    totalChunks: 3,
  });
  await addCheckpointReference({
    taskId: shared.taskId,
    songId: "song-guest",
    mode: "four_stem",
  });
  const hostSong = await seedSongAndFastCache({
    id: "song-host",
    sourceAudioHash: "hash-recompute-share",
    separationTaskId: shared.taskId,
    totalChunks: 3,
  });
  const guestSong = await seedSongAndFastCache({
    id: "song-guest",
    sourceAudioHash: "hash-recompute-share",
    separationTaskId: shared.taskId,
    totalChunks: 3,
  });

  // song-host 要求重新分離：應檢查 shared 狀態並切換至隔離 taskId，不得刪除 shared.taskId
  const shareStatus = await isCheckpointSharedOrLeased({
    taskId: shared.taskId,
    actingSongId: "song-host",
    knownInMemorySongs: [hostSong, guestSong],
  });
  assert.equal(shareStatus.sharedWithOtherSongs, true);

  const isolatedTaskId = createIsolatedRecomputeTaskId(
    "song-host",
    "hash-recompute-share",
    "failrun",
  );
  assert.notEqual(isolatedTaskId, shared.taskId);

  const isolatedTotalSamples = DEMUCS_STRIDE_SAMPLES * 2 + 4096;
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId: isolatedTaskId,
      songId: "song-host",
      sourceAudioHash: "hash-recompute-share",
      requestedMode: "four_stem",
      totalSamples: isolatedTotalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      now: 5000,
    }),
  );
  // 模擬重新分離寫入第 0 段後失敗，並清理此失敗暫存
  await commitChunkAndCheckpointAtomically({
    taskId: isolatedTaskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: createZeroChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    now: 5100,
  });
  await updateCheckpointStatus(isolatedTaskId, {
    status: "failed",
    lastError: "WebGPU OOM",
  });
  await deleteCheckpointAndChunks(isolatedTaskId);

  // song-guest 共用的完整 Checkpoint 與全 3 段 Chunk 必須完全不受影響
  const sharedCp = await getCheckpoint(shared.taskId);
  assert.equal(sharedCp?.status, "completed");
  assert.equal((await getTaskChunkRecords(shared.taskId)).length, 3);
  const guestValidation = await validateAndPrepareResume(shared.taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: "hash-recompute-share",
    totalSamples: shared.totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
  });
  assert.equal(guestValidation.action, "already_completed");
  assert.equal(guestValidation.validChunkCount, 3);
});

test("16. Clear temp, delete completed stems, and isolated force recompute maintain strict semantic boundaries", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();
  clearSeparationDiagnosticLogs();

  const hash = "hash-three-ops";
  // 1) 完成任務 A（由 song-main 與 song-peer 共用）
  const completed = await seedCompletedChunks({
    songId: "song-main",
    sourceAudioHash: hash,
    totalChunks: 3,
  });
  await addCheckpointReference({
    taskId: completed.taskId,
    songId: "song-peer",
    mode: "four_stem",
  });
  const songMain = await seedSongAndFastCache({
    id: "song-main",
    sourceAudioHash: hash,
    separationTaskId: completed.taskId,
    totalChunks: 3,
  });
  const songPeer = await seedSongAndFastCache({
    id: "song-peer",
    sourceAudioHash: hash,
    separationTaskId: completed.taskId,
    totalChunks: 3,
  });

  // 2) 建立一個未完成暫存任務 B（同一 hash，中斷於第 1 段）
  const tempTaskId = createIsolatedRecomputeTaskId("song-main", hash, "temp1");
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId: tempTaskId,
      songId: "song-main",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples: DEMUCS_STRIDE_SAMPLES * 3,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "interrupted",
      now: 2000,
    }),
  );
  await commitChunkAndCheckpointAtomically({
    taskId: tempTaskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: createZeroChunkPayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    now: 2100,
  });

  // Operation A: 清理暫存 -> 僅清除 tempTaskId，保留 completed.taskId
  const tempRes = await deleteIncompleteCheckpointsForSong({
    songId: "song-main",
    sourceAudioHash: hash,
    knownInMemorySongs: [songMain, songPeer],
  });
  assert.equal(tempRes.deletedCheckpoints, 1);
  assert.equal(tempRes.deletedChunks, 1);
  assert.equal(await getCheckpoint(tempTaskId), null);
  assert.equal((await getCheckpoint(completed.taskId))?.status, "completed");
  assert.equal((await getTaskChunkRecords(completed.taskId)).length, 3);

  // Operation C: song-main 重新分離至新隔離 taskId，並於成功後安全切換並解除對舊任務引用
  const recomputeTaskId = createIsolatedRecomputeTaskId("song-main", hash, "recomp");
  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2 + 4096;
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId: recomputeTaskId,
      songId: "song-main",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      now: 3000,
    }),
  );
  for (let i = 0; i < 3; i++) {
    const startSample = i * DEMUCS_STRIDE_SAMPLES;
    const endSample = Math.min(totalSamples, startSample + DEMUCS_STRIDE_SAMPLES);
    await commitChunkAndCheckpointAtomically({
      taskId: recomputeTaskId,
      chunkIndex: i,
      startSample,
      endSample,
      payload: createZeroChunkPayload(endSample - startSample),
      overlapCarryBuffer: null,
      now: 3100 + i * 50,
    });
  }
  const updatedMain = { ...songMain, separationTaskId: recomputeTaskId };
  await idbPut(
    "songs",
    serializePersistedSong(updatedMain, {
      audioKey: hash,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      revision: 2,
      updatedAt: 3500,
      updatedByTabId: "tab-1",
    }),
  );

  // Operation B: song-main 解除舊 task 引用時，因 song-peer 仍引用 completed.taskId，底層仍完整保留；
  // 而 song-main 刪除自己新的 recomputeTaskId 時因無其他引用，應徹底清除無殘留。
  const releaseOld = await releaseCheckpointReferenceAndMaybeGc({
    taskId: completed.taskId,
    songId: "song-main",
    knownInMemorySongs: [updatedMain, songPeer],
  });
  assert.deepEqual(releaseOld.preservedTaskIds, [completed.taskId]);
  assert.equal((await getTaskChunkRecords(completed.taskId)).length, 3);

  const clearedMain = { ...updatedMain, separationStatus: "not_started", separationTaskId: null };
  await idbPut(
    "songs",
    serializePersistedSong(clearedMain, {
      audioKey: hash,
      sourceAudioHash: hash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      revision: 3,
      updatedAt: 3600,
      updatedByTabId: "tab-1",
    }),
  );
  const deleteRecomp = await releaseCheckpointReferenceAndMaybeGc({
    taskId: recomputeTaskId,
    songId: "song-main",
    knownInMemorySongs: [clearedMain, songPeer],
  });
  assert.deepEqual(deleteRecomp.deletedTaskIds, [recomputeTaskId]);
  assert.equal(deleteRecomp.deletedChunks, 3);
  assert.equal(await getCheckpoint(recomputeTaskId), null);
  assert.equal((await getCheckpoint(completed.taskId))?.status, "completed");
});

test("17. completed checkpoint with missing chunks auto-repairs to interrupted and allows acquireLease", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalChunks = 4;
  const totalSamples = DEMUCS_STRIDE_SAMPLES * (totalChunks - 1) + 4096;
  const hash = "hash-incomplete-completed";
  const taskId = createCheckpointTaskId("song-broken-cp", hash);

  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-broken-cp",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "completed",
      userAuthorized: true,
      now: 1000,
    }),
  );

  // Checkpoint 為 completed 但 IndexedDB 實際為 0 段（模擬舊版 Worker 誤標 completed）
  const leaseMgr = new SeparationJobLeaseManager();
  try {
    const directAcquire = await leaseMgr.acquireLease(taskId, "tab-recovery", 12_000, 1100);
    assert.equal(directAcquire.acquired, true);

    await leaseMgr.releaseLease(taskId, directAcquire.lease, "interrupted", 1200);
    await saveCheckpoint({
      ...(await getCheckpoint(taskId)),
      status: "completed",
      nextChunkIndex: 0,
      committedEndSample: 0,
      committedBytes: 0,
      lease: null,
    });

    const validation = await validateAndPrepareResume(taskId, {
      sourceAudioAvailable: true,
      sourceAudioHash: hash,
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      viewerTabId: "tab-recovery",
      now: 1300,
    });
    assert.equal(validation.action, "resume");
    assert.equal(validation.validChunkCount, 0);
    assert.equal(validation.checkpoint?.status, "interrupted");

    const repairedCp = await getCheckpoint(taskId);
    assert.equal(repairedCp?.status, "interrupted");

    const postRepairAcquire = await leaseMgr.acquireLease(taskId, "tab-recovery", 12_000, 1400);
    assert.equal(postRepairAcquire.acquired, true);
  } finally {
    leaseMgr.close();
  }
});

test("18. silent intro/outro chunk payload with valid checksum is preserved during resume validation", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalChunks = 2;
  const totalSamples = DEMUCS_STRIDE_SAMPLES + 4096;
  const hash = "hash-silent-intro";
  const taskId = createCheckpointTaskId("song-silent-intro", hash);
  await saveCheckpoint(
    buildInitialCheckpoint({
      taskId,
      songId: "song-silent-intro",
      sourceAudioHash: hash,
      requestedMode: "four_stem",
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "running",
      userAuthorized: true,
      now: 1000,
    }),
  );

  const mk = (len) => new Float32Array(len);
  const silentIntroPayload = packChunkStemsToBuffer(
    {
      vocals: { left: mk(DEMUCS_STRIDE_SAMPLES), right: mk(DEMUCS_STRIDE_SAMPLES) },
      drums: { left: mk(DEMUCS_STRIDE_SAMPLES), right: mk(DEMUCS_STRIDE_SAMPLES) },
      bass: { left: mk(DEMUCS_STRIDE_SAMPLES), right: mk(DEMUCS_STRIDE_SAMPLES) },
      other: { left: mk(DEMUCS_STRIDE_SAMPLES), right: mk(DEMUCS_STRIDE_SAMPLES) },
    },
    DEMUCS_STRIDE_SAMPLES,
  );
  await commitChunkAndCheckpointAtomically({
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: silentIntroPayload,
    overlapCarryBuffer: null,
    now: 1100,
  });

  const validation = await validateAndPrepareResume(taskId, {
    sourceAudioAvailable: true,
    sourceAudioHash: hash,
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
    viewerTabId: "tab-1",
    now: 1200,
  });
  assert.equal(validation.action, "resume");
  assert.equal(validation.validChunkCount, 1);
  assert.equal(validation.repairedChunksDeleted, 0);
  assert.ok(await getChunkRecord(taskId, 0));
});

test("19. patchPersistedSongSeparationFields merges separation fields without overwriting user mix edits or downgrading completed", async () => {
  const { saveSongWithAudioFile, patchPersistedSongSeparationFields, getPersistedSongRecord } = await import(
    "../lib/storage/songSessionStore.ts"
  );
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const song = createBandSong({
    id: "song-patch-1",
    name: "Field Merge Test",
    fileName: "merge.wav",
    sourceAudioId: "song-patch-1_original",
    originalBpm: 120,
    durationSec: 30,
    sourceAudioHash: "hash-merge",
  });
  song.targetBpm = 138;
  song.keyShiftSemitones = -2;
  song.masterVolume = 0.6;
  song.loop = true;
  song.stemChannels = [
    { id: "song-patch-1_stem_vocals", songId: "song-patch-1", stemType: "vocals", volume: 0.25, muted: true, solo: false },
  ];
  await saveSongWithAudioFile({
    song,
    file: new Blob([new Uint8Array(16)], { type: "audio/wav" }),
    sourceAudioHash: "hash-merge",
    force: true,
  });

  const completed = await patchPersistedSongSeparationFields("song-patch-1", {
    separationMode: "two_stem",
    separationStatus: "completed",
    separationTaskId: "task-merge",
    separationCompletedChunks: 3,
    separationTotalChunks: 3,
    cacheKey: "cache-merge",
    playbackSource: "stems",
    ensureStemRoles: ["vocals", "instrumental"],
  });

  assert.equal(completed?.separationStatus, "completed");
  assert.equal(completed?.targetBpm, 138);
  assert.equal(completed?.keyShiftSemitones, -2);
  assert.equal(completed?.masterVolume, 0.6);
  assert.equal(completed?.loop, true);
  assert.equal(completed?.stemChannels.find((c) => c.stemType === "vocals")?.volume, 0.25);
  assert.equal(completed?.stemChannels.find((c) => c.stemType === "vocals")?.muted, true);
  assert.equal(completed?.stemChannels.find((c) => c.stemType === "instrumental")?.volume, 1);

  // 禁止過期事件將 completed 降級為 failed/interrupted
  await patchPersistedSongSeparationFields("song-patch-1", {
    separationStatus: "failed",
    separationTaskId: "task-merge",
  });
  const afterStale = await getPersistedSongRecord("song-patch-1");
  assert.equal(afterStale?.separationStatus, "completed");
});
