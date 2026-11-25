import test from "node:test";
import assert from "node:assert/strict";
import { buildShareArtifactIdentity, buildSharedDriveSongManifest } from "../lib/sharing/shareArtifactManager.ts";
import { buildProjectShareManifest, validateProjectShareManifest } from "../lib/sharing/shareManifest.ts";
import { reconcileSharePermissions } from "../lib/sharing/sharePermissions.ts";
import { withProjectShareOperation } from "../lib/sharing/shareOperationCoordinator.ts";
import { saveProjectShareRecord } from "../lib/sharing/shareManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

function entry() {
  return {
    entryId: "entry1", sourceAudioHash: "hash", source: { provider: "google_drive", fileId: "PRIVATE_FILE", resourceKey: "PRIVATE_KEY", driveId: "PRIVATE_DRIVE" },
    originalBackup: { driveFileId: "PRIVATE_FILE", resourceKey: "PRIVATE_KEY" }, displayName: "Song", fileName: "song.wav", durationSec: 10, order: 0,
    artifactRef: { manifestFileId: "shared-manifest", revisionId: "rev", sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "model", processingVersion: "process", sampleRate: 44100, channelCount: 2, totalSamples: 441000, pcmFormat: "wav-pcm16" },
    settings: { displayName: "Song", fileName: "song.wav", originalBpm: 120, targetBpm: 120, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0, savedRates: [], keyShiftSemitones: 0, masterVolume: 1, muted: false, loop: false, playbackSource: "stems", separationMode: "two_stem", stemChannels: [{ stemType: "vocals", volume: 1, muted: false, solo: false }] },
  };
}

function sourceManifest() {
  return {
    schemaVersion: 1, application: "loop-harmonizer", songId: "private-song", songName: "Song", stableSongKey: "PRIVATE_STABLE_KEY", revisionId: "rev", ownerAccountId: "owner",
    source: { provider: "google_drive", fileId: "PRIVATE_FILE", resourceKey: "PRIVATE_KEY", driveId: "PRIVATE_DRIVE", fileName: "private.wav", sourceAudioHash: "hash" },
    separation: { mode: "two_stem", modelVersion: "model", processingVersion: "process", sampleRate: 44100, channelCount: 2, totalSamples: 441000, format: "wav-pcm16" },
    artifacts: {}, sessionFileId: "PRIVATE_SESSION", status: "completed", createdAt: "now", updatedAt: "now",
  };
}

const copiedArtifacts = {
  vocals: { fileId: "sharedVocals", fileName: "vocals.wav", mimeType: "audio/wav", sizeBytes: 1764044, checksum: "sha256-vocals" },
  instrumental: { fileId: "sharedInstrumental", fileName: "instrumental.wav", mimeType: "audio/wav", sizeBytes: 1764044, checksum: "sha256-instrumental" },
};

test("shared song upload payload is whitelist-built and strips every private Drive identifier", () => {
  const payload = buildSharedDriveSongManifest({ entry: entry(), sourceManifest: sourceManifest(), copiedArtifacts, shareId: "share", ownerAccountId: "owner", nowIso: "now" });
  const json = JSON.stringify(payload);
  for (const secret of ["PRIVATE_FILE", "PRIVATE_KEY", "PRIVATE_DRIVE", "PRIVATE_SESSION", "PRIVATE_STABLE_KEY"]) assert.equal(json.includes(secret), false);
  assert.equal(payload.source.provider, "local");
  assert.equal(payload.sessionFileId, undefined);
  assert.equal(payload.artifacts.vocals.fileId, "sharedVocals");
});

test("strict share manifest validation rejects missing roles, duplicate entries and unsafe controls", () => {
  const song = entry();
  const project = { schemaVersion: 1, application: "loop-harmonizer", projectId: "project", name: "P", storageProvider: "local", revision: 1, revisionToken: "r1", createdAt: "now", updatedAt: "now", masterSettings: {}, songs: [song] };
  const sharedSong = { entry: song, manifestFileId: "manifest1", artifactRevision: "rev", artifacts: [
    { role: "vocals", fileId: "sharedVocals", fileName: "v.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "sum-v" },
    { role: "instrumental", fileId: "sharedInstrumental", fileName: "i.wav", mimeType: "audio/wav", sizeBytes: 100, checksum: "sum-i" },
  ] };
  const manifest = buildProjectShareManifest({ shareId: "share", sourceProject: project, ownerAccountId: "owner", publishedRevisionId: "pub", songs: [sharedSong], nowIso: "now" });
  assert.equal(validateProjectShareManifest(manifest).shareId, "share");
  const missing = structuredClone(manifest); missing.songs[0].artifacts.pop();
  assert.throws(() => validateProjectShareManifest(missing), /角色數量|必要 Stem/);
  const invalid = structuredClone(manifest); invalid.project.songs[0].settings.targetBpm = 999;
  assert.throws(() => validateProjectShareManifest(invalid), /BPM/);
});

test("ACL reconciliation adds and verifies new reader before removing obsolete reader", async () => {
  let permissions = [
    { id: "owner", type: "user", role: "owner" },
    { id: "old", type: "user", role: "reader", emailAddress: "old@example.com", permissionDetails: [{ inherited: false }] },
  ];
  const events = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST") { const body = JSON.parse(init.body); events.push(`add:${body.emailAddress}`); const created = { id: "new", ...body, permissionDetails: [{ inherited: false }] }; permissions.push(created); return Response.json(created); }
    if (method === "DELETE") { const id = String(url).split("/").at(-1).split("?")[0]; events.push(`remove:${id}`); permissions = permissions.filter((permission) => permission.id !== id); return new Response(null, { status: 204 }); }
    events.push(`list:${permissions.map((permission) => permission.id).join(",")}`); return Response.json({ permissions });
  };
  const result = await reconcileSharePermissions({ fileId: "folder", accessToken: "token", visibility: "restricted", recipientEmails: ["new@example.com"], fetchImpl });
  assert.equal(result.verification, "verified");
  assert.ok(events.indexOf("add:new@example.com") < events.indexOf("remove:old"));
  assert.equal(result.recipients[0].email, "new@example.com");
});

test("ACL add 429 preserves existing reader and never starts removal", async () => {
  let deleteCalls = 0;
  const fetchImpl = async (_url, init = {}) => {
    if ((init.method ?? "GET") === "POST") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    if (init.method === "DELETE") { deleteCalls += 1; return new Response(null, { status: 204 }); }
    return Response.json({ permissions: [{ id: "old", type: "user", role: "reader", emailAddress: "old@example.com", permissionDetails: [{ inherited: false }] }] });
  };
  await assert.rejects(() => reconcileSharePermissions({ fileId: "folder", accessToken: "token", visibility: "restricted", recipientEmails: ["new@example.com"], fetchImpl }), /rate limited|429/);
  assert.equal(deleteCalls, 0);
});

test("durable operation generation rejects a stale second-tab operation and revoked tombstone", async () => {
  configureInMemoryIdbForTests();
  try {
    const base = { key: "share", schemaVersion: 1, shareId: "share", sourceProjectId: "project", ownerAccountId: "owner", visibility: "restricted", status: "published", operationGeneration: 1, sourceProjectRevision: 1, publishedRevisionId: "pub", recipients: [], estimatedBytes: 0, createdAt: "now", updatedAt: "now" };
    await saveProjectShareRecord(base);
    await withProjectShareOperation({ lockKey: "share", shareId: "share", kind: "update_acl", expectedGeneration: 1, runner: async () => undefined });
    await assert.rejects(() => withProjectShareOperation({ lockKey: "share", shareId: "share", kind: "revoke", expectedGeneration: 1, runner: async () => undefined }), /其他分頁更新/);
    await saveProjectShareRecord({ ...base, operationGeneration: 3, status: "revoked", visibility: "private", revokedAt: "now", revocationGeneration: 3 });
    await assert.rejects(() => withProjectShareOperation({ lockKey: "share", shareId: "share", kind: "publish", expectedGeneration: 3, runner: async () => undefined }), /已撤銷/);
  } finally { resetInMemoryIdbForTests(); }
});

test("artifact identity reuses identical WAV across revisions but changes for real stem changes", () => {
  const base = { sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "model", processingVersion: "process", artifactRevision: "artifact-r1", role: "vocals", checksum: "sha256-v", sizeBytes: 1000, pcmFormat: "wav-pcm16" };
  assert.equal(buildShareArtifactIdentity(base), buildShareArtifactIdentity({ ...base }));
  assert.notEqual(buildShareArtifactIdentity(base), buildShareArtifactIdentity({ ...base, checksum: "sha256-v2" }));
  assert.notEqual(buildShareArtifactIdentity(base), buildShareArtifactIdentity({ ...base, artifactRevision: "artifact-r2" }));
});
