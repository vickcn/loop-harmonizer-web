import { BandSession, BandTrack } from "./bandTypes";

export function createDefaultBandSession(): BandSession {
  return {
    id: `session_${Date.now()}`,
    tracks: [],
  };
}

export async function createBandTrackFromFile(file: File): Promise<BandTrack> {
  let durationSec = 0;
  try {
    const ctx = new AudioContext();
    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    durationSec = buf.duration;
    await ctx.close();
  } catch {
    // fallback: duration unknown
  }

  return {
    id: `track_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: file.name.replace(/\.[^.]+$/, ""),
    fileName: file.name,
    originalBpm: 120,
    baseRate: 1.0,
    volume: 1.0,
    muted: false,
    selected: false,
    playheadSec: 0,
    durationSec,
    status: "stopped",
    syncMode: "free",
  };
}
