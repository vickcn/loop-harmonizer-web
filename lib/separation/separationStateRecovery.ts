import type {
  BandSong,
  SeparationStatus,
} from "../band/bandTypes.ts";
import type { PersistedSongRecord } from "../band/songModel.ts";
import type { ResumeValidationResult } from "./separationResumeController.ts";

export const SEPARATION_DIAGNOSTIC_STORAGE_KEY =
  "loop-harmonizer:separation-diagnostics:v1";
export const MAX_SEPARATION_DIAGNOSTIC_ENTRIES = 120;

export interface SeparationDiagnosticEntry {
  id: string;
  timestamp: number;
  taskId: string | null;
  songId: string | null;
  generation: number | null;
  checkpointStatus: string | null;
  validChunkCount: number | null;
  totalChunks: number | null;
  workerExitReason: string | null;
  leaseOwner: string | null;
  fromState: string | null;
  toState: string | null;
  stateTransition: string;
  source: string;
  note?: string;
}

export interface RecordSeparationDiagnosticInput {
  taskId?: string | null;
  songId?: string | null;
  generation?: number | null;
  checkpointStatus?: string | null;
  validChunkCount?: number | null;
  totalChunks?: number | null;
  workerExitReason?: string | null;
  leaseOwner?: string | null;
  fromState?: string | null;
  toState?: string | null;
  source: string;
  note?: string;
  timestamp?: number;
}

const diagnosticBuffer: SeparationDiagnosticEntry[] = [];
let diagnosticHydratedFromStorage = false;
let diagnosticSeq = 0;

function readDiagnosticStorageSafely(): SeparationDiagnosticEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(SEPARATION_DIAGNOSTIC_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SeparationDiagnosticEntry => Boolean(item && typeof item === "object"))
      .slice(-MAX_SEPARATION_DIAGNOSTIC_ENTRIES);
  } catch {
    return [];
  }
}

function writeDiagnosticStorageSafely(entries: SeparationDiagnosticEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      SEPARATION_DIAGNOSTIC_STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_SEPARATION_DIAGNOSTIC_ENTRIES)),
    );
  } catch {
    // 忽略本機儲存空間限制錯誤，絕不上傳雲端
  }
}

function ensureDiagnosticBufferHydrated(): void {
  if (diagnosticHydratedFromStorage) return;
  diagnosticHydratedFromStorage = true;
  const saved = readDiagnosticStorageSafely();
  if (saved.length > 0) {
    diagnosticBuffer.push(...saved);
    if (diagnosticBuffer.length > MAX_SEPARATION_DIAGNOSTIC_ENTRIES) {
      diagnosticBuffer.splice(
        0,
        diagnosticBuffer.length - MAX_SEPARATION_DIAGNOSTIC_ENTRIES,
      );
    }
  }
}

export function recordSeparationDiagnostic(
  input: RecordSeparationDiagnosticInput,
): SeparationDiagnosticEntry {
  ensureDiagnosticBufferHydrated();
  const timestamp = input.timestamp ?? Date.now();
  const fromState = input.fromState ?? null;
  const toState = input.toState ?? null;
  const entry: SeparationDiagnosticEntry = {
    id: `diag-${timestamp}-${++diagnosticSeq}`,
    timestamp,
    taskId: input.taskId ?? null,
    songId: input.songId ?? null,
    generation:
      typeof input.generation === "number" && Number.isFinite(input.generation)
        ? input.generation
        : null,
    checkpointStatus: input.checkpointStatus ?? null,
    validChunkCount:
      typeof input.validChunkCount === "number" &&
      Number.isFinite(input.validChunkCount)
        ? input.validChunkCount
        : null,
    totalChunks:
      typeof input.totalChunks === "number" && Number.isFinite(input.totalChunks)
        ? input.totalChunks
        : null,
    workerExitReason: input.workerExitReason ?? null,
    leaseOwner: input.leaseOwner ?? null,
    fromState,
    toState,
    stateTransition: `${fromState ?? "none"} -> ${toState ?? "none"}`,
    source: input.source,
    note: input.note,
  };
  diagnosticBuffer.push(entry);
  if (diagnosticBuffer.length > MAX_SEPARATION_DIAGNOSTIC_ENTRIES) {
    diagnosticBuffer.splice(
      0,
      diagnosticBuffer.length - MAX_SEPARATION_DIAGNOSTIC_ENTRIES,
    );
  }
  writeDiagnosticStorageSafely(diagnosticBuffer);
  return entry;
}

export function getSeparationDiagnosticLogs(): SeparationDiagnosticEntry[] {
  ensureDiagnosticBufferHydrated();
  return [...diagnosticBuffer];
}

export function clearSeparationDiagnosticLogs(): void {
  diagnosticBuffer.length = 0;
  diagnosticHydratedFromStorage = true;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(SEPARATION_DIAGNOSTIC_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export function formatSeparationDiagnosticLine(
  entry: SeparationDiagnosticEntry,
): string {
  const iso = new Date(entry.timestamp).toISOString();
  const chunkStr =
    entry.validChunkCount !== null
      ? entry.totalChunks !== null
        ? `${entry.validChunkCount}/${entry.totalChunks}`
        : `${entry.validChunkCount}`
      : "-";
  const parts = [
    iso,
    `[${entry.source}]`,
    `task=${entry.taskId ?? "-"}`,
    `gen=${entry.generation ?? "-"}`,
    `cp=${entry.checkpointStatus ?? "-"}`,
    `chunks=${chunkStr}`,
    `exit=${entry.workerExitReason ?? "-"}`,
    `lease=${entry.leaseOwner ?? "-"}`,
    `tx=${entry.stateTransition}`,
  ];
  if (entry.note) parts.push(`note=${entry.note}`);
  return parts.join(" | ");
}

export function isValidationCompleted(
  validation: ResumeValidationResult | null | undefined,
): boolean {
  if (!validation || !validation.checkpoint) return false;
  if (validation.action !== "already_completed") return false;
  if (validation.totalChunks <= 0) return false;
  return validation.validChunkCount >= validation.totalChunks;
}

export function canTransitionSeparationStatus(
  current: SeparationStatus,
  next: SeparationStatus,
  options?: { allowResetCompleted?: boolean },
): boolean {
  if (current === next) return true;
  if (current === "completed") {
    return options?.allowResetCompleted === true;
  }
  return true;
}

export function hasResumableSavedChunks(params: {
  completedChunks?: number | null;
  totalChunks?: number | null;
}): boolean {
  const completed = params.completedChunks ?? 0;
  const total = params.totalChunks ?? 0;
  return completed > 0 && (total <= 0 || completed < total);
}

export function buildZeroChunkIncompleteMessage(): string {
  return "前次分離尚未完成第 1 段，本機尚無可接續的分段進度（請重新開始分離）";
}

export function guardSeparationPatch(
  currentSong: Pick<
    BandSong,
    | "id"
    | "separationStatus"
    | "separationTaskId"
    | "separationCompletedChunks"
    | "separationTotalChunks"
    | "separationCommittedBytes"
  >,
  patch: Partial<BandSong>,
  options?: {
    source?: string;
    generation?: number | null;
    activeGeneration?: number | null;
    allowResetCompleted?: boolean;
    workerExitReason?: string | null;
    leaseOwner?: string | null;
    checkpointStatus?: string | null;
  },
): Partial<BandSong> | null {
  const source = options?.source ?? "guardSeparationPatch";
  if (
    typeof options?.generation === "number" &&
    typeof options?.activeGeneration === "number" &&
    options.generation !== options.activeGeneration
  ) {
    recordSeparationDiagnostic({
      source,
      songId: currentSong.id,
      taskId: patch.separationTaskId ?? currentSong.separationTaskId ?? null,
      generation: options.generation,
      checkpointStatus: options.checkpointStatus ?? null,
      validChunkCount:
        patch.separationCompletedChunks ??
        currentSong.separationCompletedChunks ??
        null,
      totalChunks:
        patch.separationTotalChunks ?? currentSong.separationTotalChunks ?? null,
      workerExitReason: options.workerExitReason ?? null,
      leaseOwner: options.leaseOwner ?? null,
      fromState: currentSong.separationStatus,
      toState: patch.separationStatus ?? currentSong.separationStatus,
      note: `ignored stale generation=${options.generation}, active=${options.activeGeneration}`,
    });
    return null;
  }

  const nextStatus = patch.separationStatus;
  if (
    nextStatus &&
    !canTransitionSeparationStatus(currentSong.separationStatus, nextStatus, {
      allowResetCompleted: options?.allowResetCompleted,
    })
  ) {
    recordSeparationDiagnostic({
      source,
      songId: currentSong.id,
      taskId: patch.separationTaskId ?? currentSong.separationTaskId ?? null,
      generation: options?.generation ?? null,
      checkpointStatus: options?.checkpointStatus ?? null,
      validChunkCount:
        patch.separationCompletedChunks ??
        currentSong.separationCompletedChunks ??
        null,
      totalChunks:
        patch.separationTotalChunks ?? currentSong.separationTotalChunks ?? null,
      workerExitReason: options?.workerExitReason ?? null,
      leaseOwner: options?.leaseOwner ?? null,
      fromState: currentSong.separationStatus,
      toState: nextStatus,
      note: "blocked downgrade from completed",
    });
    return null;
  }

  const effectiveCompletedChunks =
    patch.separationCompletedChunks ??
    currentSong.separationCompletedChunks ??
    0;
  const effectiveStatus = nextStatus ?? currentSong.separationStatus;

  if (
    (effectiveStatus === "interrupted" || effectiveStatus === "paused") &&
    effectiveCompletedChunks <= 0
  ) {
    return {
      ...patch,
      separationCompletedChunks: 0,
      separationCommittedBytes: 0,
      separationProgress: 0,
      separationUsesChunkPlayback: false,
      separationMessage: buildZeroChunkIncompleteMessage(),
    };
  }

  return patch;
}

export function deriveSeparationStateFromValidation(params: {
  validation: ResumeValidationResult;
  cacheKey?: string | null;
  backendLabel?: string;
}): Partial<BandSong> {
  const { validation, cacheKey, backendLabel } = params;
  const cp = validation.checkpoint;
  if (!cp) {
    return {
      separationStatus: "not_started",
      separationProgress: 0,
      separationMessage: "",
      separationTaskId: null,
      separationCompletedChunks: 0,
      separationTotalChunks: 0,
      separationCommittedBytes: 0,
      separationUsesChunkPlayback: false,
    };
  }

  const validChunks = Math.max(0, validation.validChunkCount);
  const totalChunks = Math.max(0, validation.totalChunks || cp.totalChunks);

  if (isValidationCompleted(validation)) {
    const label = backendLabel ? `（${backendLabel} · 共 ${totalChunks} 段按需播放）` : `（共 ${totalChunks} 段按需播放）`;
    return {
      separationStatus: "completed",
      separationMode: cp.requestedMode,
      separationProgress: 100,
      separationMessage: `分段分離完成${label}`,
      separationTaskId: cp.taskId,
      separationCompletedChunks: validChunks,
      separationTotalChunks: totalChunks,
      separationCommittedBytes: cp.committedBytes,
      separationUserAuthorized: cp.userAuthorized,
      separationUsesChunkPlayback: true,
      cacheKey: cacheKey ?? null,
    };
  }

  if (cp.status === "cancelled") {
    return {
      separationStatus: "cancelled",
      separationMode: cp.requestedMode,
      separationProgress:
        totalChunks > 0 ? Math.round((validChunks / totalChunks) * 100) : 0,
      separationMessage:
        validChunks > 0
          ? `已取消分離（保留本機第 ${validChunks}/${totalChunks} 段暫存）`
          : "已取消分離（尚無已保存分段）",
      separationTaskId: cp.taskId,
      separationCompletedChunks: validChunks,
      separationTotalChunks: totalChunks,
      separationCommittedBytes: validChunks > 0 ? cp.committedBytes : 0,
      separationUserAuthorized: cp.userAuthorized,
      separationUsesChunkPlayback: false,
    };
  }

  if (validChunks <= 0) {
    const mappedStatus: SeparationStatus =
      cp.status === "failed"
        ? "failed"
        : cp.status === "paused"
          ? "paused"
          : "interrupted";
    return {
      separationStatus: mappedStatus,
      separationMode: cp.requestedMode,
      separationProgress: 0,
      separationMessage:
        cp.status === "failed" && cp.lastError
          ? cp.lastError
          : buildZeroChunkIncompleteMessage(),
      separationTaskId: cp.taskId,
      separationCompletedChunks: 0,
      separationTotalChunks: totalChunks,
      separationCommittedBytes: 0,
      separationUserAuthorized: cp.userAuthorized,
      separationUsesChunkPlayback: false,
    };
  }

  const pct =
    totalChunks > 0
      ? Math.min(99, Math.round((validChunks / totalChunks) * 100))
      : 0;
  const mappedStatus: SeparationStatus =
    cp.status === "paused"
      ? "paused"
      : cp.status === "failed"
        ? "failed"
        : "interrupted";
  const prefix =
    mappedStatus === "paused"
      ? "已暫停分離"
      : mappedStatus === "failed"
        ? cp.lastError || "背景分離失敗"
        : "背景中斷，可從最近完成段落接續";

  return {
    separationStatus: mappedStatus,
    separationMode: cp.requestedMode,
    separationProgress: pct,
    separationMessage: `${prefix}（已保存第 ${validChunks}/${totalChunks} 段）`,
    separationTaskId: cp.taskId,
    separationCompletedChunks: validChunks,
    separationTotalChunks: totalChunks,
    separationCommittedBytes: cp.committedBytes,
    separationUserAuthorized: cp.userAuthorized,
    separationUsesChunkPlayback: false,
  };
}

export interface CrossTabSongSyncPatch
  extends Partial<
    Pick<
      PersistedSongRecord,
      | "targetBpm"
      | "keyShiftSemitones"
      | "tempoMode"
      | "manualRate"
      | "fineRateOffset"
      | "masterVolume"
      | "playbackSource"
      | "stemChannels"
      | "separationMode"
      | "separationStatus"
      | "separationTaskId"
      | "separationCompletedChunks"
      | "separationTotalChunks"
      | "separationCommittedBytes"
      | "cacheKey"
    >
  > {}

export function reconcileCrossTabSongUpdate(
  localSong: BandSong,
  remote: CrossTabSongSyncPatch,
  options?: {
    verifiedCompletedCheckpoint?: boolean;
    verifiedValidChunkCount?: number;
  },
): {
  song: BandSong;
  needsChunkPlaybackRestore: boolean;
  blockedDowngrade: boolean;
} {
  let blockedDowngrade = false;
  let needsChunkPlaybackRestore = false;

  const mergedStemChannels = remote.stemChannels
    ? (localSong.stemChannels.length > 0
        ? localSong.stemChannels.map((ch) => {
            const matched = remote.stemChannels!.find((rc) => rc.stemType === ch.stemType);
            return matched
              ? { ...ch, volume: matched.volume, muted: matched.muted, solo: matched.solo }
              : ch;
          })
        : remote.stemChannels.map((rc) => ({
            id: `${localSong.id}_stem_${rc.stemType}`,
            songId: localSong.id,
            stemType: rc.stemType,
            volume: rc.volume,
            muted: rc.muted,
            solo: rc.solo,
          })))
    : localSong.stemChannels;

  const baseUpdated: BandSong = {
    ...localSong,
    targetBpm: remote.targetBpm ?? localSong.targetBpm,
    keyShiftSemitones: remote.keyShiftSemitones ?? localSong.keyShiftSemitones,
    tempoMode: remote.tempoMode ?? localSong.tempoMode,
    manualRate: remote.manualRate ?? localSong.manualRate,
    fineRateOffset: remote.fineRateOffset ?? localSong.fineRateOffset,
    masterVolume: remote.masterVolume ?? localSong.masterVolume,
    stemChannels: mergedStemChannels,
  };

  const remoteStatus = remote.separationStatus;
  const explicitCompletedCleared =
    remoteStatus === "not_started" &&
    !remote.cacheKey &&
    !remote.separationTaskId &&
    (remote.separationCompletedChunks ?? 0) === 0 &&
    options?.verifiedCompletedCheckpoint === false;

  if (options?.verifiedCompletedCheckpoint) {
    needsChunkPlaybackRestore =
      localSong.separationStatus !== "completed" ||
      (!localSong.separationUsesChunkPlayback && localSong.stemIds.length === 0);
    return {
      song: {
        ...baseUpdated,
        separationStatus: "completed",
        separationMode: remote.separationMode ?? localSong.separationMode,
        separationTaskId: remote.separationTaskId ?? localSong.separationTaskId,
        cacheKey: remote.cacheKey ?? localSong.cacheKey,
        separationCompletedChunks:
          options.verifiedValidChunkCount ??
          remote.separationCompletedChunks ??
          localSong.separationCompletedChunks,
        separationTotalChunks:
          remote.separationTotalChunks ?? localSong.separationTotalChunks,
        separationCommittedBytes:
          remote.separationCommittedBytes ?? localSong.separationCommittedBytes,
        separationProgress: 100,
        playbackSource: remote.playbackSource ?? localSong.playbackSource,
      },
      needsChunkPlaybackRestore,
      blockedDowngrade: false,
    };
  }

  if (localSong.separationStatus === "completed") {
    if (explicitCompletedCleared) {
      recordSeparationDiagnostic({
        source: "reconcileCrossTabSongUpdate",
        songId: localSong.id,
        taskId: localSong.separationTaskId ?? null,
        fromState: "completed",
        toState: "not_started",
        note: "applied explicit cross-tab delete completed stems",
      });
      return {
        song: {
          ...baseUpdated,
          separationStatus: "not_started",
          separationMode: null,
          separationTaskId: null,
          separationCompletedChunks: 0,
          separationTotalChunks: 0,
          separationCommittedBytes: 0,
          separationUsesChunkPlayback: false,
          separationProgress: 0,
          separationMessage: "",
          cacheKey: null,
          stemIds: [],
          stemChannels: [],
          playbackSource: "original",
        },
        needsChunkPlaybackRestore: false,
        blockedDowngrade: false,
      };
    }

    if (remoteStatus && remoteStatus !== "completed") {
      blockedDowngrade = true;
      recordSeparationDiagnostic({
        source: "reconcileCrossTabSongUpdate",
        songId: localSong.id,
        taskId: remote.separationTaskId ?? localSong.separationTaskId ?? null,
        validChunkCount:
          remote.separationCompletedChunks ??
          localSong.separationCompletedChunks ??
          null,
        totalChunks:
          remote.separationTotalChunks ?? localSong.separationTotalChunks ?? null,
        fromState: "completed",
        toState: remoteStatus,
        note: "blocked stale cross-tab downgrade from completed",
      });
    }

    return {
      song: {
        ...baseUpdated,
        playbackSource: remote.playbackSource ?? localSong.playbackSource,
      },
      needsChunkPlaybackRestore: false,
      blockedDowngrade,
    };
  }

  if (remoteStatus === "completed") {
    needsChunkPlaybackRestore = true;
    return {
      song: {
        ...baseUpdated,
        separationStatus: "completed",
        separationMode: remote.separationMode ?? localSong.separationMode,
        separationTaskId: remote.separationTaskId ?? localSong.separationTaskId,
        cacheKey: remote.cacheKey ?? localSong.cacheKey,
        separationCompletedChunks:
          remote.separationCompletedChunks ??
          localSong.separationCompletedChunks,
        separationTotalChunks:
          remote.separationTotalChunks ?? localSong.separationTotalChunks,
        separationCommittedBytes:
          remote.separationCommittedBytes ?? localSong.separationCommittedBytes,
        separationProgress: 100,
        playbackSource: remote.playbackSource ?? localSong.playbackSource,
      },
      needsChunkPlaybackRestore,
      blockedDowngrade: false,
    };
  }

  const nextCompletedChunks =
    remote.separationTaskId &&
    remote.separationTaskId === localSong.separationTaskId
      ? Math.max(
          localSong.separationCompletedChunks ?? 0,
          remote.separationCompletedChunks ?? 0,
        )
      : remote.separationCompletedChunks ?? localSong.separationCompletedChunks ?? 0;
  const nextTotalChunks =
    remote.separationTotalChunks ?? localSong.separationTotalChunks ?? 0;

  let nextStatus: SeparationStatus = remoteStatus ?? localSong.separationStatus;
  let nextMessage = localSong.separationMessage;
  let nextProgress = localSong.separationProgress;

  if (nextStatus === "not_started") {
    nextMessage = "";
    nextProgress = 0;
  } else if (
    (nextStatus === "interrupted" || nextStatus === "paused") &&
    nextCompletedChunks <= 0
  ) {
    nextProgress = 0;
    nextMessage = buildZeroChunkIncompleteMessage();
  } else if (nextTotalChunks > 0) {
    nextProgress = Math.min(
      99,
      Math.round((nextCompletedChunks / nextTotalChunks) * 100),
    );
  }

  return {
    song: {
      ...baseUpdated,
      separationStatus: nextStatus,
      separationMode: remote.separationMode ?? localSong.separationMode,
      separationTaskId: remote.separationTaskId ?? localSong.separationTaskId,
      cacheKey: remote.cacheKey ?? localSong.cacheKey,
      separationCompletedChunks: nextCompletedChunks,
      separationTotalChunks: nextTotalChunks,
      separationCommittedBytes:
        remote.separationCommittedBytes ?? localSong.separationCommittedBytes,
      separationProgress: nextProgress,
      separationMessage: nextMessage,
      playbackSource: remote.playbackSource ?? localSong.playbackSource,
    },
    needsChunkPlaybackRestore: false,
    blockedDowngrade: false,
  };
}
