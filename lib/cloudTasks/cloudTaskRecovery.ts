import type { CloudTaskRecord } from "./cloudTaskTypes.ts";

export function normalizeInterruptedCloudTask(task: CloudTaskRecord, now: number): CloudTaskRecord {
  if ((task.status === "running" || task.status === "preparing" || task.status === "recovering" || task.status === "pausing" || task.status === "cancelling") && (task.leaseExpiresAt ?? 0) <= now) {
    return {
      ...task,
      status: task.status === "pausing" ? "paused" : task.status === "cancelling" ? "cancelled" : "recovering",
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      stage: task.status === "pausing" ? "已暫停" : task.status === "cancelling" ? "已取消" : "從持久化進度恢復",
      updatedAt: now,
    };
  }
  return task;
}
