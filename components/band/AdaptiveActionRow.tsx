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
  const menuWrapRef = useRef<HTMLDivElement>(null);

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
        let siblingsWidth = 0;
        for (const child of children) {
          if (child === container) continue;
          const style = getComputedStyle(child);
          if (style.position === "absolute" || style.display === "none") continue;
          const grow = parseFloat(style.flexGrow) || 0;
          if (grow > 0) {
            const minW = parseFloat(style.minWidth) || 56;
            siblingsWidth += minW;
          } else {
            siblingsWidth += child.getBoundingClientRect().width;
          }
        }
        const totalGaps = Math.max(0, children.length - 1) * colGap;
        const parentAvailable = parent.clientWidth - padX - siblingsWidth - totalGaps;
        if (parentAvailable > 0) {
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
      <div className="adaptive-measure-strip" aria-hidden="true" style={{ gap }}>
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
            <div role="menu" className="adaptive-overflow-menu">
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
