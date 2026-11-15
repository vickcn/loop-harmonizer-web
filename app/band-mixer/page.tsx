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
        <h1 className="title">歌曲混音器</h1>
        <p className="subtitle">每首歌獨立控制 BPM、Key、Loop 與分軌混音；音軌分離和播放處理都留在瀏覽器。</p>
      </header>

      <div className="col-full">
        <BandMixer />
      </div>
    </main>
  );
}
