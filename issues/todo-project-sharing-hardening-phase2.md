# Google Drive 專案分享第二輪安全修補

基準：`a2ab95801c34787643c655e1b6cbc33aba39d3c4`

## 已實作

- 純本機專案可由目前登入帳戶發布獨立 Share，不改變原專案 Provider／Owner，也不觸發 Project Drive Sync。
- Restricted 分享至少需要一名具體 Reader；空集合不再視為有效 Published ACL。
- `share.json` 加入 `published / revoking / revoked` 遠端生命週期、操作 ID、撤銷 Generation 與時間。
- 撤銷採「寫入 intent → 撤銷並重讀 ACL → 寫入 revoked tombstone → 更新本機」；任一步無法確認即 Fail Closed。
- Discovery 逐項回報略過原因；只要有異常即 `complete=false`，不會清除或覆寫異常分享。
- Pointer 在發布開始、寫入前與寫入後驗證 Version、Lifecycle、Operation ID；不可變 Revision 保留，衝突不自動刪除。
- Artifact Checksum 明確區分 SHA-256 與 MD5；舊 MD5-only Manifest 可驗證，但不會把 MD5 偽裝寫入 SHA-256 欄位。
- Artifact Pool 使用 SHA-256 canonical identity，完整分頁列舉候選，並重驗 Share／模型／版本／大小／Checksum／WAV Header。
- 多首缺少 Manifest 的歌曲可經一次確認後，以 concurrency=1 逐首沿用既有 Chunked WAV Export 與 Resumable Upload；已完成項目立即保存，可從剩餘歌曲接續。

## 跨裝置保證範圍

Google Drive Files API v3 未提供本專案可依賴的 Pointer 原子 Compare-And-Swap 契約，因此不宣稱完全避免最後寫入者覆蓋。系統提供：同瀏覽器 Web Locks、IndexedDB Generation、同帳戶跨裝置 Version 衝突偵測、不可變 Revision、寫入前二次確認、寫後 Operation ID 驗證及衝突拒絕。極窄競態仍可能在兩台裝置最後一次檢查與 PATCH 之間發生；寫後驗證可偵測當下覆寫，但無法阻止稍後另一台完成 PATCH。

## 待真實 Google API 驗證

- 兩個真實 Google 帳號的 Restricted／Link 分享、撤銷與 Picker 授權。
- Shared Drive 或 Workspace 組織政策造成的 inherited ACL。
- Mac／Android 同時發布的窄競態與錯誤訊息。
- Android 背景上傳取消、續傳與可用儲存空間提示。
- MD5-only 歷史成果下載後重算 SHA-256 的完整跨裝置播放流程。

## 明確限制

- 不新增後端、資料庫或 Vercel 音訊流量；WAV 仍由瀏覽器直傳 Google Drive 或 Drive 伺服端 Copy。
- Discovery 不完整時 GC 必須 Fail Closed。
- 已撤銷 Share 不由舊操作重新開放；重新分享應建立新 Share ID。
