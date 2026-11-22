"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type IconActionButtonProps = {
  icon: ReactNode;
  text?: string;
  label: string;
  shortcut?: string;
  disabledReason?: string;
  tooltipPlacement?: "auto" | "top" | "bottom";
  pressed?: boolean;
  busy?: boolean;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  expanded?: boolean;
  wrapClassName?: string;
  className?: string;
  style?: CSSProperties;
  onClick: () => void;
};

export function IconActionButton({
  icon,
  text,
  label,
  shortcut,
  disabledReason,
  tooltipPlacement = "auto",
  pressed,
  busy,
  disabled,
  primary,
  danger,
  expanded,
  wrapClassName = "",
  className = "",
  style,
  onClick,
}: IconActionButtonProps) {
  const [showTouchTooltip, setShowTouchTooltip] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<"top" | "bottom">(
    tooltipPlacement === "bottom" ? "bottom" : "top",
  );
  const [resolvedAlign, setResolvedAlign] = useState<"left" | "center" | "right">("center");
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  const tooltipText = disabled && disabledReason
    ? disabledReason
    : shortcut
      ? `${label} (${shortcut})`
      : label;

  const updateTooltipPosition = () => {
    const wrapEl = wrapRef.current;
    if (!wrapEl || typeof window === "undefined") return;

    const rect = wrapEl.getBoundingClientRect();
    const tipWidth = tooltipRef.current?.offsetWidth || 264;
    const tipHeight = tooltipRef.current?.offsetHeight || 56;
    const margin = 12;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    let nextPlacement: "top" | "bottom";
    if (tooltipPlacement === "bottom") {
      nextPlacement =
        spaceBelow < tipHeight + margin && spaceAbove >= tipHeight + margin
          ? "top"
          : "bottom";
    } else {
      nextPlacement =
        spaceAbove < tipHeight + margin && spaceBelow > spaceAbove
          ? "bottom"
          : "top";
    }

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
  };

  const clearTimers = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  useEffect(() => {
    setResolvedPlacement(tooltipPlacement === "bottom" ? "bottom" : "top");
  }, [tooltipPlacement]);

  useEffect(() => () => {
    clearTimers();
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
  }, []);

  const handleTouchStart = () => {
    longPressedRef.current = false;
    clearTimers();
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      longPressedRef.current = true;
      updateTooltipPosition();
      setShowTouchTooltip(true);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setShowTouchTooltip(false);
      }, 2000);
    }, 500);
  };

  const handleTouchEndOrMove = () => {
    clearTimers();
  };

  const handleClick = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    setShowTouchTooltip(false);
    onClick();
  };

  const alignClass =
    resolvedAlign === "left"
      ? " is-tooltip-align-left"
      : resolvedAlign === "right"
        ? " is-tooltip-align-right"
        : "";
  const placementClass = resolvedPlacement === "bottom" ? " is-tooltip-below" : "";

  return (
    <span
      ref={wrapRef}
      className={`icon-btn-wrap${placementClass}${alignClass}${showTouchTooltip ? " is-tooltip-visible" : ""}${wrapClassName ? ` ${wrapClassName}` : ""}`}
      onMouseEnter={updateTooltipPosition}
      onFocus={updateTooltipPosition}
    >
      <button
        type="button"
        aria-label={label}
        title={tooltipText}
        aria-pressed={pressed}
        aria-busy={busy}
        aria-expanded={expanded}
        disabled={disabled}
        className={`btn mixer-button icon-btn${text ? " has-text" : ""}${primary ? " primary" : ""}${busy ? " is-loading" : ""}${danger ? " is-danger" : ""}${className ? ` ${className}` : ""}`}
        style={style}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEndOrMove}
        onTouchCancel={handleTouchEndOrMove}
        onTouchMove={handleTouchEndOrMove}
      >
        {icon}
        {text && <span className="icon-btn-text">{text}</span>}
      </button>
      <span ref={tooltipRef} role="tooltip" className="action-tooltip">
        {tooltipText}
      </span>
    </span>
  );
}
