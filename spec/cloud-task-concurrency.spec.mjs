import assert from "node:assert/strict";
import test from "node:test";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { createCloudTaskIdempotently, reserveCloudTaskLease, updateCloudTaskAtomic } from "../lib/cloudTasks/cloudTaskStore.ts";

const task = { key: "task", taskId: "task", kind: "project_sync", status: "queued", ownerAccountId: "owner", projectId: "p", intentId: "intent", descriptor: { projectId: "p", snapshotRevision: "r1" }, stage: "queued", completedBytes: 0, retryCount: 0, operationGeneration: 1, createdAt: 0, updatedAt: 0 };

test("lease prevents a second tab and generation fencing rejects stale ownership", async () => {
  configureInMemoryIdbForTests();
  try {
    await createCloudTaskIdempotently(task);
    assert.ok(await reserveCloudTaskLease({ taskId: "task", ownerId: "tab-a", now: 100, ttlMs: 1_000, expectedGeneration: 1 }));
    assert.equal(await reserveCloudTaskLease({ taskId: "task", ownerId: "tab-b", now: 200, ttlMs: 1_000, expectedGeneration: 1 }), null);
    await updateCloudTaskAtomic("task", (current) => ({ ...current, operationGeneration: 2, leaseOwnerId: undefined, leaseExpiresAt: undefined }));
    assert.equal(await reserveCloudTaskLease({ taskId: "task", ownerId: "tab-a", now: 300, ttlMs: 1_000, expectedGeneration: 1 }), null);
    assert.ok(await reserveCloudTaskLease({ taskId: "task", ownerId: "tab-b", now: 300, ttlMs: 1_000, expectedGeneration: 2 }));
  } finally { resetInMemoryIdbForTests(); }
});
