const DB_NAME = "loop-harmonizer-audio-cache";
const DB_VERSION = 6;

export const INDEXEDDB_VERSION = DB_VERSION;
export const SEPARATION_CHECKPOINT_HASH_INDEX = "by_sourceAudioHash";
export const SEPARATION_CHUNK_TASK_INDEX = "by_taskId";
export const DRIVE_TRANSFER_ACCOUNT_INDEX = "by_ownerAccountId";
export const DRIVE_TRANSFER_SONG_INDEX = "by_songId";
export const IMPORTED_STEM_HASH_INDEX = "by_sourceAudioHash";
export const PROJECT_OWNER_ACCOUNT_INDEX = "by_ownerAccountId";
export const PROJECT_PROVIDER_INDEX = "by_storageProvider";
export const PROJECT_SYNC_ACCOUNT_INDEX = "by_ownerAccountId";

export type AudioCacheStore =
  | "separations"
  | "settings"
  | "modelMeta"
  | "audioFiles"
  | "songs"
  | "sessionMeta"
  | "separationCheckpoints"
  | "separationChunks"
  | "driveAccounts"
  | "driveTransfers"
  | "importedStems"
  | "projects"
  | "projectPreferences"
  | "projectSyncJobs";

const ALL_STORES: readonly AudioCacheStore[] = [
  "separations",
  "settings",
  "modelMeta",
  "audioFiles",
  "songs",
  "sessionMeta",
  "separationCheckpoints",
  "separationChunks",
  "driveAccounts",
  "driveTransfers",
  "importedStems",
  "projects",
  "projectPreferences",
  "projectSyncJobs",
];

export interface InMemoryIdbHooks {
  /** 在讀取指定 store 前呼叫，可用於驗證索引查詢不掃描完整二進位資料 */
  beforeRead?: (
    storeName: AudioCacheStore,
    op: "get" | "getAll" | "getAllKeys" | "indexGetAll" | "indexGetAllKeys" | "openKeyCursor",
    key?: string,
  ) => void;
  /** 在寫入指定 store 前注入錯誤，用於驗證交易失敗時的原子性回滾 */
  beforeWrite?: (storeName: AudioCacheStore, op: "put" | "delete" | "clear", key?: string) => void;
  /** 在寫入指定 store 後、提交前注入錯誤，用於驗證已寫入同一交易的其他資料是否一併回滾 */
  afterWrite?: (storeName: AudioCacheStore, op: "put" | "delete" | "clear", key?: string) => void;
}

interface InMemoryIdbState {
  stores: Map<AudioCacheStore, Map<string, unknown>>;
  hooks: InMemoryIdbHooks;
  txTail: Promise<void>;
}

let inMemoryIdb: InMemoryIdbState | null = null;

function cloneStoreValue<T>(value: T): T {
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as unknown as T;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    const Ctor = value.constructor as new (buf: ArrayBuffer) => T;
    return new Ctor(copy.buffer);
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneStoreValue(item)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneStoreValue(v);
  }
  return out as T;
}

function createMemoryStoreMap(): Map<AudioCacheStore, Map<string, unknown>> {
  const stores = new Map<AudioCacheStore, Map<string, unknown>>();
  for (const name of ALL_STORES) {
    stores.set(name, new Map());
  }
  return stores;
}

/** 僅供 Node 單元測試啟用記憶體內交易式 IndexedDB（模擬 atomic commit/rollback） */
export function configureInMemoryIdbForTests(hooks: InMemoryIdbHooks = {}): void {
  if (!inMemoryIdb) {
    inMemoryIdb = {
      stores: createMemoryStoreMap(),
      hooks,
      txTail: Promise.resolve(),
    };
  } else {
    inMemoryIdb.hooks = hooks;
  }
}

export function setInMemoryIdbHooksForTests(hooks: InMemoryIdbHooks = {}): void {
  if (!inMemoryIdb) {
    configureInMemoryIdbForTests(hooks);
    return;
  }
  inMemoryIdb.hooks = hooks;
}

export function resetInMemoryIdbForTests(): void {
  inMemoryIdb = null;
}

function createImmediateIdbRequest<T>(executor: () => T): IDBRequest<T> {
  const req = {
    result: undefined as unknown as T,
    error: null as DOMException | null,
    onsuccess: null as ((this: IDBRequest<T>, ev: Event) => unknown) | null,
    onerror: null as ((this: IDBRequest<T>, ev: Event) => unknown) | null,
  } as unknown as IDBRequest<T>;
  queueMicrotask(() => {
    try {
      (req as unknown as { result: T }).result = executor();
      req.onsuccess?.call(req, { target: req } as unknown as Event);
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      (req as unknown as { error: Error }).error = errorObj;
      req.onerror?.call(req, { target: req } as unknown as Event);
    }
  });
  return req;
}

export interface UpgradeableStoreLike {
  indexNames: { contains(name: string): boolean };
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: IDBIndexParameters,
  ): unknown;
}

export interface UpgradeableDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): UpgradeableStoreLike;
}

/**
 * 向後相容的 IndexedDB schema 升級：
 * - v1~v4 -> v5：僅增量建立 missing stores 與 metadata indexes，絕不清空或覆寫既有音訊/歌曲資料。
 */
export function applyIndexedDbSchemaUpgrade(
  db: UpgradeableDatabaseLike,
  upgradeTx: { objectStore(name: string): UpgradeableStoreLike } | null,
): void {
  for (const storeName of ALL_STORES) {
    let store: UpgradeableStoreLike | null = null;
    if (!db.objectStoreNames.contains(storeName)) {
      store = db.createObjectStore(storeName, { keyPath: "key" });
    } else if (upgradeTx) {
      store = upgradeTx.objectStore(storeName);
    }

    if (!store) continue;

    if (
      storeName === "separationCheckpoints" &&
      !store.indexNames.contains(SEPARATION_CHECKPOINT_HASH_INDEX)
    ) {
      store.createIndex(SEPARATION_CHECKPOINT_HASH_INDEX, "sourceAudioHash", {
        unique: false,
      });
    }
    if (
      storeName === "separationChunks" &&
      !store.indexNames.contains(SEPARATION_CHUNK_TASK_INDEX)
    ) {
      store.createIndex(SEPARATION_CHUNK_TASK_INDEX, "taskId", {
        unique: false,
      });
    }
    if (
      storeName === "driveTransfers" &&
      !store.indexNames.contains(DRIVE_TRANSFER_ACCOUNT_INDEX)
    ) {
      store.createIndex(DRIVE_TRANSFER_ACCOUNT_INDEX, "ownerAccountId", {
        unique: false,
      });
    }
    if (
      storeName === "driveTransfers" &&
      !store.indexNames.contains(DRIVE_TRANSFER_SONG_INDEX)
    ) {
      store.createIndex(DRIVE_TRANSFER_SONG_INDEX, "songId", {
        unique: false,
      });
    }
    if (
      storeName === "importedStems" &&
      !store.indexNames.contains(IMPORTED_STEM_HASH_INDEX)
    ) {
      store.createIndex(IMPORTED_STEM_HASH_INDEX, "sourceAudioHash", {
        unique: false,
      });
    }
    if (
      storeName === "projects" &&
      !store.indexNames.contains(PROJECT_OWNER_ACCOUNT_INDEX)
    ) {
      store.createIndex(PROJECT_OWNER_ACCOUNT_INDEX, "ownerAccountId", {
        unique: false,
      });
    }
    if (
      storeName === "projects" &&
      !store.indexNames.contains(PROJECT_PROVIDER_INDEX)
    ) {
      store.createIndex(PROJECT_PROVIDER_INDEX, "storageProvider", {
        unique: false,
      });
    }
    if (
      storeName === "projectSyncJobs" &&
      !store.indexNames.contains(PROJECT_SYNC_ACCOUNT_INDEX)
    ) {
      store.createIndex(PROJECT_SYNC_ACCOUNT_INDEX, "ownerAccountId", {
        unique: false,
      });
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("此瀏覽器不支援 IndexedDB。"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx =
        request.transaction ??
        (event.target as IDBOpenDBRequest | null)?.transaction ??
        null;
      applyIndexedDbSchemaUpgrade(db, tx);
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

async function runInMemoryTransaction<T>(
  storeNames: AudioCacheStore | AudioCacheStore[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const mem = inMemoryIdb;
  if (!mem) {
    throw new Error("In-memory IndexedDB 尚未初始化。");
  }
  const allowedStores = Array.isArray(storeNames) ? storeNames : [storeNames];
  const prevTail = mem.txTail;
  let releaseLock!: () => void;
  mem.txTail = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await prevTail;
  try {
    // 為參與交易的 store 建立沙盒副本，任何失敗都不汙染已提交狀態
    const workingStores = new Map<AudioCacheStore, Map<string, unknown>>();
    for (const storeName of allowedStores) {
      const source = mem.stores.get(storeName) ?? new Map<string, unknown>();
      if (mode === "readwrite") {
        const snapshot = new Map<string, unknown>();
        for (const [k, v] of source.entries()) {
          snapshot.set(k, cloneStoreValue(v));
        }
        workingStores.set(storeName, snapshot);
      } else {
        workingStores.set(storeName, source);
      }
    }

    let aborted = false;
    const txError: Error | null = null;

    const fakeTx = {
      mode,
      aborted: false,
      error: txError,
      abort() {
        aborted = true;
      },
      objectStore(name: string): IDBObjectStore {
        const storeName = name as AudioCacheStore;
        const map = workingStores.get(storeName);
        if (!map) {
          throw new Error(`交易未開啟資料表：${name}`);
        }
        return {
          get(key: IDBValidKey) {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              mem.hooks.beforeRead?.(storeName, "get", String(key));
              const val = map.get(String(key));
              return val === undefined ? undefined : cloneStoreValue(val);
            });
          },
          getAll() {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              mem.hooks.beforeRead?.(storeName, "getAll");
              return Array.from(map.values(), (v) => cloneStoreValue(v));
            });
          },
          getAllKeys() {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              mem.hooks.beforeRead?.(storeName, "getAllKeys");
              return Array.from(map.keys());
            });
          },
          index(indexName: string) {
            const extractIndexedField = (rec: unknown): unknown => {
              if (!rec || typeof rec !== "object") return undefined;
              const obj = rec as Record<string, unknown>;
              if (
                storeName === "separationCheckpoints" &&
                indexName === SEPARATION_CHECKPOINT_HASH_INDEX
              ) {
                return obj.sourceAudioHash;
              }
              if (
                storeName === "separationChunks" &&
                indexName === SEPARATION_CHUNK_TASK_INDEX
              ) {
                return obj.taskId;
              }
              if (
                storeName === "driveTransfers" &&
                indexName === DRIVE_TRANSFER_ACCOUNT_INDEX
              ) {
                return obj.ownerAccountId;
              }
              if (
                storeName === "driveTransfers" &&
                indexName === DRIVE_TRANSFER_SONG_INDEX
              ) {
                return obj.songId;
              }
              if (
                storeName === "importedStems" &&
                indexName === IMPORTED_STEM_HASH_INDEX
              ) {
                return obj.sourceAudioHash;
              }
              if (
                storeName === "projects" &&
                indexName === PROJECT_OWNER_ACCOUNT_INDEX
              ) {
                return obj.ownerAccountId;
              }
              if (
                storeName === "projects" &&
                indexName === PROJECT_PROVIDER_INDEX
              ) {
                return obj.storageProvider;
              }
              if (
                storeName === "projectSyncJobs" &&
                indexName === PROJECT_SYNC_ACCOUNT_INDEX
              ) {
                return obj.ownerAccountId;
              }
              throw new Error(`資料表 ${storeName} 尚未建立索引：${indexName}`);
            };
            const matchesQuery = (rec: unknown, query?: IDBValidKey | IDBKeyRange): boolean => {
              if (query === undefined || query === null) return true;
              const fieldVal = extractIndexedField(rec);
              if (typeof query === "object" && "lower" in query && "upper" in query) {
                const range = query as IDBKeyRange;
                const lowerOk =
                  range.lower === undefined ||
                  (range.lowerOpen ? String(fieldVal) > String(range.lower) : String(fieldVal) >= String(range.lower));
                const upperOk =
                  range.upper === undefined ||
                  (range.upperOpen ? String(fieldVal) < String(range.upper) : String(fieldVal) <= String(range.upper));
                return lowerOk && upperOk;
              }
              return fieldVal === query;
            };
            return {
              getAll(query?: IDBValidKey | IDBKeyRange) {
                return createImmediateIdbRequest(() => {
                  if (aborted) throw new Error("IndexedDB 交易已中止。");
                  mem.hooks.beforeRead?.(storeName, "indexGetAll", indexName);
                  const out: unknown[] = [];
                  for (const val of map.values()) {
                    if (matchesQuery(val, query)) out.push(cloneStoreValue(val));
                  }
                  return out;
                });
              },
              getAllKeys(query?: IDBValidKey | IDBKeyRange) {
                return createImmediateIdbRequest(() => {
                  if (aborted) throw new Error("IndexedDB 交易已中止。");
                  mem.hooks.beforeRead?.(storeName, "indexGetAllKeys", indexName);
                  const out: IDBValidKey[] = [];
                  for (const [k, val] of map.entries()) {
                    if (matchesQuery(val, query)) out.push(k);
                  }
                  return out;
                });
              },
              openKeyCursor(query?: IDBValidKey | IDBKeyRange) {
                mem.hooks.beforeRead?.(storeName, "openKeyCursor", indexName);
                const entries: Array<{ indexKey: IDBValidKey; primaryKey: IDBValidKey }> = [];
                for (const [k, val] of map.entries()) {
                  if (matchesQuery(val, query)) {
                    entries.push({
                      indexKey: extractIndexedField(val) as IDBValidKey,
                      primaryKey: k,
                    });
                  }
                }
                let cursorPos = 0;
                const req = {
                  result: null as IDBCursor | null,
                  error: null as DOMException | null,
                  onsuccess: null as ((ev: Event) => void) | null,
                  onerror: null as ((ev: Event) => void) | null,
                };
                const emitNext = () => {
                  queueMicrotask(() => {
                    if (aborted) {
                      req.error = new Error("IndexedDB 交易已中止。") as unknown as DOMException;
                      req.onerror?.(new Event("error"));
                      return;
                    }
                    if (cursorPos >= entries.length) {
                      req.result = null;
                      req.onsuccess?.(new Event("success"));
                      return;
                    }
                    const current = entries[cursorPos++];
                    req.result = {
                      key: current.indexKey,
                      primaryKey: current.primaryKey,
                      continue() {
                        emitNext();
                      },
                    } as unknown as IDBCursor;
                    req.onsuccess?.(new Event("success"));
                  });
                };
                emitNext();
                return req as unknown as IDBRequest<IDBCursor | null>;
              },
            } as unknown as IDBIndex;
          },
          put(value: { key?: string }) {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              if (mode !== "readwrite") throw new Error("唯讀交易不可寫入。");
              const key = String(value?.key ?? "");
              if (!key) throw new Error("IndexedDB record 缺少 key 欄位。");
              mem.hooks.beforeWrite?.(storeName, "put", key);
              map.set(key, cloneStoreValue(value));
              mem.hooks.afterWrite?.(storeName, "put", key);
              return key as unknown as IDBValidKey;
            });
          },
          delete(key: IDBValidKey) {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              if (mode !== "readwrite") throw new Error("唯讀交易不可刪除。");
              const keyStr = String(key);
              mem.hooks.beforeWrite?.(storeName, "delete", keyStr);
              map.delete(keyStr);
              mem.hooks.afterWrite?.(storeName, "delete", keyStr);
              return undefined;
            });
          },
          clear() {
            return createImmediateIdbRequest(() => {
              if (aborted) throw new Error("IndexedDB 交易已中止。");
              if (mode !== "readwrite") throw new Error("唯讀交易不可清空。");
              mem.hooks.beforeWrite?.(storeName, "clear");
              map.clear();
              mem.hooks.afterWrite?.(storeName, "clear");
              return undefined;
            });
          },
        } as unknown as IDBObjectStore;
      },
    } as unknown as IDBTransaction;

    const result = await run(fakeTx);
    if (aborted) {
      throw new Error("IndexedDB 交易已中止。");
    }
    if (mode === "readwrite") {
      for (const [storeName, workingMap] of workingStores.entries()) {
        mem.stores.set(storeName, workingMap);
      }
    }
    return result;
  } finally {
    releaseLock();
  }
}

export async function withIdbTransaction<T>(
  storeNames: AudioCacheStore | AudioCacheStore[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  if (inMemoryIdb) {
    return runInMemoryTransaction(storeNames, mode, run);
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction(storeNames, mode);
    const done = idbWaitTransaction(tx);
    // 預先掛載 catch 避免 run(tx) 同步/非同步擲出例外時 done 形成 unhandled rejection
    done.catch(() => {});
    try {
      const result = await run(tx);
      await done;
      return result;
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // 交易可能已結束
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

export async function idbGet<T>(storeName: AudioCacheStore, key: string): Promise<T | null> {
  if (inMemoryIdb) {
    return runInMemoryTransaction(storeName, "readonly", async (tx) => {
      const res = await idbRequestPromise(tx.objectStore(storeName).get(key));
      return (res as T | undefined) ?? null;
    });
  }
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
  if (inMemoryIdb) {
    return runInMemoryTransaction(storeName, "readonly", async (tx) => {
      const res = await idbRequestPromise(tx.objectStore(storeName).getAll());
      return (res as T[]) ?? [];
    });
  }
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
  if (inMemoryIdb) {
    await runInMemoryTransaction(storeName, "readwrite", async (tx) => {
      await idbRequestPromise(tx.objectStore(storeName).put(value));
    });
    return;
  }
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
  if (inMemoryIdb) {
    await runInMemoryTransaction(storeName, "readwrite", async (tx) => {
      await idbRequestPromise(tx.objectStore(storeName).delete(key));
    });
    return;
  }
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
  if (inMemoryIdb) {
    await runInMemoryTransaction(storeName, "readwrite", async (tx) => {
      await idbRequestPromise(tx.objectStore(storeName).clear());
    });
    return;
  }
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
