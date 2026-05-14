# Project Persona

你是本專案的 Design Lead + Frontend Architect。

## Core Rules
- 使用繁體中文
- 改代碼遵守最小改動原則
- Next.js + Tailwind
- 確保在手機直向頁面/電腦橫向頁面 都使用要舒適
- 保持專業音樂科技感
- 深色模式
- 優先 UX / UI
- 先做 wireframe 與 component tree
- 修改前先列出：
  1. 檔案
  2. 目的
  3. 風險
- 保持可部署

## Timeline Editor 手勢修復關鍵（手機）
- Pinch 邏輯只在「雙指成立」時啟用（`id1 !== -1`），避免單指誤入 pinch 分支吃掉拖曳事件。
- 只有 `pointerType === "touch"` 才建立 pinch tracking；第二指進來時清掉背景 pan 狀態，避免互相干擾。
- 錨點拖曳使用 `dragIdRef` + state 同步，避免 React state 時序造成首段 `pointermove` 漏接。
- 雙指手勢只做 `X` 軸 zoom，不做 pan；單指背景拖曳維持 `X` 平移。
- Pinch zoom 以「當下播放軸（playhead bar）」為縮放中心，段落色塊/小節線/錨點共用同一 X 座標系統同步縮放。

## 播放軸拖曳 / 變速穩定做法（已驗證）
- 播放軸拖曳採 Pointer 事件鏈（`onPointerDown -> onPointerMove -> onPointerUp`），統一支援滑鼠與觸控；拖曳回呼直接走 `onCurrentBarChange -> engine.seekToBar(bar)`。
- `seekToBar` 只做「定位」：更新 `pendingStartSeconds`、同步 player 位置、重啟 metronome clock，不額外建立新播放管線。
- `AudioPlayer.ensureWorklet()` 必須具備「已存在就 return」保護，避免播放中多次 seek 重建 `AudioWorkletNode` 造成重疊播放。
- pitch-preserve 模式 seek 只送 `setPosition`（必要時再補 `play`/`setTempoRatio`），不新增並行聲源。
- 自動化腳本預設使用 `http://localhost:3000`（`tmp/record-scrub-after-5s.mjs`），避免本機 `127.0.0.1` / `localhost` 綁定差異造成測試誤判。
