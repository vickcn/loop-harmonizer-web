import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import { ChunkedStemMixBuffer } from "../lib/band/playbackAdapters/ChunkPlaybackAdapter.ts";
import { exportSongArtifactsToDrive } from "../lib/google/driveExportManager.ts";
import { clearCachedFolderLayoutForAccount } from "../lib/google/driveFolderManager.ts";
import { clearResumableSessionUrisForAccount } from "../lib/google/driveResumableUpload.ts";
import {
  deleteDriveRevisionArtifacts,
  listDriveLibraryEntries,
  restoreSongFromDrive,
} from "../lib/google/driveRestoreManager.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  computeBufferChecksum,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  getAllCheckpoints,
  getCheckpoint,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  getAllImportedStemRecords,
  releaseImportedStemReferenceAndMaybeGc,
} from "../lib/storage/importedStemStore.ts";

function parseMultipart(bodyText) {
  const jsonStart = bodyText.indexOf("application/json");
  const b1 = bodyText.indexOf("{", jsonStart + 20);
  const b2 = bodyText.indexOf("--lh_boundary_", b1);
  const metadata = JSON.parse(bodyText.slice(b1, b2).trim());
  const json2 = bodyText.indexOf("application/json", b2);
  const b3 = bodyText.indexOf("{", json2 + 20);
  const b4 = bodyText.indexOf("--lh_boundary_", b3);
  const payload = JSON.parse(bodyText.slice(b3, b4).trim());
  return { metadata, payload };
}

function createFullFakeDriveServer() {
  let nextId = 1;
  const files = new Map();
  const downloadedBinaryIds = [];
  const deletedIds = [];

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && u.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      const rec = files.get(id);
      if (!rec || rec.trashed) return new Response("Not Found", { status: 404 });
      if (u.searchParams.get("alt") === "media") {
        if (rec.json !== undefined) {
          return new Response(JSON.stringify(rec.json), { status: 200 });
        }
        downloadedBinaryIds.push(id);
        return new Response(rec.binary ?? new Uint8Array(0), {
          status: 200,
          headers: { "content-length": String(rec.binary?.byteLength ?? 0) },
        });
      }
      return new Response(JSON.stringify(rec.meta), { status: 200 });
    }

    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const appMatch = /key='lhApp' and value='([^']+)'/.exec(q);
      const roleMatch = /key='lhRole' and value='([^']+)'/.exec(q);
      const accMatch = /key='lhAccountId' and value='([^']+)'/.exec(q);
      const artMatch = /key='lhArtifactRole' and value='([^']+)'/.exec(q);
      const revMatch = /key='lhRevisionId' and value='([^']+)'/.exec(q);
      const parentMatch = /'([^']+)' in parents/.exec(q);

      const matched = Array.from(files.values())
        .filter((item) => item.meta && !item.trashed)
        .filter((item) => {
          const m = item.meta;
          if (parentMatch && !m.parents?.includes(parentMatch[1])) return false;
          if (appMatch && m.appProperties?.lhApp !== appMatch[1]) return false;
          if (roleMatch && m.appProperties?.lhRole !== roleMatch[1]) return false;
          if (accMatch && m.appProperties?.lhAccountId !== accMatch[1]) return false;
          if (artMatch && m.appProperties?.lhArtifactRole !== artMatch[1]) return false;
          if (revMatch && m.appProperties?.lhRevisionId !== revMatch[1]) return false;
          return true;
        })
        .map((item) => item.meta);
      return new Response(JSON.stringify({ files: matched }), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = `fld_${nextId++}`;
      const meta = { id, ...body, trashed: false, capabilities: { canAddChildren: true, canDelete: true } };
      files.set(id, { meta });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/upload/drive/v3/files" && u.searchParams.get("uploadType") === "resumable") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = `bin_${nextId++}`;
      const uri = `https://upload.example.com/${id}`;
      files.set(uri, { id, meta: body, parts: [] });
      return new Response("", { status: 200, headers: { location: uri } });
    }

    if (method === "PUT" && u.hostname === "upload.example.com") {
      const holder = files.get(String(url));
      const chunk = new Uint8Array(init.body);
      holder.parts.push(chunk);
      const total = holder.parts.reduce((s, p) => s + p.byteLength, 0);
      const merged = new Uint8Array(total);
      let cursor = 0;
      for (const p of holder.parts) {
        merged.set(p, cursor);
        cursor += p.byteLength;
      }
      const meta = {
        id: holder.id,
        name: holder.meta.name,
        parents: holder.meta.parents,
        appProperties: holder.meta.appProperties,
        size: String(total),
        capabilities: { canDownload: true, canDelete: true },
      };
      files.set(holder.id, { meta, binary: merged });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if ((method === "POST" || method === "PATCH") && u.searchParams.get("uploadType") === "multipart") {
      const { metadata, payload } = parseMultipart(String(init?.body ?? ""));
      const id = `json_${nextId++}`;
      const meta = {
        id,
        name: metadata.name,
        parents: metadata.parents,
        appProperties: metadata.appProperties,
        capabilities: { canDelete: true },
      };
      files.set(id, { meta, json: payload });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if (method === "DELETE" && u.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      deletedIds.push(id);
      files.delete(id);
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
  };

  return { files, downloadedBinaryIds, deletedIds, fetchImpl };
}

test("Cross-device restore imports playable stems without running Demucs, preserves BPM/Key/Mix, and isolates deletions", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  clearResumableSessionUrisForAccount();

  try {
    const server = createFullFakeDriveServer();
    const taskId = "task_src_device_1";
    const totalSamples = 512;
    const strideSamples = 512;
    const makeTone = (v) => ({
      left: new Float32Array(totalSamples).fill(v),
      right: new Float32Array(totalSamples).fill(-v),
    });
    const rawPayload = packChunkStemsToBuffer(
      {
        vocals: makeTone(0.5),
        drums: makeTone(0.2),
        bass: makeTone(0.1),
        other: makeTone(0.05),
      },
      totalSamples,
    );
    const cp = buildInitialCheckpoint({
      taskId,
      songId: "src_song_1",
      sourceAudioHash: "sha256-cross-device-1",
      requestedMode: "two_stem",
      totalSamples,
    });
    await saveCheckpoint(cp);
    await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: 0,
      startSample: 0,
      endSample: totalSamples,
      payload: rawPayload,
      overlapCarryBuffer: null,
    });
    await updateCheckpointStatus(taskId, { status: "completed" });

    const sourceSong = createBandSong({
      id: "src_song_1",
      name: "Cloud Anthem",
      fileName: "anthem.mp3",
      sourceAudioId: "src_song_1_original",
      settingsKey: "anthem.mp3:1024:1",
      originalBpm: 120,
      durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
      sourceAudioHash: "sha256-cross-device-1",
    });
    sourceSong.targetBpm = 130;
    sourceSong.keyShiftSemitones = -3;
    sourceSong.masterVolume = 0.75;
    sourceSong.separationStatus = "completed";
    sourceSong.separationStage = "completed";
    sourceSong.separationMode = "two_stem";
    sourceSong.separationTaskId = taskId;
    sourceSong.separationTotalChunks = 1;
    sourceSong.separationCompletedChunks = 1;
    sourceSong.stemIds = ["v", "i"];
    sourceSong.stemChannels = [
      { id: "v", songId: "src_song_1", stemType: "vocals", volume: 0.6, muted: false, solo: true },
      { id: "i", songId: "src_song_1", stemType: "instrumental", volume: 0.9, muted: false, solo: false },
    ];

    const exported = await exportSongArtifactsToDrive({
      song: sourceSong,
      accountId: "google:devA",
      accessToken: "tokenA",
      generation: 1,
      isGenerationValid: () => true,
      selection: {
        format: "wav-float32",
        includeStems: true,
        includeSessionJson: true,
        includeCustomMix: false,
      },
      fetchImpl: server.fetchImpl,
    });
    assert.equal(exported.status, "completed");

    // Account isolation check: different Google account cannot see devA's entries
    const devBList = await listDriveLibraryEntries({
      accountId: "google:devB",
      accessToken: "tokenB",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(devBList.entries.length, 0);

    // 1) Same device with local completed checkpoint: listDriveLibraryEntries downloads NO WAV binaries and detects reuse
    server.downloadedBinaryIds.length = 0;
    const sameDeviceList = await listDriveLibraryEntries({
      accountId: "google:devA",
      accessToken: "tokenA",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(sameDeviceList.entries.length, 1);
    assert.equal(sameDeviceList.entries[0].localAlreadyAvailable, true);
    assert.equal(server.downloadedBinaryIds.length, 0);

    const reusedRestore = await restoreSongFromDrive({
      entry: sameDeviceList.entries[0],
      accountId: "google:devA",
      accessToken: "tokenA",
      generation: 1,
      isGenerationValid: () => true,
      includeOriginalAudio: false,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(reusedRestore.reusedLocalStems, true);
    assert.equal(server.downloadedBinaryIds.length, 0);
    assert.equal(reusedRestore.song.targetBpm, 130);
    assert.equal(reusedRestore.song.keyShiftSemitones, -3);

    // 2) Wipe local IDB to simulate clean Device B (no local checkpoint or original audio)
    resetInMemoryIdbForTests();
    configureInMemoryIdbForTests();
    clearCachedFolderLayoutForAccount();

    const cleanDeviceList = await listDriveLibraryEntries({
      accountId: "google:devA",
      accessToken: "tokenA",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(cleanDeviceList.entries.length, 1);
    assert.equal(cleanDeviceList.entries[0].localAlreadyAvailable, false);

    // Check corrupt checksum rejection
    const corruptedEntry = structuredClone(cleanDeviceList.entries[0]);
    corruptedEntry.manifest.artifacts.vocals.checksum = "sha256:" + "0".repeat(64);
    await assert.rejects(
      () =>
        restoreSongFromDrive({
          entry: corruptedEntry,
          accountId: "google:devA",
          accessToken: "tokenA",
          generation: 1,
          isGenerationValid: () => true,
          fetchImpl: server.fetchImpl,
        }),
      /Checksum/,
    );

    // Check unsupported modelVersion rejection
    const unsupportedEntry = structuredClone(cleanDeviceList.entries[0]);
    unsupportedEntry.manifest.separation.modelVersion = "demucs-future-v99";
    await assert.rejects(
      () =>
        restoreSongFromDrive({
          entry: unsupportedEntry,
          accountId: "google:devA",
          accessToken: "tokenA",
          generation: 1,
          isGenerationValid: () => true,
          fetchImpl: server.fetchImpl,
        }),
      /不支援的分軌模型版本/,
    );

    // Check missing stem manifest rejection
    const missingStemEntry = structuredClone(cleanDeviceList.entries[0]);
    delete missingStemEntry.manifest.artifacts.instrumental;
    await assert.rejects(
      () =>
        restoreSongFromDrive({
          entry: missingStemEntry,
          accountId: "google:devA",
          accessToken: "tokenA",
          generation: 1,
          isGenerationValid: () => true,
          fetchImpl: server.fetchImpl,
        }),
      /Manifest 不完整/,
    );

    // Genuine restore without original audio -> importedStemRecord created, NO fake Demucs checkpoint created
    server.downloadedBinaryIds.length = 0;
    const restored = await restoreSongFromDrive({
      entry: cleanDeviceList.entries[0],
      accountId: "google:devA",
      accessToken: "tokenA",
      generation: 1,
      isGenerationValid: () => true,
      includeOriginalAudio: false,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(restored.reusedLocalStems, false);
    assert.ok(restored.importedStemRecord);
    assert.equal(restored.song.sourceAudioMissing, true);
    assert.equal(restored.song.playbackSource, "stems");
    assert.equal(restored.song.targetBpm, 130);
    assert.equal(restored.song.keyShiftSemitones, -3);
    assert.equal(restored.song.masterVolume, 0.75);
    assert.equal(restored.song.stemChannels[0].volume, 0.6);
    assert.equal(restored.song.stemChannels[0].solo, true);

    // Crucial: must NOT fake a Demucs checkpoint
    assert.equal((await getAllCheckpoints()).length, 0);
    assert.equal(await getCheckpoint(restored.song.separationTaskId), null);
    assert.equal((await getAllImportedStemRecords()).length, 1);

    // Directly playable through ChunkedStemMixBuffer using two_stem_direct layout
    const mixBuf = new ChunkedStemMixBuffer({
      taskId: restored.song.separationTaskId,
      totalSamples,
      sampleRate: DEMUCS_SAMPLE_RATE,
      stemLayout: restored.importedStemRecord.stemLayout,
      entries: [
        { trackId: "v", role: "vocals", gain: 1, muted: false },
        { trackId: "i", role: "instrumental", gain: 1, muted: false },
      ],
    });
    await mixBuf.warmUpAroundSample(0);
    const pcmOut = new Float32Array(128 * 2);
    const extracted = mixBuf.extract(pcmOut, 128, 0);
    assert.equal(extracted, 128);
    // vocals(0.5) + instrumental(drums=0.2 + bass=0.1 + other=0.05 = 0.35) => 0.85
    assert.ok(Math.abs(pcmOut[0] - 0.85) < 1e-4);

    // Safe deletion isolation:
    // 1) Local delete must NOT delete Drive files
    server.deletedIds.length = 0;
    await releaseImportedStemReferenceAndMaybeGc({
      importId: restored.importedStemRecord.importId,
      songId: restored.song.id,
      knownInMemorySongs: [],
    });
    assert.equal((await getAllImportedStemRecords()).length, 0);
    assert.equal(server.deletedIds.length, 0);

    // 2) Cross-account Drive delete rejected
    await assert.rejects(
      () =>
        deleteDriveRevisionArtifacts({
          entry: cleanDeviceList.entries[0],
          accountId: "google:devB",
          accessToken: "tokenB",
          fetchImpl: server.fetchImpl,
        }),
      /不屬於目前登入/,
    );

    // 3) Owner Drive revision delete deletes only revision artifacts without throwing
    await deleteDriveRevisionArtifacts({
      entry: cleanDeviceList.entries[0],
      accountId: "google:devA",
      accessToken: "tokenA",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(server.deletedIds.length, 1);
  } finally {
    clearResumableSessionUrisForAccount();
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
