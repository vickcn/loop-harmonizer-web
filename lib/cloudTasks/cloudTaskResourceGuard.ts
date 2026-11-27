import type { CloudTaskRecord } from "./cloudTaskTypes.ts";

export type CloudTaskResourceSnapshot = {
  heavyAudioTaskRunning: boolean;
  anotherHeavyTransferRunning: boolean;
  storageRemainingBytes?: number;
};

export function evaluateCloudTaskResources(
  task: CloudTaskRecord,
  snapshot: CloudTaskResourceSnapshot,
): { allowed: boolean; reason?: string } {
  if (task.kind === "project_sync") return { allowed: true };
  if (snapshot.heavyAudioTaskRunning) return { allowed: false, reason: "正在執行音源分離，等待釋放重型音訊資源。" };
  if (snapshot.anotherHeavyTransferRunning) return { allowed: false, reason: "已有大型 Google Drive 傳輸，等待單工佇列。" };
  if (snapshot.storageRemainingBytes !== undefined && snapshot.storageRemainingBytes < 32 * 1024 * 1024) {
    return { allowed: false, reason: "裝置可用儲存空間過低，等待使用者釋放空間。" };
  }
  return { allowed: true };
}
