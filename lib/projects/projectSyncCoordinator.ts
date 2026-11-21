import {
  getProjectRecord,
  isProjectDeleted,
} from "../storage/projectStore.ts";
import { ProjectAutoSyncController, type ProjectDriveSyncOutcome } from "./projectDriveSync.ts";
import {
  resolveSyncActionIntent,
  type LocalSaveState,
  type ProjectToolbarBusyAction,
} from "./projectToolbarModel.ts";
import type { PersistedProjectRecord } from "./projectTypes.ts";

export interface CoordinatorAuthSnapshot {
  accountId: string | null;
  accessToken: string | null;
  generation: number;
}

export interface ProjectManualSyncCoordinatorDeps {
  getActiveProject: () => PersistedProjectRecord | null;
  getSongCount: () => number;
  getHasLegacySongs: () => boolean;
  isGoogleConfigured: () => boolean;
  getExternalBusyAction: () => ProjectToolbarBusyAction | null;
  getAuthSnapshot: () => CoordinatorAuthSnapshot;
  getSyncController: () => ProjectAutoSyncController | null;
  signInGoogle: () => Promise<CoordinatorAuthSnapshot>;
  reauthorizeGoogle: () => Promise<CoordinatorAuthSnapshot>;
  captureLatestSnapshot: (projectId: string) => void;
  getProjectRecordFn?: typeof getProjectRecord;
  isProjectDeletedFn?: typeof isProjectDeleted;
  onBusyChange?: (busy: { action: ProjectToolbarBusyAction; message: string } | null) => void;
  onLocalSaveStateChange?: (projectId: string, state: LocalSaveState) => void;
  onFreshRecordLoaded?: (record: PersistedProjectRecord) => void;
}

export type ManualSyncFlowResult =
  | { kind: "no_project"; message: string }
  | { kind: "unconfigured"; message: string }
  | { kind: "open_promote"; needsSignIn: boolean; message?: string }
  | { kind: "open_conflict"; record?: PersistedProjectRecord; message: string }
  | { kind: "auth_cancelled"; message: string }
  | { kind: "auth_failed"; message: string }
  | {
      kind: "account_mismatch";
      expectedAccountId: string;
      actualAccountId: string;
      message: string;
    }
  | {
      kind: "aborted";
      reason:
        | "stale_operation"
        | "project_switched"
        | "project_deleted"
        | "provider_changed"
        | "auth_changed"
        | "external_busy";
      message?: string;
    }
  | { kind: "ignored"; reason: string }
  | {
      kind: "synced_outcome";
      projectId: string;
      outcome: ProjectDriveSyncOutcome | null;
      localSaveFailed: boolean;
    };

/**
 * 手動 Google Drive 同步編排器（Auth-First + Single-Flight + Cross-Account / Switch Guards）：
 * - 所有狀態皆透過 Live getters 讀取，絕不依賴 React render closure 中過期的 activeProject / busyState。
 * - 若 Sync Intent 為 `guide_google_sign_in`，在呼叫 `syncProjectManually()` 前先啟動 Google 登入/重新授權。
 * - 授權完成後完整重驗操作世代、作用中專案 ID、帳戶擁有者一致性、IDB tombstone 與衝突狀態後才執行一次同步。
 */
export class ProjectManualSyncCoordinator {
  private readonly deps: ProjectManualSyncCoordinatorDeps;
  private opSeq = 0;
  private activeOperation: {
    opId: number;
    projectId: string;
    phase: "authorizing" | "syncing";
  } | null = null;

  constructor(deps: ProjectManualSyncCoordinatorDeps) {
    this.deps = deps;
  }

  isBusy(): boolean {
    return this.activeOperation !== null;
  }

  getActivePhase(): "authorizing" | "syncing" | null {
    return this.activeOperation?.phase ?? null;
  }

  /** 作廢進行中的授權/同步操作識別（專案切換、帳號登出/切換或元件卸載時呼叫）。 */
  invalidate(): void {
    this.opSeq += 1;
    if (this.activeOperation) {
      this.activeOperation = null;
      this.deps.onBusyChange?.(null);
    }
  }

  async requestSync(options?: { expectedProjectId?: string }): Promise<ManualSyncFlowResult> {
    if (this.activeOperation !== null) {
      return { kind: "ignored", reason: "already_in_flight" };
    }

    const active = this.deps.getActiveProject();
    if (!active) {
      return {
        kind: "no_project",
        message: "請先建立或開啟專案後，再同步至 Google Drive。",
      };
    }

    if (options?.expectedProjectId && active.projectId !== options.expectedProjectId) {
      return {
        kind: "aborted",
        reason: "project_switched",
        message: "目前專案已切換，已略過過期同步請求。",
      };
    }

    const controller = this.deps.getSyncController();
    if (!controller) {
      return { kind: "ignored", reason: "missing_controller" };
    }
    if (controller.isManualSyncRunning(active.projectId)) {
      return { kind: "ignored", reason: "sync_running" };
    }

    const authBefore = this.deps.getAuthSnapshot();
    const externalBusy = this.deps.getExternalBusyAction();
    const intent = resolveSyncActionIntent({
      activeProject: active,
      songCount: this.deps.getSongCount(),
      hasLegacySongs: this.deps.getHasLegacySongs(),
      isGoogleConfigured: this.deps.isGoogleConfigured(),
      isGoogleSignedIn: Boolean(authBefore.accountId),
      hasValidGoogleToken: Boolean(authBefore.accountId && authBefore.accessToken),
      busyAction: externalBusy,
      isSyncRunning: controller.isManualSyncRunning(active.projectId),
    });

    if (intent === "disabled_busy") {
      return { kind: "ignored", reason: "disabled_busy" };
    }
    if (intent === "disabled_no_project") {
      return {
        kind: "no_project",
        message: "請先建立或開啟專案後，再同步至 Google Drive。",
      };
    }
    if (intent === "disabled_unconfigured") {
      return {
        kind: "unconfigured",
        message: "尚未設定 Google OAuth 環境變數，無法使用雲端同步。",
      };
    }
    if (intent === "guide_promote_to_drive" || intent === "guide_promote_sign_in") {
      return {
        kind: "open_promote",
        needsSignIn: intent === "guide_promote_sign_in",
        message:
          intent === "guide_promote_sign_in"
            ? "請先登入 Google 帳號，再將此本機專案儲存到 Google Drive。"
            : undefined,
      };
    }
    if (intent === "open_conflict") {
      return {
        kind: "open_conflict",
        record: active,
        message: "此專案有跨裝置版本衝突，請先選擇衝突處理方式。",
      };
    }

    const opId = ++this.opSeq;
    const targetProjectId = active.projectId;
    const expectedOwner = active.ownerAccountId || active.project.ownerAccountId || "";
    this.activeOperation = {
      opId,
      projectId: targetProjectId,
      phase: intent === "guide_google_sign_in" ? "authorizing" : "syncing",
    };

    const isOpStillCurrent = (): boolean =>
      this.activeOperation !== null &&
      this.activeOperation.opId === opId &&
      this.activeOperation.projectId === targetProjectId;

    const getRecordFn = this.deps.getProjectRecordFn ?? getProjectRecord;
    const isDeletedFn = this.deps.isProjectDeletedFn ?? isProjectDeleted;

    try {
      // 1. 需要登入或 Token 失效時，先在同步前完成 Google 授權，絕不先進入 syncProjectManually()
      if (intent === "guide_google_sign_in") {
        const needsSignIn = !authBefore.accountId;
        this.deps.onBusyChange?.({
          action: "sync",
          message: needsSignIn
            ? "正在登入 Google 帳號以授權同步…"
            : "正在重新授權 Google 帳號…",
        });

        let afterAuth: CoordinatorAuthSnapshot;
        try {
          afterAuth = needsSignIn
            ? await this.deps.signInGoogle()
            : await this.deps.reauthorizeGoogle();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Google 授權失敗。";
          if (/取消|popup_closed/i.test(msg)) {
            return { kind: "auth_cancelled", message: msg };
          }
          return { kind: "auth_failed", message: msg };
        }

        if (!afterAuth.accountId || !afterAuth.accessToken) {
          return {
            kind: "auth_cancelled",
            message: "尚未取得有效的 Google 授權，未執行雲端同步。",
          };
        }

        // 2. 授權返回後立即重新檢查工作與專案狀態（不信任任何過期閉包）
        if (!isOpStillCurrent()) {
          return {
            kind: "aborted",
            reason: "stale_operation",
            message: "工作階段已變更，已中止過期授權後的同步。",
          };
        }

        const currentAfterAuth = this.deps.getActiveProject();
        if (!currentAfterAuth || currentAfterAuth.projectId !== targetProjectId) {
          return {
            kind: "aborted",
            reason: "project_switched",
            message: "授權期間已切換專案，已阻止同步至錯誤專案。",
          };
        }

        const busyAfterAuth = this.deps.getExternalBusyAction();
        if (busyAfterAuth && busyAfterAuth !== "sync") {
          return {
            kind: "aborted",
            reason: "external_busy",
            message: "目前有其他專案操作進行中，已中止同步。",
          };
        }

        const liveAuth = this.deps.getAuthSnapshot();
        if (
          !liveAuth.accountId ||
          !liveAuth.accessToken ||
          liveAuth.accountId !== afterAuth.accountId ||
          liveAuth.generation !== afterAuth.generation
        ) {
          return {
            kind: "aborted",
            reason: "auth_changed",
            message: "Google 帳號狀態已於授權期間變更，已中止本次同步。",
          };
        }

        const [freshRecord, deleted] = await Promise.all([
          getRecordFn(targetProjectId).catch(() => null),
          isDeletedFn(targetProjectId).catch(() => false),
        ]);

        if (!isOpStillCurrent()) {
          return {
            kind: "aborted",
            reason: "stale_operation",
            message: "工作階段已變更，已中止過期同步。",
          };
        }

        const currentAfterLoad = this.deps.getActiveProject();
        if (!currentAfterLoad || currentAfterLoad.projectId !== targetProjectId) {
          return {
            kind: "aborted",
            reason: "project_switched",
            message: "授權期間已切換專案，已阻止同步至錯誤專案。",
          };
        }

        if (deleted || !freshRecord) {
          return {
            kind: "aborted",
            reason: "project_deleted",
            message: "專案已刪除或不存在，已取消同步。",
          };
        }

        if (freshRecord.storageProvider !== "google_drive") {
          return {
            kind: "aborted",
            reason: "provider_changed",
            message: "專案儲存位置已變更為純本機，已取消雲端同步。",
          };
        }

        const recordOwner =
          freshRecord.ownerAccountId || freshRecord.project.ownerAccountId || expectedOwner;
        if (recordOwner && liveAuth.accountId !== recordOwner) {
          return {
            kind: "account_mismatch",
            expectedAccountId: recordOwner,
            actualAccountId: liveAuth.accountId,
            message: "登入的 Google 帳號與此專案擁有者不符，已阻止跨帳號上傳。",
          };
        }

        if (freshRecord.syncStatus === "conflict") {
          this.deps.onFreshRecordLoaded?.(freshRecord);
          return {
            kind: "open_conflict",
            record: freshRecord,
            message: "偵測到跨裝置版本衝突，請先選擇衝突處理方式。",
          };
        }

        if (controller.isManualSyncRunning(targetProjectId)) {
          return { kind: "ignored", reason: "sync_running" };
        }

        this.deps.onFreshRecordLoaded?.(freshRecord);
        this.activeOperation.phase = "syncing";
      }

      // 3. 條件全過後才發起一次手動雲端同步（內部仍保有完整本機 flush + CAS/Revision/Owner/Lock 檢查）
      this.deps.onBusyChange?.({
        action: "sync",
        message: "正在同步專案至 Google Drive…",
      });
      this.deps.captureLatestSnapshot(targetProjectId);
      if (controller.hasPendingLocalEdits(targetProjectId)) {
        this.deps.onLocalSaveStateChange?.(targetProjectId, "saving");
      }

      const outcome = await controller.syncProjectManually(targetProjectId);
      if (!isOpStillCurrent()) {
        return {
          kind: "aborted",
          reason: "stale_operation",
          message: "同步進行期間專案或工作階段已切換。",
        };
      }

      const localSaveFailed = Boolean(
        outcome?.status === "error" &&
          (outcome.localSaveFailed || outcome.errorMessage.startsWith("本機保存失敗")),
      );

      if (localSaveFailed) {
        this.deps.onLocalSaveStateChange?.(targetProjectId, "error");
      } else if (controller.hasPendingLocalEdits(targetProjectId)) {
        this.deps.onLocalSaveStateChange?.(
          targetProjectId,
          controller.getLocalSaveState(targetProjectId),
        );
      } else if (outcome && outcome.status !== "cancelled") {
        // 即使雲端同步失敗 (status === "error")，前置本機保存成功後本機狀態仍維持 saved
        this.deps.onLocalSaveStateChange?.(targetProjectId, "saved");
      }

      return {
        kind: "synced_outcome",
        projectId: targetProjectId,
        outcome,
        localSaveFailed,
      };
    } finally {
      if (this.activeOperation?.opId === opId) {
        this.activeOperation = null;
        this.deps.onBusyChange?.(null);
      }
    }
  }
}
