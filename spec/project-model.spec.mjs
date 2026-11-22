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
  normalizeArtifactChecksum,
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
  const fullFourChecksums = {
    vocals: "sha256:" + "1".repeat(64),
    drums: "sha256:" + "2".repeat(64),
    bass: "sha256:" + "3".repeat(64),
    other: "sha256:" + "4".repeat(64),
  };
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
    artifactChecksums: fullFourChecksums,
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
      checksumsByRole: fullFourChecksums,
    }).status,
    "verified",
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
      checksumsByRole: fullFourChecksums,
    }).status,
    "incompatible",
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
      checksumsByRole: fullFourChecksums,
    }).status,
    "incompatible",
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
      checksumsByRole: fullFourChecksums,
    }).status,
    "incompatible",
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
      checksumsByRole: fullFourChecksums,
    }).status,
    "incompatible",
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
      checksumsByRole: { ...fullFourChecksums, vocals: "sha256:" + "9".repeat(64) },
    }).status,
    "incompatible",
  );

  // 2 Stem 從 4 Stem 派生時必須驗證 derivedFrom 來源版本與完整 Checksum，不得混用不同版本音軌
  const twoStemChecksums = {
    vocals: "sha256:" + "1".repeat(64),
    instrumental: "sha256:" + "5".repeat(64),
  };
  const twoStemDerivedExpected = {
    ...expected,
    separationMode: "two_stem",
    revisionId: "rev-2stem-1",
    artifactChecksums: twoStemChecksums,
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
      checksumsByRole: twoStemChecksums,
    }).status,
    "verified",
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
      checksumsByRole: twoStemChecksums,
    }).status,
    "incompatible",
  );
});

test("isArtifactRefStrictlyCompatible distinguishes verified, insufficient_evidence, incompatible and preserves local-* legacy path", () => {
  const rawHex = "A".repeat(64);
  assert.equal(normalizeArtifactChecksum(rawHex), "sha256:" + "a".repeat(64));

  const fullFour = {
    vocals: "sha256:" + "a".repeat(64),
    drums: "sha256:" + "b".repeat(64),
    bass: "sha256:" + "c".repeat(64),
    other: "sha256:" + "d".repeat(64),
  };
  const officialExpected = {
    manifestFileId: "man-strict",
    revisionId: "rev-official-1",
    sourceAudioHash: "s".repeat(64),
    separationMode: "four_stem",
    modelVersion: "browser-demucs-v1",
    processingVersion: "loop-harmonizer-stems-v2",
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 441000,
    artifactChecksums: fullFour,
  };

  // 1) expected.artifactChecksums 存在，candidate 缺少 checksumsByRole -> insufficient_evidence
  const missingObj = isArtifactRefStrictlyCompatible(officialExpected, {
    sourceAudioHash: officialExpected.sourceAudioHash,
    separationMode: "four_stem",
    modelVersion: officialExpected.modelVersion,
    processingVersion: officialExpected.processingVersion,
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 441000,
    revisionId: "rev-official-1",
  });
  assert.equal(missingObj.compatible, false);
  assert.equal(missingObj.status, "insufficient_evidence");
  assert.equal(missingObj.canAttemptRecomputeVerification, true);

  // 2) candidate 缺少任一必要角色 (bass/other) -> 不得回傳 compatible=true
  const missingRole = isArtifactRefStrictlyCompatible(officialExpected, {
    sourceAudioHash: officialExpected.sourceAudioHash,
    separationMode: "four_stem",
    modelVersion: officialExpected.modelVersion,
    processingVersion: officialExpected.processingVersion,
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 441000,
    revisionId: "rev-official-1",
    checksumsByRole: { vocals: fullFour.vocals, drums: fullFour.drums },
  });
  assert.equal(missingRole.compatible, false);
  assert.equal(missingRole.status, "insufficient_evidence");
  assert.ok(missingRole.missingChecksumRoles?.includes("bass"));

  // 3) 缺少某些角色同時另一個角色 checksum 不一致 -> 優先回報 incompatible
  const corruptAndMissing = isArtifactRefStrictlyCompatible(officialExpected, {
    sourceAudioHash: officialExpected.sourceAudioHash,
    separationMode: "four_stem",
    modelVersion: officialExpected.modelVersion,
    processingVersion: officialExpected.processingVersion,
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 441000,
    revisionId: "rev-official-1",
    checksumsByRole: { vocals: "sha256:" + "f".repeat(64) },
  });
  assert.equal(corruptAndMissing.compatible, false);
  assert.equal(corruptAndMissing.status, "incompatible");

  // 4) 純 hex 大小寫正規化比對通過 -> verified
  const normalizedPass = isArtifactRefStrictlyCompatible(officialExpected, {
    sourceAudioHash: officialExpected.sourceAudioHash,
    separationMode: "four_stem",
    modelVersion: officialExpected.modelVersion,
    processingVersion: officialExpected.processingVersion,
    sampleRate: 44100,
    channelCount: 2,
    totalSamples: 441000,
    revisionId: "rev-official-1",
    checksumsByRole: {
      vocals: rawHex,
      drums: "b".repeat(64),
      bass: "c".repeat(64),
      other: "d".repeat(64),
    },
  });
  assert.equal(normalizedPass.compatible, true);
  assert.equal(normalizedPass.status, "verified");

  // 5) 2-stem 同為 two_stem 但官方來源缺少 derivedFrom.sourceRevisionId（且無完整 checksum）-> insufficient_evidence
  const twoStemNoDerivedEvidence = isArtifactRefStrictlyCompatible(
    {
      ...officialExpected,
      separationMode: "two_stem",
      revisionId: "rev-2stem-official",
      artifactChecksums: undefined,
      derivedFrom: {
        sourceMode: "four_stem",
        sourceRevisionId: "rev-4stem-A",
        modelVersion: "browser-demucs-v1",
        processingVersion: "loop-harmonizer-stems-v2",
      },
    },
    {
      sourceAudioHash: officialExpected.sourceAudioHash,
      separationMode: "two_stem",
      modelVersion: officialExpected.modelVersion,
      processingVersion: officialExpected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 441000,
      revisionId: "rev-2stem-official",
      checksumsByRole: {
        vocals: "sha256:" + "1".repeat(64),
        instrumental: "sha256:" + "2".repeat(64),
      },
      derivedFrom: null,
    },
  );
  assert.equal(twoStemNoDerivedEvidence.compatible, false);
  assert.equal(twoStemNoDerivedEvidence.status, "insufficient_evidence");

  // 6) 舊版 local-*本機版本保留無 checksums 的相容路徑 -> verified
  const legacyLocal = isArtifactRefStrictlyCompatible(
    {
      revisionId: "local-task_123",
      sourceAudioHash: officialExpected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: officialExpected.modelVersion,
      processingVersion: officialExpected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 441000,
    },
    {
      sourceAudioHash: officialExpected.sourceAudioHash,
      separationMode: "four_stem",
      modelVersion: officialExpected.modelVersion,
      processingVersion: officialExpected.processingVersion,
      sampleRate: 44100,
      channelCount: 2,
      totalSamples: 441000,
      revisionId: "local-task_123",
    },
  );
  assert.equal(legacyLocal.compatible, true);
  assert.equal(legacyLocal.status, "verified");
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

test("projectEntryToBandSong formats long local-* revisionId as concise user-facing ready message", () => {
  const restored = projectEntryToBandSong(
    {
      entryId: "e-local",
      sourceAudioHash: "c".repeat(64),
      source: { provider: "local", fileName: "song.mp3" },
      originalBackup: null,
      displayName: "Song",
      fileName: "song.mp3",
      durationSec: 120,
      order: 0,
      artifactRef: {
        revisionId: `local-sep:song_1794640394595_3zr89p:${"a".repeat(64)}:demucs-v1:loop-harmonizer-stems-v2:r1794700415429_lit2o`,
        sourceAudioHash: "c".repeat(64),
        separationMode: "four_stem",
        modelVersion: "browser-demucs-v1",
        processingVersion: "loop-harmonizer-stems-v2",
        sampleRate: 44100,
        channelCount: 2,
        totalSamples: 882000,
        localTaskId: "sep-task-1",
      },
      settings: {
        displayName: "Song",
        fileName: "song.mp3",
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
        stemChannels: [
          { stemType: "vocals", volume: 1, muted: false, solo: false },
          { stemType: "drums", volume: 1, muted: false, solo: false },
        ],
      },
    },
    {
      localStemsReady: true,
      localTaskId: "sep-task-1",
    },
  );
  assert.equal(restored.separationMessage, "已依專案本機分軌版本就緒");
  assert.equal(restored.separationMessage.includes("local-sep:"), false);
  assert.equal(restored.artifactRef?.revisionId.startsWith("local-sep:"), true);
});
