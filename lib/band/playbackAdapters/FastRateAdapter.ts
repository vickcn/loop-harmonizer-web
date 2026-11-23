/**
 * FastRateAdapter — M1 / M2A 行為完整移植。
 *
 * 使用 AudioBufferSourceNode.playbackRate 變速；
 * 音高會隨速率改變（不保音高），但 CPU 極低、無延遲。
 *
 * 此 adapter 是 M2B 架構的「生產可用」路徑。
 * M2C 將新增 PitchPreserveAdapter 取代佔位版本。
 */

import type { AdapterPlaybackMode, PlaybackLoopRange, PlayOptions, TrackPlaybackAdapter } from "./types";

export class FastRateAdapter implements TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode = "fast-rate";
  onEnded: (() => void) | null = null;

  private buffer: AudioBuffer | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;

  private startCtxTime = 0;
  private startAudioOffset = 0;
  private _pausedAt = 0;
  private _playbackRate = 1;
  private _loop = false;
  private _loopStartSec = 0;
  private _loopEndSec = 0;
  private _isPlaying = false;

  load(buffer: AudioBuffer, gainNode: GainNode, _ctx: AudioContext): void {
    this._stopSource();
    this.buffer = buffer;
    this.gainNode = gainNode;
    this._isPlaying = false;
    this._pausedAt = 0;
  }

  play(scheduleTime: number, options: PlayOptions): void {
    if (!this.buffer || !this.gainNode) return;
    this._stopSource();

    this._playbackRate = options.playbackRate;
    this._loop = options.loop;

    const dur = this.buffer.duration;
    this._setLoopRange(options.loopStartSec, options.loopEndSec, dur);
    const offset = this._normalizeOffset(options.offsetSec, dur);

    const src = (this.gainNode.context as AudioContext).createBufferSource();
    src.buffer = this.buffer;
    src.loop = this._loop;
    if (this._loop && this._loopEndSec > this._loopStartSec) {
      src.loopStart = this._loopStartSec;
      src.loopEnd = this._loopEndSec;
    }
    src.playbackRate.value = this._playbackRate;
    src.connect(this.gainNode);
    src.start(scheduleTime, offset);

    if (!this._loop) {
      src.onended = () => {
        if (this.source !== src) return;
        this.source = null;
        this._isPlaying = false;
        this._pausedAt = 0;
        this.onEnded?.();
      };
    }

    this.source = src;
    this.startCtxTime = scheduleTime;
    this.startAudioOffset = offset;
    this._isPlaying = true;
  }

  getPosition(ctx: AudioContext): number {
    if (!this._isPlaying || !this.buffer) return this._pausedAt;
    const elapsed = Math.max(0, ctx.currentTime - this.startCtxTime) * this._playbackRate;
    const raw = this.startAudioOffset + elapsed;
    const dur = this.buffer.duration;
    if (dur <= 0) return 0;
    if (this._loop) {
      const loopStart = this._loopStartSec;
      const loopEnd = this._loopEndSec > loopStart ? this._loopEndSec : dur;
      const loopDuration = loopEnd - loopStart;
      if (loopDuration > 0) {
        return loopStart + (((raw - loopStart) % loopDuration) + loopDuration) % loopDuration;
      }
    }
    return Math.min(raw, dur);
  }

  pause(ctx: AudioContext): void {
    if (!this._isPlaying) return;
    this._pausedAt = this.getPosition(ctx);
    this._stopSource();
    this._isPlaying = false;
  }

  stop(): void {
    this._stopSource();
    this._pausedAt = 0;
    this._isPlaying = false;
  }

  setPlaybackRate(rate: number, ctx: AudioContext, rampSec = 0.5): void {
    this._playbackRate = rate;
    if (this.source) {
      const now = ctx.currentTime;
      this.source.playbackRate.setValueAtTime(this.source.playbackRate.value, now);
      this.source.playbackRate.linearRampToValueAtTime(rate, now + rampSec);
    }
  }

  setPitchSemitones(_semitones: number, _ctx: AudioContext): void {
    // AudioBufferSourceNode 無法獨立變調；維持既有 fast-rate 行為。
  }

  setLoop(loop: boolean, onEnded: (() => void) | null, loopRange?: PlaybackLoopRange | null): void {
    this._loop = loop;
    this.onEnded = onEnded;
    this._setLoopRange(loopRange?.startSec, loopRange?.endSec, this.buffer?.duration ?? 0);
    if (this.source) {
      this.source.loop = loop;
      if (loop && this._loopEndSec > this._loopStartSec) {
        this.source.loopStart = this._loopStartSec;
        this.source.loopEnd = this._loopEndSec;
      }
      if (!loop) {
        const src = this.source;
        src.onended = () => {
          if (this.source !== src) return;
          this.source = null;
          this._isPlaying = false;
          this._pausedAt = 0;
          this.onEnded?.();
        };
      } else {
        this.source.onended = null;
      }
    }
  }

  dispose(): void {
    this._stopSource();
    this.buffer = null;
    this.gainNode = null;
  }

  // ── private ──

  private _stopSource(): void {
    if (!this.source) return;
    this.source.onended = null;
    try { this.source.stop(); } catch { /* already stopped */ }
    try { this.source.disconnect(); } catch { /* already disconnected */ }
    this.source = null;
  }

  private _setLoopRange(startSec: number | undefined, endSec: number | undefined, duration: number): void {
    const safeDuration = Math.max(0, duration);
    const start = Number.isFinite(startSec) ? Math.max(0, Math.min(safeDuration, startSec!)) : 0;
    const end = Number.isFinite(endSec) ? Math.max(start, Math.min(safeDuration, endSec!)) : safeDuration;
    this._loopStartSec = start;
    this._loopEndSec = end > start ? end : safeDuration;
  }

  private _normalizeOffset(offsetSec: number, duration: number): number {
    if (duration <= 0) return 0;
    if (this._loop && this._loopEndSec > this._loopStartSec) {
      if (offsetSec < this._loopStartSec || offsetSec >= this._loopEndSec) return this._loopStartSec;
      return offsetSec;
    }
    return ((offsetSec % duration) + duration) % duration;
  }
}
