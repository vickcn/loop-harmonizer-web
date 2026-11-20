import test from "node:test";
import assert from "node:assert/strict";
import { encodeStereoWav } from "../lib/separation/wavEncoder.ts";
import {
  assessProjectOfflineDownload,
  downloadEntireProjectOffline,
  projectToBandSongsMetadataOnly,
  restoreSingleProjectSongOnDemand,
} from "../lib/projects/projectRestoreManager.ts";
import { computeSha256HexSync } from "../lib/audio/chunkedWavExporter.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION } from "../lib/storage/cacheKeys.ts";
import { configureInMemoryIdbForTests, idbGet, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { saveImportedStemsAtomically } from "../lib/storage/importedStemStore.ts";
import { DEMUCS_SAMPLE_RATE, DEMUCS_STRIDE_SAMPLES, computeBufferChecksum, createChunkKey, packChunkStemsToBuffer } from "../lib/storage/separationChunkStore.ts";
import { hashSourceAudio } from "../lib/storage/separationCache.ts";

function createWavBinary(samples = 4410, freqOffset = 1) {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    left[i] = Math.sin((i + 1) * 0.01 * freqOffset) * 0.25;
    right[i] = Math.cos((i + 1) * 0.01 * freqOffset) * 0.25;
  }
  return new Uint8Array(encodeStereoWav(left, right, DEMUCS_SAMPLE_RATE));
}

test("Opening a 10-song project fetches metadata only; single song restore downloads only missing revision and applies project settings over session.json", async () => {
  configureInMemoryIdbForTests();
  try {
    const sampleCount = 4410;
    const origBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const origHash = await hashSourceAudio(new Blob([origBytes]));
    const vocalsWav = createWavBinary(sampleCount, 1);
    const drumsWav = createWavBinary(sampleCount, 2);
    const bassWav = createWavBinary(sampleCount, 3);
    const otherWav = createWavBinary(sampleCount, 4);

    // 在本機預先植入錯誤版本 revision-002，確認專案指定 revision-001 時不會誤用本機 revision-002！
    const wrongPayload = packChunkStemsToBuffer(
      {
        vocals: { left: new Float32Array(sampleCount), right: new Float32Array(sampleCount) },
        drums: { left: new Float32Array(sampleCount), right: new Float32Array(sampleCount) },
        bass: { left: new Float32Array(sampleCount), right: new Float32Array(sampleCount) },
        other: { left: new Float32Array(sampleCount), right: new Float32Array(sampleCount) },
      },
      sampleCount,
    );
    await saveImportedStemsAtomically({
      record: {
        key: "imp-rev-002",
        importId: "imp-rev-002",
        ownerAccountId: "google:acc1",
        sourceAudioHash: origHash,
        revisionId: "revision-002",
        manifestFileId: "man-rev-002",
        requestedMode: "four_stem",
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        sampleRate: DEMUCS_SAMPLE_RATE,
        channelCount: 2,
        totalSamples: sampleCount,
        strideSamples: DEMUCS_STRIDE_SAMPLES,
        totalChunks: 1,
        committedBytes: wrongPayload.byteLength,
        pcmFormat: "wav-pcm16",
        stemLayout: "four_stem",
        referencedBySongIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chunks: [
        {
          key: createChunkKey("imp-rev-002", 0),
          taskId: "imp-rev-002",
          chunkIndex: 0,
          startSample: 0,
          endSample: sampleCount,
          modelVersion: DEMUCS_MODEL_VERSION,
          processingVersion: SEPARATION_PROCESSING_VERSION,
          separationMode: "four_stem",
          sampleRate: DEMUCS_SAMPLE_RATE,
          stemCount: 4,
          payload: wrongPayload,
          checksum: computeBufferChecksum(wrongPayload),
          sizeBytes: wrongPayload.byteLength,
          createdAt: Date.now(),
        },
      ],
    });

    const manifest001 = {
      schemaVersion: 1,
      application: "loop-harmonizer",
      songId: "song-s1",
      songName: "Song 1",
      stableSongKey: `song_${origHash.slice(0, 12)}`,
      revisionId: "revision-001",
      ownerAccountId: "google:acc1",
      source: {
        provider: "google_drive",
        fileId: "orig-file-1",
        fileName: "song1.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: origBytes.byteLength,
        sourceAudioHash: origHash,
      },
      separation: {
        mode: "four_stem",
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        sampleRate: DEMUCS_SAMPLE_RATE,
        channelCount: 2,
        totalSamples: sampleCount,
        format: "wav-pcm16",
      },
      artifacts: {
        vocals: { fileId: "wav-v-1", fileName: "vocals.wav", sizeBytes: vocalsWav.byteLength, mimeType: "audio/wav", checksum: computeSha256HexSync(vocalsWav) },
        drums: { fileId: "wav-d-1", fileName: "drums.wav", sizeBytes: drumsWav.byteLength, mimeType: "audio/wav", checksum: computeSha256HexSync(drumsWav) },
        bass: { fileId: "wav-b-1", fileName: "bass.wav", sizeBytes: bassWav.byteLength, mimeType: "audio/wav", checksum: computeSha256HexSync(bassWav) },
        other: { fileId: "wav-o-1", fileName: "other.wav", sizeBytes: otherWav.byteLength, mimeType: "audio/wav", checksum: computeSha256HexSync(otherWav) },
      },
      sessionFileId: "sess-1",
      status: "completed",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const driveObjects = new Map([
      ["man-rev-001", { meta: { id: "man-rev-001", name: "manifest.json", mimeType: "application/json", appProperties: { lhApp: "loop-harmonizer", lhAccountId: "google:acc1" } }, json: manifest001 }],
      ["sess-1", { meta: { id: "sess-1", name: "session.json", mimeType: "application/json" }, json: { schemaVersion: 1, application: "loop-harmonizer", songId: "song-s1", name: "Global Session Name", fileName: "song1.mp3", originalBpm: 120, targetBpm: 120, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0, savedRates: [1], keyShiftSemitones: 0, masterVolume: 1, muted: false, loop: false, playbackSource: "original", separationMode: "four_stem", stemChannels: [], updatedAt: "2026-01-01T00:00:00Z" } }],
      ["orig-file-1", { meta: { id: "orig-file-1", name: "song1.mp3", mimeType: "audio/mpeg", size: String(origBytes.byteLength), capabilities: { canDownload: true } }, binary: origBytes }],
      ["wav-v-1", { meta: { id: "wav-v-1", name: "vocals.wav", mimeType: "audio/wav", size: String(vocalsWav.byteLength) }, binary: vocalsWav }],
      ["wav-d-1", { meta: { id: "wav-d-1", name: "drums.wav", mimeType: "audio/wav", size: String(drumsWav.byteLength) }, binary: drumsWav }],
      ["wav-b-1", { meta: { id: "wav-b-1", name: "bass.wav", mimeType: "audio/wav", size: String(bassWav.byteLength) }, binary: bassWav }],
      ["wav-o-1", { meta: { id: "wav-o-1", name: "other.wav", mimeType: "audio/wav", size: String(otherWav.byteLength) }, binary: otherWav }],
    ]);

    const downloadedIds = [];
    const fetchImpl = async (url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const u = new URL(String(url));
      if (u.pathname.startsWith("/drive/v3/files/")) {
        const id = decodeURIComponent(u.pathname.split("/").pop());
        const item = driveObjects.get(id);
        if (!item) return new Response("Not Found", { status: 404 });
        if (u.searchParams.get("alt") === "media") {
          downloadedIds.push(id);
          if (item.json) return new Response(JSON.stringify(item.json), { status: 200 });
          return new Response(item.binary, { status: 200, headers: { "content-length": String(item.binary.byteLength) } });
        }
        return new Response(JSON.stringify(item.meta), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    // 建構包含 10 首歌曲的雲端專案（第 0 首指定 revision-001 且混音設定與 session.json 不同）
    const songs = Array.from({ length: 10 }, (_, idx) => ({
      entryId: `entry-${idx + 1}`,
      sourceAudioHash: idx === 0 ? origHash : `hash-${idx + 1}`,
      source: {
        provider: "google_drive",
        fileId: idx === 0 ? "orig-file-1" : `orig-file-${idx + 1}`,
        authorizedAccountId: "google:acc1",
        fileName: `song${idx + 1}.mp3`,
        mimeType: "audio/mpeg",
        sizeBytes: 1000,
      },
      originalBackup: null,
      displayName: `Song ${idx + 1}`,
      fileName: `song${idx + 1}.mp3`,
      durationSec: 10,
      order: idx,
      artifactRef: {
        manifestFileId: idx === 0 ? "man-rev-001" : `man-${idx + 1}`,
        revisionId: "revision-001",
        sourceAudioHash: idx === 0 ? origHash : `hash-${idx + 1}`,
        separationMode: "four_stem",
        modelVersion: DEMUCS_MODEL_VERSION,
        processingVersion: SEPARATION_PROCESSING_VERSION,
        sampleRate: DEMUCS_SAMPLE_RATE,
        channelCount: 2,
        totalSamples: sampleCount,
        pcmFormat: "wav-pcm16",
      },
      settings: {
        displayName: idx === 0 ? "Song 1 Custom Mix" : `Song ${idx + 1}`,
        fileName: `song${idx + 1}.mp3`,
        originalBpm: 120,
        targetBpm: idx === 0 ? 136 : 120,
        tempoMode: "target-bpm",
        manualRate: 1,
        fineRateOffset: 0,
        savedRates: [1],
        keyShiftSemitones: idx === 0 ? 4 : 0,
        masterVolume: idx === 0 ? 0.72 : 1,
        muted: false,
        loop: idx === 0,
        playbackSource: "stems",
        separationMode: "four_stem",
        stemChannels: [{ stemType: "vocals", volume: 0.4, muted: false, solo: false }],
      },
    }));

    const project = {
      schemaVersion: 1,
      application: "loop-harmonizer",
      projectId: "proj-10-songs",
      name: "Large Setlist",
      storageProvider: "google_drive",
      ownerAccountId: "google:acc1",
      revision: 1,
      revisionToken: "r1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      masterSettings: {},
      songs,
    };

    // 開啟 10 首歌曲專案：僅 metadata，不下載任何檔案、不誤用 revision-002，所有歌曲呈 cloud_not_downloaded
    const metadataBandSongs = await projectToBandSongsMetadataOnly(project, {
      currentAccountId: "google:acc1",
      hasValidGoogleToken: true,
    });
    assert.equal(metadataBandSongs.length, 10);
    assert.equal(metadataBandSongs[0].availabilityState, "cloud_not_downloaded");
    assert.equal(downloadedIds.length, 0);

    // 點擊第 1 首歌按需恢復：僅下載第 1 首指定 revision-001 與原曲，保留專案設定覆寫 session.json
    const restored = await restoreSingleProjectSongOnDemand({
      project,
      entry: songs[0],
      accountId: "google:acc1",
      accessToken: "token-1",
      generation: 1,
      isGenerationValid: () => true,
      includeOriginalAudio: true,
      fetchImpl,
    });
    assert.equal(restored.restoredStems, true);
    assert.equal(restored.restoredOriginal, true);
    assert.equal(restored.importedStemRecord?.revisionId, "revision-001");
    assert.notEqual(restored.importedStemRecord?.importId, "imp-rev-002");
    assert.equal(restored.song.keyShiftSemitones, 4);
    assert.equal(restored.song.targetBpm, 136);
    assert.equal(restored.song.masterVolume, 0.72);
    assert.equal(restored.song.loop, true);
    assert.ok(await idbGet("audioFiles", origHash));
    // 其餘 9 首完全沒有下載
    assert.equal(downloadedIds.some((id) => id.includes("orig-file-2") || id.includes("man-2")), false);

    // 離線容量評估與逐首下載取消測試
    const smallProject = { ...project, songs: songs.slice(0, 2) };
    const assessment = await assessProjectOfflineDownload({
      project: smallProject,
      accountId: "google:acc1",
      accessToken: "token-1",
      fetchImpl,
    });
    // 第一首已在剛剛恢復完畢，應算 alreadyLocalCount=1
    assert.equal(assessment.alreadyLocalCount, 1);

    const abortController = new AbortController();
    const dlRes = await downloadEntireProjectOffline({
      project: smallProject,
      accountId: "google:acc1",
      accessToken: "token-1",
      generation: 1,
      isGenerationValid: () => true,
      signal: abortController.signal,
      fetchImpl,
      onProgress: (p) => {
        if (p.completedSongs === 1) abortController.abort();
      },
    });
    assert.equal(dlRes.completedCount, 1);
    assert.equal(dlRes.cancelled, true);
  } finally {
    resetInMemoryIdbForTests();
  }
});
