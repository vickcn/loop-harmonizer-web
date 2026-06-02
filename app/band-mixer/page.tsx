import Link from "next/link";
import { BandMixer } from "@/components/band/BandMixer";

export default function BandMixerPage() {
  return (
    <main className="container layout">
      <div className="col-full" style={{ paddingBottom: 0 }}>
        <Link href="/" className="small" style={{ color: "var(--muted)", textDecoration: "none", opacity: 0.7 }}>
          ← 首頁
        </Link>
      </div>

      <header className="col-full">
        <h1 className="title">Band Mixer M1</h1>
        <p className="subtitle">多音檔載入、每軌播放線、倍率基準設定。M1 使用 AudioBufferSourceNode 真實播放，保音高變速留到 M2。</p>
      </header>

      <div className="col-full">
        <BandMixer />
      </div>
    </main>
  );
}
