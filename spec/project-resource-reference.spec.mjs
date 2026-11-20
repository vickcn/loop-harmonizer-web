import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import { listManagedProjectsPaginated } from "../lib/google/driveFolderManager.ts";
import { checkCloudArtifactReferencesAcrossProjects, collectLocalProjectResourceReferences, isAudioHashReferencedAcrossWorkspace } from "../lib/projects/projectResourceReferences.ts";
import { buildProjectFromBandSongs } from "../lib/projects/projectModel.ts";
import { createNewProject, deleteProjectSafely, listAllProjectsForUi, saveProjectAs } from "../lib/projects/projectManager.ts";
import { pinTaskForDriveTransfer, unpinTaskForDriveTransfer } from "../lib/storage/driveTransferStore.ts";
import { configureInMemoryIdbForTests, idbGet, idbPut, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { saveImportedStemsAtomically, releaseImportedStemReferenceAndMaybeGc } from "../lib/storage/importedStemStore.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION, createSeparationCacheKey } from "../lib/storage/cacheKeys.ts";
import { buildInitialCheckpoint, commitChunkAndCheckpointAtomically, getCheckpoint, releaseCheckpointReferenceAndMaybeGc, runCheckpointGarbageCollection } from "../lib/storage/separationCheckpointStore.ts";
import { DEMUCS_SAMPLE_RATE, DEMUCS_STRIDE_SAMPLES, computeBufferChecksum, createChunkKey, packChunkStemsToBuffer } from "../lib/storage/separationChunkStore.ts";
import { clearUnusedSeparationCaches, loadPersistedBandSession, removePersistedSong, saveSongWithAudioFile } from "../lib/storage/songSessionStore.ts";

function makeValidChunk(taskId, frameCount = DEMUCS_STRIDE_SAMPLES) {
  const mk = () => {
    const a = new Float32Array(frameCount);
    if (frameCount > 0) a[0] = 0.02;
    return a;
  };
  const payload = packChunkStemsToBuffer(
    { vocals: { left: mk(), right: mk() }, drums: { left: mk(), right: mk() }, bass: { left: mk(), right: mk() }, other: { left: mk(), right: mk() } },
    frameCount,
  );
  return {
    key: createChunkKey(taskId, 0),
    taskId,
    chunkIndex: 0,
    startSample: 0,
    endSample: frameCount,
    modelVersion: DEMUCS_MODEL_VERSION,
    processingVersion: SEPARATION_PROCESSING_VERSION,
    separationMode: "four_stem",
    sampleRate: DEMUCS_SAMPLE_RATE,
    stemCount: 4,
    payload,
    checksum: computeBufferChecksum(payload),
    sizeBytes: payload.byteLength,
    createdAt: Date.now(),
  };
}

test("Deleting Project A preserves shared audio, checkpoints, chunks, imported stems, and caches used by non-active Project B", async () => {
  configureInMemoryIdbForTests();
  try {
    const sharedHash = "s".repeat(64);
    const cpTaskId = `task_${sharedHash}`;
    const impId = `imp_${sharedHash}`;

    // 建立共用 audioFile
    await idbPut("audioFiles", {
      key: sharedHash,
      sourceAudioHash: sharedHash,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
      fileName: "shared.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 3,
      lastModified: 1,
      createdAt: 1,
    });

    // 建立共用已完成 checkpoint + chunk
    const cp = buildInitialCheckpoint({
      taskId: cpTaskId,
      songId: "entry-a",
      sourceAudioHash: sharedHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      processingVersion: SEPARATION_PROCESSING_VERSION,
      requestedMode: "four_stem",
      sampleRate: DEMUCS_SAMPLE_RATE,
      totalSamples: DEMUCS_STRIDE_SAMPLES,
      totalChunks: 1,
    });
    await idbPut("separationCheckpoints", { ...cp, key: cpTaskId });
    const chunk = makeValidChunk(cpTaskId);
    await commitChunkAndCheckpointAtomically({
      taskId: cpTaskId,
      chunkIndex: 0,
      startSample: 0,
      endSample: DEMUCS_STRIDE_SAMPLES,
      payload: chunk.payload,
      overlapCarryBuffer: null,
    });

    // 建立共用 importedStem
    await saveImportedStemsAtomically({
      record: {
        key: impId,
        importId: impId,
        ownerAccountId: "google:acc1",
        sourceAudioHash: sharedHash,
        revisionId: "rev-shared",
        manifestFileId: "man-shared",
        requestedMode: "four_stem",
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        sampleRate: DEMUCS_SAMPLE_RATE,
        channelCount: 2,
        totalSamples: DEMUCS_STRIDE_SAMPLES,
        strideSamples: DEMUCS_STRIDE_SAMPLES,
        totalChunks: 1,
        committedBytes: chunk.sizeBytes,
        pcmFormat: "wav-float32",
        stemLayout: "four_stem",
        referencedBySongIds: ["entry-a"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chunks: [makeValidChunk(impId)],
    });

    // 建立 Project A 與另存 Project B（兩者共用 sharedHash，且 UI 模擬現在沒有打開 B）
    const { record: recA } = await createNewProject({
      name: "Project A",
      storageProvider: "local",
    });
    const songA = {
      ...createBandSong({
        id: "entry-a",
        projectEntryId: "entry-a",
        name: "Shared",
        fileName: "shared.mp3",
        sourceAudioId: "entry-a_original",
        settingsKey: "k-shared",
        originalBpm: 120,
        sourceAudioHash: sharedHash,
        durationSec: 8,
      }),
      separationStatus: "completed",
      separationMode: "four_stem",
      separationTaskId: cpTaskId,
      cacheKey: createSeparationCacheKey({
        sourceAudioHash: sharedHash,
        modelVersion: DEMUCS_MODEL_VERSION,
        separationMode: "four_stem",
        processingVersion: SEPARATION_PROCESSING_VERSION,
      }),
    };
    const projAUpdated = buildProjectFromBandSongs({
      existingProject: recA.project,
      songs: [songA],
      incrementRevision: true,
    });
    await idbPut("projects", { ...recA, project: projAUpdated });

    const { record: recB } = await saveProjectAs({
      sourceProject: projAUpdated,
      name: "Project B (Non-Active)",
      storageProvider: "local",
    });

    // 在刪除 Project A 前檢查工作區引用
    const refsExcludingA = await isAudioHashReferencedAcrossWorkspace(sharedHash, {
      excludeProjectId: recA.projectId,
    });
    assert.equal(refsExcludingA.referenced, true);
    assert.deepEqual(refsExcludingA.referencingProjectIds, [recB.projectId]);

    // 刪除 Project A：預設絕不刪除原始音檔、Checkpoint、Chunk、ImportedStem
    await deleteProjectSafely({ projectId: recA.projectId, scope: "local_only" });
    assert.equal(await idbGet("projects", recA.projectId), null);
    assert.ok(await idbGet("audioFiles", sharedHash));
    assert.ok(await getCheckpoint(cpTaskId));

    // 執行全系統 GC（傳入空的 knownInMemorySongs，模擬 B 尚未被開啟在畫面中）：
    // B 的引用必須受到保護，不可刪除 checkpoint / importedStem！
    const gcRes = await runCheckpointGarbageCollection({
      knownInMemorySongs: [],
      knownRemovedSongIds: ["entry-a"],
      source: "spec-non-active-project-protection",
    });
    assert.equal(gcRes.deletedCheckpoints, 0);
    assert.ok(await getCheckpoint(cpTaskId));

    const relImp = await releaseImportedStemReferenceAndMaybeGc({
      importId: impId,
      songId: "entry-a",
      knownInMemorySongs: [],
    });
    // Project B 的 entry 有 artifactRef，應阻擋清除，但即使 entry 的 revisionId 改對上 importedStem 也要保留
    assert.ok(relImp);

    // Clear unused separation caches 也不得刪掉 B 的 fast cache
    const cacheKey = createSeparationCacheKey({
      sourceAudioHash: sharedHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
      processingVersion: SEPARATION_PROCESSING_VERSION,
    });
    await idbPut("separations", {
      key: cacheKey,
      sourceAudioHash: sharedHash,
      modelVersion: DEMUCS_MODEL_VERSION,
      separationMode: "four_stem",
      processingVersion: SEPARATION_PROCESSING_VERSION,
      sizeBytes: 100,
    });
    await clearUnusedSeparationCaches([]);
    assert.ok(await idbGet("separations", cacheKey));

    // 在 legacy band-session 也放入同一首歌，然後從 legacy 移除且 deleteLocalData=true：因 Project B 仍引用，底層 audioFiles 必須保留
    const legacySong = createBandSong({
      id: "legacy-s1",
      name: "Shared",
      fileName: "shared.mp3",
      sourceAudioId: "legacy-s1_original",
      settingsKey: "k-leg",
      originalBpm: 120,
      sourceAudioHash: sharedHash,
      durationSec: 8,
    });
    await saveSongWithAudioFile({
      song: legacySong,
      file: new Blob([new Uint8Array([1, 2, 3])]),
      sourceAudioHash: sharedHash,
    });
    const removeLegRes = await removePersistedSong({
      song: legacySong,
      deleteLocalData: true,
      inMemoryRemainingSongs: [],
    });
    assert.equal(removeLegRes.sharedWithOtherSongs, true);
    assert.equal(removeLegRes.deletedAudioFile, false);
    assert.ok(await idbGet("audioFiles", sharedHash));
    assert.equal((await loadPersistedBandSession()).songs.length, 0);

    // 刪除最後一個引用者 Project B 後，驗證 Transfer Pin 仍阻擋刪除
    await deleteProjectSafely({ projectId: recB.projectId, scope: "local_only" });
    pinTaskForDriveTransfer(cpTaskId, "job-export-1");
    const blockedByPin = await releaseCheckpointReferenceAndMaybeGc({
      taskId: cpTaskId,
      sourceAudioHash: sharedHash,
      songId: "entry-b",
    });
    assert.ok(blockedByPin.blockedByLeaseTaskIds.includes(cpTaskId));
    assert.ok(await getCheckpoint(cpTaskId));

    // Unpin 後再 GC 即可安全釋放
    unpinTaskForDriveTransfer(cpTaskId, "job-export-1");
    const summary = collectLocalProjectResourceReferences([]);
    assert.equal(summary.referencedSourceAudioHashes.size, 0);
    const gcFinal = await runCheckpointGarbageCollection({
      knownInMemorySongs: [],
      knownRemovedSongIds: ["entry-a", recB.project.songs[0].entryId],
    });
    assert.equal(gcFinal.deletedCheckpoints, 1);
  } finally {
    unpinTaskForDriveTransfer("task_" + "s".repeat(64), "job-export-1");
    resetInMemoryIdbForTests();
  }
});

test("checkCloudArtifactReferencesAcrossProjects blocks cloud deletion when referenced by cloud project or when cloud list is unreachable", async () => {
  configureInMemoryIdbForTests();
  try {
    // 1. 無法連線／無法取得完整雲端專案清單 -> 禁止自動刪除
    const offlineCheck = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-1",
      revisionId: "rev-001",
      sourceAudioHash: "h1",
      accountId: "google:acc1",
      accessToken: "token-1",
      fetchImpl: async () => new Response("Network Down", { status: 503 }),
    });
    assert.equal(offlineCheck.safeToDelete, false);
    assert.equal(offlineCheck.unknownCloudCoverage, true);

    // 2. 雲端有專案引用此 manifestFileId -> safeToDelete=false
    const cloudRefMock = async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/drive/v3/files") {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes("lhRole' and value='project_json'")) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "pjson-1",
                  name: "project.json",
                  appProperties: {
                    lhApp: "loop-harmonizer",
                    lhRole: "project_json",
                    lhAccountId: "google:acc1",
                    lhProjectId: "p-ref",
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (u.pathname === "/drive/v3/files/pjson-1" && u.searchParams.get("alt") !== "media") {
        return new Response(
          JSON.stringify({
            id: "pjson-1",
            name: "project.json",
            trashed: false,
            version: "1",
            appProperties: {
              lhApp: "loop-harmonizer",
              lhRole: "project_json",
              lhAccountId: "google:acc1",
              lhProjectId: "p-ref",
            },
          }),
          { status: 200 },
        );
      }
      if (u.pathname === "/drive/v3/files/pjson-1" && u.searchParams.get("alt") === "media") {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            application: "loop-harmonizer",
            projectId: "p-ref",
            name: "Active Concert Project",
            storageProvider: "google_drive",
            ownerAccountId: "google:acc1",
            revision: 2,
            revisionToken: "r2",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            masterSettings: {},
            songs: [
              {
                entryId: "e1",
                sourceAudioHash: "h1",
                source: { provider: "local" },
                displayName: "Song 1",
                fileName: "song1.mp3",
                durationSec: 120,
                order: 0,
                artifactRef: {
                  manifestFileId: "man-1",
                  revisionId: "rev-001",
                  sourceAudioHash: "h1",
                  separationMode: "four_stem",
                  modelVersion: "m1",
                  processingVersion: "p1",
                  sampleRate: 44100,
                  channelCount: 2,
                  totalSamples: 44100,
                },
                settings: {
                  displayName: "Song 1",
                  fileName: "song1.mp3",
                  originalBpm: 120,
                  targetBpm: 120,
                  tempoMode: "target-bpm",
                  manualRate: 1,
                  fineRateOffset: 0,
                  savedRates: [1],
                  keyShiftSemitones: 0,
                  masterVolume: 1,
                  muted: false,
                  loop: false,
                  playbackSource: "stems",
                  separationMode: "four_stem",
                  stemChannels: [],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const refCheck = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-1",
      revisionId: "rev-001",
      sourceAudioHash: "h1",
      accountId: "google:acc1",
      accessToken: "token-1",
      fetchImpl: cloudRefMock,
    });
    assert.equal(refCheck.safeToDelete, false);
    assert.ok(refCheck.referencingProjectNames.includes("Active Concert Project"));
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("P1-3: paginated listing handles >100 projects, detects page-2 references & 2-stem derivedFrom, and fails closed on duplicate tokens, limits, errors, permissions, or Abort", async () => {
  configureInMemoryIdbForTests();
  try {
    const targetManifestId = "man-target-103";
    const targetRevisionId = "rev-target-103";
    const sharedHash = "p".repeat(64);
    const totalCount = 105;

    const projectDocs = new Map();
    const folderMetas = [];
    const jsonMetas = [];

    for (let i = 1; i <= totalCount; i += 1) {
      const pid = `proj-${String(i).padStart(3, "0")}`;
      const folderId = `fld-${pid}`;
      const fileId = `pjson-${pid}`;
      folderMetas.push({
        id: folderId,
        name: `project_${pid}`,
        mimeType: "application/vnd.google-apps.folder",
        appProperties: {
          lhApp: "loop-harmonizer",
          lhRole: "project",
          lhAccountId: "google:acc1",
          lhProjectId: pid,
        },
        trashed: false,
        capabilities: { canAddChildren: true },
      });
      jsonMetas.push({
        id: fileId,
        name: "project.json",
        mimeType: "application/json",
        parents: [folderId],
        appProperties: {
          lhApp: "loop-harmonizer",
          lhRole: "project_json",
          lhAccountId: "google:acc1",
          lhProjectId: pid,
        },
        trashed: false,
      });

      const songs = [];
      if (i === 1) {
        // 第 1 個專案引用相同 sourceAudioHash，但為不同 Revision（rev-unrelated）
        songs.push({
          entryId: "e-other-rev",
          sourceAudioHash: sharedHash,
          source: { provider: "local" },
          displayName: "Same Hash Other Rev",
          fileName: "shared.mp3",
          durationSec: 60,
          order: 0,
          artifactRef: {
            manifestFileId: "man-other-rev",
            revisionId: "rev-other-999",
            sourceAudioHash: sharedHash,
            separationMode: "four_stem",
            modelVersion: "m1",
            processingVersion: "p1",
            sampleRate: 44100,
            channelCount: 2,
            totalSamples: 44100,
          },
          settings: {
            displayName: "Same Hash Other Rev",
            fileName: "shared.mp3",
            originalBpm: 120,
            targetBpm: 120,
            tempoMode: "target-bpm",
            manualRate: 1,
            fineRateOffset: 0,
            savedRates: [1],
            keyShiftSemitones: 0,
            masterVolume: 1,
            muted: false,
            loop: false,
            playbackSource: "stems",
            separationMode: "four_stem",
            stemChannels: [],
          },
        });
      }
      if (i === 103) {
        // 第 103 個專案位於第 2 頁之後，直接引用或透過 2-stem derivedFrom 引用目標 Revision
        songs.push({
          entryId: "e-103",
          sourceAudioHash: sharedHash,
          source: { provider: "local" },
          displayName: "Page 2 Referencing Song",
          fileName: "shared.mp3",
          durationSec: 60,
          order: 0,
          artifactRef: {
            manifestFileId: targetManifestId,
            revisionId: targetRevisionId,
            sourceAudioHash: sharedHash,
            separationMode: "four_stem",
            modelVersion: "m1",
            processingVersion: "p1",
            sampleRate: 44100,
            channelCount: 2,
            totalSamples: 44100,
          },
          settings: {
            displayName: "Page 2 Referencing Song",
            fileName: "shared.mp3",
            originalBpm: 120,
            targetBpm: 120,
            tempoMode: "target-bpm",
            manualRate: 1,
            fineRateOffset: 0,
            savedRates: [1],
            keyShiftSemitones: 0,
            masterVolume: 1,
            muted: false,
            loop: false,
            playbackSource: "stems",
            separationMode: "four_stem",
            stemChannels: [],
          },
        });
      }
      projectDocs.set(fileId, {
        schemaVersion: 1,
        application: "loop-harmonizer",
        projectId: pid,
        name: `Tour Project ${i}`,
        storageProvider: "google_drive",
        ownerAccountId: "google:acc1",
        revision: 1,
        revisionToken: `r1-${i}`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        masterSettings: {},
        songs,
      });
    }

    let mode = "normal";
    let fetchAttemptPage2 = 0;

    const paginatedFetch = async (url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const u = new URL(String(url));
      if (u.pathname === "/drive/v3/files") {
        const q = u.searchParams.get("q") ?? "";
        const pageSize = Number(u.searchParams.get("pageSize") ?? "100");
        const token = u.searchParams.get("pageToken");
        const offset = token ? Number(token.replace("p_", "")) : 0;

        if (mode === "duplicate_token" && token) {
          return new Response(
            JSON.stringify({ files: [], nextPageToken: token }),
            { status: 200 },
          );
        }
        if (mode === "page2_503" && offset > 0) {
          fetchAttemptPage2 += 1;
          return new Response("Unavailable", { status: 503 });
        }
        if (mode === "page2_403" && offset > 0) {
          return new Response("Forbidden", { status: 403 });
        }

        const isFolder = q.includes("lhRole' and value='project'");
        const source = isFolder ? folderMetas : jsonMetas;
        const slice = source.slice(offset, offset + pageSize);
        const nextPageToken =
          offset + pageSize < source.length
            ? `p_${offset + pageSize}`
            : mode === "duplicate_token"
              ? "dup-tok-1"
              : undefined;
        return new Response(JSON.stringify({ files: slice, nextPageToken }), { status: 200 });
      }

      if (u.pathname.startsWith("/drive/v3/files/")) {
        const id = decodeURIComponent(u.pathname.split("/").pop());
        if (u.searchParams.get("alt") === "media") {
          const doc = projectDocs.get(id);
          return doc ? new Response(JSON.stringify(doc), { status: 200 }) : new Response("Not Found", { status: 404 });
        }
        const meta = jsonMetas.find((m) => m.id === id);
        return meta ? new Response(JSON.stringify(meta), { status: 200 }) : new Response("Not Found", { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    };

    // 1) >100 專案完整分頁（105 個專案，pageSize=50 -> 3 頁），成功找出位於第 2+ 頁的 Project #103
    const managedAll = await listManagedProjectsPaginated({
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(managedAll.complete, true);
    assert.equal(managedAll.entries.length, 105);
    assert.equal(managedAll.folderPagesFetched, 3);

    const gcBlockedPage2 = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: targetManifestId,
      revisionId: targetRevisionId,
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcBlockedPage2.safeToDelete, false);
    assert.equal(gcBlockedPage2.unknownCloudCoverage, false);
    assert.ok(gcBlockedPage2.referencingProjectIds.includes("proj-103"));

    // 2) 只依 sourceAudioHash：查詢完全未被任何專案引用的第三個 Revision (rev-unreferenced)，應允許刪除而不被 proj-001 的同 Hash 其他 Revision 誤卡
    const gcUnreferencedRev = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-unreferenced",
      revisionId: "rev-unreferenced",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcUnreferencedRev.safeToDelete, true);

    // 3) 若 UI / 專案只帶了 2-stem derivedFrom.sourceRevisionId 指向 rev-unreferenced-parent，必須保護該父版本
    projectDocs.get("pjson-proj-001").songs[0].artifactRef.derivedFrom = {
      sourceMode: "four_stem",
      sourceRevisionId: "rev-parent-protected",
      modelVersion: "m1",
      processingVersion: "p1",
    };
    const gcDerivedParent = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-parent-protected",
      revisionId: "rev-parent-protected",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcDerivedParent.safeToDelete, false);

    // 4) 重複 pageToken -> UI 可取得已讀部分但標記 cloudListIncomplete=true，GC fail closed
    mode = "duplicate_token";
    const uiDup = await listAllProjectsForUi({
      currentAccountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(uiDup.cloudListIncomplete, true);
    assert.ok(uiDup.projects.length > 0);
    const gcDup = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-any",
      revisionId: "rev-any",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcDup.safeToDelete, false);
    assert.equal(gcDup.unknownCloudCoverage, true);

    // 5) 超過 maxPages 上限 -> UI 明確標記 incomplete 且 GC fail closed
    mode = "normal";
    const uiLimited = await listAllProjectsForUi({
      currentAccountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 40,
      maxPages: 1,
      fetchImpl: paginatedFetch,
    });
    assert.equal(uiLimited.cloudListIncomplete, true);
    assert.ok(uiLimited.cloudIncompleteReason);
    const gcLimited = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-any",
      revisionId: "rev-any",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 40,
      maxPages: 1,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcLimited.safeToDelete, false);
    assert.equal(gcLimited.unknownCloudCoverage, true);

    // 6) 第 2 頁 503 中斷（有限重試耗盡） -> fail closed
    mode = "page2_503";
    fetchAttemptPage2 = 0;
    const gc503 = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-any",
      revisionId: "rev-any",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      maxRetriesPerPage: 1,
      retryDelayMs: [5],
      fetchImpl: paginatedFetch,
    });
    assert.equal(gc503.safeToDelete, false);
    assert.equal(gc503.unknownCloudCoverage, true);
    assert.ok(fetchAttemptPage2 >= 2);

    // 7) 權限錯誤 (403) -> fail closed
    mode = "page2_403";
    const gc403 = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-any",
      revisionId: "rev-any",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gc403.safeToDelete, false);
    assert.equal(gc403.unknownCloudCoverage, true);

    // 8) AbortSignal 中止 -> fail closed（絕不把半套清單當成可安全刪除）
    mode = "normal";
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const gcAborted = await checkCloudArtifactReferencesAcrossProjects({
      manifestFileId: "man-any",
      revisionId: "rev-any",
      sourceAudioHash: sharedHash,
      accountId: "google:acc1",
      accessToken: "token-1",
      pageSize: 50,
      signal: abortCtrl.signal,
      fetchImpl: paginatedFetch,
    });
    assert.equal(gcAborted.safeToDelete, false);
    assert.equal(gcAborted.unknownCloudCoverage, true);
  } finally {
    resetInMemoryIdbForTests();
  }
});
