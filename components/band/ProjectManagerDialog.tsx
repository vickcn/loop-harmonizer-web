"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GoogleAccount } from "@/lib/google/googleAuthTypes";
import { computeEntryBackupStatus } from "@/lib/projects/projectModel";
import { resolveProjectManagerActionGroups } from "@/lib/projects/projectToolbarModel";
import { DRIVE_CAS_LIMITATION_NOTE } from "@/lib/projects/projectDriveSync";
import type { PromoteLocalToDriveProgress } from "@/lib/projects/projectManager";
import type {
  ProjectOfflineAssessment,
  ProjectOfflineDownloadProgress,
} from "@/lib/projects/projectRestoreManager";
import type {
  PersistedProjectRecord,
  ProjectListEntrySummary,
  ProjectSongBackupStatus,
  ProjectStorageProvider,
} from "@/lib/projects/projectTypes";

export type ProjectDialogMode =
  | null
  | "list"
  | "create"
  | "save_as"
  | "rename"
  | "promote"
  | "offline"
  | "conflict";

type SortMode = "updated_desc" | "updated_asc" | "name_asc";
type ProviderFilter = "all" | "local" | "google_drive";

type Props = {
  open: boolean;
  mode: ProjectDialogMode;
  activeProject: PersistedProjectRecord | null;
  songCount: number;
  focusLocked: boolean;
  renameTarget: { projectId: string; name: string } | null;
  projects: ProjectListEntrySummary[];
  projectsLoading: boolean;
  cloudError: string | null;
  cloudIncompleteReason?: string | null;
  account: GoogleAccount | null;
  isGoogleConfigured: boolean;
  hasLegacyWorkspaceSongs: boolean;
  busyMessage: string | null;
  errorMessage: string | null;
  promoteProgress: PromoteLocalToDriveProgress | null;
  promoteBackupFailures: Array<{ entryId: string; displayName: string; reason: string }>;
  offlineAssessment: ProjectOfflineAssessment | null;
  offlineAssessmentLoading: boolean;
  offlineDownloadProgress: ProjectOfflineDownloadProgress | null;
  offlineDownloadResult: {
    completedCount: number;
    reusedCount: number;
    failedSongs: Array<{ entryId: string; displayName: string; reason: string }>;
    cancelled: boolean;
  } | null;
  onClose: () => void;
  onChangeMode: (mode: Exclude<ProjectDialogMode, null>) => void;
  onRefreshProjects: () => void;
  onOpenProject: (entry: ProjectListEntrySummary) => void | Promise<void>;
  onCreateProject: (params: {
    name: string;
    description?: string;
    storageProvider: ProjectStorageProvider;
  }) => void | Promise<void>;
  onSaveAsProject: (params: {
    name: string;
    description?: string;
    storageProvider: ProjectStorageProvider;
  }) => void | Promise<void>;
  onRenameProject: (params: { projectId: string; name: string }) => void | Promise<void>;
  onStartRenameActiveProject: () => void;
  onStartRenameFromList: (entry: ProjectListEntrySummary) => void;
  onDeleteActiveProject: () => void;
  onDeleteProjectEntry: (entry: ProjectListEntrySummary) => void;
  onOpenOfflineDownload: () => void;
  onPromoteToDrive: (params: { backupLocalOriginals: boolean }) => void | Promise<void>;
  onCancelPromote: () => void;
  onStartOfflineDownload: () => void | Promise<void>;
  onCancelOfflineDownload: () => void;
  onResolveConflict: (params: {
    strategy: "load_remote" | "save_local_as_new" | "overwrite_remote";
    newProjectNameForSaveAs?: string;
  }) => void | Promise<void>;
  onMigrateLegacyWorkspace: () => void | Promise<void>;
  onReturnToLegacyWorkspace?: () => void;
  onSignInGoogle: () => void | Promise<void>;
  onShareProject: () => void;
};

const BACKUP_LABELS: Record<ProjectSongBackupStatus, { label: string; toneClass: string }> = {
  local_only: { label: "僅本機可用", toneClass: "is-warn" },
  original_backed_up: { label: "原曲已備份", toneClass: "is-drive" },
  stems_backed_up: { label: "分軌已備份", toneClass: "is-drive-stem" },
  cross_device_ready: { label: "可跨裝置恢復", toneClass: "is-saved" },
  pending_sync: { label: "尚待同步", toneClass: "is-saving" },
};

function formatTime(isoOrMs: string | number): string {
  const ts = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ts) || ts <= 0) return "未知時間";
  try {
    return new Date(ts).toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(isoOrMs);
  }
}

function formatMiB(bytes: number | null): string {
  if (bytes === null) return "瀏覽器未提供";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function ProjectManagerDialog(props: Props) {
  const { open, mode, activeProject, busyMessage } = props;
  const isBusy = Boolean(busyMessage) || Boolean(props.promoteProgress) || Boolean(props.offlineDownloadProgress);

  const [searchText, setSearchText] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("updated_desc");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");

  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formProvider, setFormProvider] = useState<ProjectStorageProvider>("local");

  const [backupOriginals, setBackupOriginals] = useState(true);
  const [conflictSaveAsName, setConflictSaveAsName] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && prev.isConnected) {
        prev.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || !mode) return;
    const targetIsNameInput = mode === "create" || mode === "save_as" || mode === "rename";
    const rafId = window.requestAnimationFrame(() => {
      if (targetIsNameInput && nameInputRef.current && !nameInputRef.current.disabled) {
        nameInputRef.current.focus();
      } else {
        panelRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    if (mode === "create") {
      setFormName("");
      setFormDesc("");
      setFormProvider(props.isGoogleConfigured && props.account ? "google_drive" : "local");
    } else if (mode === "save_as") {
      setFormName(activeProject ? `${activeProject.project.name}（副本）` : "我的樂團專案");
      setFormDesc(activeProject?.project.description ?? "");
      setFormProvider(
        activeProject?.storageProvider === "google_drive" && props.account ? "google_drive" : "local",
      );
    } else if (mode === "rename") {
      setFormName(props.renameTarget?.name ?? activeProject?.project.name ?? "");
    } else if (mode === "conflict") {
      setConflictSaveAsName(activeProject ? `${activeProject.project.name}（衝突本機副本）` : "衝突副本");
    }
  }, [open, mode, activeProject, props.renameTarget, props.isGoogleConfigured, props.account]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && !isBusy) {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, isBusy, props]);

  const filteredProjects = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = props.projects.filter((item) => {
      if (providerFilter !== "all" && item.storageProvider !== providerFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        (item.description ?? "").toLowerCase().includes(q)
      );
    });
    return list.slice().sort((a, b) => {
      if (sortMode === "name_asc") return a.name.localeCompare(b.name, "zh-Hant");
      const ta = Date.parse(a.updatedAt) || a.localUpdatedAt || 0;
      const tb = Date.parse(b.updatedAt) || b.localUpdatedAt || 0;
      return sortMode === "updated_asc" ? ta - tb : tb - ta;
    });
  }, [props.projects, searchText, sortMode, providerFilter]);

  if (!open || !mode) return null;

  const titleByMode: Record<Exclude<ProjectDialogMode, null>, string> = {
    list: "專案管理與開啟",
    create: "新增專案",
    save_as: activeProject ? "另存新專案" : "建立並儲存為新專案",
    rename: "重新命名專案",
    promote: "將本機專案儲存到 Google Drive",
    offline: "下載整個專案供離線使用",
    conflict: "處理跨裝置專案版本衝突",
  };

  const actionGroups = resolveProjectManagerActionGroups({
    activeProject,
    songCount: props.songCount,
    hasLegacyWorkspaceSongs: props.hasLegacyWorkspaceSongs,
    isGoogleConfigured: props.isGoogleConfigured,
    focusLocked: props.focusLocked,
    isBusy,
  });
  const secondaryByKey = new Map(actionGroups.secondary.map((a) => [a.key, a]));
  const saveAsMeta = secondaryByKey.get("save_as");
  const renameMeta = secondaryByKey.get("rename_active");
  const offlineMeta = secondaryByKey.get("offline_download");
  const promoteMeta = secondaryByKey.get("promote_drive");
  const migrateMeta = secondaryByKey.get("migrate_legacy");
  const returnMeta = secondaryByKey.get("return_legacy");
  const deleteActiveMeta = actionGroups.danger.find((a) => a.key === "delete_active");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-manager-dialog-title"
      className="mixer-modal-backdrop"
      onClick={(event) => {
        if (!isBusy && event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="card mixer-modal-panel is-structured"
        style={{ width: "min(700px, 100%)" }}
      >
        <div className="row mixer-modal-header" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div className="grid" style={{ gap: 4, minWidth: 0, flex: 1 }}>
            <strong id="project-manager-dialog-title" style={{ fontSize: 16 }}>
              {titleByMode[mode]}
            </strong>
            <span className="small" style={{ opacity: 0.78 }}>
              {props.account
                ? `Google 帳戶：${props.account.displayName || props.account.email || props.account.accountId}`
                : "目前為本機匿名模式（完全可用，無須登入 Google）"}
            </span>
          </div>
          {!isBusy && (
            <button type="button" className="btn mixer-button" style={{ minHeight: 36, padding: "4px 10px", fontSize: 12 }} onClick={props.onClose}>
              關閉
            </button>
          )}
        </div>

        <div className="mixer-modal-body">
        {busyMessage && (
          <div role="status" aria-live="polite" className="row mixer-modal-section" style={{ gap: 8, alignItems: "center" }}>
            <span className="mixer-spinner" aria-hidden="true" />
            <span className="small" style={{ color: "var(--cloud)", fontWeight: 600 }}>{busyMessage}</span>
          </div>
        )}

        {props.errorMessage && (
          <div role="alert" className="card-error-banner">
            <span>{props.errorMessage}</span>
          </div>
        )}

        {mode === "list" && (
          <div className="grid" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="search"
                className="project-search-input"
                placeholder="搜尋專案名稱或備註…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                aria-label="搜尋專案"
              />
              <select
                className="project-select-input"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value as ProviderFilter)}
                aria-label="篩選儲存來源"
              >
                <option value="all">全部來源</option>
                <option value="local">僅本機</option>
                <option value="google_drive">Google Drive</option>
              </select>
              <select
                className="project-select-input"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                aria-label="專案排序方式"
              >
                <option value="updated_desc">最近修改優先</option>
                <option value="updated_asc">最舊修改優先</option>
                <option value="name_asc">依名稱排序</option>
              </select>
              <button
                type="button"
                className="btn mixer-button"
                disabled={props.projectsLoading || isBusy}
                onClick={props.onRefreshProjects}
              >
                {props.projectsLoading ? (
                  <>
                    <span className="mixer-spinner" aria-hidden="true" />
                    讀取清單…
                  </>
                ) : (
                  "↻ 重新整理"
                )}
              </button>
              <button
                type="button"
                className="btn mixer-button primary"
                disabled={isBusy}
                onClick={() => props.onChangeMode("create")}
              >
                ＋ 新增專案
              </button>
            </div>

            {props.cloudIncompleteReason && (
              <div role="status" className="card-warning-banner grid" style={{ gap: 2 }}>
                <strong style={{ fontSize: 12 }}>Google Drive 雲端專案清單可能不完整</strong>
                <span className="small">
                  僅顯示已讀取的部分專案（尚未列出全部，或部分項目讀取異常）：{props.cloudIncompleteReason}
                </span>
              </div>
            )}

            {props.cloudError && props.cloudError !== props.cloudIncompleteReason && (
              <div role="status" className="card-warning-banner">
                <span>Google Drive 雲端清單讀取異常（仍可正常開啟本機專案與快取）：{props.cloudError}</span>
              </div>
            )}

            {filteredProjects.length === 0 ? (
              <div className="mixer-modal-section grid" style={{ textAlign: "center", padding: "24px 12px", gap: 10, justifyItems: "center" }}>
                {props.projectsLoading ? (
                  <div className="row" style={{ gap: 8, justifyContent: "center" }}>
                    <span className="mixer-spinner" aria-hidden="true" />
                    <p className="small" style={{ margin: 0, opacity: 0.78 }}>
                      正在讀取專案清單（僅讀取 Metadata）…
                    </p>
                  </div>
                ) : props.projects.length === 0 && Boolean(props.cloudError) ? (
                  <>
                    <p className="small" style={{ margin: 0, color: "var(--warning)" }}>
                      雲端專案清單讀取失敗，且目前沒有本機專案。
                    </p>
                    <button
                      type="button"
                      className="btn mixer-button"
                      disabled={isBusy}
                      onClick={props.onRefreshProjects}
                    >
                      ↻ 重試讀取
                    </button>
                  </>
                ) : props.projects.length > 0 ? (
                  <>
                    <p className="small" style={{ margin: 0, opacity: 0.78 }}>
                      目前篩選條件下沒有符合的專案（共 {props.projects.length} 個專案）
                    </p>
                    <button
                      type="button"
                      className="btn mixer-button"
                      onClick={() => {
                        setSearchText("");
                        setProviderFilter("all");
                      }}
                    >
                      清除篩選條件
                    </button>
                  </>
                ) : (
                  <>
                    <p className="small" style={{ margin: 0, opacity: 0.78 }}>
                      尚未建立任何專案
                    </p>
                    <button
                      type="button"
                      className="btn mixer-button primary"
                      disabled={isBusy}
                      onClick={() => props.onChangeMode("create")}
                    >
                      ＋ 建立第一個專案
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid" style={{ gap: 8 }}>
                {filteredProjects.map((entry) => {
                  const isCurrent = activeProject?.projectId === entry.projectId;
                  return (
                    <div key={entry.projectId} className={`project-list-item${isCurrent ? " is-current" : ""}`}>
                      <div className="grid" style={{ gap: 4, flex: "1 1 240px", minWidth: 0 }}>
                        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <strong style={{ fontSize: 14, overflowWrap: "anywhere", minWidth: 0 }}>{entry.name}</strong>
                          {isCurrent && <span className="song-focus-pill">目前開啟</span>}
                          <span className={`project-provider-badge ${entry.storageProvider === "google_drive" ? "is-drive" : "is-local"}`}>
                            {entry.storageProvider === "google_drive" ? "Google Drive" : "本機"}
                          </span>
                          {entry.sourceLocation === "cloud_only" && (
                            <span className="song-storage-pill is-drive">尚未下載本機</span>
                          )}
                          {entry.hasConflict && (
                            <span className="song-storage-pill is-warn">版本衝突</span>
                          )}
                        </div>
                        <span className="small" style={{ opacity: 0.78 }}>
                          {entry.songCount} 首歌曲 · v{entry.revision} · 修改於 {formatTime(entry.updatedAt || entry.localUpdatedAt)}
                          {entry.storageProvider === "google_drive" && entry.songCount > 0
                            ? ` · 跨裝置就緒 ${entry.backupSummary.crossDeviceReadyCount}/${entry.songCount} 首`
                            : ""}
                        </span>
                        {entry.description && (
                          <span className="small" style={{ opacity: 0.65 }}>{entry.description}</span>
                        )}
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          type="button"
                          className="btn mixer-button primary"
                          disabled={isBusy}
                          style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={() => void props.onOpenProject(entry)}
                        >
                          {isCurrent ? "重新載入" : "開啟"}
                        </button>
                        <button
                          type="button"
                          className="btn mixer-button"
                          disabled={isBusy}
                          style={{ padding: "6px 10px", fontSize: 12 }}
                          onClick={() => props.onStartRenameFromList(entry)}
                        >
                          重新命名
                        </button>
                        <button
                          type="button"
                          className="btn mixer-button"
                          disabled={isBusy}
                          style={{ padding: "6px 10px", fontSize: 12, color: "var(--danger)" }}
                          onClick={() => props.onDeleteProjectEntry(entry)}
                        >
                          刪除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mixer-modal-section project-manager-secondary-section">
              <strong style={{ fontSize: 13 }}>目前專案與工作區操作（次要操作）</strong>
              <div className="project-manager-action-row">
                {saveAsMeta?.visible && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={saveAsMeta.disabled}
                    title={saveAsMeta.disabledReason}
                    onClick={() => props.onChangeMode("save_as")}
                  >
                    另存新專案
                  </button>
                )}
                {renameMeta?.visible && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={renameMeta.disabled}
                    onClick={props.onStartRenameActiveProject}
                  >
                    重新命名目前專案
                  </button>
                )}
                {promoteMeta?.visible && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={promoteMeta.disabled}
                    onClick={() => props.onChangeMode("promote")}
                  >
                    連結 Google Drive
                  </button>
                )}
                {offlineMeta?.visible && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={offlineMeta.disabled}
                    title={offlineMeta.disabledReason}
                    onClick={props.onOpenOfflineDownload}
                  >
                    離線下載
                  </button>
                )}
                {migrateMeta?.visible && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={migrateMeta.disabled}
                    title="保留原本資料不動，另外建立正式本機專案並沿用已完成分軌"
                    onClick={() => void props.onMigrateLegacyWorkspace()}
                  >
                    遷移舊工作區
                  </button>
                )}
                {returnMeta?.visible && props.onReturnToLegacyWorkspace && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={returnMeta.disabled}
                    title={returnMeta.disabledReason}
                    onClick={props.onReturnToLegacyWorkspace}
                  >
                    返回預設工作空間
                  </button>
                )}
                {activeProject && (
                  <button
                    type="button"
                    className="btn mixer-button"
                    disabled={isBusy || activeProject.storageProvider !== "google_drive" || !props.account}
                    title={
                      activeProject.storageProvider !== "google_drive"
                        ? "請先將專案連結至 Google Drive"
                        : !props.account
                          ? "請先登入 Google 帳號"
                          : "發布或管理專案唯讀共享版本"
                    }
                    onClick={props.onShareProject}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>
                    分享專案
                  </button>
                )}
              </div>
              {migrateMeta?.visible && (
                <span className="small" style={{ opacity: 0.72 }}>
                  遷移舊工作區會保留原有 IndexedDB 歌曲與工作階段不動，另外複製建立正式本機專案。
                </span>
              )}
            </div>

            {deleteActiveMeta?.visible && activeProject && (
              <div className="project-danger-section">
                <div className="grid" style={{ gap: 2, minWidth: 0 }}>
                  <strong style={{ fontSize: 13, color: "var(--danger)" }}>危險操作</strong>
                  <span className="small" style={{ opacity: 0.8 }}>
                    刪除「{activeProject.project.name}」將先開啟確認視窗，保留所有歌曲原曲與共用分軌成果。
                  </span>
                </div>
                <button
                  type="button"
                  className="btn mixer-button"
                  disabled={deleteActiveMeta.disabled}
                  style={{ color: "var(--danger)", borderColor: "rgba(248, 113, 113, 0.45)" }}
                  onClick={props.onDeleteActiveProject}
                >
                  刪除目前專案
                </button>
              </div>
            )}
          </div>
        )}

        {(mode === "create" || mode === "save_as") && (
          <form
            className="grid"
            style={{ gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!formName.trim() || isBusy) return;
              const payload = {
                name: formName.trim(),
                description: formDesc.trim() || undefined,
                storageProvider: formProvider,
              };
              if (mode === "create") {
                void props.onCreateProject(payload);
              } else {
                void props.onSaveAsProject(payload);
              }
            }}
          >
            <label className="grid" style={{ gap: 4 }}>
              <span className="small" style={{ fontWeight: 600 }}>專案名稱 *</span>
              <input
                ref={nameInputRef}
                type="text"
                required
                maxLength={80}
                className="project-text-input"
                placeholder="例如：主日敬拜、巡演歌單"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={isBusy}
              />
            </label>
            <label className="grid" style={{ gap: 4 }}>
              <span className="small" style={{ fontWeight: 600 }}>備註說明（選填）</span>
              <input
                type="text"
                maxLength={160}
                className="project-text-input"
                placeholder="例如：2026 春季場專用調性與節拍設定"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                disabled={isBusy}
              />
            </label>
            <div className="grid" style={{ gap: 6 }}>
              <span className="small" style={{ fontWeight: 600 }}>儲存位置</span>
              <label className="row mixer-modal-option">
                <input
                  type="radio"
                  name="project-storage-provider"
                  checked={formProvider === "local"}
                  onChange={() => setFormProvider("local")}
                  disabled={isBusy}
                />
                <div className="grid" style={{ gap: 2 }}>
                  <strong style={{ fontSize: 13 }}>本機專案（IndexedDB）</strong>
                  <span className="small" style={{ opacity: 0.78 }}>
                    完全無須登入 Google，即時離線使用；後續也可隨時儲存到 Google Drive。
                  </span>
                </div>
              </label>
              <label className="row mixer-modal-option" style={{ opacity: props.isGoogleConfigured && props.account ? 1 : 0.7 }}>
                <input
                  type="radio"
                  name="project-storage-provider"
                  checked={formProvider === "google_drive"}
                  onChange={() => setFormProvider("google_drive")}
                  disabled={isBusy || !props.isGoogleConfigured || !props.account}
                />
                <div className="grid" style={{ gap: 2, flex: 1 }}>
                  <strong style={{ fontSize: 13 }}>Google Drive 雲端專案</strong>
                  <span className="small" style={{ opacity: 0.78 }}>
                    直接寫入您帳戶的 .loopHarmonizer/projects/（不經後端伺服器），支援跨裝置清單、手動同步與衝突防護。
                  </span>
                  {(!props.isGoogleConfigured || !props.account) && (
                    <div className="row" style={{ gap: 8, marginTop: 4 }}>
                      <span className="small" style={{ color: "var(--warning)" }}>
                        {!props.isGoogleConfigured ? "未設定 Google OAuth 環境變數" : "尚未登入 Google 帳號"}
                      </span>
                      {props.isGoogleConfigured && !props.account && (
                        <button
                          type="button"
                          className="btn mixer-button"
                          style={{ padding: "3px 10px", fontSize: 12 }}
                          onClick={() => void props.onSignInGoogle()}
                        >
                          先登入 Google
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </label>
            </div>
            {mode === "save_as" && (
              <div className="small" style={{ opacity: 0.78 }}>
                {activeProject
                  ? "提示：另存新專案只複製專案混音設定與版本引用，不會複製 WAV 音檔與 Demucs 分軌快取。"
                  : "將保留目前工作空間的歌曲、混音設定與分軌快取，不會清除或覆蓋原有舊工作區資料。"}
              </div>
            )}
            <div className="row mixer-modal-actions">
              <button type="button" className="btn mixer-button" disabled={isBusy} onClick={props.onClose}>
                取消
              </button>
              <button type="submit" className="btn mixer-button primary" disabled={isBusy || !formName.trim()}>
                {isBusy ? "處理中…" : mode === "create" ? "建立專案" : activeProject ? "確認另存" : "建立並儲存專案"}
              </button>
            </div>
          </form>
        )}

        {mode === "rename" && (
          <form
            className="grid"
            style={{ gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              const targetId = props.renameTarget?.projectId ?? activeProject?.projectId;
              if (!targetId || !formName.trim() || isBusy) return;
              void props.onRenameProject({ projectId: targetId, name: formName.trim() });
            }}
          >
            <label className="grid" style={{ gap: 4 }}>
              <span className="small" style={{ fontWeight: 600 }}>新專案名稱 *</span>
              <input
                ref={nameInputRef}
                type="text"
                required
                maxLength={80}
                className="project-text-input"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={isBusy}
              />
            </label>
            <div className="row mixer-modal-actions">
              <button type="button" className="btn mixer-button" disabled={isBusy} onClick={props.onClose}>
                取消
              </button>
              <button type="submit" className="btn mixer-button primary" disabled={isBusy || !formName.trim()}>
                {isBusy ? "儲存中…" : "確認重新命名"}
              </button>
            </div>
          </form>
        )}

        {mode === "promote" && activeProject && (
          <div className="grid" style={{ gap: 12 }}>
            {!props.account && (
              <div role="status" className="card-warning-banner row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="small">
                  尚未登入 Google 帳號。登入後即可將此本機專案連結並儲存至 Google Drive（不會自動上傳其他本機專案）。
                </span>
                {props.isGoogleConfigured && (
                  <button
                    type="button"
                    className="btn mixer-button primary"
                    style={{ padding: "4px 12px", fontSize: 12, flexShrink: 0 }}
                    disabled={isBusy}
                    onClick={() => void props.onSignInGoogle()}
                  >
                    登入 Google 帳號
                  </button>
                )}
              </div>
            )}
            <div className="mixer-modal-section grid" style={{ gap: 6 }}>
              <strong style={{ fontSize: 13 }}>專案歌曲跨裝置備份狀態盤點（{activeProject.project.name}）</strong>
              <span className="small" style={{ opacity: 0.8 }}>
                僅有同時具備 Drive 原曲（或原曲備份）且已上傳指定分軌（或未分離）的歌曲，才會標記為「可跨裝置恢復」。
              </span>
              <div className="grid" style={{ gap: 6 }}>
                {activeProject.project.songs.length === 0 ? (
                  <span className="small" style={{ opacity: 0.7 }}>此專案目前沒有歌曲，將只上傳專案結構至 Google Drive。</span>
                ) : (
                  activeProject.project.songs.map((entry) => {
                    const st = computeEntryBackupStatus(entry, props.account?.accountId);
                    const badge = BACKUP_LABELS[st];
                    return (
                      <div key={entry.entryId} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span className="small">{entry.displayName}</span>
                        <span className={`song-storage-pill ${badge.toneClass}`}>{badge.label}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <label className="row mixer-modal-option">
              <input
                type="checkbox"
                checked={backupOriginals}
                onChange={(e) => setBackupOriginals(e.target.checked)}
                disabled={isBusy}
              />
              <div className="grid" style={{ gap: 2 }}>
                <strong style={{ fontSize: 13 }}>一併備份本機原始音檔到 Google Drive</strong>
                <span className="small" style={{ opacity: 0.78 }}>
                  上傳至 .loopHarmonizer/songs/song_&lt;hash&gt;/originals/；相同內容雜湊的檔案已存在時自動重用，不改變原 hash。
                </span>
              </div>
            </label>

            {props.promoteProgress && (
              <div className="grid mixer-modal-section" style={{ gap: 6 }}>
                <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span className="mixer-spinner" aria-hidden="true" />
                    <span className="small" style={{ color: "var(--cloud)" }}>{props.promoteProgress.message}</span>
                  </div>
                  <button type="button" className="btn mixer-abort-button" style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }} onClick={props.onCancelPromote}>
                    取消
                  </button>
                </div>
                <div className="mixer-progress-track is-indeterminate">
                  <div className="mixer-progress-fill" />
                </div>
              </div>
            )}

            {props.promoteBackupFailures.length > 0 && (
              <div role="alert" className="card-warning-banner grid" style={{ gap: 4 }}>
                <strong>部分原曲未能備份（專案已保存，這些歌曲標記為僅本機可用）：</strong>
                {props.promoteBackupFailures.map((f) => (
                  <span key={f.entryId} className="small">• {f.displayName}：{f.reason}</span>
                ))}
              </div>
            )}

            <div className="row mixer-modal-actions">
              <button type="button" className="btn mixer-button" disabled={isBusy} onClick={props.onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn mixer-button primary"
                disabled={isBusy || !props.account}
                title={!props.account ? "請先登入 Google 帳號" : undefined}
                onClick={() => void props.onPromoteToDrive({ backupLocalOriginals: backupOriginals })}
              >
                {isBusy ? "上傳與同步中…" : "確認儲存到 Google Drive"}
              </button>
            </div>
          </div>
        )}

        {mode === "offline" && activeProject && (
          <div className="grid" style={{ gap: 12 }}>
            {props.offlineAssessmentLoading ? (
              <div className="row mixer-modal-section" style={{ gap: 8, alignItems: "center" }}>
                <span className="mixer-spinner" aria-hidden="true" />
                <span className="small">正在檢查各首歌曲本機快取與估算所需容量…</span>
              </div>
            ) : props.offlineAssessment ? (
              <div className="mixer-modal-section grid" style={{ gap: 8 }}>
                <strong style={{ fontSize: 13 }}>離線下載容量評估</strong>
                <div className="small" style={{ opacity: 0.9 }}>
                  待下載歌曲：{props.offlineAssessment.songsToDownloadCount} 首 ｜ 本機已就緒：{props.offlineAssessment.alreadyLocalCount} 首 ｜ 僅舊裝置本機（無法下載）：{props.offlineAssessment.unavailableCount} 首
                </div>
                <div className="small" style={{ opacity: 0.9 }}>
                  預估網路下載：{formatMiB(props.offlineAssessment.estimatedDownloadBytes)} ｜ 預估寫入本機空間：{formatMiB(props.offlineAssessment.estimatedStorageBytes)} ｜ 瀏覽器剩餘空間：{formatMiB(props.offlineAssessment.storageRemainingBytes)}
                </div>
                {props.offlineAssessment.warnings.map((w, idx) => (
                  <div key={idx} className="card-warning-banner">{w}</div>
                ))}
                {props.offlineAssessment.perSongDetails.length > 0 && (
                  <div className="grid" style={{ gap: 4 }}>
                    {props.offlineAssessment.perSongDetails.map((d) => (
                      <div key={d.entryId} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span className="small">{d.displayName}</span>
                        <span className="small" style={{ opacity: 0.78 }}>
                          {d.unavailableReason || `${d.needsOriginal ? "原曲+" : ""}${d.needsStems ? "分軌 " : ""}${formatMiB(d.estimatedBytes)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {props.offlineDownloadProgress && (
              <div className="grid mixer-modal-section" style={{ gap: 6 }}>
                <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span className="mixer-spinner" aria-hidden="true" />
                    <span className="small" style={{ color: "var(--cloud)" }}>
                      ({props.offlineDownloadProgress.completedSongs}/{props.offlineDownloadProgress.totalSongs}) {props.offlineDownloadProgress.stageMessage}
                    </span>
                  </div>
                  <button type="button" className="btn mixer-abort-button" style={{ minHeight: 32, padding: "4px 10px", fontSize: 12 }} onClick={props.onCancelOfflineDownload}>
                    取消下載
                  </button>
                </div>
                <div className="mixer-progress-track">
                  <div
                    className="mixer-progress-fill"
                    style={{
                      width: `${props.offlineDownloadProgress.totalSongs > 0 ? Math.round((props.offlineDownloadProgress.completedSongs / props.offlineDownloadProgress.totalSongs) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {props.offlineDownloadResult && (
              <div role="status" className={props.offlineDownloadResult.failedSongs.length > 0 ? "card-warning-banner grid" : "mixer-modal-section grid"} style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>
                  {props.offlineDownloadResult.cancelled
                    ? `已取消剩餘下載（已完成 ${props.offlineDownloadResult.completedCount} 首）`
                    : `離線下載完成（完成 ${props.offlineDownloadResult.completedCount} 首，其中重用本機 ${props.offlineDownloadResult.reusedCount} 首）`}
                </strong>
                {props.offlineDownloadResult.failedSongs.map((f) => (
                  <span key={f.entryId} className="small">• {f.displayName}：{f.reason}</span>
                ))}
              </div>
            )}

            <div className="row mixer-modal-actions">
              <button type="button" className="btn mixer-button" disabled={Boolean(props.offlineDownloadProgress)} onClick={props.onClose}>
                關閉
              </button>
              <button
                type="button"
                className="btn mixer-button primary"
                disabled={
                  Boolean(props.offlineDownloadProgress) ||
                  props.offlineAssessmentLoading ||
                  !props.offlineAssessment ||
                  props.offlineAssessment.songsToDownloadCount === 0 ||
                  !props.account
                }
                onClick={() => void props.onStartOfflineDownload()}
              >
                {props.offlineDownloadProgress
                  ? "逐首下載中…"
                  : props.offlineAssessment && !props.offlineAssessmentLoading && props.offlineAssessment.songsToDownloadCount === 0
                    ? "所有可用歌曲均已本機就緒"
                    : "確認逐首下載並保存至本機"}
              </button>
            </div>
          </div>
        )}

        {mode === "conflict" && activeProject?.conflictInfo && (
          <div className="grid" style={{ gap: 12 }}>
            <div className="card-warning-banner grid" style={{ gap: 4 }}>
              <span>{activeProject.conflictInfo.reason}</span>
              {activeProject.conflictInfo.conflictSubType === "sibling_branch" &&
                activeProject.conflictInfo.siblingRevisions && (
                  <span className="small">
                    分支詳情：同父版本共發現 {activeProject.conflictInfo.siblingRevisions.length} 個保留中的不可變 Revision 快照，系統未進行任何自動合併或刪除。
                  </span>
                )}
              <span className="small" style={{ opacity: 0.8 }}>
                {DRIVE_CAS_LIMITATION_NOTE}
              </span>
            </div>
            <div className="project-conflict-grid">
              <div className="mixer-modal-section grid" style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>此裝置（本機版本）</strong>
                <span className="small">基底版本：v{activeProject.conflictInfo.localBaseRevision}</span>
                <span className="small">目前版本：v{activeProject.conflictInfo.localRevision}</span>
                <span className="small">歌曲數：{activeProject.project.songs.length} 首</span>
              </div>
              <div className="mixer-modal-section grid" style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>Google Drive（雲端版本）</strong>
                {activeProject.conflictInfo.kind === "remote_deleted" || !activeProject.conflictInfo.remoteProjectSnapshot ? (
                  <span className="small" style={{ color: "var(--danger)" }}>遠端專案檔案已刪除或移至垃圾桶（不會自動重建）。</span>
                ) : (
                  <>
                    <span className="small">雲端版本：v{activeProject.conflictInfo.remoteRevision}</span>
                    <span className="small">更新於：{formatTime(activeProject.conflictInfo.remoteUpdatedAt || "")}</span>
                    <span className="small">歌曲數：{activeProject.conflictInfo.remoteProjectSnapshot.songs.length} 首</span>
                  </>
                )}
              </div>
            </div>

            <label className="grid" style={{ gap: 4 }}>
              <span className="small" style={{ fontWeight: 600 }}>若選擇「保留本機另存新專案」的副本名稱</span>
              <input
                type="text"
                className="project-text-input"
                value={conflictSaveAsName}
                onChange={(e) => setConflictSaveAsName(e.target.value)}
                disabled={isBusy}
              />
            </label>

            <div className="row mixer-modal-actions">
              {activeProject.conflictInfo.remoteProjectSnapshot && (
                <button
                  type="button"
                  className="btn mixer-button"
                  disabled={isBusy}
                  onClick={() => void props.onResolveConflict({ strategy: "load_remote" })}
                >
                  載入雲端版本
                </button>
              )}
              <button
                type="button"
                className="btn mixer-button"
                disabled={isBusy}
                onClick={() =>
                  void props.onResolveConflict({
                    strategy: "save_local_as_new",
                    newProjectNameForSaveAs: conflictSaveAsName.trim() || undefined,
                  })
                }
              >
                保留本機另存新專案
              </button>
              <button
                type="button"
                className="btn mixer-abort-button"
                style={{ minHeight: 40, padding: "6px 14px", fontSize: 13 }}
                disabled={isBusy}
                onClick={() => void props.onResolveConflict({ strategy: "overwrite_remote" })}
              >
                以本機版本取代雲端
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
