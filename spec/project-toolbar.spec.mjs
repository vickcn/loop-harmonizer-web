import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createBandSong } from "../lib/band/songModel.ts";
import { DRIVE_FOLDER_MIME_TYPE } from "../lib/google/driveClient.ts";
import { GoogleAccountManager } from "../lib/google/googleAccountManager.ts";
import { clearCachedFolderLayoutForAccount } from "../lib/google/driveFolderManager.ts";
import {
  ProjectAutoSyncController,
  saveProjectToDrive,
} from "../lib/projects/projectDriveSync.ts";
import {
  SaveAsPersistenceError,
  createNewProject,
  deleteProjectSafely,
  migrateLegacyBandSessionToProject,
  prepareAndSaveProjectAs,
  saveLocalProjectSnapshot,
  saveProjectAs,
  verifySongsForProjectSaveAs,
} from "../lib/projects/projectManager.ts";
import {
  buildProjectFromBandSongs,
  createEmptyProject,
  createInitialPersistedProjectRecord,
} from "../lib/projects/projectModel.ts";
import {
  PROJECT_STATE_UNAVAILABLE_MESSAGE,
  ProjectManualSyncCoordinator,
} from "../lib/projects/projectSyncCoordinator.ts";
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
  idbPut,
  resetInMemoryIdbForTests,
  setInMemoryIdbHooksForTests,
  withIdbTransaction,
} from "../lib/storage/indexedDb.ts";
import {
  getActiveProjectId,
  getProjectRecord,
  saveProjectRecord,
} from "../lib/storage/projectStore.ts";
import { hashSourceAudio } from "../lib/storage/separationCache.ts";
import {
  flushPendingSongPersists,
  resetPendingSongPersistsForTests,
  saveSongStateRecord,
  saveSongWithAudioFile,
  scheduleSongPersist,
} from "../lib/storage/songSessionStore.ts";

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

  // 10. 手機窄螢幕 CSS 防溢出契約 & Tooltip 防直條／頂部裁切契約
  const cssSrc = fs.readFileSync(path.resolve("app/globals.css"), "utf8");
  const mobileBlockStart = cssSrc.indexOf("@media (max-width: 640px)");
  assert.ok(mobileBlockStart !== -1);
  const mobileBlock = cssSrc.slice(mobileBlockStart);
  assert.equal(mobileBlock.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"), true);
  assert.equal(mobileBlock.includes("flex-direction: column"), true);
  assert.equal(mobileBlock.includes("min-width: 0"), true);
  assert.equal(cssSrc.includes("width: max-content;"), true);
  assert.equal(cssSrc.includes("is-tooltip-below"), true);
  assert.equal(cssSrc.includes("is-tooltip-align-left"), true);
  assert.equal(cssSrc.includes("is-tooltip-align-right"), true);

  const iconBtnSrc = fs.readFileSync(
    path.resolve("components/band/IconActionButton.tsx"),
    "utf8",
  );
  assert.equal(toolbarSrc.includes('tooltipPlacement="bottom"'), true);
  assert.equal(iconBtnSrc.includes("getBoundingClientRect"), true);

  // 11. Micro-interactions 契約（.badge、primary、手機回饋列保留、選單防溢出、清除選取、單一捲動與背景快捷鍵保護）
  assert.equal(cssSrc.includes(".badge {"), true);
  assert.equal(cssSrc.includes(".mixer-button.is-danger"), true);
  assert.equal(cssSrc.includes(".mixer-modal-body {"), true);
  assert.equal(cssSrc.includes(".is-menu-align-left"), true);
  assert.equal(/\.mixer-shortcut-bar\s*\{\s*display:\s*none/.test(cssSrc), false);
  const guardSrc = fs.readFileSync(path.resolve("components/band/ResourceGuardModal.tsx"), "utf8");
  assert.equal(guardSrc.includes("mixer-primary"), false);
  const songCardSrc = fs.readFileSync(path.resolve("components/band/SongCard.tsx"), "utf8");
  assert.equal(songCardSrc.includes("onPointerDown={(event) => event.stopPropagation()}"), true);
  const bandMixerSrc = fs.readFileSync(path.resolve("components/band/BandMixer.tsx"), "utf8");
  assert.equal(bandMixerSrc.includes("清除選取"), true);
  assert.equal(bandMixerSrc.includes("全選"), true);
  assert.equal(bandMixerSrc.includes("Boolean(projectDialogMode) ||"), true);

  // 12. Management-app 流程安全性與狀態真相契約（優先項 1～7）
  assert.equal(bandMixerSrc.includes("window.confirm("), false);
  assert.equal(bandMixerSrc.includes("projectListLoadSeqRef"), true);
  assert.equal(bandMixerSrc.includes("offlineAssessmentSeqRef"), true);
  assert.equal(bandMixerSrc.includes("flushCurrentWorkspaceBeforeSwitch"), true);
  assert.equal(bandMixerSrc.includes("teardownActiveWorkspaceRuntime"), true);
  assert.equal(bandMixerSrc.includes("formatBatchPlaySummary"), true);
  const openEntryStart = bandMixerSrc.indexOf("const handleOpenProjectEntry");
  const createSubmitStart = bandMixerSrc.indexOf("const handleCreateProjectSubmit");
  const saveAsSubmitStart = bandMixerSrc.indexOf("const handleSaveAsProjectSubmit");
  assert.ok(openEntryStart !== -1 && createSubmitStart > openEntryStart && saveAsSubmitStart > createSubmitStart);
  const openEntrySlice = bandMixerSrc.slice(openEntryStart, createSubmitStart);
  const createSubmitSlice = bandMixerSrc.slice(createSubmitStart, saveAsSubmitStart);
  assert.equal(openEntrySlice.includes("setActive: false"), true);
  assert.equal(createSubmitSlice.includes("setActive: false"), true);
  assert.ok(openEntrySlice.indexOf("openProjectMetadataAndEntries") < openEntrySlice.indexOf("teardownActiveWorkspaceRuntime"));
  assert.ok(createSubmitSlice.indexOf("createNewProject") < createSubmitSlice.indexOf("teardownActiveWorkspaceRuntime"));
  assert.equal(dialogSrc.includes("清除篩選條件"), true);
  assert.equal(dialogSrc.includes("建立第一個專案"), true);
  assert.equal(dialogSrc.includes("所有可用歌曲均已本機就緒"), true);

  // 13. 窄版面防溢出與手機雙列分軌契約
  const adaptiveRowSrc = fs.readFileSync(
    path.resolve("components/band/AdaptiveActionRow.tsx"),
    "utf8",
  );
  const stemMixerSrc = fs.readFileSync(
    path.resolve("components/band/StemMixer.tsx"),
    "utf8",
  );
  assert.equal(cssSrc.includes(".grid { display: grid; grid-template-columns: minmax(0, 1fr);"), true);
  assert.equal(cssSrc.includes(".grid > * { min-width: 0; }"), true);
  assert.equal(cssSrc.includes(".adaptive-measure-clip"), true);
  assert.equal(cssSrc.includes("overflow-wrap: anywhere"), true);
  assert.equal(cssSrc.includes("@media (max-width: 540px)"), true);
  assert.equal(cssSrc.includes(".stem-row-slider"), true);
  assert.equal(adaptiveRowSrc.includes("adaptive-measure-clip"), true);
  assert.equal(stemMixerSrc.includes("stem-row-label"), true);
  assert.equal(stemMixerSrc.includes("stem-row-slider"), true);
  assert.equal(stemMixerSrc.includes("stem-row-actions"), true);
  assert.equal(songCardSrc.includes("song-separation-status-text"), true);
  assert.equal(songCardSrc.includes("song-card-header-meta"), true);

  // 14. 歌曲狀態過多濃縮為彩色光點（Hover / 長按浮動詳情）契約
  const statusIndicatorsSrc = fs.readFileSync(
    path.resolve("components/band/SongStatusIndicators.tsx"),
    "utf8",
  );
  assert.equal(songCardSrc.includes("SongStatusIndicators"), true);
  assert.equal(songCardSrc.includes("buildSongStatusIndicators"), true);
  assert.equal(statusIndicatorsSrc.includes("onMouseEnter"), true);
  assert.equal(statusIndicatorsSrc.includes("onTouchStart"), true);
  assert.equal(statusIndicatorsSrc.includes("onTouchMove"), true);
  assert.equal(statusIndicatorsSrc.includes("onContextMenu"), true);
  assert.equal(statusIndicatorsSrc.includes("status-dot-tooltip"), true);
  assert.equal(cssSrc.includes(".status-dot-cluster"), true);
  assert.equal(cssSrc.includes(".status-led-dot"), true);
  assert.equal(cssSrc.includes(".status-dot-tooltip"), true);

  // 15. 分軌播放來源一致性與自動切換契約
  assert.equal(bandMixerSrc.includes("switchingSourceSongIdsRef"), true);
  assert.equal(bandMixerSrc.includes("switchSourceRef"), true);
  assert.equal(bandMixerSrc.includes("已自動切換為分軌混音"), true);
  const releaseIdleStart = bandMixerSrc.indexOf("const releaseIdleResources =");
  const ensureStemsStart = bandMixerSrc.indexOf("const ensureStemsInstalledForReadySong =");
  assert.ok(releaseIdleStart !== -1 && ensureStemsStart > releaseIdleStart);
  const releaseIdleSlice = bandMixerSrc.slice(releaseIdleStart, ensureStemsStart);
  assert.equal(releaseIdleSlice.includes('playbackSource: song.playbackSource === "stems" ? "original"'), false);
  assert.equal(songCardSrc.includes("stem-source-inactive-banner"), true);
  assert.equal(songCardSrc.includes("切換分軌混音"), true);

  // 16. 手機速度拉桿長按解鎖防誤觸契約
  const touchSliderSrc = fs.readFileSync(
    path.resolve("components/band/TouchGuardedRangeSlider.tsx"),
    "utf8",
  );
  assert.equal(songCardSrc.includes("TouchGuardedRangeSlider"), true);
  assert.equal(touchSliderSrc.includes("passive: false"), true);
  assert.equal(touchSliderSrc.includes("shouldCancelSliderLongPress"), true);
  assert.equal(touchSliderSrc.includes("computeRelativeSliderValue"), true);
  assert.equal(touchSliderSrc.includes("onContextMenu"), true);
  assert.equal(touchSliderSrc.includes("長按拉桿再左右滑動以調整速度"), true);
  assert.equal(cssSrc.includes(".touch-guarded-slider"), true);
  assert.equal(cssSrc.includes("touch-action: pan-y"), true);
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
    resetPendingSongPersistsForTests();
    resetInMemoryIdbForTests();
  }
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("P1 (Save-As Fail-Closed): song persist failures & missing local audio block save-as without wiping session/stems/checkpoints, while Drive-backed sources stay recoverable", async () => {
  configureInMemoryIdbForTests();
  resetPendingSongPersistsForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const audioBytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const audioBlob = new Blob([audioBytes], { type: "audio/wav" });
    const localHash = await hashSourceAudio(audioBlob);

    const localSong = {
      ...createBandSong({
        id: "song_saveas_local",
        name: "Praise Song Local",
        fileName: "praise.wav",
        sourceAudioId: "song_saveas_local_original",
        settingsKey: "k-praise-local",
        originalBpm: 120,
        sourceAudioHash: localHash,
        durationSec: 120,
        persistenceStatus: "saved",
      }),
      targetBpm: 126,
      separationStatus: "completed",
      separationMode: "four_stem",
      separationTaskId: "task_keep_1",
      cacheKey: `cache_${localHash}`,
    };

    const saveAudioRes = await saveSongWithAudioFile({
      song: localSong,
      file: audioBlob,
      sourceAudioHash: localHash,
    });
    assert.equal(saveAudioRes.ok, true);
    const syncedLocalSong = {
      ...localSong,
      revision: saveAudioRes.record.revision,
    };

    // 模擬原工作階段已經有完成的 Checkpoint 與作用中原始專案
    await idbPut("separationCheckpoints", {
      key: "task_keep_1",
      taskId: "task_keep_1",
      songId: localSong.id,
      sourceAudioHash: localHash,
      status: "completed",
    });
    const { record: originProject } = await createNewProject({
      name: "原始基準專案",
      storageProvider: "local",
      setActive: true,
    });
    const projectsBeforeSaveAsFail = (await idbGetAll("projects")).length;

    // 1. 歌曲保存成功後（含等待中的 pending persist 與 in-flight audio）可以另存新專案
    let currentSongRef = { ...syncedLocalSong, targetBpm: 130 };
    scheduleSongPersist(
      currentSongRef.id,
      () => currentSongRef,
      (_id, res) => {
        if (res.ok) {
          currentSongRef = { ...currentSongRef, revision: res.record.revision };
        }
      },
      500,
    );
    const { record: validClone, readiness: okReadiness } = await prepareAndSaveProjectAs({
      sourceProject: originProject.project,
      currentSongs: [currentSongRef],
      name: "歌曲完成保存之副本",
      storageProvider: "local",
      setActive: false,
    });
    assert.equal(okReadiness.ok, true);
    assert.equal(validClone.project.songs.length, 1);
    assert.equal(validClone.project.songs[0].settings.targetBpm, 130);
    assert.equal((await idbGetAll("songs")).find((s) => s.songId === currentSongRef.id)?.targetBpm, 130);

    // 2a. 歌曲持久化失敗（flushPendingSongPersists 遇到 IDB QuotaExceededError）不得回報成功且停止另存
    const editedFailSong = { ...currentSongRef, targetBpm: 140 };
    let persistUiErrorObserved = "";
    scheduleSongPersist(
      editedFailSong.id,
      () => editedFailSong,
      (_id, res) => {
        if (!res.ok && res.reason === "error") {
          persistUiErrorObserved = res.message;
        }
      },
      500,
    );
    setInMemoryIdbHooksForTests({
      beforeWrite(store) {
        if (store === "songs") {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
      },
    });
    await assert.rejects(
      prepareAndSaveProjectAs({
        sourceProject: originProject.project,
        currentSongs: [editedFailSong],
        name: "配額失敗不應建立專案",
        storageProvider: "local",
        setActive: true,
      }),
      (err) => {
        assert.equal(err instanceof SaveAsPersistenceError, true);
        assert.match(err.message, /Praise Song Local/);
        assert.match(err.message, /儲存空間不足/);
        return true;
      },
    );
    assert.match(persistUiErrorObserved, /儲存空間不足/);

    // 2b. 即便 debounce 計時器已觸發進入 in-flight、IDB 交易尚未 settle 時立即另存，仍須等待並 Fail Closed
    const txHoldDef = createDeferred();
    const holdingTx = withIdbTransaction(["songs"], "readonly", () => txHoldDef.promise);
    scheduleSongPersist(
      editedFailSong.id,
      () => editedFailSong,
      () => undefined,
      0,
    );
    await new Promise((r) => setTimeout(r, 5)); // 讓 timer 觸發並卡在 inFlightSongPersists 等待 IDB 鎖定
    setInMemoryIdbHooksForTests({
      beforeWrite(store) {
        if (store === "songs") {
          throw new Error("Transient IDB IO Failure");
        }
      },
    });
    const inFlightFlushPromise = flushPendingSongPersists();
    txHoldDef.resolve();
    await holdingTx;
    const inFlightFlushRes = await inFlightFlushPromise;
    assert.equal(inFlightFlushRes.ok, false);
    assert.equal(inFlightFlushRes.failed.length, 1);
    assert.match(inFlightFlushRes.failed[0].message, /Transient IDB IO Failure/);

    // 清除 IDB 寫入錯誤，改測歌曲與音檔各種失敗情境
    setInMemoryIdbHooksForTests({});

    // 2c. 歌曲狀態本身已是 persistenceStatus === "error" 或缺少本機 audioFiles
    const missingAudioSong = createBandSong({
      id: "song_missing_local_blob",
      name: "Missing Blob Track",
      fileName: "missing.wav",
      sourceAudioId: "song_missing_local_blob_original",
      originalBpm: 100,
      sourceAudioHash: "deadbeef".repeat(8),
      durationSec: 60,
      persistenceStatus: "saved",
    });
    await assert.rejects(
      prepareAndSaveProjectAs({
        sourceProject: originProject.project,
        currentSongs: [currentSongRef, missingAudioSong],
        name: "缺音檔不應建立專案",
        storageProvider: "local",
        setActive: true,
      }),
      (err) => {
        assert.equal(err instanceof SaveAsPersistenceError, true);
        assert.equal(err.failedSongs.length, 1);
        assert.equal(err.failedSongs[0].code, "audio_not_persisted");
        assert.match(err.message, /Missing Blob Track/);
        return true;
      },
    );

    // 3. 保存失敗後，原本工作階段、歌曲、Checkpoint 與 active-project 均完整保留且不受影響
    assert.equal(await getActiveProjectId(), originProject.projectId);
    const allProjectsAfterFails = await idbGetAll("projects");
    assert.equal(allProjectsAfterFails.length, projectsBeforeSaveAsFail + 1); // 僅有第 1 步成功建立的 validClone
    assert.equal(allProjectsAfterFails.some((p) => p.project.name === "配額失敗不應建立專案"), false);
    assert.equal(allProjectsAfterFails.some((p) => p.project.name === "缺音檔不應建立專案"), false);
    assert.equal((await idbGetAll("audioFiles")).length, 1);
    assert.equal((await idbGetAll("separationCheckpoints")).length, 1);
    assert.equal((await idbGetAll("songs")).length, 1);

    // 修正錯誤狀態後（移除破損歌曲或寫入對應編輯），允許使用者直接重試並成功另存
    const retriedSaveAs = await prepareAndSaveProjectAs({
      sourceProject: originProject.project,
      currentSongs: [editedFailSong],
      name: "排除錯誤後重試成功",
      storageProvider: "local",
      setActive: true,
    });
    assert.equal(retriedSaveAs.readiness.ok, true);
    assert.equal(retriedSaveAs.record.project.name, "排除錯誤後重試成功");

    // 4. Google Drive 來源音檔（無本機 audioFiles Blob，但可依授權從雲端按需下載）允許直接另存
    const drivePickerSong = createBandSong({
      id: "song_drive_picker",
      name: "Cloud Worship Stem",
      fileName: "cloud-worship.mp3",
      sourceAudioId: "song_drive_picker_original",
      originalBpm: 92,
      sourceAudioHash: "c".repeat(64),
      durationSec: 210,
      persistenceStatus: "saved",
      source: {
        provider: "google_drive",
        fileId: "drive_file_audio_01",
        authorizedAccountId: "google:user-a",
        fileName: "cloud-worship.mp3",
        mimeType: "audio/mpeg",
        sourceAudioHash: "c".repeat(64),
      },
      availabilityState: "cloud_not_downloaded",
    });
    const backupDrivenSong = createBandSong({
      id: "song_drive_backup_only",
      name: "Cloud Backup Song",
      fileName: "backup.mp3",
      sourceAudioId: "song_drive_backup_only_original",
      originalBpm: 105,
      sourceAudioHash: "d".repeat(64),
      durationSec: 180,
      persistenceStatus: "saved",
      source: { provider: "local" },
      originalBackup: {
        driveFileId: "drive_backup_file_02",
        ownerAccountId: "google:user-a",
        fileName: "backup.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 123456,
        sourceAudioHash: "d".repeat(64),
        backedUpAt: new Date().toISOString(),
      },
      availabilityState: "cloud_not_downloaded",
    });
    const driveReadiness = await verifySongsForProjectSaveAs([
      editedFailSong,
      drivePickerSong,
      backupDrivenSong,
    ]);
    assert.equal(driveReadiness.ok, true);
    assert.equal(driveReadiness.verifiedCount, 3);
    assert.equal(driveReadiness.cloudBackedCount, 2);

    const saveWithCloudRes = await prepareAndSaveProjectAs({
      sourceProject: originProject.project,
      currentSongs: [editedFailSong, drivePickerSong, backupDrivenSong],
      name: "混合本機與雲端來源專案",
      storageProvider: "local",
      setActive: false,
    });
    assert.equal(saveWithCloudRes.record.project.songs.length, 3);
  } finally {
    setInMemoryIdbHooksForTests({});
    resetPendingSongPersistsForTests();
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("P1 (Auth-First Sync Coordinator): handles unauth sign-in, expired reauth, cancel, project/account switch, rapid clicks & local-flush before Drive", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createDriveMockServer();
    let nowMs = 1_000_000;
    const events = [];

    let nextPopupBehavior = async () => ({
      accessToken: "token-user-a-1",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    let currentUserSub = "user-a";
    let currentUserEmail = "a@example.com";

    const accountManager = new GoogleAccountManager({
      now: () => nowMs,
      getConfigStatus: () => ({
        configured: true,
        clientId: "test-client",
        apiKey: "test-key",
        appId: "test-app",
        missingFields: [],
        message: null,
      }),
      ensureSdkLoaded: async () => undefined,
      getSdkReadiness: () => "ready",
      requestAccessToken: async (_clientId, opts) => {
        events.push(`popup:${opts?.prompt ?? "default"}`);
        return nextPopupBehavior();
      },
      fetchImpl: async (url) => {
        if (String(url).includes("oauth2/v3/userinfo")) {
          return new Response(
            JSON.stringify({ sub: currentUserSub, email: currentUserEmail, name: currentUserSub }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ user: { permissionId: `perm-${currentUserSub}` } }), {
          status: 200,
        });
      },
    });

    const song = createBandSong({
      id: "sync_s1",
      projectEntryId: "sync_s1",
      name: "Coord Song",
      fileName: "coord.mp3",
      sourceAudioId: "sync_s1_original",
      settingsKey: "k-coord-1",
      originalBpm: 120,
      sourceAudioHash: "e".repeat(64),
      durationSec: 150,
    });

    let projA = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Sync Proj A",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    let projB = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Sync Proj B",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(projA);
    await saveProjectRecord(projB);

    let activeProject = projA;
    let busyAction = null;
    const localStatesByProject = new Map();
    const localStateHistory = [];

    let syncPatchGate = null;
    const wrappedDriveFetch = async (url, init) => {
      if ((init?.method ?? "GET").toUpperCase() !== "GET") {
        events.push(`drive_write:${activeProject?.projectId ?? "none"}`);
      }
      if (syncPatchGate && String(init?.method ?? "").toUpperCase() === "POST" && String(url).includes("/upload/drive/v3/files")) {
        const gate = syncPatchGate;
        syncPatchGate = null;
        await gate.promise;
      }
      return server.fetchImpl(url, init);
    };

    const ctrl = new ProjectAutoSyncController({
      localDebounceMs: 40,
      retryBackoffMs: [5],
      maxRetries: 0,
      getAuthContext: () => {
        const snap = accountManager.getSnapshot();
        const tok = snap.account
          ? accountManager.getValidAccessToken(snap.account.accountId)
          : null;
        return {
          accountId: snap.account?.accountId ?? null,
          accessToken: tok,
          generation: snap.generation,
          isGenerationValid: (g, a) => accountManager.isGenerationValid(g, a),
          onAuthExpired: () => accountManager.markTokenExpired(snap.generation),
        };
      },
      syncDriveFn: async (p) => {
        events.push(`drive_sync:${p.record.projectId}`);
        return saveProjectToDrive({ ...p, fetchImpl: wrappedDriveFetch });
      },
      onStatusChanged: (pid, outcome) => {
        if (outcome.status === "local_dirty") {
          localStatesByProject.set(pid, "dirty");
          localStateHistory.push(`${pid}:dirty`);
        } else if (outcome.status === "local_saving") {
          localStatesByProject.set(pid, "saving");
          localStateHistory.push(`${pid}:saving`);
        } else if (outcome.status === "local_saved") {
          localStatesByProject.set(pid, "saved");
          localStateHistory.push(`${pid}:saved`);
        } else if (outcome.status === "local_save_error") {
          localStatesByProject.set(pid, "error");
          localStateHistory.push(`${pid}:error`);
        }
        if ("record" in outcome && outcome.record && activeProject?.projectId === pid) {
          activeProject = outcome.record;
        }
      },
    });

    const coordinator = new ProjectManualSyncCoordinator({
      getActiveProject: () => activeProject,
      getSongCount: () => 1,
      getHasLegacySongs: () => false,
      isGoogleConfigured: () => true,
      getExternalBusyAction: () => (busyAction && busyAction !== "sync" ? busyAction : null),
      getAuthSnapshot: () => {
        const snap = accountManager.getSnapshot();
        const tok = snap.account
          ? accountManager.getValidAccessToken(snap.account.accountId)
          : null;
        return {
          accountId: snap.account?.accountId ?? null,
          accessToken: tok,
          generation: snap.generation,
        };
      },
      getSyncController: () => ctrl,
      signInGoogle: async () => {
        events.push("call:signIn");
        const after = await accountManager.signIn();
        return {
          accountId: after.account?.accountId ?? null,
          accessToken: after.account
            ? accountManager.getValidAccessToken(after.account.accountId)
            : null,
          generation: after.generation,
        };
      },
      reauthorizeGoogle: async () => {
        events.push("call:reauthorize");
        const after = await accountManager.reauthorize();
        return {
          accountId: after.account?.accountId ?? null,
          accessToken: after.account
            ? accountManager.getValidAccessToken(after.account.accountId)
            : null,
          generation: after.generation,
        };
      },
      captureLatestSnapshot: () => undefined,
      onBusyChange: (b) => {
        busyAction = b?.action ?? null;
      },
      onLocalSaveStateChange: (pid, state) => {
        localStatesByProject.set(pid, state);
        localStateHistory.push(`${pid}:${state}`);
      },
      onFreshRecordLoaded: (rec) => {
        if (activeProject?.projectId === rec.projectId) {
          activeProject = rec;
        }
      },
    });

    // 7. 使用者取消 Google 授權後：直接停在授權階段，絕不先呼叫 syncProjectManually
    nextPopupBehavior = async () => {
      throw new Error("使用者已取消 Google 授權視窗。");
    };
    const cancelRes = await coordinator.requestSync();
    assert.equal(cancelRes.kind, "auth_cancelled");
    assert.equal(events.some((e) => e.startsWith("drive_sync")), false);
    assert.equal(server.writeRequests.length, 0);
    assert.equal((await getProjectRecord(projA.projectId))?.syncStatus, "dirty");

    // 5. Google 未登入時：點擊同步直接先啟動 signIn，登入成功通過檢查後再同步
    events.length = 0;
    nextPopupBehavior = async () => ({
      accessToken: "token-user-a-1",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const signInSyncRes = await coordinator.requestSync();
    assert.equal(signInSyncRes.kind, "synced_outcome");
    assert.equal(signInSyncRes.outcome?.status, "synced");
    assert.equal(signInSyncRes.localSaveFailed, false);
    assert.equal(events[0], "call:signIn");
    assert.equal(events[2], `drive_sync:${projA.projectId}`);
    projA = await getProjectRecord(projA.projectId);
    activeProject = projA;

    // 6. Token 過期時：點擊同步直接先啟動 reauthorize，成功續權後再同步
    accountManager.markTokenExpired();
    events.length = 0;
    const dirtyRev2 = {
      ...projA,
      localRevision: projA.localRevision + 1,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: projA.project,
        songs: [{ ...song, targetBpm: 132 }],
        incrementRevision: true,
      }),
    };
    await saveProjectRecord(dirtyRev2);
    projA = await getProjectRecord(projA.projectId);
    activeProject = projA;
    nextPopupBehavior = async () => ({
      accessToken: "token-user-a-2",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const reauthSyncRes = await coordinator.requestSync();
    assert.equal(reauthSyncRes.kind, "synced_outcome");
    assert.equal(reauthSyncRes.outcome?.status, "synced");
    assert.equal(events[0], "call:reauthorize");
    assert.equal(events[1], "popup:consent");
    assert.equal(events[2], `drive_sync:${projA.projectId}`);

    // 8. 授權期間切換專案（即使未主動 invalidate，Coordinator 也透過 live getter 攔截），絕不同步到錯誤專案
    accountManager.markTokenExpired();
    const switchPopupDef = createDeferred();
    nextPopupBehavior = () => switchPopupDef.promise;
    const writesBeforeSwitch = server.writeRequests.length;
    const switchSyncPromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 10));
    // 模擬使用者在彈窗開啟期間切換到 Proj B
    activeProject = projB;
    switchPopupDef.resolve({
      accessToken: "token-user-a-3",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const switchRes = await switchSyncPromise;
    assert.equal(switchRes.kind, "aborted");
    assert.equal(switchRes.reason, "project_switched");
    assert.equal(server.writeRequests.length, writesBeforeSwitch);

    // 9a. 授權期間切換帳戶（專案 A owner 為 user-a，但彈窗登入 user-b），嚴阻跨帳戶上傳
    activeProject = projA;
    accountManager.signOut();
    currentUserSub = "user-b";
    currentUserEmail = "b@example.com";
    nextPopupBehavior = async () => ({
      accessToken: "token-user-b-1",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const writesBeforeMismatch = server.writeRequests.length;
    const mismatchRes = await coordinator.requestSync();
    assert.equal(mismatchRes.kind, "account_mismatch");
    assert.equal(mismatchRes.expectedAccountId, "google:user-a");
    assert.equal(mismatchRes.actualAccountId, "google:user-b");
    assert.equal(server.writeRequests.length, writesBeforeMismatch);

    // 9b. 授權期間原專案被刪除或進入衝突狀態，也不得啟動同步寫入
    currentUserSub = "user-a";
    currentUserEmail = "a@example.com";
    accountManager.signOut();
    const conflictProj = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Conflict Check Proj",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(conflictProj);
    activeProject = conflictProj;
    const conflictPopupDef = createDeferred();
    nextPopupBehavior = () => conflictPopupDef.promise;
    const conflictAuthPromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 10));
    await saveProjectRecord({
      ...conflictProj,
      syncStatus: "conflict",
      conflictInfo: {
        detectedAt: Date.now(),
        kind: "diverged",
        localRevision: 1,
        localRevisionToken: conflictProj.project.revisionToken,
        localBaseRevision: 1,
        remoteRevision: 2,
        remoteRevisionToken: "r2-remote",
        remoteProjectSnapshot: null,
        reason: "其他裝置已有較新版本",
      },
    });
    conflictPopupDef.resolve({
      accessToken: "token-user-a-conflict",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const conflictStopRes = await conflictAuthPromise;
    assert.equal(conflictStopRes.kind, "open_conflict");
    assert.equal(server.writeRequests.length, writesBeforeMismatch);

    // 10a. 快速連點同步（授權階段連點 3 次），絕不產生重複授權或重複同步工作
    activeProject = await getProjectRecord(projA.projectId);
    accountManager.signOut();
    const rapidAuthDef = createDeferred();
    let popupInvokeCount = 0;
    nextPopupBehavior = () => {
      popupInvokeCount += 1;
      return rapidAuthDef.promise;
    };
    const r1 = coordinator.requestSync();
    const r2 = coordinator.requestSync();
    const r3 = coordinator.requestSync();
    assert.equal(coordinator.isBusy(), true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(popupInvokeCount, 1);
    const [res2, res3] = await Promise.all([r2, r3]);
    assert.equal(res2.kind, "ignored");
    assert.equal(res3.kind, "ignored");
    rapidAuthDef.resolve({
      accessToken: "token-user-a-rapid",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const res1 = await r1;
    assert.equal(res1.kind, "synced_outcome");

    // 10b. 快速連點同步（雲端上傳進行中連點，及直接使用 syncProjectManually 併發），同一專案絕不產生兩個同步工作
    const dirtyBeforeMidClick = {
      ...(await getProjectRecord(projA.projectId)),
      localRevision: (await getProjectRecord(projA.projectId)).localRevision + 1,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: (await getProjectRecord(projA.projectId)).project,
        songs: [{ ...song, targetBpm: 148 }],
        incrementRevision: true,
      }),
    };
    await saveProjectRecord(dirtyBeforeMidClick);
    activeProject = await getProjectRecord(projA.projectId);
    syncPatchGate = createDeferred();
    const uploadGateRef = syncPatchGate;
    const syncCallsBeforeMid = events.filter((e) => e === `drive_sync:${projA.projectId}`).length;
    const mid1 = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 15));
    const mid2 = coordinator.requestSync();
    const midDirectCtrl = ctrl.syncProjectManually(projA.projectId);
    const [mid2Res, midDirectRes] = await Promise.all([mid2, midDirectCtrl]);
    assert.equal(mid2Res.kind, "ignored");
    assert.equal(midDirectRes?.status, "cancelled");
    uploadGateRef.resolve();
    const mid1Res = await mid1;
    assert.equal(mid1Res.kind, "synced_outcome");
    assert.equal(mid1Res.outcome?.status, "synced");
    assert.equal(
      events.filter((e) => e === `drive_sync:${projA.projectId}`).length,
      syncCallsBeforeMid + 1,
    );

    // 9c. 授權期間原專案在背景被刪除 (tombstone)，授權回來立即中止且不復活/不上傳
    accountManager.signOut();
    const delProj = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Deleted During Auth Proj",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(delProj);
    activeProject = delProj;
    const delPopupDef = createDeferred();
    nextPopupBehavior = () => delPopupDef.promise;
    const writesBeforeDelAuth = server.writeRequests.length;
    const delAuthPromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 10));
    await deleteProjectSafely({
      projectId: delProj.projectId,
      scope: "local_only",
      autoSyncController: ctrl,
    });
    delPopupDef.resolve({
      accessToken: "token-user-a-del",
      expiresInSec: 3600,
      grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
    });
    const delRes = await delAuthPromise;
    assert.equal(delRes.kind, "aborted");
    assert.equal(delRes.reason, "project_deleted");
    assert.equal(server.writeRequests.length, writesBeforeDelAuth);
    assert.equal(await getProjectRecord(delProj.projectId), null);

    // 11. 防抖等待中編輯 -> 直接按同步 -> 同步前完成 flush 寫入 IDB 並上傳最新版，且 13. 防抖等待中狀態不誤報已儲存
    activeProject = await getProjectRecord(projB.projectId);
    const debouncedEditB = {
      ...activeProject,
      localRevision: activeProject.localRevision + 1,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: activeProject.project,
        songs: [{ ...song, targetBpm: 158 }],
        incrementRevision: true,
      }),
    };
    localStateHistory.length = 0;
    ctrl.scheduleProjectEdit(debouncedEditB); // 40ms debounce waiting
    assert.equal(ctrl.hasPendingLocalEdits(projB.projectId), true);
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "dirty");
    assert.equal(
      resolveProjectToolbarStatus({
        activeProject: debouncedEditB,
        songCount: 1,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: true,
        hasValidGoogleToken: true,
        localSaveState: ctrl.getLocalSaveState(projB.projectId),
      }).text,
      "本機有未儲存變更 · 尚未同步",
    );

    const flushAndSyncRes = await coordinator.requestSync();
    assert.equal(flushAndSyncRes.kind, "synced_outcome");
    assert.equal(flushAndSyncRes.outcome?.status, "synced");
    assert.equal(flushAndSyncRes.localSaveFailed, false);
    const syncedB = await getProjectRecord(projB.projectId);
    assert.equal(syncedB.project.songs[0].settings.targetBpm, 158);
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "saved");

    // 12. 本機保存失敗時（包含先自動保存失敗後直接按同步），絕不執行 Drive 寫入
    const writesBeforeLocalFail = server.writeRequests.length;
    setInMemoryIdbHooksForTests({
      beforeWrite(store) {
        if (store === "projects") {
          throw new DOMException("Disk full", "QuotaExceededError");
        }
      },
    });
    const failedEditB = {
      ...syncedB,
      localRevision: syncedB.localRevision + 1,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: syncedB.project,
        songs: [{ ...song, targetBpm: 166 }],
        incrementRevision: true,
      }),
    };
    ctrl.scheduleProjectEdit(failedEditB, { immediateLocal: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "error");
    assert.equal(ctrl.hasPendingLocalEdits(projB.projectId), true);

    const syncWhenLocalFailRes = await coordinator.requestSync();
    assert.equal(syncWhenLocalFailRes.kind, "synced_outcome");
    assert.equal(syncWhenLocalFailRes.localSaveFailed, true);
    assert.equal(syncWhenLocalFailRes.outcome?.status, "error");
    assert.equal(server.writeRequests.length, writesBeforeLocalFail);
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "error");

    // 修復 IDB 後再同步：剛才卡住的 failedEditB 也會被補寫並同步成功
    setInMemoryIdbHooksForTests({});
    const recoveredBRes = await coordinator.requestSync();
    assert.equal(recoveredBRes.kind, "synced_outcome");
    assert.equal(recoveredBRes.outcome?.status, "synced");
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "saved");
    assert.equal((await getProjectRecord(projB.projectId))?.project.songs[0].settings.targetBpm, 166);

    // 14. 雲端同步失敗（HTTP 500）不覆蓋本機已保存成功狀態
    const dirtyBefore500 = {
      ...(await getProjectRecord(projB.projectId)),
      localRevision: 10,
      dirty: true,
      syncStatus: "dirty",
      project: buildProjectFromBandSongs({
        existingProject: (await getProjectRecord(projB.projectId)).project,
        songs: [{ ...song, targetBpm: 170 }],
        incrementRevision: true,
      }),
    };
    ctrl.scheduleProjectEdit(dirtyBefore500, { immediateLocal: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "saved");

    server.setFailNextPatch(true);
    activeProject = await getProjectRecord(projB.projectId);
    const cloudFailRes = await coordinator.requestSync();
    assert.equal(cloudFailRes.kind, "synced_outcome");
    assert.equal(cloudFailRes.outcome?.status, "error");
    assert.equal(cloudFailRes.localSaveFailed, false);
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "saved");

    const uiStatusOnCloudFail = resolveProjectToolbarStatus({
      activeProject: cloudFailRes.outcome.record,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: ctrl.getLocalSaveState(projB.projectId),
    });
    assert.equal(uiStatusOnCloudFail.text, "本機已儲存 · 同步失敗");
    assert.equal(uiStatusOnCloudFail.toneClass, "is-error");

    // 13b. 專案切換 (invalidateProject) 後清除舊專案 saved/error 狀態
    await ctrl.invalidateProject(projB.projectId, { discardPendingLocal: false });
    assert.equal(ctrl.getLocalSaveState(projB.projectId), "idle");

    await ctrl.dispose();
    accountManager.dispose();
  } finally {
    setInMemoryIdbHooksForTests({});
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("P2 (LocalSaveState Status Resolution & 3-Button Toolbar Contract): accurately separates idle/dirty/saving/saved/error & keeps 3 primary actions", () => {
  const localProj = createInitialPersistedProjectRecord(
    createEmptyProject({ name: "Pure Local", storageProvider: "local" }),
    { dirty: false, syncStatus: "local_only" },
  );
  const driveDirty = createInitialPersistedProjectRecord(
    createEmptyProject({
      name: "Cloud Drive Project",
      storageProvider: "google_drive",
      ownerAccountId: "google:acc-1",
    }),
    { dirty: true, syncStatus: "dirty" },
  );
  const driveSynced = { ...driveDirty, dirty: false, syncStatus: "synced" };
  const driveError = { ...driveDirty, syncStatus: "error", lastError: "HTTP 503" };

  // 13 & 14. 本機 5 態與雲端狀態組合驗證
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: localProj,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
      localSaveState: "idle",
    }).text,
    "尚未確認保存 · 僅存於本機",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: localProj,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
      localSaveState: "dirty",
    }).text,
    "尚未儲存變更 · 僅存於本機",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: localProj,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: false,
      hasValidGoogleToken: false,
      localSaveState: "saving",
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
      localSaveState: "saved",
    }).text,
    "本機已儲存 · 僅存於本機",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveSynced,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "dirty",
    }).text,
    "本機有未儲存變更 · 雲端已同步",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveSynced,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "dirty",
    }).toneClass,
    "is-dirty",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveError,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "saved",
    }).text,
    "本機已儲存 · 同步失敗",
  );
  assert.equal(
    resolveProjectToolbarStatus({
      activeProject: driveError,
      songCount: 1,
      hasLegacySongs: false,
      isGoogleConfigured: true,
      isGoogleSignedIn: true,
      hasValidGoogleToken: true,
      localSaveState: "error",
    }).text,
    "本機儲存失敗 · 同步失敗",
  );

  // 15. 全狀態工具列永遠僅 3 顆按鈕，且 BandMixer 已接上 Fail-Closed 另存與 Auth-First 同步編排器
  for (const state of ["idle", "dirty", "saving", "saved", "error"]) {
    for (const proj of [null, localProj, driveDirty, driveSynced, driveError]) {
      const actions = resolveProjectToolbarActions({
        activeProject: proj,
        songCount: 2,
        hasLegacySongs: false,
        isGoogleConfigured: true,
        isGoogleSignedIn: true,
        hasValidGoogleToken: true,
        localSaveState: state,
      });
      assert.equal(actions.length, 3);
      assert.deepEqual(
        actions.map((a) => a.text),
        ["專案", "儲存", "同步"],
      );
    }
  }

  const mixerSrc = fs.readFileSync(path.resolve("components/band/BandMixer.tsx"), "utf8");
  assert.equal(mixerSrc.includes("prepareAndSaveProjectAs"), true);
  assert.equal(mixerSrc.includes("ProjectManualSyncCoordinator"), true);
  const saveAsStart = mixerSrc.indexOf("const handleSaveAsProjectSubmit");
  const saveAsEnd = mixerSrc.indexOf("const handleRenameProjectSubmit");
  assert.ok(saveAsStart !== -1 && saveAsEnd > saveAsStart);
  const saveAsSlice = mixerSrc.slice(saveAsStart, saveAsEnd);
  assert.equal(saveAsSlice.includes("prepareAndSaveProjectAs"), true);
  assert.equal(saveAsSlice.includes(".catch(() => undefined)"), false);
});

test("P1 (Fail-Closed Post-Auth State Check): aborts sync safely on isDeletedFn/getRecordFn errors, protects local state, allows retry, and prevents stale/cross-switch continuation", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createDriveMockServer();
    let nowMs = 2_000_000;
    let currentUserSub = "user-a";
    let currentUserEmail = "a@example.com";

    const accountManager = new GoogleAccountManager({
      now: () => nowMs,
      getConfigStatus: () => ({
        configured: true,
        clientId: "test-client",
        apiKey: "test-key",
        appId: "test-app",
        missingFields: [],
        message: null,
      }),
      ensureSdkLoaded: async () => undefined,
      getSdkReadiness: () => "ready",
      requestAccessToken: async () => ({
        accessToken: `token-${currentUserSub}-${nowMs}`,
        expiresInSec: 3600,
        grantedScopes: ["https://www.googleapis.com/auth/drive.file", "openid", "profile", "email"],
      }),
      fetchImpl: async (url) => {
        if (String(url).includes("oauth2/v3/userinfo")) {
          return new Response(
            JSON.stringify({ sub: currentUserSub, email: currentUserEmail, name: currentUserSub }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ user: { permissionId: `perm-${currentUserSub}` } }), {
          status: 200,
        });
      },
    });

    const song = createBandSong({
      id: "fc_song_1",
      projectEntryId: "fc_song_1",
      name: "Fail Closed Song",
      fileName: "fail-closed.mp3",
      sourceAudioId: "fc_song_1_original",
      settingsKey: "k-fc-1",
      originalBpm: 112,
      sourceAudioHash: "f".repeat(64),
      durationSec: 120,
    });

    let projA = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Fail Closed Proj A",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    projA = {
      ...projA,
      project: buildProjectFromBandSongs({
        existingProject: projA.project,
        songs: [song],
        incrementRevision: false,
      }),
    };
    const projB = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "Fail Closed Proj B",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(projA);
    await saveProjectRecord(projB);

    let activeProject = projA;
    const localStatesByProject = new Map([[projA.projectId, "saved"]]);

    const ctrl = new ProjectAutoSyncController({
      localDebounceMs: 40,
      retryBackoffMs: [5],
      maxRetries: 0,
      getAuthContext: () => {
        const snap = accountManager.getSnapshot();
        const tok = snap.account
          ? accountManager.getValidAccessToken(snap.account.accountId)
          : null;
        return {
          accountId: snap.account?.accountId ?? null,
          accessToken: tok,
          generation: snap.generation,
          isGenerationValid: (g, a) => accountManager.isGenerationValid(g, a),
          onAuthExpired: () => accountManager.markTokenExpired(snap.generation),
        };
      },
      syncDriveFn: async (p) => saveProjectToDrive({ ...p, fetchImpl: server.fetchImpl }),
      onStatusChanged: (pid, outcome) => {
        if (outcome.status === "local_saved") {
          localStatesByProject.set(pid, "saved");
        } else if (outcome.status === "local_save_error") {
          localStatesByProject.set(pid, "error");
        }
        if ("record" in outcome && outcome.record && activeProject?.projectId === pid) {
          activeProject = outcome.record;
        }
      },
    });

    let syncProjectManuallyCalls = 0;
    const origSyncProjectManually = ctrl.syncProjectManually.bind(ctrl);
    ctrl.syncProjectManually = async (projectId) => {
      syncProjectManuallyCalls += 1;
      return origSyncProjectManually(projectId);
    };

    let customGetRecord = null;
    let customIsDeleted = null;

    const buildCoordinator = (useInjectedFns = true) =>
      new ProjectManualSyncCoordinator({
        getActiveProject: () => activeProject,
        getSongCount: () => 1,
        getHasLegacySongs: () => false,
        isGoogleConfigured: () => true,
        getExternalBusyAction: () => null,
        getAuthSnapshot: () => {
          const snap = accountManager.getSnapshot();
          const tok = snap.account
            ? accountManager.getValidAccessToken(snap.account.accountId)
            : null;
          return {
            accountId: snap.account?.accountId ?? null,
            accessToken: tok,
            generation: snap.generation,
          };
        },
        getSyncController: () => ctrl,
        signInGoogle: async () => {
          const after = await accountManager.signIn();
          return {
            accountId: after.account?.accountId ?? null,
            accessToken: after.account
              ? accountManager.getValidAccessToken(after.account.accountId)
              : null,
            generation: after.generation,
          };
        },
        reauthorizeGoogle: async () => {
          const after = await accountManager.reauthorize();
          return {
            accountId: after.account?.accountId ?? null,
            accessToken: after.account
              ? accountManager.getValidAccessToken(after.account.accountId)
              : null,
            generation: after.generation,
          };
        },
        captureLatestSnapshot: () => undefined,
        ...(useInjectedFns
          ? {
              getProjectRecordFn: (id) =>
                customGetRecord ? customGetRecord(id) : getProjectRecord(id),
              isProjectDeletedFn: (id) =>
                customIsDeleted ? customIsDeleted(id) : Promise.resolve(false),
            }
          : {}),
        onLocalSaveStateChange: (pid, state) => {
          localStatesByProject.set(pid, state);
        },
        onFreshRecordLoaded: (rec) => {
          if (activeProject?.projectId === rec.projectId) {
            activeProject = rec;
          }
        },
      });

    const coordinator = buildCoordinator(true);
    const strictDefaultCoordinator = buildCoordinator(false);

    // 3a. 注入 isDeletedFn() 非同步 reject -> 中止同步、回報 project_state_unavailable、零 Drive 寫入、保留本機狀態
    customIsDeleted = async () => {
      throw new DOMException("Failed to read projectPreferences", "UnknownError");
    };
    const resDelReject = await coordinator.requestSync();
    assert.equal(resDelReject.kind, "aborted");
    assert.equal(resDelReject.reason, "project_state_unavailable");
    assert.equal(resDelReject.message, PROJECT_STATE_UNAVAILABLE_MESSAGE);
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);
    assert.equal(coordinator.isBusy(), false);
    assert.equal(localStatesByProject.get(projA.projectId), "saved");
    const dbAfterDelReject = await getProjectRecord(projA.projectId);
    assert.equal(dbAfterDelReject?.syncStatus, "dirty");
    assert.equal(dbAfterDelReject?.project.songs.length, 1);

    // 3b. 注入 isDeletedFn() 同步 throw -> 同樣安全停止
    accountManager.signOut();
    customIsDeleted = () => {
      throw new Error("synchronous tombstone read failure");
    };
    const resDelSyncThrow = await coordinator.requestSync();
    assert.equal(resDelSyncThrow.kind, "aborted");
    assert.equal(resDelSyncThrow.reason, "project_state_unavailable");
    assert.equal(resDelSyncThrow.message, PROJECT_STATE_UNAVAILABLE_MESSAGE);
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);

    // 3c. 使用預設 Strict IDB (projectPreferences 讀取失敗) -> 亦不可被 projectStore.catch 吞掉，必須回報 project_state_unavailable
    accountManager.signOut();
    setInMemoryIdbHooksForTests({
      beforeRead(storeName) {
        if (storeName === "projectPreferences") {
          throw new DOMException("Simulated projectPreferences read error", "AbortError");
        }
      },
    });
    const resStrictDelFail = await strictDefaultCoordinator.requestSync();
    assert.equal(resStrictDelFail.kind, "aborted");
    assert.equal(resStrictDelFail.reason, "project_state_unavailable");
    assert.equal(resStrictDelFail.message, PROJECT_STATE_UNAVAILABLE_MESSAGE);
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);
    setInMemoryIdbHooksForTests({});

    // 4a. getRecordFn() 拋出錯誤（即使 isDeletedFn() 回傳 false）-> 必須停止且不誤判成有效專案或已刪除
    accountManager.signOut();
    customIsDeleted = async () => false;
    customGetRecord = async () => {
      throw new Error("IndexedDB projects read failed");
    };
    const resRecReject = await coordinator.requestSync();
    assert.equal(resRecReject.kind, "aborted");
    assert.equal(resRecReject.reason, "project_state_unavailable");
    assert.equal(resRecReject.message, PROJECT_STATE_UNAVAILABLE_MESSAGE);
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);

    // 4b. 使用預設 Strict IDB (projects 讀取失敗) -> 明確區分讀取失敗，回報 project_state_unavailable
    accountManager.signOut();
    setInMemoryIdbHooksForTests({
      beforeRead(storeName) {
        if (storeName === "projects") {
          throw new DOMException("Simulated projects read error", "AbortError");
        }
      },
    });
    const resStrictRecFail = await strictDefaultCoordinator.requestSync();
    assert.equal(resStrictRecFail.kind, "aborted");
    assert.equal(resStrictRecFail.reason, "project_state_unavailable");
    assert.equal(resStrictRecFail.message, PROJECT_STATE_UNAVAILABLE_MESSAGE);
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);
    setInMemoryIdbHooksForTests({});

    // 4c. 對照組：getRecordFn() 成功回傳 null（專案不存在）且 isDeletedFn() 回傳 false -> 回報 project_deleted
    accountManager.signOut();
    customGetRecord = async () => null;
    customIsDeleted = async () => false;
    const resMissing = await coordinator.requestSync();
    assert.equal(resMissing.kind, "aborted");
    assert.equal(resMissing.reason, "project_deleted");
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);

    // 2. isDeletedFn() 成功且明確回傳 true -> 維持 project_deleted 中止流程
    accountManager.signOut();
    customGetRecord = null;
    customIsDeleted = async () => true;
    const resDeletedTrue = await coordinator.requestSync();
    assert.equal(resDeletedTrue.kind, "aborted");
    assert.equal(resDeletedTrue.reason, "project_deleted");
    assert.equal(syncProjectManuallyCalls, 0);
    assert.equal(server.writeRequests.length, 0);

    // 1 & 7. 使用者重試且 isDeletedFn() 恢復回傳 false、getRecordFn() 正常讀取 -> 進入後續檢查並同步成功
    accountManager.signOut();
    customGetRecord = null;
    customIsDeleted = async () => false;
    const resRetrySuccess = await coordinator.requestSync();
    assert.equal(resRetrySuccess.kind, "synced_outcome");
    assert.equal(resRetrySuccess.outcome?.status, "synced");
    assert.equal(syncProjectManuallyCalls, 1);
    assert.ok(server.writeRequests.length > 0);

    projA = await getProjectRecord(projA.projectId);
    activeProject = projA;

    // 8a. 查詢期間切換專案 -> 即使查詢返回，也不得繼續同步
    accountManager.signOut();
    const writesBeforeSwitch = server.writeRequests.length;
    const callsBeforeSwitch = syncProjectManuallyCalls;
    const switchQueryDef = createDeferred();
    customIsDeleted = () => switchQueryDef.promise;
    const switchPromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 15));
    activeProject = projB;
    switchQueryDef.resolve(false);
    const switchRes = await switchPromise;
    assert.equal(switchRes.kind, "aborted");
    assert.equal(switchRes.reason, "project_switched");
    assert.equal(syncProjectManuallyCalls, callsBeforeSwitch);
    assert.equal(server.writeRequests.length, writesBeforeSwitch);

    // 8b. 查詢期間切換 / 變更 Google 帳號 -> 即使查詢返回，也不得繼續同步
    activeProject = projA;
    accountManager.signOut();
    const writesBeforeAuthChange = server.writeRequests.length;
    const authChangeQueryDef = createDeferred();
    customIsDeleted = () => authChangeQueryDef.promise;
    const authChangePromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 15));
    // 模擬查詢等待期間切換為 user-b 並完成登入（使 generation 與 accountId 雙重改變）
    currentUserSub = "user-b";
    currentUserEmail = "b@example.com";
    await accountManager.signIn();
    authChangeQueryDef.resolve(false);
    const authChangeRes = await authChangePromise;
    assert.equal(authChangeRes.kind, "aborted");
    assert.equal(authChangeRes.reason, "auth_changed");
    assert.equal(syncProjectManuallyCalls, callsBeforeSwitch);
    assert.equal(server.writeRequests.length, writesBeforeAuthChange);

    // 8c. 查詢期間呼叫 invalidate() (stale_operation 防護)，不論之後查詢 reject 或 resolve 皆中止且不觸發同步
    currentUserSub = "user-a";
    currentUserEmail = "a@example.com";
    accountManager.signOut();
    const staleQueryDef = createDeferred();
    customIsDeleted = () => staleQueryDef.promise;
    const stalePromise = coordinator.requestSync();
    await new Promise((r) => setTimeout(r, 15));
    coordinator.invalidate();
    staleQueryDef.reject(new Error("late query failure after invalidate"));
    const staleRes = await stalePromise;
    assert.equal(staleRes.kind, "aborted");
    assert.equal(staleRes.reason, "stale_operation");
    assert.equal(syncProjectManuallyCalls, callsBeforeSwitch);
    assert.equal(server.writeRequests.length, writesBeforeAuthChange);

    // 使用者重試（使用預設 Strict Coordinator 且無任何錯誤注入）也正常完成同步
    activeProject = projB;
    accountManager.signOut();
    const writesBeforeFinalStrict = server.writeRequests.length;
    const strictSuccessRes = await strictDefaultCoordinator.requestSync();
    assert.equal(strictSuccessRes.kind, "synced_outcome");
    assert.equal(strictSuccessRes.outcome?.status, "synced");
    assert.equal(syncProjectManuallyCalls, callsBeforeSwitch + 1);
    assert.ok(server.writeRequests.length > writesBeforeFinalStrict);

    await ctrl.dispose();
    accountManager.dispose();
  } finally {
    setInMemoryIdbHooksForTests({});
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
