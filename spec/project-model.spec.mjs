import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import { buildStableSongFolderKey } from "../lib/google/driveFolderManager.ts";
import {
  buildProjectFromBandSongs,
  cloneProjectForSaveAs,
  computeEntryBackupStatus,
  computeProjectBackupSummary,
  createEmptyProject,
  isArtifactRefStrictlyCompatible,
  projectEntryToBandSong,
  validateProjectDocument,
} from "../lib/projects/projectModel.ts";

test("Project mix settings are isolated per project and per duplicate entry within the same project", () => {
  const sharedHash = "a".repeat(64);
  const songInProjA = {
    ...createBandSong({
      id: "song-a",
      name: "Sunday Worship",
      fileName: "sunday.mp3",
      sourceAudioId: "song-a_original",
      settingsKey: "k1",
      originalBpm: 120,
      sourceAudioHash: sharedHash,
      durationSec: 210,
    }),
    targetBpm: 132,
    keyShiftSemitones: 2,
    masterVolume: 0.9,
  };

  const projA0 = createEmptyProject({ name: "主日崇拜 A", storageProvider: "local" });
  const projA = buildProjectFromBandSongs({
    existingProject: projA0,
    songs: [songInProjA],
    incrementRevision: true,
  });

  // 另存為專案 B，不複製 WAV/checkpoint，但擁有各自獨立的 entryId 與設定
  const projB = cloneProjectForSaveAs(projA, {
    name: "週三練習 B",
    storageProvider: "local",
  });

  assert.notEqual(projB.projectId, projA.projectId);
  assert.notEqual(projB.songs[0].entryId, projA.songs[0].entryId);
  assert.equal(projB.songs[0].sourceAudioHash, sharedHash);
  // 同首歌共用同一個 Drive stableSongKey，不重複建立分軌 WAV
  assert.equal(buildStableSongFolderKey(projA.songs[0].sourceAudioHash), buildStableSongFolderKey(projB.songs[0].sourceAudioHash));

  // 在 B 修改 Key、BPM、音量
  const bBand = projectEntryToBandSong(projB.songs[0]);
  const updatedBBand = {
    ...bBand,
    targetBpm: 96,
    keyShiftSemitones: -3,
    masterVolume: 0.45,
    tempoMode: "manual-rate",
    manualRate: 0.8,
  };
  const projBEdited = buildProjectFromBandSongs({
    existingProject: projB,
    songs: [updatedBBand],
    incrementRevision: true,
  });

  assert.equal(projA.songs[0].settings.targetBpm, 132);
  assert.equal(projA.songs[0].settings.keyShiftSemitones, 2);
  assert.equal(projA.songs[0].settings.masterVolume, 0.9);
  assert.equal(projBEdited.songs[0].settings.targetBpm, 96);
  assert.equal(projBEdited.songs[0].settings.keyShiftSemitones, -3);
  assert.equal(projBEdited.songs[0].settings.masterVolume, 0.45);

  // 同一專案可重複加入同一首歌曲兩次並維持各自獨立設定
  const duplicateSecond = {
    ...createBandSong({
      id: "song-b-encore",
      name: "Sunday Worship (Encore)",
      fileName: "sunday.mp3",
      sourceAudioId: "song-b-encore_original",
      settingsKey: "k2",
      originalBpm: 120,
      sourceAudioHash: sharedHash,
      durationSec: 210,
    }),
    targetBpm: 120,
    keyShiftSemitones: 5,
    masterVolume: 0.75,
  };
  const projWithTwo = buildProjectFromBandSongs({
    existingProject: projBEdited,
    songs: [updatedBBand, duplicateSecond],
    incrementRevision: true,
  });
  assert.equal(projWithTwo.songs.length, 2);
  assert.notEqual(projWithTwo.songs[0].entryId, projWithTwo.songs[1].entryId);
  assert.equal(projWithTwo.songs[0].settings.keyShiftSemitones, -3);
  assert.equal(projWithTwo.songs[1].settings.keyShiftSemitones, 5);
});

test("isArtifactRefStrictlyCompatible validates all 8 dimensions, revision, checksums, and 2-stem lineage", () => {
  const expected = {
    manifestFileId: "man-1",
    revisionId: "rev-001",
    sourceAudioHash: "h".repeat(64),
    separationMode: "four_stem",
    modelVersion: "browser-demucs-v1",
    processingVersion: "loop-harmonizer-stems-v2",
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 882000,
    artifactChecksums: { vocals: "sum-v-1" },
  };

  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: expected.modelVersion,
      processingVersion: expected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-001",
      checksumsByRole: { vocals: "sum-v-1" },
    }).compatible,
    true,
  );

  // 任一版本／規格／Checksum／Revision 欄位不符皆拒絕重用
  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: "browser-demucs-v2",
      processingVersion: expected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-001",
    }).compatible,
    false,
  );

  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: expected.modelVersion,
      processingVersion: "loop-harmonizer-stems-v3",
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-001",
    }).compatible,
    false,
  );

  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: expected.modelVersion,
      processingVersion: expected.processingVersion,
      sampleRate: 48000,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-001",
    }).compatible,
    false,
  );

  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: expected.modelVersion,
      processingVersion: expected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-002",
    }).compatible,
    false,
  );

  assert.equal(
    isArtifactRefStrictlyCompatible(expected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: expected.modelVersion,
      processingVersion: expected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-001",
      checksumsByRole: { vocals: "sum-corrupt" },
    }).compatible,
    false,
  );

  // 2 Stem 從 4 Stem 派生時必須驗證 derivedFrom 來源版本，不得混用不同版本人聲與伴奏
  const twoStemDerivedExpected = {
    ...expected,
    separationMode: "two_stem",
    revisionId: "rev-2stem-1",
    derivedFrom: {
      sourceMode: "four_stem",
      sourceRevisionId: "rev-4stem-A",
      modelVersion: "browser-demucs-v1",
      processingVersion: "loop-harmonizer-stems-v2",
    },
  };
  assert.equal(
    isArtifactRefStrictlyCompatible(twoStemDerivedExpected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: "browser-demucs-v1",
      processingVersion: "loop-harmonizer-stems-v2",
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-4stem-A",
    }).compatible,
    true,
  );
  assert.equal(
    isArtifactRefStrictlyCompatible(twoStemDerivedExpected, {
      sourceAudioHash: expected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: "browser-demucs-v1",
      processingVersion: "loop-harmonizer-stems-v2",
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 882000,
      revisionId: "rev-4stem-B",
      derivedFrom: {
        sourceMode: "four_stem",
        sourceRevisionId: "rev-4stem-B",
        modelVersion: "browser-demucs-v1",
        processingVersion: "loop-harmonizer-stems-v2",
      },
    }).compatible,
    false,
  );
});

test("Backup status accurately distinguishes partial backup vs cross-device ready and validates ownerAccountId", () => {
  const baseSettings = {
    displayName: "Track",
    fileName: "track.mp3",
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
    playbackSource: "original",
    separationMode: null,
    stemChannels: [],
  };

  assert.equal(
    computeEntryBackupStatus({
      source: { provider: "local" },
      originalBackup: null,
      artifactRef: null,
      settings: { ...baseSettings, separationMode: "four_stem" },
    }),
    "local_only",
  );

  // 原曲已備份但分軌未備份 -> 不可偽報為 cross_device_ready
  assert.equal(
    computeEntryBackupStatus(
      {
        source: { provider: "local" },
        originalBackup: {
          driveFileId: "orig-1",
          ownerAccountId: "google:acc1",
          fileName: "track.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 1000,
          sourceAudioHash: "h1",
          backedUpAt: "2026-01-01T00:00:00Z",
        },
        artifactRef: {
          revisionId: "local-1",
          sourceAudioHash: "h1",
          separationMode: "four_stem",
          modelVersion: "m1",
          processingVersion: "p1",
          sampleRate: 44100,
          channelCount: 2,
          totalSamples: 44100,
        },
        settings: { ...baseSettings, separationMode: "four_stem" },
      },
      "google:acc1",
    ),
    "original_backed_up",
  );

  // 分軌已備份但本機原曲未備份
  assert.equal(
    computeEntryBackupStatus({
      source: { provider: "local" },
      originalBackup: null,
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
      settings: { ...baseSettings, separationMode: "four_stem" },
    }),
    "stems_backed_up",
  );

  // Drive 原曲 + Drive 分軌 manifest 皆就緒 -> cross_device_ready
  const readyEntry = {
    entryId: "e1",
    sourceAudioHash: "h1",
    source: {
      provider: "google_drive",
      fileId: "drv-src-1",
      authorizedAccountId: "google:acc1",
      fileName: "track.mp3",
      mimeType: "audio/mpeg",
    },
    originalBackup: null,
    displayName: "Track",
    fileName: "track.mp3",
    durationSec: 10,
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
    settings: { ...baseSettings, separationMode: "four_stem" },
  };
  assert.equal(computeEntryBackupStatus(readyEntry, "google:acc1"), "cross_device_ready");

  const summary = computeProjectBackupSummary([readyEntry], "google:acc1");
  assert.equal(summary.crossDeviceReadyCount, 1);
  assert.equal(summary.pendingSyncCount, 0);

  const cloudDoc = createEmptyProject({
    name: "Cloud",
    storageProvider: "google_drive",
    ownerAccountId: "google:acc1",
  });
  assert.equal(validateProjectDocument(cloudDoc, { expectedAccountId: "google:acc1" }).valid, true);
  assert.equal(validateProjectDocument(cloudDoc, { expectedAccountId: "google:acc2" }).valid, false);
});
