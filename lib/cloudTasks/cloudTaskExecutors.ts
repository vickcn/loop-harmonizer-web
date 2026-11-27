import type { CloudTaskExecutor, CloudTaskKind } from "./cloudTaskTypes.ts";

export class CloudTaskExecutorRegistry {
  private readonly executors = new Map<CloudTaskKind, CloudTaskExecutor>();

  register<K extends CloudTaskKind>(kind: K, executor: CloudTaskExecutor<K>): () => void {
    this.executors.set(kind, executor as CloudTaskExecutor);
    return () => {
      if (this.executors.get(kind) === executor) this.executors.delete(kind);
    };
  }

  get(kind: CloudTaskKind): CloudTaskExecutor | null {
    return this.executors.get(kind) ?? null;
  }
}
