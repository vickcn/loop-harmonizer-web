import type { BandSong } from "@/lib/band/bandTypes";
import { serializeSongSettings } from "@/lib/band/songModel";
import { idbGet, idbPut } from "./indexedDb";

const pending = new Map<string, number>();

export function saveSongSettingsDebounced(song: BandSong, delayMs = 300): void {
  const existing = pending.get(song.id);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    pending.delete(song.id);
    void idbPut("settings", { key: song.settingsKey, ...serializeSongSettings(song) }).catch(() => undefined);
  }, delayMs);
  pending.set(song.id, timer);
}

export type SavedSongSettings = ReturnType<typeof serializeSongSettings> & { key: string };

export function loadSongSettings(settingsKey: string): Promise<SavedSongSettings | null> {
  return idbGet<SavedSongSettings>("settings", settingsKey);
}
