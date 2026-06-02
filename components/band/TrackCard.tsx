"use client";

import { BandTrack, TrackSyncMode } from "@/lib/band/bandTypes";
import { TrackPlayhead } from "./TrackPlayhead";

type Props = {
  track: BandTrack;
  onChange: (patch: Partial<BandTrack>) => void;
};

const STATUS_COLOR: Record<string, string> = {
  stopped: "var(--muted)",
  playing: "#22c55e",
  paused: "#f59e0b",
};

const STATUS_LABEL: Record<string, string> = {
  stopped: "停止",
  playing: "播放中",
  paused: "暫停",
};

export function TrackCard({ track, onChange }: Props) {
  const togglePlay = () =>
    onChange({ status: track.status === "playing" ? "paused" : "playing" });

  const stop = () => onChange({ status: "stopped", playheadSec: 0 });

  return (
    <div
      className="card grid"
      style={{
        gap: 12,
        border: track.selected ? "1.5px solid var(--accent)" : undefined,
        opacity: track.muted ? 0.55 : 1,
        transition: "border-color .15s, opacity .15s",
      }}
    >
      {/* ── 標頭 ── */}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <label className="row" style={{ gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={track.selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{track.name}</div>
            <div className="small" style={{ opacity: 0.45 }}>{track.fileName}</div>
          </div>
        </label>
        <span className="small" style={{ color: STATUS_COLOR[track.status] }}>
          ● {STATUS_LABEL[track.status]}
        </span>
      </div>

      {/* ── 播放線 ── */}
      <TrackPlayhead
        playheadSec={track.playheadSec}
        durationSec={track.durationSec}
        onChange={(sec) => onChange({ playheadSec: sec })}
      />

      {/* ── 播放控制 ── */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button
          className={`btn${track.status === "playing" ? " primary" : ""}`}
          style={{ minWidth: 80 }}
          onClick={togglePlay}
        >
          {track.status === "playing" ? "⏸ 暫停" : "▶ 播放"}
        </button>
        <button className="btn" onClick={stop} disabled={track.status === "stopped"}>
          ■ 停止
        </button>

        <label className="row" style={{ gap: 4 }}>
          <span className="small">原始 BPM</span>
          <input
            className="input"
            type="number"
            min={20} max={300} step={1}
            value={track.originalBpm}
            style={{ width: 64 }}
            onChange={(e) => onChange({ originalBpm: Math.max(20, Math.min(300, Number(e.target.value) || 120)) })}
          />
        </label>

        <label className="row" style={{ gap: 4 }}>
          <span className="small">倍率</span>
          <input
            className="input"
            type="number"
            min={0.25} max={4} step={0.01}
            value={track.baseRate}
            style={{ width: 60 }}
            onChange={(e) => onChange({ baseRate: Math.max(0.25, Math.min(4, Number(e.target.value) || 1)) })}
          />
        </label>

        <label className="row" style={{ gap: 4 }}>
          <span className="small">音量</span>
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={track.volume}
            style={{ width: 72 }}
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
          />
          <span className="small" style={{ minWidth: 32 }}>{Math.round(track.volume * 100)}%</span>
        </label>

        <label className="row" style={{ gap: 4, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={track.muted}
            onChange={(e) => onChange({ muted: e.target.checked })}
          />
          <span className="small">靜音</span>
        </label>

        <label className="row" style={{ gap: 4 }}>
          <span className="small">同步</span>
          <select
            className="input"
            value={track.syncMode}
            style={{ fontSize: 12 }}
            onChange={(e) => onChange({ syncMode: e.target.value as TrackSyncMode })}
          >
            <option value="free">自由</option>
            <option value="global-bpm">全域 BPM</option>
            <option value="manual-rate">手動倍率</option>
          </select>
        </label>
      </div>
    </div>
  );
}
