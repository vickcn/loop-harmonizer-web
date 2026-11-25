import { idbRequestPromise, withIdbTransaction } from "../storage/indexedDb.ts";
import type { ProjectShareRecord, ShareOperationKind } from "./shareTypes.ts";

const localQueues = new Map<string, Promise<unknown>>();

function operationId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `share-op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function reserveOperation(params: {
  shareId: string;
  kind: ShareOperationKind;
  expectedGeneration?: number;
  allowRevoked?: boolean;
}): Promise<{ operationId: string; generation: number; record: ProjectShareRecord | null }> {
  return withIdbTransaction("projectShares", "readwrite", async (tx) => {
    const store = tx.objectStore("projectShares");
    const current = (await idbRequestPromise(store.get(params.shareId))) as ProjectShareRecord | undefined;
    if (current?.status === "revoked" && !params.allowRevoked) {
      throw new Error("此分享已撤銷，過期操作不得重新開放權限。");
    }
    if (params.expectedGeneration !== undefined && current && current.operationGeneration !== params.expectedGeneration) {
      throw new Error("分享狀態已由其他分頁更新，請重新讀取後再操作。");
    }
    const id = operationId();
    const generation = (current?.operationGeneration ?? params.expectedGeneration ?? 0) + 1;
    if (current) {
      await idbRequestPromise(store.put({
        ...current,
        operationGeneration: generation,
        operationId: id,
        operationKind: params.kind,
        operationStartedAt: new Date().toISOString(),
      } satisfies ProjectShareRecord));
    }
    return { operationId: id, generation, record: current ?? null };
  });
}

async function runLocalQueue<T>(key: string, runner: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  localQueues.set(key, tail);
  await previous.catch(() => undefined);
  try { return await runner(); }
  finally {
    release();
    if (localQueues.get(key) === tail) localQueues.delete(key);
  }
}

export async function withProjectShareOperation<T>(params: {
  lockKey: string;
  shareId: string;
  kind: ShareOperationKind;
  expectedGeneration?: number;
  allowRevoked?: boolean;
  runner: (reservation: { operationId: string; generation: number; record: ProjectShareRecord | null }) => Promise<T>;
}): Promise<T> {
  const execute = async () => params.runner(await reserveOperation(params));
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request(`loop-project-share:${params.lockKey}`, { mode: "exclusive" }, execute);
  }
  return runLocalQueue(params.lockKey, execute);
}

export async function assertShareOperationCurrent(shareId: string, id: string, generation: number): Promise<void> {
  await withIdbTransaction("projectShares", "readonly", async (tx) => {
    const current = (await idbRequestPromise(tx.objectStore("projectShares").get(shareId))) as ProjectShareRecord | undefined;
    if (current && (current.operationId !== id || current.operationGeneration !== generation || current.status === "revoked")) {
      throw new Error("分享操作已被其他分頁取代或撤銷。");
    }
  });
}
