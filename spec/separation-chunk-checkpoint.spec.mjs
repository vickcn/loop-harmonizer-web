import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DemucsProcessor } from "../public/vendor/demucs-web/processor.js";
import { CONSTANTS } from "../public/vendor/demucs-web/constants.js";
import {
  configureInMemoryIdbForTests,
  idbPut,
  resetInMemoryIdbForTests,
  setInMemoryIdbHooksForTests,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_OVERLAP_CARRY_BYTES,
  DEMUCS_OVERLAP_SAMPLES,
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  DEMUCS_TRAINING_SAMPLES,
  computeTotalChunks,
  createChunkKey,
  deriveTwoStemFromChunkBuffer,
  getChunkRecord,
  getTaskChunkRecords,
  packChunkStemsToBuffer,
  unpackBufferToChunkStems,
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
  DEFAULT_JOB_LEASE_TTL_MS,
  SeparationJobLeaseManager,
  evaluateAutoResumeEligibility,
  validateAndPrepareResume,
} from "../lib/separation/separationResumeController.ts";
import {
  ChunkedStemMixBuffer,
  DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS,
} from "../lib/band/playbackAdapters/ChunkPlaybackAdapter.ts";
import {
  assessResourceRisk,
  estimateSeparationStagePeaks,
} from "../lib/band/resourceGuard.ts";
import {
  DEFAULT_NETWORK_BUDGET_BYTES,
  KNOWN_NETWORK_ASSETS,
  evaluateNetworkAssetBatch,
  evaluateNetworkTransfer,
} from "../lib/band/networkBudgetGuard.ts";
import {
  createBandSong,
  restoreBandSongFromRecord,
  serializePersistedSong,
} from "../lib/band/songModel.ts";

/**
 * 確定性模擬 ORT：依「目前分段輸入音訊」決定輸出 4 軌 PCM，
 * 因此即使在中途恢復執行單段邊界 warmup，對同一段輸入也能得到 bit-exact 的模型輸出。
 */
function createDeterministicOrtFromInput() {
  let runCount = 0;

  class MockTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
    dispose() {}
  }

  return {
    ort: {
      Tensor: MockTensor,
      InferenceSession: {
        create: async () => ({
          inputNames: ["input", "spec"],
          outputNames: ["time_out"],
          release: async () => {},
          run: async (feeds) => {
            runCount += 1;
            const inputData = feeds.input.data;
            const samples = CONSTANTS.TRAINING_SAMPLES;
            const timeData = new Float32Array(1 * 4 * 2 * samples);
            const leftScale = [0.22, 0.14, 0.11, 0.08];
            const rightScale = [0.19, 0.15, 0.09, 0.12];
            for (let s = 0; s < 4; s++) {
              const lBase = (s * 2 + 0) * samples;
              const rBase = (s * 2 + 1) * samples;
              const ls = leftScale[s];
              const rs = rightScale[s];
              for (let i = 0; i < samples; i++) {
                const inL = inputData[i];
                const inR = inputData[samples + i];
                timeData[lBase + i] = inL * ls + inR * 0.02 * (s + 1);
                timeData[rBase + i] = inR * rs - inL * 0.015 * (s + 1);
              }
            }
            return {
              time_out: {
                dims: [1, 4, 2, samples],
                data: timeData,
                dispose: () => {},
              },
            };
          },
        }),
      },
    },
    getRunCount: () => runCount,
  };
}

function makeTestAudio(lengthSamples) {
  const left = new Float32Array(lengthSamples);
  const right = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    left[i] = Math.sin(i * 0.013) * 0.45 + Math.cos(i * 0.0037) * 0.25;
    right[i] = Math.cos(i * 0.011) * 0.4 + Math.sin(i * 0.0041) * 0.22;
  }
  return { left, right };
}

function makeCapabilities(overrides = {}) {
  return {
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    storageUsageBytes: 120 * 1024 * 1024,
    storageQuotaBytes: 10 * 1024 * 1024 * 1024,
    storageRemainingBytes: 10 * 1024 * 1024 * 1024,
    storagePersisted: false,
    jsHeapUsedBytes: 60 * 1024 * 1024,
    jsHeapLimitBytes: 2048 * 1024 * 1024,
    jsHeapEstimatedAvailableBytes: 1988 * 1024 * 1024,
    supportsWebGpu: false,
    supportsWorker: true,
    crossOriginIsolated: false,
    formFactorHint: "desktop",
    collectedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// A. Chunk 演算法與音訊接縫正確性測試
// ============================================================================

test("A1: DemucsProcessor streamed onChunk 4-stem and 4->2 stem output match legacy full-song separation sample-by-sample", async () => {
  const totalSamples = 700_000; // 3 chunks: [0,257985), [257985,515970), [515970,700000)
  const { left, right } = makeTestAudio(totalSamples);
  const mockOrt = createDeterministicOrtFromInput();

  const processor = new DemucsProcessor({ ort: mockOrt.ort, sessionOptions: { executionProviders: ["wasm"] } });
  processor.session = await mockOrt.ort.InferenceSession.create();

  const legacyFour = await processor.separate(left, right, { mode: "four_stem" });
  const legacyTwo = await processor.separate(left, right, { mode: "two_stem" });

  const streamedChunks = [];
  const summary = await processor.separate(left, right, {
    mode: "four_stem",
    onChunk: async (chunk) => {
      assert.equal(chunk.totalSegments, 3);
      streamedChunks.push(chunk);
    },
  });

  assert.equal(summary.streamed, true);
  assert.equal(summary.completedChunks, 3);
  assert.equal(streamedChunks.length, 3);
  assert.equal(streamedChunks[0].startSample, 0);
  assert.equal(streamedChunks[0].endSample, DEMUCS_STRIDE_SAMPLES);
  assert.equal(streamedChunks[0].overlapCarryBuffer.byteLength, DEMUCS_OVERLAP_CARRY_BYTES);
  assert.equal(streamedChunks[2].endSample, totalSamples);
  assert.equal(streamedChunks[2].overlapCarryBuffer, null);

  for (const chunk of streamedChunks) {
    const frameCount = chunk.endSample - chunk.startSample;
    const unpacked = unpackBufferToChunkStems(chunk.payloadBuffer, frameCount);
    const derivedTwo = deriveTwoStemFromChunkBuffer(chunk.payloadBuffer, frameCount);
    for (let i = 0; i < frameCount; i++) {
      const g = chunk.startSample + i;
      for (const stemName of ["vocals", "drums", "bass", "other"]) {
        assert.ok(
          Math.abs(unpacked[stemName].left[i] - legacyFour[stemName].left[g]) <= 1e-6,
          `${stemName} L mismatch at sample ${g}`,
        );
        assert.ok(
          Math.abs(unpacked[stemName].right[i] - legacyFour[stemName].right[g]) <= 1e-6,
          `${stemName} R mismatch at sample ${g}`,
        );
      }
      assert.ok(Math.abs(derivedTwo.vocals.left[i] - legacyTwo.vocals.left[g]) <= 1e-6);
      assert.ok(Math.abs(derivedTwo.instrumental.left[i] - legacyTwo.instrumental.left[g]) <= 1e-6);
      assert.ok(Math.abs(derivedTwo.instrumental.right[i] - legacyTwo.instrumental.right[g]) <= 1e-6);
    }
  }
});

test("A2: pausing after chunk k and resuming with overlapCarryBuffer OR 1-segment warmup preserves exact seam continuity", async () => {
  const totalSamples = 850_000; // 4 chunks (stride = 257985 -> ceil(850000/257985)=4)
  const { left, right } = makeTestAudio(totalSamples);
  const mockOrt = createDeterministicOrtFromInput();
  const processor = new DemucsProcessor({ ort: mockOrt.ort, sessionOptions: { executionProviders: ["wasm"] } });
  processor.session = await mockOrt.ort.InferenceSession.create();

  const fullChunks = [];
  await processor.separate(left, right, {
    mode: "four_stem",
    onChunk: async (c) => {
      fullChunks.push(c);
    },
  });
  assert.equal(fullChunks.length, 4);

  // Case 1: pause at boundary after chunk 1 (committed chunks 0, 1), then resume with overlapCarryBuffer from chunk 2
  const firstRun = [];
  let pauseRequested = false;
  const pausedResult = await processor.separate(left, right, {
    mode: "four_stem",
    shouldPause: () => pauseRequested,
    onChunk: async (c) => {
      firstRun.push(c);
      if (c.chunkIndex === 1) pauseRequested = true;
    },
  });
  assert.equal(pausedResult.paused, true);
  assert.equal(firstRun.length, 2);

  const callsBeforeCarryResume = mockOrt.getRunCount();
  const resumedCarryChunks = [];
  const carryOffset = 2 * DEMUCS_STRIDE_SAMPLES;
  await processor.separate(left.subarray(carryOffset), right.subarray(carryOffset), {
    mode: "four_stem",
    startChunkIndex: 2,
    inputOffsetSample: carryOffset,
    totalSamples,
    initialOverlapCarryBuffer: firstRun[1].overlapCarryBuffer,
    onChunk: async (c) => {
      resumedCarryChunks.push(c);
    },
  });
  // Only chunks 2 and 3 inferred (chunks 0 and 1 are NOT re-inferred)
  assert.equal(mockOrt.getRunCount() - callsBeforeCarryResume, 2);
  assert.deepEqual(resumedCarryChunks.map((c) => c.chunkIndex), [2, 3]);
  for (let i = 0; i < resumedCarryChunks.length; i++) {
    const a = new Float32Array(resumedCarryChunks[i].payloadBuffer);
    const b = new Float32Array(fullChunks[2 + i].payloadBuffer);
    assert.equal(a.length, b.length);
    for (let s = 0; s < a.length; s++) {
      assert.ok(Math.abs(a[s] - b[s]) <= 1e-6);
    }
  }

  // Case 2: resume from chunk 2 WITHOUT overlapCarryBuffer -> runs 1 boundary warmup segment (idx 1) and emits only chunks 2 & 3
  const callsBeforeWarmupResume = mockOrt.getRunCount();
  const resumedWarmupChunks = [];
  const warmupOffset = 1 * DEMUCS_STRIDE_SAMPLES;
  await processor.separate(left.subarray(warmupOffset), right.subarray(warmupOffset), {
    mode: "four_stem",
    startChunkIndex: 2,
    inputOffsetSample: warmupOffset,
    totalSamples,
    initialOverlapCarryBuffer: null,
    onChunk: async (c) => {
      resumedWarmupChunks.push(c);
    },
  });
  // 1 warmup + 2 remaining chunks = 3 runs
  assert.equal(mockOrt.getRunCount() - callsBeforeWarmupResume, 3);
  assert.deepEqual(resumedWarmupChunks.map((c) => c.chunkIndex), [2, 3]);
  for (let i = 0; i < resumedWarmupChunks.length; i++) {
    const a = new Float32Array(resumedWarmupChunks[i].payloadBuffer);
    const b = new Float32Array(fullChunks[2 + i].payloadBuffer);
    for (let s = 0; s < a.length; s++) {
      assert.ok(Math.abs(a[s] - b[s]) <= 1e-6, `Warmup seam mismatch at chunk ${2 + i} idx ${s}`);
    }
  }
});

test("A3: ChunkedStemMixBuffer enforces sliding-window LRU cap (<= 6 chunks), handles seek/loop preload, and mixes 4->2 stems on the fly", async () => {
  const numChunks = 12;
  const totalSamples = numChunks * DEMUCS_STRIDE_SAMPLES;
  const taskId = "task-chunk-playback";
  const mockChunks = new Map();

  for (let c = 0; c < numChunks; c++) {
    const startSample = c * DEMUCS_STRIDE_SAMPLES;
    const endSample = startSample + DEMUCS_STRIDE_SAMPLES;
    const frameCount = endSample - startSample;
    const payload = packChunkStemsToBuffer(
      {
        vocals: { left: new Float32Array(frameCount).fill(0.2), right: new Float32Array(frameCount).fill(0.2) },
        drums: { left: new Float32Array(frameCount).fill(0.1), right: new Float32Array(frameCount).fill(0.1) },
        bass: { left: new Float32Array(frameCount).fill(0.05), right: new Float32Array(frameCount).fill(0.05) },
        other: { left: new Float32Array(frameCount).fill(0.025), right: new Float32Array(frameCount).fill(0.025) },
      },
      frameCount,
    );
    mockChunks.set(c, {
      key: createChunkKey(taskId, c),
      taskId,
      chunkIndex: c,
      startSample,
      endSample,
      modelVersion: "v1",
      processingVersion: "v1",
      separationMode: "four_stem",
      sampleRate: DEMUCS_SAMPLE_RATE,
      stemCount: 4,
      payload,
      checksum: "0000000000000000",
      sizeBytes: payload.byteLength,
      createdAt: Date.now(),
    });
  }

  const mixBuffer = new ChunkedStemMixBuffer({
    taskId,
    totalSamples,
    sampleRate: DEMUCS_SAMPLE_RATE,
    maxResidentChunks: DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS,
    entries: [
      { trackId: "t_vocals", role: "vocals", gain: 0.5, muted: false },
      { trackId: "t_inst", role: "instrumental", gain: 1.0, muted: false },
    ],
    loadChunk: async (_tid, idx) => mockChunks.get(idx) ?? null,
  });

  await mixBuffer.warmUpAroundSample(0);
  assert.ok(mixBuffer.getResidentChunkIndices().includes(0));
  assert.ok(mixBuffer.getResidentChunkIndices().length <= 6);

  // Seek through chunks 0..10 to verify LRU eviction bounds resident memory
  for (let c = 0; c <= 10; c++) {
    await mixBuffer.warmUpAroundSample(c * DEMUCS_STRIDE_SAMPLES + 100);
    assert.ok(
      mixBuffer.getResidentChunkIndices().length <= DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS,
      `Resident chunk count exceeded cap at chunk ${c}`,
    );
  }

  // Loop enabled retains chunk 0 alongside tail chunk window within LRU limit
  mixBuffer.setLoopEnabled(true);
  await mixBuffer.warmUpAroundSample(11 * DEMUCS_STRIDE_SAMPLES + 10);
  assert.ok(mixBuffer.getResidentChunkIndices().includes(0));
  assert.ok(mixBuffer.getResidentChunkIndices().includes(11));
  assert.ok(mixBuffer.getResidentChunkIndices().length <= DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS);

  // On-the-fly 4->2 stem mixdown: vocals (0.2*0.5=0.1) + instrumental ((0.1+0.05+0.025)*1=0.175) = 0.275
  const interleaved = new Float32Array(256 * 2);
  const extracted = mixBuffer.extract(interleaved, 256, 11 * DEMUCS_STRIDE_SAMPLES + 10);
  assert.equal(extracted, 256);
  for (let i = 0; i < 256 * 2; i++) {
    assert.ok(Math.abs(interleaved[i] - 0.275) <= 1e-6);
  }

  mixBuffer.dispose();
  assert.equal(mixBuffer.getResidentChunkIndices().length, 0);
});

// ============================================================================
// B. Checkpoint 與 IndexedDB 原子交易／損毀自動修復測試
// ============================================================================

test("B1: commitChunkAndCheckpointAtomically rolls back both stores if IDB fails mid-transaction", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
  const cp = buildInitialCheckpoint({
    songId: "song-atomic",
    sourceAudioHash: "hash-atomic",
    requestedMode: "four_stem",
    totalSamples,
  });
  await saveCheckpoint(cp);

  const leaseMgr = new SeparationJobLeaseManager();
  const lockRes = await leaseMgr.acquireLease(cp.taskId, "tab-a");
  assert.equal(lockRes.acquired, true);

  const payload = packChunkStemsToBuffer(
    {
      vocals: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1), right: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1) },
      drums: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      bass: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      other: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
    },
    DEMUCS_STRIDE_SAMPLES,
  );

  // Simulate IDB failure after chunk put, before/during checkpoint put
  setInMemoryIdbHooksForTests({
    beforeWrite: (storeName) => {
      if (storeName === "separationCheckpoints") {
        throw new Error("Simulated QuotaExceededError on separationCheckpoints");
      }
    },
  });

  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: cp.taskId,
        chunkIndex: 0,
        startSample: 0,
        endSample: DEMUCS_STRIDE_SAMPLES,
        payload,
        overlapCarryBuffer: null,
        expectedLease: lockRes.lease,
      }),
    /QuotaExceededError/,
  );

  setInMemoryIdbHooksForTests({});
  const afterRollbackCp = await getCheckpoint(cp.taskId);
  const afterRollbackChunks = await getTaskChunkRecords(cp.taskId);
  assert.equal(afterRollbackCp?.nextChunkIndex, 0);
  assert.equal(afterRollbackCp?.committedEndSample, 0);
  assert.equal(afterRollbackChunks.length, 0);
  leaseMgr.close();
  resetInMemoryIdbForTests();
});

test("B2: rejects duplicate or out-of-order chunk writes and stale lease generations", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 3;
  const cp = buildInitialCheckpoint({
    songId: "song-order",
    sourceAudioHash: "hash-order",
    requestedMode: "four_stem",
    totalSamples,
  });
  await saveCheckpoint(cp);

  const leaseMgr = new SeparationJobLeaseManager();
  const lockRes = await leaseMgr.acquireLease(cp.taskId, "tab-a");
  assert.equal(lockRes.acquired, true);

  const makePayload = (len) =>
    packChunkStemsToBuffer(
      {
        vocals: { left: new Float32Array(len).fill(0.05), right: new Float32Array(len).fill(0.05) },
        drums: { left: new Float32Array(len), right: new Float32Array(len) },
        bass: { left: new Float32Array(len), right: new Float32Array(len) },
        other: { left: new Float32Array(len), right: new Float32Array(len) },
      },
      len,
    );

  await commitChunkAndCheckpointAtomically({
    taskId: cp.taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: makePayload(DEMUCS_STRIDE_SAMPLES),
    overlapCarryBuffer: null,
    expectedLease: lockRes.lease,
  });

  // Duplicate chunk 0
  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: cp.taskId,
        chunkIndex: 0,
        startSample: 0,
        endSample: DEMUCS_STRIDE_SAMPLES,
        payload: makePayload(DEMUCS_STRIDE_SAMPLES),
        overlapCarryBuffer: null,
        expectedLease: lockRes.lease,
      }),
    /Chunk 索引不連續/,
  );

  // Out-of-order chunk 2
  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: cp.taskId,
        chunkIndex: 2,
        startSample: DEMUCS_STRIDE_SAMPLES * 2,
        endSample: DEMUCS_STRIDE_SAMPLES * 3,
        payload: makePayload(DEMUCS_STRIDE_SAMPLES),
        overlapCarryBuffer: null,
        expectedLease: lockRes.lease,
      }),
    /Chunk 索引不連續/,
  );

  // Stale generation
  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: cp.taskId,
        chunkIndex: 1,
        startSample: DEMUCS_STRIDE_SAMPLES,
        endSample: DEMUCS_STRIDE_SAMPLES * 2,
        payload: makePayload(DEMUCS_STRIDE_SAMPLES),
        overlapCarryBuffer: null,
        expectedLease: { ...lockRes.lease, generation: 999 },
      }),
    /Lease \/ Generation/,
  );

  leaseMgr.close();
  resetInMemoryIdbForTests();
});

test("B3: validateAndPrepareResume detects corrupted chunk and truncates only from damaged index while preserving verified prefix", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 4;
  const taskId = createCheckpointTaskId("song-repair", "hash-repair");
  const cp = buildInitialCheckpoint({
    taskId,
    songId: "song-repair",
    sourceAudioHash: "hash-repair",
    requestedMode: "four_stem",
    totalSamples,
  });
  await saveCheckpoint(cp);

  const leaseMgr = new SeparationJobLeaseManager();
  const lockRes = await leaseMgr.acquireLease(taskId, "tab-a");
  assert.equal(lockRes.acquired, true);

  for (let c = 0; c < 3; c++) {
    const startSample = c * DEMUCS_STRIDE_SAMPLES;
    const endSample = startSample + DEMUCS_STRIDE_SAMPLES;
    const payload = packChunkStemsToBuffer(
      {
        vocals: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1), right: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1) },
        drums: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
        bass: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
        other: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      },
      DEMUCS_STRIDE_SAMPLES,
    );
    await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: c,
      startSample,
      endSample,
      payload,
      overlapCarryBuffer: null,
      expectedLease: lockRes.lease,
    });
  }

  // Corrupt chunk 1 payload checksum without touching chunk 0 or chunk 2
  const chunk1 = await getChunkRecord(taskId, 1);
  assert.ok(chunk1);
  await idbPut("separationChunks", {
    ...chunk1,
    checksum: "deadbeef00000000",
  });

  const validation = await validateAndPrepareResume(taskId, {
    songId: "song-repair",
    sourceAudioHash: "hash-repair",
    sourceAudioAvailable: true,
    totalSamples,
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.action, "resume");
  assert.equal(validation.validChunkCount, 1);
  assert.equal(validation.resumeFromChunkIndex, 1);
  assert.equal(validation.repairedChunksDeleted, 2); // chunk 1 & chunk 2 truncated
  assert.equal(validation.needsOverlapWarmup, true);

  const remainingChunks = await getTaskChunkRecords(taskId);
  assert.deepEqual(remainingChunks.map((c) => c.chunkIndex), [0]);
  const updatedCp = await getCheckpoint(taskId);
  assert.equal(updatedCp?.nextChunkIndex, 1);
  assert.equal(updatedCp?.committedEndSample, DEMUCS_STRIDE_SAMPLES);

  // Mismatch audio hash or model version forces recompute_from_scratch
  const hashMismatch = await validateAndPrepareResume(taskId, {
    songId: "song-repair",
    sourceAudioHash: "different-hash",
    sourceAudioAvailable: true,
    totalSamples,
  });
  assert.equal(hashMismatch.valid, false);
  assert.equal(hashMismatch.action, "recompute_from_scratch");

  const versionMismatch = await validateAndPrepareResume(taskId, {
    songId: "song-repair",
    sourceAudioHash: "hash-repair",
    sourceAudioAvailable: true,
    totalSamples,
    modelVersion: "demucs-future-v99",
  });
  assert.equal(versionMismatch.valid, false);
  assert.equal(versionMismatch.action, "recompute_from_scratch");

  leaseMgr.close();
  resetInMemoryIdbForTests();
});

// ============================================================================
// C. Cross-Tab Lease、Auto-Resume Policy、Pause vs Cancel vs Clear 語意測試
// ============================================================================

test("C1: SeparationJobLeaseManager prevents concurrent cross-tab execution and fences stale tab writes", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 2;
  const cp = buildInitialCheckpoint({
    songId: "song-lease",
    sourceAudioHash: "hash-lease",
    requestedMode: "four_stem",
    totalSamples,
  });
  await saveCheckpoint(cp);

  const managerA = new SeparationJobLeaseManager();
  const managerB = new SeparationJobLeaseManager();
  const t0 = 1_700_000_000_000;

  const acqA = await managerA.acquireLease(cp.taskId, "tab-A", DEFAULT_JOB_LEASE_TTL_MS, t0);
  assert.equal(acqA.acquired, true);
  assert.equal(acqA.lease.generation, 1);

  // Tab B cannot acquire while Tab A lease is still valid
  const blockedB = await managerB.acquireLease(cp.taskId, "tab-B", DEFAULT_JOB_LEASE_TTL_MS, t0 + 2_000);
  assert.equal(blockedB.acquired, false);

  // Tab A renews heartbeat
  const renewed = await managerA.renewLease(cp.taskId, acqA.lease, DEFAULT_JOB_LEASE_TTL_MS, t0 + 8_000);
  assert.equal(renewed, true);

  // Tab B can take over once lease expires
  const acqB = await managerB.acquireLease(
    cp.taskId,
    "tab-B",
    DEFAULT_JOB_LEASE_TTL_MS,
    t0 + 8_000 + DEFAULT_JOB_LEASE_TTL_MS + 1,
  );
  assert.equal(acqB.acquired, true);
  assert.equal(acqB.lease.generation, 2);

  // Stale Tab A cannot write chunks or release Tab B's lease
  const payload = packChunkStemsToBuffer(
    {
      vocals: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1), right: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1) },
      drums: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      bass: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      other: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
    },
    DEMUCS_STRIDE_SAMPLES,
  );
  await assert.rejects(
    () =>
      commitChunkAndCheckpointAtomically({
        taskId: cp.taskId,
        chunkIndex: 0,
        startSample: 0,
        endSample: DEMUCS_STRIDE_SAMPLES,
        payload,
        overlapCarryBuffer: null,
        expectedLease: acqA.lease,
      }),
    /Lease \/ Generation/,
  );

  assert.equal(await managerA.releaseLease(cp.taskId, acqA.lease, "paused"), false);
  assert.equal(await managerB.releaseLease(cp.taskId, acqB.lease, "paused"), true);

  managerA.close();
  managerB.close();
  resetInMemoryIdbForTests();
});

test("C2: evaluateAutoResumeEligibility distinguishes interrupted vs paused vs cancelled and enforces guards", async () => {
  const baseCp = buildInitialCheckpoint({
    songId: "song-policy",
    sourceAudioHash: "hash-policy",
    requestedMode: "four_stem",
    totalSamples: DEMUCS_STRIDE_SAMPLES * 3,
    status: "interrupted",
    userAuthorized: true,
  });
  baseCp.nextChunkIndex = 1;
  baseCp.committedEndSample = DEMUCS_STRIDE_SAMPLES;

  const baseValidation = {
    valid: true,
    action: "resume",
    resumeFromChunkIndex: 1,
    totalChunks: 3,
    validChunkCount: 1,
    repairedChunksDeleted: 0,
    needsOverlapWarmup: false,
    checkpoint: baseCp,
  };

  const baseInput = {
    checkpoint: baseCp,
    validation: baseValidation,
    tabId: "tab-self",
    isDocumentHidden: false,
    hasActiveLocalDemucsTask: false,
    taskAdmission: { allowed: true },
    networkBudgetAllowed: true,
    now: 100_000,
  };

  assert.equal(evaluateAutoResumeEligibility(baseInput).allowed, true);
  assert.equal(evaluateAutoResumeEligibility({ ...baseInput, isDocumentHidden: true }).code, "hidden");
  assert.equal(evaluateAutoResumeEligibility({ ...baseInput, hasActiveLocalDemucsTask: true }).code, "already_running");
  assert.equal(evaluateAutoResumeEligibility({ ...baseInput, taskAdmission: { allowed: false, reasons: ["低記憶體"] } }).code, "resource_blocked");
  assert.equal(evaluateAutoResumeEligibility({ ...baseInput, networkBudgetAllowed: false }).code, "network_blocked");

  assert.equal(
    evaluateAutoResumeEligibility({ ...baseInput, checkpoint: { ...baseCp, userAuthorized: false } }).code,
    "unauthorized",
  );
  // Explicit Pause stays paused until user clicks Resume
  assert.equal(
    evaluateAutoResumeEligibility({ ...baseInput, checkpoint: { ...baseCp, status: "paused" } }).code,
    "paused",
  );
  // Cancelled keeps committed chunks but MUST NOT auto-resume
  assert.equal(
    evaluateAutoResumeEligibility({ ...baseInput, checkpoint: { ...baseCp, status: "cancelled" } }).code,
    "cancelled",
  );
});

test("C3: cancelling retains committed chunks while explicit deleteCheckpointAndChunks clears only target song", async () => {
  resetInMemoryIdbForTests();
  configureInMemoryIdbForTests();

  const totalSamples = DEMUCS_STRIDE_SAMPLES * 3;
  const cp1 = buildInitialCheckpoint({
    songId: "song-1",
    sourceAudioHash: "hash-1",
    requestedMode: "four_stem",
    totalSamples,
  });
  const cp2 = buildInitialCheckpoint({
    songId: "song-2",
    sourceAudioHash: "hash-2",
    requestedMode: "two_stem",
    totalSamples,
  });
  await saveCheckpoint(cp1);
  await saveCheckpoint(cp2);

  const payload = packChunkStemsToBuffer(
    {
      vocals: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1), right: new Float32Array(DEMUCS_STRIDE_SAMPLES).fill(0.1) },
      drums: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      bass: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
      other: { left: new Float32Array(DEMUCS_STRIDE_SAMPLES), right: new Float32Array(DEMUCS_STRIDE_SAMPLES) },
    },
    DEMUCS_STRIDE_SAMPLES,
  );

  await commitChunkAndCheckpointAtomically({
    taskId: cp1.taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload,
    overlapCarryBuffer: null,
  });
  await commitChunkAndCheckpointAtomically({
    taskId: cp2.taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: DEMUCS_STRIDE_SAMPLES,
    payload: payload.slice(0),
    overlapCarryBuffer: null,
  });

  // Cancel cp1 -> keeps chunk 0!
  await updateCheckpointStatus(cp1.taskId, {
    status: "cancelled",
    userAuthorized: false,
    clearLeaseIfTerminal: true,
  });
  const cancelledCp1 = await getCheckpoint(cp1.taskId);
  assert.equal(cancelledCp1?.status, "cancelled");
  assert.equal((await getTaskChunkRecords(cp1.taskId)).length, 1);

  // Explicit clear of cp1 -> deletes cp1 + chunks, leaves cp2 untouched
  const cleared = await deleteCheckpointAndChunks(cp1.taskId);
  assert.equal(cleared.deletedCheckpoint, true);
  assert.equal(cleared.deletedChunks, 1);
  assert.equal(await getCheckpoint(cp1.taskId), null);
  assert.equal((await getTaskChunkRecords(cp1.taskId)).length, 0);

  assert.ok(await getCheckpoint(cp2.taskId));
  assert.equal((await getTaskChunkRecords(cp2.taskId)).length, 1);

  resetInMemoryIdbForTests();
});

// ============================================================================
// D. Android 30s / 2m / 4m / 6m / 10m 資源矩陣與持久化狀態恢復測試
// ============================================================================

test("D1: constrained/balanced/performance admit 30s, 2m, 4m, 6m, and 10m under chunk streaming while rejecting 30m extreme on constrained", () => {
  const constrainedMobile = makeCapabilities({
    deviceMemoryGb: 2,
    hardwareConcurrency: 4,
    supportsWebGpu: false,
    formFactorHint: "mobile",
    jsHeapUsedBytes: 60 * 1024 * 1024,
    jsHeapLimitBytes: 1024 * 1024 * 1024,
  });
  const balancedDevice = makeCapabilities({
    deviceMemoryGb: 4,
    hardwareConcurrency: 6,
    supportsWebGpu: false,
    formFactorHint: "mobile",
  });
  const performanceDevice = makeCapabilities({
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    supportsWebGpu: true,
    formFactorHint: "desktop",
  });

  const durations = [30, 120, 240, 360, 600];
  for (const capabilities of [constrainedMobile, balancedDevice, performanceDevice]) {
    for (const durationSec of durations) {
      for (const separationMode of ["two_stem", "four_stem"]) {
        const res = assessResourceRisk({
          operation: "separate",
          durationSec,
          separationMode,
          capabilities,
        });
        assert.equal(
          res.admission.allowed,
          true,
          `${capabilities.deviceMemoryGb}GB ${durationSec}s ${separationMode} must be allowed`,
        );
        assert.equal(res.admission.hardRejected, false);
      }
    }
  }

  // Peak estimate for 10m (600s) fits within 480 MiB constrained budget
  const peaks10m = estimateSeparationStagePeaks(600, "four_stem");
  assert.ok(peaks10m.peakWorkingMemoryBytes <= 480 * 1024 * 1024);

  // 30m extreme track still blocked on 2GB constrained mobile (> 744 MiB)
  const constrained30m = assessResourceRisk({
    operation: "separate",
    durationSec: 1800,
    separationMode: "four_stem",
    capabilities: constrainedMobile,
  });
  assert.equal(constrained30m.admission.allowed, false);
  assert.equal(constrained30m.admission.hardRejected, true);

  // Total chunk count for 10m at 44.1kHz matches computeTotalChunks
  const tenMinSamples = 600 * DEMUCS_SAMPLE_RATE;
  assert.equal(computeTotalChunks(tenMinSamples, DEMUCS_STRIDE_SAMPLES), Math.ceil(tenMinSamples / DEMUCS_STRIDE_SAMPLES));
});

test("D2: BandSong serialization round-trips chunk checkpoint metadata and restores interrupted status without auto-play", () => {
  const song = createBandSong({
    id: "song-10m",
    name: "Worship_10Min",
    fileName: "worship.mp3",
    sourceAudioId: "song-10m_original",
    settingsKey: "worship.mp3:12000000:1",
    originalBpm: 72,
    durationSec: 600,
    sourceAudioHash: "sha256-10m",
  });
  song.status = "playing";
  song.separationStatus = "processing";
  song.separationMode = "four_stem";
  song.separationTaskId = "sep:song-10m:sha256-10m:v1:v1";
  song.separationCompletedChunks = 24;
  song.separationTotalChunks = 103;
  song.separationCommittedBytes = 198_120_960;
  song.separationUserAuthorized = true;

  const persisted = serializePersistedSong(song, 0, true);
  const restored = restoreBandSongFromRecord(persisted, { hasLocalAudioBlob: true });

  assert.equal(restored.status, "stopped");
  assert.equal(restored.separationStatus, "interrupted");
  assert.equal(restored.separationCompletedChunks, 24);
  assert.equal(restored.separationTotalChunks, 103);
  assert.equal(restored.separationCommittedBytes, 198_120_960);
  assert.equal(restored.separationUserAuthorized, true);
});

// ============================================================================
// E. 網路與 Vercel 成本防護驗證
// ============================================================================

test("E1: enforces 10 MiB hard Vercel static cap, blocks unapproved large static downloads, and keeps separation serverless-free", () => {
  assert.equal(DEFAULT_NETWORK_BUDGET_BYTES, 10 * 1024 * 1024);

  // Ensure worker.js / processor.js disk sizes still match KNOWN_NETWORK_ASSETS
  for (const entry of KNOWN_NETWORK_ASSETS.filter((e) => e.sizeSource === "exact-static-file")) {
    const abs = path.join(process.cwd(), "public", entry.matchPathOrUrl.replace(/^\//, ""));
    const stat = fs.statSync(abs);
    assert.equal(stat.size, entry.sizeBytes);
  }

  // Uncached static ORT WASM (~24.6 MiB) remains rejected under 10 MiB hard Vercel cap
  const wasmDecision = evaluateNetworkTransfer({
    url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
    isCached: false,
  });
  assert.equal(wasmDecision.allowed, false);
  assert.equal(wasmDecision.hardBlocked, true);
  assert.equal(wasmDecision.reason, "exceeds-budget");

  // When runtime static + model are cached locally, resume requires 0 bytes over network
  const resumeBatch = evaluateNetworkAssetBatch({
    assets: [
      { url: "/vendor/demucs-web/worker.js", isCached: true },
      { url: "/vendor/demucs-web/processor.js", isCached: true },
      { url: "/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", isCached: true },
      { url: "https://huggingface.co/example/htdemucs_embedded.onnx", isCached: true },
    ],
  });
  assert.equal(resumeBatch.allowed, true);
  assert.equal(resumeBatch.hardBlocked, false);
  assert.equal(resumeBatch.totalEstimatedTransferBytes, 0);

  // Confirm no server-side separation/demucs API routes exist under app/api/
  const apiDir = path.join(process.cwd(), "app", "api");
  if (fs.existsSync(apiDir)) {
    const entries = fs.readdirSync(apiDir);
    for (const forbidden of ["separate", "separation", "demucs", "stem", "stems"]) {
      assert.equal(entries.includes(forbidden), false, `Forbidden Vercel audio API route app/api/${forbidden} found`);
    }
  }
});
