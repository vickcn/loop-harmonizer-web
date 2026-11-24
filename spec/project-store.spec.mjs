import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_IDENTITY_SCOPES } from "../lib/google/googleAuthTypes.ts";
import { GoogleAccountManager } from "../lib/google/googleAccountManager.ts";
import {
  buildProjectFromBandSongs,
  createEmptyProject,
  createInitialPersistedProjectRecord,
} from "../lib/projects/projectModel.ts";
import {
  migrateLegacyBandSessionToProject,
  restoreLastActiveProjectOrNull,
} from "../lib/projects/projectManager.ts";
import {
  INDEXEDDB_VERSION,
  PROJECT_OWNER_ACCOUNT_INDEX,
  PROJECT_PROVIDER_INDEX,
  PROJECT_SYNC_ACCOUNT_INDEX,
  PROJECT_SHARE_ACCOUNT_INDEX,
  PROJECT_SHARE_SOURCE_INDEX,
  applyIndexedDbSchemaUpgrade,
  configureInMemoryIdbForTests,
  idbGet,
  idbPut,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import {
  deleteProjectRecord,
  getActiveProjectId,
  getProjectRecord,
  listProjectRecords,
  saveProjectRecord,
  setActiveProjectId,
} from "../lib/storage/projectStore.ts";
import { DEMUCS_MODEL_VERSION, SEPARATION_PROCESSING_VERSION, createSeparationCacheKey } from "../lib/storage/cacheKeys.ts";
import { loadPersistedBandSession, saveSongWithAudioFile } from "../lib/storage/songSessionStore.ts";

test("IndexedDB schema upgrade v5 -> v7 is non-destructive and adds project/share stores and indexes", async () => {
  assert.equal(INDEXEDDB_VERSION, 7);
  const v5Stores = new Map([
    ["audioFiles", new Set()],
    ["separations", new Set()],
    ["models", new Set()],
    ["settings", new Set()],
    ["modelMeta", new Set()],
    ["songs", new Set()],
    ["sessionMeta", new Set()],
    ["separationCheckpoints", new Set(["by_sourceAudioHash"])],
    ["separationChunks", new Set(["by_taskId"])],
    ["driveAccounts", new Set()],
    ["driveTransfers", new Set(["by_ownerAccountId", "by_songId"])],
    ["importedStems", new Set(["by_sourceAudioHash"])],
  ]);
  const createdStores = [];
  const createdIndexes = [];

  const db = {
    objectStoreNames: { contains: (name) => v5Stores.has(name) },
    createObjectStore: (name) => {
      if (v5Stores.has(name)) throw new Error(`existing v5 store should not be recreated: ${name}`);
      createdStores.push(name);
      v5Stores.set(name, new Set());
      return {
        indexNames: { contains: (idx) => v5Stores.get(name).has(idx) },
        createIndex: (idx, keyPath) => {
          v5Stores.get(name).add(idx);
          createdIndexes.push({ store: name, idx, keyPath });
        },
      };
    },
  };
  const tx = {
    objectStore: (name) => ({
      indexNames: { contains: (idx) => v5Stores.get(name).has(idx) },
      createIndex: (idx, keyPath) => {
        v5Stores.get(name).add(idx);
        createdIndexes.push({ store: name, idx, keyPath });
      },
    }),
  };

  applyIndexedDbSchemaUpgrade(db, tx);
  assert.deepEqual(createdStores.sort(), ["projectPreferences", "projectShares", "projectSyncJobs", "projects"]);
  assert.ok(createdIndexes.some((i) => i.store === "projects" && i.idx === PROJECT_OWNER_ACCOUNT_INDEX));
  assert.ok(createdIndexes.some((i) => i.store === "projects" && i.idx === PROJECT_PROVIDER_INDEX));
  assert.ok(createdIndexes.some((i) => i.store === "projectSyncJobs" && i.idx === PROJECT_SYNC_ACCOUNT_INDEX));
  assert.ok(createdIndexes.some((i) => i.store === "projectShares" && i.idx === PROJECT_SHARE_SOURCE_INDEX));
  assert.ok(createdIndexes.some((i) => i.store === "projectShares" && i.idx === PROJECT_SHARE_ACCOUNT_INDEX));

  // Verify existing v5 records in IDB stay intact under v7 runtime operations
  configureInMemoryIdbForTests();
  try {
    const legacySong = createBandSong({
      id: "v5-legacy-song",
      name: "Preserved v5 Track",
      fileName: "v5.mp3",
      sourceAudioId: "v5-legacy-song_original",
      settingsKey: "v5.mp3:1:1",
      originalBpm: 112,
      sourceAudioHash: "v5hash",
      durationSec: 90,
    });
    await saveSongWithAudioFile({
      song: legacySong,
      file: new Blob([new Uint8Array([5, 6, 7])]),
      sourceAudioHash: "v5hash",
    });

    const p = createEmptyProject({ name: "v6 Local Project", storageProvider: "local" });
    await saveProjectRecord(createInitialPersistedProjectRecord(p));

    const persistedSession = await loadPersistedBandSession();
    assert.equal(persistedSession.songs.length, 1);
    assert.equal(persistedSession.songs[0].songId, "v5-legacy-song");
    assert.ok(await idbGet("audioFiles", "v5hash"));
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("Local multi-project CRUD, activeProjectId reload recovery, and delete tombstone prevent resurrection", async () => {
  configureInMemoryIdbForTests();
  try {
    const p1 = createInitialPersistedProjectRecord(
      createEmptyProject({ name: "Set 1", storageProvider: "local", nowIso: "2026-01-01T00:00:00Z" }),
    );
    const p2 = createInitialPersistedProjectRecord(
      createEmptyProject({ name: "Set 2", storageProvider: "local", nowIso: "2026-01-02T00:00:00Z" }),
    );
    await saveProjectRecord(p1);
    await saveProjectRecord(p2);
    await setActiveProjectId(p2.projectId);

    const list = await listProjectRecords({ includeLocal: true });
    assert.equal(list.length, 2);
    assert.equal(await getActiveProjectId(), p2.projectId);

    const restored = await restoreLastActiveProjectOrNull();
    assert.equal(restored?.projectId, p2.projectId);
    assert.equal(restored?.project.name, "Set 2");

    // 刪除 p1 後，過期的背景儲存寫入不得復活 p1
    const staleSnapshot = await getProjectRecord(p1.projectId);
    const del = await deleteProjectRecord(p1.projectId);
    assert.equal(del.deleted, true);
    assert.equal(await getProjectRecord(p1.projectId), null);

    const lateSave = await saveProjectRecord({
      ...staleSnapshot,
      project: { ...staleSnapshot.project, name: "Resurrected Ghost" },
    });
    assert.equal(lateSave.saved, false);
    assert.equal(lateSave.reason, "project_deleted");
    assert.equal(await getProjectRecord(p1.projectId), null);
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("Legacy default-band-mixer session migration preserves legacy data, keeps Drive untouched, and deduplicates repeat migrations", async () => {
  configureInMemoryIdbForTests();
  try {
    const hash = "m".repeat(64);
    const song = {
      ...createBandSong({
        id: "legacy-mig-1",
        name: "Legacy Song",
        fileName: "legacy.mp3",
        sourceAudioId: "legacy-mig-1_original",
        settingsKey: "k-leg-1",
        originalBpm: 118,
        sourceAudioHash: hash,
        durationSec: 150,
      }),
      targetBpm: 126,
      keyShiftSemitones: 2,
      masterVolume: 0.85,
      loop: true,
      separationStatus: "completed",
      separationMode: "four_stem",
      cacheKey: createSeparationCacheKey({
        sourceAudioHash: hash,
        modelVersion: DEMUCS_MODEL_VERSION,
        separationMode: "four_stem",
        processingVersion: SEPARATION_PROCESSING_VERSION,
      }),
    };
    await saveSongWithAudioFile({
      song,
      file: new Blob([new Uint8Array([1, 2, 3, 4])]),
      sourceAudioHash: hash,
    });

    const first = await migrateLegacyBandSessionToProject({
      name: "舊版歌單匯入專案",
      setActive: true,
    });
    assert.equal(first.created, true);
    assert.equal(first.record.storageProvider, "local"); // 絕不自動上傳到 Drive
    assert.equal(first.record.project.songs.length, 1);
    assert.equal(first.record.project.songs[0].settings.targetBpm, 126);
    assert.equal(first.record.project.songs[0].settings.keyShiftSemitones, 2);
    assert.equal(first.record.project.songs[0].settings.masterVolume, 0.85);
    assert.equal(first.record.project.songs[0].settings.loop, true);
    assert.equal(first.record.project.songs[0].sourceAudioHash, hash);

    // 原始 Band Mixer IndexedDB songs 資料完整保留
    const legacyStillThere = await loadPersistedBandSession();
    assert.equal(legacyStillThere.songs.length, 1);
    assert.equal(legacyStillThere.songs[0].songId, "legacy-mig-1");

    // 再次執行遷移不應重複建立重複專案
    const second = await migrateLegacyBandSessionToProject({
      name: "舊版歌單匯入專案",
      setActive: true,
    });
    assert.equal(second.created, false);
    assert.equal(second.alreadyMigratedProjectId, first.record.projectId);
    assert.equal((await listProjectRecords({ includeLocal: true })).length, 1);
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("Verified google:sub <-> drive:permissionId mapping unifies same-account tokens without ever merging disparate accounts by email", async () => {
  configureInMemoryIdbForTests();
  try {
    let grantMode = "full_oidc";
    const manager = new GoogleAccountManager({
      getConfigStatus: () => ({
        configured: true,
        clientId: "cid",
        apiKey: "ak",
        appId: "app",
        missingFields: [],
        message: null,
      }),
      ensureSdkLoaded: async () => {},
      getSdkReadiness: () => "ready",
      subscribeSdkReadiness: () => () => {},
      requestAccessToken: async () => {
        if (grantMode === "full_oidc") {
          return {
            accessToken: "tok-oidc",
            expiresInSec: 3600,
            grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE, ...GOOGLE_IDENTITY_SCOPES],
          };
        }
        return {
          accessToken: grantMode === "drive_only_same" ? "tok-drive-same" : "tok-drive-other",
          expiresInSec: 3600,
          grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
        };
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        const auth = init?.headers?.Authorization ?? "";
        if (u.includes("/oauth2/v3/userinfo") && auth === "Bearer tok-oidc") {
          return new Response(
            JSON.stringify({ sub: "sub_alpha", email: "shared@example.com", name: "User Alpha" }),
            { status: 200 },
          );
        }
        if (u.includes("/drive/v3/about")) {
          if (auth === "Bearer tok-oidc" || auth === "Bearer tok-drive-same") {
            return new Response(
              JSON.stringify({ user: { permissionId: "perm_alpha", emailAddress: "shared@example.com" } }),
              { status: 200 },
            );
          }
          // 另一支獨立帳號（permissionId 不同），僅恰巧回報相同 emailAddress
          return new Response(
            JSON.stringify({ user: { permissionId: "perm_beta", emailAddress: "shared@example.com" } }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      },
    });

    // 1. 以 OIDC + Drive scope 登入 -> 同 token 驗證建立 google:sub_alpha <-> drive:perm_alpha 對應
    const s1 = await manager.signIn();
    assert.equal(s1.account?.accountId, "google:sub_alpha");
    assert.equal(s1.account?.identitySource, "verified_pair");

    // 2. 下次僅獲 drive.file scope（無 OIDC）但同一帳號 permissionId -> 自動解析為同一個 google:sub_alpha 命名空間
    grantMode = "drive_only_same";
    const s2 = await manager.switchAccount();
    assert.equal(s2.account?.accountId, "google:sub_alpha");
    assert.equal(s2.account?.identitySource, "verified_pair");

    // 3. 另一帳號僅有同樣 email 但 permissionId 不同（perm_beta） -> 絕不依 email 自動合併，保留獨立 drive:perm_beta
    grantMode = "drive_only_other";
    const s3 = await manager.switchAccount();
    assert.equal(s3.account?.accountId, "drive:perm_beta");
    assert.notEqual(s3.account?.accountId, "google:sub_alpha");
    manager.dispose();
  } finally {
    resetInMemoryIdbForTests();
  }
});
