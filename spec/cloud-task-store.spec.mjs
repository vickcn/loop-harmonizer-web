import assert from "node:assert/strict";
import test from "node:test";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { createCloudTaskIdempotently, getCloudTask, updateCloudTaskAtomic } from "../lib/cloudTasks/cloudTaskStore.ts";

function record(overrides = {}) {
  return { key: "cloud-1", taskId: "cloud-1", kind: "project_sync", status: "queued", ownerAccountId: "google:owner", projectId: "project-1", intentId: "intent-fixed", snapshotRevision: "revision-1", descriptor: { projectId: "project-1", snapshotRevision: "revision-1" }, stage: "等待執行", completedBytes: 0, retryCount: 0, operationGeneration: 1, createdAt: 100, updatedAt: 100, ...overrides };
}

test("cloud task store persists only safe references and deduplicates the same explicit intent", async () => {
  configureInMemoryIdbForTests();
  try {
    const first = await createCloudTaskIdempotently(record());
    const duplicate = await createCloudTaskIdempotently(record({ key: "cloud-2", taskId: "cloud-2" }));
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.task.taskId, "cloud-1");
    const json = JSON.stringify(await getCloudTask("cloud-1"));
    assert.equal(json.includes("accessToken"), false);
    assert.equal(json.includes("resumableSession"), false);
    assert.equal(json.includes("audioBlob"), false);
  } finally { resetInMemoryIdbForTests(); }
});

test("cloud task updates are atomic and retain operation generation", async () => {
  configureInMemoryIdbForTests();
  try {
    await createCloudTaskIdempotently(record());
    const updated = await updateCloudTaskAtomic("cloud-1", (current) => ({ ...current, status: "paused", operationGeneration: current.operationGeneration + 1, updatedAt: 200 }));
    assert.equal(updated.status, "paused");
    assert.equal((await getCloudTask("cloud-1")).operationGeneration, 2);
  } finally { resetInMemoryIdbForTests(); }
});
