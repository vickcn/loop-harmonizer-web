import assert from "node:assert/strict";
import test from "node:test";

import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  computeTotalChunks,
  getTaskChunkRecords,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  createCheckpointTaskId,
  deleteAllIncompleteCheckpoints,
  deleteCheckpointAndChunks,
  deleteIncompleteCheckpointsForSong,
  findCompletedCheckpointBySourceAudioHash,
  getCheckpoint,
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
