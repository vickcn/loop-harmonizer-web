"use client";

import { memo, useRef, useState } from "react";

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
  const activePointerIdRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const progress = durationSec > 0 ? Math.min(1, playheadSec / durationSec) : 0;

  const secFromPointer = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar || durationSec <= 0) return 0;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durationSec;
  };

  const clearDragState = (pointerId: number, target?: HTMLDivElement | null) => {
    if (activePointerIdRef.current !== pointerId) return;
    activePointerIdRef.current = null;
    setDragging(false);
    if (target && typeof target.hasPointerCapture === "function" && target.hasPointerCapture(pointerId)) {
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // ignore release failure on detached targets
      }
    }
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
    <div className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
      <span className="small" style={{ minWidth: 36, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
        {fmt(playheadSec)}
      </span>
      <div
        ref={barRef}
        className={`track-playhead-slider${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        aria-label="歌曲播放進度，點選、拖曳或按方向鍵以跳轉"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(playheadSec)}
        aria-valuetext={`${fmt(playheadSec)} / ${fmt(durationSec)}`}
        style={{ flex: 1, minWidth: 0, minHeight: 44, position: "relative", userSelect: "none", display: "flex", alignItems: "center", touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) return;
          activePointerIdRef.current = e.pointerId;
          setDragging(true);
          onSelect?.();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // ignore synthetic/unsupported pointer capture
          }
          onChange(secFromPointer(e));
        }}
        onPointerMove={(e) => {
          if (activePointerIdRef.current === null || activePointerIdRef.current !== e.pointerId) return;
          if (e.pointerType === "mouse" && e.buttons === 0) {
            clearDragState(e.pointerId, e.currentTarget);
            return;
          }
          onChange(secFromPointer(e));
        }}
        onPointerUp={(e) => clearDragState(e.pointerId, e.currentTarget)}
        onPointerCancel={(e) => clearDragState(e.pointerId, e.currentTarget)}
        onLostPointerCapture={(e) => clearDragState(e.pointerId)}
        onFocus={() => onSelect?.()}
        onKeyDown={handleKeyDown}
      >
        <div style={{ width: "100%", height: 6, background: "var(--line)", borderRadius: 3, position: "relative" }}>
          <div style={{ width: `${progress * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 3 }} />
          <div className="track-playhead-thumb" style={{
            position: "absolute", top: "50%", left: `${progress * 100}%`,
            transform: "translate(-50%, -50%)",
            width: 14, height: 14, borderRadius: "50%",
            background: "var(--accent)", border: "2px solid white", pointerEvents: "none",
          }} />
        </div>
      </div>
      <span className="small" style={{ minWidth: 36, textAlign: "right", opacity: 0.35, fontVariantNumeric: "tabular-nums" }}>
        {fmt(durationSec)}
      </span>
    </div>
  );
});
