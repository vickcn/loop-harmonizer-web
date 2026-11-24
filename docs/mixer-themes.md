# Band Mixer 雙主題

英文字型層級與資源量測另見 `docs/mixer-fonts.md`。

外觀控制由 MixerAppearance 獨立管理，裝置偏好儲存於 localStorage 的
`loop.band-mixer.appearance`。預設 graphite，無效值與儲存讀取錯誤回退 graphite。
元件離開路由時移除 html 的 data-mixer-theme；CSS 均以該屬性限定作用域，
因此 body 下的彈窗與提示可以繼承主題，Studio 不保留 Mixer 主題。
外觀操作不呼叫歌曲、專案、Drive、播放器或分離任務 API。

## 設計

沿用 surface、text、border、action、volume、tempo、success、warning、danger、cloud
語意變數；補上 surface-2。Graphite 使用石墨灰表面及銀藍波形，Daylight 使用暖白、
灰藍表面與深藍文字。波形另提供 background、bar、bar-played、playhead、
playhead-outline、loop-selection、loop-outside、loop-start、loop-end、
loop-label-background、focus-ring 變數。所有配色見 app/mixer-themes.css。

WaveformBars 接收原有穩定峰值陣列，以 memo 避免 Seek 和區間預覽重畫靜態波形。
音訊取樣、峰值快取及播放引擎保持原流程。A/B 方向鍵停止事件冒泡，避免同時 Seek。

## 2026-11-24 驗證

本機 Headless Chrome，1280×900 與 390×900：
- Graphite/Daylight 均無橫向溢出。
- A 把手實際滑鼠拖曳成功；切換主題保留 A 值。
- 重新整理保留 Daylight，進入 Studio 移除主題屬性。
- React DevTools commit hook 計數：五次方向鍵 Seek，TrackPlayhead 20→26，WaveformBars 2→2。
- 播放中切換主題，AudioContext 建立數 1→1、decodeAudioData 呼叫數 1→1。
- npm test：201 項通過；TypeScript 通過。
- B 把手滑鼠拖曳與方向鍵調整通過；方向鍵沒有連帶移動播放頭。
- 切換時專案狀態文字保持相同，未觀察到新增 Google API 寫入請求（未登入環境）。
- Daylight 專案對話框實際背景為白色，截圖存於 tmp/theme-daylight-project-dialog.png。
- 正式 npm run build 成功；建置前停止開發服務避免快取衝突。

可重跑腳本：tmp/verify-mixer-themes.mjs（依專案規則保留 tmp 忽略設定）。
截圖：tmp/theme-{1280,390}-{Graphite,Daylight}.png。

## 驗證限制

390px 為桌面 Chrome 視窗模擬，不代表 Android 實機觸控、背景、省電或 Demucs 負載驗證。
未使用已登入 Google 帳號驗證 Drive 網路請求；外觀不寫入專案為程式依賴隔離，
不是完整雲端端到端測試。未完成所有 Modal 狀態的視覺覆蓋與多曲同播效能量測。
