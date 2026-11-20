import test from "node:test";
import assert from "node:assert/strict";
import {
  LOOP_HARMONIZER_APP_TAG,
  LOOP_HARMONIZER_FOLDER_NAME,
  MultipleManagedAppFoldersError,
  buildStableSongFolderKey,
  clearCachedFolderLayoutForAccount,
  ensureAppFolder,
  ensureSongRevisionFolders,
} from "../lib/google/driveFolderManager.ts";
import { DRIVE_FOLDER_MIME_TYPE } from "../lib/google/driveClient.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

function createFakeDriveFolderServer() {
  let nextId = 1;
  const filesByAuth = new Map(); // authHeader -> Map<id, resource>
  const files = new Map(); // aggregated reference for assertions
  const createCalls = [];

  const getStore = (authHeader) => {
    const key = authHeader || "default";
    let store = filesByAuth.get(key);
    if (!store) {
      store = new Map();
      if (key === "Bearer token-1" || key === "default") {
        store.set("user_manual_folder", {
          id: "user_manual_folder",
          name: LOOP_HARMONIZER_FOLDER_NAME,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          trashed: false,
          parents: ["root"],
          appProperties: {},
          capabilities: { canAddChildren: true, canEdit: true },
        });
      }
      filesByAuth.set(key, store);
    }
    return store;
  };

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const store = getStore(init?.headers?.Authorization);

    if (method === "GET" && u.pathname.startsWith("/drive/v3/files/")) {
      const id = u.pathname.split("/").pop();
      const rec = store.get(id);
      if (!rec || rec.trashed) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify(rec), { status: 200 });
    }

    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const accountMatch = /key='lhAccountId' and value='([^']+)'/.exec(q);
      const roleMatch = /key='lhRole' and value='([^']+)'/.exec(q);
      const songMatch = /key='lhSongKey' and value='([^']+)'/.exec(q);
      const revMatch = /key='lhRevisionId' and value='([^']+)'/.exec(q);
      const parentMatch = /'([^']+)' in parents/.exec(q);
      const requiresManaged = q.includes(`key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}'`);

      const matched = Array.from(store.values()).filter((item) => {
        if (item.trashed) return false;
        if (parentMatch && !item.parents?.includes(parentMatch[1])) return false;
        if (requiresManaged && item.appProperties?.lhApp !== LOOP_HARMONIZER_APP_TAG) return false;
        if (roleMatch && item.appProperties?.lhRole !== roleMatch[1]) return false;
        if (accountMatch && item.appProperties?.lhAccountId !== accountMatch[1]) return false;
        if (songMatch && item.appProperties?.lhSongKey !== songMatch[1]) return false;
        if (revMatch && item.appProperties?.lhRevisionId !== revMatch[1]) return false;
        return true;
      });
      return new Response(JSON.stringify({ files: matched }), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = `folder_${nextId++}`;
      const record = {
        id,
        name: body.name,
        mimeType: body.mimeType,
        trashed: false,
        parents: body.parents ?? ["root"],
        appProperties: body.appProperties ?? {},
        capabilities: { canAddChildren: true, canEdit: true, canDelete: true },
      };
      store.set(id, record);
      files.set(id, record);
      createCalls.push(record);
      return new Response(JSON.stringify(record), { status: 200 });
    }

    return new Response("Not Implemented", { status: 500 });
  };

  return { files, getStore, createCalls, fetchImpl };
}

test("ensureAppFolder ignores same-named user folder, creates managed .loopHarmonizer once, and reuses on repeat calls", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createFakeDriveFolderServer();

    const layout1 = await ensureAppFolder({
      accountId: "google:user1",
      accessToken: "token-1",
      fetchImpl: server.fetchImpl,
    });
    assert.notEqual(layout1.rootFolderId, "user_manual_folder");
    assert.equal(server.files.get(layout1.rootFolderId).appProperties.lhApp, LOOP_HARMONIZER_APP_TAG);
    assert.equal(server.files.get(layout1.rootFolderId).appProperties.lhRole, "root");
    assert.equal(server.files.get(layout1.rootFolderId).appProperties.lhAccountId, "google:user1");
    assert.equal(server.createCalls.length, 3); // root + songs + sessions

    // Clear memory cache to simulate reload/re-login, verify no duplicate creation
    clearCachedFolderLayoutForAccount("google:user1");
    const layout2 = await ensureAppFolder({
      accountId: "google:user1",
      accessToken: "token-1",
      fetchImpl: server.fetchImpl,
    });
    assert.deepEqual(layout2, layout1);
    assert.equal(server.createCalls.length, 3);
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("ensureAppFolder isolates accounts and protects against concurrent cross-tab duplicate creation", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createFakeDriveFolderServer();
    let lockTail = Promise.resolve();
    const lockAdapter = {
      request: async (_name, optionsOrCb, maybeCb) => {
        const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
        const run = lockTail.then(() => cb());
        lockTail = run.catch(() => undefined);
        return run;
      },
    };

    // Simulate two concurrent tabs calling ensureAppFolder for User A
    clearCachedFolderLayoutForAccount("google:userA");
    const [a1, a2] = await Promise.all([
      ensureAppFolder({ accountId: "google:userA", accessToken: "tA", fetchImpl: server.fetchImpl, lockAdapter }),
      ensureAppFolder({ accountId: "google:userA", accessToken: "tA", fetchImpl: server.fetchImpl, lockAdapter }),
    ]);
    assert.deepEqual(a1, a2);
    assert.equal(server.createCalls.length, 3);

    // Account B gets strictly isolated folders
    const b1 = await ensureAppFolder({
      accountId: "google:userB",
      accessToken: "tB",
      fetchImpl: server.fetchImpl,
      lockAdapter,
    });
    assert.notEqual(b1.rootFolderId, a1.rootFolderId);
    assert.notEqual(b1.songsFolderId, a1.songsFolderId);
    assert.equal(server.createCalls.length, 6);
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("ensureAppFolder surfaces MultipleManagedAppFoldersError when multiple managed roots exist and supports resolution", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createFakeDriveFolderServer();
    const dupStore = server.getStore("Bearer token-dup");
    dupStore.set("managed_1", {
      id: "managed_1",
      name: LOOP_HARMONIZER_FOLDER_NAME,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      trashed: false,
      parents: ["root"],
      appProperties: { lhApp: LOOP_HARMONIZER_APP_TAG, lhRole: "root", lhAccountId: "google:dup" },
      capabilities: { canAddChildren: true },
    });
    dupStore.set("managed_2", {
      id: "managed_2",
      name: LOOP_HARMONIZER_FOLDER_NAME,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      trashed: false,
      parents: ["root"],
      appProperties: { lhApp: LOOP_HARMONIZER_APP_TAG, lhRole: "root", lhAccountId: "google:dup" },
      capabilities: { canAddChildren: true },
    });

    await assert.rejects(
      () =>
        ensureAppFolder({
          accountId: "google:dup",
          accessToken: "token-dup",
          fetchImpl: server.fetchImpl,
        }),
      (err) => err instanceof MultipleManagedAppFoldersError && err.candidates.length === 2,
    );

    const chosen = await ensureAppFolder({
      accountId: "google:dup",
      accessToken: "token-dup",
      onMultipleCandidates: async (candidates) => candidates[1].id,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(chosen.rootFolderId, "managed_2");
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("buildStableSongFolderKey keeps same folder after song rename", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createFakeDriveFolderServer();
    const stableSongKey = buildStableSongFolderKey("abcdef1234567890abcdef1234567890");
    assert.equal(stableSongKey, "song_abcdef1234567890abcdef1234567890");

    const f1 = await ensureSongRevisionFolders({
      accountId: "google:rename",
      accessToken: "t1",
      stableSongKey,
      revisionId: "rev-1",
      includeExports: true,
      fetchImpl: server.fetchImpl,
    });

    // Rename song but keep same stableSongKey derived from hash -> same songFolderId & revisionFolderId
    const f2 = await ensureSongRevisionFolders({
      accountId: "google:rename",
      accessToken: "t1",
      stableSongKey,
      revisionId: "rev-1",
      includeExports: true,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(f2.songFolderId, f1.songFolderId);
    assert.equal(f2.revisionFolderId, f1.revisionFolderId);
    assert.ok(f1.exportsFolderId);
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
