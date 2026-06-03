/**
 * MultiTrackEngine — M2C 更新
 *
 * 每軌依 playbackMode 使用對應 adapter：
 *   fast-rate      → FastRateAdapter（AudioBufferSourceNode.playbackRate，M1 行為）
 *   pitch-preserve → PitchPreserveAdapter（AudioWorklet WSOLA，真正保音高）
 *
 * 多軌 pitch-preserve 注意：playTracks() 共用同一 scheduleTime，
 * 但 PitchPreserveAdapter 的 worklet 不支援 scheduleTime，
 * 多條 pitch-preserve 軌道無法精確同步。建議僅單軌使用保音高模式。
 *
 * 公開 API 與 M1/M2A 完全相同，BandMixer 無需重寫。
 */

import { FastRateAdapter } from "./playbackAdapters/FastRateAdapter";
import { PitchPreserveAdapter } from "./playbackAdapters/PitchPreserveAdapter";
import type { TrackPlaybackAdapter } from "./playbackAdapters/types";

export type EnginePlaybackMode = "fast-rate" | "pitch-preserve";

type InternalTrack = {
  buffer: AudioBuffer;
  gainNode: GainNode;
  adapter: TrackPlaybackAdapter;
  pausedAt: number;
  isPlaying: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  playbackMode: EnginePlaybackMode;
};

function createAdapter(mode: EnginePlaybackMode): TrackPlaybackAdapter {
  if (mode === "pitch-preserve") {
    return new PitchPreserveAdapter();
  }
  return new FastRateAdapter();
}

export class MultiTrackEngine {
  private ctx: AudioContext | null = null;
  private tracks = new Map<string, InternalTrack>();
  onTrackEnded: ((trackId: string) => void) | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  async loadTrack(trackId: string, file: File): Promise<number> {
    const ctx = this.ensureCtx();
    const ab = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(ab);

    const existing = this.tracks.get(trackId);
    if (existing) {
      existing.adapter.dispose();
      try { existing.gainNode.disconnect(); } catch { /* ok */ }
    }

    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    const adapter = createAdapter("fast-rate");
    adapter.load(buffer, gainNode, ctx);

    this.tracks.set(trackId, {
      buffer,
      gainNode,
      adapter,
      pausedAt: 0,
      isPlaying: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
      loop: false,
      playbackMode: "fast-rate",
    });

    return buffer.duration;
  }

  async playTrack(trackId: string): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const t = this.tracks.get(trackId);
    if (!t) return;
    this._startAt(t, trackId, ctx.currentTime + 0.01);
  }

  pauseTrack(trackId: string): void {
    const t = this.tracks.get(trackId);
    if (!t || !t.isPlaying) return;
    const ctx = this.ensureCtx();
    t.pausedAt = t.adapter.getPosition(ctx);
    t.adapter.pause(ctx);
    t.isPlaying = false;
  }

  stopTrack(trackId: string): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.adapter.stop();
    t.pausedAt = 0;
    t.isPlaying = false;
  }

  async seekTrack(trackId: string, sec: number): Promise<void> {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.pausedAt = Math.max(0, sec);
    if (t.isPlaying) {
      const ctx = this.ensureCtx();
      this._startAt(t, trackId, ctx.currentTime + 0.01);
    }
  }

  async playTracks(trackIds: string[]): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const scheduleTime = ctx.currentTime + 0.02;
    // pitch-preserve 軌道的 scheduleTime 無法精確對齊，多軌同步以 fast-rate 為準
    for (const id of trackIds) {
      const t = this.tracks.get(id);
      if (!t) continue;
      this._startAt(t, id, scheduleTime);
    }
  }

  pauseTracks(trackIds: string[]): void {
    for (const id of trackIds) this.pauseTrack(id);
  }

  stopTracks(trackIds: string[]): void {
    for (const id of trackIds) this.stopTrack(id);
  }

  /**
   * 切換播放模式。
   * 若播放中：暫停 → 換 adapter → 從原位置繼續播放。
   * M2C 備忘：pitch-preserve adapter 初始化可能為 async（需 addModule），
   *           屆時此方法需改為 async 並 await adapter.init()。
   */
  setPlaybackMode(trackId: string, mode: EnginePlaybackMode): void {
    const t = this.tracks.get(trackId);
    if (!t || t.playbackMode === mode) return;

    const ctx = this.ensureCtx();
    const wasPlaying = t.isPlaying;
    const savedPos = t.adapter.getPosition(ctx);

    // 停止舊 adapter
    t.adapter.dispose();
    t.pausedAt = savedPos;
    t.isPlaying = false;

    // 建立新 adapter
    const newAdapter = createAdapter(mode);
    newAdapter.load(t.buffer, t.gainNode, ctx);
    t.adapter = newAdapter;
    t.playbackMode = mode;

    if (wasPlaying) {
      this._startAt(t, trackId, ctx.currentTime + 0.01);
    }
  }

  setLoop(trackId: string, loop: boolean): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.loop = loop;
    const onEnded = loop ? null : () => this._handleTrackEnded(trackId);
    t.adapter.setLoop(loop, onEnded);
  }

  setVolume(trackId: string, volume: number): void {
    const t = this.tracks.get(trackId);
    if (!t || !this.ctx) return;
    t.volume = Math.max(0, Math.min(1, volume));
    t.gainNode.gain.setTargetAtTime(t.muted ? 0 : t.volume, this.ctx.currentTime, 0.02);
  }

  setMuted(trackId: string, muted: boolean): void {
    const t = this.tracks.get(trackId);
    if (!t || !this.ctx) return;
    t.muted = muted;
    t.gainNode.gain.setTargetAtTime(muted ? 0 : t.volume, this.ctx.currentTime, 0.02);
  }

  setPlaybackRate(trackId: string, rate: number, rampSec = 0.5): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.playbackRate = Math.max(0.1, Math.min(4, rate));
    if (this.ctx) t.adapter.setPlaybackRate(t.playbackRate, this.ctx, rampSec);
  }

  getTrackPosition(trackId: string): number {
    const t = this.tracks.get(trackId);
    if (!t) return 0;
    if (!t.isPlaying || !this.ctx) return t.pausedAt;
    return t.adapter.getPosition(this.ctx);
  }

  dispose(): void {
    for (const t of this.tracks.values()) {
      t.adapter.dispose();
      try { t.gainNode.disconnect(); } catch { /* ok */ }
    }
    this.tracks.clear();
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
    }
    this.ctx = null;
  }

  // ── private ──

  private _startAt(t: InternalTrack, trackId: string, scheduleTime: number): void {
    t.adapter.onEnded = () => this._handleTrackEnded(trackId);
    t.adapter.play(scheduleTime, {
      offsetSec: t.pausedAt,
      playbackRate: t.playbackRate,
      loop: t.loop,
    });
    t.isPlaying = true;
  }

  private _handleTrackEnded(trackId: string): void {
    const t = this.tracks.get(trackId);
    if (t) {
      t.isPlaying = false;
      t.pausedAt = 0;
    }
    this.onTrackEnded?.(trackId);
  }
}
