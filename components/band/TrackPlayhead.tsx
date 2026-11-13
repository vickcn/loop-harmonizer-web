"use client";

import { memo, useRef } from "react";

type Props = {
  playheadSec: number;
  durationSec: number;
  onChange: (sec: number) => void;
  onSelect?: () => void;
};

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const TrackPlayhead = memo(function TrackPlayhead({ playheadSec, durationSec, onChange, onSelect }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const progress = durationSec > 0 ? Math.min(1, playheadSec / durationSec) : 0;

  const secFromPointer = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durationSec;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return;
    const step = e.shiftKey ? 15 : 5;
    let nextSec: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      nextSec = Math.max(0, playheadSec - step);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      nextSec = Math.min(durationSec, playheadSec + step);
    } else if (e.key === "Home") {
      nextSec = 0;
    } else if (e.key === "End") {
      nextSec = durationSec;
    }
    if (nextSec !== null) {
      e.preventDefault();
      onSelect?.();
      onChange(nextSec);
    }
  };

  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="small" style={{ minWidth: 36, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
        {fmt(playheadSec)}
      </span>
      <div
        ref={barRef}
        className="track-playhead-slider"
        tabIndex={0}
        aria-label="歌曲播放進度，點選、拖曳或按方向鍵以跳轉"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(playheadSec)}
        aria-valuetext={`${fmt(playheadSec)} / ${fmt(durationSec)}`}
        style={{ flex: 1, minHeight: 44, cursor: "pointer", position: "relative", userSelect: "none", display: "flex", alignItems: "center", touchAction: "none" }}
        onPointerDown={(e) => { onSelect?.(); e.currentTarget.setPointerCapture(e.pointerId); onChange(secFromPointer(e)); }}
        onPointerMove={(e) => { if (e.buttons === 0) return; onChange(secFromPointer(e)); }}
        onFocus={() => onSelect?.()}
        onKeyDown={handleKeyDown}
      >
        <div style={{ width: "100%", height: 6, background: "var(--line)", borderRadius: 3, position: "relative" }}>
          <div style={{ width: `${progress * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 3 }} />
          <div style={{
            position: "absolute", top: "50%", left: `${progress * 100}%`,
            transform: "translate(-50%, -50%)",
            width: 14, height: 14, borderRadius: "50%",
            background: "var(--accent)", border: "2px solid white", pointerEvents: "none",
          }} />
        </div>
      </div>
      <span className="small" style={{ minWidth: 36, opacity: 0.35, fontVariantNumeric: "tabular-nums" }}>
        {fmt(durationSec)}
      </span>
    </div>
  );
});
