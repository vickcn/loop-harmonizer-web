import test from "node:test";
import assert from "node:assert/strict";
import { clearCachedFolderLayoutForAccount } from "../lib/google/driveFolderManager.ts";
import { DRIVE_CAS_LIMITATION_NOTE, saveProjectToDrive } from "../lib/projects/projectDriveSync.ts";
import { createNewProject, openProjectMetadataAndEntries, resolveProjectConflict } from "../lib/projects/projectManager.ts";
import {
  configureInMemoryIdbForTests,
  resetInMemoryIdbForTests,
} from "../lib/storage/indexedDb.ts";
import { getProjectRecord, saveProjectRecord } from "../lib/storage/projectStore.ts";

function createConflictMockDriveServer() {
  let nextId = 1;
  let versionSeq = 1;
  const files = new Map();
  let concurrentOverwriteNextRevisionToken = null;

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

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();

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
          if (parentMatch && !r.meta.parents?.includes(parentMatch[1])) return false;
          if (roleMatch && r.meta.appProperties?.lhRole !== roleMatch[1]) return false;
          if (projMatch && r.meta.appProperties?.lhProjectId !== projMatch[1]) return false;
          return true;
        })
        .map((r) => r.meta);
      return new Response(JSON.stringify({ files: matched }), { status: 200 });
    }

    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = `fld_${nextId++}`;
      const meta = {
        id,
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents ?? ["root"],
        appProperties: body.appProperties ?? {},
        trashed: false,
        version: String(versionSeq++),
        createdTime: "2026-01-01T00:00:00Z",
        modifiedTime: new Date().toISOString(),
        capabilities: { canAddChildren: true, canDelete: true },
      };
      files.set(id, { meta });
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    if ((method === "POST" || method === "PATCH") && u.pathname.startsWith("/upload/drive/v3/files")) {
      const existingId = method === "PATCH" ? decodeURIComponent(u.pathname.split("/").pop()) : null;
      const { metadata, payload } = parseMultipartRequest(String(init?.body ?? ""));
      const id = existingId || `doc_${nextId++}`;
      const prev = existingId ? files.get(id) : null;

      let effectivePayload = payload;
      let effectiveToken = metadata.appProperties?.lhRevisionToken ?? payload.revisionToken;
      if (
        concurrentOverwriteNextRevisionToken &&
        metadata.appProperties?.lhRole === "project_json"
      ) {
        effectiveToken = concurrentOverwriteNextRevisionToken;
        effectivePayload = {
          ...payload,
          name: "Concurrent Winner Device",
          revision: payload.revision + 5,
          revisionToken: concurrentOverwriteNextRevisionToken,
        };
        concurrentOverwriteNextRevisionToken = null;
      }

      const meta = {
        id,
        name: metadata.name ?? prev?.meta?.name ?? "project.json",
        mimeType: "application/json",
        parents: metadata.parents ?? prev?.meta?.parents ?? ["root"],
        appProperties: {
          ...(prev?.meta?.appProperties ?? {}),
          ...(metadata.appProperties ?? {}),
          lhRevisionToken: effectiveToken,
        },
        trashed: false,
        version: String(versionSeq++),
        modifiedTime: new Date().toISOString(),
        capabilities: { canDelete: true, canEdit: true },
      };
      if (prev) {
        prev.meta = meta;
        prev.json = effectivePayload;
      } else {
        files.set(id, { meta, json: effectivePayload });
      }
      return new Response(JSON.stringify(meta), { status: 200 });
    }

    return new Response("Not Implemented", { status: 500 });
  };

  return {
    files,
    setConcurrentWinnerToken: (tok) => {
      concurrentOverwriteNextRevisionToken = tok;
    },
    fetchImpl,
  };
}

test("Conflict detection covers clean remote_ahead, diverged local+remote non-destructive conflict + all 3 resolutions, read-after-write race, and remote_deleted protection", async () => {
  configureInMemoryIdbForTests();
  clearCachedFolderLayoutForAccount();
  try {
    assert.ok(DRIVE_CAS_LIMITATION_NOTE.includes("CAS"));
    const server = createConflictMockDriveServer();
    const auth = {
      accountId: "google:acc1",
      accessToken: "token-1",
      generation: 1,
      isGenerationValid: (g, a) => g === 1 && a === "google:acc1",
    };

    // Device 1 建立專案並同步 v1 至雲端
    const created = await createNewProject({
      name: "Shared Rehearsal",
      storageProvider: "google_drive",
      auth,
      syncImmediatelyIfDrive: true,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(created.syncOutcome?.status, "synced");
    const recV1 = created.record;

    // 確認不可變 revisions/ 快照已產生
    const revSnapshots = Array.from(server.files.values()).filter(
      (f) => f.meta.appProperties?.lhRole === "project_revision",
    );
    assert.equal(revSnapshots.length, 1);

    // 情境 A：遠端更新至 v2，本機未修改（dirty: false） -> remote_ahead 且開啟時安全更新本機
    const projectFileEntry = server.files.get(recV1.project.driveProjectFileId);
    const remoteV2 = {
      ...projectFileEntry.json,
      name: "Shared Rehearsal (From Desktop v2)",
      revision: 2,
      revisionToken: "r2-desktop",
      updatedAt: "2026-06-01T12:00:00Z",
    };
    projectFileEntry.json = remoteV2;
    projectFileEntry.meta.version = "99";
    projectFileEntry.meta.appProperties.lhRevisionToken = "r2-desktop";

    const checkAhead = await saveProjectToDrive({
      record: { ...recV1, dirty: false },
      accountId: auth.accountId,
      accessToken: auth.accessToken,
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(checkAhead.status, "remote_ahead");

    const openedClean = await openProjectMetadataAndEntries({
      projectId: recV1.projectId,
      cloudEntryHint: { project: remoteV2, driveVersion: "99" },
      auth,
    });
    assert.equal(openedClean.record.project.name, "Shared Rehearsal (From Desktop v2)");
    assert.equal(openedClean.record.localRevision, 2);

    // 情境 B：遠端已前進至 v3，同時本機離線修改（dirty: true） -> 觸發 conflict，絕不靜默覆寫雲端
    const remoteV3 = {
      ...remoteV2,
      name: "Desktop Remote v3",
      revision: 3,
      revisionToken: "r3-desktop",
      updatedAt: "2026-06-02T12:00:00Z",
    };
    projectFileEntry.json = remoteV3;
    projectFileEntry.meta.appProperties.lhRevisionToken = "r3-desktop";

    const localEditedDirty = {
      ...openedClean.record,
      project: {
        ...openedClean.record.project,
        name: "Phone Local Dirty v3",
        revision: 3,
        revisionToken: "r3-phone-local",
      },
      localRevision: 3,
      dirty: true,
      syncStatus: "dirty",
    };
    await saveProjectRecord(localEditedDirty);

    const diverged = await saveProjectToDrive({
      record: localEditedDirty,
      accountId: auth.accountId,
      accessToken: auth.accessToken,
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(diverged.status, "conflict");
    assert.equal(projectFileEntry.json.name, "Desktop Remote v3"); // 雲端未被靜默覆寫
    // 已上傳不可變衝突快照到 revisions/
    const conflictSnapshots = Array.from(server.files.values()).filter(
      (f) => f.meta.appProperties?.lhRole === "project_conflict",
    );
    assert.equal(conflictSnapshots.length, 1);

    // 衝突選項 2：保留本機另存新專案
    const asNewRes = await resolveProjectConflict({
      projectId: recV1.projectId,
      strategy: "save_local_as_new",
      newProjectNameForSaveAs: "手機離線保留版",
      auth,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(asNewRes.createdLocalCopyRecord?.project.name, "手機離線保留版");
    assert.equal((await getProjectRecord(recV1.projectId)).project.name, "Desktop Remote v3");

    // 重建衝突並測試選項 1：載入雲端版本
    await saveProjectRecord({
      ...diverged.record,
      syncStatus: "conflict",
    });
    const loadRemoteRes = await resolveProjectConflict({
      projectId: recV1.projectId,
      strategy: "load_remote",
      auth,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(loadRemoteRes.activeRecord.project.name, "Desktop Remote v3");
    assert.equal(loadRemoteRes.activeRecord.dirty, false);

    // 重建衝突並測試選項 3：明確確認以本機版本取代雲端
    await saveProjectRecord(localEditedDirty);
    const overwriteRes = await resolveProjectConflict({
      projectId: recV1.projectId,
      strategy: "overwrite_remote",
      auth,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(overwriteRes.syncOutcome?.status, "synced");
    assert.equal(projectFileEntry.json.name, "Phone Local Dirty v3");

    // 情境 C：寫入後回讀驗證發現競爭寫入 (read-after-write mismatch)
    server.setConcurrentWinnerToken("r99-concurrent-winner");
    const afterRace = await saveProjectToDrive({
      record: {
        ...overwriteRes.activeRecord,
        dirty: true,
        localRevision: overwriteRes.activeRecord.localRevision + 1,
        project: {
          ...overwriteRes.activeRecord.project,
          name: "Race Sender",
          revision: overwriteRes.activeRecord.localRevision + 1,
        },
      },
      accountId: auth.accountId,
      accessToken: auth.accessToken,
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(afterRace.status, "conflict");

    // 情境 D：遠端檔案被刪除/移至垃圾桶 -> 進入 remote_deleted 衝突，絕不意外重新建立
    projectFileEntry.trashed = true;
    const afterRemoteDelete = await saveProjectToDrive({
      record: { ...overwriteRes.activeRecord, dirty: true },
      accountId: auth.accountId,
      accessToken: auth.accessToken,
      generation: 1,
      isGenerationValid: auth.isGenerationValid,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(afterRemoteDelete.status, "conflict");
    assert.equal(afterRemoteDelete.conflictInfo.kind, "remote_deleted");
    assert.equal(projectFileEntry.trashed, true);
  } finally {
    clearCachedFolderLayoutForAccount();
    resetInMemoryIdbForTests();
  }
});
