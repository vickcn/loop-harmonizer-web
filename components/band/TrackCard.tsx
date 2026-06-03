"use client";

import { useRef, useState } from "react";
import { BandTrack, TrackPlaybackMode, TrackSyncMode } from "@/lib/band/bandTypes";
import { TrackPlayhead } from "./TrackPlayhead";

type Props = {
  track: BandTrack;
  onChange: (patch: Partial<BandTrack>) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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

export function TrackCard({ track, onChange, collapsed = false, onToggleCollapse }: Props) {
  const [showFineTune, setShowFineTune] = useState(true);
  const fineTuneBaseRef = useRef(track.baseRate);

  const isAutoRate = track.syncMode === "global-bpm";

  const toggleFineTune = () => {
    if (!showFineTune) fineTuneBaseRef.current = track.baseRate;
    setShowFineTune((v) => !v);
  };

  // If user touches rate controls in global-bpm mode, switch to manual-rate first
  const coarseStep = (delta: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) patch.syncMode = "manual-rate";
    patch.baseRate = Math.max(0.25, Math.min(4, Math.round((track.baseRate + delta) * 1000) / 1000));
    onChange(patch);
  };

  const handleRateInput = (val: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) patch.syncMode = "manual-rate";
    patch.baseRate = Math.max(0.25, Math.min(4, val || 1));
    onChange(patch);
  };

  const handleFineTuneSlider = (val: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) { patch.syncMode = "manual-rate"; fineTuneBaseRef.current = track.baseRate; }
    patch.baseRate = Math.max(0.25, Math.min(4, val));
    onChange(patch);
  };

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
      {/* ── 標頭（點擊折疊）── */}
      <div
        className="row"
        style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, cursor: "pointer", userSelect: "none" }}
        onClick={onToggleCollapse}
      >
        <div className="row" style={{ gap: 10 }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={track.selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{track.name}</div>
            {!collapsed && <div className="small" style={{ opacity: 0.45 }}>{track.fileName}</div>}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="small" style={{ color: STATUS_COLOR[track.status] }}>
            ● {STATUS_LABEL[track.status]}
          </span>
          <span style={{ opacity: 0.4, fontSize: 12 }}>{collapsed ? "▶" : "▼"}</span>
        </div>
      </div>

      {/* ── 可折疊內容 ── */}
      {!collapsed && <TrackPlayhead
        playheadSec={track.playheadSec}
        durationSec={track.durationSec}
        onChange={(sec) => onChange({ playheadSec: sec })}
      />}

      {!collapsed && <>{/* ── 播放控制 ── */}
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

        {/* 倍率粗調：獨立全寬一列 */}
        <div className="grid" style={{ gap: 6, width: "100%" }}>
          <div className="row" style={{ gap: 8, alignItems: "center", width: "100%", flexWrap: "wrap" }}>
            <span className="small" style={{ opacity: isAutoRate ? 0.45 : 1, minWidth: 36 }}>倍率</span>
            <button
              className="btn"
              style={{ padding: "3px 8px", fontWeight: 700 }}
              onClick={() => coarseStep(-0.01)}
              title={isAutoRate ? "點擊切換為手動倍率" : undefined}
            >−</button>
            <input
              className="input"
              type="number"
              min={0.25} max={4} step={0.01}
              value={track.baseRate}
              readOnly={isAutoRate}
              style={{
                flex: "1 1 160px",
                minWidth: 0,
                fontWeight: 700,
                fontSize: 16,
                textAlign: "center",
                padding: "4px 6px",
                opacity: isAutoRate ? 0.6 : 1,
                cursor: isAutoRate ? "default" : "text",
              }}
              onChange={(e) => handleRateInput(Number(e.target.value))}
            />
            <button
              className="btn"
              style={{ padding: "3px 8px", fontWeight: 700 }}
              onClick={() => coarseStep(0.01)}
              title={isAutoRate ? "點擊切換為手動倍率" : undefined}
            >+</button>
            <button
              className="btn"
              style={{ padding: "3px 10px", fontWeight: 700, marginLeft: "auto" }}
              onClick={() => handleRateInput(1)}
              title="恢復 1x"
            >
              1x
            </button>
            <button
              className="btn"
              style={{ fontSize: 11, padding: "3px 7px", opacity: showFineTune ? 1 : 0.6 }}
              onClick={toggleFineTune}
            >
              微調
            </button>
            {isAutoRate && (
              <span className="small" style={{ opacity: 0.5, fontStyle: "italic" }}>自動</span>
            )}
          </div>
        </div>

        {/* 播放模式 — M2C: pitch-preserve 已接 AudioWorklet WSOLA */}
        <label className="row" style={{ gap: 4 }}>
          <span className="small">播放模式</span>
          <select
            className="input"
            value={track.playbackMode}
            style={{ fontSize: 12 }}
            onChange={(e) => onChange({ playbackMode: e.target.value as TrackPlaybackMode })}
          >
            <option value="fast-rate">快速變速</option>
            <option value="pitch-preserve">保音高（實驗）</option>
          </select>
        </label>

        <button
          className={`btn${track.loop ? " primary" : ""}`}
          style={{ fontSize: 12, padding: "4px 10px", width: "100%" }}
          onClick={() => onChange({ loop: !track.loop })}
        >
          {track.loop ? "⟳ 循環" : "⟳ 單次"}
        </button>
        {track.playbackMode === "pitch-preserve" && (
          <span className="small" style={{ color: "#f59e0b", opacity: 0.9 }}>
            ⚠ 實驗功能：保音高變速（WSOLA），倍率限 0.5–1.8×；多軌不保證同步
          </span>
        )}

        <label className="row" style={{ gap: 4 }}>
          <span className="small">同步</span>
          <select
            className="input"
            value={track.syncMode}
            style={{ fontSize: 12 }}
            onChange={(e) => onChange({ syncMode: e.target.value as TrackSyncMode })}
          >
            <option value="manual-rate">手動倍率</option>
            <option value="global-bpm">跟隨 BPM</option>
            <option value="free">自由</option>
          </select>
        </label>
      </div>

      {/* ── 微調滑桿（獨立全寬列）── */}
      {showFineTune && (
        <div className="grid" style={{ gap: 4 }}>
          <input
            type="range"
            min={fineTuneBaseRef.current - 0.03}
            max={fineTuneBaseRef.current + 0.03}
            step={0.001}
            value={track.baseRate}
            style={{ width: "100%" }}
            onChange={(e) => handleFineTuneSlider(Number(e.target.value))}
          />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small" style={{ opacity: 0.5 }}>−0.03</span>
            <span className="small" style={{ opacity: 0.8, color: "var(--accent)" }}>
              {track.baseRate >= fineTuneBaseRef.current ? "+" : ""}
              {(track.baseRate - fineTuneBaseRef.current).toFixed(3)}
            </span>
            <span className="small" style={{ opacity: 0.5 }}>+0.03</span>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}
