import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="container layout">
      <div className="col-full" style={{ paddingBottom: 0 }}>
        <Link href="/" className="small" style={{ color: "var(--muted)", textDecoration: "none" }}>
          ← 返回首頁
        </Link>
      </div>

      <article className="card col-full grid" style={{ gap: 14 }}>
        <header>
          <h1 className="title">Loop Harmonizer 隱私權與資料處理說明</h1>
          <p className="subtitle">Local-first 架構｜所有音訊解碼、AI 音源分離與混音運算皆在您的瀏覽器本機執行</p>
        </header>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>1. 音訊處理與保存位置</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            本應用程式不設後端音訊處理伺服器，也不會透過 Vercel Functions 中繼任何音檔。您載入的本機音檔、Demucs AI 分離產生的分軌 PCM 與 Chunk Checkpoint 皆保存在您裝置瀏覽器的 IndexedDB 與 CacheStorage 中。
          </p>
        </section>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>2. Google 帳號與 Google Drive 授權用途</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            當您主動登入 Google 帳號並授權時，Loop Harmonizer 僅請求最小必要權限（<code>https://www.googleapis.com/auth/drive.file</code> 與基本帳戶識別 <code>openid profile email</code>）。應用程式僅能存取您透過 Google Picker 明確選取的音檔，以及本應用程式在您自己的 Google Drive 建立之 <code>.loopHarmonizer</code> 資料夾內的分軌成果、<code>session.json</code> 與 <code>manifest.json</code>。您的瀏覽器直接與 Google API 通訊。
          </p>
        </section>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>3. Token 與帳戶隔離原則</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            Google OAuth Access Token 僅保存在瀏覽器記憶體中，不會存入 localStorage、IndexedDB、URL 或匯出 Manifest。重新整理頁面後需依瀏覽器工作階段重新授權。雲端成果與上傳紀錄皆依穩定的 Google 帳戶識別碼隔離管理。
          </p>
        </section>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>4. 使用者資料刪除方式</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            本機刪除與雲端刪除完全獨立：登出 Google 不會自動刪除您本機保存的匿名或離線歌曲與分軌；刪除本機分軌不會刪除您已上傳到 Google Drive 的成果；刪除 <code>.loopHarmonizer</code> 中的雲端成果也不會影響您的原始音檔或本機資料。您可隨時於應用程式內撤銷 Google 授權、清除本機儲存空間，或於 Google 帳號安全性設定中移除應用程式存取權。
          </p>
        </section>
      </article>
    </main>
  );
}
