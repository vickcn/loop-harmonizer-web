import type { AdapterPlaybackMode, PlaybackLoopRange, PlayOptions, TrackPlaybackAdapter } from "./types";

type SoundTouchShifter = {
  tempo: number;
  pitchSemitones: number;
  percentagePlayed: number;
  timePlayed: number;
  connect: (destination: AudioNode) => void;
  disconnect: () => void;
};

export type SoundTouchBufferLike = {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  getChannelData: (channel: number) => Float32Array;
  extract?: (target: Float32Array, numFrames: number, position: number) => number;
};

/**
 * 將既有音訊視為一段連續窗格，讓 SoundTouch 在 A/B 區段末端觸發原生 end。
 * 這避免以 UI timer 尋址，並可同時支援完整 AudioBuffer 與按需分段緩衝。
 */
class SoundTouchRangeBuffer implements SoundTouchBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;

  constructor(
    private readonly source: SoundTouchBufferLike,
    readonly startSec: number,
    readonly endSec: number,
  ) {
    this.numberOfChannels = source.numberOfChannels;
    this.sampleRate = source.sampleRate;
    const startFrame = Math.floor(startSec * this.sampleRate);
    const endFrame = Math.ceil(endSec * this.sampleRate);
    this.length = Math.max(0, endFrame - startFrame);
    this.duration = this.sampleRate > 0 ? this.length / this.sampleRate : 0;
  }

  getChannelData(channel: number): Float32Array {
    const startFrame = Math.floor(this.startSec * this.sampleRate);
    const endFrame = startFrame + this.length;
    return this.source.getChannelData(channel).subarray(startFrame, endFrame);
  }

  extract(target: Float32Array, numFrames = 0, position = 0): number {
    const startFrame = Math.floor(this.startSec * this.sampleRate);
    const available = Math.max(0, Math.min(numFrames, this.length - position));
    target.fill(0, 0, numFrames * 2);
    if (this.source.extract) {
      return this.source.extract(target, available, startFrame + position);
    }
    for (let channel = 0; channel < Math.min(2, this.numberOfChannels); channel += 1) {
      const src = this.source.getChannelData(channel);
      for (let frame = 0; frame < available; frame += 1) {
        target[frame * 2 + channel] = src[startFrame + position + frame] ?? 0;
      }
    }
    return available;
  }
}

type SoundTouchModule = {
  PitchShifter: new (
    context: AudioContext,
    buffer: SoundTouchBufferLike,
    bufferSize: number,
    onEnd: () => void,
  ) => SoundTouchShifter;
};

let modulePromise: Promise<SoundTouchModule> | null = null;

function loadSoundTouchModule(): Promise<SoundTouchModule> {
  if (!modulePromise) {
    const moduleUrl = "/vendor/soundtouch.js?v=2";
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

  private buffer: SoundTouchBufferLike | null = null;
  private playbackBuffer: SoundTouchBufferLike | null = null;
  private gainNode: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private shifter: SoundTouchShifter | null = null;
  private pausedAt = 0;
  private playbackRate = 1;
  private pitchSemitones = 0;
  private loop = false;
  private loopRange: PlaybackLoopRange | null = null;
  private playing = false;
  private playToken = 0;

  load(buffer: SoundTouchBufferLike, gainNode: GainNode, ctx: AudioContext): void {
    this.dispose();
    this.buffer = buffer;
    this.playbackBuffer = buffer;
    this.gainNode = gainNode;
    this.ctx = ctx;
    this.pausedAt = 0;
    this.playbackRate = 1;
    this.pitchSemitones = 0;
    this.loop = false;
    this.loopRange = null;
  }

  async prepare(): Promise<void> {
    await loadSoundTouchModule();
  }

  play(scheduleTime: number, options: PlayOptions): void {
    if (!this.buffer || !this.gainNode || !this.ctx) return;
    this.disconnectShifter();
    this.playbackRate = options.playbackRate;
    this.loop = options.loop;
    this.loopRange = options.loop
      ? this.normalizeLoopRange(options.loopStartSec, options.loopEndSec)
      : null;
    this.playbackBuffer = this.loop && this.loopRange
      ? new SoundTouchRangeBuffer(this.buffer, this.loopRange.startSec, this.loopRange.endSec)
      : this.buffer;
    const duration = this.buffer.duration;
    this.pausedAt = this.normalizeOffset(options.offsetSec, duration);
    this.playing = true;
    const token = ++this.playToken;
    void this.startShifter(scheduleTime, this.pausedAt, token);
  }

  getPosition(_ctx: AudioContext): number {
    if (!this.playing || !this.buffer) return this.pausedAt;
    if (!this.shifter) return this.pausedAt;
    const activeDuration = this.playbackBuffer?.duration ?? this.buffer.duration;
    const localPosition = Math.max(0, Math.min(activeDuration, this.shifter.timePlayed));
    const position = (this.loopRange?.startSec ?? 0) + localPosition;
    return this.loop && !this.loopRange && this.buffer.duration > 0
      ? position % this.buffer.duration
      : Math.min(position, this.loopRange?.endSec ?? this.buffer.duration);
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

  setLoop(loop: boolean, onEnded: (() => void) | null, loopRange?: PlaybackLoopRange | null): void {
    this.loop = loop;
    this.onEnded = onEnded;
    this.loopRange = loop ? this.normalizeLoopRange(loopRange?.startSec, loopRange?.endSec) : null;
  }

  dispose(): void {
    this.playToken += 1;
    this.disconnectShifter();
    this.onEnded = null;
    this.buffer = null;
    this.playbackBuffer = null;
    this.gainNode = null;
    this.ctx = null;
    this.playing = false;
    this.pausedAt = 0;
  }

  private async startShifter(scheduleTime: number, offsetSec: number, token: number): Promise<void> {
    const [module] = await Promise.all([loadSoundTouchModule(), this.waitUntil(scheduleTime)]);
    if (token !== this.playToken || !this.buffer || !this.playbackBuffer || !this.gainNode || !this.ctx || !this.playing) return;

    const shifter = new module.PitchShifter(this.ctx, this.playbackBuffer, 4096, () => this.handleEnded(token));
    shifter.tempo = this.playbackRate;
    shifter.pitchSemitones = this.pitchSemitones;
    const relativeOffset = offsetSec - (this.loopRange?.startSec ?? 0);
    shifter.percentagePlayed = this.playbackBuffer.duration > 0
      ? Math.max(0, Math.min(1, relativeOffset / this.playbackBuffer.duration))
      : 0;
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
      this.pausedAt = this.loopRange?.startSec ?? 0;
      const nextToken = ++this.playToken;
      void this.startShifter(this.ctx.currentTime + 0.01, this.pausedAt, nextToken);
      return;
    }
    this.playing = false;
    this.pausedAt = 0;
    this.onEnded?.();
  }

  private normalizeLoopRange(startSec: number | undefined, endSec: number | undefined): PlaybackLoopRange | null {
    const duration = this.buffer?.duration ?? 0;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || duration <= 0) return null;
    const start = Math.max(0, Math.min(duration, startSec!));
    const end = Math.max(start, Math.min(duration, endSec!));
    return end - start >= 0.05 ? { startSec: start, endSec: end } : null;
  }

  private normalizeOffset(offsetSec: number, duration: number): number {
    if (this.loopRange) {
      if (offsetSec < this.loopRange.startSec || offsetSec >= this.loopRange.endSec) {
        return this.loopRange.startSec;
      }
      return offsetSec;
    }
    return duration > 0 ? ((offsetSec % duration) + duration) % duration : 0;
  }

  private disconnectShifter(): void {
    if (!this.shifter) return;
    const shifterRef = this.shifter as SoundTouchShifter & {
      node?: { onaudioprocess?: unknown; disconnect?: () => void };
      _node?: { onaudioprocess?: unknown; disconnect?: () => void };
    };
    this.shifter = null;
    try {
      if (shifterRef.node) {
        shifterRef.node.onaudioprocess = null;
        shifterRef.node.disconnect?.();
      }
      if (shifterRef._node) {
        shifterRef._node.onaudioprocess = null;
        shifterRef._node.disconnect?.();
      }
      shifterRef.disconnect();
    } catch {
      // already disconnected
    }
  }
}
