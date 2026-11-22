"use client";

import { useEffect, useRef } from "react";

export type ConfirmDeleteCheckboxOption = {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  badgeLabel?: string;
  changeHeading?: string;
  preserveHeading?: string;
  deleteItems: string[];
  preserveItems: string[];
  recoverability: string;
  safetyNote?: string | null;
  errorMessage?: string | null;
  checkboxOption?: ConfirmDeleteCheckboxOption;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  submitting?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
};

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  return candidates.filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    return el.getClientRects().length > 0;
  });
}

export function ConfirmDeleteDialog({
  open,
  title,
  subtitle,
  badgeLabel,
  changeHeading,
  preserveHeading,
  deleteItems,
  preserveItems,
  recoverability,
  safetyNote,
  errorMessage,
  checkboxOption,
  confirmLabel,
  cancelLabel = "取消",
  danger = true,
  submitting = false,
  onConfirm,
  onCancel,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const submittingRef = useRef(submitting);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusDialog = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = getFocusableElements(panel);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    };

    focusDialog();
    const rafId = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) {
        focusDialog();
      }
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!submittingRef.current) {
          onCancelRef.current();
        }
        return;
      }

      if (event.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = getFocusableElements(panel);
        if (focusables.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const activeInside = active instanceof Node && panel.contains(active);

        if (event.shiftKey) {
          if (!activeInside || active === first || active === panel) {
            event.preventDefault();
            last.focus();
          }
        } else if (!activeInside || active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown, true);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && previous.isConnected) {
        previous.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-dialog-title"
      className="mixer-modal-backdrop is-confirm-layer"
      onClick={(event) => {
        if (!submitting && event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="card mixer-modal-panel"
        style={{ outline: "none" }}
      >
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div className="grid" style={{ gap: 4 }}>
            <strong id="confirm-delete-dialog-title" style={{ fontSize: 16 }}>
              {title}
            </strong>
            {subtitle && (
              <span className="small" style={{ opacity: 0.8 }}>
                {subtitle}
              </span>
            )}
          </div>
          <span
            className="badge"
            style={{
              background: danger ? "rgba(239, 68, 68, 0.18)" : "rgba(245, 158, 11, 0.2)",
              color: danger ? "#fecaca" : "#fde68a",
              borderColor: danger ? "rgba(248, 113, 113, 0.55)" : "rgba(251, 191, 36, 0.55)",
              flexShrink: 0,
            }}
          >
            {badgeLabel ?? (danger ? "刪除確認" : "清理確認")}
          </span>
        </div>

        <div className="grid mixer-modal-section" style={{ gap: 8 }}>
          <div className="grid" style={{ gap: 4 }}>
            <strong className="small" style={{ color: danger ? "#fca5a5" : "#bae6fd" }}>
              {changeHeading ?? "將刪除以下資料"}
            </strong>
            <ul className="mixer-modal-list">
              {deleteItems.map((item, idx) => (
                <li key={idx} className="small">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid" style={{ gap: 4, paddingTop: 6, borderTop: "1px solid rgba(148, 163, 184, 0.14)" }}>
            <strong className="small" style={{ color: "#6ee7b7" }}>
              {preserveHeading ?? "以下資料會完整保留"}
            </strong>
            <ul className="mixer-modal-list">
              {preserveItems.map((item, idx) => (
                <li key={idx} className="small">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid" style={{ gap: 2, paddingTop: 6, borderTop: "1px solid rgba(148, 163, 184, 0.14)" }}>
            <strong className="small" style={{ color: "#bae6fd" }}>
              是否可恢復
            </strong>
            <span className="small" style={{ opacity: 0.92 }}>
              {recoverability}
            </span>
          </div>
        </div>

        {safetyNote && (
          <div
            role="note"
            className="mixer-modal-section"
            style={{ borderColor: "rgba(56, 189, 248, 0.35)", background: "rgba(14, 116, 144, 0.16)" }}
          >
            <span className="small" style={{ color: "#bae6fd" }}>
              {safetyNote}
            </span>
          </div>
        )}

        {checkboxOption && (
          <label className="row mixer-modal-option">
            <input
              type="checkbox"
              checked={checkboxOption.checked}
              disabled={submitting}
              onChange={(event) => checkboxOption.onChange(event.target.checked)}
            />
            <span className="grid" style={{ gap: 2 }}>
              <span className="small" style={{ fontWeight: 600 }}>
                {checkboxOption.label}
              </span>
              {checkboxOption.description && (
                <span className="small" style={{ opacity: 0.78 }}>
                  {checkboxOption.description}
                </span>
              )}
            </span>
          </label>
        )}

        {errorMessage && (
          <div role="alert" className="card-error-banner">
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="row mixer-modal-actions">
          <button
            type="button"
            className="btn mixer-button"
            disabled={submitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn mixer-button${danger ? " mixer-abort-button" : " primary"}`}
            disabled={submitting}
            onClick={() => {
              if (!submitting) {
                void Promise.resolve(onConfirm()).catch(() => undefined);
              }
            }}
          >
            {submitting ? "處理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
