import test from "node:test";
import assert from "node:assert/strict";
import { createBandSong } from "../lib/band/songModel.ts";
import { DRIVE_FOLDER_MIME_TYPE } from "../lib/google/driveClient.ts";
import {
  clearCachedFolderLayoutForAccount,
  ensureProjectFolder,
  listManagedProjects,
} from "../lib/google/driveFolderManager.ts";
import {
  clearResumableSessionUrisForAccount,
  uploadChunkedResumable,
} from "../lib/google/driveResumableUpload.ts";
import {
  ProjectAutoSyncController,
  backupLocalOriginalAudioToDrive,
  listCloudProjects,
  loadProjectFromDrive,
  saveProjectToDrive,
} from "../lib/projects/projectDriveSync.ts";
import { buildProjectFromBandSongs, createEmptyProject, createInitialPersistedProjectRecord } from "../lib/projects/projectModel.ts";
import { createNewProject, deleteProjectSafely, listAllProjectsForUi } from "../lib/projects/projectManager.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
  setInMemoryIdbHooksForTests,
} from "../lib/storage/indexedDb.ts";
import { getProjectRecord, saveProjectRecord } from "../lib/storage/projectStore.ts";

function createProjectDriveMockServer() {
  let nextId = 1;
  let versionSeq = 1;
  const files = new Map();
  const downloadedIds = [];
  const uploadsByAuth = [];

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

  const getOwnerForAuth = (authHeader) => {
    if (!authHeader) return "anon";
    if (authHeader.includes("token-b")) return "google:user-b";
    return "google:user-a";
  };

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const authHeader = init?.headers?.Authorization ?? "";
    const callerAcc = getOwnerForAuth(authHeader);

    if (authHeader.includes("expired")) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (method === "GET" && u.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      const rec = files.get(id);
      if (!rec || rec.trashed) return new Response("Not Found", { status: 404 });
      if (rec.ownerAuthAcc !== callerAcc) return new Response("Forbidden", { status: 403 });
      if (u.searchParams.get("alt") === "media") {
        downloadedIds.push(id);
        if (rec.json !== undefined) {
          return new Response(JSON.stringify(rec.json), { status: 200 });
        }
        return new Response(rec.binary ?? new Uint8Array(0), {
          status: 200,
          headers: { "content-length": String(rec.binary?.byteLength ?? 0) },
        });
      }
      return new Response(JSON.stringify(rec.meta), { status: 200 });
    }

    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const appMatch = /key='lhApp' and value='([^']+)'/.exec(q);
      const roleMatch = /key='lhRole' and value='([^']+)'/.exec(q);
      const accMatch = /key='lhAccountId' and value='([^']+)'/.exec(q);
      const projMatch = /key='lhProjectId' and value='([^']+)'/.exec(q);
      const hashMatch = /key='lhSourceAudioHash' and value='([^']+)'/.exec(q);
      const songKeyMatch = /key='lhSongKey' and value='([^']+)'/.exec(q);
      const parentMatch = /'([^']+)' in parents/.exec(q);

      const matched = Array.from(files.values())
        .filter((r) => !r.trashed && r.ownerAuthAcc === callerAcc)
        .filter((r) => {
          const m = r.meta;
          if (parentMatch && !m.parents?.includes(parentMatch[1])) return false;
          if (q.includes(`mimeType='${DRIVE_FOLDER_MIME_TYPE}'`) && m.mimeType !== DRIVE_FOLDER_MIME_TYPE) return false;
          if (appMatch && m.appProperties?.lhApp !== appMatch[1]) return false;
          if (roleMatch && m.appProperties?.lhRole !== roleMatch[1]) return false;
          if (accMatch && m.appProperties?.lhAccountId !== accMatch[1]) return false;
          if (projMatch && m.appProperties?.lhProjectId !== projMatch[1]) return false;
          if (hashMatch && m.appProperties?.lhSourceAudioHash !== hashMatch[1]) return false;
          if (songKeyMatch && m.appProperties?.lhSongKey !== songKeyMatch[1]) return false;
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
        trashed: false,
        version: String(versionSeq++),
        createdTime: `2026-01-01T00:00:${String(nextId).padStart(2, "0")}Z`,
        modifiedTime: new Date().toISOString(),
        capabilities: { canAddChildren: true, canDelete: true },
      };
      files.set(id, { ownerAuthAcc: callerAcc, meta });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if ((method === "POST" || method === "PATCH") && u.pathname.startsWith("/upload/drive/v3/files")) {
      if (u.searchParams.get("uploadType") === "resumable") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const id = `bin_${nextId++}`;
        const uri = `https://upload.example.com/${id}`;
        files.set(uri, { ownerAuthAcc: callerAcc, id, meta: body, parts: [], isSession: true });
        uploadsByAuth.push({ callerAcc, fileName: body.name, mode: "resumable" });
        return new Response("", { status: 200, headers: { location: uri } });
      }
      const existingId = method === "PATCH" ? decodeURIComponent(u.pathname.split("/").pop()) : null;
      const { metadata, payload } = parseMultipartRequest(String(init?.body ?? ""));
      const id = existingId || `json_${nextId++}`;
      const prev = existingId ? files.get(id) : null;
      const meta = {
        id,
        name: metadata.name ?? prev?.meta?.name ?? "project.json",
        mimeType: "application/json",
        parents: metadata.parents ?? prev?.meta?.parents ?? ["root"],
        appProperties: { ...(prev?.meta?.appProperties ?? {}), ...(metadata.appProperties ?? {}) },
        trashed: false,
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
        capabilities: { canDelete: true, canEdit: true },
      };
      files.set(id, { ownerAuthAcc: callerAcc, meta, json: payload });
      uploadsByAuth.push({ callerAcc, fileName: meta.name, mode: "json", lhProjectId: meta.appProperties.lhProjectId });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if (method === "PUT" && u.hostname === "upload.example.com") {
      const holder = files.get(String(url));
      const chunk = new Uint8Array(init.body);
      holder.parts.push(chunk);
      const total = holder.parts.reduce((s, p) => s + p.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of holder.parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      const meta = {
        id: holder.id,
        name: holder.meta.name,
        mimeType: holder.meta.mimeType,
        size: String(merged.byteLength),
        parents: holder.meta.parents,
        appProperties: holder.meta.appProperties ?? {},
        trashed: false,
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
        capabilities: { canDelete: true, canDownload: true },
      };
      files.set(holder.id, { ownerAuthAcc: holder.ownerAuthAcc, meta, binary: merged });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    return new Response("Not Implemented", { status: 500 });
  };

  return { files, downloadedIds, uploadsByAuth, fetchImpl };
}

test("Google Drive project folder creation, cross-device duplicate folder convergence, JSON sync, and metadata-only listing", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createProjectDriveMockServer();
    const projectId = "proj-sync-001";

    // 模擬手機與電腦跨裝置無 Web Locks 同時呼叫 ensureProjectFolder 並出現兩個同 projectId 資料夾
    const folderA = await ensureProjectFolder({
      accountId: "google:user-a",
      accessToken: "token-a",
      projectId,
      fetchImpl: server.fetchImpl,
      lockAdapter: null,
    });
    // 人為注入第二個重複專案資料夾（較晚建立）
    const dupId = "drv_duplicate_proj";
    server.files.set(dupId, {
      ownerAuthAcc: "google:user-a",
      meta: {
        id: dupId,
        name: `project_${projectId}`,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        parents: [folderA.projectsFolderId],
        appProperties: {
          lhApp: "loop-harmonizer",
          lhRole: "project",
          lhAccountId: "google:user-a",
          lhProjectId: projectId,
        },
        trashed: false,
        createdTime: "2026-09-01T00:00:00Z",
        modifiedTime: "2026-09-01T00:00:00Z",
      },
    });
    clearCachedFolderLayoutForAccount("google:user-a");

    const converged = await ensureProjectFolder({
      accountId: "google:user-a",
      accessToken: "token-a",
      projectId,
      fetchImpl: server.fetchImpl,
      lockAdapter: null,
    });
    assert.equal(converged.projectFolderId, folderA.projectFolderId);
    assert.deepEqual(converged.duplicateFolderIds, [dupId]);

    // 儲存內含本地未備份曲目的 Drive 專案（Metadata-only 清單讀取絕不下載 WAV，且正確呈現部分未備份）
    const authA = {
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: (g, a) => g === 1 && a === "google:user-a",
    };
    const { record } = await createNewProject({
      name: "巡演主歌單",
      storageProvider: "google_drive",
      auth: authA,
      syncImmediatelyIfDrive: false,
    });
    const localSong = createBandSong({
      id: "entry_u1",
      name: "UnbackedSong",
      fileName: "unbacked.mp3",
      sourceAudioId: "entry_u1_original",
      settingsKey: "k-u1",
      originalBpm: 128,
      sourceAudioHash: "u".repeat(64),
      source: { provider: "local" },
      durationSec: 180,
    });
    const editedProj = buildProjectFromBandSongs({
      existingProject: record.project,
      songs: [localSong],
      incrementRevision: true,
    });
    const outcome = await saveProjectToDrive({
      record: { ...record, project: editedProj, localRevision: editedProj.revision, dirty: true },
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: authA.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(outcome.status, "synced");
    assert.equal(outcome.record.project.backupSummary?.localOnlyCount, 1);
    assert.equal(outcome.record.project.backupSummary?.crossDeviceReadyCount, 0);

    server.downloadedIds.length = 0;
    const managed = await listManagedProjects({
      accountId: "google:user-a",
      accessToken: "token-a",
      fetchImpl: server.fetchImpl,
    });
    assert.ok(managed.some((m) => m.projectId === record.projectId));

    const cloudList = await listCloudProjects({
      accountId: "google:user-a",
      accessToken: "token-a",
      fetchImpl: server.fetchImpl,
    });
    assert.ok(cloudList.some((c) => c.project.name === "巡演主歌單"));
    // 清單載入僅讀 project.json，無任何 WAV binary 下載
    assert.equal(
      server.downloadedIds.some((id) => Boolean(server.files.get(id)?.binary)),
      false,
    );

    const loaded = await loadProjectFromDrive({
      projectFileId: outcome.record.project.driveProjectFileId,
      expectedAccountId: "google:user-a",
      accessToken: "token-a",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(loaded.project.songs[0].backupStatus, "local_only");
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("Local original backup writes to songs/<hash>/originals/ once and reuses identical hash without re-uploading", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  clearResumableSessionUrisForAccount();
  try {
    const server = createProjectDriveMockServer();
    const audioBytes = new Uint8Array([11, 22, 33, 44, 55, 66]);
    const file = new Blob([audioBytes], { type: "audio/mpeg" });
    const hash = "f".repeat(64);

    const ref1 = await backupLocalOriginalAudioToDrive({
      file,
      fileName: "guitar.mp3",
      mimeType: "audio/mpeg",
      sourceAudioHash: hash,
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: () => true,
      fetchImpl: server.fetchImpl,
    });
    assert.ok(ref1.driveFileId);
    const uploadCountAfterFirst = server.uploadsByAuth.filter((u) => u.fileName === "guitar.mp3").length;
    assert.equal(uploadCountAfterFirst, 1);

    // 同一帳號同 hash 再備份一次應直接重用 Drive File ID
    const ref2 = await backupLocalOriginalAudioToDrive({
      file,
      fileName: "guitar.mp3",
      mimeType: "audio/mpeg",
      sourceAudioHash: hash,
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: () => true,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(ref2.driveFileId, ref1.driveFileId);
    assert.equal(server.uploadsByAuth.filter((u) => u.fileName === "guitar.mp3").length, 1);
  } finally {
    clearCachedFolderLayoutForAccount();
    clearResumableSessionUrisForAccount();
    resetInMemoryIdbForTests();
  }
});

test("Offline edits save locally first and sync on reconnect; 401 moves to waiting_auth; Google account switch enforces strict isolation", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createProjectDriveMockServer();
    let online = false;
    let currentAuth = {
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: (g, a) => g === currentAuth.generation && a === currentAuth.accountId,
    };

    const p = createEmptyProject({
      name: "Account A Cloud",
      storageProvider: "google_drive",
      ownerAccountId: "google:user-a",
    });
    const rec = createInitialPersistedProjectRecord(p, { dirty: true, syncStatus: "dirty" });

    const statuses = [];
    const controller = new ProjectAutoSyncController({
      localDebounceMs: 5,
      driveDebounceMs: 10,
      isOnline: () => online,
      getAuthContext: () => currentAuth,
      syncDriveFn: (syncParams) => saveProjectToDrive({ ...syncParams, fetchImpl: server.fetchImpl }),
      onStatusChanged: (_id, outcome) => statuses.push(outcome.status),
    });

    // 1. 離線編輯先寫入本機 IndexedDB，不會丟失資料
    controller.scheduleProjectEdit(rec, { immediateLocal: true, syncImmediately: true });
    await new Promise((r) => setTimeout(r, 30));
    const localAfterOffline = await getProjectRecord(rec.projectId);
    assert.ok(localAfterOffline);
    assert.equal(localAfterOffline.dirty, true);
    assert.equal(statuses.includes("error"), true);

    // 2. 恢復連線 -> trigger reconnect sync 成功同步至 Drive
    online = true;
    await controller.resumePendingForAccount("google:user-a");
    const syncedRec = await getProjectRecord(rec.projectId);
    assert.equal(syncedRec.syncStatus, "synced");
    assert.equal(syncedRec.dirty, false);

    // 3. Token 401 -> 進入 waiting_auth 且不再重試輪詢
    currentAuth = {
      ...currentAuth,
      accessToken: "expired-token-a",
    };
    const dirtyRec = {
      ...syncedRec,
      project: { ...syncedRec.project, revision: syncedRec.localRevision + 1, name: "Edited With Expired Auth" },
      localRevision: syncedRec.localRevision + 1,
      dirty: true,
      syncStatus: "dirty",
    };
    controller.scheduleProjectEdit(dirtyRec, { immediateLocal: true });
    await controller.triggerDriveSync(rec.projectId);
    const waitingRec = await getProjectRecord(rec.projectId);
    assert.equal(waitingRec.syncStatus, "waiting_auth");

    // 4. 切換至 Account B -> 廢止 Account A sync slot、絕不混入 Account A 雲端清單，也絕不將 Account A 專案上傳到 Account B
    controller.invalidateAccount("google:user-a");
    currentAuth = {
      accountId: "google:user-b",
      accessToken: "token-b",
      generation: 2,
      isGenerationValid: (g, a) => g === 2 && a === "google:user-b",
    };

    const crossAccOutcome = await saveProjectToDrive({
      record: dirtyRec,
      accountId: "google:user-b",
      accessToken: "token-b",
      generation: 2,
      isGenerationValid: currentAuth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(crossAccOutcome.status, "cancelled");
    assert.equal(
      server.uploadsByAuth.some((u) => u.callerAcc === "google:user-b" && u.lhProjectId === rec.projectId),
      false,
    );

    const listForB = await listAllProjectsForUi({
      currentAccountId: "google:user-b",
      accessToken: "token-b",
      fetchImpl: server.fetchImpl,
    });
    assert.equal(listForB.projects.some((item) => item.projectId === rec.projectId), false);
    controller.dispose();
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("Resumable upload distinguishes fresh upload, in-memory byte resume, and completed artifact reuse", async () => {
  configureInMemoryIdbForTests();
  clearResumableSessionUrisForAccount();
  try {
    const server = createProjectDriveMockServer();
    const bytes = new Uint8Array(64 * 1024);
    const source = {
      totalBytes: bytes.byteLength,
      readSlice: async (start, end) => bytes.slice(start, end),
    };

    const freshRes = await uploadChunkedResumable({
      jobId: "job-r1",
      songId: "song-r1",
      ownerAccountId: "google:user-a",
      sourceAudioHash: "h".repeat(64),
      revisionId: "rev-001",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "root",
      source,
      accessToken: "token-a",
      isAccountStillValid: () => true,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(freshRes.status, "completed");
    assert.equal(freshRes.resumeMode, "fresh_upload");

    // 同一 job metadata 重跑且遠端已完成 -> reused_completed_artifact（不從舊 byte offset 重傳）
    const reusedRes = await uploadChunkedResumable({
      jobId: "job-r1",
      songId: "song-r1",
      ownerAccountId: "google:user-a",
      sourceAudioHash: "h".repeat(64),
      revisionId: "rev-001",
      artifactRole: "vocals",
      fileName: "vocals.wav",
      mimeType: "audio/wav",
      targetFolderId: "root",
      source,
      accessToken: "token-a",
      isAccountStillValid: () => true,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(reusedRes.status, "completed");
    assert.equal(reusedRes.resumeMode, "reused_completed_artifact");
  } finally {
    clearResumableSessionUrisForAccount();
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

test("P0 race: concurrent edits during v10 Drive upload (both flushed and within debounce) are never overwritten by stale sync snapshot, including retry/401/tombstone/IDB errors", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createProjectDriveMockServer();
    let holdV10Patch = null;
    let holdV10Entered = null;
    const observedSyncedBpmHistory = [];

    const wrappedFetch = async (url, init) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      if (
        (method === "POST" || method === "PATCH") &&
        u.pathname.startsWith("/upload/drive/v3/files") &&
        String(init?.body ?? "").includes('"lhRole":"project_json"') &&
        holdV10Patch
      ) {
        const d = holdV10Patch;
        holdV10Patch = null;
        holdV10Entered?.resolve();
        await d.promise;
      }
      return server.fetchImpl(url, init);
    };

    const auth = {
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: (g, a) => g === auth.generation && a === auth.accountId,
    };

    // 建立並預先把專案推進到 localRevision=10
    const baseSong10 = {
      ...createBandSong({
        id: "e1",
        projectEntryId: "e1",
        name: "Race Track",
        fileName: "race.mp3",
        sourceAudioId: "e1_original",
        settingsKey: "k-race",
        originalBpm: 120,
        sourceAudioHash: "r".repeat(64),
        durationSec: 120,
      }),
      targetBpm: 100,
      keyShiftSemitones: 0,
      masterVolume: 0.5,
    };
    let rec = createInitialPersistedProjectRecord(
      buildProjectFromBandSongs({
        existingProject: createEmptyProject({
          name: "Race Project v10",
          storageProvider: "google_drive",
          ownerAccountId: "google:user-a",
        }),
        songs: [baseSong10],
        incrementRevision: false,
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    rec = {
      ...rec,
      project: { ...rec.project, revision: 10, revisionToken: "r10-tok" },
      localBaseRevision: 10,
      localBaseRevisionToken: "r10-tok",
      localRevision: 10,
    };
    await saveProjectRecord(rec);

    const statusEvents = [];
    const controller = new ProjectAutoSyncController({
      localDebounceMs: 60,
      driveDebounceMs: 200,
      retryBackoffMs: [20, 40],
      getAuthContext: () => auth,
      syncDriveFn: (syncParams) => saveProjectToDrive({ ...syncParams, fetchImpl: wrappedFetch }),
      onStatusChanged: (_id, outcome) => {
        statusEvents.push(outcome);
        if ("record" in outcome && outcome.record?.project?.songs?.[0]) {
          observedSyncedBpmHistory.push({
            status: outcome.status,
            rev: outcome.record.localRevision,
            bpm: outcome.record.project.songs[0].settings.targetBpm,
            dirty: outcome.record.dirty,
          });
        }
      },
    });

    holdV10Entered = createDeferred();
    const patchDeferred = createDeferred();
    holdV10Patch = patchDeferred;

    // 1. 開始同步 v10（會停在 PATCH project.json 的 Deferred Promise）
    const v10SyncPromise = controller.triggerDriveSync(rec.projectId);
    await holdV10Entered.promise;

    // 2. 同步卡在半途期間：先編輯形成 localRevision=11 且讓它寫進 IDB，再編輯形成 localRevision=12 停在 Debounce 記憶體內
    const rec11 = {
      ...rec,
      project: buildProjectFromBandSongs({
        existingProject: rec.project,
        songs: [{ ...baseSong10, targetBpm: 111, keyShiftSemitones: 1, masterVolume: 0.61 }],
        incrementRevision: true,
      }),
    };
    rec11.localRevision = 11;
    rec11.project.revision = 11;
    rec11.project.revisionToken = "r11-tok";
    controller.scheduleProjectEdit(rec11, { immediateLocal: true });
    await controller.flushLocalSaves({ projectId: rec.projectId });

    const rec12 = {
      ...rec11,
      project: buildProjectFromBandSongs({
        existingProject: rec11.project,
        songs: [{ ...baseSong10, targetBpm: 142, keyShiftSemitones: 3, masterVolume: 0.88 }],
        incrementRevision: true,
      }),
    };
    rec12.localRevision = 12;
    rec12.project.revision = 12;
    rec12.project.revisionToken = "r12-tok";
    // 特意不 immediateLocal，讓 v12 在 Debounce 內，驗證 v10 commit 前會透過 onBeforeCommit flush v12
    controller.scheduleProjectEdit(rec12, { immediateLocal: false });

    // 3. 放行 v10 上傳完成！
    patchDeferred.resolve();
    const firstOutcome = await v10SyncPromise;
    assert.equal(firstOutcome?.status, "synced");
    assert.equal(firstOutcome?.superseded, true);
    // v10 提交結果絕對不可把本機狀態倒退回 v10 (100 BPM)！
    assert.equal(firstOutcome?.record.localRevision, 12);
    assert.equal(firstOutcome?.record.dirty, true);
    assert.equal(firstOutcome?.record.project.songs[0].settings.targetBpm, 142);
    assert.equal(firstOutcome?.record.lastSyncedRemoteRevision, 10);

    // 等待 follow-up sync 自動把 v12 同步上 Drive
    await new Promise((r) => setTimeout(r, 120));
    const afterFollowUp = await getProjectRecord(rec.projectId);
    assert.equal(afterFollowUp.localRevision, 12);
    assert.equal(afterFollowUp.dirty, false);
    assert.equal(afterFollowUp.syncStatus, "synced");
    assert.equal(afterFollowUp.project.songs[0].settings.targetBpm, 142);
    assert.equal(afterFollowUp.project.songs[0].settings.keyShiftSemitones, 3);
    // 全程 onStatusChanged 從未把 stale 100 BPM 覆寫回流到 UI
    assert.equal(observedSyncedBpmHistory.some((h) => h.bpm === 100), false);

    // 4. 同步失敗/503 重試/401 及帳號切換時一樣絕不覆蓋較新本機修改
    const rec13 = {
      ...afterFollowUp,
      dirty: true,
      syncStatus: "dirty",
      localRevision: 13,
      project: {
        ...afterFollowUp.project,
        revision: 13,
        revisionToken: "r13-tok",
        songs: [
          {
            ...afterFollowUp.project.songs[0],
            settings: { ...afterFollowUp.project.songs[0].settings, targetBpm: 155 },
          },
        ],
      },
    };
    await saveProjectRecord(rec13);

    // 4a. 503 retryable 失敗後自動重試期間又有新編輯 -> 最終必須保留最新修改並成功同步
    let transient503Count = 1;
    let first503Done = false;
    const retryHold = createDeferred();
    const retryCtrl = new ProjectAutoSyncController({
      localDebounceMs: 20,
      driveDebounceMs: 50,
      retryBackoffMs: [25],
      getAuthContext: () => auth,
      syncDriveFn: async (syncParams) => {
        if (transient503Count > 0) {
          transient503Count -= 1;
          return saveProjectToDrive({
            ...syncParams,
            fetchImpl: async () => new Response("Retryable 503", { status: 503 }),
          });
        }
        const out = await saveProjectToDrive({ ...syncParams, fetchImpl: server.fetchImpl });
        if (out.status === "synced" && first503Done) {
          retryHold.resolve();
        }
        return out;
      },
    });
    const firstRetryTry = await retryCtrl.triggerDriveSync(rec.projectId);
    assert.equal(firstRetryTry?.status, "error");
    const rec13b = {
      ...rec13,
      localRevision: 14,
      project: {
        ...rec13.project,
        revision: 14,
        revisionToken: "r14-retry-tok",
        songs: [{ ...rec13.project.songs[0], settings: { ...rec13.project.songs[0].settings, targetBpm: 158 } }],
      },
    };
    retryCtrl.scheduleProjectEdit(rec13b, { immediateLocal: true });
    first503Done = true;
    await retryCtrl.triggerDriveSync(rec.projectId);
    const dbAfterRetry = await getProjectRecord(rec.projectId);
    assert.equal(dbAfterRetry.localRevision, 14);
    assert.equal(dbAfterRetry.project.songs[0].settings.targetBpm, 158);
    assert.equal(dbAfterRetry.syncStatus, "synced");
    await retryCtrl.dispose();

    // 4b. 401 waiting_auth 與帳號切換競態
    const dirtyBefore401 = {
      ...dbAfterRetry,
      dirty: true,
      syncStatus: "dirty",
      localRevision: 15,
      project: {
        ...dbAfterRetry.project,
        revision: 15,
        revisionToken: "r15-tok",
        songs: [{ ...dbAfterRetry.project.songs[0], settings: { ...dbAfterRetry.project.songs[0].settings, targetBpm: 161 } }],
      },
    };
    await saveProjectRecord(dirtyBefore401);
    const hold401 = createDeferred();
    const res401Promise = saveProjectToDrive({
      record: dirtyBefore401,
      accountId: "google:user-a",
      accessToken: "expired-token",
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      onBeforeCommit: async () => {
        await hold401.promise;
      },
      fetchImpl: server.fetchImpl,
    });
    const rec16 = {
      ...dirtyBefore401,
      localRevision: 16,
      project: {
        ...dirtyBefore401.project,
        revision: 16,
        revisionToken: "r16-tok",
        songs: [
          {
            ...dirtyBefore401.project.songs[0],
            settings: { ...dirtyBefore401.project.songs[0].settings, targetBpm: 166 },
          },
        ],
      },
    };
    await saveProjectRecord(rec16);
    hold401.resolve();
    const outcome401 = await res401Promise;
    assert.equal(outcome401.status, "waiting_auth");
    const dbAfter401 = await getProjectRecord(rec.projectId);
    assert.equal(dbAfter401.localRevision, 16);
    assert.equal(dbAfter401.project.songs[0].settings.targetBpm, 166);
    assert.equal(dbAfter401.dirty, true);

    // 4c. 同步進行中發生帳號切換（generation 過期）-> 回傳 cancelled 且不覆蓋較新本機資料
    const holdSwitchRace = createDeferred();
    const switchRacePromise = saveProjectToDrive({
      record: dbAfter401,
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      onBeforeCommit: async () => {
        await holdSwitchRace.promise;
      },
      fetchImpl: server.fetchImpl,
    });
    const rec17 = {
      ...dbAfter401,
      localRevision: 17,
      project: { ...dbAfter401.project, revision: 17, revisionToken: "r17-tok" },
    };
    await saveProjectRecord(rec17);
    auth.generation = 2;
    auth.accountId = "google:user-b";
    holdSwitchRace.resolve();
    const switchRaceOut = await switchRacePromise;
    assert.equal(switchRaceOut.status, "cancelled");
    assert.equal((await getProjectRecord(rec.projectId))?.localRevision, 17);
    auth.generation = 1;
    auth.accountId = "google:user-a";

    // 5. 同步期間刪除專案 -> 寫入受 tombstone 保護回傳 cancelled，絕不復活
    const delPromise = saveProjectToDrive({
      record: dbAfter401,
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      onBeforeCommit: async () => {
        await deleteProjectSafely({
          projectId: rec.projectId,
          scope: "local_only",
          autoSyncController: controller,
        });
      },
      fetchImpl: server.fetchImpl,
    });
    const delOutcome = await delPromise;
    assert.equal(delOutcome.status, "cancelled");
    assert.equal(await getProjectRecord(rec.projectId), null);

    // 6. IndexedDB 寫入失敗時，絕不把 catch 後失敗誤當 synced / local_saved
    const errProj = createInitialPersistedProjectRecord(
      createEmptyProject({
        name: "IDB Failure Probe",
        storageProvider: "google_drive",
        ownerAccountId: "google:user-a",
      }),
      { dirty: true, syncStatus: "dirty" },
    );
    await saveProjectRecord(errProj);
    setInMemoryIdbHooksForTests({
      beforeWrite(storeName) {
        if (storeName === "projects") {
          throw new Error("Simulated IDB write error");
        }
      },
    });
    const failedSync = await saveProjectToDrive({
      record: errProj,
      accountId: "google:user-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(failedSync.status, "error");
    assert.notEqual(failedSync.status, "synced");

    const localErrEvents = [];
    const errCtrl = new ProjectAutoSyncController({
      localDebounceMs: 20,
      getAuthContext: () => auth,
      onStatusChanged: (_id, out) => localErrEvents.push(out.status),
    });
    errCtrl.scheduleProjectEdit({ ...errProj, localRevision: 2 }, { immediateLocal: false });
    await errCtrl.flushLocalSaves();
    assert.equal(localErrEvents.includes("local_saved"), false);
    assert.equal(localErrEvents.includes("local_save_error"), true);
    await errCtrl.dispose();
    await controller.dispose();
  } finally {
    setInMemoryIdbHooksForTests({});
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});

test("P1-2: account switch, sign out, token expiry, project switch, and dispose flush pending 500ms edits without polluting new account UI; tombstone blocks delayed recreate", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    const server = createProjectDriveMockServer();
    let currentAuth = {
      accountId: "google:acc-a",
      accessToken: "token-a",
      generation: 1,
      isGenerationValid: (g, a) => g === currentAuth.generation && a === currentAuth.accountId,
    };

    const makeProj = (name, accountId = "google:acc-a") =>
      createInitialPersistedProjectRecord(
        createEmptyProject({
          name,
          storageProvider: "google_drive",
          ownerAccountId: accountId,
        }),
        { dirty: true, syncStatus: "dirty" },
      );

    const pSwitchAcc = makeProj("Pending Account Switch");
    const pSwitchProj = makeProj("Pending Project Switch");
    const pDispose = makeProj("Pending Unmount Dispose");
    const pDeleted = makeProj("Deleted Before Flush");
    await saveProjectRecord(pSwitchAcc);
    await saveProjectRecord(pSwitchProj);
    await saveProjectRecord(pDispose);
    await saveProjectRecord(pDeleted);

    const uiCallbacksAfterSwitch = [];
    let activeUiAccount = "google:acc-a";
    const ctrl = new ProjectAutoSyncController({
      localDebounceMs: 500,
      driveDebounceMs: 4000,
      getAuthContext: () => currentAuth,
      syncDriveFn: (p) => saveProjectToDrive({ ...p, fetchImpl: server.fetchImpl }),
      onStatusChanged: (pid, outcome) => {
        if (activeUiAccount !== "google:acc-a") {
          uiCallbacksAfterSwitch.push({ pid, status: outcome.status });
        }
      },
    });

    // 1. 在 500ms Debounce 內編輯後立即切換帳號（模擬 Account A -> Account B）
    const editedAcc = {
      ...pSwitchAcc,
      localRevision: 2,
      project: { ...pSwitchAcc.project, revision: 2, revisionToken: "r2-acc-a", name: "Unsaved Before Switch" },
    };
    ctrl.scheduleProjectEdit(editedAcc); // 500ms local debounce 尚未到期
    activeUiAccount = "google:acc-b";
    currentAuth = {
      accountId: "google:acc-b",
      accessToken: "token-b",
      generation: 2,
      isGenerationValid: (g, a) => g === 2 && a === "google:acc-b",
    };
    await ctrl.invalidateAccount("google:acc-a");
    assert.equal((await getProjectRecord(pSwitchAcc.projectId))?.project.name, "Unsaved Before Switch");
    assert.equal(uiCallbacksAfterSwitch.length, 0); // 舊帳號不觸發 UI 回呼掛回新帳號畫面

    // 2. 切回 Account A 後在 500ms 內切換另一專案 (invalidateProject(..., discardPendingLocal: false))
    activeUiAccount = "google:acc-a";
    currentAuth = {
      accountId: "google:acc-a",
      accessToken: "token-a",
      generation: 3,
      isGenerationValid: (g, a) => g === 3 && a === "google:acc-a",
    };
    const editedSwitchProj = {
      ...pSwitchProj,
      localRevision: 2,
      project: { ...pSwitchProj.project, revision: 2, revisionToken: "r2-sw", name: "Saved On Project Switch" },
    };
    ctrl.scheduleProjectEdit(editedSwitchProj);
    await ctrl.invalidateProject(pSwitchProj.projectId, { discardPendingLocal: false });
    assert.equal((await getProjectRecord(pSwitchProj.projectId))?.project.name, "Saved On Project Switch");

    // 3. 在 500ms Debounce 內主動刪除專案 -> 遵守 tombstone，絕不重建
    ctrl.scheduleProjectEdit({
      ...pDeleted,
      localRevision: 2,
      project: { ...pDeleted.project, revision: 2, revisionToken: "r2-del", name: "Should Stay Deleted" },
    });
    await deleteProjectSafely({
      projectId: pDeleted.projectId,
      scope: "local_only",
      autoSyncController: ctrl,
    });
    await ctrl.flushLocalSaves();
    assert.equal(await getProjectRecord(pDeleted.projectId), null);

    // 4. 在 500ms Debounce 內元件 unmount 呼叫 dispose() -> 本機未提交資料必須安全落盤
    ctrl.scheduleProjectEdit({
      ...pDispose,
      localRevision: 2,
      project: { ...pDispose.project, revision: 2, revisionToken: "r2-disp", name: "Saved On Dispose" },
    });
    await ctrl.dispose();
    assert.equal((await getProjectRecord(pDispose.projectId))?.project.name, "Saved On Dispose");
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
