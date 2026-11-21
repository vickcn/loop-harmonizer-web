import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWavTotalBytes,
  createChunkedStemWavSource,
  decodeWavSampleRange,
  parseWavHeader,
  validateChunksForExport,
} from "../lib/audio/chunkedWavExporter.ts";
import {
  DRIVE_RESUMABLE_CHUNK_ALIGNMENT,
  alignUploadChunkSize,
  clearResumableSessionUrisForAccount,
  getActiveResumableSessionCountForTests,
  parseDriveRangeHeader,
  queryResumableUploadStatus,
  uploadChunkedResumable,
} from "../lib/google/driveResumableUpload.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  computeBufferChecksum,
  createChunkKey,
  getChunkSampleBounds,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  deleteAllIncompleteCheckpoints,
  getCheckpoint,
  releaseCheckpointReferenceAndMaybeGc,
  runCheckpointGarbageCollection,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  pinTaskForDriveTransfer,
  unpinTaskForDriveTransfer,
} from "../lib/storage/driveTransferStore.ts";

function buildDeterministicChunkMap({
  taskId,
  totalSamples,
  strideSamples,
  includeAmplitudeAboveOne = false,
}) {
  const chunks = new Map();
  const totalChunks = Math.ceil(totalSamples / strideSamples);
  for (let c = 0; c < totalChunks; c += 1) {
    const bounds = getChunkSampleBounds(c, totalSamples, strideSamples);
    const makeStereo = (stemOffset) => {
      const left = new Float32Array(bounds.frameCount);
      const right = new Float32Array(bounds.frameCount);
      for (let i = 0; i < bounds.frameCount; i += 1) {
        const globalIdx = bounds.startSample + i;
        let lVal = Math.sin((globalIdx + 1) * 0.01 * (stemOffset + 1)) * 0.4;
        let rVal = Math.cos((globalIdx + 1) * 0.01 * (stemOffset + 1)) * 0.4;
        if (includeAmplitudeAboveOne && globalIdx === 0 && stemOffset === 0) {
          lVal = 1.65;
          rVal = -1.65;
        }
        left[i] = lVal;
        right[i] = rVal;
      }
      return { left, right };
    };
    const stems = {
      vocals: makeStereo(0),
      drums: makeStereo(1),
      bass: makeStereo(2),
      other: makeStereo(3),
    };
    const payload = packChunkStemsToBuffer(stems, bounds.frameCount);
    chunks.set(c, {
      key: createChunkKey(taskId, c),
      taskId,
      chunkIndex: c,
      startSample: bounds.startSample,
      endSample: bounds.endSample,
      modelVersion: "browser-demucs-v1",
      processingVersion: "loop-harmonizer-stems-v2",
      separationMode: "four_stem",
      sampleRate: DEMUCS_SAMPLE_RATE,
      stemCount: 4,
      payload,
      checksum: computeBufferChecksum(payload),
      sizeBytes: payload.byteLength,
      createdAt: 1_700_000_000_000,
    });
  }
  return { chunks, totalChunks };
}

async function readFullWavBytes(source) {
  const out = new Uint8Array(source.totalBytes);
  const step = 1024;
  for (let pos = 0; pos < source.totalBytes; pos += step) {
    const end = Math.min(source.totalBytes, pos + step);
    const part = await source.readSlice(pos, end);
    out.set(part, pos);
  }
  return out;
}

test("chunkedWavExporter outputs valid 2-stem & 4-stem WAVs with exact chunk boundaries and sliding window reads", async () => {
  const totalSamples = 700;
  const strideSamples = 256; // chunks: 256 + 256 + 188
  const { chunks, totalChunks } = buildDeterministicChunkMap({
    taskId: "task_wav_1",
    totalSamples,
    strideSamples,
    includeAmplitudeAboveOne: true,
  });

  const validated = await validateChunksForExport({
    taskId: "task_wav_1",
    totalSamples,
    totalChunks,
    strideSamples,
    loadChunk: async (_tid, idx) => chunks.get(idx) ?? null,
  });
  assert.equal(validated.totalSamples, totalSamples);
  assert.equal(validated.totalChunks, 3);

  // Float32 4-stem vocals + sliding window load counting
  let loadChunkCalls = 0;
  let activeLoads = 0;
  let maxConcurrentLoads = 0;
  const loadedIndicesPerSlice = [];
  let sliceObservedIndices = new Set();

  const vocalsFloatSource = createChunkedStemWavSource({
    taskId: "task_wav_1",
    role: "vocals",
    totalSamples,
    strideSamples,
    format: "wav-float32",
    loadChunk: async (_tid, idx) => {
      loadChunkCalls += 1;
      activeLoads += 1;
      maxConcurrentLoads = Math.max(maxConcurrentLoads, activeLoads);
      sliceObservedIndices.add(idx);
      await Promise.resolve();
      activeLoads -= 1;
      return chunks.get(idx) ?? null;
    },
  });

  assert.equal(vocalsFloatSource.totalBytes, computeWavTotalBytes(totalSamples, "wav-float32", 2));
  const floatBytes = new Uint8Array(vocalsFloatSource.totalBytes);
  const sliceLen = 512;
  for (let pos = 0; pos < vocalsFloatSource.totalBytes; pos += sliceLen) {
    sliceObservedIndices = new Set();
    const end = Math.min(vocalsFloatSource.totalBytes, pos + sliceLen);
    floatBytes.set(await vocalsFloatSource.readSlice(pos, end), pos);
    loadedIndicesPerSlice.push(sliceObservedIndices.size);
  }

  assert.equal(maxConcurrentLoads, 1);
  // Each small slice loads at most 1 chunk (or 2 when straddling a chunk boundary), never all 3 at once
  assert.equal(loadedIndicesPerSlice.every((count) => count <= 2), true);
  assert.ok(loadChunkCalls > 0);

  const floatHeader = parseWavHeader(floatBytes);
  assert.equal(floatHeader.audioFormat, 3);
  assert.equal(floatHeader.pcmFormat, "wav-float32");
  assert.equal(floatHeader.bitsPerSample, 32);
  assert.equal(floatHeader.sampleRate, DEMUCS_SAMPLE_RATE);
  assert.equal(floatHeader.channelCount, 2);
  assert.equal(floatHeader.totalSamples, totalSamples);

  // Decode samples across chunk boundaries and compare exact Float32 values
  const decodedVocals = decodeWavSampleRange(floatBytes, floatHeader, 0, totalSamples);
  assert.equal(decodedVocals.left.length, totalSamples);
  assert.ok(Math.abs(decodedVocals.left[0] - 1.65) < 1e-5);
  assert.ok(Math.abs(decodedVocals.left[256] - Math.sin(257 * 0.01) * 0.4) < 1e-5);

  // PCM16 clips values > 1.0 or < -1.0 safely without overflow
  const pcm16VocalsSource = createChunkedStemWavSource({
    taskId: "task_wav_1",
    role: "vocals",
    totalSamples,
    strideSamples,
    format: "wav-pcm16",
    loadChunk: async (_tid, idx) => chunks.get(idx) ?? null,
  });
  const pcm16Bytes = await readFullWavBytes(pcm16VocalsSource);
  const pcm16Header = parseWavHeader(pcm16Bytes);
  assert.equal(pcm16Header.audioFormat, 1);
  assert.equal(pcm16Header.pcmFormat, "wav-pcm16");
  assert.equal(pcm16Header.bitsPerSample, 16);
  const decodedPcm16 = decodeWavSampleRange(pcm16Bytes, pcm16Header, 0, 10);
  assert.ok(decodedPcm16.left[0] <= 1.0 && decodedPcm16.left[0] > 0.99);
  assert.equal(decodedPcm16.right[0], -1.0);

  // 2-stem instrumental sums drums + bass + other in standard four_stem storage
  const instFourSource = createChunkedStemWavSource({
    taskId: "task_wav_1",
    role: "instrumental",
    totalSamples,
    strideSamples,
    format: "wav-float32",
    stemLayout: "four_stem",
    loadChunk: async (_tid, idx) => chunks.get(idx) ?? null,
  });
  const instFourBytes = await readFullWavBytes(instFourSource);
  const decodedInst = decodeWavSampleRange(instFourBytes, parseWavHeader(instFourBytes), 255, 258);
  for (let i = 0; i < 3; i += 1) {
    const g = 255 + i;
    const expected =
      Math.sin((g + 1) * 0.02) * 0.4 +
      Math.sin((g + 1) * 0.03) * 0.4 +
      Math.sin((g + 1) * 0.04) * 0.4;
    assert.ok(Math.abs(decodedInst.left[i] - expected) < 1e-5);
  }

  // two_stem_direct reads slot 1 (drums field) directly without re-summing bass/other
  const instDirectSource = createChunkedStemWavSource({
    taskId: "task_wav_1",
    role: "instrumental",
    totalSamples,
    strideSamples,
    format: "wav-float32",
    stemLayout: "two_stem_direct",
    loadChunk: async (_tid, idx) => chunks.get(idx) ?? null,
  });
  const instDirectBytes = await readFullWavBytes(instDirectSource);
  const decodedDirect = decodeWavSampleRange(instDirectBytes, parseWavHeader(instDirectBytes), 10, 12);
  assert.ok(Math.abs(decodedDirect.left[0] - Math.sin(11 * 0.02) * 0.4) < 1e-5);

  // Missing chunk throws clear integrity error
  await assert.rejects(
    () =>
      validateChunksForExport({
        taskId: "task_wav_1",
        totalSamples,
        totalChunks,
        strideSamples,
        loadChunk: async (_tid, idx) => (idx === 1 ? null : chunks.get(idx) ?? null),
      }),
    /找不到第 2\/3 段/,
  );
});

test("Resumable Upload handles 256 KiB alignment, HTTP 308 Range resume, pause->probe resume, 401, retry cap, 404/410 rebuild, dedup, and cancel", async () => {
  configureInMemoryIdbForTests();
  clearResumableSessionUrisForAccount();

  const totalBytes = 600_000; // > 2 * 256 KiB (3 upload PUT chunks)
  const payload = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i += 1) payload[i] = i & 0xff;
  const source = {
    totalBytes,
    readSlice: async (start, end) => payload.subarray(start, end),
  };

  assert.equal(alignUploadChunkSize(1000), DRIVE_RESUMABLE_CHUNK_ALIGNMENT);
  assert.equal(alignUploadChunkSize(500_000), DRIVE_RESUMABLE_CHUNK_ALIGNMENT);
  assert.equal(parseDriveRangeHeader("bytes=0-262143"), 262144);

  try {
    // 1) Pause after chunk 0 (HTTP 308) -> query server offset -> resume and complete 200
    let sessionServerBytes = new Uint8Array(totalBytes);
    let confirmedLen = 0;
    let putCount = 0;
    let probeCount = 0;
    let pauseAfterFirstChunk = true;

    const fakeFetchPauseThenResume = async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && u.includes("/drive/v3/files")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (method === "POST" && u.includes("uploadType=resumable")) {
        return new Response("", {
          status: 200,
          headers: { location: "https://upload.example.com/session-1" },
        });
      }
      if (method === "PUT" && u === "https://upload.example.com/session-1") {
        const cr = String(init?.headers?.["Content-Range"] ?? "");
        if (cr.startsWith("bytes */")) {
          probeCount += 1;
          return new Response("", {
            status: 308,
            headers: { range: `bytes=0-${confirmedLen - 1}` },
          });
        }
        putCount += 1;
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
        const start = Number(m[1]);
        const end = Number(m[2]);
        const body = init.body;
        assert.equal(body.byteLength, end - start + 1);
        sessionServerBytes.set(body, start);
        confirmedLen = Math.max(confirmedLen, end + 1);
        if (confirmedLen >= totalBytes) {
          return new Response(
            JSON.stringify({ id: "remote_wav_1", size: String(totalBytes), md5Checksum: "abc" }),
            { status: 200 },
          );
        }
        return new Response("", {
          status: 308,
          headers: { range: `bytes=0-${confirmedLen - 1}` },
        });
      }
      return new Response("Unhandled", { status: 500 });
    };

    const pausedRes = await uploadChunkedResumable({
      jobId: "job_1",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      chunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGNMENT,
      isPauseRequested: () => pauseAfterFirstChunk && putCount >= 1,
      fetchImpl: fakeFetchPauseThenResume,
      sleepImpl: async () => {},
    });
    assert.equal(pausedRes.status, "paused");
    assert.equal(pausedRes.job.confirmedUploadedBytes, DRIVE_RESUMABLE_CHUNK_ALIGNMENT);

    // Now resume with same jobId -> must probe server offset and upload remaining bytes without restarting at 0
    pauseAfterFirstChunk = false;
    const completedRes = await uploadChunkedResumable({
      jobId: "job_1",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      chunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGNMENT,
      fetchImpl: fakeFetchPauseThenResume,
      sleepImpl: async () => {},
    });
    assert.equal(completedRes.status, "completed");
    assert.equal(completedRes.remoteFileId, "remote_wav_1");
    assert.equal(probeCount, 1);
    assert.deepEqual(sessionServerBytes, payload);

    // 2) Duplicate prevention: if target folder already holds completed matching file, do NOT re-upload
    let uploadPostCalled = false;
    const dedupRes = await uploadChunkedResumable({
      jobId: "job_dedup",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      fetchImpl: async (url, init) => {
        if ((init?.method ?? "GET") === "GET") {
          return new Response(
            JSON.stringify({
              files: [{ id: "existing_remote_wav", name: "vocals.wav", size: String(totalBytes) }],
            }),
            { status: 200 },
          );
        }
        uploadPostCalled = true;
        return new Response("Should not upload", { status: 500 });
      },
    });
    assert.equal(dedupRes.status, "completed");
    assert.equal(dedupRes.remoteFileId, "existing_remote_wav");
    assert.equal(uploadPostCalled, false);

    // 3) 401 waiting_auth triggers onAuthExpired
    let authExpiredTriggered = false;
    const authRes = await uploadChunkedResumable({
      jobId: "job_401",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "drums",
      fileName: "drums.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "expired-t",
      onAuthExpired: () => { authExpiredTriggered = true; },
      fetchImpl: async (url, init) => {
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ files: [] }), { status: 200 });
        if ((init?.method ?? "GET") === "POST") {
          return new Response("", { status: 200, headers: { location: "https://upload.example.com/s401" } });
        }
        return new Response("Unauthorized", { status: 401 });
      },
      sleepImpl: async () => {},
    });
    assert.equal(authRes.status, "waiting_auth");
    assert.equal(authExpiredTriggered, true);

    // 4) 503 respects maxRetries and stops cleanly
    let putAttempts503 = 0;
    const retryCapRes = await uploadChunkedResumable({
      jobId: "job_503",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "bass",
      fileName: "bass.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      maxRetries: 2,
      fetchImpl: async (_url, init) => {
        const m = (init?.method ?? "GET").toUpperCase();
        if (m === "GET") return new Response(JSON.stringify({ files: [] }), { status: 200 });
        if (m === "POST") return new Response("", { status: 200, headers: { location: "https://upload.example.com/s503" } });
        const cr = String(init?.headers?.["Content-Range"] ?? "");
        if (!cr.startsWith("bytes */")) {
          putAttempts503 += 1;
        }
        return new Response("Service Unavailable", { status: 503 });
      },
      sleepImpl: async () => {},
    });
    assert.equal(retryCapRes.status, "failed");
    assert.equal(putAttempts503, 3); // initial attempt + 2 retries

    // 5) HTTP 404/410 session expiry rebuilds session once and finishes cleanly
    let sessionRebuilds = 0;
    const rebuiltRes = await uploadChunkedResumable({
      jobId: "job_410",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "other",
      fileName: "other.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      chunkSizeBytes: 1024 * 1024, // single chunk PUT > 600_000
      fetchImpl: async (url, init) => {
        const m = (init?.method ?? "GET").toUpperCase();
        if (m === "GET") return new Response(JSON.stringify({ files: [] }), { status: 200 });
        if (m === "POST") {
          sessionRebuilds += 1;
          return new Response("", {
            status: 200,
            headers: { location: `https://upload.example.com/s410-${sessionRebuilds}` },
          });
        }
        if (String(url).endsWith("s410-1")) {
          return new Response("Gone", { status: 410 });
        }
        return new Response(JSON.stringify({ id: "rebuilt_ok", size: String(totalBytes) }), { status: 200 });
      },
      sleepImpl: async () => {},
    });
    assert.equal(rebuiltRes.status, "completed");
    assert.equal(rebuiltRes.remoteFileId, "rebuilt_ok");
    assert.equal(sessionRebuilds, 2);

    // 6) Cancelled upload clears active session URI and does not auto-resume
    clearResumableSessionUrisForAccount();
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const cancelledRes = await uploadChunkedResumable({
      jobId: "job_cancel",
      songId: "s1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "h1",
      revisionId: "rev1",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "folder_stems",
      source,
      accessToken: "t1",
      signal: abortCtrl.signal,
      fetchImpl: async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ files: [] }), { status: 200 });
        return new Response("", { status: 200, headers: { location: "https://upload.example.com/scancel" } });
      },
    });
    assert.equal(cancelledRes.status, "cancelled");
    assert.equal(getActiveResumableSessionCountForTests(), 0);

    // Direct status probe helper test for queryResumableUploadStatus
    const probe410 = await queryResumableUploadStatus({
      sessionUri: "https://upload.example.com/dead",
      totalBytes,
      accessToken: "t1",
      fetchImpl: async () => new Response("", { status: 410 }),
    });
    assert.equal(probe410.status, "expired");
  } finally {
    clearResumableSessionUrisForAccount();
    resetInMemoryIdbForTests();
  }
});

test("pinTaskForDriveTransfer protects in-use chunks from GC and deleteAllIncompleteCheckpoints", async () => {
  configureInMemoryIdbForTests();
  try {
    const taskId = "task_pin_test";
    const totalSamples = 512;
    const strideSamples = 512;
    const { chunks } = buildDeterministicChunkMap({ taskId, totalSamples, strideSamples });
    const cp = buildInitialCheckpoint({
      taskId,
      songId: "song_pin",
      sourceAudioHash: "hash_pin",
      requestedMode: "four_stem",
      totalSamples,
    });
    cp.totalChunks = 1;
    await commitChunkAndCheckpointAtomically; // keep static check happy
    const { saveCheckpoint } = await import("../lib/storage/separationCheckpointStore.ts");
    await saveCheckpoint({ ...cp, totalChunks: 1, strideSamples });
    const chunkRec = chunks.get(0);
    await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: 0,
      startSample: chunkRec.startSample,
      endSample: chunkRec.endSample,
      payload: chunkRec.payload,
      overlapCarryBuffer: null,
    });
    await updateCheckpointStatus(taskId, { status: "completed" });

    pinTaskForDriveTransfer(taskId, "transfer_1");

    // Attempt release & GC while pinned -> checkpoint and chunks MUST stay intact
    await releaseCheckpointReferenceAndMaybeGc({
      taskId,
      songId: "song_pin",
      knownInMemorySongs: [],
      knownRemovedSongIds: new Set(["song_pin"]),
      source: "test-pinned",
    });
    await runCheckpointGarbageCollection({
      knownInMemorySongs: [],
      knownRemovedSongIds: new Set(["song_pin"]),
      source: "test-pinned-gc",
    });
    assert.ok(await getCheckpoint(taskId));

    // Also test incomplete checkpoint protection under deleteAllIncompleteCheckpoints
    await updateCheckpointStatus(taskId, { status: "paused", allowDowngradeCompleted: true });
    await deleteAllIncompleteCheckpoints();
    assert.ok(await getCheckpoint(taskId));

    // Unpin and GC -> safely cleaned up
    unpinTaskForDriveTransfer(taskId, "transfer_1");
    await runCheckpointGarbageCollection({
      knownInMemorySongs: [],
      knownRemovedSongIds: new Set(["song_pin"]),
      source: "test-unpinned-gc",
    });
    assert.equal(await getCheckpoint(taskId), null);
  } finally {
    resetInMemoryIdbForTests();
  }
});
