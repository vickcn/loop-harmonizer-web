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
import { SoundTouchAdapter, type SoundTouchBufferLike } from "./playbackAdapters/SoundTouchAdapter";
import {
  ChunkedStemMixBuffer,
  type ChunkMixStemRole,
  type ChunkMixTrackEntry,
} from "./playbackAdapters/ChunkPlaybackAdapter";
import type { TrackPlaybackAdapter } from "./playbackAdapters/types";
import { createAudioBufferFromStem } from "@/lib/separation/audioBuffer";
import type { StereoPcm } from "@/lib/separation/stemTypes";

export type EnginePlaybackMode = "fast-rate" | "pitch-preserve" | "soundtouch";

type StemMixEntry = {
  trackId: string;
  left: Float32Array;
  right: Float32Array;
  gain: number;
  muted: boolean;
};

class StemMixBuffer implements SoundTouchBufferLike {
  readonly numberOfChannels = 2;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly entries: StemMixEntry[];

  constructor(entries: StemMixEntry[], sampleRate: number) {
    this.entries = entries;
    this.sampleRate = sampleRate;
    this.length = entries.reduce((max, entry) => Math.max(max, entry.left.length), 0);
    this.duration = sampleRate > 0 ? this.length / sampleRate : 0;
  }

  getChannelData(channel: number): Float32Array {
    const out = new Float32Array(this.length);
    for (const entry of this.entries) {
      if (entry.muted || entry.gain <= 0) continue;
      const src = channel === 0 ? entry.left : entry.right;
      for (let i = 0; i < src.length; i += 1) {
        out[i] += src[i] * entry.gain;
      }
    }
    return out;
  }

  extract(target: Float32Array, numFrames = 0, position = 0): number {
    const available = Math.max(0, Math.min(numFrames, this.length - position));
    target.fill(0, 0, numFrames * 2);
    for (const entry of this.entries) {
      if (entry.muted || entry.gain <= 0) continue;
      const gain = entry.gain;
      const left = entry.left;
      const right = entry.right;
      const len = Math.max(0, Math.min(available, left.length - position));
      for (let i = 0; i < len; i += 1) {
        target[i * 2] += left[position + i] * gain;
        target[i * 2 + 1] += right[position + i] * gain;
      }
    }
    return available;
  }
}

type StemMixEntryState = {
  trackId: string;
  gain: number;
  muted: boolean;
};

type StemMixBus = {
  groupId: string;
  trackIds: string[];
  entriesByTrackId: Map<string, StemMixEntryState>;
  chunkedBuffer?: ChunkedStemMixBuffer;
  gainNode: GainNode;
  adapter: SoundTouchAdapter;
  pausedAt: number;
  isPlaying: boolean;
  playbackRate: number;
  keyShiftSemitones: number;
  loop: boolean;
};

type InternalTrack = {
  buffer: AudioBuffer | null;
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
  private stemMixBuses = new Map<string, StemMixBus>();
  private trackToMixGroup = new Map<string, string>();
  onTrackEnded: ((trackId: string) => void) | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      try {
        this.ctx = new AudioContext({ sampleRate: 44100 });
      } catch {
        this.ctx = new AudioContext();
      }
    }
    return this.ctx;
  }

  /**
   * 同步於使用者點擊手勢當下喚醒 AudioContext，避免後續非同步準備流程造成 Chrome User Activation 失效。
   */
  primeContextFromGesture(): void {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
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

  /**
   * 將同一首歌的多條分離音軌綁定為單一混音匯流排（StemMixBus）：
   * 先依各軌音量／靜音狀態即時加總為單一立體聲流，再進入單一 SoundTouch 處理，
   * 避免多軌獨立 WSOLA 造成跨軌相位撕裂，並將主執行緒 ScriptProcessorNode 負載降為 1/N。
   */
  setStemMixGroup(groupId: string, trackIds: string[]): void {
    this._disposeMixBus(groupId);
    const ctx = this.ensureCtx();
    const entries: StemMixEntry[] = [];
    const validIds: string[] = [];
    let firstTrack: InternalTrack | null = null;

    for (const trackId of trackIds) {
      const track = this.tracks.get(trackId);
      if (!track || !track.buffer) continue;
      if (!firstTrack) firstTrack = track;
      const left = track.buffer.getChannelData(0);
      const right = track.buffer.numberOfChannels > 1 ? track.buffer.getChannelData(1) : left;
      entries.push({
        trackId,
        left,
        right,
        gain: track.volume,
        muted: track.muted,
      });
      validIds.push(trackId);
      this.trackToMixGroup.set(trackId, groupId);
    }

    if (!validIds.length || !firstTrack || !firstTrack.buffer) return;

    const mixBuffer = new StemMixBuffer(entries, firstTrack.buffer.sampleRate);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    const adapter = new SoundTouchAdapter();
    adapter.load(mixBuffer, gainNode, ctx);
    adapter.setPlaybackRate(firstTrack.playbackRate, ctx, 0);
    adapter.setPitchSemitones(firstTrack.keyShiftSemitones, ctx);

    const bus: StemMixBus = {
      groupId,
      trackIds: validIds,
      entriesByTrackId: new Map(entries.map((entry) => [entry.trackId, entry])),
      gainNode,
      adapter,
      pausedAt: firstTrack.pausedAt,
      isPlaying: false,
      playbackRate: firstTrack.playbackRate,
      keyShiftSemitones: firstTrack.keyShiftSemitones,
      loop: false,
    };
    this.stemMixBuses.set(groupId, bus);
  }

  /**
   * 載入 IndexedDB 分段保存的分離分軌（不將全曲 4 軌 PCM 載入記憶體），
   * 透過 ChunkedStemMixBuffer 僅常駐滑動視窗內的數個 Chunk 並接入單一 SoundTouchAdapter。
   */
  async loadChunkedStemGroup(params: {
    groupId: string;
    taskId: string;
    totalSamples: number;
    sampleRate: number;
    stemLayout?: "four_stem" | "two_stem_direct";
    tracks: Array<{
      trackId: string;
      role: ChunkMixStemRole;
      volume?: number;
      muted?: boolean;
    }>;
    playbackRate?: number;
    keyShiftSemitones?: number;
    loop?: boolean;
    initialPositionSec?: number;
  }): Promise<number> {
    this._disposeMixBus(params.groupId);
    const ctx = this.ensureCtx();
    const initialRate = Math.max(0.1, Math.min(4, params.playbackRate ?? 1));
    const initialPitch = params.keyShiftSemitones ?? 0;
    const initialPos = Math.max(0, params.initialPositionSec ?? 0);

    const entries: ChunkMixTrackEntry[] = [];
    const trackIds: string[] = [];

    for (const spec of params.tracks) {
      const existing = this.tracks.get(spec.trackId);
      if (existing) {
        existing.adapter.dispose();
        try { existing.gainNode.disconnect(); } catch { /* ok */ }
        this.tracks.delete(spec.trackId);
      }
      const entry: ChunkMixTrackEntry = {
        trackId: spec.trackId,
        role: spec.role,
        gain: spec.volume ?? 1,
        muted: Boolean(spec.muted),
      };
      entries.push(entry);
      trackIds.push(spec.trackId);
      this.trackToMixGroup.set(spec.trackId, params.groupId);

      // 輕量虛擬軌道紀錄：不持有整曲 AudioBuffer
      const dummyGain = ctx.createGain();
      const dummyAdapter = new SoundTouchAdapter();
      this.tracks.set(spec.trackId, {
        buffer: null,
        gainNode: dummyGain,
        adapter: dummyAdapter,
        pausedAt: initialPos,
        isPlaying: false,
        playbackRate: initialRate,
        volume: entry.gain,
        muted: entry.muted,
        loop: Boolean(params.loop),
        playbackMode: "soundtouch",
        keyShiftSemitones: initialPitch,
      });
    }

    const chunkedBuffer = new ChunkedStemMixBuffer({
      taskId: params.taskId,
      totalSamples: params.totalSamples,
      sampleRate: params.sampleRate,
      stemLayout: params.stemLayout,
      entries,
      loop: params.loop,
    });
    await chunkedBuffer.warmUpAroundSample(Math.floor(initialPos * chunkedBuffer.sampleRate));

    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    const adapter = new SoundTouchAdapter();
    adapter.load(chunkedBuffer, gainNode, ctx);
    adapter.setPlaybackRate(initialRate, ctx, 0);
    adapter.setPitchSemitones(initialPitch, ctx);

    const bus: StemMixBus = {
      groupId: params.groupId,
      trackIds,
      entriesByTrackId: new Map(entries.map((entry) => [entry.trackId, entry])),
      chunkedBuffer,
      gainNode,
      adapter,
      pausedAt: initialPos,
      isPlaying: false,
      playbackRate: initialRate,
      keyShiftSemitones: initialPitch,
      loop: Boolean(params.loop),
    };
    this.stemMixBuses.set(params.groupId, bus);
    return chunkedBuffer.duration;
  }

  async warmupChunkedStemGroup(groupId: string, positionSec = 0): Promise<void> {
    const bus = this.stemMixBuses.get(groupId);
    if (!bus?.chunkedBuffer) return;
    await bus.chunkedBuffer.warmUpAroundSample(
      Math.floor(Math.max(0, positionSec) * bus.chunkedBuffer.sampleRate),
    );
  }

  hasTrack(trackId: string): boolean {
    return this.tracks.has(trackId);
  }

  hasHealthyStemMixBus(groupId: string): boolean {
    const bus = this.stemMixBuses.get(groupId);
    if (!bus || bus.trackIds.length === 0 || bus.entriesByTrackId.size === 0) {
      return false;
    }
    if (bus.chunkedBuffer) {
      return (
        bus.chunkedBuffer.totalChunks > 0 &&
        bus.chunkedBuffer.duration > 0 &&
        bus.chunkedBuffer.entries.length > 0
      );
    }
    const duration = this.tracks.get(bus.trackIds[0])?.buffer?.duration ?? 0;
    return duration > 0;
  }

  diagnosePlayback(trackIds: string[]): {
    contextState: AudioContextState | "uninitialized";
    sampleRate: number | null;
    buses: Array<{
      groupId: string;
      isPlaying: boolean;
      busGain: number;
      pausedAt: number;
      duration: number;
      activeEntryCount: number;
      entries: Array<{ trackId: string; gain: number; muted: boolean }>;
      adapterDiagnostics: ReturnType<ChunkedStemMixBuffer["getDiagnostics"]> | null;
    }>;
    standalone: Array<{
      trackId: string;
      isPlaying: boolean;
      gain: number;
      volume: number;
      muted: boolean;
      pausedAt: number;
      duration: number;
      playbackMode: EnginePlaybackMode;
    }>;
  } {
    const { buses, standalone } = this._resolvePlaybackTargets(trackIds);
    return {
      contextState: this.ctx?.state ?? "uninitialized",
      sampleRate: this.ctx?.sampleRate ?? null,
      buses: buses.map((bus) => {
        const entries = Array.from(bus.entriesByTrackId.values()).map((entry) => ({
          trackId: entry.trackId,
          gain: entry.gain,
          muted: entry.muted,
        }));
        const adapterDiagnostics = bus.chunkedBuffer?.getDiagnostics() ?? null;
        const activeEntryCount =
          adapterDiagnostics?.activeEntryCount ??
          entries.filter((entry) => !entry.muted && entry.gain > 0).length;
        const duration =
          bus.chunkedBuffer?.duration ?? this.tracks.get(bus.trackIds[0])?.buffer?.duration ?? 0;
        return {
          groupId: bus.groupId,
          isPlaying: bus.isPlaying,
          busGain: bus.gainNode.gain.value,
          pausedAt: bus.pausedAt,
          duration,
          activeEntryCount,
          entries,
          adapterDiagnostics,
        };
      }),
      standalone: standalone.map(({ id, track }) => ({
        trackId: id,
        isPlaying: track.isPlaying,
        gain: track.gainNode.gain.value,
        volume: track.volume,
        muted: track.muted,
        pausedAt: track.pausedAt,
        duration: track.buffer?.duration ?? 0,
        playbackMode: track.playbackMode,
      })),
    };
  }

  isTrackPlaying(trackId: string): boolean {
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      const bus = this.stemMixBuses.get(groupId);
      if (bus?.isPlaying) return true;
    }
    return this.tracks.get(trackId)?.isPlaying ?? false;
  }

  getTrackMemoryEstimateBytes(): number {
    let total = 0;
    for (const bus of this.stemMixBuses.values()) {
      if (bus.chunkedBuffer) {
        total += bus.chunkedBuffer.getEstimatedResidentBytes();
      }
    }
    for (const track of this.tracks.values()) {
      if (!track.buffer) continue;
      total += track.buffer.length * track.buffer.numberOfChannels * 4;
    }
    return total;
  }

  getActiveSoundTouchCount(): number {
    let count = 0;
    for (const bus of this.stemMixBuses.values()) {
      if (bus.isPlaying) count += 1;
    }
    for (const [trackId, track] of this.tracks.entries()) {
      if (track.isPlaying && track.playbackMode === "soundtouch") {
        const groupId = this.trackToMixGroup.get(trackId);
        if (!groupId || !this.stemMixBuses.get(groupId)) count += 1;
      }
    }
    return count;
  }

  hasActivePlayback(): boolean {
    for (const bus of this.stemMixBuses.values()) {
      if (bus.isPlaying) return true;
    }
    for (const track of this.tracks.values()) {
      if (track.isPlaying) return true;
    }
    return false;
  }

  getProjectedSoundTouchCount(additionalTrackIds: string[]): number {
    const activeBuses = new Set<string>();
    const activeStandalone = new Set<string>();
    for (const [groupId, bus] of this.stemMixBuses.entries()) {
      if (bus.isPlaying) activeBuses.add(groupId);
    }
    for (const [trackId, track] of this.tracks.entries()) {
      if (track.isPlaying && track.playbackMode === "soundtouch") {
        const groupId = this.trackToMixGroup.get(trackId);
        if (!groupId || !this.stemMixBuses.get(groupId)) {
          activeStandalone.add(trackId);
        }
      }
    }
    const { buses, standalone } = this._resolvePlaybackTargets(additionalTrackIds);
    for (const bus of buses) {
      activeBuses.add(bus.groupId);
    }
    for (const { id, track } of standalone) {
      if (track.playbackMode === "soundtouch") {
        activeStandalone.add(id);
      }
    }
    return activeBuses.size + activeStandalone.size;
  }

  /**
   * 真正暫停所有播放中的匯流排與獨立音軌（斷開 SoundTouch ScriptProcessorNode，不使用 mute 代替 pause）。
   */
  pauseAllActivePlayback(): { pausedTrackIds: string[]; positionsByTrackId: Record<string, number> } {
    const activeIds = new Set<string>();
    const positionsByTrackId: Record<string, number> = {};

    for (const bus of this.stemMixBuses.values()) {
      if (!bus.isPlaying) continue;
      for (const id of bus.trackIds) {
        activeIds.add(id);
        positionsByTrackId[id] = this.getTrackPosition(id);
      }
    }
    for (const [trackId, track] of this.tracks.entries()) {
      if (!track.isPlaying) continue;
      activeIds.add(trackId);
      positionsByTrackId[trackId] = this.getTrackPosition(trackId);
    }

    const pausedTrackIds = [...activeIds];
    if (pausedTrackIds.length > 0) {
      this.pauseTracks(pausedTrackIds);
    }
    return { pausedTrackIds, positionsByTrackId };
  }

  /**
   * 僅釋放未處於播放中的指定音軌（解除 AudioBuffer 與音訊節點參照，不會強制中斷正在播放之音軌）。
   */
  releaseIdleTracks(trackIds: readonly string[]): {
    releasedTrackIds: string[];
    estimatedFreedBytes: number;
  } {
    const releasedTrackIds: string[] = [];
    let estimatedFreedBytes = 0;
    for (const trackId of trackIds) {
      if (this.isTrackPlaying(trackId)) continue;
      const track = this.tracks.get(trackId);
      if (!track) continue;
      if (track.buffer) {
        estimatedFreedBytes += track.buffer.length * track.buffer.numberOfChannels * 4;
      }
      this.removeTrack(trackId);
      releasedTrackIds.push(trackId);
    }
    return { releasedTrackIds, estimatedFreedBytes };
  }

  removeTrack(trackId: string): void {
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      this.trackToMixGroup.delete(trackId);
      const bus = this.stemMixBuses.get(groupId);
      if (bus) {
        bus.entriesByTrackId.delete(trackId);
        bus.trackIds = bus.trackIds.filter((id) => id !== trackId);
        if (bus.trackIds.length === 0) {
          this._disposeMixBus(groupId);
        }
      }
    }
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.adapter.dispose();
    try { track.gainNode.disconnect(); } catch { /* already disconnected */ }
    this.tracks.delete(trackId);
    this.loopGroups.delete(trackId);
  }

  async playTrack(trackId: string): Promise<void> {
    await this.playTracks([trackId]);
  }

  pauseTrack(trackId: string): void {
    this.pauseTracks([trackId]);
  }

  stopTrack(trackId: string): void {
    this.stopTracks([trackId]);
  }

  async seekTrack(trackId: string, sec: number): Promise<void> {
    this.seekTracks([trackId], sec);
  }

  /** 同一群分軌共用一個 schedule time 重新定位，避免逐軌 seek 造成起點漂移。 */
  seekTracks(trackIds: string[], sec: number): void {
    const ctx = this.ensureCtx();
    const offset = Math.max(0, sec);
    const { buses, standalone } = this._resolvePlaybackTargets(trackIds);

    for (const bus of buses) {
      bus.pausedAt = offset;
      for (const id of bus.trackIds) {
        const member = this.tracks.get(id);
        if (member) member.pausedAt = offset;
      }
      if (bus.chunkedBuffer) {
        void bus.chunkedBuffer.warmUpAroundSample(
          Math.floor(offset * bus.chunkedBuffer.sampleRate),
        );
      }
      if (bus.isPlaying) this._startMixBusAt(bus, ctx.currentTime);
    }

    for (const { track } of standalone) track.pausedAt = offset;
    const scheduleTime = standalone.every(({ track }) => track.playbackMode === "soundtouch")
      ? ctx.currentTime
      : ctx.currentTime + 0.02;
    for (const { id, track } of standalone) {
      if (track.isPlaying) this._startAt(track, id, scheduleTime);
    }
  }

  async playTracks(trackIds: string[]): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const { buses, standalone } = this._resolvePlaybackTargets(trackIds);
    await Promise.all([
      ...buses.map(async (bus) => {
        const duration = bus.chunkedBuffer?.duration ?? this.tracks.get(bus.trackIds[0])?.buffer?.duration ?? 0;
        if (duration > 0.5 && bus.pausedAt >= duration - 0.4) {
          bus.pausedAt = 0;
          for (const id of bus.trackIds) {
            const member = this.tracks.get(id);
            if (member) member.pausedAt = 0;
          }
        }
        if (bus.chunkedBuffer) {
          await bus.chunkedBuffer.warmUpAroundSample(
            Math.floor(Math.max(0, bus.pausedAt) * bus.chunkedBuffer.sampleRate),
          );
        }
        await bus.adapter.prepare?.();
      }),
      ...standalone.map(({ track }) => track.adapter.prepare?.()),
    ]);
    // SoundTouch 的模組先共同預載，再於同一 JavaScript tick 啟動，避免每軌各自 setTimeout。
    const scheduleTime = ctx.currentTime;
    for (const bus of buses) this._startMixBusAt(bus, scheduleTime);
    for (const { id, track } of standalone) this._startAt(track, id, scheduleTime);
  }

  pauseTracks(trackIds: string[]): void {
    const ctx = this.ensureCtx();
    const { buses, standalone } = this._resolvePlaybackTargets(trackIds);
    for (const bus of buses) {
      if (!bus.isPlaying) continue;
      const pos = bus.adapter.getPosition(ctx);
      bus.pausedAt = pos;
      bus.adapter.pause(ctx);
      bus.isPlaying = false;
      for (const id of bus.trackIds) {
        const member = this.tracks.get(id);
        if (member) {
          member.pausedAt = pos;
          member.isPlaying = false;
        }
      }
    }
    for (const { track } of standalone) {
      if (!track.isPlaying) continue;
      track.pausedAt = track.adapter.getPosition(ctx);
      track.adapter.pause(ctx);
      track.isPlaying = false;
    }
  }

  stopTracks(trackIds: string[]): void {
    const { buses, standalone } = this._resolvePlaybackTargets(trackIds);
    for (const bus of buses) {
      bus.adapter.stop();
      bus.pausedAt = 0;
      bus.isPlaying = false;
      if (this.ctx) {
        bus.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
        bus.gainNode.gain.setValueAtTime(1, this.ctx.currentTime);
      }
      for (const id of bus.trackIds) {
        const member = this.tracks.get(id);
        if (member) {
          member.pausedAt = 0;
          member.isPlaying = false;
        }
      }
    }
    for (const { track } of standalone) {
      track.adapter.stop();
      track.pausedAt = 0;
      track.isPlaying = false;
    }
  }

  /**
   * 切換播放模式。
   * 若播放中：暫停 → 換 adapter → 從原位置繼續播放。
   * M2C 備忘：pitch-preserve adapter 初始化可能為 async（需 addModule），
   *           屆時此方法需改為 async 並 await adapter.init()。
   */
  setPlaybackMode(trackId: string, mode: EnginePlaybackMode): void {
    const t = this.tracks.get(trackId);
    if (!t || !t.buffer || t.playbackMode === mode) return;

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

  /** Stem 群組改用單一 StemMixBus 原生循環，無跨軌漂移；若未綁定 mixBus 則保留舊有群組重播機制。 */
  setLoopGroup(trackIds: string[], loop: boolean): void {
    const handledGroups = new Set<string>();
    for (const trackId of trackIds) {
      const groupId = this.trackToMixGroup.get(trackId);
      if (groupId) {
        if (!handledGroups.has(groupId)) {
          handledGroups.add(groupId);
          const bus = this.stemMixBuses.get(groupId);
          if (bus) {
            bus.loop = loop;
            bus.chunkedBuffer?.setLoopEnabled(loop);
            bus.adapter.setLoop(loop, loop ? null : () => this._handleMixBusEnded(bus));
          }
        }
        continue;
      }
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
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      const entry = this.stemMixBuses.get(groupId)?.entriesByTrackId.get(trackId);
      if (entry) entry.gain = t.volume;
      return;
    }
    t.gainNode.gain.setTargetAtTime(t.muted ? 0 : t.volume, this.ctx.currentTime, 0.02);
  }

  setMuted(trackId: string, muted: boolean): void {
    const t = this.tracks.get(trackId);
    if (!t || !this.ctx) return;
    t.muted = muted;
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      const entry = this.stemMixBuses.get(groupId)?.entriesByTrackId.get(trackId);
      if (entry) entry.muted = muted;
      return;
    }
    t.gainNode.gain.setTargetAtTime(muted ? 0 : t.volume, this.ctx.currentTime, 0.02);
  }

  setGroupVolume(trackIds: string[], volume: number): void {
    trackIds.forEach((trackId) => this.setVolume(trackId, volume));
  }

  /** 在同一 AudioContext 時間軸切換原始混音與 stems，短暫重疊後停止舊來源。 */
  crossfadeTracks(fromIds: string[], toIds: string[], durationSec = 0.06): void {
    const ctx = this.ensureCtx();
    const now = ctx.currentTime;
    const fromTargets = this._resolvePlaybackTargets(fromIds);
    const toTargets = this._resolvePlaybackTargets(toIds);

    for (const bus of fromTargets.buses) {
      bus.gainNode.gain.cancelScheduledValues(now);
      bus.gainNode.gain.setValueAtTime(bus.gainNode.gain.value, now);
      bus.gainNode.gain.linearRampToValueAtTime(0, now + durationSec);
    }
    for (const { track } of fromTargets.standalone) {
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setValueAtTime(track.gainNode.gain.value, now);
      track.gainNode.gain.linearRampToValueAtTime(0, now + durationSec);
    }

    for (const bus of toTargets.buses) {
      bus.gainNode.gain.cancelScheduledValues(now);
      bus.gainNode.gain.setValueAtTime(0, now);
      bus.gainNode.gain.linearRampToValueAtTime(1, now + durationSec);
    }
    for (const { track } of toTargets.standalone) {
      const target = track.muted ? 0 : track.volume;
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setValueAtTime(0, now);
      track.gainNode.gain.linearRampToValueAtTime(target, now + durationSec);
    }

    window.setTimeout(() => {
      this.pauseTracks(fromIds);
      if (this.ctx) {
        const restoreTime = this.ctx.currentTime;
        for (const bus of fromTargets.buses) {
          if (!bus.isPlaying) {
            bus.gainNode.gain.cancelScheduledValues(restoreTime);
            bus.gainNode.gain.setValueAtTime(1, restoreTime);
          }
        }
        for (const { track } of fromTargets.standalone) {
          if (!track.isPlaying) {
            const target = track.muted ? 0 : track.volume;
            track.gainNode.gain.cancelScheduledValues(restoreTime);
            track.gainNode.gain.setValueAtTime(target, restoreTime);
          }
        }
      }
    }, Math.ceil(durationSec * 1000) + 10);
  }

  getTrackOffsets(trackIds: string[]): Record<string, number> {
    return Object.fromEntries(trackIds.map((trackId) => [trackId, this.getTrackPosition(trackId)]));
  }

  setPlaybackRate(trackId: string, rate: number, rampSec = 0.5): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    const clamped = Math.max(0.1, Math.min(4, rate));
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      t.playbackRate = clamped;
      const bus = this.stemMixBuses.get(groupId);
      if (bus && bus.playbackRate !== clamped) {
        bus.playbackRate = clamped;
        if (this.ctx) bus.adapter.setPlaybackRate(bus.playbackRate, this.ctx, rampSec);
      }
      return;
    }
    if (t.playbackRate === clamped) return;
    t.playbackRate = clamped;
    if (this.ctx) t.adapter.setPlaybackRate(t.playbackRate, this.ctx, rampSec);
  }

  setPitchSemitones(trackId: string, semitones: number): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      t.keyShiftSemitones = clamped;
      const bus = this.stemMixBuses.get(groupId);
      if (bus && bus.keyShiftSemitones !== clamped) {
        bus.keyShiftSemitones = clamped;
        if (this.ctx) bus.adapter.setPitchSemitones(bus.keyShiftSemitones, this.ctx);
      }
      return;
    }
    if (t.keyShiftSemitones === clamped) return;
    t.keyShiftSemitones = clamped;
    if (this.ctx) t.adapter.setPitchSemitones(t.keyShiftSemitones, this.ctx);
  }

  getTrackPosition(trackId: string): number {
    const groupId = this.trackToMixGroup.get(trackId);
    if (groupId) {
      const bus = this.stemMixBuses.get(groupId);
      if (!bus) return 0;
      if (!bus.isPlaying || !this.ctx) return bus.pausedAt;
      return bus.adapter.getPosition(this.ctx);
    }
    const t = this.tracks.get(trackId);
    if (!t) return 0;
    if (!t.isPlaying || !this.ctx) return t.pausedAt;
    return t.adapter.getPosition(this.ctx);
  }

  dispose(): void {
    for (const groupId of [...this.stemMixBuses.keys()]) {
      this._disposeMixBus(groupId);
    }
    for (const t of this.tracks.values()) {
      t.adapter.dispose();
      try { t.gainNode.disconnect(); } catch { /* ok */ }
    }
    this.tracks.clear();
    this.loopGroups.clear();
    this.trackToMixGroup.clear();
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
    }
    this.ctx = null;
  }

  // ── private ──

  private _disposeMixBus(groupId: string): void {
    const bus = this.stemMixBuses.get(groupId);
    if (!bus) return;
    bus.adapter.dispose();
    bus.chunkedBuffer?.dispose();
    try { bus.gainNode.disconnect(); } catch { /* ok */ }
    for (const id of bus.trackIds) {
      if (this.trackToMixGroup.get(id) === groupId) {
        this.trackToMixGroup.delete(id);
      }
    }
    this.stemMixBuses.delete(groupId);
  }

  private _resolvePlaybackTargets(trackIds: string[]): {
    buses: StemMixBus[];
    standalone: Array<{ id: string; track: InternalTrack }>;
  } {
    const seenGroups = new Set<string>();
    const buses: StemMixBus[] = [];
    const standalone: Array<{ id: string; track: InternalTrack }> = [];
    for (const id of trackIds) {
      const groupId = this.trackToMixGroup.get(id);
      if (groupId) {
        if (!seenGroups.has(groupId)) {
          seenGroups.add(groupId);
          const bus = this.stemMixBuses.get(groupId);
          if (bus) buses.push(bus);
        }
        continue;
      }
      const track = this.tracks.get(id);
      if (track) standalone.push({ id, track });
    }
    return { buses, standalone };
  }

  private _startMixBusAt(bus: StemMixBus, scheduleTime: number): void {
    const ctx = this.ctx;
    const duration = bus.chunkedBuffer?.duration ?? this.tracks.get(bus.trackIds[0])?.buffer?.duration ?? 0;
    if (duration > 0.5 && bus.pausedAt >= duration - 0.4) {
      bus.pausedAt = 0;
      for (const id of bus.trackIds) {
        const member = this.tracks.get(id);
        if (member) member.pausedAt = 0;
      }
      if (bus.chunkedBuffer) {
        void bus.chunkedBuffer.warmUpAroundSample(0);
      }
    }
    if (ctx) {
      bus.gainNode.gain.cancelScheduledValues(ctx.currentTime);
      bus.gainNode.gain.setValueAtTime(1, ctx.currentTime);
    }
    bus.gainNode.gain.value = 1;
    bus.adapter.onEnded = () => this._handleMixBusEnded(bus);
    bus.adapter.play(scheduleTime, {
      offsetSec: bus.pausedAt,
      playbackRate: bus.playbackRate,
      loop: bus.loop,
    });
    bus.isPlaying = true;
    for (const id of bus.trackIds) {
      const member = this.tracks.get(id);
      if (member) member.isPlaying = true;
    }
  }

  private _handleMixBusEnded(bus: StemMixBus): void {
    bus.isPlaying = false;
    bus.pausedAt = 0;
    for (const id of bus.trackIds) {
      const member = this.tracks.get(id);
      if (member) {
        member.isPlaying = false;
        member.pausedAt = 0;
      }
    }
    if (bus.trackIds[0]) {
      this.onTrackEnded?.(bus.trackIds[0]);
    }
  }

  private _startAt(t: InternalTrack, trackId: string, scheduleTime: number): void {
    const ctx = this.ctx;
    const duration = t.buffer?.duration ?? 0;
    if (duration > 0.5 && t.pausedAt >= duration - 0.4) {
      t.pausedAt = 0;
    }
    const targetGain = t.muted ? 0 : t.volume;
    if (ctx) {
      t.gainNode.gain.cancelScheduledValues(ctx.currentTime);
      t.gainNode.gain.setValueAtTime(targetGain, ctx.currentTime);
    }
    t.gainNode.gain.value = targetGain;
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
