import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createBandSong } from "../lib/band/songModel.ts";
import { DRIVE_FOLDER_MIME_TYPE } from "../lib/google/driveClient.ts";
import { clearCachedFolderLayoutForAccount } from "../lib/google/driveFolderManager.ts";
import {
  ProjectAutoSyncController,
  saveProjectToDrive,
} from "../lib/projects/projectDriveSync.ts";
import {
  createNewProject,
  deleteProjectSafely,
  migrateLegacyBandSessionToProject,
  saveLocalProjectSnapshot,
  saveProjectAs,
} from "../lib/projects/projectManager.ts";
import {
  buildProjectFromBandSongs,
  createEmptyProject,
  createInitialPersistedProjectRecord,
} from "../lib/projects/projectModel.ts";
import {
  buildDeleteProjectConfirmConfig,
  resolveProjectManagerActionGroups,
  resolveProjectToolbarActions,
  resolveProjectToolbarStatus,
  resolveSaveActionIntent,
  resolveSyncActionIntent,
} from "../lib/projects/projectToolbarModel.ts";
import {
  configureInMemoryIdbForTests,
  idbGetAll,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import { getProjectRecord, saveProjectRecord } from "../lib/storage/projectStore.ts";
import { hashSourceAudio } from "../lib/storage/separationCache.ts";
import { saveSongWithAudioFile } from "../lib/storage/songSessionStore.ts";

function createDriveMockServer() {
  let nextId = 1;
  let versionSeq = 1;
  const files = new Map();
  const requests = [];
  const writeRequests = [];

  const parseMultipartRequest = (bodyText) => {
    const boundary = bodyText.split("\r\n")[0].trim();
    const parts = bodyText.split(boundary).filter((p) => p.includes("Content-Type: application/json"));
    const metaStart = parts[0].indexOf("{");
    const metaEnd = parts[0].lastIndexOf("}");
    const metadata = JSON.parse(parts[0].slice(metaStart, metaEnd + 1));
    const payStart = parts[1].indexOf("{");
    const payEnd = parts[1].lastIndexOf("}");
    const payload = JSON.parse(parts[1].slice(payStart, payEnd + 1));
    return { metadata, payload };
  };

  let failNextPatch = false;

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url: String(url) });
    if (method !== "GET") {
      writeRequests.push({ method, url: String(url) });
    }

    const authHeader = init?.headers?.Authorization ?? "";
    if (!authHeader || authHeader.includes("expired")) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (method === "GET" && u.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      const rec = files.get(id);
      if (!rec || rec.trashed) return new Response("Not Found", { status: 404 });
      if (u.searchParams.get("alt") === "media") {
        return new Response(JSON.stringify(rec.json), { status: 200 });
      }
      return new Response(JSON.stringify(rec.meta), { status: 200 });
    }

    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const roleMatch = /key='lhRole' and value='([^']+)'/.exec(q);
      const projMatch = /key='lhProjectId' and value='([^']+)'/.exec(q);
      const parentMatch = /'([^']+)' in parents/.exec(q);
      const matched = Array.from(files.values())
        .filter((r) => !r.trashed)
        .filter((r) => {
          const m = r.meta;
          if (parentMatch && !m.parents?.includes(parentMatch[1])) return false;
          if (q.includes(`mimeType='${DRIVE_FOLDER_MIME_TYPE}'`) && m.mimeType !== DRIVE_FOLDER_MIME_TYPE) return false;
          if (roleMatch && m.appProperties?.lhRole !== roleMatch[1]) return false;
          if (projMatch && m.appProperties?.lhProjectId !== projMatch[1]) return false;
          return true;
        })
        .map((r) => r.meta);
      return new Response(JSON.stringify({ files: matched }), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = `drv_${nextId++}`;
      const meta = {
        id,
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents ?? ["root"],
        appProperties: body.appProperties ?? {},
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
        trashed: false,
      };
      files.set(id, { meta, trashed: false });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      const { metadata, payload } = parseMultipartRequest(String(init?.body ?? ""));
      const id = `drv_${nextId++}`;
      const meta = {
        id,
        name: metadata.name,
        mimeType: "application/json",
        parents: metadata.parents ?? ["root"],
        appProperties: metadata.appProperties ?? {},
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
        trashed: false,
      };
      files.set(id, { meta, json: payload, trashed: false });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if (method === "PATCH" && u.pathname.startsWith("/upload/drive/v3/files/")) {
      if (failNextPatch) {
        failNextPatch = false;
        return new Response("Internal Server Error", { status: 500 });
      }
      const id = decodeURIComponent(u.pathname.split("/").pop());
      const rec = files.get(id);
      if (!rec) return new Response("Not Found", { status: 404 });
      const { metadata, payload } = parseMultipartRequest(String(init?.body ?? ""));
      rec.meta = {
        ...rec.meta,
        name: metadata.name ?? rec.meta.name,
        appProperties: { ...(rec.meta.appProperties ?? {}), ...(metadata.appProperties ?? {}) },
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
      };
      rec.json = payload;
      return new Response(JSON.stringify(rec.meta), { status: 200 });
    }

    return new Response("Unhandled mock endpoint", { status: 500 });
  };

  return {
    fetchImpl,
    files,
    requests,
    writeRequests,
    setFailNextPatch: (v) => {
      failNextPatch = v;
    },
  };
}

test("1 & 2 & 10. ProjectToolbar renders strictly 3 actions, ProjectManagerDialog groups operations cleanly, and mobile layout prevents overflow", () => {
  const driveDirty = createInitialPersistedProjectRecord(
    createEmptyProject({
      name: "主日敬拜",
      storageProvider: "google_drive",
      ownerAccountId: "google:acc-1",
    }),
    { dirty: true, syncStatus: "dirty" },
  );
  const driveSynced = { ...driveDirty, dirty: false, syncStatus: "synced" };
  const localProj = createInitialPersistedProjectRecord(
    createEmptyProject({ name: "本機專案", storageProvider: "local" }),
    { dirty: false, syncStatus: "local_only" },
  );

  // 1. 各種狀態皆嚴格回傳恰好三個操作：「專案」「儲存」「同步」
  for (const stateInput of [
    {
      activeProject: null,
      songCount: 0,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
    },
    {
      activeProject: null,
      songCount: 2,
      hasLegacySongs: true,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
    },
    {
      activeProject: localProj,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
    },
    {
      activeProject: driveDirty,
      songCount: 3,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
    },
    {
      activeProject: driveSynced,
      songCount: 3,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
    },
  ]) {
    const actions = resolveProjectToolbarActions(stateInput);
    assert.equal(actions.length, 3);
    assert.deepEqual(
      actions.map((a) => a.text),
      ["專案", "儲存", "同步"],
    );
  }

  // 檢查元件原始碼確定未引入 AdaptiveActionRow 且只有三顆 IconActionButton
  const toolbarSrc = fs.readFileSync(
    path.resolve("components/band/ProjectToolbar.tsx"),
    "utf8",
  );
  assert.equal(toolbarSrc.includes("AdaptiveActionRow"), false);
  assert.equal(toolbarSrc.includes("resolveProjectToolbarActions"), true);

  // 狀態顯示規則驗證
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveDirty,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "saved",
    }).text,
    "本機已儲存 · 尚未同步",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveSynced,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "saved",
    }).text,
    "本機已儲存 · 雲端已同步",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveDirty,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "saving",
      busyAction: "save",
    }).spinning,
    true,
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: localProj,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
      localSaveState: "error",
    }).text,
    "儲存失敗",
  );

  // 2. 專案管理視窗分層檢查（主要 / 次要 / 危險）
  const groups = resolveProjectManagerActionGroups({
    activeProject: driveSynced,
    songCount: 2,
    hasLegacyWorkspaceSongs: true,
    isGoogleConfigured: true,
    focusLocked: false,
    isBusy: false,
  });
  assert.deepEqual(
    groups.primary.map((a) => a.key),
    ["open", "create"],
  );
  assert.equal(
    groups.secondary.some((a) => a.key === "save_as" && a.visible),
    true,
  );
  assert.equal(
    groups.secondary.some((a) => a.key === "rename_active" && a.visible),
    true,
  );
  assert.equal(
    groups.secondary.some((a) => a.key === "migrate_legacy" && a.visible),
    true,
  );
  assert.equal(
    groups.secondary.some((a) => a.key === "offline_download" && a.visible),
    true,
  );
  assert.equal(
    groups.danger.some((a) => a.key === "delete_active" && a.visible),
    true,
  );

  const dialogSrc = fs.readFileSync(
    path.resolve("components/band/ProjectManagerDialog.tsx"),
    "utf8",
  );
  assert.equal(dialogSrc.includes("providerFilter"), true);
  assert.equal(dialogSrc.includes("目前專案與工作區操作（次要操作）"), true);
  assert.equal(dialogSrc.includes("危險操作"), true);

  // 10. 手機窄螢幕 CSS 防溢出契約
  const cssSrc = fs.readFileSync(path.resolve("app/globals.css"), "utf8");
  const mobileBlockStart = cssSrc.indexOf("@media (max-width: 640px)");
  assert.ok(mobileBlockStart !== -1);
  const mobileBlock = cssSrc.slice(mobileBlockStart);
  assert.equal(mobileBlock.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"), true);
  assert.equal(mobileBlock.includes("flex-direction: column"), true);
  assert.equal(mobileBlock.includes("min-width: 0"), true);
});

test("3 & 4 & 5 & 6 & 11 & 12. Save stays local (auto & manual), Sync uploads manually, guides auth & handles conflict without losing local edits", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createDriveMockServer();
    let currentAuth = {
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: (g, a) => g === currentAuth.generation && a === currentAuth.accountId,
    };

    const rec = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Toolbar Sync Flow",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(rec);

    const ctrl = new ProjectAutoSyncController({
      localDebounceMs: 20,
      retryBackoffMs: [5],
      maxRetries: 1,
      getAuthContext: () => currentAuth,
      syncDriveFn: (p) => saveProjectToDrive({ ...p, fetchImpl: server.fetchImpl }),
    });

    // 11. 自動本機保存運作正常，但不觸發任何 Google Drive 請求
    const song = createBandSong({
      id: "e-toolbar-1",
      projectEntryId: "e-toolbar-1",
      name: "Grace Song",
      fileName: "grace.mp3",
      sourceAudioId: "e-toolbar-1_original",
      settingsKey: "k-grace",
      originalBpm: 120,
      sourceAudioHash: "a".repeat(64),
      durationSec: 120,
    });
    const autoEditRec = {
      ...rec,
      localRevision: 2,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: rec.project,
        songs: [{ ...song, targetBpm: 128, keyShiftSemitones: 2 }],
        incrementRevision: true,
      }),
    };
    ctrl.scheduleProjectEdit(autoEditRec);
    await new Promise((r) => setTimeout(r, 60));
    const afterAuto = await getProjectRecord(rec.projectId);
    assert.equal(afterAuto.localRevision, 2);
    assert.equal(afterAuto.project.songs[0].settings.targetBpm, 128);
    assert.equal(server.requests.length, 0);

    // 3. 手動點擊儲存：只寫本機 IndexedDB，Google Drive 寫入次數仍為 0
    const manualEditRec = {
      ...afterAuto,
      localRevision: 3,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: afterAuto.project,
        songs: [{ ...song, targetBpm: 136, keyShiftSemitones: -1 }],
        incrementRevision: true,
      }),
    };
    const saveLocalRes = await ctrl.saveProjectLocallyNow(rec.projectId, manualEditRec);
    assert.equal(saveLocalRes.ok, true);
    assert.equal((await getProjectRecord(rec.projectId)).project.songs[0].settings.targetBpm, 136);
    assert.equal(server.writeRequests.length, 0);

    // 4. 手動點擊同步：才會上傳已保存的 v3 至 Google Drive
    const syncOut = await ctrl.syncProjectManually(rec.projectId);
    assert.equal(syncOut?.status, "synced");
    assert.ok(server.writeRequests.length > 0);
    const syncedDb = await getProjectRecord(rec.projectId);
    assert.equal(syncedDb.dirty, false);
    assert.equal(syncedDb.syncStatus, "synced");

    // 5. 未登入 / Token 過期時能正確引導登入，不觸發上傳且保存本機變更
    const localOnly = createInitialPersistedProjectRecord(
      createEmptyProject({ name: "Need Login Local", storageProvider: "local" }),
      { dirty: false, syncStatus: "local_only" },
    );
    assert.equal(
      resolveSyncActionIntent({
        activeProject: localOnly,
        songCount: 1,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: false,
        hasValidGoogleToken: false,
      }),
      "guide_promote_sign_in",
    );
    assert.equal(
      resolveSyncActionIntent({
        activeProject: syncedDb,
        songCount: 1,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: false,
        hasValidGoogleToken: false,
      }),
      "guide_google_sign_in",
    );

    const writeCountBeforeUnauth = server.writeRequests.length;
    currentAuth = {
      accountId: "",
      accessToken: null,
      generation: 2,
      isGenerationValid: () => false,
    };
    const editWhileSignedOut = {
      ...syncedDb,
      localRevision: 4,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: syncedDb.project,
        songs: [{ ...song, targetBpm: 145 }],
        incrementRevision: true,
      }),
    };
    ctrl.scheduleProjectEdit(editWhileSignedOut);
    const unauthSync = await ctrl.syncProjectManually(rec.projectId);
    assert.equal(unauthSync?.status, "waiting_auth");
    assert.equal(server.writeRequests.length, writeCountBeforeUnauth);
    assert.equal((await getProjectRecord(rec.projectId)).project.songs[0].settings.targetBpm, 145);

    // 重新恢復授權
    currentAuth = {
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 3,
      isGenerationValid: (g, a) => g === 3 && a === "google:user-a",
    };

    // 12. 同步失敗（HTTP 500）不讓本機已保存的變更消失
    server.setFailNextPatch(true);
    const editBeforeFail = {
      ...(await getProjectRecord(rec.projectId)),
      localRevision: 5,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: (await getProjectRecord(rec.projectId)).project,
        songs: [{ ...song, targetBpm: 152, masterVolume: 0.42 }],
        incrementRevision: true,
      }),
    };
    await saveProjectRecord(editBeforeFail);
    const recoveredSync = await ctrl.syncProjectManually(rec.projectId);
    assert.equal(recoveredSync?.status, "synced");
    const afterRetry = await getProjectRecord(rec.projectId);
    assert.equal(afterRetry.project.songs[0].settings.targetBpm, 152);
    assert.equal(afterRetry.project.songs[0].settings.masterVolume, 0.42);

    // 6. 雲端版本衝突不靜默覆蓋
    const mainDriveFile = server.files.get(afterRetry.project.driveProjectFileId);
    mainDriveFile.json = {
      ...mainDriveFile.json,
      revision: 99,
      revisionToken: "r99-remote-device",
      updatedAt: new Date().toISOString(),
    };
    const localDiverged = {
      ...afterRetry,
      localRevision: 6,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: afterRetry.project,
        songs: [{ ...song, targetBpm: 164 }],
        incrementRevision: true,
      }),
    };
    await saveProjectRecord(localDiverged);
    const conflictOut = await ctrl.syncProjectManually(rec.projectId);
    assert.equal(conflictOut?.status, "conflict");
    const dbConflict = await getProjectRecord(rec.projectId);
    assert.equal(dbConflict.syncStatus, "conflict");
    assert.equal(dbConflict.project.songs[0].settings.targetBpm, 164);
    assert.equal(
      resolveSyncActionIntent({
        activeProject: dbConflict,
        songCount: 1,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: true,
        hasValidGoogleToken: true,
      }),
      "open_conflict",
    );
    await ctrl.dispose();
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("7 & 8 & 9. Save without active project guides creation/preserves songs, legacy migration keeps old workspace intact, and delete confirms safely", async () => {
  configureInMemoryIdbForTests();
  try {
    // 7. 沒有正式專案時的儲存與同步意圖
    assert.equal(
      resolveSaveActionIntent({
        activeProject: null,
        songCount: 0,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: false,
        hasValidGoogleToken: false,
      }),
      "disabled_empty",
    );
    assert.equal(
      resolveSaveActionIntent({
        activeProject: null,
        songCount: 2,
        hasLegacySongs: true,
        isGoogleConfigured: true,
        isGoogleSignedIn: false,
        hasValidGoogleToken: false,
      }),
      "guide_create_project",
    );
    assert.equal(
      resolveSyncActionIntent({
        activeProject: null,
        songCount: 2,
        hasLegacySongs: true,
        isGoogleConfigured: true,
        isGoogleSignedIn: true,
        hasValidGoogleToken: true,
      }),
      "disabled_no_project",
    );

    // 準備舊工作區歌曲與原始音檔
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
    const audioHash = await hashSourceAudio(audioBlob);

    const legacySong = {
      ...createBandSong({
        id: "legacy_song_1",
        name: "Legacy Song One",
        fileName: "worship.mp3",
        sourceAudioId: "legacy_song_1_original",
        settingsKey: "k-legacy-1",
        originalBpm: 100,
        sourceAudioHash: audioHash,
        durationSec: 180,
      }),
      targetBpm: 112,
      keyShiftSemitones: 3,
      masterVolume: 0.68,
      loop: true,
    };
    const saveLegacyRes = await saveSongWithAudioFile({
      song: legacySong,
      file: audioBlob,
      sourceAudioHash: audioHash,
    });
    assert.equal(saveLegacyRes.ok, true);

    // 8a. 由「儲存 -> 引導另存專案」建立正式專案：保留歌曲與設定，且不刪除舊工作區資料
    const legacySnapshot = buildProjectFromBandSongs({
      existingProject: {
        schemaVersion: 1,
        application: "loop-harmonizer",
        projectId: "legacy-snapshot",
        name: "目前工作空間",
        storageProvider: "local",
        revision: 1,
        revisionToken: "r1-legacy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        masterSettings: {},
        songs: [],
      },
      songs: [legacySong],
      incrementRevision: false,
    });
    const { record: savedAsProj } = await saveProjectAs({
      sourceProject: legacySnapshot,
      currentSongs: [legacySong],
      name: "敬拜歌單（從未命名工作區建立）",
      storageProvider: "local",
      setActive: true,
    });
    assert.equal(savedAsProj.project.songs.length, 1);
    assert.equal(savedAsProj.project.songs[0].settings.targetBpm, 112);
    assert.equal(savedAsProj.project.songs[0].settings.keyShiftSemitones, 3);
    assert.equal(savedAsProj.project.songs[0].settings.loop, true);
    assert.equal((await idbGetAll("songs")).length, 1);

    // 8b. 遷移舊工作區不遺失歌曲且完整保留舊版 songs store
    const migRes = await migrateLegacyBandSessionToProject({
      songsOverride: [legacySong],
      setActive: true,
    });
    assert.equal(migRes.created, true);
    assert.equal(migRes.record.project.songs.length, 1);
    assert.equal(migRes.record.project.songs[0].settings.targetBpm, 112);
    assert.equal((await idbGetAll("songs")).length, 1);

    // 9. 刪除專案確認彈窗內容完整且刪除後保留原始音檔
    const localConfirm = buildDeleteProjectConfirmConfig({
      projectId: migRes.record.projectId,
      name: migRes.record.project.name,
      storageProvider: "local",
    });
    assert.ok(localConfirm.deleteItems.length > 0);
    assert.ok(localConfirm.preserveItems.some((item) => item.includes("原始音檔")));
    assert.ok(localConfirm.safetyNote.includes("Google Drive"));
    assert.ok(localConfirm.recoverability.includes("可恢復"));

    const cloudConfirm = buildDeleteProjectConfirmConfig({
      projectId: "p-cloud",
      name: "雲端專案",
      storageProvider: "google_drive",
    });
    assert.ok(cloudConfirm.checkboxLabel?.includes("Google Drive"));
    assert.ok(cloudConfirm.recoverability.includes("垃圾桶"));

    await deleteProjectSafely({
      projectId: migRes.record.projectId,
      scope: "local_only",
    });
    assert.equal(await getProjectRecord(migRes.record.projectId), null);
    assert.equal((await idbGetAll("audioFiles")).length, 1);

    // 確保 createNewProject + saveLocalProjectSnapshot 不破壞原有專案建立
    const { record: freshLocal } = await createNewProject({
      name: "另一本機專案",
      storageProvider: "local",
    });
    await saveLocalProjectSnapshot({ projectId: freshLocal.projectId, songs: [legacySong] });
    assert.equal((await getProjectRecord(freshLocal.projectId)).project.songs.length, 1);
  } finally {
    resetInMemoryIdbForTests();
  }
});
