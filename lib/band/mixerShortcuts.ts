import type { BandSong } from "./bandTypes";

export type MixerSelection = {
  songId: string | null;
  stemId: string | null;
};

export type ShortcutActionType =
  | "toggle-play"
  | "toggle-mute"
  | "toggle-solo"
  | "toggle-loop"
  | "open-upload"
  | "reset-speed"
  | "reset-key"
  | "reset-mix"
  | "seek-start";

export type ShortcutElementLike = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

export type KeyboardEventLike = {
  code?: string;
  key?: string;
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
};

export const EMPTY_MIXER_SELECTION: MixerSelection = {
  songId: null,
  stemId: null,
};

export function sanitizeMixerSelection(
  selection: MixerSelection,
  songs: readonly BandSong[],
): MixerSelection {
  if (!selection.songId) return EMPTY_MIXER_SELECTION;
  const song = songs.find((candidate) => candidate.id === selection.songId);
  if (!song) return EMPTY_MIXER_SELECTION;
  if (!selection.stemId) return { songId: song.id, stemId: null };
  const hasStem = song.stemChannels.some((channel) => channel.id === selection.stemId);
  return {
    songId: song.id,
    stemId: hasStem ? selection.stemId : null,
  };
}

function asElementLike(target: unknown): ShortcutElementLike | null {
  if (!target || typeof target !== "object") return null;
  return target as ShortcutElementLike;
}

function isEditableTextTarget(el: ShortcutElementLike): boolean {
  if (el.isContentEditable) return true;
  const ceAttr = el.getAttribute?.("contenteditable");
  if (ceAttr === "" || ceAttr === "true" || ceAttr === "plaintext-only") return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const inputType = (el.type ?? "text").toLowerCase();
    return inputType !== "range" && inputType !== "checkbox" && inputType !== "radio" && inputType !== "button" && inputType !== "submit" && inputType !== "reset";
  }
  return false;
}

function isInsideDialog(el: ShortcutElementLike): boolean {
  if (el.closest?.("dialog, [role='dialog'], [aria-modal='true']")) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  const role = el.getAttribute?.("role")?.toLowerCase();
  return tag === "DIALOG" || role === "dialog";
}

export function shouldBlockSpaceShortcut(target: unknown): boolean {
  const el = asElementLike(target);
  if (!el) return false;
  if (isInsideDialog(el)) return true;
  if (el.isContentEditable) return true;
  const ceAttr = el.getAttribute?.("contenteditable");
  if (ceAttr === "" || ceAttr === "true" || ceAttr === "plaintext-only") return true;

  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A" || tag === "SUMMARY") {
    return true;
  }
  if (tag === "INPUT") {
    const inputType = (el.type ?? "text").toLowerCase();
    // 除 range 滑桿外，其他 input（文字、數字、checkbox 等）皆保留原生 Space 行為，不執行歌曲播放
    return inputType !== "range";
  }
  const role = el.getAttribute?.("role")?.toLowerCase();
  if (role === "button" || role === "link" || role === "menuitem" || role === "tab") {
    return true;
  }
  if (el.closest?.("button, a[href], summary, [role='button']")) {
    return true;
  }
  return false;
}

export function shouldBlockAltShortcut(target: unknown): boolean {
  const el = asElementLike(target);
  if (!el) return false;
  if (isInsideDialog(el)) return true;
  return isEditableTextTarget(el);
}

const ALT_CODE_MAP: Record<string, ShortcutActionType> = {
  KeyM: "toggle-mute",
  KeyK: "toggle-solo",
  KeyL: "toggle-loop",
  KeyN: "open-upload",
  KeyZ: "reset-speed",
  KeyX: "reset-key",
  KeyC: "reset-mix",
  KeyA: "seek-start",
};

const ALT_KEY_MAP: Record<string, ShortcutActionType> = {
  m: "toggle-mute",
  k: "toggle-solo",
  l: "toggle-loop",
  n: "open-upload",
  z: "reset-speed",
  x: "reset-key",
  c: "reset-mix",
  a: "seek-start",
};

export function resolveShortcutAction(event: KeyboardEventLike): ShortcutActionType | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) {
    return null;
  }
  if (event.ctrlKey || event.metaKey) {
    return null;
  }

  if (!event.altKey) {
    if (event.shiftKey) return null;
    const isSpace = event.code === "Space" || event.key === " ";
    if (!isSpace) return null;
    return shouldBlockSpaceShortcut(event.target) ? null : "toggle-play";
  }

  if (shouldBlockAltShortcut(event.target)) {
    return null;
  }

  if (event.code && event.code in ALT_CODE_MAP) {
    return ALT_CODE_MAP[event.code];
  }
  const normalizedKey = (event.key ?? "").toLowerCase();
  if (normalizedKey in ALT_KEY_MAP) {
    return ALT_KEY_MAP[normalizedKey];
  }
  return null;
}

export function getResetSpeedPatch(song: Pick<BandSong, "originalBpm">): Partial<BandSong> {
  return {
    targetBpm: song.originalBpm,
    tempoMode: "target-bpm",
    manualRate: 1,
    fineRateOffset: 0,
  };
}

export function getResetKeyPatch(): Partial<BandSong> {
  return {
    keyShiftSemitones: 0,
  };
}

export function getResetMixPatch(song: Pick<BandSong, "stemChannels">): Partial<BandSong> {
  return {
    masterVolume: 1,
    muted: false,
    stemChannels: song.stemChannels.map((channel) => ({
      ...channel,
      volume: 1,
      muted: false,
      solo: false,
    })),
  };
}

export function isSongSpeedAtDefault(
  song: Pick<BandSong, "originalBpm" | "targetBpm" | "tempoMode" | "manualRate" | "fineRateOffset">,
): boolean {
  return (
    song.targetBpm === song.originalBpm
    && song.tempoMode === "target-bpm"
    && song.manualRate === 1
    && song.fineRateOffset === 0
  );
}

export function isSongKeyAtDefault(song: Pick<BandSong, "keyShiftSemitones">): boolean {
  return song.keyShiftSemitones === 0;
}

export function isSongMixAtDefault(
  song: Pick<BandSong, "masterVolume" | "muted" | "stemChannels">,
): boolean {
  return (
    song.masterVolume === 1
    && !song.muted
    && song.stemChannels.every((channel) => channel.volume === 1 && !channel.muted && !channel.solo)
  );
}

export function applyResetSpeed(
  song: Pick<BandSong, "name" | "originalBpm" | "targetBpm" | "tempoMode" | "manualRate" | "fineRateOffset">,
): { changed: boolean; patch: Partial<BandSong> | null; message: string } {
  if (isSongSpeedAtDefault(song)) {
    return {
      changed: false,
      patch: null,
      message: `${song.name} 已是原始速度 1.000×（無需變更）`,
    };
  }
  return {
    changed: true,
    patch: getResetSpeedPatch(song),
    message: `${song.name} 已恢復原始速度 1.000×`,
  };
}

export function applyResetKey(
  song: Pick<BandSong, "name" | "keyShiftSemitones">,
): { changed: boolean; patch: Partial<BandSong> | null; message: string } {
  if (isSongKeyAtDefault(song)) {
    return {
      changed: false,
      patch: null,
      message: `${song.name} 已是原始 Key 0 半音（無需變更）`,
    };
  }
  return {
    changed: true,
    patch: getResetKeyPatch(),
    message: `${song.name} 已恢復原始 Key (0 半音)`,
  };
}

export function applyResetMix(
  song: Pick<BandSong, "name" | "masterVolume" | "muted" | "stemChannels">,
): { changed: boolean; patch: Partial<BandSong> | null; message: string } {
  if (isSongMixAtDefault(song)) {
    return {
      changed: false,
      patch: null,
      message: `${song.name} 混音已是預設值（無需變更）`,
    };
  }
  return {
    changed: true,
    patch: getResetMixPatch(song),
    message: `${song.name} 已恢復混音預設`,
  };
}

export function describePlaybackError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/NotAllowedError|user gesture|autoplay|suspended/i.test(message)) {
    return "瀏覽器阻擋自動啟動音訊引擎，請再次點擊播放以授權音訊。";
  }
  if (/network|fetch|404|Failed to fetch/i.test(message)) {
    return `音訊處理模組載入失敗，請檢查連線後重試（${message}）。`;
  }
  if (message) {
    return `無法啟動播放：${message}`;
  }
  return "音訊引擎啟動失敗，請重試。";
}

export function toggleMuteBySelection(
  songs: readonly BandSong[],
  selection: MixerSelection,
): { songs: BandSong[]; changedSong: BandSong | null; message: string } {
  if (!selection.songId) {
    return { songs: [...songs], changedSong: null, message: "請先選取一首歌曲或分軌。" };
  }
  const song = songs.find((candidate) => candidate.id === selection.songId);
  if (!song) {
    return { songs: [...songs], changedSong: null, message: "找不到選取的歌曲。" };
  }

  if (selection.stemId) {
    const targetStem = song.stemChannels.find((channel) => channel.id === selection.stemId);
    if (targetStem) {
      const nextMuted = !targetStem.muted;
      const updatedSong: BandSong = {
        ...song,
        stemChannels: song.stemChannels.map((channel) => (
          channel.id === selection.stemId ? { ...channel, muted: nextMuted } : channel
        )),
      };
      return {
        songs: songs.map((candidate) => (candidate.id === song.id ? updatedSong : candidate)),
        changedSong: updatedSong,
        message: `${targetStem.stemType} ${nextMuted ? "已靜音" : "已解除靜音"}`,
      };
    }
  }

  const nextSongMuted = !song.muted;
  const updatedSong: BandSong = { ...song, muted: nextSongMuted };
  return {
    songs: songs.map((candidate) => (candidate.id === song.id ? updatedSong : candidate)),
    changedSong: updatedSong,
    message: `${song.name} ${nextSongMuted ? "整首已靜音" : "已解除靜音"}`,
  };
}

export function toggleSoloBySelection(
  songs: readonly BandSong[],
  selection: MixerSelection,
): { songs: BandSong[]; changedSong: BandSong | null; message: string } {
  if (!selection.songId) {
    return { songs: [...songs], changedSong: null, message: "請先選取一條分軌以切換 Solo。" };
  }
  const song = songs.find((candidate) => candidate.id === selection.songId);
  if (!song) {
    return { songs: [...songs], changedSong: null, message: "找不到選取的歌曲。" };
  }
  if (!selection.stemId) {
    return {
      songs: [...songs],
      changedSong: null,
      message: "Solo 僅適用於分軌，請先點選某條分軌再按 Alt+K。",
    };
  }
  const targetStem = song.stemChannels.find((channel) => channel.id === selection.stemId);
  if (!targetStem) {
    return {
      songs: [...songs],
      changedSong: null,
      message: "Solo 僅適用於分軌，請先點選某條分軌再按 Alt+K。",
    };
  }
  const nextSolo = !targetStem.solo;
  const updatedSong: BandSong = {
    ...song,
    stemChannels: song.stemChannels.map((channel) => (
      channel.id === selection.stemId ? { ...channel, solo: nextSolo } : channel
    )),
  };
  return {
    songs: songs.map((candidate) => (candidate.id === song.id ? updatedSong : candidate)),
    changedSong: updatedSong,
    message: `${targetStem.stemType} ${nextSolo ? "已開啟 Solo" : "已取消 Solo"}`,
  };
}
