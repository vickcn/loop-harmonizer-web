export type PlaybackMode = "quick" | "pitch-preserve";

export class AudioPlayer {
  private ctx: AudioContext;
  private outGain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private buffer: AudioBuffer | null = null;
  private workletLoading: Promise<void> | null = null;
  private _mode: PlaybackMode = "pitch-preserve";
  private _pitchPreserveReady = false;
  private _startAudioTime = 0;
  private _pausedSeconds = 0;
  private _playing = false;

  constructor(ctx: AudioContext, outGain: GainNode) {
    this.ctx = ctx;
    this.outGain = outGain;
  }

  get isLoaded(): boolean { return this.buffer !== null; }
  get pitchPreserveReady(): boolean { return this._pitchPreserveReady; }
  get playbackMode(): PlaybackMode { return this._mode; }
  getPausedSeconds(): number { return this._pausedSeconds; }

  getBufferDuration(): number | null { return this.buffer?.duration ?? null; }

  getElapsedSeconds(): number {
    if (!this._playing) return this._pausedSeconds;
    return Math.max(0, this.ctx.currentTime - this._startAudioTime);
  }

  async load(file: File) {
    const ab = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(ab);
    this._pausedSeconds = 0;
    this._pitchPreserveReady = false;
    this.workletNode = null;
    if (this._mode === "pitch-preserve") {
      await this.ensureWorklet();
    }
  }

  async play(playbackRate: number) {
    if (!this.buffer) return;
    this.stopSource();
    this.disconnectWorklet();
    this._startAudioTime = this.ctx.currentTime - this._pausedSeconds;

    if (this._mode === "pitch-preserve") {
      await this.ensureWorklet();
      if (this.workletNode) {
        this.workletNode.connect(this.outGain);
        this.post({ type: "setPosition", seconds: this._pausedSeconds, sampleRate: this.buffer.sampleRate });
        this.post({ type: "play" });
        this.post({ type: "setTempoRatio", ratio: playbackRate });
      }
    } else {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.loop = true;
      src.playbackRate.value = playbackRate;
      src.connect(this.outGain);
      src.start(0, this._pausedSeconds % this.buffer.duration);
      this.source = src;
    }
    this._playing = true;
  }

  async seek(seconds: number, playbackRate: number) {
    if (!this.buffer) return;
    const duration = this.buffer.duration;
    const wrapped = duration > 0
      ? ((seconds % duration) + duration) % duration
      : 0;
    this._pausedSeconds = wrapped;

    if (this._mode === "pitch-preserve") {
      if (this._playing) {
        await this.ensureWorklet();
        if (this.workletNode) this.workletNode.connect(this.outGain);
      }
      this.post({ type: "setPosition", seconds: wrapped, sampleRate: this.buffer.sampleRate });
      if (this._playing) {
        this._startAudioTime = this.ctx.currentTime - this._pausedSeconds;
        this.post({ type: "play" });
        this.post({ type: "setTempoRatio", ratio: playbackRate });
      }
      return;
    }

    if (!this._playing) return;
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.connect(this.outGain);
    src.start(0, this._pausedSeconds % this.buffer.duration);
    this.source = src;
    this._startAudioTime = this.ctx.currentTime - this._pausedSeconds;
  }

  pause() {
    this._pausedSeconds = this.getElapsedSeconds();
    this.stopSource();
    this.post({ type: "pause" });
    this.disconnectWorklet();
    this._playing = false;
  }

  stop() {
    this._pausedSeconds = 0;
    this.stopSource();
    this.post({ type: "stop" });
    this.disconnectWorklet();
    this._playing = false;
  }

  setPlaybackRate(rate: number) {
    if (this._mode === "pitch-preserve") {
      this.post({ type: "setTempoRatio", ratio: rate });
    } else if (this.source) {
      this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.035);
    }
  }

  setVolume(v: number) {
    this.outGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02);
  }

  async setMode(mode: PlaybackMode, isCurrentlyPlaying: boolean, playbackRate: number) {
    this._mode = mode;
    if (mode === "pitch-preserve" && this.buffer) {
      await this.ensureWorklet();
    }
    if (isCurrentlyPlaying) {
      if (this._playing) this._pausedSeconds = this.getElapsedSeconds();
      this.stopSource();
      this.disconnectWorklet();
      await this.play(playbackRate);
    }
  }

  private async ensureWorklet() {
    if (!this.buffer) return;
    if (!this.workletLoading) {
      this.workletLoading = this.ctx.audioWorklet.addModule("/worklets/pitch-preserve-processor.js");
    }
    await this.workletLoading;
    const node = new AudioWorkletNode(this.ctx, "pitch-preserve-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.min(2, Math.max(1, this.buffer.numberOfChannels))]
    });
    const channels = Array.from({ length: Math.min(2, this.buffer.numberOfChannels) }, (_, i) =>
      this.buffer!.getChannelData(i).slice()
    );
    node.port.postMessage({ type: "load", channels }, channels.map((c) => c.buffer));
    node.port.postMessage({ type: "setGain", gain: 0.95 });
    this.workletNode = node;
    this._pitchPreserveReady = true;
  }

  private stopSource() {
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.source.disconnect();
    this.source = null;
  }

  private disconnectWorklet() {
    if (!this.workletNode) return;
    try { this.workletNode.disconnect(); } catch { /* already disconnected */ }
    this.workletNode = null;
    this._pitchPreserveReady = false;
  }

  private post(msg: unknown) {
    this.workletNode?.port.postMessage(msg);
  }
}
