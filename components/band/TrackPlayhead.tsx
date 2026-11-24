"use client";

import { memo, useRef, useState } from "react";

const MIN_LOOP_RANGE_SECONDS = 0.25;
const WAVEFORM_PLACEHOLDER_PEAKS = Array.from({ length: 96 }, (_, index) => {
  const broadShape = 0.42 + Math.sin(index * 0.23) * 0.16 + Math.sin(index * 0.071 + 1.4) * 0.18;
  const detail = Math.abs(Math.sin(index * 1.73)) * 0.2;
  return Math.max(0.16, Math.min(0.88, broadShape + detail));
});

type LoopPreview = { startSec: number; endSec: number };
type DragMode = "playhead" | "loop-start" | "loop-end";
type ActiveDrag = { pointerId: number; mode: DragMode };

export const WaveformBars = memo(function WaveformBars({ peaks }: { peaks: readonly number[] }) {
  return <div className="track-waveform-bars" aria-hidden="true">
    {peaks.map((peak, index) => <span key={index} className="track-waveform-bar" style={{ height: `${Math.max(8, Math.min(100, peak * 100))}%` }} />)}
  </div>;
});

type Props = {
  playheadSec: number;
  durationSec: number;
  loopStartSec?: number;
  loopEndSec?: number | null;
  loopEnabled?: boolean;
  waveformPeaks?: readonly number[];
  onChange: (sec: number) => void;
  onSetLoopStart?: (sec: number) => void;
  onSetLoopEnd?: (sec: number) => void;
  onClearLoopRange?: () => void;
  onSelect?: () => void;
  disabled?: boolean;
};

function fmt(sec: number) {
  const safeSec = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(safeSec / 60);
  const s = Math.floor(safeSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const TrackPlayhead = memo(function TrackPlayhead({
  playheadSec,
  durationSec,
  loopStartSec = 0,
  loopEndSec = null,
  loopEnabled = false,
  waveformPeaks = [],
  onChange,
  onSetLoopStart,
  onSetLoopEnd,
  onSelect,
  disabled = false,
}: Props) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const previewRef = useRef<LoopPreview | null>(null);
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  const [loopPreview, setLoopPreview] = useState<LoopPreview | null>(null);

  const safeDuration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  const persistedStart = Math.max(0, Math.min(safeDuration, loopStartSec));
  const persistedEnd = Number.isFinite(loopEndSec)
    ? Math.max(persistedStart, Math.min(safeDuration, loopEndSec!))
    : safeDuration;
  const displayStart = loopPreview?.startSec ?? persistedStart;
  const displayEnd = loopPreview?.endSec ?? persistedEnd;
  const canConfigureLoop = Boolean(onSetLoopStart && onSetLoopEnd);
  const displayedPeaks = waveformPeaks.length > 0 ? waveformPeaks : WAVEFORM_PLACEHOLDER_PEAKS;
  const progressPct = safeDuration > 0 ? Math.max(0, Math.min(100, (playheadSec / safeDuration) * 100)) : 0;
  const loopStartPct = safeDuration > 0 ? (displayStart / safeDuration) * 100 : 0;
  const loopEndPct = safeDuration > 0 ? (displayEnd / safeDuration) * 100 : 100;

  const secFromClientX = (clientX: number) => {
    const waveform = waveformRef.current;
    if (!waveform || safeDuration <= 0) return 0;
    const rect = waveform.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * safeDuration;
  };

  const updatePreview = (next: LoopPreview) => {
    previewRef.current = next;
    setLoopPreview(next);
  };

  const beginDrag = (event: React.PointerEvent<HTMLElement>, mode: DragMode) => {
    if (disabled || safeDuration <= 0 || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.stopPropagation();
    activeDragRef.current = { pointerId: event.pointerId, mode };
    setDragMode(mode);
    onSelect?.();
    if (mode !== "playhead") updatePreview({ startSec: displayStart, endSec: displayEnd });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and older browsers may not support pointer capture.
    }
    if (mode === "playhead") onChange(secFromClientX(event.clientX));
  };

  const continueDrag = (event: React.PointerEvent<HTMLElement>) => {
    const active = activeDragRef.current;
    if (!active || active.pointerId !== event.pointerId || disabled) return;
    if (event.pointerType === "mouse" && event.buttons === 0) return;
    const seconds = secFromClientX(event.clientX);
    if (active.mode === "playhead") {
      onChange(seconds);
      return;
    }
    const current = previewRef.current ?? { startSec: persistedStart, endSec: persistedEnd };
    if (active.mode === "loop-start") {
      updatePreview({ ...current, startSec: Math.max(0, Math.min(seconds, current.endSec - MIN_LOOP_RANGE_SECONDS)) });
    } else {
      updatePreview({ ...current, endSec: Math.min(safeDuration, Math.max(seconds, current.startSec + MIN_LOOP_RANGE_SECONDS)) });
    }
  };

  const finishDrag = (event: React.PointerEvent<HTMLElement>) => {
    const active = activeDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.mode === "loop-start" && previewRef.current) onSetLoopStart?.(previewRef.current.startSec);
    if (active.mode === "loop-end" && previewRef.current) onSetLoopEnd?.(previewRef.current.endSec);
    activeDragRef.current = null;
    previewRef.current = null;
    setLoopPreview(null);
    setDragMode(null);
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Target may already be detached.
      }
    }
  };

  const handlePlayheadKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (safeDuration <= 0 || disabled) return;
    const step = event.shiftKey ? 15 : 5;
    let nextSec: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextSec = Math.max(0, playheadSec - step);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextSec = Math.min(safeDuration, playheadSec + step);
    if (event.key === "Home") nextSec = 0;
    if (event.key === "End") nextSec = safeDuration;
    if (nextSec === null) return;
    event.preventDefault();
    onSelect?.();
    onChange(nextSec);
  };

  const handleBoundaryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, boundary: "start" | "end") => {
    if (safeDuration <= 0 || disabled) return;
    const step = event.shiftKey ? 5 : 1;
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (boundary === "start") {
      onSetLoopStart?.(Math.max(0, Math.min(persistedEnd - MIN_LOOP_RANGE_SECONDS, persistedStart + direction * step)));
    } else {
      onSetLoopEnd?.(Math.min(safeDuration, Math.max(persistedStart + MIN_LOOP_RANGE_SECONDS, persistedEnd + direction * step)));
    }
  };

  return (
    <div className={`track-playhead${loopEnabled ? " is-loop-enabled" : ""}`}>
      <div className="track-playhead-time-row" aria-live="off">
        <span>{fmt(playheadSec)}</span><span aria-hidden="true">/</span><span>{fmt(safeDuration)}</span>
        {canConfigureLoop && <span className="track-loop-time-summary">A {fmt(displayStart)} · B {fmt(displayEnd)}</span>}
      </div>

      <div
        ref={waveformRef}
        className={`track-waveform${dragMode ? ` is-dragging-${dragMode}` : ""}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="歌曲波形與播放進度"
        aria-description={canConfigureLoop ? `循環區段 A ${fmt(displayStart)} 到 B ${fmt(displayEnd)}` : undefined}
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={Math.round(safeDuration)}
        aria-valuenow={Math.round(playheadSec)}
        aria-valuetext={`${fmt(playheadSec)} / ${fmt(safeDuration)}`}
        onPointerDown={(event) => beginDrag(event, "playhead")}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onFocus={() => onSelect?.()}
        onKeyDown={handlePlayheadKeyDown}
      >
        <WaveformBars peaks={displayedPeaks} />

        {canConfigureLoop && <>
          <div className="track-loop-selection" style={{ left: `${loopStartPct}%`, right: `${100 - loopEndPct}%` }} aria-hidden="true" />
          <div className="track-loop-dim is-before" style={{ width: `${loopStartPct}%` }} aria-hidden="true" />
          <div className="track-loop-dim is-after" style={{ width: `${100 - loopEndPct}%` }} aria-hidden="true" />
        </>}

        <div className="track-waveform-progress" style={{ width: `${progressPct}%` }} aria-hidden="true" />
        <div className="track-playhead-line" style={{ left: `${progressPct}%` }} aria-hidden="true"><span /></div>

        {canConfigureLoop && <>
          <div
            className="track-loop-handle is-start"
            style={{ left: `${loopStartPct}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="循環起點 A"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(displayEnd - MIN_LOOP_RANGE_SECONDS))}
            aria-valuenow={Math.round(displayStart)}
            aria-valuetext={fmt(displayStart)}
            onPointerDown={(event) => beginDrag(event, "loop-start")}
            onPointerMove={continueDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={finishDrag}
            onKeyDown={(event) => handleBoundaryKeyDown(event, "start")}
          ><span className="track-loop-handle-label">A</span><span className="track-loop-handle-grip" aria-hidden="true" /></div>
          <div
            className="track-loop-handle is-end"
            style={{ left: `${loopEndPct}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="循環終點 B"
            aria-valuemin={Math.round(displayStart + MIN_LOOP_RANGE_SECONDS)}
            aria-valuemax={Math.round(safeDuration)}
            aria-valuenow={Math.round(displayEnd)}
            aria-valuetext={fmt(displayEnd)}
            onPointerDown={(event) => beginDrag(event, "loop-end")}
            onPointerMove={continueDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={finishDrag}
            onKeyDown={(event) => handleBoundaryKeyDown(event, "end")}
          ><span className="track-loop-handle-label">B</span><span className="track-loop-handle-grip" aria-hidden="true" /></div>
        </>}
      </div>
    </div>
  );
});
