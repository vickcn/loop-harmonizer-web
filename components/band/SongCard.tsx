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
const MANUAL_RATE_MIN = 0.25;
const MANUAL_RATE_MAX = 4;
const MANUAL_RATE_STEP = 0.05;

function clampManualRate(value: number) {
  return Math.max(MANUAL_RATE_MIN, Math.min(MANUAL_RATE_MAX, value));
}

export function SongCard(props: Props) {
  const { song } = props;
  const [mode, setMode] = useState<StemSeparationMode>(song.separationMode ?? "four_stem");
  const rate = getEffectivePlaybackRate(song);
  const coarseRate = song.tempoMode === "target-bpm"
    ? song.targetBpm / Math.max(1, song.originalBpm)
    : song.manualRate;
  const setManualRate = (value: number) => props.onChange({
    manualRate: clampManualRate(value),
    tempoMode: "manual-rate",
  });

  return (
    <article className="card grid song-card" style={{ gap: 14, border: song.selected ? "1.5px solid var(--accent)" : undefined }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 10 }}>
          <input
            className="song-select"
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
          <button className="btn song-card-action" style={{ padding: "4px 8px", fontSize: 12 }} onClick={props.onToggleCollapse}>
            {props.collapsed ? "展開" : "收合"}
          </button>
          <button className="btn song-card-action" style={{ padding: "4px 8px", fontSize: 12, color: "#f87171" }} onClick={props.onRemove}>移除</button>
        </div>
      </div>

      {!props.collapsed && <>
        <TrackPlayhead playheadSec={song.playheadSec} durationSec={song.durationSec} onChange={props.onSeek} />

        <div className="row song-transport" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className={`btn${song.status === "playing" ? " primary" : ""}`} onClick={props.onPlayPause}>
            {song.status === "playing" ? "⏸ 暫停" : "▶ 播放"}
          </button>
          <button className="btn" disabled={song.status === "stopped"} onClick={props.onStop}>■ 停止</button>
          <button className={`btn${song.loop ? " primary" : ""}`} onClick={() => props.onChange({ loop: !song.loop })}>
            {song.loop ? "⟳ 循環" : "⟳ 單次"}
          </button>
          <label className="row song-volume" style={{ gap: 6, marginLeft: "auto" }}>
            <span className="small">主音量</span>
            <input type="range" min={0} max={1} step={0.01} value={song.masterVolume} onChange={(event) => props.onChange({ masterVolume: Number(event.target.value) })} />
            <span className="small">{Math.round(song.masterVolume * 100)}%</span>
          </label>
        </div>

        <div className="row song-speed-controls" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">原始 BPM</span>
            <input aria-label="原始 BPM" className="input" type="number" min={20} max={300} value={song.originalBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ originalBpm: Math.max(20, Math.min(300, Number(event.target.value) || 120)) })} />
          </label>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">目標 BPM{song.tempoMode === "target-bpm" ? "（目前使用）" : ""}</span>
            <input aria-label="目標 BPM" className="input" type="number" min={20} max={300} value={song.targetBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ targetBpm: Math.max(20, Math.min(300, Number(event.target.value) || song.originalBpm)), tempoMode: "target-bpm", fineRateOffset: 0 })} />
          </label>
          <label className="grid" style={{ gap: 4 }}>
            <span className="small">升降 Key</span>
            <div className="row" style={{ gap: 4 }}>
              <button aria-label="降低 Key 一個半音" className="btn key-stepper" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.max(-12, song.keyShiftSemitones - 1) })}>−</button>
              <input aria-label="升降 Key 半音數" className="input" type="number" min={-12} max={12} value={song.keyShiftSemitones} style={{ width: 58, textAlign: "center" }} onChange={(event) => props.onChange({ keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(Number(event.target.value)))) })} />
              <button aria-label="提高 Key 一個半音" className="btn key-stepper" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.min(12, song.keyShiftSemitones + 1) })}>+</button>
            </div>
          </label>
          <div className="grid manual-rate-control" style={{ gap: 6, flex: "1 1 240px" }}>
            <span className="small">指定倍率{song.tempoMode === "manual-rate" ? "（目前使用）" : ""}</span>
            <datalist id={`song-rates-${song.id}`}>
              {song.savedRates.map((savedRate) => <option key={savedRate} value={savedRate.toFixed(3)} />)}
            </datalist>
            <div className="row manual-rate-input" style={{ gap: 6, flexWrap: "nowrap" }}>
              <button aria-label={`降低倍率 ${MANUAL_RATE_STEP.toFixed(2)} 倍`} className="btn rate-stepper" onClick={() => setManualRate(song.manualRate - MANUAL_RATE_STEP)}>−</button>
              <input aria-label="指定播放倍率" className="input" type="number" list={`song-rates-${song.id}`} min={MANUAL_RATE_MIN} max={MANUAL_RATE_MAX} step={0.01} value={song.manualRate.toFixed(3)} onChange={(event) => setManualRate(Number(event.target.value) || 1)} />
              <button aria-label={`提高倍率 ${MANUAL_RATE_STEP.toFixed(2)} 倍`} className="btn rate-stepper" onClick={() => setManualRate(song.manualRate + MANUAL_RATE_STEP)}>+</button>
            </div>
            <input aria-label="倍率粗調拉桿" className="manual-rate-slider" type="range" min={MANUAL_RATE_MIN} max={MANUAL_RATE_MAX} step={MANUAL_RATE_STEP} value={song.manualRate} onChange={(event) => setManualRate(Number(event.target.value))} />
            <span className="small" style={{ opacity: 0.65 }}>粗調範圍 {MANUAL_RATE_MIN.toFixed(2)}×–{MANUAL_RATE_MAX.toFixed(2)}× · 每次 {MANUAL_RATE_STEP.toFixed(2)}×</span>
          </div>
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
            {song.savedRates.some((value) => Math.abs(value - rate) < 0.0001) ? "✕ 移除已儲存倍率" : "＋ 儲存目前倍率"}
          </button>
          {song.tempoMode === "manual-rate" && (
            <button className="btn" onClick={() => props.onChange({ tempoMode: "target-bpm", fineRateOffset: 0 })}>
              改用目標 BPM
            </button>
          )}
          <button className="btn" onClick={() => props.onChange({ targetBpm: song.originalBpm, keyShiftSemitones: 0, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0 })}>↺ 原始速度／Key</button>
        </div>

        <div className="grid" style={{ gap: 5 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">倍率微調 ±0.05</span>
            <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{rate.toFixed(3)}× · {song.keyShiftSemitones >= 0 ? "+" : ""}{song.keyShiftSemitones} 半音</strong>
          </div>
          <input type="range" min={-0.05} max={0.05} step={0.001} value={song.fineRateOffset} onChange={(event) => props.onChange({ fineRateOffset: Number(event.target.value) })} />
          <div className="small" style={{ opacity: 0.65 }}>目前由{song.tempoMode === "target-bpm" ? "目標 BPM" : "指定倍率"}控制 · 基準 {coarseRate.toFixed(3)}× ＋ 微調 {song.fineRateOffset >= 0 ? "+" : ""}{song.fineRateOffset.toFixed(3)}</div>
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
          <details className="playback-note">
            <summary>播放同步說明</summary>
            <span className="small">SoundTouch 仍使用舊式 ScriptProcessorNode；同歌分軌共用 AudioContext、歌曲時間軸與單次排程，但目前不宣稱樣本級同步。</span>
          </details>
        </section>
      </>}
    </article>
  );
}
