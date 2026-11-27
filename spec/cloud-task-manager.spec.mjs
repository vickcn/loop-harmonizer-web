import assert from "node:assert/strict";
import test from "node:test";
import { CloudTaskManager } from "../lib/cloudTasks/cloudTaskManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";
import { updateCloudTaskAtomic } from "../lib/cloudTasks/cloudTaskStore.ts";

test("manager deduplicates explicit intent and keeps user cancellation durable", async () => {
  configureInMemoryIdbForTests();
  const manager = new CloudTaskManager(() => 1_000, () => 0.5);
  try {
    assert.equal(manager.getServerSnapshot(), manager.getServerSnapshot(), "React server snapshot must keep a stable reference");
    const input = { kind: "project_sync", ownerAccountId: "owner", projectId: "p", intentId: "sync:owner:p:r1", snapshotRevision: "r1", descriptor: { projectId: "p", snapshotRevision: "r1" } };
    const first = await manager.enqueue(input);
    const duplicate = await manager.enqueue(input);
    assert.equal(duplicate.taskId, first.taskId);
    await manager.cancel(first.taskId);
    assert.equal(manager.getSnapshot().find((item) => item.taskId === first.taskId)?.status, "cancelled");
    await manager.recover("reload");
    assert.equal(manager.getSnapshot().find((item) => item.taskId === first.taskId)?.status, "cancelled");
    await updateCloudTaskAtomic(first.taskId, (current) => ({ ...current, status: "completed" }));
    await manager.cancel(first.taskId);
    assert.equal(manager.getSnapshot().find((item) => item.taskId === first.taskId)?.status, "completed", "cancel cannot downgrade an already completed task");
  } finally { manager.dispose(); await new Promise((resolve) => setTimeout(resolve, 0)); resetInMemoryIdbForTests(); }
});
