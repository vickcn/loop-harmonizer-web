# Google Drive 專案分享實作紀錄

## 架構決策

- 分享紀錄與私人專案分離；`shareId`、`projectId`、`publishedRevisionId` 各自獨立。
- IndexedDB v7 新增 `projectShares`，只保存分享狀態、Drive File ID、權限映射與錯誤診斷，不保存 WAV。
- Google Drive 使用 `.loopHarmonizer/shared/share_<shareId>/`，不對 `.loopHarmonizer`、`songs` 或私人 `projects` 設定外部權限。
- 分享成果一律以 Drive `files.copy` 建立隔離副本。大型 WAV 不經 Vercel，也不整軌載入瀏覽器記憶體。
- 新 Revision 先在私人 staging folder 建立；完整 Manifest 上傳後才移入分享資料夾，最後才更新 `share.json`。
- 分享連結格式為 `/share/<shareId>?file=<share.json Drive File ID>`。網址不含 OAuth token、resource key 或 resumable session URI。
- `shareId` 不是授權；Google Drive ACL 才是權威。接收者在 `drive.file` 下可能需要透過 Picker 明確選取 `share.json`。

## 權限與 OAuth

- 保留 `https://www.googleapis.com/auth/drive.file`，未擴大為完整 `drive` scope。
- 本應用程式建立的分享資料夾可以使用 `permissions.create/list/delete` 管理 reader ACL。
- 指定對象使用 `type=user, role=reader`；連結分享使用 `type=anyone, role=reader, allowFileDiscovery=false`。
- 同一資料夾的權限變更依序執行，避免 Drive ACL last-write-wins 競態。
- 停止分享後重新列出 ACL；若仍有繼承或額外外部權限，紀錄 `requiresPermissionRepair`，不宣稱已完全撤銷。

## 發布與更新

1. 驗證 source hash、完成分軌、Manifest、版本與每軌 checksum。
2. 對每個 Drive Stem 讀取實際 metadata 與前 44 bytes，核對檔案大小、Drive MD5、RIFF/WAVE header、PCM 格式、取樣率、聲道與總樣本數；不下載整軌 WAV。
3. 計算新增 Drive 儲存量。
4. 在私人 staging 建立不可變 Revision。
5. 以 Drive server-side copy 建立共享專用 Stem。
6. 寫入每曲 Manifest 與專案 Share Manifest。
7. 將完成的 Revision 移入 share folder。
8. 設定並重新讀取 Drive ACL。
9. 最後寫入／更新 `share.json` pointer。
10. 只有 pointer 回讀驗證成功才將本機狀態標為 `published`。

私人專案後續修改不會自動發布。更新失敗時舊 pointer 與舊 Revision 保持可讀。

## 接收者匯入

- 開啟連結後只讀取 pointer、Share Manifest 與歌曲 Metadata，不自動下載 WAV。
- 匯入建立新的 project ID 與 song entry ID，保存 `ImportedFromShare`。
- 匯入專案為本機獨立副本；Key、BPM、速度、音量、Mute、Solo、Loop 與排序可獨立修改。
- `artifactRef` 指向共享專用 song manifest；播放時沿用 Imported Stem 按需下載、checksum/WAV header 驗證與 chunk playback，不建立假的 Demucs checkpoint，也不重新推論。
- 尚未下載的分軌仍依賴分享者 Drive 權限，UI 會明確說明。

## GC

- 分享副本採獨立生命週期，不隨私人專案清理自動刪除。
- 只有 `revoked`、權限無待修復、無其他分享引用且使用者另外確認時，才允許規劃清理共享副本。
- 找不到完整分享紀錄時 fail closed。

## 已知限制與人工驗收

- 沒有後端索引，因此不能只靠 shareId 尋找 Drive 檔案；連結必須包含 `share.json` File ID。
- `drive.file` 的接收者跨帳戶讀取需以真實 Google 帳號與 Picker 驗證；Mock 測試不能取代此項。
- Google Workspace 網域可能禁止 `anyone` reader；程式會顯示 Drive 原始拒絕，不會繞過政策。
- 已下載或另存的接收者副本無法在停止分享後遠端收回。
- 真實大檔 server-side copy、ACL 繼承、邀請通知、Android 長時間下載與兩個不同 Google 帳號的端到端流程仍需人工驗收。

## 官方依據

- [Google Drive API OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)：`drive.file` 可存取由應用程式建立或由使用者透過 Picker 明確選取的檔案。
- [Manage sharing](https://developers.google.com/workspace/drive/api/guides/manage-sharing)：資料夾權限由子項目繼承，同一檔案的權限操作需依序處理。
- [Permissions resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions)：本功能使用 create/list/delete 管理 reader ACL，並在撤銷後重新讀取驗證。

## 本機驗證結果（2026-11-24）

- `npm test`：218 / 218 通過，包含 7 個新增分享規格檔、WAV 44-byte Range preflight、權限撤銷、匯入、不可變更新與 GC fail-closed。
- `npx tsc --noEmit`：通過，零型別錯誤。
- `npm run build`：通過；`/share/[shareId]` 正式路由成功產生。
- Mock 與本機建置不等同真實 Google API 驗收；兩個不同 Google 帳號、Workspace 網域政策、真實 anyone ACL、邀請通知、Android 大檔按需播放仍標記為尚未驗證。
