# Google Drive 背景雲端任務實作紀錄

## 完成範圍

本階段新增全域 `CloudTaskProvider`、持久化 `CloudTaskManager` 與 `cloudTasks` IndexedDB store，支援四類由使用者明確建立的任務：

- `project_sync`：固定建立任務當下的輕量 Project JSON 快照，沿用既有 Drive Revision、Sibling Branch、衝突與原子提交檢查。
- `original_backup`：以 `sourceAudioHash` 與既有 `audioFiles` key 重新取得 Blob；不在任務紀錄複製音訊。
- `stem_export`：沿用既有 Chunked WAV、SHA-256、Resumable Upload、Manifest 與 Transfer Pin。
- `share_publish`：固定使用者確認的 Project Snapshot、Share ID、visibility 與收件者名單，沿用既有 Share Pointer、Revision、Lifecycle、ACL 與 Revoked Tombstone 防護。

日常音量、BPM、Key、Mute、Solo、Loop 與歌曲排序仍只觸發本機保存，不會建立雲端同步意圖。

## 狀態與恢復

狀態機包含 `queued`、`preparing`、`running`、`pausing`、`paused`、`waiting_network`、`waiting_auth`、`waiting_resources`、`recovering`、`completed`、`failed`、`cancelling`、`cancelled`。

- 同一 intent 依 owner、kind 與 intent ID 原子去重。
- 同瀏覽器跨分頁先取得 Web Lock，再取得 IndexedDB lease；每次寫入驗證 operation generation。
- 過期的執行狀態恢復為 `recovering`；使用者暫停或取消不會自動恢復。
- Retry 為 1 秒、5 秒、15 秒、45 秒，附 ±15% jitter，並尊重較長的 Retry-After；第四次自動重試後停止。
- `visibilitychange` hidden 不會取消既有請求；visible、pageshow、online、focus 與帳戶狀態變更會重新讀取權威紀錄並排程。
- Token 只在執行當下由 Google Account Manager 讀取，沒有寫入 IndexedDB。Resumable Session URI 仍只保留在記憶體。

## IndexedDB v8

新增 `cloudTasks` store，索引為 ownerAccountId、status、kind、projectId、songId、updatedAt 與唯一 intentId。升級只建立缺少的 store/index，不清除歌曲、音訊、Checkpoint、Transfer、Project 或 Share 資料。

任務只保存專案/歌曲/分享 ID、固定的輕量 JSON 快照、來源 hash、Checkpoint/Artifact revision、選擇項與進度；不保存 Access Token、Resumable Session URI 或 Audio Blob。

## 資源協調

- Project JSON Sync 視為輕量工作，可與播放或其他大型工作並行。
- Original Backup、Stem Export 與 Share Publish 視為大型傳輸，同一時間只啟動一項。
- Demucs 執行、其他大型傳輸或剩餘儲存空間低於 32 MiB 時，任務進入 `waiting_resources`。
- Stem Export 沿用既有 Transfer Pin，執行期間不讓 GC 清除使用中的 Checkpoint；完成、暫停或取消後由既有 `finally` 釋放。

## UI

Band Mixer 專案工具列與全域右下角均可開啟背景任務中心。列表只在有真實總 bytes 時顯示百分比，未知總量使用 rolling；提供暫停、繼續、取消、重試與重新授權。取消使用應用內確認視窗，不把關閉視窗視為取消。

## 瀏覽器限制

這是 Best-effort Background Execution + Durable Recovery，不是原生背景服務。Android/iOS 可能凍結或回收分頁；恢復後會從 IndexedDB、既有 Drive Artifact 與 Manifest 重新核對。完整重啟後不保證單一未完成檔案從上次 byte offset 接續，因 Session URI 基於安全考量不持久化；已完成 Artifact 會先核對並重用。

## 尚待真實裝置驗證

- Android Chrome：切換 App、短/長時間鎖屏、系統回收後恢復。
- iOS Safari：背景凍結、重新載入與 OAuth 重新授權後恢復。
- 桌面 Chrome/Edge：長時間 hidden、網路中斷、跨分頁 lease 接管。
- 真實 Google Drive API 的跨裝置衝突仍由 Revision/Pointer 最終一致性檢查處理；Web Locks 無法跨裝置提供原子鎖。
