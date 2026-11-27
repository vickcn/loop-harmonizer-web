import {
  CLOUD_TASK_INTENT_INDEX,
  idbGet,
  idbGetAll,
  idbRequestPromise,
  withIdbTransaction,
} from "../storage/indexedDb.ts";
import type { CloudTaskKind, CloudTaskRecord } from "./cloudTaskTypes.ts";

export async function getCloudTask(taskId: string): Promise<CloudTaskRecord | null> {
  return idbGet<CloudTaskRecord>("cloudTasks", taskId);
}

export async function listCloudTasks(): Promise<CloudTaskRecord[]> {
  return (await idbGetAll<CloudTaskRecord>("cloudTasks")).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createCloudTaskIdempotently<K extends CloudTaskKind>(
  record: CloudTaskRecord<K>,
): Promise<{ task: CloudTaskRecord<K>; created: boolean }> {
  return withIdbTransaction("cloudTasks", "readwrite", async (tx) => {
    const store = tx.objectStore("cloudTasks");
    const rows = typeof store.index === "function" && (!store.indexNames || store.indexNames.contains(CLOUD_TASK_INTENT_INDEX))
      ? await idbRequestPromise(store.index(CLOUD_TASK_INTENT_INDEX).getAll(record.intentId)) as CloudTaskRecord[]
      : (await idbRequestPromise(store.getAll()) as CloudTaskRecord[]).filter((row) => row.intentId === record.intentId);
    const existing = rows.find((row) => row.ownerAccountId === record.ownerAccountId && row.kind === record.kind);
    if (existing) return { task: existing as CloudTaskRecord<K>, created: false };
    await idbRequestPromise(store.put(record));
    return { task: record, created: true };
  });
}

export async function updateCloudTaskAtomic(
  taskId: string,
  updater: (current: CloudTaskRecord) => CloudTaskRecord,
): Promise<CloudTaskRecord> {
  return withIdbTransaction("cloudTasks", "readwrite", async (tx) => {
    const store = tx.objectStore("cloudTasks");
    const current = await idbRequestPromise(store.get(taskId)) as CloudTaskRecord | undefined;
    if (!current) throw new Error("找不到背景雲端任務。");
    const next = updater(current);
    await idbRequestPromise(store.put(next));
    return next;
  });
}

export async function reserveCloudTaskLease(params: {
  taskId: string; ownerId: string; now: number; ttlMs: number; expectedGeneration?: number;
}): Promise<CloudTaskRecord | null> {
  return withIdbTransaction("cloudTasks", "readwrite", async (tx) => {
    const store = tx.objectStore("cloudTasks");
    const current = await idbRequestPromise(store.get(params.taskId)) as CloudTaskRecord | undefined;
    if (!current || ["completed", "cancelled", "paused"].includes(current.status)) return null;
    if (params.expectedGeneration !== undefined && current.operationGeneration !== params.expectedGeneration) return null;
    if (current.leaseOwnerId && current.leaseOwnerId !== params.ownerId && (current.leaseExpiresAt ?? 0) > params.now) return null;
    const next: CloudTaskRecord = {
      ...current,
      status: current.status === "queued" ? "preparing" : "recovering",
      leaseOwnerId: params.ownerId,
      leaseExpiresAt: params.now + params.ttlMs,
      updatedAt: params.now,
    };
    await idbRequestPromise(store.put(next));
    return next;
  });
}
