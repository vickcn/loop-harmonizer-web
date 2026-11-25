# Google Drive 專案分享安全強化實作紀錄

## 架構與資料安全

- 公開 `song-manifest.json` 改由 `buildSharedDriveSongManifest()` 白名單建構，不再深拷貝私人 Drive Manifest。
- 移除私人原曲 File ID、Resource Key、Drive ID、私人 Session File ID、local task ID 與暫態來源資訊。
- `share-manifest.json` 的 Project Snapshot 只保留可播放設定、來源 Hash、分離版本及共享成果引用。
- OAuth Scope 維持 `drive.file + openid/profile/email`，未擴大成完整 Drive 權限。
- IndexedDB Schema 未升級；沿用 `projectShares`，新增欄位採向下相容 Optional Metadata。

## ACL 差異式更新

1. 完整讀取 Permission 分頁。
2. 區分 Direct 與 Inherited ACL。
3. 先新增缺少的 Reader。
4. 重新讀取並確認新增成功。
5. 再移除不需要的 Direct Reader。
6. 最後重新讀取並以 Drive 實際 ACL 設定 `verified / mismatch / incomplete / unknown`。

ACL 修改與音樂 Revision 發布已拆開；單純新增、移除成員不會複製 WAV。

## 操作競態與恢復

- 每個 `shareId` 使用 Web Locks 排他鎖；沒有 Web Locks 時以同頁序列化加 IndexedDB operation generation 防護。
- Operation Record 保存 `operationId`、種類、世代、開始時間、階段、目標 Revision 與 Pointer 更新狀態。
- 撤銷保存 revocation generation / tombstone，舊操作不得重新發布權限。
- 跨裝置無法由 Web Locks 保護，因此更新 Pointer 前比對 Drive file version，寫後重新讀取 Pointer 與 ACL。
- 操作失敗後不直接套回舊本機狀態，而是重新讀取遠端 Pointer 與 ACL；無法證明一致即標記待修復。

## 跨裝置重建

- 依 `lhApp / lhRole / lhShareId / lhSourceProjectId / lhAccountId` 完整分頁查詢分享資料夾。
- 驗證擁有者、唯一 Pointer、Share ID、Source Project ID 與實際 ACL 後重建本機 Share Record。
- 清單不完整時明確回報，不宣稱沒有分享，也不自動變更遠端權限。

## Manifest 與匯入

- 外部 JSON 設置 4 MiB 與 500 首歌曲上限。
- 驗證歌曲一一對應、Entry ID 唯一、2/4 Stem 角色、來源 Hash、分離版本、Artifact Revision、取樣率、聲道、總樣本、檔案大小、Checksum、BPM、Key、速度、音量及 Loop。
- 匯入寫入 IndexedDB 前會再次執行完整驗證。
- 開啟分享時逐一確認歌曲 Manifest 與所有 Stem 的 Drive 讀取能力；選取 `share.json` 不代表引用檔案必然已授權。

## WAV 與 Revision 政策

- 分享前核對來源 WAV metadata、Drive MD5 與 44-byte Header；Google Drive server-side copy 後再次核對。
- Drive MD5 只和 Drive MD5 比較；應用程式 SHA-256 保留獨立語意。
- 同一 Share 使用 Artifact Pool，依 source hash、模式、模型、處理版本、artifact revision、role、checksum、大小及 PCM 格式重用 WAV。
- 不同 Share 不共用實體檔案，避免權限交叉授權。
- 一般連結只指向 Current Published Revision；但 Share Folder ACL 會使已知歷史 File ID 在分享有效期間仍可能讀取。若需要撤銷歷史版本，必須額外清理或改用每 Revision ACL，不能靠隱藏 UI。

## 發布與 UI

- 發布前擷取 Band Mixer 最新設定、Flush Local Save Debounce、等待 IndexedDB Transaction，重新讀取後才發布。
- 權限成員管理、連結分享、音樂 Revision 更新、修復與停止分享為獨立操作。
- Restricted → Link、移除成員、停止分享均使用應用內確認對話框。
- 缺少雲端 Manifest 時提供「補齊共享成果」，導向現有低記憶體 Drive Export 確認流程；不自動上傳、不重跑 Demucs。

## GC

- Share GC 必須同時具備使用者確認、完整 Inventory、無 Staging、無其他引用、已撤銷、ACL verified。
- 任一條件未知即 Fail Closed。

## 仍需真實 Google API 驗證

- 兩個不同 Google 帳號的 restricted 邀請、Picker 授權、按需下載與播放。
- Workspace 網域禁止 Anyone Reader、Group／Domain ACL 與繼承權限。
- 真實 429／5xx／網路中斷後的遠端 Pointer 與 ACL 修復。
- 大型 WAV server-side copy 後的 MD5/Header 驗證與 Android 記憶體行為。
- 跨裝置同時更新的 Drive version 衝突偵測。

Mock 測試只證明本機狀態機與 API 呼叫順序，不視為真實 Google API 實機驗收。
