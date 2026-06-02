"use client";

import Link from "next/link";
import { useState } from "react";
import { BandMixer } from "@/components/band/BandMixer";
import { BandSession } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";

export default function BandMixerPage() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);

  return (
    <main className="container layout">
      <div className="col-full" style={{ paddingBottom: 0 }}>
        <Link href="/" className="small" style={{ color: "var(--muted)", textDecoration: "none", opacity: 0.7 }}>
          ← 首頁
        </Link>
      </div>

      <header className="col-full">
        <h1 className="title">Band Mixer M0</h1>
        <p className="subtitle">多音檔載入、每軌播放線、倍率基準設定。M0 先建立 UI 與資料狀態，音訊播放引擎留到 M1。</p>
      </header>

      <div className="col-full">
        <BandMixer session={session} onSessionChange={setSession} />
      </div>
    </main>
  );
}
