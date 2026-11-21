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

把以下內容貼到雲端 session 的 setup script 欄位（會自動搜尋 repo 位置，不管容器是 `/home/user` 還是 `/root`）：

```bash
set -e
setup_script="$(find "${HOME:-/home/user}" /home /root -maxdepth 5 -type f \
  -path "*/scripts/claude-cloud-setup.sh" 2>/dev/null | head -n 1)"
[ -n "$setup_script" ] || { echo "setup script not found"; exit 254; }
bash "$setup_script"
```

這個專案的腳本會自動尋找 `package.json`、執行 `npm ci`，並預設執行 `npm run build`。  
若要加快初始化，可加環境變數：`SKIP_BUILD=1 bash "$setup_script"`。

## 部署到 Vercel

```bash
npm run build
```

推到 GitHub 後，用 Vercel 匯入專案並設定下方的 Google 環境變數即可。若未設定 Google 環境變數，本機匯入與本機 Demucs 分軌功能仍可完全匿名離線使用，Google Drive 相關功能會維持停用狀態並提示尚未設定。

## Google Drive 整合設定（Google Cloud Console）

Loop Harmonizer 採用 **純前端（Client-Side Local-First）架構**：
- 所有音訊解碼、Demucs 分軌推論、Chunked WAV 匯出與 Google Drive 傳輸均在使用者瀏覽器與 Google Drive API 之間直接進行。
- 本專案**不會**透過 Vercel API 中繼大型音檔或分軌 WAV，也沒有後端資料庫、不存放 Google OAuth Client Secret。

你可以沿用既有的 GCP Project（例如與 `audioStudio` 相同專案），但建議為 **Loop Harmonizer** 建立獨立的 Web OAuth Client，方便設定網域白名單與隔離授權。

### 環境變數（`.env.example`）

複製 `.env.example` 為 `.env.local` 並填入以下公開前端參數（**切勿提交 `.env.local` 或真實金鑰進版控**）：

```dotenv
NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
NEXT_PUBLIC_GOOGLE_API_KEY=""
# 選填：Google Cloud Project Number（Google Picker App ID）。
# 若留空，系統會自動從 NEXT_PUBLIC_GOOGLE_CLIENT_ID 的數字前綴推導。
NEXT_PUBLIC_GOOGLE_APP_ID=""
```

> 目前採用 Google Identity Services（GIS）Token Model，**不需要**也不應把 `Client Secret` 放入前端或環境變數中。

### GCP 設定清單（全部 13 項）

1. **啟用 Google Drive API**：在 GCP Console `APIs & Services > Library` 啟用 `Google Drive API`。
2. **啟用 Google Picker API**：在同一專案啟用 `Google Picker API`。
3. **OAuth Consent Screen**：在 `Google Auth platform / OAuth consent screen` 設定應用程式名稱（如 `Loop Harmonizer`）、支援電子郵件與開發者聯絡信箱，並加上 `/privacy` 與 `/terms` 連結。
4. **必要 OAuth Scope（最小權限）**：僅申請與宣告：
   - `https://www.googleapis.com/auth/drive.file`
   - `openid`
   - `profile`
   - `email`
   （不使用整座雲端硬碟讀取權限 `drive` / `drive.readonly`，也不要求 Gmail / Calendar 等無關 Scope。）
5. **OAuth 測試使用者**：在未通過 Google OAuth Verification 前（Testing 模式），將開發及測試 Google 帳號加入 `Test users`。
6. **正確的 Authorized JavaScript Origins**：在 Web OAuth Client 設定授權來源。
7. **API Key HTTP Referrer 限制**：編輯 `NEXT_PUBLIC_GOOGLE_API_KEY`，限制 `Application restrictions` 為 `Websites (HTTP referrers)`，僅允許你的本機與正式網域（見下述）。
8. **API Key API 限制**：將該 API Key 的 `API restrictions` 限制為僅能呼叫 `Google Picker API`（必要時加上 `Google Drive API` metadata 輔助），勿保留 Unrestricted Key。
9. **Vercel Production 網址設定**：將正式網域（例如 `https://your-app.vercel.app` 或自訂網域，**不可含結尾斜線 `/` 或路徑**）同時加入 OAuth Client `Authorized JavaScript origins` 與 API Key HTTP Referrer 白名單。
10. **本機 `localhost` 網址設定**：加入 `http://localhost:3000` 與 `http://127.0.0.1:3000`（若換 port 亦須加上）至 Authorized JavaScript origins 與 API Key HTTP Referrer。
11. **Preview 網址授權限制**：Google OAuth `Authorized JavaScript origins` 不支援動態萬用字元 `https://*.vercel.app`。請勿試圖放開任意隨機 Vercel Preview URL 來通過 OAuth；若有固定 Staging/Preview 別名網域再單獨註冊，其餘隨機 Preview 環境請維持僅使用本機模式測試。
12. **Google App ID / Project Number**：建議在 `.env.local` / Vercel 設定 `NEXT_PUBLIC_GOOGLE_APP_ID` 為 GCP Project Dashboard 上的 **Project Number**（純數字）；未設定時會自動取 `NEXT_PUBLIC_GOOGLE_CLIENT_ID` `-` 前的數字前綴。若設錯會導致 Shared Drives 或權限驗證異常。
13. **OAuth 發布及必要驗證事項**：`drive.file` 屬於敏感（Sensitive）或受限評估範圍（視 Consent Screen 類型與選取用途而定），從 `Testing` 發布為 `In production` 時需通過 Google Branding / Scope Review，並於首頁及設定中提供公開可存取的隱私權政策（`/privacy`）與服務條款（`/terms`）頁面，且頁面描述必須與實際瀏覽器本機處理與 Google Drive 存取行為一致。

### Google Drive 專用資料夾結構（`.loopHarmonizer`）

所有由 Loop Harmonizer 建立或匯出的雲端檔案均隔離存放於使用者 Google Drive 的專用資料夾（**不會**寫入 `.audioStudio`，也**不使用**隱藏的 `appDataFolder`），並透過 `appProperties`（`lhApp="loop-harmonizer"` 與 `lhAccountId` 等屬性）標記識別：

```text
My Drive/
└── .loopHarmonizer/
    ├── songs/
    │   └── <sourceAudioHash_prefix>/
    │       └── revisions/
    │           └── <revisionId>/
    │               ├── stems/
    │               │   ├── vocals.wav
    │               │   ├── drums.wav / bass.wav / other.wav (4-stem) 或 instrumental.wav (2-stem)
    │               ├── exports/
    │               │   └── custom-mix.wav（若有勾選混音）
    │               ├── session.json（BPM / Key / Volume / Mute / Solo / 倍率）
    │               └── manifest.json（於所有檔案上傳並驗證完成後才最後發布 status: "completed"）
    └── sessions/
        └── default-band-mixer.json
```

- 同名非系統建立的 `.loopHarmonizer` 資料夾不會被誤當作系統資料夾使用。
- Google 帳號切換或登出時會立即清除記憶體 Access Token、作廢進行中的舊世代非同步請求，並維持帳號之間的本地與雲端隔離。

### 專案儲存與 Google Drive 同步（本機自動儲存、雲端手動同步）

- **本機自動儲存**：調整音量、Key、BPM、速度、Mute/Solo、Loop、歌曲排序、改名、分軌完成引用更新等，皆只寫入 IndexedDB（約 500ms Debounce），Google Drive 專案會標記為「本機已儲存 · 尚未同步」，**不會**自動呼叫 Google Drive、也不會建立雲端 Revision。
- **儲存本機鈕**：立即 flush Debounce 並等待 IndexedDB 寫入完成才顯示「本機已儲存」；失敗會顯示明確錯誤；內容未改變時不會產生新版本；不會觸發雲端同步。
- **同步至 Google Drive 鈕**：唯一的雲端專案同步入口。先保存並 flush 本機修改，成功後才驗證帳戶/Token、檢查遠端版本與分支衝突、必要時建立不可變 Revision 並更新 `project.json`。同步期間新產生的本機修改會被保留並維持尚未同步，需再次按下同步鈕，不會自動排第二次同步。
- 登入、切換帳戶、Token 續權、網路恢復、頁面重新整理與開啟專案**皆不會**自動同步；只會保存本機資料並提示有待同步專案。
- 手動同步遇到 429/5xx/短暫網路錯誤時，同一次操作內有限次退避重試（以同次操作的內容快照為準），帳戶切換、刪除或取消後不再繼續。
- 專案同步僅包含專案資料、歌曲引用與混音設定；原始音檔與分軌 WAV 備份仍透過 Drive 匯出對話框明確操作，備份完成後專案會標記為尚未同步。
- 因 Drive API 無跨裝置原子 CAS，仍以不可變 `revisions/`、寫前寫後驗證與 Sibling 分支掃描避免靜默覆寫。

### 隱私權與服務條款

- [隱私權政策（/privacy）](/privacy)
- [服務條款（/terms）](/terms)

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
