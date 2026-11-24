# Band Mixer 英文字型系統

## 架構

Band Mixer 透過 Next.js `next/font/google` 載入 Space Grotesk 與 Manrope 的 Latin
可變字型，使用 `display: swap` 與 Next.js 產生的 fallback metric。字型配置集中於
`app/band-mixer/fonts.ts`，頁面 SSR 範圍立即取得字型變數；`MixerAppearance` 掛載時
把同一組變數 class 加到 `html`，讓 body Portal 下的 Modal、Tooltip 與帳戶選單共用
字型。離開 Band Mixer 時會移除 class 與 `data-mixer-theme`，Studio 維持原排版。

字型不寫入主題偏好、專案、IndexedDB 或 Drive。既有主題 key 仍為
`loop.band-mixer.appearance`。

## Tokens 與使用位置

- `--font-brand`：Space Grotesk；Loop Harmonizer、STEMS、PROJECT 等英文標籤。
- `--font-heading`：Space Grotesk；頁面、專案、歌曲、面板及對話框標題。
- `--font-interface`：Manrope；按鈕、輸入、選單、Tooltip、Modal 與操作介面。
- `--font-numeric`：Manrope；時間碼、A/B、BPM、Key、倍率、音量及進度數值。
- `--font-cjk`：PingFang TC、Microsoft JhengHei、Noto Sans TC、sans-serif。

數值層同時啟用 `font-variant-numeric: tabular-nums` 與 `font-feature-settings: "tnum" 1`。
歌曲名稱仍保留 `min-width: 0`、單行省略與 `title` 全文，混合繁中、英文、韓文及
東南亞語言缺少 glyph 時由系統 fallback 接手。

## 資源量測（2026-11-24）

正式 Build 成功並由 Next.js 自託管：

- Build 產物：9 個 WOFF2，共 122,280 bytes（119.4 KiB）。
- 實際 Latin Band Mixer 首次載入：2 個 WOFF2，共 46,756 bytes（45.7 KiB）。
- Space Grotesk Latin：22,320 bytes。
- Manrope Latin：24,436 bytes。
- 其餘檔案由 Next.js 按 Unicode range 產生；目前 Latin 頁面沒有請求。
- Studio 新分頁：0 個 WOFF2 請求，仍使用既有 system-ui。
- 主題連續切換：字型請求數維持 2。

字型小於專案的靜態資源門檻，來源由建置配置重現，不需要 Vercel Blob，也沒有新增
runtime JS loader 或外部 CDN 請求。Git 保存字型配置與來源版本，`.next` 產物不進版。
若未來建置環境無法取得 Google Fonts，可改以取得相同版本與授權的 Latin WOFF2，
納入 `next/font/local`；目前本機正式 Build 可重現，沒有啟用替代流程。

## 驗證

Headless Chrome production server：

- 1280×900、1440×900、390×900、360×800，Graphite Pro 與 Daylight Studio 均無橫向溢出。
- 超長繁中／英文／韓文／印尼文歌名正確省略並保留全文提示。
- 初次字型載入 CLS 為 0；完整測試情境的 0.1025 包含刻意載入歌曲與四次 viewport 改變，
  不作為字型 CLS。
- 播放中切換主題後 AudioContext 建立數 1→1、解碼數 1→1。
- A/B Loop 數值維持不變，波形峰值與渲染流程未修改。
- 專案狀態文字未改變，Google API 寫入請求為 0。
- Portal Modal、Tooltip、Google Account Button computed font 均為 Manrope + CJK fallback。
- `npm test`：203 項通過；TypeScript 與正式 Build 通過。

重跑腳本與截圖放在 gitignored `tmp/verify-mixer-fonts.mjs`、
`tmp/font-{1280,1440,390,360}-{Graphite,Daylight}.png`。

## 尚未驗證

未完成 Android 實機的系統 fallback、最大字體縮放、實際網路限速及記憶體壓力測試；
未在登入 Google 帳號的環境執行 Drive 端到端寫入監測。桌面 Chrome 模擬不能取代
Android Chrome 真機結果。
