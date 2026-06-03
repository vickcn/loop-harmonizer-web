import { BandSession, BandTrack } from "./bandTypes";

export function createDefaultBandSession(): BandSession {
  return {
    id: `session_${Date.now()}`,
    globalBpm: 120,
    tracks: [],
  };
}

/**
 * Legacy M0 helper.
 *
 * This function only decodes an uploaded audio file to create BandTrack metadata
 * such as durationSec. It does NOT keep the decoded AudioBuffer in the playback
 * engine, so it is not used by the current M1 BandMixer playback flow.
 *
 * Current M1 flow:
 * - BandMixer calls MultiTrackEngine.loadTrack(trackId, file)
 * - MultiTrackEngine owns the decoded AudioBuffer for real playback
 * - BandMixer then creates the BandTrack state from the returned duration
 *
 * Keep this here temporarily as a reference/fallback while the Band Mixer data
 * model is still evolving. If no future code uses it, it can be removed or
 * replaced by a pure metadata factory.
 */
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
    syncMode: "manual-rate",
    loop: false,
    playbackMode: "pitch-preserve",
  };
}
