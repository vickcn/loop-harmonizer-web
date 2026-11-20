import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="container layout">
      <div className="col-full" style={{ paddingBottom: 0 }}>
        <Link href="/" className="small" style={{ color: "var(--muted)", textDecoration: "none" }}>
          ← 返回首頁
        </Link>
      </div>

      <article className="card col-full grid" style={{ gap: 14 }}>
        <header>
          <h1 className="title">Loop Harmonizer 服務條款</h1>
          <p className="subtitle">純前端音訊練團與分軌工具使用規範</p>
        </header>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>1. 本機端工具性質</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            Loop Harmonizer 提供瀏覽器本機端之節拍器時間軸、變速變調混音與 Demucs AI 音源分離功能。所有音訊處理依賴使用者自身裝置之瀏覽器、記憶體與運算能力，不提供任何雲端算力或伺服端音訊儲存保證。
          </p>
        </section>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>2. Google Drive 整合與權限責任</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            Google Drive 整合功能為選用功能，不登入仍可完整使用本機所有功能。使用者應確保對選取匯入或共享的音檔具有合法存取與使用權利，並自行管理自身 Google Drive 儲存配額與共享設定。
          </p>
        </section>

        <section className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>3. 本機離線儲存限制</h2>
          <p className="small" style={{ margin: 0, lineHeight: 1.65 }}>
            瀏覽器本機儲存（IndexedDB / CacheStorage）可能受裝置可用空間、隱私瀏覽模式或作業系統自動清理機制影響。建議將重要分軌成果與混音設定明確備份輸出至您的 Google Drive。
          </p>
        </section>
      </article>
    </main>
  );
}
