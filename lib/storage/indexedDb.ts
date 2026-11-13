const DB_NAME = "loop-harmonizer-audio-cache";
const DB_VERSION = 2;

export type AudioCacheStore =
  | "separations"
  | "settings"
  | "modelMeta"
  | "audioFiles"
  | "songs"
  | "sessionMeta";

const ALL_STORES: readonly AudioCacheStore[] = [
  "separations",
  "settings",
  "modelMeta",
  "audioFiles",
  "songs",
  "sessionMeta",
];

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("此瀏覽器不支援 IndexedDB。"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 保留既有資料表（separations/settings/modelMeta），僅增量建立新增 store
      for (const store of ALL_STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("無法開啟本機音訊快取。"));
    request.onblocked = () => reject(new Error("其他分頁正在更新本機資料庫，請稍候重試。"));
  });
}

export function idbRequestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失敗。"));
  });
}

export function idbWaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 交易失敗。"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 交易已中止。"));
  });
}

export async function withIdbTransaction<T>(
  storeNames: AudioCacheStore | AudioCacheStore[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(storeNames, mode);
    const done = idbWaitTransaction(tx);
    const result = await run(tx);
    await done;
    return result;
  } finally {
    db.close();
  }
}

export async function idbGet<T>(storeName: AudioCacheStore, key: string): Promise<T | null> {
  const db = await openDatabase();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function idbGetAll<T>(storeName: AudioCacheStore): Promise<T[]> {
  const db = await openDatabase();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function idbPut<T>(storeName: AudioCacheStore, value: T): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function idbDelete(storeName: AudioCacheStore, key: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function idbClear(storeName: AudioCacheStore): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(storeName, "readwrite").objectStore(storeName).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
