import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import {
  buildDriveSongManifest,
  buildDriveSongSessionPayload,
  validateDriveSongManifest,
} from "../lib/google/driveManifest.ts";
import {
  exportSongArtifactsToDrive,
  resolveExportRevisionId,
} from "../lib/google/driveExportManager.ts";
import { sharedNetworkBudgetLedger } from "../lib/band/networkBudgetGuard.ts";
import {
  DRIVE_FOLDER_MIME_TYPE,
} from "../lib/google/driveClient.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import {
  DEMUCS_SAMPLE_RATE,
  computeBufferChecksum,
  createChunkKey,
  packChunkStemsToBuffer,
} from "../lib/storage/separationChunkStore.ts";
import {
  buildInitialCheckpoint,
  commitChunkAndCheckpointAtomically,
  saveCheckpoint,
  updateCheckpointStatus,
} from "../lib/storage/separationCheckpointStore.ts";
import {
  clearCachedFolderLayoutForAccount,
} from "../lib/google/driveFolderManager.ts";
import { clearResumableSessionUrisForAccount } from "../lib/google/driveResumableUpload.ts";

function parseMultipartPayload(bodyText) {
  const jsonStart = bodyText.indexOf("application/json");
  const firstJsonBrace = bodyText.indexOf("{", jsonStart + 20);
  const secondMeta = bodyText.indexOf("--lh_boundary_", firstJsonBrace);
  const metaJson = JSON.parse(bodyText.slice(firstJsonBrace, secondMeta).trim());

  const secondJsonStart = bodyText.indexOf("application/json", secondMeta);
  const secondBrace = bodyText.indexOf("{", secondJsonStart + 20);
  const ending = bodyText.indexOf("--lh_boundary_", secondBrace);
  const payloadJson = JSON.parse(bodyText.slice(secondBrace, ending).trim());
  return { metadata: metaJson, payload: payloadJson };
}

test("buildDriveSongSessionPayload includes musical settings and excludes secrets/tokens", () => {
  const song = createBandSong({
    id: "song_sess_1",
    name: "Holy Forever",
    fileName: "holy.mp3",
    sourceAudioId: "song_sess_1_original",
    settingsKey: "holy.mp3:1024:1",
    originalBpm: 72,
    durationSec: 240,
    sourceAudioHash: "hash-holy",
    source: {
      provider: "google_drive",
      fileId: "drive_orig_1",
      authorizedAccountId: "google:u1",
      fileName: "holy.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 1024,
      sourceAudioHash: "hash-holy",
    },
  });
  song.targetBpm = 76;
  song.keyShiftSemitones = 2;
  song.tempoMode = "manual-rate";
  song.manualRate = 1.05;
  song.fineRateOffset = -0.01;
  song.masterVolume = 0.82;
  song.loop = true;
  song.playbackSource = "stems";
  song.separationMode = "four_stem";
  song.stemChannels = [
    { id: "v", songId: "song_sess_1", stemType: "vocals", volume: 0.9, muted: false, solo: true },
    { id: "d", songId: "song_sess_1", stemType: "drums", volume: 0.7, muted: true, solo: false },
    { id: "b", songId: "song_sess_1", stemType: "bass", volume: 0.85, muted: false, solo: false },
    { id: "o", songId: "song_sess_1", stemType: "other", volume: 1, muted: false, solo: false },
  ];

  const payload = buildDriveSongSessionPayload(song);
  assert.equal(payload.targetBpm, 76);
  assert.equal(payload.keyShiftSemitones, 2);
  assert.equal(payload.tempoMode, "manual-rate");
  assert.equal(payload.manualRate, 1.05);
  assert.equal(payload.fineRateOffset, -0.01);
  assert.equal(payload.masterVolume, 0.82);
  assert.equal(payload.loop, true);
  assert.equal(payload.stemChannels.length, 4);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("accessToken"), false);
  assert.equal(serialized.includes("sessionUri"), false);
});

test("exportSongArtifactsToDrive uploads stems + session.json + custom-mix before publishing manifest last, and never publishes manifest on failure", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  clearResumableSessionUrisForAccount();
  const budgetBefore = sharedNetworkBudgetLedger.getSnapshot();

  try {
    const taskId = "task_manifest_seq";
    const totalSamples = 512;
    const strideSamples = 512;
    const makeTone = (amp) => {
      const left = new Float32Array(totalSamples).fill(amp);
      const right = new Float32Array(totalSamples).fill(-amp);
      return { left, right };
    };
    const payload = packChunkStemsToBuffer(
      {
        vocals: makeTone(0.25),
        drums: makeTone(0.15),
        bass: makeTone(0.1),
        other: makeTone(0.05),
      },
      totalSamples,
    );
    const cp = buildInitialCheckpoint({
      taskId,
      songId: "song_m1",
      sourceAudioHash: "sha256-m1",
      requestedMode: "two_stem",
      totalSamples,
    });
    await saveCheckpoint({ ...cp, totalChunks: 1, strideSamples });
    await commitChunkAndCheckpointAtomically({
      taskId,
      chunkIndex: 0,
      startSample: 0,
      endSample: totalSamples,
      payload,
      overlapCarryBuffer: null,
    });
    await updateCheckpointStatus(taskId, { status: "completed" });

    const song = createBandSong({
      id: "song_m1",
      name: "M1 Song",
      fileName: "m1.wav",
      sourceAudioId: "song_m1_original",
      settingsKey: "m1.wav:512:1",
      originalBpm: 120,
      durationSec: totalSamples / DEMUCS_SAMPLE_RATE,
      sourceAudioHash: "sha256-m1",
    });
    song.separationStatus = "completed";
    song.separationStage = "completed";
    song.separationMode = "two_stem";
    song.separationTaskId = taskId;
    song.separationTotalChunks = 1;
    song.separationCompletedChunks = 1;
    song.stemIds = ["v", "i"];
    song.stemChannels = [
      { id: "v", songId: "song_m1", stemType: "vocals", volume: 0.8, muted: false, solo: false },
      { id: "i", songId: "song_m1", stemType: "instrumental", volume: 1, muted: false, solo: false },
    ];

    let nextId = 1;
    const remoteFiles = new Map();
    const uploadSequence = [];
    let abortOnRole = null;

    const fakeFetch = async (url, init) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && u.pathname.startsWith("/drive/v3/files/")) {
        const id = u.pathname.split("/").pop();
        const rec = remoteFiles.get(id);
        return rec ? new Response(JSON.stringify(rec), { status: 200 }) : new Response("", { status: 404 });
      }
      if (method === "GET" && u.pathname === "/drive/v3/files") {
        const q = u.searchParams.get("q") ?? "";
        const roleMatch = /key='lhRole' and value='([^']+)'/.exec(q);
        const parentMatch = /'([^']+)' in parents/.exec(q);
        const artMatch = /key='lhArtifactRole' and value='([^']+)'/.exec(q);
        const revMatch = /key='lhRevisionId' and value='([^']+)'/.exec(q);
        const matched = Array.from(remoteFiles.values()).filter((f) => {
          if (parentMatch && !f.parents?.includes(parentMatch[1])) return false;
          if (roleMatch && f.appProperties?.lhRole !== roleMatch[1]) return false;
          if (artMatch && f.appProperties?.lhArtifactRole !== artMatch[1]) return false;
          if (revMatch && f.appProperties?.lhRevisionId !== revMatch[1]) return false;
          return true;
        });
        return new Response(JSON.stringify({ files: matched }), { status: 200 });
      }
      if (method === "POST" && u.pathname === "/drive/v3/files") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const id = `fld_${nextId++}`;
        const rec = { id, ...body, trashed: false, capabilities: { canAddChildren: true, canDelete: true } };
        remoteFiles.set(id, rec);
        return new Response(JSON.stringify(rec), { status: 200 });
      }
      if (method === "POST" && u.pathname === "/upload/drive/v3/files" && u.searchParams.get("uploadType") === "resumable") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const id = `resumable_${nextId++}`;
        const uri = `https://upload.example.com/${id}`;
        remoteFiles.set(uri, { meta: body, id, chunks: [] });
        return new Response("", { status: 200, headers: { location: uri } });
      }
      if (method === "PUT" && u.hostname === "upload.example.com") {
        const entry = remoteFiles.get(String(url));
        const role = entry.meta.appProperties?.lhArtifactRole;
        if (abortOnRole && role === abortOnRole) {
          return new Response("Forbidden abort test", { status: 403 });
        }
        const buf = init.body;
        entry.chunks.push(new Uint8Array(buf));
        const total = entry.chunks.reduce((s, c) => s + c.byteLength, 0);
        const fileRec = {
          id: entry.id,
          name: entry.meta.name,
          parents: entry.meta.parents,
          appProperties: entry.meta.appProperties,
          size: String(total),
        };
        remoteFiles.set(entry.id, fileRec);
        uploadSequence.push(entry.meta.name);
        return new Response(JSON.stringify(fileRec), { status: 200 });
      }
      if ((method === "POST" || method === "PATCH") && u.searchParams.get("uploadType") === "multipart") {
        const parsed = parseMultipartPayload(String(init?.body ?? ""));
        const id = `json_${nextId++}`;
        const fileRec = {
          id,
          name: parsed.metadata.name,
          parents: parsed.metadata.parents,
          appProperties: parsed.metadata.appProperties,
          json: parsed.payload,
        };
        remoteFiles.set(id, fileRec);
        uploadSequence.push(parsed.metadata.name);
        return new Response(JSON.stringify(fileRec), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const res = await exportSongArtifactsToDrive({
      song,
      accountId: "google:u1",
      accessToken: "token-1",
      generation: 1,
      isGenerationValid: () => true,
      selection: {
        format: "wav-pcm16",
        includeStems: true,
        includeSessionJson: true,
        includeCustomMix: true,
      },
      fetchImpl: fakeFetch,
    });

    assert.equal(res.status, "completed");
    assert.ok(res.manifestFileId);
    assert.equal(res.manifest?.status, "completed");
    assert.deepEqual(uploadSequence, [
      "vocals.wav",
      "instrumental.wav",
      "M1-Song-custom-mix.wav",
      "session.json",
      "manifest.json",
    ]);
    const budgetAfter = sharedNetworkBudgetLedger.getSnapshot();
    assert.ok(budgetAfter.googleDriveUploadBytes > budgetBefore.googleDriveUploadBytes);
    // Drive upload never blocked by Vercel 10 MiB static cap
    assert.equal(budgetAfter.vercelStaticBytes, budgetBefore.vercelStaticBytes);

    // Revision reuse vs new revision isolation:
    const newRevAfterComplete = await resolveExportRevisionId({
      songId: "song_m1",
      ownerAccountId: "google:u1",
      sourceAudioHash: "sha256-m1",
      mode: "two_stem",
      existingCompletedRevisionId: res.revisionId,
    });
    assert.notEqual(newRevAfterComplete, res.revisionId);

    // Failed partial upload MUST NOT publish manifest.json
    const prevManifestCount = uploadSequence.filter((n) => n === "manifest.json").length;
    uploadSequence.length = 0;
    abortOnRole = "instrumental";
    const failRes = await exportSongArtifactsToDrive({
      song,
      accountId: "google:u1",
      accessToken: "token-1",
      generation: 1,
      isGenerationValid: () => true,
      selection: {
        format: "wav-pcm16",
        includeStems: true,
        includeSessionJson: true,
        includeCustomMix: false,
        forceNewRevision: true,
      },
      fetchImpl: fakeFetch,
    });
    assert.equal(failRes.status, "failed");
    assert.equal(uploadSequence.includes("manifest.json"), false);
    assert.equal(prevManifestCount, 1);

    // Manifest validator rejects non-completed, missing stem, wrong account
    const invalid1 = validateDriveSongManifest({ ...res.manifest, status: "uploading" });
    assert.equal(invalid1.valid, false);
    const invalid2 = validateDriveSongManifest(res.manifest, { expectedAccountId: "google:other" });
    assert.equal(invalid2.valid, false);
    const brokenManifest = structuredClone(res.manifest);
    delete brokenManifest.artifacts.vocals;
    assert.equal(validateDriveSongManifest(brokenManifest).valid, false);
    assert.equal(
      validateDriveSongManifest(
        buildDriveSongManifest({
          songId: "s",
          songName: "n",
          stableSongKey: "k",
          revisionId: "r",
          ownerAccountId: "google:u1",
          source: res.manifest.source,
          mode: "two_stem",
          modelVersion: "browser-demucs-v1",
          processingVersion: "loop-harmonizer-stems-v2",
          sampleRate: DEMUCS_SAMPLE_RATE,
          totalSamples,
          format: "wav-pcm16",
          artifacts: res.manifest.artifacts,
        }),
      ).valid,
      true,
    );
  } finally {
    clearResumableSessionUrisForAccount();
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
