"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type IconActionButtonProps = {
  icon: ReactNode;
  text?: string;
  label: string;
  shortcut?: string;
  disabledReason?: string;
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
  const pressTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  const tooltipText = disabled && disabledReason
    ? disabledReason
    : shortcut
      ? `${label} (${shortcut})`
      : label;

  const clearTimers = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

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

  return (
    <span className={`icon-btn-wrap${showTouchTooltip ? " is-tooltip-visible" : ""}${wrapClassName ? ` ${wrapClassName}` : ""}`}>
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
      <span role="tooltip" className="action-tooltip">
        {tooltipText}
      </span>
    </span>
  );
}
