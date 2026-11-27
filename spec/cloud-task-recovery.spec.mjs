import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInterruptedCloudTask } from "../lib/cloudTasks/cloudTaskRecovery.ts";

const base = { key: "t", taskId: "t", kind: "stem_export", status: "running", ownerAccountId: "a", intentId: "i", descriptor: { songId: "s", sourceAudioHash: "h", artifactRevision: "r", selection: { format: "wav-pcm16", selectedStemRoles: [], includeSessionJson: true, includeCustomMix: false, forceNewRevision: false } }, stage: "upload", completedBytes: 10, retryCount: 0, operationGeneration: 2, createdAt: 0, updatedAt: 0 };

test("expired running task recovers from persisted progress without changing generation", () => {
  const next = normalizeInterruptedCloudTask({ ...base, leaseOwnerId: "old", leaseExpiresAt: 99 }, 100);
  assert.equal(next.status, "recovering");
  assert.equal(next.completedBytes, 10);
  assert.equal(next.operationGeneration, 2);
  assert.equal(next.leaseOwnerId, undefined);
});

test("valid lease and user paused/cancelled states are never auto-resumed", () => {
  assert.equal(normalizeInterruptedCloudTask({ ...base, leaseExpiresAt: 101 }, 100).status, "running");
  assert.equal(normalizeInterruptedCloudTask({ ...base, status: "paused" }, 100).status, "paused");
  assert.equal(normalizeInterruptedCloudTask({ ...base, status: "cancelled" }, 100).status, "cancelled");
});
