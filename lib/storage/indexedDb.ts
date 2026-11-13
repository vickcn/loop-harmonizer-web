const DB_NAME = "loop-harmonizer-audio-cache";
const DB_VERSION = 1;

export type AudioCacheStore = "separations" | "settings" | "modelMeta";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("此瀏覽器不支援 IndexedDB。"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ["separations", "settings", "modelMeta"] as const) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("無法開啟本機音訊快取。"));
  });
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
