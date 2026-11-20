import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import {
  buildProjectFromBandSongs,
  projectEntryToBandSong,
} from "../lib/projects/projectModel.ts";
import {
  createNewProject,
  deleteProjectSafely,
  listAllProjectsForUi,
  openProjectMetadataAndEntries,
  renameProject,
  restoreLastActiveProjectOrNull,
  saveLocalProjectSnapshot,
  saveProjectAs,
} from "../lib/projects/projectManager.ts";
import { SeparationJobManager } from "../lib/separation/separationJobManager.ts";
import { clearTransientSongAudioRegistry } from "../lib/separation/separationJobRunner.ts";
import { SeparationJobLeaseManager, getOrCreateTabId } from "../lib/separation/separationResumeController.ts";
import { SeparationTaskCoordinator } from "../lib/separation/separationTaskController.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../lib/storage/cacheKeys.ts";
import { configureInMemoryIdbForTests, idbPut, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { getProjectRecord, setActiveProjectId } from "../lib/storage/projectStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  saveCheckpoint,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import { hashSourceAudio } from "../lib/storage/separationCache.ts";

function fakeCapabilities() {
  return {
    deviceMemoryGb: 8,
    hardwareConcurrency: 4,
    storageUsageBytes: 1024,
    storageQuotaBytes: 2 * 1024 * 1024 * 1024,
    storageRemainingBytes: 1.5 * 1024 * 1024 * 1024,
    storagePersisted: true,
    jsHeapUsedBytes: 20 * 1024 * 1024,
    jsHeapLimitBytes: 1024 * 1024 * 1024,
    jsHeapEstimatedAvailableBytes: 900 * 1024 * 1024,
    supportsWebGpu: true,
    supportsWorker: true,
    formFactorHint: "desktop",
    collectedAt: Date.now(),
  };
}

function fakeNetworkEval() {
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

function createFakeSeparationFn(leaseManager, samples = DEMUCS_STRIDE_SAMPLES, delayMs = 30) {
  const mkStem = (val) => {
    const left = new Float32Array(samples);
    const right = new Float32Array(samples);
    left[0] = val;
    right[0] = val;
    return { left, right };
  };
  return async (_file, options) => {
    const taskId = options.checkpointTaskId;
    const cp = buildInitialCheckpoint({
      taskId,
      songId: options.songId,
      sourceAudioHash: options.sourceAudioHash,
      requestedMode: options.mode ?? "four_stem",
      totalSamples: samples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      status: "queued",
      userAuthorized: true,
    });
    await saveCheckpoint(cp);
    const leaseRes = await leaseManager.acquireLease(taskId, getOrCreateTabId());
    await new Promise((r) => setTimeout(r, delayMs));
    const payload = packChunkStemsToBuffer(
      {
        vocals: mkStem(0.11),
        drums: mkStem(0.12),
        bass: mkStem(0.13),
        other: mkStem(0.14),
      },
      samples,
    );
    const committed = await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: 0,
      startSample: 0,
      endSample: samples,
      payload,
      overlapCarryBuffer: null,
      expectedLease: leaseRes.lease,
    });
    await options?.onChunkCommitted?.({
      checkpoint: committed.checkpoint,
      chunkIndex: 0,
      totalChunks: 1,
    });
    await leaseManager.releaseLease(taskId, leaseRes.lease, "completed");
    return {
      backend: "wasm",
      modelVersion: DEMUCS_MODEL_VERSION,
      durationSeconds: samples / DEMUCS_SAMPLE_RATE,
      chunkedTask: {
        taskId,
        mode: options.mode ?? "four_stem",
        sampleRate: DEMUCS_SAMPLE_RATE,
        totalSamples: samples,
        totalChunks: 1,
        committedBytes: payload.byteLength,
        durationSeconds: samples / DEMUCS_SAMPLE_RATE,
      },
    };
  };
}

test("Local anonymous workspace supports create, rename, save-as, switch, reload recovery, and blocks Drive creation when signed out", async () => {
  configureInMemoryIdbForTests();
  try {
    await assert.rejects(
      () => createNewProject({ name: "Need Auth", storageProvider: "google_drive" }),
      /登入 Google 帳號/,
    );

    const { record: pA } = await createNewProject({
      name: "敬拜流程",
      storageProvider: "local",
    });
    const hash = await hashSourceAudio(new Blob([new Uint8Array([7, 8, 9])]));
    await idbPut("audioFiles", {
      key: hash,
      sourceAudioHash: hash,
      blob: new Blob([new Uint8Array([7, 8, 9])]),
      fileName: "a.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 3,
      lastModified: 1,
      createdAt: 1,
    });

    const bandSong = {
      ...createBandSong({
        id: "entry_1",
        projectEntryId: "entry_1",
        name: "Amazing Grace",
        fileName: "a.mp3",
        sourceAudioId: "entry_1_original",
        settingsKey: "k-1",
        originalBpm: 90,
        sourceAudioHash: hash,
        durationSec: 120,
      }),
      targetBpm: 96,
      keyShiftSemitones: -2,
    };
    const savedA = await saveLocalProjectSnapshot({
      projectId: pA.projectId,
      songs: [bandSong],
    });
    assert.ok(savedA);

    const { record: pARenamed } = await renameProject({
      projectId: pA.projectId,
      newName: "週日敬拜主流程",
    });
    assert.equal(pARenamed.project.name, "週日敬拜主流程");

    const { record: pB } = await saveProjectAs({
      sourceProject: pARenamed.project,
      name: "青少年版流程",
      storageProvider: "local",
    });
    assert.notEqual(pB.projectId, pA.projectId);

    const allUi = await listAllProjectsForUi({ includeCloud: false });
    assert.equal(allUi.projects.length, 2);

    // 模擬切換回專案 A 並重整頁面後恢復上次開啟的專案
    const openedA = await openProjectMetadataAndEntries({
      projectId: pA.projectId,
      setActive: true,
    });
    assert.equal(openedA.songs.length, 1);
    assert.equal(openedA.songs[0].targetBpm, 96);

    const onReload = await restoreLastActiveProjectOrNull();
    assert.equal(onReload?.projectId, pA.projectId);

    // 刪除專案 B
    await deleteProjectSafely({ projectId: pB.projectId, scope: "local_only" });
    assert.equal((await listAllProjectsForUi({ includeCloud: false })).projects.length, 1);
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("Background separation started in Project A commits safely after switching to Project B without polluting B or resurrecting removed entries/deleted projects", async () => {
  configureInMemoryIdbForTests();
  clearTransientSongAudioRegistry();
  let lockTail = Promise.resolve();
  const lockAdapter = {
    request: async (_name, optsOrCb, maybeCb) => {
      const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      const run = lockTail.then(() => cb({}), () => cb({}));
      lockTail = run.catch(() => undefined);
      return run;
    },
  };
  const leaseManager = new SeparationJobLeaseManager({ lockAdapter });
  const manager = new SeparationJobManager({
    coordinator: new SeparationTaskCoordinator(),
    leaseManager,
    lockAdapter,
    retryStorage: null,
    isDocumentHidden: () => false,
    enableBroadcastSync: false,
    runnerDeps: {
      separateAudioFn: createFakeSeparationFn(leaseManager, DEMUCS_STRIDE_SAMPLES, 25),
      preflightNetworkFn: async () => fakeNetworkEval(),
      collectCapabilitiesFn: async () => fakeCapabilities(),
    },
  });

  try {
    const fileBlob = new Blob([new Uint8Array([10, 20, 30, 40])], { type: "audio/mpeg" });
    const file = new File([fileBlob], "songA.mp3", { type: "audio/mpeg" });
    const sourceAudioHash = await hashSourceAudio(file);
    await idbPut("audioFiles", {
      key: sourceAudioHash,
      sourceAudioHash,
      blob: fileBlob,
      fileName: "songA.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: file.size,
      lastModified: file.lastModified,
      createdAt: Date.now(),
    });

    // 建立 Project A（內有目標歌曲 entry-a1，自訂 BPM 144 / Key +3）與 Project B
    const { record: pA } = await createNewProject({ name: "Proj A", storageProvider: "local" });
    const songA = {
      ...createBandSong({
        id: "entry-a1",
        projectEntryId: "entry-a1",
        name: "Song In A",
        fileName: "songA.mp3",
        sourceAudioId: "entry-a1_original",
        settingsKey: "ka",
        originalBpm: 120,
        sourceAudioHash,
        durationSec: 8,
      }),
      targetBpm: 144,
      keyShiftSemitones: 3,
      masterVolume: 0.7,
    };
    const savedA = await saveLocalProjectSnapshot({
      projectId: pA.projectId,
      songs: [songA],
    });
    assert.ok(savedA);

    const { record: pB } = await createNewProject({ name: "Proj B", storageProvider: "local" });
    const savedBBefore = await getProjectRecord(pB.projectId);
    assert.equal(savedBBefore.project.songs.length, 0);

    // 啟動 Project A 歌曲分離並立即切換目前作用中專案為 Proj B
    const runPromise = manager.runSongSeparation({
      songId: songA.id,
      projectId: pA.projectId,
      entryId: "entry-a1",
      songName: songA.name,
      mode: "four_stem",
      file,
      sourceAudioHash,
      fileName: songA.fileName,
      mimeType: songA.mimeType,
      fileSizeBytes: file.size,
      durationSec: 8,
      userAuthorized: true,
    });

    await setActiveProjectId(pB.projectId);
    await new Promise((r) => setTimeout(r, 5));
    const otherJobs = manager.getActiveJobsForOtherProjects(pB.projectId);
    assert.equal(otherJobs.length, 1);
    assert.equal(otherJobs[0].projectId, pA.projectId);

    const outcome = await runPromise;
    assert.equal(outcome.status, "completed");

    // 檢查 Proj A 已收到分離 ArtifactRef 且保留使用者原本 BPM=144 / Key=+3 設定；Proj B 毫髮無傷
    const reloadedA = await getProjectRecord(pA.projectId);
    const reloadedB = await getProjectRecord(pB.projectId);
    assert.equal(reloadedA.project.songs[0].artifactRef?.separationMode, "four_stem");
    assert.equal(reloadedA.project.songs[0].settings.targetBpm, 144);
    assert.equal(reloadedA.project.songs[0].settings.keyShiftSemitones, 3);
    assert.equal(reloadedB.project.songs.length, 0);

    // 測試刪除專案與移除歌曲後，過期分離結果絕不復活專案或重建歌曲
    const { record: pC } = await createNewProject({ name: "Proj C To Delete", storageProvider: "local" });
    const songC = createBandSong({
      id: "entry-c1",
      projectEntryId: "entry-c1",
      name: "Song In C",
      fileName: "songA.mp3",
      sourceAudioId: "entry-c1_original",
      settingsKey: "kc",
      originalBpm: 120,
      sourceAudioHash,
      durationSec: 8,
    });
    await saveLocalProjectSnapshot({ projectId: pC.projectId, songs: [songC] });
    const delPromise = manager.runSongSeparation({
      songId: songC.id,
      projectId: pC.projectId,
      entryId: "entry-c1",
      songName: songC.name,
      mode: "two_stem",
      file,
      sourceAudioHash,
      fileName: songC.fileName,
      mimeType: songC.mimeType,
      fileSizeBytes: file.size,
      durationSec: 8,
      userAuthorized: true,
      forceRecompute: true,
    });
    await deleteProjectSafely({ projectId: pC.projectId, scope: "local_only" });
    await delPromise;
    assert.equal(await getProjectRecord(pC.projectId), null);

    // 建立 Proj D、啟動分離並於完成前移除 entry-d1 -> 不會重新出現 entry-d1
    const { record: pD } = await createNewProject({ name: "Proj D Song Removed", storageProvider: "local" });
    const songD = projectEntryToBandSong(reloadedA.project.songs[0]);
    songD.id = "entry-d1";
    songD.projectEntryId = "entry-d1";
    songD.separationStatus = "not_started";
    await saveLocalProjectSnapshot({ projectId: pD.projectId, songs: [songD] });
    const removedEntryPromise = manager.runSongSeparation({
      songId: "entry-d1",
      projectId: pD.projectId,
      entryId: "entry-d1",
      songName: songD.name,
      mode: "two_stem",
      file,
      sourceAudioHash,
      fileName: songD.fileName,
      mimeType: songD.mimeType,
      fileSizeBytes: file.size,
      durationSec: 8,
      userAuthorized: true,
      forceRecompute: true,
    });
    // 在完成前清空 Proj D 的歌曲清單
    const latestD = await getProjectRecord(pD.projectId);
    await saveLocalProjectSnapshot({ projectId: latestD.projectId, songs: [] });
    await removedEntryPromise;
    const afterD = await getProjectRecord(pD.projectId);
    assert.equal(afterD.project.songs.length, 0);
  } finally {
    manager.dispose();
    clearTransientSongAudioRegistry();
    resetInMemoryIdbForTests();
  }
});
