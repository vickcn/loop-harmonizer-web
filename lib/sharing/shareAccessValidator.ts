import { downloadDriveJson, getDriveFileMetadata } from "../google/driveClient.ts";
import { validateProjectShareManifest, validateProjectSharePointer } from "./shareManifest.ts";
import type { ProjectShareManifest, ProjectSharePointer } from "./shareTypes.ts";

export async function loadAndValidateSharedProject(params: {
  shareId: string;
  pointerFileId: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ pointer: ProjectSharePointer; manifest: ProjectShareManifest }> {
  if (!params.shareId || !params.pointerFileId) throw new Error("分享連結缺少必要識別資訊。");
  const [metadata, rawPointer] = await Promise.all([
    getDriveFileMetadata(params.pointerFileId, {
      accessToken: params.accessToken,
      fields: "id,name,trashed,appProperties,capabilities(canDownload)",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
    downloadDriveJson<unknown>({
      fileId: params.pointerFileId,
      accessToken: params.accessToken,
      fileName: "share.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
  ]);
  if (metadata.trashed || metadata.capabilities?.canDownload === false) {
    throw new Error("你目前沒有此專案的存取權，請聯繫分享者。");
  }
  if (
    metadata.appProperties?.lhApp !== "loop-harmonizer" ||
    metadata.appProperties?.lhRole !== "shared_project" ||
    metadata.appProperties?.lhShareId !== params.shareId
  ) {
    throw new Error("此檔案不是有效的 Loop Harmonizer 分享描述檔。");
  }
  const pointer = validateProjectSharePointer(rawPointer);
  if (pointer.shareId !== params.shareId) throw new Error("分享連結與 Drive 檔案識別不一致。");
  const manifest = validateProjectShareManifest(
    await downloadDriveJson<unknown>({
      fileId: pointer.revisionManifestFileId,
      accessToken: params.accessToken,
      fileName: "share-manifest.json",
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    }),
    { shareId: pointer.shareId, publishedRevisionId: pointer.publishedRevisionId },
  );
  return { pointer, manifest };
}
