export type MixerTheme = "graphite" | "daylight";
export const MIXER_APPEARANCE_KEY = "loop.band-mixer.appearance";
export function readMixerTheme(storage: Pick<Storage, "getItem">): MixerTheme {
  try { return storage.getItem(MIXER_APPEARANCE_KEY) === "daylight" ? "daylight" : "graphite"; }
  catch { return "graphite"; }
}
export function saveMixerTheme(storage: Pick<Storage, "setItem">, theme: MixerTheme): boolean {
  try { storage.setItem(MIXER_APPEARANCE_KEY, theme); return true; }
  catch { return false; }
}
