# Loop Harmonizer M0 Web

這是一個 M0 Web 原型：

- 載入 loop 音檔
- 播放 / 暫停 / 停止
- 段落 timeline 顯示
- Tempo 錨點拖拉編輯
- 播放既定流程時依 timeline BPM 改變 playbackRate
- 即時切 beat，線性緩衝到目標 BPM
- Tap Tempo：前端敲拍，敲滿後一次送到 Vercel API `/api/beat/analyze`

> 注意：M0 先用 Web Audio `playbackRate` 驗證流程，因此會變速也變調。下一版可接 AudioWorklet + SoundTouchJS / RubberBand WASM 做保音高變速。

## 安裝

```bash
npm install
npm run dev
```

打開：

```bash
http://localhost:3000
```

## 部署到 Vercel

```bash
npm run build
```

推到 GitHub 後，用 Vercel 匯入專案即可。這個 M0 沒有環境變數。

## 操作

1. 載入一個音檔。
2. 設定原始 BPM。
3. 按播放。
4. 在 timeline tempo 區雙擊新增錨點。
5. 拖曳錨點改 bar / BPM。
6. 使用「即時切 Beat」設定目標 BPM 和緩衝拍數。
7. 或用 Tap Tempo 敲拍，敲滿後自動送 API，回傳建議 BPM 後套用。

## 主要檔案

```txt
app/page.tsx
app/api/beat/analyze/route.ts
components/TimelineEditor.tsx
components/TapTempoPad.tsx
components/LiveBeatPanel.tsx
lib/audioEngine.ts
lib/timeline.ts
lib/tapTempo.ts
lib/types.ts
```

## 下一步建議

- Section lane 加上真正拖拉調整段落長度
- Undo / Redo
- 儲存 timeline JSON 到 localStorage / DB
- AudioWorklet 化
- Pitch-preserving time-stretch
- 匯入/匯出 timeline JSON
