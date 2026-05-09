import { LiveTransition, PlaybackParams } from "./tempoTypes";
import { interpolateBpm, resolvePlaybackParams } from "./tempoMath";

export class TempoEngine {
  private baseBpm: number;
  private currentBpm: number;
  private loopBpm: number;
  private liveTransition: LiveTransition | null = null;
  private driverMode: "loop" | "timeline" = "loop";

  constructor(baseBpm: number) {
    this.baseBpm = baseBpm;
    this.currentBpm = baseBpm;
    this.loopBpm = baseBpm;
  }

  setBaseBpm(bpm: number) { this.baseBpm = bpm; }
  setDriverMode(mode: "loop" | "timeline") { this.driverMode = mode; }
  getLoopBpm(): number { return this.loopBpm; }
  getCurrentBpm(): number { return this.currentBpm; }

  setLoopBpm(bpm: number) {
    this.loopBpm = bpm;
    this.currentBpm = bpm;
  }

  triggerTransition(toBpm: number, transitionBeats: number, ctxTime: number) {
    const fromBpm = this.currentBpm;
    const durationSeconds = (60 / Math.max(1, fromBpm)) * transitionBeats;
    this.liveTransition = { fromBpm, toBpm, startTime: ctxTime, durationSeconds };
  }

  // Used by MetronomeClock lookahead scheduler to get future BPM
  getBpmAtAudioTime(audioTime: number): number {
    if (this.liveTransition) {
      const elapsed = audioTime - this.liveTransition.startTime;
      const progress = Math.max(0, Math.min(1, elapsed / this.liveTransition.durationSeconds));
      if (progress < 1) {
        return interpolateBpm(this.liveTransition.fromBpm, this.liveTransition.toBpm, progress);
      }
    }
    return this.currentBpm;
  }

  // Called every animation frame; timelineBpm is provided by the driver in timeline mode
  tick(ctxTime: number, timelineBpm?: number): PlaybackParams {
    const targetBpm = this.driverMode === "loop" ? this.loopBpm : (timelineBpm ?? this.loopBpm);

    if (this.liveTransition) {
      const elapsed = ctxTime - this.liveTransition.startTime;
      const progress = Math.max(0, Math.min(1, elapsed / this.liveTransition.durationSeconds));
      this.currentBpm = interpolateBpm(this.liveTransition.fromBpm, this.liveTransition.toBpm, progress);
      if (progress >= 1) {
        if (this.driverMode === "loop") this.loopBpm = this.liveTransition.toBpm;
        this.liveTransition = null;
      }
    } else {
      this.currentBpm = targetBpm;
    }

    return resolvePlaybackParams(this.currentBpm, this.baseBpm);
  }
}
