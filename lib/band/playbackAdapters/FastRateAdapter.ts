/**
 * FastRateAdapter — M1 / M2A 行為完整移植。
 *
 * 使用 AudioBufferSourceNode.playbackRate 變速；
 * 音高會隨速率改變（不保音高），但 CPU 極低、無延遲。
 *
 * 此 adapter 是 M2B 架構的「生產可用」路徑。
 * M2C 將新增 PitchPreserveAdapter 取代佔位版本。
 */

import type { AdapterPlaybackMode, PlayOptions, TrackPlaybackAdapter } from "./types";

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
    const offset = dur > 0 ? ((options.offsetSec % dur) + dur) % dur : 0;

    const src = (this.gainNode.context as AudioContext).createBufferSource();
    src.buffer = this.buffer;
    src.loop = this._loop;
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
    if (this._loop) return ((raw % dur) + dur) % dur;
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

  setPlaybackRate(rate: number, ctx: AudioContext): void {
    this._playbackRate = rate;
    if (this.source) {
      this.source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.05);
    }
  }

  setLoop(loop: boolean, onEnded: (() => void) | null): void {
    this._loop = loop;
    this.onEnded = onEnded;
    if (this.source) {
      this.source.loop = loop;
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
}
