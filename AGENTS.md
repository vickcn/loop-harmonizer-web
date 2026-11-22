# Project Persona

你是本專案的 Design Lead + Frontend Architect。

## Core Rules
- 使用繁體中文
- 改代碼遵守「最小改動」原則
- Next.js 15 (App Router) + React 19 + Tailwind
- 確保在手機直向頁面 / 電腦橫向頁面 都使用舒適
- 保持專業音樂科技感
- 深色模式（Dark Mode）
- 優先 UX / UI
- 先做 wireframe 與 component tree
- 修改前先列出：
  1. 檔案
  2. 目的
  3. 風險
- 保持可部署（零雲端音訊成本，所有音訊運算均在瀏覽器本機端執行）
- 測試驗證：修改核心邏輯前後必須執行 `npm test`，確保 192 項單元測試全數通過；同時執行 `npx tsc --noEmit` 確保型別零錯誤
- 開發防護：嚴禁在 `npm run dev` 啟動期間執行 `npm run build`，以避免 Webpack runtime 與 `.next` 快取衝突產生 `a[d] is not a function` 錯誤

## 腳本與環境注意
- 自動化腳本預設使用 `http://localhost:3000`
- 專案區底下的 `tmp/` 作為測試腳本與暫存輸入輸出的存放處
- 若需執行 Python 腳本，虛擬環境預設使用 `source ~/tchop/bin/activate`
- `.gitignore` 中如果有屏蔽測試腳本應予保持，除非確認為進版功能

---

## 核心開發要點與技術備忘

### 一、Timeline Editor 手勢與縮放關鍵（手機與桌機）
1. **Pinch 手勢防誤觸**：
   - Pinch 邏輯只在「雙指成立」時啟用（`id1 !== -1`），避免單指誤入 pinch 分支吃掉拖曳事件。
   - 只有 `pointerType === "touch"` 才建立 pinch tracking；第二指進來時清掉背景 pan 狀態，避免互相干擾。
2. **錨點拖曳同步**：
   - 錨點拖曳使用 `dragIdRef` + state 同步，避免 React state 時序造成首段 `pointermove` 漏接。
3. **單指與雙指職責分離**：
   - 雙指手勢只做 `X` 軸 zoom，不做 pan；單指背景拖曳維持 `X` 平移。
4. **播放軸為中心縮放**：
   - Pinch zoom 以「當下播放軸（playhead bar）」為縮放中心，段落色塊/小節線/錨點共用同一 X 座標系統同步縮放。
5. **桌機操控適配**：
   - 觸控板/滑鼠滾輪做 `X` 軸 zoom（同樣以播放軸為中心）；`Alt + 滾輪` 保留給 `Y` 軸範圍調整。

### 二、播放軸拖曳與定位穩定做法
1. **Pointer 事件鏈**：
   - 播放軸拖曳採 Pointer 事件鏈（`onPointerDown -> onPointerMove -> onPointerUp`），統一支援滑鼠與觸控；拖曳回呼直接走 `onCurrentBarChange -> engine.seekToBar(bar)`。
2. **定位純粹化**：
   - `seekToBar` 只做「定位」：更新 `pendingStartSeconds`、同步 player 位置、重啟 metronome clock，不額外建立新播放管線。
3. **避免重疊播放**：
   - `AudioPlayer.ensureWorklet()` 必須具備「已存在就 return」保護，避免播放中多次 seek 重建 `AudioWorkletNode` 造成重疊播放。
   - `pitch-preserve` 模式 seek 只送 `setPosition`（必要時再補 `play` / `setTempoRatio`），不新增並行聲源。

### 三、Band Mixer（樂團歌曲混音器）架構要點
1. **以歌曲（`BandSong`）為主要操作單位**：
   - 每首歌為獨立物件，內部包含 `sourceAudioId` 與 `stemIds`。
   - 每首歌曲獨立控制：原始/目標 BPM、升降 Key、手動倍率（0.25× ~ 4.0×）、微調（±0.05）、主音量與循環。
2. **播放來源互斥切換（`playbackSource`）與即時反應保障**：
   - 歌曲僅能在「原始混音（`original`）」或「分軌混音（`stems`）」二選一，絕對不可同時發聲造成相位衝突或音量疊加。
   - 切換時透過 `MultiTrackEngine.crossfadeTracks` 執行 60ms 線性淡入淡出，平滑過渡後暫停舊來源。
   - **分軌即時反應**：當使用者操作分軌的音量 Slider、Mute 或 Solo 開關時，系統必須自動切換 `playbackSource` 為 `"stems"` 並保持發聲，嚴禁靜默或繼續播放原曲。
   - **背景保護**：空閒資源回收（`releaseIdleResources`）等背景作業不得擅自覆寫使用者的 `playbackSource` 設定。
3. **多軌同步與群組循環（Loop Group）**：
   - 歌曲內的分軌共用同一 `AudioContext` 時鐘排程，seek 時採用 `seekTracks` 批次定位。
   - 分軌群組循環不可交由各軌獨自 loop，必須由 `setLoopGroup` 在最先結束的音軌觸發全組同步歸零重播（`stopTracks` -> `playTracks`），防止各軌內部微小延遲累積漂移。
4. **SoundTouchJS 整合**：
   - 透過 `SoundTouchAdapter` 實現變速同時升降半音（-12 至 +12 半音）。
   - 多軌同時啟動時，先以 `prepare()` 預載模組，再於同一 JS tick 發送播放指令。
   - SoundTouch 使用舊式 `ScriptProcessorNode`，UI 上須保留「不宣稱樣本級同步」之說明。
5. **多選批次控制與拖曳排序**：
   - 支援 Checkbox 多選歌曲批次播放/暫停/停止。
   - 歌曲卡片支援 HTML5 Drag & Drop 拖曳調整清單順序。

### 四、專案管理、雲端同步與資料安全（Project Manager & Google Drive）
1. **工具列契約（Toolbar Contract）**：
   - 主工具列固定維持「專案」、「儲存」、「同步」三大核心功能入口，嚴禁任意更名、合併或移除。
2. **Fail-Closed 專案安全防護**：
   - 專案狀態查詢與未儲存校驗一律採 Fail-closed 原則：遇異常或無回應狀態一律視為「存在未儲存變更」，強制阻擋切換、載入或關閉，防止使用者心血遺失。
   - 切換或建立專案前，必須嚴格檢查是否有未存資料；若有變更，必須顯示應用內確認彈窗並支援非破壞式保存。
3. **現代化彈窗取代原生 Alert/Confirm**：
   - 嚴禁呼叫瀏覽器原生 `window.alert()` / `window.confirm()` / `window.prompt()`。
   - 一律使用應用內 React Modal/Dialog 進行二次確認、衝突比對與錯誤反饋。
4. **載入請求序號防護（Request Sequence Guard）**：
   - 專案清單與 Google Drive 檔案清單必須具備 `loadSeqRef` 序號檢查，丟棄過期非同步請求，防止 Race Condition 造成舊資料覆蓋新狀態。
5. **輕量化 JSON 架構**：
   - 專案 JSON 只保存曲目參數、參照與分軌設定，嚴禁將龐大二進位 PCM/WAV 寫入專案結構。

### 五、行動端與窄版面操控體驗（Mobile & Touch Ergonomics）
1. **速度滑桿長按防誤觸（Touch Guarded Slider）**：
   - 手機觸控環境下，速度滑桿由 `TouchGuardedRangeSlider` 封裝，必須長按 350ms 解鎖後才允許調整數值，防止滑動頁面時意外誤觸變速。
2. **狀態指示燈濃縮（LED Indicator Dots）**：
   - 當歌曲狀態標籤超過 2 個時，自動濃縮為彩色 LED 光點群（以綠/黃/紫/藍等視覺呼吸/恆亮區分），支援懸浮與長按顯示詳細說明，防止排版膨脹。
3. **窄版面防溢出與文案精簡**：
   - 所有網格與彈性佈局容器強制設定 `minmax(0, 1fr)` 與 `overflow-hidden`。
   - 分軌切換按鈕簡化排版（不顯示冗餘「分軌」文字），長檔名與系統內部雜湊（如 `local-sep:...`）在 UI 上一律轉為友善繁體中文提示。

### 六、Demucs 音源分離與 WebGPU/WASM 邊界
1. **全瀏覽器端推論**：
   - 模型下載、音訊切片、推論及 PCM 重組全部在使用者本機端執行，不經任何雲端 API。
2. **後端優先級與自動 Fallback**：
   - 優先偵測與使用 `WebGPU`；若環境不支援、推論失敗或記憶體不足（OOM），必須 release 舊 session 並安全降級至多執行緒 `WASM`。
3. **零 WAV 二次編解碼**：
   - 模型分離輸出的 PCM 浮點陣列直接透過 `createAudioBufferFromStem` 轉入 `AudioBuffer`。
   - 嚴禁進行「PCM -> WAV -> AudioBuffer」的轉碼與二次解碼，以避免無謂的記憶體複製與延遲。
   - 僅當使用者點擊「↓ WAV」按鈕時，才以 `encodeStereoWav` 輸出 16-bit 44.1kHz RIFF WAV 供瀏覽器下載。

### 七、本機持久化與快取生命週期
1. **分離結果快取（`separationCache`）**：
   - 依 `sourceAudioHash`、`DEMUCS_MODEL_VERSION`、`separationMode`、`SEPARATION_PROCESSING_VERSION` 組合成 Cache Key 儲存於 IndexedDB。
   - 再次載入相同歌曲時，系統自動秒級還原已分離的 Stems。
2. **ONNX 模型快取（`modelCache`）**：
   - 模型檔案下載後存入 CacheStorage / IndexedDB，避免每次重新整理都重複下載龐大模型權重。
3. **歌曲設定持久化（`songSettings`）**：
   - 依檔案簽章以 Debounce 方式寫入 localStorage，下次載入時還原 BPM、Key、倍率與分軌靜音/音量狀態。
   - 嚴格限定只存控制參數 JSON，絕不存入巨大二進位音訊。
4. **清理快取安全性**：
   - 使用者點擊「清理快取」時，只清除 IndexedDB/CacheStorage 的持久化記錄，不得中斷或卸載當前記憶體中已載入且正在播放的 AudioBuffer。

### 八、測試與驗證指令
- 測試指令：`npm test`
  （實質執行：`spec/` 下包含 demucs、stem-sync、song-mixer、project-manager、project-drive-sync、project-toolbar 等完整測試集）
- 型別檢查：`npx tsc --noEmit`
- 驗證標準：每次修改核心資料模型、混音邏輯、專案協調器或 UI 核心元件後，必須確保 **192 項單元測試全數通過** 且 **TypeScript 零型別錯誤**。
