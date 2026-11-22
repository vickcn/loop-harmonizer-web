"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CONDENSED_STATUS_THRESHOLD,
  shouldCondenseStatusIndicators,
  type StatusIndicatorItem,
} from "@/lib/band/songStatusIndicators";

type Props = {
  items: readonly StatusIndicatorItem[];
  condensedThreshold?: number;
};

export function SongStatusIndicators({
  items,
  condensedThreshold = CONDENSED_STATUS_THRESHOLD,
}: Props) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [resolvedPlacement, setResolvedPlacement] = useState<"top" | "bottom">("top");
  const [resolvedAlign, setResolvedAlign] = useState<"left" | "center" | "right">("center");

  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const condensed = items.length > 0 && shouldCondenseStatusIndicators(items.length, condensedThreshold);
  const isOpen = condensed && (hoverOpen || focusOpen || touchOpen);

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!condensed) {
      clearPressTimer();
      clearHideTimer();
      setHoverOpen(false);
      setFocusOpen(false);
      setTouchOpen(false);
      setHoveredKey(null);
    }
  }, [condensed]);

  useEffect(() => () => {
    clearPressTimer();
    clearHideTimer();
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;

    const rect = wrapEl.getBoundingClientRect();
    const tipWidth = tooltipRef.current?.offsetWidth || 260;
    const tipHeight = tooltipRef.current?.offsetHeight || 140;
    const margin = 12;

    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const nextPlacement =
      spaceAbove < tipHeight + margin && spaceBelow > spaceAbove ? "bottom" : "top";

    const centerX = rect.left + rect.width / 2;
    const halfW = tipWidth / 2;
    let nextAlign: "left" | "center" | "right" = "center";
    if (centerX - halfW < margin) {
      nextAlign = "left";
    } else if (centerX + halfW > window.innerWidth - margin) {
      nextAlign = "right";
    }

    setResolvedPlacement(nextPlacement);
    setResolvedAlign(nextAlign);
  }, [isOpen, items.length]);

  useEffect(() => {
    if (!touchOpen && !focusOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        clearHideTimer();
        setTouchOpen(false);
        setFocusOpen(false);
        setHoveredKey(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearHideTimer();
        setHoverOpen(false);
        setFocusOpen(false);
        setTouchOpen(false);
        setHoveredKey(null);
        triggerRef.current?.blur();
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [touchOpen, focusOpen]);

  if (items.length === 0) {
    return null;
  }

  if (!condensed) {
    return (
      <>
        {items.map((item) => {
          const pillClass =
            item.tone === "is-focus"
              ? "song-focus-pill"
              : item.tone === "is-muted"
                ? "song-muted-pill"
                : `song-storage-pill ${item.tone}`;
          return (
            <span
              key={item.key}
              className={pillClass}
              title={item.detail || item.label}
            >
              {item.label}
            </span>
          );
        })}
      </>
    );
  }

  const alignClass =
    resolvedAlign === "left"
      ? " is-tooltip-align-left"
      : resolvedAlign === "right"
        ? " is-tooltip-align-right"
        : "";
  const placementClass = resolvedPlacement === "bottom" ? " is-tooltip-below" : "";
  const summaryAriaLabel = `歌曲狀態（${items.length} 項）：${items.map((item) => item.label).join("、")}`;

  return (
    <span
      ref={wrapRef}
      className="status-dot-cluster-wrap"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => {
        setHoverOpen(false);
        setHoveredKey(null);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`status-dot-cluster${isOpen ? " is-open" : ""}`}
        aria-label={summaryAriaLabel}
        aria-expanded={isOpen}
        onFocus={() => setFocusOpen(true)}
        onBlur={() => {
          setFocusOpen(false);
          setHoveredKey(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onTouchStart={(event) => {
          if (event.touches.length !== 1) {
            clearPressTimer();
            touchStartPosRef.current = null;
            return;
          }
          const touch = event.touches[0];
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
          clearPressTimer();
          pressTimerRef.current = window.setTimeout(() => {
            pressTimerRef.current = null;
            setTouchOpen(true);
            clearHideTimer();
            hideTimerRef.current = window.setTimeout(() => {
              hideTimerRef.current = null;
              setTouchOpen(false);
            }, 4500);
          }, 420);
        }}
        onTouchMove={(event) => {
          if (!pressTimerRef.current || !touchStartPosRef.current || event.touches.length === 0) return;
          const touch = event.touches[0];
          const dx = touch.clientX - touchStartPosRef.current.x;
          const dy = touch.clientY - touchStartPosRef.current.y;
          if (Math.hypot(dx, dy) > 10) {
            clearPressTimer();
          }
        }}
        onTouchEnd={() => {
          clearPressTimer();
          touchStartPosRef.current = null;
        }}
        onTouchCancel={() => {
          clearPressTimer();
          touchStartPosRef.current = null;
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {items.map((item) => (
          <span
            key={item.key}
            className={`status-led-dot ${item.tone}${hoveredKey === item.key ? " is-highlighted" : ""}`}
            aria-hidden="true"
            onMouseEnter={() => setHoveredKey(item.key)}
            onMouseLeave={() => setHoveredKey(null)}
          />
        ))}
      </button>

      {isOpen && (
        <div
          ref={tooltipRef}
          role="tooltip"
          className={`status-dot-tooltip${placementClass}${alignClass}`}
        >
          <div className="status-dot-tooltip-header">歌曲狀態（{items.length} 項）</div>
          <ul className="status-dot-tooltip-list">
            {items.map((item) => (
              <li
                key={item.key}
                className={`status-dot-tooltip-row${hoveredKey === item.key ? " is-row-highlighted" : ""}`}
              >
                <span className={`status-led-dot ${item.tone}`} aria-hidden="true" />
                <span className="status-dot-tooltip-copy">
                  <strong>{item.label}</strong>
                  {item.detail ? (
                    <span className="status-dot-tooltip-detail">{item.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
