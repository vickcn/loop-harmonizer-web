"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconActionButton } from "./IconActionButton";

export type AdaptiveActionItem = {
  key: string;
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  onSelect: () => void;
  renderInline: () => ReactNode;
};

type Props = {
  items: AdaptiveActionItem[];
  gap?: number;
  moreButtonWidth?: number;
  className?: string;
};

export function AdaptiveActionRow({ items, gap = 6, moreButtonWidth = 40, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAlign, setMenuAlign] = useState<"right" | "left">("right");
  const [menuAbove, setMenuAbove] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const recompute = () => {
    const container = containerRef.current;
    if (!container) return;

    let available = container.clientWidth;
    const parent = container.parentElement;
    if (parent) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.display.includes("flex")) {
        const padX =
          (parseFloat(parentStyle.paddingLeft) || 0) +
          (parseFloat(parentStyle.paddingRight) || 0);
        const colGap = parseFloat(parentStyle.columnGap) || parseFloat(parentStyle.gap) || 0;
        const children = Array.from(parent.children).filter((el) => el instanceof HTMLElement) as HTMLElement[];
        const containerRect = container.getBoundingClientRect();
        const parentWraps = parentStyle.flexWrap !== "nowrap";
        const parentWidth = parent.clientWidth;
        let siblingsWidth = 0;
        let sameLineCount = 1;
        for (const child of children) {
          if (child === container) continue;
          const style = getComputedStyle(child);
          if (style.position === "absolute" || style.display === "none") continue;
          const childRect = child.getBoundingClientRect();
          if (parentWraps && containerRect.height > 0 && childRect.height > 0) {
            const threshold = Math.max(8, Math.min(childRect.height, containerRect.height) * 0.6);
            if (Math.abs(childRect.top - containerRect.top) >= threshold) {
              continue;
            }
          }
          sameLineCount += 1;
          const grow = parseFloat(style.flexGrow) || 0;
          if (grow > 0) {
            const minW = parseFloat(style.minWidth) || 56;
            siblingsWidth += minW;
          } else {
            siblingsWidth += childRect.width;
          }
        }
        if (parentWidth > 0) {
          const totalGaps = Math.max(0, sameLineCount - 1) * colGap;
          const parentAvailable = parentWidth - padX - siblingsWidth - totalGaps;
          if (parentAvailable <= 0) {
            setVisibleCount((prev) => (prev === 0 ? prev : 0));
            return;
          }
          available = parentAvailable;
        }
      }
    }

    if (available <= 0) return;

    const widths = items.map((_, i) => measureRefs.current[i]?.getBoundingClientRect().width ?? 40);
    const totalAll = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, items.length - 1) * gap;
    if (totalAll <= available + 1) {
      setVisibleCount((prev) => (prev === items.length ? prev : items.length));
      setMenuOpen(false);
      return;
    }

    let used = 0;
    let count = 0;
    for (let i = 0; i < widths.length; i++) {
      const nextUsed = used + (i > 0 ? gap : 0) + widths[i];
      const withMore = nextUsed + gap + moreButtonWidth;
      if (withMore <= available + 1) {
        used = nextUsed;
        count = i + 1;
      } else {
        break;
      }
    }
    setVisibleCount((prev) => (prev === count ? prev : count));
  };

  useLayoutEffect(() => {
    recompute();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recompute());
    observer.observe(container);
    if (container.parentElement) observer.observe(container.parentElement);
    return () => observer.disconnect();
  }, [items.length, gap, moreButtonWidth]);

  useLayoutEffect(() => {
    if (!menuOpen || typeof window === "undefined") return;
    const wrapEl = menuWrapRef.current;
    if (!wrapEl) return;
    const rect = wrapEl.getBoundingClientRect();
    const menuW = menuRef.current?.offsetWidth || 200;
    const menuH = menuRef.current?.offsetHeight || 180;
    const margin = 12;
    const spaceRightFromLeftEdge = window.innerWidth - rect.left;
    const nextAlign =
      rect.right < menuW + margin && spaceRightFromLeftEdge >= rect.right
        ? "left"
        : "right";
    const spaceBelow = window.innerHeight - rect.bottom;
    const nextAbove = spaceBelow < menuH + margin && rect.top > spaceBelow;
    setMenuAlign(nextAlign);
    setMenuAbove(nextAbove);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const inlineItems = items.slice(0, visibleCount);
  const overflowItems = items.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      className={`adaptive-action-row${className ? ` ${className}` : ""}`}
      style={{ gap }}
    >
      <div className="adaptive-measure-clip" aria-hidden="true">
        <div className="adaptive-measure-strip" style={{ gap }}>
          {items.map((item, index) => (
            <div
              key={item.key}
              ref={(el) => {
                measureRefs.current[index] = el;
              }}
              style={{ flex: "0 0 auto" }}
            >
              {item.renderInline()}
            </div>
          ))}
        </div>
      </div>

      {inlineItems.map((item) => (
        <div key={item.key} style={{ flex: "0 0 auto" }}>
          {item.renderInline()}
        </div>
      ))}

      {overflowItems.length > 0 && (
        <div ref={menuWrapRef} className="adaptive-more-wrap">
          <IconActionButton
            icon="⋯"
            label={`更多操作（${overflowItems.length} 項）`}
            expanded={menuOpen}
            primary={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          />
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              className={`adaptive-overflow-menu${menuAlign === "left" ? " is-menu-align-left" : ""}${menuAbove ? " is-menu-above" : ""}`}
            >
              {overflowItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  aria-pressed={item.pressed}
                  className={`btn mixer-button adaptive-overflow-item${item.pressed ? " primary" : ""}${item.danger ? " is-danger" : ""}`}
                  onClick={() => {
                    setMenuOpen(false);
                    item.onSelect();
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <kbd className="adaptive-shortcut-kbd">{item.shortcut}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
