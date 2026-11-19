# 瀏覽器端背景分軌任務（第二階段：執行流程解耦與狀態安全）

## 一、架構演進

第一階段透過 `SeparationJobProvider`、`SeparationJobManager` 與全域任務指示器建立了應用程式層的狀態投影，但 `separateSong()` 與 `registerAutoResume` 仍留在 `BandMixer.tsx` 中，使得任務恢復仍依賴 `BandMixer` 掛載與元件閉包。

第二階段將執行、恢復、持久化提交與資源釋放完整抽離至獨立模組 `SeparationJobRunner` 與 `patchPersistedSongSeparationFields`：
- `BandMixer` 僅保留使用者操作、分軌模式選擇、互動確認彈窗（`ResourceGuardModal`）、UI 狀態訂閱與掛載播放引擎資源。
- 任務執行與自動恢復不再依賴特定 React 元件是否掛載；即使重新整理後直接停留在 `/studio`，系統仍可從 IndexedDB 重建任務描述並安全續跑。
- 全程維持純瀏覽器端運算（Demucs Web Worker + IndexedDB + Web Locks + BroadcastChannel），不引入任何後端運算服務。

```mermaid
flowchart TD
    A[BandMixer UI] -->|操作與預檢確認| B[Global SeparationJobManager]
    C[全域背景任務指示器] -->|操作與訂閱| B
    D[SeparationJobProvider] -->|去重生命週期事件| B
    B --> E[SeparationJobRunner]
    E --> F[Web Lock + IndexedDB Lease]
    F --> G[SeparationTaskController]
    G --> H[stemSeparator]
    H --> I[Demucs Worker]
    I -->|Transferable PCM Chunk| J[Atomic Chunk Commit]
    J --> K[(IndexedDB)]
    K --> B
    E --> L[欄位級歌曲提交與資源釋放]
    L -->|patchPersistedSongSeparationFields| K
    B -.useSyncExternalStore 狀態訂閱.-> A
    B -.useSyncExternalStore 狀態訂閱.-> C
```

## 二、Runner 與 Job Manager 責任分工

| 元件 | 核心責任 |
| --- | --- |
| `SeparationJobProvider` | 掛載於 `RootLayout`，監聽 `mount`、`visibilitychange`、`pageshow`、`resume`、`online` 並呼叫 `triggerLifecycleRecovery`；`hidden` 與 `freeze` 不取消 Worker。 |
| `SeparationJobManager` | 應用程式層任務管理器：`startJobController`、防降級 `updateJob`、跨分頁同步 `refreshFromStorage` / `refreshFromCheckpoint`、`pauseJob` / `cancelJob` / `resumeJob` / `requestAutoResume`、重試退避管理與全域 `globalFocusActive`。 |
| `SeparationJobRunner` | 無 UI 依賴的執行宿主：由 IndexedDB 重建 `SeparationJobDescriptor`、取得 Web Lock 並保護完整執行臨界區、計算 `sourceAudioHash`、驗證 Checkpoint 與快取、檢查 Resource / Network Guard、呼叫 `separateAudio`、處理暫停／取消／例外修復及釋放閒置模型。 |
| `patchPersistedSongSeparationFields` | 資料層欄位級原子合併：在背景進度與完成寫入 IndexedDB `songs` Store 時，只更新分軌相關欄位與補齊 `stemChannels`，完整保留使用者於分軌期間修改的 BPM、Key、音量、Loop 與 Playhead。 |
| `sharedSeparationCoordinator` / `stemSeparator` / Worker | 維持單一重型 Worker 並行度限制（同時最多 1 個 Demucs 推論）、Chunk Checksum 與主執行緒 ack 原子交易邊界。 |

## 三、任務描述重建（`SeparationJobDescriptor`）

不新增 IndexedDB Store，直接整合既有的 `separationCheckpoints`、`songs`、`audioFiles`（及尚未完成寫入前之 `transientSongAudioRegistry`）重建：

```mermaid
flowchart TD
    A[Provider 初始化或恢復前景] --> B[讀取 IndexedDB Checkpoints]
    B --> C{本頁或他頁已有執行者?}
    C -->|是| D[維持或同步為 processing]
    C -->|否| E[由 Checkpoints / songs / audioFiles 重建 SeparationJobDescriptor]
    E --> F[驗證原始音訊是否存在]
    F --> G[驗證 userAuthorized 與 Checkpoint 完整性]
    G --> H[Resource / Network Budget Guard]
    H --> I[取得 Web Lock 與 IDB Lease]
    I --> J[獨立 SeparationJobRunner 續跑]
```

- **無原始音訊或未授權**：直接標記為需使用者處理（`requiresManualAction: true`、`autoResumeExhausted: true`），回傳 `blocked` 而不無限重試。
- **跨路由獨立恢復**：在 `/studio` 重新整理時，`SeparationJobProvider` 會在不掛載 `BandMixer` 的情況下自動完成重建與續跑，並透過 `patchPersistedSongSeparationFields` 提交完成狀態；待下次進入 `/band-mixer` 時再將分段音軌載入播放引擎。

## 四、Web Lock 與 Lease 完整生命週期

```mermaid
flowchart TD
    A[取得任務級 Web Lock] --> B[驗證權威 Checkpoint / 既有快取]
    B --> C[取得或續約 IndexedDB Lease]
    C --> D[建立 Controller 與啟動 Worker]
    D --> E[推論運算及 Atomic Chunk Commit]
    E --> F[欄位級寫入歌曲完成紀錄]
    F --> G[終止 Worker 與釋放模型資源]
    G --> H[釋放 IndexedDB Lease 與廣播完成]
    H --> I[釋放 Web Lock]
```

- **排他保護擴大**：`sharedSeparationLeaseManager.withTaskLock(taskId, ...)` 涵蓋驗證、Lease 取得、推論、最終提交與清理全程（禁止巢狀 Web Lock）。
- **Web Lock 探測與 Lease 協同**：Lease TTL 為 90 秒、Heartbeat 為 20 秒（不依賴 `BandMixer` 掛載）；若背景分頁因 timer 節流導致 `leaseExpiresAt` 暫時過期，其他分頁會透過 `isTaskLockHeld(taskId)` 非阻塞探測 Web Lock。只要 Web Lock 仍有效，就維持投影為執行中而不接管。
- **鎖定失敗語意**：Web Lock 取得失敗時，回傳 `{ status: "blocked", code: "lock_unavailable", retryable: true }`，絕不將歌曲標記為 `failed`，也不計入自動續跑失敗次數。
- **降級相容**：在不支援 `navigator.locks` 的瀏覽器上，自動降級為 IndexedDB Lease + Generation Fencing。

## 五、狀態映射、Generation 與防降級策略

1. **窮盡狀態映射（無 `processing` 預設 Fallback）**
   - `mapJobStageToSongSeparationStatus(stage)` 明確映射 `idle` / `preparing` / `downloading` / `processing` / `pausing` / `paused` / `cancelling` / `cancelled` / `completed` / `failed` / `interrupted`。
   - `completed` 固定映射為 `"completed"`。
2. **區分 Chunk 寫完與最終任務完成**
   - `onChunkCommitted` 期間即使寫完最後一段 Chunk，Job Manager 階段仍維持 `processing`（`progress <= 0.99`），必須等 IndexedDB `songs` Store 完成最終欄位合併提交後，才轉為 `completed`。
3. **防降級規則（`canTransitionJobStage` / `updateJob`）**
   - 阻擋過期 `generation`、同世代錯配 `ownerJobToken`、同一世代內 `completedChunks` 倒退。
   - 阻擋 `completed -> processing | interrupted | failed | paused | cancelled` 與 `cancelled -> processing | interrupted | failed`。
   - 若權威 Checkpoint 檢驗發現分段損毀需退回修復，須透過專用入口 `repairJobFromAuthoritativeCheckpoint` 執行並寫入 `recordSeparationDiagnostic` 紀錄。

## 六、跨分頁同步機制

- **輕量廣播**：透過 `BroadcastChannel`（`SEPARATION_LEASE_CHANNEL_NAME`）發送 `lease-acquired`、`task-progress`（僅含 taskId、generation、分段數與位元組數，不含 PCM）、`task-completed`、`task-paused`、`task-cancelled`、`task-failed` 與 `lease-released`。
- **權威對帳（`refreshFromStorage` / `refreshFromCheckpoint`）**：
  - 檢查全部分頁的真實狀態，包含已完成／已取消／已失敗終態，以及已從資料庫刪除的過期投影。
  - 同時檢查本地 `controller` 是否非終態（不僅是 `controllers.has(taskId)`）、IndexedDB Lease 與 Web Lock 持有狀態，正確區分「本分頁執行」、「他分頁執行（`isForeignActive`）」與「失去執行者的中斷任務」。
  - 若任務由另一分頁執行，本分頁的 `pauseJob` / `cancelJob` 安全返回 `false`，避免誤顯示已成功停止。

## 七、自動續跑重試與退避

- 預設上限與退避常數：`MAX_AUTO_RESUME_ATTEMPTS = 3`、`AUTO_RESUME_BACKOFF_MS = [5_000, 15_000, 60_000]`。
- 重試計數與退避時間持久化於 `localStorage`（`loop-harmonizer:auto-resume-retry:v1`），重新整理頁面不會歸零重試計數。
- **生命週期事件去重**：`triggerLifecycleRecovery` 以 in-flight 互斥鎖與去抖動合併連續觸發的 `visibilitychange`、`pageshow`、`resume`、`online`，確保不建立第二個 Worker。
- **計數重置與終止條件**：僅當有實質 Chunk 進展（`completedChunks > baselineCompletedChunks`）才重置連續失敗次數；Web Lock 被他頁持有或頁面隱藏不計入失敗；不可重試錯誤（欠缺音檔、未授權、預算超限）與手動 `paused`／`cancelled` 立即停止自動續跑並顯示需手動介入。

## 八、資源釋放與記憶體邊界

- 任務進入終態（`completed`、`cancelled`、`failed`、`paused`）後，`controllers` 立即清除已終止的 Controller，`autoResumeHandlers` 清除不再需要的句柄，並對歷史終態保留數量做上限裁切（`MAX_RETAINED_TERMINAL_JOBS = 24`）。
- 解除 UI 元件註冊（`subscribe` 返回之 unsubscribe）正確移除 `listeners` 且不影響執行中任務。
- `BandMixer` 卸載時若仍有全域執行中的背景分軌（`sharedSeparationJobManager.hasRunningHeavyTask()`），不得提前 `disposeStemSeparator`，直到 Runner 結束且無活躍任務時才釋放閒置模型／Worker。

## 九、測試與瀏覽器實測結果

### 1. 單元測試、整合測試與建置
- **`npx tsc --noEmit`**：通過（0 錯誤）。
- **`npm test`**：**108 / 108 通過**（0 失敗、0 略過），涵蓋：
  - `spec/background-separation-jobs.spec.mjs`：不掛載 `BandMixer` 完成分離、區分最後 Chunk 與最終提交、`completed` 階段映射、過期頁面重建 Descriptor 續跑、分軌完成保留使用者近期編輯（BPM/Key/音量/Loop）、generation／chunk 防降級與權威修復、跨分頁終態同步與清理、生命週期去重、手動暫停取消保護、重試上限／退避與清理後無殘留 Controller/Handler/Listener。
  - `spec/background-separation-lease.spec.mjs`：背景 Lease 過期但 Web Lock 有效時維持 `processing` 且阻擋他頁、Web Lock 失敗回傳 `blocked` 不標記為 `failed`。
  - `spec/separation-state-recovery.spec.mjs`：新增 `patchPersistedSongSeparationFields` 欄位級原子合併與防降級測試，並維持全部既有 18 項回復與資料安全性測試。
  - `spec/demucs-separation.spec.mjs`、`spec/separation-chunk-checkpoint.spec.mjs` 等 Chunk Checksum、Overlap Carry、2/4 Stem 正確性測試全數通過。
- **`npm run build`**：通過（Next.js 15 編譯與 7/7 靜態頁面輸出成功）。

### 2. 真實瀏覽器（macOS Google Chrome Headless）端到端 Demucs 驗證
使用真實 `htdemucs_embedded.onnx` 模型與本機 WAV 音檔執行 `node tmp/verify_background_separation_phase2.mjs`：

| 測試項目 | 實測操作與觀察數據 | 結果 |
| --- | --- | --- |
| **測試 A：站內路由切換** | `/band-mixer` 啟動 2-Stem 分離 → SPA 切換 `/` → `/studio` 期間全域指示器即時顯示 → `BandMixer` 卸載狀態下於 `/studio` 完成 `2/2` chunks 並寫入 `songs` 完成態 → 切回 `/band-mixer` 無需重算並可正常播放 | 通過 |
| **測試 B：瀏覽器背景分頁（30s WAV）** | 啟動後提交 `nextChunkIndex=1`（`updatedAt=1795021311729`）→ 將第 2 個分頁切至前景停留約 10.3 秒 → 切回原分頁確認已完成 `6/6` chunks（`updatedAt=1795021322022`，`elapsedMs=10293`） | 通過（註：headless Chromium 下 `bringToFront` 後分頁 `document.visibilityState` 仍維持 `"visible"`，非真實 OS 視窗遮蔽節流） |
| **測試 C：重新載入並直入 `/studio` 獨立恢復** | 分離至 `1/6` chunk 處強制 `goto(/studio)` 重新載入（未進 `BandMixer`）→ `/studio` 上的 `SeparationJobProvider` 由 IndexedDB 重建 Descriptor 並自動接續完成至 `6/6` chunks 與 `songs` 完成態 | 通過 |
| **測試 D：跨分頁執行鎖與同步** | 分頁 A 啟動 30s WAV 分離並取得 Lease/Lock → 同上下文分頁 B 開啟 `/band-mixer` 顯示忙碌鎖定且未標記 `failed`／未重複啟動 Worker → 分頁 A 完成後分頁 B 自動同步為「分段分離完成」 | 通過 |

### 3. 尚未驗證的環境
| 環境 | 狀態與原因 |
| --- | --- |
| 非 headless 桌面 Chrome／Edge（視窗最小化／實際 `visibilityState=hidden`） | 未取得有頭桌面視窗互動環境；headless Chromium 未觸發 OS 層背景分頁深度節流，尚未實測長音檔最小化數分鐘是否完成或凍結續跑。 |
| Android Chrome 實機 | 未連接實體裝置，尚未驗證鎖屏後 OS 省電節流與前景自動續跑手感。 |
| Safari / iOS WebKit | 未驗證（特別針對 `navigator.locks` 缺省或頁面生命週期差異之表現）。 |

## 十、剩餘風險與限制

1. **作業系統背景節流／凍結**：瀏覽器仍可能在 OS 省電、休眠或鎖屏下暫停 Web Worker；本設計仰賴每段 Atomic Chunk Commit 保證已算段落不遺失，恢復前景後從最近有效 Checkpoint 安全續跑，而非阻止系統休眠。
2. **主執行緒 Commit ACK 邊界**：Chunk 仍透過 Transferable 傳回主執行緒進行 IndexedDB atomic transaction（以維持 Checksum 與 generation fencing 一致性）；若未來實機實測確認主執行緒背景 timer 節流造成 commit ack 延遲成為瓶頸，才考慮下一階段將 IndexedDB Chunk commit 移入 Worker 執行。
3. **跨分頁控制權限制**：若分頁 B 檢視分頁 A 正在執行的任務，目前採安全鎖定不允許由分頁 B 偽裝暫停或取消成功，須回到持有執行權的分頁或待該任務凍結釋放鎖後再行接手。

## 十一、第三階段：最終提交與自動恢復補強

`completed` 現在只代表「分軌產物、歌曲紀錄與必要播放欄位均已一致提交」；Checkpoint 的 `completed` 僅表示所有 Chunk 已通過驗證。

```mermaid
stateDiagram-v2
  [*] --> processing
  processing --> finalizing: 全部 Chunk atomic commit
  finalizing --> completed: 嚴格 songs transaction 成功
  finalizing --> finalizing: 暫時性儲存失敗
  finalizing --> failed: 歌曲刪除／來源或世代不一致
  processing --> interrupted
  interrupted --> processing: 尚有 Chunk 時恢復
  interrupted --> finalizing: Chunk 已完成時恢復
```

- `commitPersistedSongSeparationFinalization` 在單一 `songs` transaction 內確認歌曲存在、`taskId`、來源 hash、模型／處理版本、模式與狀態轉移，並以 discriminated union 回傳 `committed`、`already_committed`、`song_missing`、`stale_generation`、`source_mismatch` 或 `transition_rejected`。它不吞掉 IndexedDB 錯誤。
- Runner 會在最後一段後投影 `finalizing`（99%），只有上述嚴格提交成功後才呼叫 `markCompleted`、廣播 `task-completed`、釋放舊產物引用。最終提交失敗會保留有效 Chunk；下次恢復會走零推論的既有 Checkpoint 路徑。
- 跨分頁 `refreshFromCheckpoint` 一律重讀歌曲紀錄：完整 Chunk 但歌曲結果未提交時顯示 `finalizing`，不再只依 Broadcast 或 Checkpoint status 顯示完成。
- Job Manager 使用單一 `retryWakeupTimer` 掃描持久化 `nextEligibleAt`；到期後重新驗證生命週期與執行權。背景節流只會延後該喚醒，不會產生 polling 或多個 timer。finalizing 與 interrupted 都可進入同一安全恢復入口，因此完整 Chunk 的重試不會建立 Demucs Worker 或重新下載模型。

本階段新增 `spec/separation-finalization.spec.mjs` 與 `spec/separation-resume-scheduler.spec.mjs`，並擴充跨分頁測試以確認「Chunk completed → finalizing」的權威投影及單一最早到期 retry timer。最新本機驗證：`npm test` 110/110 通過、`npx tsc --noEmit` 通過；實際 UI smoke test 已確認 Band Mixer／首頁／Studio 路由與節拍器互動，未載入真實歌曲，因此 finalizing 與真實 hidden／凍結仍列為未驗證。

---

## 第四階段：執行權、重試排程與最終提交安全修補（Phase 4）

### 1. 重試 Timer `0ms` Spin 根因、事件優先喚醒與瀏覽器綁定修補
- **問題根因**：當環境條件暫時阻擋（如資源不足、他頁鎖定）或 `nextEligibleAt <= now` 尚未重新設定退避時，若直接重新排程 `Math.max(0, nextEligibleAt - now)`，會退化成連續 `0ms` 高頻輪詢；此外 `SeparationJobManager` 原以 `{ setTimeout, clearTimeout }` 未綁定 `globalThis` 建立 `retryTimer`，在真實瀏覽器（Chromium WebIDL）透過 `this.retryTimer.setTimeout(...)` 呼叫時會拋出 `TypeError: Illegal invocation`。
- **修補實作**：
  - constructor 改為包裝 `(callback, delayMs) => globalThis.setTimeout(callback, delayMs)` 與 `globalThis.clearTimeout`。
  - `scheduleRetryWakeup()` 僅維護單一定時器並加入下限保護：`MIN_RETRY_WAKEUP_DELAY_MS = 1_000`（一般到期防抖）與 `BLOCKED_RECHECK_DELAY_MS = 10_000`（被資源／他頁條件阻擋後的保底重檢）。
  - 當頁面處於 `hidden`、本地有其他重型分軌進行中（`hasRunningHeavyTask()` 且非 lightweight `finalization`）、或他頁持有執行權（`isForeignActive`）時，**不建立輪詢定時器**，改為事件優先喚醒：由 `visibilitychange`、`focus`、`online`、`lease-released` 廣播與 `markControllerSettled` 直接觸發 `triggerLifecycleRecovery`。

### 2. Generation 與 `FinalizationFence` 持久化（解除最後一段 Lease 後之執行權防護）
- 在 `SeparationCheckpoint` 新增持久化欄位：`lastExecutionGeneration`、`finalizationFence`（含 `taskId`、`generation`、`ownerJobToken`、`ownerTabId`、`updatedAt`）、`finalizedAt`、`finalizedGeneration` 與 `finalizedOwnerJobToken`；於 `PersistedSongRecord` 與 `BandSong` 對應記錄 `separationGeneration`、`separationOwnerJobToken`、`separationFinalizedAt`。
- 最後一段 Chunk 寫入（`commitChunkAndCheckpointAtomically`）與 `releaseLease` 在將進行中 `lease` 清為 `null` 時，仍會單調保留並推進 `lastExecutionGeneration` 與 `finalizationFence`。
- `SeparationJobLeaseManager.acquireFinalizationOwnership()` 會在單一 IndexedDB 交易內遞增生成最終提交專用 `generation` 與 `ownerJobToken`，並在支援 Web Locks 環境同步配合 `loop-harmonizer:separation:${taskId}`；在無 Web Locks 環境仍可依 IDB `finalizationFence` 阻止舊世代（Gen 1）覆寫新世代（Gen 2）或錯配 Token。
- `stemSeparator.ts` 釋放進行中 Lease 時傳入 `{ suppressCompletedBroadcast: true }`，確保僅在 `commitPersistedSongSeparationFinalization` 成功後才由 `notifyTaskCompleted` 廣播 `"task-completed"`。

### 3. 跨 Store 原子最終提交與單一收斂入口
- `commitPersistedSongSeparationFinalization` 將交易擴展為單一 `readwrite` 原子交易涵蓋 `["songs", "separationCheckpoints", "separationChunks", "separations"]`：
  - 交易內一次驗證歌曲存在性、`sourceAudioHash`、模型／處理版本、Checkpoint 狀態（拒絕對 `cancelled` 提交）、Chunks 鍵數量或快速快取存在性、以及 `lastExecutionGeneration` / `finalizationFence` 世代與 `ownerJobToken`。
  - 同步寫入歌曲完成欄位、`separationGeneration`、`separationFinalizedAt`，並於 Checkpoint 寫入 `finalizedAt`、`finalizedGeneration`、`finalizedOwnerJobToken` 與清除 `retryState: null`。
  - 支援 `allowReplaceCompleted` 與 `expectedPreviousTaskId` 隔離強制重算（`forceRecompute`）：新隔離 `:r...` 任務提交失敗前，原完成歌曲與舊 Chunks 維持可播放，失敗後重試僅針對隔離 `taskId` 執行。
- `saveSongStateRecord` 預設禁止延遲設定寫入（如背景未更新之 debounced UI save）把已完成的 `separationStatus: "completed"` 與 `separationGeneration` 降級；僅在使用者明確清除分軌時傳入 `{ allowResetSeparation: true }`。
- `SeparationJobRunner` 將 chunked、fast-cache、4->2 衍生、`alreadyCompleted` 與 `catchRecovery` 收斂至單一 `performAuthoritativeFinalization`，並支援零 Worker／零下載之 `onlyFinalize: true` 最終提交路徑。

### 4. `SeparationTaskController` 與 Coordinator 結算與退避時間驗證
- `SeparationTaskController` 新增 `settleForFinalizationPending()`，並於 `runSeparationJob` 所有失敗／受阻／取消／完成出口透過 `markControllerSettled` 解除 Coordinator 重型名額佔用；連續最終提交失敗後 `controller.isTerminal() === true` 且 `coordinator.hasRunningHeavyTask() === false`，不阻塞後續重試；`cancelJob` 亦支援中止尚未 `finalizedAt` 的 `finalizing` 等待保存任務。
- 修正 5／15／60 秒退避 off-by-one（以 `backoffCursor` 區分初始失敗後第一次 5 秒排程與冷重啟補齊）：
  - **Fake Clock 實測時間線（`spec/separation-resume-scheduler.spec.mjs` 10.4a）**：
    - `t = 0 ms`：初次 `songs` 寫入失敗 → `attempts = 0`、排程 `+5,000 ms`（`nextEligibleAt = 5,000`）。
    - `t = 5,000 ms`：第 1 次自動重試失敗 → `attempts = 1`、排程 `+15,000 ms`（`nextEligibleAt = 20,000`）。
    - `t = 20,000 ms`：第 2 次自動重試失敗 → `attempts = 2`、排程 `+60,000 ms`（`nextEligibleAt = 80,000`）。
    - `t = 80,000 ms`：第 3 次自動重試失敗 → `attempts = 3`（耗盡），標記 `autoResumeExhausted: true`、`requiresManualAction: true`，狀態訊息轉為 `保存未完成，請手動重試`。
    - `t > 80,000 ms`（推進 10 分鐘）：不再排程或觸發第 4 次自動重試，且全過程無任何 `< 1,000 ms` spin timer。
- 多分頁一致性：重試額度透過 IndexedDB `reserveAutoResumeAttempt` 與 `finalizeAutoResumeAttemptOutcome` 原子預約與結算，兩分頁即使各自持有獨立記憶體狀態共用同一 IDB，總自動重試次數仍嚴格受限為 3 次；跨頁面重新載入保留先前失敗次數。

### 5. `finalizing` UI 區分、手動重試保存與專注模式修補
- `SongCard.tsx` 與 `BackgroundSeparationIndicator.tsx` 清楚區分「主動寫入保存中（`isActivelyFinalizing`）」與「等待自動／手動保存」：
  - 主動寫入顯示 `正在保存結果`（含動畫）；
  - 等待保存（`分軌已完成，等待保存`）、空間不足（`請釋放空間後重試保存`）、他頁處理中（`其他分頁正在處理`）或額度耗盡（`保存未完成，請手動重試`）時**停止無限 Rolling 動畫**，保留防連點保護，並在本地等待時提供 `↻ 重試保存` 按鈕直接呼叫 `sharedSeparationJobManager.retryFinalization(taskId)`（只執行 `onlyFinalize`，0 次建立 Demucs Worker、0 次下載模型）。
- `BackgroundSeparationIndicator.tsx` 新增 `finalizing -> completed` 完成通知涵蓋、以模組層 `announcedCompletionKeys` 去重避免跨頁切換重複跳出，並將 5 秒關閉 timer 拆至獨立 `useEffect([completedNotice])`。
- `BandMixer.tsx` 與 `songModel.ts` 修正兩項瀏覽器實測邊界：
  1. `restoreSongsAfterSeparationFocus` 與 `separateSong` 在退出專注模式時保留 `finalizing` 等待保存狀態，避免被覆寫成 `failed`。
  2. `restoreCachedStems`、`hydrateOnePersistedSong` 與 `subscribeSongSessionSync` 在恢復／同步前確認 `checkpoint.finalizedAt`（或遠端歌曲紀錄已為 `completed`），防止他頁在 `songs` 提交完成前提前渲染完成分軌介面。

### 6. Phase 4 驗證結果與未驗證項目限制
- **型別檢查與生產建置**：
  - `npx tsc --noEmit`：通過（0 錯誤）。
  - `npm run build`：通過（Next.js 15.5.18 靜態／動態頁面全數編譯通過）。
- **自動化單元／整合測試（`npm test`：128 項全數通過）**：
  - 新增並通過 `spec/separation-finalization.spec.mjs`（10/10）：涵蓋 `songs` 寫入故障注入、`QuotaExceededError`、`song_missing`、`stale_generation`、`source_mismatch`、`transition_rejected`、Chunk 保留、重試 0 Worker / 0 下載、`task-completed` 僅於 authoritative commit 後發出、`forceRecompute` 失敗保留舊完成產物、fast-cache 與 4->2 衍生路徑、延遲 `saveSongStateRecord` 防覆寫、無 Web Locks 世代/Token 競態、他頁持鎖、取消防復活與 Controller 連續失敗結算。
  - 新增並通過 `spec/separation-resume-scheduler.spec.mjs`（10/10）：涵蓋可控 Fake Clock 實測 5/15/60s 退避、5 分鐘 `hidden` 零 spin、5 分鐘本地重型任務零輪詢、他頁鎖與 `resource_unavailable` 不扣重試額度並事件喚醒、重載保留嘗試次數、雙分頁 IDB 原子協調上限（總計 <= 3 次）、手動取消／刪歌／`dispose()` 清除 timer 與排程器例外不產生 `unhandledRejection`。
- **真實瀏覽器測試（`node tmp/verify_background_separation_phase4.mjs`，Playwright + Headless Chrome）**：
  - 腳本置於 `tmp/`（受 `.gitignore` 屏蔽），以本機伺服器提供 `tmp/htdemucs_embedded.onnx` 與真實 WAV 測試音檔實測 A～E 全數通過（`ALL_PHASE4_REAL_BROWSER_TESTS_PASSED`）：
    - **測試 A**：`/band-mixer` 啟動分軌 → 切換 `/studio` 觀察指示器並背景完成（`separationFinalizedAt` 寫入）→ 回 `/band-mixer` 切換分軌正常播放。
    - **測試 B**：注入 `songs` store 最終提交寫入失敗 → UI 顯示 `分軌已完成，等待保存` 與 `↻ 重試保存` 且 `cardSpinners = 0`（停止 Rolling）→ 解除注入點擊 `↻ 重試保存` 成功完成，`__demucsWorkerCreatedCount`（1 → 1）與模型下載請求（2 → 2）新增皆為 **0**。
    - **測試 C**：30 秒 WAV 分軌並觸發背景切換與前景回復，`localStorage` 診斷包含 14 筆資料並驗證 `lastChunkCommitAt`／`lastCommitAckMs`、`visibilityState`／`lifecycleEvent` 與 `finalizationOutcome: "committed"`（備註：此短測約 5 秒內完成、短於 20 秒 heartbeat 週期，故該次實測 `hasHeartbeat: false`）。
    - **測試 D**：雙分頁 Tab A 注入最終寫入失敗進入等待保存 → Tab B 的 `SongCard` 與 `BackgroundSeparationIndicator` 皆正確同步顯示等待／他頁處理且未提前顯示完成分軌控制項 → Tab A 手動 `↻ 重試保存` 後 Tab B 同步轉為 `completed` 且 Tab B 建立 Demucs Worker 次數為 **0**。
    - **測試 E**：於 `separationCheckpoints` 已 `completed` 但尚未 `finalizedAt` 與未標記歌曲完成之狀態直接重新導向 `/studio`（不掛載 `BandMixer`）→ 背景恢復自動完成最終寫入，且 `/studio` 建立 Worker 次數 **0**、模型下載 **0**，隨後開啟 `/band-mixer` 直接呈現已完成分軌。
- **尚未實測之環境限制**：
  - TODO 第 11 節提及之子代理 `"gpt6.1 terra中"` 在本對話工具環境中並不存在（可用子代理僅 `self`、`research`、`image-generator`），因此未委派該名稱子代理，所有檢查均由當前工作階段與本機 Playwright 直接執行。
  - Headless Chrome 在同視窗切換分頁時，未取得系統聚焦狀態下 `document.visibilityState` 仍維持回報 `"visible"`；真實行動裝置瀏覽器（iOS Safari／Android Chrome）長時間背景鎖屏系統凍結、`> 20s` 背景節流實測 heartbeat，以及實體裝置磁碟空間真實耗盡觸發之原生 `QuotaExceededError` 未在本機無頭桌面環境驗證。
