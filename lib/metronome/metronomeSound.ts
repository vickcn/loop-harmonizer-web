export type WaveType = "sine" | "square" | "triangle" | "sawtooth";

export interface MetronomeSound {
  id: string;
  name: string;
  wave: WaveType;
  accentFreq: number;
  beatFreq: number;
  accentPeak: number;
  beatPeak: number;
  attack: number;    // seconds
  decay: number;     // seconds
  duration: number;  // seconds
  builtIn?: boolean;
}

export const BUILT_IN_SOUNDS: MetronomeSound[] = [
  {
    id: "original",
    name: "原始版本",
    wave: "sine",
    accentFreq: 1200, beatFreq: 900,
    accentPeak: 0.9, beatPeak: 0.55,
    attack: 0.005, decay: 0.04, duration: 0.05,
    builtIn: true,
  },
  {
    id: "square",
    name: "方波版本",
    wave: "square",
    accentFreq: 2000, beatFreq: 1400,
    accentPeak: 0.9, beatPeak: 0.55,
    attack: 0.0015, decay: 0.035, duration: 0.04,
    builtIn: true,
  },
  {
    id: "sawtooth",
    name: "鋸齒波版本",
    wave: "sawtooth",
    accentFreq: 2200, beatFreq: 1600,
    accentPeak: 0.9, beatPeak: 0.55,
    attack: 0.001, decay: 0.025, duration: 0.035,
    builtIn: true,
  },
  {
    id: "triangle",
    name: "柔和三角波",
    wave: "triangle",
    accentFreq: 1800, beatFreq: 1200,
    accentPeak: 0.9, beatPeak: 0.55,
    attack: 0.002, decay: 0.04, duration: 0.05,
    builtIn: true,
  },
];

export const DEFAULT_SOUND_ID = "triangle";

const STORAGE_KEY = "metro-custom-sounds";

export function loadCustomSounds(): MetronomeSound[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as MetronomeSound[];
  } catch {
    return [];
  }
}

export function saveCustomSounds(sounds: MetronomeSound[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sounds));
}

export function getAllSounds(customSounds: MetronomeSound[]): MetronomeSound[] {
  return [...BUILT_IN_SOUNDS, ...customSounds];
}

export function findSound(
  sounds: MetronomeSound[],
  id: string,
): MetronomeSound {
  return (
    sounds.find((s) => s.id === id) ??
    BUILT_IN_SOUNDS.find((s) => s.id === DEFAULT_SOUND_ID)!
  );
}
