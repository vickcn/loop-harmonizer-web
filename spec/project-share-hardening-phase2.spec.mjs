import test from "node:test";
import assert from "node:assert/strict";
import { validateProjectSharePublishOwnership } from "../lib/sharing/shareManager.ts";
import { evaluateShareAcl } from "../lib/sharing/sharePermissions.ts";
import { buildProjectSharePointer, validateProjectSharePointer } from "../lib/sharing/shareManifest.ts";
import { buildShareArtifactIdentity, getArtifactChecksumDescriptor } from "../lib/sharing/shareArtifactManager.ts";
import { validateDriveSongManifest } from "../lib/google/driveManifest.ts";

function record(storageProvider, ownerAccountId = "") {
  return { storageProvider, ownerAccountId, projectId: "project", project: { projectId: "project" } };
}

test("純本機專案可由目前登入帳戶發布，且不需改寫本機 owner", () => {
  const local = record("local", "");
  assert.doesNotThrow(() => validateProjectSharePublishOwnership(local, "google:publisher"));
  assert.equal(local.storageProvider, "local");
  assert.equal(local.ownerAccountId, "");
});

test("Google Drive 專案 owner 不一致時拒絕發布", () => {
  assert.throws(() => validateProjectSharePublishOwnership(record("google_drive", "google:owner"), "google:other"), /不是此雲端專案擁有者/);
});

test("Restricted 空 Reader 集合不會被誤判為有效 Published ACL", () => {
  assert.notEqual(evaluateShareAcl({ permissions: [], visibility: "restricted", recipientEmails: [] }).verification, "verified");
});

test("revoked tombstone 可由另一裝置辨識且保留 generation", () => {
  const manifest = { shareId: "share", sourceProjectId: "project", ownerAccountId: "owner", publishedRevisionId: "rev", project: { name: "P" }, songs: [] };
  const checked = validateProjectSharePointer(buildProjectSharePointer({ manifest, revisionManifestFileId: "manifest", visibility: "restricted", lifecycle: "revoked", operationId: "op-revoke", revocationGeneration: 7, revokedAt: "2026-01-01T00:00:00Z" }));
  assert.equal(checked.lifecycle, "revoked");
  assert.equal(checked.operationId, "op-revoke");
  assert.equal(checked.revocationGeneration, 7);
});

test("Artifact identity 使用完整 SHA-256 且內容變更產生不同 identity", () => {
  const base = { sourceAudioHash: "hash", separationMode: "two_stem", modelVersion: "m", processingVersion: "p", artifactRevision: "r", role: "vocals", checksum: "sha256:" + "a".repeat(64), sizeBytes: 100, pcmFormat: "wav-pcm16" };
  assert.match(buildShareArtifactIdentity(base), /^[0-9a-f]{64}$/);
  assert.notEqual(buildShareArtifactIdentity(base), buildShareArtifactIdentity({ ...base, checksum: "sha256:" + "b".repeat(64) }));
});

test("Checksum Descriptor 明確區分 SHA-256 與舊 MD5-only 成果", () => {
  assert.deepEqual(getArtifactChecksumDescriptor({ checksum: "sha256:" + "a".repeat(64) }), { algorithm: "sha256", value: "sha256:" + "a".repeat(64) });
  assert.deepEqual(getArtifactChecksumDescriptor({ md5Checksum: "b".repeat(32) }), { algorithm: "md5", value: "b".repeat(32) });
});

test("Drive Manifest 接受有 MD5 證據的舊成果，但拒絕完全缺少 checksum", () => {
  const artifact = { fileId: "file", fileName: "v.wav", sizeBytes: 100, md5Checksum: "a".repeat(32), mimeType: "audio/wav" };
  const manifest = { schemaVersion: 1, application: "loop-harmonizer", songId: "s", songName: "S", stableSongKey: "k", revisionId: "r", ownerAccountId: "owner", source: { provider: "local", fileName: "s", sourceAudioHash: "hash" }, separation: { mode: "two_stem", modelVersion: "m", processingVersion: "p", sampleRate: 44100, channelCount: 2, totalSamples: 10, format: "wav-pcm16" }, artifacts: { vocals: artifact, instrumental: { ...artifact, fileId: "file2" } }, status: "completed", createdAt: "now", updatedAt: "now" };
  assert.equal(validateDriveSongManifest(manifest).valid, true);
  const invalid = structuredClone(manifest); delete invalid.artifacts.vocals.md5Checksum;
  assert.equal(validateDriveSongManifest(invalid).valid, false);
});
