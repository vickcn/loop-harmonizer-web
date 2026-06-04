"use client";

import { useState } from "react";
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
  const [inputVal, setInputVal] = useState<string>("");
  const [inputFocused, setInputFocused] = useState(false);

  const isAutoRate = track.syncMode === "global-bpm";
  const fineOffset = track.baseRate - track.coarseRate;
  const isSaved = track.savedRates.some((r) => Math.abs(r - track.coarseRate) < 0.0001);

  const toggleFineTune = () => setShowFineTune((v) => !v);

  // If user touches rate controls in global-bpm mode, switch to manual-rate first
  // Coarse step: update coarseRate (BandMixer resets baseRate = coarseRate)
  const coarseStep = (delta: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) patch.syncMode = "manual-rate";
    patch.coarseRate = Math.max(0.25, Math.min(4, Math.round((track.coarseRate + delta) * 1000) / 1000));
    onChange(patch);
  };

  const handleRateInput = (val: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) patch.syncMode = "manual-rate";
    patch.coarseRate = Math.max(0.25, Math.min(4, val || 1));
    onChange(patch);
  };

  // Fine-tune: only changes baseRate, coarseRate stays fixed
  const handleFineTuneSlider = (val: number) => {
    const patch: Partial<BandTrack> = {};
    if (isAutoRate) patch.syncMode = "manual-rate";
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
          {/* 第一列：− 輸入框(含下拉) + 微調 */}
          <div className="row" style={{ gap: 8, alignItems: "center", width: "100%", flexWrap: "wrap" }}>
            <span className="small" style={{ opacity: isAutoRate ? 0.45 : 1, minWidth: 36 }}>倍率</span>
            <button
              className="btn"
              style={{ padding: "8px 10px", fontWeight: 700 }}
              onClick={() => coarseStep(-0.01)}
              title={isAutoRate ? "點擊切換為手動倍率" : undefined}
            >−</button>
            <datalist id={`rates-${track.id}`}>
              {track.savedRates.map((r) => (
                <option key={r.toFixed(3)} value={r.toFixed(3)} />
              ))}
            </datalist>
            <input
              className="input"
              type="number"
              list={`rates-${track.id}`}
              min={0.25} max={4} step={0.01}
              readOnly={isAutoRate}
              value={inputFocused ? inputVal : track.coarseRate.toFixed(3)}
              style={{
                flex: "1 1 120px",
                minWidth: 0,
                fontWeight: 700,
                fontSize: 15,
                textAlign: "center",
                padding: "6px",
                opacity: isAutoRate ? 0.6 : 1,
                cursor: isAutoRate ? "default" : "text",
              }}
              onFocus={() => { setInputVal(track.coarseRate.toFixed(3)); setInputFocused(true); }}
              onChange={(e) => setInputVal(e.target.value)}
              onBlur={() => {
                setInputFocused(false);
                const v = parseFloat(inputVal);
                if (!isNaN(v)) handleRateInput(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <button
              className="btn"
              style={{ padding: "8px 10px", fontWeight: 700 }}
              onClick={() => coarseStep(0.01)}
              title={isAutoRate ? "點擊切換為手動倍率" : undefined}
            >+</button>
            <button
              className="btn"
              style={{ fontSize: 11, padding: "6px 9px", opacity: showFineTune ? 1 : 0.6 }}
              onClick={toggleFineTune}
            >
              微調
            </button>
            {isAutoRate && (
              <span className="small" style={{ opacity: 0.5, fontStyle: "italic" }}>自動</span>
            )}
          </div>
          {/* 第二列：1x 快捷 + 記憶/刪除 */}
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <button
              className="btn"
              style={{ padding: "5px 14px", fontWeight: 700 }}
              onClick={() => handleRateInput(1)}
            >
              1×
            </button>
            <button
              className={`btn${isSaved ? " primary" : ""}`}
              style={{ padding: "5px 12px", fontSize: 12 }}
              onClick={() => {
                const r = Math.round(track.coarseRate * 1000) / 1000;
                if (isSaved) {
                  // 1.0 至少保留一個
                  if (track.savedRates.length <= 1) return;
                  onChange({ savedRates: track.savedRates.filter((x) => Math.abs(x - r) > 0.0001) });
                } else {
                  const next = [...track.savedRates, r].sort((a, b) => a - b);
                  onChange({ savedRates: next });
                }
              }}
            >
              {isSaved ? "✕ 刪除此倍率" : "＋ 記憶此倍率"}
            </button>
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
            min={track.coarseRate - 0.03}
            max={track.coarseRate + 0.03}
            step={0.001}
            value={track.baseRate}
            style={{ width: "100%" }}
            onChange={(e) => handleFineTuneSlider(Number(e.target.value))}
          />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small" style={{ opacity: 0.5 }}>−0.03</span>
            <span className="small" style={{ opacity: 0.8, color: "var(--accent)" }}>
              {fineOffset >= 0 ? "+" : ""}{fineOffset.toFixed(3)}
            </span>
            <span className="small" style={{ opacity: 0.5 }}>+0.03</span>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}
