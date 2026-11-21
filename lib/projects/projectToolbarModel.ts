import type {
  PersistedProjectRecord,
  ProjectStorageProvider,
} from "./projectTypes.ts";

export type LocalSaveState = "idle" | "saving" | "saved" | "error";

export type ProjectToolbarBusyAction =
  | "open"
  | "create"
  | "save"
  | "save_as"
  | "rename"
  | "promote"
  | "sync"
  | "delete"
  | "migrate"
  | "conflict";

export interface ProjectToolbarStateInput {
  activeProject: PersistedProjectRecord | null;
  songCount: number;
  hasLegacySongs: boolean;
  isGoogleConfigured: boolean;
  isGoogleSignedIn: boolean;
  hasValidGoogleToken: boolean;
  localSaveState?: LocalSaveState;
  busyAction?: ProjectToolbarBusyAction | null;
  busyMessage?: string | null;
  isSyncRunning?: boolean;
}

export type SaveActionIntent =
  | "save_active_local"
  | "guide_create_project"
  | "disabled_empty"
  | "disabled_busy";

export type SyncActionIntent =
  | "sync_drive"
  | "guide_promote_to_drive"
  | "guide_promote_sign_in"
  | "guide_google_sign_in"
  | "open_conflict"
  | "disabled_no_project"
  | "disabled_unconfigured"
  | "disabled_busy";

export interface ProjectToolbarStatusView {
  text: string;
  toneClass:
    | "is-local"
    | "is-synced"
    | "is-dirty"
    | "is-syncing"
    | "is-warn"
    | "is-conflict"
    | "is-error";
  spinning: boolean;
  tooltip: string;
}

export interface ProjectToolbarActionDescriptor {
  key: "project" | "save" | "sync";
  text: "專案" | "儲存" | "同步";
  ariaLabel: string;
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  primary?: boolean;
}

export function resolveSaveActionIntent(
  input: ProjectToolbarStateInput,
): SaveActionIntent {
  if (input.busyAction) return "disabled_busy";
  if (input.activeProject) return "save_active_local";
  if (input.songCount > 0) return "guide_create_project";
  return "disabled_empty";
}

export function resolveSyncActionIntent(
  input: ProjectToolbarStateInput,
): SyncActionIntent {
  if (
    input.isSyncRunning ||
    input.busyAction ||
    input.activeProject?.syncStatus === "syncing"
  ) {
    return "disabled_busy";
  }
  if (!input.activeProject) return "disabled_no_project";
  if (!input.isGoogleConfigured) return "disabled_unconfigured";
  if (input.activeProject.storageProvider !== "google_drive") {
    return input.isGoogleSignedIn
      ? "guide_promote_to_drive"
      : "guide_promote_sign_in";
  }
  if (input.activeProject.syncStatus === "conflict") return "open_conflict";
  if (!input.isGoogleSignedIn || !input.hasValidGoogleToken) {
    return "guide_google_sign_in";
  }
  return "sync_drive";
}

export function resolveProjectToolbarStatus(
  input: ProjectToolbarStateInput,
): ProjectToolbarStatusView {
  const { activeProject } = input;
  if (!activeProject) {
    if (input.songCount > 0) {
      return {
        text: "尚未建立專案 · 目前工作區有歌曲",
        toneClass: "is-local",
        spinning: false,
        tooltip: "點擊「儲存」可將目前歌曲與設定建立為正式專案",
      };
    }
    if (input.hasLegacySongs) {
      return {
        text: "尚未建立專案 · 可遷移舊工作區",
        toneClass: "is-local",
        spinning: false,
        tooltip: "可從「專案」遷移既有預設工作空間",
      };
    }
    return {
      text: "尚未建立專案",
      toneClass: "is-local",
      spinning: false,
      tooltip: "點擊「專案」建立或開啟專案",
    };
  }

  let localText = "本機已儲存";
  let localTone: ProjectToolbarStatusView["toneClass"] | null = null;
  let localSpin = false;

  if (input.busyAction === "save" || input.localSaveState === "saving") {
    localText = "儲存中";
    localTone = "is-syncing";
    localSpin = true;
  } else if (input.localSaveState === "error") {
    localText = "儲存失敗";
    localTone = "is-error";
  }

  if (activeProject.storageProvider === "local") {
    if (localSpin) {
      return {
        text: "儲存中…",
        toneClass: "is-syncing",
        spinning: true,
        tooltip: "正在保存本機專案至 IndexedDB",
      };
    }
    if (localTone === "is-error") {
      return {
        text: "儲存失敗",
        toneClass: "is-error",
        spinning: false,
        tooltip: "寫入本機資料庫失敗，請稍後再試",
      };
    }
    return {
      text: "本機已儲存 · 僅存於本機",
      toneClass: "is-local",
      spinning: false,
      tooltip: "專案設定已儲存於本機 IndexedDB；點擊「同步」可設定 Google Drive 同步",
    };
  }

  let cloudText = "尚未同步";
  let cloudTone: ProjectToolbarStatusView["toneClass"] = "is-dirty";
  let cloudSpin = false;

  if (
    input.busyAction === "sync" ||
    input.isSyncRunning ||
    activeProject.syncStatus === "syncing"
  ) {
    cloudText = "雲端同步中";
    cloudTone = "is-syncing";
    cloudSpin = true;
  } else {
    switch (activeProject.syncStatus) {
      case "synced":
        cloudText = "雲端已同步";
        cloudTone = "is-synced";
        break;
      case "dirty":
        cloudText = "尚未同步";
        cloudTone = "is-dirty";
        break;
      case "waiting_auth":
        cloudText = "需要重新授權";
        cloudTone = "is-warn";
        break;
      case "conflict":
        cloudText = "版本衝突";
        cloudTone = "is-conflict";
        break;
      case "error":
        cloudText = "同步失敗";
        cloudTone = "is-error";
        break;
      default:
        cloudText = "尚未同步";
        cloudTone = "is-dirty";
        break;
    }
  }

  const text = `${localText} · ${cloudText}`;
  return {
    text,
    toneClass: localTone ?? cloudTone,
    spinning: localSpin || cloudSpin,
    tooltip: activeProject.lastError || text,
  };
}

export function resolveProjectToolbarActions(
  input: ProjectToolbarStateInput,
): readonly [
  ProjectToolbarActionDescriptor,
  ProjectToolbarActionDescriptor,
  ProjectToolbarActionDescriptor,
] {
  const projectAction: ProjectToolbarActionDescriptor = {
    key: "project",
    text: "專案",
    ariaLabel: "開啟專案管理（開啟、新增、另存、重新命名、遷移與刪除）",
    busy: input.busyAction === "open",
    disabled: Boolean(input.busyAction),
    disabledReason: input.busyAction
      ? input.busyMessage || "專案操作進行中，請稍候"
      : undefined,
  };

  const saveIntent = resolveSaveActionIntent(input);
  let saveAction: ProjectToolbarActionDescriptor;
  switch (saveIntent) {
    case "save_active_local":
      saveAction = {
        key: "save",
        text: "儲存",
        ariaLabel: "儲存至本機（僅寫入本機 IndexedDB，不同步 Google Drive）",
        busy: input.busyAction === "save",
        disabled: false,
      };
      break;
    case "guide_create_project":
      saveAction = {
        key: "save",
        text: "儲存",
        ariaLabel: "將目前歌曲與設定建立為正式專案（儲存至本機）",
        busy: input.busyAction === "save",
        disabled: false,
      };
      break;
    case "disabled_empty":
      saveAction = {
        key: "save",
        text: "儲存",
        ariaLabel: "儲存本機專案",
        busy: false,
        disabled: true,
        disabledReason: "尚未建立專案且目前無歌曲，請先載入歌曲或從「專案」建立專案",
      };
      break;
    case "disabled_busy":
      saveAction = {
        key: "save",
        text: "儲存",
        ariaLabel: "儲存本機專案",
        busy: input.busyAction === "save",
        disabled: true,
        disabledReason: input.busyMessage || "專案操作進行中，請稍候",
      };
      break;
  }

  const syncIntent = resolveSyncActionIntent(input);
  const syncBusy = Boolean(
    input.isSyncRunning ||
      input.busyAction === "sync" ||
      input.activeProject?.syncStatus === "syncing",
  );
  let syncAction: ProjectToolbarActionDescriptor;
  switch (syncIntent) {
    case "sync_drive":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "同步專案至 Google Drive",
        busy: syncBusy,
        disabled: false,
      };
      break;
    case "guide_promote_to_drive":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "連結 Google Drive 並設定雲端同步",
        busy: syncBusy,
        disabled: false,
      };
      break;
    case "guide_promote_sign_in":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "登入 Google 帳號以設定雲端同步",
        busy: syncBusy,
        disabled: false,
      };
      break;
    case "guide_google_sign_in":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: input.isGoogleSignedIn
          ? "重新授權 Google 帳號並同步專案"
          : "登入 Google 帳號以同步專案",
        busy: syncBusy,
        disabled: false,
      };
      break;
    case "open_conflict":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "檢視並處理 Google Drive 版本衝突",
        busy: syncBusy,
        disabled: false,
      };
      break;
    case "disabled_no_project":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "同步專案至 Google Drive",
        busy: false,
        disabled: true,
        disabledReason:
          input.songCount > 0
            ? "請先按「儲存」建立專案後，再同步至 Google Drive"
            : "請先建立或開啟專案後，再同步至 Google Drive",
      };
      break;
    case "disabled_unconfigured":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "同步專案至 Google Drive",
        busy: false,
        disabled: true,
        disabledReason: "尚未設定 Google OAuth 環境變數，無法使用雲端同步",
      };
      break;
    case "disabled_busy":
      syncAction = {
        key: "sync",
        text: "同步",
        ariaLabel: "同步專案至 Google Drive",
        busy: syncBusy,
        disabled: true,
        disabledReason: input.busyMessage || "同步進行中，請稍候",
      };
      break;
  }

  return [projectAction, saveAction, syncAction] as const;
}

export interface ProjectManagerActionDescriptor {
  key:
    | "open"
    | "create"
    | "save_as"
    | "rename_active"
    | "migrate_legacy"
    | "offline_download"
    | "promote_drive"
    | "return_legacy"
    | "delete_active";
  label: string;
  tier: "primary" | "secondary" | "danger";
  visible: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export function resolveProjectManagerActionGroups(params: {
  activeProject: PersistedProjectRecord | null;
  songCount: number;
  hasLegacyWorkspaceSongs: boolean;
  isGoogleConfigured: boolean;
  focusLocked: boolean;
  isBusy: boolean;
}): {
  primary: ProjectManagerActionDescriptor[];
  secondary: ProjectManagerActionDescriptor[];
  danger: ProjectManagerActionDescriptor[];
} {
  const {
    activeProject,
    songCount,
    hasLegacyWorkspaceSongs,
    isGoogleConfigured,
    focusLocked,
    isBusy,
  } = params;

  const primary: ProjectManagerActionDescriptor[] = [
    {
      key: "open",
      label: "開啟專案",
      tier: "primary",
      visible: true,
      disabled: isBusy,
    },
    {
      key: "create",
      label: "新增專案",
      tier: "primary",
      visible: true,
      disabled: isBusy,
    },
  ];

  const secondary: ProjectManagerActionDescriptor[] = [
    {
      key: "save_as",
      label: "另存新專案",
      tier: "secondary",
      visible: true,
      disabled: isBusy || (!activeProject && songCount === 0),
      disabledReason:
        !activeProject && songCount === 0 ? "目前無歌曲可另存" : undefined,
    },
    {
      key: "rename_active",
      label: "重新命名目前專案",
      tier: "secondary",
      visible: Boolean(activeProject),
      disabled: isBusy,
    },
    {
      key: "migrate_legacy",
      label: "遷移舊工作區",
      tier: "secondary",
      visible: hasLegacyWorkspaceSongs,
      disabled: isBusy,
    },
    {
      key: "offline_download",
      label: "離線下載",
      tier: "secondary",
      visible: activeProject?.storageProvider === "google_drive",
      disabled: isBusy || focusLocked || songCount === 0,
      disabledReason: focusLocked
        ? "分離專注模式啟動中，暫停整套專案離線下載"
        : songCount === 0
          ? "目前專案尚無歌曲"
          : undefined,
    },
    {
      key: "promote_drive",
      label: "連結 Google Drive",
      tier: "secondary",
      visible:
        Boolean(activeProject) &&
        activeProject?.storageProvider === "local" &&
        isGoogleConfigured,
      disabled: isBusy,
    },
    {
      key: "return_legacy",
      label: "返回預設工作空間",
      tier: "secondary",
      visible: Boolean(activeProject),
      disabled: isBusy || focusLocked,
      disabledReason: focusLocked
        ? "分離專注模式啟動中，暫時無法切換工作空間"
        : undefined,
    },
  ];

  const danger: ProjectManagerActionDescriptor[] = [
    {
      key: "delete_active",
      label: "刪除目前專案",
      tier: "danger",
      visible: Boolean(activeProject),
      disabled: isBusy,
    },
  ];

  return { primary, secondary, danger };
}

export interface DeleteProjectConfirmConfig {
  title: string;
  subtitle: string;
  deleteItems: string[];
  preserveItems: string[];
  safetyNote: string;
  recoverability: string;
  checkboxLabel?: string;
  checkboxDescription?: string;
  confirmLabel: string;
  danger: true;
}

export function buildDeleteProjectConfirmConfig(target: {
  projectId: string;
  name: string;
  storageProvider: ProjectStorageProvider;
}): DeleteProjectConfirmConfig {
  const isCloud = target.storageProvider === "google_drive";
  return {
    title: "刪除專案",
    subtitle: target.name,
    deleteItems: [
      "將移除此專案結構、歌曲清單引用與各曲混音設定（BPM、Key、音量、Mute/Solo、Loop）。",
      "此專案的本機 IndexedDB Metadata、排序紀錄與專案同步佇列。",
      ...(isCloud
        ? [
            "若勾選下方選項：將同時把 Google Drive 上此專案的專案資料夾（project.json 與 revisions）移至垃圾桶。",
          ]
        : []),
    ],
    preserveItems: [
      "所有歌曲原始音檔（本機 IndexedDB audioFiles 與 Google Drive Picker 原曲）。",
      "所有共用 Demucs 分軌成果、Chunk Checkpoint、Imported Stem 與 Google Drive .loopHarmonizer/songs/ 成果庫。",
      "其他專案及原有舊版預設 Band Mixer 工作階段。",
    ],
    safetyNote: isCloud
      ? "是否影響 Google Drive：預設僅刪除本機快取，不會影響 Google Drive；僅當勾選下方選項時，才會將此專案的 Drive 資料夾移至垃圾桶（共用歌曲成果庫仍完整保留）。"
      : "是否影響 Google Drive：否。此為純本機專案，刪除不會影響任何 Google Drive 檔案或帳戶資料。",
    recoverability: isCloud
      ? "可恢復性：僅刪除本機時，雲端仍完整保留，隨時可從專案管理重新開啟；若同時刪除雲端專案，需至 Google Drive 垃圾桶手動復原。"
      : "可恢復性：本機專案設定移除後無法直接復原，但歌曲原始音檔與已完成分軌均完整保留，隨時可建立新專案重新加入。",
    checkboxLabel: isCloud
      ? "同時刪除 Google Drive 上的雲端專案資料夾"
      : undefined,
    checkboxDescription: isCloud
      ? "只會將目前帳號管理的此專案資料夾移至 Drive 垃圾桶；絕不刪除共用歌曲成果庫與其他專案仍使用的原曲/分軌。"
      : undefined,
    confirmLabel: "確認刪除專案",
    danger: true,
  };
}
