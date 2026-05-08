import { SongTimeline } from "./types";
import { getAudioBaseBpm, getTimelineBpmAtBar } from "./timeline";
import { Metronome } from "./metronome";

export type PlaybackMode = "quick" | "pitch-preserve";
export type DriverMode = "loop" | "timeline";

type LiveTransition = {
  fromBpm: number;
  toBpm: number;
  startAudioTime: number;
  durationSeconds: number;
};

export type EngineStatus = {
  isPlaying: boolean;
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
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private buffer: AudioBuffer | null = null;
  private raf: number | null = null;
  private timeline: SongTimeline;
  private isPlaying = false;
  private startAudioTime = 0;
  private pausedAudioSeconds = 0;
  private liveTransition: LiveTransition | null = null;
  private onStatus?: (status: EngineStatus) => void;
  private playbackMode: PlaybackMode = "pitch-preserve";
  private pitchPreserveReady = false;
  private workletLoading: Promise<void> | null = null;
  private driverMode: DriverMode = "loop";
  private loopBpm: number;
  private lastActualBpm: number;
  private metronome: Metronome | null = null;

  constructor(timeline: SongTimeline) {
    this.timeline = timeline;
    this.loopBpm = timeline.projectBpm;
    this.lastActualBpm = timeline.projectBpm;
  }

  setTimeline(timeline: SongTimeline) {
    if (timeline.projectBpm !== this.timeline.projectBpm) {
      this.loopBpm = timeline.projectBpm;
    }
    this.timeline = timeline;
  }

  setDriverMode(mode: DriverMode) {
    this.driverMode = mode;
  }

  getBpmAtAudioTime(audioTime: number): number {
    if (this.liveTransition) {
      const elapsed = audioTime - this.liveTransition.startAudioTime;
      const progress = Math.max(0, Math.min(1, elapsed / this.liveTransition.durationSeconds));
      if (progress < 1) {
        return this.liveTransition.fromBpm + (this.liveTransition.toBpm - this.liveTransition.fromBpm) * progress;
      }
    }
    return this.driverMode === "loop" ? this.loopBpm : this.lastActualBpm;
  }

  setMetronomeEnabled(v: boolean) { this.metronome?.setEnabled(v); }
  setMetronomeVolume(v: number) { this.metronome?.setVolume(v); }
  setMetronomeAccent(v: boolean) { this.metronome?.setAccentFirstBeat(v); }
  setAudioVolume(v: number) { if (this.gain) this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx!.currentTime, 0.02); }

  getBufferDuration(): number | null {
    return this.buffer?.duration ?? null;
  }

  setStatusCallback(callback: (status: EngineStatus) => void) {
    this.onStatus = callback;
  }

  getPlaybackMode() {
    return this.playbackMode;
  }

  async setPlaybackMode(mode: PlaybackMode) {
    this.playbackMode = mode;
    if (mode === "pitch-preserve" && this.ctx && this.buffer) {
      await this.ensurePitchPreserveNode();
    }
    if (this.isPlaying) {
      await this.restartForCurrentMode();
    } else {
      const current = this.getCurrentStatusValues();
      this.emitStatus(current.bar, current.timelineBpm, current.actualBpm, current.actualBpm);
    }
  }

  async loadFile(file: File) {
    this.ctx = this.ctx ?? new AudioContext();
    this.gain = this.gain ?? this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    if (!this.metronome) {
      this.metronome = new Metronome(this.ctx, (t) => this.getBpmAtAudioTime(t));
    }
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.pausedAudioSeconds = 0;
    this.pitchPreserveReady = false;
    this.workletNode = null;
    if (this.playbackMode === "pitch-preserve") {
      await this.ensurePitchPreserveNode();
    }
  }

  async play() {
    if (!this.ctx || !this.buffer || !this.gain) return;
    await this.ctx.resume();
    this.stopSourceOnly();
    this.disconnectWorkletOnly();

    this.startAudioTime = this.ctx.currentTime - this.pausedAudioSeconds;

    if (this.playbackMode === "pitch-preserve") {
      await this.playPitchPreserve();
    } else {
      this.playQuickRate();
    }

    this.isPlaying = true;
    if (this.metronome && this.ctx) {
      this.metronome.start(
        this.ctx.currentTime,
        this.pausedAudioSeconds,
        this.timeline.projectBpm,
        this.timeline.timeSignature.beatsPerBar
      );
    }
    this.tick();
  }

  pause() {
    if (!this.ctx) return;
    this.pausedAudioSeconds = Math.max(0, this.ctx.currentTime - this.startAudioTime);
    this.stopSourceOnly();
    this.postWorklet({ type: "pause" });
    this.disconnectWorkletOnly();
    this.isPlaying = false;
    this.metronome?.pause();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  stop() {
    this.pausedAudioSeconds = 0;
    this.stopSourceOnly();
    this.postWorklet({ type: "stop" });
    this.disconnectWorkletOnly();
    this.isPlaying = false;
    this.metronome?.stop();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.emitStatus(1, this.timeline.projectBpm, this.timeline.projectBpm, this.timeline.projectBpm);
  }

  triggerLiveBeatChange(toBpm: number, transitionBeats: number) {
    if (!this.ctx) return;
    const current = this.getCurrentStatusValues();
    const durationSeconds = (60 / Math.max(1, current.actualBpm)) * transitionBeats;
    this.liveTransition = {
      fromBpm: current.actualBpm,
      toBpm,
      startAudioTime: this.ctx.currentTime,
      durationSeconds
    };
  }

  private async restartForCurrentMode() {
    if (!this.ctx || !this.buffer) return;
    this.pausedAudioSeconds = Math.max(0, this.ctx.currentTime - this.startAudioTime);
    await this.play();
  }

  private playQuickRate() {
    if (!this.ctx || !this.buffer || !this.gain) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;
    source.connect(this.gain);
    this.source = source;
    source.start(0, this.pausedAudioSeconds % this.buffer.duration);
  }

  private async playPitchPreserve() {
    if (!this.ctx || !this.buffer || !this.gain) return;
    await this.ensurePitchPreserveNode();
    if (!this.workletNode) return;
    this.workletNode.connect(this.gain);
    this.postWorklet({ type: "play" });
    const current = this.getCurrentStatusValues();
    this.postWorklet({ type: "setTempoRatio", ratio: current.ratio });
  }

  private async ensurePitchPreserveNode() {
    if (!this.ctx || !this.buffer) return;
    if (!this.workletLoading) {
      this.workletLoading = this.ctx.audioWorklet.addModule("/worklets/pitch-preserve-processor.js");
    }
    await this.workletLoading;

    const node = new AudioWorkletNode(this.ctx, "pitch-preserve-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.min(2, Math.max(1, this.buffer.numberOfChannels))]
    });

    const channels = Array.from({ length: Math.min(2, this.buffer.numberOfChannels) }, (_, index) =>
      this.buffer!.getChannelData(index).slice()
    );

    node.port.postMessage({ type: "load", channels }, channels.map((channel) => channel.buffer));
    node.port.postMessage({ type: "setGain", gain: 0.95 });
    this.workletNode = node;
    this.pitchPreserveReady = true;
  }

  private stopSourceOnly() {
    if (!this.source) return;
    try { this.source.stop(); } catch {}
    this.source.disconnect();
    this.source = null;
  }

  private disconnectWorkletOnly() {
    if (!this.workletNode) return;
    try { this.workletNode.disconnect(); } catch {}
    this.workletNode = null;
    this.pitchPreserveReady = false;
  }

  private postWorklet(message: unknown) {
    this.workletNode?.port.postMessage(message);
  }

  private getElapsedAudioSeconds() {
    if (!this.ctx) return this.pausedAudioSeconds;
    return this.isPlaying ? Math.max(0, this.ctx.currentTime - this.startAudioTime) : this.pausedAudioSeconds;
  }

  private getCurrentBarBySeconds(seconds: number, bpm: number) {
    const beats = seconds / (60 / Math.max(1, bpm));
    const rawBar = beats / this.timeline.timeSignature.beatsPerBar + 1;
    const total = this.timeline.totalBars;
    return ((rawBar - 1) % total) + 1;
  }

  private getCurrentStatusValues() {
    const seconds = this.getElapsedAudioSeconds();
    const roughBar = this.getCurrentBarBySeconds(seconds, this.timeline.projectBpm);
    const timelineBpm = this.driverMode === "loop"
      ? this.loopBpm
      : getTimelineBpmAtBar(this.timeline, roughBar);
    let actualBpm = timelineBpm;

    if (this.ctx && this.liveTransition) {
      const elapsed = this.ctx.currentTime - this.liveTransition.startAudioTime;
      const progress = Math.max(0, Math.min(1, elapsed / this.liveTransition.durationSeconds));
      actualBpm = this.liveTransition.fromBpm + (this.liveTransition.toBpm - this.liveTransition.fromBpm) * progress;
      if (progress >= 1) {
        if (this.driverMode === "loop") this.loopBpm = this.liveTransition.toBpm;
        this.liveTransition = null;
      }
    }

    return {
      bar: roughBar,
      timelineBpm,
      actualBpm,
      ratio: actualBpm / getAudioBaseBpm(this.timeline)
    };
  }

  private tick = () => {
    if (!this.isPlaying) return;
    const current = this.getCurrentStatusValues();
    this.lastActualBpm = current.actualBpm;
    if (this.playbackMode === "pitch-preserve") {
      this.postWorklet({ type: "setTempoRatio", ratio: current.ratio });
    } else if (this.source && this.ctx) {
      this.source.playbackRate.setTargetAtTime(current.ratio, this.ctx.currentTime, 0.035);
    }
    this.emitStatus(current.bar, current.timelineBpm, current.actualBpm, current.actualBpm);
    this.raf = requestAnimationFrame(this.tick);
  };

  private emitStatus(currentBar: number, timelineBpm: number, actualBpm: number, currentBpm: number) {
    this.onStatus?.({
      isPlaying: this.isPlaying,
      currentBar,
      currentBpm,
      timelineBpm,
      actualBpm,
      tempoRatio: actualBpm / getAudioBaseBpm(this.timeline),
      playbackMode: this.playbackMode,
      pitchPreserveReady: this.pitchPreserveReady,
      driverMode: this.driverMode,
      loopBpm: this.loopBpm
    });
  }
}
