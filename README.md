# Loop Harmonizer M1 Web

這是一個 Web 原型：

- 載入 loop 音檔
- 播放 / 暫停 / 停止
- 段落 timeline 顯示
- Tempo 錨點拖拉編輯
- 播放既定流程時依 timeline BPM 改變速度
- 即時切 beat，線性緩衝到目標 BPM
- Tap Tempo：前端敲拍，敲滿後一次送到 Vercel API `/api/beat/analyze`
- M1：加入「變速不變調」播放模式

## M1 變速不變調

播放模式有兩種：

1. **快速變速：會變調**  
   使用 Web Audio `AudioBufferSourceNode.playbackRate`。延遲低、穩定，但速度變化會連帶改變音高。

2. **M1 變速不變調**  
   使用 `AudioWorklet` + 粒狀 overlap-add time-stretch 原型。速度會跟著 timeline / live beat 變化，但音高盡量維持原本高度。

目前 M1 的 pitch-preserve engine 是可部署到 Vercel 的零外部依賴原型。音質不是商用等級，下一階段可以替換成 SoundTouchJS / RubberBand WASM。

## 安裝

```bash
npm install
npm run dev
```

打開：

```bash
http://localhost:3000
```

## Claude 雲端作業設定

如果 Claude 的 setup script 不是在 repo 根目錄執行，會出現 `ENOENT: /home/user/package.json`。  
請把 setup script 設成：

```bash
set -e
setup_script="$(find /home/user -maxdepth 4 -type f -path "*/scripts/claude-cloud-setup.sh" | head -n 1)"
[ -n "$setup_script" ] || { echo "setup script not found"; exit 254; }
bash "$setup_script"
```

這個專案的腳本會自動尋找 `package.json`、執行 `npm ci`，並預設執行 `npm run build`。  
若要加快初始化，可加環境變數：`SKIP_BUILD=1`。

## 部署到 Vercel

```bash
npm run build
```

推到 GitHub 後，用 Vercel 匯入專案即可。這個版本沒有環境變數。

## 操作

1. 載入一個音檔。
2. 設定原始 BPM。
3. 選擇播放模式：
   - 快速變速：會變調
   - M1 變速不變調
4. 按播放。
5. 在 timeline tempo 區雙擊新增錨點。
6. 拖曳錨點改 bar / BPM。
7. 使用「即時切 Beat」設定目標 BPM 和緩衝拍數。
8. 或用 Tap Tempo 敲拍，敲滿後自動送 API，回傳建議 BPM 後套用。

## 主要檔案

```txt
app/page.tsx
app/api/beat/analyze/route.ts
components/TimelineEditor.tsx
components/TapTempoPad.tsx
components/LiveBeatPanel.tsx
components/TransportBar.tsx
lib/audioEngine.ts
lib/timeline.ts
lib/tapTempo.ts
lib/types.ts
public/worklets/pitch-preserve-processor.js
```

## 下一步建議

- Section lane 加上真正拖拉調整段落長度
- Undo / Redo
- 儲存 timeline JSON 到 localStorage / DB
- 把 M1 粒狀引擎替換為 SoundTouchJS / RubberBand WASM
- 加上 buffer size / grain size UI 調音參數
- 匯入/匯出 timeline JSON
