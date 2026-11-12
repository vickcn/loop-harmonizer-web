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
import { SoundTouchAdapter } from "./playbackAdapters/SoundTouchAdapter";
import type { TrackPlaybackAdapter } from "./playbackAdapters/types";
import { createAudioBufferFromStem } from "@/lib/separation/audioBuffer";
import type { StereoPcm } from "@/lib/separation/stemTypes";

export type EnginePlaybackMode = "fast-rate" | "pitch-preserve" | "soundtouch";

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
  keyShiftSemitones: number;
};

function createAdapter(mode: EnginePlaybackMode): TrackPlaybackAdapter {
  if (mode === "pitch-preserve") {
    return new PitchPreserveAdapter();
  }
  if (mode === "soundtouch") {
    return new SoundTouchAdapter();
  }
  return new FastRateAdapter();
}

export class MultiTrackEngine {
  private ctx: AudioContext | null = null;
  private tracks = new Map<string, InternalTrack>();
  private loopGroups = new Map<string, string[]>();
  onTrackEnded: ((trackId: string) => void) | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  async loadTrack(
    trackId: string,
    file: File,
    playbackMode: EnginePlaybackMode = "pitch-preserve",
  ): Promise<number> {
    const ctx = this.ensureCtx();
    const ab = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(ab);

    return this.loadAudioBuffer(trackId, buffer, playbackMode);
  }

  /**
   * 直接載入已解碼的 AudioBuffer，供瀏覽器端音源分離結果使用。
   * 不經 WAV 編碼／解碼，以避免額外延遲與音質損失。
   */
  loadAudioBuffer(
    trackId: string,
    buffer: AudioBuffer,
    playbackMode: EnginePlaybackMode = "fast-rate",
  ): number {
    const ctx = this.ensureCtx();

    const existing = this.tracks.get(trackId);
    if (existing) {
      existing.adapter.dispose();
      try { existing.gainNode.disconnect(); } catch { /* ok */ }
    }

    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    const adapter = createAdapter(playbackMode);
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
      playbackMode,
      keyShiftSemitones: 0,
    });

    return buffer.duration;
  }

  /** 將分離出的 PCM 直接轉成引擎持有的 AudioBuffer，並預設以 SoundTouch 支援同步變速與變調。 */
  loadStem(trackId: string, stem: StereoPcm, sampleRate: number): number {
    const buffer = createAudioBufferFromStem(this.ensureCtx(), stem, sampleRate);
    return this.loadAudioBuffer(trackId, buffer, "soundtouch");
  }

  removeTrack(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.adapter.dispose();
    try { track.gainNode.disconnect(); } catch { /* already disconnected */ }
    this.tracks.delete(trackId);
    this.loopGroups.delete(trackId);
  }

  async playTrack(trackId: string): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const t = this.tracks.get(trackId);
    if (!t) return;
    await t.adapter.prepare?.();
    this._startAt(t, trackId, ctx.currentTime);
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
    this.seekTracks([trackId], sec);
  }

  /** 同一群分軌共用一個 schedule time 重新定位，避免逐軌 seek 造成起點漂移。 */
  seekTracks(trackIds: string[], sec: number): void {
    const ctx = this.ensureCtx();
    const tracks = trackIds
      .map((trackId) => ({ trackId, track: this.tracks.get(trackId) }))
      .filter((entry): entry is { trackId: string; track: InternalTrack } => Boolean(entry.track));
    const offset = Math.max(0, sec);
    for (const { track } of tracks) track.pausedAt = offset;

    const scheduleTime = tracks.every(({ track }) => track.playbackMode === "soundtouch")
      ? ctx.currentTime
      : ctx.currentTime + 0.02;
    for (const { trackId, track } of tracks) {
      if (track.isPlaying) this._startAt(track, trackId, scheduleTime);
    }
  }

  async playTracks(trackIds: string[]): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const entries = trackIds
      .map((id) => ({ id, track: this.tracks.get(id) }))
      .filter((entry): entry is { id: string; track: InternalTrack } => Boolean(entry.track));
    await Promise.all(entries.map(({ track }) => track.adapter.prepare?.()));
    // SoundTouch 的模組先共同預載，再於同一 JavaScript tick 啟動，避免每軌各自 setTimeout。
    // ScriptProcessorNode 仍不保證樣本級同步，UI 會保留此限制說明。
    const scheduleTime = ctx.currentTime;
    for (const { id, track } of entries) this._startAt(track, id, scheduleTime);
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
    t.adapter.setPlaybackRate(t.playbackRate, ctx, 0);
    t.adapter.setPitchSemitones(t.keyShiftSemitones, ctx);

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

  /** Stem 群組由最先結束的軌道觸發共同歸零重播，避免各 adapter 自行循環累積偏移。 */
  setLoopGroup(trackIds: string[], loop: boolean): void {
    for (const trackId of trackIds) {
      if (loop) this.loopGroups.set(trackId, [...trackIds]);
      else this.loopGroups.delete(trackId);
      const track = this.tracks.get(trackId);
      if (!track) continue;
      track.loop = false;
      track.adapter.setLoop(false, () => this._handleTrackEnded(trackId));
    }
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

  setGroupVolume(trackIds: string[], volume: number): void {
    trackIds.forEach((trackId) => this.setVolume(trackId, volume));
  }

  /** 在同一 AudioContext 時間軸切換原始混音與 stems，短暫重疊後停止舊來源。 */
  crossfadeTracks(fromIds: string[], toIds: string[], durationSec = 0.06): void {
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    for (const id of fromIds) {
      const track = this.tracks.get(id);
      if (!track) continue;
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setValueAtTime(track.gainNode.gain.value, now);
      track.gainNode.gain.linearRampToValueAtTime(0, now + durationSec);
    }
    for (const id of toIds) {
      const track = this.tracks.get(id);
      if (!track) continue;
      const target = track.muted ? 0 : track.volume;
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setValueAtTime(0, now);
      track.gainNode.gain.linearRampToValueAtTime(target, now + durationSec);
    }
    window.setTimeout(() => this.pauseTracks(fromIds), Math.ceil(durationSec * 1000) + 10);
  }

  getTrackOffsets(trackIds: string[]): Record<string, number> {
    return Object.fromEntries(trackIds.map((trackId) => [trackId, this.getTrackPosition(trackId)]));
  }

  setPlaybackRate(trackId: string, rate: number, rampSec = 0.5): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.playbackRate = Math.max(0.1, Math.min(4, rate));
    if (this.ctx) t.adapter.setPlaybackRate(t.playbackRate, this.ctx, rampSec);
  }

  setPitchSemitones(trackId: string, semitones: number): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.keyShiftSemitones = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (this.ctx) t.adapter.setPitchSemitones(t.keyShiftSemitones, this.ctx);
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
    this.loopGroups.clear();
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
    const loopGroup = this.loopGroups.get(trackId);
    if (loopGroup) {
      this.stopTracks(loopGroup);
      void this.playTracks(loopGroup);
      return;
    }
    const t = this.tracks.get(trackId);
    if (t) {
      t.isPlaying = false;
      t.pausedAt = 0;
    }
    this.onTrackEnded?.(trackId);
  }
}
