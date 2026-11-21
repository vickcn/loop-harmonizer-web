import type { BandSong } from "../band/bandTypes.ts";
import { downloadDriveJson, listDriveFiles, uploadDriveMultipartJson } from "./driveClient.ts";
import {
  LOOP_HARMONIZER_APP_TAG,
  ensureAppFolder,
} from "./driveFolderManager.ts";
import {
  DRIVE_APPLICATION_ID,
  buildDriveSongSessionPayload,
  type DriveSongSessionPayload,
} from "./driveManifest.ts";

export interface DriveMixerSessionSongEntry {
  songId: string;
  orderIndex: number;
  sourceAudioHash: string | null;
  manifestFileId: string | null;
  revisionId: string | null;
  settings: DriveSongSessionPayload;
}

export interface DriveMixerSessionDocument {
  schemaVersion: 1;
  application: "loop-harmonizer";
  sessionId: string;
  sessionName: string;
  ownerAccountId: string;
  songOrder: string[];
  songs: DriveMixerSessionSongEntry[];
  updatedAt: string;
}

export async function exportMixerSessionToDrive(params: {
  accountId: string;
  accessToken: string;
  songs: readonly BandSong[];
  sessionId?: string;
  sessionName?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ fileId: string; document: DriveMixerSessionDocument }> {
  const sessionId = params.sessionId ?? "default-band-mixer";
  const layout = await ensureAppFolder({
    accountId: params.accountId,
    accessToken: params.accessToken,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const document: DriveMixerSessionDocument = {
    schemaVersion: 1,
    application: DRIVE_APPLICATION_ID,
    sessionId,
    sessionName: params.sessionName ?? "Band Mixer Session",
    ownerAccountId: params.accountId,
    songOrder: params.songs.map((song) => song.id),
    songs: params.songs.map((song, idx) => ({
      songId: song.id,
      orderIndex: idx,
      sourceAudioHash: song.sourceAudioHash ?? null,
      manifestFileId:
        song.driveExport?.ownerAccountId === params.accountId
          ? song.driveExport.manifestFileId
          : song.importedStemOrigin?.ownerAccountId === params.accountId
            ? song.importedStemOrigin.manifestFileId
            : null,
      revisionId:
        song.driveExport?.ownerAccountId === params.accountId
          ? song.driveExport.revisionId
          : song.importedStemOrigin?.ownerAccountId === params.accountId
            ? song.importedStemOrigin.revisionId
            : null,
      settings: buildDriveSongSessionPayload(song),
    })),
    updatedAt: new Date().toISOString(),
  };

  const safeParent = layout.sessionsFolderId.replace(/'/g, "");
  const safeSessionId = sessionId.replace(/'/g, "");
  const existing = await listDriveFiles({
    accessToken: params.accessToken,
    q: `'${safeParent}' in parents and trashed=false and appProperties has { key='lhApp' and value='${LOOP_HARMONIZER_APP_TAG}' } and appProperties has { key='lhSessionId' and value='${safeSessionId}' }`,
    pageSize: 3,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  const uploaded = await uploadDriveMultipartJson({
    accessToken: params.accessToken,
    name: `${sessionId}.json`,
    parentId: layout.sessionsFolderId,
    existingFileId: existing.files[0]?.id,
    payload: document,
    appProperties: {
      lhApp: LOOP_HARMONIZER_APP_TAG,
      lhRole: "mixer_session",
      lhAccountId: params.accountId,
      lhSessionId: sessionId,
    },
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });

  return {
    fileId: uploaded.id,
    document,
  };
}

export async function loadMixerSessionFromDrive(params: {
  fileId: string;
  expectedAccountId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DriveMixerSessionDocument> {
  const doc = await downloadDriveJson<DriveMixerSessionDocument>({
    fileId: params.fileId,
    accessToken: params.accessToken,
    fileName: "mixer-session.json",
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  if (doc.application !== DRIVE_APPLICATION_ID || doc.schemaVersion !== 1) {
    throw new Error("混音器 Session JSON 格式不相容。");
  }
  if (doc.ownerAccountId !== params.expectedAccountId) {
    throw new Error("此混音器 Session 屬於其他 Google 帳戶，已禁止跨帳戶載入。");
  }
  return doc;
}
