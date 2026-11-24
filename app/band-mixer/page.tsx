import Link from "next/link";
import "../mixer-themes.css";
import { MixerAppearance } from "@/components/band/MixerAppearance";
import { BandMixer } from "@/components/band/BandMixer";
import { mixerFontVariableClasses } from "./fonts";

export default function BandMixerPage() {
  return (
    <main className={`container layout band-mixer-page ${mixerFontVariableClasses}`}>
      <div className="col-full" style={{ paddingBottom: 0 }}>
        <Link href="/" className="small" style={{ color: "var(--muted)", textDecoration: "none", opacity: 0.7 }}>
          ← 首頁
        </Link>
      </div>

      <header className="col-full mixer-page-header">
        <div className="mixer-page-heading">
          <span className="mixer-brand-name">Loop Harmonizer</span>
          <h1 className="title">歌曲混音器</h1>
          <p className="subtitle">每首歌獨立控制 BPM、Key、Loop 與分軌混音；音軌分離和播放處理都留在瀏覽器。</p>
        </div>
        <MixerAppearance fontVariableClasses={mixerFontVariableClasses} />
      </header>

      <div className="col-full">
        <BandMixer />
      </div>
    </main>
  );
}
