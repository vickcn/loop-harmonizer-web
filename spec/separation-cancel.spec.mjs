import assert from "node:assert/strict";
import test from "node:test";

import {
  isAbortError,
  SeparationAbortError,
  SeparationTaskCoordinator,
} from "../lib/separation/separationTaskController.ts";
import {
  applySongOperationSnapshot,
  createBandSong,
  createSeparationFocusSessionSnapshot,
  createSongOperationSnapshot,
  findUnusedSeparationRecordKeys,
  restoreSongsAfterSeparationFocus,
} from "../lib/band/songModel.ts";
import { DemucsProcessor } from "../public/vendor/demucs-web/processor.js";
import { CONSTANTS } from "../public/vendor/demucs-web/constants.js";

function createMockOrt({
  numSegmentsBeforeAbort = Infinity,
  onRun,
  onReleaseSession,
  onDisposeTensor,
}) {
  let runCount = 0;
  let releaseCalled = 0;
  let tensorDisposed = 0;

  class MockTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
    dispose() {
      tensorDisposed += 1;
      onDisposeTensor?.(tensorDisposed);
    }
  }

  return {
    ort: {
      Tensor: MockTensor,
      InferenceSession: {
        create: async () => {
          return {
            inputNames: ["input", "spec"],
            outputNames: ["time_out"],
            release: async () => {
              releaseCalled += 1;
              onReleaseSession?.(releaseCalled);
            },
            run: async () => {
              runCount += 1;
              await onRun?.(runCount);
              const samples = CONSTANTS.TRAINING_SAMPLES;
              const timeData = new Float32Array(1 * 4 * 2 * samples).fill(0.05);
              return {
                time_out: {
                  dims: [1, 4, 2, samples],
                  data: timeData,
                  dispose: () => {
                    tensorDisposed += 1;
                    onDisposeTensor?.(tensorDisposed);
                  },
                },
              };
            },
          };
        },
      },
    },
    getStats: () => ({ runCount, releaseCalled, tensorDisposed }),
  };
}

test("cancels during model download stream and aborts without completing", async () => {
  const originalFetch = globalThis.fetch;
  let readerCancelled = false;
  const abortController = new AbortController();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Length": "1000" }),
    body: {
      getReader() {
        let pulls = 0;
        return {
          read: async () => {
            pulls += 1;
            if (pulls === 1) {
              return { done: false, value: new Uint8Array(200) };
            }
            abortController.abort();
            return { done: false, value: new Uint8Array(200) };
          },
          cancel: async () => {
            readerCancelled = true;
          },
        };
      },
    },
  });

  try {
    const { ort } = createMockOrt({});
    const processor = new DemucsProcessor({ ort });
    await assert.rejects(
      () => processor.loadModel("https://example.invalid/model.onnx", { signal: abortController.signal }),
      (err) => isAbortError(err),
    );
    assert.equal(readerCancelled, true);
    assert.equal(processor.session, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelling during InferenceSession initialization releases newly created session", async () => {
  let released = 0;
  const abortController = new AbortController();
  const { ort } = createMockOrt({
    onReleaseSession: (count) => {
      released = count;
    },
  });
  const baseCreate = ort.InferenceSession.create;
  ort.InferenceSession.create = async (...args) => {
    const session = await baseCreate(...args);
    abortController.abort();
    return session;
  };

  const processor = new DemucsProcessor({ ort });
  await assert.rejects(
    () => processor.loadModel(new ArrayBuffer(16), { signal: abortController.signal }),
    (err) => isAbortError(err),
  );
  assert.equal(released, 1);
  assert.equal(processor.session, null);
});

test("cancels during first segment inference and disposes tensors", async () => {
  const coordinator = new SeparationTaskCoordinator();
  const events = [];
  const task = coordinator.startTask({
    songId: "song_1",
    throttleMs: 0,
    onProgress: (ev) => events.push(ev),
  });

  const mock = createMockOrt({
    onRun: async (count) => {
      if (count === 1) {
        await task.cancel("取消於第 1 片段");
      }
    },
  });

  const processor = new DemucsProcessor({ ort: mock.ort });
  await processor.loadModel(new ArrayBuffer(8));

  const left = new Float32Array(CONSTANTS.TRAINING_SAMPLES + 1000).fill(0.1);
  const right = new Float32Array(CONSTANTS.TRAINING_SAMPLES + 1000).fill(0.1);

  await assert.rejects(
    () => processor.separate(left, right, { signal: task.signal }),
    (err) => isAbortError(err),
  );

  const stats = mock.getStats();
  assert.equal(stats.runCount, 1);
  assert.ok(stats.tensorDisposed >= 2, "input/output tensors should be disposed even on cancel");
  assert.equal(task.getStage(), "cancelled");
  assert.ok(events.some((e) => e.stage === "cancelling"));
  assert.equal(events.at(-1)?.stage, "cancelled");
});

test("cancels mid-way across multi-segment inference and skips remaining segments", async () => {
  const abortController = new AbortController();
  let segmentsCompleted = 0;
  const mock = createMockOrt({});
  const processor = new DemucsProcessor({
    ort: mock.ort,
    onProgress: ({ currentSegment }) => {
      segmentsCompleted = currentSegment;
      if (currentSegment === 2) {
        abortController.abort();
      }
    },
  });
  await processor.loadModel(new ArrayBuffer(8));

  // Force 3 segments: stride ~ 257985 -> ~700000 samples yields 3 segments
  const len = CONSTANTS.TRAINING_SAMPLES * 2 + 50000;
  const left = new Float32Array(len).fill(0.1);
  const right = new Float32Array(len).fill(0.1);

  await assert.rejects(
    () => processor.separate(left, right, { signal: abortController.signal }),
    (err) => isAbortError(err),
  );

  assert.equal(segmentsCompleted, 2);
  assert.equal(mock.getStats().runCount, 2);
});

test("cancelling after separation finishes but before cache write blocks persistence", async () => {
  const coordinator = new SeparationTaskCoordinator();
  const task = coordinator.startTask({ songId: "song_cache_race", throttleMs: 0 });
  let cacheWritten = false;

  await task.cancel("寫入快取前已取消");
  assert.throws(() => task.throwIfAborted(), (err) => err instanceof SeparationAbortError);
  if (!task.isCancellingOrCancelled()) {
    cacheWritten = true;
  }
  assert.equal(cacheWritten, false);
});

test("blocks immediate restart while old task is still cancelling, then allows retry once cancelled", async () => {
  const coordinator = new SeparationTaskCoordinator();
  let cleanupDone = false;
  const task1 = coordinator.startTask({
    songId: "song_retry",
    cooldownMs: 30,
  });

  task1.registerCleanup(async () => {
    await new Promise((r) => setTimeout(r, 25));
    cleanupDone = true;
  });

  const cancelPromise = coordinator.cancelTask("song_retry");
  assert.equal(task1.getStage(), "cancelling");

  // 仍在取消中，不得立即啟動重推論
  assert.throws(
    () => coordinator.startTask({ songId: "song_retry" }),
    /仍在停止/,
  );

  await cancelPromise;
  assert.equal(cleanupDone, true);
  assert.equal(task1.getStage(), "cancelled");

  // 取消並完成清理後，可立即啟動新版分離任務
  const task2 = coordinator.startTask({ songId: "song_retry" });
  assert.ok(task2.generation > task1.generation);
  assert.equal(task2.isCurrent(), true);
});

test("stale callbacks from cancelled/invalidated generation never overwrite UI state", async () => {
  const coordinator = new SeparationTaskCoordinator();
  const uiMessages = [];

  const oldTask = coordinator.startTask({
    songId: "song_gen",
    throttleMs: 0,
    onProgress: (ev) => uiMessages.push(`g${ev.generation}:${ev.stage}:${ev.message}`),
  });

  oldTask.updateProgress("processing", 0.3, "舊任務進度");
  await coordinator.cancelTask("song_gen");

  // 模擬新任務已經開始
  const newTask = coordinator.startTask({
    songId: "song_gen",
    throttleMs: 0,
    onProgress: (ev) => uiMessages.push(`g${ev.generation}:${ev.stage}:${ev.message}`),
  });

  // 舊任務遲到的 callback 必須全部被忽略
  oldTask.updateProgress("processing", 0.9, "過期進度");
  oldTask.markCompleted("過期完成");
  oldTask.markFailed("過期失敗");

  newTask.updateProgress("processing", 0.5, "新任務進度");
  assert.ok(!uiMessages.some((m) => m.includes("過期")));
  assert.ok(uiMessages.some((m) => m.includes("新任務進度")));
});

test("operation snapshot restores previous stable source/controls and protects referenced cache from cleanup", () => {
  const song = createBandSong({
    id: "song_snap",
    name: "Grace",
    sourceAudioId: "song_snap_original",
    originalBpm: 120,
    sourceAudioHash: "hash-grace",
  });
  song.playbackSource = "stems";
  song.separationStatus = "completed";
  song.separationMode = "four_stem";
  song.cacheKey = "hash-grace:browser-demucs-v1:four_stem:v2";
  song.targetBpm = 132;
  song.keyShiftSemitones = 2;
  song.masterVolume = 0.85;
  song.stemIds = ["song_snap_stem_vocals"];
  song.stemChannels = [
    { id: "song_snap_stem_vocals", songId: "song_snap", stemType: "vocals", volume: 0.7, muted: false, solo: true },
  ];

  const snapshot = createSongOperationSnapshot(song, "重新分離前");
  assert.equal("audioBuffer" in snapshot, false);

  // 假設重新分離被取消或調整了暫存欄位，snapshotCacheKey 必須免於被 unused cleanup 清掉
  const mutatedSong = {
    ...song,
    playbackSource: "original",
    cacheKey: "new-temp-cache",
    targetBpm: 100,
    keyShiftSemitones: 0,
    activeSnapshot: snapshot,
  };

  const unused = findUnusedSeparationRecordKeys(
    [
      { key: snapshot.cacheKey, sourceAudioHash: "other-hash" },
      { key: "orphan-cache", sourceAudioHash: "orphan-hash" },
    ],
    [mutatedSong],
  );
  assert.deepEqual(unused, ["orphan-cache"]);

  const restored = applySongOperationSnapshot(mutatedSong, snapshot);
  assert.equal(restored.playbackSource, "stems");
  assert.equal(restored.targetBpm, 132);
  assert.equal(restored.keyShiftSemitones, 2);
  assert.equal(restored.masterVolume, 0.85);
  assert.equal(restored.cacheKey, snapshot.cacheKey);
  assert.equal(restored.stemChannels[0].solo, true);
});

test("separation focus snapshot restores settings & playhead paused without auto-play and keeps cache intact", () => {
  const songPlaying = createBandSong({
    id: "song_a",
    name: "Track A",
    sourceAudioId: "song_a_orig",
    originalBpm: 120,
    sourceAudioHash: "hash-a",
  });
  songPlaying.status = "playing";
  songPlaying.playheadSec = 41.25;
  songPlaying.targetBpm = 108;
  songPlaying.keyShiftSemitones = -2;
  songPlaying.masterVolume = 0.72;

  const songTarget = createBandSong({
    id: "song_b",
    name: "Track B",
    sourceAudioId: "song_b_orig",
    originalBpm: 96,
    sourceAudioHash: "hash-b",
  });
  songTarget.status = "playing";
  songTarget.playheadSec = 18.5;
  songTarget.playbackSource = "stems";
  songTarget.separationStatus = "completed";
  songTarget.cacheKey = "hash-b:browser-demucs-v1:four_stem:v2";
  songTarget.stemIds = ["song_b_stem_vocals"];
  songTarget.stemChannels = [
    { id: "song_b_stem_vocals", songId: "song_b", stemType: "vocals", volume: 0.9, muted: false, solo: false },
  ];

  const focusSnapshot = createSeparationFocusSessionSnapshot(
    [songPlaying, songTarget],
    "song_b",
    ["constrained tier"],
    { song_a: 42.5, song_b: 19.0 },
  );
  assert.deepEqual(focusSnapshot.pausedSongIds, ["song_a", "song_b"]);

  const dirtyDuringFocus = [
    { ...songPlaying, status: "paused", targetBpm: 120, keyShiftSemitones: 0, playheadSec: 0 },
    {
      ...songTarget,
      status: "paused",
      playbackSource: "original",
      separationStatus: "cancelling",
      separationMessage: "已中止音源分離，未改動既有設定與快取。",
    },
  ];

  const afterCancel = restoreSongsAfterSeparationFocus(dirtyDuringFocus, focusSnapshot, { outcome: "cancelled" });
  assert.equal(afterCancel[0].status, "paused");
  assert.equal(afterCancel[0].playheadSec, 42.5);
  assert.equal(afterCancel[0].targetBpm, 108);
  assert.equal(afterCancel[0].keyShiftSemitones, -2);
  assert.equal(afterCancel[0].masterVolume, 0.72);

  assert.equal(afterCancel[1].status, "paused");
  assert.equal(afterCancel[1].playheadSec, 19.0);
  assert.equal(afterCancel[1].playbackSource, "stems");
  assert.equal(afterCancel[1].cacheKey, "hash-b:browser-demucs-v1:four_stem:v2");
  assert.equal(afterCancel[1].separationStatus, "cancelled");
  assert.equal(afterCancel[1].separationProgress, 0);

  const afterCompleted = restoreSongsAfterSeparationFocus(
    [
      dirtyDuringFocus[0],
      {
        ...songTarget,
        status: "paused",
        separationStatus: "completed",
        stemChannels: [
          { id: "song_b_stem_vocals", songId: "song_b", stemType: "vocals", volume: 1, muted: false, solo: false },
        ],
      },
    ],
    focusSnapshot,
    { outcome: "completed" },
  );
  assert.equal(afterCompleted[0].status, "paused");
  assert.equal(afterCompleted[1].status, "paused");
  assert.equal(afterCompleted[1].playheadSec, 19.0);
  assert.equal(afterCompleted[1].stemChannels[0].volume, 1);
});
