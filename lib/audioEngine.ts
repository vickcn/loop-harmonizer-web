import { AudioPlayer, PlaybackMode } from "./audio/audioPlayer";
import { MetronomeClock } from "./metronome/metronomeClock";
import { TempoEngine } from "./bpm/tempoEngine";
import { getAudioBaseBpm, getTimelineBpmAtBar } from "./timeline";
import { SongTimeline } from "./types";

export type { PlaybackMode };
export type DriverMode = "loop" | "timeline";

export type EngineStatus = {
  isPlaying: boolean;
  isMetronomeOnly: boolean;
  currentBar: number;
  currentBpm: number;
  timelineBpm: number;
  actualBpm: number;
  tempoRatio: number;
  playbackMode: PlaybackMode;
  pitchPreserveReady: boolean;
  driverMode: DriverMode;
  loopBpm: number;
};

export class BrowserLoopEngine {
  private ctx: AudioContext | null = null;
  private outGain: GainNode | null = null;
  private timeline: SongTimeline;
  private tempoEngine: TempoEngine;
  private audioPlayer: AudioPlayer | null = null;
  private clock: MetronomeClock | null = null;
  private raf: number | null = null;
  private isPlaying = false;
  private metronomeOnly = false;
  private metronomeOnlyStartTime = 0;
  private driverMode: DriverMode = "loop";
  private onStatus?: (status: EngineStatus) => void;
  private metronomeEnabled = false;
  private metronomeVolume = 0.8;
  private metronomeAccentFirstBeat = true;

  constructor(timeline: SongTimeline) {
    this.timeline = timeline;
    this.tempoEngine = new TempoEngine(getAudioBaseBpm(timeline));
    this.tempoEngine.setLoopBpm(timeline.projectBpm);
  }

  setTimeline(timeline: SongTimeline) {
    if (timeline.projectBpm !== this.timeline.projectBpm) {
      this.tempoEngine.setLoopBpm(timeline.projectBpm);
    }
    this.timeline = timeline;
    this.tempoEngine.setBaseBpm(getAudioBaseBpm(timeline));
  }

  setDriverMode(mode: DriverMode) {
    this.driverMode = mode;
    this.tempoEngine.setDriverMode(mode);
  }

  setMetronomeEnabled(v: boolean) {
    this.metronomeEnabled = v;
    this.clock?.setEnabled(v);
  }
  setMetronomeVolume(v: number) {
    this.metronomeVolume = v;
    this.clock?.setVolume(v);
  }
  setMetronomeAccent(v: boolean) {
    this.metronomeAccentFirstBeat = v;
    this.clock?.setAccentFirstBeat(v);
  }
  setAudioVolume(v: number) { this.audioPlayer?.setVolume(v); }
  getBufferDuration(): number | null { return this.audioPlayer?.getBufferDuration() ?? null; }
  setStatusCallback(cb: (s: EngineStatus) => void) { this.onStatus = cb; }
  getPlaybackMode(): PlaybackMode { return this.audioPlayer?.playbackMode ?? "pitch-preserve"; }

  async setPlaybackMode(mode: PlaybackMode) {
    if (!this.audioPlayer) return;
    const params = this.tempoEngine.tick(this.ctx?.currentTime ?? 0);
    await this.audioPlayer.setMode(mode, this.isPlaying && !this.metronomeOnly, params.playbackRate);
    this.emitStatus();
  }

  async loadFile(file: File) {
    this.ensureCtx();
    await this.audioPlayer!.load(file);
    this.tempoEngine.setBaseBpm(getAudioBaseBpm(this.timeline));
  }

  // Play audio (or standalone metronome if no file loaded)
  async play() {
    this.ensureCtx();
    await this.ctx!.resume();
    this.metronomeOnly = !this.audioPlayer!.isLoaded;

    if (this.metronomeOnly) {
      this.metronomeOnlyStartTime = this.ctx!.currentTime;
    } else {
      const params = this.tempoEngine.tick(this.ctx!.currentTime);
      await this.audioPlayer!.play(params.playbackRate);
    }

    this.isPlaying = true;
    this.clock!.start(
      this.ctx!.currentTime,
      this.metronomeOnly ? 0 : this.audioPlayer!.getPausedSeconds(),
      this.tempoEngine.getLoopBpm(),
      this.timeline.timeSignature.beatsPerBar
    );
    if (this.raf) cancelAnimationFrame(this.raf);
    this.tick();
  }

  pause() {
    if (!this.ctx) return;
    if (!this.metronomeOnly) this.audioPlayer?.pause();
    this.isPlaying = false;
    this.clock?.pause();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  stop() {
    if (!this.metronomeOnly) this.audioPlayer?.stop();
    this.isPlaying = false;
    this.metronomeOnly = false;
    this.clock?.stop();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.emitStatus(1, this.timeline.projectBpm, this.timeline.projectBpm);
  }

  triggerLiveBeatChange(toBpm: number, transitionBeats: number) {
    if (!this.ctx) return;
    this.tempoEngine.triggerTransition(toBpm, transitionBeats, this.ctx.currentTime);
  }

  private ensureCtx() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.outGain = this.ctx.createGain();
    this.outGain.connect(this.ctx.destination);
    this.audioPlayer = new AudioPlayer(this.ctx, this.outGain);
    this.clock = new MetronomeClock(this.ctx, (t) => this.tempoEngine.getBpmAtAudioTime(t));
    this.clock.setEnabled(this.metronomeEnabled);
    this.clock.setVolume(this.metronomeVolume);
    this.clock.setAccentFirstBeat(this.metronomeAccentFirstBeat);
  }

  private getElapsedSeconds(): number {
    if (!this.ctx) return 0;
    if (this.metronomeOnly) return this.ctx.currentTime - this.metronomeOnlyStartTime;
    return this.audioPlayer?.getElapsedSeconds() ?? 0;
  }

  private getCurrentBar(seconds: number): number {
    const bpm = this.timeline.projectBpm;
    const beats = seconds / (60 / Math.max(1, bpm));
    const rawBar = beats / this.timeline.timeSignature.beatsPerBar + 1;
    const total = this.timeline.totalBars;
    return ((rawBar - 1) % total) + 1;
  }

  private tick = () => {
    if (!this.isPlaying || !this.ctx) return;
    const ctxTime = this.ctx.currentTime;
    const seconds = this.getElapsedSeconds();
    const bar = this.getCurrentBar(seconds);
    const timelineBpm = this.driverMode === "loop"
      ? this.tempoEngine.getLoopBpm()
      : getTimelineBpmAtBar(this.timeline, bar);
    const params = this.tempoEngine.tick(ctxTime, timelineBpm);

    if (!this.metronomeOnly && this.audioPlayer) {
      this.audioPlayer.setPlaybackRate(params.playbackRate);
    }

    this.emitStatus(bar, timelineBpm, params.currentBpm);
    this.raf = requestAnimationFrame(this.tick);
  };

  private emitStatus(
    bar = 1,
    timelineBpm = this.tempoEngine.getLoopBpm(),
    actualBpm = this.tempoEngine.getCurrentBpm()
  ) {
    this.onStatus?.({
      isPlaying: this.isPlaying,
      isMetronomeOnly: this.metronomeOnly,
      currentBar: bar,
      currentBpm: actualBpm,
      timelineBpm,
      actualBpm,
      tempoRatio: actualBpm / getAudioBaseBpm(this.timeline),
      playbackMode: this.audioPlayer?.playbackMode ?? "pitch-preserve",
      pitchPreserveReady: this.audioPlayer?.pitchPreserveReady ?? false,
      driverMode: this.driverMode,
      loopBpm: this.tempoEngine.getLoopBpm(),
    });
  }
}
