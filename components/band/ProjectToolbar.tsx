"use client";

import type { PersistedProjectRecord, ProjectSyncStatus } from "@/lib/projects/projectTypes";
import type { SeparationJobState } from "@/lib/separation/separationJobManager";
import { AdaptiveActionRow, type AdaptiveActionItem } from "./AdaptiveActionRow";
import { IconActionButton } from "./IconActionButton";

export type ProjectBusyState = {
  action: "open" | "create" | "save" | "save_as" | "rename" | "promote" | "sync" | "delete" | "migrate" | "conflict";
  message: string;
};

type Props = {
  activeProject: PersistedProjectRecord | null;
  songCount: number;
  hasLegacySongs: boolean;
  isGoogleConfigured: boolean;
  projectBusyState: ProjectBusyState | null;
  focusLocked: boolean;
  otherProjectJobs: readonly SeparationJobState[];
  onNewProject: () => void;
  onOpenProjectList: () => void;
  onSaveProject: () => void;
  onSaveAsProject: () => void;
  onPromoteToDrive: () => void;
  onOpenOfflineDownload: () => void;
  onMigrateLegacy: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
  onOpenConflict: () => void;
  onReauthorizeSync: () => void;
  onReturnToLegacyWorkspace?: () => void;
};

const SYNC_STATUS_META: Record<ProjectSyncStatus, { label: string; toneClass: string }> = {
  local_only: { label: "已儲存於本機", toneClass: "is-local" },
  synced: { label: "已同步至 Drive", toneClass: "is-synced" },
  dirty: { label: "尚未同步", toneClass: "is-dirty" },
  syncing: { label: "同步中…", toneClass: "is-syncing" },
  waiting_auth: { label: "需要重新授權", toneClass: "is-warn" },
  conflict: { label: "有版本衝突", toneClass: "is-conflict" },
  error: { label: "同步失敗", toneClass: "is-error" },
};

function NewProjectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function OpenProjectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function SaveProjectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </svg>
  );
}

function SaveAsProjectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function PromoteDriveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 13v8" />
      <path d="m8 17 4-4 4 4" />
      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    </svg>
  );
}

function OfflineDownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

export function ProjectToolbar(props: Props) {
  const { activeProject, projectBusyState } = props;
  const isBusy = Boolean(projectBusyState);
  const isSyncing = Boolean(activeProject?.syncStatus === "syncing" || projectBusyState?.action === "save" || projectBusyState?.action === "sync");
  const syncMeta = activeProject
    ? SYNC_STATUS_META[activeProject.syncStatus]
    : { label: props.hasLegacySongs ? "未納入專案（僅本機工作階段）" : "尚未建立專案", toneClass: "is-local" };

  const disabledAll = isBusy;

  const actionItems: AdaptiveActionItem[] = [
    {
      key: "new-project",
      label: "新增專案",
      disabled: disabledAll,
      disabledReason: isBusy ? projectBusyState?.message : undefined,
      onSelect: props.onNewProject,
      renderInline: () => (
        <IconActionButton
          icon={<NewProjectIcon />}
          label="新增專案"
          disabled={disabledAll}
          disabledReason={isBusy ? projectBusyState?.message : undefined}
          onClick={props.onNewProject}
        />
      ),
    },
    {
      key: "open-project",
      label: "開啟專案",
      disabled: disabledAll,
      disabledReason: isBusy ? projectBusyState?.message : undefined,
      onSelect: props.onOpenProjectList,
      renderInline: () => (
        <IconActionButton
          icon={projectBusyState?.action === "open" ? <span className="mixer-spinner" aria-hidden="true" /> : <OpenProjectIcon />}
          label="開啟專案清單"
          busy={projectBusyState?.action === "open"}
          disabled={disabledAll}
          disabledReason={isBusy ? projectBusyState?.message : undefined}
          onClick={props.onOpenProjectList}
        />
      ),
    },
    {
      key: "save-project",
      label: activeProject?.storageProvider === "google_drive" ? "立即儲存並同步" : "儲存專案",
      disabled: disabledAll || (!activeProject && !props.hasLegacySongs),
      disabledReason: isBusy
        ? projectBusyState?.message
        : !activeProject && !props.hasLegacySongs
          ? "請先新增專案或載入歌曲後再儲存"
          : undefined,
      onSelect: activeProject ? props.onSaveProject : props.onMigrateLegacy,
      renderInline: () => (
        <IconActionButton
          icon={isSyncing ? <span className="mixer-spinner" aria-hidden="true" /> : <SaveProjectIcon />}
          label={activeProject ? (activeProject.storageProvider === "google_drive" ? "儲存並同步專案" : "儲存本機專案") : "將目前工作空間另存為專案"}
          busy={isSyncing}
          disabled={disabledAll || (!activeProject && !props.hasLegacySongs)}
          disabledReason={isBusy ? projectBusyState?.message : (!activeProject && !props.hasLegacySongs ? "請先新增專案或載入歌曲" : undefined)}
          onClick={activeProject ? props.onSaveProject : props.onMigrateLegacy}
        />
      ),
    },
    {
      key: "save-as-project",
      label: "另存新專案",
      disabled: disabledAll || (!activeProject && props.songCount === 0),
      disabledReason: isBusy ? projectBusyState?.message : (!activeProject && props.songCount === 0 ? "目前無歌曲可另存" : undefined),
      onSelect: props.onSaveAsProject,
      renderInline: () => (
        <IconActionButton
          icon={projectBusyState?.action === "save_as" ? <span className="mixer-spinner" aria-hidden="true" /> : <SaveAsProjectIcon />}
          label="另存新專案"
          busy={projectBusyState?.action === "save_as"}
          disabled={disabledAll || (!activeProject && props.songCount === 0)}
          disabledReason={isBusy ? projectBusyState?.message : (!activeProject && props.songCount === 0 ? "目前無歌曲可另存" : undefined)}
          onClick={props.onSaveAsProject}
        />
      ),
    },
    ...(activeProject && activeProject.storageProvider === "local" && props.isGoogleConfigured
      ? ([
          {
            key: "promote-drive",
            label: "儲存到 Google Drive",
            disabled: disabledAll,
            disabledReason: isBusy ? projectBusyState?.message : undefined,
            onSelect: props.onPromoteToDrive,
            renderInline: () => (
              <IconActionButton
                icon={projectBusyState?.action === "promote" ? <span className="mixer-spinner" aria-hidden="true" /> : <PromoteDriveIcon />}
                label="儲存此專案到 Google Drive"
                busy={projectBusyState?.action === "promote"}
                disabled={disabledAll}
                disabledReason={isBusy ? projectBusyState?.message : undefined}
                onClick={props.onPromoteToDrive}
              />
            ),
          },
        ] satisfies AdaptiveActionItem[])
      : []),
    ...(activeProject && activeProject.storageProvider === "google_drive"
      ? ([
          {
            key: "offline-download",
            label: "下載整個專案供離線使用",
            disabled: disabledAll || props.focusLocked || props.songCount === 0,
            disabledReason: props.focusLocked ? "分離專注模式啟動中，暫停整套專案離線下載" : undefined,
            onSelect: props.onOpenOfflineDownload,
            renderInline: () => (
              <IconActionButton
                icon={<OfflineDownloadIcon />}
                label="下載整個專案供離線使用"
                disabled={disabledAll || props.focusLocked || props.songCount === 0}
                disabledReason={props.focusLocked ? "分離專注模式啟動中，暫停整套專案離線下載" : undefined}
                onClick={props.onOpenOfflineDownload}
              />
            ),
          },
        ] satisfies AdaptiveActionItem[])
      : []),
    ...(!activeProject && props.hasLegacySongs
      ? ([
          {
            key: "migrate-legacy",
            label: "將目前工作空間另存為專案",
            disabled: disabledAll,
            onSelect: props.onMigrateLegacy,
            renderInline: () => (
              <IconActionButton
                icon="📦"
                label="將目前工作空間另存為專案（保留原有紀錄）"
                disabled={disabledAll}
                onClick={props.onMigrateLegacy}
              />
            ),
          },
        ] satisfies AdaptiveActionItem[])
      : []),
    ...(activeProject
      ? ([
          {
            key: "rename-project",
            label: "重新命名專案",
            disabled: disabledAll,
            onSelect: props.onRenameProject,
            renderInline: () => (
              <IconActionButton
                icon={<RenameIcon />}
                label="重新命名專案"
                disabled={disabledAll}
                onClick={props.onRenameProject}
              />
            ),
          },
          {
            key: "delete-project",
            label: "刪除專案",
            danger: true,
            disabled: disabledAll,
            onSelect: props.onDeleteProject,
            renderInline: () => (
              <IconActionButton
                icon="🗑"
                label="刪除目前專案"
                danger
                disabled={disabledAll}
                onClick={props.onDeleteProject}
              />
            ),
          },
          ...(props.onReturnToLegacyWorkspace
            ? ([
                {
                  key: "exit-project-workspace",
                  label: "返回預設單一工作空間",
                  disabled: disabledAll || props.focusLocked,
                  onSelect: props.onReturnToLegacyWorkspace,
                  renderInline: () => (
                    <IconActionButton
                      icon="↩"
                      label="返回預設工作空間"
                      disabled={disabledAll || props.focusLocked}
                      onClick={() => props.onReturnToLegacyWorkspace?.()}
                    />
                  ),
                },
              ] satisfies AdaptiveActionItem[])
            : []),
        ] satisfies AdaptiveActionItem[])
      : []),
  ];

  return (
    <section className="card project-toolbar" aria-label="專案管理工具列">
      <div className="project-toolbar-main">
        <div className="project-identity">
          <div className="project-title-line">
            <span className="project-kicker">目前專案：</span>
            <strong className="project-name-text" title={activeProject?.project.name ?? "預設工作空間（尚未建立專案）"}>
              {activeProject ? activeProject.project.name : "預設工作空間"}
            </strong>
            <span className={`project-provider-badge ${activeProject?.storageProvider === "google_drive" ? "is-drive" : "is-local"}`}>
              {activeProject?.storageProvider === "google_drive" ? "Google Drive" : "本機"}
            </span>
          </div>
          <div className="project-meta-line">
            <span className={`project-sync-pill ${syncMeta.toneClass}`} title={activeProject?.lastError || syncMeta.label}>
              {activeProject?.syncStatus === "syncing" && <span className="mixer-spinner" aria-hidden="true" />}
              <span>{syncMeta.label}</span>
            </span>
            <span className="small" style={{ opacity: 0.72, whiteSpace: "nowrap" }}>
              {activeProject ? `v${activeProject.project.revision} · ${props.songCount} 首歌` : `${props.songCount} 首歌`}
            </span>
            {projectBusyState && (
              <span role="status" aria-live="polite" className="project-busy-pill">
                <span className="mixer-spinner" aria-hidden="true" />
                <span>{projectBusyState.message}</span>
              </span>
            )}
          </div>
        </div>

        <div className="project-toolbar-actions">
          <AdaptiveActionRow items={actionItems} />
        </div>
      </div>

      {activeProject?.syncStatus === "conflict" && (
        <div role="alert" className="card-warning-banner project-alert-row">
          <span>
            {activeProject.conflictInfo?.reason || "偵測到跨裝置專案版本衝突，已安全保留雙方變更並停止靜默覆寫。"}
          </span>
          <button type="button" className="btn mixer-button primary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={props.onOpenConflict}>
            處理版本衝突
          </button>
        </div>
      )}

      {activeProject?.syncStatus === "waiting_auth" && (
        <div role="status" aria-live="polite" className="card-warning-banner project-alert-row">
          <span>
            {activeProject.lastError || "Google 授權已過期，變更已妥善保存於本機 IndexedDB。"}
          </span>
          <button type="button" className="btn mixer-button primary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={props.onReauthorizeSync}>
            重新授權並同步
          </button>
        </div>
      )}

      {activeProject?.syncStatus === "error" && activeProject.lastError && (
        <div role="status" aria-live="polite" className="card-warning-banner project-alert-row">
          <span>雲端同步待處理（本機資料安全保留）：{activeProject.lastError}</span>
          <button type="button" className="btn mixer-button" style={{ padding: "5px 12px", fontSize: 12 }} onClick={props.onSaveProject}>
            立即重試同步
          </button>
        </div>
      )}

      {props.otherProjectJobs.length > 0 && (
        <div role="status" aria-live="polite" className="project-other-jobs-note">
          <span className="mixer-spinner" aria-hidden="true" />
          <span>
            背景分軌進行中（其他專案）：
            {props.otherProjectJobs.map((j) => `${j.songName || j.songId} (${Math.round((j.progress || 0) * 100)}%)`).join("、")}
            ；完成後會自動寫回原專案，不會影響目前混音畫面。
          </span>
        </div>
      )}
    </section>
  );
}
