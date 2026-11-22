"use client";

import { useEffect, useRef, useState } from "react";
import {
  TOUCH_SLIDER_LONG_PRESS_MS,
  computeAbsoluteSliderValue,
  computeKeyboardSliderValue,
  computeRelativeSliderValue,
  shouldCancelSliderLongPress,
} from "@/lib/band/touchGuardedSlider";

type Props = {
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText?: string;
  disabled?: boolean;
  className?: string;
  longPressMs?: number;
  onChange: (value: number) => void;
};

function findTouchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const item = list.item(i);
    if (item && item.identifier === id) return item;
  }
  return null;
}

export function TouchGuardedRangeSlider({
  ariaLabel,
  min,
  max,
  step,
  value,
  valueText,
  disabled = false,
  className = "",
  longPressMs = TOUCH_SLIDER_LONG_PRESS_MS,
  onChange,
}: Props) {
  const [touchPhase, setTouchPhase] = useState<"idle" | "holding" | "unlocked">("idle");
  const [mouseDragging, setMouseDragging] = useState(false);
  const [tapHintVisible, setTapHintVisible] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ min, max, step, value, disabled, onChange });
  propsRef.current = { min, max, step, value, disabled, onChange };

  const mousePointerIdRef = useRef<number | null>(null);
  const activeTouchIdRef = useRef<number | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchCurrentXRef = useRef<number>(0);
  const touchUnlockedRef = useRef(false);
  const unlockAnchorRef = useRef<{ x: number; value: number } | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const clearHintTimer = () => {
    if (hintTimerRef.current !== null) {
      window.clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  const resetTouchTracking = () => {
    clearPressTimer();
    activeTouchIdRef.current = null;
    touchStartRef.current = null;
    touchUnlockedRef.current = false;
    unlockAnchorRef.current = null;
    setTouchPhase("idle");
  };

  useEffect(() => {
    if (!disabled) return;
    clearPressTimer();
    activeTouchIdRef.current = null;
    touchStartRef.current = null;
    touchUnlockedRef.current = false;
    unlockAnchorRef.current = null;
    mousePointerIdRef.current = null;
    setTouchPhase("idle");
    setMouseDragging(false);
  }, [disabled]);

  useEffect(() => () => {
    clearPressTimer();
    clearHintTimer();
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    const handleTouchStart = (event: TouchEvent) => {
      if (propsRef.current.disabled || event.touches.length !== 1) {
        clearPressTimer();
        activeTouchIdRef.current = null;
        touchStartRef.current = null;
        touchUnlockedRef.current = false;
        unlockAnchorRef.current = null;
        setTouchPhase("idle");
        return;
      }

      const touch = event.touches[0];
      clearPressTimer();
      activeTouchIdRef.current = touch.identifier;
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      touchCurrentXRef.current = touch.clientX;
      touchUnlockedRef.current = false;
      unlockAnchorRef.current = null;
      setTouchPhase("holding");

      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        if (propsRef.current.disabled || activeTouchIdRef.current !== touch.identifier) return;
        touchUnlockedRef.current = true;
        unlockAnchorRef.current = {
          x: touchCurrentXRef.current,
          value: propsRef.current.value,
        };
        setTouchPhase("unlocked");
        clearHintTimer();
        setTapHintVisible(false);
        try {
          if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            navigator.vibrate(15);
          }
        } catch {
          // ignore vibrate restrictions
        }
      }, longPressMs);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const activeId = activeTouchIdRef.current;
      if (activeId === null) return;

      if (propsRef.current.disabled || event.touches.length !== 1) {
        clearPressTimer();
        activeTouchIdRef.current = null;
        touchStartRef.current = null;
        touchUnlockedRef.current = false;
        unlockAnchorRef.current = null;
        setTouchPhase("idle");
        return;
      }

      const touch = findTouchById(event.touches, activeId);
      if (!touch) return;

      touchCurrentXRef.current = touch.clientX;

      if (!touchUnlockedRef.current) {
        const start = touchStartRef.current;
        if (!start) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (shouldCancelSliderLongPress(dx, dy)) {
          // 手指滑動超過門檻代表捲動頁面，立刻放行原生捲動
          clearPressTimer();
          activeTouchIdRef.current = null;
          touchStartRef.current = null;
          touchUnlockedRef.current = false;
          unlockAnchorRef.current = null;
          setTouchPhase("idle");
        }
        return;
      }

      event.preventDefault();
      const anchor = unlockAnchorRef.current;
      if (!anchor) return;
      const rect = el.getBoundingClientRect();
      const { min: cMin, max: cMax, step: cStep, value: cVal, onChange: cOnChange } = propsRef.current;
      const nextValue = computeRelativeSliderValue(
        anchor.value,
        touch.clientX - anchor.x,
        rect.width,
        cMin,
        cMax,
        cStep,
      );
      if (nextValue !== cVal) {
        cOnChange(nextValue);
      }
    };

    const handleTouchEndOrCancel = (event: TouchEvent) => {
      const activeId = activeTouchIdRef.current;
      if (activeId === null) return;
      const ended = findTouchById(event.changedTouches, activeId);
      if (!ended) return;

      const wasUnlocked = touchUnlockedRef.current;
      const start = touchStartRef.current;
      const movedBeyond =
        start !== null &&
        shouldCancelSliderLongPress(ended.clientX - start.x, ended.clientY - start.y);

      clearPressTimer();
      activeTouchIdRef.current = null;
      touchStartRef.current = null;
      touchUnlockedRef.current = false;
      unlockAnchorRef.current = null;
      setTouchPhase("idle");

      if (event.type === "touchend" && !wasUnlocked && !movedBeyond && !propsRef.current.disabled) {
        setTapHintVisible(true);
        clearHintTimer();
        hintTimerRef.current = window.setTimeout(() => {
          hintTimerRef.current = null;
          setTapHintVisible(false);
        }, 2200);
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEndOrCancel);
    el.addEventListener("touchcancel", handleTouchEndOrCancel);

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEndOrCancel);
      el.removeEventListener("touchcancel", handleTouchEndOrCancel);
    };
  }, [longPressMs]);

  const clearMouseDrag = (pointerId: number, target?: HTMLDivElement | null) => {
    if (mousePointerIdRef.current !== pointerId) return;
    mousePointerIdRef.current = null;
    setMouseDragging(false);
    if (target && typeof target.hasPointerCapture === "function" && target.hasPointerCapture(pointerId)) {
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // ignore detached target
      }
    }
  };

  const applyMousePointerX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nextValue = computeAbsoluteSliderValue(clientX, rect.left, rect.width, min, max, step);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  const span = max - min;
  const clampedValue = Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const progressPct = span > 0 ? ((clampedValue - min) / span) * 100 : 0;
  const showHint = !disabled && (touchPhase === "unlocked" || tapHintVisible);

  return (
    <div className={`touch-guarded-slider-wrap${className ? ` ${className}` : ""}`}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clampedValue}
        aria-valuetext={valueText}
        aria-disabled={disabled || undefined}
        className={`touch-guarded-slider${touchPhase === "holding" ? " is-holding" : ""}${touchPhase === "unlocked" ? " is-unlocked" : ""}${mouseDragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (disabled || event.pointerType === "touch") return;
          if (event.pointerType === "mouse" && event.button !== 0) return;
          if (mousePointerIdRef.current !== null && mousePointerIdRef.current !== event.pointerId) return;
          resetTouchTracking();
          mousePointerIdRef.current = event.pointerId;
          setMouseDragging(true);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // ignore unsupported pointer capture
          }
          applyMousePointerX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          if (mousePointerIdRef.current === null || mousePointerIdRef.current !== event.pointerId) return;
          if (event.pointerType === "mouse" && event.buttons === 0) {
            clearMouseDrag(event.pointerId, event.currentTarget);
            return;
          }
          applyMousePointerX(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") return;
          clearMouseDrag(event.pointerId, event.currentTarget);
        }}
        onPointerCancel={(event) => {
          if (event.pointerType === "touch") return;
          clearMouseDrag(event.pointerId, event.currentTarget);
        }}
        onLostPointerCapture={(event) => clearMouseDrag(event.pointerId)}
        onKeyDown={(event) => {
          if (disabled) return;
          const nextValue = computeKeyboardSliderValue(clampedValue, event.key, event.shiftKey, min, max, step);
          if (nextValue === null) return;
          event.preventDefault();
          if (nextValue !== value) {
            onChange(nextValue);
          }
        }}
      >
        <div className="touch-guarded-slider-track">
          <div className="touch-guarded-slider-fill" style={{ width: `${progressPct}%` }} />
          <div className="touch-guarded-slider-thumb" style={{ left: `${progressPct}%` }} />
        </div>
      </div>

      {showHint && (
        <span
          role="status"
          aria-live="polite"
          className={`touch-guarded-slider-hint${touchPhase === "unlocked" ? " is-unlocked" : ""}`}
        >
          {touchPhase === "unlocked"
            ? "已解鎖，左右滑動調整速度"
            : "長按拉桿再左右滑動以調整速度"}
        </span>
      )}
    </div>
  );
}
