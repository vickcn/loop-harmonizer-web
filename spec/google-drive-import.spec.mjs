import test from "node:test";
import assert from "node:assert/strict";
import {
  assessDriveImportBatch,
  executeSequentialDriveImport,
  inspectPickedDriveFiles,
} from "../lib/google/driveImportManager.ts";
import { createBandSong, restoreBandSongFromRecord, serializePersistedSong } from "../lib/band/songModel.ts";
import {
  INDEXEDDB_VERSION,
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import { loadPersistedBandSession, saveSongWithAudioFile } from "../lib/storage/songSessionStore.ts";
import { createSeparationCacheKey } from "../lib/storage/cacheKeys.ts";

function makeCapabilities(overrides = {}) {
  return {
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    storageUsageBytes: 100 * 1024 * 1024,
    storageQuotaBytes: 2 * 1024 * 1024 * 1024,
    storageRemainingBytes: 1900 * 1024 * 1024,
    storagePersisted: true,
    jsHeapUsedBytes: 50 * 1024 * 1024,
    jsHeapLimitBytes: 2048 * 1024 * 1024,
    jsHeapEstimatedAvailableBytes: 1900 * 1024 * 1024,
    supportsWebGpu: true,
    supportsWorker: true,
    formFactorHint: "desktop",
    collectedAt: Date.now(),
    ...overrides,
  };
}

test("inspectPickedDriveFiles isolates partial 403/404/trashed errors while resolving Shared Drives, shared files, and resourceKey", async () => {
  const result = await inspectPickedDriveFiles(
    [
      {
        id: "shared_drive_1",
        name: "shared-song.mp3",
        mimeType: "audio/mpeg",
        driveId: "0ASharedDrive",
        resourceKey: "rk-1",
      },
      { id: "missing_404", name: "deleted-song.mp3", mimeType: "audio/mpeg" },
      { id: "forbidden_403", name: "private-song.mp3", mimeType: "audio/mpeg" },
      { id: "trashed_1", name: "trashed.wav", mimeType: "audio/wav" },
    ],
    {
      accessToken: "token-1",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("shared_drive_1")) {
          return new Response(
            JSON.stringify({
              id: "shared_drive_1",
              name: "shared-song.mp3",
              mimeType: "audio/mpeg",
              size: "5242880",
              driveId: "0ASharedDrive",
              resourceKey: "rk-1",
              capabilities: { canDownload: true },
            }),
            { status: 200 },
          );
        }
        if (u.includes("missing_404")) return new Response("Not Found", { status: 404 });
        if (u.includes("forbidden_403")) return new Response("Forbidden", { status: 403 });
        return new Response(
          JSON.stringify({ id: "trashed_1", name: "trashed.wav", mimeType: "audio/wav", trashed: true }),
          { status: 200 },
        );
      },
    },
  );

  assert.equal(result.authExpired, false);
  assert.equal(result.readyFiles.length, 1);
  assert.equal(result.readyFiles[0].resolvedFileId, "shared_drive_1");
  assert.equal(result.readyFiles[0].driveId, "0ASharedDrive");
  assert.equal(result.readyFiles[0].resourceKey, "rk-1");
  assert.equal(result.failedFiles.length, 3);
});

test("assessDriveImportBatch handles unknown sizes conservatively, blocks oversized files, and blocks during focus mode", () => {
  const unknownMeta = [
    {
      pickedFileId: "u1",
      resolvedFileId: "u1",
      name: "unknown-size.wav",
      mimeType: "audio/wav",
      sizeBytes: null,
      isShortcut: false,
      canDownload: true,
    },
  ];
  const unknownAssessment = assessDriveImportBatch(unknownMeta, makeCapabilities());
  assert.equal(unknownAssessment.allowed, true);
  assert.equal(unknownAssessment.unknownSizeCount, 1);
  assert.ok(unknownAssessment.estimatedTotalBytes > 0);
  assert.equal(unknownAssessment.requiresConfirmation, true);

  // Constrained mobile device + 400 MiB file -> hardBlocked before downloading
  const constrainedCap = makeCapabilities({
    deviceMemoryGb: 2,
    formFactorHint: "mobile",
    storageRemainingBytes: 1500 * 1024 * 1024,
  });
  const hugeAssessment = assessDriveImportBatch(
    [
      {
        pickedFileId: "big1",
        resolvedFileId: "big1",
        name: "huge-concert.wav",
        mimeType: "audio/wav",
        sizeBytes: 400 * 1024 * 1024,
        isShortcut: false,
        canDownload: true,
      },
    ],
    constrainedCap,
  );
  assert.equal(hugeAssessment.allowed, false);
  assert.equal(hugeAssessment.hardBlocked, true);

  // Separation Focus Mode blocks Drive audio downloads
  const focusBlocked = assessDriveImportBatch(unknownMeta, makeCapabilities(), {
    separationFocusActive: true,
  });
  assert.equal(focusBlocked.allowed, false);
  assert.equal(focusBlocked.hardBlocked, true);
});

test("executeSequentialDriveImport downloads strictly concurrency=1 and cancels without fetching remaining files", async () => {
  const events = [];
  let inFlightCount = 0;
  let maxObservedConcurrency = 0;
  const controller = new AbortController();

  const files = [
    {
      pickedFileId: "f1",
      resolvedFileId: "f1",
      name: "track1.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 10,
      isShortcut: false,
      canDownload: true,
    },
    {
      pickedFileId: "f2",
      resolvedFileId: "f2",
      name: "track2.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 10,
      isShortcut: false,
      canDownload: true,
    },
    {
      pickedFileId: "f3",
      resolvedFileId: "f3",
      name: "track3.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 10,
      isShortcut: false,
      canDownload: true,
    },
  ];

  const result = await executeSequentialDriveImport(files, {
    accessToken: "token-1",
    accountId: "google:acc1",
    generation: 1,
    isGenerationValid: () => true,
    signal: controller.signal,
    fetchImpl: async (url) => {
      inFlightCount += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
      events.push(`fetch:${String(url).includes("f1") ? "f1" : String(url).includes("f2") ? "f2" : "f3"}`);
      await new Promise((r) => setTimeout(r, 15));
      inFlightCount -= 1;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    },
    onFileDownloaded: async (_file, meta) => {
      events.push(`persisted:${meta.resolvedFileId}`);
      if (meta.resolvedFileId === "f1") {
        // Persist happens strictly before fetching f2; now let f2 fetch start then cancel during f3
      }
      if (meta.resolvedFileId === "f2") {
        controller.abort();
      }
    },
  });

  assert.equal(maxObservedConcurrency, 1);
  assert.deepEqual(events, ["fetch:f1", "persisted:f1", "fetch:f2", "persisted:f2"]);
  assert.equal(result.importedCount, 2);
  assert.equal(result.cancelled, true);
  assert.equal(events.some((e) => e.includes("f3")), false);
});

test("Drive Source persists across IDB round-trip without tokens and modified Drive file yields new sourceAudioHash cache key", async () => {
  configureInMemoryIdbForTests();
  try {
    assert.equal(INDEXEDDB_VERSION, 5);
    const song = createBandSong({
      id: "song_drive_1",
      name: "GraceSong",
      fileName: "GraceSong.mp3",
      sourceAudioId: "song_drive_1_original",
      settingsKey: "GraceSong.mp3:1024:1700000000",
      originalBpm: 118,
      durationSec: 180,
      sourceAudioHash: "hash-v1-original",
      source: {
        provider: "google_drive",
        fileId: "drive_file_777",
        authorizedAccountId: "google:acc1",
        fileName: "GraceSong.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 1024,
        modifiedTime: "2026-01-01T00:00:00Z",
        resourceKey: "rk-777",
        driveId: "0ADrive",
        sourceAudioHash: "hash-v1-original",
      },
    });
    const file = new File([new Uint8Array([10, 20, 30, 40])], "GraceSong.mp3", { type: "audio/mpeg" });
    await saveSongWithAudioFile({
      song,
      file,
      sourceAudioHash: "hash-v1-original",
    });

    const loaded = await loadPersistedBandSession();
    const record = loaded.songs.find((s) => s.songId === "song_drive_1");
    assert.ok(record);
    assert.equal(record.source?.provider, "google_drive");
    assert.equal(record.source?.fileId, "drive_file_777");
    assert.equal(record.source?.authorizedAccountId, "google:acc1");
    assert.equal("accessToken" in (record.source ?? {}), false);

    // Restoring record preserves Drive source metadata and clears stale separation when sourceAudioHash changed
    const restored = restoreBandSongFromRecord(record);
    assert.equal(restored.source?.provider, "google_drive");
    assert.equal(restored.source?.resourceKey, "rk-777");

    // Modified file on Drive produces different hash -> different separation cache key
    const v1CacheKey = createSeparationCacheKey({
      sourceAudioHash: "hash-v1-original",
      modelVersion: "browser-demucs-v1",
      separationMode: "four_stem",
      processingVersion: "loop-harmonizer-stems-v2",
    });
    const v2CacheKey = createSeparationCacheKey({
      sourceAudioHash: "hash-v2-modified",
      modelVersion: "browser-demucs-v1",
      separationMode: "four_stem",
      processingVersion: "loop-harmonizer-stems-v2",
    });
    assert.notEqual(v1CacheKey, v2CacheKey);

    // Verify legacy record without `source` defaults cleanly to local
    const legacyRecord = serializePersistedSong(
      createBandSong({
        id: "legacy_song",
        name: "Legacy",
        fileName: "Legacy.wav",
        sourceAudioId: "legacy_song_original",
        settingsKey: "Legacy.wav:1:1",
        originalBpm: 120,
      }),
      {
        audioKey: "legacy-hash",
        sourceAudioHash: "legacy-hash",
        modelVersion: "browser-demucs-v1",
        processingVersion: "loop-harmonizer-stems-v2",
        revision: 1,
        updatedAt: Date.now(),
        updatedByTabId: "tab-1",
      },
    );
    delete legacyRecord.source;
    const restoredLegacy = restoreBandSongFromRecord(legacyRecord);
    assert.equal(restoredLegacy.source?.provider, "local");
  } finally {
    resetInMemoryIdbForTests();
  }
});
