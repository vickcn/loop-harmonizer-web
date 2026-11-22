"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { preloadGoogleSdk } from "@/lib/google/googleDrivePicker";
import { sharedGoogleAccountManager } from "@/lib/google/googleAccountManager";

type Props = {
  disabled?: boolean;
  onRequestRevoke?: (confirmAction: () => Promise<void>) => void;
  onError?: (message: string) => void;
  onSignedOut?: () => void;
  className?: string;
};

export function GoogleAccountButton({
  disabled = false,
  onRequestRevoke,
  onError,
  onSignedOut,
  className = "",
}: Props) {
  const auth = useSyncExternalStore(
    sharedGoogleAccountManager.subscribe,
    sharedGoogleAccountManager.getSnapshot,
    sharedGoogleAccountManager.getSnapshot,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAlign, setMenuAlign] = useState<"right" | "left">("right");
  const [menuAbove, setMenuAbove] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menuOpen || typeof window === "undefined") return;
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const rect = wrapEl.getBoundingClientRect();
    const menuW = menuRef.current?.offsetWidth || 260;
    const menuH = menuRef.current?.offsetHeight || 240;
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
    sharedGoogleAccountManager.refreshConfigStatus();
    void preloadGoogleSdk();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
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

  if (auth.status === "unconfigured") {
    return (
      <span
        className="small google-unconfigured-note"
        title={`缺少環境變數：${auth.missingConfigFields.join("、")}（本機模式完全可用）`}
      >
        本機離線模式
      </span>
    );
  }

  const isBusy = auth.status === "authorizing" || auth.status === "switching";
  const isSignedIn = auth.status === "signed_in" && Boolean(auth.account);
  const isExpired = auth.status === "expired" && Boolean(auth.account);

  const handleSignIn = async () => {
    if (disabled || isBusy) return;
    try {
      await sharedGoogleAccountManager.signIn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Google 登入未完成。";
      if (!/已取消/.test(msg)) {
        onError?.(msg);
      }
    }
  };

  const handleSwitchAccount = async () => {
    setMenuOpen(false);
    if (disabled || isBusy) return;
    try {
      await sharedGoogleAccountManager.switchAccount();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "切換 Google 帳號未完成。";
      if (!/已取消/.test(msg)) {
        onError?.(msg);
      }
    }
  };

  const handleReauthorize = async () => {
    setMenuOpen(false);
    if (disabled || isBusy) return;
    try {
      await sharedGoogleAccountManager.reauthorize();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "重新授權 Google 帳號失敗。";
      if (!/已取消/.test(msg)) {
        onError?.(msg);
      }
    }
  };

  const handleSignOut = () => {
    setMenuOpen(false);
    sharedGoogleAccountManager.signOut();
    onSignedOut?.();
  };

  const handleRevoke = () => {
    setMenuOpen(false);
    const execRevoke = async () => {
      await sharedGoogleAccountManager.revokeAuthorization();
      onSignedOut?.();
    };
    if (onRequestRevoke) {
      onRequestRevoke(execRevoke);
    } else {
      void execRevoke();
    }
  };

  if (!isSignedIn && !isExpired) {
    return (
      <button
        type="button"
        className={`btn mixer-button google-account-btn${isBusy ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
        disabled={disabled || isBusy}
        aria-busy={isBusy}
        title="登入 Google 帳號以使用雲端選歌與分軌備份（授權 scope：drive.file）"
        onClick={() => void handleSignIn()}
      >
        {isBusy ? (
          <>
            <span className="mixer-spinner" aria-hidden="true" />
            <span>{auth.status === "switching" ? "切換帳號中…" : "等待 Google 授權…"}</span>
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.5 14.6 2.5 12 2.5 6.8 2.5 2.5 6.8 2.5 12S6.8 21.5 12 21.5c6.9 0 9.5-4.8 9.5-7.3 0-.5-.1-.9-.1-1.3H12z" />
            </svg>
            <span>{auth.status === "revoked" ? "重新登入 Google" : "登入 Google"}</span>
          </>
        )}
      </button>
    );
  }

  const account = auth.account!;
  const labelName = account.displayName || account.email || account.accountId;

  return (
    <div ref={wrapRef} className="google-account-wrap">
      <button
        type="button"
        className={`btn mixer-button google-account-btn${isExpired ? " is-expired" : ""}${isBusy ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
        disabled={disabled}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title={
          isExpired
            ? `Google 授權已過期（${labelName}），請點擊重新授權`
            : `已登入：${labelName}${account.email ? ` (${account.email})` : ""}`
        }
        onClick={() => setMenuOpen((prev) => !prev)}
      >
        {account.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={account.picture}
            alt=""
            width={18}
            height={18}
            className="google-account-avatar"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="google-account-avatar-fallback" aria-hidden="true">
            {labelName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="google-account-name">
          {isExpired ? `${labelName}（授權過期）` : labelName}
        </span>
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.75 }}>▾</span>
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className={`google-account-menu${menuAlign === "left" ? " is-menu-align-left" : ""}${menuAbove ? " is-menu-above" : ""}`}
        >
          <div className="google-account-menu-header">
            <strong style={{ fontSize: 13 }}>{account.displayName || "Google 使用者"}</strong>
            {account.email && (
              <span className="small" style={{ opacity: 0.85, wordBreak: "break-all" }}>
                {account.email}
              </span>
            )}
            <span className="small" style={{ opacity: 0.65, fontSize: 11 }}>
              授權範圍：drive.file（僅限選取與系統建立檔案）
            </span>
            {isExpired && (
              <span className="small" style={{ color: "#fde68a", fontWeight: 600 }}>
                ⚠ Access Token 已過期，請重新授權
              </span>
            )}
          </div>

          <button
            type="button"
            role="menuitem"
            className="btn mixer-button adaptive-overflow-item"
            onClick={() => void handleReauthorize()}
          >
            <span>{isExpired ? "⚠ 立即重新授權" : "🔑 重新授權 / 更新權限"}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="btn mixer-button adaptive-overflow-item"
            onClick={() => void handleSwitchAccount()}
          >
            <span>↻ 切換 Google 帳號</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="btn mixer-button adaptive-overflow-item"
            onClick={handleSignOut}
          >
            <span>🚪 登出此應用程式</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="btn mixer-button adaptive-overflow-item is-danger"
            onClick={handleRevoke}
          >
            <span>⛔ 撤銷 Google 授權</span>
          </button>
        </div>
      )}
    </div>
  );
}
