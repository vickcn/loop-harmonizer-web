"use client";

import { useRef } from "react";

type Props = {
  playheadSec: number;
  durationSec: number;
  onChange: (sec: number) => void;
};

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TrackPlayhead({ playheadSec, durationSec, onChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const progress = durationSec > 0 ? Math.min(1, playheadSec / durationSec) : 0;

  const secFromPointer = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durationSec;
  };

  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="small" style={{ minWidth: 36, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
        {fmt(playheadSec)}
      </span>
      <div
        ref={barRef}
        aria-label="歌曲播放進度，點選或拖曳以跳轉"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(playheadSec)}
        style={{ flex: 1, minHeight: 44, cursor: "pointer", position: "relative", userSelect: "none", display: "flex", alignItems: "center", touchAction: "none" }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onChange(secFromPointer(e)); }}
        onPointerMove={(e) => { if (e.buttons === 0) return; onChange(secFromPointer(e)); }}
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
}
