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
import { createNewProject, listAllProjectsForUi } from "../lib/projects/projectManager.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import { getProjectRecord } from "../lib/storage/projectStore.ts";

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
