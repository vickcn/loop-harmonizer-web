import type { AdapterPlaybackMode, PlayOptions, TrackPlaybackAdapter } from "./types";

type SoundTouchShifter = {
  tempo: number;
  pitchSemitones: number;
  percentagePlayed: number;
  timePlayed: number;
  connect: (destination: AudioNode) => void;
  disconnect: () => void;
};

type SoundTouchModule = {
  PitchShifter: new (
    context: AudioContext,
    buffer: AudioBuffer,
    bufferSize: number,
    onEnd: () => void,
  ) => SoundTouchShifter;
};

let modulePromise: Promise<SoundTouchModule> | null = null;

function loadSoundTouchModule(): Promise<SoundTouchModule> {
  if (!modulePromise) {
    const moduleUrl = "/vendor/soundtouch.js";
    modulePromise = import(/* webpackIgnore: true */ moduleUrl) as Promise<SoundTouchModule>;
  }
  return modulePromise;
}

/**
 * SoundTouchJS adapter for simultaneous tempo and pitch changes.
 *
 * SoundTouchJS is ScriptProcessorNode-based. It is intentionally restricted to
 * a shared AudioContext and a common requested start time by MultiTrackEngine,
 * but browser callback scheduling can still introduce small per-track offsets.
 */
export class SoundTouchAdapter implements TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode = "soundtouch";
  onEnded: (() => void) | null = null;

  private buffer: AudioBuffer | null = null;
  private gainNode: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private shifter: SoundTouchShifter | null = null;
  private pausedAt = 0;
  private playbackRate = 1;
  private pitchSemitones = 0;
  private loop = false;
  private playing = false;
  private playToken = 0;

  load(buffer: AudioBuffer, gainNode: GainNode, ctx: AudioContext): void {
    this.dispose();
    this.buffer = buffer;
    this.gainNode = gainNode;
    this.ctx = ctx;
    this.pausedAt = 0;
    this.playbackRate = 1;
    this.pitchSemitones = 0;
    this.loop = false;
  }

  async prepare(): Promise<void> {
    await loadSoundTouchModule();
  }

  play(scheduleTime: number, options: PlayOptions): void {
    if (!this.buffer || !this.gainNode || !this.ctx) return;
    this.disconnectShifter();
    this.playbackRate = options.playbackRate;
    this.loop = options.loop;
    const duration = this.buffer.duration;
    this.pausedAt = duration > 0 ? ((options.offsetSec % duration) + duration) % duration : 0;
    this.playing = true;
    const token = ++this.playToken;
    void this.startShifter(scheduleTime, this.pausedAt, token);
  }

  getPosition(_ctx: AudioContext): number {
    if (!this.playing || !this.buffer) return this.pausedAt;
    if (!this.shifter) return this.pausedAt;
    const position = Math.max(0, Math.min(this.buffer.duration, this.shifter.timePlayed));
    return this.loop && this.buffer.duration > 0 ? position % this.buffer.duration : position;
  }

  pause(ctx: AudioContext): void {
    if (!this.playing) return;
    this.pausedAt = this.getPosition(ctx);
    this.playToken += 1;
    this.disconnectShifter();
    this.playing = false;
  }

  stop(): void {
    this.playToken += 1;
    this.disconnectShifter();
    this.pausedAt = 0;
    this.playing = false;
  }

  setPlaybackRate(rate: number, _ctx: AudioContext, _rampSec = 0.5): void {
    this.playbackRate = Math.max(0.25, Math.min(4, rate));
    if (this.shifter) this.shifter.tempo = this.playbackRate;
  }

  setPitchSemitones(semitones: number, _ctx: AudioContext): void {
    this.pitchSemitones = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (this.shifter) this.shifter.pitchSemitones = this.pitchSemitones;
  }

  setLoop(loop: boolean, onEnded: (() => void) | null): void {
    this.loop = loop;
    this.onEnded = onEnded;
  }

  dispose(): void {
    this.playToken += 1;
    this.disconnectShifter();
    this.buffer = null;
    this.gainNode = null;
    this.ctx = null;
    this.playing = false;
    this.pausedAt = 0;
  }

  private async startShifter(scheduleTime: number, offsetSec: number, token: number): Promise<void> {
    const [module] = await Promise.all([loadSoundTouchModule(), this.waitUntil(scheduleTime)]);
    if (token !== this.playToken || !this.buffer || !this.gainNode || !this.ctx || !this.playing) return;

    const shifter = new module.PitchShifter(this.ctx, this.buffer, 4096, () => this.handleEnded(token));
    shifter.tempo = this.playbackRate;
    shifter.pitchSemitones = this.pitchSemitones;
    shifter.percentagePlayed = this.buffer.duration > 0 ? offsetSec / this.buffer.duration : 0;
    shifter.connect(this.gainNode);
    this.shifter = shifter;
  }

  private waitUntil(scheduleTime: number): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const delayMs = Math.max(0, (scheduleTime - this.ctx.currentTime) * 1000);
    if (delayMs <= 1) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }

  private handleEnded(token: number): void {
    if (token !== this.playToken || !this.playing || !this.ctx) return;
    this.disconnectShifter();
    if (this.loop) {
      this.pausedAt = 0;
      const nextToken = ++this.playToken;
      void this.startShifter(this.ctx.currentTime + 0.01, 0, nextToken);
      return;
    }
    this.playing = false;
    this.pausedAt = 0;
    this.onEnded?.();
  }

  private disconnectShifter(): void {
    if (!this.shifter) return;
    try { this.shifter.disconnect(); } catch { /* already disconnected */ }
    this.shifter = null;
  }
}
