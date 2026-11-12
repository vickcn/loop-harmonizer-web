"use client";

import { useState } from "react";
import type { BandSong, StemChannel } from "@/lib/band/bandTypes";
import type { StemSeparationMode } from "@/lib/separation/stemTypes";
import { getEffectivePlaybackRate } from "@/lib/band/songModel";
import { TrackPlayhead } from "./TrackPlayhead";
import { StemMixer } from "./StemMixer";

type Props = {
  song: BandSong;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChange: (patch: Partial<BandSong>) => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onSeparate: (mode: StemSeparationMode) => void;
  onSwitchSource: (source: "original" | "stems") => void;
  onStemChange: (id: string, patch: Partial<StemChannel>) => void;
  onDownloadStem: (id: string) => void;
  onClearSongCache: () => void;
  onRemove: () => void;
};

const STATUS_COLOR = { stopped: "var(--muted)", playing: "#22c55e", paused: "#f59e0b" };
const STATUS_LABEL = { stopped: "停止", playing: "播放中", paused: "暫停" };

export function SongCard(props: Props) {
  const { song } = props;
  const [mode, setMode] = useState<StemSeparationMode>(song.separationMode ?? "four_stem");
  const rate = getEffectivePlaybackRate(song);
  const coarseRate = song.tempoMode === "target-bpm"
    ? song.targetBpm / Math.max(1, song.originalBpm)
    : song.manualRate;

  return (
    <article className="card grid" style={{ gap: 14, border: song.selected ? "1.5px solid var(--accent)" : undefined }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 10 }}>
          <input
            type="checkbox"
            aria-label={`選取 ${song.name}`}
            checked={song.selected}
            onChange={(event) => props.onChange({ selected: event.target.checked })}
          />
          <div>
            <strong style={{ display: "block", fontSize: 16 }}>{song.name}</strong>
            <span className="small" style={{ opacity: 0.5 }}>{song.fileName}</span>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="small" style={{ color: STATUS_COLOR[song.status] }}>● {STATUS_LABEL[song.status]}</span>
          <button className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={props.onToggleCollapse}>
            {props.collapsed ? "展開" : "收合"}
          </button>
          <button className="btn" style={{ padding: "4px 8px", fontSize: 12, color: "#f87171" }} onClick={props.onRemove}>移除</button>
        </div>
      </div>

      {!props.collapsed && <>
        <TrackPlayhead playheadSec={song.playheadSec} durationSec={song.durationSec} onChange={props.onSeek} />

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className={`btn${song.status === "playing" ? " primary" : ""}`} onClick={props.onPlayPause}>
            {song.status === "playing" ? "⏸ 暫停" : "▶ 播放"}
          </button>
          <button className="btn" disabled={song.status === "stopped"} onClick={props.onStop}>■ 停止</button>
          <button className={`btn${song.loop ? " primary" : ""}`} onClick={() => props.onChange({ loop: !song.loop })}>
            {song.loop ? "⟳ 循環" : "⟳ 單次"}
          </button>
          <label className="row" style={{ gap: 6, marginLeft: "auto" }}>
            <span className="small">主音量</span>
            <input type="range" min={0} max={1} step={0.01} value={song.masterVolume} onChange={(event) => props.onChange({ masterVolume: Number(event.target.value) })} />
            <span className="small">{Math.round(song.masterVolume * 100)}%</span>
          </label>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">原始 BPM</span>
            <input className="input" type="number" min={20} max={300} value={song.originalBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ originalBpm: Math.max(20, Math.min(300, Number(event.target.value) || 120)) })} />
          </label>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">目標 BPM</span>
            <input className="input" type="number" min={20} max={300} value={song.targetBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ targetBpm: Math.max(20, Math.min(300, Number(event.target.value) || song.originalBpm)), tempoMode: "target-bpm", fineRateOffset: 0 })} />
          </label>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">升降 Key</span>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.max(-12, song.keyShiftSemitones - 1) })}>−</button>
              <input className="input" type="number" min={-12} max={12} value={song.keyShiftSemitones} style={{ width: 58, textAlign: "center" }} onChange={(event) => props.onChange({ keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(Number(event.target.value)))) })} />
              <button className="btn" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.min(12, song.keyShiftSemitones + 1) })}>+</button>
            </div>
          </label>
          <label className="grid" style={{ gap: 4, flex: "1 1 140px" }}>
            <span className="small">手動倍率（優先於目標 BPM）</span>
            <datalist id={`song-rates-${song.id}`}>
              {song.savedRates.map((savedRate) => <option key={savedRate} value={savedRate.toFixed(3)} />)}
            </datalist>
            <input className="input" type="number" list={`song-rates-${song.id}`} min={0.25} max={4} step={0.01} value={song.manualRate.toFixed(3)} onChange={(event) => props.onChange({ manualRate: Math.max(0.25, Math.min(4, Number(event.target.value) || 1)), tempoMode: "manual-rate" })} />
          </label>
          <button
            className="btn"
            onClick={() => {
              const savedRate = Math.round(rate * 1000) / 1000;
              const exists = song.savedRates.some((value) => Math.abs(value - savedRate) < 0.0001);
              props.onChange({
                savedRates: exists
                  ? song.savedRates.filter((value) => value === 1 || Math.abs(value - savedRate) >= 0.0001)
                  : [...song.savedRates, savedRate].sort((a, b) => a - b),
              });
            }}
          >
            {song.savedRates.some((value) => Math.abs(value - rate) < 0.0001) ? "✕ 刪除此倍率" : "＋ 記憶此倍率"}
          </button>
          <button className="btn" onClick={() => props.onChange({ targetBpm: song.originalBpm, keyShiftSemitones: 0, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0 })}>↺ 原始速度／Key</button>
        </div>

        <div className="grid" style={{ gap: 5 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">倍率微調 ±0.05</span>
            <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{rate.toFixed(3)}× · {song.keyShiftSemitones >= 0 ? "+" : ""}{song.keyShiftSemitones} 半音</strong>
          </div>
          <input type="range" min={-0.05} max={0.05} step={0.001} value={song.fineRateOffset} onChange={(event) => props.onChange({ fineRateOffset: Number(event.target.value) })} />
          <div className="small" style={{ opacity: 0.55 }}>粗倍率 {coarseRate.toFixed(3)}× ＋ 微調 {song.fineRateOffset >= 0 ? "+" : ""}{song.fineRateOffset.toFixed(3)}</div>
        </div>

        <section className="grid" style={{ gap: 10, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong>歌曲音源</strong>
            <select className="input" value={mode} disabled={song.separationStatus === "processing"} onChange={(event) => setMode(event.target.value as StemSeparationMode)}>
              <option value="two_stem">2 Stem</option>
              <option value="four_stem">4 Stem</option>
            </select>
            <button className="btn primary" disabled={song.separationStatus === "processing"} onClick={() => props.onSeparate(mode)}>
              {song.separationStatus === "processing" ? "分離中…" : song.separationStatus === "completed" ? "重新分離音源" : "✦ 分離音源"}
            </button>
            {song.stemIds.length > 0 && <>
              <button className={`btn${song.playbackSource === "original" ? " primary" : ""}`} onClick={() => props.onSwitchSource("original")}>原始混音</button>
              <button className={`btn${song.playbackSource === "stems" ? " primary" : ""}`} onClick={() => props.onSwitchSource("stems")}>分軌混音</button>
              <button className="btn" onClick={props.onClearSongCache}>清除此歌快取</button>
            </>}
          </div>
          {song.separationStatus === "processing" && <>
            <progress value={song.separationProgress} max={1} style={{ width: "100%" }} />
            <span className="small">{song.separationMessage || `分離進度 ${Math.round(song.separationProgress * 100)}%`}</span>
          </>}
          {song.separationStatus === "failed" && <span role="alert" className="small" style={{ color: "#f87171" }}>{song.separationMessage}</span>}
          {song.stemIds.length > 0 && <StemMixer channels={song.stemChannels} onChange={props.onStemChange} onDownload={props.onDownloadStem} />}
          <span className="small" style={{ color: "#f59e0b", opacity: 0.9 }}>
            SoundTouch 仍使用舊式 ScriptProcessorNode；同歌分軌共用 AudioContext、歌曲時間軸與單次排程，但目前不宣稱樣本級同步。
          </span>
        </section>
      </>}
    </article>
  );
}
