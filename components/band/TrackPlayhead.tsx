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
        style={{ flex: 1, height: 6, background: "var(--line)", borderRadius: 3, cursor: "pointer", position: "relative", userSelect: "none" }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onChange(secFromPointer(e)); }}
        onPointerMove={(e) => { if (e.buttons === 0) return; onChange(secFromPointer(e)); }}
      >
        <div style={{ width: `${progress * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 3 }} />
        <div style={{
          position: "absolute", top: "50%", left: `${progress * 100}%`,
          transform: "translate(-50%, -50%)",
          width: 12, height: 12, borderRadius: "50%",
          background: "var(--accent)", border: "2px solid white", pointerEvents: "none",
        }} />
      </div>
      <span className="small" style={{ minWidth: 36, opacity: 0.35, fontVariantNumeric: "tabular-nums" }}>
        {fmt(durationSec)}
      </span>
    </div>
  );
}
