"use client";

import {
  resolveProjectToolbarActions,
  resolveProjectToolbarStatus,
  type LocalSaveState,
  type ProjectToolbarBusyAction,
} from "@/lib/projects/projectToolbarModel";
import type { PersistedProjectRecord } from "@/lib/projects/projectTypes";
import type { SeparationJobState } from "@/lib/separation/separationJobManager";
import { IconActionButton } from "./IconActionButton";

export type ProjectBusyState = {
  action: ProjectToolbarBusyAction;
  message: string;
};

type Props = {
  activeProject: PersistedProjectRecord | null;
  songCount: number;
  hasLegacySongs: boolean;
  isGoogleConfigured: boolean;
  isGoogleSignedIn: boolean;
  hasValidGoogleToken: boolean;
  projectBusyState: ProjectBusyState | null;
  otherProjectJobs: readonly SeparationJobState[];
  localSaveState?: LocalSaveState;
  isSyncRunning?: boolean;
  onOpenProjectManager: () => void;
  onSaveProject: () => void;
  onSyncProject: () => void;
  onOpenConflict: () => void;
  onReauthorizeSync: () => void;
};

function ProjectFolderIcon() {
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

function CloudSyncIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 13v8" />
      <path d="m8 17 4-4 4 4" />
      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    </svg>
  );
}

export function ProjectToolbar(props: Props) {
  const { activeProject, projectBusyState } = props;
  const toolbarInput = {
    activeProject,
    songCount: props.songCount,
    hasLegacySongs: props.hasLegacySongs,
    isGoogleConfigured: props.isGoogleConfigured,
    isGoogleSignedIn: props.isGoogleSignedIn,
    hasValidGoogleToken: props.hasValidGoogleToken,
    localSaveState: props.localSaveState,
    busyAction: projectBusyState?.action ?? null,
    busyMessage: projectBusyState?.message ?? null,
    isSyncRunning: props.isSyncRunning,
  };

  const statusView = resolveProjectToolbarStatus(toolbarInput);
  const actions = resolveProjectToolbarActions(toolbarInput);

  const iconForAction = (key: "project" | "save" | "sync", busy: boolean) => {
    if (busy) return <span className="mixer-spinner" aria-hidden="true" />;
    if (key === "project") return <ProjectFolderIcon />;
    if (key === "save") return <SaveProjectIcon />;
    return <CloudSyncIcon />;
  };

  const handlerForAction = (key: "project" | "save" | "sync") => {
    if (key === "project") return props.onOpenProjectManager;
    if (key === "save") return props.onSaveProject;
    return props.onSyncProject;
  };

  return (
    <section className="card project-toolbar" aria-label="專案管理工具列">
      <div className="project-toolbar-main">
        <div className="project-identity">
          <div className="project-title-line">
            <span className="project-kicker">目前專案：</span>
            <strong
              className="project-name-text"
              title={activeProject?.project.name ?? "預設工作空間（尚未建立專案）"}
            >
              {activeProject ? activeProject.project.name : "預設工作空間"}
            </strong>
            <span
              className={`project-provider-badge ${activeProject?.storageProvider === "google_drive" ? "is-drive" : "is-local"}`}
            >
              {activeProject?.storageProvider === "google_drive" ? "Google Drive" : "本機"}
            </span>
          </div>
          <div className="project-meta-line">
            <span
              role="status"
              aria-live="polite"
              className={`project-sync-pill ${statusView.toneClass}`}
              title={statusView.tooltip}
            >
              {statusView.spinning && <span className="mixer-spinner" aria-hidden="true" />}
              <span>{statusView.text}</span>
            </span>
            <span className="small" style={{ opacity: 0.72, whiteSpace: "nowrap" }}>
              {activeProject
                ? `v${activeProject.project.revision} · ${props.songCount} 首歌`
                : `${props.songCount} 首歌`}
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
          {actions.map((action) => (
            <IconActionButton
              key={action.key}
              icon={iconForAction(action.key, action.busy)}
              text={action.text}
              label={action.ariaLabel}
              tooltipPlacement="bottom"
              busy={action.busy}
              disabled={action.disabled}
              disabledReason={action.disabledReason}
              primary={action.primary}
              onClick={handlerForAction(action.key)}
            />
          ))}
        </div>
      </div>

      {activeProject?.syncStatus === "conflict" && (
        <div role="alert" className="card-warning-banner project-alert-row">
          <span>
            {activeProject.conflictInfo?.reason || "偵測到跨裝置專案版本衝突，已安全保留雙方變更並停止靜默覆寫。"}
          </span>
          <button
            type="button"
            className="btn mixer-button primary"
            style={{ padding: "5px 12px", fontSize: 12 }}
            onClick={props.onOpenConflict}
          >
            處理版本衝突
          </button>
        </div>
      )}

      {activeProject?.syncStatus === "waiting_auth" && (
        <div role="status" aria-live="polite" className="card-warning-banner project-alert-row">
          <span>
            {activeProject.lastError || "Google 授權已過期，變更已妥善保存於本機 IndexedDB。"}
          </span>
          <button
            type="button"
            className="btn mixer-button primary"
            style={{ padding: "5px 12px", fontSize: 12 }}
            onClick={props.onReauthorizeSync}
          >
            {props.isGoogleSignedIn ? "重新授權並同步" : "登入 Google 並同步"}
          </button>
        </div>
      )}

      {activeProject?.syncStatus === "error" && activeProject.lastError && (
        <div role="status" aria-live="polite" className="card-warning-banner project-alert-row">
          <span>雲端同步待處理（本機資料安全保留）：{activeProject.lastError}</span>
          <button
            type="button"
            className="btn mixer-button"
            style={{ padding: "5px 12px", fontSize: 12 }}
            onClick={props.onSyncProject}
          >
            重新同步
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
